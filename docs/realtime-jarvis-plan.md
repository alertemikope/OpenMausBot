# OpenMausBot « Agent IA + Jarvis » — plan de mise en œuvre

Ce document décrit la migration du mode vocal half-duplex actuel vers une
conversation temps réel bidirectionnelle utilisant `gpt-live-1-codex` avec
l'authentification OAuth ChatGPT, puis les évolutions nécessaires pour faire
d'OpenMausBot un assistant de type Jarvis sans remplacer son harness d'agents.

> **État courant — 15 août 2026, après implémentation.** Les sections 0.1 à
> 0.7 conservent le dossier historique d'avant chantier pour l'audit. Elles ne
> décrivent plus l'état du code. Le runtime installé est désormais
> full-duplex WebRTC, OAuth ChatGPT chiffré, GPT-Live-first avec fallback
> abonnement `gpt-realtime-2.1`, délégation parallèle vers des bots nommés,
> contrôle continu, confirmations liées au `requestId`, wake Kenpachi et interface
> accessible. ElevenLabs et le chemin d'appel half-duplex ont été retirés.

### Statut de livraison actuel

| Milestone | Statut | Preuve principale |
| --- | --- | --- |
| 1 — Conversation temps réel | terminé pour le transport | appel installé connecté, audio bidirectionnel, sous-titres et barge-in |
| 2 — AgentConsult | multi-bot livré | catalogue borné, cible explicite, routage par nom et exécution parallèle par bot |
| 3 — Contrôle continu | multi-tâche livré | status multi-bot, contrôle ciblé, file par bot, tâches conservées après raccrochage |
| 4 — Approbations | terminé côté code et tests | confirmation exacte, expiration et propriété `threadId`/`requestId` |
| 5 — Kenpachi/UX | partiel | wake, dock global, navigation et orchestration multi-bot livrés ; journal/mémoire vocale en cours |
| 6 — Retrait legacy | terminé | aucune clé ElevenLabs requise ; TTS ponctuel local macOS seulement |

L'état ne doit plus être résumé comme « Jarvis terminé ». Le transport, le
chemin sûr vers les agents nommés et l'orchestration multi-bot fonctionnent ;
les écarts restants portent maintenant sur le registre global du travail, la
mémoire structurée et la proactivité. La première correction UX rend le contrôleur
WebRTC global à la fenêtre : changer de conversation ne le démonte plus, le chat
reste utilisable sous un panneau compact, un second appel concurrent est refusé
avant l'API, et les commandes explicites « Ouvre/Affiche/Va sur <bot> » changent
la conversation visible localement. Le prochain lot requis pour un vrai Jarvis
était le catalogue vocal de cibles, la délégation explicite à un autre bot et le
suivi parallèle de plusieurs tâches. Ce lot est maintenant implémenté côté
serveur et UI : `target_id` validé contre le catalogue, inférence prudente des
phrases « Demande à <bot> », une file par bot, parallélisme entre bots, status
global après reconnexion et résultats GA sérialisés. Le smoke test installé a
réussi : appel Luna actif, délégation Realtime avec l'ID exact de Codex, Luna et
Codex visibles simultanément dans le dock, puis résultat exact
`VOICE_MULTI_TARGET_OK` dans la conversation Codex. Le lot est donc livré.

La continuité de voix ajoute maintenant un journal local borné des segments
finalisés, sans audio brut, et injecte seulement une carte compacte des appels
récents dans la session suivante.

La livraison vocale GA suit désormais aussi les réponses déjà initiées par le
fournisseur (`response.created` → `response.done`). Si un agent termine pendant
que Jarvis prononce encore son accusé de réception, le résultat reste en file et
obtient sa propre prise de parole dès que la voix est libre ; aucun
`response.create` concurrent ne peut laisser un résultat visible mais non
annoncé.

L'autonomie planifiée est aussi reliée au dialogue : « planifie chaque jour… »,
« mets en pause la routine… », « liste mes routines » ou « lance maintenant… »
passent par un contrat structuré dédié et le `RoutineManager` durable existant.
Une demande immédiate ordinaire ne devient jamais implicitement récurrente.

Recette live du 15 août 2026 sur l'application réellement installée :

- connexion `gpt-realtime-2.1` OAuth/WebRTC, audio entrant et sortant ;
- tâche non destructive longue avec statut réel (`sleep 60`, outil et durée) ;
- steering Codex accepté avec `expectedTurnId` exact ;
- follow-up conservé pendant la tâche puis exécuté dans le même bot ;
- annulation résolvant proprement la tâche et la commande de contrôle, sans
  double `response.create` ni erreur fournisseur ;
- smoke test vocal strictement en lecture seule de Gmail, Google Drive et
  Pennylane : `CONNECTORS_OK` ;
- wake acoustique réel prononcé par l'utilisateur, ouverture de l'overlay,
  réponse Jarvis réussie, fermeture de session propre et listener réarmé.

La recette acoustique a révélé deux dépendances locales désormais traitées :
Dictée macOS était désactivée (`kLSRErrorDomain:201`) et Apple transcrit le nom
fictionnel « Kenpachi » sous la forme « Kim Paty ». Dictée a été activée avec
l'accord explicite de l'utilisateur et le helper garde une liste d'alias
étroite pour la phrase livrée, sans fuzzy matching général qui augmenterait
les faux déclenchements. Un mode diagnostic explicite peut afficher les
transcriptions pendant la calibration ; il est désactivé dans le listener de
production afin de ne pas journaliser les conversations ambiantes.
Sur macOS 27, le listener passif fonctionne par fenêtres d'énoncé locales :
une phrase sans déclencheur produit un événement interne `wake_idle`, puis
Electron relance immédiatement une fenêtre propre sans compter un échec.

Une capture de recette a aussi révélé un thread Codex repris contenant un
appel d'outil sans résultat. La cause était l'ancien hard-kill du processus au
milieu d'un outil. Le driver utilise maintenant `turn/interrupt` avec le
`threadId` et le `turnId` natifs, attend le terminal borné, puis tue seulement
en fallback. Si un ancien curseur déjà corrompu renvoie exactement l'erreur
`Custom tool call output is missing`, il démarre une fois un thread natif
propre, republie le nouveau curseur et rejoue la demande ; les autres erreurs
restent fermées sans retry ambigu. La variante réelle où Codex écrit seulement
l'erreur sur stderr puis quitte avec le code 0 est également traitée : avant
`thread/resume`, OpenMausBot vérifie le rollout JSONL local et ignore le curseur
s'il contient un `custom_tool_call` sans `custom_tool_call_output` correspondant.

Les installations locales sont enfin signées avec une identité persistante
créée dans le trousseau (`OpenMausBot Local Development`) au lieu d'une
signature ad hoc liée au CDHash. La transition demande une dernière validation
des permissions macOS, puis les recompilations et relances conservent les
autorisations TCC du bundle principal et du helper vocal.

Le seul écart fournisseur est explicite : le compte OAuth courant reçoit
`Voice session access denied` pour `gpt-live-1-codex` et
`gpt-live-1-boulder-alpha`. Le même abonnement accepte `gpt-realtime-2.1`.
OpenMausBot tente donc GPT-Live en premier et ne bascule vers GA Realtime que
sur ce 403 précis, sans clé API Platform ni fallback payant silencieux.
Ce comportement est cohérent avec l'issue OpenClaw
[#104683](https://github.com/openclaw/openclaw/issues/104683) : GPT-Live est
WebRTC-only, son API reste soumise à entitlement, sa session full-duplex ne
doit pas recevoir les réglages VAD de GA Realtime, et `gpt-realtime-2.1` reste
le chemin disponible avant ouverture de l'accès GPT-Live.

## 0. Dossier de reprise pour une nouvelle session IA

Cette section est le point d'entrée opérationnel. Une nouvelle session doit la
lire entièrement, puis lire le reste de ce document avant d'écrire du code.

### 0.1 Prompt de démarrage historique (ne plus utiliser tel quel)

Le bloc suivant peut être donné tel quel à une nouvelle session :

```text
Tu reprends l'implémentation du runtime vocal Jarvis d'OpenMausBot.

Commence par lire entièrement :
/Users/mrsachou/Frameworks/OpenMausBot/docs/realtime-jarvis-plan.md

Le vrai dépôt de travail est :
/Users/mrsachou/Frameworks/OpenMausBot

Branche : feat/voice-wake-jarvis
HEAD de départ documenté : 6ab32de
Fork : https://github.com/alertemikope/OpenMausBot.git

Ne travaille pas dans /Users/mrsachou/Documents/Dev/Grok Bot : c'est le cwd
historique de la session, pas le checkout OpenMausBot à modifier.

État fonctionnel déjà acquis : Kenpachi local, wake → commande, appel legacy
Apple STT + ElevenLabs, Pi Memory Hub partagé, Google Workspace, Pennylane,
Codex/Claude/ACP, CUA, application macOS installée et contrôles Voice nommés
pour AT-SPI.

Le runtime GPT-Live n'est PAS encore implémenté. N'annonce pas le contraire.
L'objectif est de remplacer progressivement l'appel half-duplex par WebRTC +
gpt-live-1-codex via OAuth ChatGPT, tout en gardant le bot OpenMaus comme seul
propriétaire des outils, permissions, threads et résultats.

Références locales à étudier, sans recopier tout leur framework :
- OpenClaw : /Users/mrsachou/Frameworks/OpenClaw
- runtime voix Pi :
  /Users/mrsachou/.local/share/pi-codex-conversion-patched/6be11ed/node_modules/@howaboua/pi-codex-conversion
- Pi Memory MCP : /Users/mrsachou/Documents/Dev/Pi_Setup/dist/mcp/main.js

Contraintes absolues : aucun token OAuth dans React ou une URL, aucune
approbation sensible décidée par le modèle vocal, aucune deuxième base mémoire,
aucun fallback payant silencieux et aucune suppression du chemin ElevenLabs
avant que le remplacement GPT-Live soit testé de bout en bout.

Avant toute modification : vérifie git status, lis les propriétaires actuels,
confirme le protocole OpenClaw actuel /v1/live et établis le plus petit lot
vertical. Ne réécris pas server/index.ts en bloc. Préserve les changements
utilisateur et ne reset rien.

Premier objectif recommandé : Milestone 1 uniquement — contrats, OAuth
abstrait/testable, broker /v1/live, peer WebRTC renderer et fermeture propre,
sans encore brancher les MCP. Ajoute les tests de protocole et de cycle de vie
avant le test live.

À chaque lot : pnpm test, pnpm typecheck, pnpm check:electron, puis build. Pour
un livrable macOS : pnpm package:mac, installation réelle et test de
/Applications/OpenMausBot.app. Documente toute adaptation MIT d'OpenClaw dans
THIRD_PARTY_NOTICES.md.
```

### 0.2 État historique vérifié avant implémentation

| Élément | État |
| --- | --- |
| Dépôt OpenMausBot | `/Users/mrsachou/Frameworks/OpenMausBot` |
| Branche | `feat/voice-wake-jarvis` |
| HEAD | `6ab32de` |
| Branche distante | `origin/feat/voice-wake-jarvis`, au même commit |
| Fork | `alertemikope/OpenMausBot` |
| Upstream | `milind-soni/OpenMausBot` |
| Modifications locales | ce document, encore non suivi par Git |
| Application installée | `/Applications/OpenMausBot.app`, version `0.1.17` |
| Application en cours | oui lors de la dernière vérification |
| Wake word | activé avec `Salut Kenpachi` |
| Runtime GPT-Live | non implémenté |
| Appels actuels | half-duplex Apple STT + ElevenLabs |

La seule entrée affichée par `git status --short` à cette date est :

```text
?? docs/realtime-jarvis-plan.md
```

Ne pas supprimer ni écraser ce fichier. Le commiter séparément est recommandé
avant de commencer l'implémentation.

### 0.3 Dépôts et références absolues

| Projet | Chemin | Rôle | État connu |
| --- | --- | --- | --- |
| OpenMausBot | `/Users/mrsachou/Frameworks/OpenMausBot` | dépôt à modifier | branche `feat/voice-wake-jarvis`, HEAD `6ab32de` |
| OpenClaw | `/Users/mrsachou/Frameworks/OpenClaw` | référence GPT-Live actuelle | `main`, HEAD `7e0941270d`, checkout propre |
| Pi voice runtime | `/Users/mrsachou/.local/share/pi-codex-conversion-patched/6be11ed/node_modules/@howaboua/pi-codex-conversion` | référence WebRTC/délégation Pi | package installé, lecture seule |
| Pi Setup | `/Users/mrsachou/Documents/Dev/Pi_Setup` | propriétaire du Memory Hub | bridge compilé présent |
| Pi Knowledge | `/Users/mrsachou/Documents/Pi-Knowledge` | Markdown/Obsidian canonique | ne pas dupliquer |
| Application | `/Applications/OpenMausBot.app` | build réellement utilisé | version `0.1.17` |
| Installateurs | `/Users/mrsachou/Frameworks/OpenMausBot/release` | DMG et ZIP générés | présents, normalement ignorés par Git |

Ne pas modifier OpenClaw ni le package Pi pour réaliser le port. Ils servent de
références. Le code de production doit vivre dans OpenMausBot avec ses propres
tests et contrats.

### 0.4 Historique Git utile

Les deux commits propres à ce chantier sont déjà poussés :

```text
4e509b0 feat: add Kenpachi wake voice and shared Pi memory
6ab32de fix: label voice controls for accessibility
```

Le commit `4e509b0` a ajouté 977 lignes et touché 26 fichiers. Il contient :

- le mode wake dans le helper Apple Speech ;
- le gestionnaire de cycle de vie Kenpachi dans Electron ;
- la configuration persistante de la phrase ;
- le handoff wake → bot sélectionné ;
- l'intégration MCP Pi Memory pour les drivers compatibles ;
- les tests Codex, Claude et ACP associés ;
- la documentation et les attributions tierces.

Le commit `6ab32de` a corrigé l'accessibilité de `VoiceSettings.tsx` :

- switch nommé `Enable wake word` ;
- sections Voice et Wake word exposées ;
- boutons `Save wake phrase` et `Save ElevenLabs key` différenciés.

Commits antérieurs particulièrement pertinents :

```text
674ba65 feat: add direct local Google Workspace MCP
f5feff8 fix: fall back to signed CuaDriver host on macOS
ce025ba feat: enable explicit Codex computer MCP destinations
cbbe16c fix: handle Codex MCP approval elicitations
7e04cdf feat: mount Pennylane MCP across agent drivers
3515ad3 fix: mount Composio in Codex turns
```

### 0.5 Ce qui fonctionne déjà

#### Kenpachi et capture locale

- `electron/resources/speech-helper.swift` sait fonctionner en dictée normale
  ou en mode `--wake-word`.
- `electron/build-speech-helper.mjs` construit et emballe le helper signé sous
  forme de `OpenMausBot Speech.app`.
- `electron/wake-word-config.mjs` normalise et persiste la configuration.
- `electron/wake-word.mjs` lance le helper, lit son NDJSON, borne les retries,
  suspend l'écoute pendant une dictée ou un appel et la réarme ensuite.
- La configuration active se trouve dans
  `~/Library/Application Support/openmausbot/wake-word.json`.
- À la dernière vérification, elle contenait `enabled: true` et la phrase
  `Salut Kenpachi` ; un processus `speech-helper --wake-word` était actif.
- `electron/main.mjs`, `electron/preload.cjs` et `src/types/ogb.d.ts` exposent
  le bridge wake au renderer.
- `src/App.tsx` reçoit la commande, sélectionne le bot ou la room courante,
  ouvre l'appel et envoie le texte au harness.
- `src/lib/call.ts` suspend et reprend Kenpachi autour de l'appel.

Le wake listener est local : Electron ne reçoit que le texte final. Ce chemin
doit être conservé et devenir l'entrée de la session GPT-Live.

#### Mémoire partagée

- `server/pi-memory.ts` découvre le bridge Memory Hub sans copier son backend.
- Bridge actuellement trouvé :
  `/Users/mrsachou/Documents/Dev/Pi_Setup/dist/mcp/main.js`.
- Configuration client : `~/.pi/agent/pi-memory-hub.json`, permissions `0600`.
- Le bearer est résolu par le Trousseau macOS ou le client Memory Hub ; il
  n'apparaît ni dans OpenMausBot ni dans les arguments du processus enfant.
- `server/contracts.ts` possède l'intégration `memory`.
- `server/index.ts` la monte sur chaque tour lorsque le driver accepte les MCP
  stdio.
- `server/drivers/codex.ts`, `server/drivers/claude.ts` et
  `server/drivers/acp/core.ts` montent le MCP Pi Memory.
- Outils attendus : `memory_search`, `knowledge_search`, `memory_write`,
  `memory_correct`, `memory_forget` et `memory_status`.

Validation live réalisée dans la session précédente, non rejouée lors de la
présente mise à jour documentaire : API `ok`, Qdrant et oMLX disponibles,
recherche Obsidian avec provenance et test Codex OAuth → MCP mémoire retournant
`MEMORY_OK`.

#### Harness et outils agents

Le harness possède déjà :

- Codex app-server et OAuth géré par le CLI ;
- Claude et les moteurs ACP ;
- Google Workspace local via `gws` ;
- Pennylane via `mcp-pennylane` ;
- Composio ;
- ordinateur cloud, Local VM et Cua Driver sur le Mac ;
- peer agents via `list_bots` et `ask_bot` ;
- routines et Chief of Staff ;
- EventBus normalisé et approbations.

Le point d'entrée des tours est encore la fonction `startTurn` dans
`server/index.ts`. Le futur `AgentConsultRuntime` doit réutiliser ou extraire ce
propriétaire au lieu de créer une voie parallèle.

#### Appel vocal actuel

Le mode existant reste fonctionnel mais n'est pas le résultat final :

```text
Apple SFSpeechRecognizer
        ↓ transcript final après silence
startTurn du bot
        ↓ événements agent
ElevenLabs TTS
        ↓
réouverture du microphone
```

Propriétaires actuels :

- `src/components/CallView.tsx` — appel bot 1:1 ;
- `src/components/GroupCallView.tsx` — appel room ;
- `src/lib/call.ts` — propriétaire global de l'appel ;
- `src/lib/tts/index.ts` — file de lecture et interruption ;
- `server/tts/elevenlabs.ts` — client ElevenLabs ;
- `server/tts/speech-text.ts` — Markdown vers texte prononçable ;
- `server/index.ts` — routes `/api/tts/*` ;
- `docs/voice-mode.md` — décision half-duplex historique.

Le bouton d'appel vérifie encore `state.config.tts.configured`; Voice Settings
demande encore une clé ElevenLabs. Les regex d'approbation vocale actuelles
sont dans les vues d'appel et devront être remplacées par un contrôleur lié au
`requestId`.

#### Application et packaging

- `/Applications/OpenMausBot.app` version `0.1.17` est installée.
- L'application et son utility process harness étaient actifs lors de la
  dernière vérification.
- Le harness packagé est lancé depuis `electron/main.mjs` par
  `utilityProcess.fork` et sert l'UI sur `127.0.0.1`.
- Les logs sont dans `~/Library/Logs/OpenMausBot/server.log`.
- Les artefacts présents comprennent :
  `release/OpenMausBot-0.1.17.dmg` et
  `release/OpenMausBot-0.1.17-arm64.zip`.
- Le packaging macOS avec helper Speech et Cua Driver a déjà réussi.

### 0.6 Lacunes historiques au démarrage (désormais traitées)

Il n'existe actuellement dans OpenMausBot :

- aucun client `api.openai.com/v1/live` ;
- aucun modèle `gpt-live-1-codex` ;
- aucun broker SDP ;
- aucun `RTCPeerConnection` vocal ;
- aucun sideband GPT-Live ;
- aucun profil OAuth ChatGPT propre à OpenMaus ;
- aucun `delegation.created` relié à `startTurn` ;
- aucun contrôle vocal `status/steer/cancel/followup` du travail agent ;
- aucune séparation typée entre barge-in audio et annulation du travail ;
- aucune migration des voix ElevenLabs vers les voix GPT-Live.

Ne pas confondre le wake word validé avec le runtime Jarvis final. Aujourd'hui,
Kenpachi débouche encore sur l'appel legacy half-duplex.

### 0.7 Dépendances et outillage actuels

#### Versions du projet

| Dépendance | Version ou contrainte |
| --- | --- |
| package | `openmausbot@0.1.17` |
| package manager | `pnpm@10.33.0` |
| moteur déclaré | Node `>=24` |
| Node actif lors de la vérification | `v22.23.2` |
| React / React DOM | `^19.1.0` |
| Electron | `^43.4.0` |
| Vite | `^7.1.0` |
| TypeScript | `^5.8.3` |
| Vitest | `^4.1.10` |
| Cua Driver | `0.19.3` |

Le shell actuel utilise Node 22 alors que `package.json` déclare Node 24 ou
plus. Les tests passent encore, mais une nouvelle session doit basculer vers
Node 24+ avant toute installation, mise à jour de lockfile ou validation de
packaging afin d'éviter un résultat non reproductible.

#### Dépendances externes déjà utilisées

- toolchain Swift/macOS Speech pour le helper natif ;
- CLIs Codex, Claude, Antigravity, Grok ou Kimi selon les bots ;
- `gws` pour Google Workspace ;
- `mcp-pennylane` pour Pennylane ;
- Pi Setup Memory MCP ;
- Qdrant et oMLX derrière Pi Memory Hub ;
- Cua Driver et le runtime Local VM/OpenMaus.

#### Dépendances possibles pour GPT-Live

Aucune dépendance GPT-Live n'a encore été ajoutée à `package.json`.

- WebRTC côté renderer vient de Chromium/Electron : aucune bibliothèque WebRTC
  supplémentaire n'est nécessaire.
- `fetch`, `FormData` et les primitives HTTP existent dans le runtime Node.
- Le sideband requiert un client WebSocket acceptant des headers OAuth. Évaluer
  le support exact du runtime Electron/Node ; `ws` est le candidat simple si le
  client natif ne répond pas au contrat.
- La validation de messages peut rester fondée sur des guards étroits ou
  introduire une dépendance dédiée. Ne pas importer le graphe de dépendances
  d'OpenClaw uniquement pour obtenir ses schémas.
- Toute nouvelle dépendance doit être ajoutée à `package.json`, `pnpm-lock.yaml`,
  au build serveur packagé et, si nécessaire, aux notices de licence.

### 0.8 Fichiers sensibles et données locales

Ne jamais afficher, copier dans un prompt, commiter ou logger le contenu des
fichiers suivants :

- `~/.openmausbot/config.json` — clés Composio, Pennylane, Box et ElevenLabs ;
- `~/.pi/agent/pi-memory-hub.json` — configuration/authentification Memory Hub ;
- profils OAuth Pi, Codex ou futurs profils OAuth OpenMaus ;
- fichiers du Trousseau macOS ;
- transcripts ou données utilisateurs sous `~/.openmausbot/events` et
  `~/.openmausbot/native`.

Chemins non secrets utiles :

```text
~/.openmausbot/                         données du harness
~/Library/Application Support/openmausbot/ données Electron et wake word
~/Library/Logs/OpenMausBot/server.log   log du harness packagé
```

Les endpoints publics de statut ne doivent retourner que des booléens
`configured/authenticated`, jamais le secret lui-même.

### 0.9 Validations connues

Validation fraîche au moment de cette mise à jour :

```text
pnpm test
Test Files  38 passed (38)
Tests       303 passed | 8 skipped (311)

pnpm typecheck
exit 0

git diff --check -- docs/realtime-jarvis-plan.md
exit 0
```

Validations réalisées lors du lot Kenpachi précédent :

- build TypeScript/Vite ;
- vérification Electron ;
- packaging macOS ;
- installation réelle dans `/Applications` ;
- helper vocal en écoute ;
- switch wake AT-SPI nommé ;
- sections Voice/Wake word et boutons Save correctement différenciés ;
- Memory Hub live, Qdrant, oMLX et recherche Obsidian ;
- Codex OAuth utilisant le MCP mémoire.

Une nouvelle session doit rejouer les vérifications pertinentes après ses
propres changements, plutôt que considérer ces résultats historiques comme
une preuve du nouveau runtime.

### 0.10 Commandes de bootstrap

```bash
cd /Users/mrsachou/Frameworks/OpenMausBot

git status --short
git branch --show-current
git log -5 --oneline --decorate

node --version
pnpm --version

pnpm test
pnpm typecheck
pnpm check:electron
pnpm build
```

Développement :

```bash
# Terminal 1
pnpm dev:server

# Terminal 2
pnpm dev

# ou Electron en développement
pnpm dev:desktop
```

Packaging final :

```bash
pnpm package:mac
```

Ne pas lancer deux harnesses sur le même port en supposant que `8799` est
libre. L'application packagée sait essayer des ports alternatifs ; les scripts
de développement doivent être inspectés avant coexistence avec l'app installée.

### 0.11 Premier lot de travail conseillé

Une nouvelle session ne doit pas tenter les six milestones en un seul patch.
Le premier lot vertical recommandé est :

1. commiter ce document seul ;
2. ajouter les contrats `realtime-voice` et leurs tests ;
3. introduire une interface testable de résolution OAuth, sans encore stocker
   un vrai token ;
4. porter le strict minimum du wire `/v1/live` depuis OpenClaw avec attribution ;
5. créer le broker SDP avec jeton one-shot et faux serveur OpenAI ;
6. créer le peer WebRTC renderer audio-only avec un faux
   `RTCPeerConnection` en test ;
7. prouver création, fermeture, timeout et nettoyage sans agent consult ;
8. seulement ensuite effectuer un test live OAuth contrôlé.

Critère de fin de ce premier lot : conversation GPT-Live full-duplex sans
ElevenLabs et sans outil agent, avec tokens absents du renderer et fermeture
propre. La délégation devient le lot suivant.

### 0.12 Pièges à éviter

- Ne pas copier l'ancien endpoint Pi `chatgpt.com/backend-api/...` : utiliser le
  contrat OpenClaw actuel `/v1/live`.
- Ne pas donner les MCP directement au modèle vocal.
- Ne pas faire transiter le bearer OAuth par React pour simplifier le SDP.
- Ne pas confondre interruption de la voix et interruption de l'agent.
- Ne pas accepter une approbation par recherche du mot « oui » dans une phrase.
- Ne pas ajouter un second stockage mémoire local.
- Ne pas réécrire `server/index.ts` sans d'abord extraire une frontière étroite.
- Ne pas supprimer ElevenLabs avant que le nouveau chemin soit validé ; le
  retrait appartient au Milestone 6.
- Ne pas laisser une ancienne délégation publier dans une nouvelle session :
  utiliser génération, `AbortSignal` et identifiants de session.
- Ne pas annoncer qu'une action a réussi avant `turn.completed` ou un résultat
  provider explicite.
- Ne pas oublier que l'application installée peut tourner pendant les tests.

## 1. Architecture cible

```text
┌──────────────────────────────────────────────────────────────┐
│ Kenpachi local                                               │
│ Apple Speech, aucun audio envoyé tant que le réveil n'a pas  │
│ été déclenché                                                │
└────────────────────────────┬─────────────────────────────────┘
                             │ réveil + première commande
                             ▼
┌──────────────────────────────────────────────────────────────┐
│ Electron / React                                             │
│                                                              │
│ getUserMedia + WebRTC audio-only                             │
│ - echoCancellation                                           │
│ - noiseSuppression                                           │
│ - autoGainControl                                            │
│ - sortie audio GPT-Live                                      │
│                                                              │
│ Aucun OAuth ni secret fournisseur dans le renderer           │
└────────────────────────────┬─────────────────────────────────┘
                             │ SDP avec jeton éphémère
                             ▼
┌──────────────────────────────────────────────────────────────┐
│ OpenMaus Harness                                             │
│                                                              │
│ OAuth ChatGPT ──► POST api.openai.com/v1/live                │
│                  ◄─ SDP                                      │
│                                                              │
│ Sideband WebSocket sécurisé                                  │
│ - transcriptions                                             │
│ - delegation.created                                         │
│ - contexte silencieux                                        │
│ - résultats à prononcer                                      │
│ - cycle de vie et annulation                                 │
└────────────────────────────┬─────────────────────────────────┘
                             │ AgentConsult
                             ▼
┌──────────────────────────────────────────────────────────────┐
│ Bot OpenMaus sélectionné                                     │
│                                                              │
│ Même thread, modèle, identité, outils et permissions         │
│ Codex / Claude / ACP                                         │
│ Gmail + Drive + Pennylane + mémoire + CUA + autres bots      │
└──────────────────────────────────────────────────────────────┘
```

`gpt-live-1-codex` est l'interface conversationnelle, pas l'agent exécutant.
Il écoute, parle, gère les tours et délègue les actions. Le bot OpenMaus reste
l'unique propriétaire des outils, permissions, sessions et résultats.

## 2. Invariants non négociables

1. Aucune dépendance ElevenLabs pour les appels.
2. Aucune clé OpenAI Platform requise.
3. Utilisation de ChatGPT OAuth, dans les limites et droits de l'abonnement.
4. Le bearer OAuth ne passe jamais dans React, WebRTC ou une URL.
5. Kenpachi reste local avant activation.
6. L'interface montre clairement quand le microphone transmet à GPT-Live.
7. Parler par-dessus la voix interrompt l'audio, pas automatiquement le travail.
8. « Arrête de parler » et « annule la tâche » sont deux commandes distinctes.
9. Les actions sensibles exigent une confirmation explicite et liée à l'action.
10. La mémoire canonique reste Pi Memory Hub → Obsidian → Qdrant.
11. Une panne vocale ne casse jamais le chat texte ni le travail de l'agent.
12. Aucun fallback silencieux vers une API payante.

## 3. Lot 1 — Créer un domaine `realtime-voice`

Le code actuel mélange capture, dictée Apple, TTS ElevenLabs, permissions,
cycle de vie, événements agent, approbations et rendu React. La migration doit
commencer par définir des propriétaires clairs.

### Modules serveur

```text
server/realtime-voice/
├── contracts.ts
├── openai-live-wire.ts
├── oauth-client.ts
├── session-broker.ts
├── sideband.ts
├── delegation-controller.ts
├── agent-consult.ts
├── agent-control.ts
├── confirmation-controller.ts
└── *.test.ts
```

### Modules renderer

```text
src/lib/realtime-call/
├── controller.ts
├── media-peer.ts
├── state.ts
├── client.ts
└── *.test.ts
```

`CallView.tsx` redevient principalement un composant de rendu. Le simple
`targetId | null` de `src/lib/call.ts` est remplacé par une union fermée :

```ts
type RealtimeCallState =
  | { type: "idle" }
  | { type: "authorizing"; targetId: string }
  | { type: "connecting"; targetId: string; sessionId: string }
  | { type: "live"; targetId: string; sessionId: string; phase: LivePhase }
  | { type: "reconnecting"; targetId: string; sessionId: string }
  | { type: "closing"; targetId: string }
  | { type: "failed"; targetId?: string; message: string; recoverable: boolean };
```

Cette machine d'état doit empêcher :

- un micro actif sans session ;
- un ancien appel qui ferme le nouveau ;
- le wake listener et WebRTC possédant simultanément le micro ;
- les événements tardifs d'une délégation précédente dans le nouvel appel.

## 4. Lot 2 — OAuth ChatGPT propre à OpenMaus

### Flux recommandé

1. Voice Settings propose **Connecter ChatGPT**.
2. Electron lance Authorization Code + PKCE.
3. Le callback revient sur `127.0.0.1`.
4. Electron conserve le refresh token avec `safeStorage`.
5. Le fichier chiffré est privé à l'utilisateur.
6. Le harness demande un access token temporaire à Electron par IPC.
7. Le harness extrait et valide `chatgpt-account-id`.
8. Electron rafraîchit le token avant expiration.
9. Le renderer ne reçoit qu'un statut non sensible.

```json
{
  "authenticated": true,
  "account": "ChatGPT",
  "model": "gpt-live-1-codex"
}
```

OpenMaus doit posséder son profil OAuth au lieu de relire continuellement les
fichiers d'authentification de Pi ou de Codex. Un import contrôlé pourra être
ajouté ultérieurement, mais le refresh token ne doit avoir qu'un propriétaire.

L'extension Pi installée fournit une bonne référence pour le peer WebRTC et la
délégation, mais utilise encore l'ancien endpoint
`chatgpt.com/backend-api/codex/realtime/calls`. Le port doit employer le
protocole OpenClaw actuel : `https://api.openai.com/v1/live`.

## 5. Lot 3 — Broker WebRTC sécurisé

### Création de session

```http
POST /api/realtime/sessions
Content-Type: application/json

{ "targetId": "bot-123" }
```

```json
{
  "sessionId": "voice-...",
  "offerToken": "jeton-aléatoire-à-usage-unique",
  "offerUrl": "/api/realtime/offers",
  "expiresAt": 0
}
```

### Échange SDP

```http
POST /api/realtime/offers
Authorization: Bearer <offerToken>
Content-Type: application/sdp
```

Le harness consomme le jeton, valide l'offre audio-only, ajoute modèle, voix et
instructions, appelle `/v1/live`, ouvre le sideband du `callId`, puis renvoie
uniquement le SDP answer.

### Fermeture

```http
DELETE /api/realtime/sessions/:sessionId
```

### Protections

- jeton aléatoire 256 bits et à usage unique ;
- expiration à 60 secondes ;
- une session active par fenêtre ;
- durée maximale initiale de 30 minutes ;
- modèle et voix validés par liste fermée ;
- tailles maximales pour SDP, frames et résultats ;
- retry exponentiel borné ;
- fermeture si le renderer disparaît ;
- validation Origin et écoute loopback ;
- bearer OAuth absent des logs ;
- erreurs OpenAI tronquées et nettoyées.

Voix GPT-Live admises : `alloy`, `ash`, `ballad`, `cedar`, `coral`, `echo`,
`marin`, `sage`, `shimmer` et `verse`. Défaut recommandé : `marin`, puis
`cedar`.

## 6. Lot 4 — WebRTC full-duplex dans Electron

Le renderer crée un peer audio-only :

```ts
getUserMedia({
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
});
```

Il ajoute la piste micro au `RTCPeerConnection`, reçoit la piste GPT-Live,
l'associe à un élément `<audio autoplay>`, envoie l'offre au broker et applique
la réponse SDP. Le micro reste ouvert pendant que GPT-Live parle.

Cela remplace :

```text
Apple STT → attendre → agent → ElevenLabs → rouvrir le micro
```

par :

```text
audio continu ↔ GPT-Live
```

Quand l'utilisateur recommence à parler, GPT-Live interrompt sa génération
vocale et la sortie locale est vidée. La tâche de fond n'est annulée que par
une commande sémantique explicite.

Le barge-in doit être testé avec haut-parleurs internes, casque filaire,
AirPods/Bluetooth, bruit ambiant et interruptions brèves.

## 7. Lot 5 — Déléguer au vrai bot OpenMaus

### Contrat

```ts
interface AgentConsultRuntime {
  run(input: {
    voiceSessionId: string;
    targetId: string;
    prompt: string;
    signal: AbortSignal;
    onEvent(event: RuntimeEvent): void;
  }): Promise<{ text: string }>;
}
```

Ce service réutilise le chemin existant de `startTurn` et conserve :

- bot et thread sélectionnés ;
- modèle et resume cursor ;
- persona ;
- Gmail, Drive et Pennylane ;
- Pi Memory ;
- ordinateur local, VM ou cloud ;
- autres bots ;
- politiques d'approbation.

```text
delegation.created
        ↓
validation et limites
        ↓
AgentConsultRuntime.run()
        ↓
startTurn(bot sélectionné)
        ↓
EventBus RuntimeEvent
        ├─ progression → commentary
        ├─ approbation → confirmation vocale
        ├─ erreur      → contexte d'échec
        └─ résultat    → speakable
        ↓
delegation.context.append
        ↓
GPT-Live formule et prononce le résultat
```

### `commentary`

Contexte silencieux destiné au modèle vocal : outil courant, dernier progrès,
attente d'approbation, redirection ou erreur récupérable. Il permet de répondre
à « où en es-tu ? » sans lire chaque chip d'activité.

### `speakable`

Résultat stable destiné à l'oral : réponse finale, confirmation, erreur utile
ou demande d'approbation. Les deltas bruts de raisonnement et morceaux de code
ne sont jamais lus.

## 8. Lot 6 — Contrôler l'agent pendant son travail

Le contrôleur distingue quatre opérations.

### `status`

« Où tu en es ? » produit une réponse depuis le vrai `RuntimeEvent` : outil
courant, durée, dernier progrès, approbation attendue et état final.

### `cancel`

« Annule cette tâche » appelle `ProviderAdapter.interruptTurn`.

### `steer`

« Ne touche pas à Drive, vérifie seulement Gmail » redirige le tour actif si le
driver possède une primitive native :

```ts
steerTurn?: (
  threadId: string,
  turnId: string,
  text: string,
) => Promise<{ accepted: boolean; reason?: string }>;
```

La capacité doit être vérifiée séparément pour Codex app-server, Claude et les
drivers ACP. Un moteur incapable de steering doit le dire clairement ; aucun
cancel/restart silencieux ne doit imiter un steering réussi.

### `followup`

« Quand tu auras fini, vérifie aussi juillet » place une demande dans une file
et la lance après `turn.completed`, dans la même session agent.

| Action vocale | Effet |
| --- | --- |
| Parler par-dessus GPT-Live | Coupe uniquement sa voix |
| « Sois plus bref » | Change le style conversationnel |
| « Utilise Gmail plutôt que Drive » | Steer |
| « Après ça, vérifie Pennylane » | Follow-up |
| « Annule tout » | `interruptTurn` |

## 9. Lot 7 — Approbations vocales sûres

Le modèle vocal ne décide jamais seul qu'une phrase autorise une action.

```ts
type VoiceConfirmation =
  | { type: "none" }
  | {
      type: "pending";
      requestId: string;
      threadId: string;
      exactSummary: string;
      expiresAt: number;
    };
```

Règles :

- confirmation liée à un `requestId` exact ;
- usage unique et expiration courte ;
- annulation à la fermeture de l'appel ;
- refus si la demande a changé ;
- grammaire fermée français/anglais ;
- aucune recherche naïve du mot « oui » dans une phrase ;
- répétition de la question lorsqu'une réponse est ambiguë.

Les lectures Gmail, Drive, Pennylane et mémoire peuvent rester sans
confirmation selon la politique du bot. L'envoi d'un email, le partage ou la
suppression d'un document, l'écriture Pennylane, le paiement, la publication
externe et les actions informatiques destructives exigent une confirmation qui
répète destinataire, montant, société, fichier ou action concernés.

## 10. Lot 8 — Relier Kenpachi à GPT-Live

```text
Wake listener local
   ↓ « Kenpachi »
capture locale de la première commande
   ↓
arrêt complet du wake listener
   ↓
création de la session GPT-Live
   ↓
première commande injectée une seule fois
   ↓
AgentConsult
   ↓
conversation full-duplex
   ↓
raccrochage ou expiration
   ↓
réarmement de Kenpachi
```

Le wake helper et WebRTC ne doivent jamais posséder le micro ensemble. Si
GPT-Live ne démarre pas, la commande déjà capturée peut être envoyée au bot en
texte, sans fallback ElevenLabs.

## 11. Lot 9 — Nouvelle interface Voice

### Réglages

Remplacer ElevenLabs par :

- état ChatGPT OAuth ;
- connexion et déconnexion ;
- modèle `gpt-live-1-codex` ;
- choix de voix ;
- langue principale ;
- périphériques micro et sortie ;
- activation et phrase Kenpachi ;
- erreurs de connexion ;
- test réel de conversation.

### Overlay Jarvis

États accessibles : Connecting, Listening, Hearing you, Speaking, Working,
Awaiting approval, Reconnecting, Muted et Failed.

Contrôles : mute, raccrocher, interrompre la voix, sous-titres, bot ciblé,
outil courant et refus rapide d'une approbation. Tous les contrôles doivent
avoir un nom AT-SPI et être utilisables au clavier.

## 12. Migration et suppression d'ElevenLabs

### Étape intermédiaire

- GPT-Live devient le moteur des appels ;
- ElevenLabs n'est plus un prérequis ;
- `CallButton` ne vérifie plus `tts.configured` ;
- les voix des bots migrent vers les IDs GPT-Live.

### Étape finale

Supprimer :

- la clé ElevenLabs des réglages ;
- `server/tts/elevenlabs.ts` ;
- `/api/tts/speak` et `/api/tts/voices` ;
- les mentions de facturation ;
- le chemin half-duplex des vues d'appel.

Le bouton « Lire ce message » pourra utiliser la voix système gratuitement,
être masqué temporairement ou employer plus tard un moteur local MLX. Il ne
doit pas maintenir ElevenLabs dans le chemin Jarvis.

## 13. Plan de tests

### Unitaires

- parsing des événements GPT-Live ;
- modèles, voix, JWT et `chatgpt-account-id` ;
- limites SDP, transcripts, frames et résultats ;
- jeton one-shot, expiration, retry et nettoyage ;
- state machine de l'appel ;
- classification `status/steer/cancel/followup` ;
- confirmation exacte français/anglais ;
- fencing des événements périmés.

### Intégration avec faux OpenAI

- échange SDP ;
- frames sideband reçues très tôt ;
- `delegation.created` ;
- délégation remplacée ou annulée ;
- bearer expiré ;
- erreur 403 ou voix invalide ;
- coupure sideband ;
- fermeture du renderer pendant la connexion ;
- second appel refusé ;
- absence de secret dans les réponses, URLs et logs.

### Agent et outils

Tester depuis une délégation vocale : Codex OAuth, Gmail lecture et envoi,
Drive lecture et écriture, Pennylane lecture et écriture, `memory_status`,
`memory_search`, `knowledge_search`, `memory_write/correct/forget`, ordinateur
et `ask_bot`. Les écritures et actions sensibles doivent traverser le chemin
d'approbation.

### Scénarios Jarvis réels

1. « Kenpachi, quels sont mes prochains rendez-vous ? »
2. Interrompre la réponse en parlant.
3. Pendant une tâche longue : « où tu en es ? »
4. « Ne cherche plus dans Drive, regarde Gmail. »
5. « Après ça, vérifie Pennylane. »
6. « Annule la tâche. »
7. Provoquer une approbation et répondre de façon ambiguë.
8. Confirmer explicitement.
9. Raccrocher et vérifier le réarmement de Kenpachi.
10. Redémarrer l'application et vérifier la persistance OAuth.

### Validation plateforme

- application macOS signée et installée ;
- haut-parleurs internes et AirPods ;
- permission micro refusée puis réparée ;
- fermeture brutale et veille/réveil ;
- changement réseau et expiration OAuth ;
- packaging Windows/Linux pour les appels WebRTC ;
- wake word macOS dans un premier temps.

### Objectifs mesurés

- barge-in audible interrompu en moins de 250 ms ;
- délégation démarrée moins de 300 ms après le transcript final, hors réseau ;
- aucune propriété simultanée du micro ;
- zéro secret dans le renderer ;
- zéro requête ElevenLabs ;
- zéro double commande après Kenpachi.

## 14. Évolutions vers un Jarvis complet

### A. Proactivité intelligente

Le Chief of Staff surveille des événements utiles : email urgent, réunion,
anomalie Pennylane, tâche terminée, CI cassée, document arrivé ou routine en
échec. Les notifications respectent heures silencieuses, urgence,
déduplication, snooze et canal choisi.

### B. Mémoire réellement utile

Étendre Pi Memory Hub avec préférences, personnes, sociétés, projets,
décisions, engagements, échéances et résumés vocaux. Conserver provenance,
correction et oubli. Ne jamais mémoriser automatiquement tout ce que le micro
entend et ne pas conserver l'audio par défaut.

### C. Perception multimodale

Permettre « regarde mon écran », « qu'est-ce qui bloque ? » ou « clique sur
valider ». Le bot utilise CUA, OCR et captures ; GPT-Live reste la surface
vocale. L'écran n'est capturé qu'après demande ou autorisation active.

### D. Travail en équipe

Le Chief of Staff délègue la comptabilité, l'email, le code, la recherche et le
contrôle informatique aux bots spécialisés. Une voix Jarvis orchestratrice est
préférable à plusieurs sessions parlant simultanément dans les rooms.

### E. Routines conversationnelles

Une phrase peut créer une routine structurée, l'afficher puis demander
confirmation avant activation : briefing quotidien, traitement de facture,
surveillance de build ou résumé hebdomadaire.

### F. Présence et contexte local

Contexte optionnel : application active, calendrier, casque, réunion, réseau,
heure et presse-papiers sur demande. Cela permet de choisir entre voix,
notification et silence selon la situation.

### G. Mobile et distance

Ajouter une PWA WebRTC pour iPhone, protégée par Tailscale ou un appairage fort.
L'OAuth reste sur OpenMaus et le téléphone reprend le même bot et le même
thread.

### H. Home Assistant

Ajouter lumières, température, scènes, musique et capteurs. Alarmes, serrures
et actions sensibles restent soumises à une confirmation forte.

### I. Personnalité

Créer un prompt vocal distinct du prompt agent : français naturel, réponses
courtes, humour configurable, capacité à rester silencieux, interdiction de
lire code et tableaux, et interdiction d'annoncer une action avant son vrai
résultat.

### J. Observabilité

Afficher état OAuth, session, latence WebRTC, barge-in, délégation, outil,
reconnexions, limites d'abonnement, erreurs nettoyées et confirmations. Aucun
audio brut n'est conservé.

## 15. Ordre de livraison

### Milestone 1 — Conversation GPT-Live — TERMINÉ

OAuth, WebRTC, full-duplex, barge-in et sous-titres, sans délégation.

**Gate :** conversation naturelle sans ElevenLabs.

### Milestone 2 — AgentConsult — TERMINÉ

`delegation.created`, bot sélectionné, EventBus, résultat speakable et MCP.

**Gate :** une demande vocale offre les mêmes capacités qu'une demande texte.

### Milestone 3 — Contrôle continu — TERMINÉ

Status, cancel, follow-up, steering selon le driver et progression silencieuse.

**Gate :** une tâche longue reste pilotable sans quitter l'appel.

### Milestone 4 — Sécurité et approbations — TERMINÉ

Confirmation exacte, expiration, liaison au `requestId` et tests sensibles.

**Gate :** aucune phrase ambiguë ne déclenche une action à impact.

### Milestone 5 — Kenpachi et expérience complète — TERMINÉ CÔTÉ CODE

Wake vers GPT-Live, commande unique, réarmement, overlay, AT-SPI et packaging.

**Gate :** parcours complet réveil → travail → interruption → confirmation →
résultat → raccrochage.

### Milestone 6 — Suppression du legacy — TERMINÉ

Retrait ElevenLabs, retrait half-duplex, documentation, installation propre et
test depuis `/Applications/OpenMausBot.app`.

## 16. Définition finale de « Jarvis complet »

Le premier grand objectif est atteint lorsque l'utilisateur peut dire :

> Kenpachi, cherche les dernières factures dans Gmail et Drive, compare-les à
> Pennylane, et dis-moi s'il en manque.

Puis, sans attendre la fin :

> Où tu en es ?

> Ne regarde finalement que juillet.

> Après ça, prépare les écritures mais ne valide rien.

> Oui, valide seulement ces trois-là.

Pendant tout le parcours, la voix reste naturelle, l'utilisateur peut parler
par-dessus, l'agent continue réellement à travailler, les MCP et la mémoire
restent disponibles, les confirmations sont sûres, les actions sont visibles
dans le thread et aucune clé ElevenLabs n'est nécessaire.

## 17. Références techniques auditées

### OpenMausBot

- `src/components/CallView.tsx`
- `src/components/GroupCallView.tsx`
- `src/lib/call.ts`
- `server/index.ts`
- `server/contracts.ts`
- `electron/wake-word.mjs`
- `docs/voice-mode.md`

### OpenClaw

- `extensions/openai/realtime-quicksilver-session.ts`
- `extensions/openai/realtime-quicksilver-wire.ts`
- `extensions/openai/realtime-quicksilver-delegation-controller.ts`
- `src/talk/agent-consult-runtime.ts`
- `src/talk/agent-run-control.ts`

OpenClaw est sous licence MIT. Toute adaptation doit être ajoutée à
`THIRD_PARTY_NOTICES.md`.

### Runtime Pi installé

- `src/voice/conversation/session.ts`
- `src/voice/conversation/handoff.ts`
- `src/voice/auth.ts`
