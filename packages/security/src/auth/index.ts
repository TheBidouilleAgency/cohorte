// File-backed project keys, HMAC command authentication and trust records.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson, computeAnchorMac, hmacSha256Hex, type RunId, systemClock } from '@cohorte/base';
import type { TrustRecord, TrustStore } from '@cohorte/config/schema';
import type { CommandAuthenticator, KeyStore } from '../contract/index.ts';

export interface KeyStoreOptions {
  /** `~/.cohorte/keys`: directory 0700, files 0600; wrong modes are refused */
  directory: string;
}

export function createKeyStore(options: KeyStoreOptions): KeyStore {
  const pathFor = (id: string): string => join(options.directory, `${id}.key`);
  return {
    async projectKey(projectKeyId, opts): Promise<Uint8Array> {
      if (!/^[A-Za-z0-9._-]+$/.test(projectKeyId)) throw new TypeError('invalid project key id');
      await mkdir(options.directory, { recursive: true, mode: 0o700 });
      await chmod(options.directory, 0o700);
      const path = pathFor(projectKeyId);
      try {
        const metadata = await stat(path);
        if ((metadata.mode & 0o777) !== 0o600) throw new Error('key file permissions are not 0600');
        const key = await readFile(path);
        if (key.byteLength !== 32) throw new Error('project key must be 32 bytes');
        return Uint8Array.from(key);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !opts.create) throw error;
        const key = randomBytes(32);
        const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
        await writeFile(temporary, key, { mode: 0o600 });
        await chmod(temporary, 0o600);
        await rename(temporary, path);
        return Uint8Array.from(key);
      }
    },
  };
}

export function createCommandAuthenticator(): CommandAuthenticator {
  return {
    scheme: 'hmac-sha256',
    sign(canonicalBody, key): string {
      return hmacSha256Hex(key, canonicalBody);
    },
    verify(canonicalBody, value, key): boolean {
      try {
        const expected = Buffer.from(hmacSha256Hex(key, canonicalBody), 'hex');
        const actual = Buffer.from(value, 'hex');
        return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
      } catch {
        return false;
      }
    },
    anchor(runId: RunId, atSequence: number, chainHash: string, key): string {
      return computeAnchorMac(key, runId, atSequence, chainHash);
    },
  };
}

export interface TrustStoreOptions {
  /** `~/.cohorte/trust`: directory 0700, files 0600 */
  directory: string;
  /** records are MAC'd with the project key; a bad MAC or wrong modes = ABSENT (fail closed) */
  keys: KeyStore;
}

export function createTrustStore(options: TrustStoreOptions): TrustStore {
  const pathFor = (id: string): string => join(options.directory, `${id}.json`);
  const unsigned = (record: Omit<TrustRecord, 'mac'>): string => canonicalJson(record);
  return {
    async lookup(projectKeyId, policySha256): Promise<TrustRecord | undefined> {
      try {
        const path = pathFor(projectKeyId);
        const metadata = await stat(path);
        if ((metadata.mode & 0o777) !== 0o600) return undefined;
        const record = JSON.parse(await readFile(path, 'utf8')) as TrustRecord;
        if (record.policySha256 !== policySha256) return undefined;
        const key = await options.keys.projectKey(projectKeyId, { create: false });
        const { mac: _mac, ...recordWithoutMac } = record;
        const expected = hmacSha256Hex(key, unsigned(recordWithoutMac));
        return expected === record.mac ? record : undefined;
      } catch {
        return undefined;
      }
    },
    async grant(projectKeyId, grant): Promise<TrustRecord> {
      const key = await options.keys.projectKey(projectKeyId, { create: true });
      const recordWithoutMac = {
        policySha256: grant.policySha256,
        loosenedKeys: [...grant.loosenedKeys],
        grantedAt: systemClock.now(),
        grantedBy: grant.grantedBy,
      };
      const record: TrustRecord = {
        ...recordWithoutMac,
        mac: hmacSha256Hex(key, unsigned(recordWithoutMac)),
      };
      await mkdir(options.directory, { recursive: true, mode: 0o700 });
      await chmod(options.directory, 0o700);
      const path = pathFor(projectKeyId);
      const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, path);
      return record;
    },
    async revoke(projectKeyId): Promise<boolean> {
      try {
        await unlink(pathFor(projectKeyId));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    },
  };
}
