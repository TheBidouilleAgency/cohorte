#!/usr/bin/env node
// Builds the dashboard (ui/): installs its build tooling, then compiles the server (tsc) and the page (vite)
// into ui/dist-server and ui/dist-web — the only parts of ui/ that ship. Run by `npm run build:ui`, by
// `prepack`, and by CI before the dashboard's tests.
//
//   node scripts/build-ui.mjs [--no-install]

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ui = fileURLToPath(new URL("../ui", import.meta.url));
const win = process.platform === "win32";
const install = !process.argv.includes("--no-install") || !existsSync(join(ui, "node_modules"));

// A user-level `allow-scripts` setting reaches child npm processes as npm_config_allow_scripts, which npm
// (11.x) rejects for project-scoped installs — and it is no business of this build.
const env = { ...process.env };
for (const k of Object.keys(env)) if (/^npm_config_allow[-_]scripts$/i.test(k)) delete env[k];

const step = (args) => {
  const r = spawnSync(win ? "npm.cmd" : "npm", args, { cwd: ui, stdio: "inherit", env, shell: win });
  if (r.status !== 0) { console.error(`\nbuild-ui: \`npm ${args.join(" ")}\` failed (${r.status ?? r.error?.message})`); process.exit(r.status || 1); }
};

if (install) step(["ci", "--no-audit", "--no-fund"]);
step(["run", "build"]);
