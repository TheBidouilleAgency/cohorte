# Intégrations

Les intégrations se configurent dans le profil du projet. Une entrée déclarée ne suffit pas : vérifiez aussi l’accès réel au service ou à la donnée.

## Recherche de contexte

`integrations.retrieval.provider` peut être `none`, `serena` ou `graphify`. Serena attend l’exécutable MCP installé. Graphify-Labs demande l’extra `graphify` et un graphe préconstruit dans `<repo>/graphify-out/graph.json`. Par exemple, la création explicite d’un graphe de code utilise `graphify extract <repo> --code-only --no-cluster --out <repo>`.

Quand le fournisseur est indisponible, la commande échoue visiblement. Le repli sur les fichiers n’a lieu que si `integrations.retrieval.fallback_to_files` vaut `true`. `cohorte retrieve 'question' --profile profil.json` teste une recherche.

## Design Figma

Renseignez `integrations.design.source` avec une URL de fichier ou de nœud Figma, et activez l’intégration. Un snapshot live requiert un jeton local `FIGMA_ACCESS_TOKEN` avec le scope `file_content:read`. Ne stockez pas ce jeton dans le profil. `design-snapshot` produit un instantané ; `align-ds-plan`, `align-ds-request` et `align-ds` encadrent son application au code.

## Kanban et notes de release

Avec `integrations.kanban.enabled: true` et `read_only: false`, Cohorte déplace la carte Obsidian après chaque étape enregistrée : `Ideas` → `Brainstorm` → `Spec` → `Ready to build` → `Building` → `Review` → `Fix` ou `Ship` → `Shipped` après ouverture de la PR/MR. Les sous-notes suivent la carte et le numéro de PR est ajouté à la fin. Les noms de colonnes peuvent être adaptés par `columns.ideas`, `columns.brainstorm`, `columns.spec`, `columns.ready`, `columns.building`, `columns.review`, `columns.fix`, `columns.ship` et `columns.shipped`. Toutes les colonnes utilisées doivent exister dans le board. Chaque écriture vérifie que le fichier n'a pas changé depuis sa lecture et conserve une sauvegarde dans `.cohorte-backups`.

Si la synchronisation échoue, l'étape Cohorte reste enregistrée. `cohorte kanban-sync FEATURE_ID` indique l'étape à retrouver ; ajoutez `--apply` après avoir corrigé le board. `kanban-project` reste disponible pour une projection explicite. `integrations.release_notes.enabled` ajoute une section à la description de la PR/MR lors de `ship` ; le titre et le template sont configurables. Le template accepte `{title}`, `{problem}` et `{acceptance}`.

Pour consulter les idées sans synchroniser les états, configurez `integrations.kanban` avec `enabled: true`, `provider: obsidian`, `vault_path`, `board_path` et `read_only: true`. `cohorte brainstorm` propose alors les cartes `Idea` ou `Ideas` avec leurs notes ; `columns.ideas` permet de choisir un autre titre de colonne.

## Protocole local et François

`cohorte service start` démarre un service local sans port réseau. Les clients utilisent le protocole décrit dans la [référence technique](/PROTOCOL). L’existence du protocole ne prouve pas qu’une version donnée de François ait activé toutes les surfaces de l’interface.
