import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const forbidden = /(^|\/)(\.[^/]*|node_modules|dist|vendor)(\/|$)|(^|\/)(id_rsa|id_ed25519|.*\.(pem|key|p12))$/i;
export class Files {
  readonly root: string;
  readonly writable: string[];
  readonly readOnly: boolean;
  constructor(root: string, writable: string[], readOnly: boolean) {
    this.root = root;
    this.writable = writable;
    this.readOnly = readOnly;
  }
  private parts(path: string) {
    if (
      typeof path !== 'string' ||
      path.length > 1024 ||
      path.includes('\0') ||
      path.includes('\\') ||
      path.startsWith('/') ||
      forbidden.test(path) ||
      path.split('/').some((x) => !x || x === '.' || x === '..')
    )
      throw new Error('Path denied');
    return path.split('/');
  }
  private async safe(path: string, createParents = false) {
    const parts = this.parts(path);
    let current = this.root;
    for (const [i, part] of parts.entries()) {
      current = join(current, part);
      try {
        const stat = await lstat(current);
        if (
          stat.isSymbolicLink() ||
          (i < parts.length - 1 && !stat.isDirectory()) ||
          (i === parts.length - 1 && (!stat.isFile() || stat.nlink !== 1))
        )
          throw new Error('Non-regular path denied');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        if (i < parts.length - 1) {
          if (!createParents) throw e;
          await mkdir(current);
        }
      }
    }
    return current;
  }
  async read(path: string) {
    const file = await open(await this.safe(path), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 128 * 1024) throw new Error('File exceeds text limit');
      const content = await file.readFile('utf8');
      if (content.includes('\0')) throw new Error('Binary file denied');
      return content;
    } finally {
      await file.close();
    }
  }
  async write(path: string, content: string) {
    this.parts(path);
    if (this.readOnly || !this.writable.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)))
      throw new Error('Write denied for this phase or surface');
    if (typeof content !== 'string' || Buffer.byteLength(content) > 128 * 1024 || content.includes('\0'))
      throw new Error('Invalid text content');
    const target = await this.safe(path, true);
    const temporary = join(dirname(target), `.cohorte-${randomUUID()}`);
    try {
      const file = await open(temporary, 'wx', 0o644);
      try {
        await file.writeFile(content);
        await file.sync();
      } finally {
        await file.close();
      }
      await this.safe(path);
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  async list() {
    const result: string[] = [];
    const walk = async (directory: string, depth: number) => {
      if (depth > 16) return;
      for (const entry of await readdir(join(this.root, directory), { withFileTypes: true })) {
        const path = directory ? `${directory}/${entry.name}` : entry.name;
        if (forbidden.test(path) || entry.isSymbolicLink()) continue;
        if (result.length >= 2000) throw new Error('Repository file limit exceeded');
        if (entry.isDirectory()) await walk(path, depth + 1);
        else if (entry.isFile()) result.push(path);
      }
    };
    await walk('', 0);
    return result.sort();
  }
}
