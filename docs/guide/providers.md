# Fournisseurs et comptes

Cohorte utilise les clients officiels Codex et Claude. Le profil choisit le fournisseur par défaut avec `agent_defaults.provider`; certains appels acceptent aussi `--provider codex` ou `--provider claude`.

Vérifiez l’état natif du compte avant un workflow :

```bash
cohorte auth status
cohorte auth status codex
cohorte auth status claude
```

`cohorte auth verify claude --live` effectue une vérification active du compte Claude sélectionné. `auth login` délègue la connexion au client natif. Suivez les invites dans votre terminal ou navigateur et ne placez jamais un jeton dans la commande, le profil ou un rapport partagé.

L’adaptateur Claude demande l’extra `claude`. Les clients peuvent être installés alors que l’authentification ou les droits du compte ne permettent pas un run : `auth status`, `auth verify` et une exécution réelle apportent des preuves différentes. Le mode `subscription_only` du profil n’implique pas qu’un abonnement donné soit éligible à chaque SDK.

Les événements de tours, outils et usage sont normalisés pour les deux adaptateurs. Les comptes de tokens et coûts signalés restent ceux des SDK et peuvent différer entre fournisseurs. Voir [l’état de qualification](/qualification/README) avant de promettre un scénario live précis.
