// JSON extraction lives in @narrative/engine (shared with the desktop app).
// The engine version is a merge: this app's unclosed-<think> handling PLUS
// desktop's array-root support, candidate-based truncation recovery, and
// parse-first repairJson (trailing commas, comments, single quotes).
// Re-exported here so existing imports keep working.
export { extractJson, extractJsonRobust } from '@narrative/engine';
