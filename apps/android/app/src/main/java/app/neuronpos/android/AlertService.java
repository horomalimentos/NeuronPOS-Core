package app.neuronpos.android;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.provider.Settings;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;

/**
 * Apps de Nayo (Restaurante y Repartidor): servicio en primer plano que
 * pregunta cada pocos segundos a /api/alertas si hay pedidos sin atender.
 * Mientras haya alguno suena el tono de Nayo en bucle (como alarma, aunque el
 * telefono este en silencio), vibra y pone la pantalla de "Nuevo pedido"
 * encima de cualquier app, aun con el telefono bloqueado. Se calla solo
 * cuando el pedido se acepta, se rechaza o se toma.
 *
 * El token de alertas lo da la pagina con sesion (window.NeuronAndroid.startAlerts)
 * y se guarda para volver a arrancar al prender el telefono.
 */
public class AlertService extends Service {
    private static final String PREFS = "nayo_alerts";
    private static final String CH_WATCH = "nayo_atento";
    private static final String CH_ORDER = "nayo_pedidos_v1";
    private static final int ID_WATCH = 1;
    private static final int ID_ORDER = 2;
    private static final long[] VIBRATE = {0, 600, 300, 600, 300, 600, 1200};

    private HandlerThread thread;
    private Handler handler;
    private PowerManager.WakeLock wake;
    private MediaPlayer player;
    private boolean ringing;
    private String ringingId = "";
    private int failures;

    // -----------------------------------------------------------------------
    // Arranque y paro (desde MainActivity y BootReceiver)
    // -----------------------------------------------------------------------

    static void start(Context ctx, String apiOrigin, String token, int everySeconds) {
        ctx.getSharedPreferences(PREFS, MODE_PRIVATE).edit()
            .putString("api", apiOrigin).putString("token", token)
            .putInt("every", Math.max(5, Math.min(60, everySeconds))).apply();
        resume(ctx);
    }

    /** Vuelve a arrancar con el token guardado (si hay). */
    static void resume(Context ctx) {
        SharedPreferences sp = ctx.getSharedPreferences(PREFS, MODE_PRIVATE);
        if (sp.getString("token", "").isEmpty()) return;
        Intent i = new Intent(ctx, AlertService.class);
        if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i);
        else ctx.startService(i);
    }

    static void stop(Context ctx) {
        ctx.getSharedPreferences(PREFS, MODE_PRIVATE).edit().clear().apply();
        ctx.stopService(new Intent(ctx, AlertService.class));
    }

    static boolean active(Context ctx) {
        return !ctx.getSharedPreferences(PREFS, MODE_PRIVATE).getString("token", "").isEmpty();
    }

    /** El repartidor salto ese pedido: ya no le suena. */
    static void skip(Context ctx, String id) {
        SharedPreferences sp = ctx.getSharedPreferences(PREFS, MODE_PRIVATE);
        Set<String> s = new HashSet<>(sp.getStringSet("skipped", new HashSet<>()));
        s.add(id);
        if (s.size() > 100) s.clear();
        sp.edit().putStringSet("skipped", s).apply();
        resume(ctx); // revisa ya
    }

    // -----------------------------------------------------------------------

    @Override
    public void onCreate() {
        super.onCreate();
        channels(this);
        thread = new HandlerThread("nayo-alertas");
        thread.start();
        handler = new Handler(thread.getLooper());
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "nayo:alertas");
        wake.setReferenceCounted(false);
        wake.acquire();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification n = watchNotification();
        if (Build.VERSION.SDK_INT >= 34) startForeground(ID_WATCH, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(ID_WATCH, n);
        handler.removeCallbacksAndMessages(null);
        handler.post(this::poll);
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        thread.quitSafely();
        stopRinging();
        if (wake.isHeld()) wake.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void poll() {
        SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
        String api = sp.getString("api", "");
        String token = sp.getString("token", "");
        int every = sp.getInt("every", 8);
        if (token.isEmpty() || api.isEmpty()) {
            stopSelf();
            return;
        }
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(api + "/api/alertas").openConnection();
            c.setConnectTimeout(8000);
            c.setReadTimeout(8000);
            c.setRequestProperty("Authorization", "Bearer " + token);
            int code = c.getResponseCode();
            if (code == 401) {
                // La cuenta se desactivo o cambio su contraseña: hay que volver a entrar.
                c.disconnect();
                stopRinging();
                sp.edit().clear().apply();
                stopSelf();
                return;
            }
            if (code == 200) {
                failures = 0;
                JSONArray pending = new JSONObject(read(c)).optJSONArray("pending");
                Set<String> skipped = sp.getStringSet("skipped", new HashSet<>());
                JSONObject first = null;
                for (int i = 0; pending != null && i < pending.length(); i++) {
                    JSONObject o = pending.optJSONObject(i);
                    if (o != null && !skipped.contains(o.optString("id"))) {
                        first = o;
                        break;
                    }
                }
                if (first == null) stopRinging();
                else ring(first);
            } else {
                failures++;
            }
            c.disconnect();
        } catch (Exception e) {
            failures++; // sin internet: se reintenta
        }
        handler.postDelayed(this::poll, (failures > 3 ? 20 : every) * 1000L);
    }

    // -----------------------------------------------------------------------
    // Sonar
    // -----------------------------------------------------------------------

    private void ring(JSONObject order) {
        String id = order.optString("id");
        String title = order.optString("title", "Nuevo pedido");
        String body = order.optString("body", "");
        String link = order.optString("link", "");
        Intent open = AlertActivity.intent(this, title, body, link);
        PendingIntent full = PendingIntent.getActivity(this, 1, open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CH_ORDER) : new Notification.Builder(this);
        b.setSmallIcon(R.drawable.ic_stat_nayo)
            .setContentTitle(title)
            .setContentText(body)
            .setCategory(Notification.CATEGORY_CALL)
            .setPriority(Notification.PRIORITY_MAX)
            .setOngoing(true)
            .setAutoCancel(false)
            .setContentIntent(full)
            .setFullScreenIntent(full, true)
            .setVisibility(Notification.VISIBILITY_PUBLIC);
        ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(ID_ORDER, b.build());

        // Encima de cualquier app (permiso "Mostrar sobre otras apps"). Sin el
        // permiso, Android la muestra igual con el telefono bloqueado.
        boolean fresh = !ringing || !id.equals(ringingId);
        if (fresh && (Build.VERSION.SDK_INT < 23 || Settings.canDrawOverlays(this))) {
            try {
                startActivity(open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (Exception ignored) {
                // Android no dejo abrirla: queda la notificacion de pantalla completa
            }
        }
        ringingId = id;
        AlertActivity.update(title, body, link);
        if (ringing) return;
        ringing = true;
        try {
            player = new MediaPlayer();
            player.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
            player.setDataSource(this, android.net.Uri.parse("android.resource://" + getPackageName() + "/" + R.raw.nayo_pedido));
            player.setLooping(true);
            player.prepare();
            player.start();
        } catch (Exception ignored) {
            player = null;
        }
        Vibrator v = (Vibrator) getSystemService(VIBRATOR_SERVICE);
        if (v != null) {
            if (Build.VERSION.SDK_INT >= 26) v.vibrate(VibrationEffect.createWaveform(VIBRATE, 0));
            else v.vibrate(VIBRATE, 0);
        }
    }

    private void stopRinging() {
        if (!ringing) return;
        ringing = false;
        ringingId = "";
        if (player != null) {
            try {
                player.stop();
                player.release();
            } catch (Exception ignored) {
                // ya estaba detenido
            }
            player = null;
        }
        Vibrator v = (Vibrator) getSystemService(VIBRATOR_SERVICE);
        if (v != null) v.cancel();
        ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).cancel(ID_ORDER);
        AlertActivity.dismiss();
    }

    // -----------------------------------------------------------------------

    private Notification watchNotification() {
        Intent app = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, app, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CH_WATCH) : new Notification.Builder(this);
        return b.setSmallIcon(R.drawable.ic_stat_nayo)
            .setContentTitle(getString(R.string.app_name))
            .setContentText("Atento a pedidos nuevos")
            .setOngoing(true)
            .setContentIntent(pi)
            .build();
    }

    static void channels(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) ctx.getSystemService(NOTIFICATION_SERVICE);
        NotificationChannel watch = new NotificationChannel(CH_WATCH, "Atento a pedidos", NotificationManager.IMPORTANCE_MIN);
        watch.setShowBadge(false);
        nm.createNotificationChannel(watch);
        // El tono lo toca el servicio (en bucle); el canal va sin sonido propio.
        NotificationChannel order = new NotificationChannel(CH_ORDER, "Pedidos nuevos", NotificationManager.IMPORTANCE_HIGH);
        order.setSound(null, null);
        order.enableVibration(false);
        order.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        order.setBypassDnd(true);
        nm.createNotificationChannel(order);
    }

    private static String read(HttpURLConnection c) throws Exception {
        StringBuilder sb = new StringBuilder();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) sb.append(line);
        }
        return sb.toString();
    }
}
