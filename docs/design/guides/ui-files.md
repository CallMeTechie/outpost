# Datei-Pane — Aktionsleiste und Favoriten — Umsetzungsanleitung (UI-FILES)

Artboard: docs/design/mockups/ui-files.html · Manifest-Revision: 5

Das Datei-Pane existiert bereits vollständig
(`client/src/pages/Servers/components/ViewContainer/renderer/FileRenderer/`).
Diese Anleitung schreibt den Bestand fest und fügt zwei Dinge hinzu: die
Favoritenleiste samt Stern und Kontextmenü-Einträgen, und ein Eröffnungs-
verzeichnis, das sich merkt, wo man zuletzt war. Nichts wird neu gebaut,
was es gibt — insbesondere nicht die Aktionsleiste, die Adresszeile oder
die Dateiliste.

## Wo im Code
- `.../FileRenderer/FileRenderer.jsx` — die Wurzel des Panes; hier liegen `directory`, `history` und die Auswertung von `READY`. Einhängepunkt für `UI-FILES-FAVORITES` (die Leiste wird zwischen `ActionBar` und `FileList` gerendert).
- `.../FileRenderer/components/ActionBar/ActionBar.jsx` — `UI-FILES-ACTIONBAR`, `UI-FILES-ADDRESS`, `UI-FILES-FAVORITES-TOGGLE`. Der Stern kommt in die bestehende Gruppe `.file-actions`, als **erstes** Kind, unmittelbar vor dem Suchen-Icon.
- `.../FileRenderer/components/FavoritesBar/` — **neu**: `FavoritesBar.jsx`, `styles.sass`, `index.js`. Trägt `UI-FILES-FAVORITES`, `UI-FILES-FAVORITES-OVERFLOW`, `UI-FILES-FAVORITE-MENU`.
- `.../FileRenderer/utils/favoritesOverflow.js` — **neu**, rein: Chip-Breiten und verfügbare Breite hinein, Aufteilung sichtbar/verdeckt heraus. Ohne DOM, damit `node:test` sie erreicht.
- `.../FileRenderer/components/FileList/FileList.jsx` — `UI-FILES-LIST`, `UI-FILES-LIST-MENU` (`contextMenu`, Zeile ~315), `UI-FILES-EMPTY-MENU` (`emptyContextMenu`, Zeile ~333).
- Wiederverwenden: `ContextMenu`, `ContextMenuItem`, `Icon`, `Tooltip` aus `client/src/common/components/`.
- `.../FileRenderer/components/FavoritesBar/FavoriteChip.jsx` — **neu**. Ausdrücklich **nicht** die Bestandskomponente `common/components/Chip`: die ist ein `<button>` mit `label/selected/onClick/icon/disabled` und trägt weder `title` noch Rechtsklick noch Drag-Props, und ein `<input>` zum Umbenennen ist in einem `<button>` nicht bedienbar.
- `.../FileRenderer/utils/bookmarkNotifier.js` — **neu**. Muster von `utils/moveNotifier.js`, aber Filter über `entryId`: `paneAffectedByMove` steigt mit `sessionId !== sourceSessionId` aus und erreicht zwei Kacheln desselben Servers deshalb nie.
- `.../FileRenderer/utils/bookmarkPath.js` — **neu**, die Client-Hälfte der Pfad-Normalisierung; Gegenstück `server/lib/bookmarkPath.js`, gemeinsame Fixture.
- Serverseite: `server/routes/sftpWS.js` (`READY` liefert den Pfad, `PATH_SYNC` schreibt ihn fort), `server/lib/SessionManager.js` (`get/setSftpPath`).
- Styles: `styles.sass` der jeweiligen Komponente; Werte ausschließlich aus `client/src/common/styles/_colors.sass` und `_tokens.sass`.

## Darstellung
- Art: Panel innerhalb von `UI-SERVERS-VIEW`, ausgelöst durch eine Datei-Sitzung (SFTP) im Tab. In der geteilten Ansicht hat **jede Kachel** ihre eigene Aktionsleiste, ihren eigenen Stern und ihren eigenen Streifen — die Bookmarks dahinter sind dieselben.
- Aufbau von oben: Aktionsleiste · Favoritenstreifen (`--favorites-bar-height`, nur wenn eingeschaltet) · Dateiliste.
- Tastatur: `Strg+B` schaltet den Streifen, `←`/`→` wandern zwischen den Chips, `Umschalt+←`/`Umschalt+→` verschieben den fokussierten Chip, `Enter` öffnet. Die bestehende `useKeyboardNavigation` der Dateiliste bleibt unangetastet; der Streifen bringt seine eigene mit, damit die beiden sich nicht um die Pfeiltasten streiten.
- Nur SFTP: In einer OneDrive-Kachel (`paneProvider(session) === "onedrive"`) erscheint der Stern **gar nicht** — nicht ausgegraut, sondern abwesend.

## Elemente — eins nach dem anderen

### UI-FILES-ACTIONBAR — Aktionsleiste (Bestand)
- `data-ui-id="UI-FILES-ACTIONBAR"` an `div.action-bar` in `ActionBar.jsx` — genau einmal.
- Reihenfolge unverändert: `←` `→` `↑` · Adresszeile · Icon-Gruppe. In der Gruppe: **Stern** · Suchen · Ansicht · Neu laden · Datei hochladen · Ordner hochladen · Neue Datei · Neuer Ordner. Die bestehenden Bedingungen (`capabilities.content`, `capabilities.nativeFs`) bleiben, wie sie sind.
- Zustand: nur `default`.

### UI-FILES-ADDRESS — Adresszeile (Bestand + neues Eröffnungsverhalten)
- `data-ui-id="UI-FILES-ADDRESS"` an `div.address-bar`.
- **Muss den Pfad des angezeigten Verzeichnisses zeigen** — nicht das Home, nicht `/`, nicht einen Bookmark-Pfad. Die Brotkrumen selbst ändern sich nicht.
- Eröffnungsverzeichnis, in dieser Reihenfolge: der laufende Session-Speicher (`SessionManager.getSftpPath`), sonst der gemerkte Pfad dieses Kontos für diesen Server **und diese Identität**, sonst `realpath(".")` — das Startverzeichnis des verbundenen Benutzers, bei `root` also `/root`; über FTP das `PWD` der Verbindung. Ist der gemerkte Pfad weg oder nicht lesbar, wird entlang des Pfades aufgestiegen, bis eine `listDir`-Probe trägt (nicht `stat` — ein Verzeichnis kann bestehen und unlesbar sein); greift keiner, das Startverzeichnis, letzter Ausweg `/`.
- Die Kette läuft **serverseitig, bevor `READY` gesendet wird**, nicht im Client: der Client soll kein totes Verzeichnis aufblitzen lassen und keine zweite Runde drehen.
- Zustände: `loading` „Verbinde …" (Bestand) · `partial` — der Aufstieg hat gegriffen, Copy wörtlich aus dem Manifest, mit eingesetzten Pfaden.
- Fortschreibung: `PATH_SYNC` schreibt den Pfad entprellt (≈2 s) fort. Nicht bei jedem Tastendruck schreiben.

### UI-FILES-FAVORITES-TOGGLE — Favoriten (neu)
- `data-ui-id="UI-FILES-FAVORITES-TOGGLE"` am Icon-Button in `.file-actions`, als erstes Kind vor dem Suchen-Icon.
- **Er schaltet nur die Sichtbarkeit des Streifens.** Er legt kein Bookmark an und markiert keinen Ordner — wer ihn als „diesen Ordner merken" baut, hat das Element verfehlt.
- Zustand `selected` = Streifen offen: Stern gefüllt, Akzentfarbe, Klasse `active` — dieselbe Behandlung, die der Suchen-Button im Bestand schon hat.
- Der Zustand steht in den Kontoeinstellungen als `files.favoritesBarOpen` (`PreferencesContext`, Gruppe `files`; serverseitig in `server/validations/preferences.js` im `filesSchema` ergänzen). Kontoweit, nicht je Sitzung.
- `Strg+B` mit `event.preventDefault()`, solange das Datei-Pane aktiv ist.

### UI-FILES-FAVORITES — Favoriten (neu)
- `data-ui-id="UI-FILES-FAVORITES"` an der Wurzel des Streifens.
- Datenquelle: `GET /api/entries/:entryId/bookmarks`, sortiert nach `position`. Muss **gemerkte Verzeichnisse dieses Kontos auf diesem Server** liefern — nicht den Verlauf, nicht die zuletzt besuchten Ordner, nicht die offenen Tabs, nicht die Serverliste.
- Chip (`FavoriteChip.jsx`): Ordner-Icon + Ordnername, `--type-body`, `--radius-md`, Innenabstand `--space-2`; voller Pfad als `title`. Klick navigiert die eigene Kachel. Klassen aus derselben `styles.sass`-Vorlage wie die Bestands-Chips, damit sie gleich aussehen.
- Höhe `var(--favorites-bar-height)`, Fläche `--lighter-background`, Trennlinie `--gray` nach unten. **Nicht scrollen, nicht umbrechen** (`overflow: hidden`, `flex-wrap: nowrap`).
- Zustände: `selected` — der Chip, dessen Pfad dem angezeigten Verzeichnis entspricht, bekommt `--primary-opacity` · `partial` — abschneiden vor dem ersten nicht passenden Chip, Chevron ans Ende · `dragging` — gezogener Chip halbtransparent, Einfügestelle als 2 px Strich in `--primary` · `empty` — Copy wörtlich aus dem Manifest, in `--subtext`.
- Umsortieren: Ziehen **oder** `Umschalt+←/→` auf dem fokussierten Chip. Beide schreiben über `PUT /api/entries/:entryId/bookmarks/order` mit der vollständigen ID-Liste — nicht n Einzeländerungen. Bei `409` (veralteter Stand) Liste neu laden, Sortierung verwerfen, kein Toast.
- Das Ziehen setzt `dataTransfer.setData("application/x-favorite-chip", id)`, und `FileRenderer.handleDrag` (`FileRenderer.jsx:556`) nimmt diesen Typ in seine Ausstiegsbedingung auf — sonst fährt beim Umsortieren die Upload-Überlagerung des Panes hoch. Ein Chip ist umgekehrt keine Ablagefläche.
- Messung über `ResizeObserver` auf dem Streifen; die Aufteilung selbst kommt aus `favoritesOverflow.js`, nicht aus der Komponente.

### UI-FILES-FAVORITES-OVERFLOW — Weitere Favoriten (neu)
- `data-ui-id="UI-FILES-FAVORITES-OVERFLOW"` am Chevron.
- **Erscheint nur, wenn wirklich etwas verdeckt ist** — passen alle Chips, ist das Element abwesend, nicht ausgegraut. `favoritesOverflow.js` bekommt die Chevron-Breite als eigenen Parameter und muss null sichtbare Chips als gültiges Ergebnis liefern: eine Kachel in der Rasteransicht ist nur ein Drittel bis die Hälfte der Ansichtsfläche breit.
- Menü über die Bestands-`ContextMenu`, Elevation `--shadow-sm`, gleiche Reihenfolge wie im Streifen, Ordner-Icon + Name je Eintrag.
- Zustände: `default` (Menü zu) · `selected` (Menü offen).

### UI-FILES-FAVORITE-MENU — Favoriten-Kontextmenü (neu)
- `data-ui-id="UI-FILES-FAVORITE-MENU"` am `ContextMenu` des Chips.
- Zwei Einträge: **Umbenennen** · **Entfernen**. Kein `ActionConfirmDialog` — ein Bookmark ist mit einem Rechtsklick wieder angelegt, und der Ordner bleibt unangetastet. Entfernen ist deshalb auch nicht `danger`.
- Zustand `selected` = Umbenennen aktiv: Eingabefeld an Ort und Stelle im Chip, `Enter` bestätigt, `Esc` verwirft — genau wie `handleRenameKeyDown` in `FileList.jsx` es für Dateien tut.

### UI-FILES-LIST — Dateien (Bestand)
- `data-ui-id="UI-FILES-LIST"` am Listen-Container in `FileList.jsx`.
- Diese Runde ändert an der Liste nichts außer den Kontextmenü-Einträgen. Zustände `loading`, `empty`, `error` sind Bestand und bleiben, wie sie sind.

### UI-FILES-LIST-MENU — Kontextmenü der Dateiliste (Bestand + ein Eintrag)
- `data-ui-id="UI-FILES-LIST-MENU"` am ersten `ContextMenu` in `FileList.jsx` (`contextMenu`).
- Bestandseinträge unverändert und in dieser Reihenfolge: Umbenennen · Vorschau und Bearbeiten (nur Dateien, nur mit `capabilities.content`) · Herunterladen · Pfad kopieren · Eigenschaften · Terminal hier öffnen (nur Ordner) · Löschen.
- **Neu, ausschließlich bei `selectedItem.type === "folder"`:** „Als Bookmark anlegen" mit dem Pfad `${path}/${selectedItem.name}` — der **angeklickte** Ordner, nicht das angezeigte Verzeichnis. Ist dieser Pfad schon gemerkt, steht an derselben Stelle „Bookmark entfernen" (Zustand `selected`).
- Bei einer Datei fehlt der Eintrag ganz (Zustand `disabled`) — nicht ausgegraut.

### UI-FILES-EMPTY-MENU — Kontextmenü der freien Fläche (Bestand + ein Eintrag)
- `data-ui-id="UI-FILES-EMPTY-MENU"` am zweiten `ContextMenu` in `FileList.jsx` (`emptyContextMenu`).
- Bestandseinträge unverändert: Neue Datei (nur `capabilities.nativeFs`) · Neuer Ordner · Trenner · Ordner herunterladen (nur `capabilities.content`) · Eigenschaften · Terminal hier öffnen.
- **Neu:** „Diesen Ordner als Bookmark" mit dem Pfad `path` — das **angezeigte** Verzeichnis, nicht ein darin liegender Ordner. Ist es schon gemerkt: „Bookmark entfernen" (Zustand `selected`).

## Ausdrücklich nicht
- Kein Schließen-Kreuz am Chip. Entfernen liegt im Kontextmenü.
- Keine Überschrift, kein Label und keine Brotkrumen-Wiederholung im Streifen.
- Kein waagerechtes Scrollen und kein Umbruch in eine zweite Zeile.
- Keine Bookmark-Ordner, keine Verschachtelung, kein Export, keine Tastenkürzel jenseits der oben genannten.
- Kein Bookmark auf eine Datei — nur Verzeichnisse.
- Keine zweite Akzentfarbe: der aktive Chip nutzt `--primary-opacity`, sonst nichts Farbiges.

## i18n
Neue Schlüssel unter `servers.fileManager.*`, im Stil der vorhandenen:
`actionBar.favorites`, `favorites.empty`, `favorites.more`, `favorites.rename`,
`favorites.remove`, `contextMenu.addBookmark`, `contextMenu.removeBookmark`,
`contextMenu.bookmarkThisFolder`, `address.restoredParent`. Englische Werte in
`client/public/assets/locales/en.json` zuerst; die übrigen Sprachen laufen über
Crowdin.
