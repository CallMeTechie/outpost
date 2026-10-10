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
gepflegt werden können. Nutzbar durch Agenten ist in Teilprojekt 1 nur der Typ `login`. Die `fields` von `api_key`, `ssh` und `database` werden in Teilprojekt 1 nur gespeichert und angezeigt. Wie sie bei der Vermittlung gelten (Host-Abgleich, Header-Vorlage, Engine), legt Teilprojekt 2 fest, und es darf sie per Migration ändern.

### Grenze des Modells

Was ein Agent in einem eigenen Prozess hält, kann er ausgeben. Deshalb gibt kein Werkzeug
dieser Spec einen Wert heraus. Der Agenten-Key selbst ist vor dem Agenten nicht geheim
(`~/.claude.json` ist lesbar, Codex sieht seine Umgebung); er erlaubt nur vermittelte
Aktionen unter Server-Bindung, Freigabe und Audit, und die IP-Bindung macht ihn außerhalb
seines Servers wertlos.

Die IP-Bindung unterscheidet nicht zwischen Nutzern desselben Servers. Wer dort ein Konto hat, kann den Key aus `~/.claude.json` bzw. `~/.codex/outpost.env` lesen, wenn die Dateirechte es zulassen, und während der Einrichtung aus der Prozessliste: für die Millisekunden des Ablage-Execs und für die Laufzeit von `claude mcp add`, dessen `--header` den Key als Argument verlangt (mit `hidepid=2` auf `/proc` entfällt das). Er nutzt ihn dann mit der Adresse des Servers. Agenten-Zugang gehört deshalb auf Server, deren lokale Nutzer dem Konto-Inhaber vertrauen; `docs/vault.md` sagt das.


`vault.reveal` schützt die Vault-Oberfläche, nicht das Live-Bild: Wer einen Eintrag in seinem
eigenen Browser-Tab ausfüllen lässt und zusieht, kann ihn über „Passwort anzeigen“ der Seite
sichtbar machen, auch ohne `vault.reveal`. Das ist hingenommen und steht in `docs/vault.md`.

## Entscheidungen

| Frage | Entscheidung |
|---|---|
| Besitz | Konto oder Organisation (`accountId` xor `organizationId`), wie Identitäten. |
| Anzeigen in der Oberfläche | Abgestuft: Besitzer bei persönlichen Einträgen; bei Organisationseinträgen nur mit `vault.reveal`. Mitglieder ohne das Recht nutzen nur über Agenten. Jedes Anzeigen wird auditiert. |
| Geltung für Server | Vereinigung aus Servern, Ordnern (mit Unterordnern), Tags (nur persönliche Einträge) oder „alle Server“. Standard: keine Geltung. |
| Freigabe | Je Eintrag `approvalRequired`, Standard an. Antworten: einmal / für diese Agenten-Sitzung / ablehnen; 2 Minuten ohne Antwort = abgelehnt. |
| Agenten-Key auf den Server | Ein-Klick-Einrichtung per Exec; Kopierbefehl als Ausweg. |
| IP-Bindung | Je Key, vorbelegt mit dem Standard aus Einstellungen › Vault (`ipBindingDefault`, an); zusätzliche CIDRs und das Abschalten werden beim Einrichten festgelegt, einschließlich der Übernahme der gemessenen Adresse im Einrichtungsdialog (Schritt 1a); später nur durch Entziehen und Neu-Einrichten. |
| Architektur | Im Outpost-Server integriert, eigener `VAULT_KEY`. Kein eigener Container, kein Master-Passwort (späterer Ausbau möglich, die Verschlüsselung liegt hinter einer Schnittstelle). |

## Datenmodell

Neue Migration `0047-add-vault.js` mit `vault_items`, `vault_secrets`, `vault_bindings`, `vault_settings` und den neuen Spalten von `api_keys`. Migration `0048-add-vault-agent-url.js` ergänzt `api_keys.agentUrl` und `vault_settings.ipBindingDefault`.

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
| `createdBy` | INTEGER null | Konto; `SET NULL`, wenn das Konto gelöscht wird |
| `lastUsedAt` | DATE null | |
| Zeitstempel | | |

`accountId` und `organizationId` sind Fremdschlüssel mit `CASCADE`: Mit dem Konto bzw. der Organisation verschwinden ihre Einträge samt Werten und Bindungen.

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
| `valueEncrypted` | BLOB | AES-256-GCM mit `VAULT_KEY` über eigene Funktionen in `server/lib/vault/crypto.js` (`server/utils/encryption.js` ist fest an `ENCRYPTION_KEY` gebunden); Associated Data `vault:<itemId>:<field>`, damit kein Chiffretext in eine andere Zeile wandern kann |
| `valueIV`, `valueAuthTag` | STRING | |

Eindeutig auf (`itemId`, `field`). Geheime Felder je Typ: `login` → `password`;
`api_key` → `token`; `ssh` → `privateKey` und/oder `password`, optional `passphrase`;
`database` → `password`; `generic` → `value`.

Ändert ein `PATCH /items/:id` ein Ziel-Feld eines Eintrags (`origins`, `hosts`, `host`), löscht
der Server im selben Vorgang alle `vault_secrets` dieses Eintrags; der Dialog verlangt die Werte
neu. Sonst könnte jemand mit `vault.manage`, aber ohne `vault.reveal`, einen Organisationswert
ohne Sichtkontakt auf eine fremde Seite ausfüllen lassen. Audit `vault.item_update` mit `secretsCleared: true`.

Anders als `Credential` hat das Modell **keinen** `afterFind`-Hook. Entschlüsselt wird
ausschließlich in `server/lib/vault/secrets.js` (`readSecret(itemId, field)`), aufgerufen nur
von vermittelnden Werkzeugen und vom Reveal-Endpunkt. Listen, Exporte und Includes laden
dadurch nie Klartext.

### `vault_bindings`

`itemId` (CASCADE), `kind` (`entry`, `folder`, `tag`), `targetId`. Eindeutig auf allen drei. `targetId` zeigt je nach `kind` auf verschiedene Tabellen und hat deshalb keinen Fremdschlüssel. Bindungen entfernt der Code: `deleteEntry`, `deleteFolder` (rekursiv, einschließlich der dort per `Entry.destroy({ where: { folderId } })` gelöschten Einträge) und `deleteTag` rufen `removeBindings(kind, ids)` aus `server/lib/vault/bindings.js` auf.
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
| `identityId` | INTEGER null | nur bei `agent`; `SET NULL` |
| `remoteUser` | STRING null | nur bei `agent` |
| `agentUrl` | STRING(2048) null | nur bei `agent`; die Outpost-Adresse, mit der der Key eingerichtet wurde |

Bestehende Keys bekommen `kind = account` und verhalten sich unverändert. Die bestehende
Liste, das Löschen und die Obergrenze von 50 in `server/controllers/apiKey.js` gelten nur für
`kind = account`.

### `vault_settings`

Eine Zeile, Muster `browser_settings` (Migration 0046): `agentUrl` (STRING null), `ipBindingDefault` (BOOLEAN, Standard `true`), `keyCheck`, `keyCheckIV`, `keyCheckAuthTag` (je STRING null; ein fester Prüftext, mit `VAULT_KEY` verschlüsselt, geschrieben beim ersten Start mit Schlüssel). `keyStatus` wird beim Start daraus berechnet und nicht gespeichert.

### Berechtigungen (`server/permissions/registry.js`)

- `vault.use` (System, Standard aus, `dangerous`): persönliche Einträge anlegen und durch
  eigene Agenten nutzen lassen.
- `vault.manage` (Organisation): Organisationseinträge anlegen, bearbeiten, löschen.
- `vault.reveal` (Organisation, `dangerous`): Werte von Organisationseinträgen anzeigen.
- `settings.vault` (System): Einstellungsseite Vault.
- Nutzung von Organisationseinträgen durch Agenten: aktive Mitgliedschaft genügt.

## Sichtbarkeit

`server/lib/vault/visibility.js`:
`visibleItems({ accountId, agent })` liefert die Einträge, die ein Aufrufer nutzen darf.

- Kandidaten: persönliche Einträge des Kontos (nur mit `vault.use`) plus Einträge aller
  Organisationen, in denen das Konto aktives Mitglied ist (`OrganizationMember.status = "active"`; Einladungen zählen nicht).
- Agenten-Key (`agent.entryId` gesetzt): ein Eintrag gilt, wenn `allServers` gesetzt ist
  (bei Organisationseinträgen nur, wenn der Server laut `resolveEntryScope` zur Organisation gehört; `entry.organizationId` ist in Organisationsordnern leer) oder eine Bindung
  passt — `entry` = der Server; `folder` = Ordner des Servers oder ein Vorfahre davon
  (`Folder.parentId`); `tag` = ein Tag des Servers (`EntryTag`).
- Konto-Key und Login-Session (kein Server): nur persönliche Einträge mit `allServers`. Organisationseinträge brauchen immer einen Server der Organisation.
- Der Agent muss den Server selbst noch erreichen dürfen (`validateEntryAccess`); fällt der
  Zugriff weg, sieht der Key nichts mehr.

## Agentenzugang

### Authentifizierung (`server/middlewares/auth.js`)

- Agenten-Keys passieren nur Anfragen unter `/api/mcp`; alles andere `403`. Einzige Ausnahme: Ein `pending`-Agenten-Key passiert ausschließlich `GET /api/vault/agent-keys/probe`, ohne IP-Bindung, die er erst misst. Unter `/api/mcp` und überall sonst wird er abgewiesen. Ein endgültiger Agenten-Key, eine Login-Session oder ein Konto-Key erhalten an `probe` `403`.
- IP-Bindung: `normalizeIp(req.ip)` (nach `TRUST_PROXY`) muss einer der Adressen entsprechen, die `entry.config.ip` auflöst (alle A- und AAAA-Einträge, `dns.lookup` mit `all: true`), oder in `allowedCidrs` liegen. Auflösung mit Cache von 60 Sekunden; scheitert sie, gilt die Anfrage als Verstoß. Verstoß: `403` und Audit `vault.agent_ip_denied`, höchstens einmal je Key und Quelladresse in 10 Minuten.
  - Mit `TRUST_PROXY=true` stammt `req.ip` aus einem `X-Forwarded-For`, das der Aufrufer selbst setzen kann; die Bindung ist dann wirkungslos. Einstellungen › Vault und der Agenten-Zugang-Dialog warnen in diesem Fall. `docs/vault.md` verlangt eine Adressliste (die Adresse des Reverse-Proxys). Eine Hop-Zahl ist nur sicher, wenn Outpost ausschließlich über den Proxy erreichbar ist; sonst setzt ein Agent, der `agentUrl` direkt anspricht, `X-Forwarded-For` selbst. Die Doku erklärt außerdem, dass ohne `TRUST_PROXY` hinter einem Reverse-Proxy jede Anfrage von der Adresse des Proxys kommt (bei einem Agenten auf dem Proxy-Host selbst gilt dessen Key dann von überall).
- Agenten-Keys werden wie ungültige Keys abgewiesen, solange der Vault aus ist, und mit `403`, wenn das Konto den Server des Keys nicht mehr erreichen darf (`validateEntryAccess`).
- Agenten-Keys öffnen nur ephemere Browser-Sitzungen; `profile: "persistent"` ergibt einen Fehler.
- `req.agent = { keyId, entryId, agentType }`.
- `lastUsedAt` wie bei Konto-Keys.

### MCP-Rahmen (`server/lib/mcp/`)

`server/lib/browser/mcpServer.js` zieht nach `server/lib/mcp/server.js` um und nimmt
**Werkzeug-Anbieter** statt eines Werkzeugsatzes:

```
provider = { name, available(ctx) → bool, list(ctx) → tools[], has(name, ctx), call(name, args, ctx), forgetTransport(id) }
ctx      = { accountId, agent | null, keyId | null, transportId, ipAddress, userAgent, signal }
```

- Browser-Anbieter: bisherige `createBrowserTools`, `available` = `connect.browser`.
- Vault-Anbieter: `available` = Vault eingeschaltet und (Recht `vault.use` oder aktives Mitglied einer Organisation). `vault_list` ist dann verfügbar. `browser_fill_credential` listet und nimmt der Anbieter nur, wenn zusätzlich `connect.browser` gilt; sonst antwortet es wie ein unbekanntes Werkzeug.
- `tools/list` vereinigt die verfügbaren Anbieter, `tools/call` leitet an den Anbieter des
  Werkzeugs; nicht verfügbare Werkzeuge antworten wie unbekannte.
- Ein Transport gehört dem Aufrufer, der ihn mit `initialize` geöffnet hat: (`accountId`, `keyId`). `keyId` ist die Id des API-Keys, bei Agenten- wie bei Konto-Keys, und `null` für die Login-Session. Eine Anfrage mit derselben `Mcp-Session-Id`, aber einem anderen Aufrufer antwortet `404` wie bei einem unbekannten Transport; das gilt auch für `DELETE /api/mcp`. `signal` bricht ab, sobald der Client die HTTP-Verbindung schließt, bevor die Antwort fertig ist (`res.on("close")` in `server/routes/mcp.js`). Die Freigabe nutzt es für `client_gone`. Die Obergrenze von 50 Transporten gilt je Key.
- Für Agenten-Keys schränkt der Browser-Anbieter ein: `via` nur zum Server-Eintrag des Keys
  (sonst `vault.via_not_allowed` bzw. der Browser-Fehler für fremde Ziele), und `browser_list`,
  die Auflösung von `sessionId` und die Standard-Sitzung umfassen nur Sitzungen, die dieser Key
  geöffnet hat. Sitzungen des Nutzers und anderer Agenten bleiben unsichtbar. Jede Sitzung trägt dafür die `keyId` des Aufrufers, der sie geöffnet hat; `#adoptPopup` übernimmt sie vom Öffner. Dieselbe Einschränkung gilt für `browser_fill_credential` im Vault-Anbieter. Login-Session und
  Konto-Keys verhalten sich wie bisher.
- Protokoll unverändert (JSON-RPC 2.0, Streamable HTTP ohne SSE, `Mcp-Session-Id`).
- Die Route `server/routes/mcp.js` bleibt, baut aber den Rahmen mit beiden Anbietern.

### `vault_list`

Liefert für jeden sichtbaren Eintrag: `item` (die Kennung, die `browser_fill_credential` annimmt), `owner` (`personal` oder Organisationsname), `type`, `description`, `username` bzw. `host`,
`origins`/`hosts`, `approvalRequired`, `usableBy` (Liste der Werkzeuge, die den Typ heute
nutzen; in Teilprojekt 1 nur `browser_fill_credential` für `login`). Nie Werte, Längen,
Präfixe oder Hashes von Werten.

### Einrichtung per Klick

Kontextmenü des Server-Eintrags → „Agenten-Zugang…“ (nur SSH-Einträge, nur mit Zugriff auf
den Eintrag). Auswahl Claude Code und/oder Codex.

1. Outpost legt den Agenten-Key an (`kind = agent`, Name `claude@<entry>` bzw.
   `codex@<entry>`).
1a. Adresse messen, solange der Key `pending` ist (vor Schritt 2): Der Server ruft per Exec `GET <agentUrl>/api/vault/agent-keys/probe` mit diesem Key auf (`curl -fsS -H @<datei>`; ersatzweise `wget -qO- --config=<datei>`). Weil `execCommand` keine Standardeingabe kennt, legt ein eigener, kurzer Exec ohne CLI- und Netzaufruf den Key zuerst per Builtin-`printf` in `~/.config/outpost/key-<id>-<zufall>` ab (Modus `0600`, Verzeichnis `0700`); nur dieser Exec trägt den Key in der Befehlszeile, für Millisekunden. Alle weiteren Befehle lesen ihn einmal per `$(cat …)` und brechen ab, wenn er leer ist, bevor sie etwas entfernen oder schreiben; an das Werkzeug geht er aus einer Datei mit Modus `0600`. Die Ablagedatei wird am Ende der Einrichtung und auf jedem Abbruchpfad gelöscht (siehe „Grenze des Modells“). `probe` antwortet mit der gesehenen Adresse (`normalizeIp(req.ip)`); der Server speichert nur die erste Messung am Key. `confirm` mit `addSeenIp` lehnt mit `409` ab, wenn die gemessene Adresse die des bestätigenden Browsers ist (dann misst Outpost den Proxy, nicht den Server). Weicht sie von den aufgelösten Adressen des Servers ab (NAT, Docker-Gateway, IPv6), sagt das Ergebnis das. Der Dialog bietet dann an, sie als `/32` bzw. `/128` zu übernehmen: `POST /agent-keys/:id/confirm` mit `{ addSeenIp: true }` trägt die gespeicherte Adresse in `allowedCidrs` ein, nie einen Wert vom Client. Das geht einmal und nur bis 15 Minuten nach dem Anlegen, auch bei `configured`. Ohne Übernahme weist die IP-Bindung den Key ab; das Ergebnis sagt das. Scheitert die Messung (kein Werkzeug, Outpost vom Server aus nicht erreichbar), sagt das Ergebnis das, und die Einrichtung läuft mit der statischen Auflösung weiter.
2. Outpost führt über `execCommand(accountId, entryId, identityId, command)` aus, mit der Identität, die `resolveIdentity(entry, null, null, accountId)` liefert (dieselbe Wahl wie bei `via`). Der Key speichert `identityId` und den entfernten Benutzernamen. Das Ergebnis nennt ihn („eingerichtet für root“), und Entziehen führt die Entfernbefehle mit derselben Identität aus. Ist die Identität inzwischen gelöscht, löscht Entziehen nur den Key und zeigt die Entfernbefehle zum Kopieren.
   - Claude: `claude mcp add --scope user --transport http outpost <url> --header "Authorization: Bearer <key>"`
     (vorher `claude mcp get outpost`. Besteht schon eine Registrierung, etwa die Konto-Key-Registrierung aus `docs/browser-tabs.md`, nennt das Ergebnis, dass sie ersetzt wurde und der alte Konto-Key in Outpost gültig bleibt, bis der Nutzer ihn löscht. Dann `claude mcp remove --scope user outpost`, Fehler ignoriert; der ganze Befehl läuft mit `umask 077`, nach `add` zusätzlich `chmod 600 ~/.claude.json`).
   - Codex: `~/.codex/outpost.env` mit `export OUTPOST_MCP_TOKEN=<key>`, Modus `0600`; eine
     Zeile `[ -f ~/.codex/outpost.env ] && . ~/.codex/outpost.env` in `~/.bashrc`, `~/.profile` und, falls vorhanden, `~/.bash_profile` und `~/.zshrc`, jeweils nur, wenn sie noch fehlt. Das Ergebnis sagt: „Codex in einer neuen Shell starten; laufende Codex-Prozesse und tmux-Sitzungen kennen den Key nicht.“; dann
     `codex mcp add outpost --url <url> --bearer-token-env-var OUTPOST_MCP_TOKEN`.
   - Alle Werte werden über einen gemeinsamen Quoting-Baustein (`server/lib/vault/provision.js`)
     in die Befehle gesetzt.
   - Die CLIs werden per `command -v` in einer Login-Shell gesucht (`bash -lc`, ersatzweise `sh -lc`) und zusätzlich unter `~/.local/bin`, `~/.claude/local` und `~/.npm-global/bin`. Gefunden wird mit absolutem Pfad aufgerufen. „CLI fehlt“ heißt: an keiner dieser Stellen gefunden.
   - `execCommand` gibt `entry.config.engineId` heute nicht weiter (`server/controllers/execCommand.js:48`). Die Einrichtung ergänzt das Argument, wie `openEngineSession` in `server/lib/browser/proxy.js` es tut.
3. `<url>` = Adresse aus dem Dialog + `/api/mcp`. Der Dialog belegt sie mit der Adresse der letzten Einrichtung auf diesem Server vor, sonst mit der Einstellung „Outpost-Adresse für Agenten“; so lassen sich Server im LAN direkt und Server außerhalb über einen Reverse-Proxy anbinden. `POST /agent-keys` nimmt sie als `agentUrl` (dieselbe Prüfung wie die Einstellung), fehlt sie, gilt die Einstellung. Der Key speichert die verwendete Adresse; Messung (Schritt 1a) und Befehl zum Kopieren nutzen sie. Fehlt `ipBinding` in der Anfrage, gilt `ipBindingDefault`.
4. Scheitert ein Schritt (CLI fehlt, Exec-Fehler), zeigt der Dialog den fertigen Befehl zum
   Kopieren. Der Key wird nur in diesem Dialog angezeigt.
5. Ein neuer Agenten-Key ist zunächst `pending`. Er wird endgültig, wenn die automatische
   Einrichtung gelingt oder der Nutzer den Befehl kopiert (`POST /agent-keys/:id/confirm`).
   Schließt der Nutzer den Dialog vorher, löscht der Client ihn (`DELETE /agent-keys/:id`);
   was danach noch `pending` ist, löscht der Server nach 15 Minuten. Ein `pending`-Key wird von
   `authenticate` nur an `probe` akzeptiert (Schritt 1a).
6. Gibt es weder im Dialog noch als Einstellung eine Adresse, ist Einrichten gesperrt
   (`409`) mit dem Hinweis, sie im Dialog oder in Einstellungen › Vault einzutragen.
7. Erneutes Einrichten für denselben Server, Agenten und entfernten Benutzer ersetzt den bisherigen Key dieses Kontos: Nach gelungener Einrichtung bzw. Bestätigung wird der alte gelöscht. Hat ein **anderes** Konto für denselben Server und entfernten Benutzer schon einen Agenten-Key, warnt der Dialog vor dem Einrichten: Die Registrierung wird ersetzt, und Agenten dieses Benutzers handeln danach mit den Einträgen und Freigaben des neuen Kontos.

8. Mehrere Konten auf demselben Unix-Benutzer: In Teilprojekt 1 nur die Warnung aus Schritt 7.
   Ein Key je (Server, entferntem Benutzer) mit Sperre des fremden Keys folgt in Teilprojekt 3.

Entziehen fragt vorher im Bestätigungsdialog nach.

„Zugang entziehen“ löscht den Key und entfernt danach die Registrierung nur, wenn sie noch diesen Key trägt. Verglichen wird das (nicht geheime) Präfix des Keys im Eintrag `outpost` von `~/.claude.json` bzw. in `~/.codex/outpost.env`; der Vergleich läuft auf dem Zielserver im selben Exec wie das Entfernen, sodass ein fremder Key den Server nie verlässt. Outpost liest nur die Ergebniszeile (`REMOVED`, `FOREIGN`, `ABSENT`). Dann folgen `claude mcp remove --scope user outpost` bzw. `codex mcp remove outpost` und das Entfernen von `~/.codex/outpost.env`. Trägt die Registrierung einen anderen Key (anderes Konto, Schritt 7), bleibt sie stehen, und das Ergebnis sagt das. Ersetzt Schritt 7 den eigenen alten Key, wird dieser ohne Entfernbefehle gelöscht. Schlägt das Entfernen fehl, ist der Key trotzdem widerrufen.

## `browser_fill_credential`

Neues Werkzeug im Vault-Anbieter, das den Browser-Pool nutzt.

```
browser_fill_credential({ item, passwordRef, usernameRef?, sessionId? })
```

Prüfungen in dieser Reihenfolge, jede bricht mit eigenem Fehler ab:

1. `item` ist sichtbar (siehe Sichtbarkeit). Nicht sichtbar und nicht vorhanden ergeben
   denselben Fehler `vault.item_unknown`.
2. `type === "login"`.
3. Die Browser-Sitzung gehört dem Aufrufer nach denselben Regeln wie bei den `browser_*`-Werkzeugen (bei Agenten-Keys: von diesem Key geöffnet oder ein Popup einer solchen Sitzung; das gilt auch für die Auflösung ohne `sessionId`) und ist nicht pausiert. Eine fremde `sessionId` ergibt denselben Fehler wie eine unbekannte.
3a. Im Browser-Kontext der Sitzung (siehe „Folgen für die Browser-Sitzung“) lief seit seiner Entstehung kein `browser_evaluate`, auch nicht in einer inzwischen geschlossenen Sitzung. Ein Popup kann über `window.opener` oder einen Service Worker die Anmeldeseite präpariert haben. `browser_evaluate` markiert den Kontext, bevor es `Runtime.evaluate` sendet; Prüfen und Markieren geschehen ohne `await` dazwischen. Sonst `vault.session_tainted` („öffne mit browser_open ohne profile=persistent eine neue Sitzung und fülle dort aus“). Im Profil `persistent` wird nie ausgefüllt (3b), weil Präparationen dort auf der Platte jeden Kontext überleben. Ein Dokumentwechsel reicht nicht: Der bfcache stellt präparierte Dokumente wieder her.
3b. Die Sitzung läuft nicht über `via` und nicht im Profil `persistent` (dort `vault.persistent_not_allowed`). Dort führt die Verbindung durch einen Server, den der Agent selbst bedient, und bei `http`-Ursprüngen läge das Passwort dort im Klartext. Fehler `vault.via_not_allowed`.
4. Der Ursprung des **Frames**, in dem das Ziel-Element liegt, und die Ursprünge aller seiner Vorfahren-Frames bis zur obersten Seite entsprechen je exakt einem Eintrag aus `origins` (Schema, Host, Port; Standardports normalisiert). Sonst könnte eine fremde Seite, die die Anmeldung einbettet, den Fokus zwischen Fokussieren und Eingabe in ein eigenes Feld ziehen. Wer eine Einbettung will, trägt den einbettenden Ursprung ein.
5. `passwordRef` ist ein `<input type="password">`; `usernameRef`, falls angegeben, ein
   Textfeld (`text`, `email`, `tel` oder ohne Typ) im selben Ursprung.
6. Freigabe, falls `approvalRequired`. Gewartet wird außerhalb von `session.runAgent`, denn dessen Grenze `AGENT_CALL_TIMEOUT_MS` (90 s) liegt unter den 2 Minuten der Freigabe. Während der Wartezeit ist die Sitzung für andere Werkzeuge frei, auch für `browser_evaluate`. Nach der Freigabe laufen deshalb die Prüfungen 1 (mit dem Eintrag, wie er jetzt ist; ein inzwischen entzogener Agenten-Key oder geänderter Ursprung lässt das Ausfüllen scheitern), 2, 3, 3a, 3b, 4 und 5 in `runAgent` erneut, unmittelbar vor dem Ausfüllen. Ohne Freigabe laufen 3 bis 5 und das Ausfüllen in einem einzigen `runAgent`. Scheitert eine Prüfung nach der Freigabe, ist eine Antwort `once` verbraucht (eine Antwort `session` bleibt gemerkt), und das Werkzeug meldet den Fehler dieser Prüfung.

Ausfüllen: `readSecret(item, "password")`, Fokus über die Referenz. Unmittelbar vor `Input.insertText` wird geprüft, ob das fokussierte Element (durch Shadow-Roots hindurch) das Ziel ist (`backendNodeId`); sonst `vault.focus_lost` ohne Eingabe. Dann `Input.insertText` wie
`browser_type`; beim Benutzernamen vorher Feld leeren. Antwort an den Agenten nur
„Filled username and password of `<item>`." Klartext erscheint nie in Antwort,
Log oder Audit.

### Folgen für die Browser-Sitzung

- Jeder Snapshot wird in `buildSnapshot` geschwärzt, also auch die Snapshots, die `browser_open`, `_navigate`, `_click`, `_type`, `_key`, `_scroll` und `_wait` zurückgeben. Geschwärzt wird **immer** (auch Eingaben des Nutzers) der Wert jedes `<input type="password">` in allen Frames und der Wert jedes Elements, das `browser_fill_credential` in diesem Kontext befüllt hat, auch wenn dessen Typ inzwischen nicht mehr `password` ist („Passwort anzeigen“). Das Ergebnis ist `value="••••"`, unabhängig von der Länge. Der Accessibility-Baum kennt den Eingabetyp nicht; die Menge der zu schwärzenden `backendNodeId`s kommt je Snapshot aus dem DOM.
- Browser-Kontext heißt: bei ephemeren Sitzungen der `browserContextId`, den `BrowserPool.open()` anlegt; bei `persistent` die Instanz `account-<accountId>`. Popups erben den Kontext ihres Öffners. `#adoptPopup` registriert sie heute mit `browserContextId: null`; die Pool-Registrierung bekommt deshalb ein Feld `contextKey`, das das Popup vom Öffner übernimmt. Vor dem ersten `Input.insertText` von `browser_fill_credential` wird der Kontext „befüllt“, nicht erst nach dessen Erfolg. Die Sperre gilt für jede Sitzung dieses Kontexts, auch für später angehängte Popups, mit oder ohne `window.opener`. Ein ephemerer Kontext endet mit `Target.disposeBrowserContext`, wenn die Sitzung schließt, die ihn angelegt hat; ihre Popups enden mit ihm. Der Kontext `persistent` endet, wenn seine letzte Sitzung schließt. `browser_evaluate` antwortet dort mit `vault.evaluate_locked` („in dieser Sitzung gesperrt, weil
  Zugangsdaten eingetragen wurden; nutze snapshot und click“).
- `browser_screenshot` bleibt erlaubt, außer ein Element, das `browser_fill_credential` in
  diesem Kontext befüllt hat, existiert noch und ist nicht mehr `type="password"` („Passwort
  anzeigen“): dann `vault.screenshot_locked`. Die Prüfung läuft unmittelbar vor jeder Aufnahme.
- Auswahl und Zwischenablage teilen sich alle Kontexte einer Browser-Instanz und überdauern den Kontext. Deshalb ist ein Mittelklick (`browser_click` mit `button: "middle"`) immer gesperrt, und im befüllten Kontext sind `browser_key` mit Strg-, Meta- oder Umschalt-Kombination (außer `Shift+Tab`) und Mehrfachklicks (`clickCount > 1`) gesperrt: `vault.input_locked`, Audit `vault.input_locked`. `browser_fill_credential` leert Felder vor dem Tippen, statt sie zu markieren.
- Jeder Text, der an den Agenten oder ins Audit geht und aus einem befüllten Kontext stammt oder eine seiner Sitzungen nennt (Snapshot, `URL:`, `Title:`, Fehlermeldungen, `browser_list`, die Liste „Open sessions:“ in Fehlern, auch wenn sie aus einem anderen Kontext abgefragt werden, `details.url` von `recordBrowserAudit`), wird vor dem Versand nach dem Wert der dort eingetragenen Passwörter durchsucht, roh, mit `encodeURIComponent` und formular-kodiert. Jedes Vorkommen wird durch `••••` ersetzt. Dafür legt `browser_fill_credential` beim Ausfüllen im Kontext eine eigene, mit `VAULT_KEY` verschlüsselte Kopie des eingetragenen Werts an (Associated Data `vault:ctx:<contextKey>`). Sie wird mit dem Kontext verworfen und je Prüfung entschlüsselt; Klartext bleibt nicht im Kontext. `readSecret` des Eintrags taugt dafür nicht: Ein `PATCH` mit Zieländerung löscht den Wert, und ein geänderter Wert ist nicht mehr der eingetragene. Anlass: Ein Formular mit `method=get` legt das Passwort in die URL, und `auditUrl` entfernt nur Benutzerteil und Fragment.

## Freigabe

`server/lib/vault/approvals.js`.

- Anfrage: `{ id, accountId, agentType, entryName, item, target, expiresAt }`, verteilt über
  den `StateBroadcaster` an alle offenen Fenster des Kontos, dem der Agenten-Key gehört (bei
  Organisationseinträgen derselbe Nutzer, nicht Org-Admins).
- Offene Anfragen sind Zustand des Kontos: neuer Typ `VAULT_APPROVALS` in `STATE_TYPES` und `BROADCASTABLE_TYPES` (`server/lib/StateBroadcaster.js` und `client/src/common/hooks/useStateStream.js`), `getStateData` liefert die offenen Anfragen. Ein Fenster, das sich (neu) verbindet, erhält sie sofort. Nach jeder Antwort, jedem Ablauf und jedem Abbruch wird die Liste an alle Fenster des Kontos neu verteilt.
- Die erste Antwort gewinnt (atomar im Speicher). Jede weitere Antwort auf dieselbe Anfrage erhält `409`, eine Antwort nach `expiresAt` erhält `410`.
- Antwort per Endpunkt `POST /api/vault/approvals/:id` mit `once`, `session` oder `deny`;
  nur das besitzende Konto.
- `session` merkt sich (`transportId`, `item`, Stand des Eintrags: `updatedAt` und Ursprünge) im Speicher bis zum Ende der MCP-Sitzung
  (`forgetTransport`) oder bis zum Neustart; ändert sich der Eintrag, gilt die Freigabe nicht mehr.
- Aufrufe aus einer Impersonations-Sitzung brauchen immer eine Freigabe, auch wenn der Eintrag keine verlangt.
- Offene Anfragen tragen zusätzlich `remainingMs`; der Client zählt davon herunter, nicht von seiner eigenen Uhr.
- Der Werkzeugaufruf wartet bis `expiresAt` (jetzt + 2 Minuten). Ohne Antwort:
  `vault.approval_timeout`. Schließt der Client die HTTP-Verbindung vorher (eigene Werkzeug-Zeitgrenze, Proxy-Timeout), wird die Anfrage sofort zurückgezogen: Die Karte verschwindet, das Audit schreibt `vault.approval_timeout` mit `reason: "client_gone"`, und eine spätere Antwort füllt nichts mehr aus. `docs/vault.md` nennt die nötigen Zeitgrenzen (Reverse-Proxy `proxy_read_timeout` ≥ 150 s, Codex `tool_timeout_sec`).
- Ist kein Fenster des Kontos verbunden, sofort `vault.approval_unavailable` („Outpost
  öffnen, um Freigaben zu erteilen“).
- Mehrere offene Anfragen werden unabhängig beantwortet. Je (Transport, Eintrag) gibt es höchstens eine offene Anfrage. Ein zweiter Aufruf, solange sie offen ist, erhält sofort `vault.approval_pending` („warte auf die offene Freigabe“), denn eine Antwort `once` gilt für genau ein Ausfüllen. Je Aufrufer (`accountId`, `keyId` wie bei der Transport-Bindung) sind höchstens drei Anfragen offen, darüber `vault.approval_busy`. Nach `deny` antwortet derselbe Aufrufer für denselben Eintrag 60 Sekunden lang sofort mit `vault.approval_denied`, ohne neue Karte, auch über einen neu geöffneten Transport.

## Oberfläche

- **Vault-Seite** als eigener Bereich der Navigation (neben Snippets), nur sichtbar laut
  `GET /api/vault/available` (`canUse`). Zweispaltig: links die Liste mit Reitern je Besitzer
  (Persönlich, Organisationen), Filter nach Typ, Suche; je Zeile Typ, Name, Benutzername/Host,
  Freigabe-Kennzeichen. Rechts die Details: Angaben, geheime Felder, Geltung, Freigabe und
  zuletzt genutzt, Bearbeiten/Löschen.
- **Eintrag-Dialog**: „Freigabe erforderlich“ abschalten (beim Anlegen oder Bearbeiten) verlangt eine Login-Session ohne Impersonation; Konto-Keys und Impersonation erhalten `403`. Felder je Typ; geheime Felder beim Bearbeiten leer mit Hinweis
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
  zuletzt genutzt und IP-Bindung; je Key Entziehen, je Server „Bearbeiten“ (öffnet den Agenten-Zugang-Dialog).
- **Einstellungen → Vault** (System, `settings.vault`): Status von `VAULT_KEY`,
  „Outpost-Adresse für Agenten“ (ist sie leer, mit der Adresse des Browsers vorbelegt und als
  Vorschlag gekennzeichnet; gespeichert wird erst mit Speichern) und „IP-Bindung als Standard“.

Gestaltung kommt aus mockingbird (Manifest und Artboards) vor der Umsetzung; diese Spec legt
nur Verhalten und Inhalte fest.

Mobile-App (Flutter) ist nicht Teil dieses Teilprojekts.

## REST-Endpunkte

Unter `/api/vault`, nur Login-Session oder Konto-Key (Agenten-Keys sind ausgeschlossen, außer dem `pending`-Key an `GET /agent-keys/probe`). Reveal, `POST /approvals/:id` sowie Einrichten, Bestätigen und Entziehen von Agenten-Keys verlangen eine Login-Session; Konto-Keys erhalten dort `403`, wie `blockApiKeyAuth` in `server/routes/apiKey.js`:

- `GET /items`, `POST /items`, `PATCH /items/:id`, `DELETE /items/:id`
- `GET /items/:id/secrets/:field` (Reveal)
- `POST /approvals/:id`
- `GET /agent-keys` (alle Agenten-Keys des Kontos; mit `?entryId=` nur die eines Servers und
  zusätzlich `{ remoteUser, otherAccountConfigured }`: der entfernte Benutzer der Identität, die
  `resolveIdentity` wählen würde, und ob ein anderes Konto für diesen Server und Benutzer schon
  einen Agenten-Key hat — Grundlage der Warnung vor dem Einrichten).
- `POST /agent-keys` (Einrichtung), `GET /agent-keys/probe` (nur der `pending`-Agenten-Key selbst, siehe Einrichtung Schritt 1a), `POST /agent-keys/:id/confirm` (optional `{ addSeenIp: true }`), `DELETE /agent-keys/:id` (Entziehen bzw. Verwerfen).
- Antwort von `POST /agent-keys`: je Agent `{ id, agentType, status: "configured" | "manual", remoteUser, command?, probe: { seenIp, matches } | null, replacedRegistration: boolean }`; `command` (mit Key) nur bei `manual`.
- `GET /settings`, `PATCH /settings` (Recht `settings.vault`): `{ keyStatus: "active" |
  "missing" | "mismatch", agentUrl, trustProxyUnsafe }`; `agentUrl` muss eine http- oder https-Adresse sein.
  `GET /settings` antwortet auch bei ausgeschaltetem Vault, damit die Seite den Grund zeigt.

Ist der Vault ausgeschaltet, antworten alle mit `404`, außer `GET /settings`, `PATCH /settings` (die Agenten-Adresse lässt sich vor dem Schlüssel setzen) und `GET /available`.

Ausnahme `GET /api/vault/available`, nach dem Muster von `GET /api/browser/available`: antwortet
immer `200` mit `{ enabled, canUse, canManageOrgs: [orgId…], canProvision, agentUrlSet, impersonating, trustProxyUnsafe }`, bei `canUse` zusätzlich `agentUrl` und `ipBindingDefault` (Vorbelegung im Agenten-Zugang-Dialog). `enabled` = Vault
eingeschaltet; `canUse` = `vault.use` oder aktives Mitglied mindestens einer Organisation (steuert den
Bereich in der Navigation); `canProvision` = Vault eingeschaltet und `vault.use` oder aktives Mitglied
(steuert „Agenten-Zugang…“ im Server-Kontextmenü); `impersonating` = die Sitzung trägt
`impersonatorId` (die Oberfläche blendet dann Anzeigen, Freigabe-Knöpfe und Einrichten aus);
`agentUrlSet` = die Agenten-Adresse ist gesetzt (sonst ist Einrichten gesperrt); `trustProxyUnsafe` = `TRUST_PROXY` ist `true` (Warnung im Agenten-Zugang-Dialog). Der Dialog liest beides hier, weil `GET /settings` `settings.vault` verlangt. Ist der Vault
aus, sind alle Rechte-Felder `false` bzw. leer.

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
- Die Oberfläche bekommt eine Content Security Policy, zuerst als `Content-Security-Policy-Report-Only` mit Meldeendpunkt `POST /api/csp-report`; `frame-ancestors 'self'` und `X-Frame-Options: SAMEORIGIN` gelten sofort. Datei-Vorschau-Antworten (außer PDF) tragen `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups`, damit eine HTML- oder SVG-Datei auch außerhalb ihres iframes nicht im Outpost-Ursprung läuft.
- Doku: `docs/vault.md` (Einrichtung, Agenten-Zugang, Sicherheitsmodell, Grenzen).

## Audit

Neue Aktionen: `vault.item_create`, `vault.item_update`, `vault.item_delete`, `vault.reveal`,
`vault.use`, `vault.approve`, `vault.deny`, `vault.agent_key_create`,
`vault.agent_key_revoke`, `vault.agent_ip_denied`, `vault.use_denied` (eine Prüfung von `browser_fill_credential` oder die Fokusprüfung schlägt fehl, mit Fehlercode wie `vault.session_tainted` oder `vault.focus_lost`, mit Angabe, ob vor oder nach der Freigabe, und mit Ziel), `vault.approval_timeout` (mit `reason`: `expired` oder `client_gone`), `vault.item_unreadable`, `vault.evaluate_locked`, `vault.screenshot_locked`, `vault.persistent_not_allowed`, `vault.input_locked`. Details: Eintrag, Agent, Server, Ziel
(Ursprung/Host). Nie Werte.

## Fehler- und Randfälle

- Fehler der Vault-Werkzeuge folgen dem Muster von `lib/browser/errors.js`: Code,
  Übersetzungsschlüssel, an den Agenten gerichtete Meldung mit nächstem Schritt.
- Entschlüsselung schlägt fehl: Werkzeug meldet `vault.item_unreadable`, Server-Log und Audit
  mit Eintrags-ID, Oberfläche zeigt den Eintrag als „nicht lesbar“.
- Server-Eintrag gelöscht: Agenten-Keys fallen per CASCADE weg; Bindungen an ihn entfernt `deleteEntry`.
- Ordner gelöscht: Bindungen an ihn, an seine Unterordner und an die mitgelöschten Einträge entfernt `deleteFolder`.
- Tag gelöscht: Bindungen an ihn entfernt `deleteTag`.
- Organisation verlassen: Einträge der Organisation sind sofort nicht mehr sichtbar, auch für
  bestehende MCP-Sitzungen (Sichtbarkeit wird je Aufruf berechnet).
- Kennung für Agenten: Persönliche Einträge heißen `<name>`, Organisationseinträge immer `org:<organizationId>/<name>`, auch ohne Namensgleichheit. So wechselt eine Kennung nicht, wenn anderswo ein gleichnamiger Eintrag entsteht. Organisationsnamen sind nicht eindeutig und taugen nicht als Kennung; `vault_list` nennt sie in `owner`.

## Impersonation

`POST /users/:accountId/login` (Recht `users.impersonate`) erzeugt eine Sitzung des Zielkontos.
`sessions` bekommt die Spalte `impersonatorId` (INTEGER null, gesetzt nur von diesem Endpunkt).
In solchen Sitzungen antworten Reveal (`GET /items/:id/secrets/:field`), Freigabe-Antworten
(`POST /approvals/:id`), Einrichten, Bestätigen und Entziehen von Agenten-Keys mit `403`; die
Vault-Seite zeigt Einträge, aber keine Anzeigen-Knöpfe. Jeder Audit-Eintrag, den eine HTTP-Anfrage einer solchen
Sitzung erzeugt, nennt zusätzlich `impersonatorId` (WebSocket-Handler wie Terminal, SFTP und AI in Teilprojekt 1 noch nicht). Ein Impersonator kann keinen Konto-Key anlegen (`POST /api/accounts/api-keys` verlangt eine Login-Session ohne `impersonatorId`); Reveal, Freigabe-Antworten und die Verwaltung der Agenten-Keys verlangen ohnehin eine Login-Session (siehe REST-Endpunkte). Fenster einer Impersonations-Sitzung erhalten `VAULT_APPROVALS` nicht und zählen für `vault.approval_unavailable` nicht als verbundenes Fenster; `StateBroadcaster.register` bekommt dafür, ob die Session `impersonatorId` trägt.

## Tests

Budget nach Verhalten; Kernlogik der Sichtbarkeit test-first.

1. Agenten-Key wird auf jeder Route außer `/api/mcp` abgewiesen, ein `pending`-Key auch dort; die `Mcp-Session-Id` eines anderen Keys desselben Kontos ergibt `404` (HTTP über die Middleware).
2. IP-Bindung: eigene IP ok, fremde abgewiesen, CIDR ok, gelöste Bindung ok.
3. Reveal: Besitzer persönlich ok, `vault.reveal` bei Organisation ok, Mitglied ohne Recht
   `403`; jeder Abruf erzeugt Audit.
4. Sichtbarkeit als Tabelle: Server, Ordner mit Unterordner, Tag, `allServers`
   (persönlich/Organisation), keine Bindung, Konto-Key, Organisation verlassen.
5. `vault_list`-Antwort enthält keinen gespeicherten Wert (Prüfung über die serialisierte
   Antwort).
6. Freigabe: einmal, Sitzung, ablehnen, Timeout, kein Fenster; zweite Antwort `409`; Client bricht ab → Anfrage zurückgezogen; eine Freigabe nach mehr als 90 s füllt noch aus; ein `browser_evaluate` während der Wartezeit lässt das Ausfüllen mit `vault.session_tainted` scheitern; die Sperre nach `deny` gilt auch über einen neuen Transport.
7. Chromium-Reihe: Ausfüllen bei passendem Ursprung; Ablehnung bei fremdem Ursprung, fremdem iframe, Einbettung durch eine fremde Seite, Nicht-Passwortfeld, `via`-Sitzung, `persistent`-Sitzung und nach einem vorherigen `browser_evaluate` in einem inzwischen geschlossenen Popup desselben Kontexts.
8. Chromium-Reihe: Nach dem Ausfüllen ist `browser_evaluate` gesperrt, auch im Popup der Seite. Der Snapshot nach `browser_click` schwärzt das befüllte Feld auch nach dem Umschalten auf `type=text`. Ein `method=get`-Formular bringt das Passwort weder in `URL:` noch in `browser_list` noch ins Audit, auch nachdem ein `PATCH` mit Zieländerung die Werte des Eintrags gelöscht hat.
9. Einrichtungsbefehle quoten URL und Key mit Sonderzeichen korrekt.
10. Agenten-Key im Browser-Anbieter: `via` zu einem fremden Server abgelehnt, `browser_list`
    zeigt nur eigene Sitzungen, eine fremde `sessionId` antwortet wie unbekannt, auch bei `browser_fill_credential`.
11. Ein `PATCH` mit geändertem Ursprung löscht die gespeicherten Werte; Reveal, Freigabe und
    Einrichtung antworten in einer Impersonations-Sitzung mit `403`; `probe` nimmt einen
    `pending`-Key an und liefert die gesehene Adresse.
12. Chromium-Reihe: `browser_screenshot` nach „Passwort anzeigen“ auf dem befüllten Feld wird
    abgelehnt, ohne diesen Umschalter erlaubt.

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
<!-- design: manifest=docs/design/manifest.yaml design_rev=15 design_hash=sha256:423b56fc550d2cf0835685c78dd763c3c38bc80266bd4543e13641fe31bc3493 system=docs/design/design-system.md index=docs/design/mockups/index.html adapter=web screens=UI-AGENT-ACCESS,UI-API-KEYS,UI-DIRECT-CONNECT,UI-FILES,UI-SERVER-DIALOG,UI-SERVERS,UI-SHELL,UI-TMUX-DIALOG,UI-VAULT,UI-VAULT-APPROVAL,UI-VAULT-DIALOG,UI-VAULT-SETTINGS -->
<!-- Generiert aus docs/design/manifest.yaml. Nicht von Hand ändern —
     Änderungen hier werden beim nächsten mockingbird-Lauf überschrieben.
     Design ändern heißt Manifest ändern. -->

## UI Requirements

| ID | Element | Screen | Status | Fachlicher Anker |
|----|---------|--------|--------|------------------|
| UI-SHELL-LOGO | Outpost | UI-SHELL | required | Die Bildmarke, zugleich der Schalter, der die Leiste ein- und ausklappt. Vier Pfosten unterschiedlicher Höhe, der letzte in der Erfolgsfarbe. |
| UI-SHELL-NAV | Bereiche | UI-SHELL | required | Die Bereiche der Anwendung — Server, Monitoring, Snippets, Vault, Audit — und dazwischen die Aktion Browser. Ein Eintrag je Bereich, der aktive hervorgehoben; Browser ist kein Bereich, sondern öffnet unter Server einen neuen Browser-Tab und wird deshalb nie hervorgehoben. Browser nur, wenn Browser-Tabs aktiviert sind und das Konto das Recht dazu hat; Vault nur, wenn der Vault eingeschaltet ist und das Konto vault.use hat oder Mitglied einer Organisation ist; Audit nur mit dem Recht dafür. Nicht: server_entry, session. |
| UI-SHELL-ACCOUNT | Konto | UI-SHELL | required | Das eigene Konto am Fuß der Leiste. Öffnet ein Menü mit Einstellungen, Unterstützung und Abmelden. Nicht: server_entry, identity. |
| UI-SHELL-REVEAL | Seitenleiste einblenden | UI-SHELL | required | Der schmale Streifen am linken Rand, solange die Leiste eingeklappt ist. Mit Maus fährt sie beim Überfahren vorübergehend ein, ein Tipp oder Klick holt sie dauerhaft zurück. |
| UI-SHELL-MOBILE-NAV | Bereiche (schmaler Schirm) | UI-SHELL | required | Unter 768px ersetzt eine Leiste am unteren Rand die seitliche. Sie zeigt dieselben Einträge mit Beschriftung, Browser auch hier als Aktion ohne hervorgehobenen Zustand; ein Tipp auf den bereits offenen Bereich klappt dort die Serverliste auf. Nicht: server_entry, session. |
| UI-SERVERS-LIST | Server | UI-SERVERS | required | Die Verbindungsziele des Nutzers, gruppiert nach Ordner und Organisation, plus verknüpfte OneDrive-Konten. Nicht: session, tab, identity, snippet. |
| UI-SERVERS-SEARCH | Suche | UI-SERVERS | required | Filtert die Server-Liste nach Name, IP oder Tag, ohne die Gruppierung aufzulösen. |
| UI-SERVERS-LIST-MENU | Kontextmenü Server | UI-SERVERS | required | Zweitweg für Aktionen auf einem Eintrag — Verbinden, SFTP öffnen, Notizen, Bearbeiten, Duplizieren, Session beitreten, Agenten-Zugang… (nur SSH, nur bei eingeschaltetem Vault), Löschen. Port weiterleiten erscheint nur in der Desktop-App (Tauri), im Web-Build nie. Nicht: primary_navigation. |
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
| UI-FILES-ACTIONBAR | Aktionsleiste | UI-FILES | required | Bestand: Zurück, Vorwärts, Hoch, die Adresszeile, und rechts die Icon-Gruppe Suchen · Ansicht · Neu laden · Datei hochladen · Ordner hochladen · Neue Datei · Neuer Ordner. Diese Runde setzt genau ein Icon hinzu, den Stern, links neben der Lupe — die Reihenfolge der übrigen Icons bleibt unangetastet. |
| UI-FILES-ADDRESS | Adresszeile | UI-FILES | required | Der Pfad des gerade angezeigten Verzeichnisses als anklickbare Brotkrumen. Beim Öffnen einer Datei-Sitzung steht hier das Verzeichnis, in dem dieses Konto auf diesem Server mit diesem Benutzer zuletzt war. Gibt es keines, das Startverzeichnis des verbundenen Benutzers — für root also /root, nicht /; über FTP das PWD der Verbindung. Ist der gemerkte Pfad verschwunden oder nicht lesbar, der nächste vorhandene übergeordnete Ordner; im Grenzfall das Startverzeichnis, zuletzt /. Nicht: filesystem_root, home_directory, bookmark_path, transfer_destination. |
| UI-FILES-FAVORITES-TOGGLE | Favoriten | UI-FILES | required | Blendet die Favoritenleiste ein und aus — ein Stern in der Icon-Gruppe der Aktionsleiste, unmittelbar links neben der Lupe. Er merkt sich nichts und legt nichts an: er zeigt nur den Streifen. Solange der Streifen offen ist, ist der Stern gefüllt und trägt die Akzentfarbe, wie der Suchen-Button es im Bestand schon tut. Der Zustand gilt kontoweit, nicht je Sitzung, und überlebt das Neuladen. Taste Strg+B. Nicht: add_bookmark, mark_folder_as_favorite, search, filter, rating. |
| UI-FILES-FAVORITES | Favoriten | UI-FILES | required | Die von diesem Konto auf diesem Server gemerkten Verzeichnisse, als eine Zeile Chips mit Ordner-Icon und Ordnernamen; der volle Pfad steht im Tooltip. Ein Klick springt in den Ordner. Der Chip des gerade angezeigten Verzeichnisses ist in der Akzentfarbe hinterlegt. Die Zeile scrollt nicht und bricht nicht um; was nicht passt, geht ins Überlauf-Menü. Umsortiert wird per Ziehen oder mit Umschalt+Pfeil auf dem fokussierten Chip. Nicht: navigation_history, recent_directory, open_tab, server_entry, tag, saved_search. |
| UI-FILES-FAVORITES-OVERFLOW | Weitere Favoriten | UI-FILES | required | Ein Chevron am rechten Ende der Zeile, das die verdeckten Bookmarks als Menü öffnet — in derselben Reihenfolge wie im Balken, mit Ordner-Icon und Namen. Es erscheint nur, wenn wirklich etwas verdeckt ist, und verschwindet, sobald die Kachel breit genug wird. Nicht: more_actions_menu, chip_context_menu, pagination, sort_menu. |
| UI-FILES-FAVORITE-MENU | Favoriten-Kontextmenü | UI-FILES | required | Rechtsklick auf einen Chip: Umbenennen und Entfernen. Umbenennen ersetzt die Beschriftung des Chips an Ort und Stelle durch ein Eingabefeld, wie die Dateiliste es beim Umbenennen einer Datei schon tut. Entfernen fragt nicht nach — ein Bookmark ist mit einem Rechtsklick wieder angelegt, und der Ordner selbst bleibt unangetastet. Nicht: delete_folder, file_context_menu, overflow_menu. |
| UI-FILES-LIST | Dateien | UI-FILES | required | Bestand: der Inhalt des angezeigten Verzeichnisses — Ordner zuerst, dann Dateien, mit Name, Größe, Änderungsdatum und Rechten, in drei Ansichtsarten. Diese Runde ändert daran nichts außer den beiden Kontextmenü-Einträgen. Nicht: directory_bookmark, server_entry, transfer, search_result. |
| UI-FILES-LIST-MENU | Kontextmenü der Dateiliste | UI-FILES | required | Rechtsklick auf einen Eintrag. Bestand: Umbenennen, Vorschau und Bearbeiten (nur Dateien), Herunterladen, Pfad kopieren, Eigenschaften, Terminal hier öffnen (nur Ordner), Löschen. Neu und ausschließlich bei Ordnern: "Als Bookmark anlegen", das den angeklickten Ordner merkt — nicht das angezeigte Verzeichnis. Ist der Ordner schon gemerkt, steht an derselben Stelle "Bookmark entfernen". Nicht: empty_area_menu, favorite_context_menu, drop_menu. |
| UI-FILES-EMPTY-MENU | Kontextmenü der freien Fläche | UI-FILES | required | Rechtsklick auf die freie Fläche unter den Einträgen. Bestand: Neue Datei, Neuer Ordner, Trenner, Ordner herunterladen, Eigenschaften, Terminal hier öffnen. Neu: "Diesen Ordner als Bookmark", das das gerade angezeigte Verzeichnis merkt — nicht einen darin liegenden Ordner. Ist es schon gemerkt, steht dort "Bookmark entfernen". Nicht: item_context_menu, favorite_context_menu, drop_menu. |
| UI-SERVER-DIALOG-TABS | Details · Identität · Einstellungen | UI-SERVER-DIALOG | required | Die drei Abschnitte des Dialogs in fester Reihenfolge. |
| UI-SERVER-DIALOG-DETAILS | Details | UI-SERVER-DIALOG | required | Name, Icon, Server-IP, Port, Protokoll, Engine, MAC-Adresse und WoL-Broadcast des Servers. Nicht: identity. |
| UI-SERVER-DIALOG-IDENTITY | Identität | UI-SERVER-DIALOG | required | Zugangsdaten, mit denen dieser Server erreicht wird — persönliche und Organisations-Identitäten, verknüpfbar; Authentifizierung Passwort, SSH-Key oder beides. Nicht: server_entry, user_account. |
| UI-SERVER-DIALOG-SETTINGS | Einstellungen | UI-SERVER-DIALOG | required | Verhalten dieses Servers, nicht seine Stammdaten: Jump-Hosts, Startbefehl, tmux ein/aus, Monitoring, Wake-on-LAN, Terminal-Tastenverhalten (Backspace, Entf, Funktionstasten) und für RDP zusätzlich Sicherheit, Tastaturlayout, Anzeige, Audio und Leistung. Nicht: server_entry. |
| UI-SERVER-DIALOG-SAVE | Speichern | UI-SERVER-DIALOG | required | Legt den Server an bzw. speichert Änderungen und schließt den Dialog; Beschriftung „Erstellen" beim Anlegen, „Speichern" beim Bearbeiten. |
| UI-TMUX-DIALOG-SESSIONS | Sessions | UI-TMUX-DIALOG | required | Die tmux-Sessions des Servers — nicht Outposts eigene Tabs. Eine Zeile je Session: der Name in voller Länge, rechts die drei Aktionen (Fenster anzeigen, Umbenennen, Beenden), die über dem Zeilenende liegen und nur auf der Zeile erscheinen, auf der man ist. Die Fensterzahl steht nicht als Text da — sie ist im Fenster-Icon gezeichnet; der Name braucht den Platz. Nicht: tab, server_entry, window. |
| UI-TMUX-DIALOG-WINDOWS | Fenster | UI-TMUX-DIALOG | required | Die Fenster der gewählten Session als Raster, aktives Fenster markiert. Nicht: tmux_session, tab. |
| UI-TMUX-DIALOG-ATTACH | Beitreten | UI-TMUX-DIALOG | required | Hängt das Terminal an die gewählte Session und das gewählte Fenster. |
| UI-TMUX-DIALOG-NEW | Neue Session | UI-TMUX-DIALOG | required | Startet eine neue tmux-Session auf dem Server und hängt sich an. |
| UI-DIRECT-CONNECT-HOST | Host | UI-DIRECT-CONNECT | required | Zieladresse (Host oder IP) und Port für eine Einmalverbindung. |
| UI-DIRECT-CONNECT-AUTH | Authentifizierung | UI-DIRECT-CONNECT | required | Zugangsdaten nur für diese Verbindung — nicht gespeichert, keine Identität. Nicht: identity, server_entry. |
| UI-DIRECT-CONNECT-GO | Verbinden | UI-DIRECT-CONNECT | required | Öffnet eine Session-Tab mit dieser Verbindung und schließt den Dialog. |
| UI-VAULT-NEW | Neuer Eintrag | UI-VAULT | required | Öffnet den Eintrag-Dialog zum Anlegen. Nur sichtbar mit Recht vault.use oder vault.manage in mindestens einer Organisation. |
| UI-VAULT-SCOPE | Persönlich · Organisationen | UI-VAULT | required | Wechselt, wessen Einträge die Liste zeigt — die eigenen oder die einer Organisation. Ein Reiter je Besitzer. Nicht: server_folder, tag, item_type. |
| UI-VAULT-SEARCH | Suchen | UI-VAULT | required | Filtert die Liste nach Name, Benutzer, Host, Ursprung und Beschreibung. Durchsucht nie geheime Werte. |
| UI-VAULT-TYPES | Alle · Login · API-Key · SSH · Datenbank · Sonstiges | UI-VAULT | required | Filtert die Liste nach der Art der Zugangsdaten. Nicht: vault_owner, tag. |
| UI-VAULT-LIST | Einträge | UI-VAULT | required | Die Vault-Einträge des gewählten Besitzers — je Zeile Typ-Icon, Name, darunter Benutzer oder Host; ein Schild-Kennzeichen, wenn eine Freigabe nötig ist. Nie ein geheimer Wert. Nicht: identity, api_key, server_entry, snippet. |
| UI-VAULT-DETAIL | Eintrag | UI-VAULT | required | Kopf des gewählten Eintrags — Name, Typ, Besitzer, Beschreibung — mit Bearbeiten und Löschen (nur mit Verwaltungsrecht). Nicht: identity, server_entry. |
| UI-VAULT-DETAIL-ACTIONS | Bearbeiten · Löschen | UI-VAULT | required | Bearbeiten öffnet den Eintrag-Dialog; Löschen fragt im Bestätigungsdialog nach und entfernt den Eintrag samt Werten und Bindungen. Nur mit Verwaltungsrecht (Besitzer persönlicher Einträge, vault.manage bei Organisationen); ohne das Recht nicht sichtbar. Nicht: vault_secret. |
| UI-VAULT-DETAIL-FIELDS | Angaben | UI-VAULT | required | Die nicht geheimen Angaben des Eintrags je Typ — Login Benutzer und erlaubte Ursprünge, API-Key Hosts und Header, SSH Benutzer, Datenbank Engine, Host, Port, Datenbank, Benutzer. Nicht: vault_secret. |
| UI-VAULT-DETAIL-SECRET | Geheimer Wert | UI-VAULT | required | Je geheimem Feld eine Zeile mit genau zwölf Punkten, unabhängig von der Länge des Werts. Anzeigen und Kopieren nur für den Besitzer persönlicher Einträge oder mit vault.reveal, nie in einer Impersonations-Sitzung; sonst der Hinweis, dass der Wert nur für Agenten nutzbar ist. Ein angezeigter Wert verbirgt sich nach 30 Sekunden. Nicht: vault_item_fields, identity. |
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
| UI-AGENT-ACCESS-URL | Outpost-Adresse für diesen Server | UI-AGENT-ACCESS | required | Die Adresse, unter der dieser Server Outpost erreicht; daraus entstehen MCP-URL und Adressprüfung dieses Keys. Vorbelegt mit der Adresse der letzten Einrichtung auf diesem Server, sonst mit der Standardadresse aus den Einstellungen. Für Server außerhalb des LANs zum Beispiel die Domain über einen Reverse-Proxy. Nicht: browser_launcher_url, vault_binding. |
| UI-AGENT-ACCESS-IPBIND | Nur von der IP dieses Servers | UI-AGENT-ACCESS | required | Ob der Key nur Anfragen von der Adresse dieses Servers (plus den eingetragenen Adressbereichen) akzeptiert. Vorbelegt mit dem Standard aus Einstellungen › Vault; aus heißt von überall. Nicht: vault_binding, allowed_origin. |
| UI-AGENT-ACCESS-RESULT | Ergebnis | UI-AGENT-ACCESS | required | Je Agent das Ergebnis der Einrichtung — eingerichtet, oder der fertige Befehl zum Kopieren, wenn die automatische Einrichtung scheiterte (CLI fehlt, Exec-Fehler). Der Key ist nur hier und nur jetzt sichtbar; ein Key, der weder automatisch eingerichtet noch kopiert wurde, wird beim Schließen gelöscht. Nicht: agent_key, toast. |
| UI-VAULT-SETTINGS-KEY | Vault-Schlüssel | UI-VAULT-SETTINGS | required | Ob der Vault läuft — Schlüssel aktiv, fehlt (Vault aus) oder passt nicht zu den gespeicherten Daten (Vault aus). Bei fehlendem Schlüssel ein Satz, wie man VAULT_KEY setzt. Nicht: encryption_key, api_key. |
| UI-VAULT-SETTINGS-URL | Outpost-Adresse für Agenten | UI-VAULT-SETTINGS | required | Die Adresse, unter der Server Outpost erreichen; daraus entsteht die MCP-URL, die beim Einrichten eines Agenten eingetragen wird. Nicht: browser_launcher_url. |
| UI-VAULT-SETTINGS-IPBIND | IP-Bindung als Standard | UI-VAULT-SETTINGS | required | Ob neue Agenten-Keys standardmäßig nur von der IP ihres Servers gelten. Belegt den Schalter „Nur von der IP dieses Servers“ im Agenten-Zugang vor; dort lässt er sich je Server ändern. Aus für Umgebungen, in denen Outpost die Absenderadressen nicht sieht. Nicht: vault_binding, allowed_origin, proxy_trust_warning. |
| UI-VAULT-SETTINGS-PROXY | Hinweis Reverse-Proxy | UI-VAULT-SETTINGS | required | Warnt, wenn Outpost jedem X-Forwarded-For glaubt (TRUST_PROXY=true) — dann ist die IP-Bindung von Agenten-Keys wirkungslos. Sonst nicht sichtbar. Nicht: vault_key_status, agent_base_url. |
| UI-VAULT-SETTINGS-SAVE | Einstellungen speichern | UI-VAULT-SETTINGS | required | Speichert die Outpost-Adresse für Agenten, wie der Speichern-Knopf der Browser-Einstellungen. |
| UI-API-KEYS-LIST | API-Schlüssel | UI-API-KEYS | required | Die API-Keys des Kontos mit voller Kontoberechtigung — Name, Präfix, zuletzt genutzt, Ablauf; Anlegen und Löschen wie bisher. Nicht: agent_key. |
| UI-API-KEYS-AGENTS | Agenten-Schlüssel | UI-API-KEYS | required | Die Agenten-Keys des Kontos, gruppiert nach Server — Agent, zuletzt genutzt, IP-Bindung; je Server Bearbeiten (öffnet Agenten-Zugang) und je Key Entziehen. Agenten-Keys erreichen nur den MCP-Endpunkt. Nicht: api_key, vault_item. |
| UI-VAULT-APPROVAL-CARD | Freigabe angefordert | UI-VAULT-APPROVAL | required | Eine Karte unten rechts über jeder Seite, nicht modal: ein Agent will einen Vault-Eintrag nutzen. Zeigt Agent und Server, Eintrag und Ziel (Ursprung oder Host) und die verbleibende Zeit; Antworten Einmal, Für diese Sitzung, Ablehnen. Mehrere Anfragen stapeln sich, die älteste unten. Der Stapel liegt über Dialogen und Toasts. Eine abgelaufene Karte zeigt fünf Sekunden den Fehlerzustand und verschwindet; scheitert das Senden einer Antwort, bleibt die Karte stehen und ein Toast nennt den Grund. Nicht: notification, toast, error. |

Artboards: `docs/design/mockups/index.html` · Design-System: `docs/design/design-system.md`
<!-- mockingbird:design:end -->

<!-- preflight:security:begin -->
<!-- facts: network_surface=both has_accounts=yes auth_method=api-key
     has_privilege_levels=yes session_transport=bearer-header has_owned_data=yes
     is_multi_tenant=yes persistence=sql renders_html=yes accepts_uploads=yes
     handles_pii=yes -->

## Security Requirements

| ID | Maßnahme | Geltungsbereich | Status | Begründung |
|----|----------|-----------------|--------|------------|
| SEC-INPUT-01 | Input-Validierung per Whitelist | `fields` je Typ, `name`-Muster, CIDRs, `agentUrl`, Argumente der Vault-Werkzeuge | required | HTTP-API |
| SEC-ERR-01 | Fehlermeldungen ohne Stack-Traces und DB-Details | Vault-Werkzeuge, REST-Antworten, „nicht lesbar“ ohne Details | required | HTTP-API |
| SEC-SECRET-01 | Secrets außerhalb von Code und Repo | `VAULT_KEY` per Umgebung oder Docker-Secret; Werte nie in Log, Audit oder Antwort | required | immer |
| SEC-DEP-01 | Abhängigkeiten auf bekannte Schwachstellen prüfen | neue Abhängigkeiten und Client-Bausteine | required | immer |
| SEC-INJECT-01 | Fremde Eingaben nicht in Befehle oder Pfade bauen | Einrichtungsbefehle per Exec, Quoting in `server/lib/vault/provision.js` | required | immer |
| SEC-RATE-01 | Rate Limiting auf zustandsändernden Endpunkten | Reveal, Freigabe-Antwort, Agenten-Einrichtung, Vault-Werkzeuge | required | HTTP-API |
| SEC-RATE-02 | Brute-Force-Bremse am Login | Login | not-applicable | (2026-10-09) die Spec ändert den Login nicht; Agenten-Keys haben 256 Bit Entropie |
| SEC-SQLI-01 | Prepared Statements, keine String-Konkatenation | Sichtbarkeits-Abfragen, Bindungen, Agenten-Keys | required | SQL-Persistenz |
| SEC-XSS-01 | Kontextsensitives Output-Encoding | Vault-Seite, Freigabe-Karte, angezeigte Werte | required | React-Oberfläche |
| SEC-CSP-01 | Content Security Policy | gesamte Oberfläche; zuerst `Content-Security-Policy-Report-Only`, scharf nach Auswertung der Verstöße | required | React-Oberfläche; XSS erreicht über Reveal alle Werte |
| SEC-UPLOAD-01 | Upload-Prüfung | Dateimanager | not-applicable | (2026-10-09) der Vault nimmt keine Dateien an, SSH-Schlüssel kommen als Text |
| SEC-IDOR-01 | Objektbezogene Autorisierung bei jedem Zugriff über eine ID | Einträge, Werte, Freigaben, Agenten-Keys | required | Einträge gehören Konten oder Organisationen |
| SEC-TENANT-01 | Mandanten-Scoping in jeder Abfrage | Sichtbarkeit, Bindungen (nur Server und Ordner derselben Organisation), Freigaben, Reveal | required | Organisationen als Mandanten |
| SEC-RBAC-01 | Rollen- oder Rechtemodell | `vault.use`, `vault.manage`, `vault.reveal`, `settings.vault` | required | Berechtigungssystem |
| SEC-APIKEY-01 | API-Keys hoch entropisch, gehasht, widerrufbar, zeitkonstant verglichen | Agenten-Keys inkl. `pending` | required | Agenten-Keys |
| SEC-SESS-02 | Ablauf, Rotation, serverseitiger Widerruf | Agenten-Keys, Freigaben je MCP-Sitzung | required | Bearer-Header |
| SEC-TOKEN-01 | Token-Validierung, Lebensdauer, sichere Ablage, Widerruf | Bearer-Pfad in `authenticate`, IP-Bindung, Token im Query-String des Zustandsstroms (nicht in Logs) | required | Bearer-Header |
| SEC-PII-01 | Datensparsamkeit, Zugriffsprotokoll, Löschkonzept | Benutzernamen in Einträgen, Audit der Nutzung, Löschen von Einträgen | required | Login-Einträge und Audit enthalten Personenbezug |
<!-- preflight:security:end -->
