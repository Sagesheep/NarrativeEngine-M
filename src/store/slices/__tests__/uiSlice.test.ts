import { describe, it, expect } from 'vitest';
import { createUISlice, type UISlice } from '../uiSlice';

/** Instantiate the slice with a minimal set/get harness (no full store needed). */
function makeSlice() {
    let state = {} as UISlice;
    const set = (partial: Partial<UISlice> | ((s: UISlice) => Partial<UISlice>)) => {
        const next = typeof partial === 'function' ? partial(state) : partial;
        state = { ...state, ...next };
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    state = createUISlice(set as any, (() => state) as any, {} as any);
    return { get: () => state };
}

describe('uiSlice keyboardVisible', () => {
    it('defaults to false', () => {
        expect(makeSlice().get().keyboardVisible).toBe(false);
    });

    it('setKeyboardVisible(true) flips it on', () => {
        const { get } = makeSlice();
        get().setKeyboardVisible(true);
        expect(get().keyboardVisible).toBe(true);
    });

    it('setKeyboardVisible(false) resets it', () => {
        const { get } = makeSlice();
        get().setKeyboardVisible(true);
        get().setKeyboardVisible(false);
        expect(get().keyboardVisible).toBe(false);
    });
});
