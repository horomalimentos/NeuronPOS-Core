package app.neuronpos.android;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Apps de Nayo: al prender el telefono (o actualizar la app) vuelve a estar atenta a pedidos. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        String a = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(a) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)) {
            AlertService.resume(ctx);
        }
    }
}
