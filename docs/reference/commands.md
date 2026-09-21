# Commandes V3

La CLI V3 expose une commande durable par action. Utilisez `cohorte --help` pour la syntaxe exacte installée.

## Projet et spécifications

```sh
cohorte init [path]
cohorte doctor [--json]
cohorte discover [--json]
cohorte config get|set|validate|trust
cohorte reconcile --plan|--apply
cohorte spec validate <feature-id>
cohorte spec freeze <feature-id>
```

## Workflow

```sh
cohorte intake [text]
cohorte brainstorm [idea]
cohorte patch [bug]
cohorte build <feature-id>
cohorte run <feature-id> [--detach] [--json]
cohorte loop <feature-id>
cohorte review <run-id>
cohorte fix <run-id>
cohorte ship <run-id>
```

Variantes : `audit`, `refactor`, `fleet`, `retro`, `align-ds` et `update-pipeline`.

## Observation et contrôle

```sh
cohorte status [run-id] [--json]
cohorte tail <run-id>
cohorte logs <run-id>
cohorte inspect <run-id> --agent|--context|--approval|--effect|--snapshot|--locks|--diff|--artifact
cohorte diff <run-id>
cohorte pause <run-id>
cohorte resume <run-id>
cohorte cancel <run-id>
cohorte retry <run-id>
cohorte approve <run-id>
cohorte deny <run-id>
cohorte shutdown <run-id>
```

## Providers et intégrations

```sh
cohorte auth login|status|logout
cohorte providers list|test
cohorte models list
cohorte policy explain -- <argv>
cohorte obsidian create <vault-root> <board-path>
cohorte obsidian connect <vault-root> <board-path>
cohorte obsidian status
cohorte obsidian move <feature-id> <column>
```

`cohorte init --export-v2` et `cohorte init --from-v2` sont des commandes de migration de données, pas un runtime V2. Le runtime V2 a été retiré du dépôt.
