import { useEffect, useRef } from 'react';
import { registerBackHandler } from '../services/backHandler';

/**
 * While `active` is true, the hardware back button invokes `close` (dismissing
 * this overlay) instead of leaving the app. Registers on the shared back-handler
 * stack while active and unregisters on cleanup.
 *
 * The latest `close` is held in a ref so a re-render that passes a new callback
 * identity doesn't re-register (which would move this overlay to the top of the
 * LIFO stack and break dismissal order). Must be called unconditionally — put it
 * above any early `return null`, driven by the `active` flag.
 */
export function useBackHandler(active: boolean, close: () => void): void {
    const closeRef = useRef(close);
    // Keep the ref current without re-running the registration effect below.
    useEffect(() => {
        closeRef.current = close;
    });

    useEffect(() => {
        if (!active) return;
        return registerBackHandler(() => closeRef.current());
    }, [active]);
}
