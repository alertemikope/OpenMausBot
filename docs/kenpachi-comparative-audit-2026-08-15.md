# Kenpachi — audit comparatif du 15 août 2026

Plan appliqué : [`kenpachi-comparative-audit-plan.md`](./kenpachi-comparative-audit-plan.md)  
Cible : OpenMausBot `feat/voice-wake-jarvis` à partir de `e275215`.

## Références inspectées

Les quatre checkouts étaient propres. Ils ont été mis à jour avec
`git pull --ff-only`, sont restés en lecture seule et n'ont pas été modifiés.

| Projet | Checkout | Révision inspectée | Portée |
| --- | --- | --- | --- |
| OpenClaw | `/Users/mrsachou/Frameworks/OpenClaw` | `37763e4d7ef8` | health registry, heartbeat, admission |
| Hermes Agent | `/Users/mrsachou/Frameworks/hermes-agent` | `0c50bdbdea57` | gateway/cron health, leases, stale claims |
| OpenJarvis | `/Users/mrsachou/Frameworks/OpenJarvis` | `3042bfe3f1f7` | scheduler, connector health, phase metrics |
| OpenYabby | `/Users/mrsachou/Frameworks/OpenYabby` | `5c2dcafbb226` | queue, ownership, delivery terminale |

## Ce que les références prouvent

### OpenClaw — health comme contrat fermé

- les checks ont un ID stable, une sévérité fermée et un propriétaire ; un ID
  dupliqué est rejeté (`src/flows/health-check-registry.ts:5-25`) ;
- un finding sépare détection, message, cible et piste de réparation
  (`src/flows/health-checks.ts:5-47,104-115`) ;
- le heartbeat est une déclaration de scheduler déterministe avec cadence,
  phase et enablement explicites (`src/cron/heartbeat-monitor.ts:26-77`) ;
- le drain ferme l'admission avant le restart et suit les travaux racine au
  lieu d'espérer qu'ils finissent (`src/process/gateway-work-admission.ts:18-51,78-106`).

**Décision :** adopter les findings fermés et l'état explicite. Ne pas porter
son registry de plugins, son gateway ni son stockage SQLite dans Kenpachi.

### Hermes Agent — diagnostics sans contenu et ownership temporel

- le snapshot gateway interdit prompts, messages, arguments d'outils et
  historique, puis borne/redacte tout texte libre
  (`agent/monitoring/gateway_health.py:1-7,49-67`) ;
- ses métriques exposent up, busy, drainable, agents actifs et état, sans
  données utilisateur (`agent/monitoring/gateway_health.py:210-239`) ;
- cron expose fraîcheur du ticker, dernier succès, jobs en retard et jobs
  actifs (`agent/monitoring/cron_health.py:148-192`) ;
- le lease de turn est lié à l'identité et à la génération, fail-closed au
  timeout et n'évince jamais un owner actif (`gateway/turn_lease.py:27-39,58-76`).

**Décision :** adopter un health content-free et commencer par diagnostiquer
les travaux silencieusement figés. L'auto-reclaim reste un lot séparé : annuler
un vrai provider sur une simple durée serait une régression.

### OpenJarvis — lifecycle explicite mais scheduler moins durci

- démarrage/arrêt du poller ont un owner et un thread nommés
  (`src/openjarvis/scheduler/scheduler.py:76-126`) ;
- chaque exécution émet start/end et persiste résultat/erreur
  (`src/openjarvis/scheduler/scheduler.py:188-260`) ;
- les connecteurs partagent `is_connected`, `disconnect`, `sync` et
  `sync_status` (`tests/connectors/test_connector_health.py:51-70`).

**Décision :** conserver notre `RoutineManager` plus fermé, mais exiger un
statut runtime commun pour les futurs pollers Gmail/Calendar. Ne pas adopter
son KnowledgeStore : Pi Memory est déjà canonique.

### OpenYabby — résultat terminal et queue par owner

- priorité décroissante puis FIFO, états pending/processing/completed/failed et
  résultats bornés (`db/queries/agent-task-queue.js:40-87`) ;
- un set empêche deux processors de posséder le même agent
  (`lib/agent-task-processor.js:11-13`) ;
- résultat brut, statut et résumé vocal sont des livraisons différentes
  (`lib/agent-task-processor.js:20-25,125-157`).

**Décision :** déjà couvert par `WorkRegistry`, `WorkQueueCoordinator` et la
livraison vocale sérialisée. Ne pas ajouter PostgreSQL/Redis.

## Baseline Kenpachi

Portée inspectée : `server`, `src`, `electron`, tests et documents de roadmap.
Les scores sont prudents et suivent le rubric agent-native ; ils ne mesurent
pas la valeur produit.

| Axe | Score /10 | Preuve |
| --- | ---: | --- |
| Ownership agent-native | 6 | owners solides pour work/routines/voice/proactive, mais `server/index.ts` reste à 2 011 lignes et `src/state/store.tsx` à 1 356 |
| Sécurité des contrats | 6 | TypeScript strict et états fermés ; JSON externe encore casté et DTO API/SSE recopiés côté client |
| Traversabilité | 6 | modules verticaux lisibles ; composition, routes et projection provider encore concentrées dans `server/index.ts` |
| Couverture adaptée | 8 | états, restart, voix, routines, proactivité et API réelle couverts ; pas encore de chaos/soak ni E2E UI automatisé |
| Feedback loops | 7 | test, typecheck, builds et check Electron ; pas de commande agrégée unique ni lint architectural |
| Auto-documentation | 8 | invariants et roadmaps détaillés ; quelques compteurs/baselines datés restent à rafraîchir |

## Findings prioritaires

### P1 — le health check ne prouvait que l'identité du processus — livré

Avant ce lot, `GET /api/health` renvoyait uniquement app, pid et présence du
bundle. Aucun provider chargé, scheduler arrêté, routine en retard, travail
figé ou cancellation suspendue n'était visible.

Livraison :

- projection pure `server/health/snapshot.ts` avec codes et actions fermés ;
- statuts content-free possédés par Work Registry, Routine Manager et moteur
  proactif ;
- endpoint rapide qui conserve `app/pid/static` pour le handshake Electron ;
- carte Settings → General → Runtime health avec refresh explicite ;
- diagnostic seulement : aucune relance, cancellation ou mutation implicite.

Gate : provider absent, travail stale, cancellation suspendue, scheduler
arrêté et routine overdue sont testés ; les intégrations optionnelles et la
voix idle ne dégradent pas la santé.

### P1 — pollers externes proactifs non livrés

Calendar, Gmail, Pennylane et CI existent dans le contrat de policy mais n'ont
pas encore de source owner avec poll lifecycle, cursor, deadline et health.
Le prochain lot doit introduire **un** contrat de source générique, puis
Calendar et Gmail via le `gws` local déjà installé. Une source désactivée ne
doit ni démarrer ni planifier de timer ; une source indisponible doit rester
visiblement unavailable, jamais sembler activée.

### P1 — activité provider figée sans remediation

Le nouveau health signale un work `running` sans événement depuis 30 minutes
et une cancellation pendante depuis deux minutes. Il ne faut pas encore les
reclaim automatiquement. Le lot suivant doit distinguer deadline globale,
heartbeat d'outil, attente réseau et lease provider, puis échouer avec un reçu
terminal unique avant toute politique de retry.

### P2 — composition et contrats partagés

- extraire verticalement les routes health/proactive/work lorsque le prochain
  lot les touche, plutôt que découper `server/index.ts` arbitrairement ;
- produire les DTO API/SSE client depuis une source de vérité compatible avec
  les deux tsconfig, au lieu d'ajouter progressivement des copies ;
- ajouter une commande `check` agrégée après stabilisation, sans changer le
  compilateur ni le lockfile dans ce lot.

## Rejets explicites

- pas de second agent runtime, gateway, scheduler général ou Memory Store ;
- pas de nouvelle base PostgreSQL/Redis/SQLite uniquement pour imiter les
  références ;
- pas de heartbeat LLM périodique coûteux quand une projection locale suffit ;
- pas d'auto-cancel fondé uniquement sur l'âge ;
- pas de télémétrie externe ni de contenu utilisateur dans le health.

## Prochain gate concret

`ProactiveSource` doit posséder : `id`, `available`, `start`, `stop`,
`pollOnce`, deadline, cursor durable, dernier succès/échec classifié et zéro
timer lorsque disabled. Le premier smoke réel est : événement Calendar proche
→ un signal dock dédupliqué → disable Calendar → aucun poll ni signal suivant.
