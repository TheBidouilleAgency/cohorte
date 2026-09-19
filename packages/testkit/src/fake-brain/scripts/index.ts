// `@cohorte/testkit/fake-brain/scripts` — what a test needs to drive the engine-free fake brain (DESIGN 7.2): the path
// of its entry, the shape of its script, and the two files it exchanges with the test through the agent state dir
// (the child's cwd). A script is DATA: the child is started with an allowlisted env and a fixed argv, so the state
// dir is the only channel a test has.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JsonValue } from '@cohorte/base';

/** Pass it as `entryOverride`. Node runs it as TypeScript (type stripping); it never loads the testkit barrel. */
export const FAKE_BRAIN_ENTRY: string = fileURLToPath(new URL('../child.ts', import.meta.url));

export const FAKE_BRAIN_SCRIPT_FILE = 'fake-brain.script.json';
export const FAKE_BRAIN_MODEL_INPUTS_FILE = 'fake-brain.model-inputs.ndjson';
export const FAKE_BRAIN_GRANDCHILD_FILE = 'fake-brain.grandchild.pid';

export interface FakeBrainTurn {
  text?: string;
  toolCalls?: { tool: string; input: JsonValue }[];
}

export interface FakeBrainModelInput {
  systemPrompt: string;
  messages: { role: 'user' | 'assistant' | 'tool-result'; text: string }[];
}

/** Everything is optional: `{}` is a clean brain whose model stops at its first request. */
export interface FakeBrainScript {
  /** Model request k (1-based) is answered by `turns[k - 1]`; past the end the model answers an empty final turn. */
  turns?: FakeBrainTurn[];
  /** The endpoint this "engine" talks to. Default: the one the request pins. */
  endpoint?: string;
  /** Deep-merged over the honest attestation: `{ modelFallback: true }`, `{ hooks: { guardFetchInstalled: false } }`… */
  attestation?: { [member: string]: JsonValue };
  /** Added to the env var NAMES the child reports. */
  extraEnvKeys?: string[];
  /** Default 5000 (DESIGN 3.2). */
  heartbeatMs?: number;
  suppressHeartbeat?: boolean;
  /** Ignores `abort`, `shutdown` and SIGTERM: only SIGKILL ends it. */
  stubborn?: boolean;
  /** Starts a sleeping process in the fake brain's process group and writes its pid to FAKE_BRAIN_GRANDCHILD_FILE. */
  grandchild?: boolean;
  /** Hostile: sends a `tool.call` frame for a tool that was not granted instead of rejecting it engine-side. */
  forwardUngranted?: boolean;
  /** Hostile: sends this value as a frame when the first model request starts. */
  rawFrameOnFirstRequest?: JsonValue;
  /** Lines printed on stderr before `hello`. */
  stderr?: string[];
  /** Then that many bytes of `x` lines on stderr. */
  stderrFloodBytes?: number;
  /** What the "guard fetch" reports for every model request; 'omit' = no `provider.request` frame at all. */
  providerRequest?:
    | 'omit'
    | { origin?: string; authScheme?: 'bearer-jwt' | 'bearer-opaque' | 'api-key-header' | 'none'; refused?: boolean };
  /** Overrides of the echoed `model.responded` members. */
  responded?: { model?: string; authSource?: 'oauth' | 'api-key' | 'none' };
  /** Ends the model request k with this engine error instead of an answer. */
  failRequest?: { request: number; signal: { [member: string]: JsonValue } };
  /** Answers `init` with a `fatal` carrying this engine signal instead of `ready`: the spawn never starts. */
  fatalBeforeReady?: { signal: { [member: string]: JsonValue } };
  /** Dies without `settled`. */
  crash?: { at: 'first-request' | 'first-tool-call'; how: 'disconnect' | 'exit' };
}

/** Call it from the `stateDir` binding: the child reads the file from its cwd before it says `hello`. */
export function writeFakeBrainScript(stateDir: string, script: FakeBrainScript): void {
  writeFileSync(join(stateDir, FAKE_BRAIN_SCRIPT_FILE), JSON.stringify(script), 'utf8');
}

/** Every model input the fake brain recorded in that state dir, oldest first. */
export function readFakeBrainModelInputs(stateDir: string): FakeBrainModelInput[] {
  const path = join(stateDir, FAKE_BRAIN_MODEL_INPUTS_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as FakeBrainModelInput);
}

export function readFakeBrainGrandchildPid(stateDir: string): number | undefined {
  const path = join(stateDir, FAKE_BRAIN_GRANDCHILD_FILE);
  return existsSync(path) ? Number(readFileSync(path, 'utf8')) : undefined;
}
