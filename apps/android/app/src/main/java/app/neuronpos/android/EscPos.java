package app.neuronpos.android;

import android.graphics.Bitmap;

import java.io.ByteArrayOutputStream;

/**
 * Convierte un Bitmap a comandos ESC/POS (imagen GS v 0, avance y corte),
 * igual que la app de escritorio (apps/desktop/src/escpos.js).
 */
final class EscPos {
    static final byte ESC = 0x1b;
    static final byte GS = 0x1d;

    private EscPos() {}

    static int dotsFor(int paper) {
        return paper == 58 ? 384 : 576;
    }

    static byte[] drawerPulse() {
        return new byte[] {ESC, 0x40, ESC, 0x70, 0x00, 0x19, (byte) 0xfa};
    }

    static byte[] raster(Bitmap bmp, boolean openDrawer) {
        int width = bmp.getWidth();
        int height = bmp.getHeight();
        int bytesPerRow = (width + 7) / 8;
        byte[] data = new byte[bytesPerRow * height];
        int[] row = new int[width];
        int last = 0;
        for (int y = 0; y < height; y++) {
            bmp.getPixels(row, 0, width, 0, y, width, 1);
            boolean any = false;
            for (int x = 0; x < width; x++) {
                int c = row[x];
                int a = (c >>> 24) & 0xff;
                int r = (c >> 16) & 0xff;
                int g = (c >> 8) & 0xff;
                int b = c & 0xff;
                double lum = (0.299 * r + 0.587 * g + 0.114 * b) * (a / 255.0) + 255 * (1 - a / 255.0);
                if (lum < 160) {
                    data[y * bytesPerRow + (x >> 3)] |= (byte) (0x80 >> (x & 7));
                    any = true;
                }
            }
            if (any) last = y;
        }
        height = Math.max(1, last + 1); // sin filas blancas al final

        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(ESC);
        out.write(0x40);
        if (openDrawer) out.write(drawerPulse(), 2, 5);
        for (int y = 0; y < height; y += 256) {
            int rows = Math.min(256, height - y);
            out.write(GS);
            out.write(0x76);
            out.write(0x30);
            out.write(0x00);
            out.write(bytesPerRow & 0xff);
            out.write(bytesPerRow >> 8);
            out.write(rows & 0xff);
            out.write(rows >> 8);
            out.write(data, y * bytesPerRow, rows * bytesPerRow);
        }
        out.write(ESC);
        out.write(0x64);
        out.write(4);
        out.write(GS);
        out.write(0x56);
        out.write(0x42);
        out.write(0x00);
        return out.toByteArray();
    }
}
