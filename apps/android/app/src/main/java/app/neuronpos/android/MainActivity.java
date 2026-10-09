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
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
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
    private static final String START_PATH = IS_KDS ? "/admin/cocina" : "/admin/pos";

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newCachedThreadPool();
    private WebView web;
    private Printer printer;
    private volatile String currentUrl = "";
    private String pendingBluetoothCb;

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

        String url = Config.url(this);
        if (url.isEmpty()) web.loadUrl(SETUP_URL);
        else web.loadUrl(url + START_PATH);
        if (IS_KDS) hideSystemBars();
        checkUpdates();
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
        String origin = Config.origin(Config.url(this));
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
            String url = Config.url(MainActivity.this);
            if (!url.isEmpty()) main.post(() -> web.loadUrl(url + START_PATH));
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
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
