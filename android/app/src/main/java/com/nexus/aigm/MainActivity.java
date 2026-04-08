package com.nexus.aigm;

import android.os.Bundle;
import androidx.core.view.WindowCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Allow WebView to render behind system bars
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
    }
}
