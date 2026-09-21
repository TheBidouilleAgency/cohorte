# Cohorte

Cohorte V3 est un orchestrateur durable de pipelines multi-agents, construit autour de Pi et d'un état SQLite. Il transforme une spécification validée en run observable, reprend les runs interrompus et protège chaque effet par des contrats typés, une politique de sécurité et un journal idempotent.

[Documentation complète](https://thebidouilleagency.github.io/cohorte/) · [Spécification V3](docs/v3/SPEC.md) · [Design](docs/v3/DESIGN.md) · [Référence CLI](docs/v3/CLI.md)

## Installation

Prérequis : Node `24.16.0` minimum supporté et pnpm `12.4.2` pour contribuer au dépôt. Pour utiliser la CLI publiée :

```sh
npm install -g cohorte
cohorte --version
```

Dans un projet :

```sh
cohorte init
cohorte doctor
cohorte discover --json
cohorte config validate
```

`cohorte init` crée `.cohorte/`. Les fichiers de configuration générés peuvent être réconciliés avec `cohorte reconcile --plan`, puis `cohorte reconcile --apply`. L'état d'exécution reste local et n'a pas vocation à être versionné.

## Workflow V3

Le workflow est piloté par la CLI ; il n'exige pas un runtime V2 ni des slash commands :

```sh
cohorte brainstorm "Ajouter une fonctionnalité"
cohorte spec validate <feature-id>
cohorte spec freeze <feature-id>
cohorte run <feature-id> --detach --json
cohorte status <run-id> --json
cohorte tail <run-id>
cohorte review <run-id>
cohorte fix <run-id>
cohorte ship <run-id>
```

Pour un workflow complet borné :

```sh
cohorte loop <feature-id>
```

Les commandes `build`, `audit`, `refactor`, `fleet`, `retro`, `align-ds`, `intake` et `patch` couvrent les variantes de développement. Les commandes `pause`, `resume`, `cancel`, `retry`, `approve`, `deny`, `inspect`, `diff`, `logs`, `shutdown` et `gc` administrent les runs et leur état durable.

## Obsidian

Le tableau Kanban Obsidian est optionnel et se connecte explicitement au projet :

```sh
cohorte obsidian create <vault-root> <board-path>
cohorte obsidian connect <vault-root> <board-path>
cohorte obsidian status
cohorte obsidian move <feature-id> <column>
```

La connexion déplace les cartes lors des transitions prévues du workflow ; elle ne copie pas le vault dans le dépôt et ne lit que le fichier de tableau configuré.

## Providers, modèles et sécurité

```sh
cohorte auth login
cohorte auth status
cohorte providers list
cohorte providers test
cohorte models list
cohorte policy explain -- <argv>
cohorte doctor --json
```

Pi est le runtime de référence de V3. Le runtime fake reste disponible pour les tests hors ligne et les smoke tests. Aucun fallback automatique ne change de provider pendant un run : le snapshot épingle le bundle, les prompts, la configuration et le runtime utilisés.

Chaque erreur affiche un code stable, son impact et l'action corrective. Les codes de contrôle sont `0` (terminé), `2` (usage), `3` (rejeté), `4` (accepté mais encore en attente) et `16` (annulé) ; les erreurs de run utilisent les classes documentées dans [`docs/v3/reference/exit-codes.md`](docs/v3/reference/exit-codes.md).

## Migration depuis V2

Le runtime et les fichiers V2 ne sont plus présents dans le dépôt. La compatibilité fonctionnelle est couverte par les tests V3 ; l'importeur reste disponible pour convertir un ancien projet :

```sh
cohorte init --export-v2 <bundle-dir>
cohorte init --from-v2 <bundle-dir> --yes
cohorte migrate --rollback <report-id>
```

Voir [`docs/v3/MIGRATION.md`](docs/v3/MIGRATION.md) pour les garanties, les sauvegardes et le rollback. Cette procédure ne transforme jamais un ancien run en run V3 : un run V3 démarre avec son propre snapshot et son propre état SQLite.

## Contribuer

```sh
pnpm install --frozen-lockfile
pnpm ci:typecheck
pnpm ci:unit
pnpm ci:integration
pnpm ci:acceptance
```

La suite complète locale est `pnpm ci:local`. La CI vérifie lint, types, unités, intégration, schémas, migrations, packaging, sécurité, crash recovery, dogfood, acceptance et compatibilité Pi. Consultez [`docs/guide/maintainers.md`](docs/guide/maintainers.md) et [`docs/v3/workspace.md`](docs/v3/workspace.md) pour l'architecture et les procédures de release.

Licence AGPL-3.0.
