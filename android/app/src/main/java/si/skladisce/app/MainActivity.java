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
import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattServer;
import android.bluetooth.BluetoothGattServerCallback;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;
import androidx.core.app.ActivityCompat;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Collections;
import java.util.UUID;
import java.util.zip.GZIPInputStream;
import java.util.zip.GZIPOutputStream;

public class MainActivity extends BridgeActivity {
    public static String pendingIncomingJson = null;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MLKitDirectPlugin.class);
        registerPlugin(NativeFileSaverPlugin.class);
        registerPlugin(BLESyncPlugin.class);
        super.onCreate(savedInstanceState);
        handleIncomingIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleIncomingIntent(intent);
    }

    private void handleIncomingIntent(Intent intent) {
        if (intent == null) return;
        Uri uri = intent.getData();
        if (uri == null && intent.hasExtra(Intent.EXTRA_STREAM)) {
            uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        }
        if (uri != null) {
            try {
                java.io.InputStream is = getContentResolver().openInputStream(uri);
                if (is != null) {
                    java.io.BufferedReader reader = new java.io.BufferedReader(new java.io.InputStreamReader(is));
                    StringBuilder sb = new StringBuilder();
                    String line;
                    while ((line = reader.readLine()) != null) {
                        sb.append(line);
                    }
                    reader.close();
                    pendingIncomingJson = sb.toString();
                }
            } catch (Exception e) {
                e.printStackTrace();
            }
        }
    }

    @Override
    public boolean dispatchKeyEvent(android.view.KeyEvent event) {
        int action = event.getAction();
        int keyCode = event.getKeyCode();
        if (action == android.view.KeyEvent.ACTION_DOWN) {
            if (keyCode == android.view.KeyEvent.KEYCODE_VOLUME_UP) {
                if (getBridge() != null && getBridge().getWebView() != null) {
                    getBridge().getWebView().post(() -> {
                        getBridge().getWebView().evaluateJavascript("if (window.handleHardwareVolumeKey) { window.handleHardwareVolumeKey('up'); }", null);
                    });
                    return true;
                }
            } else if (keyCode == android.view.KeyEvent.KEYCODE_VOLUME_DOWN) {
                if (getBridge() != null && getBridge().getWebView() != null) {
                    getBridge().getWebView().post(() -> {
                        getBridge().getWebView().evaluateJavascript("if (window.handleHardwareVolumeKey) { window.handleHardwareVolumeKey('down'); }", null);
                    });
                    return true;
                }
            }
        }
        return super.dispatchKeyEvent(event);
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

        @PluginMethod
        public void shareFile(PluginCall call) {
            String base64Data = call.getString("base64");
            String fileName = call.getString("fileName");
            String mimeType = call.getString("mimeType", "application/json");

            if (base64Data == null || base64Data.isEmpty()) {
                call.reject("Manjkajo podatki datoteke (base64).");
                return;
            }
            if (fileName == null || fileName.isEmpty()) {
                fileName = "skladisce-zaloga.skladisce";
            }
            if (base64Data.contains(",")) {
                base64Data = base64Data.substring(base64Data.indexOf(",") + 1);
            }

            try {
                byte[] fileBytes = Base64.decode(base64Data, Base64.DEFAULT);
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

                Intent shareIntent = new Intent(Intent.ACTION_SEND);
                shareIntent.setType(mimeType);
                shareIntent.putExtra(Intent.EXTRA_STREAM, contentUri);
                shareIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

                Intent chooser = Intent.createChooser(shareIntent, "Deli zalogo (Quick Share / Bluetooth)");
                chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(chooser);

                JSObject ret = new JSObject();
                ret.put("success", true);
                ret.put("fileName", fileName);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Napaka pri deljenju: " + e.getMessage());
            }
        }

        @PluginMethod
        public void checkIncomingSync(PluginCall call) {
            JSObject ret = new JSObject();
            if (MainActivity.pendingIncomingJson != null && !MainActivity.pendingIncomingJson.isEmpty()) {
                ret.put("hasData", true);
                ret.put("jsonData", MainActivity.pendingIncomingJson);
                MainActivity.pendingIncomingJson = null; // prebrano
            } else {
                ret.put("hasData", false);
            }
            call.resolve(ret);
        }
    }

    @CapacitorPlugin(name = "BLESync")
    public static class BLESyncPlugin extends Plugin {
        private static final UUID SERVICE_UUID = UUID.fromString("0000FE55-0000-1000-8000-00805F9B34FB");
        private static final UUID CHAR_DATA_UUID = UUID.fromString("0000FE56-0000-1000-8000-00805F9B34FB");
        private static final UUID CHAR_CTRL_UUID = UUID.fromString("0000FE57-0000-1000-8000-00805F9B34FB");
        private static final UUID CCCD_UUID = UUID.fromString("00002902-0000-1000-8000-00805F9B34FB");
        private static final byte[] EOF_MARKER = "__EOF__".getBytes(StandardCharsets.UTF_8);

        private BluetoothManager bluetoothManager;
        private BluetoothAdapter bluetoothAdapter;
        private BluetoothLeAdvertiser advertiser;
        private BluetoothGattServer gattServer;
        private BluetoothLeScanner scanner;
        private BluetoothGatt connectedGatt;

        private byte[] payloadToSend = null;
        private ByteArrayOutputStream receiveBuffer = null;
        private PluginCall activeSendCall = null;
        private PluginCall activeReceiveCall = null;
        private Handler mainHandler = new Handler(Looper.getMainLooper());
        private Runnable timeoutRunnable = null;

        private boolean hasPermissions() {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                return ActivityCompat.checkSelfPermission(getContext(), Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED &&
                       ActivityCompat.checkSelfPermission(getContext(), Manifest.permission.BLUETOOTH_ADVERTISE) == PackageManager.PERMISSION_GRANTED &&
                       ActivityCompat.checkSelfPermission(getContext(), Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED;
            } else {
                return ActivityCompat.checkSelfPermission(getContext(), Manifest.permission.BLUETOOTH) == PackageManager.PERMISSION_GRANTED &&
                       ActivityCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
            }
        }

        private void requestBlePermissions() {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                ActivityCompat.requestPermissions(getActivity(), new String[]{
                    Manifest.permission.BLUETOOTH_SCAN,
                    Manifest.permission.BLUETOOTH_ADVERTISE,
                    Manifest.permission.BLUETOOTH_CONNECT
                }, 101);
            } else {
                ActivityCompat.requestPermissions(getActivity(), new String[]{
                    Manifest.permission.BLUETOOTH,
                    Manifest.permission.BLUETOOTH_ADMIN,
                    Manifest.permission.ACCESS_FINE_LOCATION
                }, 101);
            }
        }

        private byte[] compress(String str) {
            try {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                GZIPOutputStream gzip = new GZIPOutputStream(out);
                gzip.write(str.getBytes(StandardCharsets.UTF_8));
                gzip.close();
                return out.toByteArray();
            } catch (Exception e) {
                return str.getBytes(StandardCharsets.UTF_8);
            }
        }

        private String decompress(byte[] bytes) {
            try {
                ByteArrayInputStream in = new ByteArrayInputStream(bytes);
                GZIPInputStream gzip = new GZIPInputStream(in);
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[1024];
                int len;
                while ((len = gzip.read(buf)) > 0) {
                    out.write(buf, 0, len);
                }
                gzip.close();
                return out.toString("UTF-8");
            } catch (Exception e) {
                return new String(bytes, StandardCharsets.UTF_8);
            }
        }

        @PluginMethod
        public void startSending(PluginCall call) {
            if (!hasPermissions()) {
                requestBlePermissions();
                call.reject("Dovoljenja za Bluetooth še niso potrjena. Prosimo potrdite dostop in poskusite znova.");
                return;
            }

            cleanup();
            activeSendCall = call;

            String jsonData = call.getString("data");
            if (jsonData == null || jsonData.isEmpty()) {
                call.reject("Manjkajo podatki za pošiljanje.");
                return;
            }

            payloadToSend = compress(jsonData);

            bluetoothManager = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
            if (bluetoothManager == null) {
                call.reject("Bluetooth na napravi ni na voljo.");
                return;
            }
            bluetoothAdapter = bluetoothManager.getAdapter();
            if (bluetoothAdapter == null || !bluetoothAdapter.isEnabled()) {
                call.reject("Bluetooth je izklopljen. Prosimo vklopite Bluetooth.");
                return;
            }

            advertiser = bluetoothAdapter.getBluetoothLeAdvertiser();
            if (advertiser == null) {
                call.reject("Ta naprava ne podpira BLE oddajanja.");
                return;
            }

            // 1. Nastavi lokalni GATT Server
            gattServer = bluetoothManager.openGattServer(getContext(), new BluetoothGattServerCallback() {
                @Override
                public void onConnectionStateChange(BluetoothDevice device, int status, int newState) {
                    // Povezava odjemalca
                }

                @Override
                public void onMtuChanged(BluetoothDevice device, int mtu) {
                    // MTU potrjen
                }

                @Override
                public void onCharacteristicWriteRequest(BluetoothDevice device, int requestId, BluetoothGattCharacteristic characteristic, boolean preparedWrite, boolean responseNeeded, int offset, byte[] value) {
                    if (responseNeeded) {
                        try {
                            gattServer.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value);
                        } catch (SecurityException ignored) {}
                    }
                    String cmd = new String(value, StandardCharsets.UTF_8);
                    if ("START".equals(cmd)) {
                        streamPayloadToDevice(device);
                    }
                }

                @Override
                public void onDescriptorWriteRequest(BluetoothDevice device, int requestId, BluetoothGattDescriptor descriptor, boolean preparedWrite, boolean responseNeeded, int offset, byte[] value) {
                    if (responseNeeded) {
                        try {
                            gattServer.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value);
                        } catch (SecurityException ignored) {}
                    }
                }
            });

            BluetoothGattService service = new BluetoothGattService(SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY);

            BluetoothGattCharacteristic dataChar = new BluetoothGattCharacteristic(
                CHAR_DATA_UUID,
                BluetoothGattCharacteristic.PROPERTY_READ | BluetoothGattCharacteristic.PROPERTY_NOTIFY,
                BluetoothGattCharacteristic.PERMISSION_READ
            );
            BluetoothGattDescriptor cccd = new BluetoothGattDescriptor(CCCD_UUID, BluetoothGattDescriptor.PERMISSION_READ | BluetoothGattDescriptor.PERMISSION_WRITE);
            dataChar.addDescriptor(cccd);
            service.addCharacteristic(dataChar);

            BluetoothGattCharacteristic ctrlChar = new BluetoothGattCharacteristic(
                CHAR_CTRL_UUID,
                BluetoothGattCharacteristic.PROPERTY_WRITE,
                BluetoothGattCharacteristic.PERMISSION_WRITE
            );
            service.addCharacteristic(ctrlChar);

            try {
                gattServer.addService(service);
            } catch (SecurityException e) {
                call.reject("Napaka pri dodajanju BLE storitve: " + e.getMessage());
                return;
            }

            // 2. Začni oddajanje
            AdvertiseSettings settings = new AdvertiseSettings.Builder()
                .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
                .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
                .setConnectable(true)
                .setTimeout(60000)
                .build();

            AdvertiseData data = new AdvertiseData.Builder()
                .setIncludeDeviceName(false)
                .addServiceUuid(new ParcelUuid(SERVICE_UUID))
                .build();

            try {
                advertiser.startAdvertising(settings, data, new AdvertiseCallback() {
                    @Override
                    public void onStartSuccess(AdvertiseSettings settingsInEffect) {
                        JSObject notify = new JSObject();
                        notify.put("status", "broadcasting");
                        notify.put("bytes", payloadToSend.length);
                    }

                    @Override
                    public void onStartFailure(int errorCode) {
                        if (activeSendCall != null) {
                            activeSendCall.reject("Oddajanje BLE ni uspelo (koda: " + errorCode + ")");
                            activeSendCall = null;
                        }
                        cleanup();
                    }
                });
            } catch (SecurityException e) {
                call.reject("Varnostna napaka: " + e.getMessage());
            }

            timeoutRunnable = () -> {
                if (activeSendCall != null) {
                    activeSendCall.reject("Čas za povezavo je potekel.");
                    activeSendCall = null;
                }
                cleanup();
            };
            mainHandler.postDelayed(timeoutRunnable, 60000);
        }

        private void streamPayloadToDevice(BluetoothDevice device) {
            new Thread(() -> {
                try {
                    BluetoothGattService svc = gattServer.getService(SERVICE_UUID);
                    if (svc == null) return;
                    BluetoothGattCharacteristic dataChar = svc.getCharacteristic(CHAR_DATA_UUID);
                    if (dataChar == null) return;

                    int chunkSize = 240;
                    int totalLen = payloadToSend.length;
                    int offset = 0;

                    while (offset < totalLen) {
                        int currentChunk = Math.min(chunkSize, totalLen - offset);
                        byte[] chunk = Arrays.copyOfRange(payloadToSend, offset, offset + currentChunk);
                        dataChar.setValue(chunk);
                        try {
                            gattServer.notifyCharacteristicChanged(device, dataChar, false);
                        } catch (SecurityException ignored) {}
                        offset += currentChunk;
                        Thread.sleep(15);
                    }

                    Thread.sleep(30);
                    dataChar.setValue(EOF_MARKER);
                    try {
                        gattServer.notifyCharacteristicChanged(device, dataChar, false);
                    } catch (SecurityException ignored) {}

                    mainHandler.post(() -> {
                        if (activeSendCall != null) {
                            JSObject ret = new JSObject();
                            ret.put("success", true);
                            ret.put("bytesSent", totalLen);
                            activeSendCall.resolve(ret);
                            activeSendCall = null;
                        }
                        cleanup();
                    });
                } catch (Exception e) {
                    mainHandler.post(() -> {
                        if (activeSendCall != null) {
                            activeSendCall.reject("Napaka pri prenosu: " + e.getMessage());
                            activeSendCall = null;
                        }
                        cleanup();
                    });
                }
            }).start();
        }

        @PluginMethod
        public void startReceiving(PluginCall call) {
            if (!hasPermissions()) {
                requestBlePermissions();
                call.reject("Dovoljenja za Bluetooth še niso potrjena. Prosimo potrdite dostop in poskusite znova.");
                return;
            }

            cleanup();
            activeReceiveCall = call;
            receiveBuffer = new ByteArrayOutputStream();

            bluetoothManager = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
            if (bluetoothManager == null) {
                call.reject("Bluetooth ni na voljo.");
                return;
            }
            bluetoothAdapter = bluetoothManager.getAdapter();
            if (bluetoothAdapter == null || !bluetoothAdapter.isEnabled()) {
                call.reject("Bluetooth je izklopljen. Prosimo vklopite Bluetooth.");
                return;
            }

            scanner = bluetoothAdapter.getBluetoothLeScanner();
            if (scanner == null) {
                call.reject("BLE skener ni na voljo.");
                return;
            }

            ScanFilter filter = new ScanFilter.Builder()
                .setServiceUuid(new ParcelUuid(SERVICE_UUID))
                .build();

            ScanSettings settings = new ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                .build();

            try {
                scanner.startScan(Collections.singletonList(filter), settings, new ScanCallback() {
                    @Override
                    public void onScanResult(int callbackType, ScanResult result) {
                        BluetoothDevice device = result.getDevice();
                        if (device != null) {
                            try {
                                scanner.stopScan(this);
                            } catch (SecurityException ignored) {}
                            connectToSender(device);
                        }
                    }

                    @Override
                    public void onScanFailed(int errorCode) {
                        if (activeReceiveCall != null) {
                            activeReceiveCall.reject("Skeniranje ni uspelo (koda: " + errorCode + ")");
                            activeReceiveCall = null;
                        }
                        cleanup();
                    }
                });
            } catch (SecurityException e) {
                call.reject("Varnostna napaka pri skeniranju: " + e.getMessage());
                return;
            }

            timeoutRunnable = () -> {
                if (activeReceiveCall != null) {
                    activeReceiveCall.reject("Ni bilo mogoče najti sodelavca v bližini. Poskusite znova.");
                    activeReceiveCall = null;
                }
                cleanup();
            };
            mainHandler.postDelayed(timeoutRunnable, 40000);
        }

        private void connectToSender(BluetoothDevice device) {
            try {
                connectedGatt = device.connectGatt(getContext(), false, new BluetoothGattCallback() {
                    @Override
                    public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
                        if (newState == BluetoothProfile.STATE_CONNECTED) {
                            try {
                                gatt.requestMtu(512);
                            } catch (SecurityException ignored) {}
                        } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                            if (activeReceiveCall != null) {
                                activeReceiveCall.reject("Povezava je bila prekinjena pred zaključkom.");
                                activeReceiveCall = null;
                            }
                            cleanup();
                        }
                    }

                    @Override
                    public void onMtuChanged(BluetoothGatt gatt, int mtu, int status) {
                        try {
                            gatt.discoverServices();
                        } catch (SecurityException ignored) {}
                    }

                    @Override
                    public void onServicesDiscovered(BluetoothGatt gatt, int status) {
                        if (status != BluetoothGatt.GATT_SUCCESS) return;

                        BluetoothGattService svc = gatt.getService(SERVICE_UUID);
                        if (svc == null) return;

                        BluetoothGattCharacteristic dataChar = svc.getCharacteristic(CHAR_DATA_UUID);
                        BluetoothGattCharacteristic ctrlChar = svc.getCharacteristic(CHAR_CTRL_UUID);
                        if (dataChar == null || ctrlChar == null) return;

                        try {
                            gatt.setCharacteristicNotification(dataChar, true);
                            BluetoothGattDescriptor desc = dataChar.getDescriptor(CCCD_UUID);
                            if (desc != null) {
                                desc.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                                gatt.writeDescriptor(desc);
                            }

                            mainHandler.postDelayed(() -> {
                                try {
                                    ctrlChar.setValue("START".getBytes(StandardCharsets.UTF_8));
                                    gatt.writeCharacteristic(ctrlChar);
                                } catch (SecurityException ignored) {}
                            }, 100);
                        } catch (SecurityException ignored) {}
                    }

                    @Override
                    public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic) {
                        byte[] val = characteristic.getValue();
                        if (val == null || val.length == 0) return;

                        if (Arrays.equals(val, EOF_MARKER)) {
                            mainHandler.removeCallbacks(timeoutRunnable);
                            byte[] fullBytes = receiveBuffer.toByteArray();
                            String json = decompress(fullBytes);

                            mainHandler.post(() -> {
                                if (activeReceiveCall != null) {
                                    JSObject ret = new JSObject();
                                    ret.put("success", true);
                                    ret.put("json", json);
                                    ret.put("bytesReceived", fullBytes.length);
                                    activeReceiveCall.resolve(ret);
                                    activeReceiveCall = null;
                                }
                                cleanup();
                            });
                        } else {
                            receiveBuffer.write(val, 0, val.length);
                        }
                    }
                }, BluetoothDevice.TRANSPORT_LE);
            } catch (SecurityException e) {
                if (activeReceiveCall != null) {
                    activeReceiveCall.reject("Varnostna napaka pri povezavi: " + e.getMessage());
                    activeReceiveCall = null;
                }
                cleanup();
            }
        }

        @PluginMethod
        public void cancel(PluginCall call) {
            cleanup();
            JSObject ret = new JSObject();
            ret.put("success", true);
            call.resolve(ret);
        }

        private void cleanup() {
            if (timeoutRunnable != null) {
                mainHandler.removeCallbacks(timeoutRunnable);
                timeoutRunnable = null;
            }
            try {
                if (scanner != null) {
                    scanner.stopScan(new ScanCallback() {});
                    scanner = null;
                }
            } catch (Exception ignored) {}

            try {
                if (advertiser != null) {
                    advertiser.stopAdvertising(new AdvertiseCallback() {});
                    advertiser = null;
                }
            } catch (Exception ignored) {}

            try {
                if (connectedGatt != null) {
                    connectedGatt.disconnect();
                    connectedGatt.close();
                    connectedGatt = null;
                }
            } catch (Exception ignored) {}

            try {
                if (gattServer != null) {
                    gattServer.close();
                    gattServer = null;
                }
            } catch (Exception ignored) {}

            payloadToSend = null;
            receiveBuffer = null;
        }
    }
}
