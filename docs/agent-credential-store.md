# Credential Store Agent — Phase 5 (Lot 2)

## 1. Interface `AgentCredentialStore`

```ts
interface AgentCredentialStore {
  load(): Promise<StoredAgentCredentials | null>;
  save(credentials: StoredAgentCredentials): Promise<void>;
  clear(): Promise<void>;
  exists(): Promise<boolean>;
  describeSecurity(): CredentialStoreSecurityDescription; // jamais de secret
}
```

Trois implémentations, sélectionnées **explicitement** selon `AGENT_RUNTIME_MODE` (`development` par défaut, `packaged`, `test`) — jamais devinées depuis la plateforme ou la présence d'un fichier :

| Mode | Implémentation | Protection |
|---|---|---|
| `development` (défaut) | `DevFileCredentialStore` | Fichier JSON en clair (comportement historique `agent:dev`, avertissement local à chaque sauvegarde) |
| `packaged` | `WindowsDpapiCredentialStore` | DPAPI CurrentUser — **obligatoire**, échec fermé si indisponible |
| `test` | `TestCredentialStore` | En mémoire uniquement, jamais de disque |

`createCredentialStore(settings, log)` (`src/agent/agentCredentialStore.ts`) est le point d'entrée unique. En mode `packaged`, si `isDpapiAvailable()` renvoie `false` (plateforme non-Windows, PowerShell absent/non exécutable), la fonction **lève une erreur** — l'agent ne démarre pas. Jamais de repli silencieux vers un fichier en clair.

## 2. Choix technique DPAPI

Comparaison (voir aussi `docs/agent-packaging.md`) :

| Option | Retenue ? | Raison |
|---|---|---|
| A. Module natif Node DPAPI | Non | Dépendance native à précompiler par ABI Node — casse la reproductibilité du build et l'intégration future dans un exécutable SEA (pas de mécanisme mature d'embarquement d'addons natifs) |
| B. Appel contrôlé à `System.Security.Cryptography.ProtectedData` (PowerShell) | **Oui** | Aucune dépendance native, API DPAPI officielle .NET, PowerShell déjà une dépendance établie de toute la chaîne de packaging Windows |
| C. Petit helper Windows dédié (binaire compilé séparément) | Non | Ajoute un artefact binaire supplémentaire à builder/maintenir/signer, sans bénéfice net sur l'option B |
| D. Autre solution compatible SEA | — | Aucune alternative mature identifiée à ce stade |

Implémentation : `src/agent/agentDpapi.ts` (`dpapiProtect`/`dpapiUnprotect`/`isDpapiAvailable`). Le script PowerShell lui-même ne contient **aucune valeur secrète** (code fixe passé en argument) ; la donnée (texte en clair ou blob chiffré) transite **uniquement par stdin/stdout**, jamais par un argument de ligne de commande (visible via Gestionnaire des tâches/journaux). Portée `CurrentUser` explicite. Timeout de 10s (échec fermé si PowerShell ne répond jamais).

## 3. Format du fichier protégé

`%LOCALAPPDATA%\RendezBot\credentials\agent-credentials.json` (ou `AGENT_CREDENTIALS_PATH` si fourni explicitement) :

```json
{
  "formatVersion": 1,
  "protection": "windows-dpapi-current-user",
  "agentId": 42,
  "protectedToken": "<base64 du blob DPAPI>",
  "agencyId": 7,
  "computerName": "PC-AGENCE-01",
  "displayName": "PC-AGENCE-01",
  "version": "0.1.0",
  "pairedAt": "...",
  "createdAt": "...",
  "updatedAt": "..."
}
```

`agentId`/`computerName`/etc. ne sont pas des secrets mais restent dans la même enveloppe versionnée pour la cohérence du format. Validation stricte au chargement (`agentDpapiCredentialStore.ts`) :
- taille maximale 64 Ko (rejet si dépassée) ;
- `formatVersion` doit être exactement `1` ;
- toute clé `__proto__`/`prototype`/`constructor` rejette le fichier (protection anti-pollution de prototype) ;
- chaque champ attendu est validé individuellement (type + présence).

Toute violation lève `CredentialFileCorruptedError` — jamais une tentative de "réparation" silencieuse. Écriture **atomique** (`writeFileAtomic`) : fichier temporaire unique dans le même dossier puis `rename()`, garanti atomique sur le même volume Windows.

## 4. Migration depuis le fichier en clair

`src/agent/agentCredentialMigration.ts`. Au premier démarrage, si le store cible ne contient pas déjà des identifiants protégés valides (vérifié par un `load()` réussi, jamais par une simple présence de fichier — un fichier en clair au même chemin par défaut existerait aussi), recherche **uniquement** des chemins explicitement connus (le chemin courant, et l'ancien défaut du Lot 1 `config/credentials.json` sous le même `dataRoot`) — jamais un balayage arbitraire du disque.

Séquence : lecture du fichier en clair → sauvegarde protégée → **relecture et vérification** que les valeurs correspondent → suppression de l'ancien fichier **uniquement si** son chemin diffère de celui du nouveau store (cas où l'ancien et le nouveau chemin coïncident : `save()` a déjà remplacé le contenu en clair par l'enveloppe protégée, une suppression supplémentaire effacerait les identifiants qui viennent d'être migrés — défaut trouvé et corrigé pendant la validation du test simulé Lot 2). En cas d'échec à n'importe quelle étape : l'ancien fichier est conservé, aucun fichier partiel ne survit, un nouvel appairage est requis plutôt qu'une connexion avec des données incertaines. Idempotente : un second appel sur un store déjà protégé renvoie `already-present` sans réécrire.

## 5. Limites et éléments du Lot 3

- Pas encore de rotation de clé DPAPI ni de ré-chiffrement périodique.
- Pas de sauvegarde/export chiffré des identifiants (hors périmètre).
- La désinstallation complète (suppression définitive du credential store) reste une action du Lot 3 (installateur), distincte de la dissociation locale (Lot 2, réversible par un nouvel appairage).
