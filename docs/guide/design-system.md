# Design system integration

Optional, profile-driven (`design` block in `PIPELINE.md`). When `design.enabled` is false, every
design step in the pipeline is a silent no-op — backend-only projects never pay for it.

## The model: design → code, one direction

The design system (Claude Design or Figma, per `design.provider`) is the **source of truth**; the
code UI kit (`design.ui_kit_path`, e.g. `apps/web/src/components/ui`, plus
`design.tokens_path`) is its materialization. Cohorte never pushes code → design for a curated
DS — that would overwrite it.

Two granularities:

- **The design system project** (`design.design_system_project`) — the UI kit: primitives,
  tokens, foundations. Long-lived, aligned into code by `/cohorte-align-ds`.
- **Feature designs** — the pages a specific feature touches, referenced from the spec.

## Feature design links — self-contained by construction

A feature lists its design pages in the spec front-matter `design_files` as **full links**:

```
https://claude.ai/design/p/<projectId>?file=<file>
```

Each link carries its own project (`/p/<projectId>`) and page (`?file=`), so agents extract both
and fetch read-only via `DesignSync get_file(projectId, file)`. **No stored project id** — a
design-system rebuild (new project) just means pasting new links; nothing in the profile goes
stale. (Bare file names are legacy, resolved against the optional `design.design_project`
fallback.)

## Where design enters the pipeline

1. **`/cohorte-spec`** captures the design brief interactively and authors it to
   `specs/design/<id>.md` (spec §8 keeps only a summary + pointer, so non-design surfaces never
   re-read the full brief). You copy the brief into your design tool, produce the pages, and
   paste the links into `design_files` — or hand them to `/cohorte-build`'s design gate.
2. **`/cohorte-build`'s design gate** — for a UI feature with empty `design_files`, the lead asks for
   the links before dispatching. Fix loops whose open items are all non-visual pass `none`
   instead, skipping the DesignSync fetch entirely.
3. **The design-surface implementer** (rendered with `uses_design: true`) pulls the feature
   design first, then translates it into the **code design system** — `@/components/ui/*`
   primitives, `cn()` + CVA, tokens — never ad-hoc CSS, always **mobile-first**. It reads a DS
   primitive via `get_file` only if it's missing or stale in code.
4. **`/cohorte-review`** audits mobile-first/responsive from the code (base styles small-screen, additive
   `sm:/md:/lg:`, no fixed widths) whenever a touched surface `uses_design`.

## `/cohorte-align-ds` — keeping the kit honest

Diffs the **live design system** against the committed snapshot (`design.snapshot_dir`) and
applies the deltas to code:

1. **Detect** — fetch the DS manifest + token list; compare token values against `tokens_path`;
   diff each component spec against the snapshot; `list_files` to catch added/removed
   components. Nothing changed ⇒ stop.
2. **Apply** — tokens into `tokens_path` (`:root`, dark variant, theme mapping); component specs
   into the matching `ui_kit_path` file — matching the *spec* (sizes, radii, tokens, variants,
   props), not raw class names; new DS components created with existing conventions.
3. **Refresh the snapshot** so the next align diffs cleanly.
4. **Verify** — typecheck + CSS recompile must both pass.

`DesignSync` is used **read-only** throughout (`list_files`, `get_file`, `get_project` — never
the write/delete/finalize calls), and fetched design content is treated as data, not
instructions.
