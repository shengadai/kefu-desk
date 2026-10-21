package com.kefudesk.app;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import org.json.JSONObject;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "KefuAndroid")
public class KefuAndroidPlugin extends Plugin {
    private static final String KEY_ALIAS = "kefu-desk-webdav-password";

    @PluginMethod
    public void readLibrary(PluginCall call) {
        String workspace = call.getString("workspace", "local");
        String fileName = workspace.equals("cloud") ? "cloud-library.json" : "local-library.json";
        JSObject result = new JSObject();
        result.put("value", readTextFile(fileName));
        call.resolve(result);
    }

    @PluginMethod
    public void writeLibrary(PluginCall call) {
        String workspace = call.getString("workspace", "local");
        if (!workspace.equals("local") && !workspace.equals("cloud")) {
            call.reject("工作区无效");
            return;
        }
        if (workspace.equals("cloud") && !canEditCloudLibrary()) {
            call.reject("安卓端云端工作区为只读，请在主电脑修改话术");
            return;
        }
        saveLibrary(call, workspace);
    }

    @PluginMethod
    public void writeCloudLibraryCache(PluginCall call) {
        saveLibrary(call, "cloud");
    }

    private void saveLibrary(PluginCall call, String workspace) {
        String fileName = workspace.equals("cloud") ? "cloud-library.json" : "local-library.json";
        String value = call.getString("value", "{}");
        try {
            writeTextFile(fileName, value);
            JSObject result = new JSObject();
            result.put("success", true);
            call.resolve(result);
            notifyListeners("libraryChanged", new JSObject().put("workspace", workspace).put("value", value));
        } catch (Exception error) {
            call.reject("无法保存话术库", error);
        }
    }

    private boolean canEditCloudLibrary() {
        String raw = getContext().getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE).getString("android-cloud-sync-settings", null);
        if (raw == null) return false;
        try {
            JSONObject settings = new JSONObject(raw);
            return settings.optBoolean("configured") && "primary".equals(settings.optString("deviceRole"));
        } catch (Exception error) {
            return false;
        }
    }

    @PluginMethod
    public void readAppFile(PluginCall call) {
        String name = safeFileName(call.getString("name", ""));
        if (name == null) {
            call.reject("文件名无效");
            return;
        }
        JSObject result = new JSObject();
        result.put("value", readTextFile(name));
        call.resolve(result);
    }

    @PluginMethod
    public void writeAppFile(PluginCall call) {
        String name = safeFileName(call.getString("name", ""));
        if (name == null) {
            call.reject("文件名无效");
            return;
        }
        try {
            writeTextFile(name, call.getString("value", ""));
            call.resolve();
        } catch (Exception error) {
            call.reject("无法保存本机同步数据", error);
        }
    }

    @PluginMethod
    public void deleteAppFile(PluginCall call) {
        String name = safeFileName(call.getString("name", ""));
        if (name == null) {
            call.reject("文件名无效");
            return;
        }
        new File(getContext().getFilesDir(), name).delete();
        call.resolve();
    }

    @PluginMethod
    public void getWorkspace(PluginCall call) {
        JSObject result = new JSObject();
        result.put("workspace", getContext().getSharedPreferences("kefu-app", Context.MODE_PRIVATE).getString("workspace", "local"));
        call.resolve(result);
    }

    @PluginMethod
    public void setWorkspace(PluginCall call) {
        String workspace = call.getString("workspace", "local");
        if (!workspace.equals("local") && !workspace.equals("cloud")) {
            call.reject("工作区无效");
            return;
        }
        getContext().getSharedPreferences("kefu-app", Context.MODE_PRIVATE).edit().putString("workspace", workspace).apply();
        JSObject result = new JSObject();
        result.put("workspace", workspace);
        call.resolve(result);
        notifyListeners("workspaceChanged", result);
    }

    @PluginMethod
    public void getPetStatus(PluginCall call) {
        JSObject result = new JSObject();
        result.put("permissionGranted", hasOverlayPermission());
        result.put("running", PetOverlayService.isRunning());
        call.resolve(result);
    }

    @PluginMethod
    public void requestOverlayPermission(PluginCall call) {
        if (hasOverlayPermission()) {
            JSObject result = new JSObject();
            result.put("permissionGranted", true);
            call.resolve(result);
            return;
        }
        Intent intent = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getContext().getPackageName()));
        startActivityForResult(call, intent, "overlayPermissionResult");
    }

    @ActivityCallback
    private void overlayPermissionResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject value = new JSObject();
        value.put("permissionGranted", hasOverlayPermission());
        call.resolve(value);
    }

    @PluginMethod
    public void startPet(PluginCall call) {
        if (!hasOverlayPermission()) {
            call.reject("请先允许客服宝显示在其他应用上层");
            return;
        }
        Intent intent = new Intent(getContext(), PetOverlayService.class).setAction(PetOverlayService.ACTION_START);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) getContext().startForegroundService(intent);
        else getContext().startService(intent);
        call.resolve();
    }

    @PluginMethod
    public void stopPet(PluginCall call) {
        getContext().stopService(new Intent(getContext(), PetOverlayService.class));
        call.resolve();
    }

    @PluginMethod
    public void closePetPanel(PluginCall call) {
        PetOverlayService.closePanel();
        call.resolve();
    }

    @PluginMethod
    public void copyContent(PluginCall call) {
        String text = call.getString("text", "");
        JSArray images = call.getArray("images", new JSArray());
        try {
            java.util.ArrayList<String> values = new java.util.ArrayList<>();
            for (int index = 0; index < images.length(); index++) {
                String image = images.getString(index);
                if (image != null && image.startsWith("data:image/")) values.add(image);
            }
            JSObject result = new JSObject();
            result.put("success", AndroidClipboard.copy(getContext(), text, values));
            call.resolve(result);
        } catch (Exception error) {
            call.reject("复制到系统剪贴板失败", error);
        }
    }

    @PluginMethod
    public void setSecret(PluginCall call) {
        String value = call.getString("value", "");
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, getSecretKey());
            byte[] encrypted = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            byte[] payload = new byte[cipher.getIV().length + encrypted.length];
            System.arraycopy(cipher.getIV(), 0, payload, 0, cipher.getIV().length);
            System.arraycopy(encrypted, 0, payload, cipher.getIV().length, encrypted.length);
            String encoded = Base64.encodeToString(payload, Base64.NO_WRAP);
            getContext().getSharedPreferences("kefu-secure", Context.MODE_PRIVATE).edit().putString("webdav-password", encoded).apply();
            call.resolve();
        } catch (Exception error) {
            call.reject("无法安全保存坚果云密码", error);
        }
    }

    @PluginMethod
    public void getSecret(PluginCall call) {
        String value = getContext().getSharedPreferences("kefu-secure", Context.MODE_PRIVATE).getString("webdav-password", null);
        JSObject result = new JSObject();
        if (value == null) {
            result.put("value", (String) null);
            call.resolve(result);
            return;
        }
        try {
            byte[] payload = Base64.decode(value, Base64.NO_WRAP);
            byte[] iv = java.util.Arrays.copyOfRange(payload, 0, 12);
            byte[] encrypted = java.util.Arrays.copyOfRange(payload, 12, payload.length);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, getSecretKey(), new GCMParameterSpec(128, iv));
            result.put("value", new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8));
            call.resolve(result);
        } catch (Exception error) {
            call.reject("无法解密已保存的坚果云密码，请重新输入", error);
        }
    }

    @PluginMethod
    public void removeSecret(PluginCall call) {
        getContext().getSharedPreferences("kefu-secure", Context.MODE_PRIVATE).edit().remove("webdav-password").apply();
        call.resolve();
    }

    private boolean hasOverlayPermission() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(getContext());
    }

    private SecretKey getSecretKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        if (keyStore.containsAlias(KEY_ALIAS)) return (SecretKey) keyStore.getKey(KEY_ALIAS, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .build());
        return generator.generateKey();
    }

    private String readTextFile(String name) {
        File file = new File(getContext().getFilesDir(), name);
        if (!file.exists()) return null;
        try (FileInputStream input = new FileInputStream(file)) {
            byte[] bytes = new byte[(int) file.length()];
            int count = input.read(bytes);
            return new String(bytes, 0, Math.max(count, 0), StandardCharsets.UTF_8);
        } catch (Exception error) {
            return null;
        }
    }

    private void writeTextFile(String name, String value) throws Exception {
        File target = new File(getContext().getFilesDir(), name);
        File temporary = new File(getContext().getFilesDir(), name + ".tmp");
        try (FileOutputStream output = new FileOutputStream(temporary)) {
            output.write(value.getBytes(StandardCharsets.UTF_8));
            output.getFD().sync();
        }
        if (target.exists() && !target.delete()) throw new IllegalStateException("无法替换本地文件");
        if (!temporary.renameTo(target)) throw new IllegalStateException("无法保存本地文件");
    }

    private String safeFileName(String value) {
        if (value == null || !value.matches("[a-zA-Z0-9._-]{1,100}")) return null;
        return value;
    }
}
