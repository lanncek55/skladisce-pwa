package si.skladisce.app;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Bundle;
import android.util.Base64;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MLKitDirectPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @CapacitorPlugin(name = "MLKitDirect")
    public static class MLKitDirectPlugin extends Plugin {
        @PluginMethod
        public void recognizeBase64(PluginCall call) {
            String base64Data = call.getString("base64");
            if (base64Data == null || base64Data.isEmpty()) {
                call.reject("Base64 string missing");
                return;
            }

            if (base64Data.contains(",")) {
                base64Data = base64Data.substring(base64Data.indexOf(",") + 1);
            }

            try {
                byte[] decodedBytes = Base64.decode(base64Data, Base64.DEFAULT);
                Bitmap bitmap = BitmapFactory.decodeByteArray(decodedBytes, 0, decodedBytes.length);
                if (bitmap == null) {
                    call.reject("Could not decode bitmap");
                    return;
                }

                InputImage image = InputImage.fromBitmap(bitmap, 0);
                com.google.mlkit.vision.text.TextRecognizer recognizer = 
                    TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);

                recognizer.process(image)
                    .addOnSuccessListener(result -> {
                        recognizer.close();
                        JSObject ret = new JSObject();
                        ret.put("text", result.getText());
                        call.resolve(ret);
                    })
                    .addOnFailureListener(e -> {
                        recognizer.close();
                        call.reject(e.getMessage());
                    });
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        }
    }
}
