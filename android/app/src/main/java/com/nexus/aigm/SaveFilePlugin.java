package com.nexus.aigm;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

@CapacitorPlugin(name = "SaveFile")
public class SaveFilePlugin extends Plugin {

    @PluginMethod
    public void copyToDownloads(PluginCall call) {
        String uriString = call.getString("uri");
        String filename = call.getString("filename");

        if (uriString == null || filename == null) {
            call.reject("uri and filename are required");
            return;
        }

        try {
            Uri sourceUri = Uri.parse(uriString);
            ContentResolver resolver = getContext().getContentResolver();

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, filename);
                values.put(MediaStore.Downloads.MIME_TYPE, "application/octet-stream");
                values.put(MediaStore.Downloads.IS_PENDING, 1);

                Uri destUri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (destUri == null) { call.reject("Could not create file in Downloads"); return; }

                try (InputStream is = resolver.openInputStream(sourceUri);
                     OutputStream os = resolver.openOutputStream(destUri)) {
                    if (is == null || os == null) { call.reject("Could not open streams"); return; }
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = is.read(buf)) > 0) os.write(buf, 0, n);
                }

                values.clear();
                values.put(MediaStore.Downloads.IS_PENDING, 0);
                resolver.update(destUri, values, null, null);
            } else {
                File downloads = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                try (InputStream is = resolver.openInputStream(sourceUri);
                     FileOutputStream fos = new FileOutputStream(new File(downloads, filename))) {
                    if (is == null) { call.reject("Could not read source file"); return; }
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = is.read(buf)) > 0) fos.write(buf, 0, n);
                }
            }

            call.resolve();
        } catch (IOException e) {
            call.reject("Save failed: " + e.getMessage());
        }
    }
}
