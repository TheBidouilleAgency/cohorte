# Guide de maintenance et de release

Ce document décrit le fonctionnement de Cohorte V3 pour les personnes qui maintiennent le dépôt, ajoutent une
fonctionnalité ou publient une version. Il complète la [spécification technique V3](https://github.com/TheBidouilleAgency/cohorte/tree/main/docs/v3) avec
les gestes quotidiens et les procédures opératoires.

## 1. Périmètre et sources de vérité

Cohorte V3 est le monorepo racine. Le runtime V2 a été retiré ; seule la voie d'import `init --export-v2` / `init --from-v2` reste maintenue pour les projets historiques.

Les sources de vérité sont :

| Sujet | Fichier ou commande |
|---|---|
| Architecture et décisions | [`docs/v3/DESIGN.md`](https://github.com/TheBidouilleAgency/cohorte/blob/main/docs/v3/DESIGN.md), [`docs/v3/SPEC.md`](https://github.com/TheBidouilleAgency/cohorte/blob/main/docs/v3/SPEC.md) |
| Plan et unités | [`docs/v3/PLAN.md`](https://github.com/TheBidouilleAgency/cohorte/blob/main/docs/v3/PLAN.md), [`docs/v3/plan.json`](https://github.com/TheBidouilleAgency/cohorte/blob/main/docs/v3/plan.json) |
| Contrats JSON | `packages/*/src/contract/**`, puis `schemas/**` générés |
| Catalogue protocolaire | `packages/protocol`, `scripts/gen-protocol-docs.ts` |
| Dépendances et scripts | `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml` |
| CI et release | `.github/workflows/ci.yml`, `.github/workflows/publish.yml` |
| État et configuration projet | `.cohorte/` (local au projet, généralement non versionné pour l'état) |

Ne modifiez pas un schéma généré ou un fichier de `tsconfig.checks/` à la main : modifiez sa source puis lancez le
générateur associé.

## 2. Vue d'ensemble de l'architecture

```text
CLI (apps/cli)
  ├─ commandes / observers / controllers
  └─ composition root (compose/engine.ts)
       ├─ config + project model
       ├─ RunEngine + state machine
       ├─ SQLite StateStore + EffectJournal + EventWriter
       ├─ PolicyEngine + ToolHost + Executor
       ├─ Supervisor ── RuntimeProvider (fake ou Pi)
       ├─ WorktreeService ── GitPort
       └─ phase executors : PREFLIGHT → BUILD → TEST → REVIEW → FIX → SHIP

Contrats et données partagées :
  base / protocol / runtime-contract / persistence / security / tools / git
```

### Cycle d'un run

1. `cohorte run` valide la configuration, crée le run et épingle le snapshot de l'installation, des prompts et du
   runtime.
2. Le host détaché acquiert le lease, récupère les commandes de l'inbox et fait évoluer l'état par la table de
   transitions. Le prompt ne décide jamais du workflow.
3. Chaque agent reçoit un `SpawnRequest` avec une incarnation, un workspace et un budget. Le runtime ne modifie
   jamais directement le dépôt : les appels passent par `ToolHost` et `PolicyEngine`.
4. Les outils traversent les contrôles de schéma, capacité, chemins, commandes et budgets avant l'effet. Les effets
   écrivent une intention journalisée et possèdent une clé idempotente.
5. BUILD travaille dans des slots externes au dépôt. TEST exécute les checks sur l'arbre d'intégration et lie le
   résultat à un digest. REVIEW produit des `AgentOutput`; FIX est relancé si les findings l'exigent.
6. Les commits sont créés par Cohorte, puis fusionnés dans la branche d'intégration. Le checkout humain reste
   inchangé jusqu'à l'action de livraison prévue.
7. Une reprise réutilise le snapshot et réconcilie les effets ouverts ; elle ne bascule pas silencieusement vers une
   nouvelle version du runtime ou des prompts.

### Invariants à préserver

- Une seule identité de propriétaire par surface et par chemin.
- Aucun outil agent ne contourne `PolicyEngine`, `PathResolver` ou `EffectJournal`.
- Un effet avec la même clé ne s'exécute pas deux fois.
- Un run actif reste lié à son snapshot et à son runtime pin.
- Les événements durables sont chaînés, séquencés et validables par le schéma.
- Les worktrees sont sous `~/.cohorte/worktrees`, jamais dans le dépôt utilisateur.
- Les clés qui desserrent la sécurité nécessitent un trust explicite.

## 3. Installer le dépôt de développement

Prérequis V3 : Node `24.16.0` minimum supporté, pnpm `12.4.2` et Git. Le runtime Pi est optionnel pour le
développement courant ; le runtime fake permet de travailler hors ligne.

```sh
pnpm install --frozen-lockfile
pnpm exec tsc -b
pnpm exec tsc -p tsconfig.tests.json
```

Pour vérifier l'installation complète sans lancer de provider réel :

```sh
pnpm ci:local
```

Cette commande exécute les mêmes commandes que les jobs CI, dans l'ordre : lint, typecheck, unit,
integration, schema-compat, migrations, packaging, E2E fake, crash, security, dogfood, acceptance et Pi.

## 4. Développement quotidien

### Commandes utiles

```sh
# formatage / statique
pnpm exec biome ci .
node scripts/check-layers.ts
node scripts/check-contract-words.ts
node scripts/check-prompts.ts

# types et tests rapides
pnpm exec tsc -b
pnpm exec tsc -p tsconfig.tests.json
pnpm test

# tests par domaine
pnpm ci:integration
pnpm ci:schema-compat
pnpm ci:migrations
pnpm ci:security
pnpm ci:dogfood
pnpm ci:acceptance

# build isolé et vérifiable
node scripts/build.ts --out .build/dev
node scripts/pack-check.ts .build/dev
```

Ne partagez pas un répertoire de build entre deux jobs. Chaque build doit avoir un dossier `--out` distinct ; les
sorties `.build/` sont immuables pour le job qui les consomme.

### Ajouter ou modifier un package

1. Déclarer le package dans son propre `package.json` et dans `pnpm-workspace.yaml` si nécessaire.
2. Ajouter ses couches et ses exports dans `layers.json` et son barrel `src/index.ts`.
3. Ajouter les contrats dans la couche la plus basse possible ; ne faites pas importer `protocol` ou `persistence`
   depuis `core`.
4. Ajouter les tests sous le suffixe attendu (`.test.ts` ou `.itest.ts`).
5. Régénérer les `tsconfig.checks/` avec `pnpm exec node scripts/gen-unit-checks.ts` si le plan change.
6. Relancer `pnpm ci:local` avant de demander une review.

### Modifier un contrat ou un schéma

Un changement de contrat est une migration, même s'il ne touche qu'un type TypeScript.

1. Modifier la source du contrat et ses tests de conformance.
2. Modifier le catalogue ou la définition TypeBox concernée.
3. Régénérer les schémas :

   ```sh
   pnpm gen:schemas
   node scripts/gen-schemas.ts --check
   node scripts/schema-compat.ts --self
   ```

4. Régénérer la référence protocolaire :

   ```sh
   node scripts/gen-protocol-docs.ts --check
   ```

5. Ajouter une fixture de compatibilité si le document doit rester lisible par une version précédente.
6. Documenter la décision dans `docs/v3/adr/` ou `docs/v3/requests/`.

Ne supprimez pas un champ ou une valeur d'enum sans décider explicitement de la politique de tolérance et de migration.

### Modifier une migration SQLite

Les migrations vivent dans `migrations/` et sont appliquées par le store V3. Une migration doit être :

- monotone et numérotée ;
- idempotente ou protégée par le mécanisme de version du store ;
- testée sur une base ancienne et une base déjà à jour ;
- compatible avec la reprise d'un run interrompu ;
- couverte par `pnpm ci:migrations` et `pnpm ci:schema-compat` si un document change.

Ne modifiez pas silencieusement le schéma initial pour réparer une base existante : ajoutez une migration.

## 5. Dépannage

### Le run reste suspendu ou bloqué

```sh
cohorte status <run-id> --json
cohorte tail <run-id> --json
cohorte inspect <run-id> --snapshot
cohorte doctor --json
```

Lire d'abord `lastError`, `phase`, `runtimePin`, `snapshotDigest` et le dernier événement durable. Ne supprimez pas
la base ou le CAS d'un run actif pour le débloquer.

### Un agent est refusé

Vérifier dans cet ordre :

1. l'outil est-il dans la capacité du plan ?
2. le chemin est-il sous le workspace du slot et dans les globs d'ownership ?
3. le chemin est-il protégé (`.git`, `.cohorte`, secrets) ?
4. la commande correspond-elle à une règle argv autorisée ?
5. le trust du projet autorise-t-il réellement la clé de configuration utilisée ?

Les refus sont intentionnels et doivent rester observables comme `tool.denied`; ne contournez pas la policy dans un
test ou dans le runtime fake.

### Un build packagé ne démarre pas

```sh
node scripts/build.ts --out .build/diagnostic
node scripts/pack-check.ts .build/diagnostic
```

Le build V3 doit fonctionner depuis `.publish`, hors du répertoire source, avec les dépendances runtime liées ou
installées par le pipeline de packaging. Vérifier également le manifest de bundle, le hash des assets et le runtime
pin avant de modifier le bundler.

### Un test dépasse le timeout

Les tests de génération, schema-compat et packaging peuvent lancer des sous-processus. Reproduire d'abord le test
isolément avec `--testTimeout=30000`, puis sous `pnpm ci:unit`. N'augmentez pas un timeout E2E sans comprendre si le
run est réellement vivant ; utilisez l'état SQLite et le journal pour distinguer lenteur, deadlock et panne.

## 6. Pull requests et intégration

Une PR V3 doit :

- expliquer le contrat ou l'invariant modifié ;
- inclure les tests du domaine touché ;
- mettre à jour les schémas, docs ou ADR concernés ;
- passer `pnpm ci:local` ou documenter précisément le job impossible à exécuter ;
- être rebasée sur `origin/main` avant merge si GitHub signale `CONFLICTING` ;
- garder `.cohorte/`, `.build/`, `dist-types/` et les credentials hors du commit.

Pour résoudre une PR de migration, vérifier le diff par rapport à `origin/main` et conserver le runtime V3 à la racine. Après résolution :

```sh
git fetch origin main
git rebase origin/main
git diff --check
pnpm exec biome ci .
pnpm exec tsc -p tsconfig.tests.json --noEmit
git push --force-with-lease origin feat/<branch>
```

## 7. Release V3

### Avant le merge sur `main`

1. Vérifier que la PR est mergeable et que tous les jobs obligatoires sont verts.
2. Vérifier la version dans `apps/cli/package.json` et l'entrée correspondante dans `CHANGELOG.md`.
3. Vérifier que `node scripts/build.ts --out .build/release` et `node scripts/pack-check.ts .build/release` passent.
4. Vérifier `node scripts/gen-protocol-docs.ts --check` et `node scripts/schema-compat.ts --self`.
5. Exécuter le smoke provider uniquement si un mainteneur l'a budgété :

   ```sh
   COHORTE_LIVE=1 pnpm test:live
   ```

6. Vérifier le [runbook humain de release](https://github.com/TheBidouilleAgency/cohorte/blob/main/docs/v3/runbooks/release.md).

### Ce qui se passe après le merge

`.github/workflows/publish.yml` se déclenche sur `main` et appelle d'abord le workflow CI réutilisable. La publication
ne démarre que si cette gate passe.

Le job de version lit `apps/cli/package.json`. Si `cohorte@<version>` existe déjà sur npm, la publication est
ignorée ; sinon le workflow :

1. installe les dépendances avec le lockfile ;
2. construit le bundle dans `.build/release` ;
3. publie `.build/release/.publish` avec provenance npm/OIDC ;
4. crée et pousse le tag `v<version>` ;
5. crée la GitHub release si elle n'existe pas.

La publication utilise l'environnement GitHub `npm-publish`. Aucun token ne doit être ajouté dans le dépôt ou dans
le workflow.

### Rollback

Une release déjà publiée ne doit pas être réécrite. Pour une régression :

- arrêter la promotion de la version suivante ;
- corriger sur une nouvelle branche ;
- publier une nouvelle version patch ;
- vérifier le tag et la release GitHub ;
- documenter l'incident et la procédure de migration si l'état persistant est concerné.

Pour un problème de run en production, le snapshot du run est prioritaire : ne remplacez pas son installation ou ses
prompts sous ses pieds. Installez la version corrigée côte à côte et reprenez uniquement selon le diagnostic du
runtime pin et du rapport de reprise.

## 8. Sécurité et données sensibles

- Ne lisez, n'affichez et ne copiez jamais `~/.pi/agent/auth.json`, `~/.codex` ou une clé provider.
- Les logs et fixtures live ne doivent contenir que des noms d'en-têtes, erreurs assainies et métadonnées non secrètes.
- Les clés de configuration qui desserrent une policy nécessitent une confiance explicite ; ne désactivez pas cette
  vérification pour rendre un test vert.
- Les worktrees, CAS, SQLite et logs peuvent contenir du code projet : vérifiez leur emplacement avant tout partage.
- Les commandes destructrices doivent rester derrière `PolicyEngine` et les profils de sandbox prévus.

## 9. Checklist courte

```text
[ ] contrat / invariant identifié
[ ] tests unitaires + intégration ajoutés
[ ] schémas et docs générés
[ ] pnpm ci:local vert
[ ] build immutable + pack-check verts
[ ] PR rebasée sur origin/main
[ ] version + CHANGELOG vérifiés
[ ] live smoke exécuté seulement avec budget humain
[ ] tag / npm / GitHub release vérifiés
[ ] aucune donnée sensible, .cohorte ou build local commitée
```
