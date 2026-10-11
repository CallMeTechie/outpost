# Credentials Vault – Teilprojekt 2a: Tokens (vault_http, browser_fill_secret, Git-Proxy)

## Ziel

Claude Code und Codex auf einem Server nutzen API-Tokens aus dem Vault für drei Dinge, ohne den Token je zu sehen:

1. **APIs aufrufen** (`vault_http`): Outpost schickt die HTTP-Anfrage selbst und setzt den Token in den Header.
2. **Einen Token in ein Web-Formular eintragen** (`browser_fill_secret`) im Outpost-Browser, wie `browser_fill_credential` ein Passwort einträgt.
3. **Git auf private Repos** (Git-Proxy): Das Git auf dem Server spricht mit Outpost, Outpost setzt den Token gegenüber dem Git-Host ein. Der Token liegt nie auf dem Server.

Erfolg: Claude auf einem LAN-Server legt mit einem GitHub-PAT aus dem Vault ein Issue an, klont ein privates Repo, pusht einen Branch und trägt den PAT in ein Formular im Outpost-Browser ein. Der PAT taucht in keiner Antwort, keinem Snapshot, keiner Datei auf dem Server und keinem Audit-Eintrag auf. Lesende und schreibende Zugriffe gibst du getrennt frei.

**Umsetzungsreihenfolge.** (A) Vermittlungskern, Erweiterung der Freigaben, Schwärzung, neue Felder, `vault_http`; (B) `browser_fill_secret`, `fillAnywhere`; (C) Git-Proxy, Auth-Änderung, Einrichtung und Entziehen. B und C hängen nur von A ab und laufen parallel; gemeinsame Dateien sind `server/lib/vault/errors.js`, `server/lib/vault/mcpProvider.js` (`vault_list`) und die Locale-Dateien.

### Einordnung

Teilprojekt 2 des Vaults (siehe `docs/superpowers/specs/2026-10-09-vault-core-design.md`, „Einordnung“) ist in drei Specs geschnitten: **2a Tokens** (diese Spec), 2b `ssh_exec`, 2c `db_query`. 2a baut auf dem Kern aus Teilprojekt 1 auf: Einträge, Bindung an Server, Agenten-Keys mit IP-Bindung, MCP-Endpunkt, Freigabe-Karte, Audit, `vaultGuard`.

### Grenze des Modells

Wie in Teilprojekt 1 gibt kein Werkzeug einen Wert heraus. Was eine Antwort enthält, bestimmt der angefragte Dienst; Outpost schwärzt darin den Token und seine Varianten (Abschnitt „Schwärzung“), aber nicht andere Daten, die der Dienst mit diesem Token herausgibt — wer `api.github.com` lesen darf, liest, was GitHub diesem Token zeigt. Der Git-Key liegt in `~/.gitconfig` des entfernten Benutzers und ist vor dem Agenten nicht geheim; er taugt nur für den Git-Proxy, nur von der Adresse dieses Servers aus (IP-Bindung), nur mit Freigabe und nur für Einträge, die für diesen Server gelten.

Anfragen gehen vom Outpost-Server aus. Erreichbar ist, was Outpost erreicht; APIs, die nur auf dem localhost des Agenten-Servers lauschen, gehören nicht zu 2a.

Git-Antworten (Pack-Daten, `remote:`-Meldungen) laufen ungeschwärzt durch; Outpost schickt den Token dort nur im `Authorization`-Header an den Git-Host und gibt von dessen Antwort-Headern nur die Liste in „Ablauf“ weiter.

## Entscheidungen

| Thema | Entscheidung |
|---|---|
| Architektur | MCP-Werkzeuge `vault_http` und `browser_fill_secret`, dazu ein Git-Endpunkt `/api/vault/git/`. Alle drei laufen durch einen gemeinsamen Vermittlungskern (`server/lib/vault/broker.js`). Kein transparenter HTTPS-Proxy, keine CA auf dem Server. |
| Methoden | Je Eintrag „Nur lesen“ (`readOnly`): nur GET/HEAD bzw. Git fetch. Standard: alle Methoden. |
| Lesen/Schreiben | Schreibend sind POST, PUT, PATCH, DELETE, `git-receive-pack` (push) und jedes Eintragen im Browser. „Für diese Sitzung“ gilt je Eintrag und je Art getrennt: Lesen, Schreiben über API oder Git, Eintragen im Browser. |
| Eintragen im Browser | Je Eintrag „Darf im Browser eingetragen werden auf“ (`fillOrigins`). Leer heißt nirgends, außer der Schalter „Token auf jeder Seite eintragen erlauben“ (`vault_settings.fillAnywhere`) ist an; dann jede Seite, immer mit Freigabe, Sitzungsfreigabe nur für die eine Origin; Einträge einer Organisation dann nur für Mitglieder mit `vault.reveal`. |
| Git | Git-Proxy mit `insteadOf` und `extraHeader` in der globalen gitconfig; eigener Agenten-Key `git@<server>`. Kein Credential-Helper (der Token läge sonst im Git-Prozess auf dem Server). |
| Klartext-HTTP | Nur mit `allowHttp` je Eintrag; sonst nur `https:`. |
| Hosts | `hosts` des Eintrags gilt für `vault_http` und Git; exakter Abgleich, ohne Platzhalter, ohne Groß-/Kleinschreibung, mit optionalem Port. Ein Port in `hosts` gleicht nur URLs mit genau diesem Nicht-Standardport; `host:443` und `host:80` lehnt die Prüfung ab („leave out the default port“). |

## Datenmodell

### `vault_items.fields` (JSON, keine Spaltenänderung)

`api_key` bekommt zusätzlich (Joi in `server/validations/vault.js`, `FIELDS.api_key`):

| Feld | Typ | Standard | Bedeutung |
|---|---|---|---|
| `hosts` | Hostname oder `host:port`, 1–20 | (Bestand) | Erlaubte Hosts für `vault_http` und Git. Die Prüfung erlaubt künftig einen Port (`coolify.lan:8000`). |
| `readOnly` | boolean | `false` | Nur GET/HEAD, Git nur fetch. |
| `allowHttp` | boolean | `false` | `http:` erlaubt. |
| `git` | boolean | `false` | Der Git-Proxy darf den Eintrag nutzen. |
| `gitUsername` | string 1–64, `[A-Za-z0-9._@-]` | `"x-access-token"` | Benutzer neben dem Token bei Git-Basic-Auth. |
| `fillOrigins` | Origins wie `login.origins`, 0–20 | `[]` | Origins für `browser_fill_secret`. |

`generic` bekommt nur `fillOrigins` (0–20, Standard `[]`). Bestehende Einträge lesen sich mit den Standardwerten; kein Datenumbau.

### `vault_settings`

Migration `0049-add-vault-fill-anywhere.js`: `fillAnywhere` BOOLEAN NOT NULL, Standard `false` (Muster und Wiederholbarkeit wie 0048). `GET`/`PATCH /api/vault/settings` lesen und schreiben ihn (`updateVaultSettingsValidation` bekommt `fillAnywhere: Joi.boolean()`).

### `api_keys`

`agentType` bekommt den Wert `git` (`createAgentKeysValidation.agentTypes` erlaubt `claude`, `codex`, `git`). Keine neue Spalte.

## Vermittlungskern (`server/lib/vault/broker.js`)

`use({ ctx, itemRef, tool, access, target, check, act })` kapselt, was heute in `browser_fill_credential` (`server/lib/vault/mcpProvider.js`) steht:

1. Eintrag über `findVisibleItem(caller, itemRef)` laden (Bindung an den Server des Agenten-Keys, Organisation, `vault.use`).
2. `check(item)` — die Prüfungen des Werkzeugs (Typ, Host, Methode, Feld, Origin). Wirft `VaultError`.
3. Freigabe, wenn `item.approvalRequired` oder Impersonation: `approvals.requestApproval({ …, tool, access, target, scope })`.
4. Nach der Freigabe: Key noch gültig (`keyStillValid`), Eintrag neu laden, `check` erneut. Geänderte Hosts, `readOnly`, `git`, `fillOrigins` oder Ziel ergeben `vault.approval_stale` („changed while the approval was open; nothing was done“). Ausnahme `browser_fill_credential`: geänderte `origins` ergeben dort weiter `vault.origin_mismatch` mit der bisherigen Meldung (`mcpProvider.test.js`, „an origin is added to the entry“).
5. `secret = readSecret(item.id, field)`; `act(secret, item)` — nur hier ist der Wert im Speicher.

Bei den Browser-Werkzeugen läuft die Zielprüfung nach der Freigabe nicht getrennt von `act`: `act` ruft `assertFillableSession` und die Origin-/Feldprüfung innerhalb desselben `session.runAgent`-Aufrufs auf, in dem `readSecret` und das Eintragen laufen, wie heute in `fill`.
6. Audit `vault.use` (Erfolg) bzw. `vault.use_denied` mit Code (Ablehnung), wie heute; `lastUsedAt` per `silent: true`.

`browser_fill_credential` wird auf `use` umgestellt, ohne Verhaltensänderung außer den werkzeugneutralen Standardmeldungen (Abschnitt „Fehlercodes“); seine bestehenden Tests (`server/lib/vault/__tests__/`, `server/lib/browser/__tests__/vaultGuard.test.js`) bleiben unverändert grün. `field` ist `password` (login), `token` (api_key), `value` (generic).

### Freigabe (`server/lib/vault/approvals.js`)

- Eine Anfrage trägt zusätzlich `tool` (`vault_http`, `browser_fill_secret`, `browser_fill_credential`, `git`), `access` (`read` | `write`) und `target` (Abschnitte unten). Die Karte zeigt sie (`UI-VAULT-APPROVAL-CARD`, `UI-VAULT-APPROVAL-WRITE`).
- Sitzungsfreigaben gelten für (Sitzung, Eintrag, Umfang). Umfang = `access` (`read` | `write`) bei `vault_http` und Git; beim Eintragen im Browser (`browser_fill_secret`, `browser_fill_credential`) `fill`, bei „jeder Seite“ zusätzlich die Ziel-Origin (`fill|https://coolify.example.net`). Eine Sitzungsfreigabe fürs Eintragen gibt also keine API-Schreibzugriffe frei und umgekehrt. `browser_fill_credential` hat nur den Umfang `fill`; sein Verhalten bleibt gleich. `access` bleibt beim Eintragen `write` (Abzeichen „schreibt“). Eine Anfrage kann `allowSession: false` tragen (`browser_fill_secret` in ein Feld, das kein Passwortfeld ist); dann gibt es für sie keine Sitzungsfreigabe, weder eine bestehende noch eine neue.
- Sitzung = `transportId` der MCP-Verbindung (wie heute) oder `git:<keyId>` beim Git-Proxy. Eine Git-Sitzung endet nach 12 Stunden ohne Git-Anfrage dieses Keys (gemessen an der letzten Anfrage) und beim Entziehen des Keys. Offene Karten gelten wie heute je (Sitzung, Eintrag): ein zweiter Git-Vorgang desselben Keys mit demselben Eintrag (z. B. paralleler Clone eines anderen Repos auf demselben Host) endet, solange eine Karte offen ist, mit `vault.approval_pending`.
- Der Stempel einer Sitzungsfreigabe (`grantStamp`) enthält zusätzlich `hosts`, `readOnly`, `allowHttp`, `git`, `gitUsername`, `fillOrigins`; jede Änderung beendet die Freigabe.
- Unverändert: 120 s Laufzeit, 3 offene Karten je Agent, 60 s Sperre nach Ablehnen — sie gilt je (Agent, Eintrag) unabhängig von `access`: wer einen Schreibzugriff ablehnt, sperrt für 60 s auch das Lesen dieses Eintrags — bei Impersonation nur „Einmal“, `vault.approval_unavailable` ohne offenes Fenster.

### Schwärzung

`redactSecretText(text, variants)` in `server/lib/vault/redact.js` ersetzt jede Variante durch `••••` (längste zuerst). Varianten eines Tokens: der Token, `variantsOf(token)` aus `server/lib/browser/vaultGuard.js` (Prozent- und Formular-Kodierung; heute modulintern, wird für `redact.js` exportiert), der fertige Header-Wert (`headerTemplate` mit eingesetztem Token), bei Git `gitUsername:token` im Klartext und base64, `token` base64. Leere Varianten und solche unter 4 Zeichen werden nicht ersetzt (sonst schwärzt ein kurzer Token beliebige Antworttexte); Neu: `token` von `api_key` verlangt beim Speichern mindestens 4 Zeichen (`secretsOf` in `server/validations/vault.js` bekommt für `token` `min(4)`; heute gilt für alle geheimen Felder `min(1)`). Ein bestehender Eintrag mit kürzerem Token wird von `vault_http` und Git bei der Nutzung mit `vault.secret_too_short` abgelehnt, bevor etwas gesendet wird.

## `vault_http`

### Werkzeug

```
vault_http({ item, method, url, headers?, body? })
```

Beschreibung an den Agenten (englisch): Call an HTTP API with a vault API key. Outpost sends the request itself and sets the entry's header; you never see the token, and it is replaced by •••• wherever the response repeats it. Only the entry's hosts, https unless the entry allows http, GET/HEAD only for read-only entries. Writes (POST, PUT, PATCH, DELETE) need their own approval. Prefer this over curl or gh with a token.

### Prüfungen (`check`)

1. Typ `api_key`, sonst `vault.wrong_type`.
2. `url` absolut, ohne Zugangsdaten, höchstens 8 KB, Schema `http:` oder `https:`, sonst `vault.bad_url`; `http:` nur mit `allowHttp`, sonst `vault.http_not_allowed`.
3. `host[:port]` der URL (Port nur, wenn nicht Standard) steht in `hosts`, sonst `vault.host_not_allowed`.
4. `method` ∈ GET, HEAD, POST, PUT, PATCH, DELETE (`vault.bad_method`); bei `readOnly` nur GET/HEAD (`vault.read_only`).
5. `headers`: höchstens 30, Namen Token-Zeichen, Werte ohne CR/LF, zusammen höchstens 8 KB. Abgelehnt (`vault.header_not_allowed`): `headerName` des Eintrags, `Authorization`, `Cookie`, `Host`, `Content-Length`, `Transfer-Encoding`, `Connection`, die übrigen Hop-by-Hop-Header (`Keep-Alive`, `Upgrade`, `Expect`, `TE`, `Trailer`), `Range` und `If-Range` (ein Byte-Bereich der Antwort entginge der Schwärzung), `X-HTTP-Method-Override`, `X-Method-Override` und `X-HTTP-Method` (sie hebelten „Nur lesen“ aus), alles mit `Proxy-`. Ein `headers`, das kein Objekt ist, mehr als 30 Einträge, ungültige Namen oder Werte hat oder zusammen über 8 KB liegt, ergibt `vault.header_not_allowed` mit eigener Meldung (Abschnitt „Fehlercodes“).
6. `body`: String bis 1 MB; bei GET/HEAD nicht erlaubt (`vault.bad_body`). Dafür liest `/api/mcp` in `server/index.js` seinen Body selbst, nach `authenticate`: `app.use("/api/mcp", authenticate, express.json({ limit: "2mb" }), …)`, damit kein Unangemeldeter 2 MB geparst bekommt; der globale `express.json()` (Standard 100 KB) überspringt `/api/mcp` und alles darunter, ohne Groß-/Kleinschreibung.

`access` = `read` für GET/HEAD, sonst `write`. `target` = `METHOD host/path` ohne Query und Fragment, gekürzt auf 200 Zeichen.

### Ausführung (`act`)

- `fetch` von Node mit `redirect: "manual"`, 30 s Gesamtzeit (`AbortSignal.timeout`), ohne Proxy-Umgebung; Header des Agenten plus `headerName: headerTemplate` mit eingesetztem Token.
- Weiterleitungen (301, 302, 303, 307, 308) folgt Outpost höchstens 5-mal und nur, wenn die neue URL dieselbe Origin hat; 303 wird zu GET ohne Body, ebenso 301 und 302 nach POST; dabei entfallen auch die Header des Agenten `Content-Type`, `Content-Encoding`, `Content-Language` und `Content-Location` (ohne Groß-/Kleinschreibung). Eine Weiterleitung auf eine andere Origin wird nicht verfolgt und mit ihrem `location` an den Agenten gegeben; der Token geht nicht dorthin.
- Antwort: `status`, Header aus der Liste `content-type`, `content-length`, `location`, `link`, `etag`, `last-modified`, `retry-after`, `x-ratelimit-*`, `x-github-request-id` (nie `set-cookie`); Body bei Text (`text/*`, `*json*`, `*xml*`, `javascript`, `x-www-form-urlencoded`) als UTF-8 bis 256 KB. Ist der Body länger, kürzt Outpost auf 256 KB, entfernt am Ende jeden Rest, der Anfang einer Variante ist, schwärzt erst dann und hängt `[truncated after 262144 bytes]` an; sonst `[binary body, <type>, <bytes> bytes]`. Alles läuft durch `redactSecretText`.
- Ergebnis an den Agenten: Text `HTTP <status>\n<header>: <wert>\n…\n\n<body>`.
- Netzfehler: `vault.http_failed` mit der Art (Zeitüberschreitung, Verbindung, TLS), ohne URL-Query und ohne Token.

### Grenzen

60 Aufrufe pro Minute je Agenten-Key (Fenster wie `FILL_WINDOW_MS`), darüber `vault.rate_limited`, im Audit einmal je Fenster. Gleichzeitig höchstens 4 laufende Aufrufe je Key (`vault.busy`).

## `browser_fill_secret`

```
browser_fill_secret({ item, ref, sessionId? })
```

Beschreibung (englisch): Type the value of an API key or "other" entry into one field of a browser session, for example a token field in a web form. You never see the value: snapshots show ••••, browser_evaluate stays locked in this browser context afterwards, and screenshots stay locked while the value is visible in a field that is not a password field. The field's frame and all frames around it must be one of the entry's fill origins. Needs approval unless the entry says otherwise.

- Verfügbar wie `browser_fill_credential`: Vault an, `vault.use`, `connect.browser`.
- Typ `api_key` (Feld `token`) oder `generic` (Feld `value`), sonst `vault.wrong_type`.
- Ziel: `<input>` vom Typ `text`, `password`, `search`, `url` oder ohne Typ, oder `<textarea>`; sonst `vault.field_not_fillable`. Prüfung wie `checkFillTarget` in `server/lib/vault/fill.js`: Frame des Felds und alle umgebenden Frames haben eine Origin aus `fillOrigins` (`vault.origin_mismatch`). Leere `fillOrigins` und `fillAnywhere` aus: `vault.no_fill_origins`. Leer und `fillAnywhere` an: jede Origin, Freigabe immer (auch wenn `approvalRequired` aus ist), Umfang `fill|<origin>` — für persönliche Einträge, für Einträge einer Organisation nur, wenn das Konto hinter dem Agenten sie aufdecken darf (`canRevealItem`, `vault.reveal`); sonst `vault.no_fill_origins`. Grund: Auf einer Seite seiner Wahl liest der Aufrufer den Wert mit dem Skript der Seite. `vault_list` bietet `browser_fill_secret` für solche Einträge nicht an.
- Feld auf der Karte: Die Prüfung des Felds ermittelt im selben CDP-Aufruf, der den Feldtyp liefert, eine Bezeichnung (`aria-labelledby`, `aria-label`, `<label>`, `placeholder`, `name`, `id`, die erste nicht leere), mit zusammengezogenem Leerraum, geschwärzt wie andere Texte des Browser-Kontexts und auf 60 Zeichen gekürzt. Sie geht als `field` in die Freigabe-Anfrage und auf die Karte („Eintragen auf <origin> · Feld „<field>““), nicht ins Audit: Seiteninhalt ist kein Audit-Datum.
- Ist das Feld kein Passwortfeld (`fieldType` ≠ `password`), trägt die Anfrage `allowSession: false`: Die Karte zeigt kein „Für diese Sitzung“, `answerApproval` nimmt `session` serverseitig als `once` und speichert nichts, und eine bestehende Sitzungsfreigabe deckt die Anfrage nicht. Sonst deckte eine Freigabe jedes Textfeld der Origin, auch ein Kommentarfeld, über das der Wert veröffentlicht würde.
- `access` = `write`, `target` = Origin des Feld-Frames.
- Eintragen: über `typeInto` aus `server/lib/vault/fill.js` (Fokus, Feld leeren über `Runtime.callFunctionOn`, Fokus prüfen, Wert per `Input.insertText`, das selbst `input` auslöst). `vaultGuard.markFilled(contextKey, { backendNodeIds: [feld], secret, targetId })` läuft wie in `fillCredential` als `beforeInsert` unmittelbar vor `Input.insertText`, im selben synchronen Schritt wie die Taint-Prüfung — nie danach. Daraus folgen ohne neuen Code: Schwärzung in Snapshots und Fehlern, Sperre von `browser_evaluate`, Markier- und Kopiertasten, Mittelklick, und Screenshot-Sperre, solange das Feld kein Passwortfeld ist und der Frame nicht weiternavigiert (`assertScreenshotAllowed`).
- Der Wert wird erst in `act` gelesen (`broker.use` mit `lazySecret: true`), nach der zweiten Prüfung von Sitzung und Feld im selben `runAgent`-Aufruf; ist das Feld nach der Karte auf eine andere Origin gewandert, endet der Aufruf mit `vault.approval_stale`, ohne den Wert zu entschlüsseln.
- Ergebnis: `Filled the value of <item> into the field.`
- Rate: gemeinsam mit `browser_fill_credential` (`FILL_LIMIT` 20 pro Minute).

## Git-Proxy

### Endpunkt

`server/routes/vault/git.js`, eingehängt unter `/api/vault/git`. Der globale `express.json()` liest Git-Bodies nicht (Git sendet `application/x-git-*`); der Proxy liest den Request-Stream selbst. Erlaubt sind genau die Smart-HTTP-Pfade:

| Methode | Pfad | Dienst | Art |
|---|---|---|---|
| GET | `/api/vault/git/<host>/<repo>/info/refs?service=git-upload-pack` | fetch | read |
| POST | `/api/vault/git/<host>/<repo>/git-upload-pack` | fetch | read |
| GET | `/api/vault/git/<host>/<repo>/info/refs?service=git-receive-pack` | push | write |
| POST | `/api/vault/git/<host>/<repo>/git-receive-pack` | push | write |

`<host>` ist Hostname oder `host:port`; `<repo>` ist ein Pfad aus 1–8 Segmenten `[A-Za-z0-9._~-]` (ohne `..`), optional mit `.git`. Alles andere: 404 (kein Dumb-HTTP, kein LFS).

### Authentifizierung (`server/middlewares/auth.js`)

`rejectAgentKey` lässt Agenten-Keys künftig an zwei Stellen zu: `agentType` `claude`/`codex` nur an `/api/mcp`, `agentType` `git` nur unter `/api/vault/git/`. Sonst 403 wie heute. Bindung an den Server, IP-Bindung und `touchApiKey` gelten unverändert. Der Endpunkt verlangt `req.agent?.agentType === "git"` und den Vault an.

### Ablauf

1. Eintrag suchen: alle für diesen Key sichtbaren Einträge vom Typ `api_key` mit `git` an, deren `hosts` `<host>` enthält. Keiner: `vault.git_not_enabled`; mehrere: `vault.git_ambiguous` (Meldung nennt die Einträge). Der Eintrag ist damit nicht vom Agenten gewählt, sondern vom Host bestimmt.
2. `broker.use` mit `tool: "git"`, `access` aus der Tabelle, `target` = `Git · <host>/<repo ohne .git>`, Sitzung `git:<keyId>`. `readOnly` und `receive-pack`: `vault.read_only`.
3. Weiterleiten an `https://<host>/<repo>/<rest>?<query>` mit `Authorization: Basic base64(gitUsername:token)`, `Content-Type`, `Content-Length` (falls gesendet), `Accept`, `Content-Encoding`, `Git-Protocol` und `User-Agent` des Clients. Request-Body und Antwort werden gestreamt (`node:https`, kein Puffern, keine Größengrenze). Keine Weiterleitungen. 60 s, in denen in keiner Richtung Daten fließen, beendet die Verbindung. Upstream-Header zurück: `content-type`, `cache-control`, `expires`, `pragma`; nie `set-cookie`, `www-authenticate`. Antworten, die nicht `application/x-git-*` sind (Fehlerseiten des Hosts, Textmeldungen), puffert Outpost bis 256 KB und gibt sie geschwärzt weiter wie bei `vault_http`; Pack-Daten laufen unverändert durch.
4. Der Git-Host antwortet 401/403: Outpost gibt eine Fehlermeldung (unten) mit „the token was refused by <host>“ und auditiert `vault.use_denied` mit Code `vault.upstream_refused`.

Ein **Git-Vorgang** beginnt mit einer erfolgreichen `info/refs`-Anfrage und umfasst die POST-Anfragen desselben Keys an denselben Dienst (`upload-pack` | `receive-pack`) und dasselbe Repo. Er bleibt offen, solange eine seiner Anfragen läuft, und danach 60 s ab dem Ende der letzten (Antwort vollständig gesendet oder Verbindung beendet). Das Ablaufen des Fensters beendet keine laufende Anfrage; es entscheidet nur, ob ein neuer POST noch dazugehört. POSTs desselben Vorgangs dürfen gleichzeitig laufen und zählen einzeln zu den 4 gleichzeitigen Weiterleitungen. Prüfung und Freigabe (auch „Einmal“) laufen bei `info/refs`; der Vorgang speichert dabei `grantStamp(item)` und die Eintrags-ID. Ein POST des Vorgangs ruft `broker.use({ …, approved: vorgang })` auf: Schritt 3 (Freigabe) entfällt, Schritt 4 läuft — Key entzogen: `vault.item_unknown`; Stempel des neu geladenen Eintrags weicht ab oder `check` scheitert: `vault.approval_stale` bzw. der Code von `check`. Ein POST ohne offenen Vorgang: 403 `vault.git_no_operation`. Ein zweiter `receive-pack`-POST, während einer desselben Vorgangs läuft, wird abgelehnt (`vault.git_no_operation`). Lesevorgänge (`upload-pack`) haben keine Obergrenze, solange Anfragen im Fenster kommen; `docs/vault.md` nennt das. Ein `receive-pack`-Vorgang endet nach dem ersten POST, dessen Body mehr als die Flush-Zeile `0000` enthält (Gits leerer Probe-POST zählt nicht): „Einmal“ deckt genau einen Push, jeder weitere öffnet eine neue Karte, außer eine Sitzungsfreigabe gilt. Verbraucht ist der Push, sobald Pack-Daten an den Host gegangen sind, gleich was der Host antwortet. Wird ein POST eines Vorgangs abgelehnt, endet der Vorgang, sobald seine laufenden Anfragen beendet sind; Wiederholungen bekommen `vault.git_no_operation`. Audit: ein `vault.use` je Vorgang, geschrieben, wenn der Vorgang endet, `bytes` summiert über alle Anfragen; eine Ablehnung eines POST erzeugt ein eigenes `vault.use_denied`.

**Dauer eines Uploads.** Node bricht Requests, deren Body nicht innerhalb von `server.requestTimeout` (Standard 300 s) ankommt, mit 408 ab; je Request lässt sich das nicht aufheben (geprüft mit Node 22: `req.setTimeout(0)` und `req.socket.setTimeout(0)` wirken nicht). Deshalb setzt `server/index.js` für beide Listener (`app.listen` und den HTTPS-Server) `requestTimeout = 0`, und eine Middleware `server/middlewares/requestDeadline.js`, als erste nach `app.set("trust proxy", …)` eingehängt, startet je Request einen Timer von 300 s. Läuft er ab und ist `req.complete` noch `false`, antwortet sie mit 408 und `Connection: close`; sind die Header schon gesendet, zerstört sie den Socket. Den Stream liest sie nicht. Der Timer endet, sobald der Body vollständig angekommen ist; eine Antwort vor dem vollständigen Body (401, 404, 413 …) hebt die Frist nicht auf, weil Node den ungelesenen Rest sonst ohne Grenze weiterliest. WebSocket-Upgrades durchlaufen die Middleware über express-ws, sind aber sofort `complete` und bleiben unberührt; MCP-Aufrufe in der Freigabe-Wartezeit und lange Downloads ebenso, weil ihr Body vollständig ist. Die Frist gilt auch unter `/api/vault/git/`: erst wenn der Git-Router Key, Eintrag und Vorgang geprüft hat und die Weiterleitung beginnt, hebt er sie für diesen Request auf (`req.clearRequestDeadline()`) und setzt die 60-s-Leerlaufgrenze aus Schritt 3. Abgelehnte Git-Requests antworten mit `Connection: close` und zerstören den Socket nach dem Senden, damit ein ungelesener Body die Verbindung nicht offen hält. `headersTimeout` (60 s) bleibt unverändert.

### Fehler, die Git anzeigt

Für `info/refs` (der erste Schritt jedes Vorgangs) antwortet Outpost bei Ablehnung mit 200, `Content-Type: application/x-<dienst>-advertisement` und einem Pkt-Line-Paket `ERR vault: <Meldung> (<code>)`; Git zeigt `fatal: remote error: vault: …`. Für die POST-Pfade antwortet Outpost bei Ablehnung mit 403 und Text-Body. Meldungen sind englisch und enthalten nie den Token.

### Grenzen

30 Git-Vorgänge pro Minute je Git-Key (gezählt werden `info/refs`-Anfragen, also Vorgänge wie oben), darüber `vault.rate_limited`. Höchstens 4 gleichzeitige Weiterleitungen je Key (`vault.busy`).

### Einrichtung (`server/lib/vault/provision.js`, `server/controllers/agentKeys.js`)

Der Agenten-Zugang-Dialog bietet „Git“ als dritten Agenten. Er braucht kein CLI außer `git` (`command -v git` wie bei Claude/Codex; fehlt es: Ergebnis „git nicht gefunden“ mit Befehl zum Kopieren). Ablauf wie bei Claude/Codex: Key-Ablage per `keyDropCommand`, Adressprüfung per `probeCommand`, dann:

```
git config --file "$HOME/.gitconfig" --replace-all url."<base>/api/vault/git/<host>/".insteadOf "https://<host>/" || exit 1   # je Host
printf '[http "%s"]\n\textraHeader = "%s"\n' "<base>/api/vault/git/" "Authorization: Bearer <key>" >> "$HOME/.gitconfig"   # Shell-Builtin
chmod 600 "$HOME/.gitconfig" || exit 1
```

`--file "$HOME/.gitconfig"` statt `--global`, auch beim Entfernen und in der Prüfung: Git liest `~/.gitconfig` neben `~/.config/git/config` immer, `--global` schriebe aber in die XDG-Datei, wenn nur diese existiert.

- `<base>` = Agenten-Adresse dieses Keys ohne abschließenden Schrägstrich. `<host>` = Vereinigung der `hosts` aller für diesen Server sichtbaren `api_key`-Einträge mit `git` an, zum Zeitpunkt der Einrichtung; ohne solche Einträge: Ergebnis „Kein Eintrag mit „Für Git nutzen“ gilt für diesen Server.“ und kein Key.
- Vorher entfernt der Befehl eigene alte Zeilen: jede `url.*.insteadOf`, deren Abschnittsname `/api/vault/git/` enthält, und `http.*/api/vault/git/.extraHeader`. Andere `insteadOf`-Regeln bleiben.
- Werte gehen durch `shQuote`; der Key wird wie heute aus der Ablagedatei gelesen. Den Abschnitt mit `extraHeader` hängt das Shell-Builtin `printf` an `~/.gitconfig` an (Abschnittsname mit `\` und `"` maskiert, vorher ein fehlender Zeilenumbruch am Dateiende ergänzt), damit der Key nicht im argv von `git config` und so nicht in der Prozessliste steht; `git config --get-all` und `--unset-all` lesen und entfernen ihn wie einen von `git config` geschriebenen. Nur `claude mcp add` bekommt den Key weiter als Argument (`--header`), `docs/vault.md` nennt das.
- `server/controllers/agentKeys.js`: `setupAgent` und `manualCommand` haben einen Zweig für `git`, der statt `setupCommand`/`/api/mcp` ein neues `gitSetupCommand({ base, hosts, keyFile | key })` aus `provision.js` nutzt; `CLI_NAMES` enthält `git` für `findCliCommand`. Die Hosts ermittelt `createAgentKeys` vor dem Anlegen des Keys mit `visibleItems({ accountId, agent: { entryId } })`; ohne Treffer kein Key.
- Registrierungsprüfung und Entziehen: das modulinterne `registrationStateLines` in `provision.js` bekommt einen Zweig für `git`, wirksam über die Exporte `registrationCheckCommand` und `revokeCommands`. MATCH, wenn `git config --file "$HOME/.gitconfig" --get-all http.<base>/api/vault/git/.extraHeader` den Präfix des Keys enthält; OTHER bei anderem Key; sonst ABSENT. `revokeCommands` sucht für `git` kein CLI über `findCliScript`, sondern entfernt bei MATCH die Zeilen wie oben und meldet REMOVED.
- Kommen später neue Git-Hosts hinzu, richtet man den Zugang erneut ein; `docs/vault.md` sagt das.

### Hinweis SSH-Remotes

Remotes der Form `git@github.com:o/r.git` laufen nicht über den Proxy. Der Dialog zeigt den Hinweis `UI-AGENT-ACCESS-GIT-NOTE`, sobald Git ausgewählt ist; `docs/vault.md` beschreibt `git remote set-url origin https://github.com/o/r.git`.

## `vault_list`

`usableBy` nennt je Eintrag die Werkzeuge: `login` → `browser_fill_credential`; `api_key` → `vault_http`, dazu `git` bei `git`, dazu `browser_fill_secret` bei nicht leerem `fillOrigins` oder `fillAnywhere` (bei Einträgen einer Organisation ohne `fillOrigins` nur mit `vault.reveal`, Abschnitt `browser_fill_secret`); `generic` → `browser_fill_secret` unter derselben Bedingung. `api_key` zeigt zusätzlich `readOnly`, `allowHttp`, `git`, `fillOrigins`; nie `gitUsername` (nicht geheim, aber für den Agenten bedeutungslos).

## Oberfläche

Der Design-Block unten listet alle Elemente der sechs betroffenen Screens. Neu oder geändert sind nur die 13 Elemente aus Revision 16 (`touched` im Manifest-Changelog); die übrigen sind Bestand aus Teilprojekt 1 und bleiben unverändert.

Nach Manifest Revision 16 (Design-Block unten), Regeln in `docs/design/design-system.md` „Neu in Runde 16“, Umsetzungsanleitungen in `docs/design/guides/`:

- **Eintrag-Dialog:** Gruppe „Nutzung durch Agenten“ mit `UI-VAULT-DIALOG-READONLY`, `-HTTP`, `-GIT` (mit „Git-Benutzername“), `-FILL`; die ersten drei nur bei API-Key, FILL bei API-Key und Sonstiges.
- **Detail:** `UI-VAULT-DETAIL-USAGE`.
- **Freigabe-Karte:** Werkzeug und Ziel, Abzeichen „schreibt“ bei `access: write`. `VAULT_APPROVALS` liefert je Anfrage zusätzlich `tool`, `access`, `target`.
- **Einstellungen › Vault:** `UI-VAULT-SETTINGS-FILLANY`, gespeichert über `UI-VAULT-SETTINGS-SAVE`.
- **Agenten-Zugang:** Haken „Git“, Ergebnis für Git, `UI-AGENT-ACCESS-GIT-NOTE`; „Git“ in den Key-Listen (`UI-AGENT-ACCESS-KEYS`, `UI-API-KEYS-AGENTS`).
- Texte in `client/public/assets/locales/de_DE.json` und `en.json`.

## REST-Endpunkte

| Endpunkt | Änderung |
|---|---|
| `POST /api/vault/items`, `PATCH /api/vault/items/:id` | neue Felder in `fields` |
| `GET`/`PATCH /api/vault/settings` | `fillAnywhere` |
| `POST /api/vault/agent-keys` | `agentTypes` darf `git` enthalten |
| `GET /api/vault/agent-keys` | Keys mit `agentType: "git"` |
| `GET`/`POST /api/vault/git/…` | neu (oben) |
| `POST /api/mcp` | Werkzeuge `vault_http`, `browser_fill_secret` |

## Audit

Keine neue Aktion. `vault.use` und `vault.use_denied` tragen in `details` zusätzlich `tool` und `access`; `vault_http`: `method`, `host`, `path` (ohne Query), `status`, `bytes`; `browser_fill_secret`: `origin`, `fieldType`; Git: `host`, `repo`, `service` (`fetch` | `push`), `bytes` (Summe beider Richtungen über alle Anfragen des Vorgangs, geschrieben beim Ende des Vorgangs). Nie Header-Werte, Bodies oder Query-Strings.

## Fehlercodes

Neue Codes in `server/lib/vault/errors.js` (Meldung englisch, ohne Token, ohne Query): `vault.approval_stale` "The entry changed while the approval was open; nothing was done. Call again so the user approves the entry as it is now." · `vault.http_not_allowed` "This entry only allows https." · `vault.bad_url` "url must be an absolute http(s) URL without credentials, at most 8 KB." · `vault.host_not_allowed` "This host is not one of the entry's hosts (vault_list shows them)." · `vault.bad_method` "method must be GET, HEAD, POST, PUT, PATCH or DELETE." · `vault.read_only` "This entry is read-only: only GET/HEAD and git fetch." · `vault.header_not_allowed` "This header cannot be set; Outpost sets authentication, Host, Cookie, Content-Length, Transfer-Encoding, Connection and Proxy-* itself.", bei fehlerhaftem `headers` "headers must be an object of at most 30 headers with token names and single-line string values, at most 8 KB together." · `vault.bad_body` "body must be a string of at most 1 MB and is not allowed with GET or HEAD." · `vault.http_failed` "The request failed (<kind>); nothing was returned." · `vault.busy` "Too many calls of this key are running; wait for one to finish." · `vault.field_not_fillable` "ref must point to a text, password, search or url input, or a textarea." · `vault.no_fill_origins` "This entry may not be filled in the browser; ask the user to add fill origins." · `vault.git_not_enabled` "No vault entry with Git enabled covers <host> on this server." · `vault.git_ambiguous` "Several vault entries with Git enabled cover <host> on this server (<entries>); ask the user to restrict one." · `vault.git_no_operation` "This request does not belong to a running git operation; run the git command again." · `vault.upstream_refused` "The token was refused by <host>; ask the user to check the entry." · `vault.secret_too_short` "The token of this entry is shorter than 4 characters; ask the user to replace it in Outpost.". Die Standardmeldungen von `vault.wrong_type`, `vault.rate_limited`, `vault.no_secret`, `vault.approval_timeout`, `vault.approval_pending` ("An approval request for this entry is already open for this caller. Wait for the user to answer it before calling again."), `vault.client_gone` und `vault.item_unreadable` werden werkzeugneutral („nothing was done“). Auch `browser_fill_credential` zeigt diese neutralen Texte, weil `approvals.js`, `secrets.js` und `mcpProvider.js` sie ohne eigene Meldung werfen; nur seine expliziten Meldungen (`wrong_type`, `item_unknown`, `origin_mismatch`, `bad_username_field`) bleiben. Kein Test prüft die Standardtexte.

## Fehler- und Randfälle

- Token im Eintrag leer oder unlesbar: `vault.no_secret` bzw. `vault.item_unreadable` (wie heute).
- Eintrag während der offenen Karte geändert oder Key entzogen: nichts wird gesendet oder eingetragen (`vault.approval_stale` bzw. `vault.item_unknown`).
- Upstream liefert die Antwort langsam: 30 s gelten für den ganzen `vault_http`-Aufruf ohne die Wartezeit der Freigabe.
- Git-Push großer Repos: Streaming ohne Größen- und Zeitgrenze (Abschnitt „Dauer eines Uploads“); nur 60 s, in denen in keiner Richtung Daten fließen, beenden die Verbindung. Abbruch des Clients bricht die Weiterleitung ab, das Audit zählt die bis dahin übertragenen Bytes.
- Ein Eintrag mit `git` und `readOnly`: clone/fetch gehen, push endet mit `ERR vault: This entry is read-only: only GET/HEAD and git fetch. (vault.read_only)`.
- Der Git-Host leitet um (z. B. umbenanntes Repo): Outpost folgt nicht; Git meldet den Status, der Agent nutzt die neue URL.
- Zwei Einträge mit `git` für `github.com`, die für denselben Server gelten: `vault.git_ambiguous`. Abhilfe: Bindung eines Eintrags einschränken.

## Tests

Ein Test je Verhalten, möglichst über echte Nahtstellen:

1. **`vault_http` gegen einen lokalen HTTP-Server** (`server/lib/vault/__tests__/vaultHttp.test.js`): Header wird eingesetzt; der Server wiederholt Token und Header-Wert in Body, `location` und einem Header, der Agent sieht `••••`; fremder Host → `vault.host_not_allowed`; `readOnly` + POST → `vault.read_only`; `http:` ohne `allowHttp` → `vault.http_not_allowed`; Weiterleitung auf andere Origin kommt als 3xx zurück und der zweite Server sieht keinen Token; Body über 256 KB wird gekürzt; verbotener Header → `vault.header_not_allowed`.
2. **Freigaben** (`approvals`-Test erweitert): Sitzungsfreigabe für `read` deckt `write` nicht; Änderung von `hosts` beendet die Freigabe; Key entzogen bei offener Karte → nichts gesendet; „jede Seite“: Freigabe für Origin A deckt Origin B nicht; Git-Sitzung endet nach 12 h ohne Anfrage.
3. **`browser_fill_secret`** mit dem CDP-Double aus `vaultGuard.test.js`: passende Origin → eingetragen, Snapshot `••••`; Frame mit fremder Origin, `<select>`, leere `fillOrigins` → abgelehnt; `text`-Feld → Screenshot gesperrt; `fillAnywhere` → Freigabe trotz `approvalRequired: false`.
4. **Git-Proxy Ende-zu-Ende** (`server/lib/vault/__tests__/gitProxy.test.js`): ein lokaler `git http-backend` hinter Basic-Auth spielt den Git-Host; ein Test-Home mit `insteadOf`/`extraHeader` wie von der Einrichtung geschrieben; echtes `git clone`, `git fetch`, `git push` über Outpost gelingen; mit `readOnly` scheitert der Push mit `remote error: vault:`; im Test-Home, in der gitconfig und in den Ausgaben von Git steht der Token nicht; ein nicht erlaubter Pfad (`/objects/…`) → 404; ein `git push` mit „Einmal“ zeigt genau eine Karte, ein zweiter Push danach eine neue; ein POST ohne vorheriges `info/refs` → 403 `vault.git_no_operation`.
5. **Einrichtung und Entziehen Git** (`agentKeysRoute.test.js`, Exec-Double): Befehle mit `insteadOf` je Host und `extraHeader`, fremde `insteadOf` bleiben; Entziehen entfernt nur eigene Zeilen; ohne Git-Eintrag kein Key.
6. **Auth**: Git-Key an `/api/mcp` → 403, Claude-Key an `/api/vault/git/` → 403.
6a. **Upload-Dauer** (`requestDeadline`): ein langsamer Body an einer beliebigen Route endet nach der Frist mit 408, ein geprüfter Push unter `/api/vault/git/` nicht (Frist im Test verkürzt); ein unauthentifizierter, tröpfelnder POST unter `/api/vault/git/` endet ebenfalls nach der Frist.
7. **`browser_fill_credential` nach dem Umbau auf den Broker**: bestehende Tests unverändert grün.
8. **Client**: Felder im Eintrag-Dialog je Typ, Abzeichen „schreibt“ auf der Karte, Git-Haken samt Hinweis im Agenten-Zugang, Schalter in den Einstellungen.
9. **Handtest** mit echtem GitHub-PAT: Issue anlegen (`vault_http`), clone/push über den Proxy, PAT in ein Formular im Outpost-Browser.

## Betrieb und Doku

`docs/vault.md` bekommt Abschnitte zu `vault_http`, `browser_fill_secret` und Git (Einrichtung, SSH-Remotes umstellen, neue Hosts → neu einrichten, Grenzen; hinter einem Reverse-Proxy brauchen `/api/vault/git/` und `/api/mcp` eine ausreichende Body-Grenze, Git zusätzlich ungepufferte Requests, nginx: `client_max_body_size 0; proxy_request_buffering off;`), die neuen Felder und `fillAnywhere`. Die Werkzeugtabelle in Abschnitt 9 und die Fehlercodes werden ergänzt.

<!-- mockingbird:design:begin -->
<!-- design: manifest=docs/design/manifest.yaml design_rev=17 design_hash=sha256:49524403d840637d69957ba4511dd393ba480ca08c1abda9425f7894f9213d8e system=docs/design/design-system.md index=docs/design/mockups/index.html adapter=web screens=UI-VAULT,UI-VAULT-DIALOG,UI-VAULT-APPROVAL,UI-VAULT-SETTINGS,UI-AGENT-ACCESS,UI-API-KEYS consumes=UI-SHELL-ACCOUNT,UI-SHELL-MOBILE-NAV,UI-SHELL-NAV -->
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
| UI-VAULT-DETAIL-SECRET | Geheimer Wert | UI-VAULT | required | Je geheimem Feld eine Zeile mit genau zwölf Punkten, unabhängig von der Länge des Werts. Anzeigen und Kopieren nur für den Besitzer persönlicher Einträge oder mit vault.reveal, nie in einer Impersonations-Sitzung; sonst der Hinweis, dass der Wert nur für Agenten nutzbar ist. Ein angezeigter Wert verbirgt sich nach 30 Sekunden. Nicht: vault_item_fields, identity. |
| UI-VAULT-DETAIL-SCOPE | Gilt für | UI-VAULT | required | Für welche Server Agenten diesen Eintrag sehen — einzelne Server, Ordner mit Unterordnern, Tags oder alle Server. Nicht: vault_owner, permission. |
| UI-VAULT-DETAIL-POLICY | Freigabe erforderlich | UI-VAULT | required | Ob jede Nutzung durch einen Agenten bestätigt werden muss, und wann der Eintrag zuletzt genutzt wurde. Nicht: permission, vault_binding. |
| UI-VAULT-DETAIL-USAGE | Nutzung durch Agenten | UI-VAULT | required | Was Agenten mit diesem Wert tun dürfen: nur lesen, auch über http, für Git (mit Benutzername), Eintragen im Browser auf den genannten Origins. Ausgeschaltetes fehlt als Zeile. Nur bei API-Key und Sonstiges sichtbar. Nicht: vault_binding, approval_policy, permission. |
| UI-VAULT-DIALOG-TYPE | Typ | UI-VAULT-DIALOG | required | Art der Zugangsdaten — Login, API-Key, SSH, Datenbank, Sonstiges. Nur beim Anlegen wählbar, danach fest. Nicht: vault_owner. |
| UI-VAULT-DIALOG-OWNER | Besitzer | UI-VAULT-DIALOG | required | Wem der Eintrag gehört — dem eigenen Konto oder einer Organisation. Nur beim Anlegen wählbar. Nicht: vault_binding, server_folder. |
| UI-VAULT-DIALOG-FIELDS | Angaben | UI-VAULT-DIALOG | required | Name, Beschreibung und die nicht geheimen Angaben des gewählten Typs. Der Name ist die Kennung für Agenten, Kleinbuchstaben, Ziffern, Punkt, Bindestrich und Unterstrich. Nicht: vault_secret. |
| UI-VAULT-DIALOG-SECRET | Geheimer Wert | UI-VAULT-DIALOG | required | Eingabe der geheimen Felder des Typs. Beim Bearbeiten leer mit dem Hinweis, dass ein Wert gespeichert ist und leer lassen ihn behält. Nicht: vault_item_fields. |
| UI-VAULT-DIALOG-SCOPE | Gilt für | UI-VAULT-DIALOG | required | Auswahl, auf welchen Servern Agenten den Eintrag sehen — Server, Ordner (mit Unterordnern), Tags nur bei persönlichen Einträgen, oder Alle Server. Standard keine Auswahl. Nicht: vault_owner, permission. |
| UI-VAULT-DIALOG-APPROVAL | Freigabe erforderlich | UI-VAULT-DIALOG | required | Jede Nutzung durch einen Agenten muss im Outpost-Fenster bestätigt werden. Standard an. |
| UI-VAULT-DIALOG-READONLY | Nur lesen | UI-VAULT-DIALOG | required | Agenten dürfen mit diesem Token nur lesen — vault_http nur GET und HEAD, Git nur clone, fetch und pull; schreibende Aufrufe und git push werden abgelehnt. Nur bei API-Key. Standard aus. Nicht: approval_policy, permission. |
| UI-VAULT-DIALOG-HTTP | Unverschlüsseltes HTTP erlauben | UI-VAULT-DIALOG | required | Ob vault_http den Token auch über http:// statt nur https:// schicken darf, etwa an Dienste im LAN. Nur bei API-Key. Standard aus. Nicht: allowed_origin, approval_policy. |
| UI-VAULT-DIALOG-GIT | Für Git nutzen | UI-VAULT-DIALOG | required | Ob der Git-Proxy von Outpost diesen Token gegenüber den Hosts des Eintrags einsetzen darf (clone, fetch, push über https). Ist er an, erscheint das Feld „Git-Benutzername“ (Standard x-access-token für GitHub, oauth2 für GitLab). Nur bei API-Key. Standard aus. Nicht: ssh_key, identity. |
| UI-VAULT-DIALOG-FILL | Darf im Browser eingetragen werden auf | UI-VAULT-DIALOG | required | Die Origins (scheme://host[:port]), auf denen browser_fill_secret den Wert in ein Formularfeld eintragen darf. Leer heißt: kein Eintragen im Browser — außer „Token auf jeder Seite eintragen erlauben“ ist in den Einstellungen an. Für API-Key und Sonstiges. Nicht: api_host, vault_binding. |
| UI-VAULT-DIALOG-SAVE | Speichern | UI-VAULT-DIALOG | required | Legt den Eintrag an bzw. speichert Änderungen und schließt den Dialog; Beschriftung Erstellen beim Anlegen. |
| UI-AGENT-ACCESS-KEYS | Agenten auf diesem Server | UI-AGENT-ACCESS | required | Die Agenten-Keys dieses Servers — Agent, angelegt, zuletzt genutzt, IP-Bindung — je mit Entziehen. Entziehen widerruft den Key und entfernt die Registrierung auf dem Server. Nicht: api_key, vault_item, identity. |
| UI-AGENT-ACCESS-SETUP | Einrichten | UI-AGENT-ACCESS | required | Welche Agenten eingerichtet werden (Claude Code, Codex, Git) und welche zusätzlichen Adressbereiche (CIDR) ihr Key neben der IP dieses Servers akzeptiert. Git richtet in der globalen gitconfig des entfernten Benutzers den Git-Proxy von Outpost ein. Nicht: api_key, vault_binding. |
| UI-AGENT-ACCESS-URL | Outpost-Adresse für diesen Server | UI-AGENT-ACCESS | required | Die Adresse, unter der dieser Server Outpost erreicht; daraus entstehen MCP-URL und Adressprüfung dieses Keys. Vorbelegt mit der Adresse der letzten Einrichtung auf diesem Server, sonst mit der Standardadresse aus den Einstellungen. Für Server außerhalb des LANs zum Beispiel die Domain über einen Reverse-Proxy. Nicht: browser_launcher_url, vault_binding. |
| UI-AGENT-ACCESS-IPBIND | Nur von der IP dieses Servers | UI-AGENT-ACCESS | required | Ob der Key nur Anfragen von der Adresse dieses Servers (plus den eingetragenen Adressbereichen) akzeptiert. Vorbelegt mit dem Standard aus Einstellungen › Vault; aus heißt von überall. Nicht: vault_binding, allowed_origin. |
| UI-AGENT-ACCESS-RESULT | Ergebnis | UI-AGENT-ACCESS | required | Je Agent das Ergebnis der Einrichtung — eingerichtet, oder der fertige Befehl zum Kopieren, wenn die automatische Einrichtung scheiterte (CLI fehlt, Exec-Fehler). Der Key ist nur hier und nur jetzt sichtbar; ein Key, der weder automatisch eingerichtet noch kopiert wurde, wird beim Schließen gelöscht. Nicht: agent_key, toast. |
| UI-AGENT-ACCESS-GIT-NOTE | Hinweis Git über SSH | UI-AGENT-ACCESS | required | Steht im Agenten-Zugang, sobald Git ausgewählt ist — Remotes über SSH (git@github.com:…) laufen nicht über den Vault und müssen auf https umgestellt werden. Nicht: error, agent_setup_result. |
| UI-VAULT-SETTINGS-KEY | Vault-Schlüssel | UI-VAULT-SETTINGS | required | Ob der Vault läuft — Schlüssel aktiv, fehlt (Vault aus) oder passt nicht zu den gespeicherten Daten (Vault aus). Bei fehlendem Schlüssel ein Satz, wie man VAULT_KEY setzt. Nicht: encryption_key, api_key. |
| UI-VAULT-SETTINGS-URL | Outpost-Adresse für Agenten | UI-VAULT-SETTINGS | required | Die Adresse, unter der Server Outpost erreichen; daraus entsteht die MCP-URL, die beim Einrichten eines Agenten eingetragen wird. Nicht: browser_launcher_url. |
| UI-VAULT-SETTINGS-IPBIND | IP-Bindung als Standard | UI-VAULT-SETTINGS | required | Ob neue Agenten-Keys standardmäßig nur von der IP ihres Servers gelten. Belegt den Schalter „Nur von der IP dieses Servers“ im Agenten-Zugang vor; dort lässt er sich je Server ändern. Aus für Umgebungen, in denen Outpost die Absenderadressen nicht sieht. Nicht: vault_binding, allowed_origin, proxy_trust_warning. |
| UI-VAULT-SETTINGS-FILLANY | Token auf jeder Seite eintragen erlauben | UI-VAULT-SETTINGS | required | Ob browser_fill_secret einen Wert ohne eigene Origin-Liste auf jeder Seite eintragen darf — dann immer mit Freigabe, und eine Sitzungsfreigabe gilt nur für die eine Origin, die auf der Karte stand. Standard aus. Nicht: fill_origin, approval_policy. |
| UI-VAULT-SETTINGS-PROXY | Hinweis Reverse-Proxy | UI-VAULT-SETTINGS | required | Warnt, wenn Outpost jedem X-Forwarded-For glaubt (TRUST_PROXY=true) — dann ist die IP-Bindung von Agenten-Keys wirkungslos. Sonst nicht sichtbar. Nicht: vault_key_status, agent_base_url. |
| UI-VAULT-SETTINGS-SAVE | Einstellungen speichern | UI-VAULT-SETTINGS | required | Speichert die Outpost-Adresse für Agenten, den Standard der IP-Bindung und „Token auf jeder Seite eintragen erlauben“, wie der Speichern-Knopf der Browser-Einstellungen. |
| UI-API-KEYS-LIST | API-Schlüssel | UI-API-KEYS | required | Die API-Keys des Kontos mit voller Kontoberechtigung — Name, Präfix, zuletzt genutzt, Ablauf; Anlegen und Löschen wie bisher. Nicht: agent_key. |
| UI-API-KEYS-AGENTS | Agenten-Schlüssel | UI-API-KEYS | required | Die Agenten-Keys des Kontos, gruppiert nach Server — Agent, zuletzt genutzt, IP-Bindung; je Server Bearbeiten (öffnet Agenten-Zugang) und je Key Entziehen. Agenten-Keys erreichen nur den MCP-Endpunkt, Git-Keys nur den Git-Proxy. Nicht: api_key, vault_item. |
| UI-VAULT-APPROVAL-CARD | Freigabe angefordert | UI-VAULT-APPROVAL | required | Eine Karte unten rechts über jeder Seite, nicht modal: ein Agent will einen Vault-Eintrag nutzen. Zeigt Agent und Server, Eintrag, Werkzeug und Ziel (Ursprung beim Eintragen, Methode mit Host und Pfad bei vault_http, Git mit Host und Repo) und die verbleibende Zeit; Antworten Einmal, Für diese Sitzung, Ablehnen. „Für diese Sitzung“ gilt getrennt für lesende und schreibende Zugriffe. Mehrere Anfragen stapeln sich, die älteste unten. Der Stapel liegt über Dialogen und Toasts. Eine abgelaufene Karte zeigt fünf Sekunden den Fehlerzustand und verschwindet; scheitert das Senden einer Antwort, bleibt die Karte stehen und ein Toast nennt den Grund. Nicht: notification, toast, error. |
| UI-VAULT-APPROVAL-WRITE | schreibt | UI-VAULT-APPROVAL | required | Abzeichen in der Kopfzeile der Freigabe-Karte, wenn der Zugriff etwas verändert; bei lesenden Zugriffen fehlt es. Eine Sitzungsfreigabe für Lesen gibt Schreiben nicht frei. Nicht: error, warning_toast. |

**Übernommene Elemente** (hier nicht zu bauen, nur zu verwenden):
- `UI-SHELL-ACCOUNT` — Konto
- `UI-SHELL-MOBILE-NAV` — Bereiche (schmaler Schirm)
- `UI-SHELL-NAV` — Bereiche

Artboards: `docs/design/mockups/index.html` · Design-System: `docs/design/design-system.md`
<!-- mockingbird:design:end -->

<!-- preflight:security:begin -->
<!-- facts: network_surface=both has_accounts=yes auth_method=api-key
     has_privilege_levels=yes session_transport=bearer-header has_owned_data=yes
     is_multi_tenant=yes persistence=sql renders_html=yes accepts_uploads=no
     handles_pii=yes -->

## Security Requirements

| ID | Maßnahme | Geltungsbereich | Status | Begründung |
|----|----------|-----------------|--------|------------|
| SEC-INPUT-01 | Input-Validierung per Whitelist | Argumente von `vault_http` und `browser_fill_secret`, Git-Pfade, neue `fields`, `fillAnywhere` | required | HTTP-API |
| SEC-ERR-01 | Fehlermeldungen ohne Stack-Traces und DB-Details | Werkzeugfehler, Git-`ERR`-Meldungen, Netzfehler ohne Query und Token | required | HTTP-API |
| SEC-SECRET-01 | Secrets außerhalb von Code und Repo | Token, Header-Wert und Basic-Auth nie in Log, Audit oder Antwort; Schwärzung der Antworten | required | immer |
| SEC-DEP-01 | Abhängigkeiten auf bekannte Schwachstellen prüfen | keine neue Abhängigkeit geplant (Node `fetch`, `node:https`); neue nur nach Prüfung | required | immer |
| SEC-INJECT-01 | Fremde Eingaben nicht in Befehle oder Pfade bauen | gitconfig-Befehle über `shQuote` in `server/lib/vault/provision.js`, Upstream-URL nur aus geprüftem Host und Repo-Pfad | required | immer |
| SEC-RATE-01 | Rate Limiting auf zustandsändernden Endpunkten | `vault_http` 60/min, Git 30/min, Fills 20/min, gleichzeitige Aufrufe je Key | required | HTTP-API |
| SEC-RATE-02 | Brute-Force-Bremse am Login | Login | not-applicable | (2026-10-10) 2a ändert den Login nicht; Agenten- und Git-Keys haben 256 Bit Entropie |
| SEC-SQLI-01 | Prepared Statements, keine String-Konkatenation | Suche der Git-Einträge, Einstellungen | required | SQL-Persistenz |
| SEC-XSS-01 | Kontextsensitives Output-Encoding | Freigabe-Karte mit Ziel aus Agenten-Eingabe, Detailansicht | required | React-Oberfläche |
| SEC-CSP-01 | Content Security Policy | Bestand (Report-Only, Issue #16); 2a fügt keine Quellen hinzu | required | React-Oberfläche |
| SEC-IDOR-01 | Objektbezogene Autorisierung bei jedem Zugriff über eine ID | Eintrag über `findVisibleItem`, Git-Eintrag nur aus sichtbaren Einträgen | required | Einträge gehören Konten oder Organisationen |
| SEC-TENANT-01 | Mandanten-Scoping in jeder Abfrage | Organisations-Einträge nur für aktive Mitglieder, Git-Suche je Server | required | Organisationen als Mandanten |
| SEC-RBAC-01 | Rollen- oder Rechtemodell | `vault.use`, `connect.browser`, Agententyp `git` nur am Git-Proxy | required | Berechtigungssystem |
| SEC-APIKEY-01 | API-Keys hoch entropisch, gehasht, widerrufbar, zeitkonstant verglichen | Git-Keys wie Agenten-Keys | required | Agenten-Keys |
| SEC-SESS-02 | Ablauf, Rotation, serverseitiger Widerruf | Git-Sitzung 12 h, Freigaben enden bei Änderung oder Widerruf | required | Bearer-Header |
| SEC-TOKEN-01 | Token-Validierung, Lebensdauer, sichere Ablage, Widerruf | Git-Key in `~/.gitconfig` (Modus 600), `extraHeader` nur gegenüber Outpost | required | Bearer-Header |
| SEC-PII-01 | Datensparsamkeit, Zugriffsprotokoll, Löschkonzept | Audit ohne Query, Bodies und Header-Werte | required | Audit der Nutzung mit Personenbezug |
<!-- preflight:security:end -->
