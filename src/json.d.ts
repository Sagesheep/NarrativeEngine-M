// Ambient module declarations for JSON imports used by the NPC name subsystem.
// These files (src/data/nameBank.json, src/data/nameBlocklist.json) are generated
// at build time by `scripts/buildNameBank.mjs` from the reviewed asset pipeline and
// are intentionally NOT committed. Declaring the module shape lets `tsc` typecheck
// the importers without `resolveJsonModule` and without the runtime file present.

declare module "*.json" {
  const value: unknown;
  export default value;
}
