package app.neuronpos.android;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Configuracion local: direccion del restaurante e impresoras (tickets y
 * comandas). Se guarda como JSON en SharedPreferences.
 */
final class Config {
    static final String PLATFORM_DOMAIN = "neuronpos.app";
    private static final String PREFS = "neuronpos";
    private static final String KEY = "config";
    private static final Pattern SLUG = Pattern.compile("^[a-z0-9-]+$");

    private Config() {}

    static JSONObject load(Context ctx) {
        SharedPreferences sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        try {
            return sanitize(new JSONObject(sp.getString(KEY, "{}")));
        } catch (JSONException e) {
            return sanitize(new JSONObject());
        }
    }

    static JSONObject save(Context ctx, JSONObject next) {
        JSONObject clean = sanitize(next);
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, clean.toString()).apply();
        return clean;
    }

    static String url(Context ctx) {
        return load(ctx).optString("url", "");
    }

    static JSONObject printer(Context ctx, String role) {
        JSONObject printers = load(ctx).optJSONObject("printers");
        JSONObject p = printers == null ? null : printers.optJSONObject(role);
        return p == null ? cleanPrinter(null) : p;
    }

    /** "tacos", "tacos.neuronpos.app" o una URL completa -> https://host (solo el origen). */
    static String normalizeUrl(String input) {
        String v = input == null ? "" : input.trim().toLowerCase(Locale.ROOT);
        if (v.isEmpty()) return "";
        if (SLUG.matcher(v).matches()) v = v + "." + PLATFORM_DOMAIN;
        if (!v.startsWith("http://") && !v.startsWith("https://")) v = "https://" + v;
        Uri u = Uri.parse(v);
        if (!"https".equals(u.getScheme()) || u.getHost() == null || u.getHost().isEmpty()) return "";
        return "https://" + u.getHost() + (u.getPort() > 0 ? ":" + u.getPort() : "");
    }

    static String origin(String url) {
        if (url == null) return "";
        Uri u = Uri.parse(url);
        if (u.getScheme() == null || u.getHost() == null) return "";
        return u.getScheme() + "://" + u.getHost() + (u.getPort() > 0 ? ":" + u.getPort() : "");
    }

    private static JSONObject cleanPrinter(JSONObject p) {
        JSONObject o = new JSONObject();
        try {
            String type = p == null ? "none" : p.optString("type", "none");
            if (!type.equals("network") && !type.equals("bluetooth") && !type.equals("usb")) type = "none";
            int port = p == null ? 9100 : p.optInt("port", 9100);
            o.put("type", type);
            o.put("host", p == null ? "" : p.optString("host", "").trim());
            o.put("port", port > 0 && port < 65536 ? port : 9100);
            o.put("address", p == null ? "" : p.optString("address", "").trim());
            o.put("usb", p == null ? "" : p.optString("usb", "").trim()); // "vendorId:productId"
            o.put("name", p == null ? "" : p.optString("name", ""));
            o.put("paper", p != null && p.optInt("paper", 80) == 58 ? 58 : 80);
            o.put("drawer", p != null && p.optBoolean("drawer", false));
        } catch (JSONException ignored) {
            // put() solo falla con claves nulas
        }
        return o;
    }

    static JSONObject sanitize(JSONObject in) {
        JSONObject out = new JSONObject();
        try {
            out.put("url", normalizeUrl(in.optString("url", "")));
            JSONObject printers = in.optJSONObject("printers");
            JSONObject p = new JSONObject();
            p.put("ticket", cleanPrinter(printers == null ? null : printers.optJSONObject("ticket")));
            p.put("comanda", cleanPrinter(printers == null ? null : printers.optJSONObject("comanda")));
            out.put("printers", p);
        } catch (JSONException ignored) {
            // put() solo falla con claves nulas
        }
        return out;
    }
}
