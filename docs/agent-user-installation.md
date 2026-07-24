# Installer RendezBot Agent

Ce guide s'adresse a l'utilisateur final. Pour la procedure de publication cote serveur, voir [agent-download-release.md](agent-download-release.md). Pour l'appairage, voir [agent-pairing-guide.md](agent-pairing-guide.md).

## 1. Avant de commencer

- Windows 10 ou 11, 64 bits.
- Google Chrome installe sur cet ordinateur.
- Aucune installation prealable de Node.js ou d'un autre outil n'est necessaire.

## 2. Telecharger

1. Connectez-vous a RendezBot.
2. Ouvrez la page "Agent local" (ou le message de configuration affiche automatiquement).
3. Cliquez sur "Telecharger RendezBot Agent". La version, la taille approximative et le hash SHA-256 sont affiches sur cette page.

## 3. Installer

1. Lancez le fichier telecharge (`RendezBotAgentSetup-<version>.exe`).
2. **Un avertissement Windows SmartScreen peut apparaitre** ("Windows a protege votre ordinateur"). C'est normal : l'installateur n'est pas encore signe numeriquement. Cliquez sur "Informations complementaires" puis "Executer quand meme" si vous faites confiance a la source (votre propre telechargement depuis RendezBot).
3. Suivez l'installateur. Aucune autorisation administrateur n'est demandee.
4. Choisissez si vous voulez un raccourci sur le Bureau et le demarrage automatique a l'ouverture de session (recommande).
5. A la fin, l'agent se lance automatiquement.

## 4. Premier lancement

L'agent ouvre une petite fenetre dans votre navigateur avec un champ pour saisir un code d'appairage. Voir [agent-pairing-guide.md](agent-pairing-guide.md) pour la suite.

## 5. Verifier que tout fonctionne

Une fois appaire, retournez sur RendezBot : l'agent doit apparaitre "Connecte". Vous pouvez alors demarrer des bots depuis l'application - ils s'executeront directement sur cet ordinateur, avec un Chrome visible.

## 6. En cas de probleme

- **L'installateur est bloque par l'antivirus/SmartScreen** : voir l'etape 2 ci-dessus. Ne desactivez jamais votre antivirus.
- **L'agent ne demarre pas** : ouvrez le dossier de logs depuis la petite fenetre de l'agent (bouton "Ouvrir les logs") et consultez `agent.log`.
- **Besoin d'aide** : voir [agent-support-checklist.md](agent-support-checklist.md).

## 7. Quitter ou desinstaller

- **Quitter temporairement** : bouton "Quitter l'agent" dans la fenetre de l'agent.
- **Desinstaller** : via "Applications installees" de Windows. Vos identifiants et vos profils Chrome sont conserves par defaut (vous pourrez reinstaller sans vous reappairer). Une option separee "Supprimer aussi toutes les donnees locales" existe si vous voulez tout effacer definitivement.
