// IDF + RRF fusion math lives in @narrative/engine (shared with the desktop
// app). Re-exported here so existing imports keep working. Note: the engine
// version uses prebuilt rank Maps (O(n)) instead of indexOf scans (O(n²));
// output order is identical (first-occurrence semantics are parity-tested in
// the engine suite).
export { computeIdf, fuseRRF } from '@narrative/engine';
