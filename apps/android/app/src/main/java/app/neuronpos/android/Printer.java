package app.neuronpos.android;

import android.Manifest;
import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothSocket;
import android.content.Context;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Impresion directa: el HTML del ticket se dibuja en un WebView fuera de la
 * pantalla, se convierte a imagen ESC/POS y se manda a la impresora termica
 * por red (IP:9100) o Bluetooth. Los documentos (recibos de nomina) usan el
 * servicio de impresion de Android.
 */
final class Printer {
    interface Done {
        void done(String error);
    }

    private static final UUID SPP = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");
    private static final int CSS_WIDTH = 288; // ancho de diseno del ticket en px CSS
    private static final ExecutorService IO = Executors.newSingleThreadExecutor();

    private final Activity activity;
    private final FrameLayout offscreen;
    private final Handler main = new Handler(Looper.getMainLooper());
    private WebView documentView; // se conserva mientras Android imprime

    Printer(Activity activity, FrameLayout offscreen) {
        this.activity = activity;
        this.offscreen = offscreen;
    }

    static boolean configured(JSONObject p) {
        String type = p.optString("type", "none");
        return ("network".equals(type) && !p.optString("host").isEmpty())
            || ("bluetooth".equals(type) && !p.optString("address").isEmpty())
            || ("usb".equals(type) && !p.optString("usb").isEmpty());
    }

    /** Imprime con la impresora del rol. Llamar desde el hilo principal. */
    void print(JSONObject printer, String html, boolean openDrawer, Done done) {
        if (!configured(printer)) {
            done.done(null);
            return;
        }
        int paper = printer.optInt("paper", 80);
        boolean drawer = openDrawer && printer.optBoolean("drawer", false);
        render(html, EscPos.dotsFor(paper), (bitmap, error) -> {
            if (error != null) {
                done.done(error);
                return;
            }
            byte[] job = EscPos.raster(bitmap, drawer);
            bitmap.recycle();
            send(printer, job, done);
        });
    }

    void openDrawer(JSONObject printer, Done done) {
        if (!configured(printer) || !printer.optBoolean("drawer", false)) {
            done.done(null);
            return;
        }
        send(printer, EscPos.drawerPulse(), done);
    }

    /** Documento con la ventana de impresion de Android (PDF o impresora del sistema). */
    void printDocument(String html, String title) {
        WebView view = new WebView(activity);
        view.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView v, String url) {
                PrintManager pm = (PrintManager) activity.getSystemService(Context.PRINT_SERVICE);
                pm.print(title, v.createPrintDocumentAdapter(title), new PrintAttributes.Builder().build());
            }
        });
        documentView = view;
        view.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    private interface Rendered {
        void rendered(Bitmap bitmap, String error);
    }

    private void render(String html, int dots, Rendered cb) {
        WebView view = new WebView(activity);
        view.setBackgroundColor(Color.WHITE);
        view.getSettings().setJavaScriptEnabled(true);
        view.getSettings().setUseWideViewPort(true);
        view.getSettings().setLoadWithOverviewMode(true);
        view.setVerticalScrollBarEnabled(false);
        view.setHorizontalScrollBarEnabled(false);
        offscreen.addView(view, new FrameLayout.LayoutParams(dots, 10));
        final boolean[] finished = {false};
        Runnable timeout = () -> {
            if (finished[0]) return;
            finished[0] = true;
            offscreen.removeView(view);
            view.destroy();
            cb.rendered(null, "No se pudo preparar la impresión");
        };
        main.postDelayed(timeout, 15000);
        view.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView v, String url) {
                v.evaluateJavascript("(function(){var imgs=Array.prototype.slice.call(document.images);"
                    + "return imgs.every(function(i){return i.complete;})?Math.ceil(document.documentElement.scrollHeight):-1;})()",
                    value -> measure(v, dots, value, 0, cb, finished, timeout));
            }
        });
        String viewport = "<meta name=\"viewport\" content=\"width=" + CSS_WIDTH + "\">"
            + "<style>@page{margin:0}html,body{margin:0!important;background:#fff!important}"
            + "body{width:" + (CSS_WIDTH - 8) + "px!important;padding:0 4px!important}</style>";
        String doc = html.contains("<head>") ? html.replace("<head>", "<head>" + viewport) : viewport + html;
        view.loadDataWithBaseURL("https://localhost/", doc, "text/html", "utf-8", null);
    }

    private void measure(WebView v, int dots, String value, int tries, Rendered cb, boolean[] finished, Runnable timeout) {
        int cssHeight;
        try {
            cssHeight = (int) Double.parseDouble(value);
        } catch (NumberFormatException e) {
            cssHeight = 0;
        }
        if (cssHeight < 0 && tries < 20) {
            // Todavia carga el logo
            main.postDelayed(() -> v.evaluateJavascript(
                "(function(){var imgs=Array.prototype.slice.call(document.images);"
                    + "return imgs.every(function(i){return i.complete;})?Math.ceil(document.documentElement.scrollHeight):-1;})()",
                val -> measure(v, dots, val, tries + 1, cb, finished, timeout)), 200);
            return;
        }
        if (cssHeight <= 0) cssHeight = 600;
        int height = Math.min((int) Math.ceil(cssHeight * (dots / (double) CSS_WIDTH)) + 8, 20000);
        ViewGroup.LayoutParams lp = v.getLayoutParams();
        lp.width = dots;
        lp.height = height;
        v.setLayoutParams(lp);
        int finalHeight = height;
        main.postDelayed(() -> {
            if (finished[0]) return;
            finished[0] = true;
            main.removeCallbacks(timeout);
            Bitmap bmp = Bitmap.createBitmap(dots, finalHeight, Bitmap.Config.ARGB_8888);
            Canvas canvas = new Canvas(bmp);
            canvas.drawColor(Color.WHITE);
            v.draw(canvas);
            offscreen.removeView(v);
            v.destroy();
            cb.rendered(bmp, null);
        }, 400);
    }

    private void send(JSONObject printer, byte[] data, Done done) {
        String type = printer.optString("type");
        IO.execute(() -> {
            String error = null;
            try {
                if ("bluetooth".equals(type)) sendBluetooth(printer.optString("address"), data);
                else if ("usb".equals(type)) Usb.send(activity, printer.optString("usb"), data);
                else sendTcp(printer.optString("host"), printer.optInt("port", 9100), data);
            } catch (Exception e) {
                error = e.getMessage() == null ? e.toString() : e.getMessage();
            }
            String result = error;
            main.post(() -> done.done(result));
        });
    }

    private static void sendTcp(String host, int port, byte[] data) throws Exception {
        try (Socket s = new Socket()) {
            s.connect(new InetSocketAddress(host, port), 6000);
            s.setSoTimeout(8000);
            OutputStream out = s.getOutputStream();
            out.write(data);
            out.flush();
        } catch (Exception e) {
            throw new Exception("No se pudo conectar con la impresora " + host + ":" + port + " (" + e.getMessage() + ")");
        }
    }

    private void sendBluetooth(String address, byte[] data) throws Exception {
        if (Build.VERSION.SDK_INT >= 31
            && activity.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
            throw new Exception("Falta el permiso de Bluetooth. Ábrelo en Configuración de la app.");
        }
        BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
        if (adapter == null || !adapter.isEnabled()) throw new Exception("Enciende el Bluetooth del dispositivo");
        BluetoothDevice device = adapter.getRemoteDevice(address);
        BluetoothSocket socket = device.createRfcommSocketToServiceRecord(SPP);
        try {
            adapter.cancelDiscovery();
            socket.connect();
            OutputStream out = socket.getOutputStream();
            out.write(data);
            out.flush();
            Thread.sleep(400); // deja que la impresora reciba todo antes de cerrar
        } catch (Exception e) {
            throw new Exception("No se pudo imprimir por Bluetooth (" + e.getMessage() + ")");
        } finally {
            try {
                socket.close();
            } catch (Exception ignored) {
                // ya cerrado
            }
        }
    }
}
