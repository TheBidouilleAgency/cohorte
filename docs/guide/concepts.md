# Concepts essentiels

**Projet et profil.** Un projet est identifié par son `project_id`. Son profil décrit les surfaces de code, les chemins, les checks, le VCS, les fournisseurs et les intégrations. Cohorte découvre une première version du profil ; vous validez les décisions qui demandent une connaissance du dépôt.

**Surface.** Une partie du dépôt qu’un agent peut prendre en charge, par exemple une API, un frontend ou un paquet partagé. Les chemins et dépendances entre surfaces servent à contrôler les modifications et la parallélisation.

**Brief.** Le résultat d’un brainstorm : contributions indépendantes, désaccords, questions, pistes et synthèse. Il documente le cadrage et ne donne pas à lui seul l’autorisation de construire une fonctionnalité.

**Spec gelée.** Le contrat exact utilisé pour une exécution. Cohorte lie son contenu, le profil et les références à une approbation précise. Modifier ces données après l’approbation demande une nouvelle décision.

**Run.** Une exécution avec un identifiant, des phases, un journal SQLite et des artefacts. Le travail de code se fait dans un worktree Git distinct du checkout source.

**Review et décision.** Une revue indépendante compare le résultat à la spec. Certaines étapes, notamment le gel de la spec et la livraison, passent par une demande de décision explicite. `ship` crée commit, push et PR/MR après les vérifications ; il ne merge ni ne déploie.

**Événements.** Les adaptateurs Codex et Claude produisent des événements de workflow communs pour les tours, outils et usages. Les métriques de tokens ou de coût fournies par les SDK ne constituent pas une facture.

Voir le [parcours](/guide/parcours), le [profil](/reference/profile) et le [protocole local](/PROTOCOL) pour plus de détail.
