# Profil de projet

Le profil enregistré par `init` est un document versionné. `cohorte profile show` affiche celui du répertoire courant ; `cohorte profile edit` ouvre son JSON dans l’éditeur ; `cohorte profile apply profil.json` valide et applique un fichier révisé. `--json init .` renvoie aussi un `profile_ref` avec identifiant, révision et hash, ainsi que les questions de découverte.

| Champ | Rôle |
| --- | --- |
| `project_id`, `name`, `language` | Identité du projet et langue de travail. |
| `vcs` | Hôte, remote, branche par défaut et préfixes de branches. |
| `surfaces` | Chemins, dépendances, rôle de l’agent et checks par surface. |
| `checks` | Commandes, répertoire, timeout, portée et caractère obligatoire. |
| `contract` | Mécanisme et chemins d’un contrat partagé, s’il existe. |
| `execution` | Mode d’exécution et préparation éventuelle des dépendances. |
| `agent_defaults`, `policy` | Fournisseur, mode d’authentification, parallélisme et décisions. |
| `integrations` | Recherche, design, RBAC, Kanban et notes de release. |
| `conventions` | Règles propres au projet. |

Une surface doit correspondre à une zone de responsabilité réelle. Dans un monorepo, inspectez les packages imbriqués, les dépendances internes, les fichiers partagés et le lockfile. Vérifiez que chaque check détecté peut réellement s’exécuter dans le projet ; `pnpm test` au niveau racine peut exiger un service ou ne pas couvrir tous les packages.

La découverte initiale ne crée pas de fichier de profil dans le dépôt cible : l’état est local à Cohorte. Exportez ou appliquez un JSON explicitement si vous voulez le conserver à côté du projet. `init --refresh` remplace le profil existant par une nouvelle découverte.

Voir les [intégrations](/reference/integrations) et la [référence CLI](/reference/cli).
