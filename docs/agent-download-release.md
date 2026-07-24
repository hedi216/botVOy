# Publication de l'installateur RendezBot Agent (Phase 5, Lot 4)

Ce document decrit l'architecture de publication et la procedure operationnelle pour activer/mettre a jour/retirer une release. Pour la construction de l'installateur lui-meme, voir [agent-packaging.md](agent-packaging.md). Pour le statut du candidat actuel, voir [phase5-release-candidate.md](phase5-release-candidate.md).

## 1. Architecture

Le dossier Git du projet ne contient **jamais** de binaire produit (`.exe`) - uniquement le code du service de release et la documentation. Les artefacts reels vivent dans un dossier configure separement sur la machine serveur :

```
<AGENT_RELEASES_DIR>/
  <version>/
    RendezBotAgentSetup-<version>.exe
    SHA256SUMS.txt
    build-manifest.json
```

Exemple recommande : `C:\RendezBotReleases\agent\<version>\`.

Le serveur lit **uniquement** la version explicitement approuvee (`AGENT_RELEASE_VERSION`) - jamais une selection automatique du dernier dossier trouve par tri alphabetique. Sans configuration (`AGENT_RELEASES_DIR`/`AGENT_RELEASE_VERSION` vides), aucune release n'est jamais annoncee disponible.

## 2. Variables serveur

| Variable | Role | Defaut |
|---|---|---|
| `AGENT_RELEASES_DIR` | Dossier racine des releases (jamais suivi par Git) | vide (service desactive) |
| `AGENT_RELEASE_VERSION` | Version explicitement activee (format `X.Y.Z`) | vide (service desactive) |
| `AGENT_RELEASE_CHANNEL` | `candidate` \| `stable` \| `deprecated` \| `blocked` | `candidate` |
| `AGENT_DOWNLOAD_URL` | Override administratif : remplace l'URL de telechargement generee (doit etre `https://`, un hote local reste tolere en test) | vide (service interne utilise) |

## 3. Procedure : publier une nouvelle version

1. **Construire** l'installateur (voir [agent-packaging.md](agent-packaging.md)) : `npm run agent:package:win`. Produit `release/windows/RendezBotAgentSetup-<version>.exe`, `SHA256SUMS.txt`, `build-manifest.json`.
2. **Verifier avant toute copie** (jamais accepter un fichier simplement parce qu'il existe) :
   - Hash SHA-256 du `.exe` correspond a `SHA256SUMS.txt`.
   - `build-manifest.json` : `agentVersion` correspond a la version annoncee, `protocolVersion` est celui attendu, `signed` est `false`, le nom de fichier est exact.
   - Taille du fichier coherente (pas de troncature).
3. **Copier** les 3 fichiers dans `<AGENT_RELEASES_DIR>/<version>/` sur la machine serveur.
4. **Activer** : definir `AGENT_RELEASE_VERSION=<version>` (et `AGENT_RELEASES_DIR` si pas deja fait) dans la configuration serveur.
5. **Redemarrer** le serveur (la configuration de release est lue au demarrage, jamais re-lue a chaud entre deux requetes).
6. **Verifier l'endpoint** : `GET /api/agent/releases/latest` (authentifie) doit repondre `available: true` avec la version/le hash attendus.
7. **Telecharger et revérifier** : telecharger via le bouton de l'application, recalculer le SHA-256 du fichier obtenu, comparer au hash affiche et a celui de l'etape 2.

## 4. Validation reelle confirmee (`https://app.rendezbot.xyz`)

La procedure ci-dessus (sections 1-3) a ete suivie reellement pour la release `0.1.0` et validee sur une VM Windows de test, via le vrai domaine de production :

- Page `/agent/setup` accessible via `https://app.rendezbot.xyz` (pas un equivalent local).
- Release `0.1.0` (channel `candidate`) correctement affichee, hash `48a72d142a0652cbdbce8b6c148c29cb76b46f7bd6c7b507149d8db8928a1695`.
- Telechargement reel via le bouton, hash du fichier obtenu identique au hash affiche.
- Installation reelle sans droits administrateur, agent lance avec `app.rendezbot.xyz` comme serveur (aucun fallback vers un serveur local).
- Appairage reel, statut "Connecte" et `READY_FOR_COMMANDS` confirmes.
- Reconnexion automatique apres redemarrage (identifiants DPAPI preserves), verrou mono-instance valide.
- Revocation depuis le serveur confirmee : l'agent repasse a "Non appaire".

Voir [phase5-release-candidate.md](phase5-release-candidate.md) section 5.2 pour le detail complet de cette validation.

## 5. Regle absolue : une version publiee n'est jamais remplacee silencieusement

Si le binaire change pour quelque raison que ce soit, il **doit** recevoir un nouveau numero de version (ou une nouvelle procedure d'activation explicite) - jamais un remplacement du fichier sous le meme numero de version deja publie. Le cache de hash du serveur se recalcule automatiquement si la taille ou la date de modification du fichier changent (voir agentReleaseService.ts), mais cette detection ne remplace pas la discipline operationnelle : un changement de contenu sous un numero de version identique est une erreur de procedure, pas une fonctionnalite.

## 6. Desactiver une release

Definir `AGENT_RELEASE_CHANNEL=blocked` (redemarrage requis) rend la release immediatement indisponible (`available: false`) sans avoir a supprimer les fichiers. Alternative : vider `AGENT_RELEASE_VERSION`.

## 7. Rollback vers une version anterieure

1. S'assurer que le dossier `<AGENT_RELEASES_DIR>/<version anterieure>/` existe toujours avec ses 3 fichiers valides (ne jamais supprimer une version anterieure des sa publication, justement pour permettre ce rollback).
2. Reconfigurer `AGENT_RELEASE_VERSION` vers cette version anterieure.
3. Redemarrer, revérifier l'endpoint (etape 3.6-3.7).

Ceci ne desinstalle rien chez les clients deja installes - cela change uniquement ce que le bouton "Telecharger" propose desormais.

## 8. Remplacer un artefact corrompu

Si le hash reel ne correspond plus au hash declare dans `build-manifest.json` (fichier corrompu/tronque), le service refuse automatiquement de servir la release (`available: false`, jamais un telechargement partiel ou invalide). Reconstruire proprement (etape 3.1) et republier sous un identifiant de version distinct plutot que de tenter de "reparer" le fichier en place.

## 9. Consulter les logs

Les erreurs de resolution de release (manifeste invalide, hash incorrect, fichier absent) sont journalisees cote serveur (jamais transmises au client) avec un message clair mais sans jamais exposer le chemin disque complet dans une reponse HTTP. Consultez la sortie standard du process serveur pour le diagnostic operationnel.

## 10. Limites de ce lot

Aucun auto-update, aucune installation silencieuse distante, aucune signature de code reelle, aucune publication publique (GitHub Releases ou equivalent), aucun deploiement chez un client final. Voir [phase5-release-candidate.md](phase5-release-candidate.md) pour le detail complet.
