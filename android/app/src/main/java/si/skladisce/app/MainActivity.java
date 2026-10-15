package si.skladisce.app;

import android.content.ContentValues;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import androidx.core.content.FileProvider;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MLKitDirectPlugin.class);
        registerPlugin(NativeFileSaverPlugin.class);
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

    @CapacitorPlugin(name = "NativeFileSaver")
    public static class NativeFileSaverPlugin extends Plugin {
        @PluginMethod
        public void saveAndOpenFile(PluginCall call) {
            String base64Data = call.getString("base64");
            String fileName = call.getString("fileName");
            String mimeType = call.getString("mimeType", "application/pdf");

            if (base64Data == null || base64Data.isEmpty()) {
                call.reject("Manjkajo podatki datoteke (base64).");
                return;
            }
            if (fileName == null || fileName.isEmpty()) {
                fileName = "dokument-" + System.currentTimeMillis() + ".pdf";
            }

            if (base64Data.contains(",")) {
                base64Data = base64Data.substring(base64Data.indexOf(",") + 1);
            }

            try {
                byte[] fileBytes = Base64.decode(base64Data, Base64.DEFAULT);

                // 1. Shrani v mapo Prenosi (Downloads) na napravi
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
                    values.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);
                    values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);

                    Uri uri = getContext().getContentResolver().insert(
                        MediaStore.Downloads.EXTERNAL_CONTENT_URI, values
                    );
                    if (uri != null) {
                        try (OutputStream os = getContext().getContentResolver().openOutputStream(uri)) {
                            if (os != null) {
                                os.write(fileBytes);
                                os.flush();
                            }
                        }
                    }
                } else {
                    File downloadsDir = Environment.getExternalStoragePublicDirectory(
                        Environment.DIRECTORY_DOWNLOADS
                    );
                    if (!downloadsDir.exists()) downloadsDir.mkdirs();
                    File targetFile = new File(downloadsDir, fileName);
                    try (FileOutputStream fos = new FileOutputStream(targetFile)) {
                        fos.write(fileBytes);
                        fos.flush();
                    }
                    MediaScannerConnection.scanFile(
                        getContext(),
                        new String[]{targetFile.getAbsolutePath()},
                        new String[]{mimeType},
                        null
                    );
                }

                // 2. Shrani kopijo v predpomnilnik za takojšnje odpiranje / deljenje
                File cacheFile = new File(getContext().getCacheDir(), fileName);
                try (FileOutputStream fos = new FileOutputStream(cacheFile)) {
                    fos.write(fileBytes);
                    fos.flush();
                }

                Uri contentUri = FileProvider.getUriForFile(
                    getContext(),
                    getContext().getPackageName() + ".fileprovider",
                    cacheFile
                );

                Intent viewIntent = new Intent(Intent.ACTION_VIEW);
                viewIntent.setDataAndType(contentUri, mimeType);
                viewIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                viewIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

                try {
                    Intent chooser = Intent.createChooser(viewIntent, "Odpri " + fileName);
                    chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    getContext().startActivity(chooser);
                } catch (Exception ex) {
                    // Ignoriraj, če ni nameščenega pregledovalnika
                }

                JSObject ret = new JSObject();
                ret.put("success", true);
                ret.put("fileName", fileName);
                call.resolve(ret);

            } catch (Exception e) {
                call.reject("Napaka pri shranjevanju: " + e.getMessage());
            }
        }
    }
}
