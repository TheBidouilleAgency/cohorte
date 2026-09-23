# Parcours de travail

## 1. Découvrir et cadrer

Dans le dépôt cible, `cohorte init .` crée le profil local. Relisez-le avec `cohorte profile show`, corrigez-le avec `cohorte profile edit`, puis utilisez `cohorte intake` pour trier une demande ou `cohorte brainstorm` pour explorer une idée. Si le triage demande des précisions, `cohorte intake --continue IDENTIFIANT` reprend les questions et conserve les réponses dans une nouvelle révision. Pour une demande classée « feature », `cohorte brainstorm --from-intake IDENTIFIANT` reprend sa provenance et ses réponses. `cohorte brief show IDENTIFIANT` permet de relire le brief complet sans relancer le panel. `cohorte status` affiche les fonctionnalités, runs et décisions en attente du projet courant.

Après le premier tour, le terminal propose de répondre aux questions bloquantes et de relancer le panel. Vous pouvez arrêter puis reprendre avec `cohorte brainstorm --continue IDENTIFIANT` : les nouvelles réponses s’ajoutent au brief précédent, et la nouvelle révision référence l’ancienne. Une réponse laissée vide reste ouverte. Le panel réévalue sa recommandation ; il ne transforme pas son accord en décision utilisateur.

Une commande de brainstorm peut aussi être entièrement explicite :

```bash
cohorte --json brainstorm mon-projet \
  --feature-id export --idea 'Exporter un run de façon sûre' \
  --answer 'Conserver les données localement' --live
```

Le brief contient les objections et questions bloquantes. Répondez à ces questions avant de définir les critères d’acceptation.

## 2. Préparer et geler une spec

Dans un terminal, `cohorte spec` reprend le brief enregistré et le profil courant. Il recueille les surfaces, scénarios, critères, checks, cas d’erreur et retour arrière. Pour plusieurs surfaces, il demande un fichier de contrat partagé et en capture une référence. Si une question bloquante reste sans réponse, le brouillon est conservé dans les données locales et le gel n’est pas proposé. Une nouvelle invocation permet de répondre aux questions restantes. Après affichage du contenu, il faut taper `oui` pour approuver le hash exact de la spec et du profil.
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

Après `intake`, une demande classée « patch » peut être préparée avec `cohorte patch-spec --from-intake IDENTIFIANT`. Le terminal demande la reproduction, le résultat attendu, les surfaces, chemins, checks de régression et retour arrière, puis écrit un `patch.json` à relire avant `patch`. `audit`, `refactor`, `retro` et `align-ds-*` servent à la maintenance avec des entrées explicites. La [référence CLI](/reference/cli) donne leurs paramètres, et le [README du dépôt](https://github.com/TheBidouilleAgency/cohorte#readme) contient des exemples détaillés.

## Limites actuelles

- Fleet et la maintenance nécessitent encore des fichiers et identifiants explicites. `ship` garde une approbation et une commande séparées.
- La découverte du profil ne peut pas déduire seule l’ownership, les migrations, les sources de design ou les conventions d’un monorepo.
- Les preuves d’intégration live dépendent des comptes et services disponibles. Un test local ou une CI verte ne qualifie pas automatiquement toutes les combinaisons de fournisseurs et plateformes. Consultez la [matrice de qualification](/qualification/README).
