# Eintrag anlegen / bearbeiten — Umsetzungsanleitung (UI-VAULT-DIALOG)

Artboard: docs/design/mockups/ui-vault-dialog.html · Manifest-Revision: 12

Neuer Dialog, im Client gibt es noch keine Vault-Seite. Er folgt dem Muster von `SnippetDialog` (ein Formular, `DialogProvider`, Toast bei Fehlern). Nicht neu gebaut: Dialog-Rahmen, Eingabefelder, Auswahl, Schalter, Chips, Ordner- und Tag-Laden.

## Wo im Code
- `client/src/pages/Vault/components/VaultItemDialog/VaultItemDialog.jsx` — **neu**; Container, trägt `data-ui-id="UI-VAULT-DIALOG"` am Wurzel-`div` im `DialogProvider`, plus alle sechs Marker unten
- `…/VaultItemDialog/index.js`, `styles.sass` — **neu** (Muster `SnippetDialog/index.js`, `styles.sass`)
- `…/VaultItemDialog/typeFields.js` — **neu**; Feldliste und Geheimfelder je Typ (aus der Spec, siehe SECRET/FIELDS)
- Eingebunden von der Vault-Seite `client/src/pages/Vault/Vault.jsx` (**neu**, andere Anleitung: UI-VAULT); Auslöser „Neuer Eintrag“, Bearbeiten im Detail-Kopf, Taste `N`
- Wiederverwenden: `DialogProvider`, `DialogCancelButton` (`common/components/Dialog`), `IconInput`, `SelectBox` (`multiple`, `searchable`), `ToggleSwitch`, `Chip`, `Button`, `useToast`, `useContext(ServerContext)` (es gibt keinen Hook `useServers`), `TagContext`, `getRequest`/`postRequest`/`patchRequest` (`common/utils/RequestUtil.js`)
- Styles: `styles.sass` des Dialogs; Werte nur aus den Tokens des Design-Systems (`--lighter-background`, `--radius-lg`, `--type-mono`, `--subtext`, `--danger`)

## Darstellung
- Art: Dialog über `UI-VAULT`, modal, mittig, 40 rem, max. 85 vh (Inhalt scrollt, Fußzeile bleibt sichtbar).
- Schließen: Esc, Backdrop, Abbrechen (`DialogCancelButton`); nach Speichern automatisch (`onClose`). `isDirty` wie im SnippetDialog.
- Aufbau: Titel („Eintrag anlegen“ / „Eintrag bearbeiten“) · Typ + Besitzer nebeneinander · Angaben · Geheimer Wert · Gilt für · Freigabe erforderlich · Fußzeile Abbrechen + primärer Button.
- Tastatur: `Ctrl+Enter` speichert (keydown-Listener im Dialog, wie `ServerDialog`, Zeile ~289, mit Strg-/Meta-Prüfung).
- Beim Bearbeiten sind Typ und Besitzer `disabled`. Zum Vorbelegen genügt der Eintrag aus `GET /api/vault/items`: er enthält alle nicht geheimen Felder und Bindungen, keine Werte. Geheime Werte kommen nie.

## Elemente — eins nach dem anderen
### UI-VAULT-DIALOG-TYPE — Typ (neu)
- `data-ui-id` am Wrapper des `SelectBox` (`SelectBox` nimmt kein `data-ui-id` an, daher `div`-Wrapper). Genau einmal.
- Optionen: Login, API-Key, SSH, Datenbank, Sonstiges (`login`, `api_key`, `ssh`, `database`, `generic`) mit Lucide-Icons laut Design-System. Beim Wechsel wechseln FIELDS und SECRET.
- Zustände: `default`; `disabled` beim Bearbeiten, Hilfetext „nach dem Anlegen fest“. **Nicht** der Besitzer.

### UI-VAULT-DIALOG-OWNER — Besitzer (neu)
- `data-ui-id` am `SelectBox`-Wrapper. Optionen: „Persönlich (<Benutzername>)“ (nur mit `vault.use`) und Organisationen mit `vault.manage`. Organisationen aus `getRequest("organizations")` (Muster `Snippets.jsx`).
- Der Besitzer bestimmt die Auswahl in SCOPE (siehe dort). **Nicht** Bindung oder Ordner.
- Zustände: `default`; `disabled` beim Bearbeiten, Hilfetext „nach dem Anlegen fest“ (wie beim Typ).

### UI-VAULT-DIALOG-FIELDS — Angaben (neu)
- `data-ui-id` am Formular-Wrapper der nicht geheimen Felder. Immer Name (mono) und Beschreibung; dazu je Typ:
  `login` Benutzer, Ursprünge (Liste `scheme://host[:port]`); `api_key` Hosts, Header-Name (Standard `Authorization`), Header-Vorlage (Standard `Bearer {{secret}}`); `ssh` Benutzer; `database` Engine (`postgres`, `mysql`, `sqlite`), Host, Port, Datenbank, Benutzer; `generic` keine.
- Name: Muster `^[a-z0-9][a-z0-9._-]{0,63}$`, clientseitig als Hinweis, maßgeblich ist die Server-Validierung (Joi).
- Zustände: `error` „Name schon vergeben.“ am Namensfeld, aus der Serverantwort. **Nicht** Geheimwerte.

### UI-VAULT-DIALOG-SECRET — Geheimer Wert (neu)
- `data-ui-id` am Wrapper der geheimen Felder. `type="password"`, mono. Felder je Typ: `login` password; `api_key` token; `ssh` privateKey und/oder password, optional passphrase; `database` password; `generic` value.
- Beim Bearbeiten leer, Platzhalter und Hilfetext „gespeichert — leer lassen, um beizubehalten“ (`partial`); leere Felder werden nicht gesendet. `error` „Wert fehlt.“ beim Anlegen ohne Wert.
- `empty` „Ziel geändert — gespeicherte Werte werden verworfen. Neu eingeben.“ (Hinweis in `--warning` unter dem leeren Feld, Platzhalter „Passwort eingeben“ statt des `partial`-Hinweises). Greift nur beim Bearbeiten, sobald ein Ziel-Feld geändert wurde (`origins`, `hosts`, `host`): der Server löscht dann beim PATCH die gespeicherten Werte. Speichern ist dann nur mit neuem Wert möglich; ohne ihn bleibt der Button `disabled`.
- Kein Anzeigen- oder Kopieren-Button hier.

### UI-VAULT-DIALOG-SCOPE — Gilt für (neu)
- `data-ui-id` am Wrapper aus Chip-Zeile und „Alle Server“-Zeile. Gewählte Bindungen als Chips mit Art-Präfix (Ordner, Server, Tag), daneben „+ Server“, „+ Ordner“, „+ Tag“ (öffnen `SelectBox` multiple, searchable).
- Datenquelle: Server und Ordner aus `useContext(ServerContext).servers` (Baum, `type` `folder`/`organization`/Server; beim Besitzer „Persönlich“ die Knoten ohne Organisation, sonst `entries` der gewählten Organisation); Tags aus dem `TagContext`, nur bei Besitzer „Persönlich“ (bei Organisationen entfällt „+ Tag“). Ordner gelten mit Unterordnern.
- Zustände: `empty` „Für keinen Server freigegeben.“ (Standard). `selected` bei Schalter „Alle Server“ (`ToggleSwitch`, `allServers`): Chips werden gedimmt und nicht mehr bearbeitet. Wechsel des Besitzers verwirft Bindungen, die dort nicht gelten.

### UI-VAULT-DIALOG-APPROVAL — Freigabe erforderlich (neu)
- `data-ui-id` am Zeilen-Wrapper um den `ToggleSwitch` (`approvalRequired`). Standard an.

### UI-VAULT-DIALOG-SAVE — Speichern (neu)
- `data-ui-id` am primären `Button`. Beschriftung „Erstellen“ beim Anlegen, „Speichern“ beim Bearbeiten. Anlegen `POST /api/vault/items`, Bearbeiten `PATCH /api/vault/items/:id`.
- Zustände: `disabled` bei ungültigem Formular; `loading` „Speichere …“ (Button gesperrt); `error` „Speichern fehlgeschlagen.“ als Text unter dem Button in `--error`, Button wieder bedienbar. Namenskonflikt statt dessen am Namensfeld (FIELDS).

## Ausdrücklich nicht
- Kein Formular-Monster: keine Abschnittsüberschriften, keine Tabs, keine Zusatzfelder (Ablauf, Tags am Eintrag, Notizen) jenseits der Liste oben.
- Kein gespeicherter Geheimwert im Client, keine Teilanzeige; kein Reveal im Dialog.
- Typ und Besitzer nach dem Anlegen nicht änderbar.
- Tags nur bei persönlichen Einträgen; Organisationseinträge nur Server und Ordner derselben Organisation.

## i18n
Neuer Block `vault.dialog` in `client/public/assets/locales/de_DE.json` (zuerst), Schema wie `snippets.dialog`: `title.create|edit`, `fields.*` (type, owner, name, description, …), `placeholders.*`, `types.*`, `scope.*` (`empty`, `allServers`, `addServer|addFolder|addTag`), `approval`, `secret.stored`, `errors.nameTaken|secretMissing`, `actions.cancel|create|save|saving`. Danach `en.json`.
