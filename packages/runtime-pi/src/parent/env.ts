// DESIGN 3.7 layer 1 — the child's environment is an ALLOWLIST; nothing else is inherited (D3). The engine has no
// injectable auth context, so a process without credential-shaped variables is the only structural defence against
// "nothing stored + an env key => a paid API call".
import { CohorteError, errorOf } from '@cohorte/base';
import type { SandboxPolicy } from '@cohorte/runtime-contract';

/**
 * A name is credential-shaped when the LAST word of it is one of the secret words (so `OPENAI_API_KEY`, `XAI_KEY`,
 * `APIKEY` and a bare `TOKEN` are all refused, while `MONKEY` and `TOKENIZER` are not), or when it opens with a known
 * provider prefix. It is a NAME guard, not a value guard: the value is never looked at (I7).
 */
const CREDENTIAL_SHAPED =
  /(^|_)(API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|CREDENTIALS|BEARER)$|^(AWS|GOOGLE|GCP|GH|GITHUB|GITLAB|ANTHROPIC|OPENAI|AZURE|XAI|GROQ|MISTRAL|OPENROUTER|COHERE|DEEPSEEK|HUGGINGFACE|REPLICATE|VERTEX)_/i;

/**
 * A name that makes the runtime load foreign code before the entry runs (`DYLD_INSERT_LIBRARIES`, `LD_PRELOAD`,
 * `NODE_OPTIONS`, `NODE_REPL_EXTERNAL_MODULE`…). It is refused in `allow` AND in `set`: the parent fixes `NODE_OPTIONS`
 * itself, and a policy that could name one of these would defeat every other layer of 3.7.
 */
const LOADER_SHAPED = /^(LD_|DYLD_|NODE_)/i;

/** DESIGN 3.7 layer 1: the ONLY names the child inherits from the parent's environment. A policy narrows this list. */
export const L1_ENV_ALLOW: readonly string[] = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR'];

/**
 * Inherited only when the project's `network.proxyEnv` is on. That switch lives in `@cohorte/config`, two layers away,
 * and `SandboxPolicy` carries no flag for it: the composition root's decision reaches this side as the presence of
 * these names in `sandbox.env.allow` (docs/v3/requests/U1.07.md R4).
 */
export const L1_PROXY_ENV: readonly string[] = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
];

const INHERITABLE = new Set([...L1_ENV_ALLOW, ...L1_PROXY_ENV]);
export const DEFAULT_MAX_OLD_SPACE_MB = 512;

/** What the parent ALWAYS sets, whatever the policy says: a project cannot turn the engine's network features back on. */
export function fixedChildEnv(agentDir: string, maxOldSpaceMb: number | undefined): Record<string, string> {
  return {
    NODE_OPTIONS: `--max-old-space-size=${maxOldSpaceMb ?? DEFAULT_MAX_OLD_SPACE_MB}`,
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
    PI_CODING_AGENT_DIR: agentDir,
  };
}

/**
 * The exact env of the child, and the policy whose names the attestation is held against (`allow` ∪ keys of `set`,
 * PLAN F-8: plus whatever the OS injects, which `diffAttestation` knows).
 */
export function childEnv(
  policy: SandboxPolicy['env'],
  fixed: Record<string, string>,
  ambient: NodeJS.ProcessEnv = process.env,
): { env: Record<string, string>; attested: SandboxPolicy['env'] } {
  const set = { ...policy.set, ...fixed };
  const named = [...policy.allow, ...Object.keys(policy.set)];
  const refuse = (why: string, names: string[]): void => {
    if (names.length > 0)
      throw new CohorteError(errorOf('security/auth-mode-violation', `${why}: ${names.join(', ')}`));
  };
  refuse(
    'credential-shaped variables may not reach the agent process',
    named.filter((name) => CREDENTIAL_SHAPED.test(name)),
  );
  refuse(
    'loader variables may not reach the agent process',
    named.filter((name) => LOADER_SHAPED.test(name)),
  );
  // The allowlist of layer 1 is the parent's, not the policy's: a policy narrows it and can never widen it.
  refuse(
    'the agent process inherits only the layer-1 allowlist (DESIGN 3.7), plus the proxy variables of network.proxyEnv',
    policy.allow.filter((name) => !INHERITABLE.has(name)),
  );
  const env: Record<string, string> = {};
  for (const name of policy.allow) {
    const value = ambient[name];
    if (value !== undefined) env[name] = value;
  }
  return { env: { ...env, ...set }, attested: { allow: policy.allow, set } };
}
