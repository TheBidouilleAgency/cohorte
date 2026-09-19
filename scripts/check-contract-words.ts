#!/usr/bin/env node
// DESIGN 1.2 / 2.2: `@cohorte/runtime-contract` carries no orchestration vocabulary and no engine
// name. This script fails when one of
//
//     phase pipeline gate policy approval review ownership worktree finding pi
//
// appears as a WHOLE camelCase / snake_case word of an exported name or of a schema key of that
// package. `capabilities` and `RuntimePin` pass (the letters "pi" are not a word there), `piSession`
// and `phaseId` do not. Plurals count (`findings`, `policies`). One identifier is let through by
// name: `SandboxPolicy`, which spec 5.1 itself puts in the contract (see ALLOWED_IDENTIFIERS).
//
// What is looked at, and nothing else:
//   - exported names: `export interface|type|const|let|var|function|class|enum|namespace X`,
//     `export { a as X }`, `export type { X }`, `export * as X`
//   - schema keys: members of an interface, class or enum body, of a type alias, the keys of an
//     object literal handed to `Type.Object(`, and the keys of an inline object type in a SIGNATURE
//     (a parameter or the return type of a method, of an exported function, of an exported arrow
//     constant: `spawn(opts: { phaseId: string })`), at any nesting depth
// Comments, string VALUES, parameter names and the bodies of functions are not contract surface.
//
// TypeScript 7 has no compiler API: this works on the tokens of check-layers.ts.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { type Token, tokenize } from './check-layers.ts';

export const FORBIDDEN_WORDS: readonly string[] = [
  'phase',
  'pipeline',
  'gate',
  'policy',
  'approval',
  'review',
  'ownership',
  'worktree',
  'finding',
  'pi',
];

/**
 * Exact identifiers the rule lets through. `SandboxPolicy` is the type of `SpawnRequest.sandbox` in spec
 * 5.1, which DESIGN 2.2 keeps VERBATIM: it names the isolation of the runtime's own process, not the
 * orchestrator's policy engine, and the word rule of DESIGN 1.2 would otherwise reject the spec's own
 * contract. Nothing else belongs here without a DESIGN amendment.
 */
export const ALLOWED_IDENTIFIERS: readonly string[] = ['SandboxPolicy'];

const PLURALS = new Map<string, string>(
  FORBIDDEN_WORDS.map((word) => [word.endsWith('y') ? `${word.slice(0, -1)}ies` : `${word}s`, word]),
);

/** `piSession` -> ['pi', 'session']; `APPROVAL_TTL_MS` -> ['approval', 'ttl', 'ms']; `RuntimePin` -> ['runtime', 'pin'] */
export function splitWords(identifier: string): string[] {
  return (identifier.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g) ?? []).map((word) => word.toLowerCase());
}

/** The forbidden word an identifier contains as a whole word, or `null`. */
export function findForbiddenWord(identifier: string): string | null {
  if (ALLOWED_IDENTIFIERS.includes(identifier)) return null;
  for (const word of splitWords(identifier)) {
    if (FORBIDDEN_WORDS.includes(word)) return word;
    const singular = PLURALS.get(word);
    if (singular !== undefined) return singular;
  }
  return null;
}

export interface WordHit {
  identifier: string;
  word: string;
  kind: 'export' | 'key';
  line: number;
}

const DECLARATION_KEYWORDS = new Set([
  'interface',
  'type',
  'const',
  'let',
  'var',
  'function',
  'class',
  'enum',
  'namespace',
]);
const EXPORT_MODIFIERS = new Set(['declare', 'default', 'abstract', 'async']);
const MEMBER_MODIFIERS = new Set([
  'readonly',
  'static',
  'public',
  'private',
  'protected',
  'declare',
  'abstract',
  'override',
  'get',
  'set',
  'async',
]);
/** Inside a member list, a `{` after one of these opens a nested member list (a type literal or a nested schema). */
const NESTED_MEMBER_OPENERS = new Set([':', '|', '&', '<', ',', '(', '[', '=', '?']);
const MEMBER_LIST_HEADERS = new Set(['interface', 'class', 'enum']);
/** Inside a signature a `{` is an object TYPE only in a type position; after `(`, `,` or `=` it is a pattern or a value. */
const SIGNATURE_TYPE_OPENERS = new Set([':', '|', '&', '<']);

/** `signature`: the parentheses of a method, of an exported function, or anything nested in them. */
type FrameKind = 'members' | 'signature' | 'other';
interface Frame {
  kind: FrameKind;
  /** The parameter list of an exported function: its `)` may be followed by a return type. */
  exported: boolean;
}

export function scanContractSource(source: string): WordHit[] {
  const tokens = tokenize(source);
  const hits: WordHit[] = [];
  const at = (index: number): Token | undefined => tokens[index];
  const isPunct = (index: number, text: string) => at(index)?.kind === 'punct' && at(index)?.text === text;
  const isWord = (index: number, text?: string) =>
    at(index)?.kind === 'word' && (text === undefined || at(index)?.text === text);

  const consider = (identifier: string, kind: WordHit['kind'], line: number) => {
    const word = findForbiddenWord(identifier);
    if (word !== null) hits.push({ identifier, word, kind, line });
  };

  // One frame per open bracket of any kind.
  const frames: Frame[] = [];
  const top = (): FrameKind | undefined => frames.at(-1)?.kind;
  // Depth of `frames` at which a `type X =` alias started; its `;` at that depth ends it.
  let aliasDepth: number | null = null;
  // Depth of `frames` at which the return type of an exported function is being read; the body's `{`,
  // an arrow or a `;` at that depth ends it.
  let returnTypeDepth: number | null = null;

  /** Does the statement that `{` at `index` belongs to start with interface / class / enum? */
  const opensMemberList = (index: number): boolean => {
    for (let k = index - 1; k >= 0 && k > index - 60; k -= 1) {
      const token = at(k) as Token;
      if (token.kind === 'punct' && [';', '{', '}', ')', '='].includes(token.text)) return false;
      if (token.kind === 'word' && MEMBER_LIST_HEADERS.has(token.text)) return true;
    }
    return false;
  };

  /** Is the `(` at `index` the parameter list of `export function f(`, `export function f<T>(` or `export const f = (`? */
  const opensExportedSignature = (index: number): boolean => {
    let k = index - 1;
    if (isPunct(k, '>')) {
      let depth = 0;
      for (; k >= 0; k -= 1) {
        if (isPunct(k, '>')) depth += 1;
        else if (isPunct(k, '<')) depth -= 1;
        if (depth === 0) break;
      }
      k -= 1;
    }
    const exportedBefore = (from: number): boolean => {
      let m = from;
      while (isWord(m) && EXPORT_MODIFIERS.has(at(m)?.text ?? '')) m -= 1;
      return isWord(m, 'export') && !isPunct(m - 1, '.');
    };
    if (isWord(k, 'async')) k -= 1;
    if (isPunct(k, '=')) {
      return isWord(k - 1) && ['const', 'let', 'var'].includes(at(k - 2)?.text ?? '') && exportedBefore(k - 3);
    }
    if (isWord(k) && !isWord(k, 'function')) k -= 1;
    if (isPunct(k, '*')) k -= 1;
    return isWord(k, 'function') && exportedBefore(k - 1);
  };

  /** `Type.Object( {` — also through a namespace alias such as `T.Object(`. */
  const opensSchemaObject = (index: number): boolean =>
    isPunct(index - 1, '(') && isWord(index - 2, 'Object') && isPunct(index - 3, '.');

  for (let k = 0; k < tokens.length; k += 1) {
    const token = at(k) as Token;

    if (token.kind === 'punct') {
      const readingReturnType = returnTypeDepth !== null && frames.length === returnTypeDepth;
      if (token.text === '{') {
        const previous = at(k - 1);
        const after = (openers: ReadonlySet<string>) => previous?.kind === 'punct' && openers.has(previous.text);
        const nested = top() === 'members' && after(NESTED_MEMBER_OPENERS);
        const inAlias = aliasDepth !== null && after(NESTED_MEMBER_OPENERS);
        const inSignature = (top() === 'signature' || readingReturnType) && after(SIGNATURE_TYPE_OPENERS);
        // At return-type depth, a `{` that is not in a type position is the body of the function.
        if (readingReturnType && !inSignature) returnTypeDepth = null;
        const members = opensMemberList(k) || opensSchemaObject(k) || nested || inAlias || inSignature;
        frames.push({ kind: members ? 'members' : 'other', exported: false });
      } else if (token.text === '(') {
        const exported = opensExportedSignature(k);
        const signature = exported || top() === 'members' || top() === 'signature' || readingReturnType;
        frames.push({ kind: signature ? 'signature' : 'other', exported });
      } else if (token.text === '[') {
        frames.push({ kind: 'other', exported: false });
      } else if (token.text === '}' || token.text === ')' || token.text === ']') {
        const closed = frames.pop();
        if (closed?.exported && isPunct(k + 1, ':')) returnTypeDepth = frames.length;
      } else if (token.text === ';' || token.text === '=>') {
        if (token.text === ';' && aliasDepth !== null && frames.length === aliasDepth) aliasDepth = null;
        if (readingReturnType) returnTypeDepth = null;
      }
      continue;
    }

    // `type Name =` at the start of a statement opens a type alias.
    if (token.kind === 'word' && token.text === 'type' && isWord(k + 1) && aliasDepth === null) {
      const previous = at(k - 1);
      const statementStart =
        previous === undefined ||
        token.lineStart ||
        isWord(k - 1, 'export') ||
        isWord(k - 1, 'declare') ||
        isPunct(k - 1, ';') ||
        isPunct(k - 1, '}');
      if (statementStart && (isPunct(k + 2, '=') || isPunct(k + 2, '<'))) aliasDepth = frames.length;
    }

    // Exported names.
    if (token.kind === 'word' && token.text === 'export' && !isPunct(k - 1, '.')) {
      let next = k + 1;
      while (isWord(next) && EXPORT_MODIFIERS.has(at(next)?.text ?? '')) next += 1;
      const keyword = at(next);
      if (isPunct(next, '*') && isWord(next + 1, 'as') && isWord(next + 2)) {
        consider(at(next + 2)?.text ?? '', 'export', token.line);
      } else if (isPunct(next, '{') || (isWord(next, 'type') && isPunct(next + 1, '{'))) {
        const open = isPunct(next, '{') ? next : next + 1;
        for (let m = open + 1; m < tokens.length && !isPunct(m, '}'); m += 1) {
          if (!isWord(m) || isWord(m, 'as') || isWord(m, 'type')) continue;
          const renamed = isWord(m + 1, 'as');
          if (!renamed) consider(at(m)?.text ?? '', 'export', at(m)?.line ?? token.line);
        }
      } else if (keyword?.kind === 'word' && DECLARATION_KEYWORDS.has(keyword.text)) {
        let name = next + 1;
        if (isPunct(name, '*')) name += 1;
        if (isWord(name)) consider(at(name)?.text ?? '', 'export', at(name)?.line ?? token.line);
      }
      continue;
    }

    // Schema keys: the first thing of a member, followed by what can follow a member name.
    if (top() !== 'members' || (token.kind !== 'word' && token.kind !== 'string')) continue;
    if (token.kind === 'word' && MEMBER_MODIFIERS.has(token.text) && (isWord(k + 1) || at(k + 1)?.kind === 'string'))
      continue;
    let before = k - 1;
    while (isWord(before) && MEMBER_MODIFIERS.has(at(before)?.text ?? '')) before -= 1;
    const startsMember = token.lineStart || isPunct(before, '{') || isPunct(before, ';') || isPunct(before, ',');
    const following = at(k + 1);
    const endsName = following?.kind === 'punct' && [':', '?', '(', '<', ',', '}', '=', ';'].includes(following.text);
    if (startsMember && endsName) consider(token.text, 'key', token.line);
  }
  return hits;
}

export interface FileHit extends WordHit {
  file: string;
}

function walk(root: string, relativeDir: string, out: string[]): void {
  if (!existsSync(join(root, relativeDir))) return;
  for (const name of readdirSync(join(root, relativeDir)).sort()) {
    if (name === 'node_modules' || name === 'dist' || name === 'dist-types') continue;
    const child = posix.join(relativeDir, name);
    const stats = statSync(join(root, child), { throwIfNoEntry: false });
    if (stats?.isDirectory()) walk(root, child, out);
    else if (stats?.isFile() && /\.[cm]?ts$/.test(name) && !name.endsWith('.d.ts')) out.push(child);
  }
}

export const CONTRACT_SOURCE_DIRECTORY = 'packages/runtime-contract/src';

export function checkContractWords(options: { root: string }): { hits: FileHit[]; filesScanned: number } {
  const files: string[] = [];
  walk(options.root, CONTRACT_SOURCE_DIRECTORY, files);
  const hits = files.flatMap((file) =>
    scanContractSource(readFileSync(join(options.root, file), 'utf8')).map((hit) => ({ file, ...hit })),
  );
  return { hits, filesScanned: files.length };
}

function main(): number {
  const { values } = parseArgs({ options: { root: { type: 'string' }, json: { type: 'boolean', default: false } } });
  const root = resolve(values.root ?? join(import.meta.dirname, '..'));
  const result = checkContractWords({ root });
  if (values.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.hits.length === 0) {
    process.stdout.write(
      `check-contract-words: OK (${result.filesScanned} files under ${CONTRACT_SOURCE_DIRECTORY})\n`,
    );
  } else {
    for (const hit of result.hits) {
      const what = hit.kind === 'export' ? 'exported name' : 'schema key';
      process.stderr.write(`${hit.file}:${hit.line} ${what} \`${hit.identifier}\` contains the word "${hit.word}"\n`);
    }
    process.stderr.write(
      `check-contract-words: ${result.hits.length} hit(s). The runtime contract names no orchestration concept and no engine (DESIGN 2.2).\n`,
    );
  }
  return result.hits.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = main();
