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
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashMap;
import java.util.Map;

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
    /** The bundled web app is served from this virtual https origin (no file:// restrictions). */
    private static final String ASSET_HOST = "appassets.androidplatform.net";
    private static final String UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

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

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                String host = u.getHost();
                if (host == null) return null;
                if (host.equals(ASSET_HOST)) return asset(u.getPath());
                if (isSoundCloud(host)) return proxy(request);
                return null;
            }
        });
        web.addJavascriptInterface(new Bridge(), "AndroidBridge");
        web.loadUrl("https://" + ASSET_HOST + "/www/index.html");

        midi = new MidiBridge(this, web);
        midi.start();
    }

    private static boolean isSoundCloud(String host) {
        return host.endsWith("soundcloud.com") || host.endsWith("sndcdn.com") || host.endsWith("soundcloud.cloud");
    }

    private static Map<String, String> corsHeaders() {
        Map<String, String> h = new HashMap<>();
        h.put("Access-Control-Allow-Origin", "*");
        h.put("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
        h.put("Access-Control-Allow-Headers", "*");
        h.put("Access-Control-Expose-Headers", "X-Final-URL, Content-Length");
        return h;
    }

    private static String mimeOf(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js")) return "application/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".svg")) return "image/svg+xml";
        return "application/octet-stream";
    }

    /** Serve files from assets/ under https://appassets.androidplatform.net/... */
    private WebResourceResponse asset(String path) {
        try {
            if (path == null || path.equals("/")) path = "/www/index.html";
            InputStream in = getAssets().open(path.substring(1));
            String mime = mimeOf(path);
            WebResourceResponse r = new WebResourceResponse(mime, mime.startsWith("text") || mime.contains("javascript") ? "UTF-8" : null, in);
            Map<String, String> h = corsHeaders();
            h.put("Cache-Control", "no-cache");
            r.setResponseHeaders(h);
            return r;
        } catch (Exception e) {
            return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", corsHeaders(), new ByteArrayInputStream(new byte[0]));
        }
    }

    /** Fetch SoundCloud requests natively and add CORS headers, so the web app can use the API and streams. */
    private WebResourceResponse proxy(WebResourceRequest request) {
        String method = request.getMethod();
        if ("OPTIONS".equalsIgnoreCase(method)) {
            return new WebResourceResponse("text/plain", "UTF-8", 200, "OK", corsHeaders(), new ByteArrayInputStream(new byte[0]));
        }
        if (!"GET".equalsIgnoreCase(method) && !"HEAD".equalsIgnoreCase(method)) return null;
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(request.getUrl().toString()).openConnection();
            c.setInstanceFollowRedirects(true);
            c.setConnectTimeout(15000);
            c.setReadTimeout(30000);
            c.setRequestProperty("User-Agent", UA);
            c.setRequestProperty("Accept-Language", "hu-HU,hu;q=0.9,en;q=0.8");
            Map<String, String> rh = request.getRequestHeaders();
            if (rh != null) {
                for (Map.Entry<String, String> e : rh.entrySet()) {
                    String k = e.getKey();
                    if (k.equalsIgnoreCase("Range") || k.equalsIgnoreCase("Accept")) c.setRequestProperty(k, e.getValue());
                }
            }
            int code = c.getResponseCode();
            InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            if (in == null) in = new ByteArrayInputStream(new byte[0]);
            String ct = c.getContentType();
            String mime = "application/octet-stream", charset = null;
            if (ct != null) {
                String[] parts = ct.split(";");
                mime = parts[0].trim();
                for (String part : parts) {
                    String t = part.trim();
                    if (t.toLowerCase().startsWith("charset=")) charset = t.substring(8).replace("\"", "");
                }
            }
            if (charset == null && (mime.startsWith("text") || mime.contains("json") || mime.contains("javascript") || mime.contains("mpegurl"))) charset = "UTF-8";
            Map<String, String> h = corsHeaders();
            h.put("X-Final-URL", c.getURL().toString());
            String msg = c.getResponseMessage();
            if (msg == null || msg.trim().isEmpty()) msg = code < 400 ? "OK" : "Error";
            if (code >= 300 && code < 400) code = 200; // WebResourceResponse does not accept 3xx
            return new WebResourceResponse(mime, charset, code, msg, h, in);
        } catch (Exception e) {
            String m = e.getClass().getSimpleName() + ": " + e.getMessage();
            return new WebResourceResponse("text/plain", "UTF-8", 502, "Bad Gateway", corsHeaders(), new ByteArrayInputStream(m.getBytes()));
        }
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
