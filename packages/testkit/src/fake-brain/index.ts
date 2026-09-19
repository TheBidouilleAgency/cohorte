// `@cohorte/testkit/fake-brain` — the area index the subpath map (`./*` -> `./src/*/index.ts`) needs for this area
// to resolve at all. Written at gate G1 (docs/v3/requests/U0.03.md R5, carried to docs/v3/requests/U0.G.md R2):
// `frames.ts` (U0.03) and `child.ts` (U1.07) existed, `index.ts` did not, so `@cohorte/testkit/fake-brain` resolved
// to nothing and a test outside `@cohorte/runtime-pi` could only reach the frames by file URL.
//
// It re-exports the two things a TEST holds — the protocol frame helpers and the script/handle of the child — and
// deliberately NOT `./child.ts`: that file is a PROGRAM. It runs on import (reads `fake-brain.script.json` from its
// cwd, opens fd 3/4 or the IPC channel and starts answering frames), and it is reached the only way it should be,
// as `FAKE_BRAIN_ENTRY` handed to a spawn.
export * from './frames.ts';
export * from './scripts/index.ts';
