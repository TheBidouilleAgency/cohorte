// Kept out of `index.ts`: the Wave-0 barrel re-exports that file with `export *` and froze its value names.
import { join } from 'node:path';

export const PI_ENGINE_VERSION = '0.85.1';
/** Header NAMES the child may relay in `provider.response` (DESIGN 3.3). */
export const RESPONSE_HEADER_ALLOWLIST: readonly string[] = Object.freeze([
  'retry-after',
  'x-ratelimit-*',
  'x-codex-*',
]);
export const AGENT_HOST_ENTRY = join('dist', 'agent-host.mjs');
