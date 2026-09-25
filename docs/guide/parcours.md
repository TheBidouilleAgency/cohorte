# Parcours de travail

## 1. Découvrir et cadrer

Dans le dépôt cible, `cohorte init .` analyse le projet, montre un aperçu en mode interactif puis enregistre un profil local après accord. `cohorte init . --preview` laisse le projet inchangé. Relisez le profil avec `cohorte profile show` et corrigez-le avec `cohorte profile edit`.

Si vous partez d’une **idée**, lancez directement `cohorte brainstorm`. Si vous avez une **demande à comprendre** (ticket, message, URL), `cohorte intake` la reçoit, pose les questions manquantes et propose une route « fonctionnalité » ou « correctif ». Ce triage est facultatif et ne modifie pas le code. `cohorte intake --continue IDENTIFIANT` reprend les questions et enregistre les réponses dans une nouvelle révision. Pour une fonctionnalité, `cohorte brainstorm --from-intake IDENTIFIANT` transmet ce contexte au panel ; pour un bug, `cohorte patch-spec --from-intake IDENTIFIANT` prépare le correctif.

`cohorte brief show IDENTIFIANT` relit le brief complet sans relancer le panel. `cohorte status` affiche les fonctionnalités, runs et décisions en attente du projet courant.

Après le premier tour, le terminal propose de répondre aux questions bloquantes et de relancer le panel. Vous pouvez arrêter puis reprendre avec `cohorte brainstorm --continue IDENTIFIANT` : les nouvelles réponses s’ajoutent au brief précédent, et la nouvelle révision référence l’ancienne. Une réponse laissée vide reste ouverte. Le panel réévalue sa recommandation ; il ne transforme pas son accord en décision utilisateur.

Une commande de brainstorm peut aussi être entièrement explicite :

```bash
cohorte --json brainstorm mon-projet \
  --feature-id export --idea 'Exporter un run de façon sûre' \
  --answer 'Conserver les données localement' --live
```

Le brief contient les objections et questions bloquantes. Répondez à ces questions avant de définir les critères d’acceptation.

## 2. Préparer et geler une spec

Dans un terminal, `cohorte spec` reprend le brief enregistré et le profil courant. Un agent en lecture seule propose des réponses aux questions ouvertes et un brouillon de scénarios, critères, checks, cas d’erreur et retour arrière. Vous pouvez accepter cette proposition, la corriger ou utiliser `--manual` pour renseigner chaque champ. Pour plusieurs surfaces, Cohorte demande un fichier de contrat partagé et en capture une référence. Si une question bloquante reste sans réponse, le brouillon est conservé dans les données locales et le gel n’est pas proposé. Une nouvelle invocation permet de répondre aux questions restantes. Après affichage du contenu, il faut taper `oui` pour approuver le hash exact de la spec et du profil.
En mode structuré, `cohorte --json spec-propose IDENTIFIANT` renvoie et conserve la proposition ainsi que les références du brief. Elle reste consultative. Après relecture, `cohorte --json spec-draft IDENTIFIANT --accept-proposal --answer 1="votre décision" --output draft.json` crée un brouillon éditable lié au même brief ; omettre une réponse garde la question ouverte. Si le brief a changé, relancez `spec-propose`. Plusieurs surfaces exigent `--contract` avec un fichier du dépôt. `spec-draft` ne vaut pas approbation du gel.
Si vous reprenez le brainstorm après avoir commencé la spec, `cohorte spec IDENTIFIANT` signale le nouveau brief et propose de le rattacher au brouillon sans effacer ses scénarios ni critères. `--refresh` reconstruit le brouillon à partir de la dernière révision ; relisez d’abord les modifications déjà faites.

Pour un workflow automatisé ou une spec préparée manuellement, préparez le fichier au format attendu par le moteur, puis utilisez les commandes explicites :

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

Après un gel guidé, `cohorte start` vérifie la spec et le profil approuvés, affiche le périmètre et attend votre `oui` avant de lancer le run. Le travail se fait dans un worktree sous les données locales de Cohorte. Pour un workflow automatisé ou une spec préparée manuellement, utilisez `loop` dans un dépôt de test ou sur une branche adaptée :

```bash
cohorte --json loop frozen.json \
  --profile project.json --repo /chemin/vers/projet \
  --worktrees /chemin/vers/worktrees --run-id export-1 --live
```

`loop` crée une branche et un worktree isolés, exécute le build, les checks et la revue. Il ne publie rien à cette étape. Pour plusieurs fonctionnalités supervisées, `fleet-plan` prévisualise les zones d’écriture et l’ordre ; `fleet-plan ... --apply` prépare un worktree par spec gelée, puis `fleet-status` suit chaque branche. Après le merge d’une feature, `fleet-sync` vérifie quelles branches doivent être rebasées ; `--apply` ne modifie que les worktrees propres et sans run Cohorte actif. Une nouvelle revue est nécessaire après rebase. La commande `fleet` conserve son exécution automatisée distincte.

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

Après `intake`, une demande classée « patch » peut être préparée avec `cohorte patch-spec --from-intake IDENTIFIANT`. L'agent propose en lecture seule un diagnostic, une reproduction, des surfaces, chemins, checks de régression et un retour arrière. Le terminal les laisse corriger avant d'écrire le `patch.json` à relire avant `patch` ; `--manual` saute cette proposition. `cohorte audit` utilise le profil du projet courant, ou accepte des entrées explicites. `cohorte retro` cherche les constats de revue répétés entre au moins deux fonctionnalités et propose une règle à ratifier : seule une décision approuvée puis `retro-apply` l'ajoute au profil actif. Les revues antérieures à l'enregistrement structuré des constats ne peuvent pas être récupérées automatiquement. `refactor` et `align-ds-*` restent plus explicites. La [référence CLI](/reference/cli) donne leurs paramètres.

Pour une PR ou MR déjà ouverte hors Cohorte, `cohorte incoming-review NUMÉRO` récupère ses commits et ses métadonnées, crée un worktree détaché et demande une revue en lecture seule sur le diff et les surfaces touchées. Le résultat est un artefact local ; aucun commentaire ou verdict n'est publié sur la forge. Quand la forge fournit les identités attendues, un changement de commit pendant la préparation fait refuser la revue. Les très grands diffs sont refusés plutôt que déclarés entièrement revus après troncature.

## Limites actuelles

- Fleet, refactor, rétro et alignement design nécessitent encore des fichiers ou identifiants explicites. `ship` garde une approbation et une commande séparées.
- La découverte du profil propose les surfaces et checks détectables, mais l’ownership des fichiers partagés, les migrations, la source de design et les conventions demandent une vérification humaine.
- Les preuves d’intégration live dépendent des comptes et services disponibles. Un test local ou une CI verte ne qualifie pas automatiquement toutes les combinaisons de fournisseurs et plateformes. Consultez la [matrice de qualification](/qualification/README).
