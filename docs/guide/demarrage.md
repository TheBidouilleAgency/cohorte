# Premiers pas

Placez-vous dans le dépôt sur lequel vous voulez travailler. Cohorte suit un projet, mais garde son profil et son état dans ses données locales : `init` ne remplit pas le dépôt de fichiers.

```bash
cohorte init .
cohorte profile show
```

`init` analyse les manifests, workspaces, scripts de validation, contrats, chemins de code et indices de design ou de release. Il signale aussi les fichiers de conventions, serveurs MCP de retrieval et indices d'isolation sans activer ces intégrations de lui-même. En mode interactif, il montre les surfaces, les rôles, les checks et les questions restantes, puis permet de choisir un serveur de retrieval détecté ou une source design explicite avec son snapshot JSON avant l'enregistrement. Relisez surtout les chemins partagés, les dépendances et les commandes de test. Utilisez `cohorte profile edit` pour corriger une proposition. `cohorte init .` réutilise le profil existant ; `--refresh` ajoute les éléments nouvellement détectés tout en conservant les choix personnalisés. `--preview` montre l'analyse sans enregistrer le projet, y compris en JSON. Pour enregistrer un profil validé par une autre interface, `cohorte --json init . --profile-file profil.json` applique exactement ce document ; ajoutez `--refresh` si le projet est déjà enregistré.

## Choisir votre point de départ

**Vous avez une idée à explorer ?** Lancez directement :

```bash
cohorte brainstorm
```

Le terminal vous demande l’idée puis lance le panel défini dans le profil, avec des extraits pertinents du dépôt. Le panel propose un brief, des objections, des questions ciblées et, pour chaque question, une piste produit et une piste code. Vous pouvez répondre librement ou taper `p` ou `c` pour reprendre une piste. Le panel ne modifie pas le code et ne transforme pas son avis en décision de votre part. Relisez le brief avec `cohorte brief show IDENTIFIANT`. Si des questions restent ouvertes, répondez dans le terminal ou revenez plus tard avec `cohorte brainstorm --continue IDENTIFIANT`.

**Vous avez plutôt un ticket, un message client ou une URL ?** Commencez par :

```bash
cohorte intake
```

`intake` signifie **recevoir et trier la demande**. L'agent examine la source et le contexte du dépôt en lecture seule, puis propose une route et des questions ciblées. Vous pouvez accepter ou corriger la route avant de l'enregistrer ; `--manual` conserve le tri déterministe. Si vous quittez le terminal avec des questions ouvertes, `cohorte intake --continue IDENTIFIANT` les reprend. Aucun code n’est modifié à cette étape.

Après le triage :

- **Fonctionnalité** : `cohorte brainstorm --from-intake IDENTIFIANT` transmet les réponses et la provenance au panel.
- **Bug** : `cohorte patch-spec --from-intake IDENTIFIANT` prépare un correctif borné et un check de régression à relire avant toute exécution.
- **Encore incertain** : répondez aux questions ou choisissez explicitement la route lors de la reprise d’`intake`.

`intake` reste facultatif. Il sert quand il faut d’abord comprendre et classer une demande ; il n’ajoute pas une étape obligatoire aux idées déjà claires.

## Du brief au code

Lorsque le brief décrit assez bien le problème et les critères attendus :

```bash
cohorte spec IDENTIFIANT
```

`spec` demande à l'agent du profil une proposition en lecture seule : réponses possibles aux questions ouvertes, scénarios, critères, checks du profil, tests, cas d'erreur et retour arrière. Ces pistes restent des propositions ; une question sans réponse de votre part demeure ouverte. Vous pouvez accepter le brouillon proposé, le corriger dans le fichier JSON ou choisir la saisie manuelle avec `cohorte spec IDENTIFIANT --manual`. Si l'agent est indisponible, la saisie manuelle reste accessible. Avant de geler la spec, Cohorte affiche son contenu et demande votre approbation exacte. **La préparation et le gel ne lancent pas les agents de code.**

Lorsque le profil active le design, le RBAC ou le mobile sur une surface concernée, la spec demande aussi les contraintes correspondantes. Une spec sans ces contraintes ne peut pas être gelée ni construite ; la revue reçoit une liste explicite de points à contrôler.

Le cadrage rappelle des fichiers pertinents du dépôt à vérifier avant le gel. Les agents de construction, revue et correction reçoivent ensuite la spec approuvée et un relevé récent des fichiers utiles dans leur worktree ; la revue inspecte également le diff. Relisez les décisions de la spec : le relevé de fichiers sert d'indice et peut manquer du contexte métier extérieur au dépôt.

Une fois la spec gelée :

```bash
cohorte start IDENTIFIANT
```

`start` montre le périmètre et attend votre accord avant de lancer le travail dans un worktree Git isolé. Le run passe ensuite par les checks et la revue. La création du commit et de la PR ou MR est une autre décision, décrite dans le [parcours complet](/guide/parcours).

::: tip Version installée
Les commandes `intake --continue`, `brainstorm --from-intake`, la spec enrichie et `patch-spec --from-intake` sont disponibles depuis `1.0.0a5`. La version `1.0.0a6` corrige également l’arrêt du service quand un client reste connecté. Depuis `1.0.0a7`, `brainstorm` donne au panel des extraits du projet avec leurs chemins et lignes à chaque tour. `1.0.0a8` étend ces pistes à la spec et aux agents de construction, revue et correction ; `1.0.0a9` couvre aussi Fleet. `1.0.0a10` propose un brouillon de spec rédigé par l'agent et `1.0.0a11` rend visibles ses réponses même si les questions sont reformulées. Vérifiez avec `cohorte --version` ; depuis le dépôt, `uv run cohorte` exécute la version de développement.
:::

Pour l’automatisation, placez `--json` **avant** la sous-commande et fournissez les paramètres explicitement. `--live` autorise les appels effectifs au fournisseur pour les commandes qui le demandent. La [référence CLI](/reference/cli) détaille cette forme, et `cohorte status` montre les fonctionnalités, runs et décisions en attente du projet courant.
