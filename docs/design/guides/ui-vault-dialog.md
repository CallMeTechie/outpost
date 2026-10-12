# Eintrag anlegen / bearbeiten — Umsetzungsanleitung (UI-VAULT-DIALOG)

Artboard: docs/design/mockups/ui-vault-dialog.html · Manifest-Revision: 21

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

### UI-VAULT-DIALOG-READONLY — Nur lesen (neu in Rev. 16)
- `data-ui-id` an der Zeilen-Wrapper-`div` um den `ToggleSwitch` (`id="vault-read-only"`), nach dem Muster von `UI-VAULT-DIALOG-APPROVAL`: `vault-item-dialog-switch` mit `label` und Schalter. Eigener Knoten, genau einmal. Die Gruppe „Nutzung durch Agenten“ (READONLY, HTTP, GIT, FILL) steht im Dialog-Formular nach „Freigabe erforderlich“ und vor „Speichern“, wie im Artboard.
- Nur bei Typ `api_key`; bei anderen Typen nicht rendern.
- Datenquelle: `fields.readOnly` (boolean, Standard `false`) des Eintrags. Im Formularzustand unter `form.fields` führen (`toFormFields` / `toPayloadFields` in `vaultTypes.js` kennen heute nur Text- und Listenfelder, boolesche Werte dort ergänzen) und mit dem bestehenden `POST /api/vault/items` bzw. `PATCH /api/vault/items/:id` mitsenden; kein neuer Endpunkt. Die Server-Validierung in `server/validations/vault.js` (`FIELDS.api_key`) ist durch die Umsetzung zu erweitern (`readOnly: Joi.boolean().default(false)`); der Client-Hinweis ersetzt sie nicht.
- Zustände: `default` Schalter aus, Hinweis „aus“; `selected` Schalter an, Hinweis „an — nur lesen“.
- Nicht: kein Ersatz für „Freigabe erforderlich“ (`approval_policy`), kein Recht (`permission`); Beschriftung „Nur lesen“. Bedeutung für den Nutzer: vault_http nur GET und HEAD, Git nur clone, fetch und pull.

### UI-VAULT-DIALOG-HTTP — Unverschlüsseltes HTTP erlauben (neu in Rev. 16)
- `data-ui-id` an der Zeilen-Wrapper-`div` um den `ToggleSwitch` (`id="vault-allow-http"`), direkt unter `UI-VAULT-DIALOG-READONLY`. Genau einmal.
- Nur bei Typ `api_key`.
- Datenquelle: `fields.allowHttp` (boolean, Standard `false`), gesendet mit denselben Create-/Update-Anfragen; serverseitig `allowHttp: Joi.boolean().default(false)` in `FIELDS.api_key`.
- Zustände: `default` aus, Hinweis „aus — nur https“; `selected` an, Hinweis „an — der Token geht unverschlüsselt über das Netz“ (Hinweis in `--warning`, nicht in `--error`: es ist eine bewusste Wahl).
- Nicht: keine Origin-Liste (`allowed_origin`) und keine Freigabe-Einstellung; der Schalter ändert nur das Schema, das vault_http für die Hosts des Eintrags zulässt.

### UI-VAULT-DIALOG-GIT — Für Git nutzen (neu in Rev. 16)
- `data-ui-id` an der Zeilen-Wrapper-`div` um den `ToggleSwitch` (`id="vault-git"`) **und** das darunter eingeblendete Benutzernamenfeld, damit `error` im selben Knoten liegt. Genau einmal; Position direkt unter `UI-VAULT-DIALOG-HTTP`.
- Nur bei Typ `api_key`.
- Das Feld „Git-Benutzername“ ist ein `IconInput` (Icon `User`, `customClass="vault-mono"`, Muster der `username`-Zeile in `FIELD_INPUTS`) und **nur sichtbar, solange Git an ist**; ausgeschaltet wird es nicht gerendert und `fields.gitUsername` nicht gesendet.
- Datenquelle: `fields.git` (boolean, Standard `false`) und `fields.gitUsername` (String, Standard `"x-access-token"`; `oauth2` für GitLab als Hilfetext, nicht als Auswahl). Mit `POST /api/vault/items` bzw. `PATCH /api/vault/items/:id` senden. Serverseitig `FIELDS.api_key` um `git` und `gitUsername` erweitern (`gitUsername` nur wenn `git` an, nicht leer).
- Zustände: `default` aus; `selected` an, Hinweis „an · Git-Benutzername x-access-token“ (Benutzername in `--type-mono`, aktueller Wert); `error` leeres Feld bei eingeschaltetem Git: „Git-Benutzername fehlt.“ (`--error`, `role="alert"`, `aria-invalid`), Speichern bleibt `disabled`.
- Nicht: kein SSH-Schlüssel und keine Identität (`not: ssh_key, identity`); der Schalter richtet nichts auf einem Server ein (das macht UI-AGENT-ACCESS-SETUP).

### UI-VAULT-DIALOG-FILL — Darf im Browser eingetragen werden auf (neu in Rev. 16)
- `data-ui-id` am `form-group`-Wrapper aus Label und Origin-Eingabe, genau einmal; im Block nach „Angaben“, vor dem Geheimen Wert. Das Label heißt „Darf im Browser eingetragen werden auf“.
- Für Typ `api_key` und `generic` („Sonstiges“); bei `login` und anderen Typen nicht rendern (`login` hat seine Origins schon als Ziel, `targets: ["origins"]`).
- Wiederverwenden: das Origin-Eingabefeld, das der Typ `login` in diesem Dialog schon benutzt (`IconInput` mit Icon `Globe`, Liste durch Komma/Leerzeichen getrennt, `LIST_FIELDS` in `vaultTypes.js`, `FIELD_INPUTS.origins`). Kein neues Eingabe-Widget; `fillOrigins` wird als weiteres Listenfeld neben `origins` und `hosts` geführt (`LIST_FIELDS`, `toFormFields`, `toPayloadFields`). Ein anderes Label als beim Login, eigener Hilfetext.
- Datenquelle: `fields.fillOrigins` (Liste `scheme://host[:port]`, Standard leer) des Eintrags, gesendet mit den bestehenden Create-/Update-Anfragen. Serverseitig `fillOrigins: Joi.array().items(origin).max(20).default([])` in `FIELDS.api_key` und `FIELDS.generic` mit dem vorhandenen `origin`-Validator (dort wird der Wert normalisiert). `fillOrigins` gehört nicht zur Ziel-Liste von SECRET (`targets`): eine Änderung verwirft gespeicherte Werte nicht.
- Zustände: `default` Origins sichtbar; `empty` Platzhalter „Nirgends — nur für vault_http und Git“ (wörtlich, auch bei `generic`); `error` „Keine gültige Origin (scheme://host[:port]).“ (`--error`, `role="alert"`).
- Nicht: nicht `hosts` (Header-Ziele von vault_http, `api_host`) und keine Bindung (`vault_binding`). Leer heißt im Produkt: kein Eintragen im Browser, außer „Token auf jeder Seite eintragen erlauben“ ist in Einstellungen › Vault an (`UI-VAULT-SETTINGS-FILLANY`).

### UI-VAULT-DIALOG-APPROVAL — Freigabe erforderlich (neu)
- `data-ui-id` am Zeilen-Wrapper um den `ToggleSwitch` (`approvalRequired`). Standard an.

### UI-VAULT-DIALOG-SSH-SERVERS — Ziele aus der Serverliste (neu in Rev. 20)
- `data-ui-id` am Wrapper (Label, Chips, „+ Server“). Nur bei Typ `ssh`, in „Nutzung durch Agenten“ unter Benutzer und Geheimnissen.
- Chips je Server mit Name und Host (`--type-mono`, `--subtext`); „+ Server“ öffnet eine durchsuchbare Liste der SSH-Server aus `ServerContext`, die der Bearbeiter sieht. Bei Organisations-Einträgen nur Server derselben Organisation (wie „Gilt für“). Gespeichert als `fields.servers` (Entry-IDs).
- Nicht verwechseln mit „Gilt für“ (`UI-VAULT-DIALOG-SCOPE`): das bleibt die Bindung an den Server des Agenten.
- Zieländerung beim Bearbeiten: Hinweis wie bei API-Key (`vault.dialog.secretCleared`), Geheimnisse müssen neu eingegeben werden.

### UI-VAULT-DIALOG-SSH-HOSTS — Freie Hosts (neu in Rev. 20)
- `data-ui-id` am Feld-Wrapper; `IconInput` mit Globus-Icon, `vault-mono`, Platzhalter `nas.example.net:2222`, Trennung an Komma/Leerzeichen wie `hosts` beim API-Key. `error` „Kein gültiger Host (host oder host:port).“ mit `aria-invalid`. Rev. 21: `disabled` ohne `connect.direct` des Bearbeiters (Feld gesperrt, Hinweis „Freie Hosts brauchen das Recht „Direkt verbinden“.“); vorhandene Hosts bleiben sichtbar.

### UI-VAULT-DIALOG-SSH-SESSION — „Für diese Sitzung“ erlauben (neu in Rev. 20)
- `UsageSwitch` wie `UI-VAULT-DIALOG-HTTP`; Hinweis aus „aus — jeder Befehl einzeln“, an „an — eine Freigabe gilt bis Sitzungsende für beliebige Befehle auf diesem Ziel“ (Warnton wie beim HTTP-Schalter). `fields.allowSession`, Standard aus. Rev. 21: Ob überhaupt eine Karte kommt, bestimmt weiter „Freigabe erforderlich“ (`UI-VAULT-DIALOG-APPROVAL`), auch bei SSH.

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
