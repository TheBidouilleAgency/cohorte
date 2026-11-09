---
layout: home

hero:
  name: Cohorte
  text: Multi-agent dev pipeline for Claude Code
  tagline: Install the core, run /cohorte-init-pipeline, and a portable, stack-agnostic team of agents adapts to your project — spec-driven, TDD-first, token-frugal.
  image:
    src: /cohorte-avatar-512.png
    alt: Cohorte
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Why not just ask your agent?
      link: /guide/why-cohorte
    - theme: alt
      text: GitHub
      link: https://github.com/TheBidouilleAgency/cohorte

features:
  - icon: 🧭
    title: One profile drives everything
    details: /cohorte-init-pipeline detects your stack, interviews the gaps, and writes PIPELINE.md — the single machine-readable profile every command, agent, and hook reads. The core stays generic; your facts live in one place.
  - icon: 🤖
    title: One agent per surface, in parallel
    details: /cohorte-build authors a frozen contract, then dispatches one stateless implementer per code surface concurrently — TDD-first, each owning exactly one tree, syncing only through the contract.
  - icon: 🪙
    title: Token-frugal by design
    details: Deterministic preflight aborts before spawning agents on red code. Quiet commands, staged diffs, capped reports, baked conventions, byte-stable prompts for cache hits, /clear-safe at every boundary.
  - icon: 🛡️
    title: Guard-railed autonomy
    details: A profile-driven PreToolUse gate hard-denies destructive commands, confirm-gates the risky ones (branch-aware), and enforces a preflight phase gate — for every agent, including workflow subagents.
  - icon: 🖥️
    title: Readable without an agent
    details: cohorte doctor, specs and metrics report a project's health, board and cost straight from the shell — doctor exits 1 on any bad check, so it drops into CI as-is.
---

<div align="center">
  <img src="/demo-cli.gif" alt="cohorte doctor reporting a green pipeline, the spec board, and the gate denying a chained destructive command" width="760">
</div>

<p align="center"><sub><code>cohorte doctor</code> · the spec board · the gate refusing a hard-denied command chained behind a benign one.<br>
Recorded from the real CLI by <code>scripts/demo/record-cli.sh</code> — no output is hand-edited.</sub></p>

## Why a pipeline at all

Your agent is already good at the first prompt of a feature. It gets worse at every one after —
because what it knows lives in a conversation, and a conversation degrades. Cohorte is the set of
constraints that stop that: **decisions frozen to disk** (not remembered), a **contract agreed
before either surface is written**, **one owner per tree**, a **blocking hook** on destructive
commands, and a **reviewer that never saw the conversation that produced the code**.

→ [Why not just ask your agent?](/guide/why-cohorte) — the seven failures it removes, and the four
cases where you shouldn't use it.

## The loop, end to end

```
/cohorte-brainstorm   →  a persona panel pressure-tests the idea
/cohorte-spec         →  the frozen spec + contract — the single source of truth
/cohorte-build <id>   →  one implementer per surface, in parallel
/cohorte-review <id>  →  one reviewer per touched surface, adversarially cross-checked
/cohorte-fix <id>     →  the findings applied, surface by surface
/cohorte-ship <id>    →  commit, push, PR, CI watch — the one human-confirmed gate
```

Three moments of human attention per feature: the brainstorm, the spec freeze, and the ship
confirmation. Everything in between runs itself — and every stage hands off through files on disk,
so `/clear` between commands is always safe.

## Install in one line

```sh
npm i -g cohorte                # once, per machine
cohorte install --global        # one shared core for every repo on this machine
# then, inside your project, in Claude Code:
/cohorte-init-pipeline
```

See [Getting started](/guide/getting-started) for per-project installs, Windows, and what gets
generated.
