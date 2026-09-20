# Cohorte V3 — plan de migration

**Statut :** gelé pour V3.0  
**Portée :** migration d'un projet déjà piloté par Cohorte V2 vers V3, puis migrations d'état entre versions V3.  
**Décision liée :** [ADR-0014](adr/0014-v2-compatibility-surface.md)

## 1. Décision de version

V3.0 est une rupture contrôlée : il n'exécute pas le runtime V2 et ne transforme pas
automatiquement un projet V2. L'importeur V2 est livré en V3.1 sous la forme de
`cohorte-v2 export` / `cohorte init --from-v2`.

Cela donne deux chemins explicites :

| Situation | Commande | Résultat |
|---|---|---|
| Nouveau projet | `cohorte init` | configuration V3 neuve |
| Projet V2 à conserver tel quel | aucune migration | V2 continue avec l'installation V2 |
| Projet V2 à reprendre dans V3.1 | `cohorte init --export-v2 <bundle>` puis `cohorte init --from-v2 <bundle>` | bundle inspectable, import approuvé |
| Base d'état V3 avec migrations en attente | `cohorte migrate --check` puis `cohorte migrate --apply` | schéma V3 suivant, après backup |

V3.0 doit toutefois reconnaître proprement les traces V2 et expliquer l'action
attendue. Il ne doit ni les écraser, ni les interpréter comme une base V3.

## 2. Ce qui est migré et ce qui ne l'est pas

| Source V2 | V3.0 | V3.1 importer |
|---|---|---|
| `PIPELINE.md`, profils et `cohorte.config.yaml` | détection et diagnostic seulement | import vers `.cohorte/manifest.yaml`, `config.yaml`, `ownership.yaml` |
| `specs/*.md` et leurs statuts | laissés intacts | import en spécifications V3 avec provenance `v2` |
| `specs/reports/`, métriques, logs | laissés intacts | attachés comme artefacts historiques, jamais comme événements durables |
| `.cohorte/`, `.claude/`, états runtime et `gate-config.json` | jamais lus comme état V3 | archivés dans le bundle, sans être exécutés |
| cartes Kanban externes | aucune écriture | export des liens et statuts, sans synchronisation automatique |
| runs, leases, transcripts et worktrees V2 | non migrés | non migrés ; un run V3 démarre à `IDLE` |
| secrets, credentials, fichiers de session | refusés | exclus du bundle et signalés comme non exportables |

Les règles V2 sans équivalent V3 sont conservées dans `warnings[]` avec leur
chemin et une action de remplacement. Une perte silencieuse est une erreur de
validation, pas un warning.

## 3. Contrat du bundle d'import

V3.1 produit un bundle portable et non exécutable, par exemple un répertoire
`cohorte-v2-export-<id>` (l'archivage externe est optionnel), contenant :

```text
manifest.json       # format, version source, projet, inventaire, hashes
config.yaml         # proposition V3, jamais la config active
ownership.yaml      # proposition V3
specs/              # copies des specs V2 retenues
history/            # rapports et métriques explicitement sélectionnés
warnings.json       # pertes, ambiguïtés et actions requises
checksums.sha256
```

Contraintes du format :

1. `manifest.json` indique `format: "cohorte-v2-export"`, `sourceVersion`,
   `createdAt`, `projectRootDigest`, la liste des fichiers et leur SHA-256.
2. Les chemins sont relatifs, normalisés, sans `..`, sans lien symbolique et
   sans fichier hors racine du projet.
3. Les fichiers sensibles sont exclus par défaut ; aucun contenu de credential
   n'est copié, même s'il est référencé par une configuration V2.
4. L'import est déterministe : même arbre source + mêmes options = même contenu
   hors timestamp et identifiant d'export.
5. Le bundle est vérifié avant lecture et ne peut écrire dans le projet tant que
   l'utilisateur n'a pas confirmé le diff proposé.

Le schéma du bundle est réservé dans `project-model/src/import/` dès V3.0 ; son
implémentation et sa CLI appartiennent à V3.1.

## 4. Procédure V3.1

### Phase A — préflight sans écriture

1. Vérifier que la racine est un dépôt Git propre ou arrêter avec la liste des
   changements non committés.
2. Détecter les marqueurs V2 (`PIPELINE.md`, profil, `cohorte.config.yaml`,
   `.cohorte`, `.claude`, `gate-config.json`, `specs/`).
3. Refuser les chemins ambigus, les liens symboliques sortants et les fichiers
   sensibles ; produire `warnings.json`.
4. Écrire le bundle dans un répertoire temporaire hors du projet, puis vérifier
   ses checksums.

### Phase B — proposition

1. Mapper les champs V2 connus vers les schémas V3.
2. Générer une nouvelle proposition sous `.cohorte/import-preview/<id>/`.
3. Afficher les ajouts, modifications, champs ignorés et conflits.
4. Exiger une confirmation explicite si une valeur V2 n'a pas d'équivalent ou
   si un fichier V3 existe déjà.

### Phase C — application atomique

1. Prendre le verrou projet V3.
2. Faire une sauvegarde de `.cohorte/` et des fichiers qui vont être remplacés.
3. Vérifier que le digest du projet n'a pas changé depuis la phase A.
4. Installer les fichiers V3 proposés dans une transaction de fichiers : écriture
   temporaire, fsync, rename ; aucun fichier V2 n'est supprimé.
5. Créer un rapport signé par les hashes : source, destination, warnings, backup,
   commande et version de l'importeur.
6. Initialiser un nouveau run V3 uniquement à la demande ; aucun run V2 ne devient
   artificiellement `COMPLETED`, `PAUSED` ou `RESUMABLE`.

## 5. Rollback et reprise

Avant toute application, l'importeur crée un backup horodaté hors de la racine
du projet. Tant que le rapport n'est pas `applied`, la commande est sans effet.

- échec avant le rename : suppression des temporaires uniquement ;
- échec après un rename : restauration depuis le backup, puis vérification des
  checksums ;
- échec de vérification : état `rollback-required`, aucune nouvelle tentative
  automatique ;
- rollback manuel : `cohorte migrate --rollback <report-id>` en V3.1, avec le
  backup exact et le digest attendu ;
- les fichiers V2 d'origine ne sont jamais supprimés par l'importeur.

Pour les migrations d'état V3, la règle reste celle de `StateStore.migrate` :
`--check` d'abord, backup obligatoire, verrou projet exclusif, migrations
numérotées et sha256-pinnées, puis `--apply`. Une version plus récente qui ne
connaît pas le schéma refuse `status` et indique exactement `cohorte migrate
--apply`; elle ne réécrit ni ne supprime un run.

## 6. Critères d'acceptation

- V3.0 sur un projet V2 ne modifie aucun fichier et explique la procédure V3.1.
- Un export exclut les secrets, refuse les traversals et est vérifiable hors ligne.
- Un import avec conflit ne touche pas au projet et produit un diff lisible.
- Une interruption à chaque étape de l'application est récupérable par le backup.
- Les specs V2 importées gardent leur contenu et leur provenance ; les statuts
  non mappés deviennent des warnings bloquants.
- Aucun run, lease, transcript ou worktree V2 n'est présenté comme un run V3.
- Une migration `0002` de la base V3 est testée avec `check`, backup, `apply`,
  rollback de test et lecture d'un ancien run.

## 7. Découpage d'implémentation

| Version | Travail | Preuve |
|---|---|---|
| V3.0 / W0 | réserver le schéma d'import, documenter la détection et conserver V2 dans `legacy/v2/` | test de non-écriture + diagnostic |
| V3.0 / W1 + W5 | moteur de migrations SQLite, backups, refus de schéma incompatible | `U1.01`, `U5.07`, D5 |
| V3.1 | export V2, mapping config/specs, preview, application atomique, rollback | suite `tests/integration/import-v2/**` |
| V3.1 | retirer éventuellement `legacy/v2/` après adoption de l'importeur | décision de release, jamais automatique |
