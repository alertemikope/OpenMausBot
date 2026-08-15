# Kenpachi — plan d'audit comparatif continu

Date de référence : 15 août 2026  
Dépôt cible : `/Users/mrsachou/Frameworks/OpenMausBot`  
Branche : `feat/voice-wake-jarvis`

## Objectif

Comparer Kenpachi à des assistants et runtimes agentiques maintenus, puis
transformer uniquement les écarts prouvés en petits lots verticaux testables.
Les dépôts de référence restent en lecture seule : l'objectif n'est ni de
copier un framework, ni d'ajouter une seconde source de vérité.

## Invariants non négociables

1. Le harness existant reste propriétaire des agents, outils et permissions.
2. Une notification n'est jamais une autorisation d'agir.
3. Une tâche, une routine, un appel et une mémoire ont chacun un propriétaire
   et un identifiant distincts.
4. Pi Memory reste la mémoire durable canonique ; aucun graphe concurrent.
5. Aucun bearer OAuth, audio brut ou raisonnement interne dans les logs.
6. Les politiques de proactivité sont déterministes, persistantes et
   explicables.
7. `server/index.ts` compose des propriétaires nommés ; chaque nouveau lot doit
   éviter d'y réimplémenter sa logique métier.
8. Une amélioration n'est livrée qu'après tests, build, package signé et smoke
   de l'application installée lorsqu'elle touche le runtime utilisateur.

## Périmètre comparatif

| Référence | Question vérifiée | Ce qui peut être transféré |
| --- | --- | --- |
| OpenClaw | Comment heartbeat, cron, gateway et erreurs restent-ils observables ? | lifecycle, receipts, wake/poll policy |
| Hermes Agent | Comment scheduler, hooks et exécutions détachées sont-ils bornés ? | contrats de job, retries, diagnostics |
| OpenJarvis | Comment le runtime local expose-t-il santé, modules et métriques ? | health/readiness, ownership local |
| OpenYabby | Comment queues, priorités et résultats évitent-ils les doubles propriétaires ? | états fermés, claim, reçu terminal |
| OpenMausBot | Quels chemins centraux, contrats dupliqués et gates manquent encore ? | cible et baseline autoritative |

Chaque constat doit citer une révision et un fichier réellement inspecté. Une
idée non vérifiée reste une hypothèse et ne devient pas une tâche.

## Méthode et ordre

### Phase 1 — baseline

- vérifier Git et les commandes actives (`test`, `typecheck`, `build`,
  `build:server`, `check:electron`) ;
- cartographier composition, tâches, routines, proactivité, voix, mémoire,
  persistance et UI ;
- mesurer les hotspots maintenus à la main et les frontières API/SSE recopiées ;
- attribuer un score prudent : ownership, contrats, traversabilité, tests,
  feedback loops et documentation.

### Phase 2 — comparaison

- mettre à jour uniquement les checkouts propres ;
- lire les entrypoints et propriétaires derrière les mécanismes comparés ;
- distinguer : déjà adopté, meilleur que Kenpachi, incompatible, ou sans preuve ;
- refuser les transports, mémoires et registries qui dupliqueraient nos owners.

### Phase 3 — matrice d'écarts

Pour chaque écart : impact utilisateur, risque, preuve, owner cible, fichiers
touchés, test d'échec, gate de sortie et coût estimé. Priorités :

- **P0** : perte de résultat, action ambiguë, secret, faux état terminal,
  redémarrage ou concurrence dangereuse ;
- **P1** : autonomie utile, proactivité contrôlée, diagnostic, recovery ;
- **P2** : confort, performance non critique ou extension de capacité.

### Phase 4 — livraison linéaire

1. écrire/renforcer le test qui expose l'écart ;
2. choisir le plus petit propriétaire cohérent ;
3. implémenter sans chemin parallèle ni fallback silencieux ;
4. exécuter le test étroit, puis la recette globale ;
5. mettre à jour l'analyse comparative et la roadmap ;
6. empaqueter, signer, installer et faire un smoke réel si le lot est visible.

## Gates de validation

```bash
pnpm typecheck
pnpm test -- --run
pnpm build
pnpm build:server
pnpm check:electron
git diff --check
```

Pour le runtime macOS : `pnpm package:mac`, remplacement atomique de
`/Applications/OpenMausBot.app`, `codesign --verify --deep --strict`, health
check, vérification des fichiers sensibles en `0600`, puis smoke utilisateur
réel et nettoyage de ses données temporaires.

## Définition de fini de l'audit

- les révisions et chemins de référence inspectés sont consignés ;
- la baseline Kenpachi et les écarts sont étayés, pas supposés ;
- chaque recommandation possède une décision adoptée/rejetée et une raison ;
- le premier P0/P1 compatible est livré et vérifié de bout en bout ;
- la roadmap désigne le prochain lot concret sans déclarer livré ce qui ne
  l'est pas.
