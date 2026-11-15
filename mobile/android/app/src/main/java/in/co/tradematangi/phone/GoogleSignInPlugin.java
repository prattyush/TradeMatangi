package in.co.tradematangi.phone;

import android.app.Activity;
import androidx.annotation.NonNull;
import androidx.core.content.ContextCompat;
import androidx.credentials.Credential;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.CustomCredential;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.exceptions.GetCredentialCancellationException;
import androidx.credentials.exceptions.GetCredentialException;
import androidx.credentials.exceptions.GetCredentialProviderConfigurationException;
import androidx.credentials.exceptions.NoCredentialException;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption;
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;

/**
 * Native "Sign in with Google": shows Google's account chooser (Android Credential Manager) and returns a Google ID
 * token whose audience is the server's Web client ID. The server verifies it at /api/auth/desktop/google-token.
 * The token is handed straight to the web layer; nothing is stored or logged here.
 *
 * Reject codes: "config" (no client id), "cancelled", "no_account", "provider" (Google Play services missing or
 * out of date), "unsupported", "failed" (message carries Google's own text, which includes 28444 when the Android
 * OAuth client does not match the package and signing key).
 */
@CapacitorPlugin(name = "GoogleSignIn")
public class GoogleSignInPlugin extends Plugin {

    @PluginMethod
    public void signIn(final PluginCall call) {
        final String serverClientId = call.getString("serverClientId");
        if (serverClientId == null || serverClientId.trim().isEmpty()) {
            call.reject("serverClientId is required", "config");
            return;
        }
        final Activity activity = getActivity();
        if (activity == null) {
            call.reject("The app is not in the foreground", "failed");
            return;
        }
        GetSignInWithGoogleOption option = new GetSignInWithGoogleOption.Builder(serverClientId.trim()).build();
        GetCredentialRequest request = new GetCredentialRequest.Builder().addCredentialOption(option).build();
        CredentialManager.create(activity).getCredentialAsync(
            activity,
            request,
            null,
            ContextCompat.getMainExecutor(activity),
            new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                @Override
                public void onResult(GetCredentialResponse response) {
                    Credential credential = response.getCredential();
                    if (!(credential instanceof CustomCredential)
                        || !GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL.equals(credential.getType())) {
                        call.reject("Google returned an unexpected kind of credential", "unsupported");
                        return;
                    }
                    try {
                        GoogleIdTokenCredential google = GoogleIdTokenCredential.createFrom(credential.getData());
                        JSObject result = new JSObject();
                        result.put("idToken", google.getIdToken());
                        result.put("email", google.getId());
                        result.put("name", google.getDisplayName());
                        call.resolve(result);
                    } catch (RuntimeException error) {
                        // GoogleIdTokenParsingException is a Kotlin exception Java cannot name in a catch; any parsing failure lands here.
                        call.reject("Google returned a token the app could not read", "unsupported");
                    }
                }

                @Override
                public void onError(@NonNull GetCredentialException error) {
                    if (error instanceof GetCredentialCancellationException) {
                        call.reject("Sign-in was cancelled", "cancelled");
                    } else if (error instanceof NoCredentialException) {
                        call.reject("No Google account is available on this phone", "no_account");
                    } else if (error instanceof GetCredentialProviderConfigurationException) {
                        call.reject("Google Play services is missing or needs an update", "provider");
                    } else {
                        String message = error.getMessage() == null ? "" : error.getMessage();
                        call.reject(error.getType() + ": " + message, "failed");
                    }
                }
            }
        );
    }
}
