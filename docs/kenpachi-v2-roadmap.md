# Kenpachi V2 — roadmap vers un assistant autonome fiable

Date de référence : 15 août 2026  
Branche : `feat/voice-wake-jarvis`  
Baseline : `449bc10`

## 1. État réel

### Acquis

- wake local « Salut Kenpachi » avec ownership exclusif du micro ;
- appel WebRTC full-duplex, OAuth ChatGPT, GPT-Live-first et fallback GA ;
- chat/sidebar utilisables pendant l'appel ;
- routage vocal multi-bot, travail parallèle entre bots et file par bot ;
- status, steering, follow-up, cancel et approbations exactes ;
- tâches agent indépendantes de la durée de l'appel ;
- routines durables créables et pilotables par la voix ;
- transcript vocal local sans audio brut, historique et suppression ;
- Gmail, Drive, Calendar, Pennylane, Pi Memory, CUA, peer agents et VM ;
- application macOS signée, installée et couverte par 333 tests réussis.

### Écart principal

Kenpachi est déjà une bonne **interface vocale vers des agents**, mais pas encore
un assistant autonome complet. Il lui manque surtout :

1. un registre unique et durable de tout le travail ;
2. une mémoire de travail structurée issue des conversations ;
3. un moteur de signaux et de politiques proactives ;
4. une vue « mission control » ;
5. une orchestration par objectifs et dépendances plutôt que par prompts isolés ;
6. une recette mesurée de fiabilité, latence et récupération.

## 2. Invariants de conception

1. **Une voix, plusieurs agents, un seul propriétaire par tâche.**
2. **Aucune action annoncée avant un événement terminal réel.**
3. **Aucune permission sensible décidée par le modèle vocal.**
4. **Aucune tâche immédiate transformée implicitement en routine.**
5. **Pi Memory reste la mémoire canonique** ; pas de second graphe mémoire.
6. **Pas d'audio brut conservé.** Les transcripts sont locaux, bornés et effaçables.
7. **La proactivité est une politique, pas un prompt** : urgence, déduplication,
   heures silencieuses, snooze, canal et limites sont déterministes.
8. **Le chat doit toujours survivre à une panne vocale.**
9. **Chaque tâche autonome possède un reçu** : origine, cible, état, résultat,
   coût, outils, approbations, timestamps et raison d'arrêt.
10. **Le chemin court reste lisible** : les features vivent dans leurs modules ;
    `server/index.ts` compose mais n'absorbe plus leurs règles métier.

## 3. Ordre recommandé

| Priorité | Lot | Impact | Effort | Dépend de |
| --- | --- | --- | --- | --- |
| P0 | A — registre global du travail | très élevé | L | baseline actuelle |
| P0 | B — durcissement sécurité/observabilité | très élevé | M | A partiel |
| P1 | C — mémoire de travail post-appel | élevé | M | A |
| P1 | D — moteur de proactivité | très élevé | L | A + C |
| P1 | E — Mission Control | élevé | M | A + D |
| P1 | F — fiabilité et qualité vocale | élevé | M | instrumentation B |
| P2 | G — capacités rapides déterministes | moyen/élevé | L | A + B |
| P2 | H — orchestration multi-agent par objectifs | très élevé | XL | A + D + E |
| P2 | I — perception écran multimodale | élevé | L | B + H |
| P3 | J — mobile, distance et Home Assistant | élevé | XL | B + D |

## 4. Lot A — registre global et durable du travail

### Objectif

Unifier les tâches créées par le chat, la voix, les routines et `ask_bot` dans
un modèle commun. Aujourd'hui, `HarnessAgentConsultRuntime`, `RoutineManager`,
les tâches du `Store` et les événements provider possèdent chacun une partie de
la vérité.

### Contrat cible

```ts
type WorkItemState =
  | "queued"
  | "running"
  | "waiting_approval"
  | "waiting_input"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted_by_restart";

interface WorkItem {
  id: string;
  origin: "chat" | "voice" | "routine" | "peer" | "proactive";
  targetBotId: string;
  threadId: string;
  parentId?: string;
  objective: string;
  state: WorkItemState;
  priority: number;
  progress?: string;
  currentTool?: string;
  requestId?: string;
  result?: string;
  error?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}
```

### Propriétaires

- nouveau `server/work/registry.ts` : états, transitions, persistance, limites ;
- nouveau `server/work/projector.ts` : `RuntimeEvent` → transition de tâche ;
- `server/routines.ts` : timing seulement, référence un `WorkItem` ;
- `server/realtime-voice/agent-consult.ts` : contrôle vocal d'un `WorkItem` ;
- `server/store.ts` : conversations/messages, pas état autonome parallèle ;
- `server/index.ts` : composition et routes, pas règles de transition.

### Comportements

- file FIFO/priority par bot et plafond global configurable ;
- idempotence par `workItemId` et fencing des anciens événements ;
- parent/enfants pour peer agents ;
- récupération au redémarrage : aucun état `running` fantôme ;
- retry explicite uniquement pour erreurs classifiées récupérables ;
- résultat terminal unique et reçu durable ;
- status/cancel/steer par ID ou par bot sans ambiguïté ;
- rétention bornée et suppression locale.

### Gate

1. Lancer deux tâches sur deux bots et deux tâches séquentielles sur le même bot.
2. Raccrocher, rouvrir et demander leur état.
3. Redémarrer l'application pendant une tâche et obtenir un reçu
   `interrupted_by_restart`, jamais `running`.
4. Aucun résultat ou événement d'une ancienne génération ne modifie une nouvelle tâche.

## 5. Lot B — sécurité, contrats et observabilité

### Sécurité locale

- répertoires voix/travail en `0700`, fichiers sensibles en `0600` ;
- rotation/révocation OAuth testée ;
- routes Realtime et Mission Control loopback + Origin strict ;
- censure centralisée des tokens, emails sensibles et payloads provider ;
- politique de rétention explicite pour transcripts, résultats et captures ;
- journal d'audit des approvals et actions autonomes, sans raisonnement brut.

### Contrats

- schémas runtime uniques pour API, SSE et UI au lieu de DTO recopiés ;
- IDs de session, tâche, thread et request distingués par types de domaine ;
- validateurs fermés pour événements Realtime, routines et transitions ;
- erreurs nommées : auth, entitlement, réseau, timeout, approval, provider,
  restart et policy.

### Observabilité

- métriques : connexion, latence transcript→délégation, durée tâche, tool,
  approval, barge-in, reconnect, queue, routine, coût et résultat ;
- timeline corrélée `voiceSessionId → workItemId → turnId → requestId` ;
- panneau diagnostic exportable avec secrets retirés ;
- seuils et alertes locales, pas de télémétrie audio.

### Hardening architectural

`server/index.ts` (environ 1 827 lignes) reste un point de risque car il plie
les événements, possède `startTurn`, les routes et plusieurs politiques. Ne pas
le découper arbitrairement : extraire verticalement, dans cet ordre :

1. projection `RuntimeEvent` vers messages/travail ;
2. routes Realtime ;
3. routes routines/work ;
4. composition `startTurn` derrière un `TurnCoordinator` explicite.

Chaque extraction doit laisser une petite registration visible dans `index.ts`
et conserver les mêmes tests E2E.

### Gate

- aucun secret dans réponses API, URLs, logs ou captures de diagnostic ;
- chaque erreur live possède une catégorie, une corrélation et une action utilisateur ;
- test chaos : coupure réseau, renderer fermé, sideband mort, OAuth expiré,
  provider exit 0 sans réponse, et application tuée pendant un outil.

## 6. Lot C — mémoire de travail post-appel

### Objectif

Transformer un appel terminé en contexte utile, sans mémoriser automatiquement
toute parole comme une vérité durable.

### Pipeline

```text
transcript final local
  → extraction asynchrone bornée
  → décisions / engagements / questions / échéances / préférences candidates
  → validation utilisateur pour les souvenirs durables
  → Pi Memory Hub memory_write/correct/forget
  → carte compacte injectée au prochain appel
```

### Données

- `workingState`: décisions, engagements, questions ouvertes et deltas ;
- `memoryCandidates`: faits/préférences avec extrait source et confiance ;
- `followUpCandidates`: actions proposées mais jamais planifiées implicitement ;
- `recentCallMap`: résumé compact déjà présent, enrichi par provenance.

### UX

- carte « Retenu de cet appel » après raccrochage ;
- actions : conserver, corriger, ignorer, oublier ;
- « Qu'avons-nous décidé hier ? » consulte d'abord la carte, puis le transcript
  complet uniquement à la demande ;
- aucune écriture mémoire pour une conversation ambiguë ou captée par erreur.

### Gate

- un engagement parlé apparaît comme candidat, pas comme tâche exécutée ;
- une préférence corrigée supersède l'ancienne mémoire ;
- suppression transcript + oubli mémoire vérifiés séparément ;
- extraction n'allonge pas la fermeture d'appel.

## 7. Lot D — moteur de proactivité contrôlée

### Signaux V1

1. tâche/routine terminée, bloquée ou échouée ;
2. réunion proche ou modifiée ;
3. email explicitement urgent/VIP ;
4. facture/document attendu arrivé ;
5. anomalie Pennylane bornée ;
6. CI/build rouge sur un projet surveillé ;
7. approbation en attente depuis trop longtemps.

### Architecture

- `server/proactive/signals.ts` : événements normalisés ;
- `server/proactive/policies.ts` : urgence, quiet hours, canal, dédup, snooze ;
- `server/proactive/engine.ts` : évaluation et création de notification/work ;
- `server/proactive/sources/*` : Gmail, Calendar, Pennylane, work registry, CI ;
- `server/proactive/receipts.ts` : pourquoi l'utilisateur a été interrompu.

### Politique minimale

```ts
interface ProactivePolicy {
  enabled: boolean;
  quietHours: { from: string; to: string };
  vipSenders: string[];
  channels: Array<"dock" | "system" | "voice">;
  maxInterruptionsPerHour: number;
  dedupeWindowMinutes: number;
  requireConfirmationForActions: true;
}
```

### Règles

- le moteur peut observer et notifier ; agir nécessite routine/policy explicite ;
- voice seulement si l'utilisateur est présent et hors quiet hours ;
- sinon notification silencieuse dans Mission Control ;
- même signal dédupliqué par source + entité + version ;
- snooze et « ne plus me prévenir pour ceci » sont persistants ;
- chaque interruption explique sa source et sa règle.

### Gate

- 100 emails identiques produisent une seule notification ;
- aucune voix pendant quiet hours ;
- une routine échouée remonte même si l'appel est fermé ;
- désactiver une source arrête réellement ses polls et notifications.

## 8. Lot E — Mission Control

### Vue globale

- Now : tâches actives, bot, outil, durée, approval ;
- Next : queues et routines à venir ;
- Needs you : approvals, questions, erreurs récupérables ;
- Done : résultats non lus et reçus ;
- Signals : alertes proactives avec snooze/ignore ;
- Voice : session, transport, latence et transcription opt-in.

### Contrôles

- ouvrir la conversation propriétaire ;
- cancel/steer/retry avec conséquence explicite ;
- réordonner une queue sans toucher au tour actif ;
- approuver/refuser la demande exacte ;
- transformer un résultat en follow-up ou routine ;
- marquer lu, archiver et exporter le reçu.

### Gate

L'utilisateur peut fermer la voix, naviguer entre cinq bots et comprendre en
moins de dix secondes ce qui travaille, ce qui attend et ce qui a échoué.

## 9. Lot F — fiabilité et qualité conversationnelle

### Résilience

- reconnexion WebRTC réellement testée et reprise de captions ;
- heartbeat renderer/broker ;
- récupération après veille/réveil et changement Wi-Fi ;
- expiration 30 minutes avec renouvellement contrôlé ;
- fallback texte de la commande wake une seule fois ;
- session suivante sans double micro ni session serveur fantôme.

### Audio et latence

- mesurer p50/p95 wake→écoute, transcript→task, barge-in et premier audio ;
- calibrage micro et phrase wake dans Voice Settings ;
- endpointing adaptatif pour phrases courtes/longues ;
- casque, AirPods, haut-parleurs, bruit ambiant et écho ;
- personnalité vocale configurable : concis, silencieux, humour, langue ;
- résumer code/tableaux au lieu de les lire.

### Cibles

- barge-in p95 < 250 ms ;
- transcript final → création WorkItem p95 < 300 ms hors réseau ;
- zéro double commande après wake ;
- zéro appel `409 active session` sur navigation/reconnexion normale ;
- test soak 2 h sans fuite de piste micro, listener ou session.

## 10. Lot G — capacités rapides déterministes

### Pourquoi

Un agent complet est approprié pour raisonner et agir, mais trop lent pour
« quelle est ma prochaine réunion ? » ou « combien de tâches travaillent ? ».

### Premières capacités

- prochaines réunions et disponibilité ;
- compteurs mails urgents/VIP ;
- état des bots/tâches/routines ;
- lecture d'un résultat ou transcript précis ;
- scènes Home Assistant non sensibles plus tard.

### Limite d'architecture

Créer un petit registre de capacités déclaratives avec schéma, coût, risque et
propriétaire. Ne pas donner directement tous les MCP à GPT-Live. Les lectures
bornées peuvent être rapides ; raisonnement, écriture et actions restent dans le
harness et le système d'approbation.

### Gate

- réponse locale rapide mesurée ;
- même provenance et politique que le chemin agent ;
- aucune duplication d'un outil d'écriture ;
- fallback vers AgentConsult lorsqu'une requête dépasse le contrat rapide.

## 11. Lot H — orchestration multi-agent par objectifs

### Évolution

Passer de « demande à Codex puis Luna » à un graphe de travail :

```text
objectif
  ├─ recherche Gmail/Drive → Luna
  ├─ rapprochement Pennylane → bot comptable
  ├─ vérification technique → Codex
  └─ synthèse/risques → Chief of Staff
```

### Contrat

- objectif, contraintes, livrables et définition de fini ;
- étapes avec dépendances et parallélisme borné ;
- budget temps/coût/outils ;
- propriétaire de synthèse ;
- approval gates entre plan et actions ;
- possibilité de steer/cancel une étape ou tout le graphe.

### Règles

- une seule voix synthétise ; les sous-agents ne parlent pas simultanément ;
- chaque enfant est un `WorkItem` traçable ;
- pas de boucle `ask_bot` non bornée ;
- pas de « terminé » global si une étape requise est failed/unknown ;
- le plan peut être revu avant exécution des actions à impact.

### Gate

Le scénario factures Gmail + Drive + Pennylane produit un plan visible, trois
travaux parallèles, une synthèse unique, puis une approval exacte avant écriture.

## 12. Lot I — perception écran multimodale

### Parcours

« Regarde mon écran » crée un grant d'observation borné. « Clique sur valider »
requiert une cible inspectée, une preuve visuelle récente et une confirmation si
l'action est sensible.

### Protections

- CUA/Local VM conserve son lease mono-thread existant ;
- capture seulement sur demande ou grant temporaire visible ;
- redaction optionnelle des zones sensibles ;
- TTL pour captures et observations ;
- action liée à la fenêtre, géométrie et preuve observées ;
- aucun clic par coordonnées mémorisées après changement d'état.

### Gate

Observer → expliquer → proposer → confirmer → agir → vérifier, avec interruption
possible à chaque étape et aucun écran capturé après expiration du grant.

## 13. Lot J — mobile, distance et maison

### Mobile

- client PWA/WebRTC ou app native minimale ;
- appairage fort et Tailscale ;
- OAuth et outils restent sur le Mac ;
- reprise du même WorkItem/thread ;
- notifications push corrélées aux reçus.

### Home Assistant

- lectures capteurs/scènes comme capacités rapides ;
- actions ordinaires selon allowlist ;
- serrures, alarmes, portes et actions critiques avec confirmation forte ;
- état vérifié après commande, jamais succès supposé.

## 14. Validation continue

### À chaque lot

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm build:server
pnpm check:electron
```

Pour un livrable macOS : signature persistante, installation atomique,
`codesign --verify --deep --strict`, health check et smoke depuis
`/Applications/OpenMausBot.app`.

### Suites à ajouter

- transitions du Work Registry et restart recovery ;
- policies proactives avec horloge déterministe ;
- extraction mémoire et confirmation ;
- E2E Mission Control ;
- chaos WebRTC/OAuth/provider ;
- benchmark latence et soak audio ;
- scénario multi-agent factures ;
- tests de permissions multimodales.

### Environnement

Le projet déclare Node `>=24` mais le shell courant utilise encore Node 22. Les
tests passent, néanmoins la CI et les packages finaux doivent être alignés sur
Node 24 avant une modernisation du lockfile ou du compilateur.

## 15. Séquence de livraison proposée

### V2.1 — « Je sais exactement ce qui travaille »

- Lot A complet ;
- timeline minimale Mission Control ;
- reprise/restart ;
- notifications de résultat non lu.

### V2.2 — « Je me souviens sans inventer »

- Lot C ;
- candidats mémoire et engagements ;
- recall d'appel à la demande ;
- contrôles corriger/ignorer/oublier.

### V2.3 — « Je te préviens au bon moment »

- Lot D ;
- signaux tâche/routine/calendar/email ;
- quiet hours, dédup, snooze ;
- Mission Control complet.

### V2.4 — « Je coordonne une mission »

- Lot H ;
- plans, dépendances, budgets et synthèse ;
- scénario factures complet avec approval.

### V2.5 — « Je vois et j'agis avec toi »

- Lots F, G et I ;
- qualité vocale mesurée ;
- capacités rapides ;
- perception écran contrôlée.

### V3 — présence partout

- Lot J ;
- mobile distant ;
- Home Assistant ;
- politiques multi-canal.

## 16. Prochain lot concret recommandé

Commencer par **V2.1 / Work Registry**, pas par Home Assistant ou une nouvelle
UI spectaculaire. C'est le socle qui rend ensuite mémoire, proactivité,
orchestration, notifications et reprise fiables.

Découpage vertical :

1. définir `WorkItem` et ses transitions pures ;
2. persister un fichier borné atomiquement ;
3. projeter les `RuntimeEvent` d'une tâche vocale ;
4. migrer les receipts de routines ;
5. exposer `GET /api/work` et actions ciblées ;
6. afficher une barre Mission Control minimale ;
7. tester concurrence, approval, cancel, fermeture voix et restart ;
8. installer et valider avec deux bots réels.

**Définition de fini V2.1 :** après fermeture de l'appel ou redémarrage de
l'application, l'utilisateur peut demander « qu'est-ce qui travaille ? » et
obtenir une réponse exacte, corrélée à une timeline visible, sans tâche fantôme,
résultat perdu ni action ambiguë.
