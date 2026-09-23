# Dépannage

## La commande ne reflète pas le code du dépôt

Comparez `cohorte --version` et `uv run cohorte --version` depuis le dépôt Cohorte. La première peut être une préversion installée ; la seconde utilise l’environnement de développement local.

## Le projet courant est introuvable

Lancez `cohorte init .` dans le dépôt voulu, puis `cohorte profile show`. Pour de l’automatisation isolée, fournissez toujours les mêmes `--config-dir` et `--data-dir` globaux à toutes les commandes.

## Les checks découverts ne conviennent pas

Le profil est une proposition. Corrigez les surfaces et checks avec `cohorte profile edit` ou `cohorte profile apply fichier.json`. N’utilisez `init --refresh` que si vous acceptez de remplacer le profil édité.

## Le fournisseur est installé mais le run échoue

Commencez par `cohorte doctor` et `cohorte auth status`. Pour Claude, une vérification active est disponible avec `cohorte auth verify claude --live`. Contrôlez le fournisseur du profil et la disponibilité de son client natif. Ne copiez pas d’URL OAuth, de code ou de jeton dans un ticket.

## Le brainstorm reste trop général

Ajoutez le public visé, le problème observé, le résultat attendu et les contraintes. Utilisez `--context`, plusieurs `--answer` ou les questions du mode guidé. Le panel ne peut pas inventer des données produit absentes.

## Le site ne se construit pas

Depuis le dépôt Cohorte, exécutez `npm ci --prefix docs` puis `npm run build --prefix docs`. Le site généré se trouve dans `docs/.vitepress/dist`. L’URL publique utilise le préfixe `/cohorte/` pour GitHub Pages.
