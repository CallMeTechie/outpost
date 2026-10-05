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
| Umfang | ssh, telnet, pve-lxc (Xterm) und rdp, vnc (Guacamole). Nicht: SFTP/OneDrive (eigene Socket-Wiederholung), Skripte (dürfen nicht doppelt laufen), Notizen, beigetretene Sitzungen. |
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
  - der Typ zu den unterstützten gehört (Konfiguration `type` bzw. `renderer` ergibt ssh,
    telnet, pve-lxc, rdp, vnc) und
  - die Sitzung mit einem Fehler endet: `code === 4017` oder Aufruf aus `engineDisconnected`.
- Kein Tombstone bei normalem Ende (Code 1000/ohne Code: `exit`, Tab geschlossen, RDP-Logoff
  über `SESSION_CLOSED`), bei beigetretenen Sitzungen und bei Skripten.
- `createSession` muss dafür `connectionReason` und `organizationId` an der Sitzung ablegen
  (heute nur im Audit-Log).
- Ablauf: ein Aufräumtimer (60 s) entfernt Einträge mit `expiresAt < now`. Höchstens ein
  Tombstone pro ID; ein neuer ersetzt den alten.
- `DELETE /connections/:id` entfernt auch einen vorhandenen Tombstone.

### Engine-Abbruch

`server/index.js` `engineDisconnected`: Sitzungen werden mit
`{ code: 4017, reason: "Engine disconnected" }` entfernt statt ohne Code. Damit erscheint
statt eines stumm geschlossenen Tabs die Fehlerseite, und es entsteht ein Tombstone.

### Endpunkt `POST /api/connections/:id/reconnect`

- Body (optional): `{ displayDpi }` (gleiche Joi-Regel wie beim Anlegen).
- Ablauf:
  1. Läuft für die ID bereits ein Reconnect (`reconnectOperations: Map<id, Promise>`), wird
     dasselbe Promise abgewartet und dessen Ergebnis geliefert.
  2. Lebt die Sitzung noch → `409 Conflict` (Client behandelt das als „bereits verbunden“).
  3. Kein Tombstone oder abgelaufen → `410 Gone`.
  4. `tombstone.accountId !== req.user.id` → `404` (keine Auskunft über fremde Sitzungen).
  5. Rechte erneut prüfen wie in `createSession`: Zugriff auf Eintrag bzw. Direktziel und
     Identität. Fehlend → `403` bzw. `404`. Der Grund wird **nicht** erneut verlangt.
  6. Neue Sitzung anlegen mit **derselben ID**, `generation = tombstone.generation + 1` und
     der gespeicherten Konfiguration; `tmuxCreate = true`, falls `tmuxSession` gesetzt.
     `displayDpi` aus dem Body ersetzt den gespeicherten Wert, falls vorhanden.
  7. Tombstone entfernen, Audit-Eintrag `session.reconnect` mit
     `details: { reconnectOf: id, generation, connectionReason }`.
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
- `openEngineSession`, `waitForDataConnection`, `closeSession`, `auxSessionIds` und die
  Guacamole-Anbindung verwenden die Engine-ID der aktuellen Generation.
- `ControlPlane` `sessionClosed` und `engineDisconnected` liefern Engine-IDs. Eine Funktion
  `resolveEngineSession(engineId) → { sessionId, generation }` übersetzt zurück. Ereignisse,
  deren Generation nicht der aktuellen Sitzung entspricht, werden ignoriert und nur geloggt.
  Damit kann ein verspätetes „Sitzung beendet“ der alten Verbindung die neue nicht entfernen.
- `SessionManager.remove` darf beim Abbau nur die Ressourcen seiner eigenen Generation
  freigeben (Aufzeichnung, Transfer-Registry, Preview-Tokens, Engine-Sitzung).

### Aufzeichnung, Freigaben

- Eine laufende Aufzeichnung wird beim Abbruch wie heute abgeschlossen; die neue Generation
  beginnt eine neue.
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
- Zufallswerte ohne `crypto.randomUUID` (Outpost läuft auch ohne sicheren Kontext).

### Anbindung

- `Servers.jsx`: `reconnectSession(id)` ruft den Endpunkt; bei Erfolg Fehlerzustand
  (`erroredSessionsRef`) löschen und `generation` am Session-Objekt setzen. `410` → Fehlerseite
  „Sitzung abgelaufen, bitte neu öffnen“ ohne Reconnect-Knopf.
- `erroredSessionsRef` speichert `{ message, retryable, generation }`. Fehler- und
  Trennungsmeldungen eines Renderers einer älteren Generation werden verworfen.
- `ViewContainer.jsx`: Renderer erhalten `key={`${session.id}-${generation}`}` und werden so
  bei jedem Reconnect sauber neu aufgebaut (nötig, weil Xterm und Guacamole beim Mount
  `getSessionError` prüfen bzw. `errorShownRef` nur einmal feuern).
- `XtermRenderer.jsx`: `markSessionConnected` beim ersten empfangenen Datenpaket.
- `GuacamoleRenderer.jsx`: `markSessionConnected` bei `CONNECTED`. Eine Trennung ohne
  Fehlertext schließt den Tab nicht mehr stumm, wenn die Sitzung verbunden war, sondern meldet
  einen wiederholbaren Abbruch. Ohne vorherige Verbindung bleibt das heutige Verhalten.
- Popout (`client/src/pages/Popout/Popout.jsx`): Knopf „Neu verbinden“ ohne Automatik.

### Oberfläche

Festgelegt in Manifest-Revision 6 (Runde 6), Artboard `docs/design/mockups/ui-servers.html`,
Anleitung `docs/design/guides/ui-servers.md`:

- `UI-SERVERS-VIEW-ERROR` (`ConnectionError`): Knopfzeile „Neu verbinden“ / „Schließen“,
  Countdown „Neuer Versuch in 8 s · Versuch 2/5“ mit „Jetzt verbinden“, Zustände `default`,
  `countdown`, `loading`, `final`, `expired`.
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
| Tab während Countdown geschlossen | Timer abbrechen, `DELETE` entfernt den Tombstone. |
| Sitzung lebt noch | `409`, Client verwirft den Fehlerzustand. |
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
1. Abbruch mit 4017 hinterlässt einen Tombstone, normales Ende nicht.
2. Reconnect liefert dieselbe ID mit `generation + 1` und nutzt die gespeicherte
   Konfiguration (Direkt-Identität, tmux mit `tmuxCreate`, Grund).
3. Verspätetes `sessionClosed` der alten Engine-ID lässt die neue Generation leben.
4. Zwei gleichzeitige Reconnects ergeben genau eine neue Sitzung.
5. Fremdes Konto → `404`, abgelaufener Tombstone → `410`.
6. Reconnect schreibt `session.reconnect` ins Audit-Log.
7. `terminal.autoReconnect` wird validiert.

Client (vitest, `*.test.jsx`):
1. Klassifizierung: Anmeldefehler nicht wiederholbar, 4017 wiederholbar.
2. `useAutoReconnect`: Wartezeiten und Zähler-Reset mit Fake-Timern.
3. `ConnectionError` zeigt Countdown, „Jetzt verbinden“ löst den Reconnect aus.

Manuell auf `outpost-test` (DS918+): SSH mit tmux und Claude Code, Engine-Prozess neu starten
bzw. Netz kurz trennen; RDP-Sitzung mit kurz getrenntem VM-Netz; Handy in den Standby und zurück.

<!-- mockingbird:design:begin -->
<!-- design: manifest=docs/design/manifest.yaml design_rev=6 design_hash=sha256:9d73153572cc72608b1ccbfa9979cb0057c2c5b107e7b3b146401cec1aaee4a3 system=docs/design/design-system.md index=docs/design/mockups/index.html adapter=web screens=UI-SERVERS consumes=UI-SHELL-ACCOUNT,UI-SHELL-MOBILE-NAV,UI-SHELL-NAV -->
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
