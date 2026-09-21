# Getting started

## Prerequisites

- Node `24.16.0` minimum supporté pour la CLI et pnpm `12.4.2` pour contribuer au monorepo.
- Un provider Pi configuré pour les runs réels. Le runtime fake permet les tests hors ligne.
- `gh` est optionnel pour le flux de livraison.

## Installer et initialiser

```sh
npm install -g cohorte
cd mon-projet
cohorte init
cohorte doctor
cohorte config validate
```

`cohorte init` crée `.cohorte/` et ne remplace pas les champs humains. Utilisez `cohorte reconcile --plan` pour inspecter le drift, puis `cohorte reconcile --apply` après revue.

## Premier workflow

```sh
cohorte brainstorm "Ajouter ..."
cohorte spec validate <feature-id>
cohorte spec freeze <feature-id>
cohorte run <feature-id> --detach --json
cohorte status <run-id> --json
cohorte tail <run-id>
cohorte review <run-id>
cohorte ship <run-id>
```

Pour déléguer les tours build → review → fix dans les limites du projet :

```sh
cohorte loop <feature-id>
```

Les transitions et les effets sont durables. Un `Ctrl-C` détache l'observateur ; il ne tue pas le run. Reprenez-le avec `cohorte resume <run-id>` et inspectez un incident avec `cohorte logs` ou `cohorte inspect`.

## Obsidian (optionnel)

```sh
cohorte obsidian create /chemin/vers/vault Tasks.md
cohorte obsidian connect /chemin/vers/vault Tasks.md
cohorte obsidian status
```

Le vault reste externe au projet. Cohorte synchronise le tableau configuré, pas l'ensemble du vault.

## Vérifier une installation

```sh
cohorte discover --json
cohorte providers list
cohorte models list
cohorte doctor --json
```

Consultez la [référence CLI V3](https://github.com/TheBidouilleAgency/cohorte/blob/main/docs/v3/CLI.md) et la [spécification](https://github.com/TheBidouilleAgency/cohorte/blob/main/docs/v3/SPEC.md) pour le détail des contrats.
