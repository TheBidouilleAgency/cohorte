## Rendering / reconciling a surface agent (shared procedure)

Both `/cohorte-init-pipeline` (initial render) and `/cohorte-build` (auto-reconcile when a spec needs a new agent) use
this exact procedure so a surface is always defined the same way. To add surface `S`:

1. **Add the `surfaces[]` entry** to `PIPELINE.md`: `key`, `path` (the disjoint tree it exclusively
   owns), `label`, `agent` (rendered file name), `tools` (add `DesignSync` only if `uses_design: true`;
   append the retrieval provider's MCP tools when `retrieval.provider` ≠ `none` — e.g. `mcp__serena`),
   `model` (tier for the rendered agent: `sonnet` (default) — the implementer mostly applies a frozen
   contract, which Sonnet does well at a fraction of the Opus-lead cost; `haiku` for purely mechanical
   scaffolding; `inherit` only when the surface makes real design decisions worth the lead's model),
   the five `*_cmd`s (derive from the surface's `package.json` / workspace
   filter, mirroring a sibling surface), and `uses_design`. Then run `<sync>`: it regenerates
   `<state>/profile.json` (the parsed machine block agents read), which otherwise lacks `S`.
2. **Render the agent file** `<agents>/<agent>.md` from `<core>/pipeline/implementer.template.md`
   — the template is already rendered for this runtime, so only the placeholders are yours to fill —
   substituting `<SURFACE_AGENT>`, `<SURFACE_LABEL>`,
   `<SURFACE_PATH>`, `<SURFACE_TOOLS>`, `<SURFACE_MODEL>`, `<PROJECT_NAME>`, and the surface-specific
   blocks (`<SURFACE_EXTRA_NEVER>`, `<SURFACE_DESIGN_INPUT>`, `<SURFACE_TDD_STEP1>` — leave the design
   ones empty unless `uses_design`). Fill `<SURFACE_CONVENTIONS>` with the surface's convention slice
   **baked at render time**: `PIPELINE.md` §Conventions `### Shared` + this surface's
   `### Surface: <key>` stanza + its §Testing lines, verbatim. At runtime the agent then reads only
   the profile's machine block (the fenced `yaml pipeline-profile`) — never the prose sections. The
   bake stays honest because §Conventions edits go through `/cohorte-update-pipeline`, whose reconcile
   re-renders every agent (§Reconcile step 2, `<core>/pipeline/schema/reconcile.md`); hand-edit the prose without re-rendering and the baked
   slice goes stale — that's the trade for not re-reading the prose on every dispatch. For a `uses_design` surface, fill them **link-based** (never with a
   stored `design_project` id — that goes stale on a DS rebuild):
   - `<SURFACE_DESIGN_INPUT>` — a 4th input bullet: _"The **feature design** — the pages this feature
     touches, listed in your dispatch's design slot as full links
     (`https://claude.ai/design/p/<projectId>?file=<file>`); a slot saying `none` means a fix loop with
     no visual work — skip DesignSync entirely. For each link, extract the `<projectId>` (the
     `/p/…` segment) and `<file>` (the `?file=` query) from the URL and read it read-only via `DesignSync
     get_file(<projectId>, <file>)`; `list_files(<projectId>)` to catch linked pages (shared nav/modals)
     this feature also changes. The link is self-contained — no stored project id. Build with the code UI
     kit (the `design_system_project`'s materialization: `@/components/ui/*` + tokens); read a primitive
     via `get_file` only if it's missing/stale in code. Mobile-first."_
   - `<SURFACE_TDD_STEP1>` — a **lead-in paragraph** above the TDD list (not a numbered item; it
     renders as nothing for a non-design surface, which is why the list must not start at it):
     _"**Pull the feature design first** (skip if your dispatch's design slot
     says `none`): `DesignSync get_file(<projectId>, <file>)` for each link in the slot and translate
     each into the code design system (`@/components/ui/*`, `cn()` + CVA), mobile-first — never ad-hoc
     CSS. Then:"_
3. **Add a §Conventions + §Testing stanza** for `S` in `PIPELINE.md` (mirror a sibling surface; keep it
   rule-shaped). If `S` is a shared-code surface, its convention is "single owner of shared X; slices
   consume, never redefine."

Removing/merging a surface is the reverse: drop the `surfaces[]` entry, delete its agent file, fold its
conventions, run `<sync>`. Never leave an agent file with no matching `surfaces[]` entry (orphan) or vice-versa.
