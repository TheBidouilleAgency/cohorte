# Premiers pas

Placez-vous dans le dépôt à utiliser, puis lancez :

```bash
cohorte init .
cohorte profile show
cohorte status
```

`init` détecte les manifests, workspaces, surfaces et checks possibles. Il enregistre un profil local dans l’état de Cohorte, hors du dépôt cible. La réponse signale les questions à trancher. Dans un monorepo, vérifiez en particulier l’appartenance des fichiers partagés, le lockfile, les dépendances entre surfaces et les commandes de test : une commande détectée est une proposition, pas une preuve qu’elle fonctionne.

Pour corriger le profil :

```bash
cohorte profile edit
cohorte profile show
```

Vous pouvez aussi préparer un fichier JSON et l’appliquer avec `cohorte profile apply profil.json`. `cohorte init .` réutilise le profil existant ; `cohorte init . --refresh` relance volontairement la découverte et remplace les corrections précédentes.

Capturez ensuite une demande et explorez une idée :

```bash
cohorte intake
cohorte brainstorm
cohorte spec
cohorte start
cohorte status
```

Le terminal demande les informations manquantes. Le brainstorm lance un panel produit, architecture et QA lorsque l’accès fournisseur est disponible. Il affiche une synthèse courte et conserve le brief complet. Il ne modifie pas le code du projet. `spec` prépare ensuite un brouillon pour une seule surface, laisse les questions sans réponse ouvertes et demande une approbation liée au contenu exact. `start` affiche le périmètre et demande un accord avant de lancer les agents dans un worktree. **Ces deux commandes ne sont pas dans la version PyPI `1.0.0a2`** : avant la prochaine publication, utilisez `uv run cohorte` depuis le dépôt Cohorte pour les essayer.

Pour un script, placez `--json` **avant** la sous-commande et fournissez les arguments explicites :

```bash
cohorte --json status
cohorte --json brainstorm mon-projet \
  --feature-id onboarding --idea 'Explorer l’onboarding' \
  --answer 'Cadrage uniquement, sans modification du code' --live
```

`--live` autorise les appels effectifs au fournisseur pour les commandes qui le demandent. La sortie JSON est destinée à l’automatisation ; la sortie humaine résume les éléments utiles.

Le brief obtenu n’est pas encore une spec gelée. Le [parcours complet](/guide/parcours) décrit les décisions et les limites de l’interface actuelle.
