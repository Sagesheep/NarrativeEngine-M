import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.nexus.aigm',
  appName: 'Narrative Engine',
  webDir: 'dist',
  android: {
    backgroundColor: '#0b0f12',
  },
  server: {
    androidScheme: 'https',
  },
  plugins: {
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#0b0f12',
    },
    Keyboard: {
      // Note: `resize` only takes effect on iOS. On Android we drive the
      // app height from window.visualViewport (see App.tsx), which reports
      // the actual keyboard-excluded viewport on every device/WebView.
      resize: 'native',
      resizeOnFullScreen: true,
    },
  },
};

export default config;