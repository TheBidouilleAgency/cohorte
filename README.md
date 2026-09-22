# Cohorte — premier noyau natif

Prototype en cours, proposé en draft. Le périmètre livré et l’ordre des prochaines étapes (`init`, `intake`, `brainstorm`, `spec`, puis `ship`) sont décrits dans la [feuille de route](docs/ROADMAP.md).

Parcours actuellement disponible : **spec fournie → build → tests → review → fix borné → résultat prêt à examiner**.
TypeScript, XState, SQLite et Codex app-server.

## Démarrer

Prérequis : Node.js 24.16+, Docker actif et **Codex CLI 0.155.1** connecté à un abonnement ChatGPT.
Le binaire est volontairement borné à la version testée. Un changement de version doit passer les tests natifs avant de modifier `CODEX_VERSION`.

```sh
npm ci --ignore-scripts
npm run build
node dist/cli.js doctor
docker pull node:24-alpine
```

`doctor` ne lit ni ne copie les tokens : il demande au client officiel le type de connexion et les modèles disponibles.
Choisir un de ces modèles dans une copie de `examples/config.json`. La connexion doit être `chatgpt` ; les comptes API sont refusés. Le login, le renouvellement et le coffre restent la responsabilité de Codex.

Créer une spec Markdown et une configuration **hors du dépôt cible**, ou les committer dans ce dépôt. Le dépôt cible doit être propre et posséder au moins un commit.

```sh
node dist/cli.js run --repo /chemin/projet --config /chemin/config.json --spec /chemin/tache.md
node dist/cli.js status <run-id> --repo /chemin/projet
node dist/cli.js logs <run-id> --repo /chemin/projet
node dist/cli.js diff <run-id> --repo /chemin/projet
```

Le run affiche immédiatement sa branche et son worktree. L'état est dans `~/.cohorte/<identifiant-projet>/state.sqlite`, hors du worktree. `--state-root /autre/emplacement` permet de changer la racine ; conserver la même option pour consulter le run.
Le checkout d'origine reste intact. Le worktree et sa branche restent disponibles après exécution. Aucun commit, push, merge ou PR n'est automatique.

## Préparer un projet npm

`prepare` construit une image de dépendances depuis un profil réutilisable. Le premier profil livré, `examples/francois.profile.json`, configure les tests de notifications, TypeScript et ESLint de François. Copier ce profil pour changer le périmètre et les commandes d'une autre tâche.

```sh
# Le parent de --out doit exister ; la préparation crée un nouveau dossier.
node dist/cli.js prepare --repo /chemin/francois --profile examples/francois.profile.json --out /tmp/francois-prepared
node dist/cli.js check --repo /chemin/francois --config /tmp/francois-prepared/config.json
node dist/cli.js run --repo /chemin/checkout-propre --config /tmp/francois-prepared/config.json --spec /chemin/correctif.md
```

- `prepare` et `check` ne démarrent aucun agent et ne consomment pas l'abonnement. `check` peut vérifier un checkout modifié ; `run` exige toujours une source propre.
- Version 1 : projet npm autonome avec `package-lock.json` v2/v3, dépendances HTTPS publiques, sans workspaces ni dépendances locales/Git. Pas de montage de credentials npm ni de copie de `.npmrc`. L'installation utilise le réseau pendant la préparation explicite, avec `npm ci --ignore-scripts` ; les paquets nécessitant un postinstall ne sont pas pris en charge.
- Le contexte Docker contient uniquement les deux manifests et les fichiers de vérification générés. L'image finale est enregistrée par son identité immuable dans `config.json`. `build.log`, le profil et la recette restent dans le dossier de préparation, hors du dépôt. Un dossier existant n'est jamais écrasé.
- Les commandes `config.checks` sont des tableaux argv, sans shell implicite. Les exécutables de `node_modules/.bin` sont disponibles dans le PATH. `config.image` vaut `prepared` dans le profil et est remplacé par l'identité de l'image dans la configuration produite.
- `copyPaths` sélectionne des fichiers ou répertoires à la racine du dépôt. Les sources sont copiées vers `/tmp` dans chaque conteneur ; les liens, fichiers cachés, clés usuelles et répertoires de dépendances/génération sont refusés. La copie est bornée à 64 Mio et 10 000 entrées. Les dépendances restent en lecture seule dans l'image ; les caches doivent être désactivés ou placés dans `/tmp`.
- Chaque check vérifie les empreintes de `package.json` et `package-lock.json`. Un changement impose une nouvelle préparation. Les fichiers générés sont jetés à la fin du check ; ils ne sont pas partagés entre deux commandes.
- `nodeHeapMb` règle le heap Node (64–384 Mio) à l'intérieur de la limite de 512 Mio du conteneur. Les projets nécessitant davantage de ressources demandent encore une extension du runner.

`writablePaths` contient des chemins relatifs exacts ou des répertoires (pas de glob). Pour protéger les tests existants, autoriser seulement `src`. Les commandes `checks` sont des tableaux argv, exécutés dans `/workspace` dans l'image Docker configurée ; celle-ci doit contenir les dépendances nécessaires. Aucun téléchargement ni installation implicite.

## Frontière d'exécution de ce lot

- Codex expose `cohorte_list`, `cohorte_read` et `cohorte_write` à l'implémenteur. Le reviewer reçoit seulement les deux premiers et le contrôle d'écriture refuse aussi toute requête forgée.
- Les outils natifs de filesystem et de processus sont dirigés vers un petit endpoint qui refuse toute opération : il expose uniquement l'initialisation et les métadonnées d'environnement. Le canal utilise une capacité aléatoire et n'accepte qu'un client, sur loopback.
- Les outils Cohorte travaillent dans le worktree, refusent traversées, chemins cachés, fichiers de clés usuels, symlinks, hardlinks et fichiers non réguliers. Les lectures/écritures sont bornées à 128 Kio de texte ; les listes à 2000 fichiers. Pas de suppression de fichier pour ce premier lot.
- Le **code-mode host de Codex reste activé** : le modèle par défaut l'utilise pour appeler les outils. Les accès natifs restent refusés par notre endpoint. Le code-mode host fait partie du client de confiance, pas du workflow maison.
- Hooks, plugins, apps, sous-agents natifs, navigateur et mémoire native sont désactivés. Les serveurs MCP issus de la configuration sont explicitement désactivés au lancement du thread. Le contexte de phase est fourni par Cohorte.
- Les checks s'exécutent dans un conteneur non privilégié, sans réseau, workspace en lecture seule, sans montage du HOME hôte, des credentials ou de l'état Cohorte. `/tmp` est inscriptible et borné. Les profils préparés utilisent une copie temporaire pour les checks qui génèrent des fichiers.
- Une erreur de compte, quota, protocole ou capacité bloque le run. Aucun fallback API. Les sorties doivent satisfaire le contrat JSON, les tests réellement réussir et la review être positive avant `completed`.

Les vérifications livrées couvrent ce sous-ensemble sur macOS arm64 avec Docker Linux arm64. Ce n'est pas une preuve d'isolation universelle face à un client Codex compromis, à un administrateur local ou à toutes les primitives des futures versions. Les fichiers secrets déjà versionnés dans le dépôt peuvent exister dans le worktree : ne pas y committer de secrets.

## Arrêt et reprise

Ctrl-C ou SIGTERM interrompt le run ; Cohorte demande l'interruption du tour, ferme l'app-server et supprime le conteneur de checks actif. La phase et les effets déjà terminés restent enregistrés.

Après une panne, inspecter le worktree, le statut et les logs, puis :

```sh
node dist/cli.js resume <run-id> --repo /chemin/projet --acknowledge-uncertain
```

La commande **redémarre la phase avec une nouvelle session** ; elle ne prétend pas reprendre exactement une commande interrompue. Une review redémarre par les tests, afin de tenir compte d'éventuelles corrections manuelles. Le compteur des corrections automatiques reste conservé.
Un verrou empêche deux contrôleurs du même run. Un verrou laissé par un processus mort exige l'acquittement ; un PID réutilisé ou un verrou de récupération incomplet bloque volontairement pour inspection.

Après SIGKILL, SQLite conserve la phase en `running` (dernier état connu). Aucun redémarrage automatique n'est déclenché. Un conteneur peut rester actif après la mort brutale du contrôleur ; il reste sans accès d'écriture au dépôt et est supprimé lors du `resume`. Le watchdog indépendant et le détachement des runs ne sont pas livrés.

## Ajouter une étape

- `src/contracts.ts` : données de run, configuration, contrat du runtime et des résultats.
- `src/workflow.ts` : registre `StepDefinition` et transitions XState. Ajouter une étape implique son module et ses transitions, sans modifier le transport Codex.
- `src/codex.ts` : adaptateur natif et outils disponibles par rôle.
- `src/checks.ts` : exécution des vérifications, indépendante de l'agent.
- `src/store.ts` : état et événements SQLite.

Les variantes brainstorm/spec/audit/refactor/fleet/retro, le parallélisme par surface, les approvals interactives, Claude, Obsidian et ship viendront comme extensions. Ce lot ne réimplémente ni le keyring ni un framework de plugins.

## Validation

```sh
npm run typecheck
npm test
npm run test:native
npm run test:profile
npm run build
npm run test:live
```

- `npm test` : fichiers/permissions, transitions, bornes de correction, transport, verrou et vraie mort SIGKILL d'un contrôleur, état SQLite et redémarrage explicite. Aucun compte ni appel modèle.
- `test:native` : **vrai Codex 0.155.1**, fournisseur HTTP synthétique local, vraie correction de fichier et vrais tests Docker. Contrôles négatifs : lecture du secret factice via un outil natif, écriture du reviewer, interruption avant écriture, accès à l'état hôte et réseau du conteneur. Aucune connexion réelle.
- `test:live` : **abonnement ChatGPT réel**, dépôt Git jetable, CLI complète, correction d'addition, tests Docker et review séparée. Consomme du quota d'abonnement. Ne s'exécute pas avec `npm test`. `COHORTE_TEST_MODEL` peut sélectionner un modèle ; sinon le modèle par défaut annoncé par Codex est utilisé.
- `test:profile` : vraie construction Docker, checks répétés avec génération de fichiers temporaires, refus des manifests périmés et liens de source, checkout intact. Aucun compte modèle.

`COHORTE_CODEX_BINARY` permet aux tests de sélectionner le binaire. Les fixtures et leurs conteneurs sont nettoyés. Les sessions réelles restent gérées par Codex.

Références : [app-server](https://developers.openai.com/codex/app-server), [authentification](https://developers.openai.com/codex/auth), [XState](https://stately.ai/docs/actors).

La CI exécute l’installation, TypeScript, les tests sans modèle, le build et l’intégration des profils Docker depuis la racine. Les tests natifs Codex et le smoke test avec abonnement sont lancés explicitement dans un environnement équipé.
