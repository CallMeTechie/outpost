# Credentials Vault – Teilprojekt 2a: Tokens — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Code und Codex nutzen API-Tokens aus dem Vault, ohne sie zu sehen: `vault_http` ruft APIs mit eingesetztem Header auf, `browser_fill_secret` trägt einen Token in ein Formularfeld im Outpost-Browser ein, und ein Git-Proxy unter `/api/vault/git/` lässt Git auf dem Server private Repos klonen und pushen, ohne dass der Token den Server erreicht — mit getrennten Freigaben für Lesen und Schreiben.

**Architecture:** Ein gemeinsamer Vermittlungskern `server/lib/vault/broker.js` übernimmt Laden, Prüfen, Freigabe, Neu-Prüfen, Lesen des Werts, Ausführen und Audit; `browser_fill_credential` wird darauf umgestellt. Freigaben (`approvals.js`) gelten je (Sitzung, Eintrag, Umfang) mit `tool`/`access`/`target`; Git-Sitzungen heißen `git:<keyId>`. `vault_http` und `browser_fill_secret` sind MCP-Werkzeuge im Vault-Anbieter; der Git-Proxy ist ein eigener Router mit Git-Vorgängen als Einheit der Freigabe und gestreamter Weiterleitung. Agenten-Keys mit `agentType: "git"` dürfen nur den Git-Proxy nutzen; die Einrichtung schreibt `insteadOf`/`extraHeader` in `~/.gitconfig`.

**Tech Stack:** Node.js ≥ 22 (Express 5, Sequelize, Joi, `node:test`, globales `fetch`, `node:https`), Chromium über CDP, React 19 + Vite, vitest/jsdom/Testing Library (`*.test.jsx`), lucide-react, `git` (Tests: `git http-backend`).

**Spec:** `docs/superpowers/specs/2026-10-10-vault-tokens-design.md` (inkl. mockingbird-Block Manifest-Revision 17 und preflight-Sicherheitsblock). Die Spec ist maßgeblich; dieser Plan argumentiert aus ihr. Abweichungen stehen unter „Abweichungen und Ergänzungen zur Spec“. Grundlage: `docs/superpowers/specs/2026-10-09-vault-core-design.md` (Teilprojekt 1, umgesetzt).

**Design:** `docs/design/manifest.yaml` (rev 17) — Design-System: `docs/design/design-system.md` („Neu in Runde 16“) — Artboards: `docs/design/mockups/index.html`

**Design Scope:** UI-VAULT, UI-VAULT-DIALOG, UI-VAULT-APPROVAL, UI-VAULT-SETTINGS, UI-AGENT-ACCESS, UI-API-KEYS — zu bauen sind nur die 13 Elemente aus `touched` von Revision 16 (Revision 17 ergänzt bei UI-VAULT-DETAIL-USAGE den Zustand `disabled`) (UI-VAULT-DIALOG-READONLY, -HTTP, -GIT, -FILL, UI-VAULT-DETAIL-USAGE, UI-VAULT-APPROVAL-CARD (geändert), UI-VAULT-APPROVAL-WRITE, UI-VAULT-SETTINGS-FILLANY, UI-AGENT-ACCESS-SETUP (geändert), -RESULT (geändert), -KEYS (geändert), -GIT-NOTE, UI-API-KEYS-AGENTS (geändert)); alle übrigen Elemente dieser Screens sind Bestand aus Teilprojekt 1 und bleiben unverändert.

## Global Constraints

- Design-Quelle: `docs/design/manifest.yaml` (rev 17). Bei Konflikt zwischen Plan-Text und Manifest gilt das Manifest; melde den Konflikt, statt ihn still aufzulösen.
- Jedes gebaute UI-Element trägt seine Manifest-ID im Code: Web `data-ui-id="UI-…"`, andere Medien nach `adapters:` im Manifest. Ohne ID ist das Element nicht prüfbar.
- Design-Tokens ausschließlich aus `docs/design/mockups/tokens.css` bzw. `docs/design/design-system.md`. Keine neuen Farben, Abstände, Radien oder Schriftgrößen.
- Sichtbare Texte (Labels, Leer-, Lade- und Fehlerzustände) wörtlich aus dem Manifest (`label`, `states[].copy`). Keine eigenen Formulierungen.
- Jeder im Manifest deklarierte Zustand eines Elements wird gebaut, nicht nur `default`.
- Umsetzungsanleitungen je Screen: `docs/design/guides/ui-vault-dialog.md`, `ui-vault.md`, `ui-vault-approval.md`, `ui-vault-settings.md`, `ui-agent-access.md`, `ui-api-keys.md` (Abschnitte „neu in Rev. 16“).
- Kein geheimer Wert (Token, Header-Wert, Basic-Auth-String, Git-Key nach seiner Ablage) erscheint je in einer Werkzeug-Antwort an einen Agenten, in einem Log, im Audit-Log, in einer Fehlermeldung oder in einer Listen-Antwort der REST-API. Antworten von `vault_http` und Text-Antworten des Git-Proxys laufen durch `redactSecretText`; Pack-Daten laufen ungeschwärzt durch (Spec „Grenze des Modells“).
- Nur `https:` für `vault_http`, außer `fields.allowHttp`; Git immer `https:` zum Git-Host. Weiterleitungen: `vault_http` nur gleiche Origin, höchstens 5; Git nie.
- Freigabe: Umfang `read` | `write` bei `vault_http` und Git, `fill` beim Eintragen im Browser (beide Fill-Werkzeuge), bei „jeder Seite“ `fill|<origin>` — Sitzungsfreigaben gelten je Umfang, eine fürs Eintragen gibt kein API-Schreiben frei; Sitzungen `transportId` (MCP) oder `git:<keyId>` (12 h Leerlauf); Sperre nach Ablehnen 60 s je (Agent, Eintrag) unabhängig vom Umfang; „Einmal“ deckt bei Git genau einen Vorgang, bei `receive-pack` genau einen Push.
- Grenzen: `vault_http` 60/min und 4 gleichzeitig je Key; Git 30 Vorgänge/min und 4 gleichzeitige Weiterleitungen je Key; Fills (Passwort und Secret zusammen) 20/min; `vault_http`-Body 1 MB, Antwort-Body 256 KB, 30 s; Git ohne Größen- und Zeitgrenze, 60 s ohne Daten in beiden Richtungen beendet.
- Fehlercodes und Meldungen exakt wie Spec „Fehlercodes“ (englisch, ohne Token, ohne Query).
- Sicherheitsanforderungen aus dem preflight-Block der Spec gelten für jeden Task in ihrem Geltungsbereich, insbesondere SEC-INJECT-01 (Befehle nur über `server/lib/vault/provision.js`/`shQuote`; Upstream-URL nur aus geprüftem Host und Repo-Pfad), SEC-SECRET-01, SEC-IDOR-01/-TENANT-01 (Einträge nur über `findVisibleItem`/`visibleItems`), SEC-RATE-01, SEC-TOKEN-01 (`~/.gitconfig` Modus 600, `extraHeader` nur für die Outpost-URL), SEC-PII-01 (Audit ohne Query, Bodies, Header-Werte).
- Keine neuen Abhängigkeiten.
- Code-Kommentare: fast keine — nur nicht offensichtliches Warum, Fallstricke, externe Constraints. Bestehende Kommentardichte einer Datei wird nicht erhöht.
- Tests: ein Test je Verhalten; Integration über die Naht vor Mocks; keine Tests für Weiterreichung, Konstanten, Getter, Framework-Zusagen, Logs. Je Task nur die betroffenen Tests, volle Suite einmal am Phasenende.
- Server-Tests unter `server/lib/**/__tests__/*.test.js` mit `node:test` (CommonJS); Module werden vor dem Laden über `require.cache` ersetzt (Muster `server/lib/vault/__tests__/agentKeysRoute.test.js`), DB mit In-Memory-SQLite. Client: `*.test.jsx` mit vitest (`globals:false`), `renderWithProviders`, `createRequestDouble`; jeder neue `t()`-Schlüssel muss in `client/public/assets/locales/en.json` stehen.
- Texte: neue Schlüssel in `en.json` und `de_DE.json` (andere Sprachen fallen auf `en` zurück); nur Task 9 ändert die Locale-Dateien.
- Commits: deutsche Betreffzeile im Stil des Repos („Vault: …“), **keine** `Co-Authored-By`-/KI-Zeilen (ein Commit-Hook lehnt sie ab).

## Review Focus

1. **Eine API antwortet mit einer Weiterleitung auf einen anderen Host (z. B. Download-Link auf S3).** Erwartet: Outpost folgt nicht, gibt Status und `location` zurück, der zweite Host sieht keinen Token. → Test in Task 4.
2. **Der 256-KB-Schnitt einer langen JSON-Antwort fällt mitten in einen dort wiederholten Token.** Erwartet: Kein Anfang des Tokens bleibt stehen. → Test in Task 3 (`truncateAndRedact`).
3. **`git clone` eines großen Repos mit Protokoll v2: mehrere POSTs, einer streamt länger als 60 s.** Erwartet: Eine Karte, der Vorgang bleibt offen, solange eine Anfrage läuft; der folgende POST gehört noch dazu. → Test in Task 7 (verkürzte Fenster).
4. **Der Nutzer ändert die Hosts eines Eintrags, während eine Git-Karte oder eine `vault_http`-Karte offen ist.** Erwartet: Nichts wird gesendet, `vault.approval_stale`. → Tests in Task 3 (Broker) und Task 7 (POST eines Vorgangs nach Änderung).
5. **Ein Token-Feld ist eine `<textarea>` in einem iframe einer erlaubten Origin, umgeben von einer fremden Seite.** Erwartet: `vault.origin_mismatch`, nichts eingetragen. → Test in Task 5.

---

## Abweichungen und Ergänzungen zur Spec

Beim Lesen des Codes gefunden; im Plan so umgesetzt, beim Review bitte bestätigen:

1. **Werkzeug-Handler als eigene Module.** `vault_http` und `browser_fill_secret` liegen in `server/lib/vault/tools/http.js` und `server/lib/vault/tools/fillSecret.js`; `mcpProvider.js` bekommt in Task 3 eine Tabelle `TOOLS` (Name → `{ def, handler, needsBrowser }`), in die Task 4 und Task 5 je einen Eintrag aufnehmen. So berühren die parallelen Tasks 4 und 5 `mcpProvider.js` nur mit je einer Zeile.
2. **`variantsOf` zieht nach `server/lib/vault/redact.js`** und wird von dort sowohl von `vaultGuard.js` als auch vom Broker benutzt (statt aus `vaultGuard` exportiert); eine Quelle der Wahrheit für Varianten, keine Abhängigkeit der Vault-Kernlogik von der Browser-Bibliothek.
3. **Git-Sitzungen leben in `approvals.js`**, nicht im Git-Router: `gitSessionId(keyId)` liefert die Sitzungs-ID `git:<keyId>`, ein 12-h-Leerlauf-Ablauf gilt nur für IDs mit diesem Präfix, `touchSession(id)` setzt die Uhr. `StateBroadcaster.js` braucht keine Änderung, die Payload kommt aus `listOpenApprovals`.
4. **Meldungen mit Platzhaltern** (`<kind>`, `<host>`, `<entries>`) liegen als Vorlage in `VaultErrorMessage`; Task 4 und Task 7 ersetzen den Platzhalter beim Werfen (`new VaultError(code, VaultErrorMessage[code].replace("<host>", host))`).
5. **Bestehende Tests mit Ein-Zeichen-Tokens** (`"t"`) werden in Task 1 auf `"ghp_test"` umgestellt (Mindestlänge 4). Hosts bleiben gespeichert, wie eingegeben (`targetOf` in `server/controllers/vaultItems.js` vergleicht exakt und löschte sonst beim Speichern eines Bestandseintrags mit Großbuchstaben dessen Token); Task 4, 7 und 8 vergleichen ohne Groß-/Kleinschreibung.
6. **Design-Quellen angeglichen (Revision 17):** die Gruppe „Nutzung durch Agenten“ steht im Eintrag-Dialog nach „Freigabe erforderlich“, die Git-Zeile der Detailansicht lautet „Git · Benutzername x-access-token“; Guide, Design-System und Manifest-Beispiel sind nachgezogen.
7. **Texte:** die endgültige Liste der 33 neuen Schlüssel steht in Task 9; sie ersetzt die Aufzählung unter „Schnittstellen“ Task 9. `successGit` und `gitNote` enthalten `<mono>`-Tags und werden mit `Trans` gerendert.

10. **Weiterleitungen bei `vault_http` wie `fetch`:** 303 sowie 301/302 auf POST werden zu GET ohne Body; 307/308 behalten Methode und Body. Sonst schickte Outpost einen POST-Body ein zweites Mal an einen Pfad, der nicht auf der Karte stand.
8. **Bestandstests mit geänderter Schnittstelle:** `approvals.test.js` (Aufrufe mit Umfang, Kartenschlüssel um `tool`/`access`/`target`) und der Test „without connect.browser …“ in `mcpProvider.test.js` (Werkzeugliste um `vault_http`, `browser_fill_secret`, in Task 3) ändern sich; das Verhalten von `browser_fill_credential` bleibt bis auf werkzeugneutrale Standardmeldungen und das Audit von Drossel-Ablehnungen einmal je Werkzeug und Minute.
9. **Entscheidungen aus dem Plan-Review (vom Nutzer):** Sitzungsfreigaben für Schreiben gelten je Werkzeugart (`write` für API/Git, `fill` fürs Eintragen); „Sonstiges“ ohne Origins zeigt in der Detailansicht „Nur von Hand nutzbar — kein Eintragen im Browser“ (Rev. 17); Git-Lesevorgänge haben keine Obergrenze. Der Plan ergänzt außerdem: `Content-Length` wird an den Git-Host weitergereicht, ein zweiter gleichzeitiger `receive-pack`-POST wird abgelehnt, die Upload-Frist endet erst mit vollständigem Body. Die Spec ist entsprechend nachgezogen.

## Dateistruktur und Parallelgruppen

| Datei | Verantwortung | Task |
|---|---|---|
| `server/validations/vault.js` | neue `fields` je Typ, `host:port`, `token` min 4, `fillAnywhere` | 1 |
| `server/migrations/0049-add-vault-fill-anywhere.js`, `server/models/VaultSettings.js`, `server/controllers/vaultSettings.js` | `fillAnywhere` | 1 |
| `server/lib/vault/errors.js` | neue Codes, neutrale Standardmeldungen | 1 |
| `server/lib/vault/approvals.js` | Umfang, `tool`/`access`/`target`, Git-Sitzung, Stempel | 2 |
| `server/lib/vault/redact.js` (neu), `server/lib/browser/vaultGuard.js` | Varianten, Schwärzung, Kürzen | 3 |
| `server/lib/vault/broker.js` (neu), `server/lib/vault/mcpProvider.js`, `server/lib/vault/tools/http.js` und `tools/fillSecret.js` (Platzhalter) | Vermittlungskern, Umbau `browser_fill_credential`, Werkzeug-Tabelle mit beiden neuen Werkzeugen, `vault_list` | 3 |
| `server/lib/vault/tools/http.js` (ersetzt den Platzhalter), `server/index.js` (nur `/api/mcp`-Parser) | `vault_http` | 4 |
| `server/lib/vault/tools/fillSecret.js` (ersetzt den Platzhalter), `server/lib/vault/fill.js` | `browser_fill_secret` | 5 |
| `server/middlewares/auth.js`, `server/middlewares/requestDeadline.js` (neu), `server/index.js` (Listener, Middleware) | Git-Keys nur am Git-Proxy, Upload-Frist | 6 |
| `server/routes/vault/git.js` (neu), `server/lib/vault/gitProxy.js` (neu), `server/routes/vault/index.js` | Git-Proxy | 7 |
| `server/lib/vault/provision.js`, `server/lib/vault/gitHosts.js` (neu), `server/controllers/agentKeys.js`, `server/validations/vaultAgentKeys.js` | Einrichtung/Entziehen Git, gemeinsamer Host-Abgleich | 8 |
| `client/public/assets/locales/en.json`, `de_DE.json` | alle neuen Texte | 9 |
| `client/src/pages/Vault/components/VaultItemDialog/*`, `VaultDetail/*`, `client/src/pages/Vault/vaultTypes.js` | Eintrag-Dialog, Detail | 10 |
| `client/src/common/components/VaultApprovalCard/*`, `client/src/pages/Settings/pages/Vault/*` | Freigabe-Karte, Einstellungen | 11 |
| `client/src/pages/Servers/components/AgentAccessDialog/*`, `client/src/pages/Settings/pages/Account/components/AgentKeysSection/*` | Agenten-Zugang, Agenten-Keys | 12 |
| `docs/vault.md` | Doku | 13 |

**Wellen** (Tasks einer Welle teilen keine Dateien und laufen parallel, je in eigenem Worktree):

- **Welle A:** Task 1, Task 2, Task 6, Task 8, Task 9
- **Welle B:** Task 3, Task 10, Task 11, Task 12
- **Welle C:** Task 4, Task 5, Task 7
- **Welle D:** Task 13

Welle C teilt keine Dateien: Task 3 legt beide Werkzeug-Module als Platzhalter an und trägt sie in `TOOLS` und in die Werkzeuglisten von `mcpProvider.test.js` ein; Task 4 und Task 5 ersetzen nur ihr eigenes Modul. `server/index.js` ändern Task 4 (Welle C) und Task 6 (Welle A) — verschiedene Wellen.

## Schnittstellen (verbindlich für alle Tasks)

**Task 1 → alle**
- `FIELDS.api_key` (Joi, `server/validations/vault.js`): `{ hosts: (hostname | "host:port", Port ≠ 80/443)[1..20], headerName = "Authorization", headerTemplate = "Bearer {{secret}}", readOnly = false, allowHttp = false, git = false, gitUsername = "x-access-token" (/^[A-Za-z0-9._@-]{1,64}$/), fillOrigins = [] (origin[0..20], wie login.origins) }`; `FIELDS.generic`: `{ fillOrigins = [] }`. `secretsOf("api_key").token` `min(4)`.
- `vault_settings.fillAnywhere` (BOOLEAN, Standard `false`); `getVaultSettings()` → `{ keyStatus, agentUrl, ipBindingDefault, fillAnywhere }`; `updateVaultSettings({ agentUrl?, ipBindingDefault?, fillAnywhere? })`.
- `VaultErrorCode` neu: `APPROVAL_STALE: "vault.approval_stale"`, `HTTP_NOT_ALLOWED`, `BAD_URL`, `HOST_NOT_ALLOWED`, `BAD_METHOD`, `READ_ONLY`, `HEADER_NOT_ALLOWED`, `BAD_BODY`, `HTTP_FAILED`, `BUSY`, `FIELD_NOT_FILLABLE`, `NO_FILL_ORIGINS`, `GIT_NOT_ENABLED`, `GIT_AMBIGUOUS`, `GIT_NO_OPERATION`, `UPSTREAM_REFUSED`, `SECRET_TOO_SHORT` (Werte `vault.<snake_case>`), Meldungen aus Spec „Fehlercodes“; neutrale Standardmeldungen für `WRONG_TYPE`, `RATE_LIMITED`, `NO_SECRET`, `APPROVAL_TIMEOUT`, `APPROVAL_PENDING`, `CLIENT_GONE`, `ITEM_UNREADABLE`.

**Task 2 → 3, 7, 11**
- Umfänge: `read`, `write` (API/Git), `fill` (Eintragen), `fill|<origin>` (jede Seite). `requestApproval({ accountId, keyId, transportId, agentType, entryName, impersonated, item, target, tool, access, scope = access, signal })` → `"once" | "session"`; `hasSessionApproval(transportId, item, scope)`; Sitzungsfreigabe gespeichert unter `(transportId, item.id, scope)`.
- `grantStamp(item)` enthält `updatedAt`, `origins`, `hosts`, `readOnly`, `allowHttp`, `git`, `gitUsername`, `fillOrigins` (sortiert, JSON); exportiert.
- `gitSessionId(keyId)` → `"git:<keyId>"`; `touchSession(id)` (lässt eine seit 12 h ruhende Git-Sitzung erst verfallen, dann setzt es die Uhr); Git-Sitzungen (Präfix `git:`) verlieren ihre Freigaben 12 h nach dem letzten `touchSession`; `forgetSession(id)` (Umbenennung von `forgetTransport`, alter Name bleibt als Alias).
- `listOpenApprovals(accountId)` liefert je Anfrage zusätzlich `tool`, `access`, `target` (Payload von `VAULT_APPROVALS`).

**Task 3 → 4, 5, 7**
- `server/lib/vault/redact.js`: `variantsOf(secret)` (bisher in `vaultGuard`), `secretVariants({ token, headerValue = null, gitUsername = null })` → `string[]` (Token, `variantsOf(token)`, Header-Wert, `gitUsername:token` und dessen base64, `token` base64; leer und < 4 Zeichen entfernt; längste zuerst), `redactSecretText(text, variants)` → `string`, `truncateAndRedact(text, limitBytes, variants)` → `{ text, truncated }` (kürzt auf `limitBytes` UTF-8, entfernt am Ende jeden Rest, der Anfang einer Variante ist, schwärzt, hängt bei Kürzung `[truncated after <limit> bytes]` an).
- `server/lib/vault/broker.js`: `use({ ctx, itemRef, tool, access, target, scope = access, field, check, act, approved = null, precheck = null, stale, deferUse = false, auditExtra = {} })` → `Promise<{ result, approval, item }>` (mit `deferUse: true` zusätzlich `recordUse`); `check(item, { phase: "before" | "after", approving })` wirft `VaultError`; `act(secret, item)` ist das Einzige, das den Wert bekommt; `approved = { itemId, stamp }` überspringt die Freigabe (Git-Vorgang), prüft aber Key, Stempel und `check`; Audit `vault.use`/`vault.use_denied` mit `details: { tool, access, target, ...auditExtra }`. `ctx` = MCP-Kontext (`accountId`, `keyId`, `agent`, `transportId`, `impersonatorId`, `signal`, `ipAddress`, `userAgent`) bzw. für Git `transportId = gitSessionId(keyId)`.
- `broker.use` nimmt zusätzlich `precheck`, `stale = (item) => new VaultError(APPROVAL_STALE)` und `deferUse = false` (dann kein `vault.use`, stattdessen `recordUse(extraDetails)` im Ergebnis; Git schreibt so ein `vault.use` je Vorgang); `check(item, { phase, approving })`. `broker.js` exportiert `use` (gemeinsame Instanz), `createBroker({ approvals, audit })`, `createRateLimit({ windowMs, limit })`. Werkzeug-Module exportieren `{ def, handler, needsBrowser }`; die `TOOLS`-Zeile lautet `[HTTP]: require("./tools/http"),` bzw. `[FILL_SECRET]: require("./tools/fillSecret"),`. Einzelheiten: Abweichungsnotiz am Anfang von Task 3.
- `broker.use` (Ergänzung für Task 5): `target`, `scope` und `field` dürfen auch Funktionen `(item) => string` sein, aufgelöst nach `check(item, { phase: "before" })`; ein `scope` mit `|` (`fill|<origin>`) verlangt immer eine Freigabe, auch bei `approvalRequired: false`; `check` darf ein Promise liefern; das `audit`-Objekt wird erst beim Schreiben des Audits gelesen, `check` darf es ergänzen.
- `mcpProvider.js`: `TOOLS` (Name → `{ def, handler(args, ctx, deps), needsBrowser }`); `deps = { broker, getBrowserTools, approvals, fillRate, httpLimits }`; `fillRate(ctx)` ist die gemeinsame Grenze von 20 Fills pro Minute (Passwort und Secret, aufgerufen im `precheck`; der Broker auditiert die Ablehnung einmal je Werkzeug, Aufrufer und Minute); `httpLimits = createHttpLimits()` aus `tools/http.js` hält Zähler je Anbieter-Instanz; die Broker-Option für zusätzliche Audit-Details heißt `auditExtra`; `vault_list` `usableBy` nach Spec „vault_list“.

**Task 6 → 7**
- Agenten-Keys: `agentType` `claude`/`codex` nur `/api/mcp`, `git` nur Pfade unter `/api/vault/git/`; `req.agent = { keyId, entryId, agentType }` wie bisher.
- `requestDeadline({ ms = 300000 })` Middleware; `req.clearRequestDeadline()`.

**Task 8 → 12**
- `POST /api/vault/agent-keys` akzeptiert `agentTypes` ⊆ `["claude", "codex", "git"]`; Ergebnis je Agent wie bisher, für `git` zusätzlich Grund `no_git_entries`, wenn kein Git-Eintrag für den Server gilt (dann kein Key, `id: null`). Jedes Git-Ergebnis trägt `hosts: string[]` (die an `gitSetupCommand` übergebenen Hosts, sortiert, ohne Doppelte; bei `no_git_entries` `[]`).
- `server/lib/vault/gitHosts.js`: `coversGit(item, host)`, `gitHostsOf(items)` (ohne Groß-/Kleinschreibung, nur Hosts, die `provision.isGitHost` annimmt; Task 7 nutzt `coversGit`). `provision.gitSetupCommand({ base, hosts, key | keyFile })`, `provision.isGitHost(host)`, `revokeCommands({ agentType: "git", keyPrefix, base })`, `registrationCheckCommand({ agentType: "git", keyPrefix, base })`.

**Task 9 → 10, 11, 12** — Locale-Schlüssel (de/en):
- `vault.agents.git` = „Git“
- `vault.dialog.usage.title` = „Nutzung durch Agenten“; `vault.dialog.usage.readOnly` = „Nur lesen“, `.readOnlyHint` (Text aus Manifest-States READONLY), `.allowHttp` = „Unverschlüsseltes HTTP erlauben“, `.allowHttpWarning` = „an — der Token geht unverschlüsselt über das Netz“, `.git` = „Für Git nutzen“, `.gitUsername` = „Git-Benutzername“, `.gitUsernameMissing` = „Git-Benutzername fehlt.“, `.fill` = „Darf im Browser eingetragen werden auf“, `.fillEmpty` = „Nirgends — nur für vault_http und Git“, `.fillInvalid` = „Keine gültige Origin (scheme://host[:port]).“
- `vault.detail.usage.title` = „Nutzung durch Agenten“, `.readOnly` = „Nur lesen“, `.allowHttp` = „Auch über http“, `.git` = „Git · Benutzername {{user}}“, `.fill` = „Eintragen auf {{origins}}“, `.empty` = „vault_http über https“
- `vault.approval.write` = „schreibt“, `vault.approval.target.fill` = „Eintragen auf {{origin}}“
- `settings.vault.fillAnywhere.title` = „Token auf jeder Seite eintragen erlauben“, `.description` = „Werte ohne eigene Origin-Liste lassen sich dann auf jeder Seite eintragen — jedes Mal mit Freigabe, eine Sitzungsfreigabe gilt nur für die eine Seite.“
- `servers.agentAccess.result.successGit` = „Git eingerichtet für {{user}}: {{hosts}} läuft über Outpost.“, `.result.noGitEntries` = „Kein Eintrag mit „Für Git nutzen“ gilt für diesen Server.“, `servers.agentAccess.gitNote` = „Remotes per SSH (git@github.com:) gehen nicht über den Vault — auf HTTPS umstellen.“
- englische Texte sinngemäß wie die Manifest-`means`.

---

### Task 1: Felder, Einstellung `fillAnywhere`, Fehlercodes

**Files:**
- Modify: `server/validations/vault.js` (FIELDS.api_key, FIELDS.generic, secretsOf token min 4, updateVaultSettingsValidation)
- Create: `server/migrations/0049-add-vault-fill-anywhere.js`
- Modify: `server/models/VaultSettings.js`, `server/controllers/vaultSettings.js`, `server/routes/vault/settings.js` (JSDoc)
- Modify: `server/lib/vault/errors.js`
- Test: `server/lib/vault/__tests__/validation.test.js`, `server/lib/vault/__tests__/itemsRoute.test.js`, `server/lib/vault/__tests__/state.test.js` (Migration 0049 im Setup)

**Interfaces:**
- Consumes: Bestand `FIELDS`, `secretsOf`, `VaultSettings.getOrCreate`, Migration 0048 als Muster.
- Produces: siehe „Schnittstellen“ Task 1.

**Design:** kein UI-Anteil.

**Tests:** 2 Tests — (1) Validierung: `api_key` mit `host:port`, `readOnly`/`allowHttp`/`git`/`gitUsername`/`fillOrigins` wird angenommen und mit Standardwerten ergänzt; `host:443`, `gitUsername` mit Leerzeichen, Token mit 3 Zeichen, `generic` mit ungültiger Origin werden abgelehnt (ein Test mit Tabelle). (2) Settings-Route: `PATCH { fillAnywhere: true }` speichert und `GET` liefert es (bestehenden Settings-Test erweitern). Fehlermeldungen nicht testen (Konstanten).

**Parallel:** Task 2, Task 6, Task 8, Task 9 (Welle A).

> **Hinweise aus der Planung:**
>
> # Plan 2a — Task 1 und Task 2
>
> Hinweis für den Zusammenbau: `server/lib/StateBroadcaster.js` braucht für die neue Payload keine Änderung, weil `VAULT_APPROVALS` schon `listOpenApprovals` durchreicht; Task 2 fasst die Datei deshalb nicht an.


- [ ] **Step 1: Failing tests schreiben**

`server/lib/vault/__tests__/validation.test.js` — der bestehende Helfer und der bestehende API-Key-Fall nutzen den Token `"t"`, den `min(4)` künftig ablehnt; beide bekommen einen gültigen Token. Zeile 15 ersetzen:

```js
const apiKey = (fields) => ({ name: "gh", type: "api_key", fields: { hosts: ["api.github.com"], ...fields }, secrets: { token: "t" } });
```

durch:

```js
const apiKey = (fields, secrets = { token: "ghp_test" }) => ({ name: "gh", type: "api_key", fields: { hosts: ["api.github.com"], ...fields }, secrets });
```

und Zeile 21 ersetzen:

```js
        [{ name: "gh.token_1", type: "api_key", fields: { hosts: ["api.github.com"] }, secrets: { token: "t" } },
```

durch:

```js
        [{ name: "gh.token_1", type: "api_key", fields: { hosts: ["api.github.com"] }, secrets: { token: "ghp_test" } },
```

Am Ende der Datei anhängen (Test 1 des Budgets):

```js
test("API-Key und Sonstiges: Nutzung durch Agenten mit Standardwerten, Hosts mit Port, Token ab 4 Zeichen, fillAnywhere", () => {
    const fieldsOf = (input) => {
        const { error, value } = validate(createVaultItemValidation, input);
        assert.strictEqual(error, undefined, error?.message);
        return value.fields;
    };
    assert.deepStrictEqual(fieldsOf(apiKey({ hosts: ["Coolify.LAN:8000", "api.github.com"] })), {
        hosts: ["Coolify.LAN:8000", "api.github.com"], headerName: "Authorization", headerTemplate: "Bearer {{secret}}",
        readOnly: false, allowHttp: false, git: false, gitUsername: "x-access-token", fillOrigins: [],
    });
    const full = fieldsOf(apiKey({ readOnly: true, allowHttp: true, git: true, gitUsername: "oauth2", fillOrigins: ["HTTPS://Coolify.Example.net:443"] }));
    assert.deepStrictEqual([full.readOnly, full.allowHttp, full.git, full.gitUsername, full.fillOrigins],
        [true, true, true, "oauth2", ["https://coolify.example.net"]]);
    assert.deepStrictEqual(fieldsOf({ name: "misc", type: "generic", fields: { fillOrigins: ["https://tool.example.com"] }, secrets: { value: "x" } }),
        { fillOrigins: ["https://tool.example.com"] });
    assert.strictEqual(validate(updateVaultItemSchema("api_key"), { secrets: { token: "abcd" } }).error, undefined);
    assert.strictEqual(validate(updateVaultSettingsValidation, { fillAnywhere: true }).value.fillAnywhere, true);

    for (const [label, schema, input] of [
        ["Standardport 443", createVaultItemValidation, apiKey({ hosts: ["api.github.com:443"] })],
        ["Standardport 80", createVaultItemValidation, apiKey({ hosts: ["coolify.lan:80"] })],
        ["Port 0", createVaultItemValidation, apiKey({ hosts: ["coolify.lan:0"] })],
        ["Git-Benutzername mit Leerzeichen", createVaultItemValidation, apiKey({ git: true, gitUsername: "x access" })],
        ["Git-Benutzername mit 65 Zeichen", createVaultItemValidation, apiKey({ gitUsername: "a".repeat(65) })],
        ["Origin mit Pfad", createVaultItemValidation, apiKey({ fillOrigins: ["https://coolify.example.net/login"] })],
        ["21 Origins", createVaultItemValidation, apiKey({ fillOrigins: Array.from({ length: 21 }, (_, i) => `https://h${i}.example.net`) })],
        ["readOnly kein Boolean", createVaultItemValidation, apiKey({ readOnly: "yes" })],
        ["Token mit 3 Zeichen", createVaultItemValidation, apiKey({}, { token: "abc" })],
        ["Token mit 3 Zeichen bei Änderung", updateVaultItemSchema("api_key"), { secrets: { token: "abc" } }],
        ["Sonstiges mit ungültiger Origin", createVaultItemValidation, { name: "misc", type: "generic", fields: { fillOrigins: ["tool.example.com"] }, secrets: { value: "x" } }],
        ["fillAnywhere kein Boolean", updateVaultSettingsValidation, { fillAnywhere: "on" }],
    ]) {
        assert.ok(validate(schema, input).error, label);
    }
});
```

`server/lib/vault/__tests__/itemsRoute.test.js` — den bestehenden Settings-Test erweitern (Test 2 des Budgets). Titel und Anfang des Tests ersetzen:

```js
test("available meldet Schalter, Rechte, Agenten-Adresse, Standard der IP-Bindung, Impersonation und TRUST_PROXY=true; bei ausgeschaltetem Vault sind alle Rechte leer", async (t) => {
    const { get, patch } = await listen(t, { trustProxy: true });

    assert.strictEqual((await patch("/settings", "s-owner", { agentUrl: "https://outpost.example.com" })).status, 403);
    assert.deepStrictEqual((await patch("/settings", "s-revealer", { agentUrl: "https://outpost.example.com/", ipBindingDefault: false })).body,
        { keyStatus: "active", agentUrl: "https://outpost.example.com", ipBindingDefault: false, trustProxyUnsafe: true });
    assert.strictEqual((await patch("/settings", "s-revealer", {})).status, 400);
```

durch:

```js
test("Einstellungen speichern Agenten-Adresse, IP-Bindung und fillAnywhere; available meldet Schalter, Rechte, Agenten-Adresse, Standard der IP-Bindung, Impersonation und TRUST_PROXY=true; bei ausgeschaltetem Vault sind alle Rechte leer", async (t) => {
    const { get, patch } = await listen(t, { trustProxy: true });

    assert.strictEqual((await patch("/settings", "s-owner", { agentUrl: "https://outpost.example.com" })).status, 403);
    assert.deepStrictEqual((await patch("/settings", "s-revealer", { agentUrl: "https://outpost.example.com/", ipBindingDefault: false })).body,
        { keyStatus: "active", agentUrl: "https://outpost.example.com", ipBindingDefault: false, fillAnywhere: false, trustProxyUnsafe: true });
    assert.strictEqual((await patch("/settings", "s-revealer", {})).status, 400);
    assert.strictEqual((await patch("/settings", "s-revealer", { fillAnywhere: true })).body.fillAnywhere, true);
    assert.deepStrictEqual((await get("/settings", "s-revealer")).body,
        { keyStatus: "active", agentUrl: "https://outpost.example.com", ipBindingDefault: false, fillAnywhere: true, trustProxyUnsafe: true });
```

Der Rest des Tests (`urlFields`, `/available`, Vault aus) bleibt unverändert; `/available` meldet `fillAnywhere` nicht.

`server/lib/vault/__tests__/state.test.js` — kein neuer Test: das Modell `VaultSettings` liest künftig die Spalte `fillAnywhere`, also muss das Setup die Migration 0049 ausführen (zweimal, wie 0048, damit die Wiederholbarkeit mitläuft). Nach Zeile 11 einfügen:

```js
const fillAnywhereMigration = require("../../../migrations/0049-add-vault-fill-anywhere");
```

und im `test.before` nach den beiden Aufrufen von `agentUrlMigration.up`:

```js
    await fillAnywhereMigration.up(queryInterface, DataTypes);
    await fillAnywhereMigration.up(queryInterface, DataTypes);
```

- [ ] **Step 2: Tests laufen lassen, Fehlschlag prüfen**

Run: `cd /root/outpost && node --test server/lib/vault/__tests__/validation.test.js server/lib/vault/__tests__/itemsRoute.test.js server/lib/vault/__tests__/state.test.js`
Expected: FAIL — der neue Validierungstest mit `"fields.hosts[0]" must be a valid hostname`, der Settings-Test mit `AssertionError` (Antwort ohne `fillAnywhere`), `state.test.js` mit `Cannot find module '../../../migrations/0049-add-vault-fill-anywhere'`. Der bestehende Validierungstest bleibt grün.

- [ ] **Step 3: Validierung erweitern**

`server/validations/vault.js` — nach `SECRET_MAX_LENGTH` (Zeile 12) einfügen:

```js
// redact.js ignores variants under 4 characters.
const SECRET_MIN_LENGTH = { token: 4 };
```

Den Block `const FIELDS = { login: …, api_key: … },` bis einschließlich `api_key` ersetzen:

```js
const FIELDS = {
    login: Joi.object({
        username: Joi.string().max(255).allow(""),
        origins: Joi.array().items(origin).min(1).max(20).required(),
    }),
    api_key: Joi.object({
        hosts: Joi.array().items(Joi.string().hostname()).min(1).max(20).required(),
        headerName: Joi.string().pattern(/^[A-Za-z0-9-]{1,64}$/).default("Authorization"),
        headerTemplate: Joi.string().max(512).pattern(/\{\{secret\}\}/).default("Bearer {{secret}}"),
    }),
```

durch:

```js
const hostname = Joi.string().hostname();
// vault_http and the git proxy compare the URL's host[:port] with new URL().host, which drops default ports.
const host = Joi.string().max(261).custom((value, helpers) => {
    if (!hostname.validate(value).error) return value;
    const match = /^([^:]+):([1-9][0-9]{0,4})$/.exec(value);
    if (!match || hostname.validate(match[1]).error || Number(match[2]) > 65535) return helpers.error("any.invalid");
    if (match[2] === "80" || match[2] === "443") return helpers.error("host.defaultPort");
    return value;
}).messages({ "any.invalid": "hosts must look like host or host:port", "host.defaultPort": "hosts: leave out the default port (80 or 443)" });

const fillOrigins = Joi.array().items(origin).max(20).default([]);

const FIELDS = {
    login: Joi.object({
        username: Joi.string().max(255).allow(""),
        origins: Joi.array().items(origin).min(1).max(20).required(),
    }),
    api_key: Joi.object({
        hosts: Joi.array().items(host).min(1).max(20).required(),
        headerName: Joi.string().pattern(/^[A-Za-z0-9-]{1,64}$/).default("Authorization"),
        headerTemplate: Joi.string().max(512).pattern(/\{\{secret\}\}/).default("Bearer {{secret}}"),
        readOnly: Joi.boolean().default(false),
        allowHttp: Joi.boolean().default(false),
        git: Joi.boolean().default(false),
        gitUsername: Joi.string().pattern(/^[A-Za-z0-9._@-]{1,64}$/).default("x-access-token")
            .messages({ "string.pattern.base": "gitUsername may only contain letters, digits, dot, underscore, @ and dash (max. 64)" }),
        fillOrigins,
    }),
```

Hosts bleiben gespeichert, wie eingegeben: `targetOf` in `server/controllers/vaultItems.js` vergleicht Hosts exakt und löschte sonst beim nächsten Speichern eines Bestandseintrags mit Großbuchstaben dessen Token. Task 4, Task 7 und Task 8 vergleichen ohne Groß-/Kleinschreibung. IPv4/IPv6 ohne Port gehen wie bisher über `hostname()`.

`generic` ersetzen:

```js
    generic: Joi.object({}),
```

durch:

```js
    generic: Joi.object({ fillOrigins }),
```

(`CREATE_FIELDS.generic` bleibt `FIELDS.generic.default({})`: ohne `fields` bleibt es `{}`, wie der bestehende Test erwartet; Leser behandeln ein fehlendes `fillOrigins` als `[]`.)

`secretsOf` ersetzen:

```js
    SECRET_FIELDS[type].map((field) => [field, Joi.string().min(1).max(SECRET_MAX_LENGTH[field])]),
```

durch:

```js
    SECRET_FIELDS[type].map((field) => [field, Joi.string().min(SECRET_MIN_LENGTH[field] ?? 1).max(SECRET_MAX_LENGTH[field])]),
```

`updateVaultSettingsValidation` ersetzen:

```js
module.exports.updateVaultSettingsValidation = Joi.object({
    agentUrl: agentUrl.allow(null, ""),
    ipBindingDefault: Joi.boolean(),
}).min(1);
```

durch:

```js
module.exports.updateVaultSettingsValidation = Joi.object({
    agentUrl: agentUrl.allow(null, ""),
    ipBindingDefault: Joi.boolean(),
    fillAnywhere: Joi.boolean(),
}).min(1);
```

- [ ] **Step 4: Migration 0049 anlegen**

`server/migrations/0049-add-vault-fill-anywhere.js` (neu; wiederholbar wie 0048, überspringt eine fehlende Tabelle):

```js
module.exports = {
    async up(queryInterface, Sequelize) {
        const tables = (await queryInterface.showAllTables()).map((t) => t.toLowerCase?.() || t);
        if (!tables.includes("vault_settings")) return;
        const existing = await queryInterface.describeTable("vault_settings");
        if (!existing.fillAnywhere)
            await queryInterface.addColumn("vault_settings", "fillAnywhere", { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false });
    },
};
```

- [ ] **Step 5: Modell, Controller und Route-Doku**

`server/models/VaultSettings.js` — nach der Zeile `ipBindingDefault: …` einfügen:

```js
    fillAnywhere: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
```

`server/controllers/vaultSettings.js` — `getVaultSettings` und `updateVaultSettings` ersetzen:

```js
const getVaultSettings = async () => {
    const settings = await VaultSettings.getOrCreate();
    return { keyStatus: getKeyStatus(), agentUrl: settings.agentUrl || null, ipBindingDefault: settings.ipBindingDefault !== false };
};

const updateVaultSettings = async ({ agentUrl, ipBindingDefault }) => {
    const settings = await VaultSettings.getOrCreate();
    await settings.update({
        ...(agentUrl !== undefined ? { agentUrl: agentUrl || null } : {}),
        ...(ipBindingDefault !== undefined ? { ipBindingDefault } : {}),
    });
    return getVaultSettings();
};
```

durch:

```js
const getVaultSettings = async () => {
    const settings = await VaultSettings.getOrCreate();
    return {
        keyStatus: getKeyStatus(), agentUrl: settings.agentUrl || null,
        ipBindingDefault: settings.ipBindingDefault !== false, fillAnywhere: settings.fillAnywhere === true,
    };
};

const updateVaultSettings = async ({ agentUrl, ipBindingDefault, fillAnywhere }) => {
    const settings = await VaultSettings.getOrCreate();
    await settings.update({
        ...(agentUrl !== undefined ? { agentUrl: agentUrl || null } : {}),
        ...(ipBindingDefault !== undefined ? { ipBindingDefault } : {}),
        ...(fillAnywhere !== undefined ? { fillAnywhere } : {}),
    });
    return getVaultSettings();
};
```

`getVaultAvailability` bleibt unverändert (es destrukturiert nur `agentUrl` und `ipBindingDefault`).

`server/routes/vault/settings.js` — JSDoc von `GET /vault/settings` ersetzen:

```js
 * @description Status of VAULT_KEY and the Outpost address agents use. Answers while the vault is off, so the page can show why.
 * @tags Vault
 * @produces application/json
 * @security BearerAuth
 * @return {object} 200 - { keyStatus, agentUrl, trustProxyUnsafe }
```

durch:

```js
 * @description Status of VAULT_KEY, the Outpost address agents use, the default of the IP binding and whether browser_fill_secret may fill entries without fill origins on any page. Answers while the vault is off, so the page can show why.
 * @tags Vault
 * @produces application/json
 * @security BearerAuth
 * @return {object} 200 - { keyStatus, agentUrl, ipBindingDefault, fillAnywhere, trustProxyUnsafe }
```

und von `PATCH /vault/settings`:

```js
 * @description Sets the Outpost address agents use (http or https; empty clears it). Works while the vault is off.
 * @tags Vault
 * @produces application/json
 * @security BearerAuth
 * @param {UpdateVaultSettings} request.body.required - { agentUrl }
 * @return {object} 200 - { keyStatus, agentUrl, trustProxyUnsafe }
```

durch:

```js
 * @description Sets the Outpost address agents use (http or https; empty clears it), the default of the IP binding and fillAnywhere. Works while the vault is off.
 * @tags Vault
 * @produces application/json
 * @security BearerAuth
 * @param {UpdateVaultSettings} request.body.required - { agentUrl?, ipBindingDefault?, fillAnywhere? }, at least one
 * @return {object} 200 - { keyStatus, agentUrl, ipBindingDefault, fillAnywhere, trustProxyUnsafe }
```

- [ ] **Step 6: Fehlercodes**

`server/lib/vault/errors.js` vollständig ersetzen. Neue Codes und Meldungen wörtlich aus Spec „Fehlercodes“; `WRONG_TYPE`, `ITEM_UNREADABLE`, `APPROVAL_TIMEOUT`, `APPROVAL_PENDING` (Text aus der Spec), `CLIENT_GONE`, `RATE_LIMITED` und `NO_SECRET` werden werkzeugneutral. Alle übrigen Meldungen bleiben wörtlich wie heute. Kein Test prüft die Texte (Konstanten).

```js
class VaultError extends Error {
    constructor(code, message = VaultErrorMessage[code], details = {}) {
        super(message);
        this.name = "VaultError";
        this.code = code;
        this.details = details;
    }
}

const VaultErrorCode = Object.freeze({
    ITEM_UNKNOWN: "vault.item_unknown",
    WRONG_TYPE: "vault.wrong_type",
    ITEM_UNREADABLE: "vault.item_unreadable",
    SESSION_TAINTED: "vault.session_tainted",
    VIA_NOT_ALLOWED: "vault.via_not_allowed",
    PERSISTENT_NOT_ALLOWED: "vault.persistent_not_allowed",
    ORIGIN_MISMATCH: "vault.origin_mismatch",
    NOT_PASSWORD_FIELD: "vault.not_password_field",
    BAD_USERNAME_FIELD: "vault.bad_username_field",
    FOCUS_LOST: "vault.focus_lost",
    EVALUATE_LOCKED: "vault.evaluate_locked",
    SCREENSHOT_LOCKED: "vault.screenshot_locked",
    INPUT_LOCKED: "vault.input_locked",
    APPROVAL_TIMEOUT: "vault.approval_timeout",
    APPROVAL_UNAVAILABLE: "vault.approval_unavailable",
    APPROVAL_PENDING: "vault.approval_pending",
    APPROVAL_BUSY: "vault.approval_busy",
    APPROVAL_DENIED: "vault.approval_denied",
    APPROVAL_STALE: "vault.approval_stale",
    CLIENT_GONE: "vault.client_gone",
    RATE_LIMITED: "vault.rate_limited",
    NO_SECRET: "vault.no_secret",
    SESSION_NOT_ALLOWED: "vault.session_not_allowed",
    HTTP_NOT_ALLOWED: "vault.http_not_allowed",
    BAD_URL: "vault.bad_url",
    HOST_NOT_ALLOWED: "vault.host_not_allowed",
    BAD_METHOD: "vault.bad_method",
    READ_ONLY: "vault.read_only",
    HEADER_NOT_ALLOWED: "vault.header_not_allowed",
    BAD_BODY: "vault.bad_body",
    HTTP_FAILED: "vault.http_failed",
    BUSY: "vault.busy",
    FIELD_NOT_FILLABLE: "vault.field_not_fillable",
    NO_FILL_ORIGINS: "vault.no_fill_origins",
    GIT_NOT_ENABLED: "vault.git_not_enabled",
    GIT_AMBIGUOUS: "vault.git_ambiguous",
    GIT_NO_OPERATION: "vault.git_no_operation",
    UPSTREAM_REFUSED: "vault.upstream_refused",
    SECRET_TOO_SHORT: "vault.secret_too_short",
});

const C = VaultErrorCode;
// <kind>, <host> and <entries> are placeholders: callers pass the message with them replaced.
const VaultErrorMessage = Object.freeze({
    [C.ITEM_UNKNOWN]: "This vault item does not exist or is not available on this server. Call vault_list to see the items you can use here.",
    [C.WRONG_TYPE]: "This vault entry cannot be used with this tool, so nothing was done. Call vault_list and pick an entry whose usableBy lists the tool.",
    [C.ITEM_UNREADABLE]: "This vault entry cannot be decrypted, so nothing was done. Ask the user to check the entry in Outpost.",
    [C.SESSION_TAINTED]: "browser_evaluate ran in this browser context, so credentials are not filled here. Open a new session with browser_open without profile=persistent and fill there.",
    [C.VIA_NOT_ALLOWED]: "Credentials are not filled in sessions that run through a server (via), and an agent key may use via only with its own server. Open a session with browser_open without via.",
    [C.PERSISTENT_NOT_ALLOWED]: "Credentials are never filled in the persistent profile. Open a new session with browser_open without profile=persistent and fill there.",
    [C.ORIGIN_MISMATCH]: "The field is not on an origin this vault item allows; the page and every frame around the field must match one of its origins. Navigate to the item's login page (vault_list shows its origins).",
    [C.NOT_PASSWORD_FIELD]: "passwordRef does not point to a password input. Take a browser_snapshot and pass the ref of the password field.",
    [C.BAD_USERNAME_FIELD]: "usernameRef must point to a text, email or tel input on the same origin as the password field. Take a browser_snapshot and pass the right ref, or leave usernameRef out.",
    [C.FOCUS_LOST]: "The target field lost focus before anything was typed, so nothing was filled. Take a browser_snapshot and try again.",
    [C.EVALUATE_LOCKED]: "browser_evaluate is locked in this session because credentials were filled in its browser context. Use browser_snapshot and browser_click instead.",
    [C.SCREENSHOT_LOCKED]: "browser_screenshot is locked while a field filled by browser_fill_credential shows its value in plain text. Use browser_snapshot instead.",
    [C.INPUT_LOCKED]: "Selecting text and middle-click paste are locked in this session because credentials were filled in its browser context. Use browser_click and browser_type on single fields instead.",
    [C.APPROVAL_TIMEOUT]: "The user did not answer the approval request within 2 minutes, so nothing was done. Ask the user, then try again.",
    [C.APPROVAL_UNAVAILABLE]: "No Outpost window of this account is open to approve the request. Ask the user to open Outpost, then try again.",
    [C.APPROVAL_PENDING]: "An approval request for this entry is already open for this caller. Wait for the user to answer it before calling again.",
    [C.APPROVAL_BUSY]: "Too many approval requests of this caller are open. Wait for the user to answer them, then try again.",
    [C.APPROVAL_DENIED]: "The user denied the use of this vault item. Do not retry now; ask the user how to continue.",
    [C.APPROVAL_STALE]: "The entry changed while the approval was open; nothing was done. Call again so the user approves the entry as it is now.",
    [C.CLIENT_GONE]: "The request ended before the approval arrived, so nothing was done.",
    [C.RATE_LIMITED]: "Too many vault calls of this key, so nothing was done; wait a minute and try again.",
    [C.NO_SECRET]: "This entry has no stored value, so nothing was done; ask the user to enter it in Outpost.",
    [C.SESSION_NOT_ALLOWED]: "Requests from an impersonation session can only be approved once.",
    [C.HTTP_NOT_ALLOWED]: "This entry only allows https.",
    [C.BAD_URL]: "url must be an absolute http(s) URL without credentials, at most 8 KB.",
    [C.HOST_NOT_ALLOWED]: "This host is not one of the entry's hosts (vault_list shows them).",
    [C.BAD_METHOD]: "method must be GET, HEAD, POST, PUT, PATCH or DELETE.",
    [C.READ_ONLY]: "This entry is read-only: only GET/HEAD and git fetch.",
    [C.HEADER_NOT_ALLOWED]: "This header cannot be set; Outpost sets authentication, Host, Cookie, Content-Length, Transfer-Encoding, Connection and Proxy-* itself.",
    [C.BAD_BODY]: "body must be a string of at most 1 MB and is not allowed with GET or HEAD.",
    [C.HTTP_FAILED]: "The request failed (<kind>); nothing was returned.",
    [C.BUSY]: "Too many calls of this key are running; wait for one to finish.",
    [C.FIELD_NOT_FILLABLE]: "ref must point to a text, password, search or url input, or a textarea.",
    [C.NO_FILL_ORIGINS]: "This entry may not be filled in the browser; ask the user to add fill origins.",
    [C.GIT_NOT_ENABLED]: "No vault entry with Git enabled covers <host> on this server.",
    [C.GIT_AMBIGUOUS]: "Several vault entries with Git enabled cover <host> on this server (<entries>); ask the user to restrict one.",
    [C.GIT_NO_OPERATION]: "This request does not belong to a running git operation; run the git command again.",
    [C.UPSTREAM_REFUSED]: "The token was refused by <host>; ask the user to check the entry.",
    [C.SECRET_TOO_SHORT]: "The token of this entry is shorter than 4 characters; ask the user to replace it in Outpost.",
});

module.exports = { VaultError, VaultErrorCode, VaultErrorMessage };
```

- [ ] **Step 7: Tests laufen lassen, Erfolg prüfen**

Run: `cd /root/outpost && node --test server/lib/vault/__tests__/validation.test.js server/lib/vault/__tests__/itemsRoute.test.js server/lib/vault/__tests__/state.test.js server/lib/vault/__tests__/mcpProvider.test.js server/lib/browser/__tests__/vaultGuard.test.js && yarn lint`
Expected: PASS (`mcpProvider.test.js` und `vaultGuard.test.js` laufen mit, weil sie Fehler aus `errors.js` werfen; sie prüfen Codes, keine Standardtexte), Lint ohne Befund.

- [ ] **Step 8: Commit**

```bash
git add server/validations/vault.js server/migrations/0049-add-vault-fill-anywhere.js server/models/VaultSettings.js server/controllers/vaultSettings.js server/routes/vault/settings.js server/lib/vault/errors.js server/lib/vault/__tests__/validation.test.js server/lib/vault/__tests__/itemsRoute.test.js server/lib/vault/__tests__/state.test.js
git commit -m "Vault: Felder für die Nutzung durch Agenten, Einstellung fillAnywhere und neue Fehlercodes"
```

---

### Task 2: Freigaben mit Umfang, Werkzeug und Git-Sitzung

**Files:**
- Modify: `server/lib/vault/approvals.js`
- Modify: `server/lib/vault/mcpProvider.js` nur den Aufruf `approvals.forgetTransport` → `approvals.forgetSession` (Alias bleibt; keine weitere Änderung, Task 3 baut die Datei um)
- Test: `server/lib/vault/__tests__/approvals.test.js`

**Interfaces:**
- Consumes: Bestand `approvals.js`.
- Produces: siehe „Schnittstellen“ Task 2.

**Design:** kein UI-Anteil (Payload für UI-VAULT-APPROVAL-CARD/-WRITE kommt hier, die Anzeige baut Task 11).

**Tests:** 4 Tests — (1) Sitzungsfreigabe für `read` deckt `write` desselben Eintrags nicht, `write` deckt `fill` nicht, `fill|https://a` deckt `fill|https://b` nicht; (2) Änderung von `hosts` (neuer `updatedAt`/Stempel) beendet die Sitzungsfreigabe; (3) Git-Sitzung: Freigabe gilt nach `touchSession` weiter und ist 12 h nach dem letzten `touchSession` weg (Uhr per `Date.now`-Stub); (4) `listOpenApprovals` liefert `tool`, `access`, `target`. Bestehende Tests bleiben grün.

**Parallel:** Task 1, Task 6, Task 8, Task 9 (Welle A).

- [ ] **Step 1: Failing tests schreiben**

`server/lib/vault/__tests__/approvals.test.js` — Fixtures und Aufruf-Helfer: jede Anfrage trägt künftig `tool` und `access`, Sitzungsfreigaben werden je Umfang abgefragt. Den Block von `const ITEM = {` bis einschließlich `const flush = …` (Zeilen 36–45) ersetzen durch (`nextWindow` und `openWindow` danach bleiben):

```js
const ITEM = {
    id: 7, accountId: 1, organizationId: null, name: "portal-login", type: "login", updatedAt: "2026-10-10T08:00:00.000Z",
    fields: { username: "ma", origins: ["https://portal.example.com", "https://sso.example.com"] },
};
const OTHER_ITEMS = [8, 9, 10].map((id) => ({ ...ITEM, id, name: `login-${id}` }));
const API_KEY = {
    id: 12, accountId: 1, organizationId: null, name: "github", type: "api_key", updatedAt: "2026-10-10T08:00:00.000Z",
    fields: {
        hosts: ["api.github.com", "github.com"], headerName: "Authorization", headerTemplate: "Bearer {{secret}}",
        readOnly: false, allowHttp: false, git: true, gitUsername: "x-access-token", fillOrigins: [],
    },
};
const HOUR = 60 * 60 * 1000;
const call = (overrides = {}) => ({
    accountId: 1, keyId: 5, transportId: "t-1", agentType: "claude", entryName: "web-01",
    item: ITEM, target: "https://portal.example.com", tool: "browser_fill_credential", access: "write", scope: "fill",
    signal: new AbortController().signal, ...overrides,
});
const flush = () => new Promise((resolve) => setImmediate(resolve));
```

Im bestehenden Test „Einmal gibt genau ein Ausfüllen frei …“ die Schlüsselliste der Karte ersetzen:

```js
    assert.deepStrictEqual(Object.keys(card).sort(), ["agentType", "entryName", "expiresAt", "id", "impersonated", "item", "remainingMs", "target"]);
```

durch:

```js
    assert.deepStrictEqual(Object.keys(card).sort(), ["access", "agentType", "entryName", "expiresAt", "id", "impersonated", "item", "remainingMs", "target", "tool"]);
```

Im bestehenden Test „Für diese Sitzung gilt bis zum Ende des Transports …“ fragen die drei `hasSessionApproval`-Aufrufe künftig den Umfang `fill` ab (den `browser_fill_credential` hat; `call()` setzt ihn als Standard):

```js
    assert.strictEqual(approvals.hasSessionApproval("t-1", reordered), true);
```
→
```js
    assert.strictEqual(approvals.hasSessionApproval("t-1", reordered, "fill"), true);
```

```js
    assert.strictEqual(approvals.hasSessionApproval("t-1", moved), false);
```
→
```js
    assert.strictEqual(approvals.hasSessionApproval("t-1", moved, "fill"), false);
```

```js
    approvals.forgetTransport("t-1");
    assert.strictEqual(approvals.hasSessionApproval("t-1", ITEM), false);
```
→
```js
    approvals.forgetTransport("t-1");
    assert.strictEqual(approvals.hasSessionApproval("t-1", ITEM, "fill"), false);
```

(`forgetTransport` bleibt hier bewusst stehen: es prüft nebenbei den Alias.)

Am Ende der Datei die vier Tests des Budgets anhängen. Wer `call()` nutzt und nicht `fill` meint, setzt `scope` ausdrücklich, weil `call()` `scope: "fill"` vorgibt. Der Git-Test ruft wie der Git-Router erst `touchSession`, dann `hasSessionApproval` auf:

```js
test("Für diese Sitzung gilt je Umfang: Lesen deckt Schreiben nicht, Schreiben nicht Eintragen, Eintragen auf Origin A nicht Origin B", async (t) => {
    const window = openWindow(t, 1);
    const answerNext = async (decision) => {
        await flush();
        assert.strictEqual(window.cards().length, 1);
        approvals.answerApproval(window.cards()[0].id, 1, decision);
    };
    const http = (access) => call({ item: API_KEY, tool: "vault_http", access, scope: access, target: `${access === "read" ? "GET" : "POST"} api.github.com/repos/o/r/issues` });

    const read = approvals.requestApproval(http("read"));
    await answerNext("session");
    assert.strictEqual(await read, "session");
    assert.strictEqual(await approvals.requestApproval(http("read")), "session");
    assert.strictEqual(approvals.hasSessionApproval("t-1", API_KEY, "write"), false);
    const write = approvals.requestApproval(http("write"));
    await answerNext("session");
    assert.strictEqual(await write, "session");
    assert.strictEqual(approvals.hasSessionApproval("t-1", API_KEY, "fill"), false);

    const fill = (origin) => call({ item: API_KEY, tool: "browser_fill_secret", access: "write", scope: `fill|${origin}`, target: origin });
    const onA = approvals.requestApproval(fill("https://a.example.net"));
    await answerNext("session");
    assert.strictEqual(await onA, "session");
    assert.strictEqual(await approvals.requestApproval(fill("https://a.example.net")), "session");
    assert.deepStrictEqual(["fill|https://b.example.net", "fill"].map((scope) => approvals.hasSessionApproval("t-1", API_KEY, scope)), [false, false]);
    const onB = approvals.requestApproval(fill("https://b.example.net"));
    await answerNext("once");
    assert.strictEqual(await onB, "once");
});

test("jede Änderung an Hosts, Lesen/Schreiben, http, Git oder Eintrags-Origins beendet die Sitzungsfreigabe", async (t) => {
    const window = openWindow(t, 1);
    const pending = approvals.requestApproval(call({ item: API_KEY, tool: "vault_http", access: "read", scope: "read", target: "GET api.github.com/user" }));
    await flush();
    approvals.answerApproval(window.cards()[0].id, 1, "session");
    await pending;
    assert.strictEqual(approvals.hasSessionApproval("t-1", API_KEY, "read"), true);
    const reordered = { ...API_KEY, fields: { ...API_KEY.fields, hosts: ["github.com", "api.github.com"] } };
    assert.strictEqual(approvals.hasSessionApproval("t-1", reordered, "read"), true);

    for (const change of [
        { hosts: ["api.github.com", "evil.example.net"] }, { readOnly: true }, { allowHttp: true }, { git: false },
        { gitUsername: "oauth2" }, { fillOrigins: ["https://a.example.net"] },
    ]) {
        const changed = { ...API_KEY, fields: { ...API_KEY.fields, ...change } };
        assert.strictEqual(approvals.hasSessionApproval("t-1", changed, "read"), false, JSON.stringify(change));
    }
    assert.notStrictEqual(approvals.grantStamp({ ...API_KEY, updatedAt: "2026-10-10T08:05:00.000Z" }), approvals.grantStamp(API_KEY));
});

test("Git-Sitzung git:<keyId>: Freigaben bleiben, solange touchSession sie auffrischt, und enden 12 h nach dem letzten touchSession", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
    const window = openWindow(t, 1);
    const session = approvals.gitSessionId(5);
    assert.strictEqual(session, "git:5");
    const grant = async (transportId, tool, target) => {
        if (transportId === session) approvals.touchSession(session);
        const pending = approvals.requestApproval(call({ transportId, agentType: transportId === session ? "git" : "claude", item: API_KEY, tool, access: "read", scope: "read", target }));
        await flush();
        approvals.answerApproval(window.cards()[0].id, 1, "session");
        await pending;
    };
    const gitRequest = () => {
        approvals.touchSession(session);
        return approvals.hasSessionApproval(session, API_KEY, "read");
    };
    await grant(session, "git", "Git · github.com/o/r");
    await grant("t-1", "vault_http", "GET api.github.com/user");

    t.mock.timers.tick(11 * HOUR);
    assert.strictEqual(gitRequest(), true);
    t.mock.timers.tick(12 * HOUR - 1);
    assert.strictEqual(gitRequest(), true);
    t.mock.timers.tick(12 * HOUR);
    assert.strictEqual(gitRequest(), false);
    assert.strictEqual(approvals.hasSessionApproval("t-1", API_KEY, "read"), true, "MCP transports do not expire here");

    await grant(session, "git", "Git · github.com/o/r");
    approvals.forgetSession(session);
    assert.strictEqual(approvals.hasSessionApproval(session, API_KEY, "read"), false);
});

test("listOpenApprovals liefert Werkzeug, Art und Ziel jeder offenen Anfrage", async (t) => {
    openWindow(t, 1);
    const pending = approvals.requestApproval(call({ item: API_KEY, tool: "vault_http", access: "write", target: "POST api.github.com/repos/o/r/issues" }));
    const [card] = approvals.listOpenApprovals(1);
    assert.deepStrictEqual([card.tool, card.access, card.target], ["vault_http", "write", "POST api.github.com/repos/o/r/issues"]);
    approvals.answerApproval(card.id, 1, "once");
    await pending;
});
```

- [ ] **Step 2: Tests laufen lassen, Fehlschlag prüfen**

Run: `cd /root/outpost && node --test server/lib/vault/__tests__/approvals.test.js`
Expected: FAIL — „Einmal gibt genau ein Ausfüllen frei …“ (Karte ohne `access`/`tool`), „Für diese Sitzung gilt je Umfang …“ und „jede Änderung an Hosts …“ (`AssertionError`: Lesen deckt Schreiben und Eintragen, Stempel kennt `hosts` nicht), „Git-Sitzung …“ mit `approvals.gitSessionId is not a function`, „listOpenApprovals liefert …“ (`tool` ist `undefined`). Die übrigen acht bestehenden Tests bleiben grün.

- [ ] **Step 3: Freigaben mit Umfang, Werkzeug, Stempel und Git-Sitzung**

`server/lib/vault/approvals.js` vollständig ersetzen:

```js
const { randomUUID } = require("node:crypto");
const stateBroadcaster = require("../StateBroadcaster");
const { createAuditLog, AUDIT_ACTIONS, RESOURCE_TYPES } = require("../../controllers/audit");
const { VaultError, VaultErrorCode } = require("./errors");
const { itemRef } = require("./visibility");

const APPROVAL_TTL_MS = 120000;
const DENY_LOCK_MS = 60000;
const MAX_OPEN_PER_CALLER = 3;
const GIT_SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
const GIT_SESSION_PREFIX = "git:";

let open = new Map();
let closed = new Map();
let sessionGrants = new Map();
let sessionSeen = new Map();
let denials = new Map();

const callerKey = (accountId, keyId) => `${accountId}:${keyId ?? "session"}`;
const denialKey = (accountId, keyId, itemId) => `${callerKey(accountId, keyId)}:${itemId}`;
const grantKey = (itemId, scope) => JSON.stringify([itemId, scope ?? null]);
const sorted = (list) => [...(list ?? [])].sort();
const grantStamp = (item) => {
    const fields = item.fields ?? {};
    return JSON.stringify([
        new Date(item.updatedAt).getTime(), sorted(fields.origins), sorted(fields.hosts),
        fields.readOnly === true, fields.allowHttp === true, fields.git === true, fields.gitUsername ?? null, sorted(fields.fillOrigins),
    ]);
};
const early = (code) => new VaultError(code, undefined, { early: true });

const gitSessionId = (keyId) => `${GIT_SESSION_PREFIX}${keyId}`;
const isGitSession = (id) => typeof id === "string" && id.startsWith(GIT_SESSION_PREFIX);
const touchSession = (id) => {
    const now = Date.now();
    if (now - (sessionSeen.get(id) ?? now) >= GIT_SESSION_IDLE_MS) sessionGrants.delete(id);
    sessionSeen.set(id, now);
};

const publish = (accountId) =>
    stateBroadcaster.sendStateToAccount(accountId, stateBroadcaster.STATE_TYPES.VAULT_APPROVALS).catch(() => {});

const audit = (request, action, details = {}, meta = {}) => createAuditLog({
    accountId: request.accountId, organizationId: request.organizationId, action,
    resource: RESOURCE_TYPES.VAULT, resourceId: request.itemId,
    details: {
        item: request.item, agentType: request.agentType, entryName: request.entryName, keyId: request.keyId,
        tool: request.tool, access: request.access, target: request.target, ...details,
    },
    ipAddress: meta.ipAddress ?? null, userAgent: meta.userAgent ?? null,
});

const dropIdleGitSessions = (now) => {
    for (const [id, seen] of sessionSeen) {
        if (now - seen < GIT_SESSION_IDLE_MS) continue;
        sessionSeen.delete(id);
        sessionGrants.delete(id);
    }
};

const prune = (now) => {
    for (const [id, entry] of closed) if (entry.until <= now) closed.delete(id);
    for (const [key, until] of denials) if (until <= now) denials.delete(key);
    dropIdleGitSessions(now);
};

const close = (request, status) => {
    open.delete(request.id);
    clearTimeout(request.timer);
    request.signal?.removeEventListener("abort", request.onAbort);
    closed.set(request.id, { accountId: request.accountId, status, until: Date.now() + APPROVAL_TTL_MS });
    publish(request.accountId);
};

const expire = (request, reason) => {
    if (!open.has(request.id)) return;
    close(request, 410);
    audit(request, AUDIT_ACTIONS.VAULT_APPROVAL_TIMEOUT, { reason });
    request.reject(new VaultError(reason === "expired" ? VaultErrorCode.APPROVAL_TIMEOUT : VaultErrorCode.CLIENT_GONE));
};

const hasSessionApproval = (transportId, item, scope) => {
    if (isGitSession(transportId)) dropIdleGitSessions(Date.now());
    return sessionGrants.get(transportId)?.get(grantKey(item.id, scope)) === grantStamp(item);
};

const requestApproval = async ({
    accountId, keyId = null, transportId, agentType = null, entryName = null, impersonated = false,
    item, target, tool, access, scope = access, signal,
}) => {
    if (hasSessionApproval(transportId, item, scope)) return "session";
    const now = Date.now();
    prune(now);
    if ((denials.get(denialKey(accountId, keyId, item.id)) ?? 0) > now) throw early(VaultErrorCode.APPROVAL_DENIED);
    const waiting = [...open.values()];
    if (waiting.some((request) => request.transportId === transportId && request.itemId === item.id))
        throw early(VaultErrorCode.APPROVAL_PENDING);
    if (waiting.filter((request) => request.caller === callerKey(accountId, keyId)).length >= MAX_OPEN_PER_CALLER)
        throw early(VaultErrorCode.APPROVAL_BUSY);
    if (!stateBroadcaster.hasConnection(accountId)) throw early(VaultErrorCode.APPROVAL_UNAVAILABLE);
    if (signal?.aborted) throw early(VaultErrorCode.CLIENT_GONE);

    return new Promise((resolve, reject) => {
        const request = {
            id: randomUUID(), accountId, keyId, caller: callerKey(accountId, keyId), transportId,
            itemId: item.id, stamp: grantStamp(item), organizationId: item.organizationId ?? null, item: itemRef(item),
            agentType, entryName, impersonated: Boolean(impersonated), target, tool, access, scope,
            expiresAt: now + APPROVAL_TTL_MS, resolve, reject, signal,
        };
        request.timer = setTimeout(() => expire(request, "expired"), APPROVAL_TTL_MS);
        request.onAbort = () => expire(request, "client_gone");
        signal?.addEventListener("abort", request.onAbort, { once: true });
        open.set(request.id, request);
        publish(accountId);
    });
};

const answerApproval = (id, accountId, decision, meta = {}) => {
    const now = Date.now();
    prune(now);
    const request = open.get(id);
    if (!request) {
        const done = closed.get(id);
        return { status: done && Number(done.accountId) === Number(accountId) ? done.status : 404 };
    }
    if (Number(request.accountId) !== Number(accountId)) return { status: 404 };
    if (now >= request.expiresAt) {
        expire(request, "expired");
        return { status: 410 };
    }
    if (decision === "session" && request.impersonated) return { status: 400, code: VaultErrorCode.SESSION_NOT_ALLOWED };
    close(request, 409);
    if (decision === "deny") {
        denials.set(denialKey(request.accountId, request.keyId, request.itemId), now + DENY_LOCK_MS);
        audit(request, AUDIT_ACTIONS.VAULT_DENY, {}, meta);
        request.reject(new VaultError(VaultErrorCode.APPROVAL_DENIED));
    } else {
        if (decision === "session") {
            if (isGitSession(request.transportId)) touchSession(request.transportId);
            if (!sessionGrants.has(request.transportId)) sessionGrants.set(request.transportId, new Map());
            sessionGrants.get(request.transportId).set(grantKey(request.itemId, request.scope), request.stamp);
        }
        audit(request, AUDIT_ACTIONS.VAULT_APPROVE, { decision }, meta);
        request.resolve(decision);
    }
    return { status: 200 };
};

const listOpenApprovals = (accountId) => {
    const now = Date.now();
    return [...open.values()]
        .filter((request) => Number(request.accountId) === Number(accountId))
        .sort((a, b) => a.expiresAt - b.expiresAt)
        .map(({ id, agentType, entryName, impersonated, item, tool, access, target, expiresAt }) => ({
            id, agentType, entryName, impersonated, item, tool, access, target,
            expiresAt: new Date(expiresAt).toISOString(), remainingMs: Math.max(0, expiresAt - now),
        }));
};

const forgetSession = (id) => {
    sessionGrants.delete(id);
    sessionSeen.delete(id);
    for (const request of [...open.values()]) if (request.transportId === id) expire(request, "client_gone");
};

const _resetForTests = () => {
    for (const request of open.values()) clearTimeout(request.timer);
    open = new Map();
    closed = new Map();
    sessionGrants = new Map();
    sessionSeen = new Map();
    denials = new Map();
};

module.exports = {
    APPROVAL_TTL_MS, GIT_SESSION_IDLE_MS, requestApproval, answerApproval, listOpenApprovals, hasSessionApproval, grantStamp,
    gitSessionId, touchSession, forgetSession, forgetTransport: forgetSession, _resetForTests,
};
```

Was sich gegenüber dem Bestand ändert: Sitzungsfreigaben liegen unter `(Sitzung, Eintrag, Umfang)` (`grantKey`), `scope` ist standardmäßig `access`. Umfänge: `read` (GET/HEAD, git fetch), `write` (schreibendes `vault_http`, git push), `fill` (`browser_fill_secret` und `browser_fill_credential`), `fill|<origin>` (`browser_fill_secret` bei `fillAnywhere`); Schreiben und Eintragen werden also getrennt freigegeben, und `browser_fill_credential` verhält sich wie bisher, weil es nur `fill` kennt. Der Stempel enthält zusätzlich `hosts`, `readOnly`, `allowHttp`, `git`, `gitUsername`, `fillOrigins` (Listen sortiert, Schalter als echte Booleans, damit Bestandseinträge ohne die Felder denselben Stempel behalten). Offene Karten und die 60-s-Sperre bleiben je (Sitzung bzw. Aufrufer, Eintrag) ohne Umfang. Anfrage, Karte und die Audits von Freigabe, Ablehnen und Ablauf tragen `tool` und `access`. Sitzungen mit Präfix `git:` verlieren ihre Freigaben 12 h nach dem letzten `touchSession`: `touchSession` prüft den Leerlauf, bevor es die Uhr neu setzt, denn der Git-Router berührt die Sitzung vor der Freigabeprüfung — andersherum liefe eine Git-Sitzung nie ab. Eine erteilte Sitzungsfreigabe berührt die Sitzung vor dem Speichern, damit eine ältere, abgelaufene Berührung die neue Freigabe nicht sofort löscht. `prune` räumt abgelaufene Git-Sitzungen zusätzlich auf. `forgetTransport` ist Alias von `forgetSession`.

- [ ] **Step 4: Aufruf in `mcpProvider.js` umbenennen**

`server/lib/vault/mcpProvider.js` — nur diese Zeile (Task 3 baut die Datei um):

```js
        forgetTransport: (transportId) => approvals.forgetTransport(transportId),
```

durch:

```js
        forgetTransport: (transportId) => approvals.forgetSession(transportId),
```

Die Approvals-Doubles in `mcpProvider.test.js` und `chromium.e2e.test.js` haben nur `forgetTransport`; sie bleiben unverändert, weil keiner dieser Tests `provider.forgetTransport` aufruft.

- [ ] **Step 5: Tests laufen lassen, Erfolg prüfen**

Run: `cd /root/outpost && node --test server/lib/vault/__tests__/approvals.test.js server/lib/vault/__tests__/mcpProvider.test.js server/lib/mcp/__tests__/*.test.js && yarn lint`
Expected: PASS (13 Tests in `approvals.test.js`), Lint ohne Befund.

- [ ] **Step 6: Commit**

```bash
git add server/lib/vault/approvals.js server/lib/vault/mcpProvider.js server/lib/vault/__tests__/approvals.test.js
git commit -m "Vault: Freigaben je Umfang mit Werkzeug, Ziel und Git-Sitzung"
```

### Task 3: Vermittlungskern, Schwärzung, Umbau `browser_fill_credential`

**Files:**
- Create: `server/lib/vault/redact.js`, `server/lib/vault/broker.js`
- Modify: `server/lib/browser/vaultGuard.js` (`variantsOf` aus `redact.js`)
- Modify: `server/lib/vault/mcpProvider.js` (`fill` über `broker.use`, Tabelle `TOOLS`, `vault_list` `usableBy`)
- Create: `server/lib/vault/tools/http.js`, `server/lib/vault/tools/fillSecret.js` (Platzhalter, die Task 4 und Task 5 vollständig ersetzen)
- Modify: `server/lib/vault/__tests__/helpers/vaultBed.js` (Ersatz für `controllers/vaultSettings`)
- Test: `server/lib/vault/__tests__/redact.test.js` (neu), `server/lib/vault/__tests__/broker.test.js` (neu), bestehende `mcpProvider.test.js`, `server/lib/browser/__tests__/vaultGuard.test.js`

**Interfaces:**
- Consumes: Task 1 (`VaultErrorCode.APPROVAL_STALE`, neue `fields`), Task 2 (`requestApproval` mit `tool`/`access`/`scope`, `grantStamp`).
- Produces: siehe „Schnittstellen“ Task 3.

**Design:** kein UI-Anteil.

**Tests:** 4 Tests — (1) `truncateAndRedact`: Schnitt mitten in einer Variante lässt keinen Anfang stehen, Varianten base64/Prozent werden geschwärzt (Review Focus 2); (2) Broker: Eintrag ändert Hosts während offener Karte → `vault.approval_stale`, `act` läuft nicht (Review Focus 4); (3) Broker: Key widerrufen während offener Karte → `vault.item_unknown`, `act` läuft nicht; (4) `vault_list` `usableBy` für `api_key` mit `git`/`fillOrigins` und `generic` (bestehenden Test erweitern). Bestehende Tests von `browser_fill_credential` unverändert grün (kein neuer Test dafür).

**Parallel:** Task 10, Task 11, Task 12 (Welle B).

> **Hinweise aus der Planung:**
>
> **Abweichung (Tasks 3 und 4):** Die Schnittstellen aus „Schnittstellen“ Task 3 gelten mit den folgenden **Ergänzungen und einer Umbenennung**. Ohne sie lässt sich `browser_fill_credential` nicht ohne Verhaltensänderung auf `broker.use` umstellen, und der Git-Proxy (Task 7) bekäme nicht ein `vault.use` je Vorgang. Die Ergänzungen sind optional. Bitte an Task 5 und Task 7 weitergeben, besonders Punkt 0:
>
> 0. Die Broker-Option für zusätzliche Audit-Details heißt **`auditExtra`**. Tasks 5 und 7 übergeben ihre Details ebenfalls als `auditExtra`.
>
> 1. `broker.use` nimmt zusätzlich `precheck = null` (läuft als Erstes im auditierten Abschnitt, noch vor dem Laden des Eintrags: für Argumente und Drosseln, deren Ablehnung schon heute mit `item: <Argument, max. 200 Zeichen>` ins Audit geht; eine `vault.rate_limited`-Ablehnung aus `precheck` auditiert der Broker höchstens einmal je Werkzeug, Aufrufer und Minute), `stale = (item) => new VaultError(APPROVAL_STALE)` (welcher Fehler bei abweichendem Stempel geworfen wird — `browser_fill_credential` übergibt hier sein `ORIGIN_MISMATCH`, wie es die Spec als Ausnahme verlangt) und `deferUse = false` (true: kein `vault.use` und kein `lastUsedAt`, stattdessen liefert `use` zusätzlich `recordUse(extraDetails)`; für Task 7, der `vault.use` erst beim Ende des Vorgangs mit summierten `bytes` schreibt).
> 2. `target`, `scope` und `field` dürfen Funktionen `(item) => string` sein. Der Broker wertet sie nach `check(item, { phase: "before" })` aus (`field` beim Lesen des Werts), `target` noch einmal beim Schreiben des Audits; vor dem Laden des Eintrags gilt eine Funktion als `null`. Das brauchen die Browser-Werkzeuge: Ihr Ziel (die Origin von Sitzung bzw. Feld) steht erst fest, wenn `check` die Sitzung aufgelöst hat. `check` darf ein Promise liefern (es wird abgewartet). `auditExtra` wird erst beim Schreiben gelesen, `check` und `act` dürfen es also ergänzen (`vault_http` setzt dort `status` und `bytes`, Task 5 `origin` und `fieldType`).
> 3. `check(item, { phase, approving })`: `approving` sagt, ob der Eintrag (`approvalRequired`) oder der Aufrufer (Impersonation) eine Freigabe verlangt. Dazu fragt der Broker immer, wenn der ausgewertete `scope` ein `|` enthält (`fill|<origin>` bei `fillAnywhere`, Task 5), auch bei `approvalRequired: false`. So bleibt die Freigabepflicht an einer Stelle. `vault_http` nutzt `scope = access` (`read`/`write`), Schreibfreigaben gelten also je Werkzeug.
> 4. Stempelvergleich nach der Freigabe: Gab es eine Karte, vergleicht der Broker `grantStamp` des Eintrags vor und nach der Freigabe mit auf 0 gesetztem `updatedAt`. Eine Änderung außerhalb der gestempelten Felder (Beschreibung, Benutzername) hält eine gerade erteilte Freigabe also nicht auf, so wie heute. Bei `approved` vergleicht er den vollen `grantStamp` mit `approved.stamp` und prüft `approved.itemId`. Der Vergleich läuft **vor** `check(…, { phase: "after" })`, damit geänderte Hosts immer `vault.approval_stale` ergeben (Review Focus 4). Einen Wechsel des Ziels (etwa eine andere Origin nach der Freigabe) prüft das Werkzeug selbst in `check(…, { phase: "after" })`. `browser_fill_credential` prüft ihn wie heute über die Origin-Prüfung in `act`.
> 5. `broker.js` exportiert `createBroker({ approvals = require("./approvals"), audit })` → `{ use }`, dazu `createRateLimit({ windowMs, limit })` → `(ctx) => void` (wirft `RATE_LIMITED`, Schlüssel `accountId:keyId`) und `use` als Funktion einer gemeinsamen Standardinstanz (für den Git-Router). Der Vault-Anbieter legt je Instanz einen eigenen Broker an, wie bisher seine Zähler.
> 6. `deps` enthält zusätzlich `fillRate` (`createRateLimit({ windowMs: 60000, limit: 20 })` je Anbieter-Instanz), die gemeinsame Drossel von `browser_fill_credential` und `browser_fill_secret`. Die Werkzeuge rufen sie in `precheck` auf. Die Ablehnung auditiert der Broker höchstens einmal je Werkzeug, Aufrufer und Minute. Bisher galt das je Aufrufer über beide Werkzeuge hinweg, und `browser_fill_secret` gab es noch nicht; der bestehende Drossel-Test nutzt nur `browser_fill_credential` und bleibt grün. Dazu `httpLimits` (`createHttpLimits()` aus `tools/http.js`, je Anbieter-Instanz: `{ rate, enter, leave }` für 60/min und 4 gleichzeitige Aufrufe von `vault_http`).
> 7. Ein Werkzeug-Modul exportiert `{ def, handler, needsBrowser }`. Task 3 legt Platzhalter `server/lib/vault/tools/http.js` (zusätzlich mit `createHttpLimits`) und `server/lib/vault/tools/fillSecret.js` an, trägt beide in `TOOLS` ein und passt die Werkzeuglisten in `mcpProvider.test.js` an. Task 4 und Task 5 ersetzen nur noch ihr eigenes Modul und teilen sich in Welle C keine Datei.
> 8. Task 3 ändert zusätzlich `server/lib/vault/__tests__/helpers/vaultBed.js` (Ersatz für `controllers/vaultSettings` mit `state.settings`, damit `vault_list` und Task 5 `fillAnywhere` lesen können).


- [ ] **Step 1: Failing test für die Schwärzung schreiben**

`server/lib/vault/__tests__/redact.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const { secretVariants, truncateAndRedact } = require("../redact");

const TOKEN = "ghp_tok en/+42secret";
const USER = "x-access-token";
const base64 = (text) => Buffer.from(text, "utf8").toString("base64");

test("truncateAndRedact cuts on the byte limit without leaving the start of a variant behind and blanks the token in its encoded forms", () => {
    const variants = secretVariants({ token: TOKEN, headerValue: `Bearer ${TOKEN}`, gitUsername: USER });
    const encoded = [TOKEN, encodeURIComponent(TOKEN), base64(TOKEN), base64(`${USER}:${TOKEN}`), `Bearer ${TOKEN}`];
    const head = `{"seen":${JSON.stringify(encoded)},"pad":"`;
    // The cut falls 7 bytes into the token that follows 150 two-byte characters: "ghp_tok" would be left over.
    const limit = Buffer.byteLength(head) + 300 + 7;
    const text = `${head}${"ä".repeat(150)}${TOKEN}${"z".repeat(500)}"}`;

    assert.deepStrictEqual(truncateAndRedact(text, limit, variants), {
        text: `{"seen":["••••","••••","••••","••••","••••"],"pad":"${"ä".repeat(150)}\n[truncated after ${limit} bytes]`,
        truncated: true,
    });
    assert.deepStrictEqual(truncateAndRedact("ää", 3, variants), { text: "ä\n[truncated after 3 bytes]", truncated: true },
        "a character cut in half is dropped, not turned into U+FFFD");
    assert.deepStrictEqual(truncateAndRedact(`ok ${TOKEN}`, 1000, variants), { text: "ok ••••", truncated: false });
});
```

- [ ] **Step 2: Test laufen lassen, er schlägt fehl**

Run: `node --test server/lib/vault/__tests__/redact.test.js`
Expected: FAIL, der Test bricht beim Laden ab mit `Error: Cannot find module '../redact'`.

- [ ] **Step 3: `server/lib/vault/redact.js` anlegen und `vaultGuard.js` umstellen**

`server/lib/vault/redact.js`:

```js
const REDACTED = "••••";
const MIN_LENGTH = 4;

// document.title and innerText collapse runs of whitespace, so the value can show up in that form too.
const lowerHex = (encoded) => encoded.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
const variantsOf = (secret) => {
    const percent = encodeURIComponent(secret);
    const form = new URLSearchParams([["", secret]]).toString().slice(1);
    return [secret, percent, lowerHex(percent), form, lowerHex(form), secret.replace(/\s+/g, " ").trim()];
};

const base64 = (text) => Buffer.from(text, "utf8").toString("base64");

// Longest first, or a variant that contains a shorter one leaves its rest behind. Variants under
// 4 characters stay: a very short token would blank arbitrary words of a response.
const usable = (variants) => [...new Set(variants)]
    .filter((variant) => typeof variant === "string" && variant.length >= MIN_LENGTH)
    .sort((x, y) => y.length - x.length);

const secretVariants = ({ token, headerValue = null, gitUsername = null }) => {
    const basic = gitUsername === null ? [] : [`${gitUsername}:${token}`, base64(`${gitUsername}:${token}`)];
    // JSON escapes: a JSON body may repeat the token with \" or \/ in it.
    const json = [JSON.stringify(token).slice(1, -1), token.replaceAll("/", "\\/")];
    return usable([token, ...variantsOf(token), ...json, headerValue, ...basic, base64(token)]);
};

const redactSecretText = (text, variants) => {
    let result = text;
    for (const variant of usable(variants)) result = result.split(variant).join(REDACTED);
    return result;
};

const withoutPartialVariant = (text, variants) => {
    let cut = 0;
    for (const variant of variants) {
        for (let length = Math.min(variant.length - 1, text.length); length > cut; length--) {
            if (text.endsWith(variant.slice(0, length))) {
                cut = length;
                break;
            }
        }
    }
    return text.slice(0, text.length - cut);
};

const truncateAndRedact = (text, limitBytes, variants) => {
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length <= limitBytes) return { text: redactSecretText(text, variants), truncated: false };
    // stream: true holds back a character cut in half instead of turning it into U+FFFD.
    const head = new TextDecoder().decode(bytes.subarray(0, limitBytes), { stream: true });
    return {
        text: `${redactSecretText(withoutPartialVariant(head, usable(variants)), variants)}\n[truncated after ${limitBytes} bytes]`,
        truncated: true,
    };
};

module.exports = { REDACTED, variantsOf, secretVariants, redactSecretText, truncateAndRedact };
```

In `server/lib/browser/vaultGuard.js` kommt `variantsOf` künftig aus `redact.js`. Neue Importzeile nach `const { parseKey, MODIFIERS } = require("./actions");`:

```js
const { variantsOf } = require("../vault/redact");
```

und diese Zeilen fallen weg (bisher Z. 53–59):

```js
// document.title and innerText collapse runs of whitespace, so the value can show up in that form too.
const lowerHex = (encoded) => encoded.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
const variantsOf = (secret) => {
    const percent = encodeURIComponent(secret);
    const form = new URLSearchParams([["", secret]]).toString().slice(1);
    return [secret, percent, lowerHex(percent), form, lowerHex(form), secret.replace(/\s+/g, " ").trim()];
};
```

`redactorFor` bleibt unverändert: Sein `if (variant)` behält wie bisher auch kurze Varianten, denn im Browser schwärzt es nur Werte, die tatsächlich eingetragen wurden.

- [ ] **Step 4: Tests laufen lassen, sie bestehen**

Run: `node --test server/lib/vault/__tests__/redact.test.js server/lib/browser/__tests__/vaultGuard.test.js server/lib/browser/__tests__/tools.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 5: Failing tests für den Broker schreiben**

`server/lib/vault/__tests__/broker.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const bed = require("./helpers/vaultBed");
const { VaultErrorCode } = require("../errors");
const { createBroker } = require("../broker");

const TOKEN = "ghp_broker-secret";
const API = {
    id: 42, accountId: 1, organizationId: null, name: "github-api", type: "api_key", description: null, updatedAt: "2026-10-10T08:00:00.000Z",
    fields: { hosts: ["api.github.com"], headerName: "Authorization", headerTemplate: "Bearer {{secret}}" }, approvalRequired: true, allServers: true,
};

const until = async (condition) => {
    for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(condition(), "condition not reached");
};

const setup = () => {
    bed.reset({ items: [{ ...API }], secrets: { "42:token": TOKEN }, apiKeys: [99] });
    const open = [];
    const approvals = { requestApproval: (request) => new Promise((resolve) => { open.push({ request, answer: resolve }); }) };
    const audit = [];
    const acted = [];
    const broker = createBroker({ approvals, audit: async (entry) => { audit.push(entry); } });
    const ctx = {
        accountId: 1, keyId: 99, agent: null, impersonatorId: null, transportId: "A", ipAddress: "10.0.0.1", userAgent: "claude-code",
        signal: new AbortController().signal,
    };
    const use = () => broker.use({
        ctx, itemRef: "github-api", tool: "vault_http", access: "read", target: "GET api.github.com/user", field: "token",
        check: () => {},
        act: (secret) => {
            acted.push(secret);
            return "sent";
        },
    });
    return { open, audit, acted, use };
};

const assertNothingDone = (env, code) => {
    assert.deepStrictEqual([env.acted, bed.state.secretReads], [[], 0], "neither read nor used");
    const denied = env.audit.find((entry) => entry.action === "vault.use_denied");
    assert.deepStrictEqual(
        [denied.resourceId, denied.details.code, denied.details.stage, denied.details.tool, denied.details.access, denied.details.target],
        [42, code, "after_approval", "vault_http", "read", "GET api.github.com/user"]);
    assert.ok(!env.audit.some((entry) => entry.action === "vault.use"));
};

test("the hosts of an entry change while its approval is open: vault.approval_stale, the value is never read and act never runs", async () => {
    const env = setup();
    const pending = env.use();
    await until(() => env.open.length === 1);
    bed.state.items[0].fields = { ...API.fields, hosts: ["api.github.com", "uploads.github.com"] };
    env.open[0].answer("once");

    await assert.rejects(pending, { code: VaultErrorCode.APPROVAL_STALE });
    assertNothingDone(env, VaultErrorCode.APPROVAL_STALE);
});

test("the key of the caller is revoked while the approval is open: vault.item_unknown, the value is never read and act never runs", async () => {
    const env = setup();
    const pending = env.use();
    await until(() => env.open.length === 1);
    bed.state.apiKeys.clear();
    env.open[0].answer("once");

    await assert.rejects(pending, { code: VaultErrorCode.ITEM_UNKNOWN });
    assertNothingDone(env, VaultErrorCode.ITEM_UNKNOWN);
});
```

- [ ] **Step 6: Tests laufen lassen, sie schlagen fehl**

Run: `node --test server/lib/vault/__tests__/broker.test.js`
Expected: FAIL, die Datei bricht beim Laden ab mit `Error: Cannot find module '../broker'`.

- [ ] **Step 7: `server/lib/vault/broker.js` anlegen**

```js
const { VaultError, VaultErrorCode } = require("./errors");
const { itemRef, findVisibleItem } = require("./visibility");
const { readSecret } = require("./secrets");
const { grantStamp } = require("./approvals");
const VaultItem = require("../../models/VaultItem");
const ApiKey = require("../../models/ApiKey");
const Entry = require("../../models/Entry");
const logger = require("../../utils/logger");

const RATE_AUDIT_WINDOW_MS = 60 * 1000;
const APPROVAL_CODES = new Set([
    VaultErrorCode.APPROVAL_TIMEOUT, VaultErrorCode.APPROVAL_UNAVAILABLE, VaultErrorCode.APPROVAL_PENDING,
    VaultErrorCode.APPROVAL_BUSY, VaultErrorCode.APPROVAL_DENIED, VaultErrorCode.CLIENT_GONE,
]);
const DENIAL_ACTIONS = {
    [VaultErrorCode.ITEM_UNREADABLE]: "vault.item_unreadable",
    [VaultErrorCode.PERSISTENT_NOT_ALLOWED]: "vault.persistent_not_allowed",
};

const defaultAudit = (entry) => require("../../controllers/audit").createAuditLog(entry);
const callerKey = (ctx) => `${ctx.accountId}:${ctx.keyId ?? null}`;
const valueOf = (value, item) => (typeof value !== "function" ? value : item ? value(item) : null);
// Without updatedAt: an edit outside the stamped fields (description, username) does not stop a use the
// user has just approved. Session approvals still end on every edit, their stamp keeps updatedAt.
const useStamp = (item) => grantStamp({ id: item.id, fields: item.fields, updatedAt: 0 });
const staleEntry = () => new VaultError(VaultErrorCode.APPROVAL_STALE);

const createRateLimit = ({ windowMs, limit }) => {
    const calls = new Map();
    return (ctx) => {
        const now = Date.now();
        for (const [key, stamps] of calls) if (stamps.every((at) => now - at >= windowMs)) calls.delete(key);
        const key = callerKey(ctx);
        const recent = (calls.get(key) ?? []).filter((at) => now - at < windowMs);
        if (recent.length >= limit) throw new VaultError(VaultErrorCode.RATE_LIMITED);
        recent.push(now);
        calls.set(key, recent);
    };
};

const createBroker = ({ approvals = require("./approvals"), audit = defaultAudit } = {}) => {
    const rateAudited = new Map();

    const firstRefusalInWindow = (tool, ctx) => {
        const now = Date.now();
        for (const [key, at] of rateAudited) if (now - at >= RATE_AUDIT_WINDOW_MS) rateAudited.delete(key);
        const key = `${tool}:${callerKey(ctx)}`;
        if (rateAudited.has(key)) return false;
        rateAudited.set(key, now);
        return true;
    };

    const entryNameOf = async (agent) => {
        if (!agent?.entryId) return null;
        return (await Entry.findByPk(agent.entryId, { attributes: ["name"] }))?.name ?? null;
    };

    const keyStillValid = async (ctx) => ctx.keyId == null
        || (await ApiKey.count({ where: { id: ctx.keyId, accountId: ctx.accountId, pending: false } })) > 0;

    const record = (ctx, item, action, details) => audit({
        accountId: ctx.accountId,
        organizationId: item?.organizationId ?? null,
        action,
        resource: "vault",
        resourceId: item?.id ?? null,
        details,
        ipAddress: ctx.ipAddress ?? null,
        userAgent: ctx.userAgent ?? null,
    });

    const use = async ({
        ctx, itemRef: ref, tool, access, target = null, scope = access, field, check, act,
        approved = null, precheck = null, stale = staleEntry, deferUse = false, auditExtra = {},
    }) => {
        const caller = { accountId: ctx.accountId, agent: ctx.agent ?? null };
        const note = { item: typeof ref === "string" ? ref.slice(0, 200) : null, stage: "before_approval" };
        let item = null;
        let approval = null;
        let auditedByApprovals = false;
        let result;
        const details = () => ({
            item: note.item, target: valueOf(target, item) ?? null, tool, access, ...auditExtra,
            agentType: ctx.agent?.agentType ?? null, keyId: ctx.keyId ?? null, entryId: ctx.agent?.entryId ?? null,
        });
        const load = async () => {
            item = await findVisibleItem(caller, ref);
            note.item = itemRef(item);
        };
        try {
            if (precheck) await precheck();
            await load();
            const approving = approved === null && (Boolean(item.approvalRequired) || ctx.impersonatorId != null);
            await check(item, { phase: "before", approving });
            const scopeNow = valueOf(scope, item);
            if (approved !== null || approving || String(scopeNow).includes("|")) {
                const expected = approved ?? { itemId: item.id, stamp: useStamp(item) };
                const stampOf = approved ? grantStamp : useStamp;
                if (approved === null) {
                    // Waited for outside every session lock: runAgent allows 90 s, an approval 2 minutes.
                    // So the key, the entry and the tool's checks run again afterwards, with everything as it is now.
                    approval = await approvals.requestApproval({
                        accountId: ctx.accountId, keyId: ctx.keyId ?? null, transportId: ctx.transportId,
                        agentType: ctx.agent?.agentType ?? null, entryName: await entryNameOf(ctx.agent),
                        impersonated: Boolean(ctx.impersonatorId), item, target: valueOf(target, item), tool, access, scope: scopeNow,
                        signal: ctx.signal,
                    }).catch((err) => {
                        // approvals.js audits answers, timeouts and withdrawn cards itself; only early refusals come back unaudited.
                        auditedByApprovals = APPROVAL_CODES.has(err?.code) && !err.details?.early;
                        throw err;
                    });
                }
                note.stage = "after_approval";
                if (ctx.signal?.aborted) throw new VaultError(VaultErrorCode.CLIENT_GONE);
                if (!(await keyStillValid(ctx)))
                    throw new VaultError(VaultErrorCode.ITEM_UNKNOWN, "The key of this connection was revoked while the approval was open; nothing was done.");
                await load();
                if (item.id !== expected.itemId || stampOf(item) !== expected.stamp) throw stale(item);
                await check(item, { phase: "after", approving });
            }
            const secret = await readSecret(item.id, valueOf(field, item));
            if (secret === null) throw new VaultError(VaultErrorCode.NO_SECRET);
            result = await act(secret, item);
        } catch (err) {
            if (!auditedByApprovals && (err?.code !== VaultErrorCode.RATE_LIMITED || firstRefusalInWindow(tool, ctx))) {
                if (err?.code === VaultErrorCode.ITEM_UNREADABLE) logger.warn("Vault entry unreadable", { itemId: item?.id ?? null });
                await record(ctx, item, DENIAL_ACTIONS[err?.code] ?? "vault.use_denied", {
                    ...details(), stage: note.stage, code: typeof err?.code === "string" ? err.code : "INTERNAL",
                });
            }
            throw err;
        }
        const used = item;
        const recordUse = async (more = {}) => {
            try {
                await record(ctx, used, "vault.use", { ...details(), ...more, approval });
            } catch (err) {
                logger.warn("Could not audit a completed vault use", { itemId: used.id, tool, error: err?.name });
            }
            // silent: updatedAt is part of the stamp of a session approval; touching it would end that approval after every use.
            await VaultItem.update({ lastUsedAt: new Date() }, { where: { id: used.id }, silent: true })
                .catch((err) => logger.warn("Could not record the last use of a vault entry", { itemId: used.id, error: err.message }));
        };
        if (deferUse) return { result, approval, item, recordUse };
        await recordUse();
        return { result, approval, item };
    };

    return { use };
};

let shared = null;
const use = (options) => (shared ??= createBroker()).use(options);

module.exports = { createBroker, createRateLimit, use };
```

- [ ] **Step 8: Tests laufen lassen, sie bestehen**

Run: `node --test server/lib/vault/__tests__/broker.test.js`
Expected: PASS, `# tests 2`, `# pass 2`, `# fail 0`.

- [ ] **Step 9: Test-Helfer um die Einstellungen ergänzen, `vault_list`-Test erweitern (failing)**

In `server/lib/vault/__tests__/helpers/vaultBed.js` bekommt `state` das Feld `settings`, und `controllers/vaultSettings` wird ersetzt. `vault_list` (und Task 5) lesen dort `fillAnywhere`.

Ersetze

```js
const state = {
    enabled: true, items: [], secrets: new Map(), permissions: new Set(), memberships: 0,
    orgs: [], entries: new Map(), apiKeys: new Set(), updates: [], secretReads: 0,
};
```

durch

```js
const state = {
    enabled: true, items: [], secrets: new Map(), permissions: new Set(), memberships: 0,
    orgs: [], entries: new Map(), apiKeys: new Set(), updates: [], secretReads: 0, settings: { fillAnywhere: false },
};
```

Füge nach der Zeile `fake("../../../../models/Entry", …);` ein:

```js
fake("../../../../controllers/vaultSettings", {
    getVaultSettings: async () => ({ keyStatus: "active", agentUrl: null, ipBindingDefault: true, ...state.settings }),
});
```

und ersetze `reset` durch:

```js
const reset = ({ items = [], secrets = {}, permissions = [], memberships = 0, orgs = [], entries = [], apiKeys = [], settings = {} } = {}) => {
    Object.assign(state, {
        enabled: true, items, secrets: new Map(Object.entries(secrets)), permissions: new Set(permissions), memberships,
        orgs, entries: new Map(entries.map((entry) => [entry.id, entry])), apiKeys: new Set(apiKeys), updates: [], secretReads: 0,
        settings: { fillAnywhere: false, ...settings },
    });
};
```

In `server/lib/vault/__tests__/mcpProvider.test.js` kommen nach `ORG_API` zwei Einträge dazu:

```js
const GIT_API = {
    id: 43, accountId: 1, organizationId: null, name: "gh-token", type: "api_key", description: null,
    fields: {
        hosts: ["github.com"], headerName: "Authorization", headerTemplate: "Bearer {{secret}}",
        readOnly: true, git: true, gitUsername: "x-access-token", fillOrigins: ["https://github.com"],
    },
    approvalRequired: true, allServers: true,
};
const NOTE = {
    id: 44, accountId: 1, organizationId: null, name: "webhook-secret", type: "generic", description: null,
    fields: {}, approvalRequired: false, allServers: true,
};
```

Der erste Test wird so ersetzt:

```js
test("vault_list names every visible entry without a stored value; organization entries as org:<id>/<name>; usableBy follows type, git and fill origins", async () => {
    const { provider, ctx, text } = setup({ items: [LOGIN, ORG_API, GIT_API, NOTE] });
    const result = await provider.call("vault_list", {}, ctx());

    const serialized = JSON.stringify(result);
    for (const value of [SECRET, "tok-123-secret", "x-access-token"]) assert.ok(!serialized.includes(value), `vault_list leaks ${value}`);
    assert.strictEqual(bed.state.secretReads, 0, "vault_list never decrypts");
    assert.deepStrictEqual(JSON.parse(text(result)), [
        {
            item: "github", owner: "personal", type: "login", description: null, username: "ada",
            origins: ["https://login.test"], approvalRequired: false, usableBy: ["browser_fill_credential"],
        },
        {
            item: "org:3/shop-api", owner: "Shop GmbH", type: "api_key", description: "Shop API", hosts: ["api.shop.test"],
            readOnly: false, allowHttp: false, git: false, fillOrigins: [], approvalRequired: true, usableBy: ["vault_http"],
        },
        {
            item: "gh-token", owner: "personal", type: "api_key", description: null, hosts: ["github.com"],
            readOnly: true, allowHttp: false, git: true, fillOrigins: ["https://github.com"], approvalRequired: true,
            usableBy: ["vault_http", "git", "browser_fill_secret"],
        },
        { item: "webhook-secret", owner: "personal", type: "generic", description: null, fillOrigins: [], approvalRequired: false, usableBy: [] },
    ]);

    bed.state.settings.fillAnywhere = true;
    const anywhere = JSON.parse(text(await provider.call("vault_list", {}, ctx())));
    assert.deepStrictEqual(anywhere.map((entry) => entry.usableBy), [
        ["browser_fill_credential"], ["vault_http", "browser_fill_secret"], ["vault_http", "git", "browser_fill_secret"], ["browser_fill_secret"],
    ], "with fillAnywhere every API key and other entry can be filled in the browser");
});
```

Im Test „without connect.browser …“ stehen künftig auch die Werkzeuge der Platzhalter in der Liste. Der Testname wird zu `"without connect.browser the MCP endpoint lists no browser tool and answers browser_fill_credential as an unknown tool"`, und

```js
    assert.deepStrictEqual(await names(), ["vault_list", "vault_http"]);
```

ersetzt `assert.deepStrictEqual(await names(), ["vault_list"]);`, sowie

```js
    assert.deepStrictEqual(await names(), ["vault_list", "vault_http", FILL, "browser_fill_secret"]);
```

ersetzt `assert.deepStrictEqual(await names(), ["vault_list", FILL]);`.

Run: `node --test server/lib/vault/__tests__/mcpProvider.test.js`
Expected: FAIL, `# fail 2`: Der erste Test scheitert an `deepStrictEqual` (`usableBy: []` statt `["vault_http"]`, `readOnly`/`fillOrigins` fehlen), der Test „without connect.browser …“ an der Werkzeugliste (`["vault_list"]` statt `["vault_list", "vault_http"]`). Die übrigen 4 Tests bestehen.

- [ ] **Step 10: `server/lib/vault/mcpProvider.js` auf Broker und `TOOLS` umbauen**

Die ganze Datei (Stand nach Task 2, mit `approvals.forgetSession`) wird ersetzt durch:

```js
const { VaultError, VaultErrorCode } = require("./errors");
const { isVaultEnabled } = require("./state");
const { itemRef, visibleItems, canUseVault } = require("./visibility");
const { checkFillTarget, fillCredential, assertFillableSession, normalizeOrigin } = require("./fill");
const { createBroker, createRateLimit } = require("./broker");
const { createHttpLimits } = require("./tools/http");
const { getVaultSettings } = require("../../controllers/vaultSettings");
const { defaultAudit } = require("../browser/tools");
const vaultGuard = require("../browser/vaultGuard");
const { BrowserError, BrowserErrorCode } = require("../browser/errors");
const permission = require("../../utils/permission");
const { Permission } = require("../../permissions/registry");
const Organization = require("../../models/Organization");
const logger = require("../../utils/logger");

const LIST = "vault_list";
const FILL = "browser_fill_credential";
const HTTP = "vault_http";
const FILL_SECRET = "browser_fill_secret";
const FILL_WINDOW_MS = 60 * 1000;
const FILL_LIMIT = 20;
const REF_PATTERN = /^e\d{1,9}$/;
const FILLABLE_TYPES = new Set(["api_key", "generic"]);

const textResult = (text) => ({ content: [{ type: "text", text }] });
const errorResult = (err) => ({
    isError: true,
    content: [{ type: "text", text: err instanceof VaultError ? `${err.message} (${err.code})` : err.message }],
});
const fieldsOf = (item) => item.fields ?? {};
const canUseBrowser = (accountId) => permission.hasAccountPermission(accountId, Permission.CONNECT_BROWSER);

const usableBy = (item, fields, { canFill, fillAnywhere }) => {
    const fillable = canFill && ((fields.fillOrigins ?? []).length > 0 || fillAnywhere);
    if (item.type === "login") return canFill ? [FILL] : [];
    if (item.type === "api_key") return [HTTP, ...(fields.git === true ? ["git"] : []), ...(fillable ? [FILL_SECRET] : [])];
    if (item.type === "generic") return fillable ? [FILL_SECRET] : [];
    return [];
};

const describeItem = (item, orgNames, abilities) => {
    const fields = fieldsOf(item);
    return {
        item: itemRef(item),
        owner: item.organizationId ? orgNames.get(item.organizationId) ?? `organization ${item.organizationId}` : "personal",
        type: item.type,
        description: item.description ?? null,
        ...(typeof fields.username === "string" && { username: fields.username }),
        ...(typeof fields.host === "string" && { host: fields.host }),
        ...(Array.isArray(fields.origins) && { origins: fields.origins.map(String) }),
        ...(Array.isArray(fields.hosts) && { hosts: fields.hosts.map(String) }),
        ...(item.type === "api_key" && { readOnly: fields.readOnly === true, allowHttp: fields.allowHttp === true, git: fields.git === true }),
        ...(FILLABLE_TYPES.has(item.type) && { fillOrigins: (fields.fillOrigins ?? []).map(String) }),
        approvalRequired: !!item.approvalRequired,
        usableBy: usableBy(item, fields, abilities),
    };
};

const assertFillArgs = ({ item, passwordRef, usernameRef, sessionId }) => {
    const invalid = (message) => new BrowserError(BrowserErrorCode.INVALID_ARGUMENT, message);
    if (typeof item !== "string" || item.length === 0 || item.length > 200)
        throw invalid("item needs an entry id as vault_list shows it, e.g. github or org:3/shop");
    if (typeof passwordRef !== "string" || !REF_PATTERN.test(passwordRef))
        throw invalid("passwordRef needs the [ref=eN] of the password field from the latest snapshot");
    if (usernameRef != null && (typeof usernameRef !== "string" || !REF_PATTERN.test(usernameRef)))
        throw invalid("usernameRef, if given, needs the [ref=eN] of the username field from the latest snapshot");
    if (sessionId != null && typeof sessionId !== "string") throw invalid("sessionId needs a session id as browser_list shows it");
};

const listItems = async (args, ctx) => {
    const items = await visibleItems({ accountId: ctx.accountId, agent: ctx.agent ?? null });
    const orgIds = [...new Set(items.map((item) => item.organizationId).filter(Boolean))];
    const orgs = orgIds.length > 0 ? await Organization.findAll({ where: { id: orgIds }, attributes: ["id", "name"] }) : [];
    const orgNames = new Map(orgs.map((org) => [org.id, org.name]));
    const canFill = await canUseBrowser(ctx.accountId);
    const fillAnywhere = items.some((item) => FILLABLE_TYPES.has(item.type)) && (await getVaultSettings()).fillAnywhere === true;
    return textResult(items.length > 0
        ? JSON.stringify(items.map((item) => describeItem(item, orgNames, { canFill, fillAnywhere })), null, 2)
        : "No vault entries are available to this connection.");
};

const fillLogin = async (args, ctx, { broker, getBrowserTools, fillRate }) => {
    const usernameRef = args.usernameRef ?? null;
    const refs = { passwordRef: args.passwordRef, usernameRef };
    const seen = { sessionId: null };
    let session = null;
    let origin = null;
    const locate = (sessionId) => {
        session = getBrowserTools().resolveSession(ctx, sessionId);
        seen.sessionId = session.id;
        origin = normalizeOrigin(session.state.url);
    };
    const verify = (item) => {
        assertFillableSession(session);
        return checkFillTarget(session, refs, fieldsOf(item).origins ?? []);
    };
    try {
        const { item } = await broker.use({
            ctx, itemRef: args.item, tool: FILL, access: "write", scope: "fill", field: "password", target: () => origin, auditExtra: seen,
            precheck: () => {
                fillRate(ctx);
                assertFillArgs(args);
            },
            check: async (item, { phase, approving }) => {
                const name = itemRef(item);
                if (item.type !== "login")
                    throw new VaultError(VaultErrorCode.WRONG_TYPE, `${name} is a ${item.type} entry; browser_fill_credential fills login entries only.`);
                if (usernameRef && !fieldsOf(item).username)
                    throw new VaultError(VaultErrorCode.BAD_USERNAME_FIELD, `${name} stores no username; call again without usernameRef.`);
                locate(phase === "before" ? args.sessionId ?? null : session.id);
                // Only so that a wrong field fails before the card opens; act checks again in the runAgent that types.
                if (phase === "before" && approving) await session.runAgent(FILL, () => verify(item));
            },
            stale: (item) => new VaultError(VaultErrorCode.ORIGIN_MISMATCH,
                `The origins of ${itemRef(item)} changed while the approval was open; nothing was filled. Call browser_fill_credential again so the user approves the entry as it is now.`),
            act: (password, item) => session.runAgent(FILL, async () => {
                const nodes = await verify(item);
                await fillCredential(session, { ...nodes, username: usernameRef ? fieldsOf(item).username : null, password });
            }),
        });
        return textResult(usernameRef ? `Filled username and password of ${itemRef(item)}.` : `Filled password of ${itemRef(item)}.`);
    } catch (err) {
        if (session && typeof err?.message === "string") err.message = vaultGuard.redactText(session.contextKey, err.message);
        throw err;
    }
};

const TOOLS = {
    [LIST]: {
        def: {
            name: LIST,
            description: "List the vault entries this connection may use. Never returns a secret value: per entry its id for the vault tools (item), owner, type, username or host, origins or hosts, whether the user approves each use, and the tools that can use it (usableBy).",
            inputSchema: { type: "object", properties: {} },
        },
        handler: listItems,
        needsBrowser: false,
    },
    [HTTP]: require("./tools/http"),
    [FILL]: {
        def: {
            name: FILL,
            description: "Type a login entry from the vault into the password field, and optionally the username field, of a browser session. You never see the password: snapshots show it as ••••, and browser_evaluate stays locked in this browser context afterwards. The field's frame and all frames around it must be one of the entry's origins. If the entry needs approval, this call waits up to 2 minutes for the user.",
            inputSchema: {
                type: "object",
                properties: {
                    item: { type: "string", description: "Entry id as vault_list shows it, e.g. github or org:3/shop" },
                    passwordRef: { type: "string", description: "ref of the <input type=password> from the latest snapshot" },
                    usernameRef: { type: "string", description: "ref of the username field (text, email or tel input); optional" },
                    sessionId: { type: "string", description: "Browser session id. Defaults to the session this connection opened last; may be left out while only one session is open." },
                },
                required: ["item", "passwordRef"],
            },
        },
        handler: fillLogin,
        needsBrowser: true,
    },
    [FILL_SECRET]: require("./tools/fillSecret"),
};

const createVaultProvider = ({ getBrowserTools, approvals = require("./approvals"), audit = defaultAudit }) => {
    const browserAllowed = new WeakMap();
    const deps = {
        broker: createBroker({ approvals, audit }),
        getBrowserTools,
        approvals,
        fillRate: createRateLimit({ windowMs: FILL_WINDOW_MS, limit: FILL_LIMIT }),
        httpLimits: createHttpLimits(),
    };
    const offered = (name, browser) => Object.hasOwn(TOOLS, name) && (!TOOLS[name].needsBrowser || browser);

    return {
        name: "vault",
        available: async (ctx) => {
            if (!isVaultEnabled()) return false;
            const [canUse, browser] = await Promise.all([canUseVault(ctx.accountId), canUseBrowser(ctx.accountId)]);
            browserAllowed.set(ctx, browser);
            return canUse;
        },
        list: (ctx) => Object.keys(TOOLS).filter((name) => offered(name, browserAllowed.get(ctx) === true)).map((name) => TOOLS[name].def),
        has: (name, ctx) => offered(name, browserAllowed.get(ctx) === true),
        call: async (name, args, ctx) => {
            try {
                const tool = Object.hasOwn(TOOLS, name) ? TOOLS[name] : null;
                if (!tool || (tool.needsBrowser && !(await canUseBrowser(ctx.accountId))))
                    throw new BrowserError(BrowserErrorCode.INVALID_ARGUMENT, `Unknown tool: ${name}`);
                return await tool.handler(args ?? {}, ctx, deps);
            } catch (err) {
                if (err instanceof VaultError || err instanceof BrowserError) return errorResult(err);
                logger.warn("Vault tool failed", { tool: name, error: err.message });
                return errorResult(new BrowserError(BrowserErrorCode.INTERNAL, `${name} failed unexpectedly; try again.`));
            }
        },
        forgetTransport: (transportId) => approvals.forgetSession(transportId),
    };
};

module.exports = { createVaultProvider };
```

Platzhalter, damit `TOOLS` schon beide Werkzeuge der Welle C kennt. Task 4 und Task 5 ersetzen diese Dateien vollständig.

`server/lib/vault/tools/http.js`:

```js
module.exports = {
    def: { name: "vault_http", description: "", inputSchema: { type: "object", properties: {} } },
    handler: async () => { throw new Error("not implemented"); },
    needsBrowser: false,
    createHttpLimits: () => ({ rate: () => {}, enter: () => null, leave: () => {} }),
};
```

`server/lib/vault/tools/fillSecret.js`:

```js
module.exports = {
    def: { name: "browser_fill_secret", description: "", inputSchema: { type: "object", properties: {} } },
    handler: async () => { throw new Error("not implemented"); },
    needsBrowser: true,
};
```

Was gleich bleibt, Punkt für Punkt gegen den bisherigen `fill`, damit der Umbau keine Verhaltensänderung bringt:
- Drossel und Argumentprüfung laufen wie bisher vor dem Laden (`precheck`), und wie bisher zählt jeder Aufruf, auch einer mit ungültigen Argumenten. Ihre Ablehnungen gehen wie bisher mit gekürztem `item` ins Audit, `vault.rate_limited` höchstens einmal je Werkzeug, Aufrufer und Minute.
- Ohne Freigabe gibt es genau ein `runAgent` (Prüfen und Eintragen). Mit Freigabe gibt es eines vor der Karte (nur Prüfen) und nach der Karte wie bisher eines, in dem `assertFillableSession`, `checkFillTarget` und `fillCredential` zusammen laufen.
- Nach der Freigabe in derselben Reihenfolge wie bisher: Abbruch → `vault.client_gone`, Key widerrufen → `vault.item_unknown`, Eintrag neu laden, geänderte `origins` → `vault.origin_mismatch` (über `stale`, denn für Logins enthält der Stempel ohne `updatedAt` nur die `origins`), Sitzung neu auflösen, Ziel neu setzen.
- Neu ist nur: Der Broker liest das Passwort unmittelbar vor `act` statt innerhalb von `runAgent`. Der Wert ist dadurch etwas früher im Speicher, gelesen wird er nur, wenn alle Prüfungen vor `act` bestanden sind.

- [ ] **Step 11: Betroffene Tests laufen lassen, sie bestehen**

Run: `node --test server/lib/vault/__tests__/redact.test.js server/lib/vault/__tests__/broker.test.js server/lib/vault/__tests__/mcpProvider.test.js server/lib/browser/__tests__/vaultGuard.test.js server/lib/browser/__tests__/tools.test.js server/lib/mcp/__tests__/mcpRoute.test.js server/lib/browser/__tests__/chromium.e2e.test.js`
Expected: PASS, `# fail 0`. `mcpProvider.test.js` meldet `# pass 6`: die vier unveränderten Tests von `browser_fill_credential` grün, dazu der erweiterte `vault_list`-Test und der Listen-Test mit den neuen Werkzeugnamen. `chromium.e2e.test.js` lädt und überspringt ohne `OUTPOST_BROWSER_E2E_LAUNCHER`.

Run: `node -e "require('./server/routes/mcp')"` (aus `/root/outpost`)
Expected: kein Fehler (Route lädt mit Broker, `controllers/vaultSettings` und echtem `approvals`).

Run: `yarn lint`
Expected: keine Fehler in `server/lib/vault/redact.js`, `server/lib/vault/broker.js`, `server/lib/vault/mcpProvider.js`, `server/lib/vault/tools/*.js`, `server/lib/browser/vaultGuard.js` und den Testdateien.

- [ ] **Step 12: Commit**

```bash
git add server/lib/vault/redact.js server/lib/vault/broker.js server/lib/vault/mcpProvider.js server/lib/vault/tools/http.js \
    server/lib/vault/tools/fillSecret.js server/lib/browser/vaultGuard.js \
    server/lib/vault/__tests__/redact.test.js server/lib/vault/__tests__/broker.test.js server/lib/vault/__tests__/mcpProvider.test.js \
    server/lib/vault/__tests__/helpers/vaultBed.js
git commit -m "Vault: Vermittlungskern, Schwärzung und Werkzeug-Tabelle, browser_fill_credential über den Broker"
```

---

### Task 4: `vault_http`

**Files:**
- Modify: `server/lib/vault/tools/http.js` (Platzhalter aus Task 3 vollständig ersetzen)
- Modify: `server/index.js` (globaler `express.json()` überspringt `/api/mcp`; `/api/mcp` liest Bodies bis 2 MB erst nach `authenticate`)
- Test: `server/lib/vault/__tests__/vaultHttp.test.js` (neu)
- Unverändert in Task 4: `server/lib/vault/mcpProvider.js` und `server/lib/vault/__tests__/mcpProvider.test.js` (Task 3 hat `[HTTP]` in `TOOLS` und die Werkzeuglisten schon eingetragen; Welle C teilt keine Datei).

**Interfaces:**
- Consumes: Task 3 (`broker.use`, `secretVariants`, `truncateAndRedact`, `TOOLS`), Task 1 (Felder, Codes).
- Produces: MCP-Werkzeug `vault_http({ item, method, url, headers?, body? })` → Text `HTTP <status>\n<header>: <wert>…\n\n<body>`.

**Design:** kein UI-Anteil.

**Tests:** 5 Tests gegen zwei lokale HTTP-Server (`node:http` auf 127.0.0.1, `allowHttp: true` im Eintrag) — (1) Header wird eingesetzt; der Server wiederholt Token und Header-Wert in Body, `location` und einem Header, der Agent sieht `••••`; (2) Weiterleitung auf den zweiten Server (andere Origin) kommt als 3xx zurück, der zweite Server sieht keine Anfrage (Review Focus 1); Weiterleitung auf dieselbe Origin wird verfolgt; (3) Ablehnungen in einer Tabelle: fremder Host, `readOnly` + POST, `http:` ohne `allowHttp`, verbotener Header, GET mit Body → jeweils Code; (4) Body > 256 KB wird gekürzt; (5) Freigabe: GET mit Sitzungsfreigabe, danach POST öffnet neue Karte mit `access: "write"`.

**Parallel:** Task 5, Task 7 (Welle C).

- [ ] **Step 1: Failing tests schreiben**

`server/lib/vault/__tests__/vaultHttp.test.js`. Test (5) läuft mit dem echten `approvals.js` (Task 2) über die Naht: Karten aus `listOpenApprovals`, Antworten über `answerApproval`. Dessen Audit wird wie in `approvals.test.js` vor dem Laden ersetzt.

```js
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const bed = require("./helpers/vaultBed");
// approvals.js destructures createAuditLog when it loads; the in-memory database has no tables.
require("../../../controllers/audit").createAuditLog = async () => {};
const stateBroadcaster = require("../../StateBroadcaster");
const approvals = require("../approvals");
const { Permission } = require("../../../permissions/registry");
const { createVaultProvider } = require("../mcpProvider");

const TOKEN = "ghp_test token/42";
const LIMIT = 256 * 1024;

const until = async (condition) => {
    for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(condition(), "condition not reached");
};

const listen = async (t, handle) => {
    const seen = [];
    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
            seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization ?? null, body });
            handle(req, res);
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    const host = `127.0.0.1:${server.address().port}`;
    return { seen, host, base: `http://${host}` };
};

const setup = async (t, { approvalRequired = false } = {}) => {
    const b = await listen(t, (req, res) => res.end("other origin"));
    const a = await listen(t, (req, res) => {
        const path = new URL(req.url, "http://local").pathname;
        if (path === "/echo") {
            res.writeHead(200, {
                "content-type": "application/json", etag: `"${TOKEN}"`, location: `/next?t=${encodeURIComponent(TOKEN)}`,
                "x-secret": TOKEN, "set-cookie": `s=${encodeURIComponent(TOKEN)}`,
            });
            return res.end(JSON.stringify({ authorization: req.headers.authorization, again: TOKEN, percent: encodeURIComponent(TOKEN) }));
        }
        if (path === "/hop") return res.writeHead(302, { location: "/echo" }).end();
        if (path === "/away") return res.writeHead(302, { location: `${b.base}/steal` }).end();
        if (path === "/big") return res.writeHead(200, { "content-type": "text/plain" }).end(`${"a".repeat(LIMIT - 5)}${TOKEN}${"b".repeat(1000)}`);
        res.writeHead(201, { "content-type": "application/json" }).end('{"created":true}');
    });
    const item = (id, name, fields) => ({
        id, accountId: 1, organizationId: null, name, type: "api_key", description: null, updatedAt: "2026-10-10T08:00:00.000Z",
        fields: { hosts: [a.host], headerName: "Authorization", headerTemplate: "Bearer {{secret}}", allowHttp: true, ...fields },
        approvalRequired, allServers: true,
    });
    bed.reset({
        items: [item(51, "api", {}), item(52, "api-ro", { readOnly: true }), item(53, "api-tls", { allowHttp: false })],
        secrets: { "51:token": TOKEN, "52:token": TOKEN, "53:token": TOKEN },
        permissions: [Permission.VAULT_USE],
    });
    approvals._resetForTests();
    const audit = [];
    const provider = createVaultProvider({ getBrowserTools: () => null, approvals, audit: async (entry) => { audit.push(entry); } });
    const ctx = {
        accountId: 1, keyId: null, agent: null, impersonatorId: null, transportId: "T1", ipAddress: "10.0.0.1", userAgent: "claude-code",
        signal: new AbortController().signal,
    };
    const call = (args) => provider.call("vault_http", args, ctx);
    const text = (result) => result.content.map((c) => c.text).join("");
    return { a, b, audit, call, text };
};

test("vault_http sets the entry's header and blanks the token wherever the response repeats it; the audit has method, host and path without query", async (t) => {
    const env = await setup(t);
    const result = await env.call({ item: "api", method: "GET", url: `${env.a.base}/echo?per_page=5` });
    const shown = env.text(result);

    assert.strictEqual(result.isError, undefined, shown);
    assert.strictEqual(env.a.seen[0].authorization, `Bearer ${TOKEN}`);
    assert.match(shown, /^HTTP 200\n/);
    assert.ok(shown.split("\n").includes('etag: "••••"'), shown);
    assert.ok(shown.split("\n").includes("location: /next?t=••••"), shown);
    assert.ok(!/set-cookie|x-secret/.test(shown), "only the listed headers reach the agent");
    for (const leak of [TOKEN, encodeURIComponent(TOKEN), "ghp_test"]) assert.ok(!shown.includes(leak), `the agent sees ${leak}`);
    const use = env.audit.find((entry) => entry.action === "vault.use");
    assert.deepStrictEqual([use.details.tool, use.details.access, use.details.method, use.details.host, use.details.path, use.details.status],
        ["vault_http", "read", "GET", env.a.host, "/echo", 200]);
    assert.ok(!/per_page|ghp_test/.test(JSON.stringify(env.audit)), "no query and no token in the audit");
});

test("a redirect to another origin comes back as it is and the other host is never called; one on the same origin is followed", async (t) => {
    const env = await setup(t);
    const away = env.text(await env.call({ item: "api", method: "GET", url: `${env.a.base}/away` }));
    assert.match(away, /^HTTP 302\n/);
    assert.ok(away.split("\n").includes(`location: ${env.b.base}/steal`), away);
    assert.deepStrictEqual(env.b.seen, []);

    const hop = env.text(await env.call({ item: "api", method: "GET", url: `${env.a.base}/hop` }));
    assert.match(hop, /^HTTP 200\n/);
    assert.deepStrictEqual(env.a.seen.map((request) => [request.url, request.authorization]),
        [["/away", `Bearer ${TOKEN}`], ["/hop", `Bearer ${TOKEN}`], ["/echo", `Bearer ${TOKEN}`]]);
});

test("vault_http refuses before reading the token: foreign host, write on a read-only entry, http without allowHttp, forbidden headers, a body with GET", async (t) => {
    const env = await setup(t);
    const cases = [
        [{ item: "api", method: "GET", url: `${env.b.base}/x` }, "vault.host_not_allowed"],
        [{ item: "api-ro", method: "POST", url: `${env.a.base}/issues`, body: "{}" }, "vault.read_only"],
        [{ item: "api-tls", method: "GET", url: `${env.a.base}/echo` }, "vault.http_not_allowed"],
        [{ item: "api", method: "GET", url: `${env.a.base}/echo`, headers: { Cookie: "a=b" } }, "vault.header_not_allowed"],
        [{ item: "api", method: "GET", url: `${env.a.base}/echo`, headers: { "Proxy-Authorization": "Basic eDp5" } }, "vault.header_not_allowed"],
        [{ item: "api", method: "GET", url: `${env.a.base}/echo`, body: "q=1" }, "vault.bad_body"],
    ];
    for (const [args, code] of cases) {
        const result = await env.call(args);
        assert.strictEqual(result.isError, true, code);
        assert.ok(env.text(result).endsWith(`(${code})`), `${code}: ${env.text(result)}`);
    }
    assert.deepStrictEqual([env.a.seen, env.b.seen, bed.state.secretReads], [[], [], 0]);
    assert.deepStrictEqual(env.audit.map((entry) => [entry.action, entry.details.code]), cases.map(([, code]) => ["vault.use_denied", code]));
});

test("a text body over 256 KB is cut on the limit without leaving the start of the token behind", async (t) => {
    const env = await setup(t);
    const shown = env.text(await env.call({ item: "api", method: "GET", url: `${env.a.base}/big` }));
    assert.strictEqual(shown.slice(shown.indexOf("\n\n") + 2), `${"a".repeat(LIMIT - 5)}\n[truncated after ${LIMIT} bytes]`);
});

test("a session approval for reading does not cover writing: the next GET goes without a card, a POST opens its own with access write", { timeout: 5000 }, async (t) => {
    const env = await setup(t, { approvalRequired: true });
    const ws = { readyState: 1, send: () => {} };
    stateBroadcaster.register(1, "vault-http-window", ws);
    t.after(() => stateBroadcaster.unregister(1, ws));
    const cards = () => approvals.listOpenApprovals(1);
    const get = () => env.call({ item: "api", method: "GET", url: `${env.a.base}/echo` });

    const first = get();
    await until(() => cards().length === 1);
    assert.deepStrictEqual([cards()[0].tool, cards()[0].access, cards()[0].target], ["vault_http", "read", `GET ${env.a.host}/echo`]);
    approvals.answerApproval(cards()[0].id, 1, "session");
    assert.match(env.text(await first), /^HTTP 200\n/);
    assert.match(env.text(await get()), /^HTTP 200\n/, "the session approval covers the next read");

    const post = env.call({ item: "api", method: "POST", url: `${env.a.base}/issues`, body: '{"title":"x"}', headers: { "Content-Type": "application/json" } });
    await until(() => cards().length === 1);
    assert.deepStrictEqual([cards()[0].access, cards()[0].target], ["write", `POST ${env.a.host}/issues`]);
    approvals.answerApproval(cards()[0].id, 1, "once");
    assert.match(env.text(await post), /^HTTP 201\n/);
    assert.deepStrictEqual(env.a.seen.map((request) => request.method), ["GET", "GET", "POST"]);
});
```

- [ ] **Step 2: Tests laufen lassen, sie schlagen fehl**

Run: `node --test server/lib/vault/__tests__/vaultHttp.test.js`
Expected: FAIL, `# fail 5`. Jeder Aufruf antwortet mit `vault_http failed unexpectedly; try again.` (der Platzhalter aus Task 3 wirft), Test (5) scheitert an `condition not reached`.

- [ ] **Step 3: `server/lib/vault/tools/http.js` schreiben (ersetzt den Platzhalter)**

Hinweis: Node-`fetch` und `node:https` nutzen `HTTP_PROXY`/`HTTPS_PROXY` nur mit `NODE_USE_ENV_PROXY=1`. Outpost setzt das nicht, Anfragen von `vault_http` gehen also ohne Proxy-Umgebung direkt zum Host.

```js
const { VaultError, VaultErrorCode, VaultErrorMessage } = require("../errors");
const { itemRef } = require("../visibility");
const { createRateLimit } = require("../broker");
const { secretVariants, redactSecretText, truncateAndRedact } = require("../redact");

const NAME = "vault_http";
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const READS = new Set(["GET", "HEAD"]);
const FORBIDDEN_HEADERS = new Set([
    "authorization", "cookie", "host", "content-length", "transfer-encoding", "connection", "keep-alive", "upgrade", "expect", "te", "trailer",
]);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEADER_VALUE_INVALID = /[^\t\x20-\x7e\x80-\xff]/;
const URL_LIMIT = 8 * 1024;
const HEADERS_LIMIT = 8 * 1024;
const MAX_HEADERS = 30;
const BODY_LIMIT = 1024 * 1024;
const RESPONSE_LIMIT = 256 * 1024;
const TIMEOUT_MS = 30 * 1000;
const MAX_REDIRECTS = 5;
const MAX_RUNNING = 4;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const SHOWN_HEADERS = new Set(["content-type", "content-length", "location", "link", "etag", "last-modified", "retry-after", "x-github-request-id"]);
const TEXT_TYPE = /^text\/|json|xml|javascript|x-www-form-urlencoded/i;
// fetch decodes exactly these; any other encoding would reach the redaction still compressed.
const DECODED_ENCODINGS = new Set(["", "identity", "gzip", "x-gzip", "deflate", "br"]);

const def = {
    name: NAME,
    description: "Call an HTTP API with a vault API key. Outpost sends the request itself and sets the entry's header; you never see the token, and it is replaced by •••• wherever the response repeats it. Only the entry's hosts, https unless the entry allows http, GET/HEAD only for read-only entries. Writes (POST, PUT, PATCH, DELETE) need their own approval. Prefer this over curl or gh with a token.",
    inputSchema: {
        type: "object",
        properties: {
            item: { type: "string", description: "Entry id as vault_list shows it, e.g. github-api or org:3/shop-api" },
            method: { type: "string", enum: [...METHODS] },
            url: { type: "string", description: "Absolute https URL (http only if the entry allows it) on one of the entry's hosts" },
            headers: { type: "object", additionalProperties: { type: "string" }, description: "Additional request headers; Outpost sets authentication, Host, Cookie, Content-Length and hop-by-hop headers itself" },
            body: { type: "string", description: "Request body, at most 1 MB; not allowed with GET or HEAD" },
        },
        required: ["item", "method", "url"],
    },
};

const textResult = (text) => ({ content: [{ type: "text", text }] });
const callerKey = (ctx) => `${ctx.accountId}:${ctx.keyId ?? null}`;

const createHttpLimits = () => {
    const running = new Map();
    return {
        rate: createRateLimit({ windowMs: 60 * 1000, limit: 60 }),
        enter: (ctx) => {
            const key = callerKey(ctx);
            const count = running.get(key) ?? 0;
            if (count >= MAX_RUNNING) throw new VaultError(VaultErrorCode.BUSY);
            running.set(key, count + 1);
            return key;
        },
        leave: (key) => {
            const count = (running.get(key) ?? 1) - 1;
            if (count > 0) running.set(key, count);
            else running.delete(key);
        },
    };
};

const parseUrl = (value) => {
    if (typeof value !== "string" || Buffer.byteLength(value) > URL_LIMIT) return null;
    try {
        const url = new URL(value);
        return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password ? url : null;
    } catch {
        return null;
    }
};

const headerProblem = (headers, entryHeader) => {
    if (headers == null) return null;
    if (typeof headers !== "object" || Array.isArray(headers)) return "shape";
    const entries = Object.entries(headers);
    if (entries.length > MAX_HEADERS) return "shape";
    let size = 0;
    for (const [name, value] of entries) {
        if (!HEADER_NAME.test(name) || typeof value !== "string" || HEADER_VALUE_INVALID.test(value)) return "shape";
        size += Buffer.byteLength(name) + Buffer.byteLength(value);
        const lower = name.toLowerCase();
        if (FORBIDDEN_HEADERS.has(lower) || lower.startsWith("proxy-") || lower === entryHeader.toLowerCase()) return "forbidden";
    }
    return size > HEADERS_LIMIT ? "shape" : null;
};

const assertRequest = (item, { url, method, headers, body }) => {
    const fields = item.fields ?? {};
    if (item.type !== "api_key")
        throw new VaultError(VaultErrorCode.WRONG_TYPE, `${itemRef(item)} is a ${item.type} entry; vault_http uses API key entries only.`);
    if (!url) throw new VaultError(VaultErrorCode.BAD_URL);
    if (url.protocol === "http:" && fields.allowHttp !== true) throw new VaultError(VaultErrorCode.HTTP_NOT_ALLOWED);
    if (!(fields.hosts ?? []).some((host) => String(host).toLowerCase() === url.host)) throw new VaultError(VaultErrorCode.HOST_NOT_ALLOWED);
    if (!METHODS.has(method)) throw new VaultError(VaultErrorCode.BAD_METHOD);
    if (fields.readOnly === true && !READS.has(method)) throw new VaultError(VaultErrorCode.READ_ONLY);
    const problem = headerProblem(headers, fields.headerName ?? "Authorization");
    if (problem === "shape")
        throw new VaultError(VaultErrorCode.HEADER_NOT_ALLOWED,
            "headers must be an object of at most 30 headers with token names and single-line string values, at most 8 KB together.");
    if (problem) throw new VaultError(VaultErrorCode.HEADER_NOT_ALLOWED);
    if (body != null && (typeof body !== "string" || READS.has(method) || Buffer.byteLength(body) > BODY_LIMIT))
        throw new VaultError(VaultErrorCode.BAD_BODY);
};

const sameOrigin = (location, base) => {
    if (!location) return null;
    try {
        const next = new URL(location, base);
        return next.origin === base.origin ? next : null;
    } catch {
        return null;
    }
};

// Only redirects on the same origin are followed: the token must never reach another host.
const send = async ({ url, method, headers, body, signal }) => {
    let current = url;
    let currentMethod = method;
    let currentBody = body;
    const request = () => fetch(current, { method: currentMethod, headers, body: currentBody, redirect: "manual", signal });
    let response = await request();
    for (let hop = 0; hop < MAX_REDIRECTS; hop += 1) {
        const next = REDIRECTS.has(response.status) ? sameOrigin(response.headers.get("location"), current) : null;
        if (!next) break;
        await response.body?.cancel();
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentMethod === "POST")) {
            currentMethod = currentMethod === "HEAD" ? "HEAD" : "GET";
            currentBody = undefined;
        }
        current = next;
        response = await request();
    }
    return response;
};

const readCapped = async (response, limit) => {
    const chunks = [];
    let size = 0;
    if (response.body) {
        for await (const chunk of response.body) {
            chunks.push(chunk);
            size += chunk.length;
            if (size >= limit) break;
        }
    }
    return Buffer.concat(chunks).subarray(0, limit);
};

const isText = (headers) => {
    const type = headers.get("content-type") ?? "";
    const charset = /charset\s*=\s*"?([^";\s]+)/i.exec(type)?.[1]?.toLowerCase() ?? "utf-8";
    const encoding = (headers.get("content-encoding") ?? "").trim().toLowerCase();
    return TEXT_TYPE.test(type) && (charset === "utf-8" || charset === "utf8") && DECODED_ENCODINGS.has(encoding);
};

const bodyText = (headers, raw, size, variants) => {
    if (raw.length === 0) return "";
    if (!isText(headers)) return `[binary body, ${redactSecretText(headers.get("content-type") ?? "", variants) || "no content type"}, ${size}]`;
    return truncateAndRedact(raw.toString("utf8"), RESPONSE_LIMIT, variants).text;
};

const formatResponse = (response, raw, size, variants) => {
    const lines = [`HTTP ${response.status}`];
    for (const [name, value] of response.headers)
        if (SHOWN_HEADERS.has(name) || name.startsWith("x-ratelimit-")) lines.push(`${name}: ${redactSecretText(value, variants)}`);
    return `${lines.join("\n")}\n\n${bodyText(response.headers, raw, size, variants)}`;
};

const failure = (err, ctx) => {
    if (ctx.signal?.aborted) return new VaultError(VaultErrorCode.CLIENT_GONE);
    const code = String(err?.cause?.code ?? err?.code ?? "");
    const kind = err?.name === "TimeoutError" ? "timeout" : /CERT|TLS|SSL|UNABLE_TO_VERIFY/.test(code) ? "TLS" : "connection";
    return new VaultError(VaultErrorCode.HTTP_FAILED, VaultErrorMessage[VaultErrorCode.HTTP_FAILED].replace("<kind>", kind));
};

const handler = async (args, ctx, { broker, httpLimits }) => {
    const method = typeof args.method === "string" ? args.method.toUpperCase() : "";
    const url = parseUrl(args.url);
    const details = { method: method.slice(0, 10) || null, host: url?.host ?? null, path: url ? url.pathname.slice(0, 200) : null };
    let entered = null;
    try {
        const { result } = await broker.use({
            ctx, itemRef: args.item, tool: NAME, access: READS.has(method) ? "read" : "write", field: "token", auditExtra: details,
            target: url ? `${method} ${url.host}${url.pathname}`.slice(0, 200) : null,
            precheck: () => httpLimits.rate(ctx),
            check: (item) => assertRequest(item, { url, method, headers: args.headers, body: args.body }),
            act: async (token, item) => {
                // Taken only now: a call waiting for the user's approval does not hold one of the 4 slots.
                entered = httpLimits.enter(ctx);
                if (token.length < 4) throw new VaultError(VaultErrorCode.SECRET_TOO_SHORT);
                const fields = item.fields ?? {};
                const headerValue = (fields.headerTemplate ?? "Bearer {{secret}}").split("{{secret}}").join(token);
                const variants = secretVariants({ token, headerValue });
                // The 30 s start after the approval: the wait for the user is not part of the call.
                const signal = AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...(ctx.signal ? [ctx.signal] : [])]);
                try {
                    details.sent = true;
                    const response = await send({
                        url, method, body: args.body ?? undefined, signal,
                        headers: { ...(args.headers ?? {}), [fields.headerName ?? "Authorization"]: headerValue },
                    });
                    const raw = await readCapped(response, RESPONSE_LIMIT + 1);
                    const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
                    const bytes = Number.isSafeInteger(declared) && declared >= 0 ? declared : raw.length > RESPONSE_LIMIT ? null : raw.length;
                    Object.assign(details, { status: response.status, bytes });
                    return textResult(formatResponse(response, raw, bytes === null ? `more than ${RESPONSE_LIMIT} bytes` : `${bytes} bytes`, variants));
                } catch (err) {
                    if (err instanceof VaultError) throw err;
                    throw failure(err, ctx);
                }
            },
        });
        return result;
    } finally {
        if (entered) httpLimits.leave(entered);
    }
};

module.exports = { def, handler, needsBrowser: false, createHttpLimits };
```

Ein `vault.use_denied` mit `vault.http_failed` und `sent: true` heißt: die Anfrage ging mit dem Token hinaus, die Antwort kam nicht an.

Ohne `content-length` und mit einem Body über 256 KB steht im Audit `bytes: null`, und eine binäre Antwort meldet `more than 262144 bytes`.

- [ ] **Step 4: Body-Grenze für `/api/mcp` erst nach der Authentifizierung**

In `server/index.js` wird die Zeile `app.use(express.json());` ersetzt durch:

```js
// /api/mcp reads its larger bodies itself, after authenticate: nobody unauthenticated gets 2 MB parsed.
const json = express.json();
app.use((req, res, next) => (req.path === "/api/mcp" || req.path.startsWith("/api/mcp/") ? next() : json(req, res, next)));
```

und die Einhängung `app.use("/api/mcp", authenticate, require("./routes/mcp"));` durch:

```js
app.use("/api/mcp", authenticate, express.json({ limit: "2mb" }), require("./routes/mcp"));
```

- [ ] **Step 5: Tests laufen lassen, sie bestehen**

Run: `node --test server/lib/vault/__tests__/vaultHttp.test.js server/lib/vault/__tests__/mcpProvider.test.js server/lib/vault/__tests__/broker.test.js server/lib/mcp/__tests__/mcpRoute.test.js`
Expected: PASS, `# fail 0`. Davon `vaultHttp.test.js` `# pass 5`.

Run: `grep -n 'express.json\|"/api/mcp"' server/index.js`
Expected: drei Treffer, in dieser Reihenfolge: `const json = express.json();`, die Zeile mit `req.path === "/api/mcp"` und `app.use("/api/mcp", authenticate, express.json({ limit: "2mb" }), require("./routes/mcp"));`. Ein `app.use(express.json());` gibt es nicht mehr.

Run: `yarn lint`
Expected: keine Fehler in `server/lib/vault/tools/http.js`, `server/index.js` und `server/lib/vault/__tests__/vaultHttp.test.js`.

- [ ] **Step 6: Commit**

```bash
git add server/lib/vault/tools/http.js server/index.js server/lib/vault/__tests__/vaultHttp.test.js
git commit -m "Vault: Werkzeug vault_http"
```

### Task 5: `browser_fill_secret`

**Files:**
- Modify: `server/lib/vault/tools/fillSecret.js` (Stub aus Task 3 vollständig ersetzen; Task 3 hat `[FILL_SECRET]` bereits in `TOOLS` eingetragen und die Werkzeuglisten in `mcpProvider.test.js` angepasst — `mcpProvider.js` und `mcpProvider.test.js` bleiben in Task 5 unberührt)
- Modify: `server/lib/vault/fill.js` (`checkSecretTarget(session, ref, origins | null)`, `typeInto` exportieren)
- Test: `server/lib/browser/__tests__/vaultGuard.test.js` (CDP-Double erweitern) oder `server/lib/vault/__tests__/fillSecret.test.js` (neu) mit demselben Double

**Interfaces:**
- Consumes: Task 3 (`broker.use`, `TOOLS`), Task 1 (`fillOrigins`, `fillAnywhere`, Codes), Bestand `vaultGuard.markFilled`, `assertFillableSession`.
- Produces: MCP-Werkzeug `browser_fill_secret({ item, ref, sessionId? })` → `Filled the value of <item> into the field.`

**Design:** kein UI-Anteil.

**Tests:** 4 Tests — (1) passende Origin → eingetragen, `markFilled` vor `Input.insertText`, Snapshot zeigt `••••`; (2) Ablehnungen: `<textarea>` in iframe erlaubter Origin unter fremder Hauptseite → `vault.origin_mismatch` (Review Focus 5), `<select>` → `vault.field_not_fillable`, leere `fillOrigins` bei `fillAnywhere` aus → `vault.no_fill_origins`; (3) `text`-Feld gefüllt → `browser_screenshot` gesperrt; (4) `fillAnywhere` an, Eintrag ohne Freigabepflicht → Karte trotzdem, Umfang `fill|<origin>`.

**Parallel:** Task 4, Task 7 (Welle C).

Gewählt ist die neue Datei `server/lib/vault/__tests__/fillSecret.test.js`: `vaultGuard.test.js` bleibt unberührt (kein Konflikt mit anderen Tasks). Das Double ist dasselbe wie dort (`helpers/fakeCdp.js`, echter `BrowserPool`, echte `BrowserSession`, echte `createBrowserTools`), ergänzt um die Antworten, die `fill.js` braucht (Muster `mcpProvider.test.js`: `Runtime.callFunctionOn` liefert das `INSPECT`-Ergebnis je Knoten, `DOM.focus`/`DEEPEST_ACTIVE` für die Fokusprüfung). Einträge, Werte, Rechte und `fillAnywhere` kommen aus `helpers/vaultBed.js` (`bed.state.settings`, dort ersetzt Task 3 `controllers/vaultSettings`), die Freigaben per Attrappe wie in `mcpProvider.test.js`. Über die Naht `createVaultProvider().call("browser_fill_secret", …)` laufen damit echter Broker (Task 3), echte `fill.js`, echter `vaultGuard`. Test 2 fängt auch einen Fehler in den Funktionen für `target`/`scope`: Der Broker ruft `target(item)` beim Audit einer Ablehnung, sobald der Eintrag geladen ist, auch wenn `check` vor dem Feld gescheitert ist; ein `field.origin` ohne `?.` würfe dort einen `TypeError`, die `VaultError` und ihr `vault.use_denied` gingen verloren.

Nicht getestet: die Argumentprüfung (Whitelist wie `assertFillArgs`, SEC-INPUT-01; reine Eingabeformate), `vault.wrong_type` (eine Zeile, Muster aus `browser_fill_credential`), der gemeinsame Zähler (`deps.fillRate` im `precheck`; Grenze und einmaliges Audit je Minute testet Task 3 über den bestehenden `browser_fill_credential`-Test), die Schwärzung von Fehlermeldungen (Bestand `vaultGuard.redactText`), `vault.approval_stale` bei geänderter Feld-Origin nach der Freigabe (Broker-Stempel testet Task 3; hier eine Zeile in `act`). SEC-Abdeckung: SEC-SECRET-01 (Wert nur in `Input.insertText`, nie in Antwort, Snapshot oder Audit — Tests 1, 3), SEC-IDOR-01 (Eintrag nur über `broker.use` → `findVisibleItem`), SEC-INPUT-01 (Feldtypen und Origins per Whitelist — Test 2), SEC-RATE-01 (gemeinsamer Fill-Zähler).

- [ ] **Step 1: Write the failing test**

`server/lib/vault/__tests__/fillSecret.test.js`:

```js
process.env.VAULT_KEY = "ab".repeat(32);
const test = require("node:test");
const assert = require("node:assert");
const bed = require("./helpers/vaultBed");
const { BrowserPool } = require("../../browser/BrowserPool");
const { createBrowserTools } = require("../../browser/tools");
const vaultGuard = require("../../browser/vaultGuard");
const { createFakeCdp, flush } = require("../../browser/__tests__/helpers/fakeCdp");
const { Permission } = require("../../../permissions/registry");
const { VaultErrorCode } = require("../errors");

const { createVaultProvider } = require("../mcpProvider");

const FILL = "browser_fill_secret";
const TOKEN = "ghp_Fo4ms+Tok/en42";
const VALUE = "recovery code 7731";
const UPDATED = "2026-10-10T08:00:00.000Z";
const API = {
    id: 61, accountId: 1, organizationId: null, name: "forms-token", type: "api_key", description: null, updatedAt: UPDATED,
    fields: { hosts: ["api.forms.test"], headerName: "Authorization", headerTemplate: "Bearer {{secret}}", fillOrigins: ["https://forms.test"] },
    approvalRequired: false, allServers: true,
};
const OTHER = {
    id: 62, accountId: 1, organizationId: null, name: "recovery", type: "generic", description: null, updatedAt: UPDATED,
    fields: { fillOrigins: [] }, approvalRequired: false, allServers: true,
};

const FORMS = "https://forms.test";
const field = (backendNodeId, name, { tag = "input", type = "text", origin = FORMS, ancestors = [], role = "textbox" } = {}) => ({
    backendNodeId, name, role, tag, type, origin, ancestors,
});
const FIELDS = [
    field(51, "API token"),
    field(52, "Secret", { type: "password" }),
    field(53, "Notes", { tag: "textarea", type: null, ancestors: ["https://ads.evil.test"] }),
    field(54, "Scope", { tag: "select", type: null, role: "combobox" }),
];

const fakeApprovals = () => {
    const open = [];
    return {
        open,
        requestApproval: (request) => new Promise((resolve) => {
            const pending = { request, answer: (decision) => { open.splice(open.indexOf(pending), 1); resolve(decision); } };
            open.push(pending);
        }),
        forgetSession: () => {},
        forgetTransport: () => {},
    };
};

const until = async (condition) => {
    for (let i = 0; i < 200 && !condition(); i++) await flush();
    assert.ok(condition(), "condition not reached");
};

const setup = async () => {
    vaultGuard._resetForTests();
    bed.reset({
        items: [API, OTHER], secrets: { "61:token": TOKEN, "62:value": VALUE },
        permissions: [Permission.VAULT_USE, Permission.CONNECT_BROWSER], apiKeys: [41], entries: [{ id: 7, name: "web01" }],
    });
    const page = { values: new Map(), types: new Map(FIELDS.map((f) => [f.backendNodeId, f.type])), focused: null, inserted: [], session: null };
    const byId = (id) => FIELDS.find((f) => f.backendNodeId === id);
    const nodeId = (objectId) => Number(objectId.slice("node-".length));
    const domNode = (f) => ({
        backendNodeId: f.backendNodeId, localName: f.tag, nodeName: f.tag.toUpperCase(),
        attributes: f.tag === "input" ? ["type", page.types.get(f.backendNodeId)] : [],
    });
    const connectCdp = async () => createFakeCdp({
        "Target.createBrowserContext": () => ({ browserContextId: "ctx-1" }),
        "Target.createTarget": () => ({ targetId: "T1" }),
        "Target.attachToTarget": ({ targetId }) => ({ sessionId: `S-${targetId}` }),
        "Page.getNavigationHistory": { currentIndex: 0, entries: [{ id: 1, url: `${FORMS}/settings/tokens`, title: "Tokens" }] },
        "Accessibility.getFullAXTree": () => ({
            nodes: [
                { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Tokens" }, childIds: FIELDS.map((f) => String(f.backendNodeId)) },
                ...FIELDS.map((f) => ({
                    nodeId: String(f.backendNodeId), parentId: "1", childIds: [], role: { value: f.role }, name: { value: f.name },
                    backendDOMNodeId: f.backendNodeId, value: { type: "string", value: page.values.get(f.backendNodeId) ?? "" },
                })),
            ],
        }),
        "DOM.getFlattenedDocument": () => ({ nodes: FIELDS.map(domNode) }),
        "DOM.resolveNode": ({ backendNodeId }) => ({ object: { objectId: `node-${backendNodeId}` } }),
        "DOM.describeNode": ({ objectId, backendNodeId }) => (objectId
            ? { node: { backendNodeId: nodeId(objectId), nodeName: byId(nodeId(objectId)).tag.toUpperCase() } }
            : { node: domNode(byId(backendNodeId)) }),
        "Runtime.evaluate": ({ expression }) => (expression === "document" ? { result: { objectId: "document" } } : { result: { value: "complete" } }),
        "Runtime.callFunctionOn": ({ objectId }) => {
            if (objectId === "document")
                return { result: page.focused === null ? { type: "object", subtype: "null", value: null } : { objectId: `node-${page.focused}` } };
            const f = byId(nodeId(objectId));
            return { result: { value: {
                origin: f.origin, ancestors: f.ancestors, input: f.tag === "input", textarea: f.tag === "textarea",
                type: f.tag === "input" ? page.types.get(f.backendNodeId) : null, connected: true,
            } } };
        },
        "DOM.focus": ({ backendNodeId }) => {
            page.focused = backendNodeId;
            return {};
        },
        "Input.insertText": ({ text }) => {
            page.inserted.push({ text, filledBefore: vaultGuard.isFilled(page.session.contextKey) });
            page.values.set(page.focused, text);
            return {};
        },
        "DOM.getContentQuads": { quads: [[0, 0, 20, 0, 20, 20, 0, 20]] },
        "Page.getLayoutMetrics": { cssLayoutViewport: { clientWidth: 1280, clientHeight: 800 } },
        "Page.captureScreenshot": { data: "UE5H" },
    });
    const launcher = {
        async start({ key }) { return { key, port: 9300 }; },
        async stop() {},
        async endpoint(port) { return `ws://10.0.0.7:${port}/devtools/browser/x`; },
    };
    const pool = new BrowserPool({ getSettings: async () => ({ enabled: true, maxSessions: 4, idleMinutes: 30 }), launcher, connectCdp });
    pool.onContextEnded(vaultGuard.forgetContext);
    const audit = [];
    const record = async (entry) => { audit.push(entry); };
    const tools = createBrowserTools({ getPool: () => pool, audit: record, sleep: async () => {} });
    const approvals = fakeApprovals();
    const provider = createVaultProvider({ getBrowserTools: () => tools, approvals, audit: record });
    const agent = {
        accountId: 1, keyId: 41, agent: { keyId: 41, entryId: 7, agentType: "claude" }, impersonatorId: null,
        transportId: "T41", ipAddress: "10.0.0.5", userAgent: "claude-code", signal: new AbortController().signal,
    };
    const text = (result) => result.content.map((c) => c.text ?? "").join("");
    const opened = text(await tools.call("browser_open", { url: `${FORMS}/settings/tokens` }, agent));
    page.session = pool.get(/^Session: (\S+)/m.exec(opened)[1]);
    const refs = Object.fromEntries(FIELDS.map((f) => [f.name, new RegExp(`"${f.name}" \\[ref=(e\\d+)\\]`).exec(opened)[1]]));
    const fill = (args) => provider.call(FILL, args, agent);
    const vaultAudit = () => audit.filter((entry) => entry.action.startsWith("vault."));
    return { page, tools, provider, approvals, agent, text, refs, fill, audit, vaultAudit };
};

test("a token goes into a field on one of its fill origins; markFilled runs before Input.insertText and the snapshot shows ••••", async () => {
    const env = await setup();
    const result = await env.fill({ item: "forms-token", ref: env.refs["API token"] });

    assert.strictEqual(env.text(result), "Filled the value of forms-token into the field.");
    assert.deepStrictEqual(env.page.inserted, [{ text: TOKEN, filledBefore: true }]);
    const snapshot = env.text(await env.tools.call("browser_snapshot", {}, env.agent));
    assert.match(snapshot, /- textbox "API token" \[ref=e\d+\] value="••••"/);
    assert.ok(!snapshot.includes(TOKEN));
    const use = env.vaultAudit().find((entry) => entry.action === "vault.use");
    assert.deepStrictEqual([use.resourceId, use.details.tool, use.details.access, use.details.origin, use.details.fieldType],
        [61, FILL, "write", FORMS, "text"]);
    assert.ok(!JSON.stringify(env.audit).includes(TOKEN));
});

test("refused without typing or decrypting: a textarea in a frame of the fill origin inside a foreign page, a select, an entry without fill origins", async () => {
    const cases = [
        ["textarea of forms.test embedded in ads.evil.test", { item: "forms-token", ref: "Notes" }, VaultErrorCode.ORIGIN_MISMATCH],
        ["select on the fill origin", { item: "forms-token", ref: "Scope" }, VaultErrorCode.FIELD_NOT_FILLABLE],
        ["generic entry without fill origins, fillAnywhere off", { item: "recovery", ref: "API token" }, VaultErrorCode.NO_FILL_ORIGINS],
    ];
    for (const [label, { item, ref }, code] of cases) {
        const env = await setup();
        const result = await env.fill({ item, ref: env.refs[ref] });

        assert.strictEqual(result.isError, true, label);
        assert.ok(env.text(result).endsWith(`(${code})`), `${label}: ${env.text(result)}`);
        assert.deepStrictEqual([env.page.inserted, bed.state.secretReads, env.approvals.open.length], [[], 0, 0], label);
        assert.deepStrictEqual(env.vaultAudit().map((entry) => [entry.action, entry.details.code]), [["vault.use_denied", code]], label);
    }
});

test("a filled field that is not a password field locks browser_screenshot; a filled password field does not", async () => {
    const env = await setup();
    await env.fill({ item: "forms-token", ref: env.refs.Secret });
    assert.ok(!(await env.tools.call("browser_screenshot", {}, env.agent)).isError, "the value sits in a password field");

    await env.fill({ item: "forms-token", ref: env.refs["API token"] });
    const refused = await env.tools.call("browser_screenshot", {}, env.agent);
    assert.strictEqual(refused.isError, true);
    assert.match(env.text(refused), /\(vault\.screenshot_locked\)$/);
});

test("with fillAnywhere an entry without fill origins asks even without approvalRequired, for this one origin", async () => {
    const env = await setup();
    bed.state.settings.fillAnywhere = true;
    const pending = env.fill({ item: "recovery", ref: env.refs.Notes });
    await until(() => env.approvals.open.length === 1);

    const { request } = env.approvals.open[0];
    assert.deepStrictEqual([request.tool, request.access, request.target, request.scope], [FILL, "write", FORMS, `fill|${FORMS}`]);
    assert.deepStrictEqual(env.page.inserted, [], "nothing is typed while the card is open");
    env.approvals.open[0].answer("once");

    assert.strictEqual(env.text(await pending), "Filled the value of recovery into the field.");
    assert.deepStrictEqual(env.page.inserted.map((entry) => entry.text), [VALUE]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/lib/vault/__tests__/fillSecret.test.js`
Expected: FAIL, `# fail 4`. Der Stub aus Task 3 trägt nichts ein: Tests 1–3 bekommen dessen Fehlermeldung statt des Ergebnisses (Test 1: `!== 'Filled the value of forms-token into the field.'`, Test 2: Antwort endet nicht auf `(vault.origin_mismatch)`, Test 3: `refused.isError` ist `false`), Test 4 endet mit `condition not reached`, weil keine Karte geöffnet wird.

- [ ] **Step 3: `fill.js` — Zielprüfung für Werte, `typeInto` exportieren**

`server/lib/vault/fill.js`:

Nach `const USERNAME_TYPES = new Set(["text", "email", "tel"]);`:

```js
const SECRET_INPUT_TYPES = new Set(["text", "password", "search", "url"]);
```

`INSPECT`, die letzten beiden Zeilen vor `}` nachher (das Ergebnis meldet zusätzlich, ob das Element eine `<textarea>` ist; `this instanceof` gilt im Realm des Felds, eine Seite kann es nicht fälschen):

```js
    const input = this instanceof HTMLInputElement;
    const textarea = this instanceof HTMLTextAreaElement;
    return { origin: location.origin, ancestors, input, textarea, type: input ? this.type : null, connected: this.isConnected };
```

Vor `const staleRef = () =>`:

```js
const releaseObjects = (session) => session.send("Runtime.releaseObjectGroup", { objectGroup: OBJECT_GROUP }).catch(() => {});
```

In `checkFillTarget` und `fillCredential` die Zeile im `finally`

```js
        session.send("Runtime.releaseObjectGroup", { objectGroup: OBJECT_GROUP }).catch(() => {});
```

jeweils ersetzen durch:

```js
        releaseObjects(session);
```

Nach `checkFillTarget` einfügen (Reihenfolge wie dort: erst die Origins, dann der Feldtyp — eine `<textarea>` in einem iframe der erlaubten Origin unter fremder Hauptseite endet mit `vault.origin_mismatch`; die Meldung von `assertOrigins` bleibt unverändert):

```js
// origins null: the entry has no fill origins and fillAnywhere is on, so any page with an origin of its own.
const checkSecretTarget = async (session, ref, origins) => {
    try {
        const field = await inspect(session, ref);
        const origin = normalizeOrigin(field.origin);
        if (origins !== null) assertOrigins(field, new Set(origins.map(normalizeOrigin).filter(Boolean)));
        else if (origin === null)
            throw new VaultError(VaultErrorCode.ORIGIN_MISMATCH,
                `${ref} is in a frame without an origin of its own (about:blank, data: or sandboxed); nothing was filled. Open the page directly.`);
        const fieldType = field.textarea ? "textarea" : field.input && SECRET_INPUT_TYPES.has(field.type) ? field.type : null;
        if (fieldType === null) throw new VaultError(VaultErrorCode.FIELD_NOT_FILLABLE);
        return { backendNodeId: field.backendNodeId, origin, fieldType };
    } finally {
        releaseObjects(session);
    }
};
```

`this.type` liefert für ein `<input>` ohne `type`-Attribut `"text"`; „ohne Typ“ aus der Spec ist damit abgedeckt.

In `typeInto` nennt die zweite `FOCUS_LOST`-Meldung kein bestimmtes Werkzeug mehr (sie gilt jetzt für beide; kein Test prüft den Text, und sie gehört nicht zu den expliziten Meldungen von `browser_fill_credential`, die laut Spec bleiben):

```js
        throw new VaultError(VaultErrorCode.FOCUS_LOST,
            "The page moved the focus away from the field before typing; nothing was typed into it. Take a new snapshot and call the fill tool again.");
```

`module.exports` nachher:

```js
module.exports = { checkFillTarget, checkSecretTarget, fillCredential, typeInto, releaseObjects, assertFillableSession, normalizeOrigin };
```

- [ ] **Step 4: Werkzeug `server/lib/vault/tools/fillSecret.js` (Stub aus Task 3 ersetzen)**

Ablauf über `broker.use` mit den Optionen aus Task 3: `precheck` zählt den Aufruf gegen die gemeinsame Fill-Grenze (`deps.fillRate`) und prüft die Argumente, beides vor dem Laden des Eintrags und auditiert vom Broker. Umfang ist `fill`, bei leeren `fillOrigins` mit `fillAnywhere` `fill|<origin>` — der Broker verlangt dafür immer eine Freigabe, und eine Sitzungsfreigabe gilt nur für diese eine Origin. `target`, `scope` und `field` sind Funktionen des Eintrags; `target` liefert `null`, solange `check` das Feld nicht gefunden hat (Audit einer frühen Ablehnung). `origin` und `fieldType` ergänzt `check` in `auditExtra`. `check` Phase `before` prüft Typ und `fillOrigins`/`fillAnywhere`, löst die Sitzung auf und prüft Sitzung und Feld in `runAgent` — so auditiert der Broker auch `UNKNOWN_SESSION`, `vault.session_tainted` und `vault.origin_mismatch`. Phase `after` (nur nach einer Freigabe) prüft Typ und Einstellung erneut; der Broker vergleicht den Stempel (`fillOrigins` gehört dazu). `act` löst die Sitzung neu auf und prüft Sitzung, Origins und Feld innerhalb desselben `runAgent`, in dem eingetragen wird; liegt das Feld jetzt auf einer anderen Origin als bei der Prüfung (also als auf der Karte), endet es mit `vault.approval_stale`. `markFilled` läuft als `beforeInsert` von `typeInto`, unmittelbar vor `Input.insertText`.

```js
const { VaultError, VaultErrorCode } = require("../errors");
const { itemRef } = require("../visibility");
const { checkSecretTarget, typeInto, releaseObjects, assertFillableSession } = require("../fill");
const vaultGuard = require("../../browser/vaultGuard");
const { BrowserError, BrowserErrorCode } = require("../../browser/errors");
const { getVaultSettings } = require("../../../controllers/vaultSettings");

const TOOL = "browser_fill_secret";
const SECRET_FIELD = Object.freeze({ api_key: "token", generic: "value" });
const REF_PATTERN = /^e\d{1,9}$/;

const def = {
    name: TOOL,
    description: "Type the value of an API key or \"other\" entry into one field of a browser session, for example a token field in a web form. You never see the value: snapshots show ••••, browser_evaluate stays locked in this browser context afterwards, and screenshots stay locked while the value is visible in a field that is not a password field. The field's frame and all frames around it must be one of the entry's fill origins. Needs approval unless the entry says otherwise.",
    inputSchema: {
        type: "object",
        properties: {
            item: { type: "string", description: "Entry id as vault_list shows it, e.g. github-token or org:3/deploy-token" },
            ref: { type: "string", description: "ref of the field from the latest snapshot: a text, password, search or url input, or a textarea" },
            sessionId: { type: "string", description: "Browser session id. Defaults to the session this connection opened last; may be left out while only one session is open." },
        },
        required: ["item", "ref"],
    },
};

const assertArgs = ({ item, ref, sessionId }) => {
    const invalid = (message) => new BrowserError(BrowserErrorCode.INVALID_ARGUMENT, message);
    if (typeof item !== "string" || item.length === 0 || item.length > 200)
        throw invalid("item needs an entry id as vault_list shows it, e.g. github-token or org:3/deploy-token");
    if (typeof ref !== "string" || !REF_PATTERN.test(ref))
        throw invalid("ref needs the [ref=eN] of the field from the latest snapshot");
    if (sessionId != null && typeof sessionId !== "string") throw invalid("sessionId needs a session id as browser_list shows it");
};

const fillOriginsOf = (item) => {
    const origins = item.fields?.fillOrigins ?? [];
    return origins.length > 0 ? origins : null;
};

const typeSecret = async (session, backendNodeId, secret) => {
    try {
        // markFilled checks the taint in the same synchronous step, directly before Input.insertText.
        await typeInto(session, backendNodeId, secret, () => {
            if (session.closed)
                throw new BrowserError(BrowserErrorCode.SESSION_CLOSED, `Session ${session.id} has ended; nothing was typed. Open a new session with browser_open and fill there.`);
            vaultGuard.markFilled(session.contextKey, { targetId: session.targetId, backendNodeIds: [backendNodeId], secret });
        });
    } finally {
        releaseObjects(session);
    }
};

const handler = async (args, ctx, deps) => {
    const auditExtra = {};
    let session = null;
    let field = null;
    const check = async (item, { phase }) => {
        if (!Object.hasOwn(SECRET_FIELD, item.type))
            throw new VaultError(VaultErrorCode.WRONG_TYPE, `${itemRef(item)} is a ${item.type} entry; browser_fill_secret fills API key and "other" entries only.`);
        if (fillOriginsOf(item) === null && !(await getVaultSettings()).fillAnywhere) throw new VaultError(VaultErrorCode.NO_FILL_ORIGINS);
        if (phase !== "before") return;
        session = deps.getBrowserTools().resolveSession(ctx, args.sessionId ?? null);
        field = await session.runAgent(TOOL, async () => {
            assertFillableSession(session);
            return checkSecretTarget(session, args.ref, fillOriginsOf(item));
        });
        Object.assign(auditExtra, { origin: field.origin, fieldType: field.fieldType });
    };
    // Waiting for the approval happens outside runAgent; act checks the session and the field again
    // inside the runAgent that types, so nothing can change between the check and the keystroke.
    const act = async (secret, item) => {
        session = deps.getBrowserTools().resolveSession(ctx, session.id);
        await session.runAgent(TOOL, async () => {
            assertFillableSession(session);
            const now = await checkSecretTarget(session, args.ref, fillOriginsOf(item));
            if (now.origin !== field.origin)
                throw new VaultError(VaultErrorCode.APPROVAL_STALE,
                    `The field moved from ${field.origin} to ${now.origin} after the check; nothing was filled. Take a new snapshot and call browser_fill_secret again.`);
            await typeSecret(session, now.backendNodeId, secret);
        });
        return `Filled the value of ${itemRef(item)} into the field.`;
    };
    try {
        const { result } = await deps.broker.use({
            ctx, itemRef: args.item, tool: TOOL, access: "write",
            precheck: () => {
                deps.fillRate(ctx);
                assertArgs(args);
            },
            // Also read for the audit of a refusal, before check has located the field.
            target: () => field?.origin ?? null,
            scope: (item) => (fillOriginsOf(item) === null ? `fill|${field.origin}` : "fill"),
            field: (item) => SECRET_FIELD[item.type],
            check, act, auditExtra,
        });
        return { content: [{ type: "text", text: result }] };
    } catch (err) {
        if (session && typeof err?.message === "string") err.message = vaultGuard.redactText(session.contextKey, err.message);
        throw err;
    }
};

module.exports = { def, handler, needsBrowser: true };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test server/lib/vault/__tests__/fillSecret.test.js`
Expected: PASS, 4 Tests.

Run (Gegenprüfung `browser_fill_credential` nach der Änderung an `fill.js`, Browser-Sperren, Broker): `node --test server/lib/vault/__tests__/mcpProvider.test.js server/lib/vault/__tests__/broker.test.js server/lib/browser/__tests__/*.test.js`
Expected: PASS (die beiden Chromium-Tests ohne `OUTPOST_BROWSER_E2E_LAUNCHER` übersprungen).

Run: `npx eslint server/lib/vault/fill.js server/lib/vault/tools/fillSecret.js server/lib/vault/__tests__/fillSecret.test.js`
Expected: keine Ausgabe.

- [ ] **Step 6: Commit**

```bash
git add server/lib/vault/fill.js server/lib/vault/tools/fillSecret.js server/lib/vault/__tests__/fillSecret.test.js
git commit -m "Vault: browser_fill_secret trägt Token und Werte in ein Formularfeld ein, nur auf Fill-Origins oder mit Freigabe je Seite"
```

---

### Task 6: Git-Keys an der Authentifizierung, Upload-Frist

**Files:**
- Modify: `server/middlewares/auth.js` (`rejectAgentKey`)
- Create: `server/middlewares/requestDeadline.js`
- Modify: `server/index.js` (Middleware nach `trust proxy`, `requestTimeout = 0` für `app.listen`-Server und HTTPS-Server)
- Test: `server/lib/vault/__tests__/agentAuth.test.js` (erweitern), `server/lib/__tests__/requestDeadline.test.js` (neu)

**Interfaces:**
- Consumes: Bestand `rejectAgentKey`.
- Produces: siehe „Schnittstellen“ Task 6.

**Design:** kein UI-Anteil.

**Tests:** 2 Tests — (1) Auth: Git-Key an `/api/mcp` → 403, Claude-Key an `/api/vault/git/github.com/o/r.git/info/refs` → 403, Git-Key dort → durchgelassen (mit Stub-Route); (2) `requestDeadline` (Frist 200 ms): tröpfelnder POST an beliebiger Route → 408, derselbe POST unter `/api/vault/git/` ohne `clearRequestDeadline` → 408, mit `clearRequestDeadline` → läuft durch; vollständiger Body mit langer Antwortzeit → kein 408; Route antwortet 401, ohne den Body zu lesen, der Client tröpfelt weiter → Verbindung binnen ~3× Frist geschlossen; tröpfelnder POST an eine Route, die es nicht gibt → 408, der Prozess läuft weiter (die 408 geht direkt auf den Socket).

**Parallel:** Task 1, Task 2, Task 8, Task 9 (Welle A).

Zwei Node-Fakten tragen den Entwurf (mit Node 22 in diesem Projekt geprüft): `server.requestTimeout` lässt sich je Request nicht aufheben (`req.setTimeout(0)`, `req.socket.setTimeout(0)` wirken nicht), wohl aber für den ganzen Server, auch nach dem Erzeugen (`server.requestTimeout = 0` nach `listen` — ein Body, der länger als die alte Frist tröpfelt, kommt dann mit 200 an statt mit 408); `req.complete` ist bei WebSocket-Upgrades sofort `true` und wird bei kleinen Bodies `true`, sobald sie angekommen sind, auch ungelesen. Deshalb prüft die Middleware beim Ablauf nur `req.complete`: MCP-Aufrufe in der Freigabe-Wartezeit, lange Downloads und WebSockets bleiben unberührt, ohne dass sie Routen kennen muss. Eine Antwort allein beendet die Frist nicht: Routen, die mit 401, 404 oder 413 antworten, ohne den Body zu lesen, lassen Node den Rest auf einer Keep-alive-Verbindung weiterlesen — mit `requestTimeout = 0` so lange, wie der Client tröpfelt (Slow-Loris, nachgestellt). Der Timer endet deshalb erst mit dem Body (`req` `end`, oder `finish`/`close` der Antwort bei `req.complete`, `close` auch bei zerstörtem Request); läuft er nach gesendeter Antwort ab, zerstört er den Socket.

Nicht getestet: die zwei Zeilen `requestTimeout = 0` in `server/index.js` (Konfiguration; der Fakt oben ist geprüft, der Handtest in Task 13 schiebt einen echten Push), die Reihenfolge der Middleware in `index.js` (Weiterreichung). Dass der Git-Router die Frist erst nach seinen Prüfungen aufhebt, belegt Task 7 (Test 5). SEC-Abdeckung: SEC-RBAC-01 (Agententyp `git` nur am Git-Proxy, `claude`/`codex` nur an `/api/mcp` — Test 1), SEC-TOKEN-01 (Git-Key taugt nur für den Git-Proxy — Test 1), SEC-RATE-01 (ein unauthentifizierter, tröpfelnder Upload hält keine Verbindung länger als die Frist, auch wenn die Route schon mit 401 geantwortet hat — Test 2).

- [ ] **Step 1: Write the failing auth test**

`server/lib/vault/__tests__/agentAuth.test.js`, nach `app.use("/api/mcp", authenticate, echo);` die Stub-Route des Git-Proxys:

```js
app.use("/api/vault/git", authenticate, echo);
```

Neuer Test nach dem ersten Test („ein endgültiger Agenten-Key erreicht nur /api/mcp …“):

```js
test("ein Git-Key erreicht nur Pfade unter /api/vault/git/, ein Claude-Key dort nichts", async () => {
    const GIT_REFS = "/api/vault/git/github.com/o/r.git/info/refs?service=git-upload-pack";
    const git = await agentKey(servers.nas, { agentType: "git", name: "git@nas" });
    const claude = await agentKey(servers.nas);
    const gitOnly = { status: 403, body: { code: 403, message: "Git keys can only access the vault Git proxy" } };

    assert.deepStrictEqual(await call("POST", "/api/mcp", git.token), gitOnly);
    assert.deepStrictEqual(await call("GET", "/api/entries", git.token), gitOnly);
    assert.deepStrictEqual(await call("GET", GIT_REFS, claude.token),
        { status: 403, body: { code: 403, message: "Agent keys can only access the MCP endpoint" } });

    const refs = await call("GET", GIT_REFS, git.token);
    assert.deepStrictEqual([refs.status, refs.body.agent], [200, { keyId: git.id, entryId: servers.nas.id, agentType: "git" }]);
    assert.strictEqual((await call("POST", "/api/vault/git/github.com/o/r.git/git-upload-pack", git.token)).status, 200);
});
```

- [ ] **Step 2: Write the failing deadline test**

`server/lib/__tests__/requestDeadline.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const express = require("express");
const { requestDeadline } = require("../../middlewares/requestDeadline");

const DEADLINE_MS = 200;
const drain = (req, res) => {
    req.resume();
    req.on("end", () => {
        if (!res.headersSent) res.end("done");
    });
};

const app = express();
app.use(requestDeadline({ ms: DEADLINE_MS }));
app.use(express.json());
app.post("/api/vault/git/cleared", (req, res, next) => {
    req.clearRequestDeadline();
    next();
}, drain);
app.post("/api/vault/git/kept", drain);
app.post("/api/vault/git/refused", (req, res) => res.status(401).json({ message: "no" }));
app.post("/api/entries", drain);
app.post("/api/slow", (req, res) => setTimeout(() => res.json({ ok: req.body.ok }), DEADLINE_MS * 2));

let server;

test.before(async () => {
    server = await new Promise((resolve) => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
});

test.after(() => {
    server.closeAllConnections();
    server.close();
});

// Sends the body one byte at a time over trickleMs; settles on the response head, like a client
// that stops uploading once the server has answered.
const post = (path, { body = "x".repeat(12), trickleMs = 0, type = "application/octet-stream" } = {}) => new Promise((resolve, reject) => {
    const req = http.request({
        host: "127.0.0.1", port: server.address().port, path, method: "POST",
        headers: { "content-type": type, "content-length": Buffer.byteLength(body) },
    });
    const chunks = trickleMs > 0 ? [...body] : [body];
    const step = trickleMs / chunks.length;
    let timer = null;
    const sendNext = () => {
        req.write(chunks.shift());
        if (chunks.length === 0) req.end();
        else timer = setTimeout(sendNext, step);
    };
    req.on("response", (res) => {
        clearTimeout(timer);
        resolve({ status: res.statusCode, connection: res.headers.connection });
        res.resume();
        res.on("end", () => req.destroy());
    });
    req.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
    });
    sendNext();
});

// Keeps sending after the answer, like a slow-loris client; settles when the server closes the connection.
const uploadUntilClosed = (path, { giveUpMs }) => new Promise((resolve) => {
    const started = Date.now();
    const req = http.request({
        host: "127.0.0.1", port: server.address().port, path, method: "POST",
        headers: { "content-type": "application/octet-stream", "content-length": 100000 },
    });
    let status = null;
    const sending = setInterval(() => req.write("x"), 20);
    const giveUp = setTimeout(() => req.destroy(), giveUpMs);
    req.on("response", (res) => {
        status = res.statusCode;
        res.resume();
    });
    req.on("socket", (socket) => socket.once("close", () => {
        clearInterval(sending);
        clearTimeout(giveUp);
        resolve({ status, closedAfterMs: Date.now() - started });
    }));
    req.on("error", () => {});
});

test("a body that has not arrived after the deadline ends with 408, also under /api/vault/git/ until the route lifts it; a slow answer to a complete body does not", async () => {
    const trickle = { trickleMs: DEADLINE_MS * 3 };

    assert.deepStrictEqual(await post("/api/entries", trickle), { status: 408, connection: "close" });
    assert.deepStrictEqual(await post("/api/vault/git/kept", trickle), { status: 408, connection: "close" }, "the git prefix alone lifts nothing");
    assert.strictEqual((await post("/api/vault/git/cleared", trickle)).status, 200, "clearRequestDeadline lets the upload run past the deadline");
    assert.strictEqual((await post("/api/slow", { body: JSON.stringify({ ok: true }), type: "application/json" })).status, 200,
        "a complete body is not cut off while the route takes its time");

    const refused = await uploadUntilClosed("/api/vault/git/refused", { giveUpMs: DEADLINE_MS * 10 });
    assert.strictEqual(refused.status, 401);
    assert.ok(refused.closedAfterMs < DEADLINE_MS * 3, `an answer without reading the body still ends the upload at the deadline (${refused.closedAfterMs} ms)`);
    const unrouted = await uploadUntilClosed("/api/nowhere", { giveUpMs: DEADLINE_MS * 10 });
    assert.deepStrictEqual([unrouted.status, unrouted.closedAfterMs < DEADLINE_MS * 3], [408, true],
        "finalhandler waits for the body of an unknown route; the deadline ends it without ERR_HTTP_HEADERS_SENT ending the process");
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test server/lib/vault/__tests__/agentAuth.test.js server/lib/__tests__/requestDeadline.test.js`
Expected: FAIL, 2 Fehlschläge. Der Auth-Test scheitert an der ersten Zusicherung (`message: 'Agent keys can only access the MCP endpoint'` statt `'Git keys can only access the vault Git proxy'`; heute gilt für jeden Agenten-Key nur `/api/mcp`); der Fristen-Test mit `Error: Cannot find module '../../middlewares/requestDeadline'`. Die 6 bestehenden Tests in `agentAuth.test.js` bleiben grün.

- [ ] **Step 4: `rejectAgentKey` nach Agententyp**

`server/middlewares/auth.js`, nach `const isMcpPath = …`:

```js
const isGitPath = (path) => path.startsWith("/api/vault/git/");
const AREAS = {
    git: { allows: isGitPath, message: "Git keys can only access the vault Git proxy" },
    mcp: { allows: isMcpPath, message: "Agent keys can only access the MCP endpoint" },
};
```

In `rejectAgentKey` die Prüfung

```js
    if (!isMcpPath(path))
        return { status: 403, body: { code: 403, message: "Agent keys can only access the MCP endpoint" } };
```

ersetzen durch:

```js
    const area = apiKey.agentType === "git" ? AREAS.git : AREAS.mcp;
    if (!area.allows(path))
        return { status: 403, body: { code: 403, message: area.message } };
```

Bindung an den Server, IP-Bindung, `touchApiKey` und `req.agent` (jetzt mit `agentType: "git"`) laufen danach unverändert. `pathOf` nimmt `req.originalUrl` ohne Query; Express normalisiert `..` nicht, ein Pfad wie `/api/vault/git/../items` trifft keinen anderen Router.

- [ ] **Step 5: Middleware `server/middlewares/requestDeadline.js`**

```js
const DEFAULT_MS = 300 * 1000;
const TIMED_OUT = "HTTP/1.1 408 Request Timeout\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";

// Stands in for server.requestTimeout, which index.js sets to 0: Node cannot lift that limit for a
// single request, and a git push may upload for longer. Only a route that knows who is sending lifts this one.
// An answer alone does not end the deadline: after a 401 or 404 Node keeps reading an unread body on a
// keep-alive connection, without requestTimeout for as long as the client sends.
// The 408 goes to the socket, not through res: finalhandler and routes that wait for this body answer
// afterwards, and with res.headersSent set that answer throws ERR_HTTP_HEADERS_SENT outside any try.
const requestDeadline = ({ ms = DEFAULT_MS } = {}) => (req, res, next) => {
    let timer = setTimeout(() => {
        timer = null;
        const socket = req.socket;
        if (req.complete || !socket || socket.destroyed) return;
        if (res.headersSent) return socket.destroy();
        socket.end(TIMED_OUT, () => socket.destroy());
    }, ms);
    const clear = () => {
        clearTimeout(timer);
        timer = null;
    };
    req.clearRequestDeadline = clear;
    req.once("end", clear);
    res.once("finish", () => {
        if (req.complete) clear();
    });
    res.once("close", () => {
        if (req.complete || req.destroyed) clear();
    });
    next();
};

module.exports = { requestDeadline };
```

Kein `unref`: der Timer endet mit dem Body oder läuft ab. Bei WebSocket-Upgrades schickt express-ws eine Attrappe als `res`, die nie endet; dort läuft der Timer einmal ab und tut nichts, weil `req.complete` `true` ist.

- [ ] **Step 6: `server/index.js` — Middleware und Listener**

Nach `const { authenticate } = require("./middlewares/auth");`:

```js
const { requestDeadline } = require("./middlewares/requestDeadline");
```

Nach `app.set("trust proxy", parseTrustProxy(process.env.TRUST_PROXY));`, vor `app.use(express.json());` (als erste Middleware; Task 4 setzt seinen Parser für `/api/mcp` danach, vor den globalen):

```js
app.use(requestDeadline());
```

`app.listen(APP_PORT, …)` nachher (express-ws gibt den `http.Server` zurück):

```js
        const httpServer = app.listen(APP_PORT, () =>
            logger.system(`Server listening on port ${APP_PORT}`)
        );
        httpServer.requestTimeout = 0;
```

Nach `const httpsServer = https.createServer(sslOptions, app);`:

```js
                httpsServer.requestTimeout = 0;
```

`headersTimeout` (60 s) bleibt an beiden Servern unverändert.

- [ ] **Step 7: Run tests to verify they pass**

Run: `node --test server/lib/vault/__tests__/agentAuth.test.js server/lib/__tests__/requestDeadline.test.js`
Expected: PASS, 8 Tests (7 in `agentAuth.test.js`, 1 in `requestDeadline.test.js`).

Run (weitere Tests, die `auth.js` laden): `node --test server/lib/vault/__tests__/itemsRoute.test.js server/lib/vault/__tests__/approvals.test.js server/lib/vault/__tests__/agentKeysRoute.test.js server/lib/__tests__/bookmarkRoutes.test.js`
Expected: PASS.

Run: `node --check server/index.js && npx eslint server/middlewares/auth.js server/middlewares/requestDeadline.js server/index.js server/lib/vault/__tests__/agentAuth.test.js server/lib/__tests__/requestDeadline.test.js`
Expected: keine Ausgabe.

- [ ] **Step 8: Commit**

```bash
git add server/middlewares/auth.js server/middlewares/requestDeadline.js server/index.js server/lib/vault/__tests__/agentAuth.test.js server/lib/__tests__/requestDeadline.test.js
git commit -m "Vault: Git-Keys nur am Git-Proxy, Upload-Frist je Request statt requestTimeout"
```

### Task 7: Git-Proxy

**Files:**
- Create: `server/lib/vault/gitProxy.js` (Vorgänge, Eintragssuche, Weiterleitung, Pkt-Line `ERR`), `server/routes/vault/git.js`
- Modify: `server/routes/vault/index.js` (Router einhängen)
- Test: `server/lib/vault/__tests__/gitProxy.test.js` (neu)

**Interfaces:**
- Consumes: Task 3 (`broker.use` mit `approved`, `secretVariants`, `redactSecretText`), Task 2 (`gitSessionId`, `touchSession`, `grantStamp`), Task 6 (`req.agent.agentType === "git"`, `req.clearRequestDeadline()`), Task 1 (`git`, `gitUsername`, `readOnly`, Codes), Task 8 (`coversGit` aus `server/lib/vault/gitHosts.js`), Bestand `visibleItems`.
- Produces: Endpunkte `GET|POST /api/vault/git/<host>/<repo>/(info/refs|git-upload-pack|git-receive-pack)`.

**Design:** kein UI-Anteil.

**Tests:** 5 Tests, Ende-zu-Ende mit echtem `git` gegen einen lokalen `git http-backend` (CGI über `node:https`, Basic-Auth, TLS mit selbstsigniertem Zertifikat über den injizierbaren `https.Agent` des Proxys) und einem Test-Home mit `insteadOf`/`extraHeader` — (1) `git clone`, Änderung, `git push`, `git fetch` gelingen; ein Push mit „Einmal“ zeigt genau eine Karte, ein zweiter Push eine neue; ein `vault.use` je Vorgang; Token steht weder im Test-Home noch in der gitconfig noch in Git-Ausgaben; (2) `readOnly`: clone gelingt, push scheitert mit `remote error: vault:` und `vault.read_only`; (3) POST ohne `info/refs` → 403 `vault.git_no_operation`; nicht erlaubter Pfad → 404; (4) Vorgangsfenster (verkürzt auf 200 ms): ein POST, der länger als das Fenster streamt, hält den Vorgang offen, der nächste POST gehört dazu (Review Focus 3); ein zweiter `receive-pack`-POST, während einer läuft → `vault.git_no_operation`; Hosts geändert zwischen `info/refs` und POST → `vault.approval_stale` (Review Focus 4); (5) Upload-Frist (Spec-Test 6a, Frist verkürzt): ein langsamer Body an einer anderen Route endet mit 408, ein geprüfter `upload-pack`-POST, dessen Body länger als die Frist tröpfelt, wird weitergeleitet und erreicht den Git-Host.

**Parallel:** Task 4, Task 5 (Welle C).

Entscheidungen dieses Tasks (aus der Spec abgeleitet, im Code umgesetzt):
- Broker: `broker.use` der gemeinsamen Standardinstanz (`server/lib/vault/broker.js`, Task 3) mit `deferUse: true` — kein `vault.use` je Anfrage; das zurückgegebene `recordUse({ bytes })` aus `info/refs` schreibt beim Ende des Vorgangs genau ein `vault.use` mit `bytes` (Summe beider Richtungen über alle Anfragen des Vorgangs) und setzt `lastUsedAt`. Antwortet der Git-Host auf `info/refs` nicht mit 200, entsteht kein Vorgang und `recordUse` läuft sofort. POSTs eines Vorgangs laufen mit `approved = { itemId, stamp }` (voller `grantStamp` aus `info/refs`); Zusatzangaben fürs Audit gehen als `auditExtra` (`host`, `repo`, `service`).
- Drossel und Audit vor dem Broker: Die Drossel (30 `info/refs` pro Minute je Key, `broker.createRateLimit({ windowMs, limit })`) läuft bei jedem `info/refs` **vor** der Eintragssuche; `precheck` bleibt leer. Ablehnungen vor dem Broker (`vault.rate_limited`, `vault.git_not_enabled`, `vault.git_ambiguous`, `vault.git_no_operation`) auditiert der Proxy selbst als `vault.use_denied`, höchstens einmal je Key, Code und Minute (kleine Map mit Bereinigung des Fensters) — ein Skript, das in Schleife wiederholt, flutet sonst das Audit. Alles ab `broker.use` auditiert der Broker.
- Hostvergleich ohne Groß-/Kleinschreibung über `coversGit` aus `server/lib/vault/gitHosts.js` (Task 8): dieselbe Regel wie bei der Einrichtung; Task 1 speichert Hosts wie eingegeben.
- Ein Vorgang wird registriert, sobald der Git-Host `info/refs` mit 200 beantwortet — **bevor** die Antwort an Git geht. Git schickt den ersten POST, sobald es die Advertisement gelesen hat; würde der Vorgang erst nach `broker.use` registriert, käme der POST im Wettlauf zu früh (`vault.git_no_operation`).
- Ein Vorgang zählt aktive Anfragen (`active`); das Fenster (Standard 60 s, `windowMs`) startet erst, wenn `active` auf 0 fällt. Ein `receive-pack`-POST mit mehr als `0000` im Body beendet den Vorgang nach seinem Ende. Solange ein `receive-pack`-POST läuft, nimmt der Vorgang keinen zweiten an (`pushing`, → `vault.git_no_operation`): „Einmal“ deckt genau einen Push.
- Abbruch: Unmittelbar bevor die Weiterleitung zählt und startet, prüft `act` `ctx.signal.aborted`, `req.destroyed` und `res.destroyed` → `vault.client_gone`; ein Client, der während der Freigabe aufgab, löst keine Anfrage an den Git-Host aus.
- Request-Header an den Git-Host: `Content-Type`, `Content-Length` (nur wenn der Client einen schickte; sonst chunked), `Accept`, `Content-Encoding`, `Git-Protocol`, `User-Agent` und das eigene `Authorization: Basic …`.
- Antworten für Ablehnungen: `info/refs` → 200 `application/x-<dienst>-advertisement` mit `ERR vault: <Meldung> (<code>)`; POST → 403 Text; immer `Connection: close` und Socket-Ende nach dem Senden. Platzhalter der Meldungen (`<host>`, `<entries>`, `<kind>`) ersetzt der Proxy in den Vorlagen aus `VaultErrorMessage` (Task 1).
- Upstream-URL nur aus geprüftem Host und Repo-Pfad (SEC-INJECT-01): Query wird nicht durchgereicht, sondern aus dem geprüften Dienstnamen gebaut (`?service=git-upload-pack|git-receive-pack`).
- Upstream-TLS: `createGitProxy({ windowMs, idleMs, agent })` nimmt einen `https.Agent`; in Produktion ist `agent` `undefined` (globaler Agent, System-CAs). Der Test übergibt `new https.Agent({ ca: <selbstsigniertes Zertifikat> })` — kein `NODE_EXTRA_CA_CERTS` (wirkt nur beim Prozessstart), kein Abschalten der Zertifikatsprüfung. Der Upstream ist im Test ein `node:https`-Server, der `git http-backend` als CGI startet; das Zertifikat erzeugt das vorhandene `selfsigned` (keine neue Abhängigkeit).
- Upload-Frist: `server/middlewares/requestDeadline.js` (Task 6) exportiert benannt `{ requestDeadline }`; der Proxy hebt die Frist mit `req.clearRequestDeadline()` erst auf, wenn Key, Eintrag, Vorgang und Freigabe geprüft sind und die Weiterleitung beginnt.

- [ ] **Step 0: Voraussetzungen aus Task 3, Task 6 und Task 8 prüfen**

Run: `cd /root/outpost && grep -n "deferUse\|createRateLimit\|auditExtra" server/lib/vault/broker.js && grep -n "requestDeadline" server/middlewares/requestDeadline.js && grep -n "gitSessionId\|touchSession\|grantStamp" server/lib/vault/approvals.js && grep -n "secretVariants\|redactSecretText" server/lib/vault/redact.js && grep -n "GIT_NO_OPERATION\|UPSTREAM_REFUSED\|SECRET_TOO_SHORT" server/lib/vault/errors.js && grep -n "coversGit" server/lib/vault/gitHosts.js`
Expected: jede Suche trifft; `broker.js` exportiert `{ createBroker, createRateLimit, use }` und `use` liefert mit `deferUse: true` `{ result, approval, item, recordUse }`; `requestDeadline.js` exportiert `requestDeadline` benannt; `approvals.js` exportiert die drei Funktionen; `gitHosts.js` exportiert `coversGit`.

Weicht ein Export ab: anhalten und melden (Task 3, 6 bzw. 8 nachziehen oder den `require` anpassen), nicht raten.

- [ ] **Step 1: Failing Test schreiben**

`server/lib/vault/__tests__/gitProxy.test.js`:

```js
process.env.VAULT_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const { execFile, spawn } = require("node:child_process");
const express = require("express");
const selfsigned = require("selfsigned");
const { Sequelize } = require("sequelize");

// Foreign keys off: the fixtures create api_keys and vault rows without the full account graph behind them.
const db = new Sequelize({ dialect: "sqlite", storage: ":memory:", logging: false, query: { raw: true }, foreignKeys: false });
const fake = (modulePath, exports) => {
    const resolved = require.resolve(modulePath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

const ACCOUNT = 1;
const ENTRY_ID = 5;
const WINDOW_MS = 200;
const GIT_KEY = `outpost_${crypto.randomBytes(32).toString("hex")}`;
const TOKEN = `ghp_${crypto.randomBytes(18).toString("hex")}`;
const audits = [];
const cards = [];
const answer = { decision: "once" };

fake("../../../utils/database", db);
fake("../../../permissions/engine", {
    getSystemPermissions: async () => ({ isAdmin: false, permissions: ["vault.use"] }),
    getOrganizationPermissions: async () => ({ isOwner: false, isAdmin: false, permissions: [] }),
});
fake("../../../controllers/entry", {
    validateEntryAccess: async (accountId, entry) => (accountId === ACCOUNT ? { valid: true, entry } : { code: 403, message: "no" }),
    resolveEntryScope: async (entry) => ({ organizationId: null, ownerAccountId: entry.accountId }),
});
const audit = require("../../../controllers/audit");
audit.createAuditLog = async (entry) => { audits.push(entry); };

const { createGitProxy } = require("../gitProxy");
const { createGitRouter } = require("../../../routes/vault/git");
const { requestDeadline } = require("../../../middlewares/requestDeadline");
const stateBroadcaster = require("../../StateBroadcaster");
const approvals = require("../approvals");
const { initVaultState } = require("../state");
const { writeSecret } = require("../secrets");
const { hashToken } = require("../../../controllers/apiKey");
const Account = require("../../../models/Account");
const ApiKey = require("../../../models/ApiKey");
const Entry = require("../../../models/Entry");
const VaultItem = require("../../../models/VaultItem");

let tls;

test.before(async () => {
    await db.sync();
    await initVaultState();
    await Account.create({ id: ACCOUNT, firstName: "F", lastName: "L", username: "ada", password: "x" });
    await Entry.create({ id: ENTRY_ID, accountId: ACCOUNT, type: "server", name: "web01", config: { protocol: "ssh", ip: "192.0.2.10" } });
    await ApiKey.create({
        accountId: ACCOUNT, name: "git@web01", tokenHash: hashToken(GIT_KEY), prefix: `${GIT_KEY.slice(0, 14)}…`,
        kind: "agent", pending: false, entryId: ENTRY_ID, agentType: "git", ipBinding: false,
    });
    tls = await selfsigned.generate([{ name: "commonName", value: "localhost" }], {
        keySize: 2048, algorithm: "sha256", extensions: [{ name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }] }],
    });
});

test.beforeEach(async () => {
    approvals._resetForTests();
    audits.length = 0;
    cards.length = 0;
    answer.decision = "once";
    await VaultItem.destroy({ where: {} });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Async on purpose: the Outpost under test runs in this process, a sync exec would block it.
const run = (cmd, args, { env = process.env, cwd } = {}) => new Promise((resolve) => {
    execFile(cmd, args, { env, cwd }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
});

// Plays the Git host: HTTPS with Basic-Auth in front of git http-backend (CGI) over a bare repo o/r.git.
const startUpstream = async (t, { onRequest = async () => {} } = {}) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "outpost-git-upstream-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const env = {
        PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test",
    };
    const bare = path.join(root, "o/r.git");
    const seed = path.join(root, "seed");
    await run("git", ["init", "-q", "--bare", "-b", "main", bare], { env });
    await run("git", ["init", "-q", "-b", "main", seed], { env });
    fs.writeFileSync(path.join(seed, "README"), "hello\n");
    await run("git", ["-C", seed, "add", "."], { env });
    await run("git", ["-C", seed, "commit", "-qm", "init"], { env });
    await run("git", ["-C", seed, "push", "-q", bare, "main"], { env });

    const expected = `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`;
    const seen = [];
    const server = https.createServer({ key: tls.private, cert: tls.cert }, async (req, res) => {
        const url = new URL(req.url, "https://localhost");
        const info = { method: req.method, path: url.pathname, query: url.search };
        seen.push(info);
        if (req.headers.authorization !== expected) {
            res.writeHead(401, { "www-authenticate": "Basic realm=\"git\"" });
            return res.end();
        }
        await onRequest(info);
        const cgi = spawn("git", ["http-backend"], {
            env: {
                PATH: process.env.PATH, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: "1", REMOTE_USER: "tester",
                REQUEST_METHOD: req.method, PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1),
                CONTENT_TYPE: req.headers["content-type"] ?? "",
                ...(req.headers["content-length"] ? { CONTENT_LENGTH: req.headers["content-length"] } : {}),
                HTTP_GIT_PROTOCOL: req.headers["git-protocol"] ?? "",
                HTTP_CONTENT_ENCODING: req.headers["content-encoding"] ?? "",
            },
        });
        req.pipe(cgi.stdin);
        let buffered = Buffer.alloc(0);
        const onData = (chunk) => {
            buffered = Buffer.concat([buffered, chunk]);
            const end = buffered.indexOf("\r\n\r\n");
            if (end < 0) return;
            cgi.stdout.off("data", onData);
            const headers = {};
            let status = 200;
            for (const line of buffered.subarray(0, end).toString().split("\r\n")) {
                const [name, ...value] = line.split(": ");
                if (name.toLowerCase() === "status") status = Number.parseInt(value.join(": "), 10);
                else headers[name] = value.join(": ");
            }
            res.writeHead(status, headers);
            res.write(buffered.subarray(end + 4));
            cgi.stdout.pipe(res);
        };
        cgi.stdout.on("data", onData);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    return { host: `localhost:${server.address().port}`, bare, seen };
};

// /slow stands for any other route that reads its whole body: there the deadline must still bite.
const listen = async (t, { deadlineMs = 300000, ...options } = {}) => {
    const app = express();
    app.use(requestDeadline({ ms: deadlineMs }));
    app.use(express.json());
    app.post("/slow", (req, res) => { req.resume(); req.on("end", () => res.end("read")); });
    app.use("/api/vault", createGitRouter(createGitProxy({ agent: new https.Agent({ ca: tls.cert }), ...options })));
    const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    t.after(() => { server.closeAllConnections(); server.close(); });
    return `http://127.0.0.1:${server.address().port}`;
};

// The same two lines the setup writes (Task 8), so Git on the "server" talks to Outpost instead of the host.
const makeHome = async (t, outpost, host) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "outpost-git-home-"));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const env = {
        HOME: home, PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C",
        GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test",
    };
    const git = (...args) => run("git", args, { env, cwd: home });
    await git("config", "--file", `${home}/.gitconfig`, `url.${outpost}/api/vault/git/${host}/.insteadOf`, `https://${host}/`);
    await git("config", "--file", `${home}/.gitconfig`, `http.${outpost}/api/vault/git/.extraHeader`, `Authorization: Bearer ${GIT_KEY}`);
    return { home, git };
};

const addItem = async (host, fields = {}, approvalRequired = false) => {
    const item = await VaultItem.create({
        accountId: ACCOUNT, name: "github", type: "api_key", approvalRequired, allServers: true, createdBy: ACCOUNT,
        fields: {
            hosts: [host], headerName: "Authorization", headerTemplate: "Bearer {{secret}}", readOnly: false, allowHttp: false,
            git: true, gitUsername: "x-access-token", fillOrigins: [], ...fields,
        },
    });
    await writeSecret(item.id, "token", TOKEN);
    return item;
};

// Plays the open Outpost window: every new card is answered with answer.decision.
const openWindow = (t) => {
    const ws = {
        readyState: 1,
        send: (raw) => {
            const message = JSON.parse(raw);
            if (message.type !== "VAULT_APPROVALS") return;
            for (const card of message.data) {
                if (cards.some((seen) => seen.id === card.id)) continue;
                cards.push(card);
                setImmediate(() => approvals.answerApproval(card.id, ACCOUNT, answer.decision));
            }
        },
    };
    stateBroadcaster.register(ACCOUNT, 1, ws, null, null, { impersonating: false });
    t.after(() => stateBroadcaster.unregister(ACCOUNT, ws));
};

const gitCall = async (url, { method = "GET", body, service = "upload-pack" } = {}) => {
    const res = await fetch(url, {
        method, body,
        headers: { authorization: `Bearer ${GIT_KEY}`, ...(body ? { "content-type": `application/x-git-${service}-request` } : {}) },
    });
    return { status: res.status, connection: res.headers.get("connection"), text: await res.text() };
};

// A POST whose body ("0000", a flush) arrives in two halves pauseMs apart, chunked as Git sends large bodies.
const trickle = (url, pauseMs) => new Promise((resolve) => {
    const req = http.request(url, {
        method: "POST", headers: { authorization: `Bearer ${GIT_KEY}`, "content-type": "application/x-git-upload-pack-request" },
    }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, text }));
    });
    req.on("error", () => {});
    req.write("00");
    setTimeout(() => req.end("00"), pauseMs);
});

const filesUnder = (dir) => fs.readdirSync(dir, { recursive: true })
    .map((name) => path.join(dir, name))
    .filter((file) => fs.statSync(file).isFile());

test("git clone, Änderung, push und fetch laufen über Outpost; „Einmal“ deckt genau einen Vorgang, der Token erscheint nirgends auf dem Server", async (t) => {
    const upstream = await startUpstream(t);
    await addItem(upstream.host, {}, true);
    openWindow(t);
    const outpost = await listen(t, { windowMs: 1000 });
    const { home, git } = await makeHome(t, outpost, upstream.host);
    const work = path.join(home, "work");
    const outputs = [];
    const ok = async (...args) => {
        const result = await git(...args);
        outputs.push(result.stdout, result.stderr);
        assert.strictEqual(result.code, 0, result.stderr);
    };

    await ok("clone", `https://${upstream.host}/o/r.git`, work);
    for (const file of ["a.txt", "b.txt"]) {
        fs.writeFileSync(path.join(work, file), `${file}\n`);
        await ok("-C", work, "add", file);
        await ok("-C", work, "commit", "-qm", file);
        await ok("-C", work, "push", "origin", "main");
    }
    await ok("-C", work, "fetch", "origin");

    const target = `Git · ${upstream.host}/o/r`;
    assert.deepStrictEqual(cards.map((card) => [card.tool, card.access, card.target]),
        [["git", "read", target], ["git", "write", target], ["git", "write", target], ["git", "read", target]]);
    assert.strictEqual((await run("git", ["--git-dir", upstream.bare, "log", "--format=%s", "main"])).stdout, "b.txt\na.txt\ninit\n");

    await sleep(1500);
    const uses = audits.filter((entry) => entry.action === "vault.use");
    assert.deepStrictEqual(uses.map((entry) => entry.details.service).sort(), ["fetch", "fetch", "push", "push"]);
    assert.ok(uses.every((entry) => entry.details.tool === "git" && entry.details.host === upstream.host
        && entry.details.repo === "o/r" && entry.details.bytes > 0));

    const secrets = [TOKEN, Buffer.from(`x-access-token:${TOKEN}`).toString("base64")];
    const texts = [...filesUnder(home).map((file) => fs.readFileSync(file, "latin1")), ...outputs, JSON.stringify(audits)];
    assert.deepStrictEqual(texts.filter((text) => secrets.some((secret) => text.includes(secret))), []);
});

test("readOnly: clone gelingt, push endet mit remote error: vault: und vault.read_only, ohne den Git-Host zu erreichen", async (t) => {
    const upstream = await startUpstream(t);
    await addItem(upstream.host, { readOnly: true });
    const outpost = await listen(t);
    const { home, git } = await makeHome(t, outpost, upstream.host);
    const work = path.join(home, "work");

    assert.strictEqual((await git("clone", `https://${upstream.host}/o/r.git`, work)).code, 0);
    fs.writeFileSync(path.join(work, "a.txt"), "a\n");
    await git("-C", work, "add", "a.txt");
    await git("-C", work, "commit", "-qm", "a");
    const push = await git("-C", work, "push", "origin", "main");

    assert.notStrictEqual(push.code, 0);
    assert.match(push.stderr, /remote error: vault: .*\(vault\.read_only\)/);
    assert.ok(!upstream.seen.some((request) => `${request.path}${request.query}`.includes("receive-pack")));
    assert.deepStrictEqual(audits.filter((entry) => entry.action === "vault.use_denied").map((entry) => entry.details.code), ["vault.read_only"]);
});

test("ein POST ohne info/refs bekommt 403 vault.git_no_operation, andere Pfade 404, und nichts erreicht den Git-Host", async (t) => {
    const upstream = await startUpstream(t);
    await addItem(upstream.host);
    const outpost = await listen(t);
    const base = `${outpost}/api/vault/git/${upstream.host}`;

    const post = await gitCall(`${base}/o/r.git/git-upload-pack`, { method: "POST", body: "0000" });

    assert.deepStrictEqual([post.status, post.connection], [403, "close"]);
    assert.match(post.text, /\(vault\.git_no_operation\)/);
    for (const [method, url] of [
        ["GET", `${base}/o/r.git/objects/info/packs`],
        ["GET", `${base}/o/r.git/HEAD`],
        ["GET", `${base}/o/r.git/info/refs?service=git-foo`],
        ["GET", `${base}/o/r.git/info/refs`],
        ["POST", `${base}/o/r.git/info/lfs/objects/batch`],
        ["PUT", `${base}/o/r.git/git-receive-pack`],
        ["GET", `${base}/o/r.git/git-upload-pack`],
        ["GET", `${base}/o/r%20x.git/info/refs?service=git-upload-pack`],
        ["GET", `${base}/a/b/c/d/e/f/g/h/i.git/info/refs?service=git-upload-pack`],
        ["GET", `${outpost}/api/vault/git/localhost:443/o/r.git/info/refs?service=git-upload-pack`],
    ]) assert.strictEqual((await gitCall(url, { method })).status, 404, `${method} ${url}`);
    assert.deepStrictEqual(upstream.seen, []);
});

test("Review Focus 3 und 4: ein POST, der länger als das Vorgangsfenster läuft, hält den Vorgang offen; ein zweiter Push-POST während des ersten und geänderte Hosts zwischen info/refs und POST werden abgelehnt", async (t) => {
    let posts = 0;
    const upstream = await startUpstream(t, {
        onRequest: async ({ method, path: pathname }) => {
            if (method !== "POST") return;
            if (pathname.endsWith("/git-receive-pack")) return sleep(3 * WINDOW_MS);
            if (++posts === 1) await sleep(4 * WINDOW_MS);
        },
    });
    const item = await addItem(upstream.host);
    const outpost = await listen(t, { windowMs: WINDOW_MS });
    const { home, git } = await makeHome(t, outpost, upstream.host);
    const repo = `${outpost}/api/vault/git/${upstream.host}/o/r.git`;

    const clone = await git("clone", `https://${upstream.host}/o/r.git`, path.join(home, "work"));

    assert.strictEqual(clone.code, 0, clone.stderr);
    assert.ok(posts >= 2, "protocol v2 sends ls-refs and fetch as separate POSTs");
    await sleep(2 * WINDOW_MS);
    assert.strictEqual((await gitCall(`${repo}/git-upload-pack`, { method: "POST", body: "0000" })).status, 403);

    assert.strictEqual((await gitCall(`${repo}/info/refs?service=git-receive-pack`)).status, 200);
    const firstPush = gitCall(`${repo}/git-receive-pack`, { method: "POST", body: "0000", service: "receive-pack" });
    await sleep(WINDOW_MS / 2);
    const secondPush = await gitCall(`${repo}/git-receive-pack`, { method: "POST", body: "0000", service: "receive-pack" });
    assert.strictEqual(secondPush.status, 403);
    assert.match(secondPush.text, /\(vault\.git_no_operation\)/);
    assert.strictEqual((await firstPush).status, 200);

    const advertisement = await gitCall(`${repo}/info/refs?service=git-upload-pack`);
    assert.strictEqual(advertisement.status, 200);
    assert.match(advertisement.text, /# service=git-upload-pack/);
    await VaultItem.update({ fields: { ...item.fields, hosts: [upstream.host, "git.example.net"] } }, { where: { id: item.id } });
    const seen = upstream.seen.length;
    const stale = await gitCall(`${repo}/git-upload-pack`, { method: "POST", body: "0000" });

    assert.strictEqual(stale.status, 403);
    assert.match(stale.text, /\(vault\.approval_stale\)/);
    assert.strictEqual(upstream.seen.length, seen);
});

test("Spec-Test 6a: die Upload-Frist beendet einen langsamen Body an einer anderen Route, ein geprüfter Git-POST läuft über sie hinaus", async (t) => {
    const deadlineMs = 300;
    const upstream = await startUpstream(t);
    await addItem(upstream.host.toUpperCase());
    const outpost = await listen(t, { deadlineMs });
    const repo = `${outpost}/api/vault/git/${upstream.host}/o/r.git`;

    assert.strictEqual((await trickle(`${outpost}/slow`, 2 * deadlineMs)).status, 408);
    assert.strictEqual((await gitCall(`${repo}/info/refs?service=git-upload-pack`)).status, 200);
    const seen = upstream.seen.length;
    const post = await trickle(`${repo}/git-upload-pack`, 2 * deadlineMs);

    assert.strictEqual(post.status, 200);
    assert.deepStrictEqual(upstream.seen.slice(seen).map((request) => `${request.method} ${request.path}`), ["POST /o/r.git/git-upload-pack"]);
});
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag prüfen**

Run: `cd /root/outpost && node --test server/lib/vault/__tests__/gitProxy.test.js`
Expected: FAIL — `Cannot find module '../gitProxy'`.

- [ ] **Step 3: `server/lib/vault/gitProxy.js` anlegen**

```js
const https = require("node:https");
const { VaultError, VaultErrorCode, VaultErrorMessage } = require("./errors");
const { visibleItems, itemRef } = require("./visibility");
const broker = require("./broker");
const approvals = require("./approvals");
const { secretVariants, redactSecretText } = require("./redact");
const { coversGit } = require("./gitHosts");
const { createAuditLog } = require("../../controllers/audit");
const logger = require("../../utils/logger");

const OPERATION_WINDOW_MS = 60 * 1000;
const IDLE_MS = 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 30;
const MAX_FORWARDS = 4;
const DEFAULT_GIT_USERNAME = "x-access-token";
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SEGMENT = /^[A-Za-z0-9._~-]{1,100}$/;
const SERVICES = {
    "git-upload-pack": { service: "fetch", access: "read" },
    "git-receive-pack": { service: "push", access: "write" },
};
const REQUEST_HEADERS = ["content-type", "content-length", "accept", "content-encoding", "git-protocol", "user-agent"];
const RESPONSE_HEADERS = ["content-type", "cache-control", "expires", "pragma"];
const FLUSH = Buffer.from("0000");
const C = VaultErrorCode;

const refusal = (code, values = {}) =>
    new VaultError(code, Object.entries(values).reduce((text, [name, value]) => text.replace(`<${name}>`, value), VaultErrorMessage[code]));

const parseHost = (value) => {
    const match = /^([^:]+)(?::([1-9][0-9]{0,4}))?$/.exec(value.toLowerCase());
    if (!match || match[1].length > 253 || !match[1].split(".").every((label) => LABEL.test(label))) return null;
    if (match[2] && (Number(match[2]) > 65535 || match[2] === "80" || match[2] === "443")) return null;
    return { host: match[0], hostname: match[1], port: match[2] ? Number(match[2]) : 443 };
};

const parseGitRequest = (method, path, query) => {
    const parts = path.split("/").slice(1);
    const target = parseHost(parts.shift() ?? "");
    let name = null;
    if (parts.at(-2) === "info" && parts.at(-1) === "refs") {
        if (method === "GET" && typeof query.service === "string" && Object.hasOwn(SERVICES, query.service)) name = query.service;
        parts.splice(-2);
    } else if (method === "POST" && Object.hasOwn(SERVICES, parts.at(-1) ?? "")) {
        name = parts.pop();
    }
    if (!target || !name || parts.length < 1 || parts.length > 8) return null;
    if (!parts.every((segment) => SEGMENT.test(segment) && segment !== "." && !segment.includes(".."))) return null;
    const repo = parts.join("/");
    const advertise = path.endsWith("/info/refs");
    return {
        ...target, name, advertise, repo, repoName: repo.replace(/\.git$/, ""), ...SERVICES[name],
        upstreamPath: advertise ? `/${repo}/info/refs?service=${name}` : `/${repo}/${name}`,
    };
};

const failureKind = (err) => {
    if (err?.message === "idle" || err?.code === "ETIMEDOUT") return "timeout";
    if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO/.test(String(err?.code ?? ""))) return "TLS";
    return "connection";
};

const pktLine = (text) => {
    const payload = Buffer.from(`${text}\n`);
    return Buffer.concat([Buffer.from((payload.length + 4).toString(16).padStart(4, "0")), payload]);
};

// Rejected requests close the connection: a body Outpost never reads must not keep it open.
const refuse = (res, status, contentType, body) => {
    if (res.headersSent || res.destroyed) return res.destroy();
    // Node detaches the socket before "finish" listeners run, so it is captured here.
    const socket = res.socket;
    res.on("finish", () => socket?.destroy());
    res.writeHead(status, { "Content-Type": contentType, "Cache-Control": "no-cache", Connection: "close" });
    res.end(body);
};

const createGitProxy = ({ windowMs = OPERATION_WINDOW_MS, idleMs = IDLE_MS, agent = undefined } = {}) => {
    const operations = new Map();
    const forwards = new Map();
    const refusalsAudited = new Map();
    const advertiseRate = broker.createRateLimit({ windowMs: RATE_WINDOW_MS, limit: RATE_LIMIT });

    // Refusals before the broker repeat as fast as a script retries; one audit entry per key, code and minute says enough.
    const firstRefusal = (keyId, code) => {
        const now = Date.now();
        for (const [name, at] of refusalsAudited) if (now - at >= RATE_WINDOW_MS) refusalsAudited.delete(name);
        const name = `${keyId}|${code}`;
        if (refusalsAudited.has(name)) return false;
        refusalsAudited.set(name, now);
        return true;
    };

    const record = (ctx, item, action, details) => createAuditLog({
        accountId: ctx.accountId, organizationId: item?.organizationId ?? null, action,
        resource: "vault", resourceId: item?.id ?? null,
        details: { item: item ? itemRef(item) : null, agentType: "git", keyId: ctx.keyId, entryId: ctx.agent.entryId, tool: "git", ...details },
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent,
    }).catch((err) => logger.warn("Could not audit a git operation", { error: err?.name }));

    const end = (op) => {
        if (op.ended) return;
        op.ended = true;
        clearTimeout(op.timer);
        if (operations.get(op.key) === op) operations.delete(op.key);
        op.recordUse?.({ bytes: op.bytes });
    };

    const settle = (op) => {
        op.active -= 1;
        clearTimeout(op.timer);
        if (op.active > 0) return;
        if (op.finished) return end(op);
        op.timer = setTimeout(() => end(op), windowMs);
        op.timer.unref?.();
    };

    const findGitItem = async (ctx, host) => {
        const items = (await visibleItems({ accountId: ctx.accountId, agent: ctx.agent })).filter((item) => coversGit(item, host));
        if (items.length === 0) throw refusal(C.GIT_NOT_ENABLED, { host });
        if (items.length > 1) throw refusal(C.GIT_AMBIGUOUS, { host, entries: items.map(itemRef).join(", ") });
        return items[0];
    };

    const forward = ({ req, res, request, basic, onAccepted }) => new Promise((resolve, reject) => {
        let bytes = 0;
        let sent = 0;
        let head = Buffer.alloc(0);
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            resolve({ bytes, onlyFlush: sent === FLUSH.length && head.equals(FLUSH) });
        };
        const headers = { authorization: `Basic ${basic}` };
        for (const name of REQUEST_HEADERS) if (typeof req.headers[name] === "string") headers[name] = req.headers[name];
        const upstream = https.request({ hostname: request.hostname, port: request.port, method: req.method, path: request.upstreamPath, headers, agent });
        upstream.setTimeout(idleMs, () => upstream.destroy(new Error("idle")));
        upstream.on("error", (err) => {
            if (res.headersSent) return res.destroy();
            if (settled) return;
            settled = true;
            reject(refusal(C.HTTP_FAILED, { kind: failureKind(err) }));
        });
        upstream.on("response", (answer) => {
            if (answer.statusCode === 401 || answer.statusCode === 403) {
                answer.resume();
                upstream.destroy();
                settled = true;
                return reject(refusal(C.UPSTREAM_REFUSED, { host: request.host }));
            }
            onAccepted(answer.statusCode);
            const out = {};
            for (const name of RESPONSE_HEADERS) if (answer.headers[name] !== undefined) out[name] = answer.headers[name];
            res.writeHead(answer.statusCode, out);
            answer.on("data", (chunk) => { bytes += chunk.length; });
            answer.on("error", () => res.destroy());
            answer.pipe(res);
        });
        res.on("finish", finish);
        res.on("close", () => {
            upstream.destroy();
            finish();
        });
        req.on("data", (chunk) => {
            bytes += chunk.length;
            sent += chunk.length;
            if (head.length < 8) head = Buffer.concat([head, chunk]).subarray(0, 8);
        });
        req.pipe(upstream);
    });

    const handle = async (req, res) => {
        const request = parseGitRequest(req.method, req.path, req.query ?? {});
        if (!request) return refuse(res, 404, "text/plain; charset=utf-8", "Not found\n");
        if (req.agent?.agentType !== "git")
            return refuse(res, 403, "text/plain; charset=utf-8", "Only git keys can use the vault git proxy.\n");

        const keyId = req.agent.keyId;
        const transportId = approvals.gitSessionId(keyId);
        approvals.touchSession(transportId);
        const controller = new AbortController();
        res.on("close", () => { if (!res.writableFinished) controller.abort(); });
        const ctx = {
            accountId: req.user.id, keyId, agent: req.agent, transportId, impersonatorId: null, signal: controller.signal,
            ipAddress: req.ip ?? null, userAgent: req.headers["user-agent"] ?? null,
        };
        const details = { host: request.host, repo: request.repoName, service: request.service };
        const key = `${keyId}|${request.name}|${request.host}/${request.repoName}`;
        let variants = [];
        let op = null;
        let item = null;
        let brokered = false;
        let pushing = false;
        try {
            if (request.advertise) {
                advertiseRate(ctx);
                item = await findGitItem(ctx, request.host);
            } else {
                const current = operations.get(key);
                if (!current || current.ended || current.finished || current.pushing) throw new VaultError(C.GIT_NO_OPERATION);
                op = current;
                op.active += 1;
                clearTimeout(op.timer);
                item = op.item;
                if (request.name === "git-receive-pack") pushing = op.pushing = true;
            }
            const check = (candidate) => {
                if (!coversGit(candidate, request.host)) throw refusal(C.GIT_NOT_ENABLED, { host: request.host });
                if (request.name === "git-receive-pack" && candidate.fields.readOnly === true) throw new VaultError(C.READ_ONLY);
            };
            const act = async (secret, current) => {
                if (secret.length < 4) throw new VaultError(C.SECRET_TOO_SHORT);
                if ((forwards.get(keyId) ?? 0) >= MAX_FORWARDS) throw new VaultError(C.BUSY);
                const username = current.fields.gitUsername || DEFAULT_GIT_USERNAME;
                variants = secretVariants({ token: secret, gitUsername: username });
                const basic = Buffer.from(`${username}:${secret}`).toString("base64");
                if (ctx.signal.aborted || req.destroyed || res.destroyed) throw new VaultError(C.CLIENT_GONE);
                forwards.set(keyId, (forwards.get(keyId) ?? 0) + 1);
                req.clearRequestDeadline();
                try {
                    const outcome = await forward({
                        req, res, request, basic,
                        // Registered before the advertisement reaches Git: Git sends its first POST as soon as it has read it.
                        onAccepted: (status) => {
                            if (!request.advertise || status !== 200) return;
                            const previous = operations.get(key);
                            op = {
                                key, item: current, stamp: approvals.grantStamp(current),
                                active: 1, bytes: 0, pushing: false, finished: false, ended: false, timer: null, recordUse: null,
                            };
                            operations.set(key, op);
                            if (previous && previous.active === 0) end(previous);
                        },
                    });
                    if (op) op.bytes += outcome.bytes;
                    if (op && request.name === "git-receive-pack" && !request.advertise && !outcome.onlyFlush) op.finished = true;
                    return outcome;
                } finally {
                    forwards.set(keyId, forwards.get(keyId) - 1);
                }
            };
            brokered = true;
            const { result, recordUse } = await broker.use({
                ctx, itemRef: itemRef(item), tool: "git", access: request.access, target: `Git · ${request.host}/${request.repoName}`,
                field: "token", check, act, approved: request.advertise ? null : { itemId: op.item.id, stamp: op.stamp },
                auditExtra: details, deferUse: true,
            });
            if (request.advertise && op) op.recordUse = recordUse;
            else if (request.advertise) await recordUse({ bytes: result.bytes });
        } catch (err) {
            if (!(err instanceof VaultError)) logger.warn("Git proxy request failed", { error: err?.name });
            if (!brokered && err instanceof VaultError && firstRefusal(keyId, err.code))
                record(ctx, item, "vault.use_denied", { access: request.access, ...details, code: err.code });
            const message = redactSecretText(err instanceof VaultError ? `${err.message} (${err.code})` : "The git request failed unexpectedly; nothing was sent.", variants);
            if (request.advertise) refuse(res, 200, `application/x-${request.name}-advertisement`, pktLine(`ERR vault: ${message}`));
            else refuse(res, 403, "text/plain; charset=utf-8", `vault: ${message}\n`);
        } finally {
            variants = [];
            if (pushing) op.pushing = false;
            if (op) settle(op);
        }
    };

    return { handle };
};

module.exports = { createGitProxy, parseGitRequest };
```

Hinweise zum Code:
- `req.path` ist relativ zum Einhängepunkt `/api/vault/git` und nicht dekodiert: `%2e%2e`, `%20` usw. scheitern an `SEGMENT` (404).
- Die 60-s-Leerlaufgrenze ist `upstream.setTimeout(idleMs)`: Sie misst den Upstream-Socket, über den beide Richtungen laufen — stockt der Client beim Senden oder beim Lesen (Gegendruck), steht auch der Upstream-Socket still.
- `onlyFlush`: Gits Probe-POST vor großen Pushes ist genau `0000` mit `Content-Length: 4`; `receive-pack`-Bodies sind nie gzip-kodiert (Git komprimiert nur `upload-pack`-Anfragen).
- `Content-Length` geht nur weiter, wenn der Client ihn schickte; sonst sendet `node:https` chunked, wie Git selbst bei großen POSTs. `onlyFlush` und `bytes` zählen in beiden Fällen dieselben Body-Bytes.

- [ ] **Step 4: Router anlegen und einhängen**

`server/routes/vault/git.js`:

```js
const { Router } = require("express");
const { authenticate } = require("../../middlewares/auth");
const { requireVaultEnabled } = require("../../lib/vault/state");
const { createGitProxy } = require("../../lib/vault/gitProxy");

/**
 * GET /vault/git/{host}/{repo}/info/refs
 * @summary Git Proxy
 * @description Smart-HTTP proxy for git keys of agents: GET info/refs?service=git-upload-pack|git-receive-pack and POST git-upload-pack|git-receive-pack below /vault/git/{host}/{repo}/. Outpost sends the token of the vault entry with Git enabled for this host; the token never reaches the server. Every other path answers 404.
 * @tags Vault
 * @security BearerAuth
 * @param {string} host.path.required - Git host, optionally with a non-default port
 * @param {string} repo.path.required - Repository path, 1 to 8 segments
 * @return {string} 200 - Git advertisement or pack data
 */
const createGitRouter = (proxy = createGitProxy()) => {
    const app = Router();
    app.use("/git", authenticate, requireVaultEnabled, proxy.handle);
    return app;
};

module.exports = createGitRouter();
module.exports.createGitRouter = createGitRouter;
```

`server/routes/vault/index.js` — nach `app.use(require("./settings"));` einfügen:

```js
app.use(require("./git"));
```

`authenticate` steht vor `requireVaultEnabled` wie in den Routern `items` und `approvals`. `app.use("/git", …)` ist pfadgebunden und läuft damit nur für `/api/vault/git/…` (der Kommentar in `index.js` warnt vor Router-Middleware ohne Pfad). Der globale `express.json()` liest die Git-Bodies nicht (`application/x-git-*`).

- [ ] **Step 5: Test laufen lassen, Erfolg prüfen**

Run: `cd /root/outpost && node --test server/lib/vault/__tests__/gitProxy.test.js`
Expected: PASS — `# pass 5`, `# fail 0`.

Run: `cd /root/outpost && node --test server/lib/vault/__tests__/agentAuth.test.js server/lib/vault/__tests__/agentKeysRoute.test.js`
Expected: PASS (der neue Router hängt unter demselben `/api/vault`; Auth und Agenten-Keys bleiben grün).

- [ ] **Step 6: Commit**

```bash
cd /root/outpost && git add server/lib/vault/gitProxy.js server/routes/vault/git.js server/routes/vault/index.js server/lib/vault/__tests__/gitProxy.test.js && git commit -m "Vault: Git-Proxy unter /api/vault/git mit Vorgängen, Freigabe je Vorgang und gestreamter Weiterleitung"
```

### Task 8: Einrichtung und Entziehen für Git

**Files:**
- Modify: `server/lib/vault/provision.js` (`CLI_NAMES` + `git`, `gitSetupCommand`, `isGitHost`, Git-Zweig in `registrationStateLines`/`revokeCommands`)
- Create: `server/lib/vault/gitHosts.js` (`hostsOf`, `coversGit`, `gitHostsOf` — gemeinsame Hostregel für Einrichtung und Git-Proxy)
- Modify: `server/controllers/agentKeys.js` (Git-Zweig in `createAgentKeys`, `setupAgent`, `manualCommand`; Hosts aus `visibleItems`; Git-Sitzung beim Entziehen/Ersetzen beenden)
- Modify: `server/validations/vaultAgentKeys.js` (`agentTypes` + `git`)
- Test: `server/lib/vault/__tests__/provision.test.js`, `server/lib/vault/__tests__/agentKeysRoute.test.js`

**Interfaces:**
- Consumes: Task 1 (`fields.git`, `fields.hosts` — nur als Datenvertrag; Felder können in Tests direkt gesetzt werden), Bestand `visibleItems`, `keyDropCommand`, `probeCommand`.
- Produces: siehe „Schnittstellen“ Task 8; zusätzlich `provision.isGitHost(host)` und `server/lib/vault/gitHosts.js`: `hostsOf(item)` (nur `api_key` mit `fields.git === true`, Hosts kleingeschrieben, ohne Hosts, die `isGitHost` ablehnt), `coversGit(item, host)` (Vergleich ohne Groß-/Kleinschreibung; Task 7), `gitHostsOf(items)` (sortiert, ohne Doppelte); jedes Git-Ergebnis von `POST /api/vault/agent-keys` trägt `hosts`.

**Design:** kein UI-Anteil (UI baut Task 12).

**Tests:** 3 Tests — (1) `gitSetupCommand`/`revokeCommands` gegen eine echte Shell in einem Test-Home: fremde `insteadOf`-Regel bleibt, eigene alte Zeilen werden ersetzt, `~/.gitconfig` Modus 600, XDG-Datei `~/.config/git/config` bleibt unberührt, Entziehen entfernt nur eigene Zeilen und nur bei passendem Präfix; Werte mit Sonderzeichen sicher gequotet; (2) Route mit Exec-Double: `agentTypes: ["git"]` legt `git@web01` an, Befehle enthalten je Host eine `insteadOf`-Zeile, Hosts kleingeschrieben, ein nicht Git-tauglicher Host (`fd00::1`) fehlt, `hosts` im Ergebnis; (3) ohne Git-Eintrag für den Server (auch: nur nicht Git-taugliche Hosts): kein Key, Ergebnis `no_git_entries` mit `hosts: []`.

**Parallel:** Task 1, Task 2, Task 6, Task 9 (Welle A).

Entscheidungen dieses Tasks:
- `gitSetupCommand` sucht `git` selbst über `findCliScript("git")` (wie `revokeCommands` die CLIs sucht), statt einen `cliPath` zu nehmen — so bleibt die Signatur `gitSetupCommand({ base, hosts, key | keyFile })` aus „Schnittstellen“ Task 8, und der Kopierbefehl läuft auch, wenn `git` nur in der Login-Shell im PATH steht. Die vorgelagerte `findCliCommand("git")` im Controller liefert weiter `cli_missing`.
- Eigene alte Zeilen: `git config --get-regexp` über `^(url\..*/api/vault/git/.*\.insteadof|http\..*/api/vault/git/\.extraheader)$` (kanonische Schlüssel sind in Abschnitt und Variable kleingeschrieben), dann `--unset-all` je Schlüssel; Exit 5 („gibt es nicht mehr“) ist kein Fehler, weil ein mehrwertiger Schlüssel einmal je Wert gelistet wird. Ohne `--name-only` (erst ab Git 2.6), damit ältere Server gehen.
- `OUTPOST_REPLACED=1`, wenn vorher eigene Zeilen standen, wie bei Claude/Codex.
- `base` = Agenten-Adresse ohne abschließenden Schrägstrich (`endpoint(agentUrl, "")`); beim Entziehen aus `key.agentUrl` (bei jedem Git-Key gesetzt), ersatzweise aus den Einstellungen.
- Jedes Git-Ergebnis trägt `hosts: string[]` — genau die Hosts, die an `gitSetupCommand` gingen (sortiert, ohne Doppelte), bei `configured` wie bei `manual` (Task 12 zeigt sie in „Git eingerichtet für {{user}}: {{hosts}} …“).
- Ohne Git-Eintrag: Ergebnis `{ id: null, agentType: "git", remoteUser, hosts: [], status: "manual", reason: "no_git_entries", probe: null, replacedRegistration: false }` ohne `command`; andere Agenten derselben Anfrage laufen normal; die Reihenfolge der Ergebnisse folgt `agentTypes`.
- Hostregel an einer Stelle: `server/lib/vault/gitHosts.js` (diese Task) nimmt die Hosts eines Eintrags mit `git` kleingeschrieben und lässt alles weg, was `provision.isGitHost` (`/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[1-9][0-9]{0,4})?$/`) ablehnt — Joi (Task 1) erlaubt auch `fd00::1` oder `bücher.de`, die als gitconfig-Abschnitt bzw. `insteadOf`-Präfix nicht taugen; ohne diesen Filter würfe `gitSetupCommand` (`TypeError`) und die Einrichtung endete mit 500. Bleibt kein Host übrig: `no_git_entries`. Task 1 speichert Hosts wie eingegeben; der Git-Proxy (Task 7) vergleicht mit demselben `coversGit`.
- Datei vor dem Key privat: `gitSetupCommand` legt `~/.gitconfig` bei Bedarf unter `umask 077` an und setzt Modus 600, **bevor** der Key hineingeschrieben wird. Scheitert ein Schreiben, entfernt der Befehl die eigenen Zeilen wieder und endet mit Exit 1 — kein `insteadOf` bleibt stehen, das Git ohne Header zu Outpost schickt.
- Entziehen und Ersetzen beenden die Git-Sitzung des alten Keys: ``approvals.forgetTransport(`git:${key.id}`)`` in `revoke` und in `finalize` (für ersetzte Git-Keys). Wörtlich statt `gitSessionId`: Task 2 läuft parallel in Welle A; `forgetTransport` gibt es heute schon und bleibt als Alias von `forgetSession`.

- [ ] **Step 1: Failing Tests schreiben**

`server/lib/vault/__tests__/provision.test.js` — in Zeile 12 `git` in die Werkzeugliste aufnehmen (die Befehle laufen weiter mit einem PATH ohne `bash`, Claude, Codex, `curl`, `wget`; `git` braucht der neue Test, die bestehenden rufen es nicht):

```js
const TOOLS = ["awk", "cat", "chmod", "git", "grep", "mkdir", "mktemp", "mv", "rm", "tail"];
```

und am Dateiende anhängen:

```js
test("Git: Einrichten ersetzt nur eigene Zeilen in ~/.gitconfig und macht sie privat, Entziehen nur bei passendem Präfix, die XDG-Datei bleibt", async (t) => {
    const env = makeHome(t);
    const base = "https://out'post.example/x\"$(touch${IFS}$HOME/pwned)`touch${IFS}$HOME/pwned2`;&|*?!#\\y";
    const hosts = ["github.com", "git.example.net:8443"];
    const [first, second] = [newKey(), newKey()];
    const gitconfig = path.join(env.home, ".gitconfig");
    const xdg = path.join(env.home, ".config/git/config");
    const xdgContent = "[url \"https://xdg.example/api/vault/git/github.com/\"]\n\tinsteadOf = https://github.com/\n";
    fs.mkdirSync(path.dirname(xdg), { recursive: true });
    fs.writeFileSync(xdg, xdgContent);
    fs.writeFileSync(gitconfig, [
        "[user]", "\tname = Ada",
        "[url \"https://mirror.example/\"]", "\tinsteadOf = https://gitlab.example/",
        "[url \"https://old.example/api/vault/git/github.com/\"]", "\tinsteadOf = https://github.com/",
        "[http \"https://old.example/api/vault/git/\"]", "\textraHeader = Authorization: Bearer outpost_old", "",
    ].join("\n"));
    const list = async () => (await env.run("git config --file \"$HOME/.gitconfig\" --list")).stdout.trim().split("\n").sort();
    const foreign = ["user.name=Ada", "url.https://mirror.example/.insteadof=https://gitlab.example/"];
    const expected = (key) => [
        ...foreign,
        ...hosts.map((host) => `url.${base}/api/vault/git/${host}/.insteadof=https://${host}/`),
        `http.${base}/api/vault/git/.extraheader=Authorization: Bearer ${key}`,
    ].sort();

    for (const key of [first, second]) {
        await env.drop(key);
        const setup = await env.run(provision.gitSetupCommand({ base, hosts, keyFile: fileOf(key) }));
        assert.strictEqual(setup.code, 0);
        assert.match(setup.stdout, /^OUTPOST_REPLACED=1$/m);
    }

    assert.deepStrictEqual(await list(), expected(second));
    assert.strictEqual(fs.statSync(gitconfig).mode & 0o777, 0o600);
    assert.deepStrictEqual(fs.readdirSync(path.join(env.home, ".config/outpost")), []);
    assert.throws(() => provision.gitSetupCommand({ base, hosts: ["github.com'; touch x"], keyFile: fileOf(first) }), TypeError);
    const check = async (key) => (await env.run(provision.registrationCheckCommand({ agentType: "git", keyPrefix: prefixOf(key), base }))).stdout;
    assert.deepStrictEqual([await check(first), await check(second)], ["OTHER\n", "MATCH\n"]);

    const revoke = async (key) => (await env.run(provision.revokeCommands({ agentType: "git", keyPrefix: prefixOf(key), base }))).stdout;
    assert.strictEqual(await revoke(first), "FOREIGN\n");
    assert.deepStrictEqual(await list(), expected(second));
    assert.strictEqual(await revoke(second), "REMOVED\n");
    assert.deepStrictEqual(await list(), [...foreign].sort());
    assert.strictEqual(await revoke(second), "ABSENT\n");
    assert.strictEqual(fs.readFileSync(xdg, "utf8"), xdgContent);
    assert.deepStrictEqual(env.pwned(), []);
});
```

`server/lib/vault/__tests__/agentKeysRoute.test.js` — im Exec-Double (`fake("../../controlPlane/ControlPlaneServer", …)`) direkt vor `if (command.includes("echo FOREIGN")) return ok(state.revokeOutput);` einfügen (der Git-Einrichtungsbefehl enthält `command -v` aus `findCliScript` und würde sonst als CLI-Suche beantwortet):

```js
        if (command.includes(".insteadOf")) return ok("OUTPOST_REPLACED=0\n");
```

nach `const VaultSettings = require("../../../models/VaultSettings");` einfügen:

```js
const VaultItem = require("../../../models/VaultItem");
```

und am Dateiende anhängen (beide Tests mit Konto B: Konto A schöpft das Limit von 30 Änderungen pro Minute in dieser Datei schon aus):

```js
const gitItem = (accountId, name, fields, allServers = true) => VaultItem.create({
    accountId, name, type: "api_key", fields: { headerName: "Authorization", headerTemplate: "Bearer {{secret}}", ...fields },
    approvalRequired: true, allServers, createdBy: accountId,
});

test("Git: die Einrichtung legt git@web01 an und schreibt je Host des Servers eine insteadOf-Zeile; Entziehen nutzt dieselbe Adresse", async (t) => {
    await listen(t);
    t.after(() => VaultItem.destroy({ where: {} }));
    await gitItem(ACCOUNT_B, "github", { hosts: ["GitHub.com", "git.example.net:8443", "fd00::1"], git: true });
    await gitItem(ACCOUNT_B, "gitlab-api", { hosts: ["gitlab.example.com"], git: false });
    await gitItem(ACCOUNT_B, "elsewhere", { hosts: ["code.example.org"], git: true }, false);

    const [result] = (await setUp(tokens.b, { agentTypes: ["git"] })).body.results;

    assert.deepStrictEqual([result.agentType, result.status, result.reason, result.hosts],
        ["git", "configured", null, ["git.example.net:8443", "github.com"]]);
    assert.strictEqual((await ApiKey.findByPk(result.id)).name, "git@web01");
    const [setup] = execs.filter((exec) => exec.command.includes(".insteadOf"));
    const base = "https://outpost.example/api/vault/git/";
    for (const host of ["github.com", "git.example.net:8443"])
        assert.ok(setup.command.includes(`url.${base}${host}/.insteadOf`) && setup.command.includes(`https://${host}/`), host);
    assert.ok(!/gitlab\.example\.com|code\.example\.org|GitHub|fd00/.test(setup.command));
    assert.ok(setup.command.includes(`http.${base}.extraHeader`));
    assert.ok(!setup.command.includes(keyFrom(execs[0].command)), "the key is read from the drop file");

    execs.length = 0;
    assert.deepStrictEqual((await call("DELETE", `/api/vault/agent-keys/${result.id}`, tokens.b)).body, { success: true, registration: "removed" });
    assert.ok(execs[0].command.includes(`http.${base}.extraHeader`));
});

test("Git: ohne Eintrag mit „Für Git nutzen“ für diesen Server entsteht kein Key", async (t) => {
    await listen(t);
    t.after(() => VaultItem.destroy({ where: {} }));
    await gitItem(ACCOUNT_A, "github", { hosts: ["github.com"], git: true });
    await gitItem(ACCOUNT_B, "github-api", { hosts: ["api.github.com"], git: false });
    await gitItem(ACCOUNT_B, "ipv6-only", { hosts: ["fd00::1"], git: true });

    const { status, body } = await setUp(tokens.b, { agentTypes: ["git"] });

    assert.strictEqual(status, 201);
    assert.deepStrictEqual(body.results, [{
        id: null, agentType: "git", remoteUser: "deploy", hosts: [], status: "manual", reason: "no_git_entries", probe: null, replacedRegistration: false,
    }]);
    assert.deepStrictEqual(execs, []);
    assert.strictEqual(await ApiKey.count({ where: { agentType: "git" } }), 0);
});
```

`GitHub.com` kommt kleingeschrieben an, `fd00::1` fällt weg (im zweiten Test bleibt dadurch kein Host). Der Eintrag von Konto A im zweiten Test ist für Konto B unsichtbar (SEC-IDOR-01/-TENANT-01 über `visibleItems`), der Eintrag `elsewhere` im ersten gilt für keinen Server (`allServers: false`, keine Bindung).

- [ ] **Step 2: Tests laufen lassen, Fehlschlag prüfen**

Run: `cd /root/outpost && node --test server/lib/vault/__tests__/provision.test.js server/lib/vault/__tests__/agentKeysRoute.test.js`
Expected: FAIL — `provision.test.js`: der Git-Test mit `TypeError: provision.gitSetupCommand is not a function`, die übrigen 5 grün; `agentKeysRoute.test.js`: „Git: die Einrichtung …“ mit `TypeError: undefined is not iterable` (die Validierung antwortet 400), „Git: ohne Eintrag …“ mit `400 !== 201`, die übrigen 10 grün.

- [ ] **Step 3: `server/lib/vault/provision.js` erweitern, `server/lib/vault/gitHosts.js` anlegen**

Zeile 1:

```js
const CLI_NAMES = new Set(["claude", "codex", "git"]);
```

Nach `const KEY_DIR = "$HOME/.config/outpost";` einfügen:

```js
const GITCONFIG = "$HOME/.gitconfig";
const GIT_HOST = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[1-9][0-9]{0,4})?$/;
const OWN_GIT_KEYS = "^(url\\..*/api/vault/git/.*\\.insteadof|http\\..*/api/vault/git/\\.extraheader)$";
```

Vor `const probeCommand = ({ url, keyFile }) => {` einfügen:

```js
const isGitHost = (host) => typeof host === "string" && GIT_HOST.test(host);

const gitPrefix = (base) => {
    if (typeof base !== "string" || !/^https?:\/\/[^/\s]+[^\s]*$/.test(base) || base.endsWith("/")) throw new TypeError("Invalid agent base URL");
    return `${base}/api/vault/git/`;
};

// --file instead of --global: with only ~/.config/git/config present, --global would write there.
// Exit 5 of --unset-all means the key is already gone (a multi-valued key is listed once per value).
const removeOwnGitLines = (code, announce = false) => [
    `names=$("$cli" config --file "${GITCONFIG}" --get-regexp ${shQuote(OWN_GIT_KEYS)} 2>/dev/null)`,
    ...(announce ? ["if [ -n \"$names\" ]; then echo OUTPOST_REPLACED=1; else echo OUTPOST_REPLACED=0; fi"] : []),
    "printf '%s\\n' \"$names\" | while read -r name value; do",
    "[ -n \"$name\" ] || continue",
    `"$cli" config --file "${GITCONFIG}" --unset-all "$name"; rc=$?`,
    `[ "$rc" -eq 0 ] || [ "$rc" -eq 5 ] || exit ${code}`,
    `done || exit ${code}`,
];

const gitSetupCommand = ({ base, hosts, key, keyFile }) => {
    const prefix = gitPrefix(base);
    if (!Array.isArray(hosts) || hosts.length === 0 || !hosts.every(isGitHost)) throw new TypeError("Invalid git hosts");
    const header = keyWord({ keyFile, key }, "Authorization: Bearer ");
    // Private before the key is written; a failed write takes the own lines out again, so no insteadOf
    // is left that sends git to Outpost without the header.
    return asCommand([
        `cli=$( ${findCliScript("git")} ) || exit 1`,
        ...header.setup,
        `( umask 077; [ -e "${GITCONFIG}" ] || : > "${GITCONFIG}" ) && chmod 600 "${GITCONFIG}" || exit 1`,
        ...removeOwnGitLines(1, true),
        "failed=0",
        ...hosts.map((host) => `"$cli" config --file "${GITCONFIG}" --replace-all ${shQuote(`url.${prefix}${host}/.insteadOf`)} ${shQuote(`https://${host}/`)} || failed=1`),
        `[ "$failed" = 1 ] || "$cli" config --file "${GITCONFIG}" --replace-all ${shQuote(`http.${prefix}.extraHeader`)} ${header.word} || failed=1`,
        "if [ \"$failed\" = 1 ]; then",
        ...removeOwnGitLines(1),
        "exit 1",
        "fi",
        `chmod 600 "${GITCONFIG}" || exit 1`,
        ...header.cleanup,
    ]);
};
```

`registrationStateLines`, `registrationCheckCommand` und `revokeCommands` ersetzen durch:

```js
// Sets $state to MATCH (the registration carries keyPrefix) or OTHER (another key); anything else means none.
const registrationStateLines = (agentType, keyPrefix, base) => {
    if (!KEY_PREFIX.test(keyPrefix)) throw new TypeError("Invalid key prefix");
    if (cliName(agentType) === "git") return [
        `cli=$( ${findCliScript("git")} ) || exit 3`,
        `v=$("$cli" config --file "${GITCONFIG}" --get-all ${shQuote(`http.${gitPrefix(base)}.extraHeader`)} 2>/dev/null)`,
        "state=ABSENT",
        `if [ -n "$v" ]; then state=OTHER; printf '%s\\n' "$v" | grep -qF ${shQuote(`Bearer ${keyPrefix}`)} && state=MATCH; fi`,
    ];
    if (agentType === "claude") return [
        "f=\"$HOME/.claude.json\"",
        `state=$([ -f "$f" ] && awk -v p=${shQuote(`Bearer ${keyPrefix}`)} ${shQuote(CLAUDE_REGISTRATION_AWK)} "$f")`,
    ];
    return [
        `f="${CODEX_ENV}"`,
        "state=ABSENT",
        `if [ -f "$f" ]; then state=OTHER; grep -Eq ${shQuote(`^export OUTPOST_MCP_TOKEN='?${keyPrefix}`)} "$f" && state=MATCH; fi`,
    ];
};

const registrationCheckCommand = ({ agentType, keyPrefix, base }) => asCommand([
    ...registrationStateLines(agentType, keyPrefix, base),
    "case \"$state\" in MATCH|OTHER) echo \"$state\" ;; *) echo ABSENT ;; esac",
]);

const revokeCommands = ({ agentType, keyPrefix, base }) => asCommand([
    ...registrationStateLines(agentType, keyPrefix, base),
    "case \"$state\" in",
    "MATCH) ;;",
    "OTHER) echo FOREIGN; exit 0 ;;",
    "*) echo ABSENT; exit 0 ;;",
    "esac",
    ...(agentType === "git" ? removeOwnGitLines(4) : [
        `cli=$( ${findCliScript(agentType)} ) || exit 3`,
        ...withCliPath,
        ...(agentType === "claude"
            ? ["\"$cli\" mcp remove --scope user outpost >/dev/null 2>&1 || exit 4"]
            : ["\"$cli\" mcp remove outpost >/dev/null 2>&1 || exit 4", "rm -f \"$f\""]),
    ]),
    "echo REMOVED",
]);
```

In `module.exports` nach `setupCommand,` ergänzen:

```js
    gitSetupCommand,
    isGitHost,
```

Hinweise: Fehlt `git` beim Prüfen/Entziehen, endet der Befehl mit Exit 3 ohne Marker → `registration: "unknown"` mit Kopierbefehl, wie bei fehlender CLI. Entziehen entfernt bei MATCH alle eigenen Zeilen (auch die einer früheren Adresse), wie die Einrichtung vorher; fremde `insteadOf`-Regeln und `~/.config/git/config` bleiben.

`server/lib/vault/gitHosts.js` anlegen:

```js
const { isGitHost } = require("./provision");

// Hosts are stored as entered; Git and DNS compare them without case. A host that Joi accepts but a
// gitconfig section cannot carry (fd00::1, bücher.de) is left out instead of breaking the setup.
const hostsOf = (item) => (item?.type === "api_key" && item.fields?.git === true && Array.isArray(item.fields.hosts)
    ? item.fields.hosts.map((host) => String(host).toLowerCase()).filter(isGitHost)
    : []);

const coversGit = (item, host) => hostsOf(item).includes(String(host).toLowerCase());

const gitHostsOf = (items) => [...new Set(items.flatMap(hostsOf))].sort();

module.exports = { hostsOf, coversGit, gitHostsOf };
```

- [ ] **Step 4: Controller und Validierung**

`server/validations/vaultAgentKeys.js`, `createAgentKeysValidation`:

```js
    agentTypes: Joi.array().items(Joi.string().valid("claude", "codex", "git")).min(1).unique().required(),
```

`server/controllers/agentKeys.js`:

Import (Zeile 14), dazu nach `const provision = require("../lib/vault/provision");` zwei Zeilen:

```js
const { canUseVault, visibleItems } = require("../lib/vault/visibility");
```

```js
const approvals = require("../lib/vault/approvals");
const { gitHostsOf } = require("../lib/vault/gitHosts");
```

`manualCommand` (Zeilen 32–33) ersetzen durch:

```js
const manualCommand = (agentType, agentUrl, token, gitHosts) => (agentType === "git"
    ? ` ${provision.gitSetupCommand({ base: endpoint(agentUrl, ""), hosts: gitHosts, key: token })}`
    : ` ${provision.setupCommand({ agentType, cliPath: agentType, url: endpoint(agentUrl, "/api/mcp"), key: token })}`);
const setupCommandFor = ({ agentType, cliPath, agentUrl, keyFile, gitHosts }) => (agentType === "git"
    ? provision.gitSetupCommand({ base: endpoint(agentUrl, ""), hosts: gitHosts, keyFile })
    : provision.setupCommand({ agentType, cliPath, url: endpoint(agentUrl, "/api/mcp"), keyFile }));

const gitHostsFor = async (accountId, entryId) => gitHostsOf(await visibleItems({ accountId, agent: { entryId } }));
// Literal instead of gitSessionId: approvals.js keeps forgetTransport as the name for every session.
const forgetGitSession = (key) => {
    if (key.agentType === "git") approvals.forgetTransport(`git:${key.id}`);
};
```

`setupAgent`: Kopf und `manual` ersetzen —

```js
const setupAgent = async ({ accountId, entry, identity, agentUrl, key, token, gitHosts }) => {
    const keyPrefix = keyPrefixOf(key);
    const keyFile = `key-${key.id}-${crypto.randomBytes(8).toString("hex")}`;
    const manual = (reason, probe = null, replacedRegistration = false) => ({
        status: "manual", reason, probe, replacedRegistration, command: manualCommand(key.agentType, agentUrl, token, gitHosts),
    });
```

(die Zeile `const url = endpoint(agentUrl, "/api/mcp");` entfällt), den Einrichtungs-Exec

```js
        const setup = await run(setupCommandFor({ agentType: key.agentType, cliPath, agentUrl, keyFile, gitHosts }));
```

und die Nachprüfung nach einem Exec-Fehler

```js
            const check = await run(provision.registrationCheckCommand({ agentType: key.agentType, keyPrefix, base: endpoint(agentUrl, "") }));
```

`setupOne`: `gitHosts` in die Parameter aufnehmen, weiterreichen und für Git ins Ergebnis legen —

```js
const setupOne = async ({ accountId, entry, identity, organizationId, agentUrl, gitHosts, attempt, ipBinding, allowedCidrs, context }) => {
```

```js
    const outcome = await setupAgent({ accountId, entry, identity, agentUrl, key, token, gitHosts });
    if (outcome.status === "configured") await finalize(key, entry, context);
    return { id: key.id, agentType, remoteUser, ...(agentType === "git" ? { hosts: gitHosts } : {}), ...outcome };
```

`createAgentKeys`: den Block von `const shared = …` bis zum Ende des `return` im `try` ersetzen durch:

```js
        const gitHosts = agentTypes.includes("git") ? await gitHostsFor(accountId, entry.id) : [];
        const runnable = agentTypes.filter((agentType) => agentType !== "git" || gitHosts.length > 0);
        const shared = { accountId, entry, identity, organizationId, agentUrl, gitHosts, ipBinding, allowedCidrs, context: { ipAddress, userAgent } };
        const attempts = runnable.map((agentType) => ({ agentType, token: generateToken(), key: null }));
        const settled = await Promise.allSettled(attempts.map((attempt) => setupOne({ ...shared, attempt })));
        const results = settled.map(({ status, value, reason }, i) => {
            if (status === "fulfilled") return value;
            const { agentType, token, key } = attempts[i];
            logger.warn("Agent setup failed", { entryId: entry.id, agentType, error: reason?.name });
            return {
                id: key?.id ?? null, agentType, remoteUser: identity?.username || null, ...(agentType === "git" ? { hosts: gitHosts } : {}),
                status: "manual", reason: "exec_failed", probe: null, replacedRegistration: false,
                ...(key ? { command: manualCommand(agentType, agentUrl, token, gitHosts) } : {}),
            };
        });
        const noGitEntries = {
            id: null, agentType: "git", remoteUser: identity?.username || null, hosts: [],
            status: "manual", reason: "no_git_entries", probe: null, replacedRegistration: false,
        };
        return { results: agentTypes.map((agentType) => (runnable.includes(agentType) ? results[runnable.indexOf(agentType)] : noGitEntries)) };
```

`finalize`: nach `await ApiKey.destroy({ where: { id: replaced.map((old) => old.id) } });` einfügen:

```js
        replaced.forEach(forgetGitSession);
```

`revoke`: nach dem ersten `await ApiKey.destroy({ where: { id: key.id } });` einfügen:

```js
    forgetGitSession(key);
```

und die Zeile `const command = provision.revokeCommands(…)` ersetzen durch:

```js
        const base = key.agentType === "git" ? endpoint(key.agentUrl || (await VaultSettings.getOrCreate()).agentUrl || "", "") : undefined;
        const command = provision.revokeCommands({ agentType: key.agentType, keyPrefix: keyPrefixOf(key), base });
```

`confirm` und `listAgentKeys` bleiben: Ein neuer Git-Key ersetzt beim Bestätigen den alten Git-Key desselben (Server, entfernter Benutzer) ohne Entfernbefehle, weil die Einrichtung die alten Zeilen schon ersetzt hat.

- [ ] **Step 5: Tests laufen lassen, Erfolg prüfen**

Run: `cd /root/outpost && node --test server/lib/vault/__tests__/provision.test.js server/lib/vault/__tests__/agentKeysRoute.test.js`
Expected: PASS — `# pass 18`, `# fail 0` (6 in `provision.test.js`, 12 in `agentKeysRoute.test.js`).

- [ ] **Step 6: Commit**

```bash
cd /root/outpost && git add server/lib/vault/provision.js server/lib/vault/gitHosts.js server/controllers/agentKeys.js server/validations/vaultAgentKeys.js server/lib/vault/__tests__/provision.test.js server/lib/vault/__tests__/agentKeysRoute.test.js && git commit -m "Vault: Einrichtung und Entziehen für Git über insteadOf und extraHeader in ~/.gitconfig"
```

### Task 9: Client-Texte

**Files:**
- Modify: `client/public/assets/locales/en.json`, `client/public/assets/locales/de_DE.json`

**Interfaces:**
- Produces: alle Schlüssel aus „Schnittstellen“ Task 9.

**Design:**
| Element | Label | Zustände | Anker |
|---|---|---|---|
| alle 13 Elemente aus Revision 16 | wörtlich aus `docs/design/manifest.yaml` | Texte aller `states[].copy` | `semantic_anchor.means` |

**Tests:** 0 Tests — reine Texte; die Client-Tasks 10–12 decken sie über ihre Komponententests ab, `src/test/i18n.js` meldet fehlende `en`-Schlüssel.

**Parallel:** Task 1, Task 2, Task 6, Task 8 (Welle A).

Die Schlüsselliste aus „Schnittstellen“ Task 9 ist hier vervollständigt; Tasks 10–12 benutzen genau diese Schlüssel und ändern keine Locale-Datei. Gegenüber der Liste im Kopf:

- ergänzt: `vault.dialog.usage.off`/`.on` („aus“/„an“, Hinweiszeile der Schalter), `.readOnlyHint` = „an — nur lesen“ (Manifest READONLY `selected`), `.allowHttpOff` = „aus — nur https“ (HTTP `default`), `.gitHint` = „an · Git-Benutzername“ (GIT `selected`; der Benutzername wird in `--type-mono` dahinter gesetzt), `.gitUsernameHelp` (Hilfetext laut `ui-vault-dialog.md`, Wortlaut aus `semantic_anchor.means` von UI-VAULT-DIALOG-GIT), `settings.vault.fillAnywhere.off`/`.on` (FILLANY `default`/`selected`, Schema laut `ui-vault-settings.md`), `vault.detail.usage.emptyGeneric` (UI-VAULT-DETAIL-USAGE `disabled`, Manifest-Revision 17: „Sonstiges“ ohne `fillOrigins`).
- geändert: `vault.detail.usage.fill` = „Eintragen auf“ ohne Platzhalter — die Origins stehen laut Artboard in `--type-mono` dahinter und werden im JSX angehängt. `servers.agentAccess.result.successGit` und `servers.agentAccess.gitNote` tragen `<mono>…</mono>` um Adresse bzw. `git@github.com:` (gerendert mit `Trans`, Anleitung `ui-agent-access.md`: „in `--type-mono`“). `settings.account.agentKeys.sectionDescription` nennt jetzt beides (UI-API-KEYS-AGENTS `means`, Wortlaut des Artboards `ui-api-keys.html`).

Endgültige Schlüssel (de_DE / en):

| Schlüssel | de_DE | en |
|---|---|---|
| `vault.agents.git` | Git | Git |
| `vault.dialog.usage.title` | Nutzung durch Agenten | Use by agents |
| `vault.dialog.usage.off` | aus | off |
| `vault.dialog.usage.on` | an | on |
| `vault.dialog.usage.readOnly` | Nur lesen | Read only |
| `vault.dialog.usage.readOnlyHint` | an — nur lesen | on — read only |
| `vault.dialog.usage.allowHttp` | Unverschlüsseltes HTTP erlauben | Allow unencrypted HTTP |
| `vault.dialog.usage.allowHttpOff` | aus — nur https | off — https only |
| `vault.dialog.usage.allowHttpWarning` | an — der Token geht unverschlüsselt über das Netz | on — the token travels unencrypted over the network |
| `vault.dialog.usage.git` | Für Git nutzen | Use for Git |
| `vault.dialog.usage.gitHint` | an · Git-Benutzername | on · Git username |
| `vault.dialog.usage.gitUsername` | Git-Benutzername | Git username |
| `vault.dialog.usage.gitUsernameHelp` | Standard x-access-token für GitHub, oauth2 für GitLab | Default x-access-token for GitHub, oauth2 for GitLab |
| `vault.dialog.usage.gitUsernameMissing` | Git-Benutzername fehlt. | Git username missing. |
| `vault.dialog.usage.fill` | Darf im Browser eingetragen werden auf | May be filled in the browser on |
| `vault.dialog.usage.fillEmpty` | Nirgends — nur für vault_http und Git | Nowhere — only for vault_http and Git |
| `vault.dialog.usage.fillInvalid` | Keine gültige Origin (scheme://host[:port]). | Not a valid origin (scheme://host[:port]). |
| `vault.detail.usage.title` | Nutzung durch Agenten | Use by agents |
| `vault.detail.usage.readOnly` | Nur lesen | Read only |
| `vault.detail.usage.allowHttp` | Auch über http | Also over http |
| `vault.detail.usage.git` | Git · Benutzername {{user}} | Git · username {{user}} |
| `vault.detail.usage.fill` | Eintragen auf | Fill in on |
| `vault.detail.usage.empty` | vault_http über https | vault_http over https |
| `vault.detail.usage.emptyGeneric` | Nur von Hand nutzbar — kein Eintragen im Browser | Manual use only — not filled in the browser |
| `vault.approval.write` | schreibt | writes |
| `vault.approval.target.fill` | Eintragen auf {{origin}} | Fill in on {{origin}} |
| `settings.vault.fillAnywhere.title` | Token auf jeder Seite eintragen erlauben | Allow filling tokens on any page |
| `settings.vault.fillAnywhere.description` | Werte ohne eigene Origin-Liste lassen sich dann auf jeder Seite eintragen — jedes Mal mit Freigabe, eine Sitzungsfreigabe gilt nur für die eine Seite. | Values without their own origin list can then be filled in on any page — each time with approval; a session approval covers only that one page. |
| `settings.vault.fillAnywhere.off` | aus | off |
| `settings.vault.fillAnywhere.on` | an — Werte ohne eigene Liste lassen sich auf jeder Seite eintragen, jedes Mal mit Freigabe. | on — values without their own list can be filled in on any page, each time with approval. |
| `servers.agentAccess.result.successGit` | Git eingerichtet für {{user}}: `<mono>{{hosts}}</mono>` läuft über Outpost. | Git set up for {{user}}: `<mono>{{hosts}}</mono>` runs through Outpost. |
| `servers.agentAccess.result.noGitEntries` | Kein Eintrag mit „Für Git nutzen“ gilt für diesen Server. | No entry with “Use for Git” applies to this server. |
| `servers.agentAccess.gitNote` | Remotes per SSH (`<mono>git@github.com:</mono>`) gehen nicht über den Vault — auf HTTPS umstellen. | Remotes over SSH (`<mono>git@github.com:</mono>`) do not go through the vault — switch them to HTTPS. |
| `settings.account.agentKeys.sectionDescription` (geändert) | Agenten-Schlüssel erreichen nur den MCP-Endpunkt, Git-Keys nur den Git-Proxy. | Agent keys only reach the MCP endpoint, Git keys only the Git proxy. |

- [ ] **Step 1: Texte eintragen**

Beide Dateien sind heute exakt `JSON.stringify(…, null, 2)` plus Zeilenumbruch (geprüft: Parse und erneutes Schreiben ergibt dieselben Bytes). Das Skript setzt deshalb die Schlüssel über `JSON.parse`/`JSON.stringify`, ohne andere Zeilen anzufassen; neue Schlüssel landen am Ende ihres Objekts. Aus dem Repo-Wurzelverzeichnis ausführen, nicht einchecken:

```bash
node --input-type=module <<'EOF'
import { readFileSync, writeFileSync } from "node:fs";

// [de_DE, en]
const TEXTS = {
    "vault.agents.git": ["Git", "Git"],
    "vault.dialog.usage.title": ["Nutzung durch Agenten", "Use by agents"],
    "vault.dialog.usage.off": ["aus", "off"],
    "vault.dialog.usage.on": ["an", "on"],
    "vault.dialog.usage.readOnly": ["Nur lesen", "Read only"],
    "vault.dialog.usage.readOnlyHint": ["an — nur lesen", "on — read only"],
    "vault.dialog.usage.allowHttp": ["Unverschlüsseltes HTTP erlauben", "Allow unencrypted HTTP"],
    "vault.dialog.usage.allowHttpOff": ["aus — nur https", "off — https only"],
    "vault.dialog.usage.allowHttpWarning": ["an — der Token geht unverschlüsselt über das Netz", "on — the token travels unencrypted over the network"],
    "vault.dialog.usage.git": ["Für Git nutzen", "Use for Git"],
    "vault.dialog.usage.gitHint": ["an · Git-Benutzername", "on · Git username"],
    "vault.dialog.usage.gitUsername": ["Git-Benutzername", "Git username"],
    "vault.dialog.usage.gitUsernameHelp": ["Standard x-access-token für GitHub, oauth2 für GitLab", "Default x-access-token for GitHub, oauth2 for GitLab"],
    "vault.dialog.usage.gitUsernameMissing": ["Git-Benutzername fehlt.", "Git username missing."],
    "vault.dialog.usage.fill": ["Darf im Browser eingetragen werden auf", "May be filled in the browser on"],
    "vault.dialog.usage.fillEmpty": ["Nirgends — nur für vault_http und Git", "Nowhere — only for vault_http and Git"],
    "vault.dialog.usage.fillInvalid": ["Keine gültige Origin (scheme://host[:port]).", "Not a valid origin (scheme://host[:port])."],
    "vault.detail.usage.title": ["Nutzung durch Agenten", "Use by agents"],
    "vault.detail.usage.readOnly": ["Nur lesen", "Read only"],
    "vault.detail.usage.allowHttp": ["Auch über http", "Also over http"],
    "vault.detail.usage.git": ["Git · Benutzername {{user}}", "Git · username {{user}}"],
    "vault.detail.usage.fill": ["Eintragen auf", "Fill in on"],
    "vault.detail.usage.empty": ["vault_http über https", "vault_http over https"],
    "vault.detail.usage.emptyGeneric": ["Nur von Hand nutzbar — kein Eintragen im Browser", "Manual use only — not filled in the browser"],
    "vault.approval.write": ["schreibt", "writes"],
    "vault.approval.target.fill": ["Eintragen auf {{origin}}", "Fill in on {{origin}}"],
    "settings.vault.fillAnywhere.title": ["Token auf jeder Seite eintragen erlauben", "Allow filling tokens on any page"],
    "settings.vault.fillAnywhere.description": [
        "Werte ohne eigene Origin-Liste lassen sich dann auf jeder Seite eintragen — jedes Mal mit Freigabe, eine Sitzungsfreigabe gilt nur für die eine Seite.",
        "Values without their own origin list can then be filled in on any page — each time with approval; a session approval covers only that one page.",
    ],
    "settings.vault.fillAnywhere.off": ["aus", "off"],
    "settings.vault.fillAnywhere.on": [
        "an — Werte ohne eigene Liste lassen sich auf jeder Seite eintragen, jedes Mal mit Freigabe.",
        "on — values without their own list can be filled in on any page, each time with approval.",
    ],
    "servers.agentAccess.result.successGit": [
        "Git eingerichtet für {{user}}: <mono>{{hosts}}</mono> läuft über Outpost.",
        "Git set up for {{user}}: <mono>{{hosts}}</mono> runs through Outpost.",
    ],
    "servers.agentAccess.result.noGitEntries": [
        "Kein Eintrag mit „Für Git nutzen“ gilt für diesen Server.",
        "No entry with “Use for Git” applies to this server.",
    ],
    "servers.agentAccess.gitNote": [
        "Remotes per SSH (<mono>git@github.com:</mono>) gehen nicht über den Vault — auf HTTPS umstellen.",
        "Remotes over SSH (<mono>git@github.com:</mono>) do not go through the vault — switch them to HTTPS.",
    ],
    "settings.account.agentKeys.sectionDescription": [
        "Agenten-Schlüssel erreichen nur den MCP-Endpunkt, Git-Keys nur den Git-Proxy.",
        "Agent keys only reach the MCP endpoint, Git keys only the Git proxy.",
    ],
};

const put = (tree, path, value) => {
    const keys = path.split(".");
    const last = keys.pop();
    const parent = keys.reduce((node, key) => (node[key] ??= {}), tree);
    parent[last] = value;
};

for (const [file, column] of [["client/public/assets/locales/de_DE.json", 0], ["client/public/assets/locales/en.json", 1]]) {
    const tree = JSON.parse(readFileSync(file, "utf8"));
    for (const [path, texts] of Object.entries(TEXTS)) put(tree, path, texts[column]);
    writeFileSync(file, `${JSON.stringify(tree, null, 2)}\n`);
}
EOF
```

- [ ] **Step 2: Prüfen**

Run (Repo-Wurzel):

```bash
node --input-type=module <<'EOF'
import { readFileSync } from "node:fs";

const KEYS = [
    "vault.agents.git",
    ...["title", "off", "on", "readOnly", "readOnlyHint", "allowHttp", "allowHttpOff", "allowHttpWarning", "git", "gitHint",
        "gitUsername", "gitUsernameHelp", "gitUsernameMissing", "fill", "fillEmpty", "fillInvalid"].map((key) => `vault.dialog.usage.${key}`),
    ...["title", "readOnly", "allowHttp", "git", "fill", "empty", "emptyGeneric"].map((key) => `vault.detail.usage.${key}`),
    "vault.approval.write", "vault.approval.target.fill",
    ...["title", "description", "off", "on"].map((key) => `settings.vault.fillAnywhere.${key}`),
    "servers.agentAccess.result.successGit", "servers.agentAccess.result.noGitEntries", "servers.agentAccess.gitNote",
    "settings.account.agentKeys.sectionDescription",
];

for (const file of ["client/public/assets/locales/de_DE.json", "client/public/assets/locales/en.json"]) {
    const tree = JSON.parse(readFileSync(file, "utf8"));
    const missing = KEYS.filter((path) => typeof path.split(".").reduce((node, key) => node?.[key], tree) !== "string");
    console.log(`${file}: ${KEYS.length - missing.length}/${KEYS.length}${missing.length ? ` missing ${missing.join(", ")}` : ""}`);
}
EOF
```

Expected:

```
client/public/assets/locales/de_DE.json: 34/34
client/public/assets/locales/en.json: 34/34
```

Run: `git diff --stat`
Expected: `2 files changed, 94 insertions(+), 12 deletions(-)` — nur die beiden Locale-Dateien.

Run: `cd client && npx vitest run src/pages/Vault src/common/components/VaultApprovalCard src/pages/Settings/pages/Vault src/pages/Servers/components/AgentAccessDialog`
Expected: PASS (5 Dateien, 21 Tests) — die Bestandstests sehen keine geänderten Texte außer der Kopfzeile der Agenten-Schlüssel, die kein Test prüft.

- [ ] **Step 3: Commit**

```bash
git add client/public/assets/locales/en.json client/public/assets/locales/de_DE.json
git commit -m "Vault: Texte für Tokens, Git und Eintragen im Browser"
```

---

### Task 10: Client — Eintrag-Dialog und Detail

**Files:**
- Modify: `client/src/pages/Vault/vaultTypes.js`, `client/src/pages/Vault/components/VaultItemDialog/*`, `client/src/pages/Vault/components/VaultDetail/*`
- Test: bestehende Tests unter `client/src/pages/Vault/**/__tests__/` erweitern

**Interfaces:**
- Consumes: Task 9 (Schlüssel `vault.dialog.usage.*`, `vault.detail.usage.*`), Datenvertrag Task 1 (`fields.*`).
- Produces: Eintrag-Dialog sendet die neuen `fields`, Detail zeigt sie.

**Design:**
| Element | Label | Zustände | Anker |
|---|---|---|---|
| UI-VAULT-DIALOG-READONLY | Nur lesen | default, selected | nur API-Key; GET/HEAD, git fetch |
| UI-VAULT-DIALOG-HTTP | Unverschlüsseltes HTTP erlauben | default, selected | nur API-Key |
| UI-VAULT-DIALOG-GIT | Für Git nutzen | default, selected, error | nur API-Key; Git-Benutzername erst bei an |
| UI-VAULT-DIALOG-FILL | Darf im Browser eingetragen werden auf | default, empty, error | API-Key und Sonstiges; Listen-Eingabe wie Login-Origins |
| UI-VAULT-DETAIL-USAGE | Nutzung durch Agenten | default, empty, disabled | ausgeschaltetes fehlt als Zeile |

**Tests:** 2 Tests — (1) Dialog API-Key: Schalter und Felder erscheinen, Git-Benutzername nur bei „Für Git nutzen“, Speichern sendet `fields` mit den Werten; Sonstiges zeigt nur FILL; (2) Detail zeigt nur eingeschaltete Zeilen, sonst den Leerzustand.

**Parallel:** Task 3, Task 11, Task 12 (Welle B).

Umsetzung nach Artboard `docs/design/mockups/ui-vault-dialog.html`: Die Gruppe „Nutzung durch Agenten“ steht als eigener Block **nach** „Freigabe erforderlich“ und enthält READONLY, HTTP, GIT und FILL in dieser Reihenfolge. Die Anleitung `ui-vault-dialog.md` setzt READONLY zwischen „Gilt für“ und „Freigabe erforderlich“ und FILL vor den Geheimen Wert, `design-system.md` „unter die Angaben“ — drei Quellen, drei Orte; das Manifest legt keine Reihenfolge fest. Der Plan folgt dem Artboard, gegen das `/design-verify` vergleicht; beim Review bestätigen. Die Felder laufen wie in der Anleitung über `form.fields` (`toFormFields`/`toPayloadFields` kennen Booleans, `fillOrigins` ist Listenfeld neben `origins`/`hosts`); die generische Felderschleife der Angaben überspringt sie über `USAGE_FIELDS`. `gitUsername` geht nur mit eingeschaltetem Git mit. Ungültige Origins und ein leerer Git-Benutzername sperren Speichern; maßgeblich bleibt Joi aus Task 1. `IconInput` kennt kein `aria-invalid` — der Fehlerzustand zeigt sich über `is-error` am `form-group` und die Meldung mit `role="alert"`.

- [ ] **Step 1: Write the failing test (Dialog)** — an `client/src/pages/Vault/components/VaultItemDialog/__tests__/VaultItemDialog.test.jsx` anhängen (Importe, `item` und `Targets` sind schon da)

```jsx

const apiKey = {
    ...item, id: 6, ref: "github-pat", name: "github-pat", type: "api_key", secretFields: ["token"],
    fields: { hosts: ["api.github.com"], headerName: "Authorization", headerTemplate: "Bearer {{secret}}" },
};
const generic = { ...item, id: 7, ref: "coolify-token", name: "coolify-token", type: "generic", fields: {}, secretFields: ["value"] };
const editEntry = (shown) => renderWithProviders(
    <VaultItemDialog open onClose={() => {}} item={shown} onSaved={() => {}} defaultOwner="personal"
                     owners={[{ value: "personal", label: "Personal (ma.backes)", organizationId: null }]} />,
    { providers: [Targets] },
);
const node = (id) => document.querySelector(`[data-ui-id='${id}']`);

test("API-Key zeigt die Nutzung durch Agenten, der Git-Benutzername erscheint erst mit Git, Speichern schickt die Felder; Sonstiges kennt nur das Eintragen im Browser", async () => {
    const user = userEvent.setup();
    requestDouble.stub("patchRequest", "vault/items/6", { item: apiKey, secretsCleared: false });
    const { unmount } = editEntry(apiKey);
    const save = screen.getByRole("button", { name: "Save" });
    const fill = () => screen.getByLabelText("May be filled in the browser on");

    expect(screen.getByRole("checkbox", { name: "Read only" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Allow unencrypted HTTP" })).not.toBeChecked();
    expect(screen.queryByLabelText("Git username")).not.toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Use for Git" }));
    expect(screen.getByLabelText("Git username")).toHaveValue("x-access-token");
    await user.clear(screen.getByLabelText("Git username"));
    expect(screen.getByText("Git username missing.")).toBeInTheDocument();
    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText("Git username"), "oauth2");

    await user.click(screen.getByRole("checkbox", { name: "Read only" }));
    await user.type(fill(), "coolify");
    expect(screen.getByText("Not a valid origin (scheme://host[:port]).")).toBeInTheDocument();
    expect(save).toBeDisabled();
    await user.clear(fill());
    await user.type(fill(), "https://coolify.example.net");
    await user.click(save);

    expect(requestDouble.calls).toEqual([{
        method: "patchRequest", path: "vault/items/6",
        body: expect.objectContaining({
            fields: {
                hosts: ["api.github.com"], headerName: "Authorization", headerTemplate: "Bearer {{secret}}",
                readOnly: true, allowHttp: false, git: true, gitUsername: "oauth2", fillOrigins: ["https://coolify.example.net"],
            },
        }),
    }]);

    unmount();
    editEntry(generic);
    expect(node("UI-VAULT-DIALOG-READONLY")).toBeNull();
    expect(node("UI-VAULT-DIALOG-HTTP")).toBeNull();
    expect(node("UI-VAULT-DIALOG-GIT")).toBeNull();
    expect(node("UI-VAULT-DIALOG-FILL")).toHaveTextContent("Nowhere — only for vault_http and Git");
});
```

Der Eintrag ist ein Bestandseintrag ohne die neuen Felder: Er prüft nebenbei, dass Standardwerte (`x-access-token`, alles aus) im Formular ankommen.

- [ ] **Step 2: Write the failing test (Detail)** — `client/src/pages/Vault/components/VaultDetail/__tests__/VaultDetail.test.jsx`

Import erweitern:

```jsx
import { act, fireEvent, screen, within } from "@testing-library/react";
```

Anhängen:

```jsx

const node = (id) => document.querySelector(`[data-ui-id='${id}']`);
const detail = (shown) => <VaultDetail item={shown} impersonating={false} onEdit={() => {}} onDelete={() => {}} />;

test("die Nutzung durch Agenten nennt nur Eingeschaltetes, ohne Option den Leerzustand je Typ, und fehlt bei Login", () => {
    const { rerender } = show({
        ...item, id: 6, name: "github-pat", type: "api_key", secretFields: ["token"],
        fields: {
            hosts: ["api.github.com"], headerName: "Authorization", headerTemplate: "Bearer {{secret}}",
            readOnly: true, allowHttp: false, git: true, gitUsername: "x-access-token", fillOrigins: ["https://coolify.example.net"],
        },
    });
    expect(within(node("UI-VAULT-DETAIL-USAGE")).getAllByRole("listitem").map((row) => row.textContent)).toEqual([
        "Read only", "Git · username x-access-token", "Fill in on https://coolify.example.net",
    ]);

    rerender(detail({ ...item, id: 6, name: "github-pat", type: "api_key", secretFields: ["token"], fields: { hosts: ["api.github.com"] } }));
    expect(within(node("UI-VAULT-DETAIL-USAGE")).queryAllByRole("listitem")).toEqual([]);
    expect(node("UI-VAULT-DETAIL-USAGE")).toHaveTextContent("vault_http over https");

    rerender(detail({ ...item, id: 7, name: "coolify-token", type: "generic", fields: { fillOrigins: [] }, secretFields: ["value"] }));
    expect(within(node("UI-VAULT-DETAIL-USAGE")).queryAllByRole("listitem")).toEqual([]);
    expect(node("UI-VAULT-DETAIL-USAGE")).toHaveTextContent("Manual use only — not filled in the browser");

    rerender(detail(item));
    expect(node("UI-VAULT-DETAIL-USAGE")).toBeNull();
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd client && npx vitest run src/pages/Vault`
Expected: FAIL — 2 von 7 Tests:
- `VaultItemDialog.test.jsx > API-Key zeigt die Nutzung durch Agenten …` mit `TestingLibraryElementError: Unable to find an accessible element with the role "checkbox" and name "Read only"`
- `VaultDetail.test.jsx > die Nutzung durch Agenten nennt nur Eingeschaltetes …` mit `TypeError: Expected container to be an Element, a Document or a DocumentFragment but got null.`

- [ ] **Step 4: Felder und Prüfungen** — `client/src/pages/Vault/vaultTypes.js` (vollständig)

```js
import { LogIn as IconLogIn, KeyRound as IconKeyRound, SquareTerminal as IconSquareTerminal, Database as IconDatabase, Lock as IconLock } from "lucide-react";

export const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const DB_ENGINES = [
    { value: "postgres", label: "PostgreSQL" },
    { value: "mysql", label: "MySQL" },
    { value: "sqlite", label: "SQLite" },
];

// `targets` are the fields whose change makes the server drop every stored secret of the item.
export const VAULT_TYPES = {
    login: {
        labelKey: "vault.types.login", icon: IconLogIn, secrets: ["password"], targets: ["origins"],
        defaults: { username: "", origins: "" },
    },
    api_key: {
        labelKey: "vault.types.apiKey", icon: IconKeyRound, secrets: ["token"], targets: ["hosts"],
        defaults: {
            hosts: "", headerName: "Authorization", headerTemplate: "Bearer {{secret}}",
            readOnly: false, allowHttp: false, git: false, gitUsername: "x-access-token", fillOrigins: "",
        },
    },
    ssh: {
        labelKey: "vault.types.ssh", icon: IconSquareTerminal, secrets: ["privateKey", "password", "passphrase"], targets: [],
        defaults: { username: "" },
    },
    database: {
        labelKey: "vault.types.database", icon: IconDatabase, secrets: ["password"], targets: ["host"],
        defaults: { engine: "postgres", host: "", port: "", database: "", username: "" },
    },
    generic: { labelKey: "vault.types.other", icon: IconLock, secrets: ["value"], targets: [], defaults: { fillOrigins: "" } },
};

export const TYPE_KEYS = Object.keys(VAULT_TYPES);

export const USAGE_FIELDS = ["readOnly", "allowHttp", "git", "gitUsername", "fillOrigins"];

const LIST_FIELDS = ["origins", "hosts", "fillOrigins"];

// Mirrors the required fields of Task 5 (`FIELDS` in server/validations/vault.js); the server stays authoritative.
const REQUIRED_FIELDS = {
    login: ["origins"], api_key: ["hosts"], ssh: ["username"], database: ["engine", "host", "database"], generic: [],
};

export const ownerKey = (item) => (item.organizationId ? `org-${item.organizationId}` : "personal");

// A database password is optional: SQLite has none, and the server accepts a database entry without one.
export const isSecretMissing = (type, values) => {
    if (type === "database") return false;
    if (type === "ssh") return !values.privateKey && !values.password;
    return VAULT_TYPES[type].secrets.some((field) => !values[field]);
};

export const missingFields = (type, payloadFields) => REQUIRED_FIELDS[type].filter((field) => {
    if (field === "host" && payloadFields.engine === "sqlite") return false;
    const value = payloadFields[field];
    return Array.isArray(value) ? value.length === 0 : value === undefined;
});

export const toFormFields = (type, fields = {}) => {
    const { defaults } = VAULT_TYPES[type];
    return Object.fromEntries(Object.entries({ ...defaults, ...fields })
        .filter(([key]) => key in defaults)
        .map(([key, value]) => {
            if (typeof defaults[key] === "boolean") return [key, value === true];
            return [key, Array.isArray(value) ? value.join(", ") : value == null ? "" : String(value)];
        }));
};

const splitList = (value) => value.split(/[\s,]+/).filter(Boolean);

export const toPayloadFields = (formFields) => Object.fromEntries(Object.entries(formFields).flatMap(([key, value]) => {
    if (typeof value === "boolean") return [[key, value]];
    if (LIST_FIELDS.includes(key)) return [[key, splitList(value)]];
    if (key === "gitUsername" && !formFields.git) return [];
    const trimmed = value.trim();
    if (!trimmed) return [];
    return [[key, key === "port" ? Number(trimmed) : trimmed]];
}));

const isOrigin = (value) => {
    try {
        const url = new URL(value);
        return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
            && url.pathname === "/" && !url.search && !url.hash;
    } catch {
        return false;
    }
};

export const usageProblems = (formFields) => ({
    gitUsername: formFields.git === true && !formFields.gitUsername.trim(),
    fillOrigins: typeof formFields.fillOrigins === "string" && splitList(formFields.fillOrigins).some((origin) => !isOrigin(origin)),
});

const hostOf = (origin) => {
    try {
        return new URL(origin).host;
    } catch {
        return origin;
    }
};

export const itemSubject = ({ type, fields = {} }) => {
    const joined = (user, host) => [user, host].filter(Boolean).join("@");
    if (type === "login") return joined(fields.username, fields.origins?.[0] && hostOf(fields.origins[0]));
    if (type === "api_key") return fields.hosts?.[0] || "";
    if (type === "database") return joined(fields.username, fields.host);
    if (type === "ssh") return fields.username || "";
    return "";
};

export const matchesSearch = (item, term) => {
    const needle = term.trim().toLowerCase();
    if (!needle) return true;
    const { username, host, hosts = [], origins = [] } = item.fields || {};
    return [item.name, item.description, username, host, ...hosts, ...origins]
        .some((value) => typeof value === "string" && value.toLowerCase().includes(needle));
};

export const detailRows = ({ type, fields = {} }) => {
    const rows = {
        login: [["vault.fields.username", fields.username], ["vault.fields.origins", fields.origins?.join(", ")]],
        api_key: [["vault.fields.hosts", fields.hosts?.join(", ")],
            ["vault.fields.header", fields.headerName && `${fields.headerName}: ${fields.headerTemplate || ""}`]],
        ssh: [["vault.fields.username", fields.username]],
        database: [["vault.fields.engine", DB_ENGINES.find((engine) => engine.value === fields.engine)?.label],
            ["vault.fields.host", fields.host], ["vault.fields.port", fields.port],
            ["vault.fields.database", fields.database], ["vault.fields.username", fields.username]],
    }[type] || [];
    return rows.filter(([, value]) => value !== undefined && value !== null && value !== "");
};
```

`detailRows` bleibt bewusst ohne die neuen Felder: Sie gehören in UI-VAULT-DETAIL-USAGE, nicht in UI-VAULT-DETAIL-FIELDS. Die Formularwerte von Login, SSH und Datenbank ändern sich nicht (der Bestandstest prüft `fields` eines Logins exakt).

- [ ] **Step 5: Eintrag-Dialog** — `client/src/pages/Vault/components/VaultItemDialog/VaultItemDialog.jsx`

(a) Import aus `vaultTypes.js` ersetzen:

```jsx
import {
    DB_ENGINES, NAME_PATTERN, TYPE_KEYS, USAGE_FIELDS, VAULT_TYPES, isSecretMissing, missingFields, ownerKey, toFormFields,
    toPayloadFields, usageProblems,
} from "../../vaultTypes.js";
```

(b) Direkt vor `const BINDING_KINDS = …` einfügen:

```jsx
const UsageSwitch = ({ id, dataUiId, label, hint, warning = false, checked, onChange }) => (
    <div className="vault-item-dialog-switch" data-ui-id={dataUiId}>
        <div className="vault-item-dialog-switch-label">
            <label htmlFor={id}>{label}</label>
            <span className={`vault-help${warning ? " vault-help--warning" : ""}`}>{hint}</span>
        </div>
        <ToggleSwitch id={id} checked={checked} onChange={onChange} />
    </div>
);
```

(c) Die Zeile `const saveBlocked = saving || !nameValid || fieldsMissing || (targetChanged && secretsMissing);` ersetzen durch:

```jsx
    const problems = usageProblems(form.fields);
    const saveBlocked = saving || !nameValid || fieldsMissing || (targetChanged && secretsMissing)
        || problems.gitUsername || problems.fillOrigins;
```

(d) Direkt vor `const secretPlaceholder = …` einfügen:

```jsx
    const gitUsername = form.fields.gitUsername?.trim();
    const gitHint = !form.fields.git ? t("vault.dialog.usage.off") : gitUsername
        ? <>{t("vault.dialog.usage.gitHint")} <span className="vault-mono">{gitUsername}</span></>
        : t("vault.dialog.usage.on");
```

(e) In der Felderschleife der Angaben `{Object.keys(form.fields).map((key) => (key === "engine" ? (` ersetzen durch:

```jsx
                            {Object.keys(form.fields).filter((key) => !USAGE_FIELDS.includes(key)).map((key) => (key === "engine" ? (
```

(f) Direkt nach dem schließenden `</div>` von `data-ui-id="UI-VAULT-DIALOG-APPROVAL"` (noch innerhalb von `vault-item-dialog-body`) einfügen:

```jsx

                        {"fillOrigins" in form.fields && (
                            <div className="vault-item-dialog-usage" role="group" aria-labelledby="vault-usage-title">
                                <h3 id="vault-usage-title">{t("vault.dialog.usage.title")}</h3>
                                {form.type === "api_key" && (
                                    <>
                                        <UsageSwitch id="vault-read-only" dataUiId="UI-VAULT-DIALOG-READONLY"
                                                     label={t("vault.dialog.usage.readOnly")} checked={form.fields.readOnly}
                                                     onChange={(value) => setField("readOnly", value)}
                                                     hint={t(form.fields.readOnly ? "vault.dialog.usage.readOnlyHint" : "vault.dialog.usage.off")} />
                                        <UsageSwitch id="vault-allow-http" dataUiId="UI-VAULT-DIALOG-HTTP"
                                                     label={t("vault.dialog.usage.allowHttp")} checked={form.fields.allowHttp}
                                                     onChange={(value) => setField("allowHttp", value)} warning={form.fields.allowHttp}
                                                     hint={t(form.fields.allowHttp ? "vault.dialog.usage.allowHttpWarning" : "vault.dialog.usage.allowHttpOff")} />
                                        <div className="vault-item-dialog-git" data-ui-id="UI-VAULT-DIALOG-GIT">
                                            <UsageSwitch id="vault-git" label={t("vault.dialog.usage.git")} checked={form.fields.git}
                                                         onChange={(value) => setField("git", value)} hint={gitHint} />
                                            {form.fields.git && (
                                                <div className={`form-group${problems.gitUsername ? " is-error" : ""}`}>
                                                    <label htmlFor="vault-git-username">{t("vault.dialog.usage.gitUsername")}</label>
                                                    <IconInput id="vault-git-username" icon={IconUser} customClass="vault-mono"
                                                               value={form.fields.gitUsername} setValue={(value) => setField("gitUsername", value)} />
                                                    {problems.gitUsername ? (
                                                        <span className="vault-help vault-help--error" role="alert">{t("vault.dialog.usage.gitUsernameMissing")}</span>
                                                    ) : (
                                                        <span className="vault-help">{t("vault.dialog.usage.gitUsernameHelp")}</span>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    </>
                                )}
                                <div className={`form-group${problems.fillOrigins ? " is-error" : ""}`} data-ui-id="UI-VAULT-DIALOG-FILL">
                                    <label htmlFor="vault-fill-origins">{t("vault.dialog.usage.fill")}</label>
                                    <IconInput id="vault-fill-origins" icon={IconGlobe} customClass="vault-mono"
                                               value={form.fields.fillOrigins} setValue={(value) => setField("fillOrigins", value)} />
                                    {problems.fillOrigins ? (
                                        <span className="vault-help vault-help--error" role="alert">{t("vault.dialog.usage.fillInvalid")}</span>
                                    ) : !form.fields.fillOrigins.trim() && (
                                        <span className="vault-help">{t("vault.dialog.usage.fillEmpty")}</span>
                                    )}
                                </div>
                            </div>
                        )}
```

Zustände im Code: READONLY `default` „aus“ / `selected` „an — nur lesen“; HTTP `default` „aus — nur https“ / `selected` „an — der Token geht unverschlüsselt über das Netz“ in `--warning`; GIT `default` „aus“ / `selected` „an · Git-Benutzername <Wert in mono>“ mit Feld / `error` „Git-Benutzername fehlt.“ (`role="alert"`, Speichern gesperrt); FILL `default` Origins im Feld / `empty` „Nirgends — nur für vault_http und Git“ / `error` „Keine gültige Origin (scheme://host[:port]).“ (`role="alert"`, Speichern gesperrt). `data-ui-id` von GIT sitzt am Wrapper um Schalter **und** Benutzerfeld, damit `error` im selben Knoten liegt.

- [ ] **Step 6: Stile des Dialogs** — `client/src/pages/Vault/components/VaultItemDialog/styles.sass`

Direkt vor `  .vault-help` einfügen (Einrückung zwei Leerzeichen, innerhalb `.vault-item-dialog`):

```sass
  .vault-item-dialog-switch-label
    display: flex
    flex-direction: column
    gap: tokens.$space-1

  .vault-item-dialog-usage
    display: flex
    flex-direction: column
    gap: tokens.$space-3

    h3
      margin: 0
      padding-top: tokens.$space-2
      border-top: 1px solid colors.$gray
      font: tokens.$type-heading

  .vault-item-dialog-git
    display: flex
    flex-direction: column
    gap: tokens.$space-2

  .form-group.is-error .input
    border-color: colors.$error

```

- [ ] **Step 7: Detail** — `client/src/pages/Vault/components/VaultDetail/VaultDetail.jsx`

(a) Direkt vor `export const VaultDetail =` einfügen:

```jsx
const USAGE_TYPES = ["api_key", "generic"];

```

(b) Direkt vor `const lastUsed = item.lastUsedAt …` einfügen:

```jsx
    const { readOnly, allowHttp, git, gitUsername, fillOrigins = [] } = item.fields || {};
    const usage = [
        readOnly && ["readOnly", t("vault.detail.usage.readOnly")],
        allowHttp && ["allowHttp", t("vault.detail.usage.allowHttp")],
        git && ["git", t("vault.detail.usage.git", { user: gitUsername, interpolation: { escapeValue: false } })],
        fillOrigins.length > 0 && ["fill", <>{t("vault.detail.usage.fill")} <span className="vault-detail-mono">{fillOrigins.join(", ")}</span></>],
    ].filter(Boolean);
```

(c) Direkt nach dem `vault-detail-section`-Block mit `data-ui-id="UI-VAULT-DETAIL-POLICY"` (vor `<ActionConfirmDialog …`) einfügen:

```jsx

            {USAGE_TYPES.includes(item.type) && (
                <div className="vault-detail-section" data-ui-id="UI-VAULT-DETAIL-USAGE">
                    <h4>{t("vault.detail.usage.title")}</h4>
                    {usage.length > 0 ? (
                        <ul className="vault-detail-usage">
                            {usage.map(([key, content]) => <li key={key}>{content}</li>)}
                        </ul>
                    ) : (
                        <p className="vault-detail-hint">
                            {t(item.type === "generic" ? "vault.detail.usage.emptyGeneric" : "vault.detail.usage.empty")}
                        </p>
                    )}
                </div>
            )}
```

`client/src/pages/Vault/components/VaultDetail/styles.sass` — direkt nach dem Block `  .vault-detail-hint` (drei Zeilen) einfügen:

```sass

  .vault-detail-usage
    display: flex
    flex-direction: column
    gap: tokens.$space-1
    margin: 0
    padding: 0
    list-style: none
    font: tokens.$type-body

  .vault-detail-mono
    font: tokens.$type-mono
```

Zeilen wie im Artboard `ui-vault.html`: „Nur lesen“, „Auch über http“, „Git · Benutzername <name>“, „Eintragen auf <Origins in mono>“; ausgeschaltete Optionen fehlen. `empty` (API-Key ohne Option) „vault_http über https“ und `disabled` („Sonstiges“ ohne `fillOrigins`, Manifest-Revision 17) „Nur von Hand nutzbar — kein Eintragen im Browser“, beide in `--subtext`. Login, SSH und Datenbank rendern die Region nicht.

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd client && npx vitest run src/pages/Vault`
Expected: PASS (2 Dateien, 7 Tests).

- [ ] **Step 9: Lint**

Run: `cd client && npx eslint src/pages/Vault`
Expected: keine Ausgabe (keine Fehler, keine Warnungen).

- [ ] **Step 10: Commit**

```bash
git add client/src/pages/Vault
git commit -m "Vault: Nutzung durch Agenten im Eintrag-Dialog und in den Details"
```

---

### Task 11: Client — Freigabe-Karte und Einstellungen

**Files:**
- Modify: `client/src/common/components/VaultApprovalCard/VaultApprovalCard.jsx` (+ styles)
- Modify: `client/src/pages/Settings/pages/Vault/Vault.jsx` (+ styles)
- Test: `client/src/common/components/VaultApprovalCard/__tests__/VaultApprovalStack.test.jsx`, `client/src/pages/Settings/pages/Vault/__tests__/VaultSettings.test.jsx`

**Interfaces:**
- Consumes: Task 9 (Schlüssel), Payload Task 2 (`tool`, `access`, `target`), Settings Task 1 (`fillAnywhere`).

**Design:**
| Element | Label | Zustände | Anker |
|---|---|---|---|
| UI-VAULT-APPROVAL-CARD | Freigabe angefordert | default, empty, partial, loading, error | zeigt Werkzeug und Ziel |
| UI-VAULT-APPROVAL-WRITE | schreibt | default, empty | nur bei `access: "write"` |
| UI-VAULT-SETTINGS-FILLANY | Token auf jeder Seite eintragen erlauben | default, selected | gespeichert über UI-VAULT-SETTINGS-SAVE |

**Tests:** 2 Tests — (1) Karte: Werkzeug-/Zielzeile, Abzeichen „schreibt“ nur bei `write`; (2) Einstellungen: Schalter wird mit `fillAnywhere` geladen und gespeichert (bestehenden Test erweitern).

**Parallel:** Task 3, Task 10, Task 12 (Welle B).

Umsetzung nach Artboard `docs/design/mockups/ui-vault-approval.html`: Kopfzeile „Freigabe angefordert“ mit dem Abzeichen rechts (je Karte, nur bei `access === "write"`), darunter Agent und Server, Eintrag, dann die Werkzeugzeile in `--type-mono`. `target` kommt fertig vom Server (Task 2/3/4/7: `POST api.github.com/repos/o/r/issues`, `Git · github.com/o/r`, Origin beim Eintragen); der Client setzt nur bei den Eintrage-Werkzeugen (`browser_fill_secret`, `browser_fill_credential`) „Eintragen auf <Origin>“ davor, wie das Artboard es zeigt. Ohne `tool` (alte Nutzlast) bleibt die Zeile der rohe `target` wie bisher. Zustände der Karte (`default`, `empty`, `partial`, `loading`, `error`) sind Bestand aus Teilprojekt 1 und bleiben unverändert; neu sind nur Werkzeugzeile und Abzeichen. Das Abzeichen ist Pill wie der Schlüsselstatus der Einstellungen (`--type-caption`, `--radius-sm`, `--space-1`/`--space-2`, `--warning` auf `--warning-opacity`, Icon `PenLine` in Schriftgröße).

Einstellungen nach Artboard `ui-vault-settings.html`: Zeile nach IP-Bindung, vor dem Proxy-Hinweis; Schalter plus Zustandstext („aus“ / „an — …“); gespeichert nur über UI-VAULT-SETTINGS-SAVE zusammen mit Adresse und IP-Bindung. Der Bestandstest fragte die einzige Checkbox der Seite ohne Bereich ab (`getByRole("checkbox")`); mit dem zweiten Schalter wird er auf die Zeile eingegrenzt.

- [ ] **Step 1: Write the failing test (Karte)** — `client/src/common/components/VaultApprovalCard/__tests__/VaultApprovalStack.test.jsx`

Import erweitern:

```jsx
import { act, screen, waitFor, within } from "@testing-library/react";
```

Anhängen:

```jsx

test("the card names tool and target; only a writing request carries the badge", () => {
    mount();
    push([
        { ...approval("a1", 120_000), item: "github-pat", tool: "vault_http", access: "write", target: "POST api.github.com/repos/o/r/issues" },
        { ...approval("a2", 110_000), item: "github-pat", tool: "git", access: "read", target: "Git · github.com/o/r" },
        { ...approval("a3", 100_000), item: "coolify-login", tool: "browser_fill_credential", access: "write", target: "https://coolify.example.net" },
    ]);
    const badge = (line) => within(screen.getByText(line).closest(".vault-approval-card")).queryByText(t("vault.approval.write"));

    expect(badge("POST api.github.com/repos/o/r/issues")).toBeInTheDocument();
    expect(badge("Git · github.com/o/r")).not.toBeInTheDocument();
    expect(badge(t("vault.approval.target.fill", { origin: "https://coolify.example.net" }))).toBeInTheDocument();
    expect(document.querySelectorAll("[data-ui-id='UI-VAULT-APPROVAL-WRITE']")).toHaveLength(2);
});
```

- [ ] **Step 2: Write the failing test (Einstellungen)** — `client/src/pages/Settings/pages/Vault/__tests__/VaultSettings.test.jsx`

Import erweitern:

```jsx
import { screen, waitFor, within } from "@testing-library/react";
```

Nach `const mount = …` einfügen:

```jsx
const node = (id) => document.querySelector(`[data-ui-id='${id}']`);
const toggle = (id) => within(node(id)).getByRole("checkbox");
```

Den Test `an empty address is suggested from the browser; …` vollständig ersetzen durch:

```jsx
test("an empty address is suggested from the browser; a wrong one blocks saving, a valid one is saved with the binding default and fillAnywhere", async () => {
    const user = userEvent.setup();
    requestDouble.stub("getRequest", "vault/settings", settings({ fillAnywhere: true }));
    requestDouble.stub("patchRequest", "vault/settings", settings({ agentUrl: "http://192.168.2.10:6989", ipBindingDefault: false, fillAnywhere: false }));
    mount();
    const field = await screen.findByRole("textbox");
    const save = () => screen.getByRole("button", { name: t("settings.vault.saveSettings") });
    expect(field).toHaveValue(window.location.origin);
    expect(screen.getByText(t("settings.vault.agentUrl.suggested"))).toBeInTheDocument();
    expect(toggle("UI-VAULT-SETTINGS-FILLANY")).toBeChecked();
    expect(within(node("UI-VAULT-SETTINGS-FILLANY")).getByText(t("settings.vault.fillAnywhere.on"))).toBeInTheDocument();

    await user.clear(field);
    await user.type(field, "192.168.2.10:6989");
    expect(screen.getByText(t("settings.vault.agentUrl.invalid"))).toBeInTheDocument();
    expect(screen.queryByText(t("settings.vault.agentUrl.suggested"))).not.toBeInTheDocument();
    expect(save()).toBeDisabled();

    await user.clear(field);
    await user.type(field, "http://192.168.2.10:6989");
    await user.click(toggle("UI-VAULT-SETTINGS-IPBIND"));
    await user.click(toggle("UI-VAULT-SETTINGS-FILLANY"));
    expect(within(node("UI-VAULT-SETTINGS-FILLANY")).getByText(t("settings.vault.fillAnywhere.off"))).toBeInTheDocument();
    await user.click(save());

    await waitFor(() => expect(requestDouble.calls).toContainEqual({
        method: "patchRequest", path: "vault/settings",
        body: { agentUrl: "http://192.168.2.10:6989", ipBindingDefault: false, fillAnywhere: false },
    }));
    expect(vaultAvailable.refresh).toHaveBeenCalled();
    expect(toggle("UI-VAULT-SETTINGS-IPBIND")).not.toBeChecked();
    expect(toggle("UI-VAULT-SETTINGS-FILLANY")).not.toBeChecked();
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd client && npx vitest run src/common/components/VaultApprovalCard src/pages/Settings/pages/Vault`
Expected: FAIL — 2 von 12 Tests:
- `VaultApprovalStack.test.jsx > the card names tool and target; only a writing request carries the badge` mit `expect(received).toBeInTheDocument()` … `received value must be an HTMLElement or an SVGElement. Received has value: null`
- `VaultSettings.test.jsx > an empty address is suggested … and fillAnywhere` mit `TypeError: Expected container to be an Element, a Document or a DocumentFragment but got null.`

- [ ] **Step 4: Freigabe-Karte** — `client/src/common/components/VaultApprovalCard/VaultApprovalCard.jsx` (vollständig)

```jsx
import { useTranslation } from "react-i18next";
import { PenLine as IconPenLine } from "lucide-react";
import Button from "@/common/components/Button";
import Icon from "@/common/components/Icon";

// Only for the width of the bar. The server decides when a request has expired.
const APPROVAL_TTL_MS = 120000;
const FILL_TOOLS = ["browser_fill_secret", "browser_fill_credential"];

const formatRemaining = (ms) => {
    const seconds = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

export const VaultApprovalCard = ({ approval, now, sending, onAnswer }) => {
    const { t } = useTranslation();
    const remaining = approval.deadline - now;
    const expired = remaining <= 0;
    const disabled = expired || sending;
    const agent = approval.agentType ? t(`vault.agents.${approval.agentType}`) : null;
    const toolLine = approval.target && (FILL_TOOLS.includes(approval.tool)
        ? t("vault.approval.target.fill", { origin: approval.target, interpolation: { escapeValue: false } })
        : approval.target);

    // On the card, not on the document: a dialog underneath needs Esc for itself.
    const onKeyDown = (event) => {
        if (disabled) return;
        if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onAnswer("deny");
        } else if (event.key === "Enter" && event.target === event.currentTarget) {
            event.preventDefault();
            onAnswer("once");
        }
    };

    return (
        <div className={`vault-approval-card${expired ? " is-expired" : ""}`} tabIndex={0} role="group"
             aria-label={t("vault.approval.title")} onKeyDown={onKeyDown}>
            <div className="vault-approval-head">
                <h3>{t("vault.approval.title")}</h3>
                {approval.access === "write" && (
                    <span className="vault-approval-write" data-ui-id="UI-VAULT-APPROVAL-WRITE">
                        <Icon icon={IconPenLine} />
                        {t("vault.approval.write")}
                    </span>
                )}
            </div>
            {agent && (
                <div className="vault-approval-who">
                    {approval.entryName
                        ? t("vault.approval.who", { agent, server: approval.entryName, interpolation: { escapeValue: false } })
                        : agent}
                </div>
            )}
            {approval.impersonated && <div className="vault-approval-who">{t("vault.approval.impersonated")}</div>}
            <div className="vault-approval-target">{approval.item}</div>
            {toolLine && <div className="vault-approval-target">{toolLine}</div>}
            {(sending || expired) && (
                <div className="vault-approval-status" role="status">
                    {t(expired ? "vault.approval.expired" : "vault.approval.sending")}
                </div>
            )}
            <div className="vault-approval-actions">
                <Button type="primary" text={t("vault.approval.actions.once")} disabled={disabled} loading={sending}
                        onClick={() => onAnswer("once")} />
                {!approval.impersonated && (
                    <Button text={t("vault.approval.actions.session")} disabled={disabled} onClick={() => onAnswer("session")} />
                )}
                <Button text={t("vault.approval.actions.deny")} disabled={disabled} onClick={() => onAnswer("deny")} />
            </div>
            <div className="vault-approval-timer">{formatRemaining(remaining)}</div>
            <div className="vault-approval-bar">
                <i style={{ width: `${Math.min(1, Math.max(0, remaining / APPROVAL_TTL_MS)) * 100}%` }} />
            </div>
        </div>
    );
};
```

`escapeValue: false`, weil i18next sonst `/` der Origin als `&#x2F;` in den Textknoten schriebe (React escapet selbst). `VaultApprovalStack.jsx` bleibt unverändert: Die neuen Felder `tool`, `access`, `target` gehen mit der Anfrage durch.

- [ ] **Step 5: Stile der Karte** — `client/src/common/components/VaultApprovalCard/styles.sass`

Innerhalb `.vault-approval-card` den Block

```sass
  h3
    margin: 0
    font: tokens.$type-heading
```

ersetzen durch:

```sass
  .vault-approval-head
    display: flex
    align-items: center
    justify-content: space-between
    gap: tokens.$space-2

  h3
    margin: 0
    font: tokens.$type-heading

  .vault-approval-write
    display: inline-flex
    align-items: center
    gap: tokens.$space-1
    padding: tokens.$space-1 tokens.$space-2
    border-radius: tokens.$radius-sm
    font: tokens.$type-caption
    color: colors.$warning
    background: colors.$warning-opacity

    svg
      width: 1em
      height: 1em
```

- [ ] **Step 6: Einstellungen** — `client/src/pages/Settings/pages/Vault/Vault.jsx`

(a) Nach `const [ipBindingDefault, setIpBindingDefault] = useState(true);` einfügen:

```jsx
    const [fillAnywhere, setFillAnywhere] = useState(false);
```

(b) In `apply` nach `setIpBindingDefault(data.ipBindingDefault !== false);` einfügen:

```jsx
        setFillAnywhere(data.fillAnywhere === true);
```

(c) In `save` die Zeile mit `patchRequest` ersetzen durch:

```jsx
            apply(await patchRequest("vault/settings", { agentUrl: trimmed || null, ipBindingDefault, fillAnywhere }));
```

(d) Direkt nach dem schließenden `</SettingItem>` von `dataUiId="UI-VAULT-SETTINGS-IPBIND"` einfügen:

```jsx
                <SettingItem title={s("fillAnywhere.title")} description={s("fillAnywhere.description")}
                             dataUiId="UI-VAULT-SETTINGS-FILLANY">
                    <div className="vault-toggle-row">
                        <ToggleSwitch id="vault-fill-anywhere" checked={fillAnywhere} onChange={setFillAnywhere} />
                        <span className="vault-toggle-status">{s(fillAnywhere ? "fillAnywhere.on" : "fillAnywhere.off")}</span>
                    </div>
                </SettingItem>
```

`client/src/pages/Settings/pages/Vault/styles.sass` — direkt vor `  .setting-input.is-error .input` einfügen:

```sass
  .vault-toggle-row
    display: flex
    align-items: center
    gap: tokens.$space-2

  .vault-toggle-status
    font: tokens.$type-caption
    color: colors.$subtext

```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd client && npx vitest run src/common/components/VaultApprovalCard src/pages/Settings/pages/Vault`
Expected: PASS (2 Dateien, 12 Tests).

- [ ] **Step 8: Lint**

Run: `cd client && npx eslint src/common/components/VaultApprovalCard src/pages/Settings/pages/Vault`
Expected: `0 errors, 2 warnings` — beide schon vor dem Task in `Settings/pages/Vault/Vault.jsx` (`react-refresh/only-export-components` Zeile 23, `react-hooks/set-state-in-effect` in `useEffect` mit `load()`).

- [ ] **Step 9: Commit**

```bash
git add client/src/common/components/VaultApprovalCard client/src/pages/Settings/pages/Vault
git commit -m "Vault: Werkzeug, Ziel und Abzeichen „schreibt“ auf der Freigabe-Karte, Eintragen auf jeder Seite"
```

---

### Task 12: Client — Agenten-Zugang und Agenten-Keys

**Files:**
- Modify: `client/src/pages/Servers/components/AgentAccessDialog/AgentAccessDialog.jsx` (+ styles)
- Modify: `client/src/pages/Settings/pages/Account/components/AgentKeysSection/AgentKeysSection.jsx`
- Test: `client/src/pages/Servers/components/AgentAccessDialog/__tests__/AgentAccessDialog.test.jsx`

**Interfaces:**
- Consumes: Task 9 (Schlüssel), Task 8 (`agentTypes` mit `git`, Ergebnis `no_git_entries`).

**Design:**
| Element | Label | Zustände | Anker |
|---|---|---|---|
| UI-AGENT-ACCESS-SETUP | Einrichten | default, loading, error, disabled, partial | dritter Haken Git |
| UI-AGENT-ACCESS-RESULT | Ergebnis | default, empty, success, partial, error | Git-Ergebnis |
| UI-AGENT-ACCESS-KEYS | Agenten auf diesem Server | wie Bestand | Git als Agent |
| UI-AGENT-ACCESS-GIT-NOTE | Hinweis Git über SSH | default, empty | sichtbar, solange Git gewählt ist |
| UI-API-KEYS-AGENTS | Agenten-Schlüssel | wie Bestand | Git-Zeilen |

**Tests:** 2 Tests — (1) Git-Haken: Hinweis erscheint/verschwindet, Einrichten sendet `agentTypes` mit `git`, Ergebnis „Git eingerichtet …“ bzw. `no_git_entries`; (2) Key-Liste zeigt Agent „Git“.

**Parallel:** Task 3, Task 10, Task 11 (Welle B).

Umsetzung nach Artboard `docs/design/mockups/ui-agent-access.html` und Anleitung `ui-agent-access.md` (Rev. 16): dritter Haken „Git“ (nicht vorbelegt), darunter — nur solange Git angehakt ist — UI-AGENT-ACCESS-GIT-NOTE mit Info-Icon in `--subtext`, kein `role="alert"`, sperrt „Einrichten“ nicht. Die Bestandszustände von SETUP (`loading`, `error`, `disabled`, `partial`), RESULT (`empty`, `error` mit Befehl und „Kopieren“, `partial`) und KEYS gelten für Git unverändert, weil sie nicht am Agententyp hängen; neu sind nur die Erfolgszeile für Git und die Zeile für `no_git_entries`. Die Agent-Beschriftung kommt wie bisher aus `vault.agents.<agentType>` — mit `vault.agents.git` aus Task 9 zeigen KEYS und UI-API-KEYS-AGENTS „Git“ ohne weiteren Code. In UI-API-KEYS-AGENTS ordnet der Task die Keys eines Servers nach Agent (Claude Code · Codex · Git, Beispiel im Manifest); die Liste kommt neuester zuerst vom Server, ein später eingerichteter Git-Key stünde sonst oben. Im Agenten-Zugang bleibt die Reihenfolge des Servers, weil die Vorbelegung der Adresse den neuesten Key braucht.

Datenvertrag mit Task 8: Die Erfolgszeile „Git eingerichtet für root: https://github.com läuft über Outpost.“ braucht die eingerichteten Hosts. Der Client liest sie aus `result.hosts` (`string[]`, Hostnamen bzw. `host:port` wie in den Einträgen) des Ergebnisses für `git` und schreibt sie als `https://<host>`, kommagetrennt. „Schnittstellen“ Task 8 liefert dieses Feld für jedes Git-Ergebnis (bei `no_git_entries` `[]`). `no_git_entries` erkennt der Client am `reason`, unabhängig von `status`; das Ergebnis hat `id: null` und keinen Befehl, also weder „Kopieren“ noch Key-Hinweis, und `discardPending` überspringt es (`id != null`).

- [ ] **Step 1: Write the failing tests** — `client/src/pages/Servers/components/AgentAccessDialog/__tests__/AgentAccessDialog.test.jsx`

Import ergänzen (vor `import { AgentAccessDialog } …`):

```jsx
import AgentKeysSection from "@/pages/Settings/pages/Account/components/AgentKeysSection";
```

Anhängen:

```jsx

test.each([
    ["set up", { id: 46, agentType: "git", status: "configured", remoteUser: "root", hosts: ["github.com"], probe: null, replacedRegistration: false },
        "Git set up for root: https://github.com runs through Outpost."],
    ["without a Git entry", { id: null, agentType: "git", hosts: [], status: "manual", reason: "no_git_entries", remoteUser: "root", probe: null, replacedRegistration: false },
        t("servers.agentAccess.result.noGitEntries")],
])("the SSH note follows the Git checkbox, setup sends git, and the result says %s", async (_, result, text) => {
    const user = userEvent.setup();
    open();
    const git = screen.getByRole("checkbox", { name: t("vault.agents.git") });
    expect(git).not.toBeChecked();
    expect(node("UI-AGENT-ACCESS-GIT-NOTE")).toBeNull();

    await user.click(git);
    expect(node("UI-AGENT-ACCESS-GIT-NOTE")).toHaveTextContent("Remotes over SSH (git@github.com:) do not go through the vault — switch them to HTTPS.");
    await user.click(git);
    expect(node("UI-AGENT-ACCESS-GIT-NOTE")).toBeNull();
    await user.click(git);
    await runSetup(user, [result]);

    expect(requestDouble.calls).toContainEqual({
        method: "postRequest", path: "vault/agent-keys",
        body: { entryId: 7, agentTypes: ["claude", "codex", "git"], agentUrl: "http://192.168.2.10:6989", allowedCidrs: [] },
    });
    expect(node("UI-AGENT-ACCESS-RESULT")).toHaveTextContent(text);
});

test("the account's agent keys list Git as the third agent of a server, after Claude Code and Codex", async () => {
    vaultAvailable.current = { ...AVAILABLE, enabled: true };
    const key = (id, agentType) => ({
        id, entryId: 7, agentType, pending: false, ipBinding: true, allowedCidrs: [],
        agentUrl: "http://192.168.2.10:6989", createdAt: "2026-10-10T08:00:00.000Z", lastUsedAt: null,
    });
    requestDouble.stub("getRequest", "vault/agent-keys", { keys: [key(50, "git"), key(49, "codex"), key(48, "claude")] });
    renderWithProviders(<AgentKeysSection />, { providers: [ToastProvider, Servers] });

    const section = node("UI-API-KEYS-AGENTS");
    await within(section).findByText(t("vault.agents.git"));
    expect([...section.querySelectorAll(".item-details h3")].map((heading) => heading.textContent))
        .toEqual([t("vault.agents.claude"), t("vault.agents.codex"), t("vault.agents.git")]);
});
```

Der erste Test prüft Erfolg und `no_git_entries` als zwei Fälle desselben Verhaltens; die Texte mit `<mono>` vergleicht er als `textContent`. Der zweite rendert UI-API-KEYS-AGENTS mit derselben Datei-Infrastruktur (Server 7 = web01, `useVaultAvailable` mit `enabled`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd client && npx vitest run src/pages/Servers/components/AgentAccessDialog`
Expected: FAIL — 3 von 8 Tests:
- beide Fälle von `the SSH note follows the Git checkbox …` mit `TestingLibraryElementError: Unable to find an accessible element with the role "checkbox" and name "Git"`
- `the account's agent keys list Git as the third agent …` mit `AssertionError: expected [ 'Git', 'Codex', 'Claude Code' ] to deeply equal [ 'Claude Code', 'Codex', 'Git' ]`

- [ ] **Step 3: Agenten-Zugang** — `client/src/pages/Servers/components/AgentAccessDialog/AgentAccessDialog.jsx`

(a) Die beiden Importzeilen von `react-i18next` und `lucide-react` ersetzen durch:

```jsx
import { Trans, useTranslation } from "react-i18next";
import { Copy as IconCopy, Info as IconInfo, KeyRound as IconKeyRound, Link as IconLink, Network as IconNetwork } from "lucide-react";
```

(b) `const AGENT_TYPES = ["claude", "codex"];` ersetzen durch:

```jsx
const AGENT_TYPES = ["claude", "codex", "git"];
```

(c) `const [agents, setAgents] = useState({ claude: true, codex: true });` ersetzen durch:

```jsx
    const [agents, setAgents] = useState({ claude: true, codex: true, git: false });
```

(d) In `resultText` direkt nach `const resultText = (result) => {` einfügen:

```jsx
        if (result.reason === "no_git_entries") return t("servers.agentAccess.result.noGitEntries");
        if (result.status === "configured" && result.agentType === "git") {
            const hosts = (result.hosts || []).map((host) => `https://${host}`).join(", ");
            return (
                <Trans i18nKey="servers.agentAccess.result.successGit" values={{ user: result.remoteUser, hosts }}
                       components={{ mono: <span className="mono" /> }} tOptions={raw} />
            );
        }
```

`tOptions={raw}` aus demselben Grund wie bei `t(…, raw)` im Bestand: ohne `escapeValue: false` stünde `https:&#x2F;&#x2F;github.com` im Text.

(e) Im SETUP-Formular direkt nach dem schließenden `</div>` von `agent-access-checks` einfügen:

```jsx
                    {agents.git && (
                        <p className="agent-access-help agent-access-git-note" data-ui-id="UI-AGENT-ACCESS-GIT-NOTE">
                            <Icon icon={IconInfo} />
                            <span><Trans i18nKey="servers.agentAccess.gitNote" components={{ mono: <span className="mono" /> }} /></span>
                        </p>
                    )}
```

Zustände von GIT-NOTE: `default` sichtbar mit „Remotes per SSH (git@github.com:) gehen nicht über den Vault — auf HTTPS umstellen.“ (`git@github.com:` in `--type-mono`); `empty` nicht gerendert, solange Git nicht angehakt ist.

`client/src/pages/Servers/components/AgentAccessDialog/styles.sass` — direkt vor `  .agent-access-ipbind` (dem Block mit `order: 4`) einfügen:

```sass
  .agent-access-git-note
    order: 3
    display: flex
    align-items: center
    gap: tokens.$space-2

    svg
      flex-shrink: 0

```

`order: 3` wie `.agent-access-checks`: SETUP ist `display: contents`, der Hinweis folgt in DOM-Reihenfolge direkt unter den Haken und vor IPBIND (`order: 4`).

- [ ] **Step 4: Agenten-Schlüssel** — `client/src/pages/Settings/pages/Account/components/AgentKeysSection/AgentKeysSection.jsx`

(a) Nach `const raw = { interpolation: { escapeValue: false } };` einfügen:

```jsx
const AGENT_ORDER = ["claude", "codex", "git"];
const byAgent = (a, b) => AGENT_ORDER.indexOf(a.agentType) - AGENT_ORDER.indexOf(b.agentType);
```

(b) Die Zeile `const groups = [...keys.reduce(…), new Map())];` ersetzen durch:

```jsx
    const groups = [...keys.reduce((map, key) => map.set(key.entryId, [...(map.get(key.entryId) || []), key]), new Map())]
        .map(([entryId, entryKeys]) => [entryId, [...entryKeys].sort(byAgent)]);
```

Die Kopfzeile „Agenten-Schlüssel erreichen nur den MCP-Endpunkt, Git-Keys nur den Git-Proxy.“ kommt aus `settings.account.agentKeys.sectionDescription` (Task 9); Zuletzt genutzt, IP-Bindung, Entziehen und Bearbeiten gelten für Git-Zeilen unverändert.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd client && npx vitest run src/pages/Servers/components/AgentAccessDialog`
Expected: PASS (1 Datei, 8 Tests).

Run: `cd client && npx vitest run src/pages/Settings`
Expected: PASS — `VaultSettings.test.jsx` rendert `AgentKeysSection` mit und bleibt grün.

- [ ] **Step 6: Lint**

Run: `cd client && npx eslint src/pages/Servers/components/AgentAccessDialog src/pages/Settings/pages/Account/components/AgentKeysSection`
Expected: `0 errors, 4 warnings` — alle vier schon vor dem Task vorhanden (`react-refresh/only-export-components` für `isValidCidr`/`parseCidrs`, `react-hooks/set-state-in-effect` in beiden Lade-Effekten).

- [ ] **Step 7: Commit**

```bash
git add client/src/pages/Servers/components/AgentAccessDialog client/src/pages/Settings/pages/Account/components/AgentKeysSection
git commit -m "Vault: Git als dritter Agent im Agenten-Zugang und bei den Agenten-Schlüsseln"
```

### Task 13: Doku, volle Prüfung, Handtest

**Files:**
- Modify: `docs/vault.md`
- Befunde aus Step 4–6 werden in der Datei des zuständigen Tasks behoben (dessen **Files:**-Zeile).

**Interfaces:**
- Consumes: alle Tasks.

**Design:** kein UI-Anteil.

**Tests:** 0 neue Tests — volle Suite (`yarn test`), Lint, Client-Build, Migration 0049 gegen MySQL 8.4, Handtest mit echtem GitHub-PAT (Spec „Tests“ Punkt 9).

**Parallel:** none — braucht alle vorigen Tasks.

- [ ] **Step 1: `docs/vault.md` ergänzen**

In `docs/vault.md` (englisch, Stil der Datei) einfügen bzw. ändern:

1. Abschnitt **3. Entries**, Tabelle der Typen: Zeile *API key* bekommt in „Fields“ `read only, allow http, use for Git (Git username), fill origins` und in „Usable by agents“ `vault_http`, `git`, `browser_fill_secret`; Zeile *Other* in „Fields“ `fill origins` und „Usable by agents“ `browser_fill_secret`. Darunter ein Absatz **Use by agents** mit den fünf Schaltern und ihren Standardwerten wie in der Spec „Datenmodell“, einschließlich der Regel zu Ports in `hosts` („leave out the default port“) und der Mindestlänge von 4 Zeichen für Tokens.
2. Abschnitt **4. Agent access**, „Set up with one click“: Schritt 2 nennt **Git** als dritten Agenten; neuer Unterabschnitt **Git** mit: was die Einrichtung schreibt (die drei `git config --file "$HOME/.gitconfig"`-Zeilen aus der Spec, Modus 600), dass nur Hosts von Einträgen mit „Use for Git“ eingerichtet werden und man nach neuen Hosts erneut einrichtet, dass SSH-Remotes nicht über den Vault laufen und wie man umstellt (`git remote set-url origin https://github.com/o/r.git`), dass `git config` den Key für die Laufzeit des Befehls in der Prozessliste zeigt, die Grenzen (30 Git-Vorgänge pro Minute je Git-Key, höchstens 4 gleichzeitige Weiterleitungen, kein Dumb-HTTP und kein LFS → 404, Lesevorgänge ohne Zeitgrenze), und dass Entziehen nur die eigenen Zeilen entfernt und die Git-Sitzung beendet.
3. Abschnitt **5. Approvals**: Lesen und Schreiben getrennt (was als schreibend gilt), „For this session“ je Art — Lesen, Schreiben über API/Git und Eintragen im Browser sind getrennte Freigaben, Git-Sitzung mit 12 h Leerlauf, „Once“ deckt bei Git einen Vorgang und bei Push genau einen Push, die entry-weite 60-s-Sperre nach Ablehnen, das Abzeichen „schreibt“ auf der Karte.
4. Abschnitt **Time limits**: `vault_http` 30 s; Git-Uploads ohne Zeitgrenze, 60 s ohne Daten beenden; hinter einem Reverse-Proxy für `/api/vault/git/` und `/api/mcp` eine ausreichende Body-Grenze und ungepufferte Requests (`client_max_body_size 0; proxy_request_buffering off;` in nginx); `/api/vault/git/` braucht dazu dasselbe `proxy_read_timeout` von mindestens 150 s wie `/api/mcp`, weil `info/refs` auf die Freigabe wartet.
5. Abschnitt **7. Security model and limits**: neuer Punkt **Responses** — the token is replaced by •••• in vault_http responses and in Git text responses (plain, percent/form-encoded, JSON-escaped, base64); pack data is not. A service that echoes the token transformed (a byte range of it, \u-escaped, hashed, reversed) is not caught; entries should only list hosts whose APIs do not reflect the Authorization header. Whatever data a service shows this token, the agent sees. Neuer Punkt **Fill anywhere** — Risiko des Schalters, eine Sitzungsfreigabe gilt nur für eine Origin. Neuer Punkt **Proxy environment** — Node `fetch` und `node:https` nutzen `HTTP(S)_PROXY` nur mit `NODE_USE_ENV_PROXY=1`; Outpost setzt sie nicht, mit dieser Variable ginge der Token über den Proxy.
6. Abschnitt **9. Tools**: Tabelle um `vault_http` und `browser_fill_secret` ergänzen (Argumente, Rückgabe, Grenzen wie Spec), eine Zeile zum Git-Proxy; Fehlercode-Tabelle um alle Codes aus Spec „Fehlercodes“ mit ihrer Meldung ergänzen.

Run: `cd /root/outpost && yarn docs:build`
Expected: `build complete`, keine `dead link`-Meldung.

```bash
git add docs/vault.md
git commit -m "Vault: Doku zu vault_http, browser_fill_secret und Git-Proxy"
```

- [ ] **Step 2: Volle Suite, Lint, Build**

Run: `cd /root/outpost && yarn test && yarn lint && yarn --cwd client lint && yarn --cwd client build`
Expected: alle Server-, Skript- und Client-Tests grün (die Chromium-Reihe wird übersprungen, Bestand); Lint ohne Errors; Build erfolgreich.

- [ ] **Step 3: Migration 0049 gegen MySQL 8.4**

```bash
ssh -i ~/.ssh/synology-manager-plus_ed25519 ma.backes@192.168.2.151 \
  'sudo -n /usr/local/bin/docker run -d --rm --name outpost-mysql-e2e -p 33306:3306 -e MYSQL_ROOT_PASSWORD=outpost-e2e -e MYSQL_DATABASE=outpost mysql:8.4'
cd /root/outpost && DB_TYPE=mysql DB_HOST=192.168.2.151 DB_PORT=33306 DB_NAME=outpost DB_USER=root DB_PASS=outpost-e2e \
  ENCRYPTION_KEY=$(printf 'a%.0s' $(seq 64)) node -e 'new (require("./server/utils/migrationRunner"))().runMigrations().then(()=>{console.log("MIGRATIONS OK");process.exit(0)},(e)=>{console.log("FAILED",e.message);process.exit(1)})'
ssh -i ~/.ssh/synology-manager-plus_ed25519 ma.backes@192.168.2.151 'sudo -n /usr/local/bin/docker stop outpost-mysql-e2e'
```

Expected: `MIGRATIONS OK` (auf eine frisch gestartete MySQL warten, bis sie Verbindungen annimmt; bei `ECONNREFUSED` nach 10 s erneut).

- [ ] **Step 4: Sicherheitsabgleich (SEC-*)**

```bash
cd /root/outpost
git diff main --stat -- package.json yarn.lock client/package.json client/yarn.lock
grep -rn "dangerouslySetInnerHTML" client/src/pages/Vault client/src/common/components/VaultApprovalCard \
  client/src/pages/Servers/components/AgentAccessDialog client/src/pages/Settings/pages/Vault
grep -rn "sequelize\.query\|literal(" server/lib/vault server/routes/vault server/controllers/agentKeys.js server/controllers/vaultSettings.js
grep -rn "logger\.\(info\|warn\|error\|debug\|system\|verbose\)" server/lib/vault/broker.js server/lib/vault/redact.js \
  server/lib/vault/tools server/lib/vault/gitProxy.js server/routes/vault/git.js server/middlewares/requestDeadline.js
grep -n "execCommand(\|runRemote(" server/controllers/agentKeys.js
grep -rn "https://\${\|new URL(" server/lib/vault/gitProxy.js server/lib/vault/tools/http.js
```

Expected, Zeile für Zeile:
1. keine Ausgabe (keine neuen Abhängigkeiten, SEC-DEP-01);
2. keine Treffer (SEC-XSS-01);
3. keine Treffer (SEC-SQLI-01);
4. jede Log-Zeile nennt nur IDs, Codes, Hosts, Pfade ohne Query — nie Token, Header-Wert, Body oder fertigen Befehl (SEC-SECRET-01). Jede Zeile einzeln lesen;
5. jede Fundstelle übergibt einen Befehl aus `server/lib/vault/provision.js` (SEC-INJECT-01); `gitSetupCommand` und der Git-Zweig von `revokeCommands` setzen jede Interpolation in `shQuote(…)`;
6. die Upstream-URL des Git-Proxys entsteht nur aus dem geprüften `<host>` und `<repo>` (Spec „Endpunkt“), die von `vault_http` nur aus der geprüften URL des Agenten (SEC-INJECT-01).

Danach die Tabelle SEC-COVERAGE unten Zeile für Zeile abhaken: Testdatei öffnen und prüfen, dass der genannte Fall wirklich darin steht. Fehlt ein Nachweis → Befund, beheben in der Datei des zuständigen Tasks, betroffene Tests laufen lassen, einzeln committen.

- [ ] **Step 5: Review-Ketten am Phasenende**

`/mockingbird:design-verify --screens UI-VAULT,UI-VAULT-DIALOG,UI-VAULT-APPROVAL,UI-VAULT-SETTINGS,UI-AGENT-ACCESS,UI-API-KEYS` (Manifest Revision 16); footgun über die geänderten Server-Dateien; Gesamt-Review des Branches. Befunde in den Dateien der Tasks beheben, betroffene Tests laufen lassen, committen.

- [ ] **Step 6: Handtest mit echtem GitHub-PAT**

Aufbau: Branch-Image auf die Testinstanz (NAS, wie Release-Ablauf), `docs/browser-tabs.md` eingerichtet. In GitHub einen Fine-grained PAT nur für ein Test-Repo `o/vault-test` (Contents read/write, Issues read/write). Vault-Eintrag `github-pat` (API-Key): Hosts `api.github.com`, `github.com`; „Für Git nutzen“ an, Benutzername `x-access-token`; „Darf im Browser eingetragen werden auf“: Origin einer Testseite auf `web01` (`http://web01:8080`) mit einem Formular `<input name="token" type="text">`; Gilt für `web01`; Freigabe an. Agenten-Zugang auf `web01`: Claude Code und Git.

1. **API lesen.** Claude ruft `vault_http` GET `https://api.github.com/repos/o/vault-test` → Karte ohne Abzeichen, „Für diese Sitzung“; Antwort mit Repo-Daten; ein zweiter GET ohne Karte. Transcript auf `web01` enthält den PAT nicht.
2. **API schreiben.** `vault_http` POST `/repos/o/vault-test/issues` mit Titel → neue Karte **mit** Abzeichen „schreibt“; „Einmal“ → Issue angelegt; ein zweiter POST → wieder Karte.
3. **Git.** `git clone https://github.com/o/vault-test` auf `web01` → Karte „Git · github.com/o/vault-test“ ohne Abzeichen „schreibt“, „Einmal“, Klon gelingt. Datei ändern, `git push` → genau **eine** Karte mit „schreibt“; „Einmal“; Push gelingt; ein zweiter Push → neue Karte. `grep -r "<PAT-Anfang>" ~ 2>/dev/null` findet nichts; `stat -c %a ~/.gitconfig` → `600`.
4. **Nur lesen.** Eintrag auf „Nur lesen“ stellen → `git push` endet mit `fatal: remote error: vault: This entry is read-only …`; POST über `vault_http` → `vault.read_only`.
5. **Browser.** Claude öffnet `http://web01:8080/`, ruft `browser_fill_secret` für `github-pat` auf das Token-Feld → Karte „Eintragen auf http://web01:8080“ mit „schreibt“; „Für diese Sitzung“; danach Snapshot `••••`, `browser_screenshot` → `vault.screenshot_locked`; ein folgender `vault_http`-POST öffnet trotzdem eine eigene Karte (Freigaben je Werkzeug).
6. **Entziehen.** Git-Zugang entziehen → `~/.gitconfig` ohne die `/api/vault/git/`-Zeilen, eine eigene `insteadOf`-Regel des Nutzers bleibt; `git fetch` geht wieder direkt an GitHub (ohne Token: 401/Prompt).

Befunde wie in Step 4 beheben.

#### SEC-COVERAGE

| SEC-ID | Task(s) | Nachweis |
|---|---|---|
| SEC-INPUT-01 | 1, 4, 5, 7 | `validation.test.js` (Felder), `vaultHttp.test.js` (Ablehnungen), `fillSecret`-Test (Feldtypen), `gitProxy.test.js` (Pfad → 404) |
| SEC-ERR-01 | 1, 4, 7 | Meldungen aus `errors.js`; `vaultHttp.test.js` und `gitProxy.test.js` prüfen Code und Meldung ohne Token |
| SEC-SECRET-01 | 3, 4, 7 | `redact.test.js`, `vaultHttp.test.js` (Token in Body/Header/`location` → `••••`), `gitProxy.test.js` (Token nicht im Test-Home, nicht in Ausgaben); Step 4 Zeile 4 |
| SEC-DEP-01 | alle | Step 4 Zeile 1 |
| SEC-INJECT-01 | 7, 8 | `provision.test.js` (Quoting gegen echte Shell), Step 4 Zeilen 5–6 |
| SEC-RATE-01 | 3, 4, 5, 6, 7 | `fillRate`/`httpLimits` je Anbieter (Task 3, 4), `gitProxy.js` (30/min vor der Eintragssuche, Ablehnungen einmal je Key/Code/Minute auditiert), `requestDeadline.test.js` (Slow-Loris); Step 4 lesen |
| SEC-RATE-02 | — | not-applicable (Spec-Sicherheitsblock) |
| SEC-SQLI-01 | 1, 7, 8 | Step 4 Zeile 3 |
| SEC-XSS-01 | 11 | Step 4 Zeile 2; Zielzeile der Karte als Text gerendert |
| SEC-CSP-01 | — | Bestand (Report-Only, Issue #16); keine neuen Quellen (Step 2 Build) |
| SEC-IDOR-01 | 3, 7 | `broker.test.js` (Eintrag nur über `findVisibleItem`), `gitProxy.test.js` (Eintrag nur aus sichtbaren) |
| SEC-TENANT-01 | 3, 7, 8 | wie IDOR; `agentKeysRoute.test.js` (Hosts nur aus sichtbaren Einträgen des Servers) |
| SEC-RBAC-01 | 4, 5, 6 | `agentAuth.test.js` (Git-Key nur Git-Proxy, Claude-Key nicht), Verfügbarkeit `browser_fill_secret` nur mit `connect.browser` |
| SEC-APIKEY-01 | 8 | Git-Keys über `generateToken`/`hashToken` wie Agenten-Keys (`agentKeysRoute.test.js`) |
| SEC-SESS-02 | 2, 8 | `approvals.test.js` (Git-Sitzung 12 h in Reihenfolge des Routers, Stempel beendet Freigabe); `agentKeys.js` `revoke`/`finalize` beenden `git:<keyId>` |
| SEC-TOKEN-01 | 8 | `provision.test.js` (`~/.gitconfig` 600, `extraHeader` nur für die Outpost-URL) |
| SEC-PII-01 | 3, 4, 7 | Audit-Details ohne Query/Body/Header in `vaultHttp.test.js` und `gitProxy.test.js` |

#### Spec-Tests und Review Focus → Nachweis

| Spec-Test / Review Focus | Task | Testdatei |
|---|---|---|
| 1 `vault_http` gegen lokalen Server | 4 | `vaultHttp.test.js` |
| 2 Freigaben | 2, 3 | `approvals.test.js`, `broker.test.js` |
| 3 `browser_fill_secret` | 5 | Fill-Secret-Test mit CDP-Double |
| 4 Git Ende-zu-Ende | 7 | `gitProxy.test.js` |
| 5 Einrichtung/Entziehen Git | 8 | `provision.test.js`, `agentKeysRoute.test.js` |
| 6 Auth | 6 | `agentAuth.test.js` |
| 6a Upload-Dauer | 6, 7 | `requestDeadline.test.js` (auch früh beantworteter, tröpfelnder Upload), `gitProxy.test.js` (Test 5) |
| 7 `browser_fill_credential` nach Umbau | 3 | bestehende `mcpProvider.test.js`, `vaultGuard.test.js` |
| 8 Client | 10, 11, 12 | vitest-Dateien der Tasks |
| 9 Handtest | 13 | Step 6 |
| Review Focus 1 | 4 | `vaultHttp.test.js` |
| Review Focus 2 | 3 | `redact.test.js` |
| Review Focus 3 | 7 | `gitProxy.test.js` |
| Review Focus 4 | 3, 7 | `broker.test.js`, `gitProxy.test.js` |
| Review Focus 5 | 5 | Fill-Secret-Test |

---

```
DESIGN-COVERAGE
UI-VAULT-DIALOG-READONLY | covered | Task 10
UI-VAULT-DIALOG-HTTP | covered | Task 10
UI-VAULT-DIALOG-GIT | covered | Task 10
UI-VAULT-DIALOG-FILL | covered | Task 10
UI-VAULT-DETAIL-USAGE | covered | Task 10
UI-VAULT-APPROVAL-CARD | covered | Task 11 (Werkzeug und Ziel)
UI-VAULT-APPROVAL-WRITE | covered | Task 11
UI-VAULT-SETTINGS-FILLANY | covered | Task 11
UI-VAULT-SETTINGS-SAVE | covered | Task 11 (speichert fillAnywhere mit)
UI-AGENT-ACCESS-SETUP | covered | Task 12 (Git-Haken)
UI-AGENT-ACCESS-RESULT | covered | Task 12 (Git-Ergebnis)
UI-AGENT-ACCESS-KEYS | covered | Task 12 (Agent Git)
UI-AGENT-ACCESS-GIT-NOTE | covered | Task 12
UI-API-KEYS-AGENTS | covered | Task 12 (Git-Zeilen)
UI-VAULT-NEW | covered | Bestand Teilprojekt 1, unverändert
UI-VAULT-SCOPE | covered | Bestand Teilprojekt 1, unverändert
UI-VAULT-SEARCH | covered | Bestand Teilprojekt 1, unverändert
UI-VAULT-TYPES | covered | Bestand Teilprojekt 1, unverändert
UI-VAULT-LIST | covered | Bestand Teilprojekt 1, unverändert
UI-VAULT-DETAIL | covered | Bestand Teilprojekt 1, unverändert
UI-VAULT-DETAIL-ACTIONS | covered | Bestand Teilprojekt 1, unverändert
UI-VAULT-DETAIL-FIELDS | covered | Bestand Teilprojekt 1, unverändert
UI-VAULT-DETAIL-SECRET | covered | Bestand Teilprojekt 1, unverändert
UI-VAULT-DETAIL-SCOPE | covered | Bestand Teilprojekt 1, unverändert
UI-VAULT-DETAIL-POLICY | covered | Bestand Teilprojekt 1, unverändert
UI-VAULT-DIALOG-TYPE | covered | Bestand Teilprojekt 1, unverändert
UI-VAULT-DIALOG-OWNER | covered | Bestand Teilprojekt 1, unverändert
UI-VAULT-DIALOG-FIELDS | covered | Bestand Teilprojekt 1, unverändert
UI-VAULT-DIALOG-SECRET | covered | Bestand Teilprojekt 1, unverändert
UI-VAULT-DIALOG-SCOPE | covered | Bestand Teilprojekt 1, unverändert
UI-VAULT-DIALOG-APPROVAL | covered | Bestand Teilprojekt 1, unverändert
UI-VAULT-DIALOG-SAVE | covered | Bestand Teilprojekt 1, unverändert
UI-VAULT-SETTINGS-KEY | covered | Bestand Teilprojekt 1, unverändert
UI-VAULT-SETTINGS-URL | covered | Bestand (Rev. 15), unverändert
UI-VAULT-SETTINGS-IPBIND | covered | Bestand (Rev. 15), unverändert
UI-VAULT-SETTINGS-PROXY | covered | Bestand Teilprojekt 1, unverändert
UI-AGENT-ACCESS-URL | covered | Bestand (Rev. 15), unverändert
UI-AGENT-ACCESS-IPBIND | covered | Bestand Teilprojekt 1, unverändert
UI-API-KEYS-LIST | covered | Bestand Teilprojekt 1, unverändert
END
```

