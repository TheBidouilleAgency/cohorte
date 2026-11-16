## Feature diff — what "the feature changed" means

Every diff the pipeline reads — the review's changed-path list and per-surface hunks, an
implementer's self-diff, the freshness digest `/cohorte-review` stamps and `/cohorte-ship` re-checks —
comes from ONE shipped script, `<core>/pipeline/scripts/feature-diff.sh`, never a bare `git diff`:

```
feature-diff.sh --default <default_branch> (--numstat|--name-only|--patch|--digest|--base-only) [-- <pathspec>…]
feature-diff.sh --base <sha>               (same modes)
```

- **Untracked files are in.** Feature work stays uncommitted until `/cohorte-ship`, and `git diff <ref>`
  never shows an untracked file — new modules escaped review, and an adds-only feature reviewed as an
  empty diff that scored SHIP. The script diffs a **throwaway index** (seeded from the real one,
  `git add -A` on the copy); the human's index and what they staged are never touched.
- **The base is the merge-base**, not the default branch's tip (which blames the feature for every
  file `main` gained since). Local `<branch>` and `origin/<branch>` are both tried; the newer
  merge-base wins (fleet worktrees branch off the remote ref).
- **`.claude/` and `specs/` are always excluded** (the pipeline's own writes), gitignored files never
  enter. Exit 3 = the base cannot be resolved: the caller stops — it never falls back to `git diff`.
