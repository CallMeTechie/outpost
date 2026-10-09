# Credentials Vault – Teilprojekt 1: Kern und Agentenzugang

Stand: 2026-10-09 · Status: Entwurf zur Freigabe

## Ziel

Zugangsdaten (API-Keys, SSH-, Login-, Datenbank- und sonstige Credentials) liegen in Outpost.
Claude Code und Codex, die auf den Zielservern in Outpost-Terminals laufen, nutzen sie, ohne
den Wert je zu sehen: Outpost setzt das Geheimnis selbst ein und gibt dem Agenten nur das
Ergebnis (Broker-Modell). Kein Wert erscheint im Transcript eines Agenten, in einer
Modell-Anfrage, in einem Log oder im Audit-Log.

Erfolg für Teilprojekt 1: Claude auf einem LAN-Server meldet sich mit einem eingeschränkten
Agenten-Key an, sieht nur die für diesen Server freigegebenen Einträge, meldet sich im
Outpost-Browser-Tab auf einer Webseite an, ohne dass das Passwort in seinem Kontext
auftaucht, und jeder Zugriff steht im Audit-Log.

### Einordnung

Der Vault ist in vier Teilprojekte geschnitten, jedes mit eigener Spec:

1. **Kern und Agentenzugang** (diese Spec): Datenmodell, Richtlinien, Oberfläche, Audit,
   Agenten-Keys, MCP mit Freischaltung je Werkzeug-Anbieter, `vault_list`,
   `browser_fill_credential`.
2. Weitere vermittelte Werkzeuge: `vault_http`, `ssh_exec`, `db_query`.
3. Rückwärts-Tunnel über Outposts SSH-Verbindung, Token je Sitzung; bindet Server außerhalb
   des LANs an.
4. `outpost-secret run`: Herausgabe an einen Prozess für Werkzeuge, die den Wert selbst
   brauchen, mit Freigabe.

Teilprojekt 1 legt alle Credential-Typen schon an, damit Einträge vor den Werkzeugen aus 2
gepflegt werden können. Nutzbar durch Agenten ist in Teilprojekt 1 nur der Typ `login`.

### Grenze des Modells

Was ein Agent in einem eigenen Prozess hält, kann er ausgeben. Deshalb gibt kein Werkzeug
dieser Spec einen Wert heraus. Der Agenten-Key selbst ist vor dem Agenten nicht geheim
(`~/.claude.json` ist lesbar, Codex sieht seine Umgebung); er erlaubt nur vermittelte
Aktionen unter Server-Bindung, Freigabe und Audit, und die IP-Bindung macht ihn außerhalb
seines Servers wertlos.

## Entscheidungen

| Frage | Entscheidung |
|---|---|
| Besitz | Konto oder Organisation (`accountId` xor `organizationId`), wie Identitäten. |
| Anzeigen in der Oberfläche | Abgestuft: Besitzer bei persönlichen Einträgen; bei Organisationseinträgen nur mit `vault.reveal`. Mitglieder ohne das Recht nutzen nur über Agenten. Jedes Anzeigen wird auditiert. |
| Geltung für Server | Vereinigung aus Servern, Ordnern (mit Unterordnern), Tags (nur persönliche Einträge) oder „alle Server“. Standard: keine Geltung. |
| Freigabe | Je Eintrag `approvalRequired`, Standard an. Antworten: einmal / für diese Agenten-Sitzung / ablehnen; 2 Minuten ohne Antwort = abgelehnt. |
| Agenten-Key auf den Server | Ein-Klick-Einrichtung per Exec; Kopierbefehl als Ausweg. |
| IP-Bindung | Je Key, Standard an; zusätzliche CIDRs eintragbar, Bindung abschaltbar. |
| Architektur | Im Outpost-Server integriert, eigener `VAULT_KEY`. Kein eigener Container, kein Master-Passwort (späterer Ausbau möglich, die Verschlüsselung liegt hinter einer Schnittstelle). |

## Datenmodell

Neue Migration `0047-add-vault.js`.

### `vault_items`

| Spalte | Typ | Bemerkung |
|---|---|---|
| `accountId` | INTEGER null | genau eines von `accountId`, `organizationId` ist gesetzt |
| `organizationId` | INTEGER null | |
| `name` | STRING | eindeutig je Besitzer; Kennung für Agenten, Muster `^[a-z0-9][a-z0-9._-]{0,63}$` |
| `type` | STRING | `login`, `api_key`, `ssh`, `database`, `generic` |
| `description` | TEXT null | |
| `fields` | JSON | nicht geheime Angaben, je Typ (siehe unten) |
| `approvalRequired` | BOOLEAN | Standard `true` |
| `allServers` | BOOLEAN | Standard `false` |
| `createdBy` | INTEGER | Konto |
| `lastUsedAt` | DATE null | |
| Zeitstempel | | |

`fields` je Typ, per Joi validiert:

- `login`: `username`, `origins` (Liste, je `scheme://host[:port]`, mindestens einer)
- `api_key`: `hosts` (Liste), `headerName` (Standard `Authorization`), `headerTemplate`
  (Standard `Bearer {{secret}}`)
- `ssh`: `username`
- `database`: `engine` (`postgres`, `mysql`, `sqlite`), `host`, `port`, `database`, `username`
- `generic`: keine

### `vault_secrets`

| Spalte | Typ | Bemerkung |
|---|---|---|
| `itemId` | INTEGER | CASCADE |
| `field` | STRING | `password`, `token`, `privateKey`, `passphrase`, `value` |
| `valueEncrypted` | BLOB | AES-256-GCM mit `VAULT_KEY` |
| `valueIV`, `valueAuthTag` | STRING | |

Eindeutig auf (`itemId`, `field`). Geheime Felder je Typ: `login` → `password`;
`api_key` → `token`; `ssh` → `privateKey` und/oder `password`, optional `passphrase`;
`database` → `password`; `generic` → `value`.

Anders als `Credential` hat das Modell **keinen** `afterFind`-Hook. Entschlüsselt wird
ausschließlich in `server/lib/vault/secrets.js` (`readSecret(itemId, field)`), aufgerufen nur
von vermittelnden Werkzeugen und vom Reveal-Endpunkt. Listen, Exporte und Includes laden
dadurch nie Klartext.

### `vault_bindings`

`itemId` (CASCADE), `kind` (`entry`, `folder`, `tag`), `targetId`. Eindeutig auf allen drei.
`tag` nur bei persönlichen Einträgen (Tags gehören einem Konto, `Tag.accountId`).
Organisationseinträge binden nur an Server und Ordner derselben Organisation; `allServers`
heißt bei ihnen „alle Server der Organisation“.

### `api_keys` (erweitert)

| Spalte | Typ | Bemerkung |
|---|---|---|
| `kind` | STRING | `account` (Bestand, Standard) oder `agent` |
| `pending` | BOOLEAN | nur bei `agent`; Standard `true`, siehe Einrichtung |
| `entryId` | INTEGER null | nur bei `agent`; CASCADE |
| `agentType` | STRING null | `claude`, `codex` |
| `ipBinding` | BOOLEAN | Standard `true` |
| `allowedCidrs` | JSON null | zusätzliche Adressbereiche |

Bestehende Keys bekommen `kind = account` und verhalten sich unverändert. Die bestehende
Liste, das Löschen und die Obergrenze von 50 in `server/controllers/apiKey.js` gelten nur für
`kind = account`.

### Berechtigungen (`server/permissions/registry.js`)

- `vault.use` (System, Standard aus, `dangerous`): persönliche Einträge anlegen und durch
  eigene Agenten nutzen lassen.
- `vault.manage` (Organisation): Organisationseinträge anlegen, bearbeiten, löschen.
- `vault.reveal` (Organisation, `dangerous`): Werte von Organisationseinträgen anzeigen.
- `settings.vault` (System): Einstellungsseite Vault.
- Nutzung von Organisationseinträgen durch Agenten: Mitgliedschaft genügt.

## Sichtbarkeit

`server/lib/vault/visibility.js`:
`visibleItems({ accountId, agent })` liefert die Einträge, die ein Aufrufer nutzen darf.

- Kandidaten: persönliche Einträge des Kontos (nur mit `vault.use`) plus Einträge aller
  Organisationen, in denen das Konto Mitglied ist.
- Agenten-Key (`agent.entryId` gesetzt): ein Eintrag gilt, wenn `allServers` gesetzt ist
  (bei Organisationseinträgen nur, wenn der Server zur Organisation gehört) oder eine Bindung
  passt — `entry` = der Server; `folder` = Ordner des Servers oder ein Vorfahre davon
  (`Folder.parentId`); `tag` = ein Tag des Servers (`EntryTag`).
- Konto-Key (kein Server): nur Einträge mit `allServers`.
- Der Agent muss den Server selbst noch erreichen dürfen (`validateEntryAccess`); fällt der
  Zugriff weg, sieht der Key nichts mehr.

## Agentenzugang

### Authentifizierung (`server/middlewares/auth.js`)

- Agenten-Keys passieren nur Anfragen unter `/api/mcp`; alles andere `403`.
- IP-Bindung: `req.ip` (nach `TRUST_PROXY`) muss der aufgelösten Adresse von
  `entry.config.ip` entsprechen oder in `allowedCidrs` liegen. Auflösung mit Cache von
  60 Sekunden. Verstoß: `403` und Audit `vault.agent_ip_denied`.
- `req.agent = { keyId, entryId, agentType }`.
- `lastUsedAt` wie bei Konto-Keys.

### MCP-Rahmen (`server/lib/mcp/`)

`server/lib/browser/mcpServer.js` zieht nach `server/lib/mcp/server.js` um und nimmt
**Werkzeug-Anbieter** statt eines Werkzeugsatzes:

```
provider = { name, available(ctx) → bool, list(ctx) → tools[], has(name), call(name, args, ctx), forgetTransport(id) }
ctx      = { accountId, agent | null, transportId, ipAddress, userAgent }
```

- Browser-Anbieter: bisherige `createBrowserTools`, `available` = `connect.browser`.
- Vault-Anbieter: `available` = Vault eingeschaltet und (Recht `vault.use` oder Mitglied
  einer Organisation).
- `tools/list` vereinigt die verfügbaren Anbieter, `tools/call` leitet an den Anbieter des
  Werkzeugs; nicht verfügbare Werkzeuge antworten wie unbekannte.
- Protokoll unverändert (JSON-RPC 2.0, Streamable HTTP ohne SSE, `Mcp-Session-Id`).
- Die Route `server/routes/mcp.js` bleibt, baut aber den Rahmen mit beiden Anbietern.

### `vault_list`

Liefert für jeden sichtbaren Eintrag: `name`, `type`, `description`, `username` bzw. `host`,
`origins`/`hosts`, `approvalRequired`, `usableBy` (Liste der Werkzeuge, die den Typ heute
nutzen; in Teilprojekt 1 nur `browser_fill_credential` für `login`). Nie Werte, Längen,
Präfixe oder Hashes von Werten.

### Einrichtung per Klick

Kontextmenü des Server-Eintrags → „Agenten-Zugang…“ (nur SSH-Einträge, nur mit Zugriff auf
den Eintrag). Auswahl Claude Code und/oder Codex.

1. Outpost legt den Agenten-Key an (`kind = agent`, Name `claude@<entry>` bzw.
   `codex@<entry>`).
2. Outpost führt über `execCommand` aus:
   - Claude: `claude mcp add --scope user --transport http outpost <url> --header "Authorization: Bearer <key>"`
     (vorher `claude mcp remove --scope user outpost`, Fehler ignoriert).
   - Codex: `~/.codex/outpost.env` mit `export OUTPOST_MCP_TOKEN=<key>`, Modus `0600`; eine
     Zeile `[ -f ~/.codex/outpost.env ] && . ~/.codex/outpost.env` in `~/.bashrc` und
     `~/.profile`, falls noch nicht vorhanden; dann
     `codex mcp add outpost --url <url> --bearer-token-env-var OUTPOST_MCP_TOKEN`.
   - Alle Werte werden über einen gemeinsamen Quoting-Baustein (`server/lib/vault/provision.js`)
     in die Befehle gesetzt.
3. `<url>` = Einstellung „Outpost-Adresse für Agenten“ + `/api/mcp`.
4. Scheitert ein Schritt (CLI fehlt, Exec-Fehler), zeigt der Dialog den fertigen Befehl zum
   Kopieren. Der Key wird nur in diesem Dialog angezeigt.
5. Ein neuer Agenten-Key ist zunächst `pending`. Er wird endgültig, wenn die automatische
   Einrichtung gelingt oder der Nutzer den Befehl kopiert (`POST /agent-keys/:id/confirm`).
   Schließt der Nutzer den Dialog vorher, löscht der Client ihn (`DELETE /agent-keys/:id`);
   was danach noch `pending` ist, löscht der Server nach 15 Minuten. Ein `pending`-Key wird von
   `authenticate` nicht akzeptiert.
6. Ist „Outpost-Adresse für Agenten“ nicht gesetzt (Standard: leer), ist Einrichten gesperrt
   mit Verweis auf Einstellungen › Vault.

Entziehen fragt vorher im Bestätigungsdialog nach.

„Zugang entziehen“ löscht den Key und führt danach `claude mcp remove --scope user outpost`
bzw. `codex mcp remove outpost` und das Entfernen von `~/.codex/outpost.env` aus; schlägt das
fehl, ist der Key trotzdem widerrufen.

## `browser_fill_credential`

Neues Werkzeug im Vault-Anbieter, das den Browser-Pool nutzt.

```
browser_fill_credential({ item, passwordRef, usernameRef?, sessionId? })
```

Prüfungen in dieser Reihenfolge, jede bricht mit eigenem Fehler ab:

1. `item` ist sichtbar (siehe Sichtbarkeit). Nicht sichtbar und nicht vorhanden ergeben
   denselben Fehler `vault.item_unknown`.
2. `type === "login"`.
3. Die Browser-Sitzung gehört dem Konto (wie bei allen `browser_*`-Werkzeugen) und ist nicht
   pausiert.
4. Der Ursprung des **Frames**, in dem das Ziel-Element liegt, entspricht exakt einem Eintrag
   aus `origins` (Schema, Host, Port; Standardports normalisiert).
5. `passwordRef` ist ein `<input type="password">`; `usernameRef`, falls angegeben, ein
   Textfeld (`text`, `email`, `tel` oder ohne Typ) im selben Ursprung.
6. Freigabe, falls `approvalRequired`.

Ausfüllen: `readSecret(item, "password")`, Fokus über die Referenz, `Input.insertText` wie
`browser_type`; beim Benutzernamen vorher Feld leeren. Antwort an den Agenten nur
„Benutzername und Passwort von `<item>` eingetragen.“ Klartext erscheint nie in Antwort,
Log oder Audit.

### Folgen für die Browser-Sitzung

- `browser_snapshot` schwärzt den Wert jedes Passwortfeldes, **immer** (auch Eingaben des
  Nutzers): `value="••••"` statt des Werts.
- Nach einem erfolgreichen Ausfüllen ist die Sitzung „befüllt“: `browser_evaluate` antwortet
  bis zum Ende der Sitzung mit `vault.evaluate_locked` („in dieser Sitzung gesperrt, weil
  Zugangsdaten eingetragen wurden; nutze snapshot und click“).
- `browser_screenshot` bleibt erlaubt.

## Freigabe

`server/lib/vault/approvals.js`.

- Anfrage: `{ id, accountId, agentType, entryName, item, target, expiresAt }`, verteilt über
  den `StateBroadcaster` an alle offenen Fenster des Kontos, dem der Agenten-Key gehört (bei
  Organisationseinträgen derselbe Nutzer, nicht Org-Admins).
- Antwort per Endpunkt `POST /api/vault/approvals/:id` mit `once`, `session` oder `deny`;
  nur das besitzende Konto.
- `session` merkt sich (`transportId`, `item`) im Speicher bis zum Ende der MCP-Sitzung
  (`forgetTransport`) oder bis zum Neustart.
- Der Werkzeugaufruf wartet bis `expiresAt` (jetzt + 2 Minuten). Ohne Antwort:
  `vault.approval_timeout`.
- Ist kein Fenster des Kontos verbunden, sofort `vault.approval_unavailable` („Outpost
  öffnen, um Freigaben zu erteilen“).
- Mehrere offene Anfragen werden unabhängig beantwortet.

## Oberfläche

- **Vault-Seite** als eigener Bereich der Navigation (neben Snippets), nur sichtbar laut
  `GET /api/vault/available` (`canUse`). Zweispaltig: links die Liste mit Reitern je Besitzer
  (Persönlich, Organisationen), Filter nach Typ, Suche; je Zeile Typ, Name, Benutzername/Host,
  Freigabe-Kennzeichen. Rechts die Details: Angaben, geheime Felder, Geltung, Freigabe und
  zuletzt genutzt, Bearbeiten/Löschen.
- **Eintrag-Dialog**: Felder je Typ; geheime Felder beim Bearbeiten leer mit Hinweis
  „gespeichert – leer lassen, um beizubehalten“ (der Wert wird nicht an den Client geschickt);
  Bereich „Gilt für“ mit Servern, Ordnern, Tags (nur persönlich) und „alle Server“; Schalter
  „Freigabe erforderlich“.
- **Anzeigen/Kopieren** nur bei Reveal-Recht; Wert wird erst beim Klick über
  `GET /api/vault/items/:id/secrets/:field` geholt und auditiert. Kopieren über den
  bestehenden Clipboard-Fallback.
- **Freigabe-Overlay** auf jeder Seite inkl. Popout, mit Countdown; mehrere Anfragen gestapelt.
- **Agenten-Zugang-Dialog** im Kontextmenü des Server-Eintrags mit den bestehenden
  Agenten-Keys dieses Servers.
- **Einstellungen → Konto → API-Keys**: Agenten-Keys gruppiert nach Server mit Agententyp,
  zuletzt genutzt, IP-Bindung, CIDRs bearbeitbar.
- **Einstellungen → Vault** (System, `settings.vault`): Status von `VAULT_KEY`,
  „Outpost-Adresse für Agenten“.

Gestaltung kommt aus mockingbird (Manifest und Artboards) vor der Umsetzung; diese Spec legt
nur Verhalten und Inhalte fest.

Mobile-App (Flutter) ist nicht Teil dieses Teilprojekts.

## REST-Endpunkte

Unter `/api/vault`, nur Login-Session oder Konto-Key (Agenten-Keys sind ausgeschlossen):

- `GET /items`, `POST /items`, `PATCH /items/:id`, `DELETE /items/:id`
- `GET /items/:id/secrets/:field` (Reveal)
- `POST /approvals/:id`
- `GET /agent-keys` (alle Agenten-Keys des Kontos; mit `?entryId=` nur die eines Servers),
  `POST /agent-keys` (Einrichtung), `POST /agent-keys/:id/confirm`, `DELETE /agent-keys/:id`
  (Entziehen bzw. Verwerfen)
- `GET /settings`, `PATCH /settings` (Recht `settings.vault`): `{ keyStatus: "active" |
  "missing" | "mismatch", agentUrl }`; `agentUrl` muss eine http- oder https-Adresse sein.
  `GET /settings` antwortet auch bei ausgeschaltetem Vault, damit die Seite den Grund zeigt.

Ist der Vault ausgeschaltet, antworten alle mit `404`.

Ausnahme `GET /api/vault/available`, nach dem Muster von `GET /api/browser/available`: antwortet
immer `200` mit `{ enabled, canUse, canManageOrgs: [orgId…], canProvision }`. `enabled` = Vault
eingeschaltet; `canUse` = `vault.use` oder Mitglied mindestens einer Organisation (steuert den
Bereich in der Navigation); `canProvision` = Vault eingeschaltet und `vault.use` oder Mitglied
(steuert „Agenten-Zugang…“ im Server-Kontextmenü). Ist der Vault aus, sind alle Rechte-Felder
`false` bzw. leer.

## Betrieb

- `VAULT_KEY` (64 Hex-Zeichen) ist optional, per Umgebungsvariable oder
  `/run/secrets/vault_key` (bestehender Loader in `server/utils/secrets.js`). Ohne ihn ist der
  Vault aus: keine Navigation, keine Vault-Werkzeuge, REST `404`. Bestehende Installationen
  starten unverändert.
- Ein falscher `VAULT_KEY` bei vorhandenen Daten wird beim Start erkannt (Prüfwert in den
  Einstellungen) und schaltet den Vault mit Meldung in Einstellungen → Vault aus, statt
  Fehler beim Gebrauch zu erzeugen.
- Backups enthalten die Einträge verschlüsselt; ohne denselben `VAULT_KEY` sind sie nach einer
  Wiederherstellung nicht lesbar.
- Doku: `docs/vault.md` (Einrichtung, Agenten-Zugang, Sicherheitsmodell, Grenzen).

## Audit

Neue Aktionen: `vault.item_create`, `vault.item_update`, `vault.item_delete`, `vault.reveal`,
`vault.use`, `vault.approve`, `vault.deny`, `vault.agent_key_create`,
`vault.agent_key_revoke`, `vault.agent_ip_denied`. Details: Eintrag, Agent, Server, Ziel
(Ursprung/Host). Nie Werte.

## Fehler- und Randfälle

- Fehler der Vault-Werkzeuge folgen dem Muster von `lib/browser/errors.js`: Code,
  Übersetzungsschlüssel, an den Agenten gerichtete Meldung mit nächstem Schritt.
- Entschlüsselung schlägt fehl: Werkzeug meldet `vault.item_unreadable`, Server-Log und Audit
  mit Eintrags-ID, Oberfläche zeigt den Eintrag als „nicht lesbar“.
- Server-Eintrag gelöscht: Agenten-Keys fallen per CASCADE weg, Bindungen an ihn ebenso.
- Ordner gelöscht: Bindungen an ihn werden entfernt.
- Organisation verlassen: Einträge der Organisation sind sofort nicht mehr sichtbar, auch für
  bestehende MCP-Sitzungen (Sichtbarkeit wird je Aufruf berechnet).
- Gleichnamige Einträge in Konto und Organisation: `vault_list` liefert beide mit Präfix des
  Besitzers (`org:<orgname>/<name>`); persönliche Einträge ohne Präfix.

## Tests

Budget nach Verhalten; Kernlogik der Sichtbarkeit test-first.

1. Agenten-Key wird auf jeder Route außer `/api/mcp` abgewiesen, ein `pending`-Key auch
   dort (HTTP über die Middleware).
2. IP-Bindung: eigene IP ok, fremde abgewiesen, CIDR ok, gelöste Bindung ok.
3. Reveal: Besitzer persönlich ok, `vault.reveal` bei Organisation ok, Mitglied ohne Recht
   `403`; jeder Abruf erzeugt Audit.
4. Sichtbarkeit als Tabelle: Server, Ordner mit Unterordner, Tag, `allServers`
   (persönlich/Organisation), keine Bindung, Konto-Key, Organisation verlassen.
5. `vault_list`-Antwort enthält keinen gespeicherten Wert (Prüfung über die serialisierte
   Antwort).
6. Freigabe: einmal, Sitzung, ablehnen, Timeout, kein Fenster.
7. Chromium-Reihe: Ausfüllen bei passendem Ursprung; Ablehnung bei fremdem Ursprung, fremdem
   iframe und Nicht-Passwortfeld.
8. Chromium-Reihe: nach dem Ausfüllen `browser_evaluate` gesperrt; `browser_snapshot`
   schwärzt Passwortfelder.
9. Einrichtungsbefehle quoten URL und Key mit Sonderzeichen korrekt.

Nicht getestet: reine Weiterreichung in Controllern, Konfig-Konstanten, Darstellung (prüft
mockingbird), Log-Ausgaben.

## Geänderter Bestand in der Oberfläche

Die übernommenen Elemente unten werden nicht neu gebaut, aber ergänzt (Manifest-Revision 11,
`touched`):

- `UI-SHELL-NAV`, `UI-SHELL-MOBILE-NAV`: Bereich „Vault“ zwischen Snippets und Browser, sichtbar
  nach `GET /api/vault/available` → `canUse` (Anleitung `docs/design/guides/ui-shell.md`).
- `UI-SERVERS-LIST-MENU`: „Agenten-Zugang…“ vor „Löschen“, nur bei SSH-Einträgen und
  `canProvision` (Anleitung `docs/design/guides/ui-servers.md`).

<!-- mockingbird:design:begin -->
<!-- design: manifest=docs/design/manifest.yaml design_rev=11 design_hash=sha256:766e158afd75a14d82bc0ce04a0172047319054631fe67e4cb4f1c012643d8d1 system=docs/design/design-system.md index=docs/design/mockups/index.html adapter=web screens=UI-VAULT,UI-VAULT-DIALOG,UI-AGENT-ACCESS,UI-VAULT-SETTINGS,UI-API-KEYS,UI-VAULT-APPROVAL consumes=UI-SHELL-NAV,UI-SHELL-MOBILE-NAV,UI-SHELL-ACCOUNT,UI-SERVERS-LIST-MENU -->
<!-- Generiert aus docs/design/manifest.yaml. Nicht von Hand ändern —
     Änderungen hier werden beim nächsten mockingbird-Lauf überschrieben.
     Design ändern heißt Manifest ändern. -->

## UI Requirements

| ID | Element | Screen | Status | Fachlicher Anker |
|----|---------|--------|--------|------------------|
| UI-VAULT-NEW | Neuer Eintrag | UI-VAULT | required | Öffnet den Eintrag-Dialog zum Anlegen. Nur sichtbar mit Recht vault.use oder vault.manage in mindestens einer Organisation. |
| UI-VAULT-SCOPE | Persönlich · Organisationen | UI-VAULT | required | Wechselt, wessen Einträge die Liste zeigt — die eigenen oder die einer Organisation. Ein Reiter je Besitzer. Nicht: server_folder, tag, item_type. |
| UI-VAULT-SEARCH | Suchen | UI-VAULT | required | Filtert die Liste nach Name, Benutzer, Host, Ursprung und Beschreibung. Durchsucht nie geheime Werte. |
| UI-VAULT-TYPES | Alle · Login · API-Key · SSH · Datenbank · Sonstiges | UI-VAULT | required | Filtert die Liste nach der Art der Zugangsdaten. Nicht: vault_owner, tag. |
| UI-VAULT-LIST | Einträge | UI-VAULT | required | Die Vault-Einträge des gewählten Besitzers — je Zeile Typ-Icon, Name, darunter Benutzer oder Host; ein Schild-Kennzeichen, wenn eine Freigabe nötig ist. Nie ein geheimer Wert. Nicht: identity, api_key, server_entry, snippet. |
| UI-VAULT-DETAIL | Eintrag | UI-VAULT | required | Kopf des gewählten Eintrags — Name, Typ, Besitzer, Beschreibung — mit Bearbeiten und Löschen (nur mit Verwaltungsrecht). Nicht: identity, server_entry. |
| UI-VAULT-DETAIL-ACTIONS | Bearbeiten · Löschen | UI-VAULT | required | Bearbeiten öffnet den Eintrag-Dialog; Löschen fragt im Bestätigungsdialog nach und entfernt den Eintrag samt Werten und Bindungen. Nur mit Verwaltungsrecht (Besitzer persönlicher Einträge, vault.manage bei Organisationen); ohne das Recht nicht sichtbar. Nicht: vault_secret. |
| UI-VAULT-DETAIL-FIELDS | Angaben | UI-VAULT | required | Die nicht geheimen Angaben des Eintrags je Typ — Login Benutzer und erlaubte Ursprünge, API-Key Hosts und Header, SSH Benutzer, Datenbank Engine, Host, Port, Datenbank, Benutzer. Nicht: vault_secret. |
| UI-VAULT-DETAIL-SECRET | Geheimer Wert | UI-VAULT | required | Je geheimem Feld eine Zeile mit genau zwölf Punkten, unabhängig von der Länge des Werts. Anzeigen und Kopieren nur für den Besitzer persönlicher Einträge oder mit vault.reveal; sonst der Hinweis, dass der Wert nur für Agenten nutzbar ist. Ein angezeigter Wert verbirgt sich nach 30 Sekunden. Nicht: vault_item_fields, identity. |
| UI-VAULT-DETAIL-SCOPE | Gilt für | UI-VAULT | required | Für welche Server Agenten diesen Eintrag sehen — einzelne Server, Ordner mit Unterordnern, Tags oder alle Server. Nicht: vault_owner, permission. |
| UI-VAULT-DETAIL-POLICY | Freigabe erforderlich | UI-VAULT | required | Ob jede Nutzung durch einen Agenten bestätigt werden muss, und wann der Eintrag zuletzt genutzt wurde. Nicht: permission, vault_binding. |
| UI-VAULT-DIALOG-TYPE | Typ | UI-VAULT-DIALOG | required | Art der Zugangsdaten — Login, API-Key, SSH, Datenbank, Sonstiges. Nur beim Anlegen wählbar, danach fest. Nicht: vault_owner. |
| UI-VAULT-DIALOG-OWNER | Besitzer | UI-VAULT-DIALOG | required | Wem der Eintrag gehört — dem eigenen Konto oder einer Organisation. Nur beim Anlegen wählbar. Nicht: vault_binding, server_folder. |
| UI-VAULT-DIALOG-FIELDS | Angaben | UI-VAULT-DIALOG | required | Name, Beschreibung und die nicht geheimen Angaben des gewählten Typs. Der Name ist die Kennung für Agenten, Kleinbuchstaben, Ziffern, Punkt, Bindestrich und Unterstrich. Nicht: vault_secret. |
| UI-VAULT-DIALOG-SECRET | Geheimer Wert | UI-VAULT-DIALOG | required | Eingabe der geheimen Felder des Typs. Beim Bearbeiten leer mit dem Hinweis, dass ein Wert gespeichert ist und leer lassen ihn behält. Nicht: vault_item_fields. |
| UI-VAULT-DIALOG-SCOPE | Gilt für | UI-VAULT-DIALOG | required | Auswahl, auf welchen Servern Agenten den Eintrag sehen — Server, Ordner (mit Unterordnern), Tags nur bei persönlichen Einträgen, oder Alle Server. Standard keine Auswahl. Nicht: vault_owner, permission. |
| UI-VAULT-DIALOG-APPROVAL | Freigabe erforderlich | UI-VAULT-DIALOG | required | Jede Nutzung durch einen Agenten muss im Outpost-Fenster bestätigt werden. Standard an. |
| UI-VAULT-DIALOG-SAVE | Speichern | UI-VAULT-DIALOG | required | Legt den Eintrag an bzw. speichert Änderungen und schließt den Dialog; Beschriftung Erstellen beim Anlegen. |
| UI-AGENT-ACCESS-KEYS | Agenten auf diesem Server | UI-AGENT-ACCESS | required | Die Agenten-Keys dieses Servers — Agent, angelegt, zuletzt genutzt, IP-Bindung — je mit Entziehen. Entziehen widerruft den Key und entfernt die Registrierung auf dem Server. Nicht: api_key, vault_item, identity. |
| UI-AGENT-ACCESS-SETUP | Einrichten | UI-AGENT-ACCESS | required | Welche Agenten eingerichtet werden (Claude Code, Codex) und welche zusätzlichen Adressbereiche (CIDR) ihr Key neben der IP dieses Servers akzeptiert. Nicht: api_key, vault_binding. |
| UI-AGENT-ACCESS-IPBIND | Nur von der IP dieses Servers | UI-AGENT-ACCESS | required | Ob der Key nur Anfragen von der Adresse dieses Servers (plus den eingetragenen Adressbereichen) akzeptiert. Standard an; aus heißt von überall. Nicht: vault_binding, allowed_origin. |
| UI-AGENT-ACCESS-RESULT | Ergebnis | UI-AGENT-ACCESS | required | Je Agent das Ergebnis der Einrichtung — eingerichtet, oder der fertige Befehl zum Kopieren, wenn die automatische Einrichtung scheiterte (CLI fehlt, Exec-Fehler). Der Key ist nur hier und nur jetzt sichtbar; ein Key, der weder automatisch eingerichtet noch kopiert wurde, wird beim Schließen gelöscht. Nicht: agent_key, toast. |
| UI-VAULT-SETTINGS-KEY | Vault-Schlüssel | UI-VAULT-SETTINGS | required | Ob der Vault läuft — Schlüssel aktiv, fehlt (Vault aus) oder passt nicht zu den gespeicherten Daten (Vault aus). Bei fehlendem Schlüssel ein Satz, wie man VAULT_KEY setzt. Nicht: encryption_key, api_key. |
| UI-VAULT-SETTINGS-URL | Outpost-Adresse für Agenten | UI-VAULT-SETTINGS | required | Die Adresse, unter der Server Outpost erreichen; daraus entsteht die MCP-URL, die beim Einrichten eines Agenten eingetragen wird. Nicht: browser_launcher_url. |
| UI-VAULT-SETTINGS-SAVE | Einstellungen speichern | UI-VAULT-SETTINGS | required | Speichert die Outpost-Adresse für Agenten, wie der Speichern-Knopf der Browser-Einstellungen. |
| UI-API-KEYS-LIST | API-Schlüssel | UI-API-KEYS | required | Die API-Keys des Kontos mit voller Kontoberechtigung — Name, Präfix, zuletzt genutzt, Ablauf; Anlegen und Löschen wie bisher. Nicht: agent_key. |
| UI-API-KEYS-AGENTS | Agenten-Schlüssel | UI-API-KEYS | required | Die Agenten-Keys des Kontos, gruppiert nach Server — Agent, zuletzt genutzt, IP-Bindung; je Server Bearbeiten (öffnet Agenten-Zugang) und je Key Entziehen. Agenten-Keys erreichen nur den MCP-Endpunkt. Nicht: api_key, vault_item. |
| UI-VAULT-APPROVAL-CARD | Freigabe angefordert | UI-VAULT-APPROVAL | required | Eine Karte unten rechts über jeder Seite, nicht modal: ein Agent will einen Vault-Eintrag nutzen. Zeigt Agent und Server, Eintrag und Ziel (Ursprung oder Host) und die verbleibende Zeit; Antworten Einmal, Für diese Sitzung, Ablehnen. Mehrere Anfragen stapeln sich, die älteste unten. Der Stapel liegt über Dialogen und Toasts. Eine abgelaufene Karte zeigt fünf Sekunden den Fehlerzustand und verschwindet; scheitert das Senden einer Antwort, bleibt die Karte stehen und ein Toast nennt den Grund. Nicht: notification, toast, error. |

**Übernommene Elemente** (hier nicht zu bauen, nur zu verwenden):
- `UI-SHELL-NAV` — Bereiche
- `UI-SHELL-MOBILE-NAV` — Bereiche (schmaler Schirm)
- `UI-SHELL-ACCOUNT` — Konto
- `UI-SERVERS-LIST-MENU` — Kontextmenü Server

Artboards: `docs/design/mockups/index.html` · Design-System: `docs/design/design-system.md`
<!-- mockingbird:design:end -->
