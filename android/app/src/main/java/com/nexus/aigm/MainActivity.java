package com.nexus.aigm;

import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

public class MainActivity extends BridgeActivity {
    private static final String TAG = "MainActivity";

    /**
     * Latest safe-area injection script, kept so we can re-run it after every page
     * load (the inset listener can fire before the web content exists).
     */
    private String pendingSafeAreaJs;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(SaveFilePlugin.class);
        super.onCreate(savedInstanceState);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        installWebViewClient();
        installSafeAreaInsetInjection();
    }

    /**
     * We run edge-to-edge (setDecorFitsSystemWindows=false), so the WebView draws
     * under the status and navigation bars. Android's WebView only maps the display
     * CUTOUT into CSS env(safe-area-inset-*) — never the status/navigation bars — and
     * some OEM WebViews report 0 for it entirely, so top-anchored UI renders behind
     * the status bar (reported on Pixel 9a while a Samsung S25 was fine).
     *
     * Read the real WindowInsets natively and inject them as CSS custom properties
     * (--android-safe-*, in CSS px). index.css folds these together with env() via
     * max(), so whichever source is populated on a given device wins.
     */
    private void installSafeAreaInsetInjection() {
        final WebView webView = getBridge().getWebView();
        if (webView == null) {
            return;
        }
        final float density = getResources().getDisplayMetrics().density;
        ViewCompat.setOnApplyWindowInsetsListener(webView, (view, insets) -> {
            Insets top = insets.getInsets(
                    WindowInsetsCompat.Type.statusBars() | WindowInsetsCompat.Type.displayCutout());
            // Fold the IME (keyboard) into the bottom inset. When the keyboard opens,
            // ime.bottom > nav.bottom, so --android-safe-bottom grows and .nav-clearance
            // lifts the chat input above the keyboard. (Edge-to-edge means the window
            // never auto-resizes, so this manual inset is the only signal CSS gets.)
            Insets nav = insets.getInsets(WindowInsetsCompat.Type.navigationBars());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            float topPx = top.top / density;
            float bottomPx = Math.max(nav.bottom, ime.bottom) / density;
            float leftPx = top.left / density;
            float rightPx = top.right / density;
            pendingSafeAreaJs =
                    "(function(){var s=document.documentElement&&document.documentElement.style;" +
                    "if(!s)return;" +
                    "s.setProperty('--android-safe-top','" + topPx + "px');" +
                    "s.setProperty('--android-safe-bottom','" + bottomPx + "px');" +
                    "s.setProperty('--android-safe-left','" + leftPx + "px');" +
                    "s.setProperty('--android-safe-right','" + rightPx + "px');})();";
            injectSafeArea(webView);
            // Do not consume — let the WebView and its children still receive insets.
            return insets;
        });
        ViewCompat.requestApplyInsets(webView);
    }

    private void injectSafeArea(WebView webView) {
        if (pendingSafeAreaJs == null) {
            return;
        }
        final String js = pendingSafeAreaJs;
        webView.post(() -> webView.evaluateJavascript(js, null));
    }

    /**
     * Installs a WebViewClient that (a) recovers from WebView renderer death and
     * (b) re-applies the safe-area insets after each navigation.
     *
     * The on-device embedding model (especially the 768-dim "high" model) keeps the
     * WebView under heavy memory pressure. When Android reclaims or crashes the
     * WebView renderer process, the default BridgeActivity has no handler, so the
     * renderer death escalates into a full app crash (crashpad:
     * "Render process's crash wasn't handled by all associated webviews").
     *
     * Override onRenderProcessGone to recover instead: campaign state is persisted
     * in IndexedDB, so recreating the activity rebuilds a fresh WebView/renderer and
     * the app resumes where it left off rather than crashing to the launcher.
     */
    private void installWebViewClient() {
        final WebView webView = getBridge().getWebView();
        if (webView == null) {
            return;
        }
        webView.setWebViewClient(new BridgeWebViewClient(getBridge()) {
            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                boolean didCrash = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && detail.didCrash();
                Log.e(TAG, "WebView renderer gone (didCrash=" + didCrash
                        + ", reclaimed for memory=" + (!didCrash) + "); recovering by recreating activity.");
                // We must not touch `view` again after returning true. Rebuild the
                // activity (and with it a fresh WebView) so the app survives.
                if (!isFinishing()) {
                    recreate();
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                // Insets may have been delivered before the page existed; re-apply now.
                injectSafeArea(view);
            }
        });
    }
}
