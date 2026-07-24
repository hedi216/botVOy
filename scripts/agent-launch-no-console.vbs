' Phase 5 (Lot 2 candidat, confirme au Lot 3) : launcher sans fenetre
' console visible.
'
' Mise a jour Lot 3 (voir docs/agent-packaging.md section 12) : Node SEA a
' ete PROTOTYPE avec les dependances reelles de l'agent (playwright,
' socket.io-client) et rejete - cause exacte documentee : (1) le script
' embarque par SEA ne peut require() que des modules natifs Node, jamais un
' node_modules sur disque, ce qui impose un bundle 100% autonome ; (2) une
' fois bundle integralement, playwright-core echoue a l'execution car son
' code interne recherche son propre package.json via un chemin relatif
' calcule depuis __dirname, casse par la fusion en un seul fichier.
' Architecture retenue a la place : une copie privee de node.exe (renommee
' RendezBotAgent.exe, embarquee dans l'installateur) + node_modules reel sur
' disque, exactement comme valide au Lot 1 - donc TOUJOURS besoin de ce
' launcher pour masquer la fenetre console (node.exe reste un executable a
' sous-systeme CONSOLE ; aucun compilateur C/C++ n'etait disponible sur la
' machine de build pour produire un stub natif a sous-systeme GUI). Reste
' donc un mecanisme TRANSITOIRE explicitement documente, pas la solution
' ideale, mais fonctionnellement suffisant et sans console visible.
'
' N'affiche aucune fenetre, mais NE MASQUE JAMAIS une erreur : l'agent
' continue d'ecrire dans agent.log et de refleter son etat (y compris une
' erreur) via l'interface locale (http://127.0.0.1:<port>/), consultable a
' tout moment.
'
' Usage : cible des raccourcis (menu Demarrer, Bureau, dossier Demarrage)
' generes par l'installateur Inno Setup - place dans le dossier d'installation,
' a cote de RendezBotAgent.exe, agent\agentMain.js, node_modules\, etc.

Option Explicit
Dim fso, shell, scriptDir, args, i, commandLine, exePath

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
exePath = scriptDir & "\RendezBotAgent.exe"

commandLine = Chr(34) & exePath & Chr(34) & " agent\agentMain.js"
For i = 0 To WScript.Arguments.Count - 1
  commandLine = commandLine & " " & Chr(34) & WScript.Arguments(i) & Chr(34)
Next

shell.CurrentDirectory = scriptDir
' 0 = fenetre masquee (SW_HIDE) ; False = ne pas attendre la fin du process.
shell.Run commandLine, 0, False
