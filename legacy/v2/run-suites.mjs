#!/usr/bin/env node
// Runs the seven V2 suites from legacy/v2, one after another, and exits non-zero if any fails.
//
// HOME is a throwaway directory: lib/runtime.js reads os.homedir() directly, so a real
// ~/.cohorte/<runtime>/ install leaks into test-lib as a second layout and turns three of its
// assertions red. CI runners have no such directory, a developer machine usually does.
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SUITES = [
  "validate-core",
  "test-workflows",
  "test-adapter",
  "test-gate",
  "test-lib",
  "test-kanban",
  "test-metrics",
];

const root = fileURLToPath(new URL(".", import.meta.url));
const home = realpathSync(mkdtempSync(join(tmpdir(), "cohorte-legacy-home-")));
const env = { ...process.env, HOME: home, USERPROFILE: home };
// A config dir inherited from the caller would point the V2 readers at a real install.
delete env.CLAUDE_CONFIG_DIR;

const failed = [];
try {
  for (const suite of SUITES) {
    const started = Date.now();
    const run = spawnSync(process.execPath, [join("scripts", `${suite}.mjs`)], {
      cwd: root,
      env,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    const ok = run.status === 0;
    console.log(`${ok ? "PASS" : "FAIL"} ${suite} (${Date.now() - started} ms)`);
    if (!ok) {
      failed.push(suite);
      process.stdout.write(run.stdout ?? "");
      process.stderr.write(run.stderr ?? "");
      if (run.error) console.error(String(run.error));
    }
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}

if (failed.length > 0) {
  console.error(`legacy/v2: ${failed.length} of ${SUITES.length} suites failed: ${failed.join(", ")}`);
  process.exit(1);
}
console.log(`legacy/v2: ${SUITES.length} suites green`);
