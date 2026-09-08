# Servers — Arbeitsfläche — Umsetzungsanleitung (UI-SERVERS)

Artboard: docs/design/mockups/ui-servers.html · Manifest-Revision: 3

Diese Seite existiert bereits (`client/src/pages/Servers/Servers.jsx`). Die
Anleitung schreibt den Bestand fest und fügt genau ein neues Verhalten hinzu:
den Fokus-Modus. Nichts wird neu gebaut, was es gibt.

## Wo im Code
- `client/src/pages/Servers/Servers.jsx` — Einhängepunkt für `UI-SERVERS-FOCUS` (Zustand + Taste)
- `client/src/pages/Servers/components/ServerList/ServerList.jsx` — `UI-SERVERS-LIST`, `UI-SERVERS-SEARCH` (in `components/ServerSearch`), `UI-SERVERS-LIST-MENU` (ContextMenu)
- `client/src/pages/Servers/components/ViewContainer/ViewContainer.jsx` — `UI-SERVERS-VIEW`; darin `components/ServerTabs` → `UI-SERVERS-TABS`, `components/TerminalKeyBar` → `UI-SERVERS-KEYBAR`, `components/TerminalActionsMenu` → `UI-SERVERS-ACTIONS`
- `client/src/pages/Servers/components/WelcomePanel/WelcomePanel.jsx` — `UI-SERVERS-WELCOME`
- Wiederverwenden: `ContextMenu`, `ContextMenuItem`, `ContextMenuSeparator`, `Tooltip`, `Icon` aus `client/src/common/components/`
- Styles: `styles.sass` der jeweiligen Komponente; Werte aus `client/src/common/styles/_colors.sass` (siehe `docs/design/design-system.md`)

## Darstellung
- Art: Seite, Route `/servers`. Dreiteilig: Liste links (einklappbar), Tabs oben, Fläche rechts.
- Fokus-Modus: `Ctrl+Shift+F` schaltet; unter 40 rem Terminal-Breite bzw. 22 rem Datei-Pane greift er automatisch. Im Fokus-Modus: Liste und Tab-Leiste ausgeblendet, nur das aktive Pane; `UI-SERVERS-ACTIONS` bleibt als schmaler Griff erreichbar.
- Tastenleiste nur auf Touch-Geräten (`@media (pointer: coarse)`, nicht an einem Breitpunkt: ein aufgeklapptes Foldable ist breiter als jeder Mobil-Breitpunkt und braucht sie am dringendsten) und nur, wenn das aktive Pane ein Terminal ist.

## Elemente — eins nach dem anderen
### UI-SERVERS-LIST — Server
- Markup-Wurzel der Liste (`ServerList.jsx`, äußerstes Element) trägt `data-ui-id="UI-SERVERS-LIST"` — genau einmal.
- Datenquelle: `GET /entries` → Ordner, Organisationen, Server, OneDrive-Konten. Muss **Verbindungsziele** liefern, **nicht** Sessions/Tabs/Identitäten.
- Zustände: `loading` Skeleton-Zeilen (kein Spinner-Vollbild) · `empty` Copy wörtlich „Noch keine Server. Server anlegen, SSH-Config importieren oder direkt verbinden." mit drei Aktionen · `error` „Serverliste konnte nicht geladen werden." + Erneut-laden · `selected` Akzent-Hinterlegung `--primary-opacity`.
- Tokens: `--lighter-background` (Fläche), `--gray` (Trenner), `--text`/`--subtext`, `--primary-opacity` (Auswahl).

### UI-SERVERS-SEARCH — Suche
- `data-ui-id="UI-SERVERS-SEARCH"` am Eingabefeld-Wrapper in `ServerSearch`.
- Filtert nach Name und Tag; Gruppierung bleibt sichtbar. `empty` Copy „Kein Server passt zur Suche."

### UI-SERVERS-LIST-MENU — Kontextmenü Server
- `data-ui-id="UI-SERVERS-LIST-MENU"` am `ContextMenu`-Container der Liste.
- Einträge in dieser Reihenfolge: Verbinden · SFTP öffnen · Notizen · — · Bearbeiten · Duplizieren · Session beitreten · — · Löschen (destruktiv, `--error`, mit `ActionConfirmDialog`). Port weiterleiten steht nur in der Desktop-App (Tauri) und rendert im Web-Build nicht.
- Zweitweg: jede Aktion hat auch eine Taste (bestehende i18n-Schlüssel `servers.contextMenu.*` beibehalten).

### UI-SERVERS-TABS — Sessions
- `data-ui-id="UI-SERVERS-TABS"` an der Tab-Leiste in `ServerTabs`.
- Datenquelle: die offenen Sessions (Server-, SFTP-, Notiz-, Skript-Tabs) — **nicht** die Server-Liste.
- Jeder Tab trägt seine Split-View-Farbe als Streifen (Regel und Palette: `/root/docs/superpowers/specs/2026-08-15-split-view-colors-design.md`; die Farben im Artboard sind Platzhalter).
- Kontextmenü: Umbenennen · Duplizieren · Teilen/Teilen beenden · Schreibschutz · Schlafen legen · Ausklinken · Notizen · Schließen.
- Zustände: `selected` (aktiv: `--gray-strong` Fläche + Farbstreifen) · `empty` (keine Session → Tab-Leiste leer, Welcome sichtbar).

### UI-SERVERS-VIEW — Arbeitsfläche
- `data-ui-id="UI-SERVERS-VIEW"` am Renderer-Container in `ViewContainer`.
- Zeigt die aktive Session über die vorhandenen Renderer (`XtermRenderer`, `FileRenderer`, `GuacamoleRenderer`, `NotesRenderer`, `ScriptRenderer`); Split via bestehendem `ResizeHandle`.
- Zustände: `loading` „Verbinde …" zentriert auf `--terminal` · `error` „Verbindung fehlgeschlagen. Erneut versuchen oder Server bearbeiten." mit zwei Aktionen.

### UI-SERVERS-FOCUS — Fokus-Modus (neu)
- `data-ui-id="UI-SERVERS-FOCUS"` am Umschalter (Icon-Button rechts in der Tab-Leiste) **und** derselbe Zustand steuert die Klasse `focus-mode` am Seiten-Wrapper.
- Taste `Ctrl+Shift+F` (global auf der Seite, nicht im Terminal-Fokus verschluckt — Handler auf `keydown` mit `event.preventDefault()`).
- Automatik: `ResizeObserver` auf dem Pane; unter 40 rem (Terminal) / 22 rem (Datei) → ein, darüber → nur zurück, wenn der Nutzer ihn nicht manuell aktiviert hatte.
- Zustand `selected` = aktiv (Akzent-Icon).

### UI-SERVERS-KEYBAR — Tastenleiste
- `data-ui-id="UI-SERVERS-KEYBAR"` an `TerminalKeyBar`. Nur bei `pointer: coarse`, nur bei Terminal-Pane; Höhe `--key-bar-height`. Trefferflächen ≥ 44 px.

### UI-SERVERS-ACTIONS — Aktionen
- `data-ui-id="UI-SERVERS-ACTIONS"` an `TerminalActionsMenu` (gesetzt).
- Inhalt (Bestand, so beibehalten): Snippets · Broadcast (bei einzelner Ansicht deaktiviert, nicht versteckt) · Vollbild. Tastenkürzel erscheinen nur bei Guacamole-Sitzungen — bei einem SSH-Terminal gäbe es nichts, worauf sie wirken.
  Vollbild. **Nicht** Teilen/Ausklinken/Schließen — die liegen im
  Tab-Kontextmenü. Der Eintrag „Vollbild" wird beim Fokus-Modus (Blocker 2)
  zu dessen Umschalter ausgebaut, nicht ersetzt.
- `disabled` ohne aktive Session fehlt noch (Important-Befund).

### UI-SERVERS-WELCOME — Willkommen
- `data-ui-id="UI-SERVERS-WELCOME"` an `WelcomePanel`. Datenquelle `GET /entries/recent?limit=5` — **die letzten fünf Verbindungen**, nicht alle Server.
- Inhalte: Begrüßung (`welcome.hello`), letzte Verbindungen, Erste Schritte, Gerät verbinden, Apps. `empty` Copy „Noch keine Verbindungen. Lege einen Server an oder verbinde dich direkt."

### UI-SERVERS-TAB-MARKER
- `data-ui-id` an dem einen Platz links im Tab, den sich Punkt und Ring **teilen** (`.tab-marker`), nicht an einem der beiden.
- `default`: ein Punkt von 0,5 rem in der Farbe des Split-Fensters. `loading`: ein Ring, der sich im Uhrzeigersinn nach dem gemeldeten Prozentsatz füllt, in `--success`.
- Der Platz hat feste Größe — 1 rem, unter 768 px 0,875 rem. Das ist der Punkt: der Ring brachte einmal seine eigene 36-px-Fläche mit, füllte damit die ganze Tabhöhe und schob den Namen bei jedem Prozentwert zur Seite.
- Fortschritt kommt aus `progressParser.js`, das die Terminalausgabe mitliest (Prozentangaben, ASCII-Balken, `x/y`, Byte-Angaben, docker/apt/git). Der Ring erscheint zwischen 1 und 99 und verschwindet bei 100 oder auf einer Abschlusszeile.

### UI-SERVERS-TAB-CONTEXT
- `data-ui-id` am Streifen am oberen Rand (`.tab-stripe`), in **beiden** Zuständen -- sonst wäre das Element nur auffindbar, solange gerade ein Agent läuft.
- `default`: Fensterfarbe über die volle Breite, 2 px. `loading`: dieselbe Farbe als Balken auf einer sichtbaren Spur, **3 px**.
- Der Höhenunterschied ist kein Zierrat. In der Einzelansicht hat kein Tab eine Fensterfarbe, der gewöhnliche Streifen ist dort durchsichtig; beim Wechsel in die geteilte Ansicht bekommt jeder Tab eine Farbe, und ein Tab ohne Agenten zeigte sonst einen durchgehenden Streifen, der sich wie ein randvoller Balken liest.
- **Outpost misst nichts.** Der Wert kommt vom Agenten selbst als Marke im Terminalstrom: `⟦ctx <werkzeug> <prozent>⟧`, gelesen in `utils/contextParser.js`. Für Claude Code schreibt sie dessen eigene Statuszeile, für qwen die tmux-Statusleiste (`scripts/outpost-statusline.js` bzw. `scripts/outpost-ctx.js`).
- Von innen gemessen und nicht von außen, weil mehrere Sitzungen desselben Werkzeugs im selben Verzeichnis laufen und der Prozess seine Verlaufsdatei nicht offen hält -- eine Zuordnung Terminal → Sitzung ist von außen nicht verlässlich.
- Kein Wert heißt **kein Agent**, nicht „Kontext leer". Ein Balken auf 0 % würde behaupten, gemessen worden zu sein.

### UI-SERVERS-TAB-LABEL
- `data-ui-id` an der Beschriftung (`<h2>` im Tab). Reihenfolge: Name, Art, Nummer — die Art sagt, **was** der Tab ist, die Nummer, **welcher von mehreren**.
- Die Nummer erscheint nur, solange in der Leiste tatsächlich ein zweiter Tab steht, der sonst gleich hieße (`idsNeedingNumber`). Ein einzelner Tab trägt nie eine.
- Vergeben wird die kleinste Nummer, die die Gruppe gerade nicht benutzt; die 1 wird nie geschrieben. Eine bereits vergebene Nummer wird weitergereicht, nie neu berechnet — sonst würde das Schließen eines Tabs die übrigen umbenennen, während man sie ansieht.

## Ausdrücklich nicht
- **Keine Nummer als Zähler.** Sie beantwortet „welcher von mehreren", nicht „wie oft schon geöffnet". Eine geschlossene Sitzung reserviert nichts.
- Keine Aktivitätsleiste mit Icon-Spalte, keine Statusleiste, keine Panels-in-Panels (nicht wie eine IDE).
- Keine zweite Akzentfarbe; keine Rohwerte, wo ein Token existiert.
- Keine Aktion, die nur per Maus geht.
- Kein Onboarding-Overlay im Leerzustand.

## Fertig, wenn
- `mockingbird-scope.sh --locate <ID> --root /root/outpost` jedes der zwölf Elemente auf Tier A findet.
- `/design-verify --screen UI-SERVERS` MATCH ergibt.
