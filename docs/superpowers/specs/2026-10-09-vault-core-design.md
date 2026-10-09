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
| `entryId` | INTEGER null | nur bei `agent`; CASCADE |
| `agentType` | STRING null | `claude`, `codex` |
| `ipBinding` | BOOLEAN | Standard `true` |
| `allowedCidrs` | JSON null | zusätzliche Adressbereiche |

Bestehende Keys bekommen `kind = account` und verhalten sich unverändert.

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
   Kopieren. Der Key wird nur in diesem Dialog angezeigt; schließt der Nutzer ihn, ohne den
   Key übernommen oder kopiert zu haben, wird er gelöscht.

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

- **Vault-Seite** als eigener Bereich der Navigation (neben Snippets), nur sichtbar, wenn der
  Vault eingeschaltet ist und das Konto `vault.use` hat oder Mitglied einer Organisation ist.
  Liste gruppiert nach Persönlich und Organisationen, Filter nach Typ, Suche; je Zeile Typ,
  Name, Benutzername/Host, Kurzform der Geltung, Freigabe-Kennzeichen, zuletzt genutzt.
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
- `GET /agent-keys?entryId=`, `POST /agent-keys` (Einrichtung), `DELETE /agent-keys/:id`
  (Entziehen)

Ist der Vault ausgeschaltet, antworten alle mit `404`.

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

1. Agenten-Key wird auf jeder Route außer `/api/mcp` abgewiesen (HTTP über die
   Middleware).
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
