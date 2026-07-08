// Hardware back-button handler registry.
//
// A LIFO stack of close-handlers so the Android hardware back button (and the
// edge back-gesture) dismisses the top-most open overlay instead of
// backgrounding the whole app. We use a plain registry rather than watching
// store flags because overlay "open" state is split between the Zustand
// uiSlice and local component state (modals that own their `open` boolean) —
// the registry lets every overlay opt in the same way, wherever its state lives.

type Entry = { id: number; close: () => void };

let stack: Entry[] = [];
let nextId = 1;

/**
 * Push a close-handler onto the stack. Returns an unregister fn that removes
 * this exact entry wherever it currently sits (not necessarily the top).
 * LIFO: the last handler registered is the first one popBackHandler() closes.
 */
export function registerBackHandler(close: () => void): () => void {
    const entry: Entry = { id: nextId++, close };
    stack.push(entry);
    return () => {
        stack = stack.filter((e) => e.id !== entry.id);
    };
}

/**
 * Pop the top-most handler and invoke its close fn.
 * Returns true if something was closed, false if the stack was empty.
 */
export function popBackHandler(): boolean {
    const entry = stack.pop();
    if (!entry) return false;
    entry.close();
    return true;
}

/** Test-only: reset the registry between test cases. */
export function _resetBackHandlers(): void {
    stack = [];
    nextId = 1;
}
