package in.co.tradematangi.phone;

import android.os.Build;
import androidx.annotation.NonNull;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Optional app lock: asks for the phone's fingerprint / face, or its screen lock (PIN, pattern, password) as the
 * fallback. Whether the lock is on is kept by the web layer; this only answers "is the owner of the phone here".
 *
 * Reject codes of authenticate(): "cancelled", "busy", "unavailable" (no screen lock set up), "failed".
 */
@CapacitorPlugin(name = "AppLock")
public class AppLockPlugin extends Plugin {

    private BiometricPrompt activePrompt;

    /** Strong biometrics or the screen lock; Android 9 and 10 cannot combine STRONG with the screen lock, so allow weak there. */
    private int authenticators() {
        return Build.VERSION.SDK_INT >= 30
            ? BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL
            : BiometricManager.Authenticators.BIOMETRIC_WEAK | BiometricManager.Authenticators.DEVICE_CREDENTIAL;
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        int status = BiometricManager.from(getContext()).canAuthenticate(authenticators());
        JSObject result = new JSObject();
        result.put("available", status == BiometricManager.BIOMETRIC_SUCCESS);
        call.resolve(result);
    }

    @PluginMethod
    public void authenticate(final PluginCall call) {
        final FragmentActivity activity = getActivity();
        if (activity == null) {
            call.reject("The app is not in the foreground", "failed");
            return;
        }
        if (BiometricManager.from(getContext()).canAuthenticate(authenticators()) != BiometricManager.BIOMETRIC_SUCCESS) {
            call.reject("Set a screen lock (or a fingerprint) on this phone first", "unavailable");
            return;
        }
        final String title = call.getString("title", "Unlock TradeMatangi");
        activity.runOnUiThread(() -> {
            if (activePrompt != null) {
                call.reject("Already asking", "busy");
                return;
            }
            BiometricPrompt.AuthenticationCallback callback = new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
                    activePrompt = null;
                    call.resolve();
                }

                @Override
                public void onAuthenticationError(int errorCode, @NonNull CharSequence message) {
                    activePrompt = null;
                    boolean cancelled = errorCode == BiometricPrompt.ERROR_USER_CANCELED
                        || errorCode == BiometricPrompt.ERROR_NEGATIVE_BUTTON
                        || errorCode == BiometricPrompt.ERROR_CANCELED;
                    call.reject(message.toString(), cancelled ? "cancelled" : "failed");
                }
                // onAuthenticationFailed (a wrong finger) keeps the prompt open; nothing to do.
            };
            BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
                .setTitle(title)
                .setAllowedAuthenticators(authenticators())
                .build();
            activePrompt = new BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), callback);
            activePrompt.authenticate(info);
        });
    }
}
