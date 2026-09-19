import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import {
  canonicalJson,
  type ErrorInfo,
  err,
  errorOf,
  type JsonValue,
  ok,
  type Result,
  type Sha256,
  sha256Hex,
} from '@cohorte/base';
import { Compile } from 'typebox/compile';
import { parse as parseYaml } from 'yaml';
import type { FakeScript } from './index.ts';
import { FakeScriptSchema } from './schema.ts';

const MAX_REPORTED_PROBLEMS = 5;
const check = Compile(FakeScriptSchema);

const invalid = (message: string, problems: string[] = []): { ok: false; error: ErrorInfo } =>
  err(errorOf('configuration/unexpected', message, problems.length > 0 ? { details: { problems } } : {}));

/** A value of unknown origin (a parsed file, a JS caller) is a FakeScript, or the first problems say why not. */
export function validateFakeScript(value: unknown): Result<FakeScript, ErrorInfo> {
  if (check.Check(value)) return ok(value);
  const problems: string[] = [];
  for (const problem of check.Errors(value)) {
    problems.push(`${problem.instancePath || '/'} ${problem.message}`);
    if (problems.length === MAX_REPORTED_PROBLEMS) break;
  }
  return invalid(`the fake runtime script is invalid: ${problems[0] ?? 'it does not match the schema'}`, problems);
}

export function parseFakeScript(text: string, format: 'yaml' | 'json'): Result<FakeScript, ErrorInfo> {
  let value: unknown;
  try {
    value = format === 'json' ? JSON.parse(text) : parseYaml(text);
  } catch (thrown) {
    const reason = thrown instanceof Error ? thrown.message : String(thrown);
    return invalid(`the fake runtime script is not readable ${format.toUpperCase()}: ${reason}`);
  }
  return validateFakeScript(value);
}

/** `.json` is JSON, anything else is YAML (of which JSON is a subset). */
export function loadFakeScriptFile(path: string): Result<FakeScript, ErrorInfo> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (thrown) {
    const reason = thrown instanceof Error ? thrown.message : String(thrown);
    return invalid(`the fake runtime script ${path} cannot be read: ${reason}`);
  }
  return parseFakeScript(text, extname(path).toLowerCase() === '.json' ? 'json' : 'yaml');
}

/** What `pin()` records: two scripts with the same content have the same hash, whatever their key order or format. */
export function fakeScriptSha256(script: FakeScript): Sha256 {
  // A validated FakeScript holds JSON values only; the interface just does not say so structurally.
  return sha256Hex(canonicalJson(script as unknown as JsonValue));
}
