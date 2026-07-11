import type { useAppStore } from '../../store/useAppStore';

// Minimal accessor the turn/image layer needs. Keep it a getter, not a copy,
// so callers always see live state. Wired once at app boot via setStoreAccess.
export type StoreState = ReturnType<typeof useAppStore.getState>;
export interface StoreAccess {
    getState: () => StoreState;
    setState: (patch: Partial<StoreState> | ((s: StoreState) => Partial<StoreState>)) => void;
}

let access: StoreAccess | null = null;

export function setStoreAccess(a: StoreAccess): void {
    access = a;
}

export function storeAccess(): StoreAccess {
    if (!access) throw new Error('StorePort not wired — call setStoreAccess at app boot');
    return access;
}