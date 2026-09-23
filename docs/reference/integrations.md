# Intégrations

Les intégrations se configurent dans le profil du projet. Une entrée déclarée ne suffit pas : vérifiez aussi l’accès réel au service ou à la donnée.

## Recherche de contexte

`integrations.retrieval.provider` peut être `none`, `serena` ou `graphify`. Serena attend l’exécutable MCP installé. Graphify-Labs demande l’extra `graphify` et un graphe préconstruit dans `<repo>/graphify-out/graph.json`. Par exemple, la création explicite d’un graphe de code utilise `graphify extract <repo> --code-only --no-cluster --out <repo>`.

Quand le fournisseur est indisponible, la commande échoue visiblement. Le repli sur les fichiers n’a lieu que si `integrations.retrieval.fallback_to_files` vaut `true`. `cohorte retrieve 'question' --profile profil.json` teste une recherche.

## Design Figma

Renseignez `integrations.design.source` avec une URL de fichier ou de nœud Figma, et activez l’intégration. Un snapshot live requiert un jeton local `FIGMA_ACCESS_TOKEN` avec le scope `file_content:read`. Ne stockez pas ce jeton dans le profil. `design-snapshot` produit un instantané ; `align-ds-plan`, `align-ds-request` et `align-ds` encadrent son application au code.

## Kanban et notes de release

`kanban-project` relie un état de fonctionnalité au board configuré dans le profil. `integrations.release_notes.enabled` ajoute une section à la description de la PR/MR lors de `ship` ; le titre et le template sont configurables. Le template accepte `{title}`, `{problem}` et `{acceptance}`.

## Protocole local et François

`cohorte service start` démarre un service local sans port réseau. Les clients utilisent le protocole décrit dans la [référence technique](/PROTOCOL). L’existence du protocole ne prouve pas qu’une version donnée de François ait activé toutes les surfaces de l’interface.
