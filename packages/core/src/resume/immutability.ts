// DESIGN 4.4 step 4 / 6.2 / 6.3 / ADR-0023 — "immutability inputs (pin, snapshot digest, table version; NO adopt
// flag)". Mismatch ⇒ stop `runtime-incompatible` ⇒ BLOCKED, `resumeRequires: reinstall-pinned-version`; there is
// no override (ADR-0023 §3: "no adopt/accept flag exists in V3.0").
//
// DEVIATION (docs/v3/requests/U1.10.md, item D2): full re-verification needs a content-addressed re-hash of the
// pinned install's `dist/**` and of the run's own snapshot manifest (`PinReader`/`RunSnapshotter.verify`, which
// need a `RunSnapshotManifest` this port has no way to load without `PinReader` in `ResumeDeps`). The smallest
// consistent reading implemented here: (a) the CURRENT host's own install directory must equal
// `RunRecord.pinnedInstallDir` (`InstallInspector.installDir()`, already a frozen `core` port — no new package
// edge), which is exactly what ADR-0023 §2 says resume must check before doing anything else ("the detached host is
// always spawned from that directory... after its hashes verify"); (b) the run's `(profile, tableVersion)` must
// resolve to a table this build ships (`resolveTable`, U0.09, pure). Both failures map to the SAME
// `resumeRequires: reinstall-pinned-version` DESIGN names for a pin mismatch; a real build's `hashesVerify()` would
// extend check (a) without changing this function's shape.
import type { RunRecord } from '@cohorte/persistence/contract';
import type { InstallInspector } from '../contract/ports.ts';
import { resolveTable } from '../pipeline/tables/index.ts';

export type ImmutabilityCheck = { ok: true } | { ok: false; reason: 'install-dir-mismatch' | 'table-not-shipped' };

/** Synchronous: both halves read data already in hand (`InstallInspector.installDir()` is sync, `resolveTable` is
 * pure). It becomes asynchronous the day a real `PinReader`/`RunSnapshotter` re-hash joins it (D2). */
export function checkImmutability(run: RunRecord, installInspector: InstallInspector): ImmutabilityCheck {
  const installDir = installInspector.installDir();
  if (installDir !== run.pinnedInstallDir) return { ok: false, reason: 'install-dir-mismatch' };
  const resolved = resolveTable(run.profile, run.tableVersion);
  if (!resolved.ok) return { ok: false, reason: 'table-not-shipped' };
  return { ok: true };
}
