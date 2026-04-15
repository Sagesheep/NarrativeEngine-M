import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.nexus.aigm',
  appName: 'Narrative Engine',
  webDir: 'dist',
  android: {
    backgroundColor: '#FFFFFF',
  },
  server: {
    androidScheme: 'https',
  },
  plugins: {
    StatusBar: {
      style: 'LIGHT',
      backgroundColor: '#FFFFFF',
    },
    Keyboard: {
      resize: 'body',
      resizeOnFullScreen: true,
    },
  },
};

export default config;
