package app.neuronpos.android;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbEndpoint;
import android.hardware.usb.UsbInterface;
import android.hardware.usb.UsbManager;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Impresoras termicas conectadas por USB (tabletas con USB OTG). Se
 * identifican por "vendorId:productId", que no cambia al reconectar.
 */
final class Usb {
    interface Granted {
        void granted(boolean ok);
    }

    private static final String ACTION = "app.neuronpos.android.USB_PERMISSION";

    private Usb() {}

    static String id(UsbDevice d) {
        return d.getVendorId() + ":" + d.getProductId();
    }

    private static UsbEndpoint bulkOut(UsbInterface intf) {
        for (int e = 0; e < intf.getEndpointCount(); e++) {
            UsbEndpoint ep = intf.getEndpoint(e);
            if (ep.getType() == UsbConstants.USB_ENDPOINT_XFER_BULK && ep.getDirection() == UsbConstants.USB_DIR_OUT) return ep;
        }
        return null;
    }

    /** Interfaz de impresora (clase 7) o, si no hay, la primera con salida bulk. */
    private static UsbInterface printerInterface(UsbDevice d) {
        UsbInterface fallback = null;
        for (int i = 0; i < d.getInterfaceCount(); i++) {
            UsbInterface intf = d.getInterface(i);
            if (bulkOut(intf) == null) continue;
            if (intf.getInterfaceClass() == UsbConstants.USB_CLASS_PRINTER) return intf;
            if (fallback == null) fallback = intf;
        }
        return fallback;
    }

    static UsbDevice find(Context ctx, String id) {
        UsbManager mgr = (UsbManager) ctx.getSystemService(Context.USB_SERVICE);
        if (mgr == null) return null;
        for (UsbDevice d : mgr.getDeviceList().values()) {
            if (id(d).equals(id)) return d;
        }
        return null;
    }

    /** Dispositivos conectados que parecen impresoras (tienen salida bulk). */
    static JSONArray list(Context ctx) {
        JSONArray out = new JSONArray();
        UsbManager mgr = (UsbManager) ctx.getSystemService(Context.USB_SERVICE);
        if (mgr == null) return out;
        for (UsbDevice d : mgr.getDeviceList().values()) {
            if (printerInterface(d) == null) continue;
            try {
                JSONObject o = new JSONObject();
                String name = Build.VERSION.SDK_INT >= 21 && d.getProductName() != null ? d.getProductName() : null;
                String maker = Build.VERSION.SDK_INT >= 21 ? d.getManufacturerName() : null;
                o.put("id", id(d));
                o.put("name", name != null ? (maker != null ? maker + " " + name : name) : "Impresora USB " + id(d));
                out.put(o);
            } catch (Exception ignored) {
                // put() solo falla con claves nulas
            }
        }
        return out;
    }

    /** Pide permiso para usar el dispositivo (Android muestra un aviso). */
    static void requestPermission(Context ctx, String id, Granted cb) {
        UsbManager mgr = (UsbManager) ctx.getSystemService(Context.USB_SERVICE);
        UsbDevice d = find(ctx, id);
        if (mgr == null || d == null) {
            cb.granted(false);
            return;
        }
        if (mgr.hasPermission(d)) {
            cb.granted(true);
            return;
        }
        Context app = ctx.getApplicationContext();
        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context c, Intent intent) {
                try {
                    app.unregisterReceiver(this);
                } catch (Exception ignored) {
                    // ya se quito
                }
                cb.granted(intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false));
            }
        };
        IntentFilter filter = new IntentFilter(ACTION);
        if (Build.VERSION.SDK_INT >= 33) app.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED);
        else app.registerReceiver(receiver, filter);
        int flags = Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0;
        Intent intent = new Intent(ACTION).setPackage(app.getPackageName());
        mgr.requestPermission(d, PendingIntent.getBroadcast(app, 0, intent, flags));
    }

    /** Manda los bytes a la impresora. Corre en un hilo de fondo. */
    static void send(Context ctx, String id, byte[] data) throws Exception {
        UsbManager mgr = (UsbManager) ctx.getSystemService(Context.USB_SERVICE);
        UsbDevice d = find(ctx, id);
        if (mgr == null || d == null) throw new Exception("La impresora USB no está conectada");
        if (!mgr.hasPermission(d)) {
            requestPermission(ctx, id, ok -> { });
            throw new Exception("Acepta el permiso para usar la impresora USB y vuelve a imprimir");
        }
        UsbInterface intf = printerInterface(d);
        UsbEndpoint out = intf == null ? null : bulkOut(intf);
        if (out == null) throw new Exception("El dispositivo USB no parece una impresora");
        UsbDeviceConnection conn = mgr.openDevice(d);
        if (conn == null) throw new Exception("No se pudo abrir la impresora USB");
        try {
            if (!conn.claimInterface(intf, true)) throw new Exception("La impresora USB está ocupada");
            int chunk = 16384;
            for (int off = 0; off < data.length; off += chunk) {
                int len = Math.min(chunk, data.length - off);
                byte[] part = new byte[len];
                System.arraycopy(data, off, part, 0, len);
                int sent = conn.bulkTransfer(out, part, len, 10000);
                if (sent < 0) throw new Exception("La impresora USB no recibió los datos");
            }
            conn.releaseInterface(intf);
        } finally {
            conn.close();
        }
    }
}
