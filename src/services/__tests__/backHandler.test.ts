import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    registerBackHandler,
    popBackHandler,
    _resetBackHandlers,
} from '../backHandler';

describe('backHandler registry', () => {
    beforeEach(() => {
        _resetBackHandlers();
    });

    it('pop on empty stack returns false', () => {
        expect(popBackHandler()).toBe(false);
    });

    it('pops the most recently registered handler first (LIFO)', () => {
        const order: string[] = [];
        registerBackHandler(() => order.push('first'));
        registerBackHandler(() => order.push('second'));

        expect(popBackHandler()).toBe(true);
        expect(popBackHandler()).toBe(true);
        expect(popBackHandler()).toBe(false);
        expect(order).toEqual(['second', 'first']);
    });

    it('unregister removes an entry from the middle without disturbing order', () => {
        const a = vi.fn();
        const b = vi.fn();
        const c = vi.fn();
        registerBackHandler(a);
        const unregisterB = registerBackHandler(b);
        registerBackHandler(c);

        unregisterB();

        expect(popBackHandler()).toBe(true); // c (top)
        expect(popBackHandler()).toBe(true); // a
        expect(popBackHandler()).toBe(false);

        expect(c).toHaveBeenCalledTimes(1);
        expect(a).toHaveBeenCalledTimes(1);
        expect(b).not.toHaveBeenCalled();
    });

    it('unregister is idempotent and safe to call after the entry was popped', () => {
        const close = vi.fn();
        const unregister = registerBackHandler(close);

        expect(popBackHandler()).toBe(true);
        expect(close).toHaveBeenCalledTimes(1);

        // Calling unregister after the entry is already gone must not throw or
        // remove an unrelated entry.
        const other = vi.fn();
        registerBackHandler(other);
        unregister();

        expect(popBackHandler()).toBe(true);
        expect(other).toHaveBeenCalledTimes(1);
    });

    it('supports re-registering after a handler was closed', () => {
        const first = vi.fn();
        registerBackHandler(first);
        popBackHandler();

        const second = vi.fn();
        registerBackHandler(second);
        expect(popBackHandler()).toBe(true);
        expect(second).toHaveBeenCalledTimes(1);
    });
});
