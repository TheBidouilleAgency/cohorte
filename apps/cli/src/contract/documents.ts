// apps/cli/src/contract/documents.ts — DESIGN 2.3.5 "one [S] document per --json output". `JSON_OUTPUTS` is the
// map a Wave-4 command unit's `--json validates` test reads: verb -> the published document(s) that verb's
// `--json` can print, each resolvable to a real schema in the protocol, project-model or security contract (PLAN
// U0.10 test list, 6th row).

import { ProjectModel, ReconcilePlan } from '@cohorte/project-model/contract';
import { DOCUMENTS, type DocumentName } from '@cohorte/protocol';
import type { TSchema } from 'typebox';

/** The two project-model documents a `--json` verb may print (DESIGN §9: `reconcile --plan`, `discover`). */
export const PROJECT_MODEL_DOCUMENT_NAMES = ['reconcile-plan', 'project-model'] as const;
export type ProjectModelDocumentName = (typeof PROJECT_MODEL_DOCUMENT_NAMES)[number];

export type DocumentRef =
  | { readonly source: 'protocol'; readonly name: DocumentName }
  | { readonly source: 'project-model'; readonly name: ProjectModelDocumentName };

/** Resolves a `DocumentRef` to its real schema; throws when the referenced contract has no such entry (a drift
 * guard, not a runtime path: every entry of `JSON_OUTPUTS` below is checked against this at test time). */
export function resolveDocumentSchema(ref: DocumentRef): TSchema {
  if (ref.source === 'protocol') {
    const schema = DOCUMENTS[ref.name];
    if (!schema) throw new RangeError(`resolveDocumentSchema: no protocol document named ${ref.name}`);
    return schema;
  }
  // A plain lookup, not a `switch` with an unreachable default: the ref may come from a Wave-4 unit's data, so an
  // unknown name must throw at run time and not only fail to typecheck.
  // No cast: `TUnsafe<T> extends TSchema`, and there is exactly one typebox install (the `pnpm-workspace.yaml`
  // override pins 1.3.7), so `@cohorte/project-model/contract`'s schemas ARE `TSchema`s here. If this ever stops
  // compiling, the cause is a second typebox identity in the graph — a real defect to report, not to cast away.
  const projectModelSchemas: Record<ProjectModelDocumentName, TSchema> = {
    'reconcile-plan': ReconcilePlan,
    'project-model': ProjectModel,
  };
  const schema = projectModelSchemas[ref.name];
  if (!schema) throw new RangeError(`resolveDocumentSchema: no project-model document named ${String(ref.name)}`);
  return schema;
}

const protocolDoc = (name: DocumentName): DocumentRef => ({ source: 'protocol', name });
const reconcilePlanDoc: DocumentRef = { source: 'project-model', name: 'reconcile-plan' };
/** DESIGN §9 verb semantics: "`cohorte discover` prints the deterministic scan as a Project Model document". */
const projectModelDoc: DocumentRef = { source: 'project-model', name: 'project-model' };
/** DESIGN 2.3.4's inbox route: every mutating command answers with a `CommandResultDocument`. */
const commandResult: readonly DocumentRef[] = [protocolDoc('command-result')];

/**
 * Keyed by CLI verb (not by `CommandType`: read-only verbs publish a document with no command behind them).
 *
 * The key set is exactly `{ verb.name | verb.json }` of `contract/verbs.ts`, and `cli.ts` registers `--json` only
 * for those verbs — `apps/cli/test/registry/json-outputs.test.ts` pins both directions. `logs` and `tail` are
 * deliberately absent: DESIGN 4.7 gives an observer `--format=line|json` over an NDJSON *stream* of event
 * envelopes, not a single `--json` document (request U0.10 R1 asks U0.G to confirm that reading).
 */
export const JSON_OUTPUTS: Readonly<Record<string, readonly DocumentRef[]>> = Object.freeze({
  // `status <run>` -> run-state; `status` (no run) -> project-status (DESIGN 2.3.4 "no runId => ProjectStatusDocument")
  status: [protocolDoc('project-status'), protocolDoc('run-state')],
  inspect: [protocolDoc('inspect')],
  diff: [protocolDoc('run-diff')],
  doctor: [protocolDoc('doctor-report')],
  auth: [protocolDoc('auth-status')],
  reconcile: [reconcilePlanDoc],
  discover: [projectModelDoc],
  // `run` drives `start`; its `--wait`/`--json` prints the same run-state an observer would (DESIGN 4.7).
  run: [protocolDoc('command-result'), protocolDoc('run-state')],
  resume: commandResult,
  pause: commandResult,
  cancel: commandResult,
  approve: commandResult,
  deny: commandResult,
  retry: commandResult,
  skip: commandResult,
  shutdown: commandResult,
  send: commandResult,
  'run-tool': commandResult,
});
