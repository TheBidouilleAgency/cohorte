# Parcours de travail

## 1. Découvrir et cadrer

Dans le dépôt cible, `cohorte init .` crée le profil local. Relisez-le avec `cohorte profile show`, corrigez-le avec `cohorte profile edit`, puis utilisez `cohorte intake` pour trier une demande ou `cohorte brainstorm` pour explorer une idée. `cohorte status` affiche les fonctionnalités, runs et décisions en attente du projet courant.

Une commande de brainstorm peut aussi être entièrement explicite :

```bash
cohorte --json brainstorm mon-projet \
  --feature-id export --idea 'Exporter un run de façon sûre' \
  --answer 'Conserver les données localement' --live
```

Le brief contient les objections et questions bloquantes. Répondez à ces questions avant de définir les critères d’acceptation.

## 2. Préparer et geler une spec

La CLI ne transforme pas encore automatiquement un brief en brouillon de spec. Préparez le fichier de spec au format attendu par le moteur, puis demandez et appliquez l’approbation de son contenu exact :

```bash
cohorte --json spec-freeze-request draft.json \
  --profile project.json --repo /chemin/vers/projet
cohorte --json approve REQUEST_ID
cohorte --json spec-freeze draft.json \
  --profile project.json --repo /chemin/vers/projet \
  --decision-id DECISION_ID --output frozen.json
```

`examples/g1/spec.json` et `examples/g1/profile.json` donnent un exemple technique dans le dépôt Cohorte. Le gel refuse un brouillon incomplet ou une décision liée à un autre hash, profil ou ensemble de références.

## 3. Construire et contrôler

Après le gel, lancez le workflow dans un dépôt de test ou sur une branche adaptée :

```bash
cohorte --json loop frozen.json \
  --profile project.json --repo /chemin/vers/projet \
  --worktrees /chemin/vers/worktrees --run-id export-1 --live
```

`loop` crée une branche et un worktree isolés, exécute le build, les checks et la revue. Il ne publie rien à cette étape. `fleet` accepte plusieurs specs gelées et planifie les fonctionnalités selon leurs zones d’écriture et dépendances.

En cas d’interruption, `cohorte --json resume RUN_ID --live` reprend le run journalisé. `pause RUN_ID` et `cancel RUN_ID` prennent effet à la prochaine frontière de phase, après le tour fournisseur actif.

## 4. Livrer

La livraison dispose d’une approbation séparée :

```bash
cohorte --json approve REQUEST_ID
cohorte --json ship RUN_ID --live
cohorte --json delivery-status RUN_ID --live --watch
```

`ship` revérifie le candidat et la base distante, crée un commit, pousse sans force et confirme la PR GitHub ou MR GitLab. Il ne merge ni ne déploie. L’intégration de notes de release dans la description est optionnelle.

## Autres parcours

`patch-spec` et `patch` encadrent un correctif avec reproduction et régression ; `audit`, `refactor`, `retro` et `align-ds-*` servent à la maintenance. Leurs entrées restent aujourd’hui explicites. La [référence CLI](/reference/cli) donne leurs paramètres, et le [README du dépôt](https://github.com/TheBidouilleAgency/cohorte#readme) contient des exemples détaillés.

## Limites actuelles

- Le guidage s’arrête après `init`, `profile`, `intake`, `status` et `brainstorm`. La préparation de spec, le lancement et la maintenance nécessitent des fichiers, chemins et identifiants explicites.
- La découverte du profil ne peut pas déduire seule l’ownership, les migrations, les sources de design ou les conventions d’un monorepo.
- Les preuves d’intégration live dépendent des comptes et services disponibles. Un test local ou une CI verte ne qualifie pas automatiquement toutes les combinaisons de fournisseurs et plateformes. Consultez la [matrice de qualification](/qualification/README).
