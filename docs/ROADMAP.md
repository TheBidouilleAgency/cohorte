# Cohorte — périmètre et suite

Cohorte orchestre le développement logiciel avec des étapes explicites et des transitions contrôlées par le moteur. Ce draft permet de relire le noyau, ses frontières d'exécution et ses premiers essais avant de développer le parcours complet.

## Contraintes retenues

- TypeScript, avec des étapes extensibles séparées de l'adaptateur de modèle.
- Utilisation des abonnements existants. Le premier adaptateur est Codex app-server avec un compte ChatGPT ; aucun fallback vers une facturation API.
- Authentification confiée au client officiel : pas de lecture/copie de tokens ni de keyring propre à Cohorte.
- État, résultats et historique des phases persistés hors du dépôt cible.
- Vérifications exécutées par le moteur. Un verdict du modèle ne remplace pas un résultat de test.

## Ce qui fonctionne dans ce draft

Une spec Markdown déjà rédigée et une configuration permettent de créer un worktree, d'implémenter, de lancer les checks Docker, puis de demander une review dans un thread distinct en lecture seule. Un échec peut déclencher une correction, dans la limite du nombre de tours configuré. Les sorties structurées et les checks commandent les transitions.

`prepare` construit une image pour un projet npm autonome depuis un profil ; `check` réutilise cette configuration sans agent. La préparation est explicite, les checks sont sans réseau, et leurs fichiers générés restent dans une copie temporaire. Les empreintes des manifests empêchent de réutiliser les dépendances après leur modification.

L'arrêt et la reprise explicite sont disponibles. Une reprise recommence une phase avec une nouvelle session ; elle ne restaure pas l'exécution exacte d'un outil interrompu. Aucun commit, push, merge ou création de PR n'est exécuté par ce noyau.

Les commandes, limites et procédures de validation sont détaillées dans le [README](../README.md).

## Parcours visé, non encore livré

`init` configure une fois le projet. Les demandes suivent ensuite `intake → brainstorm → spec → build → tests → review → fix si nécessaire → ship`. Un bug suffisamment défini peut suivre un parcours patch plus court, avec une spec minimale.

| Ordre | Étape | Résultat attendu |
| --- | --- | --- |
| 1 | init | Détecter la stack, proposer les surfaces, conventions et commandes, faire valider le profil et préparer l'environnement. Le `prepare` actuel devient sa partie technique. |
| 2 | intake | Qualifier la demande et choisir un parcours feature ou patch ; conserver les éléments sources et les informations manquantes. |
| 3 | brainstorm | Explorer le besoin, comparer les options et challenger les hypothèses. Conserver les décisions et questions ouvertes avant la spec. |
| 4 | spec | Produire un périmètre et des critères vérifiables, puis figer une version après validation explicite de l'utilisateur. |
| 5 | ship | Présenter le diff et les preuves, puis gérer commit et PR selon les autorisations explicites. |

Le noyau `build/tests/review/fix` existant sera raccordé à ces entrées. Une validation humaine doit être un état enregistré que le moteur vérifie : le modèle ne peut pas s'approuver lui-même. Modifier une spec figée devra demander une nouvelle version et invalider les validations devenues périmées. Ces mécanismes de validation humaine ne sont pas encore implémentés.

Le support de Claude via abonnement, les autres gestionnaires de paquets (dont les monorepos pnpm), audit/refactor/retro, le travail parallèle et l'interface de suivi restent des extensions ultérieures.

## Preuves et limites

Les tests livrés distinguent le moteur sans modèle, le vrai client Codex avec un fournisseur synthétique, Docker et le smoke test avec abonnement réel. Le test réel est opt-in et consomme du quota ; il n'est pas lancé par `npm test`.

Un premier essai local sur François a corrigé le clic d'une notification après suppression de sa session : deux fichiers TypeScript modifiés, 23 tests de notification verts, deux tests d'acceptation indépendants rouges avant correction et verts après, TypeScript et ESLint verts, puis review positive. Le checkout d'origine est resté intact. Il s'agit d'une validation ciblée du gestionnaire avec les mocks Tauri existants, pas d'une preuve de livraison des notifications par l'OS ni d'un test desktop complet.

Le profil François livré rend sa préparation reproductible ; le dépôt François, son patch, les sessions, les bases SQLite et les journaux locaux de cet essai ne font pas partie de cette PR. Les futurs essais doivent couvrir d'autres tâches et les parcours d'échec avant toute revendication de robustesse générale.
