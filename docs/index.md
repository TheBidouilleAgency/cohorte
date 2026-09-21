---
layout: home

hero:
  name: Cohorte
  text: Durable multi-agent pipeline for Pi
  tagline: Freeze a contract, run it through Pi, observe every transition, and resume safely from SQLite-backed state.
  image:
    src: /cohorte-avatar-512.png
    alt: Cohorte
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: CLI reference
      link: https://github.com/TheBidouilleAgency/cohorte/blob/main/docs/v3/CLI.md
    - theme: alt
      text: GitHub
      link: https://github.com/TheBidouilleAgency/cohorte

features:
  - icon: 🧭
    title: A frozen contract drives the run
    details: cohorte spec validate and spec freeze turn a feature into the durable input for every Pi phase.
  - icon: 🤖
    title: Native Pi orchestration
    details: Typed phase contracts, surface ownership and a detached run host keep implementation, tests and review coordinated.
  - icon: 💾
    title: Durable by construction
    details: SQLite state, snapshots and idempotent effect keys make pause, resume and crash recovery explicit.
  - icon: 🛡️
    title: Policy before prompts
    details: Commands and paths are decided in typed code and rechecked at tool use; prompts never grant permissions.
  - icon: 🔎
    title: Observable from the shell
    details: cohorte status, tail, logs and inspect expose the same durable state to humans and automation.
---

## The V3 cycle

```text
cohorte brainstorm "..." → draft feature input
cohorte spec validate <id> → validate the human spec
cohorte spec freeze <id> → freeze the contract
cohorte run <id> → start an observable Pi run
cohorte review <run> → review the integrated result
cohorte ship <run> → resolve the ship approval
```

Every run is durable and observable. Use `cohorte status`, `tail`, `logs` and `inspect` from a second terminal; use `resume` after a suspended or recovered host.

## Install

```sh
npm i -g cohorte
cohorte init
cohorte doctor
```

See [Getting started](/guide/getting-started) for the project model and [the V3 CLI reference](https://github.com/TheBidouilleAgency/cohorte/blob/main/docs/v3/CLI.md) for the complete command surface.
