// DESIGN 2.7 — the 9 V3.0 tools + the 3 seams, as DATA: name, model-facing description, input schema, effect,
// terminal, and the path-argument annotations `pathArgsOf` reads. Every input schema is authored UNCLOSED (as every
// TypeBox schema in this repo is) and closed once, uniformly, by `toStrictSchema` in `./index.ts` — the same
// generator `@cohorte/protocol` uses for commands and events (DESIGN 0.1 C3), so "additionalProperties: false" is
// never something an author can forget.
import type { JsonValue } from '@cohorte/base';
import { AgentOutput, ClosedEnum } from '@cohorte/protocol';
// The ONE closed union of path intents (DESIGN 2.6.3): re-exported, never re-declared, so `toolIntrospection`'s
// `PathArg[]` IS a `ToolIntrospection` result and no cast bridges two copies of the same union.
import type { PathIntent } from '@cohorte/security/contract';
import { type Static, type TSchema, Type } from 'typebox';

export type { PathIntent };
export interface PathArg {
  arg: string;
  value: string;
  intent: PathIntent;
}

const ReadFileInput = Type.Object({
  path: Type.String(),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1 })),
});
const ListFilesInput = Type.Object({
  path: Type.Optional(Type.String()),
  glob: Type.Optional(Type.String()),
  maxEntries: Type.Optional(Type.Integer({ minimum: 1 })),
});
const SearchInput = Type.Object({
  pattern: Type.String(),
  path: Type.Optional(Type.String()),
  glob: Type.Optional(Type.String()),
  caseInsensitive: Type.Optional(Type.Boolean()),
  maxMatches: Type.Optional(Type.Integer({ minimum: 1 })),
});
const WriteFileInput = Type.Object({ path: Type.String(), content: Type.String() });
const PatchFileInput = Type.Object({
  path: Type.String(),
  edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() }), { minItems: 1 }),
});
const RunCommandInput = Type.Object({
  argv: Type.Array(Type.String(), { minItems: 1 }),
  cwd: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
});
export const GIT_DIFF_BASES = ['run-base', 'integration', 'checkpoint'] as const;
const GitDiffInput = Type.Object({
  base: Type.Optional(ClosedEnum(GIT_DIFF_BASES)),
  paths: Type.Optional(Type.Array(Type.String())),
  stat: Type.Optional(Type.Boolean()),
});
const ApprovalRequestInput = Type.Object({
  question: Type.String(),
  options: Type.Optional(Type.Array(Type.String())),
});
const GitCommitInput = Type.Object({ message: Type.String() });
const NetworkRequestInput = Type.Object({ url: Type.String(), method: Type.Optional(Type.String()) });
const SecretReadInput = Type.Object({ id: Type.String() });

export type ReadFileInput = Static<typeof ReadFileInput>;
export type ListFilesInput = Static<typeof ListFilesInput>;
export type SearchInput = Static<typeof SearchInput>;
export type WriteFileInput = Static<typeof WriteFileInput>;
export type PatchFileInput = Static<typeof PatchFileInput>;
export type RunCommandInput = Static<typeof RunCommandInput>;
export type GitDiffInput = Static<typeof GitDiffInput>;
export type ApprovalRequestInput = Static<typeof ApprovalRequestInput>;
export type GitCommitInput = Static<typeof GitCommitInput>;
export type NetworkRequestInput = Static<typeof NetworkRequestInput>;
export type SecretReadInput = Static<typeof SecretReadInput>;

export interface CatalogueRow {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: TSchema;
  readonly effect: 'read' | 'write' | 'execute' | 'network' | 'control';
  readonly terminal: boolean;
  readonly pathArgsOf: (input: JsonValue) => PathArg[];
}

const noPaths = (): PathArg[] => [];
const stringField = (input: JsonValue, key: string): string | undefined => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const value = (input as Record<string, JsonValue>)[key];
  return typeof value === 'string' ? value : undefined;
};
const arrayField = (input: JsonValue, key: string): JsonValue[] | undefined => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const value = (input as Record<string, JsonValue>)[key];
  return Array.isArray(value) ? value : undefined;
};

/** DESIGN 2.7, in table order. `submit_result.inputSchema` is `AgentOutput` itself — closed by the same
 * `toStrictSchema` every other row goes through in `./index.ts`, so the two are deep-equal by construction. */
export const CATALOGUE_ROWS: readonly CatalogueRow[] = [
  {
    name: 'read_file',
    description:
      'Read a file as sealed text with line numbers. offset/limit page through it; binary files error; capped at 256 KiB per call.',
    inputSchema: ReadFileInput,
    effect: 'read',
    terminal: false,
    pathArgsOf: (input) => {
      const path = stringField(input, 'path');
      return path === undefined ? [] : [{ arg: 'path', value: path, intent: 'read' }];
    },
  },
  {
    name: 'list_files',
    description:
      'List files under a path (default the workspace root), filtered by glob. Deny sets are filtered out; outgoing symlinks are never followed.',
    inputSchema: ListFilesInput,
    effect: 'read',
    terminal: false,
    pathArgsOf: (input) => {
      const path = stringField(input, 'path');
      return path === undefined ? [] : [{ arg: 'path', value: path, intent: 'list' }];
    },
  },
  {
    name: 'search',
    description:
      'Search file contents for a pattern (a literal argv element, never a shell string). Every hit is filtered against the deny sets and the grant before it is returned.',
    inputSchema: SearchInput,
    effect: 'read',
    terminal: false,
    pathArgsOf: (input) => {
      const path = stringField(input, 'path');
      return path === undefined ? [] : [{ arg: 'path', value: path, intent: 'list' }];
    },
  },
  {
    name: 'write_file',
    description: 'Write the complete content of a file, creating it if it does not exist. The whole file is replaced.',
    inputSchema: WriteFileInput,
    effect: 'write',
    terminal: false,
    pathArgsOf: (input) => {
      const path = stringField(input, 'path');
      return path === undefined ? [] : [{ arg: 'path', value: path, intent: 'write' }];
    },
  },
  {
    name: 'patch_file',
    description:
      'Apply exact-match text edits to a file: each oldText must occur exactly once in the current content, or the call fails without writing anything.',
    inputSchema: PatchFileInput,
    effect: 'write',
    terminal: false,
    pathArgsOf: (input) => {
      const path = stringField(input, 'path');
      return path === undefined ? [] : [{ arg: 'path', value: path, intent: 'write' }];
    },
  },
  {
    name: 'run_command',
    description: 'Run one allow-listed command (argv only, never a shell line) and return its output.',
    inputSchema: RunCommandInput,
    effect: 'execute',
    terminal: false,
    pathArgsOf: (input) => {
      const cwd = stringField(input, 'cwd');
      return cwd === undefined ? [] : [{ arg: 'cwd', value: cwd, intent: 'exec-cwd' }];
    },
  },
  {
    name: 'git_diff',
    description:
      "Show a diff of the worktree against 'run-base' (the run's pinned base, the default on a read-only review ref), 'integration' (the default in a slot) or 'checkpoint'.",
    inputSchema: GitDiffInput,
    effect: 'read',
    terminal: false,
    pathArgsOf: (input) => {
      const paths = arrayField(input, 'paths');
      if (!paths) return [];
      const out: PathArg[] = [];
      paths.forEach((value, index) => {
        if (typeof value === 'string') out.push({ arg: `paths[${index}]`, value, intent: 'read' });
      });
      return out;
    },
  },
  {
    name: 'approval_request',
    description:
      'Ask a human a question before proceeding, optionally offering a fixed set of answers. Waits for a decision.',
    inputSchema: ApprovalRequestInput,
    effect: 'control',
    terminal: false,
    pathArgsOf: noPaths,
  },
  {
    name: 'submit_result',
    description:
      'Submit the final structured result for this task. Call submit_result alone, last: no other tool call may follow it in the same batch.',
    inputSchema: AgentOutput,
    effect: 'control',
    terminal: true,
    pathArgsOf: (input) => {
      const artifacts = arrayField(input, 'artifacts');
      if (!artifacts) return [];
      const out: PathArg[] = [];
      artifacts.forEach((artifact, index) => {
        const path = stringField(artifact, 'path');
        if (path !== undefined) out.push({ arg: `artifacts[${index}].path`, value: path, intent: 'read' });
      });
      return out;
    },
  },
  {
    name: 'git_commit',
    description: 'Reserved: granted to nobody in V3.0. Cohorte alone commits agent work.',
    inputSchema: GitCommitInput,
    effect: 'write',
    terminal: false,
    pathArgsOf: noPaths,
  },
  {
    name: 'network_request',
    description: 'Reserved: granted to nobody in V3.0. Agents have no network access.',
    inputSchema: NetworkRequestInput,
    effect: 'network',
    terminal: false,
    pathArgsOf: noPaths,
  },
  {
    name: 'secret_read',
    description: 'Reserved: granted to nobody in V3.0.',
    inputSchema: SecretReadInput,
    effect: 'read',
    terminal: false,
    pathArgsOf: noPaths,
  },
];

/** Tools registered but granted to nobody in V3.0 (DESIGN 2.7): the default policy denies every call, on principle. */
export const SEAM_TOOL_NAMES = ['git_commit', 'network_request', 'secret_read'] as const;

export const TOOL_NAMES = CATALOGUE_ROWS.map((row) => row.name);
