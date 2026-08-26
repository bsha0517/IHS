// Stub for the "server-only" package's Next.js-build-time behavior. Next.js
// replaces this import with a no-op inside a real server bundle; vitest runs
// in plain Node with no such rewrite, so every domain service file's leading
// `import "server-only"` would otherwise throw ("This module cannot be
// imported from a Client Component module") the moment a test imports it.
// Aliased in vitest.config.ts — the permanent, config-level equivalent of the
// temporary node_modules/server-only shim every phase's standalone tsx test
// script has used since Phase 9 (see PROJECT_STATUS.md's Testing methodology
// notes) — this one lives in source control instead of being recreated and
// deleted by hand each time.
export {}
