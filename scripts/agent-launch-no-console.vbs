' Phase 5 (Lot 2, section 10): launcher CANDIDAT sans fenetre console visible.
'
' LIMITES EXPLICITES (a ne jamais presenter comme la solution finale de
' Phase 5, voir docs/agent-packaging.md) :
' - Solution TRANSITOIRE (WScript), documentee comme telle. La solution
'   definitive est un executable Node SEA avec sous-systeme Windows natif
'   (Lot 3), qui n'aura plus besoin de ce launcher.
' - Necessite Node.js installe separement (le runtime compile du Lot 1/2
'   n'embarque pas encore Node): ne satisfait PAS encore l'exigence finale
'   "fonctionner sans Node.js installe separement".
' - N'affiche aucune fenetre, mais NE MASQUE JAMAIS une erreur: l'agent
'   continue d'ecrire dans agent.log et de refleter son etat (y compris une
'   erreur) via l'interface locale (http://127.0.0.1:<port>/), consultable a
'   tout moment.
'
' Usage: double-clic, ou raccourci Windows pointant vers ce fichier, place
' dans le meme dossier que agent\agentMain.js (donc a cote de package.json,
' node_modules\, etc. - la structure produite par agent-package-win.ps1).

Option Explicit
Dim fso, shell, scriptDir, args, i, commandLine

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

commandLine = "node.exe agent\agentMain.js"
For i = 0 To WScript.Arguments.Count - 1
  commandLine = commandLine & " " & Chr(34) & WScript.Arguments(i) & Chr(34)
Next

shell.CurrentDirectory = scriptDir
' 0 = fenetre masquee (SW_HIDE) ; False = ne pas attendre la fin du process.
shell.Run commandLine, 0, False
