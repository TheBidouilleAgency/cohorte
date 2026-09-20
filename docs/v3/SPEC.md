# Cohorte V3 — Spécification complète

**Statut :** proposition de référence pour implémentation  
**Version :** 3.0.0  
**Nature :** full-breaking rewrite  
**Date :** 2026-09-18

> Cette spécification décrit la cible V3. Les éléments marqués **MUST** sont normatifs. **SHOULD** indique une recommandation forte, **MAY** une option compatible. Les éléments explicitement listés dans « Questions ouvertes » ne doivent pas être traités comme des décisions définitives.

## 1. Résumé exécutif

Cohorte V3 devient une application d’orchestration et un coding-agent autonome. Cohorte possède le workflow, l’état persistant, les politiques, les agents logiques, les gates, la découverte du projet et la réconciliation. Pi est le runtime/harness agentique de référence : il exécute une boucle LLM → tool → observation → LLM pour un agent donné. Les modèles et fournisseurs sont interchangeables derrière Pi et le routeur Cohorte. Le chemin d’authentification cible est l’utilisation des abonnements utilisateur via OAuth Pi, et non l’utilisation de clés API.

La hiérarchie cible est :

```text
Human / François
        │  Cohorte Protocol
        ▼
     COHORTE                 orchestrateur, policy, state machine
        │  AgentRuntime
        ▼
       PI                    runtime d’un agent
        │  provider adapter
        ▼
 Claude · OpenAI · Google · OpenRouter · Ollama · ...
```

Cohorte **ne dépend plus** de Claude Code, Codex, Cursor, Gemini ou OpenCode comme runtimes d’exécution. Ces outils peuvent éventuellement être utilisés comme éditeurs ou clients externes, mais ne font pas partie du chemin d’exécution V3. Cohorte doit toutefois conserver une abstraction `AgentRuntime` afin que Pi ne devienne pas un couplage architectural irréversible.

Le principe directeur est :

> Le code contrôle ce qui doit arriver ; le Markdown explique au modèle comment raisonner ; YAML/JSON et le stockage persistant décrivent la configuration et l’état.

## 2. Objectifs et non-objectifs

### 2.1 Objectifs MUST

- Exécuter le pipeline `brainstorm → spec → build → test → review → fix → ship` comme une state machine persistante.
- Reprendre un run après crash, interruption ou redémarrage sans perdre l’état ni exécuter deux fois une action non idempotente.
- Isoler les agents par contexte, permissions, ownership, worktree et budget.
- Supporter plusieurs fournisseurs et modèles dans un même pipeline via les abonnements utilisateur connectés à Pi.
- Permettre d’utiliser les abonnements ChatGPT/Codex et Claude Pro/Max sans exiger de compte API ni de clé API.
- Exposer un protocole Cohorte stable, indépendant de Pi, pour François et d’autres clients.
- Découvrir un repository, produire un Project Model normalisé, calculer un desired state et détecter/reconcilier le drift.
- Permettre à Cohorte de développer Cohorte sans modifier le runtime actif du run.
- Rendre les décisions importantes observables : événements, tokens, quota d’abonnement, coût uniquement si API explicitement autorisée, outils, fichiers, approvals, retries et erreurs.
- Produire un paquet installable sur macOS et Linux ; Windows est une cible de compatibilité à confirmer.

### 2.2 Non-objectifs V3.0

- Remplacer Pi ou maintenir une compatibilité complète avec chacun des coding-agents historiques.
- Garantir que tout repository inconnu soit compris parfaitement sans validation humaine.
- Autoriser par défaut les agents à pousser, merger, publier un package ou déployer.
- Faire de François une dépendance d’exécution.
- Définir un protocole propriétaire de modèle ; les providers restent derrière une interface.
- Faire de l’API pay-as-you-go le chemin par défaut : l’API est au mieux une extension optionnelle, jamais une précondition de V3.

## 3. Principes d’architecture

1. **Cohorte contrôle le workflow.** Le LLM ne décide pas de la prochaine phase, du nombre maximal d’itérations ou de l’arrêt.
2. **Pi contrôle la boucle agentique locale.** Pi peut planifier des appels d’outils dans les limites données par Cohorte, mais ne peut pas dépasser sa policy.
3. **Tout état important est durable.** Un transcript seul n’est jamais la source de vérité.
4. **Les permissions sont positives par défaut.** Une capacité non accordée est refusée ou soumise à approval.
5. **Le code et les données sont séparés de la connaissance LLM.** Les prompts ne doivent pas contenir la logique de contrôle.
6. **Les outputs agentiques sont structurés.** Le texte est conservé pour l’humain ; les décisions utilisent des schémas validés.
7. **Les mutations sont transactionnelles autant que possible.** Une opération reprise doit être détectable et sûre.
8. **Le runtime est snapshoté pendant un run.** Une mise à jour de Cohorte ne change jamais le code exécuté au milieu d’un run.
9. **Les overrides humains sont des entrées protégées.** `init`, `update` et `reconcile` ne les écrasent jamais silencieusement.

## 4. Architecture du repository source

L’arborescence cible est indicative mais chaque responsabilité doit avoir un équivalent explicite :

```text
cohorte/
├── apps/
│   ├── cli/                         # exécutable cohorte
│   └── daemon/                      # API/protocole optionnel local
├── packages/
│   ├── core/                        # orchestration indépendante du runtime
│   │   ├── pipeline/
│   │   ├── state-machine/
│   │   ├── agents/
│   │   ├── context/
│   │   ├── policies/
│   │   ├── budgets/
│   │   └── errors/
│   ├── runtime-contract/            # AgentRuntime, events et capabilities
│   ├── runtime-pi/                  # implémentation Pi
│   ├── providers/                   # mapping provider/modèle, abonnements et coûts API optionnels
│   ├── project-model/               # discovery, normalisation, drift
│   ├── persistence/                 # event store, snapshots, migrations
│   ├── protocol/                    # Cohorte Protocol, schemas, transport
│   ├── security/                    # gates, secrets, sandbox, ownership
│   ├── git/                         # repos, worktrees, diff, merge
│   ├── telemetry/                   # logs, traces, métriques, accounting
│   └── config/                      # chargement, fusion, validation
├── prompts/
│   ├── agents/                      # doctrine de raisonnement
│   ├── phases/                      # brainstorm, spec, review, etc.
│   ├── discovery/
│   └── system/
├── skills/
│   ├── _shared/
│   ├── testing/
│   ├── security-review/
│   └── providers/                   # instructions propres à un stack
├── schemas/
│   ├── config.schema.json
│   ├── project-model.schema.json
│   ├── spec.schema.json
│   ├── run-state.schema.json
│   ├── events.schema.json
│   └── agent-output.schema.json
├── migrations/                      # migrations code/config/state
├── fixtures/
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── e2e/
│   └── fixtures/
├── docs/
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.json
└── README.md
```

### 4.1 Répartition des formats

**TypeScript MUST contenir :** transitions d’état, orchestration, validation, calcul de budget, résolution de permissions, isolation, retries, idempotence, sécurité, protocoles, accès au système et intégration Git.

**Markdown MUST contenir :** prompts, doctrine des rôles, critères de raisonnement, conventions lisibles par un LLM, documentation et skills. Un prompt MAY être enrichi par variables structurées, mais ne doit pas porter une transition obligatoire.

**YAML/JSON MUST contenir :** configuration, Project Model, specs structurées, capabilities, desired state, manifests, événements et snapshots sérialisables. YAML est recommandé pour les fichiers humains ; JSON est recommandé pour les contrats et événements.

## 5. AgentRuntime et PiRuntime

### 5.1 Contrat abstrait

```ts
export interface AgentRuntime {
  readonly id: string;
  readonly version: string;
  capabilities(): RuntimeCapabilities;
  spawn(request: SpawnRequest): Promise<RuntimeAgentHandle>;
  send(agentId: string, message: RuntimeMessage): Promise<void>;
  cancel(agentId: string, reason?: string): Promise<void>;
  pause(agentId: string): Promise<void>;
  resume(agentId: string): Promise<void>;
  subscribe(listener: (event: RuntimeEvent) => void): Unsubscribe;
  inspect(agentId: string): Promise<RuntimeSnapshot>;
  close(): Promise<void>;
}

export interface SpawnRequest {
  runId: string;
  agentId: string;
  role: AgentRole;
  model: ModelRef;
  systemPrompt: PromptRef;
  context: ContextManifest;
  tools: ToolGrant[];
  sandbox: SandboxPolicy;
  budget: Budget;
  workingDirectory: string;
}
```

`AgentRuntime` MUST être consommable par le core sans importer de type Pi. `PiRuntime` est l’implémentation V3 de référence et adapte les sessions Pi en `RuntimeEvent` normalisés. Toute fonctionnalité Pi non présente dans le contrat reste interne à `runtime-pi`.

### 5.2 Responsabilités de PiRuntime

PiRuntime MUST :

- créer une session isolée par agent ;
- installer le system prompt, le contexte et les tools accordés ;
- transmettre les appels au modèle choisi ;
- intercepter chaque appel d’outil avant exécution ;
- produire les événements normalisés et conserver le transcript brut ;
- respecter annulation, pause, timeout et budget ;
- retourner un résultat structuré validé par Cohorte.

PiRuntime MUST NOT :

- décider de passer de `BUILD` à `REVIEW` ;
- modifier un fichier hors de son grant ;
- publier directement une release sans capability explicite ;
- lire les secrets non montés dans son contexte ;
- faire dépendre François d’un événement Pi brut.

## 6. Modèle d’agent et lifecycle

Un agent Cohorte est une entité logique durable ; une session Pi est une incarnation d’exécution.

```text
declared → planned → spawning → running → waiting
                                      ├── completed
                                      ├── failed → retrying
                                      ├── paused
                                      ├── cancelled
                                      └── escalated → running
```

Chaque agent possède :

- `agentId`, `role`, `surface`, `owner` et `parentAgentId` ;
- phase, attempt, incarnation et runtime session ;
- contexte autorisé et provenance de chaque entrée ;
- capacités, chemins, commandes et secrets accordés ;
- modèle demandé, modèle réellement utilisé et raison du routage ;
- budget individuel et consommation ;
- worktree ou répertoire de travail ;
- résultat structuré, résumé humain et artifacts ;
- timestamps, erreurs, retries et événements de contrôle.

Le spawn est idempotent via `(runId, agentId, incarnation)`. Un agent déjà terminé ne doit pas être relancé par une reprise sauf instruction explicite ou nouvelle incarnation.

## 7. Context engineering

Le contexte est construit par `ContextBuilder` à partir d’un manifest déterministe :

```yaml
context:
  projectModel: .cohorte/project.yaml
  specification: specs/auth-042.yaml
  doctrine:
    - prompts/agents/implementer.md
    - .cohorte/conventions.md
  files:
    include:
      - src/auth/**
      - tests/auth/**
    exclude:
      - node_modules/**
      - .env*
  artifacts:
    - build/contracts/api.json
  priorEvents: phase-local
```

MUST :

- tracer la source, le hash et la taille de chaque élément de contexte ;
- séparer instructions système, doctrine, données de projet, tâche et résultats ;
- exclure secrets et fichiers hors ownership ;
- imposer une limite de contexte et une stratégie de réduction déterministe ;
- empêcher un artifact produit par l’agent de devenir une instruction de priorité supérieure ;
- traiter tout contenu du repository comme données non fiables.

SHOULD : utiliser une stratégie progressive : manifest → extraits ciblés → recherche structurée → résumé validé → fichiers complets nécessaires. Les résumés générés doivent rester accompagnés de leurs références.

## 8. Agents, skills et ownership

Les rôles V3 minimum sont : `discoverer`, `brainstormer`, `architect`, `spec-author`, `implementer`, `tester`, `reviewer`, `security-reviewer`, `fixer`, `release-manager` et `reconciler`.

Une skill est un paquet de connaissance et de procédures destinées au modèle. Elle contient un manifeste, des Markdown, des exemples et éventuellement des checks déterministes ; elle ne peut pas accorder une permission système par elle-même.

```yaml
id: typescript-testing
version: 1.0.0
appliesWhen:
  languages: [typescript]
  frameworks: [vitest]
prompt: skills/testing/typescript.md
checks:
  - command: pnpm test
```

L’ownership est explicite :

```yaml
surfaces:
  backend:
    paths: [src/backend/**, tests/backend/**]
    owners: [backend-implementer]
    reviewers: [backend-reviewer, security-reviewer]
  shared:
    paths: [package.json, pnpm-lock.yaml]
    owners: [architect]
    approval: human
```

Un agent ne peut écrire que dans ses chemins, sauf grant temporaire audité. Les fichiers partagés demandent soit un agent propriétaire unique, soit une réservation/merge explicite.

## 9. Tools, permissions, gates et sandboxing

Les tools sont des capacités déclarées : `read_file`, `list_files`, `search`, `write_file`, `patch_file`, `run_command`, `git_diff`, `git_commit`, `network_request`, `secret_read`, `approval_request`.

Chaque appel suit ce chemin :

```text
Pi tool call
  ↓
schema validation
  ↓
agent capability check
  ↓
ownership/path check
  ↓
command/network policy
  ↓
budget + rate limit
  ↓
approval gate si nécessaire
  ↓
isolated executor
  ↓
result + audit event
```

Décisions possibles : `allow`, `deny`, `ask`, `allow-once`, `allow-for-run`. Les règles de sécurité sont codées, testées et versionnées. Un prompt ne peut jamais contourner un gate.

Le sandbox MUST fournir : working directory borné, environnement filtré, réseau désactivé par défaut, timeout, limite de CPU/mémoire si disponible, taille maximale de sortie et kill tree. Le niveau exact dépend de l’OS ; `cohorte doctor` doit signaler les garanties réellement actives.

Les secrets sont référencés par identifiant, jamais copiés dans les prompts, événements ou logs. Les valeurs sont redacted avant persistence. Le provider reçoit seulement les secrets nécessaires à la requête.

## 10. Providers, abonnements, modèles, routage et budgets

Le modèle logique est :

```ts
type ModelRef = {
  provider: string;
  model: string;
  capability?: 'fast' | 'coding' | 'reasoning' | 'vision' | 'cheap';
};
```

Le provider adapter normalise l’authentification OAuth déléguée à Pi, le streaming, le tool calling, l’usage et les erreurs. La configuration ne doit pas présumer qu’un fournisseur supporte toutes les capabilities.

### 10.1 Politique d’authentification : abonnement d’abord

L’objectif V3 est de faire fonctionner Cohorte avec les abonnements déjà détenus par l’utilisateur :

```text
cohorte
  ↓ demande une session au PiRuntime
Pi
  ↓ /login OAuth
ChatGPT Plus/Pro (Codex) ou Claude Pro/Max
```

MUST :

- supporter le login OAuth Pi pour ChatGPT Plus/Pro et Claude Pro/Max lorsque Pi expose ces providers ;
- ne pas exiger `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` ou une autre clé API pour installer, initialiser ou exécuter le chemin nominal V3 ;
- conserver les tokens OAuth dans le credential store de Pi, hors configuration Cohorte, prompts, événements et logs ;
- permettre à Cohorte de vérifier l’état d’authentification sans lire ni exporter le token ;
- détecter une expiration, une déconnexion ou une limite d’abonnement et passer en `AUTH_REQUIRED`, `QUOTA_EXCEEDED` ou `WAITING_APPROVAL` plutôt que basculer silencieusement sur une API payante ;
- afficher clairement le provider, le compte/tenant non secret, le modèle, le quota connu et l’origine de l’authentification.

L’usage d’une clé API MAY être supporté comme mode développeur, CI ou fallback explicitement activé, mais il doit être opt-in, visible dans le plan du run et jamais activé automatiquement. V3 ne doit jamais transformer un abonnement en facturation API sans consentement explicite.

Le support d’un abonnement reste soumis aux conditions, limites et changements de politique du fournisseur. La présence d’un login dans Pi ne garantit pas une capacité illimitée ni une disponibilité headless permanente.

Politique de routage exemple, orientée abonnements :

```yaml
routing:
  defaults:
    brainstorm: reasoning
    spec: reasoning
    implementer: coding
    tester: cheap
    reviewer: reasoning
  tiers:
    coding: { provider: openai-codex, model: subscription-default }
    reasoning: { provider: anthropic-claude, model: subscription-default }
    cheap: { provider: openai-codex, model: subscription-default }
  authentication:
    mode: subscription
    allowApiKeys: false
  escalation:
    sameFailureCount: 2
    from: cheap
    to: reasoning
```

Le routeur MUST considérer disponibilité, capability, quotas d’abonnement, latence, résidence des données et policy du projet. Il MUST enregistrer le modèle demandé, le modèle effectif et le mode d’authentification (`subscription` ou `api`). Une panne provider peut déclencher retry, fallback vers un autre abonnement déjà connecté ou pause ; il ne doit jamais envoyer automatiquement les données vers une API payante ou un provider non autorisé.

Budgets : run, phase, agent, provider et tool. Limites minimales : tokens, quota estimé, durée, appels, retries, taille de contexte et concurrence. Pour le mode abonnement, Cohorte suit les tokens, appels, durée et limites/quota reportés par Pi ou le provider ; il ne doit pas inventer un coût monétaire API. Le champ `monetaryCost` est `not_applicable` en mode abonnement, sauf si l’utilisateur a explicitement autorisé un provider API. En mode API optionnel, le coût est calculé à partir des usages provider et d’un catalogue de prix versionné.

## 11. Pipeline comme state machine persistante

### 11.1 États

```text
IDLE
  → BRAINSTORM
  → SPEC
  → PREFLIGHT
  → BUILD
  → TEST
  ├─ failure → FIX
  └─ pass → REVIEW
REVIEW
  ├─ approved → SHIP
  ├─ findings → FIX
  └─ needs-human → WAITING_APPROVAL
FIX → TEST
SHIP → COMPLETED
Tous les états → PAUSED | CANCELLED | FAILED | BLOCKED
```

Les transitions sont une table de code versionnée, validée avant persistence. Chaque transition possède `from`, `to`, `reason`, `actor`, `preconditions`, `effects`, `idempotencyKey` et `eventId`.

### 11.2 Contrat de phase

Chaque phase possède : objectifs, inputs, agents attendus, outputs schema, checks, budget, arrêt, retry policy et approvals. Une phase ne peut être considérée terminée qu’après validation déterministe de ses outputs.

Exemple de loop :

```ts
while (run.phase !== 'COMPLETED') {
  const phase = stateMachine.nextRunnablePhase(run);
  const result = await phaseExecutor.execute(phase);
  await stateStore.commit(result.events);
  if (result.stopReason) break;
}
```

La loop autonome s’arrête si : review clean et checks pass ; limite d’itérations ; budget ; timeout ; échec identique répété ; absence de progress ; policy violation ; approval requise ; changement de repository inattendu ; runtime incompatible. Elle escalade de modèle ou de rôle selon une policy explicite, jamais selon une improvisation du LLM.

### 11.3 Reprise, retries et idempotence

Le state store écrit d’abord les événements puis un snapshot compacté. Au redémarrage, Cohorte recharge le dernier snapshot et rejoue les événements suivants. Les effets externes portent une clé idempotente. Une commande `resume` reconstruit les locks et vérifie l’état Git avant de reprendre.

Un retry est autorisé pour timeout, rate limit, panne transitoire ou erreur explicitement retryable. Les erreurs de validation, permission et sécurité sont terminales ou demandent un humain. L’exponential backoff est borné ; tous les retries sont visibles.

## 12. Repository discovery et Project Model

`cohorte init` réalise une analyse en deux étages :

1. analyse déterministe : fichiers, manifests, lockfiles, Git, scripts, langages, frameworks, CI, Docker, tests, chemins, licences et risques visibles ;
2. analyse sémantique via un agent Pi read-only : architecture, surfaces, responsabilités, dépendances, conventions et inconnues.

Le Project Model normalisé contient : identité, stack, surfaces, commands, test strategy, deployment hints, ownership, risks, conventions, generated artifacts, confidence et provenance. Toute inférence sémantique porte une confidence et une référence.

```yaml
schemaVersion: 1
project:
  id: example
  root: .
stack:
  languages: [typescript]
  packageManager: pnpm
surfaces: {}
commands:
  test: pnpm test
  lint: pnpm lint
unknowns: []
provenance:
  generatedAt: 2026-09-18T10:00:00Z
  toolVersion: 3.0.0
```

## 13. Desired state, drift detection et reconciliation

Le desired state est dérivé de Project Model, configuration humaine, templates Cohorte et versions de skills. L’actual state est ce qui existe réellement dans `.cohorte/`, le repository et la version active de Cohorte.

```text
repository scan + .cohorte + Cohorte templates
                 ↓
             desired state
                 ↓ diff engine
             drift report
                 ↓ policy + approvals
             reconciliation plan
                 ↓
         generated outputs / migrations
```

Chaque champ est classé `human`, `generated`, `derived`, `observed` ou `mixed`. Le diff engine doit distinguer : absence, changement attendu, changement humain, conflit, suppression potentielle et information inconnue.

`cohorte reconcile --plan` est read-only. `cohorte reconcile --apply` applique uniquement les opérations autorisées, affiche le plan, sauvegarde un backup ou commit optionnel et écrit un journal. Les overrides humains sont préservés ; une collision devient `CONFLICT` et non une écrasement automatique.

`cohorte update` met à jour les templates et schemas de Cohorte ; `cohorte reconcile` adapte le projet. Les deux opérations sont séparées pour permettre une revue indépendante.

## 14. Structure `.cohorte/` dans un projet utilisateur

```text
.cohorte/
├── manifest.yaml                  # version, origine et compatibilité
├── config.yaml                    # choix humains versionnés
├── project.yaml                   # Project Model, généré mais éditable avec provenance
├── conventions.md                 # connaissance humaine/LLM
├── ownership.yaml                 # règles humaines et générées
├── specs/                         # specs structurées, versionnées
├── prompts/                       # overrides explicites, versionnés
├── skills/                        # skills locales, versionnées
├── generated/                     # dérivé, réconciliable
│   ├── agents/
│   ├── contracts/
│   └── checks/
├── state/                         # gitignored par défaut
│   ├── runs/
│   ├── events/
│   ├── snapshots/
│   ├── locks/
│   └── cache/
└── worktrees/                     # gitignored ou emplacement externe
```

Par défaut, versionner `manifest.yaml`, `config.yaml`, specs, conventions, ownership et overrides. Ignorer state, cache, logs, credentials, transcripts complets et worktrees. Un projet MAY choisir de versionner des snapshots ou événements expurgés.

Les templates générés comportent une provenance et ne doivent être remplacés que si l’empreinte précédente correspond encore. Un fichier modifié par l’humain est protégé. `--force` est réservé à une commande explicite, affiche les fichiers et exige confirmation/approval selon policy.

## 15. Worktrees, concurrence et intégration Git

Chaque agent de build modifiant le code travaille dans un worktree dédié. Les reviewers sont read-only sur une référence immuable. Les agents qui partagent une surface sont sérialisés ou utilisent un mécanisme de réservation.

```text
main checkout
├── worktree/run-42/backend
├── worktree/run-42/frontend
├── worktree/run-42/tests
└── worktree/run-42/reviewer (read-only ref)
```

Le merge est une opération Cohorte explicite : vérification de base, tests, détection de conflits, application, revalidation et event. Aucun agent ne doit merger directement dans la branche protégée sans capability et approval. Un run concurrent sur le même repository doit obtenir un lock de projet et déclarer ses zones ; les runs indépendants peuvent coexister.

## 16. Dogfooding de Cohorte

Cohorte doit être capable de développer son propre repository. Au démarrage d’un run, Cohorte capture : version de l’application, manifest de packages, hash Git, schemas, prompts, skills, configuration et `AgentRuntime` actif. Ce snapshot est immuable pour la durée du run.

Toutes les modifications vont dans des worktrees. Le code nouvellement construit ou mis à jour n’est activé qu’au prochain run, après tests, review et installation/packaging validés. Une auto-mise à jour ne peut pas modifier le processus parent en mémoire.

Tests de dogfooding MUST vérifier :

- `init` puis `reconcile --plan` ne produit pas de drift inattendu sur une checkout propre ;
- Cohorte peut ajouter une petite feature à Cohorte dans un worktree ;
- le run continue avec le snapshot précédent ;
- le nouveau binaire/runtime est utilisé seulement après redémarrage ;
- une migration de state reste lisible par la nouvelle version ;
- une modification non autorisée du runtime actif est refusée.

## 17. Cohorte Protocol

Le protocole public est versionné, documenté par JSON Schema et indépendant de Pi. Transports possibles : NDJSON sur stdin/stdout pour CLI, Unix socket pour daemon local, HTTP/WebSocket optionnel. Le transport exact peut rester une décision V3.0, mais les envelopes et sémantiques doivent être identiques.

### 17.1 Envelope

```json
{
  "protocolVersion": "1.0",
  "eventId": "evt_123",
  "sequence": 42,
  "timestamp": "2026-09-18T10:00:00Z",
  "runId": "run_42",
  "type": "agent.tool.completed",
  "source": "cohorte",
  "payload": {},
  "redactions": []
}
```

Events minimum : `pipeline.started/completed/failed`, `phase.started/completed`, `agent.declared/spawned/started/completed/failed`, `tool.requested/started/completed/denied`, `model.requested/responded`, `context.built`, `file.read/written/changed`, `review.started/finding/approved`, `approval.requested/resolved`, `budget.updated`, `run.paused/resumed/cancelled`, `error`, `checkpoint.created`.

Le protocole doit exposer à François l’intention métier, le rôle, la phase, le modèle, le mode d’authentification, le quota d’abonnement, le coût seulement lorsqu’il s’applique, les tokens, le contexte, les fichiers, les diffs et les approvals. Il ne doit pas exiger que François comprenne les events Pi.

### 17.2 Commandes

`start`, `status`, `pause`, `resume`, `cancel`, `approve`, `deny`, `retry`, `skip` (si policy), `inspect`, `tail`, `run-tool` (admin explicite), `reconcile` et `shutdown`.

Les commandes portent un `commandId`, sont authentifiées par transport local, idempotentes et produisent un event de résultat. `pause` arrête les nouveaux effets mais laisse une opération atomique se terminer ; `cancel` annule ce qui est annulable et marque le run durablement.

## 18. François

François est un control plane facultatif. Il démarre et supervise des runs, affiche le graphe pipeline, agents, modèles, abonnements utilisés, quotas, coûts API éventuels, contexte, fichiers et diffs, présente les approvals, et envoie les commandes du protocole. Il ne crée pas lui-même les agents, ne contient pas la policy métier et ne parle pas directement à Pi.

Une intégration minimale doit fonctionner avec `cohorte run --json` sans François. Une panne de François ne doit pas arrêter un run, sauf si une approval bloquante est en attente.

## 19. Observabilité et accounting

Trois niveaux :

- logs structurés pour diagnostic ;
- événements durables pour replay et UI ;
- métriques/traces pour performance, quotas d’abonnement et coûts API éventuels.

Chaque appel modèle enregistre provider, modèle, mode d’authentification, durée, tokens input/output/cache, quota/limite connu, `monetaryCost` (`not_applicable` en mode abonnement), statut, retry et hash du contexte. Chaque tool enregistre arguments redacted, décision de policy, durée, sortie tronquée/hashée, fichiers touchés et code de sortie.

Les transcripts complets peuvent être lourds ; ils doivent être compressés, référencés et soumis à rétention configurable. Les secrets, tokens, valeurs `.env`, clés privées et données explicitement sensibles sont redacted avant logs et events.

## 20. Persistence et migrations

Le state store doit offrir : append event, snapshot atomique, lecture par run, recherche par sequence, lock et transaction. Une première implémentation MAY utiliser SQLite local avec JSON columns ; une abstraction doit permettre un store fichier/remote ultérieur.

Tables/concepts minimum : `runs`, `phases`, `agents`, `events`, `artifacts`, `approvals`, `budgets`, `locks`, `migrations`.

Les migrations de state et de configuration sont numérotées, monotones, testées sur fixtures et exécutées avant lecture. Une version incompatible doit s’arrêter avec une instruction de migration, jamais supprimer silencieusement un run. Les snapshots conservent `schemaVersion` et `cohorteVersion`.

## 21. CLI V3

Commandes minimum :

```text
cohorte init [path]
cohorte doctor [path]
cohorte discover [path] [--semantic]
cohorte update [--check|--apply]
cohorte reconcile [--plan|--apply]
cohorte brainstorm <input>
cohorte spec <id|input>
cohorte run <spec> [--phase ...] [--model ...]
cohorte status [run-id] [--watch|--json]
cohorte resume <run-id>
cohorte pause <run-id>
cohorte cancel <run-id>
cohorte approve <approval-id>
cohorte deny <approval-id>
cohorte logs <run-id>
cohorte diff <run-id>
cohorte review <run-id>
cohorte fix <run-id>
cohorte ship <run-id>
cohorte providers list|test
cohorte models list
cohorte auth login|status|logout
cohorte config get|set|validate
cohorte migrate [--check|--apply]
```

Chaque commande propose une sortie humaine et `--json` stable. Les erreurs affichent cause, impact, run, prochaine action et code de sortie. Les commandes mutantes demandent confirmation selon policy, mais doivent être automatisables avec `--yes` dans CI quand la policy l’autorise.

## 22. Formats de sortie structurés

Les agents retournent un envelope commun :

```json
{
  "status": "completed",
  "summary": "...",
  "artifacts": [{"path":"...","kind":"diff","sha256":"..."}],
  "findings": [],
  "checks": [{"name":"test","status":"passed","command":"..."}],
  "questions": [],
  "confidence": 0.87
}
```

Les reviewers retournent des findings avec severity, rule, location, reproduction, expected, actual, confidence et suggestedFix. Un finding sans localisation/reproduction est `needs-investigation`, pas automatiquement `major`.

## 23. Sécurité

Threat model minimum : prompt injection dans le repository, exfiltration de secrets, commande destructrice, écriture hors ownership, provider non autorisé, agent compromis, event forgé, corruption de state, symlink escape, fork bomb, supply-chain, fuite de transcript et escalation abusive.

Mesures MUST : résolution canonique des chemins, refus des symlinks sortants selon policy, allowlist de commandes, redaction, isolation de processus, limites de ressources, vérification d’intégrité du snapshot, validation des schemas, séparation des identities, journal append-only local, approvals signées/loggées et absence de privilèges root.

## 24. Gestion des erreurs

Les erreurs sont classées : `configuration`, `validation`, `permission`, `security`, `provider-transient`, `provider-terminal`, `tool-transient`, `tool-terminal`, `conflict`, `budget`, `timeout`, `corruption`, `human-required`.

Chaque erreur possède code stable, message, cause chaînée, retryability, phase/agent, remediation et event. Les erreurs inattendues arrêtent le run en `FAILED` avec checkpoint récupérable. Une erreur de sécurité met le run en `BLOCKED` et exige inspection humaine.

## 25. Tests, CI et fixtures

### 25.1 Unit tests

Tester state transitions, guards, policy engine, ownership, budgets, routing, context manifests, schemas, redaction, idempotency keys, Git path handling, migrations et drift classification.

### 25.2 Integration tests

Utiliser un fake runtime et un fake provider déterministes pour tester spawn, streaming, tool interception, pause/resume, retries, approvals, event protocol, SQLite, worktrees et reconciliation.

### 25.3 E2E tests

- fixture TypeScript monorepo ;
- fixture frontend/backend ;
- fixture projet inconnu avec ambiguïtés ;
- fixture permissions et secrets ;
- crash à chaque transition ;
- provider timeout/rate limit ;
- review trouvant puis corrigeant une faille ;
- run concurrent ;
- dogfooding Cohorte.

La CI MUST exécuter lint, typecheck, unit, integration, schema compatibility, security tests, packaging et au moins un E2E avec fake provider. Les tests live provider sont séparés, opt-in et budgetés.

## 26. Compatibilité OS et distribution

V3.0 cible macOS et Linux x64/arm64 avec Node.js LTS supporté. Les opérations nécessitant sandbox native doivent avoir une dégradation détectable et documentée. Windows est **Open Question** ; ne pas promettre la parité avant validation des worktrees, signaux, permissions et sandbox.

Distribution recommandée : package npm/pnpm et binaire packagé optionnel. Le package doit embarquer prompts, schemas, skills et migrations avec hashes. `cohorte self-update` MAY exister plus tard ; une mise à jour ne remplace jamais le runtime d’un run actif. Les versions sont semver mais un changement de schema incompatible exige une migration explicite.

## 27. V2 → V3 full-breaking

V3 ne maintient pas les adapters Claude/Codex/Cursor/Gemini/OpenCode. Les anciens fichiers peuvent être lus par un importeur ponctuel, mais ne font pas partie du runtime.

Migration proposée :

1. `cohorte-v2 export` produit un bundle de specs, conventions, ownership, agents et historique utile ;
2. `cohorte init --from-v2 bundle` crée `.cohorte/` et marque les inférences ;
3. `cohorte reconcile --plan` montre les fichiers générés et conflits ;
4. l’utilisateur valide config, providers, permissions et ownership ;
5. un run dry-run avec fake provider valide le pipeline ;
6. V3 devient la source d’exécution.

Dépréciations/suppressions : commandes/adapters runtime historiques, hooks spécifiques à chaque coding-agent, logique de workflow uniquement Markdown, formats non versionnés et assumptions implicites de Claude Code. Les prompts et doctrine utiles peuvent être importés après revue.

## 28. Milestones

### V3.0 — runtime et orchestration

- monorepo TypeScript ;
- `AgentRuntime` et `PiRuntime` ;
- un provider réel + fake provider ;
- tools, permissions, ownership, worktrees ;
- state machine persistante ;
- build/test/review/fix ;
- event protocol NDJSON ;
- CLI status/resume/pause/cancel ;
- budgets et logs ;
- dogfood sur une petite feature Cohorte.

### V3.1 — intelligence projet

- discovery déterministe + sémantique ;
- Project Model et `.cohorte/` ;
- desired state, drift et reconcile ;
- routing multi-provider ;
- migrations V2 ;
- dashboards/François consommant le protocole.

### V3.2+

- sandbox renforcé par OS ;
- remote daemon et runs distribués ;
- cache/context compaction avancé ;
- stratégies de merge et coordination plus riches ;
- marketplace/registry de skills signé ;
- support de nouveaux runtimes via `AgentRuntime` ;
- Windows si décision positive.

## 29. Critères d’acceptation

La V3.0 est acceptable quand :

- un repository fixture peut être initialisé, recevoir une spec et exécuter `build → test → review → fix` sans orchestration manuelle ;
- le workflow et ses arrêts sont décidés par TypeScript/state machine, pas par une instruction de prompt ;
- un agent ne peut pas écrire hors ownership ni exécuter une commande refusée ;
- un run interrompu reprend au dernier checkpoint sans doublon dangereux ;
- le mode abonnement, le provider, les tokens, quotas, modèle, tools, fichiers et approvals sont observables ; aucune facturation API ne peut apparaître sans activation explicite ;
- Pi peut être remplacé par un fake runtime dans les tests ;
- François peut afficher et contrôler le run via le protocole sans connaître Pi ;
- les prompts, schemas et code sont packagés et hashés ;
- une mise à jour de Cohorte ne change pas un run actif ;
- Cohorte peut modifier Cohorte dans un worktree et activer le nouveau code uniquement au run suivant ;
- `cohorte reconcile --plan` détecte un drift et ne détruit aucun override humain ;
- les tests unitaires, intégration, E2E, sécurité et migration passent en CI.

La V3.1 est acceptable quand `init/update/reconcile` fonctionne sur au moins trois stacks distinctes et que les ambiguïtés sont présentées à l’humain au lieu d’être transformées silencieusement en configuration.

## 30. Risques et mitigations

| Risque | Impact | Mitigation |
|---|---|---|
| API Pi instable ou trop spécifique | fort | contrat AgentRuntime, adapter isolé, fake runtime |
| Discovery sémantique incorrecte | fort | provenance, confidence, plan-only, approval |
| Boucles coûteuses/infinies | fort | budgets durs, arrêt déterministe, détection de répétition |
| Prompt injection | critique | contenu repo non fiable, policy code, sandbox, secrets isolés |
| Conflits d’agents | fort | ownership, reservations, worktrees, merge explicite |
| State corruption | fort | event log, snapshots atomiques, migrations, backups |
| Fuite provider/transcript | critique | allowlist, redaction, contexte minimal, logs locaux |
| Différences OS | moyen/fort | doctor, capabilities détectées, cible OS explicite |
| Reconcile écrasant un humain | critique | provenance, hash précédent, conflits bloquants |
| Scope V3 trop large | fort | milestones, fake provider, dogfooding précoce |

## 31. Questions ouvertes

Ces points doivent être décidés avant le gel de l’API correspondante :

1. Quelle version et quel sous-ensemble exact de Pi V3 sont supportés ? SDK, subprocess, RPC ou combinaison ?
2. Le state store initial est-il SQLite, fichiers append-only, ou les deux ?
3. Quel niveau de sandbox est obligatoire sur macOS et Linux, et quelle garantie est acceptable sans sandbox native ?
4. François consomme-t-il uniquement NDJSON, ou faut-il définir immédiatement WebSocket/HTTP ?
5. Quels providers et modèles d’abonnement sont supportés officiellement au lancement, et comment gérer leurs variations de tool calling ?
6. Quelle politique de données impose-t-on au fallback multi-provider ?
7. Les commits sont-ils créés par Cohorte, par un release-agent ou seulement après approval humaine ?
8. Le merge automatique vers une branche de travail est-il V3.0 ou V3.1 ?
9. Windows est-il une cible officielle ou seulement best-effort ?
10. Quelle rétention par défaut pour transcripts, événements et coûts ?
11. Comment signer/distribuer les skills externes et leurs checks ?
12. Le semantic discovery peut-il utiliser un provider distant lors de `init`, ou doit-il fonctionner offline avec un modèle local ?
13. Quel schéma de licence et quelle politique de télémétrie opt-in pour la distribution publique ?
14. **Décidé dans ADR-0014 :** V3.0 conserve uniquement la continuité cockpit et le diagnostic sans exécuter V2 ; l'importeur `init --export-v2` / `init --from-v2` est V3.1. Le bundle, le mapping, le rollback et les critères d'acceptation sont définis dans `docs/v3/MIGRATION.md`.

## 32. Décisions de conception à préserver

- Cohorte est l’orchestrateur, Pi le runtime, François le cockpit.
- La boucle Cohorte est du code ; la boucle Pi est agentique.
- Les contrats `AgentRuntime` et `Cohorte Protocol` sont les deux frontières de découplage.
- Les agents sont bornés par contexte, ownership, capabilities, budget et worktree.
- Le repository utilisateur est analysé puis réconcilié à partir d’un desired state, sans écraser les overrides.
- Le runtime actif est immuable pendant un run ; le dogfooding est obligatoire pour valider la conception.
- Les choix non arrêtés restent des questions ouvertes et ne doivent pas être codés comme des invariants cachés.

Cette spécification est suffisamment normative pour démarrer l’implémentation par le contrat de runtime, le state store, le fake provider et un premier pipeline dogfood ; les détails listés comme ouverts doivent être tranchés avant de figer les interfaces publiques concernées.
