# Server anlegen / bearbeiten — Umsetzungsanleitung (UI-SERVER-DIALOG)

Artboard: docs/design/mockups/ui-server-dialog.html · Manifest-Revision: 1

Bestehender Dialog (`client/src/pages/Servers/components/ServerDialog/`,
Seiten `DetailsPage.jsx`, `IdentityPage.jsx`, `SettingsPage.jsx`). Festschreibung
plus Locator-Marker; der Einstellungen-Tab bekommt seine drei Gruppen.

## Wo im Code
- `ServerDialog.jsx` — Container, `TabSwitcher` → `UI-SERVER-DIALOG-TABS`, Fußzeile → `UI-SERVER-DIALOG-SAVE`
- `pages/DetailsPage.jsx` → `UI-SERVER-DIALOG-DETAILS` · `pages/IdentityPage.jsx` → `UI-SERVER-DIALOG-IDENTITY` · `pages/SettingsPage.jsx` → `UI-SERVER-DIALOG-SETTINGS`
- Wiederverwenden: `DialogProvider`, `TabSwitcher`, `Input`, `IconInput`, `SelectBox`, `ToggleSwitch`, `Button`

## Darstellung
- Art: Dialog, modal, Backdrop `--dialog-background`, über `UI-SERVERS`.
- Öffnen: Kontextmenü › Bearbeiten, Kontextmenü › Neu, Taste `E` auf gewähltem Eintrag. Schließen: Esc, Backdrop, Abbrechen; nach Speichern automatisch.
- Größe: mittig, 44 rem breit, max. 85 vh, Radius `--radius-lg`, Schatten `--shadow-lg`.
- Tastatur: Tab-Wechsel `Ctrl+1/2/3`, Speichern `Ctrl+Enter`.

## Elemente — eins nach dem anderen
### UI-SERVER-DIALOG-TABS
- `data-ui-id` am `TabSwitcher`. Reihenfolge fest: Details · Identität · Einstellungen. `selected` = Akzent-Unterstreichung.

### UI-SERVER-DIALOG-DETAILS
- `data-ui-id` am Formular-Wrapper. Felder (i18n `servers.dialog.fields.*`): name, icon, serverIp, port, protocol, engine, macAddress, wolBroadcastAddress.
- Datenquelle: Server-Stammdaten des Eintrags — **nicht** Identitäten.
- `error`: Engine offline → Hinweis „Engine offline — Verbindung erst nach Start möglich." (`servers.dialog.engineOffline`), Speichern bleibt möglich.

### UI-SERVER-DIALOG-IDENTITY
- `data-ui-id` am Wrapper. Zwei Gruppen: persönliche Identitäten, Organisations-Identitäten (`servers.dialog.identities.*`); Verknüpfen/Lösen; Authentifizierung Passwort / SSH-Key / beides.
- Datenquelle: Identitäten des Nutzers + Organisation — **nicht** Server, nicht Benutzerkonten.
- `empty`: „Keine persönlichen Identitäten. Neue Identität anlegen." mit Aktion.

### UI-SERVER-DIALOG-SETTINGS
- `data-ui-id` am Wrapper. Drei Gruppen mit Überschrift (`--type-heading`): **Terminal** (Schrift, Cursor, Scrollback, Bell) · **Verbindung** (Keep-alive, Timeout, Jump-Host, Startbefehl) · **tmux** (automatisch anhängen, Standard-Session). Keine Stammdaten hier.

### UI-SERVER-DIALOG-SAVE
- `data-ui-id` am primären Button. Beschriftung „Erstellen" (`servers.dialog.actions.create`) beim Anlegen, „Speichern" (`…actions.save`) beim Bearbeiten. `disabled` bei ungültigem Formular; `error` zeigt die Serverantwort unter dem Button.

## Ausdrücklich nicht
- Kein Wizard, keine Schritt-Navigation — drei Tabs, frei wechselbar.
- Keine Speicherung ohne Bestätigung des Nutzers; kein Autosave.

## Fertig, wenn
- Alle fünf Marker auf Tier A; `/design-verify --screen UI-SERVER-DIALOG` MATCH.
