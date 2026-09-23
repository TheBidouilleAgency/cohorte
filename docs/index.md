---
layout: home

hero:
  name: Cohorte
  text: Des workflows de développement supervisés
  tagline: Cadrez une idée, préparez une spec vérifiable et exécutez des agents de code dans des worktrees isolés.
  actions:
    - theme: brand
      text: Démarrer
      link: /guide/installation
    - theme: alt
      text: Parcours de travail
      link: /guide/parcours

features:
  - title: Un profil par projet
    details: Cohorte découvre les surfaces et les checks, puis vous laisse corriger ce qu’il ne peut pas déduire.
  - title: Des décisions visibles
    details: Le brief, la spec gelée, les revues et les approbations sont conservés comme artefacts vérifiables.
  - title: Une exécution isolée
    details: Les workflows utilisent des worktrees Git et contrôlent les chemins, checks et étapes de livraison.
---

La version Python s’installe depuis PyPI sous le nom `cohorte-engine` et fournit la commande `cohorte`.
Cette documentation décrit l’interface disponible dans le dépôt. La version installée peut différer : vérifiez-la avec `cohorte --version`.

Le parcours humain est actuellement guidé jusqu’au brainstorm. La création d’une spec à partir du brief et le lancement d’un workflow restent des étapes explicites ; consultez les [limites actuelles](/guide/parcours#limites-actuelles) avant un premier lancement.
