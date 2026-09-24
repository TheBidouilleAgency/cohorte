# Installer Cohorte

Cohorte requiert Python 3.12 ou plus récent. Le paquet **Python sur PyPI** s’appelle `cohorte-engine` ; la commande installée s’appelle `cohorte`. Ce guide vise la préversion `1.0.0a9`. **N’utilisez pas `npm install -g cohorte` : ce nom correspond à l’ancien paquet npm, pas à ce moteur Python.**

Avec `uv` :

```bash
uv tool install 'cohorte-engine==1.0.0a9'
cohorte --version
cohorte doctor
```

Pour travailler depuis le dépôt Cohorte :

```bash
uv sync --all-extras
uv run cohorte --version
uv run cohorte doctor
```

La commande globale et `uv run cohorte` peuvent correspondre à des versions différentes. Pour essayer les derniers changements du dépôt, utilisez `uv run cohorte` depuis celui-ci. Pour essayer une préversion publiée, utilisez la commande globale et contrôlez `--version`.

Si vous utilisez le service local, sa version peut aussi différer de celle de la CLI : `cohorte service start` réutilise un service déjà lancé et ne le met pas à jour. Après une mise à jour du paquet, exécutez `cohorte service status` et comparez `health.version` avec `cohorte --version`. Pour redémarrer le daemon avec la nouvelle version, utilisez `cohorte service stop`, puis `cohorte service start`, et vérifiez à nouveau son état. Un redémarrage coupe temporairement les clients connectés ; terminez d’abord les runs en cours.

`npm ci --prefix docs` n’installe que les dépendances du site VitePress pour sa prévisualisation locale ; cette commande ne sert pas à installer Cohorte.

Les adaptateurs optionnels s’installent séparément selon le besoin :

```bash
uv tool install 'cohorte-engine[claude]==1.0.0a9'
```

Les extras `serena` et `graphify` concernent la [recherche de contexte](/reference/integrations). L’installation d’un extra ne configure pas automatiquement son service externe.

La configuration et l’état de Cohorte sont stockés hors du dépôt cible dans les répertoires usuels du système. Les options globales `--config-dir` et `--data-dir` permettent de les isoler, notamment dans un test.

[Initialiser un projet →](/guide/demarrage)
