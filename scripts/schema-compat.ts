#!/usr/bin/env node
// scripts/schema-compat.ts — DESIGN 7.6, the `schema-compat` CI job. `--self` is the part gate G0 owns, the two
// checks that need nothing but THIS release:
//
//   (1) every `schemas/*.schema.json` compiles under `ajv/dist/2020` in STRICT mode — a second implementation, so a
//       schema the protocol's own compiler tolerates but a schema-only client (AC-07) cannot load is red here;
//   (2) every golden instance of `fixtures/schema-compat/<version>/` validates against the schema its name names.
//
// The other three checks of DESIGN 7.6 (past-release goldens, the structural diff against the last release tag,
// forward tolerance) need a PUBLISHED previous release; they are `U5.07`'s, and this file is theirs to grow into.
//
// ajv and ajv-formats are CJS: under `module: nodenext` + `verbatimModuleSyntax` the named import comes from
// `ajv/dist/2020.js` and the plugin sits on `default` (LEAD.md L4).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { OPEN_ENUM_KEYWORD } from '@cohorte/protocol';
import { Ajv2020, type ErrorObject, type SchemaObject } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { fileNameOf, SCHEMA_NAMES } from './gen-schemas.ts';

const addFormats = addFormatsModule.default ?? addFormatsModule;

export const REPO_ROOT = resolve(import.meta.dirname, '..');
export const SELF_FIXTURE_VERSION = '3.0.0-dev';

/** A fresh validator per schema: two published documents may legitimately carry the same definition names. */
const validator = () => addFormats(new Ajv2020({ strict: true, keywords: [OPEN_ENUM_KEYWORD] }));

export interface CompatProblem {
  readonly check: 'compile' | 'fixture';
  readonly subject: string;
  readonly detail: string;
}

export interface SelfCheckResult {
  readonly ok: boolean;
  readonly schemasChecked: number;
  readonly fixturesChecked: number;
  readonly problems: readonly CompatProblem[];
}

/**
 * `event.<type>.json` -> `events`, `command.<type>.json` -> `commands`, and both
 * `document.<name>[.<variant>].json` and `schema.<name>[.<variant>].json` -> the published schema `<name>`. The
 * variant suffix is dropped one dot-segment at a time, so `document.command-result.completed.json` finds
 * `command-result` and `document.inspect.agent.json` finds `inspect`.
 *
 * The last resort is `SCHEMA_NAMES`, not the seven protocol documents of `DOCUMENT_NAMES`: EVERY published schema
 * must be addressable by a golden instance, or checks 3 and 5 of DESIGN 7.6 (`U5.07`: past releases' goldens
 * validate; the previous release's open schema accepts the new golden stream) are structurally impossible for the
 * fourteen that are not protocol documents — `agent-output` among them, which is both one of the six of spec 4 and a
 * member of `PROTOCOL_SCHEMA_NAMES` that the AC-07 schema-only client reads. The two spellings resolve identically;
 * `schema.` exists because a fixture for `config` or `tool-catalogue` is not a protocol "document" (fix round 1).
 */
export function schemaNameForFixture(fileName: string): string | undefined {
  const stem = basename(fileName, '.json');
  const dot = stem.indexOf('.');
  if (dot === -1) return undefined;
  const kind = stem.slice(0, dot);
  if (kind === 'event') return 'events';
  if (kind === 'command') return 'commands';
  if (kind !== 'document' && kind !== 'schema') return undefined;
  let rest = stem.slice(dot + 1);
  while (rest.length > 0) {
    if (SCHEMA_NAMES.includes(rest)) return rest;
    const last = rest.lastIndexOf('.');
    if (last === -1) return undefined;
    rest = rest.slice(0, last);
  }
  return undefined;
}

export interface SelfCheckOptions {
  readonly repoRoot: string;
  readonly fixtureVersion?: string;
}

export function selfCheck(options: SelfCheckOptions): SelfCheckResult {
  const repoRoot = resolve(options.repoRoot);
  const schemasDir = join(repoRoot, 'schemas');
  const version = options.fixtureVersion ?? SELF_FIXTURE_VERSION;
  const fixturesDir = join(repoRoot, 'fixtures/schema-compat', version);
  const problems: CompatProblem[] = [];

  const compiled = new Map<string, ReturnType<ReturnType<typeof validator>['compile']>>();
  for (const name of SCHEMA_NAMES) {
    const path = join(schemasDir, fileNameOf(name));
    if (!existsSync(path)) {
      problems.push({ check: 'compile', subject: name, detail: 'no such file; run `pnpm gen:schemas`' });
      continue;
    }
    try {
      // The PARSE is inside the try, not before it: a truncated or malformed `schemas/*.schema.json` — what a
      // half-finished regeneration leaves behind — must name its subject like every other problem instead of
      // aborting `--self` with a raw SyntaxError stack (fix round 2).
      const schema = JSON.parse(readFileSync(path, 'utf8')) as SchemaObject;
      compiled.set(name, validator().compile(schema));
    } catch (error) {
      problems.push({
        check: 'compile',
        subject: name,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let fixturesChecked = 0;
  if (!existsSync(fixturesDir)) {
    problems.push({ check: 'fixture', subject: version, detail: `no fixture directory ${fixturesDir}` });
  } else {
    for (const file of readdirSync(fixturesDir)
      .filter((entry) => entry.endsWith('.json'))
      .sort()) {
      const name = schemaNameForFixture(file);
      if (name === undefined) {
        problems.push({ check: 'fixture', subject: file, detail: 'no schema is named by this file name' });
        continue;
      }
      const validate = compiled.get(name);
      if (validate === undefined) {
        problems.push({ check: 'fixture', subject: file, detail: `${name}.schema.json did not compile` });
        continue;
      }
      let instance: unknown;
      try {
        instance = JSON.parse(readFileSync(join(fixturesDir, file), 'utf8'));
      } catch (error) {
        // Same reason as the schema parse above: a malformed golden instance names itself (fix round 2).
        problems.push({
          check: 'fixture',
          subject: file,
          detail: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      fixturesChecked += 1;
      if (validate(instance)) continue;
      const errors = (validate.errors ?? [])
        .map((issue: ErrorObject) => `${issue.instancePath || '/'} ${issue.message ?? ''}`.trim())
        .join('; ');
      problems.push({ check: 'fixture', subject: file, detail: `${name}.schema.json: ${errors}` });
    }
  }

  return { ok: problems.length === 0, schemasChecked: compiled.size, fixturesChecked, problems };
}

function main(): void {
  const { values } = parseArgs({ options: { self: { type: 'boolean' }, root: { type: 'string' } } });
  if (values.self !== true) {
    process.stderr.write('usage: schema-compat.ts --self [--root <dir>]\n');
    process.exitCode = 2;
    return;
  }
  const result = selfCheck({ repoRoot: values.root ?? REPO_ROOT });
  if (result.ok) {
    process.stdout.write(
      `schema-compat --self: ${result.schemasChecked} schema(s) compile under ajv 2020 strict, ` +
        `${result.fixturesChecked} golden instance(s) validate\n`,
    );
    return;
  }
  const lines = result.problems.map((problem) => `  ${problem.check.padEnd(7)} ${problem.subject}: ${problem.detail}`);
  process.stderr.write(`schema-compat --self: ${result.problems.length} problem(s)\n${lines.join('\n')}\n`);
  process.exitCode = 1;
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `schema-compat failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
