package app.neuronpos.android;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.WindowManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * NeuronPOS / Neuron KDS para Android: abre el sistema del restaurante
 * (https://<restaurante>.neuronpos.app) y le da impresion directa a
 * impresoras termicas por red o Bluetooth (window.NeuronAndroid).
 */
public class MainActivity extends Activity {
    private static final String SETUP_URL = "file:///android_asset/setup.html";
    private static final String OFFLINE_URL = "file:///android_asset/offline.html";
    private static final String UPDATE_URL = "https://" + Config.PLATFORM_DOMAIN + "/api/descargas/android/latest-" + BuildConfig.NEURON_MODE + ".json";
    private static final int REQ_BLUETOOTH = 7;
    static final boolean IS_KDS = "kds".equals(BuildConfig.NEURON_MODE);
    // Apps de Nayo: Restaurante (en el sistema del restaurante) y Repartidor (elnayo.com).
    static final boolean IS_NAYO_REST = "nayorest".equals(BuildConfig.NEURON_MODE);
    static final boolean IS_NAYO_REP = "nayorep".equals(BuildConfig.NEURON_MODE);
    static final boolean IS_NAYO = IS_NAYO_REST || IS_NAYO_REP;
    private static final String NAYO_SITE = "https://elnayo.com";
    private static final String START_PATH = IS_KDS ? "/admin/cocina"
        : IS_NAYO_REST ? "/admin/delivery/pedidos"
        : IS_NAYO_REP ? "/repartidor" : "/admin/pos";
    static final String EXTRA_PATH = "path";
    private static final int REQ_NOTIFICATIONS = 8;
    private static final int REQ_LOCATION = 9;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newCachedThreadPool();
    private WebView web;
    private Printer printer;
    private volatile String currentUrl = "";
    private String pendingBluetoothCb;
    private String pendingGeoOrigin;
    private GeolocationPermissions.Callback pendingGeoCb;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        WebView.enableSlowWholeDocumentDraw(); // para dibujar tickets completos
        super.onCreate(savedInstanceState);
        if (IS_KDS) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#030712"));
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        // Aqui se dibujan los tickets antes de imprimir; queda fuera de la pantalla.
        FrameLayout offscreen = new FrameLayout(this);
        offscreen.setTranslationX(-20000);
        root.addView(offscreen, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT));
        setContentView(root);
        printer = new Printer(this, offscreen);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setAllowFileAccess(true); // solo para las paginas locales de configuracion
        s.setUserAgentString(s.getUserAgentString() + " NeuronPOSAndroid/" + BuildConfig.VERSION_NAME);
        web.addJavascriptInterface(new WebBridge(), "NeuronAndroid");
        web.addJavascriptInterface(new SetupBridge(), "NeuronSetup");
        web.setWebViewClient(new Client());
        if (IS_NAYO) {
            s.setGeolocationEnabled(true);
            web.setWebChromeClient(new Chrome());
        }

        String url = baseUrl();
        if (url.isEmpty()) web.loadUrl(SETUP_URL);
        else web.loadUrl(url + startPath(getIntent()));
        if (IS_KDS) hideSystemBars();
        if (IS_NAYO) AlertService.resume(this);
        checkUpdates();
    }

    /** Origen del sistema: el restaurante configurado o, en el Repartidor, elnayo.com. */
    private String baseUrl() {
        return IS_NAYO_REP ? NAYO_SITE : Config.url(this);
    }

    /** Ruta a abrir: la del aviso tocado (solo rutas internas) o la de inicio. */
    private static String startPath(Intent i) {
        String p = i == null ? null : i.getStringExtra(EXTRA_PATH);
        return p != null && p.startsWith("/") && !p.startsWith("//") ? p : START_PATH;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        String p = intent.getStringExtra(EXTRA_PATH);
        String url = baseUrl();
        if (p != null && !url.isEmpty()) web.loadUrl(url + startPath(intent));
    }

    private void hideSystemBars() {
        web.setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN
            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && IS_KDS) hideSystemBars();
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    // -----------------------------------------------------------------------
    // Navegacion
    // -----------------------------------------------------------------------

    private boolean isRestaurant(String url) {
        String origin = Config.origin(baseUrl());
        return !origin.isEmpty() && origin.equals(Config.origin(url));
    }

    private static boolean isLocal(String url) {
        return url != null && url.startsWith("file:///android_asset/");
    }

    private class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            String url = request.getUrl().toString();
            if (isRestaurant(url) || isLocal(url)) return false;
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl()));
            } catch (Exception ignored) {
                // sin navegador
            }
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            currentUrl = url == null ? "" : url;
        }

        @Override
        public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
            currentUrl = url == null ? "" : url;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (!request.isForMainFrame() || isLocal(request.getUrl().toString())) return;
            String target = Uri.encode(request.getUrl().toString());
            String desc = Uri.encode(String.valueOf(error.getDescription()));
            view.loadUrl(OFFLINE_URL + "?url=" + target + "&error=" + desc);
        }
    }

    // -----------------------------------------------------------------------
    // Ubicacion (apps de Nayo): cuando la pagina pide navigator.geolocation se
    // pide el permiso de Android y se le responde a la pagina.
    // -----------------------------------------------------------------------

    private boolean hasLocation() {
        return Build.VERSION.SDK_INT < 23
            || checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
            || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private class Chrome extends WebChromeClient {
        @Override
        public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback cb) {
            if (!isRestaurant(origin)) {
                cb.invoke(origin, false, false);
                return;
            }
            if (hasLocation()) {
                cb.invoke(origin, true, false);
                return;
            }
            if (pendingGeoCb != null) pendingGeoCb.invoke(pendingGeoOrigin, false, false);
            pendingGeoOrigin = origin;
            pendingGeoCb = cb;
            requestPermissions(new String[] {Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_LOCATION);
        }

        @Override
        public void onGeolocationPermissionsHidePrompt() {
            pendingGeoOrigin = null;
            pendingGeoCb = null;
        }
    }

    private void callback(String id, JSONObject result) {
        if (id == null || id.isEmpty()) return;
        String js = "window.__neuronCb && window.__neuronCb(" + JSONObject.quote(id) + "," + result + ")";
        main.post(() -> web.evaluateJavascript(js, null));
    }

    private static JSONObject ok() {
        return obj("printed", true);
    }

    private static JSONObject obj(String k, Object v) {
        JSONObject o = new JSONObject();
        try {
            o.put(k, v);
        } catch (Exception ignored) {
            // put() solo falla con claves nulas
        }
        return o;
    }

    // -----------------------------------------------------------------------
    // window.NeuronAndroid: solo para las paginas del restaurante
    // -----------------------------------------------------------------------

    private class WebBridge {
        private boolean allowed() {
            return isRestaurant(currentUrl);
        }

        @JavascriptInterface
        public String info() {
            if (!allowed()) return "null";
            JSONObject t = Config.printer(MainActivity.this, "ticket");
            JSONObject c = Config.printer(MainActivity.this, "comanda");
            JSONObject out = new JSONObject();
            try {
                out.put("platform", "android");
                out.put("mode", BuildConfig.NEURON_MODE);
                out.put("version", BuildConfig.VERSION_NAME);
                JSONObject printers = new JSONObject();
                printers.put("ticket", Printer.configured(t));
                printers.put("comanda", Printer.configured(c));
                out.put("printers", printers);
                out.put("drawer", Printer.configured(t) && t.optBoolean("drawer", false));
                // Apps de Nayo: el sonido de pedidos lo hace la app (AlertService).
                out.put("alerts", IS_NAYO);
                out.put("alertsOn", IS_NAYO && AlertService.active(MainActivity.this));
            } catch (Exception ignored) {
                // put() solo falla con claves nulas
            }
            return out.toString();
        }

        @JavascriptInterface
        public void print(String jobJson, String cb) {
            if (!allowed()) {
                callback(cb, obj("error", "No autorizado"));
                return;
            }
            JSONObject job;
            try {
                job = new JSONObject(jobJson);
            } catch (Exception e) {
                callback(cb, obj("error", "Documento inválido"));
                return;
            }
            String role = job.optString("role", "ticket");
            String html = job.optString("html", "");
            boolean drawer = job.optBoolean("openDrawer", false);
            main.post(() -> {
                if ("documento".equals(role)) {
                    printer.printDocument(html, "NeuronPOS");
                    callback(cb, ok());
                    return;
                }
                JSONObject p = Config.printer(MainActivity.this, "comanda".equals(role) ? "comanda" : "ticket");
                if (!Printer.configured(p)) {
                    callback(cb, obj("printed", false));
                    return;
                }
                printer.print(p, html, drawer, error -> callback(cb, error == null ? ok() : obj("error", error)));
            });
        }

        @JavascriptInterface
        public void openDrawer(String cb) {
            if (!allowed()) return;
            main.post(() -> printer.openDrawer(Config.printer(MainActivity.this, "ticket"),
                error -> callback(cb, error == null ? obj("ok", true) : obj("error", error))));
        }

        @JavascriptInterface
        public void openSettings() {
            if (!allowed()) return;
            main.post(() -> web.loadUrl(SETUP_URL));
        }

        // ---- Apps de Nayo: avisos con sonido propio y encima de otras apps ----

        /** La pagina (con sesion) entrega el token de /api/alertas; la app queda atenta. */
        @JavascriptInterface
        public void startAlerts(String token, int everySeconds) {
            if (!allowed() || !IS_NAYO || token == null || token.isEmpty()) return;
            String api = Config.origin(baseUrl());
            main.post(() -> {
                AlertService.start(MainActivity.this, api, token, everySeconds);
                askAlertPermissions();
            });
        }

        /** Al cerrar sesion (o salir de turno el repartidor). */
        @JavascriptInterface
        public void stopAlerts() {
            if (!allowed() || !IS_NAYO) return;
            main.post(() -> AlertService.stop(MainActivity.this));
        }

        /** El repartidor salto ese pedido: deja de sonarle. */
        @JavascriptInterface
        public void skipAlert(String id) {
            if (!allowed() || !IS_NAYO || id == null) return;
            main.post(() -> AlertService.skip(MainActivity.this, id));
        }
    }

    // -----------------------------------------------------------------------
    // Permisos de las apps de Nayo: notificaciones, encima de otras apps y
    // sin ahorro de bateria (para que no se duerma). Se piden una vez.
    // -----------------------------------------------------------------------

    private void askAlertPermissions() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFICATIONS);
            return; // al responder sigue con los demas
        }
        askOverlayAndBattery();
    }

    private void askOverlayAndBattery() {
        android.content.SharedPreferences sp = getSharedPreferences("nayo_permisos", MODE_PRIVATE);
        if (Build.VERSION.SDK_INT >= 23 && !android.provider.Settings.canDrawOverlays(this) && !sp.getBoolean("overlay", false)) {
            sp.edit().putBoolean("overlay", true).apply();
            new AlertDialog.Builder(this)
                .setTitle("Que los pedidos salgan encima")
                .setMessage("Para que el aviso de pedido nuevo aparezca aunque estés en otra app, activa \"Mostrar sobre otras apps\" para " + getString(R.string.app_name) + ".")
                .setPositiveButton("Activar", (d, w) -> {
                    try {
                        startActivity(new Intent(android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getPackageName())));
                    } catch (Exception ignored) {
                        // sin pantalla de ajustes
                    }
                })
                .setNegativeButton("Después", null)
                .show();
            return;
        }
        android.os.PowerManager pm = (android.os.PowerManager) getSystemService(POWER_SERVICE);
        if (Build.VERSION.SDK_INT >= 23 && pm != null && !pm.isIgnoringBatteryOptimizations(getPackageName()) && !sp.getBoolean("battery", false)) {
            sp.edit().putBoolean("battery", true).apply();
            try {
                startActivity(new Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName())));
            } catch (Exception ignored) {
                // el fabricante no tiene esta pantalla
            }
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        // Al volver de los ajustes de "encima de otras apps" sigue con la bateria.
        if (IS_NAYO && AlertService.active(this) && Build.VERSION.SDK_INT >= 23
            && getSharedPreferences("nayo_permisos", MODE_PRIVATE).getBoolean("overlay", false)) {
            askOverlayAndBattery();
        }
    }

    // -----------------------------------------------------------------------
    // window.NeuronSetup: solo para la pagina local de configuracion
    // -----------------------------------------------------------------------

    private class SetupBridge {
        private boolean allowed() {
            return isLocal(currentUrl);
        }

        @JavascriptInterface
        public String get() {
            if (!allowed()) return "null";
            JSONObject out = new JSONObject();
            try {
                out.put("config", Config.load(MainActivity.this));
                out.put("mode", BuildConfig.NEURON_MODE);
                out.put("appName", getString(R.string.app_name));
                out.put("version", BuildConfig.VERSION_NAME);
            } catch (Exception ignored) {
                // put() solo falla con claves nulas
            }
            return out.toString();
        }

        @JavascriptInterface
        public void check(String input, String cb) {
            if (!allowed()) return;
            String origin = Config.normalizeUrl(input);
            if (origin.isEmpty()) {
                callback(cb, obj("error", "Escribe la dirección de tu restaurante, por ejemplo tacos.neuronpos.app"));
                return;
            }
            io.execute(() -> {
                JSONObject res = new JSONObject();
                try {
                    HttpURLConnection c = (HttpURLConnection) new URL(origin + "/api/public/site").openConnection();
                    c.setConnectTimeout(10000);
                    c.setReadTimeout(10000);
                    int code = c.getResponseCode();
                    if (code == 404) {
                        res.put("error", "No encontramos un restaurante en " + origin);
                    } else if (code != 200) {
                        res.put("error", "El servidor respondió " + code);
                    } else {
                        JSONObject site = new JSONObject(read(c));
                        JSONObject r = site.optJSONObject("restaurant");
                        res.put("ok", true);
                        res.put("origin", origin);
                        res.put("name", r == null ? origin : r.optString("name", origin));
                    }
                    c.disconnect();
                } catch (Exception e) {
                    try {
                        res.put("error", "No se pudo conectar con " + origin + ". Revisa la dirección y tu internet.");
                    } catch (Exception ignored) {
                        // put() solo falla con claves nulas
                    }
                }
                callback(cb, res);
            });
        }

        @JavascriptInterface
        public String bluetoothDevices() {
            if (!allowed()) return "[]";
            JSONArray list = new JSONArray();
            try {
                if (Build.VERSION.SDK_INT >= 31 && checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
                    return "[]";
                }
                BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
                if (adapter == null) return "[]";
                for (BluetoothDevice d : adapter.getBondedDevices()) {
                    JSONObject o = new JSONObject();
                    o.put("name", d.getName() == null ? d.getAddress() : d.getName());
                    o.put("address", d.getAddress());
                    list.put(o);
                }
            } catch (Exception ignored) {
                // sin Bluetooth
            }
            return list.toString();
        }

        @JavascriptInterface
        public String usbDevices() {
            if (!allowed()) return "[]";
            return Usb.list(MainActivity.this).toString();
        }

        @JavascriptInterface
        public void requestUsb(String id, String cb) {
            if (!allowed()) return;
            main.post(() -> Usb.requestPermission(MainActivity.this, id,
                ok -> callback(cb, ok ? obj("ok", true) : obj("error", "Sin permiso no se puede usar la impresora USB"))));
        }

        @JavascriptInterface
        public void requestBluetooth(String cb) {
            if (!allowed()) return;
            if (Build.VERSION.SDK_INT < 31 || checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED) {
                callback(cb, obj("ok", true));
                return;
            }
            main.post(() -> {
                pendingBluetoothCb = cb;
                requestPermissions(new String[] {Manifest.permission.BLUETOOTH_CONNECT}, REQ_BLUETOOTH);
            });
        }

        @JavascriptInterface
        public void test(String role, String printerJson, String cb) {
            if (!allowed()) return;
            JSONObject p;
            try {
                JSONObject wrapper = new JSONObject();
                JSONObject printers = new JSONObject();
                printers.put(role, new JSONObject(printerJson));
                wrapper.put("printers", printers);
                p = Config.sanitize(wrapper).getJSONObject("printers").getJSONObject("comanda".equals(role) ? "comanda" : "ticket");
            } catch (Exception e) {
                callback(cb, obj("error", "Datos de impresora inválidos"));
                return;
            }
            if (!Printer.configured(p)) {
                callback(cb, obj("error", "Elige una impresora"));
                return;
            }
            String html = testPage(role, p);
            main.post(() -> printer.print(p, html, false, error -> callback(cb, error == null ? obj("ok", true) : obj("error", error))));
        }

        @JavascriptInterface
        public String save(String configJson) {
            if (!allowed()) return "{\"error\":\"No autorizado\"}";
            try {
                JSONObject saved = Config.save(MainActivity.this, new JSONObject(configJson));
                String url = saved.optString("url");
                if (url.isEmpty()) return "{\"error\":\"Falta la dirección del restaurante\"}";
                main.post(() -> {
                    web.clearHistory();
                    web.loadUrl(url + START_PATH);
                });
                return "{\"ok\":true}";
            } catch (Exception e) {
                return "{\"error\":\"No se pudo guardar\"}";
            }
        }

        @JavascriptInterface
        public void cancel() {
            if (!allowed()) return;
            String url = baseUrl();
            if (!url.isEmpty()) main.post(() -> web.loadUrl(url + START_PATH));
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode == REQ_NOTIFICATIONS) {
            askOverlayAndBattery();
            return;
        }
        if (requestCode == REQ_LOCATION) {
            if (pendingGeoCb != null) pendingGeoCb.invoke(pendingGeoOrigin, hasLocation(), false);
            pendingGeoOrigin = null;
            pendingGeoCb = null;
            return;
        }
        if (requestCode != REQ_BLUETOOTH) return;
        boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        callback(pendingBluetoothCb, granted ? obj("ok", true) : obj("error", "Sin permiso de Bluetooth no se pueden usar impresoras Bluetooth"));
        pendingBluetoothCb = null;
    }

    private static String testPage(String role, JSONObject p) {
        String type = p.optString("type");
        String kind = "bluetooth".equals(type) ? "Bluetooth " + p.optString("name", p.optString("address"))
            : "usb".equals(type) ? "USB " + p.optString("name", p.optString("usb"))
            : "Red " + p.optString("host") + ":" + p.optInt("port", 9100);
        return "<!doctype html><html><head><meta charset=\"utf-8\"><style>"
            + "body{font-family:monospace;font-size:12px;width:72mm;margin:0}h1{font-size:18px;text-align:center;margin:6px 0}"
            + ".c{text-align:center}hr{border:0;border-top:1px dashed #000}</style></head><body>"
            + "<h1>NeuronPOS</h1><div class=\"c\">Prueba de impresora</div><hr>"
            + "<div>Uso: <b>" + ("comanda".equals(role) ? "Comandas de cocina" : "Tickets y cortes") + "</b></div>"
            + "<div>Tipo: " + android.text.TextUtils.htmlEncode(kind) + "</div>"
            + "<div>Papel: " + p.optInt("paper", 80) + " mm</div>"
            + "<div>Acentos: áéíóú ñ Ñ ¿? ¡!</div><hr><div class=\"c\">Android " + BuildConfig.VERSION_NAME + "</div>"
            + "</body></html>";
    }

    private static String read(HttpURLConnection c) throws Exception {
        StringBuilder sb = new StringBuilder();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) sb.append(line);
        }
        return sb.toString();
    }

    // -----------------------------------------------------------------------
    // Actualizaciones: neuronpos.app/api/descargas/android/latest-<modo>.json
    // -----------------------------------------------------------------------

    private void checkUpdates() {
        io.execute(() -> {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(UPDATE_URL).openConnection();
                c.setConnectTimeout(8000);
                c.setReadTimeout(8000);
                if (c.getResponseCode() != 200) return;
                JSONObject latest = new JSONObject(read(c));
                int code = latest.optInt("versionCode", 0);
                String apk = latest.optString("url", "");
                if (code <= BuildConfig.VERSION_CODE || !apk.startsWith("https://")) return;
                String version = latest.optString("versionName", "");
                main.post(() -> new AlertDialog.Builder(this)
                    .setTitle("Nueva versión disponible")
                    .setMessage("Hay una nueva versión de " + getString(R.string.app_name) + " (" + version + "). Descárgala e instálala para seguir al día.")
                    .setPositiveButton("Descargar", (d, w) -> startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(apk))))
                    .setNegativeButton("Después", null)
                    .show());
            } catch (Exception ignored) {
                // sin internet: se revisa la proxima vez
            }
        });
    }
}
