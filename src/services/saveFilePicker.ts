import { registerPlugin } from '@capacitor/core';

interface SaveFilePlugin {
    copyToDownloads(options: { uri: string; filename: string }): Promise<void>;
}

export const SaveFile = registerPlugin<SaveFilePlugin>('SaveFile');
