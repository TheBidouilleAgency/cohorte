# Premiers pas

Placez-vous dans le dépôt sur lequel vous voulez travailler. Cohorte suit un projet, mais garde son profil et son état dans ses données locales : `init` ne remplit pas le dépôt de fichiers.

```bash
cohorte init .
cohorte profile show
```

`init` propose des surfaces de code et des checks à partir du dépôt. Relisez le profil avant un run, particulièrement les chemins partagés, les dépendances entre surfaces et les commandes de test. Pour corriger une proposition, utilisez `cohorte profile edit`. `cohorte init .` réutilise le profil existant ; `--refresh` relance la découverte et remplace vos corrections.

## Choisir votre point de départ

**Vous avez une idée à explorer ?** Lancez directement :

```bash
cohorte brainstorm
```

Le terminal vous demande l’idée, les personnes concernées, le problème observé et le résultat souhaité. Le panel produit, architecture et QA propose un brief avec pistes, objections et questions. Il ne modifie pas le code et ne transforme pas son avis en décision de votre part. Relisez le brief avec `cohorte brief show IDENTIFIANT`. Si des questions restent ouvertes, répondez dans le terminal ou revenez plus tard avec `cohorte brainstorm --continue IDENTIFIANT`.

**Vous avez plutôt un ticket, un message client ou une URL ?** Commencez par :

```bash
cohorte intake
```

`intake` signifie **recevoir et trier la demande**. Cohorte garde la source, pose les questions utiles et indique si le sujet ressemble à une nouvelle fonctionnalité ou à un bug. Si vous quittez le terminal avec des questions ouvertes, `cohorte intake --continue IDENTIFIANT` les reprend. Aucun code n’est modifié à cette étape.

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

`spec` recueille les surfaces, scénarios, critères, checks, cas d’erreur et retour arrière. Une question laissée sans réponse garde la spec en brouillon ; relancez la même commande pour y répondre. Avant de la geler, Cohorte affiche le contenu et demande votre approbation exacte. **La préparation et le gel ne lancent pas les agents de code.**

Une fois la spec gelée :

```bash
cohorte start IDENTIFIANT
```

`start` montre le périmètre et attend votre accord avant de lancer le travail dans un worktree Git isolé. Le run passe ensuite par les checks et la revue. La création du commit et de la PR ou MR est une autre décision, décrite dans le [parcours complet](/guide/parcours).

::: tip Version installée
La préversion PyPI `1.0.0a4` ne contient pas encore `intake --continue`, `brainstorm --from-intake`, la spec enrichie ni `patch-spec --from-intake`. Ces changements sont dans le dépôt en attente d’une publication. Vérifiez avec `cohorte --version` ; pour essayer ce checkout, lancez les commandes avec `uv run cohorte` depuis le dépôt Cohorte.
:::

Pour l’automatisation, placez `--json` **avant** la sous-commande et fournissez les paramètres explicitement. `--live` autorise les appels effectifs au fournisseur pour les commandes qui le demandent. La [référence CLI](/reference/cli) détaille cette forme, et `cohorte status` montre les fonctionnalités, runs et décisions en attente du projet courant.
