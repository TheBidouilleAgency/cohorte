// Comment-preserving configuration writer (PLAN U2.09).

import { readFile, writeFile } from 'node:fs/promises';
import type { JsonValue } from '@cohorte/base';
import { parseDocument } from 'yaml';

export interface ConfigEdit {
  /** JSON pointer into the config document */
  pointer: string;
  /** undefined deletes the key */
  value: JsonValue | undefined;
}

export async function writeConfig(file: string, edits: readonly ConfigEdit[]): Promise<void> {
  const document = parseDocument(await readFile(file, 'utf8'));
  for (const edit of edits) {
    const path = edit.pointer
      .split('/')
      .slice(1)
      .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
    if (edit.value === undefined) document.deleteIn(path);
    else document.setIn(path, edit.value);
  }
  await writeFile(file, String(document), 'utf8');
}
