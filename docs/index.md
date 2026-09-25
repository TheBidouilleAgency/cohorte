---
layout: home

hero:
  name: Cohorte
  text: Du besoin à une PR contrôlée
  tagline: Cadrez une demande, gardez les décisions visibles et faites travailler les agents dans des worktrees isolés.
  image:
    src: /cohorte-mark.svg
    alt: Signe Cohorte
  actions:
    - theme: brand
      text: Démarrer
      link: /guide/installation
    - theme: alt
      text: Parcours de travail
      link: /guide/parcours

features:
  - title: Comprendre avant de coder
    details: Une demande peut être triée, discutée par un panel puis transformée en spec vérifiable.
  - title: Garder le fil des décisions
    details: Réponses, briefs, specs, revues et approbations sont conservés avec leurs révisions.
  - title: Exécuter avec contrôle
    details: Les agents travaillent dans des worktrees Git ; checks, revue et livraison ont leurs propres validations.
---

![Parcours Cohorte V3 : init, intake, brainstorm, spec, start et ship](/parcours-v3.gif)

`intake` veut simplement dire **recevoir et trier une demande**. Vous pouvez le sauter si vous partez d’une idée et lancer directement `brainstorm`. Le [guide de premiers pas](/guide/demarrage) explique quoi lancer selon votre situation et à quel moment le code est modifié.

Le moteur Python s’installe avec `uv tool install 'cohorte-engine==1.0.0a14'` et fournit `cohorte`. L’ancien paquet npm correspond à V2. Vérifiez toujours la version utilisée avec `cohorte --version`.
