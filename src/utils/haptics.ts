import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';

// Fire-and-forget haptic helpers. No-op on web (and swallow any native error so
// a missing vibrator never surfaces to the user). Keep the call sites sparse —
// over-buzzing an app reads as cheap.

export function hapticLight(): void {
    if (!Capacitor.isNativePlatform()) return;
    void Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
}

export function hapticMedium(): void {
    if (!Capacitor.isNativePlatform()) return;
    void Haptics.impact({ style: ImpactStyle.Medium }).catch(() => {});
}

export function hapticSuccess(): void {
    if (!Capacitor.isNativePlatform()) return;
    void Haptics.notification({ type: NotificationType.Success }).catch(() => {});
}

export function hapticWarning(): void {
    if (!Capacitor.isNativePlatform()) return;
    void Haptics.notification({ type: NotificationType.Warning }).catch(() => {});
}
