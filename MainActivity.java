package hu.djstudio.app;

import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * DJ Studio 2.0 – a full-screen WebView host for the bundled web app.
 * Adds: local file picker, SoundCloud access from the bundled page, native USB-MIDI
 * (DDJ-1000) bridge, saving mix recordings, keep-screen-on and the back button.
 */
public class MainActivity extends Activity {
    private static final int FILE_REQ = 42;
    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private MidiBridge midi;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        web = new WebView(this);
        web.setBackgroundColor(0xFF0C0D10);
        setContentView(web);
        hideSystemUi();

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        // the bundled page (file://) must be able to call the SoundCloud API and stream servers
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setTextZoom(100);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("audio/*");
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    startActivityForResult(Intent.createChooser(i, "Zene kiválasztása"), FILE_REQ);
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }

            @Override
            public void onPermissionRequest(PermissionRequest request) {
                request.deny();
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                if (midi != null) midi.announce();
            }
        });
        web.addJavascriptInterface(new Bridge(), "AndroidBridge");
        web.loadUrl("file:///android_asset/www/index.html");

        midi = new MidiBridge(this, web);
        midi.start();
    }

    /** Methods callable from JavaScript as window.AndroidBridge.* */
    private class Bridge {
        private OutputStream out;
        private String where = "";

        @JavascriptInterface
        public String version() { return "2.0"; }

        @JavascriptInterface
        public void beginFile(String name) {
            closeQuietly();
            try {
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.Downloads.DISPLAY_NAME, name);
                    v.put(MediaStore.Downloads.MIME_TYPE, "audio/webm");
                    v.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/DJ Studio");
                    Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                    out = uri == null ? null : getContentResolver().openOutputStream(uri);
                    where = "Letöltések/DJ Studio/" + name;
                } else {
                    File dir = getExternalFilesDir(Environment.DIRECTORY_MUSIC);
                    if (dir != null && !dir.exists()) dir.mkdirs();
                    File f = new File(dir, name);
                    out = new FileOutputStream(f);
                    where = f.getAbsolutePath();
                }
            } catch (Exception e) {
                out = null;
                where = "hiba: " + e.getMessage();
            }
        }

        @JavascriptInterface
        public void appendChunk(String base64) {
            if (out == null) return;
            try {
                out.write(Base64.decode(base64, Base64.DEFAULT));
            } catch (Exception e) {
                closeQuietly();
                where = "hiba: " + e.getMessage();
            }
        }

        @JavascriptInterface
        public String endFile() {
            closeQuietly();
            return where;
        }

        private void closeQuietly() {
            if (out != null) {
                try { out.flush(); out.close(); } catch (Exception ignored) { }
                out = null;
            }
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_REQ && fileCallback != null) {
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int n = data.getClipData().getItemCount();
                    result = new Uri[n];
                    for (int i = 0; i < n; i++) result[i] = data.getClipData().getItemAt(i).getUri();
                } else if (data.getData() != null) {
                    result = new Uri[]{data.getData()};
                }
            }
            fileCallback.onReceiveValue(result);
            fileCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onBackPressed() {
        // let the web app close panels first; leave only when it says so
        web.evaluateJavascript("(window.onAndroidBack ? String(window.onAndroidBack()) : 'false')", value -> {
            if (!"\"true\"".equals(value)) finish();
        });
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemUi();
    }

    @SuppressWarnings("deprecation")
    private void hideSystemUi() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN);
    }

    @Override
    protected void onDestroy() {
        if (midi != null) midi.stop();
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
