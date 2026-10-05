# Reconnect für Terminal- und Remote-Desktop-Sitzungen

Stand: 2026-10-05 · Status: Entwurf zur Freigabe

## Ziel

Bricht eine Verbindung ab (WLAN, Handy im Standby, Server- oder Engine-Neustart, VPN), soll
der Tab nicht sterben. Die Sitzung wird im selben Tab, an derselben Stelle im Layout und unter
derselben Sitzungs-ID neu aufgebaut — per Knopf oder automatisch. Mit tmux auf dem Ziel landet
man wieder in derselben tmux-Sitzung (Hauptnutzen: Claude Code in `tmux new -A -s claude`).

Vorlage ist Nexterm (Commits 35275492, d5496db9, 5cfe9b1a, f14eed4b, ee53b67d, 39207bf5,
35b9d0c8, Client-Teil von 7a83fe44). Übernommen werden die Client-Bausteine; der
Server-Teil wird für Outpost neu entworfen (siehe „Abweichungen von Nexterm“).

## Entscheidungen

| Frage | Entscheidung |
|---|---|
| Umfang | ssh, telnet, pve-lxc (Xterm) und rdp, vnc (Guacamole); telnet und pve-lxc erhalten dafür in der Engine eine Unterscheidung „connection lost“ wie ssh. Nicht: SFTP/OneDrive (eigene Socket-Wiederholung), Skripte (dürfen nicht doppelt laufen), Notizen, beigetretene Sitzungen. |
| tmux-Sitzung fehlt beim Reconnect | Neu anlegen unter demselben Namen (`tmuxCreate = true`, entspricht `tmux new -A`). |
| Verbindungsgrund | Ursprünglichen Grund wiederverwenden, kein Dialog. Eigener Audit-Eintrag. |
| Automatik | Standardmäßig an, 5 Versuche nach 5/10/30/60/120 s, danach nur noch Knopf. Abschaltbar. |
| ID-Strategie | Dieselbe Sitzungs-ID nach außen, intern pro Anlauf eine eigene Engine-Sitzung `<id>:<generation>`. |

## Server

### Ruhende Sitzung (Tombstone)

`SessionManager` bekommt eine Map `retired: Map<sessionId, Tombstone>`.

```
Tombstone = {
  accountId, organizationId,
  entryId | null, directTarget | null,
  configuration,          // vollständig, inkl. directIdentity, tmux*, displayDpi, renderer
  connectionReason,
  generation,             // Generation der beendeten Sitzung
  reason,                 // Fehlertext des Abbruchs
  expiresAt,              // now + 15 min
}
```

- Angelegt in `SessionManager.remove`, bevor die Sitzung gelöscht wird, **nur** wenn
  - das Protokoll unterstützt ist: `createSession` legt `configuration.protocol =
    getEntryProtocol(entry)` an der Sitzung ab (`getEntryProtocol` wird dafür aus
    `ConnectionService.js` exportiert; bei Direktzielen das Protokoll des
    Direktziels); Tombstone nur bei `protocol ∈ {ssh, telnet, pve-lxc, rdp, vnc}`,
    `configuration.type !== "sftp"` und `configuration.scriptId == null`.
    (`configuration.type` ist bei normalen Sitzungen `null`, `renderer` ist
    `terminal`/`guac`; pve-shell und pve-qemu laufen über dieselben Pfade und sind
    ausdrücklich ausgeschlossen.) Und
  - die Sitzung mit einem Fehler endet: `code === 4017` oder Aufruf aus `engineDisconnected` —
    **außer** der Abbruch stammt aus einer Guacamole-`error`-Instruktion mit Status
    `GUAC_PROTOCOL_STATUS_SESSION_CONFLICT` (0x0209), `GUAC_PROTOCOL_STATUS_SESSION_TIMEOUT`
    (0x020A), `GUAC_PROTOCOL_STATUS_SESSION_CLOSED` (0x020B) oder einem Client-Status `0x03xx`.
    `GuacdClient.processData` liest dafür den Status (zweites Argument der `error`-Instruktion,
    heute verworfen) und reicht ihn über `onMasterConnectionClosed` als `options.guacStatus` an
    `remove` weiter.
- Kein Tombstone bei normalem Ende (Code 1000/ohne Code: `exit`, Tab geschlossen), bei
  RDP-Logoff/-Trennung (`GUAC_PROTOCOL_STATUS_SESSION_CLOSED`, 0x020B, als `error`-Instruktion
  mit „Logged off.“/„Forcibly disconnected.“/„Manually logged off.“,
  `vendor/guacamole-server/src/protocols/rdp/error.c`), bei beigetretenen Sitzungen und bei
  Skripten.
- `connectionReason` und `organizationId` liegen bereits an der Sitzung (`SessionManager.create`,
  `server/lib/SessionManager.js:16-20`) und werden von dort in den Tombstone übernommen.
  `SessionManager.create` erhält zusätzlich die optionalen Parameter `sessionId` (Vorgabe: neue
  UUID) und `generation` (Vorgabe: 1) und legt beide an der Sitzung ab; ist die übergebene
  `sessionId` in `sessions` noch belegt, wirft `create`.
- Ablauf: ein Aufräumtimer (60 s) entfernt Einträge mit `expiresAt < now`. Höchstens ein
  Tombstone pro ID; ein neuer ersetzt den alten.
- `DELETE /connections/:id` entfernt auch einen vorhandenen Tombstone, sofern
  `tombstone.accountId === req.user.id`.
- `removeAllByAccountId` (Abmelden `server/controllers/auth.js:69`, Konto löschen
  `server/controllers/account.js:72`) entfernt auch alle Tombstones des Kontos,
  `removeAllByEntryId` die des Eintrags.

### Engine-Abbruch

`server/index.js` `engineDisconnected`: Sitzungen werden mit
`{ code: 4017, reason: "Engine disconnected" }` entfernt statt ohne Code. Damit erscheint
statt eines stumm geschlossenen Tabs die Fehlerseite, und es entsteht ein Tombstone.

Daten-Socket und Control-Plane-Meldung kommen über zwei TCP-Verbindungen; ohne Gegenmaßnahme
gewinnt oft der `close` des Daten-Sockets, und die Sitzung endet ohne Code. Deshalb beenden die
`close`-Handler der Daten-Sockets (`ConnectionService.js`, ssh/telnet/pve-lxc) und `GuacdClient`
mit Grund `connection closed` die Sitzung erst nach **1 s Karenz**. Trifft in dieser Zeit
`sessionClosed` oder `engineDisconnected` für die Engine-ID ein, entscheidet dessen Grund
(„connection lost“ bzw. Engine-Abbruch → 4017 mit Tombstone, „session ended“ → normales Ende).
Ohne solches Ereignis endet die Sitzung nach der Karenz wie heute ohne Code.

Der Karenz-Timer liegt als `session._closeGrace` an der Sitzung; `SessionManager.remove` löscht
ihn als Erstes. Alle Aufrufer, die eine Sitzung nach einem Timer oder `await` über die stabile
ID ansprechen (Karenz-Timer, `.catch` von `createConnectionForSession` in `openSession`,
`setConnection`/`markFailed` in den `create*ConnectionForSession`-Funktionen), übergeben die
beim Start gemerkte `generation`; `remove`, `setConnection` und `markFailed` ignorieren Aufrufe
mit fremder Generation und loggen sie. In `GuacdClient.handleClose` wird nur
`onMasterConnectionClosed` verzögert; `cleanup()` und `onCloseCallback` (Handshake-Abbruch,
`ConnectionService.js:754`) bleiben sofort. Vom Nutzer ausgelöste Enden (DELETE, Tab schließen,
Abmelden, `removeAllBy*`) bleiben sofort: `cleanupConnection` entfernt die Listener des
Daten-Sockets, bevor er geschlossen wird.

### Engine: Abbruch zum Ziel bei telnet und pve-lxc

Heute melden `engine/src/net/telnet.c` (`cleanup`, „session ended“) und
`engine/src/net/websocket.c` („websocket session ended“) jedes Ende als normal; nur `ssh.c`
unterscheidet „connection lost“. Angeglichen an `ssh.c`:

- `telnet.c`: `telnet_bridge_poll` liefert wie `ssh_bridge_poll` einen dreiwertigen Grund
  (weiter / normal / Verbindung verloren), `cleanup` sendet ihn. „connection lost“:
  `read(telnet_fd)` < 0 außer `EINTR`/`EAGAIN` (diese: weiter im Loop), Schreibfehler auf
  `telnet_fd`, `POLLERR` auf `telnet_fd`, `poll` < 0 außer `EINTR`. „session ended“:
  `read(telnet_fd)` == 0 (z. B. nach `exit`), jedes Ende auf `data_fd`-Seite
  (Lesen/Schreiben/`POLLHUP`) und Austritt über `session->state`.
- `websocket.c`: `ws_read_frame` liefert getrennte Codes für Transportfehler und sauberes Ende.
  „connection lost“ nur bei Transport-/TLS-Fehler (`read` < 0, `SSL_ERROR_SYSCALL`/
  `SSL_ERROR_SSL`), Schreibfehler zu Proxmox oder `POLLERR` auf dem WS-Socket; Close-Frame,
  sauberes EOF/`close_notify` und Enden auf `data_fd`-Seite bleiben „websocket session ended“.
  Damit schließt ein `exit` in pve-lxc/pve-shell den Tab immer normal.
- Beide senden `session_closed` **vor** dem Schließen des Daten-Sockets, wie `ssh.c`.
- Der Server braucht dafür keine Änderung: `server/index.js` bildet „connection lost“ bereits auf
  4017 ab.

### Endpunkt `POST /api/connections/:id/reconnect`

- Body (optional): `{ displayDpi }` (gleiche Joi-Regel wie beim Anlegen).
- Ablauf:
  1. Besitz: lebende Sitzung oder Tombstone mit `accountId !== req.user.id` → `404` (keine
     Auskunft über fremde Sitzungen).
  2. Läuft für die ID bereits ein Reconnect (`reconnectOperations: Map<id, Promise>`), wird
     dasselbe Promise abgewartet und dessen Ergebnis geliefert. Sonst wird sofort ein Promise
     für die Schritte 3–8 eingetragen und nach Abschluss entfernt.
  3. Lebt die Sitzung noch, ist nicht im Abbau und läuft keine Karenz
     (`!session._removing && !session._closeGrace`) → `409 Conflict`. Läuft die Karenz oder der
     Abbau, wird deren Ende abgewartet (Karenz-Promise bzw. Removal-Promise an der Sitzung) und
     mit Schritt 4 fortgefahren.
  4. Kein Tombstone oder abgelaufen → `410 Gone`. Ausnahme: Wurde in Schritt 3 eine Karenz
     abgewartet und die Sitzung endete dabei normal (kein Tombstone entstand), antwortet der
     Endpunkt `404 { message: "Session ended" }`; der Client schließt den Tab dann wie bei einem
     normalen Ende statt „Sitzung abgelaufen“ zu zeigen.
  5. Rechte erneut prüfen wie in `createSession`: Zugriff auf Eintrag bzw. Direktziel und
     Identität. Fehlend → `403` bzw. `404`. Der Grund wird **nicht** erneut verlangt.
  6. Neue Sitzung anlegen mit **derselben ID**, `generation = tombstone.generation + 1` und
     der gespeicherten Konfiguration; `tmuxCreate = true`, falls `tmuxSession` gesetzt.
     `displayDpi` aus dem Body ersetzt den gespeicherten Wert, falls vorhanden. Vor
     `SessionManager.create` verwirft `consumeFailedReason(id)` einen noch liegenden Fehlertext
     der alten Generation, und der Audit-Eintrag `entry.reconnect` (neu in `AUDIT_ACTIONS` als
     `RECONNECT`, mit Eintrag in `ACTION_LABELS`; unterliegt `enableServerConnectionAudit`;
     `resource`/`resourceId` wie beim Anlegen; `details: { reconnectOf: id, generation,
     connectionReason }`) wird geschrieben; seine ID geht als `auditLogId` an
     `SessionManager.create`.
  7. Tombstone entfernen.
  8. Antwort `200 { sessionId, generation }`; danach einmal CONNECTIONS/LIVE_SESSIONS
     broadcasten.
- Die Verbindung selbst baut wie beim Anlegen `createConnectionForSession` asynchron auf;
  scheitert sie, endet die neue Generation mit 4017 und hinterlässt einen neuen Tombstone.

`createSession` wird dafür so umgebaut, dass Anlegen und Reconnect denselben Kern nutzen:
eine interne Funktion `openSession({ accountId, sessionId?, generation?, configuration,
entry/directTarget, connectionReason, ... })`, die Prüfung, Konfiguration, `SessionManager.create`
und `createConnectionForSession` bündelt. Die öffentliche, positionelle Signatur von
`createSession` bleibt für bestehende Aufrufer erhalten, damit dieser Umbau klein bleibt.

### Generationen und Engine-Sitzungs-IDs

- Jede Sitzung trägt `generation` (erste Sitzung: 1).
- Engine-Sitzungs-ID: Generation 1 nutzt die nackte Sitzungs-ID (keine Änderung bestehender
  Pfade), ab Generation 2 `<sessionId>:<generation>` (max. 36 + 1 + Ziffern < 64 =
  `MAX_SESSION_ID_LEN`).
- Die Engine-ID der aktuellen Generation steht als `session.engineSessionId` an der Sitzung.
  `openEngineSession`, `waitForDataConnection`, `closeSession`, `sendSessionResize` (über
  `conn.sessionId` = Engine-ID in `setConnection` für ssh/telnet), `joinSession`
  (`hooks/guacamole.js`), `auxSessionIds` (Form `<engineSessionId>-<suffix>-<n>`) und
  `controlPlane.registerRecordingSession` verwenden sie. `GuacdClient` erhält zusätzlich
  `engineSessionId` und setzt `recording-name` darauf (`engine/src/net/connection.c:359` sucht
  die Datei unter der Engine-ID); `updateConnectionId` und `onMasterConnectionClosed` bleiben
  bei der stabilen `sessionId`.
- `ControlPlane` `sessionClosed` und `engineDisconnected` liefern Engine-IDs.
  `resolveEngineSession(engineId) → { sessionId, generation } | null` erkennt nur `<uuid>` und
  `<uuid>:<n>`; Hilfs-IDs liefern `null` und werden in `sessionClosed`/`engineDisconnected`
  übersprungen. Ereignisse, deren Generation nicht der aktuellen Sitzung entspricht, werden
  ignoriert und nur geloggt. Damit kann ein verspätetes „Sitzung beendet“ der alten Verbindung
  die neue nicht entfernen.
- `SessionManager.remove` darf beim Abbau nur die Ressourcen seiner eigenen Generation
  freigeben (Aufzeichnung, Transfer-Registry, Preview-Tokens, Engine-Sitzung).

### Aufzeichnung, Freigaben

- Eine laufende Aufzeichnung wird beim Abbruch wie heute abgeschlossen. Die neue Generation
  bekommt als `auditLogId` die ID ihres Reconnect-Audit-Eintrags; Aufzeichnung (cast und guac)
  und Sitzungsdauer hängen daran. Unterdrückt die Org-Einstellung den Eintrag, gibt es wie
  heute keine Aufzeichnung.
- Freigabe-Links (`shareId`) enden beim Abbruch wie heute. Org-Zuschauer können nach dem
  Reconnect über dieselbe ID wieder beitreten.

### Einstellung

`terminal.autoReconnect: boolean`, Standard `true`. Server: `server/validations/preferences.js`
`terminalSchema`. Client: `PreferencesContext.jsx` Gruppe `terminal.input`, Schalter unter
Einstellungen → Terminal.

## Client

### Fehlerklassifizierung

`client/src/common/utils/ConnectionErrorUtil.js` (aus Nexterm, zusammengeführt mit dem
heutigen `mapConnectionError` aus `ConnectionError.jsx`, der dorthin umzieht):

`classifyConnectionError({ message, code, statusCode, protocol }) → { text, retryable }`

- Nicht wiederholbar: Anmeldung fehlgeschlagen, Berechtigung verweigert, Host-Key-Fehler,
  RDP-Logoff/Manuell getrennt/Zwangsweise getrennt, Verdrängung durch andere Verbindung,
  Sitzungszeitlimit, Antworten `403`/`404`/`410` des Reconnect-Endpunkts.
- Wiederholbar: Code 4017 (Connection lost, Engine disconnected), Timeout, Host nicht
  erreichbar, Verbindung verweigert, unerwartetes Schließen (Code ≠ 1000/1005), Guacamole-
  Trennung ohne Fehlertext nach bestehender Verbindung.

Die Importe von `mapConnectionError` in `XtermRenderer`, `GuacamoleRenderer` und
`ScriptRenderer` werden auf `ConnectionErrorUtil.js` umgestellt.

### `useAutoReconnect`

`client/src/common/hooks/useAutoReconnect.js`, aus Nexterm fast unverändert, angepasst an
`activeSessions` in `SessionContext`:

- Wartezeiten `[5, 10, 30, 60, 120]` s; Zustand pro Sitzung
  `{ attempt, maxAttempts, nextAttemptAt }` für den Countdown.
- Pro Sitzung höchstens ein laufender Versuch, danach 3 s Sperre („Jetzt verbinden“ umgeht sie).
- Zähler-Reset erst, wenn eine Verbindung 10 s stabil ist.
- Sofortiger Versuch bei `window.online`, wenn die Status-Verbindung zum Server zurückkommt,
  und bei `document.visibilitychange` → sichtbar.
- Automatik nur, wenn `terminal.autoReconnect` an, Fehler `retryable` und die Sitzung schon
  einmal verbunden war (`wasConnected`). Ein Fehler der Erstverbindung löst keine Automatik
  aus; der Knopf funktioniert trotzdem.
- `ReconnectPolicy.js` aus Nexterm: berechtigt sind die Typen aus „Umfang“; nicht Notizen,
  beigetretene Sitzungen, Skripte, SFTP.
- Kein `reconnectKey` wie in Nexterm: Schlüssel ist die stabile Sitzungs-ID; Nexterms
  Zufalls-Helfer (ee53b67d) entfällt.

### Anbindung

- `Servers.jsx`: `reconnectSession(id)` ruft den Endpunkt; bei Erfolg Fehlerzustand
  (`erroredSessionsRef`) löschen und `generation` am Session-Objekt setzen. `410` → Fehlerseite
  „Sitzung abgelaufen, bitte neu öffnen“ ohne Reconnect-Knopf.
- `409` → Fehlerzustand löschen und den Renderer neu einhängen, ohne neue Generation: das
  Session-Objekt trägt den lokalen Zähler `attachNonce`, der bei jedem `409` steigt. Für die
  Automatik zählt `409` als Erfolg. `attachNonce` startet bei `0` und ist rein lokal:
  `handleConnectionsUpdate` übernimmt es beim Zusammenführen aus dem bestehenden Objekt
  (`attachNonce: existing.attachNonce ?? 0`), `generation` dagegen aus der Server-Antwort.
- `getSessions` (`server/controllers/serverSession.js`) liefert `generation` mit;
  `handleConnectionsUpdate` übernimmt es ins Session-Objekt. `reconnectSession` setzt es
  zusätzlich sofort aus der Antwort.
- „Schließen“ in `ConnectionError` und das Schließen eines getrennten Tabs rufen `closeSession`
  (mit `DELETE /connections/:id`) statt `disconnectFromServer`.
- `erroredSessionsRef` speichert `{ message, retryable, generation }`. Fehler- und
  Trennungsmeldungen eines Renderers einer älteren Generation werden verworfen.
- `ViewContainer.jsx`: Renderer erhalten `key={`${session.id}-${generation}-${attachNonce}`}`
  und werden so bei jedem Reconnect und jedem Neu-Einhängen sauber neu aufgebaut (nötig, weil Xterm und Guacamole beim Mount
  `getSessionError` prüfen bzw. `errorShownRef` nur einmal feuern).
- `XtermRenderer.jsx`: `markSessionConnected` beim ersten empfangenen Datenpaket.
- `GuacamoleRenderer.jsx`: `markSessionConnected` bei `CONNECTED`. Eine Trennung ohne
  Fehlertext schließt den Tab nicht mehr stumm, wenn die Sitzung verbunden war, sondern meldet
  einen wiederholbaren Abbruch. Ohne vorherige Verbindung bleibt das heutige Verhalten.
- Popout (`client/src/pages/Popout/Popout.jsx`): eigener Zustand
  `{ error, generation, attachNonce }`; „Neu verbinden“ ruft den Endpunkt und hängt den
  Renderer über denselben Key neu ein (bei `409` steigt `attachNonce`). Keine Automatik.

### Oberfläche

Festgelegt in Manifest-Revision 6 (Runde 6), Artboard `docs/design/mockups/ui-servers.html`,
Anleitung `docs/design/guides/ui-servers.md`:

- `UI-SERVERS-VIEW-ERROR` (`ConnectionError`): Knopfzeile „Neu verbinden“ / „Schließen“,
  Countdown „Neuer Versuch in 8 s · Versuch 2/5“ mit „Jetzt verbinden“, Zustände `default`,
  `countdown`, `loading`, `final`, `expired`. Bei RDP-Abmelden, -Trennung, -Verdrängung,
  -Zeitlimit und abgelehnter RDP-Anmeldung (Guac-Status 0x0209/0x020A/0x020B/0x03xx) gibt es keinen
  Tombstone; die Karte zeigt dann in `final` nur „Schließen“ (`reconnectable: false`). Bei
  einem SSH-Anmeldefehler bleibt „Neu verbinden“.
- `UI-SERVERS-TAB-CONNECTION` (`ServerTabs`): Label gedämpft, `Unplug` bei getrennt,
  drehendes `RotateCw` beim Neuverbinden; Marker und Streifen unverändert.
- `UI-SERVERS-TABS`: Kontextmenüeintrag „Neu verbinden“ an erster Stelle, nur bei getrennten
  Sessions.
- `UI-SERVERS-VIEW`: Zustand `error` zeigt `UI-SERVERS-VIEW-ERROR`.
- Einstellungen → Terminal: Schalter „Automatisch neu verbinden“ (Einstellungsseiten sind
  nicht im Manifest erfasst).
- Texte in `en.json` und `de_DE.json`.

Alle übrigen Elemente des Screens `UI-SERVERS` in der Tabelle unten sind Bestand und werden
von dieser Spec nicht verändert; sie dürfen nur nicht regressieren.

## Fehler- und Randfälle

| Fall | Verhalten |
|---|---|
| Server-Neustart | Tombstones nur im Speicher → `410`, „bitte neu öffnen“. |
| Reconnect scheitert erneut | Neue Generation endet mit 4017, neuer Tombstone, Automatik zählt weiter. |
| Rechte entzogen / Eintrag gelöscht | `403`/`404`, nicht wiederholbar, Automatik stoppt. |
| Zwei Fenster gleichzeitig | Deduplizierung über `reconnectOperations`, beide erhalten dasselbe Ergebnis. |
| Tab während Countdown geschlossen | Timer abbrechen; „Schließen“ ruft `closeSession`, `DELETE` entfernt den Tombstone. |
| Sitzung lebt noch (nur die Browser-Verbindung war weg, z. B. Standby) | `409`, Client löscht den Fehlerzustand und hängt den Renderer neu ein (`attachNonce`). |
| Verspätetes `sessionClosed` alter Generation | Ignoriert (Generation passt nicht). |

## Abweichungen von Nexterm

- Parameter kommen aus dem Tombstone, nicht aus dem Client-Body (der Client kennt
  `directIdentity` und den Grund nicht).
- Eigene Engine-ID pro Generation statt `closeSessionAndWait` mit 5-s-Timeout.
- Anmeldefehler sind nicht wiederholbar (Kontosperre durch Fehlversuche).
- `visibilitychange` als zusätzlicher Auslöser.
- Kein Umbau von `createSession` auf ein Options-Objekt als Voraussetzung; gemeinsamer Kern
  statt Signaturwechsel.

## Tests

Ein Test je Verhalten, Integration über die Naht bevorzugt.

Server (`server/lib/__tests__/`):
1. Abbruch mit 4017 hinterlässt einen Tombstone (auch wenn der Daten-Socket innerhalb der 1-s-Karenz vor der Engine-Meldung schließt); normales Ende und RDP-Logoff (Guac-Status
   0x020B) nicht; ein Engine-Abbruch, bei dem der Daten-Socket vor `engineDisconnected`
   schließt, hinterlässt einen.
2. Reconnect liefert dieselbe ID mit `generation + 1` und nutzt die gespeicherte
   Konfiguration (Direkt-Identität, tmux mit `tmuxCreate`, Grund).
3. Verspätetes `sessionClosed` der alten Engine-ID und ein auslaufender Karenz-Timer der alten
   Generation lassen die neue Generation leben.
4. Zwei gleichzeitige Reconnects ergeben genau eine neue Sitzung.
5. Fremdes Konto → `404`, abgelaufener Tombstone → `410`.
6. Reconnect schreibt `entry.reconnect` ins Audit-Log.
7. (entfällt, Entscheidung 2026-10-05: reine Joi-Zusage; geprüft wird stattdessen der
   Reconnect-Body, SEC-INPUT-01.)
8. `409`-Pfad: lebt die Sitzung (nur Browser-Socket weg), antwortet Reconnect `409` und ändert
   nichts.

Client (vitest, `*.test.jsx`):
1. Klassifizierung: Anmeldefehler nicht wiederholbar, 4017 wiederholbar.
2. `useAutoReconnect`: Wartezeiten und Zähler-Reset mit Fake-Timern.
3. `ConnectionError` zeigt Countdown, „Jetzt verbinden“ löst den Reconnect aus.

Manuell auf `outpost-test` (DS918+): SSH mit tmux und Claude Code, Engine-Prozess neu starten
bzw. Netz kurz trennen; RDP-Sitzung mit kurz getrenntem VM-Netz; Handy in den Standby und zurück.

<!-- mockingbird:design:begin -->
<!-- design: manifest=docs/design/manifest.yaml design_rev=7 design_hash=sha256:e051f90d123e2a5f12b75afbd98327d8477e56b766c84c30660a8c86faf63e3e system=docs/design/design-system.md index=docs/design/mockups/index.html adapter=web screens=UI-SERVERS consumes=UI-SHELL-ACCOUNT,UI-SHELL-MOBILE-NAV,UI-SHELL-NAV -->
<!-- Generiert aus docs/design/manifest.yaml. Nicht von Hand ändern —
     Änderungen hier werden beim nächsten mockingbird-Lauf überschrieben.
     Design ändern heißt Manifest ändern. -->

## UI Requirements

| ID | Element | Screen | Status | Fachlicher Anker |
|----|---------|--------|--------|------------------|
| UI-SERVERS-LIST | Server | UI-SERVERS | required | Die Verbindungsziele des Nutzers, gruppiert nach Ordner und Organisation, plus verknüpfte OneDrive-Konten. Nicht: session, tab, identity, snippet. |
| UI-SERVERS-SEARCH | Suche | UI-SERVERS | required | Filtert die Server-Liste nach Name, IP oder Tag, ohne die Gruppierung aufzulösen. |
| UI-SERVERS-LIST-MENU | Kontextmenü Server | UI-SERVERS | required | Zweitweg für Aktionen auf einem Eintrag — Verbinden, SFTP öffnen, Notizen, Bearbeiten, Duplizieren, Session beitreten, Löschen. Port weiterleiten erscheint nur in der Desktop-App (Tauri), im Web-Build nie. Nicht: primary_navigation. |
| UI-SERVERS-TABS | Sessions | UI-SERVERS | required | Die aktuell offenen Sessions als Tabs, jede mit ihrer Split-View-Zuordnungsfarbe; Kontextmenü mit Umbenennen, Duplizieren, Teilen, Schlafen legen, Ausklinken, Schließen — bei einer getrennten Session zusätzlich Neu verbinden, an erster Stelle. Nicht: server_entry, folder. |
| UI-SERVERS-TAB-MARKER | Zustand eines Tabs | UI-SERVERS | required | Der Platz links im Tab. Im Ruhezustand ein Punkt in der Farbe des Split-Fensters, zu dem der Tab gehört. Läuft ein Befehl, der Prozente ausgibt, steht dort stattdessen ein Ring, der sich im Uhrzeigersinn füllt. Nicht: connection_state, session. |
| UI-SERVERS-TAB-CONTEXT | Kontextfüllung | UI-SERVERS | required | Der Streifen am oberen Rand eines Tabs. Ohne Agenten die Farbe des Split-Fensters über die volle Breite; meldet ein Agent seine Kontextfüllung, wird derselbe Streifen zur Spur, in der ein Balken dieser Länge wächst -- in derselben Farbe, aber höher, damit „kein Agent" und „randvoll" sich unterscheiden. Nicht: session_activity, connection_state, pane_color. |
| UI-SERVERS-TAB-LABEL | Beschriftung eines Tabs | UI-SERVERS | required | Der Text eines Tabs. Name zuerst, dann die Art in Klammern, zuletzt die Nummer. Die Nummer unterscheidet Tabs, die sonst gleich hießen, und erscheint nur, solange in der Leiste tatsächlich ein zweiter solcher Tab steht. Nicht: server_entry, hostname. |
| UI-SERVERS-TAB-CONNECTION | Verbindungszustand eines Tabs | UI-SERVERS | required | Zeigt am Label, dass die Verbindung einer Session weg ist oder gerade neu aufgebaut wird: das Label wird in --subtext gedämpft, dahinter steht ein kleines Icon — Unplug bei getrennt, ein sich drehendes RotateCw beim Neuverbinden. Im Normalzustand ist nichts zu sehen. Marker und Kontextstreifen bleiben unberührt; ein Ring im Marker heißt weiterhin Fortschritt, nicht Verbindung. Nicht: session_activity, agent_context, pane_color. |
| UI-SERVERS-VIEW | Arbeitsfläche | UI-SERVERS | required | Der Inhalt der aktiven Session, einzeln oder als Split; Terminal und Datei-Pane nebeneinander sind der Kernfall. Nicht: server_entry. |
| UI-SERVERS-VIEW-ERROR | Verbindungsfehler | UI-SERVERS | required | Die Karte, die in der Arbeitsfläche an die Stelle einer abgebrochenen Session tritt: Icon, Titel, Fehlertext im Klartext, darunter eine Knopfzeile. Primär Neu verbinden (während der Automatik Jetzt verbinden), sekundär Schließen. Läuft die Automatik, steht über den Knöpfen der Countdown mit Versuchszähler. Neu verbinden baut dieselbe Session im selben Tab und an derselben Stelle im Layout wieder auf; es öffnet keinen neuen Tab. Nicht: server_entry, server_dialog. |
| UI-SERVERS-FOCUS | Fokus-Modus | UI-SERVERS | required | Blendet Server-Liste und Tab-Leiste aus, nur das aktive Pane bleibt; Taste Ctrl+Shift+F, greift automatisch unter den Mindestbreiten (Terminal 40 rem, Datei-Pane 22 rem). Nicht: fullscreen_browser. |
| UI-SERVERS-KEYBAR | Tastenleiste | UI-SERVERS | required | Terminal-Sondertasten (Esc, Tab, Ctrl, Alt, Shift, Pfeile, Home, Ende, Bild auf/ab sowie die auf Touch-Tastaturen vergrabenen Zeichen | ~ - /), und nur wenn das aktive Pane ein Terminal ist. Sichtbar nach der Einstellung terminal.keyBar (auto/always/never); auto heißt "es gibt gar keinen präzisen Zeiger" — die Frage ist any-pointer, nicht pointer, denn ein Tablet meldet einen groben Primärzeiger auch mit angeschlossener Maus, und wer eine Maus hat, braucht keine Tastenleiste. Sie sitzt über der Arbeitsfläche, nicht darunter: unterhalb schneidet eine Kette aus vier height-100%-Containern sie ab. |
| UI-SERVERS-ACTIONS | Aktionen | UI-SERVERS | required | Werkzeuge für das aktive Pane: Snippets, Broadcast an alle Panes (nur bei geteilter Ansicht bedienbar), Vollbild. Tastenkürzel nur bei Guacamole-Sitzungen, wo sie hingehören. Teilen, Ausklinken und Schließen liegen im Tab-Kontextmenü (UI-SERVERS-TABS), nicht hier — die Trennung ist beabsichtigt: hier Werkzeuge, dort Sitzungsverwaltung. |
| UI-SERVERS-WELCOME | Willkommen | UI-SERVERS | required | Leerzustand ohne offene Session — links die Begrüßung mit Namen und die Einstiege (Schnellverbindung, Server anlegen, Gerät verbinden, Apps herunterladen), rechts die zuletzt genutzten Verbindungen als Zeilen mit Farbfeld (Kennfarbe aus der Eintrags-ID, nicht die Pane-Farbe eines Tabs), Name, Alter und Protokoll-Badge. Schlafende Sitzungen erscheinen in der Liste und werden fortgesetzt statt neu verbunden. Positiv, handlungsorientiert, kein Marketing. Nicht: all_servers, marketing. |

**Übernommene Elemente** (hier nicht zu bauen, nur zu verwenden):
- `UI-SHELL-ACCOUNT` — Konto
- `UI-SHELL-MOBILE-NAV` — Bereiche (schmaler Schirm)
- `UI-SHELL-NAV` — Bereiche

Artboards: `docs/design/mockups/index.html` · Design-System: `docs/design/design-system.md`
<!-- mockingbird:design:end -->

<!-- preflight:security:begin -->
<!-- facts: network_surface=both has_accounts=yes auth_method=own-password
     has_privilege_levels=yes session_transport=bearer-header has_owned_data=yes
     is_multi_tenant=no persistence=sql renders_html=yes accepts_uploads=yes
     handles_pii=no -->

## Security Requirements

| ID | Maßnahme | Geltungsbereich | Status | Begründung |
|----|----------|-----------------|--------|------------|
| SEC-INPUT-01 | Input-Validierung per Whitelist | Reconnect-Endpunkt (`:id`, `displayDpi`), Einstellung `autoReconnect` | required | HTTP-API |
| SEC-ERR-01 | Fehlermeldungen ohne Stack-Traces und DB-Details | Antworten des Reconnect-Endpunkts, Fehlertexte an den Client | required | HTTP-API |
| SEC-SECRET-01 | Secrets außerhalb von Code und Repo | Tombstone mit `directIdentity` nur im Speicher, nie geloggt | required | immer |
| SEC-DEP-01 | Abhängigkeiten auf bekannte Schwachstellen prüfen | neue/übernommene Client-Bausteine | required | immer |
| SEC-INJECT-01 | Fremde Eingaben nicht in Befehle oder Pfade bauen | tmux-Sitzungsname beim Reconnect, Engine-Sitzungs-ID | required | immer |
| SEC-RATE-01 | Rate Limiting auf zustandsändernden Endpunkten | `POST /api/connections/:id/reconnect` | required | HTTP-API |
| SEC-RATE-02 | Brute-Force-Bremse am Login | Login | not-applicable | (2026-10-05) Reconnect ändert den Login nicht |
| SEC-SQLI-01 | Prepared Statements, keine String-Konkatenation | Audit-Eintrag, Rechteprüfung | required | SQL-Persistenz |
| SEC-XSS-01 | Kontextsensitives Output-Encoding | Fehlertexte und Countdown in `ConnectionError`, Tab-Zustand | required | React-Oberfläche |
| SEC-CSP-01 | Content Security Policy | gesamte Oberfläche | not-applicable | (2026-10-05) Reconnect liefert kein neues HTML und lädt keine fremden Ressourcen |
| SEC-UPLOAD-01 | Upload-Prüfung | Dateimanager | not-applicable | (2026-10-05) Reconnect nimmt keine Dateien entgegen |
| SEC-IDOR-01 | Objektbezogene Autorisierung bei jedem Zugriff über eine ID | Tombstone nur für das besitzende Konto, erneute Rechteprüfung auf Eintrag und Identität | required | Sitzungen gehören Konten |
| SEC-RBAC-01 | Rollen- oder Rechtemodell | Rechteprüfung beim Reconnect wie bei `createSession` | required | Berechtigungssystem |
| SEC-PWH-01 | Passwort-Hashing mit Argon2id oder bcrypt | Konten | not-applicable | (2026-10-05) Reconnect speichert und prüft keine Passwörter |
| SEC-PWPOL-01 | Mindestanforderungen, Abgleich gegen bekannte Leaks | Konten | not-applicable | (2026-10-05) Reconnect ändert keine Passwortregeln |
| SEC-MFA-01 | Zweiter Faktor | Login | not-applicable | (2026-10-05) Reconnect ändert den Login nicht |
| SEC-SESS-02 | Ablauf, Rotation, serverseitiger Widerruf | Reconnect nur mit gültiger Login-Session; Abmelden verwirft Tombstones des Kontos | required | Bearer-Session |
| SEC-TOKEN-01 | Token-Validierung, Lebensdauer, sichere Ablage, Widerruf | Reconnect-Endpunkt hinter bestehender Authentifizierung | required | Bearer-Header |
<!-- preflight:security:end -->
