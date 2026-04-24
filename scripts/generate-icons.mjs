import sharp from 'sharp';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const ICON_SIZES = {
    'mipmap-mdpi': 48,
    'mipmap-hdpi': 72,
    'mipmap-xhdpi': 96,
    'mipmap-xxhdpi': 144,
    'mipmap-xxxhdpi': 192,
};

const FOREGROUND_SIZES = {
    'mipmap-mdpi': 108,
    'mipmap-hdpi': 162,
    'mipmap-xhdpi': 216,
    'mipmap-xxhdpi': 324,
    'mipmap-xxxhdpi': 432,
};

const RES = resolve(ROOT, 'android', 'app', 'src', 'main', 'res');

async function generate() {
    const iconPath = resolve(ROOT, 'AppIcon.png');
    if (!existsSync(iconPath)) {
        console.error('AppIcon.png not found in project root');
        process.exit(1);
    }

    const iconBuffer = readFileSync(iconPath);

    for (const [folder, size] of Object.entries(ICON_SIZES)) {
        const outPath = resolve(RES, folder, 'ic_launcher.png');
        await sharp(iconBuffer).resize(size, size, { fit: 'cover' }).png().toFile(outPath);
        console.log(`  ${folder}/ic_launcher.png  (${size}x${size})`);
    }

    for (const [folder, size] of Object.entries(ICON_SIZES)) {
        const outPath = resolve(RES, folder, 'ic_launcher_round.png');
        await sharp(iconBuffer).resize(size, size, { fit: 'cover' }).png().toFile(outPath);
        console.log(`  ${folder}/ic_launcher_round.png  (${size}x${size})`);
    }

    for (const [folder, size] of Object.entries(FOREGROUND_SIZES)) {
        const outPath = resolve(RES, folder, 'ic_launcher_foreground.png');
        await sharp(iconBuffer).resize(size, size, { fit: 'cover' }).png().toFile(outPath);
        console.log(`  ${folder}/ic_launcher_foreground.png  (${size}x${size})`);
    }

    console.log('\nDone. Icons generated from AppIcon.png');
}

generate().catch(err => {
    console.error(err);
    process.exit(1);
});
