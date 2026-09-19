// The canonical PathResolver, symlink/hardlink policy, glob semantics and use-time re-verification (PLAN U1.02,
// DESIGN 2.6.3, spec 23) — one implementation shared by the gate, `WorkspaceReader`, `WorktreeService` and
// `tools`, so none of them configures picomatch or a symlink policy on its own.
export { createGlobMatcher } from './glob.ts';
export { createPathResolver } from './resolve.ts';
export { openVerified, writeAtomicVerified } from './use-time.ts';
