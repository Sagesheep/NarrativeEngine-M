/**
 * TTS playback wrapper.
 *
 * Two backends:
 *   1. Web Speech API (`window.speechSynthesis`) — used in browsers and any
 *      WebView that exposes it. Chunked playback, pause/resume supported.
 *   2. `@capacitor-community/text-to-speech` native plugin — used on Android
 *      WebView where `speechSynthesis` is missing (Samsung WebView, etc.).
 *      Android's native TextToSpeech handles long text natively, so we send
 *      the full prose in one call. Pause/resume is simulated via stop + offset.
 *
 * Voice quality depends on the OS engine — Web Speech on iOS/macOS, Android
 * TextToSpeech engine on Android. For better Android voices, install
 * "Speech Services & Voices" from Play Store and download a natural English
 * voice.
 */

import { Capacitor } from '@capacitor/core';
import { TextToSpeech as NativeTTS, QueueStrategy } from '@capacitor-community/text-to-speech';

export type SpeakHandle = {
    /** Request abort. Stops current + queued utterances. Safe to call multiple times. */
    stop: () => void;
    /** Pause current utterance. No-op if not speaking. */
    pause: () => void;
    /** Resume current utterance. No-op if not paused. */
    resume: () => void;
    /** True once stop() has been called. */
    aborted: () => boolean;
};

export type SpeakCallbacks = {
    onChunkStart?: (idx: number) => void;
    onChunkEnd?: (idx: number) => void;
    onFinish?: () => void;
    onError?: (err: string) => void;
};

let cachedVoice: SpeechSynthesisVoice | null | undefined;
let voicesReady = false;

// ─── Native backend availability ──────────────────────────────────────────
// Cached lazily — the Capacitor plugin call is async, so we expose a boolean
// via `nativeTTSReady` once `initVoices()` has had a chance to probe. Before
// the probe completes, we assume native is available on native platforms so
// the speaker button shows immediately on first render.
const isNativePlatform = Capacitor.isNativePlatform();
let nativeTTSAvailable: boolean | null = isNativePlatform ? null : false;

async function probeNativeTTS(): Promise<boolean> {
    if (!isNativePlatform) return false;
    if (nativeTTSAvailable !== null) return nativeTTSAvailable;
    try {
        const { supported } = await NativeTTS.isLanguageSupported({ lang: 'en-US' });
        nativeTTSAvailable = supported;
    } catch {
        nativeTTSAvailable = false;
    }
    return nativeTTSAvailable;
}

/** True if either Web Speech or native Capacitor TTS is available. */
export function speechSupported(): boolean {
    const webOk = typeof window !== 'undefined' && 'speechSynthesis' in window;
    if (webOk) return true;
    // Web Speech missing — fall back to native if we're on a native platform
    // and the probe has either confirmed availability or hasn't finished yet
    // (optimistic until proven otherwise, so the speaker button can render).
    if (!isNativePlatform) return false;
    return nativeTTSAvailable !== false;
}

/**
 * Load voices. On Android WebView, getVoices() is empty until the
 * `voiceschanged` event fires. Call this once at app boot; the returned
 * promise resolves once voices are available (or after a 3s timeout fallback).
 * Also probes native TTS availability on native platforms.
 */
export function initVoices(): Promise<void> {
    // Kick off the native probe in the background — we don't need to block
    // app boot on it; speechSupported() is optimistic until it settles.
    if (isNativePlatform && nativeTTSAvailable === null) {
        probeNativeTTS().catch(() => {});
    }

    if (!speechSupported() || !('speechSynthesis' in window)) return Promise.resolve();
    if (voicesReady && cachedVoice !== undefined) return Promise.resolve();

    return new Promise<void>((resolve) => {
        if (!window.speechSynthesis) {
            resolve();
            return;
        }
        const attempt = () => {
            const voices = window.speechSynthesis.getVoices();
            if (voices.length > 0) {
                voicesReady = true;
                cachedVoice = pickBestVoice(voices);
                resolve();
                return true;
            }
            return false;
        };
        if (attempt()) return;

        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            cleanup();
            voicesReady = true;
            cachedVoice = pickBestVoice(window.speechSynthesis.getVoices());
            resolve();
        };

        const cleanup = () => {
            window.speechSynthesis.removeEventListener('voiceschanged', finish);
            clearTimeout(timer);
        };
        window.speechSynthesis.addEventListener('voiceschanged', finish, { once: true });
        // Fallback timeout — some WebViews never fire voiceschanged.
        const timer = setTimeout(finish, 3000);
    });
}

/**
 * Score and pick the best available voice. Heuristic:
 *   - English voices only (prefer en-US, then en-GB, then any en-*)
 *   - Cloud/network voices sound better than local ones (but need network —
 *     for walking offline, prefer local)
 *   - Names containing "female"/"samantha"/"zira"/"google us english" score higher
 *   - Names containing "natural"/"network"/"premium"/"enhanced" score higher
 *   - Default voice gets a small bonus (it's usually tuned by the OEM)
 */
function pickBestVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
    if (!voices.length) return null;

    const scored = voices
        .filter(v => v.lang && v.lang.toLowerCase().startsWith('en'))
        .map(v => {
            const name = (v.name || '').toLowerCase();
            const lang = (v.lang || '').toLowerCase();
            let score = 0;

            // Language preference
            if (lang === 'en-us') score += 5;
            else if (lang === 'en-gb') score += 4;
            else score += 2;

            // Quality hints from name
            if (/(natural|network|premium|enhanced|wavenet|neural)/.test(name)) score += 5;
            if (/(google|samsung)/.test(name)) score += 2;
            if (v.default) score += 1;

            // Female voice hints — mainApp uses af_heart, we want the equivalent
            if (/(female|samantha|zira|aria|jenny|google us english)/.test(name)) score += 3;
            if (/\bf\b|\(female\)|^f-/.test(name)) score += 2;

            // Local service bonus for offline walking use
            if (v.localService) score += 1;

            return { v, score };
        })
        .sort((a, b) => b.score - a.score);

    return scored.length > 0 ? scored[0].v : voices[0];
}

/** Get the currently-selected voice. Loads voices first if needed. */
export function getSelectedVoice(): SpeechSynthesisVoice | null {
    if (!('speechSynthesis' in window)) return null;
    if (cachedVoice !== undefined) return cachedVoice;
    const voices = window.speechSynthesis.getVoices();
    cachedVoice = voices.length ? pickBestVoice(voices) : null;
    return cachedVoice;
}

function useNativeTTS(): boolean {
    return isNativePlatform && !('speechSynthesis' in window) && nativeTTSAvailable !== false;
}

/**
 * Speak an array of text chunks in order. Returns a handle for stop/pause/resume.
 *
 * Chunks are queued as separate SpeechSynthesisUtterance objects so the OS
 * engine doesn't choke on long text (Android WebView stops after ~200 chars
 * if fed one big utterance — see chunkSentencesForTTS in proseStripper.ts).
 *
 * On native Android (no Web Speech), we join chunks into one text and let
 * Android's native TextToSpeech handle it — it has no 200-char limit.
 */
export function speakChunks(
    chunks: string[],
    opts: { rate?: number; pitch?: number; startAt?: number } = {},
    callbacks: SpeakCallbacks = {},
): SpeakHandle {
    const rate = Math.min(2, Math.max(0.5, opts.rate ?? 1));
    const pitch = opts.pitch ?? 1;
    const startAt = opts.startAt ?? 0;

    if (useNativeTTS()) {
        return speakNative(chunks, { rate, pitch, startAt }, callbacks);
    }

    return speakWeb(chunks, { rate, pitch, startAt }, callbacks);
}

// ─── Native Capacitor TTS backend ─────────────────────────────────────────
//
// The native plugin's `speak()` Promise resolves on utterance completion and
// NEVER resolves if `stop()` is called (the plugin clears its callback table
// without rejecting/resolving the pending call). So we race the speak()
// promise against an abort signal that we control.
//
// Android's TextToSpeech engine fails on very long single utterances (the
// Samsung engine rejects anything past ~4000 chars with "Failed to read text"
// via UtteranceProgressListener.onError). So we still chunk on native, but
// chain the chunks via repeated speak() calls with QueueStrategy.Add.
function speakNative(
    chunks: string[],
    opts: { rate: number; pitch: number; startAt: number },
    callbacks: SpeakCallbacks,
): SpeakHandle {
    const voice = getSelectedVoice();
    let aborted = false;
    let currentIdx = -1;
    let paused = false;
    let pauseChunkIdx = -1; // chunk index to resume from after pause
    let rangeListener: { remove: () => void } | null = null;
    let queuePos = opts.startAt; // next chunk to speak

    const stop = () => {
        if (aborted) return;
        aborted = true;
        if (rangeListener) { try { rangeListener.remove(); } catch { /* ignore */ } rangeListener = null; }
        try { NativeTTS.stop(); } catch { /* ignore */ }
    };
    const pause = () => {
        if (aborted || paused) return;
        paused = true;
        // Remember position and stop. resume() will re-speak from this chunk.
        if (currentIdx >= 0) pauseChunkIdx = currentIdx;
        try { NativeTTS.stop(); } catch { /* ignore */ }
    };
    const resume = () => {
        if (aborted || !paused) return;
        paused = false;
        const restartFrom = pauseChunkIdx >= 0 ? pauseChunkIdx : queuePos;
        pauseChunkIdx = -1;
        queuePos = restartFrom;
        // Re-enter playback from the remembered chunk.
        speakNext();
    };

    if (!chunks.length) {
        callbacks.onFinish?.();
        return { stop, pause, resume, aborted: () => aborted };
    }

    // Subscribe to onRangeStart for chunk highlight tracking. Native fires
    // this per-utterance, so we use the chunk text length to map offsets.
    if (!rangeListener) {
        NativeTTS.addListener('onRangeStart', () => {
            // We don't need fine-grained char tracking — the chunk-start
            // callback already fires synchronously before each speak() call.
        }).then(l => { rangeListener = l; }).catch(() => {});
    }

    const speakNext = () => {
        if (aborted || paused) return;
        if (queuePos >= chunks.length) {
            callbacks.onFinish?.();
            if (rangeListener) { try { rangeListener.remove(); } catch { /* ignore */ } rangeListener = null; }
            return;
        }
        const chunk = chunks[queuePos];
        if (!chunk || !chunk.trim()) {
            queuePos++;
            speakNext();
            return;
        }
        currentIdx = queuePos;
        callbacks.onChunkStart?.(currentIdx);

        NativeTTS.speak({
            text: chunk,
            lang: voice?.lang || 'en-US',
            rate: opts.rate,
            pitch: opts.pitch,
            volume: 1,
            // Add to queue so chunks play back-to-back without clipping.
            // (We still chain via promise to track completion per chunk.)
            queueStrategy: QueueStrategy.Flush,
        })
            .then(() => {
                if (aborted) return;
                if (paused) return; // pause() triggered the stop; don't advance
                callbacks.onChunkEnd?.(currentIdx);
                queuePos++;
                speakNext();
            })
            .catch((err) => {
                if (aborted) return;
                if (paused) return;
                callbacks.onError?.(String(err) || 'native speak failed');
                // Advance past this chunk rather than stalling the whole queue.
                queuePos++;
                speakNext();
            });
    };

    speakNext();

    return { stop, pause, resume, aborted: () => aborted };
}

// ─── Web Speech API backend ────────────────────────────────────────────────
function speakWeb(
    chunks: string[],
    opts: { rate: number; pitch: number; startAt: number },
    callbacks: SpeakCallbacks,
): SpeakHandle {
    const synth = window.speechSynthesis;
    const voice = getSelectedVoice();

    let aborted = false;
    let currentIdx = -1;
    let paused = false;

    const stop = () => {
        if (aborted) return;
        aborted = true;
        try { synth.cancel(); } catch { /* ignore */ }
    };
    const pause = () => {
        if (aborted || paused) return;
        paused = true;
        try { synth.pause(); } catch { /* ignore */ }
    };
    const resume = () => {
        if (aborted || !paused) return;
        paused = false;
        try { synth.resume(); } catch { /* ignore */ }
    };

    if (!chunks.length || !synth) {
        callbacks.onFinish?.();
        return { stop, pause, resume, aborted: () => aborted };
    }

    // Cancel anything already in the OS queue (defensive — other components,
    // other bubbles, leftover utterances from a prior session).
    try { synth.cancel(); } catch { /* ignore */ }

    // Android WebView bug workaround: pause+resume shortly after speak forces
    // the engine to actually start. Without this, the first utterance can sit
    // silent for several seconds. We only do this on the first chunk.
    let firstStarted = false;
    const kickstart = () => {
        if (firstStarted) return;
        firstStarted = true;
        try {
            synth.pause();
            setTimeout(() => { if (!aborted) synth.resume(); }, 50);
        } catch { /* ignore */ }
    };

    const queue = chunks.slice(opts.startAt);
    let queuePos = 0;

    const speakNext = () => {
        if (aborted) return;
        if (queuePos >= queue.length) {
            callbacks.onFinish?.();
            return;
        }
        const chunk = queue[queuePos];
        currentIdx = opts.startAt + queuePos;

        const utt = new SpeechSynthesisUtterance(chunk);
        if (voice) {
            utt.voice = voice;
            utt.lang = voice.lang;
        }
        utt.rate = opts.rate;
        utt.pitch = opts.pitch;
        utt.volume = 1;

        utt.onstart = () => {
            if (aborted) return;
            if (queuePos === 0) kickstart();
            callbacks.onChunkStart?.(currentIdx);
        };
        utt.onend = () => {
            if (aborted) return;
            callbacks.onChunkEnd?.(currentIdx);
            queuePos++;
            speakNext();
        };
        utt.onerror = (e) => {
            if (aborted) return;
            // "interrupted" / "canceled" happen on stop() — don't surface those.
            const err = (e as SpeechSynthesisErrorEvent).error;
            if (err === 'interrupted' || err === 'canceled') return;

            callbacks.onError?.(err || 'unknown');
            // Advance past this chunk rather than stalling the whole queue.
            queuePos++;
            speakNext();
        };

        try {
            synth.speak(utt);
        } catch {
            // If speak throws (rare — usually means synth is unavailable),
            // abort gracefully.
            aborted = true;
            callbacks.onError?.('speak threw');
        }
    };

    speakNext();

    return { stop, pause, resume, aborted: () => aborted };
}

/** Force-stop any ongoing speech. Called on app background / unmount. */
export function stopAllSpeech(): void {
    if ('speechSynthesis' in window) {
        try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
    }
    if (useNativeTTS()) {
        try { NativeTTS.stop(); } catch { /* ignore */ }
    }
}