# Référence CLI

Forme générale : `cohorte [--json] [--config-dir DIR] [--data-dir DIR] COMMANDE`. Les options globales précèdent la commande. `cohorte COMMANDE --help` donne la liste exacte des options de la version installée. `--json` émet une réponse structurée pour les scripts ; `--live` est requis sur les commandes qui exécutent réellement un fournisseur ou un workflow.

## Projet et diagnostic

| Commande | Usage |
| --- | --- |
| `doctor` | Diagnostiquer l’installation et les capacités disponibles. |
| `init [PATH] [--language fr] [--refresh]` | Découvrir et enregistrer un projet ; `--refresh` remplace le profil. |
| `profile show [PROJECT_ID]` | Lire le profil local. |
| `profile edit [PROJECT_ID]` | Éditer le JSON du profil. |
| `profile apply FILE [--project-id ID]` | Valider et appliquer un profil révisé. |
| `status [RUN_ID]` | Résumer le projet courant ou un run. |
| `check PROFILE CHECK_ID` | Exécuter un check défini dans un profil. |
| `schemas OUTPUT` | Exporter les schémas JSON. |
| `metrics [--project-id ID] [--days N]` | Lire les métriques enregistrées. |
| `export RUN_ID [--output FILE] [--max-bytes N]` | Exporter les données d’un run avec une limite de taille. |

## Comptes et service local

| Commande | Usage |
| --- | --- |
| `auth status [codex|claude]` | État de l’authentification native, sans divulguer de secret. |
| `auth login codex|claude` | Démarrer la connexion dans le client natif. |
| `auth verify codex|claude --live [--full]` | Vérifier activement un compte. |
| `auth logout` / `auth disconnect` | Présentes dans le parseur, mais non implémentées ; utilisez le client natif pour gérer sa session. |
| `service start|status|stop` | Gérer le service local. `start` réutilise un daemon existant ; après une mise à jour, comparez `service status` (`health.version`) avec `cohorte --version` et redémarrez avec `stop`, puis `start`. |
| `rpc --stdio` | Servir le protocole JSON-RPC sur l’entrée/sortie standard. |

## Cadrage et spec

`intake` reçoit et trie une demande venue d’un ticket, d’un texte ou d’une URL. C’est une étape facultative avant `brainstorm` pour les fonctionnalités ou `patch-spec` pour les bugs. Elle conserve les réponses mais ne modifie pas le code. Si vous partez d’une idée déjà claire, lancez directement `brainstorm`.

| Commande | Usage |
| --- | --- |
| `intake [PROJECT_ID] [--text TEXTE | --file FILE | --url URL] [--title TITRE]` | Recevoir une demande et la classer : fonctionnalité, correctif ou questions à préciser. Sans source, ouvre le mode guidé. Les réponses sont conservées avec leur révision. |
| `intake --continue FEATURE_ID [--answer N=RÉPONSE] [--route feature\|patch]` | Reprendre un triage du projet courant. Dans un terminal, les questions et le choix de parcours sont proposés. En JSON, fournissez les réponses ou le parcours explicitement. |
| `brainstorm --from-intake FEATURE_ID [--live]` | Démarrer le panel depuis une demande classée « feature » en reprenant les réponses, questions ouvertes et la provenance de la source. |
| `brainstorm [PROJECT_ID] [--feature-id ID] [--idea TEXTE] [--answer TEXTE] [--context TEXTE] [--provider codex|claude] [--output FILE] [--live]` | Exécuter le panel ou recueillir les réponses guidées ; `--answer` et `--perspective` sont répétables. Si le panel pose des questions bloquantes, le terminal propose d’y répondre et de relancer un tour. |
| `brainstorm --continue FEATURE_ID [--answer TEXTE] [--live]` | Reprendre le dernier brief du projet courant avec de nouvelles réponses. Sans `--answer`, le terminal pose les questions encore ouvertes. En JSON, fournir au moins un `--answer` et `--live`. |
| `brief show FEATURE_ID` | Relire le dernier brief enregistré pour une fonctionnalité du projet courant, sans relancer le panel. `cohorte --json brief show FEATURE_ID` renvoie le brief complet. |
| `spec-freeze-request DRAFT --profile PROFILE [--repo DIR]` | Demander l’approbation d’une spec précise. |
| `spec-freeze DRAFT --profile PROFILE --decision-id ID --output FILE [--repo DIR]` | Produire la spec gelée après décision correspondante. |
| `spec [FEATURE_ID] [--refresh]` | Préparer et geler une spec depuis un brief enregistré, dans un terminal. Le parcours accepte plusieurs surfaces, scénarios et critères ; il reprend les questions ouvertes. `--refresh` remplace le brouillon local. |

`brainstorm` accepte aussi `--prior-decision` répétable. Chaque tour conserve son propre brief et une référence vers le tour précédent. `brief show` lit le dernier tour. Si un nouveau brief arrive après le brouillon de spec, `spec` propose de l'y rattacher sans effacer les scénarios ni critères existants et pose les nouvelles questions bloquantes. `--refresh` reconstruit le brouillon depuis le dernier brief. Une spec gelée ne se réouvre pas par un nouveau brainstorm.

Le panel reçoit automatiquement un extrait borné des fichiers locaux pertinents, avec chemins et lignes, en plus du profil enregistré. Cet extrait est recalculé à chaque tour, puis conservé dans le brief ; il sert de piste de lecture, pas de preuve que le reste du dépôt ne contient rien. Les agents doivent vérifier les fichiers complets avant de conclure sur un comportement. `--context` reste disponible pour des faits produit ou des contraintes absents du dépôt.

## Exécution et livraison

| Commande | Usage |
| --- | --- |
| `loop SPEC --profile PROFILE --worktrees DIR --run-id ID --live [--repo DIR]` | Exécuter une spec gelée dans un worktree. |
| `start [FEATURE_ID]` | Vérifier une spec gelée par `spec`, demander confirmation et lancer un run réel sans chemins à fournir. Terminal interactif uniquement. |
| `fleet SPEC... --profile PROFILE --worktrees DIR --fleet-id ID --live [--repo DIR]` | Orchestrer plusieurs fonctionnalités. |
| `resume RUN_ID --live` | Reprendre un run journalisé. |
| `pause RUN_ID [--reason TEXTE]` | Demander l’arrêt à la prochaine frontière de phase. |
| `cancel RUN_ID [--reason TEXTE]` | Demander l’annulation à la prochaine frontière de phase. |
| `approve REQUEST_ID [--response-id ID]` | Accepter une demande de décision. |
| `deny REQUEST_ID [--response-id ID]` | Refuser une demande de décision. |
| `ship RUN_ID --live` | Livrer un candidat approuvé par commit, push et PR/MR. |
| `delivery-status RUN_ID --live [--watch] [--timeout N]` | Réconcilier ou surveiller la livraison. |

`loop`, `fleet` et `patch` ne publient pas leur candidat. `ship` ne merge pas la PR/MR et ne déploie pas.

## Correctifs et maintenance

| Commande | Usage |
| --- | --- |
| `patch-spec` | Créer un patch borné à partir d’un artefact source, de la reproduction, des chemins, checks et rollback. Voir `--help` pour tous les champs obligatoires. |
| `patch-spec --from-intake FEATURE_ID` | Préparer un `patch.json` guidé depuis une demande classée « patch » dans le projet courant. Vérifier ensuite le fichier avant `patch`. |
| `patch SPEC --profile PROFILE --worktrees DIR --run-id ID --live [--repo DIR]` | Exécuter le patch et sa régression. |
| `audit --profile PROFILE --audit-id ID --title TITRE --surface ID --path PATH --concern TEXTE --output FILE --live` | Auditer une surface ; `--surface`, `--path` et `--concern` sont répétables. |
| `refactor-request SELECTION` | Demander l’approbation d’une sélection de refactor. |
| `refactor SELECTION --profile PROFILE --worktrees DIR --run-id ID --live` | Exécuter une sélection approuvée. |
| `retro REPORT... --proposal-id ID --rule TEXTE --output FILE` | Proposer une convention à partir des revues. |
| `retro-apply PROPOSAL --profile PROFILE --decision-id ID --output FILE` | Appliquer une convention approuvée. |

## Intégrations et migration

| Commande | Usage |
| --- | --- |
| `retrieve QUERY --profile PROFILE [--repo DIR] [--limit N]` | Rechercher du contexte. |
| `design-snapshot --profile PROFILE --output FILE [--repo DIR]` | Capturer la source design configurée. |
| `align-ds-plan --profile PROFILE --output FILE [--repo DIR]` | Préparer les écarts design/code. |
| `align-ds-request SELECTION` | Demander l’approbation de la sélection. |
| `align-ds SELECTION --profile PROFILE --worktrees DIR --run-id ID --live` | Appliquer la sélection approuvée. |
| `kanban-project --profile PROFILE --feature-id ID --title TITRE --state ÉTAT --state-version N [--plan-only]` | Planifier ou synchroniser un état Kanban. |
| `migrate --from-v2 DIR --plan FILE` | Préparer une migration V2 ; `--apply FILE` et `--rollback FILE` sont des actions distinctes. |

Les exemples de [parcours](/guide/parcours) montrent comment assembler les commandes. Pour les formats d’artefacts et le comportement interne, consultez [l’implémentation](/IMPLEMENTATION) et les schémas exportés par `schemas`.
