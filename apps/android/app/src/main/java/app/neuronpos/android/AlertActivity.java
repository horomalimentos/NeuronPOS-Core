package app.neuronpos.android;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.lang.ref.WeakReference;

/**
 * Pantalla de "Nuevo pedido" de las apps de Nayo: sale encima de cualquier app
 * y con el telefono bloqueado mientras AlertService suena. "Ver pedido" abre
 * la app en la pantalla de pedidos; el sonido sigue hasta que el pedido se
 * acepta, se rechaza o se toma (entonces esta pantalla se cierra sola).
 */
public class AlertActivity extends Activity {
    private static final String MUSTARD = "#F2B705";
    private static final String CHARCOAL = "#1F1F1F";
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static WeakReference<AlertActivity> current = new WeakReference<>(null);

    private TextView title;
    private TextView body;
    private String link = "";

    static Intent intent(Context ctx, String title, String body, String link) {
        return new Intent(ctx, AlertActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
            .putExtra("title", title).putExtra("body", body).putExtra("link", link);
    }

    static void update(String t, String b, String l) {
        MAIN.post(() -> {
            AlertActivity a = current.get();
            if (a != null) a.show(t, b, l);
        });
    }

    static void dismiss() {
        MAIN.post(() -> {
            AlertActivity a = current.get();
            if (a != null) a.finish();
        });
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
            KeyguardManager km = (KeyguardManager) getSystemService(KEYGUARD_SERVICE);
            if (km != null) km.requestDismissKeyguard(this, null);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON | WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        float dp = getResources().getDisplayMetrics().density;
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setPadding((int) (28 * dp), (int) (28 * dp), (int) (28 * dp), (int) (28 * dp));
        root.setBackgroundColor(Color.parseColor(MUSTARD));

        ImageView logo = new ImageView(this);
        logo.setImageResource(R.mipmap.ic_launcher);
        root.addView(logo, new LinearLayout.LayoutParams((int) (96 * dp), (int) (96 * dp)));

        title = new TextView(this);
        title.setTextColor(Color.parseColor(CHARCOAL));
        title.setTextSize(28);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setGravity(Gravity.CENTER);
        title.setPadding(0, (int) (24 * dp), 0, (int) (8 * dp));
        root.addView(title);

        body = new TextView(this);
        body.setTextColor(Color.parseColor(CHARCOAL));
        body.setTextSize(18);
        body.setGravity(Gravity.CENTER);
        root.addView(body);

        Button open = new Button(this);
        open.setText("Ver pedido");
        open.setAllCaps(false);
        open.setTextSize(20);
        open.setTypeface(Typeface.DEFAULT_BOLD);
        open.setTextColor(Color.parseColor(MUSTARD));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.parseColor(CHARCOAL));
        bg.setCornerRadius(16 * dp);
        open.setBackground(bg);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, (int) (64 * dp));
        lp.topMargin = (int) (40 * dp);
        open.setOnClickListener(v -> {
            startActivity(new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(MainActivity.EXTRA_PATH, link));
            finish();
        });
        root.addView(open, lp);

        setContentView(root);
        current = new WeakReference<>(this);
        show(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        show(intent);
    }

    @Override
    protected void onDestroy() {
        if (current.get() == this) current = new WeakReference<>(null);
        super.onDestroy();
    }

    private void show(Intent i) {
        show(i.getStringExtra("title"), i.getStringExtra("body"), i.getStringExtra("link"));
    }

    private void show(String t, String b, String l) {
        title.setText(t == null || t.isEmpty() ? "Nuevo pedido" : t);
        body.setText(b == null ? "" : b);
        link = l == null ? "" : l;
    }
}
