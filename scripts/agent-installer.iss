; RendezBot Agent - installateur Windows per-user (Phase 5, Lot 3)
;
; Genere par scripts/agent-package-win.ps1 via ISCC (Inno Setup 6). Version
; injectee au moment de la compilation via /DMyAppVersion=<version> (source
; unique: src/agent/agentVersionInfo.json) - ce fichier .iss reste stable et
; versionne, jamais edite manuellement pour un simple changement de version.
;
; Perimetre Lot 3 (voir docs/agent-packaging.md section 11 et
; docs/phase5-packaging-plan.md) : installation per-user (aucun droit
; administrateur), raccourcis, demarrage automatique optionnel, arret
; gracieux avant remplacement/suppression, conservation des donnees locales
; par defaut, suppression complete UNIQUEMENT sur confirmation explicite et
; apres validation stricte du chemin. AUCUNE signature de code (Lot 3 reste
; explicitement non signe - voir docs/agent-signing.md).

#ifndef MyAppVersion
  #define MyAppVersion "0.0.0-dev"
#endif
#ifndef SourceDir
  #define SourceDir "..\release\agent-win\app"
#endif

#define MyAppName "RendezBot Agent"
#define MyAppPublisher "Comeleon Studio"
#define MyAppExeName "RendezBotAgent.exe"
#define MyAppLauncher "agent-launch-no-console.vbs"

[Setup]
; GUID stable - NE JAMAIS changer entre versions (necessaire pour que
; l'installateur reconnaisse une installation existante et propose une mise
; a niveau plutot qu'une installation cote a cote).
AppId={{137428DC-78FA-414F-BF17-F9CC0FD444C6}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
VersionInfoVersion={#MyAppVersion}
; Per-user (section 4/5 du cahier des charges): aucune elevation demandee,
; installation dans le profil de l'utilisateur courant uniquement.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=commandline
DefaultDirName={localappdata}\Programs\RendezBot Agent
DefaultGroupName=RendezBot Agent
DisableProgramGroupPage=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\release\windows
OutputBaseFilename=RendezBotAgentSetup-{#MyAppVersion}
Compression=lzma2
SolidCompression=yes
; Lot 3: explicitement NON signe (voir docs/agent-signing.md) - aucune
; directive SignTool (une valeur vide est refusee par ISCC ; l'absence de
; cette directive signifie explicitement "non signe", jamais un contournement
; SmartScreen).
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\{#MyAppExeName}
CloseApplications=no
ChangesEnvironment=no

[Languages]
Name: "french"; MessagesFile: "compiler:Languages\French.isl"

[Tasks]
Name: "desktopicon"; Description: "Creer un raccourci sur le Bureau"; GroupDescription: "Raccourcis:"; Flags: unchecked
Name: "autostart"; Description: "Demarrer RendezBot Agent automatiquement a l'ouverture de session"; GroupDescription: "Demarrage automatique:"; Flags: checkedonce

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\RendezBot Agent"; Filename: "wscript.exe"; Parameters: """{app}\{#MyAppLauncher}"""; WorkingDir: "{app}"; IconFilename: "{app}\{#MyAppExeName}"
Name: "{group}\Desinstaller RendezBot Agent"; Filename: "{uninstallexe}"
Name: "{userdesktop}\RendezBot Agent"; Filename: "wscript.exe"; Parameters: """{app}\{#MyAppLauncher}"""; WorkingDir: "{app}"; IconFilename: "{app}\{#MyAppExeName}"; Tasks: desktopicon
; Demarrage automatique per-user (section 6): raccourci dans le dossier
; Demarrage de l'utilisateur courant, jamais une cle Run/tache planifiee -
; le plus simple a auditer/supprimer, natif Inno Setup, aucune elevation.
Name: "{userstartup}\RendezBot Agent"; Filename: "wscript.exe"; Parameters: """{app}\{#MyAppLauncher}"""; WorkingDir: "{app}"; IconFilename: "{app}\{#MyAppExeName}"; Tasks: autostart

[Run]
Filename: "wscript.exe"; Parameters: """{app}\{#MyAppLauncher}"""; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent; Description: "Lancer RendezBot Agent maintenant"

[Code]
// Section 9/11 (arret gracieux avant remplacement/suppression de fichiers):
// reutilise le verrou mono-instance (Lot 2) + l'interface locale existante
// via agent\agentStopHelper.js (Node), plutot que de reimplementer la
// sequence d'arret (bots/Chrome/buffer/socket/interface locale/verrou) en
// Pascal. Le fallback taskkill ne cible QUE le PID lu dans le verrou -
// jamais "taskkill /IM node.exe" ni RendezBotAgent.exe global.

function ReadLockPid(const LockPath: string): Integer;
var
  Lines: TArrayOfString;
  S: string;
  P1, P2: Integer;
begin
  Result := 0;
  if not FileExists(LockPath) then Exit;
  if not LoadStringsFromFile(LockPath, Lines) then Exit;
  if GetArrayLength(Lines) = 0 then Exit;
  S := Lines[0];
  for P1 := 1 to GetArrayLength(Lines) - 1 do
    S := S + Lines[P1];
  P1 := Pos('"pid"', S);
  if P1 = 0 then Exit;
  P1 := Pos(':', Copy(S, P1, Length(S) - P1 + 1)) + P1 - 1;
  if P1 = 0 then Exit;
  P2 := P1 + 1;
  while (P2 <= Length(S)) and ((S[P2] < '0') or (S[P2] > '9')) do P2 := P2 + 1;
  P1 := P2;
  while (P2 <= Length(S)) and (S[P2] >= '0') and (S[P2] <= '9') do P2 := P2 + 1;
  if P2 > P1 then
    Result := StrToIntDef(Copy(S, P1, P2 - P1), 0);
end;

function StopRunningAgentGracefully(const InstallDir: string): Boolean;
var
  LockPath, ExePath, HelperPath: string;
  ResultCode: Integer;
  Pid, Waited: Integer;
begin
  Result := True;
  LockPath := ExpandConstant('{localappdata}') + '\RendezBot\state\agent.lock';
  if not FileExists(LockPath) then Exit;

  ExePath := InstallDir + '\RendezBotAgent.exe';
  HelperPath := InstallDir + '\agent\agentStopHelper.js';
  Pid := ReadLockPid(LockPath);

  if FileExists(ExePath) and FileExists(HelperPath) then
  begin
    Exec(ExePath, '"' + HelperPath + '"', InstallDir, SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;

  // Attente bornee que le verrou disparaisse (arret confirme) avant de
  // continuer - jamais indefiniment.
  Waited := 0;
  while FileExists(LockPath) and (Waited < 10) do
  begin
    Sleep(500);
    Waited := Waited + 1;
  end;

  // Fallback: uniquement si le verrou persiste ET qu'un PID precis a ete lu -
  // jamais un arret aveugle par nom de process.
  if FileExists(LockPath) and (Pid > 0) then
  begin
    Exec(ExpandConstant('{sys}\taskkill.exe'), '/PID ' + IntToStr(Pid) + ' /T /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;
end;

// Section 11 (mise a niveau manuelle): compare deux versions "X.Y.Z"
// composant par composant (numerique) - jamais une comparaison lexicale de
// chaines (fausse des cas comme "0.9.0" vs "0.10.0"). Renvoie <0 si A<B,
// 0 si egales, >0 si A>B.
function CompareVersions(const A, B: string): Integer;
var
  ARest, BRest, APart, BPart: string;
  ANum, BNum, DotPos: Integer;
begin
  ARest := A;
  BRest := B;
  Result := 0;
  while (Result = 0) and ((ARest <> '') or (BRest <> '')) do
  begin
    DotPos := Pos('.', ARest);
    if DotPos > 0 then begin APart := Copy(ARest, 1, DotPos - 1); ARest := Copy(ARest, DotPos + 1, MaxInt); end
    else begin APart := ARest; ARest := ''; end;
    DotPos := Pos('.', BRest);
    if DotPos > 0 then begin BPart := Copy(BRest, 1, DotPos - 1); BRest := Copy(BRest, DotPos + 1, MaxInt); end
    else begin BPart := BRest; BRest := ''; end;
    ANum := StrToIntDef(APart, 0);
    BNum := StrToIntDef(BPart, 0);
    if ANum < BNum then Result := -1
    else if ANum > BNum then Result := 1;
  end;
end;

// Lit la version deja installee (chaine vide si aucune installation
// existante) - directement depuis la cle d'desinstallation HKCU que cet
// installateur cree lui-meme (jamais une valeur fournie par l'utilisateur).
function GetInstalledVersion(): string;
begin
  if not RegQueryStringValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{137428DC-78FA-414F-BF17-F9CC0FD444C6}_is1', 'DisplayVersion', Result) then
    Result := '';
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  InstalledVersion: string;
begin
  Result := '';
  StopRunningAgentGracefully(ExpandConstant('{app}'));

  // Section 11: refuse explicitement un downgrade (jamais un ecrasement
  // silencieux qui risquerait de corrompre les donnees locales avec un
  // programme plus ancien) - fonctionne identiquement en mode silencieux
  // (Setup s'arrete avec ce message, sans jamais afficher de boite de
  // dialogue ni rester bloque) et en mode interactif (boite d'erreur).
  InstalledVersion := GetInstalledVersion();
  if (InstalledVersion <> '') and (CompareVersions('{#MyAppVersion}', InstalledVersion) < 0) then
  begin
    Result := 'Une version plus recente de RendezBot Agent (' + InstalledVersion + ') est deja installee. ' +
      'Cet installateur ({#MyAppVersion}) ne peut pas retrograder l''installation. Desinstallez d''abord ' +
      'la version actuelle si vous souhaitez reellement revenir a une version anterieure.';
  end;
end;

// Section 10 (desinstallation): conserve credentials/config/logs/profils/
// extensions/etat par defaut. Propose une suppression complete SEPAREE,
// uniquement sur confirmation explicite (jamais par defaut), et valide
// STRICTEMENT le chemin avant toute suppression - jamais un chemin derive
// d'une entree utilisateur, jamais un dossier parent.
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataRoot, Expected: string;
  DeleteData: Boolean;
begin
  if CurUninstallStep = usUninstall then
  begin
    StopRunningAgentGracefully(ExpandConstant('{app}'));
  end;

  if CurUninstallStep = usPostUninstall then
  begin
    DataRoot := ExpandConstant('{localappdata}') + '\RendezBot';
    Expected := ExpandConstant('{localappdata}') + '\RendezBot';
    // Egalite stricte avec la valeur attendue (jamais une valeur construite
    // a partir d'une entree utilisateur/registre arbitraire) avant toute
    // suppression, et jamais un dossier racine ou parent.
    if (DataRoot = Expected) and (DataRoot <> '') and (Length(DataRoot) > Length(ExpandConstant('{localappdata}'))) and DirExists(DataRoot) then
    begin
      // Une desinstallation silencieuse (/VERYSILENT, utilisee par les tests
      // automatises et par toute mise a niveau scriptee) ne doit JAMAIS rester
      // bloquee sur une boite de dialogue - /SUPPRESSMSGBOXES ne supprime que
      // les boites d'Inno Setup lui-meme, jamais un MsgBox() personnalise.
      // Par defaut en mode silencieux: conserver les donnees (jamais de
      // suppression sans confirmation explicite). Le parametre optionnel
      // /DELETEALLDATA=1 permet un choix scripte et explicite (tests
      // automatises de la suppression complete, section 19) sans jamais
      // afficher de boite de dialogue.
      // IMPORTANT: WizardSilent() n'est valide que pendant l'installation -
      // un appel ici (pendant la desinstallation) leve une erreur interne
      // Pascal ("Cannot call WizardSilent function during Uninstall"),
      // silencieusement avalee par /SUPPRESSMSGBOXES (defaut sur OK), ce qui
      // a pour effet de sauter TOUT le bloc ci-dessous sans jamais executer
      // la suppression - source d'un faux negatif decouvert par un test reel.
      // La fonction correcte pour ce contexte est UninstallSilent().
      if UninstallSilent() then
        DeleteData := (ExpandConstant('{param:DELETEALLDATA|0}') = '1')
      else
        DeleteData := (MsgBox('Supprimer aussi TOUTES les donnees locales de RendezBot Agent (identifiants, logs, profils Chrome, configuration) ?' + #13#10 +
          'Ce dossier sera supprime definitivement : ' + DataRoot + #13#10#13#10 +
          'Choisissez Non pour conserver ces donnees (recommande sauf desinstallation complete voulue).',
          mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES);
      if DeleteData then
      begin
        DelTree(DataRoot, True, True, True);
      end;
    end;
  end;
end;
