# Cohorte V3 CLI

La CLI V3 est la surface publique unique. Elle orchestre des runs durables sur Pi, avec SQLite pour l'état, un journal des effets et des snapshots immuables.

## Cycle principal

```sh
cohorte init
cohorte brainstorm "..."
cohorte spec validate <feature-id>
cohorte spec freeze <feature-id>
cohorte run <feature-id> --detach --json
cohorte status <run-id> --json
cohorte review <run-id>
cohorte fix <run-id>
cohorte ship <run-id>
```

`cohorte loop <feature-id>` enchaîne le cycle durable avec les bornes configurées.

## Commandes

Les commandes exposées par `cohorte --help` sont :

`init`, `doctor`, `discover`, `run`, `loop`, `build`, `intake`, `audit`, `refactor`, `fleet`, `retro`, `align-ds`, `update-pipeline`, `status`, `inspect`, `resume`, `pause`, `cancel`, `shutdown`, `approve`, `deny`, `retry`, `skip`, `logs`, `tail`, `diff`, `review`, `fix`, `ship`, `auth`, `providers`, `models`, `config`, `migrate`, `reconcile`, `spec`, `obsidian`, `policy`, `gc`, `update`, `brainstorm`, `patch`, `run-tool` et `send`.

Sous-commandes : `auth login|status|logout`, `providers list|test`, `models list`, `config get|set|validate|trust`, `spec validate|freeze`, `obsidian create|connect|status|move` et `policy explain`.

## Compatibilité V2

Le runtime V2 a été retiré du dépôt. `init --export-v2` et `init --from-v2` sont conservés uniquement comme importeur de migration ; aucun ancien run n'est repris comme run V3.
