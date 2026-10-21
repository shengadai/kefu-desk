package com.kefudesk.app;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.net.Uri;
import android.util.Base64;
import androidx.core.content.FileProvider;
import java.io.File;
import java.io.FileOutputStream;
import java.util.ArrayList;
import java.util.List;

public final class AndroidClipboard {
    private AndroidClipboard() {}

    public static boolean copy(Context context, String text, List<String> images) throws Exception {
        File directory = new File(context.getCacheDir(), "clipboard-images");
        if (directory.exists()) {
            File[] oldFiles = directory.listFiles();
            if (oldFiles != null) {
                for (File oldFile : oldFiles) oldFile.delete();
            }
        }
        if (!directory.exists() && !directory.mkdirs()) throw new IllegalStateException("无法创建剪贴板图片缓存");
        List<Uri> uris = new ArrayList<>();
        int imageIndex = 0;
        for (String dataUrl : images) {
            int comma = dataUrl.indexOf(',');
            if (comma < 0) continue;
            String metadata = dataUrl.substring(0, comma);
            String extension = metadata.contains("image/png") ? ".png" : metadata.contains("image/webp") ? ".webp" : ".jpg";
            byte[] bytes = Base64.decode(dataUrl.substring(comma + 1), Base64.DEFAULT);
            File imageFile = new File(directory, "image-" + (++imageIndex) + extension);
            try (FileOutputStream output = new FileOutputStream(imageFile)) {
                output.write(bytes);
            }
            uris.add(FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", imageFile));
        }
        ClipboardManager clipboard = (ClipboardManager) context.getSystemService(Context.CLIPBOARD_SERVICE);
        if (clipboard == null) return false;
        String label = "客服宝话术";
        ClipData clip = null;
        if (!text.isEmpty()) clip = ClipData.newPlainText(label, text);
        for (Uri uri : uris) {
            if (clip == null) clip = ClipData.newUri(context.getContentResolver(), label, uri);
            else clip.addItem(new ClipData.Item(uri));
        }
        if (clip == null) return false;
        clipboard.setPrimaryClip(clip);
        return true;
    }
}
