# Credentials Vault – Teilprojekt 1: Kern und Agentenzugang — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zugangsdaten liegen verschlüsselt in Outpost; Claude Code und Codex auf LAN-Servern nutzen sie über eingeschränkte Agenten-Keys und den MCP-Endpunkt, ohne den Wert je zu sehen (Login-Formulare im Outpost-Browser-Tab), mit Freigabe, Server-Bindung und Audit.

**Architecture:** Neue Tabellen `vault_*` mit eigenem Schlüssel `VAULT_KEY` (AES-256-GCM mit Associated Data) und eine Sichtbarkeitslogik je Server-Eintrag. `authenticate` kennt Agenten-Keys (nur `/api/mcp`, IP-Bindung, `pending` nur an `probe`). Der MCP-Server zieht nach `server/lib/mcp/` und nimmt Werkzeug-Anbieter (Browser, Vault); `browser_fill_credential` prüft Ursprung, Kontext und Fokus, holt die Freigabe außerhalb von `runAgent` und tippt per CDP. Die Browser-Bibliothek schwärzt Passwörter überall und sperrt `evaluate`/Screenshot in befüllten Kontexten. Der Client bekommt Vault-Seite, Eintrag-Dialog, Freigabe-Karte, Agenten-Zugang, Einstellungen und Agenten-Schlüssel.

**Tech Stack:** Node.js ≥ 22 (Express 5, Sequelize, Joi, express-rate-limit 8, `node:test`), Chromium über CDP, React 19 + Vite, vitest/jsdom/Testing Library (`*.test.jsx`), lucide-react.

**Spec:** `docs/superpowers/specs/2026-10-09-vault-core-design.md` (inkl. mockingbird-Block Manifest-Revision 14 und preflight-Sicherheitsblock). Die Spec ist maßgeblich; dieser Plan argumentiert aus ihr. Abweichungen und Ergänzungen stehen ausdrücklich unter „Abweichungen und Ergänzungen zur Spec“.

**Design:** `docs/design/manifest.yaml` (rev 14) — Design-System: `docs/design/design-system.md` — Artboards: `docs/design/mockups/index.html`

**Design Scope:** UI-VAULT, UI-VAULT-DIALOG, UI-AGENT-ACCESS, UI-VAULT-SETTINGS, UI-API-KEYS, UI-VAULT-APPROVAL (übernommen, nicht zu bauen: UI-SHELL-NAV, UI-SHELL-MOBILE-NAV, UI-SHELL-ACCOUNT, UI-SERVERS-LIST-MENU — die beiden Navigationen und das Server-Kontextmenü werden laut Spec „Geänderter Bestand in der Oberfläche“ um je einen Eintrag ergänzt)

## Global Constraints

- Design-Quelle: `docs/design/manifest.yaml` (rev 14). Bei Konflikt zwischen Plan-Text und Manifest gilt das Manifest; melde den Konflikt, statt ihn still aufzulösen.
- Jedes gebaute UI-Element trägt seine Manifest-ID im Code: Web `data-ui-id="UI-…"`, andere Medien nach `adapters:` im Manifest. Ohne ID ist das Element nicht prüfbar.
- Design-Tokens ausschließlich aus `docs/design/mockups/tokens.css` bzw. `docs/design/design-system.md`. Keine neuen Farben, Abstände, Radien oder Schriftgrößen.
- Sichtbare Texte (Labels, Leer-, Lade- und Fehlerzustände) wörtlich aus dem Manifest (`label`, `states[].copy`). Keine eigenen Formulierungen.
- Jeder im Manifest deklarierte Zustand eines Elements wird gebaut, nicht nur `default`.
- Umsetzungsanleitungen je Screen: `docs/design/guides/ui-vault.md`, `ui-vault-dialog.md`, `ui-agent-access.md`, `ui-vault-settings.md`, `ui-api-keys.md`, `ui-vault-approval.md`, für den geänderten Bestand `ui-shell.md` und `ui-servers.md`.
- Kein geheimer Wert (Passwort, Token, Schlüssel, Agenten-Key nach seiner einmaligen Anzeige) erscheint je in einer Werkzeug-Antwort an einen Agenten, in einem Log, im Audit-Log, in einer Fehlermeldung oder in einer Listen-Antwort der REST-API. Ausnahmen: Reveal-Endpunkt (Login-Session mit Recht) und die einmalige Anzeige eines neuen Agenten-Keys im Einrichtungsdialog.
- `VAULT_KEY`: 64 Hex-Zeichen, optional, per Umgebung oder `/run/secrets/vault_key`. Ohne gültigen Schlüssel ist der Vault aus (REST `404` außer `GET /api/vault/available`, `GET`/`PATCH /api/vault/settings`; keine Vault-Werkzeuge; keine Navigation). Bestehende Installationen starten unverändert.
- Verschlüsselung: AES-256-GCM, 12-Byte-IV, Associated Data `vault:<itemId>:<field>` für Werte, `vault:ctx:<contextKey>` für Kontextkopien, `vault:keycheck` für den Prüfwert.
- Kennung für Agenten: persönlich `<name>`, Organisation `org:<organizationId>/<name>`; Namensmuster `^[a-z0-9][a-z0-9._-]{0,63}$`.
- Freigabe: Wartezeit 120 s; höchstens 3 offene Anfragen je Aufrufer (`accountId`, `keyId`); Sperre nach `deny` 60 s je (Aufrufer, Eintrag); `once` gilt für genau ein Ausfüllen.
- Agenten-Keys: `pending` bis Einrichtung gelingt oder Befehl kopiert; Server löscht `pending` nach 15 min; `addSeenIp` einmal und nur bis 15 min nach Anlage. IP-Bindung: Auflösung mit `dns.lookup(host, { all: true })`, Cache 60 s; Audit `vault.agent_ip_denied` höchstens einmal je (Key, Quelladresse) in 10 min.
- MCP-Transporte: höchstens 50 je Aufrufer (`accountId`, `keyId`); fremder Aufrufer bekommt `404` wie bei unbekanntem Transport.
- Reveal, `POST /api/vault/approvals/:id`, Einrichten/Bestätigen/Entziehen von Agenten-Keys verlangen eine Login-Session ohne `impersonatorId`; Konto-Keys und Impersonation bekommen `403`.
- Neue Berechtigungen: `vault.use` (System, Standard aus, dangerous), `vault.manage` (Organisation), `vault.reveal` (Organisation, dangerous), `settings.vault` (System). Kategorie `vault` in `CATEGORIES`. Client-Spiegel `client/src/common/utils/permissions.js` nachziehen.
- Audit-Aktionen (Kategorie `vault`, eigene Zeile in `ACTION_CATEGORIES`): `vault.item_create`, `vault.item_update`, `vault.item_delete`, `vault.reveal`, `vault.use`, `vault.approve`, `vault.deny`, `vault.agent_key_create`, `vault.agent_key_revoke`, `vault.agent_ip_denied`, `vault.use_denied`, `vault.approval_timeout`, `vault.item_unreadable`, `vault.evaluate_locked`, `vault.screenshot_locked`, `vault.input_locked`, `vault.persistent_not_allowed`. Audit-Details nennen Eintrag, Agent, Server, Ziel — nie Werte; aus Impersonations-Sitzungen zusätzlich `impersonatorId` (alle Audits aus HTTP-Anfragen; WebSocket-Handler wie Terminal, SFTP, AI tragen ihn in Teilprojekt 1 noch nicht).
- Sicherheitsanforderungen aus dem preflight-Block der Spec gelten für jeden Task in ihrem Geltungsbereich, insbesondere SEC-INJECT-01 (Einrichtungsbefehle nur über `server/lib/vault/provision.js`), SEC-TENANT-01 (jede Abfrage nach Organisation beschränkt), SEC-IDOR-01, SEC-RATE-01, SEC-TOKEN-01 (Token im Query-String des Zustandsstroms nicht loggen), SEC-CSP-01 (Report-Only zuerst).
- Keine neuen Abhängigkeiten, außer wo ein Task es ausdrücklich nennt.
- Code-Kommentare: fast keine — nur nicht offensichtliches Warum, Fallstricke, externe Constraints. Bestehende Kommentardichte einer Datei wird nicht erhöht.
- Tests: ein Test je Verhalten; Integration über die Naht vor Mocks; keine Tests für Weiterreichung, Konstanten, Getter, Framework-Zusagen, Logs. Je Task nur die betroffenen Tests, volle Suite einmal am Phasenende.
- Server-Tests unter `server/lib/**/__tests__/*.test.js` mit `node:test` (CommonJS); Module werden vor dem Laden über `require.cache` ersetzt (Muster `server/lib/__tests__/browserOpenRoute.test.js`), DB-Tests mit In-Memory-SQLite wie dort. Client: `*.test.jsx` mit vitest (`globals:false`), `renderWithProviders`, `createRequestDouble`; jeder neue `t()`-Schlüssel muss in `client/public/assets/locales/en.json` stehen (`src/test/i18n.js` wirft sonst).
- Texte: neue Schlüssel in `en.json` und `de_DE.json` (andere Sprachen fallen auf `en` zurück).
- Commits: deutsche Betreffzeile im Stil des Repos („Vault: …“), **keine** `Co-Authored-By`-/KI-Zeilen (ein Commit-Hook lehnt sie ab).

## Review Focus

1. **Ein Agent öffnet die Anmeldeseite, klickt „Passwort anzeigen“ und fordert danach einen Snapshot, eine Seitenliste und einen Screenshot an.** Erwartet: Snapshot und Liste zeigen `••••`, der Screenshot wird mit `vault.screenshot_locked` abgelehnt. → Tests in Task 9 und Task 11 (Chromium-Reihe).
2. **Der Nutzer antwortet erst nach 100 s auf die Freigabe, während der Agent in derselben Sitzung `browser_evaluate` aufruft.** Erwartet: Das Ausfüllen scheitert nach der Freigabe mit `vault.session_tainted`, nichts wird getippt. → Test in Task 11.
3. **Der Agenten-Key eines NAS-Servers kommt über das Docker-Gateway (andere Quell-IP als der Hostname).** Erwartet: `probe` meldet die gesehene Adresse, `confirm` mit `addSeenIp` trägt sie ein, danach wird der Key akzeptiert; ohne Übernahme `403` mit Audit. → Tests in Task 4 und Task 8.
4. **Zwei Konten richten Agenten-Zugang für denselben Unix-Benutzer ein, dann entzieht das erste Konto seinen Zugang.** Erwartet: Die Registrierung des zweiten Kontos bleibt stehen. → Test in Task 8.
5. **Ein Ordner mit Unterordnern und darin gebundenen Servern wird gelöscht.** Erwartet: Alle Bindungen an Ordner, Unterordner und mitgelöschte Einträge verschwinden; kein Eintrag bleibt an eine verwaiste ID gebunden, die später ein neuer Server erben könnte. → Test in Task 3.

---

## Abweichungen und Ergänzungen zur Spec

Beim Lesen des Codes gefunden; im Plan so umgesetzt, beim Review bitte bestätigen:

1. **`impersonatorId` braucht einen eigenen Weg in `createSession`.** Heute markiert nur `ip: "Admin"` eine Impersonation, und `authenticate` überschreibt die IP beim ersten Request (`server/middlewares/auth.js:31`). `createSession(accountId, userAgent, { impersonatorId })` setzt die neue Spalte; der Impersonations-Route-Handler übergibt `req.user.id`.
2. **`blockApiKeyAuth` ist nicht exportiert** (`server/routes/apiKey.js:8-11`). Statt es zu kopieren, entsteht `server/middlewares/requireLoginSession.js`, das Konto-Keys **und** Impersonations-Sitzungen abweist; `routes/apiKey.js` hängt es zusätzlich vor `POST /`, damit eine Impersonation keine Konto-Keys anlegt.
3. **Der Mount `/api/vault` hängt ohne `authenticate` im Mount**, weil `GET /agent-keys/probe` den `pending`-Key durchlassen muss, den `authenticate` sonst abweist. `authenticate` erhält stattdessen die Ausnahme für genau diesen Pfad, und jede Vault-Route trägt `authenticate` selbst (Muster `entryBookmarks`, `server/index.js:94-103`).
4. **`execCommand` bekommt einen optionalen fünften Parameter `{ engineId }`**, statt die Signatur zu brechen; nur die Einrichtung nutzt ihn.
5. **Browser-Sitzungen kennen keine Frames außer dem Hauptframe** (`BrowserSession.snapshot()` ruft `Accessibility.getFullAXTree` ohne `frameId`). Die Ursprungsprüfung (Spec Prüfung 4) läuft deshalb über das Ziel-Element selbst: `DOM.resolveNode({ backendNodeId })` und `Runtime.callFunctionOn` lesen im Frame des Elements das globale `location.origin` und `location.ancestorOrigins` (beide in Chromium nicht überschreibbar; `ownerDocument.location` könnte Seitenskript fälschen). Die Schwärzung sucht Passwortfelder über `DOM.getFlattenedDocument({ depth: -1, pierce: true })`.
6. **Browser-Fehlertexte bleiben englisch** wie im Bestand (`server/lib/browser/errors.js`); Vault-Fehler bekommen eigene Codes in `server/lib/vault/errors.js` nach demselben Muster, ohne Übersetzungsschlüssel (der Agent liest sie, nicht der Mensch).
7. **CSP (SEC-CSP-01)** wird als `Content-Security-Policy-Report-Only` mit Meldeendpunkt `POST /api/csp-report` ausgeliefert; scharf geschaltet wird über `CSP_ENFORCE=true`, nachdem die Meldungen ausgewertet sind (Task 16).

8. **Entziehen prüft den Key auf dem Zielserver** (Spec angepasst): Das Skript vergleicht das nicht geheime Präfix und entfernt nur bei Übereinstimmung im selben Exec; Outpost liest nur `REMOVED`/`FOREIGN`/`ABSENT`. So verlässt ein fremder Key den Server nie.
9. **`browser_wait` setzt keinen Taint.** Es nutzt eigene CDP-Abfragen (`readyState()`, `containsText()`) statt `evaluate`, sonst scheiterte schon „warten, dann ausfüllen“. `containsText` vergleicht gegen den mit `redactText` geschwärzten Seitentext; Teile eines eingetragenen Werts finden sich darin nicht.
10. **Popups schließen mit ihrem Öffner**, wenn dieser einen ephemeren Kontext angelegt hat (Grund „opener closed“). Chromium verwirft sie mit dem Kontext ohnehin; so endet der Kontext eindeutig.
11. **Organisationseinträge verlangen aktive Mitgliedschaft auch für Systemadmins** (Verwalten, Anzeigen, Anlegen), obwohl die Rechte-Engine Systemadmins alle Organisationsrechte gibt — SEC-TENANT-01.
12. **API-Key-Suche bleibt ein Hash-Lookup** (`SHA-256` als DB-Schlüssel, kein `timingSafeEqual`): Der Vergleich findet auf einem 256-Bit-Hash eines 256-Bit-Zufallswerts statt; ein Zeitkanal verrät nichts Verwertbares (SEC-APIKEY-01, im Review bestätigen).
13. **Vault-Audits sind nicht per Organisationsschalter abschaltbar** (`shouldAudit` kennt `vault.*` nicht) — Zugriffe auf Geheimnisse werden immer protokolliert.
14. **Ursprünge werden normalisiert gespeichert** (`new URL(x).origin`, nur http/https); `agentUrl` ohne abschließenden Schrägstrich.
15. **Löschpfade:** Neben `deleteEntry`, `deleteFolder` und `deleteTag` entfernt auch der Integrationsabgleich (`server/controllers/integration.js`) Bindungen (MySQL < 8 vergibt IDs nach einem Neustart erneut). Verwaiste Bindungen entstehen nur noch bei Konto- und Organisationslöschung; dort verschwinden die Einträge selbst per CASCADE.
16. **Feldbeschriftungen im Eintrag-Dialog** (Benutzer, Ursprünge, Passwort …) kommen aus den Artboards, nicht aus `states[].copy` — das Manifest führt sie nicht als Copy. Zwei Fehlertexte ohne Manifest-Vorgabe: `vault.detail.deleteFailed`, `vault.secret.copyFailed`.
17. **Neue Fehlercodes** über die Spec hinaus: `vault.rate_limited` (20 Ausfüllungen je Minute und Aufrufer, SEC-RATE-01) und `vault.no_secret` (Login-Eintrag ohne gespeichertes Passwort, z. B. nach Zieländerung). `vault.input_locked` steht inzwischen in der Spec.
18. **`api_keys.pending` hat den DB-Standard `false`** (Spec: `true`), damit Bestands-Keys nicht `pending` werden; neue Agenten-Keys setzen `true` ausdrücklich.
19. **Antwort ohne `usernameRef`:** „Passwort von `<item>` eingetragen.“ (die Spec nennt nur die Fassung mit Benutzername).
20. **`initVaultState` meldet `mismatch` nur bei vorhandenen Werten** (Spec „bei vorhandenen Daten“): Ohne gespeicherte Werte schreibt ein neuer Schlüssel einen neuen Prüfwert; mit Werten entscheidet die Probe-Entschlüsselung eines gespeicherten Werts.
21. **Bewusst nicht in Teilprojekt 1:** Sperre der Freigabe-Knöpfe kurz nach dem Erscheinen (wäre ein Manifest-Zustand); Erkennung „Probe misst einen Proxy“ über den Abgleich mit der Browser-Adresse hinaus.

---

## Dateistruktur und Parallelgruppen

| Task | Welle | Dateien (Kurzfassung aus **Files:**) | Parallel |
|---|---|---|---|
| 1 Vault-Grundlage (Server) — Migration, Modelle, Verschlüsselung, Schlüsselstatus, Rechte, Audit, Router-Gerüst | A | `server/migrations/0047-add-vault.js`, `server/models/VaultItem.js`, `server/models/VaultSecret.js`, `server/models/VaultBinding.js`, `server/models/VaultSettings.js`, `server/models/ApiKey.js`, `server/models/Session.js`, `server/lib/vault/errors.js`, `server/lib/vault/crypto.js`, `server/lib/vault/secrets.js`, `server/lib/vault/state.js`, `server/permissions/registry.js`, `server/controllers/audit.js`, `server/routes/vault/index.js`, `server/routes/vault/items.js`, `server/routes/vault/approvals.js`, `server/routes/vault/agentKeys.js`, `server/routes/vault/settings.js`, `server/index.js`, `server/lib/vault/__tests__/crypto.test.js`, `server/lib/vault/__tests__/state.test.js` | Task 2, 7, 10 (Welle A; keine gemeinsamen Dateien: Task 2 schreibt `server/lib/mcp/*` und `server/routes/mcp.js`, Task 7 `server/lib/browser/*`, Task 10 nur `client/`). |
| 2 MCP-Rahmen — Werkzeug-Anbieter, Transport je Schlüssel, Abbruchsignal | A | `server/lib/mcp/server.js`, `server/lib/browser/mcpServer.js`, `server/lib/mcp/__tests__/server.test.js`, `server/lib/browser/__tests__/mcpServer.test.js`, `server/lib/mcp/__tests__/mcpRoute.test.js`, `server/routes/mcp.js` | Task 1, 7, 10 (Welle A; keine gemeinsamen Dateien: Task 1 schreibt `server/lib/vault/*`, Modelle, `server/index.js`, Task 7 `server/lib/browser/*` ohne `mcpServer.js`, Task 10 nur `client/`; der Test dieses Tasks fakt `server/lib/browser/tools.js` und hängt nicht von Task 7 ab). |
| 10 Client-Grundlage — Texte, Rechte-Spiegel, Verfügbarkeit, Navigation, Route, Marker | A | `client/public/assets/locales/en.json`, `client/public/assets/locales/de_DE.json`, `client/src/common/utils/permissions.js`, `client/src/common/hooks/useVaultAvailable.js`, `client/src/common/hooks/useSidebarNavigation.js`, `client/src/common/utils/navigationConfig.jsx`, `client/src/App.jsx`, `client/src/pages/Vault/index.js`, `client/src/pages/Vault/Vault.jsx`, `client/src/pages/Settings/pages/Vault/index.js`, `client/src/pages/Settings/pages/Vault/Vault.jsx`, `client/src/common/hooks/__tests__/useSidebarNavigation.test.jsx` | Task 1, 2, 7 (Welle A; keine gemeinsamen Dateien: Task 10 fasst nur `client/` an, die drei anderen nur `server/`). Tasks 12–15 (Welle B und C) setzen diesen Task voraus. |
| 7 Browser I: Sitzungsbesitz für Agenten-Keys | A | `server/lib/browser/BrowserSession.js`, `server/lib/browser/BrowserPool.js`, `server/lib/browser/tools.js`, `server/lib/browser/errors.js`, `server/lib/browser/proxy.js`, `server/lib/browser/__tests__/tools.test.js`, `server/lib/browser/__tests__/agentScope.test.js` | Task 1, Task 2, Task 10 (Welle A; keine gemeinsamen Dateien — Task 2 verschiebt nur `server/lib/browser/mcpServer.js` samt Test, dieser Task fasst beide nicht an; von Task 2 und Task 4 braucht er nur die Form von `ctx`, der Test baut `ctx` selbst). |
| 3 Sichtbarkeit und Bindungen | B | `server/lib/vault/visibility.js`, `server/lib/vault/bindings.js`, `server/controllers/entry.js`, `server/controllers/folder.js`, `server/controllers/tag.js`, `server/controllers/integration.js`, `server/lib/vault/__tests__/visibility.test.js`, `server/lib/vault/__tests__/bindings.test.js` | Task 4, Task 9, Task 12, Task 13, Task 14 (Welle B; keine gemeinsamen Dateien). |
| 4 Agenten-Authentifizierung | B | `server/middlewares/auth.js`, `server/lib/vault/ipBinding.js`, `server/controllers/apiKey.js`, `server/controllers/session.js`, `server/routes/users.js`, `server/middlewares/requireLoginSession.js`, `server/routes/apiKey.js`, `server/utils/auditContext.js`, `server/controllers/audit.js`, `server/utils/database.js`, `server/lib/vault/__tests__/agentAuth.test.js` | Task 3, Task 9, Task 12, Task 13, Task 14 (Welle B; keine gemeinsamen Dateien). |
| 9 Browser II: Schwärzung und Sperren | B | `server/lib/browser/vaultGuard.js`, `server/lib/browser/snapshot.js`, `server/lib/browser/BrowserSession.js`, `server/lib/browser/actions.js`, `server/lib/browser/tools.js`, `server/lib/browser/index.js`, `server/lib/browser/__tests__/tools.test.js`, `server/lib/browser/__tests__/vaultGuard.test.js`, `server/lib/browser/__tests__/chromium.e2e.test.js` | Task 3, Task 4, Task 12, Task 13, Task 14 (Welle B; keine gemeinsamen Dateien — Task 3 und Task 4 fassen `server/lib/browser/` nicht an, Tasks 12–14 nur `client/`; setzt Task 1 und Task 7 aus Welle A voraus). |
| 12 Client — Vault-Seite und Eintrag-Dialog | B | `client/src/pages/Vault/Vault.jsx`, `client/src/pages/Vault/styles.sass`, `client/src/pages/Vault/vaultTypes.js`, `client/src/pages/Vault/components/VaultDetail/__tests__/VaultDetail.test.jsx`, `client/src/pages/Vault/components/VaultItemDialog/__tests__/VaultItemDialog.test.jsx` | Task 3, 4, 9, 13, 14 (Welle B; keine gemeinsamen Dateien; Task 12 fasst nur `client/src/pages/Vault/` an). Setzt Task 10 (Welle A) voraus; die REST-Form aus Task 5 (Welle C) steht im Vertrag oben fest, die Tests laufen gegen `requestDouble`. |
| 13 Client: Freigabe-Karte | B | `client/src/common/components/VaultApprovalCard/VaultApprovalStack.jsx`, `client/src/common/components/VaultApprovalCard/VaultApprovalCard.jsx`, `client/src/common/components/VaultApprovalCard/styles.sass`, `client/src/common/components/VaultApprovalCard/index.js`, `client/src/common/components/VaultApprovalCard/__tests__/VaultApprovalStack.test.jsx`, `client/src/common/layouts/Root.jsx`, `client/src/common/layouts/PopoutRoot.jsx` | Task 3, Task 4, Task 9, Task 12, Task 14 (Welle B; keine gemeinsamen Dateien; Task 14 teilt nur die i18n-Schlüssel aus Task 10, die hier nur gelesen werden). Setzt Task 10 (Welle A) voraus; Zustandsstrom und Route aus Task 6 (Welle C) stehen im Vertrag oben fest, die Tests laufen gegen `requestDouble` und einen eigenen `registerHandler`. |
| 14 Client: Agenten-Zugang und Kontextmenü | B | `client/src/pages/Servers/components/AgentAccessDialog/AgentAccessDialog.jsx`, `client/src/pages/Servers/components/AgentAccessDialog/styles.sass`, `client/src/pages/Servers/components/AgentAccessDialog/index.js`, `client/src/pages/Servers/components/AgentAccessDialog/__tests__/AgentAccessDialog.test.jsx`, `client/src/pages/Servers/components/ServerList/ServerList.jsx` | Task 3, Task 4, Task 9, Task 12, Task 13 (Welle B; keine gemeinsamen Dateien). Nicht neben Task 15: der importiert `AgentAccessDialog` und übernimmt die Entziehen-Auswertung dieses Tasks; Task 15 startet erst nach dem Merge dieses Tasks (Welle C). Setzt Task 10 (Welle A) voraus; die REST-Form aus Task 8 (Welle C) steht im Vertrag oben fest, die Tests laufen gegen `requestDouble`. |
| 5 REST: Einträge, Reveal, Einstellungen, Verfügbarkeit | C | `server/validations/vault.js`, `server/controllers/vaultItems.js`, `server/controllers/vaultSettings.js`, `server/routes/vault/items.js`, `server/routes/vault/settings.js`, `server/lib/vault/__tests__/validation.test.js`, `server/lib/vault/__tests__/itemsRoute.test.js` | Task 6, Task 8, Task 15 (Welle C; keine gemeinsamen Dateien: Task 6 schreibt `lib/vault/approvals.js`, `StateBroadcaster.js`, `routes/state.js`, `routes/vault/approvals.js`, `validations/vaultApprovals.js`; Task 8 `provision.js`, `controllers/agentKeys.js`, `routes/vault/agentKeys.js`, `validations/vaultAgentKeys.js`, `execCommand.js`, `server/index.js`; Task 15 nur `client/`). `visibility.js` und `secrets.js` liest dieser Task nur. |
| 6 Freigaben | C | `server/lib/vault/approvals.js`, `server/lib/StateBroadcaster.js`, `server/routes/state.js`, `server/routes/vault/approvals.js`, `server/validations/vaultApprovals.js`, `server/lib/vault/__tests__/approvals.test.js` | Task 5, Task 8, Task 15 (Welle C; keine gemeinsamen Dateien: Task 5 schreibt `validations/vault.js`, `controllers/vaultItems.js`, `controllers/vaultSettings.js`, `routes/vault/items.js`, `routes/vault/settings.js`; Task 8 `provision.js`, `controllers/agentKeys.js`, `routes/vault/agentKeys.js`, `validations/vaultAgentKeys.js`, `execCommand.js`, `server/index.js`; Task 15 nur `client/`). Setzt Task 1, Task 3 (`itemRef` aus `server/lib/vault/visibility.js`) und Task 4 voraus, alle aus Wellen A/B. |
| 8 Agenten-Einrichtung (Server) | C | `server/lib/vault/provision.js`, `server/controllers/agentKeys.js`, `server/validations/vaultAgentKeys.js`, `server/validations/vault.js`, `server/routes/vault/agentKeys.js`, `server/controllers/execCommand.js`, `server/index.js`, `server/lib/vault/__tests__/provision.test.js`, `server/lib/vault/__tests__/agentKeysRoute.test.js` | Task 5, Task 6, Task 15 (Welle C; keine gemeinsamen Dateien: Task 5 schreibt `routes/vault/items.js`, `routes/vault/settings.js`, `validations/vault.js`, `controllers/vaultItems.js`, `controllers/vaultSettings.js`; Task 6 `lib/vault/approvals.js`, `StateBroadcaster.js`, `routes/state.js`, `routes/vault/approvals.js`, `validations/vaultApprovals.js`; Task 15 nur `client/`; `server/index.js` fasst in Welle C nur Task 8 an). `visibility.js` (Task 3) und `ipBinding.js` (Task 4) liest dieser Task nur; beide stammen aus Welle B. |
| 15 Client: Einstellungen Vault und Agenten-Schlüssel | C | `client/src/pages/Settings/pages/Vault/Vault.jsx`, `client/src/pages/Settings/pages/Vault/styles.sass`, `client/src/pages/Settings/pages/Vault/__tests__/VaultSettings.test.jsx`, `client/src/pages/Settings/pages/Account/components/AgentKeysSection/AgentKeysSection.jsx`, `client/src/pages/Settings/pages/Account/components/AgentKeysSection/index.js`, `client/src/pages/Settings/pages/Account/components/AgentKeysSection/styles.sass`, `client/src/pages/Settings/pages/Account/Account.jsx` | Task 5, Task 6, Task 8 (Welle C; keine gemeinsamen Dateien). Nicht neben Task 14: `AgentKeysSection` importiert `AgentAccessDialog` und übernimmt dessen Entziehen-Auswertung, deshalb startet dieser Task erst nach dem Merge von Task 14 (Welle B). Setzt Task 10 (Welle A) voraus; die REST-Form aus Task 5 und Task 8 steht im Vertrag oben fest, die Tests laufen gegen `requestDouble`. |
| 11 Vault-MCP-Anbieter (`vault_list`, `browser_fill_credential`) | D | `server/lib/vault/fill.js`, `server/lib/vault/mcpProvider.js`, `server/lib/vault/__tests__/helpers/vaultBed.js`, `server/lib/vault/__tests__/mcpProvider.test.js`, `server/routes/mcp.js`, `server/lib/mcp/__tests__/mcpRoute.test.js`, `server/lib/browser/__tests__/chromium.e2e.test.js` | none — Welle D enthält nur diesen Task: Er setzt `approvals.js` (Task 6, Welle C), `resolveSession` (Task 7) und `vaultGuard` samt `assertInputAllowed` (Task 9) voraus und ändert `chromium.e2e.test.js` nach Task 9; Task 16 (Welle E) beschreibt sein Verhalten. |
| 16 CSP Report-Only, Einbettungsschutz und Doku | E | `server/lib/staticSite.js`, `server/index.js`, `server/routes/cspReport.js`, `server/lib/__tests__/cspHeader.test.js`, `server/lib/fileContent/download.js`, `server/lib/fileContent/__tests__/download.test.js`, `docs/vault.md`, `docs/.vitepress/config.mjs` | none — einziger Task der Welle E. Die Doku beschreibt das gebaute Verhalten der Tasks 1–15 (Fehlercodes, Sperren, Freigabe- und Entziehen-Regeln) und Schritt 11 gleicht sie gegen das fertige `en.json` aus Task 10 ab; das geht erst, wenn Welle D (Task 11) gemergt ist. `server/index.js` haben Task 1 und Task 8 in früheren Wellen schon geändert, daher hier nur über Code-Anker. Task 17 (Welle F) wartet auf diesen Task. |
| 17 Volle Prüfung, Sicherheitsabgleich, manuelle Tests mit Claude Code und Codex | F | `docs/vault.md` | none — einziger Task der Welle F; prüft den gemergten Gesamtstand aller Tasks einschließlich der Doku aus Task 16 (Welle E). |

Die Task-Nummern bleiben Kennungen; maßgeblich ist die Wellen-Spalte (Welle A: 1, 2, 7, 10 · B: 3, 4, 9, 12, 13, 14 · C: 5, 6, 8, 15 · D: 11 · E: 16 · F: 17), die Abschnitte stehen in dieser Reihenfolge. Innerhalb einer Welle laufen die Tasks parallel in eigenen Worktrees; eine Welle endet mit dem Merge aller ihrer Tasks. Die Spalte „Dateien“ ist eine Kurzfassung; maßgeblich für die Parallelität ist der **Files:**-Block des Tasks. Task 15 startet erst nach dem Merge von Task 14 (er importiert dessen Dialog).

**Phasenabschluss:** nach dem letzten Merge einer Welle `cd /root/outpost && yarn test && yarn lint && yarn --cwd client lint`; rot → Befund im besitzenden Task beheben, bevor die nächste Welle startet. Danach ein kurzer Zwischenstand (was steht, was offen ist). Review-Ketten (preflight, footgun, design-verify, code-review) laufen einmal am Ende (Task 17), nicht nach jedem Task.

---

### Task 1: Vault-Grundlage (Server) — Migration, Modelle, Verschlüsselung, Schlüsselstatus, Rechte, Audit, Router-Gerüst

**Files:**
- Create: `server/migrations/0047-add-vault.js`
- Create: `server/models/VaultItem.js`, `server/models/VaultSecret.js`, `server/models/VaultBinding.js`, `server/models/VaultSettings.js`
- Modify: `server/models/ApiKey.js` (nach `expiresAt`, Z. 31-34; Optionen Z. 35-39 um `hooks.afterFind`), `server/models/Session.js` (nach `oidcIdTokenAuthTag`, Z. 38-41)
- Create: `server/lib/vault/errors.js`, `server/lib/vault/crypto.js`, `server/lib/vault/secrets.js`, `server/lib/vault/state.js`
- Modify: `server/permissions/registry.js` (`Permission` Z. 23 und Z. 40, `CATEGORIES` Z. 59, `PERMISSIONS` Z. 86 und Z. 105)
- Modify: `server/controllers/audit.js` (Import Z. 8, `RESOURCE_CONFIG` Z. 16-21, `AUDIT_ACTIONS` Z. 73-74, `RESOURCE_TYPES` Z. 82-83, `ACTION_LABELS` Z. 135-136, `ACTION_CATEGORIES` Z. 146-147, `RESOURCE_LABELS` Z. 155-156)
- Create: `server/routes/vault/index.js`, `server/routes/vault/items.js`, `server/routes/vault/approvals.js`, `server/routes/vault/agentKeys.js`, `server/routes/vault/settings.js`
- Modify: `server/index.js` (Import nach Z. 29, Mount nach Z. 90, Start nach Z. 144)
- Test: `server/lib/vault/__tests__/crypto.test.js`, `server/lib/vault/__tests__/state.test.js`

**Interfaces:**
- Consumes: nichts aus anderen Tasks. Bestand: `sendError(res, httpCode, errorCode, message)` aus `server/utils/error.js`, `logger` aus `server/utils/logger.js`, der Loader `loadSecrets()` (`server/utils/secrets.js`) macht aus `/run/secrets/vault_key` bereits `process.env.VAULT_KEY`.
- Produces (von Tasks 3–11 genutzt):
  - `server/lib/vault/crypto.js`: `encryptValue(plaintext: string, aad: string) → { encrypted: Buffer, iv: string(hex, 24 Zeichen), authTag: string(hex, 32 Zeichen) }`; `decryptValue({ encrypted: Buffer|string(hex), iv, authTag }, aad) → string` — wirft bei falschem Schlüssel, falscher AAD oder gekürztem Tag; `hasValidKey() → boolean`. Der Schlüssel wird bei jedem Aufruf aus `process.env.VAULT_KEY` gelesen.
  - `server/lib/vault/state.js`: `initVaultState() → Promise<{ keyStatus }>`; `getKeyStatus() → "active"|"missing"|"mismatch"`; `isVaultEnabled() → boolean`; `requireVaultEnabled(req, res, next)` (Vault aus → `404 { code: 404, message: "Not found" }`); `_resetForTests()`. `mismatch` nur, wenn der Prüfwert nicht passt **und** der erste gespeicherte `VaultSecret` sich mit dem Schlüssel nicht entschlüsseln lässt; ohne gespeicherte Werte (oder wenn dieser Wert sich entschlüsseln lässt) schreibt `initVaultState` den Prüfwert mit dem aktuellen Schlüssel neu und meldet `active`. `server/index.js` ruft es beim Start in `try`/`catch`: ein Datenbankfehler loggt und lässt den Vault aus (`missing`), der Start läuft weiter.
  - `server/lib/vault/secrets.js`: `writeSecret(itemId, field, value) → Promise<void>` (Update, sonst Insert); `readSecret(itemId, field) → Promise<string|null>` (wirft `VaultError(ITEM_UNREADABLE)`, AAD aus der gelesenen Zeile); `clearSecrets(itemId) → Promise<number>`; `listSecretFields(itemId) → Promise<string[]>` (sortiert); `isUnreadable(itemId) → boolean` — `true`, sobald `readSecret` für den Eintrag an der Entschlüsselung scheitert, bis `writeSecret` oder `clearSecrets` für ihn läuft (Set im Prozessspeicher, nach einem Neustart leer; Task 5 liefert es als `Item.unreadable`).
  - `server/lib/vault/errors.js`: `class VaultError extends Error { constructor(code, message = VaultErrorMessage[code], details = {}) }` mit `name = "VaultError"`, `code`, `details`; `VaultErrorCode` (eingefroren, Werte wie in Step 3); **zusätzlich** `VaultErrorMessage` (eingefroren, Code → englische Meldung an den Agenten mit nächstem Schritt). Aufrufer schreiben `new VaultError(VaultErrorCode.X)` oder `new VaultError(VaultErrorCode.X, undefined, details)`. Für `WRONG_TYPE`, `VIA_NOT_ALLOWED`, `PERSISTENT_NOT_ALLOWED`, `ORIGIN_MISMATCH`, `NOT_PASSWORD_FIELD`, `BAD_USERNAME_FIELD` und `FOCUS_LOST` gibt Task 11 immer eine situationsgenaue Meldung mit; deren Texte in `VaultErrorMessage` sind nur der Rückfall.
  - Modelle (Tabellen mit `freezeTableName`): `VaultItem` (`vault_items`), `VaultSecret` (`vault_secrets`, ohne Zeitstempel, ohne `afterFind`), `VaultBinding` (`vault_bindings`, ohne Zeitstempel), `VaultSettings` (`vault_settings`, `getOrCreate()`); Felder wie in Step 5. `VaultItem` hat einen `afterFind`-Hook (Muster `Snippet.js`): Er macht bei rohen Zeilen aus dem JSON-Text `fields` ein Objekt und aus `approvalRequired`, `allServers` (`0`/`1`) Booleans; Tasks 3, 5, 8 und 11 lesen die Werte ohne eigene Normalisierung. `ApiKey` mit `kind`, `pending`, `entryId`, `agentType`, `ipBinding`, `allowedCidrs`, `identityId`, `remoteUser`, `seenIp`, `seenIpAdopted` und einem `afterFind`-Hook derselben Art: `allowedCidrs` wird zum Array (Text, der kein JSON ist, zur leeren Liste), `pending`, `ipBinding`, `seenIpAdopted` (`0`/`1`) zu Booleans; Tasks 4 und 8 lesen `allowedCidrs ?? []` als Array. Bei beiden Hooks bleiben Instanzen und schon normalisierte Werte unberührt. `Session.impersonatorId`.
  - `VaultErrorCode.RATE_LIMITED = "vault.rate_limited"` (Task 11: mehr als 20 Ausfüllversuche je Aufrufer und Minute), `VaultErrorCode.NO_SECRET = "vault.no_secret"` (Task 11: Login-Eintrag ohne gespeichertes Passwort) und `VaultErrorCode.INPUT_LOCKED = "vault.input_locked"` (Task 9 `vaultGuard.assertInputAllowed`: Mittelklick, Tastenkombination mit Strg/Meta/Umschalt außer `Shift+Tab` oder Mehrfachklick im befüllten Kontext), alle mit Text in `VaultErrorMessage`.
  - `Permission.VAULT_USE`, `VAULT_MANAGE`, `VAULT_REVEAL`, `SETTINGS_VAULT` (`dangerous: true`: die Agenten-Adresse bestimmt, wohin eingerichtete Agenten ihre Keys schicken); Kategorie `vault`.
  - `AUDIT_ACTIONS.VAULT_ITEM_CREATE` … `VAULT_PERSISTENT_NOT_ALLOWED` (17 Aktionen, darunter `VAULT_INPUT_LOCKED = "vault.input_locked"`), `RESOURCE_TYPES.VAULT = "vault"`. **Konvention für alle Vault-Audits:** `resource: "vault"`, `resourceId: item.id` (falls ein Eintrag betroffen ist), `details.item: itemRef(item)` — `RESOURCE_CONFIG.vault` liest den Namen darüber nach, auch nach dem Löschen. Ausnahme: Die Sperr-Audits `vault.evaluate_locked`, `vault.screenshot_locked` und `vault.input_locked` schreibt Task 9 über `recordBrowserAudit` mit `resource: "browser"` und `details: { url, sessionId, tool }`, weil sie eine Browser-Session betreffen, keinen Eintrag.
  - Router `server/routes/vault/index.js` hängt `./items`, `./approvals`, `./agentKeys`, `./settings` ein; die vier sind leere `Router()`-Module für Tasks 5, 6, 8.

**Design:** kein UI-Anteil.

**Tests:** 3 Tests, test-first (fester Vertrag aus der Spec):
- `crypto.test.js` (1 Test, über die Naht `secrets.js` + In-Memory-SQLite): Ein Chiffretext, in eine andere Zeile oder ein anderes Feld kopiert, lässt sich nicht entschlüsseln (`VaultError` `vault.item_unreadable`, ohne Wert in der Meldung); kein Wert → `null`; ein gekürzter Auth-Tag wird abgewiesen; ein Eintrag mit gescheitertem Lesen ist `isUnreadable`, bis `writeSecret` bzw. `clearSecrets` für ihn läuft. Deckt SEC-SECRET-01 (Bindung über Associated Data) und SEC-ERR-01 (Fehler ohne Details).
- `state.test.js` (2 Tests): (1) Migration 0047 läuft zweimal auf einer DB mit Bestands-Key und setzt danach einen Halbstand fort (Unique-Index und Spalte `api_keys.seenIpAdopted` entfernt, dritter Lauf legt beide wieder an); der Bestands-Key wird `kind = account`, `pending = false`, `ipBinding = true`, `seenIpAdopted = false`; `sessions.impersonatorId` und die vier Unique-Indizes existieren. (2) `initVaultState`: ohne bzw. mit ungültigem Schlüssel `missing`, erster Start schreibt den Prüfwert und ist `active`, Neustart mit demselben Schlüssel bleibt `active`; anderer Schlüssel ohne gespeicherte Werte → `active`, Prüfwert neu geschrieben; anderer Schlüssel bei gespeichertem Wert → `mismatch`, `isVaultEnabled() === false`, Prüfwert unverändert.
- Kein eigener Test für die `afterFind`-Hooks an `ApiKey` und `VaultItem`: Die Leser in den späteren Tasks verlassen sich auf ihre Form (Array, Objekt, Booleans) und lesen keinen JSON-Text mehr selbst. Fehlt ein Hook oder normalisiert er falsch, scheitern auf SQLite die CIDR-Tests in Task 4 (`agentAuth.test.js`), `addSeenIp` und die CIDR-Prüfung in Task 8 (`agentKeysRoute.test.js`) sowie die Sichtbarkeits- und Routen-Tests in Task 3 (`visibility.test.js`) und Task 5 (`itemsRoute.test.js`).
- Nicht getestet: Rechte- und Audit-Konstanten, die Fehlertexte in `VaultErrorMessage` (Konstanten; Task 11 prüft die Codes in der Agenten-Antwort), `requireVaultEnabled` (eine Zeile), `listSecretFields` (ein Sequelize-Aufruf; Task 5 deckt ihn über die Route ab), Router-Gerüst und die Verdrahtung in `server/index.js` samt `try`/`catch` um `initVaultState`.
- SEC-Abdeckung dieses Tasks: SEC-SECRET-01, SEC-ERR-01, SEC-RBAC-01 (Rechte angelegt), SEC-SQLI-01 (nur Sequelize mit `where`-Objekten), SEC-PII-01 (CASCADE an Konto/Organisation, Audit-Aktionen ohne Werte).

**Parallel:** Task 2, 7, 10 (Welle A; keine gemeinsamen Dateien: Task 2 schreibt `server/lib/mcp/*` und `server/routes/mcp.js`, Task 7 `server/lib/browser/*`, Task 10 nur `client/`).

- [ ] **Step 1: Failing test für die AAD-Bindung schreiben**

`server/lib/vault/__tests__/crypto.test.js`:

```js
process.env.VAULT_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

const test = require("node:test");
const assert = require("node:assert");
const { Sequelize, DataTypes } = require("sequelize");

const db = new Sequelize({ dialect: "sqlite", storage: ":memory:", logging: false, query: { raw: true } });
const databasePath = require.resolve("../../../utils/database");
require.cache[databasePath] = { id: databasePath, filename: databasePath, loaded: true, exports: db };

const VaultItem = require("../../../models/VaultItem");
const VaultSecret = require("../../../models/VaultSecret");
const { writeSecret, readSecret, clearSecrets, isUnreadable } = require("../secrets");
const { decryptValue } = require("../crypto");
const { VaultError, VaultErrorCode } = require("../errors");

test.before(async () => {
    for (const table of ["accounts", "organizations"])
        await db.getQueryInterface().createTable(table, { id: { type: DataTypes.INTEGER, primaryKey: true } });
    await db.sync();
});

test("a ciphertext only decrypts in its own row and field, and only with the full auth tag; a failed read marks the item until it is rewritten", async () => {
    const login = { username: "deploy", origins: ["https://git.example.com"] };
    const own = await VaultItem.create({ name: "git", type: "login", fields: login });
    const other = await VaultItem.create({ name: "wiki", type: "login", fields: login });
    await writeSecret(own.id, "password", "hunter2");

    const sealed = await VaultSecret.findOne({ where: { itemId: own.id, field: "password" } });
    assert.ok(Buffer.isBuffer(sealed.valueEncrypted) && !sealed.valueEncrypted.includes("hunter2"));
    assert.strictEqual(sealed.valueIV.length, 24);
    const copy = { valueEncrypted: sealed.valueEncrypted, valueIV: sealed.valueIV, valueAuthTag: sealed.valueAuthTag };
    await VaultSecret.create({ itemId: other.id, field: "password", ...copy });
    await VaultSecret.create({ itemId: own.id, field: "passphrase", ...copy });

    assert.strictEqual(await readSecret(own.id, "password"), "hunter2");
    assert.deepStrictEqual([isUnreadable(own.id), isUnreadable(other.id)], [false, false]);
    for (const [itemId, field] of [[other.id, "password"], [own.id, "passphrase"]]) {
        await assert.rejects(readSecret(itemId, field), (err) =>
            err instanceof VaultError && err.code === VaultErrorCode.ITEM_UNREADABLE && !err.message.includes("hunter2"));
    }
    assert.strictEqual(await readSecret(other.id, "token"), null);
    assert.throws(() => decryptValue({ encrypted: sealed.valueEncrypted, iv: sealed.valueIV, authTag: sealed.valueAuthTag.slice(0, 8) }, `vault:${own.id}:password`));

    assert.deepStrictEqual([isUnreadable(own.id), isUnreadable(other.id)], [true, true]);
    await writeSecret(other.id, "password", "hunter3");
    await clearSecrets(own.id);
    assert.deepStrictEqual([isUnreadable(own.id), isUnreadable(other.id)], [false, false]);
    assert.strictEqual(await readSecret(other.id, "password"), "hunter3");
});
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag prüfen**

Run: `cd /root/outpost && node --test server/lib/vault/__tests__/crypto.test.js`
Expected: FAIL — `Cannot find module '../../../models/VaultItem'`.

- [ ] **Step 3: Fehlerklasse anlegen**

`server/lib/vault/errors.js`:

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
    CLIENT_GONE: "vault.client_gone",
    RATE_LIMITED: "vault.rate_limited",
    NO_SECRET: "vault.no_secret",
});

const C = VaultErrorCode;
const VaultErrorMessage = Object.freeze({
    [C.ITEM_UNKNOWN]: "This vault item does not exist or is not available on this server. Call vault_list to see the items you can use here.",
    [C.WRONG_TYPE]: "This vault item is not a login; browser_fill_credential fills only login items. Call vault_list and pick an item whose usableBy lists browser_fill_credential.",
    [C.ITEM_UNREADABLE]: "This vault item cannot be decrypted, so nothing was filled. Ask the user to check the item in Outpost.",
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
    [C.APPROVAL_TIMEOUT]: "The user did not answer the approval request within 2 minutes, so nothing was filled. Ask the user, then try again.",
    [C.APPROVAL_UNAVAILABLE]: "No Outpost window of this account is open to approve the request. Ask the user to open Outpost, then try again.",
    [C.APPROVAL_PENDING]: "An approval request for this item is already open on this connection. Wait for the user to answer it before calling again.",
    [C.APPROVAL_BUSY]: "Too many approval requests of this caller are open. Wait for the user to answer them, then try again.",
    [C.APPROVAL_DENIED]: "The user denied the use of this vault item. Do not retry now; ask the user how to continue.",
    [C.CLIENT_GONE]: "The request ended before the approval arrived, so nothing was filled.",
    [C.RATE_LIMITED]: "Too many credential fills; wait a minute and try again.",
    [C.NO_SECRET]: "This entry has no stored password; ask the user to enter it in Outpost.",
});

module.exports = { VaultError, VaultErrorCode, VaultErrorMessage };
```

- [ ] **Step 4: Verschlüsselung anlegen**

`server/lib/vault/crypto.js` (eigene Funktionen, weil `server/utils/encryption.js` fest an `ENCRYPTION_KEY` und 16-Byte-IV gebunden ist):

```js
const crypto = require("node:crypto");

const ALGORITHM = "aes-256-gcm";
const KEY_PATTERN = /^[0-9a-fA-F]{64}$/;

const hasValidKey = () => KEY_PATTERN.test(process.env.VAULT_KEY ?? "");

const vaultKey = () => {
    if (!hasValidKey()) throw new Error("VAULT_KEY is missing or not 64 hex characters");
    return Buffer.from(process.env.VAULT_KEY, "hex");
};

const encryptValue = (plaintext, aad) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGORITHM, vaultKey(), iv);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const encrypted = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
    return { encrypted, iv: iv.toString("hex"), authTag: cipher.getAuthTag().toString("hex") };
};

const decryptValue = ({ encrypted, iv, authTag }, aad) => {
    // Without authTagLength, GCM accepts a truncated tag and checks only its prefix.
    const decipher = crypto.createDecipheriv(ALGORITHM, vaultKey(), Buffer.from(iv, "hex"), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(authTag, "hex"));
    const data = Buffer.isBuffer(encrypted) ? encrypted : Buffer.from(encrypted, "hex");
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
};

module.exports = { encryptValue, decryptValue, hasValidKey };
```

- [ ] **Step 5: Modelle anlegen**

`server/models/VaultItem.js`:

```js
const Sequelize = require("sequelize");
const db = require("../utils/database");

module.exports = db.define("vault_items", {
    accountId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: "accounts", key: "id" },
        onDelete: "CASCADE",
    },
    organizationId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: "organizations", key: "id" },
        onDelete: "CASCADE",
    },
    name: { type: Sequelize.STRING(64), allowNull: false },
    type: { type: Sequelize.STRING(16), allowNull: false },
    description: { type: Sequelize.TEXT, allowNull: true },
    fields: { type: Sequelize.JSON, allowNull: false },
    approvalRequired: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
    allServers: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
    createdBy: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: "accounts", key: "id" },
        onDelete: "SET NULL",
    },
    lastUsedAt: { type: Sequelize.DATE, allowNull: true },
}, {
    freezeTableName: true,
    timestamps: true,
    indexes: [
        { unique: true, fields: ["accountId", "name"], name: "vault_items_account_name_unique" },
        { unique: true, fields: ["organizationId", "name"], name: "vault_items_organization_name_unique" },
    ],
    hooks: {
        afterFind: (results) => {
            const normalize = (item) => {
                if (!item) return;
                if (typeof item.fields === "string") {
                    try { item.fields = JSON.parse(item.fields); } catch {}
                }
                for (const flag of ["approvalRequired", "allServers"]) {
                    if (typeof item[flag] === "number") item[flag] = item[flag] === 1;
                }
            };
            Array.isArray(results) ? results.forEach(normalize) : normalize(results);
        },
    },
});
```

Muster `server/models/Snippet.js` (`afterFind` für `osFilter`): Unter dem globalen `query: { raw: true }` liefert SQLite `fields` als JSON-Text und Booleans als `0`/`1`. Der Hook läuft nur für Abfragen auf `VaultItem` selbst, nicht für `include` aus einem anderen Modell.

`server/models/VaultSecret.js`:

```js
const Sequelize = require("sequelize");
const db = require("../utils/database");

// No afterFind hook as in Credential: only server/lib/vault/secrets.js decrypts, so lists and includes never carry plaintext.
module.exports = db.define("vault_secrets", {
    itemId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "vault_items", key: "id" },
        onDelete: "CASCADE",
    },
    field: { type: Sequelize.STRING(32), allowNull: false },
    valueEncrypted: { type: Sequelize.BLOB, allowNull: false },
    valueIV: { type: Sequelize.STRING, allowNull: false },
    valueAuthTag: { type: Sequelize.STRING, allowNull: false },
}, {
    freezeTableName: true,
    timestamps: false,
    indexes: [{ unique: true, fields: ["itemId", "field"], name: "vault_secrets_item_field_unique" }],
});
```

`server/models/VaultBinding.js`:

```js
const Sequelize = require("sequelize");
const db = require("../utils/database");

module.exports = db.define("vault_bindings", {
    itemId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "vault_items", key: "id" },
        onDelete: "CASCADE",
    },
    kind: { type: Sequelize.STRING(16), allowNull: false },
    // Points at entries, folders or tags depending on kind, so no foreign key; deleteEntry/deleteFolder/deleteTag remove bindings.
    targetId: { type: Sequelize.INTEGER, allowNull: false },
}, {
    freezeTableName: true,
    timestamps: false,
    indexes: [{ unique: true, fields: ["itemId", "kind", "targetId"], name: "vault_bindings_item_kind_target_unique" }],
});
```

`server/models/VaultSettings.js`:

```js
const Sequelize = require("sequelize");
const db = require("../utils/database");

const VaultSettings = db.define("vault_settings", {
    id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
    agentUrl: { type: Sequelize.STRING, allowNull: true },
    keyCheck: { type: Sequelize.TEXT, allowNull: true },
    keyCheckIV: { type: Sequelize.STRING, allowNull: true },
    keyCheckAuthTag: { type: Sequelize.STRING, allowNull: true },
    createdAt: { type: Sequelize.DATE, defaultValue: Sequelize.NOW },
    updatedAt: { type: Sequelize.DATE, defaultValue: Sequelize.NOW },
}, { freezeTableName: true });

// Same reasoning as BrowserSettings.getOrCreate: findOrCreate fails with SQLITE_BUSY on two concurrent first calls.
VaultSettings.getOrCreate = async () => {
    const existing = await VaultSettings.findByPk(1, { raw: false });
    if (existing) return existing;
    await VaultSettings.bulkCreate([{ id: 1 }], { ignoreDuplicates: true });
    return VaultSettings.findByPk(1, { raw: false });
};

module.exports = VaultSettings;
```

- [ ] **Step 6: Werte lesen und schreiben**

`server/lib/vault/secrets.js`:

```js
const VaultSecret = require("../../models/VaultSecret");
const { encryptValue, decryptValue } = require("./crypto");
const { VaultError, VaultErrorCode } = require("./errors");
const logger = require("../../utils/logger");

const aadFor = (itemId, field) => `vault:${itemId}:${field}`;

const unreadable = new Set();

const writeSecret = async (itemId, field, value) => {
    const { encrypted, iv, authTag } = encryptValue(value, aadFor(itemId, field));
    const values = { valueEncrypted: encrypted, valueIV: iv, valueAuthTag: authTag };
    const [updated] = await VaultSecret.update(values, { where: { itemId, field } });
    if (updated === 0) await VaultSecret.create({ itemId, field, ...values });
    unreadable.delete(Number(itemId));
};

const readSecret = async (itemId, field) => {
    const row = await VaultSecret.findOne({ where: { itemId, field } });
    if (!row) return null;
    try {
        return decryptValue({ encrypted: row.valueEncrypted, iv: row.valueIV, authTag: row.valueAuthTag }, aadFor(row.itemId, row.field));
    } catch {
        logger.error("Vault secret could not be decrypted", { itemId: row.itemId, field: row.field });
        unreadable.add(Number(row.itemId));
        throw new VaultError(VaultErrorCode.ITEM_UNREADABLE, undefined, { itemId: row.itemId });
    }
};

const clearSecrets = async (itemId) => {
    const removed = await VaultSecret.destroy({ where: { itemId } });
    unreadable.delete(Number(itemId));
    return removed;
};

const isUnreadable = (itemId) => unreadable.has(Number(itemId));

const listSecretFields = async (itemId) =>
    (await VaultSecret.findAll({ where: { itemId }, attributes: ["field"], order: [["field", "ASC"]] })).map((row) => row.field);

module.exports = { writeSecret, readSecret, clearSecrets, listSecretFields, isUnreadable };
```

`Number(...)` hält die Marke unabhängig davon, ob ein Aufrufer die Id aus `req.params` (Text) oder aus einer Zeile (Zahl) übergibt.

- [ ] **Step 7: Test laufen lassen, Erfolg prüfen**

Run: `cd /root/outpost && node --test server/lib/vault/__tests__/crypto.test.js`
Expected: PASS (1 Test). Die zwei Log-Zeilen „Vault secret could not be decrypted itemId=… field=…“ sind erwartet und enthalten keinen Wert.

- [ ] **Step 8: Failing tests für Migration und Schlüsselstatus schreiben**

`server/lib/vault/__tests__/state.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const { Sequelize, DataTypes, QueryTypes } = require("sequelize");

const db = new Sequelize({ dialect: "sqlite", storage: ":memory:", logging: false, query: { raw: true } });
const databasePath = require.resolve("../../../utils/database");
require.cache[databasePath] = { id: databasePath, filename: databasePath, loaded: true, exports: db };

const VaultSettings = require("../../../models/VaultSettings");
const migration = require("../../../migrations/0047-add-vault");
const { initVaultState, getKeyStatus, isVaultEnabled, _resetForTests } = require("../state");
const { writeSecret } = require("../secrets");
const { decryptValue } = require("../crypto");

const KEY_A = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const KEY_B = "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";

test.before(async () => {
    const queryInterface = db.getQueryInterface();
    for (const table of ["accounts", "organizations", "entries", "identities"])
        await queryInterface.createTable(table, { id: { type: DataTypes.INTEGER, primaryKey: true } });
    await queryInterface.createTable("api_keys", {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        accountId: { type: DataTypes.INTEGER, allowNull: false },
        name: { type: DataTypes.STRING, allowNull: false },
        tokenHash: { type: DataTypes.STRING, allowNull: false },
        prefix: { type: DataTypes.STRING, allowNull: false },
        createdAt: { type: DataTypes.DATE, allowNull: true },
    });
    await queryInterface.createTable("sessions", { id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true } });
    await queryInterface.bulkInsert("api_keys", [{ accountId: 1, name: "ci", tokenHash: "h", prefix: "outpost_0011", createdAt: new Date() }]);
    await migration.up(queryInterface, DataTypes);
    await migration.up(queryInterface, DataTypes);
});

test.afterEach(() => {
    delete process.env.VAULT_KEY;
    _resetForTests();
});

test("migration 0047 runs twice, resumes a half-applied run and turns existing API keys into ordinary account keys", async () => {
    const queryInterface = db.getQueryInterface();
    await queryInterface.removeIndex("vault_bindings", "vault_bindings_item_kind_target_unique");
    await queryInterface.removeColumn("api_keys", "seenIpAdopted");
    await migration.up(queryInterface, DataTypes);

    const [legacy] = await db.query("SELECT kind, pending, ipBinding, seenIpAdopted, entryId FROM api_keys", { type: QueryTypes.SELECT });
    assert.deepStrictEqual(
        [legacy.kind, Boolean(legacy.pending), Boolean(legacy.ipBinding), Boolean(legacy.seenIpAdopted), legacy.entryId],
        ["account", false, true, false, null]);
    assert.ok((await queryInterface.describeTable("api_keys")).seenIpAdopted);
    assert.ok((await queryInterface.describeTable("sessions")).impersonatorId);
    const indexes = (await Promise.all(["vault_items", "vault_secrets", "vault_bindings"].map((t) => queryInterface.showIndex(t))))
        .flat().map((i) => i.name);
    for (const name of ["vault_items_account_name_unique", "vault_items_organization_name_unique",
        "vault_secrets_item_field_unique", "vault_bindings_item_kind_target_unique"])
        assert.ok(indexes.includes(name), name);
});

test("without a key the vault is off; the first start with a key writes the check value; another key switches it off only once values are stored", async () => {
    assert.deepStrictEqual(await initVaultState(), { keyStatus: "missing" });
    process.env.VAULT_KEY = "not-a-key";
    assert.deepStrictEqual(await initVaultState(), { keyStatus: "missing" });
    assert.strictEqual(isVaultEnabled(), false);

    process.env.VAULT_KEY = KEY_A;
    assert.deepStrictEqual(await initVaultState(), { keyStatus: "active" });
    assert.strictEqual(isVaultEnabled(), true);
    const stored = await VaultSettings.findByPk(1);
    assert.strictEqual(decryptValue({ encrypted: stored.keyCheck, iv: stored.keyCheckIV, authTag: stored.keyCheckAuthTag }, "vault:keycheck"), "outpost-vault");
    assert.deepStrictEqual(await initVaultState(), { keyStatus: "active" });

    process.env.VAULT_KEY = KEY_B;
    assert.deepStrictEqual(await initVaultState(), { keyStatus: "active" });
    const rewritten = await VaultSettings.findByPk(1);
    assert.notStrictEqual(rewritten.keyCheck, stored.keyCheck);
    assert.strictEqual(decryptValue({ encrypted: rewritten.keyCheck, iv: rewritten.keyCheckIV, authTag: rewritten.keyCheckAuthTag }, "vault:keycheck"), "outpost-vault");

    await db.getQueryInterface().bulkInsert("vault_items", [{ name: "git", type: "login", fields: "{}", approvalRequired: true, allServers: false, createdAt: new Date(), updatedAt: new Date() }]);
    const [{ id: itemId }] = await db.query("SELECT id FROM vault_items", { type: QueryTypes.SELECT });
    await writeSecret(itemId, "password", "hunter2");

    process.env.VAULT_KEY = KEY_A;
    assert.deepStrictEqual(await initVaultState(), { keyStatus: "mismatch" });
    assert.strictEqual(getKeyStatus(), "mismatch");
    assert.strictEqual(isVaultEnabled(), false);
    assert.strictEqual((await VaultSettings.findByPk(1)).keyCheck, rewritten.keyCheck);
});
```

- [ ] **Step 9: Tests laufen lassen, Fehlschlag prüfen**

Run: `cd /root/outpost && node --test server/lib/vault/__tests__/state.test.js`
Expected: FAIL — `Cannot find module '../../../migrations/0047-add-vault'`.

- [ ] **Step 10: Migration 0047 anlegen**

`server/migrations/0047-add-vault.js` (Muster 0044/0045: je Tabelle, Spalte und Index geprüft; `TEXT` für den hex-kodierten Prüfwert wie `oidcIdTokenEncrypted` in 0045):

```js
module.exports = {
    async up(queryInterface, Sequelize) {
        const { STRING, TEXT, INTEGER, BOOLEAN, DATE, BLOB } = Sequelize;

        // Guarded per table, column and index: the runner records a migration only after `up` returns,
        // so a crash halfway leaves it pending and the rerun must skip what already exists.
        const tables = (await queryInterface.showAllTables()).map((t) => t.toLowerCase?.() ?? t);

        const createMissing = async (table, columns) => {
            if (!tables.includes(table)) await queryInterface.createTable(table, columns);
        };
        const uniqueMissing = async (table, fields, name) => {
            const indexes = await queryInterface.showIndex(table);
            if (!indexes.some((i) => i.name === name)) await queryInterface.addIndex(table, fields, { unique: true, name });
        };
        const addMissing = async (table, columns) => {
            if (!tables.includes(table)) return;
            const existing = await queryInterface.describeTable(table);
            for (const [name, definition] of Object.entries(columns)) {
                if (!existing[name]) await queryInterface.addColumn(table, name, definition);
            }
        };

        await createMissing("vault_items", {
            id: { type: INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
            accountId: { type: INTEGER, allowNull: true, references: { model: "accounts", key: "id" }, onDelete: "CASCADE" },
            organizationId: { type: INTEGER, allowNull: true, references: { model: "organizations", key: "id" }, onDelete: "CASCADE" },
            name: { type: STRING(64), allowNull: false },
            type: { type: STRING(16), allowNull: false },
            description: { type: TEXT, allowNull: true },
            fields: { type: Sequelize.JSON, allowNull: false },
            approvalRequired: { type: BOOLEAN, allowNull: false, defaultValue: true },
            allServers: { type: BOOLEAN, allowNull: false, defaultValue: false },
            createdBy: { type: INTEGER, allowNull: true, references: { model: "accounts", key: "id" }, onDelete: "SET NULL" },
            lastUsedAt: { type: DATE, allowNull: true },
            createdAt: { type: DATE, allowNull: false, defaultValue: Sequelize.NOW },
            updatedAt: { type: DATE, allowNull: false, defaultValue: Sequelize.NOW },
        });
        await uniqueMissing("vault_items", ["accountId", "name"], "vault_items_account_name_unique");
        await uniqueMissing("vault_items", ["organizationId", "name"], "vault_items_organization_name_unique");

        await createMissing("vault_secrets", {
            id: { type: INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
            itemId: { type: INTEGER, allowNull: false, references: { model: "vault_items", key: "id" }, onDelete: "CASCADE" },
            field: { type: STRING(32), allowNull: false },
            valueEncrypted: { type: BLOB, allowNull: false },
            valueIV: { type: STRING, allowNull: false },
            valueAuthTag: { type: STRING, allowNull: false },
        });
        await uniqueMissing("vault_secrets", ["itemId", "field"], "vault_secrets_item_field_unique");

        await createMissing("vault_bindings", {
            id: { type: INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
            itemId: { type: INTEGER, allowNull: false, references: { model: "vault_items", key: "id" }, onDelete: "CASCADE" },
            kind: { type: STRING(16), allowNull: false },
            targetId: { type: INTEGER, allowNull: false },
        });
        await uniqueMissing("vault_bindings", ["itemId", "kind", "targetId"], "vault_bindings_item_kind_target_unique");

        await createMissing("vault_settings", {
            id: { type: INTEGER, primaryKey: true, autoIncrement: true },
            agentUrl: { type: STRING, allowNull: true },
            // Hex-encoded ciphertext; TEXT like oidcIdTokenEncrypted in 0045, so MySQL never truncates it.
            keyCheck: { type: TEXT, allowNull: true },
            keyCheckIV: { type: STRING, allowNull: true },
            keyCheckAuthTag: { type: STRING, allowNull: true },
            createdAt: { type: DATE, allowNull: true },
            updatedAt: { type: DATE, allowNull: true },
        });

        await addMissing("api_keys", {
            kind: { type: STRING, allowNull: false, defaultValue: "account" },
            pending: { type: BOOLEAN, allowNull: false, defaultValue: false },
            entryId: { type: INTEGER, allowNull: true, references: { model: "entries", key: "id" }, onDelete: "CASCADE" },
            agentType: { type: STRING, allowNull: true },
            ipBinding: { type: BOOLEAN, allowNull: false, defaultValue: true },
            allowedCidrs: { type: Sequelize.JSON, allowNull: true },
            identityId: { type: INTEGER, allowNull: true, references: { model: "identities", key: "id" }, onDelete: "SET NULL" },
            remoteUser: { type: STRING, allowNull: true },
            seenIp: { type: STRING, allowNull: true },
            seenIpAdopted: { type: BOOLEAN, allowNull: false, defaultValue: false },
        });
        await addMissing("sessions", { impersonatorId: { type: INTEGER, allowNull: true } });
    },
};
```

- [ ] **Step 11: `ApiKey` und `Session` um die neuen Spalten erweitern**

`server/models/ApiKey.js`, vorher (Z. 31-39):

```js
    expiresAt: {
        type: Sequelize.DATE,
        allowNull: true,
    },
}, {
    freezeTableName: true,
    timestamps: true,
    updatedAt: false,
});
```

nachher:

```js
    expiresAt: {
        type: Sequelize.DATE,
        allowNull: true,
    },
    kind: { type: Sequelize.STRING, allowNull: false, defaultValue: "account" },
    pending: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
    entryId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: "entries", key: "id" },
        onDelete: "CASCADE",
    },
    agentType: { type: Sequelize.STRING, allowNull: true },
    ipBinding: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
    allowedCidrs: { type: Sequelize.JSON, allowNull: true },
    identityId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: "identities", key: "id" },
        onDelete: "SET NULL",
    },
    remoteUser: { type: Sequelize.STRING, allowNull: true },
    seenIp: { type: Sequelize.STRING, allowNull: true },
    seenIpAdopted: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
}, {
    freezeTableName: true,
    timestamps: true,
    updatedAt: false,
    hooks: {
        afterFind: (results) => {
            const normalize = (key) => {
                if (!key) return;
                if (typeof key.allowedCidrs === "string") {
                    try { key.allowedCidrs = JSON.parse(key.allowedCidrs); } catch { key.allowedCidrs = []; }
                }
                for (const flag of ["pending", "ipBinding", "seenIpAdopted"]) {
                    if (typeof key[flag] === "number") key[flag] = key[flag] === 1;
                }
            };
            Array.isArray(results) ? results.forEach(normalize) : normalize(results);
        },
    },
});
```

Muster `server/models/Snippet.js` (`afterFind` für `osFilter`); `ApiKey.js` bleibt wie im Bestand ohne Kommentar. Unter dem globalen `query: { raw: true }` liefern SQLite und MariaDB JSON als Text und Booleans als `0`/`1`. Ein `allowedCidrs`-Text, der kein JSON ist, wird zur leeren Liste, damit Task 4 (`isAddressAllowed`) und Task 8 `allowedCidrs ?? []` ohne eigene Prüfung als Array lesen.

`server/models/Session.js`, vorher (Z. 38-42):

```js
    oidcIdTokenAuthTag: {
        type: Sequelize.STRING,
        allowNull: true,
    },
}, { freezeTableName: true, createdAt: false, updatedAt: false });
```

nachher:

```js
    oidcIdTokenAuthTag: {
        type: Sequelize.STRING,
        allowNull: true,
    },
    impersonatorId: {
        type: Sequelize.INTEGER,
        allowNull: true,
    },
}, { freezeTableName: true, createdAt: false, updatedAt: false });
```

- [ ] **Step 12: Schlüsselstatus anlegen**

`server/lib/vault/state.js`:

```js
const VaultSettings = require("../../models/VaultSettings");
const VaultSecret = require("../../models/VaultSecret");
const { encryptValue, decryptValue, hasValidKey } = require("./crypto");
const { sendError } = require("../../utils/error");
const logger = require("../../utils/logger");

const KEYCHECK_PLAINTEXT = "outpost-vault";
const KEYCHECK_AAD = "vault:keycheck";

let keyStatus = "missing";

const decrypts = (sealed, aad, expected) => {
    try {
        const plaintext = decryptValue(sealed, aad);
        return expected === undefined || plaintext === expected;
    } catch {
        return false;
    }
};

const checkStoredKey = (settings) =>
    decrypts({ encrypted: settings.keyCheck, iv: settings.keyCheckIV, authTag: settings.keyCheckAuthTag }, KEYCHECK_AAD, KEYCHECK_PLAINTEXT);

// A changed key only locks data that exists: without stored values nothing is lost by adopting it.
const storedValuesReadable = async () => {
    const row = await VaultSecret.findOne({ order: [["id", "ASC"]] });
    return !row || decrypts({ encrypted: row.valueEncrypted, iv: row.valueIV, authTag: row.valueAuthTag }, `vault:${row.itemId}:${row.field}`);
};

const writeKeyCheck = async (settings) => {
    const { encrypted, iv, authTag } = encryptValue(KEYCHECK_PLAINTEXT, KEYCHECK_AAD);
    await settings.update({ keyCheck: encrypted.toString("hex"), keyCheckIV: iv, keyCheckAuthTag: authTag });
};

const initVaultState = async () => {
    if (!hasValidKey()) {
        keyStatus = "missing";
        if (process.env.VAULT_KEY) logger.warn("VAULT_KEY is not 64 hex characters; the vault stays off");
        else logger.system("No VAULT_KEY set; the vault stays off");
        return { keyStatus };
    }
    const settings = await VaultSettings.getOrCreate();
    if (settings.keyCheck && checkStoredKey(settings)) {
        keyStatus = "active";
    } else if (!settings.keyCheck || await storedValuesReadable()) {
        if (settings.keyCheck) logger.warn("VAULT_KEY changed while no stored value depends on the old key; the check value is rewritten");
        await writeKeyCheck(settings);
        keyStatus = "active";
    } else {
        keyStatus = "mismatch";
    }
    if (keyStatus === "mismatch") logger.error("VAULT_KEY does not match the stored vault data; the vault stays off");
    else logger.system("Vault enabled");
    return { keyStatus };
};

const getKeyStatus = () => keyStatus;

const isVaultEnabled = () => keyStatus === "active";

const requireVaultEnabled = (req, res, next) => {
    if (!isVaultEnabled()) return sendError(res, 404, 404, "Not found");
    next();
};

const _resetForTests = () => {
    keyStatus = "missing";
};

module.exports = { initVaultState, getKeyStatus, isVaultEnabled, requireVaultEnabled, _resetForTests };
```

- [ ] **Step 13: Tests laufen lassen, Erfolg prüfen**

Run: `cd /root/outpost && node --test server/lib/vault/__tests__/crypto.test.js server/lib/vault/__tests__/state.test.js`
Expected: PASS (3 Tests).

- [ ] **Step 14: Rechte eintragen**

`server/permissions/registry.js` — in `Permission` nach Z. 23 (`SETTINGS_BROWSER: "settings.browser",`):

```js
    SETTINGS_VAULT: "settings.vault",
```

nach Z. 40 (`SCRIPTS_EXECUTE: "scripts.execute",`) und der folgenden Leerzeile:

```js
    VAULT_USE: "vault.use",
    VAULT_MANAGE: "vault.manage",
    VAULT_REVEAL: "vault.reveal",

```

In `CATEGORIES` nach Z. 59 (`files`); das Symbol `mdiShieldKeyOutline` kennt der Client bereits (`PermissionMatrix.jsx`, `ICONS`), ein neuer Schlüssel bliebe dort ohne Icon:

```js
    { key: "vault", label: "Vault", icon: "mdiShieldKeyOutline" },
```

In `PERMISSIONS` nach Z. 86 (`P.SETTINGS_BROWSER`):

```js
    { id: P.SETTINGS_VAULT, scopes: [SYSTEM], category: "settings", label: "Vault", description: "See whether the vault key is active and set the Outpost address agents use.", dangerous: true },
```

nach Z. 105 (`P.FILES_MODIFY`):

```js

    { id: P.VAULT_USE, scopes: [SYSTEM], category: "vault", default: false, label: "Use the Vault", description: "Keep personal credentials in the vault and let your own agents fill them in. Agents act with these credentials, so it is off by default.", dangerous: true },
    { id: P.VAULT_MANAGE, scopes: [ORGANIZATION], category: "vault", label: "Manage Vault Items", description: "Create, edit and delete the organization's vault items." },
    { id: P.VAULT_REVEAL, scopes: [ORGANIZATION], category: "vault", label: "Reveal Vault Values", description: "Show and copy the stored values of the organization's vault items.", dangerous: true },
```

Org-Eigentümer erhalten `vault.manage` und `vault.reveal` über `registry.allOrgIds()` (`server/permissions/engine.js:76`), andere Mitglieder nur per Override; das entspricht der Spec. `settings.vault` ist `dangerous` wie `settings.backup`: Wer die Agenten-Adresse setzt, bestimmt, an welche Adresse künftig eingerichtete Agenten ihre Keys senden.

- [ ] **Step 15: Audit-Aktionen eintragen**

`server/controllers/audit.js` — nach Z. 8 (`const Script = require("../models/Script");`):

```js
const VaultItem = require("../models/VaultItem");
```

`RESOURCE_CONFIG`, vorher (Z. 20-21):

```js
    script: { model: Script, detailsKey: "name" },
};
```

nachher:

```js
    script: { model: Script, detailsKey: "name" },
    vault: { model: VaultItem, detailsKey: "item" },
};
```

`AUDIT_ACTIONS`, vorher (Z. 73-74):

```js
    BROWSER_CLOSE: "browser.close",
};
```

nachher:

```js
    BROWSER_CLOSE: "browser.close",

    VAULT_ITEM_CREATE: "vault.item_create",
    VAULT_ITEM_UPDATE: "vault.item_update",
    VAULT_ITEM_DELETE: "vault.item_delete",
    VAULT_REVEAL: "vault.reveal",
    VAULT_USE: "vault.use",
    VAULT_APPROVE: "vault.approve",
    VAULT_DENY: "vault.deny",
    VAULT_AGENT_KEY_CREATE: "vault.agent_key_create",
    VAULT_AGENT_KEY_REVOKE: "vault.agent_key_revoke",
    VAULT_AGENT_IP_DENIED: "vault.agent_ip_denied",
    VAULT_USE_DENIED: "vault.use_denied",
    VAULT_APPROVAL_TIMEOUT: "vault.approval_timeout",
    VAULT_ITEM_UNREADABLE: "vault.item_unreadable",
    VAULT_EVALUATE_LOCKED: "vault.evaluate_locked",
    VAULT_SCREENSHOT_LOCKED: "vault.screenshot_locked",
    VAULT_INPUT_LOCKED: "vault.input_locked",
    VAULT_PERSISTENT_NOT_ALLOWED: "vault.persistent_not_allowed",
};
```

`RESOURCE_TYPES`, vorher (Z. 82-83) `    BROWSER: "browser",` / `};`, nachher:

```js
    BROWSER: "browser",
    VAULT: "vault",
};
```

`ACTION_LABELS`, vorher (Z. 135-136):

```js
    "browser.close": "Browser session closed",
};
```

nachher:

```js
    "browser.close": "Browser session closed",

    "vault.item_create": "Vault item created",
    "vault.item_update": "Vault item updated",
    "vault.item_delete": "Vault item deleted",
    "vault.reveal": "Vault value revealed",
    "vault.use": "Vault item used by an agent",
    "vault.approve": "Vault use approved",
    "vault.deny": "Vault use denied",
    "vault.agent_key_create": "Agent key created",
    "vault.agent_key_revoke": "Agent key revoked",
    "vault.agent_ip_denied": "Agent key refused from a foreign address",
    "vault.use_denied": "Vault use refused",
    "vault.approval_timeout": "Vault approval expired",
    "vault.item_unreadable": "Vault item could not be decrypted",
    "vault.evaluate_locked": "Script blocked after a credential fill",
    "vault.screenshot_locked": "Screenshot blocked while a password is shown",
    "vault.input_locked": "Text selection or paste blocked after a credential fill",
    "vault.persistent_not_allowed": "Credential fill refused in the persistent profile",
};
```

`ACTION_CATEGORIES`, nach Z. 146 (`browser`):

```js
    { key: "vault", label: "Vault", description: "Vault items, revealed values, agent use and approvals, agent keys" },
```

`RESOURCE_LABELS`, vorher (Z. 155-156) `    browser: "Browser session",` / `};`, nachher:

```js
    browser: "Browser session",
    vault: "Vault item",
};
```

`shouldAudit` bleibt unverändert: Für `vault.*` greift keine der Prüfungen, die Aktionen werden also immer geschrieben, auch wenn eine Organisation andere Audit-Kategorien abschaltet. Das ist gewollt (Spec: „jeder Zugriff steht im Audit-Log“); ein Org-Schalter entsteht deshalb nicht.

- [ ] **Step 16: Router-Gerüst anlegen**

`server/routes/vault/index.js`:

```js
const { Router } = require("express");

const app = Router();

// The sub-routers share this root: a router-level middleware in one of them would run for every
// vault request, including GET /available and /settings, so guards belong on the routes.
app.use(require("./items"));
app.use(require("./approvals"));
app.use(require("./agentKeys"));
app.use(require("./settings"));

module.exports = app;
```

`server/routes/vault/items.js`, `server/routes/vault/approvals.js`, `server/routes/vault/agentKeys.js`, `server/routes/vault/settings.js` — je dieselbe Platzhalter-Datei (Tasks 5, 6, 8 füllen sie):

```js
const { Router } = require("express");

module.exports = Router();
```

- [ ] **Step 17: In `server/index.js` einhängen**

Nach Z. 29 (`const { mountStaticSite } = require("./lib/staticSite");`):

```js
const { initVaultState } = require("./lib/vault/state");
```

Vorher (Z. 90):

```js
app.use("/api/mcp", authenticate, require("./routes/mcp"));
```

nachher:

```js
app.use("/api/mcp", authenticate, require("./routes/mcp"));
// Without `authenticate` here: GET /api/vault/agent-keys/probe must let a pending agent key through,
// which authenticate turns away everywhere else. Every vault route carries authenticate itself.
app.use("/api/vault", require("./routes/vault"));
```

Vorher (Z. 143-146):

```js
        const migrationRunner = new MigrationRunner();
        await migrationRunner.runMigrations();

        await ensureInternalProvider();
```

nachher:

```js
        const migrationRunner = new MigrationRunner();
        await migrationRunner.runMigrations();

        try {
            await initVaultState();
        } catch (err) {
            logger.error("Could not determine the vault key status; the vault stays off", { error: err.message });
        }

        await ensureInternalProvider();
```

Ein Fehler in `initVaultState` (etwa eine gesperrte SQLite-Datei) hält damit nicht den ganzen Start an; `keyStatus` bleibt `missing`, also bleibt der Vault aus. `logger` ist in `server/index.js` bereits importiert.

- [ ] **Step 18: Prüfen, dass Bestand und Gerüst laden**

Run: `cd /root/outpost && node --test server/lib/vault/__tests__/*.test.js server/lib/__tests__/oidcLogout.test.js server/lib/__tests__/browserAudit.test.js && yarn lint`
Expected: PASS, Lint ohne Befund.

Run: `cd /root/outpost && node -e 'const r = require("./server/permissions/registry"); console.log(r.buildCatalog("system").categories.map((c) => c.key).join(","), r.buildCatalog("organization").permissions.filter((p) => p.category === "vault").map((p) => p.id).join(","))'`
Expected: `users,permissions,organizations,auditing,settings,resources,connections,files,vault vault.manage,vault.reveal`

- [ ] **Step 19: Commit**

```bash
git add server/migrations/0047-add-vault.js server/models/VaultItem.js server/models/VaultSecret.js server/models/VaultBinding.js server/models/VaultSettings.js server/models/ApiKey.js server/models/Session.js server/lib/vault/errors.js server/lib/vault/crypto.js server/lib/vault/secrets.js server/lib/vault/state.js server/lib/vault/__tests__/crypto.test.js server/lib/vault/__tests__/state.test.js server/permissions/registry.js server/controllers/audit.js server/routes/vault server/index.js
git commit -m "Vault: Grundlage mit Migration, Verschlüsselung, Schlüsselstatus, Rechten und Audit-Aktionen"
```

---

### Task 2: MCP-Rahmen — Werkzeug-Anbieter, Transport je Schlüssel, Abbruchsignal

**Files:**
- Create (per `git mv`): `server/lib/mcp/server.js` aus `server/lib/browser/mcpServer.js` (ganze Datei umgebaut)
- Delete: `server/lib/browser/mcpServer.js` (durch den `git mv`)
- Create (per `git mv`): `server/lib/mcp/__tests__/server.test.js` aus `server/lib/browser/__tests__/mcpServer.test.js` (angepasst, zwei neue Tests)
- Create: `server/lib/mcp/__tests__/mcpRoute.test.js` (zusätzlich: der Abbruch hängt an `res.on("close")` in der Route und lässt sich nur dort prüfen)
- Modify: `server/routes/mcp.js` (Kopf Z. 1-11, `POST /` Z. 33-45, `DELETE /` Z. 56)

**Interfaces:**
- Consumes: nichts aus anderen Tasks. `req.agent` setzt erst Task 4; bis dahin ist es `undefined` und die Route reicht `null` weiter. `req.apiKey` setzt `authenticate` schon heute für Konto-Keys (`server/middlewares/auth.js:21`), `req.session` für Login-Sessions; die Spalte `sessions.impersonatorId` legt Task 1 an (bis dahin ist der Wert `undefined` und die Route reicht `null` weiter).
- Produces (von Tasks 6, 7, 11 genutzt):
  - `createMcpServer({ providers: Provider[], now = Date.now }) → { handle, end }` aus `server/lib/mcp/server.js`.
  - `Provider = { name: string, available(ctx) → Promise<boolean>, list(ctx) → Tool[], has(name, ctx) → boolean, call(name, args, ctx) → Promise<ToolResult>, forgetTransport(transportId) → void }`. `tools/list` liefert die Werkzeuge aller verfügbaren Anbieter in der Reihenfolge von `providers`; `tools/call` leitet an den ersten verfügbaren Anbieter, dessen `has(name, ctx)` gilt, sonst `-32602 "Unknown tool: <name>"`. `forgetTransport` geht beim Verdrängen, beim Aufräumen nach 12 h und bei `end` an **alle** Anbieter.
  - `handle({ body, transportId, accountId, keyId = null, agent = null, impersonatorId = null, ipAddress = null, userAgent = null, signal }) → Promise<{ status, headers?, body? }>`; `end({ transportId, accountId, keyId = null }) → { status: 200|404 }`.
  - Transport-Record `{ accountId, keyId, lastSeen }`; anderer Aufrufer (abweichendes `accountId` **oder** `keyId`, auch `null` gegen eine Key-Id) → `404` mit `-32001` wie ein unbekannter Transport, ebenso bei `end`. `MAX_TRANSPORTS_PER_CALLER = 50` je (`accountId`, `keyId`): Die Transporte eines Keys verdrängen nie die eines anderen Keys desselben Kontos.
  - `ctx` an jeden Anbieter: `{ accountId, agent, keyId, impersonatorId, transportId, ipAddress, userAgent, signal }` — `impersonatorId` ist die Konto-Id des Admins, wenn die Login-Session eine Impersonation ist, sonst `null` (Task 11 schreibt ihn ins Audit).
  - `server/routes/mcp.js`: modulweite Konstante `browserTools` (= `createBrowserTools({ getPool: getBrowserPool })`, Task 11 reicht sie als `getBrowserTools: () => browserTools` an den Vault-Anbieter), `browserProvider` (`available` = `connect.browser`), `callerOf(req) → { accountId, keyId }`; `POST /` reicht `keyId = req.apiKey?.id ?? null`, `agent = req.agent ?? null`, `impersonatorId = req.session?.impersonatorId ?? null` und ein `AbortController`-Signal weiter, das abbricht, wenn der Client die Verbindung vor der fertigen Antwort schließt. Task 11 ergänzt den Vault-Anbieter im Array `providers`.

**Design:** kein UI-Anteil.

**Tests:** 7 Tests, test-first (Vertrag fest; die Bestandstests ziehen mit um).
- `server.test.js` (6): die vier Bestandstests, angepasst an Anbieter (Handshake ohne verfügbaren Anbieter → keine Werkzeuge, `-32602`; unbekannter/fremder Transport `404`, fehlender Header `400`, `DELETE` beendet und meldet `forgetTransport`; voller `ctx` je Transport, einschließlich `impersonatorId`; `"params": null`). Neu: (a) Transport eines anderen Keys desselben Kontos und der Login-Session → `404`, auch für `end`; 50 Transporte eines Keys verdrängen den Transport eines anderen Keys nicht. (b) `tools/list` vereinigt die verfügbaren Anbieter; das Werkzeug eines nicht verfügbaren Anbieters antwortet bei `tools/call` wie ein unbekanntes und erreicht den Anbieter nicht.
- `mcpRoute.test.js` (1, Route über HTTP mit gefakten Browser-Werkzeugen): (c) Das `signal` im `ctx` bricht ab, wenn der Client die Verbindung während des Werkzeugaufrufs schließt, und bleibt bei einer normal beantworteten Anfrage unberührt; `keyId` kommt aus `req.apiKey.id` — ein zweiter Request mit anderem `req.apiKey.id` und derselben `mcp-session-id` bekommt über HTTP `404` (`-32001`) und erreicht das Werkzeug nicht. `timeout: 2000`, damit ein fehlender Abbruch als Fehlschlag statt als hängender Test endet.
- Nicht getestet: Verdrahtung `browserProvider` (reine Weiterreichung an `createBrowserTools`), das Auslesen von `req.session?.impersonatorId` in der Route (Weiterreichung), `GET /mcp` → 405, das Aufräumen nach 12 h (unverändert aus dem Bestand), der generische 500-Text.
- SEC-Abdeckung dieses Tasks: SEC-IDOR-01 und SEC-SESS-02 (Transport gehört dem Key, der ihn geöffnet hat; fremder Aufrufer `404`), SEC-ERR-01 (500-Antwort ohne `err.message`, die Meldung geht nur ins Server-Log).

**Parallel:** Task 1, 7, 10 (Welle A; keine gemeinsamen Dateien: Task 1 schreibt `server/lib/vault/*`, Modelle, `server/index.js`, Task 7 `server/lib/browser/*` ohne `mcpServer.js`, Task 10 nur `client/`; der Test dieses Tasks fakt `server/lib/browser/tools.js` und hängt nicht von Task 7 ab).

- [ ] **Step 1: Test umziehen und auf Anbieter umschreiben**

```bash
mkdir -p server/lib/mcp/__tests__
git mv server/lib/browser/__tests__/mcpServer.test.js server/lib/mcp/__tests__/server.test.js
```

Inhalt von `server/lib/mcp/__tests__/server.test.js` vollständig ersetzen:

```js
const test = require("node:test");
const assert = require("node:assert");
const { createMcpServer } = require("../server");

const fakeProvider = ({ name = "browser", tools = ["browser_snapshot"], available = async () => true } = {}) => {
    const calls = [];
    const forgotten = [];
    return {
        name,
        calls,
        forgotten,
        available,
        list: () => tools.map((tool) => ({ name: tool, description: "x", inputSchema: { type: "object", properties: {} } })),
        has: (tool) => tools.includes(tool),
        call: async (tool, args, ctx) => {
            calls.push({ tool, args, ctx });
            return { content: [{ type: "text", text: `${name} ok` }] };
        },
        forgetTransport: (transportId) => forgotten.push(transportId),
    };
};

const rpc = (id, method, params = {}) => ({ jsonrpc: "2.0", id, method, params });

const handshake = async (mcp, accountId, keyId = null) => {
    const init = await mcp.handle({ body: rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "1" } }), accountId, keyId });
    const transportId = init.headers["Mcp-Session-Id"];
    const ack = await mcp.handle({ body: { jsonrpc: "2.0", method: "notifications/initialized" }, transportId, accountId, keyId });
    return { init, transportId, ack };
};

test("the handshake opens a transport; a caller whose only provider is unavailable sees no tools and cannot call one", async () => {
    const mcp = createMcpServer({ providers: [fakeProvider({ available: async (ctx) => ctx.accountId === 1 })] });
    const { init, transportId, ack } = await handshake(mcp, 1);
    assert.strictEqual(init.status, 200);
    assert.strictEqual(init.body.result.protocolVersion, "2025-06-18");
    assert.deepStrictEqual(init.body.result.capabilities, { tools: { listChanged: false } });
    assert.match(transportId, /^[0-9a-f-]{36}$/);
    assert.strictEqual(ack.status, 202);
    const listed = await mcp.handle({ body: rpc(2, "tools/list"), transportId, accountId: 1 });
    assert.deepStrictEqual(listed.body.result.tools.map((t) => t.name), ["browser_snapshot"]);

    const other = await handshake(mcp, 2);
    const hidden = await mcp.handle({ body: rpc(2, "tools/list"), transportId: other.transportId, accountId: 2 });
    assert.deepStrictEqual(hidden.body.result.tools, []);
    const call = await mcp.handle({ body: rpc(3, "tools/call", { name: "browser_snapshot", arguments: {} }), transportId: other.transportId, accountId: 2 });
    assert.strictEqual(call.body.error.code, -32602);
});

test("an unknown transport or another account's gets 404, a missing header 400, and DELETE ends it", async () => {
    const provider = fakeProvider();
    const mcp = createMcpServer({ providers: [provider] });
    const { transportId } = await handshake(mcp, 1);
    assert.strictEqual((await mcp.handle({ body: rpc(2, "tools/list"), transportId: "nope", accountId: 1 })).status, 404);
    assert.strictEqual((await mcp.handle({ body: rpc(2, "tools/list"), transportId, accountId: 2 })).status, 404);
    assert.strictEqual((await mcp.handle({ body: rpc(2, "tools/list"), accountId: 1 })).status, 400);
    assert.strictEqual(mcp.end({ transportId, accountId: 1 }).status, 200);
    assert.deepStrictEqual(provider.forgotten, [transportId]);
    assert.strictEqual((await mcp.handle({ body: rpc(3, "tools/list"), transportId, accountId: 1 })).status, 404);
});

test("a transport belongs to the key that opened it: another key of the same account gets 404, also on DELETE", async () => {
    const mcp = createMcpServer({ providers: [fakeProvider()] });
    const { transportId } = await handshake(mcp, 1, 5);

    for (const keyId of [6, null]) {
        assert.strictEqual((await mcp.handle({ body: rpc(2, "tools/list"), transportId, accountId: 1, keyId })).status, 404);
        assert.strictEqual(mcp.end({ transportId, accountId: 1, keyId }).status, 404);
    }
    for (let i = 0; i < 50; i++) await handshake(mcp, 1, 6);
    assert.strictEqual((await mcp.handle({ body: rpc(3, "ping"), transportId, accountId: 1, keyId: 5 })).status, 200);
    assert.strictEqual(mcp.end({ transportId, accountId: 1, keyId: 5 }).status, 200);
});

test("tools/list joins the available providers and tools/call answers a tool of an unavailable one as unknown", async () => {
    const browser = fakeProvider();
    const vault = fakeProvider({ name: "vault", tools: ["vault_list"], available: async (ctx) => ctx.keyId === 5 });
    const mcp = createMcpServer({ providers: [browser, vault] });
    const withVault = await handshake(mcp, 1, 5);
    const withoutVault = await handshake(mcp, 1, 6);

    const listed = await mcp.handle({ body: rpc(2, "tools/list"), transportId: withVault.transportId, accountId: 1, keyId: 5 });
    assert.deepStrictEqual(listed.body.result.tools.map((t) => t.name), ["browser_snapshot", "vault_list"]);
    const called = await mcp.handle({ body: rpc(3, "tools/call", { name: "vault_list", arguments: {} }), transportId: withVault.transportId, accountId: 1, keyId: 5 });
    assert.deepStrictEqual(called.body.result.content, [{ type: "text", text: "vault ok" }]);

    const refused = await mcp.handle({ body: rpc(4, "tools/call", { name: "vault_list", arguments: {} }), transportId: withoutVault.transportId, accountId: 1, keyId: 6 });
    assert.deepStrictEqual(refused.body.error, { code: -32602, message: "Unknown tool: vault_list" });
    assert.strictEqual(vault.calls.length, 1);
});

test("each transport reaches the providers under its own id with the full caller context", async () => {
    const provider = fakeProvider();
    const mcp = createMcpServer({ providers: [provider] });
    const first = await handshake(mcp, 1, 5);
    const second = await handshake(mcp, 1, 5);
    assert.notStrictEqual(first.transportId, second.transportId);

    const agent = { keyId: 5, entryId: 9, agentType: "claude" };
    const { signal } = new AbortController();
    for (const { transportId } of [first, second])
        await mcp.handle({ body: rpc(9, "tools/call", { name: "browser_snapshot", arguments: { sessionId: "x" } }), transportId, accountId: 1, keyId: 5, agent, impersonatorId: 2, ipAddress: "10.0.0.1", userAgent: "ua", signal });

    assert.deepStrictEqual(provider.calls.map((c) => c.ctx.transportId), [first.transportId, second.transportId]);
    assert.deepStrictEqual(provider.calls[0].ctx, { accountId: 1, agent, keyId: 5, impersonatorId: 2, transportId: first.transportId, ipAddress: "10.0.0.1", userAgent: "ua", signal });
    assert.deepStrictEqual(provider.calls[0].args, { sessionId: "x" });
});

test("a request with \"params\": null is answered, not failed", async () => {
    const mcp = createMcpServer({ providers: [fakeProvider()] });
    const init = await mcp.handle({ body: { jsonrpc: "2.0", id: 1, method: "initialize", params: null }, accountId: 1 });
    assert.strictEqual(init.status, 200);
    assert.strictEqual(init.body.result.protocolVersion, "2025-06-18");
    const call = await mcp.handle({ body: { jsonrpc: "2.0", id: 2, method: "tools/call", params: null }, transportId: init.headers["Mcp-Session-Id"], accountId: 1 });
    assert.strictEqual(call.body.error.code, -32602);
});
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag prüfen**

Run: `cd /root/outpost && node --test server/lib/mcp/__tests__/server.test.js`
Expected: FAIL — `Cannot find module '../server'`.

- [ ] **Step 3: MCP-Server umziehen und auf Anbieter umbauen**

```bash
git mv server/lib/browser/mcpServer.js server/lib/mcp/server.js
```

Inhalt von `server/lib/mcp/server.js` vollständig ersetzen (der Pfad zu `package.json` bleibt `../../../package.json`, die Tiefe ist gleich):

```js
const { randomUUID } = require("node:crypto");
const packageJson = require("../../../package.json");

const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26"];
const TRANSPORT_IDLE_MS = 12 * 60 * 60 * 1000;
const MAX_TRANSPORTS_PER_CALLER = 50;

const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

const createMcpServer = ({ providers, now = Date.now }) => {
    const transports = new Map();

    const forget = (transportId) => {
        transports.delete(transportId);
        for (const provider of providers) provider.forgetTransport(transportId);
    };

    const sweep = () => {
        for (const [id, transport] of transports) {
            if (now() - transport.lastSeen > TRANSPORT_IDLE_MS) forget(id);
        }
    };

    const ownedBy = (transport, accountId, keyId) => !!transport && transport.accountId === accountId && transport.keyId === keyId;

    const availableProviders = async (ctx) => {
        const available = await Promise.all(providers.map((provider) => provider.available(ctx)));
        return providers.filter((_, index) => available[index]);
    };

    const handle = async ({ body, transportId, accountId, keyId = null, agent = null, impersonatorId = null, ipAddress = null, userAgent = null, signal }) => {
        sweep();
        if (Array.isArray(body)) return { status: 400, body: rpcError(null, -32600, "Batched requests are not supported") };
        if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string")
            return { status: 400, body: rpcError(body?.id, -32600, "Invalid JSON-RPC request") };
        const { id, method } = body;
        const params = body.params ?? {};

        if (method === "initialize") {
            const own = [...transports].filter(([, t]) => ownedBy(t, accountId, keyId)).sort(([, a], [, b]) => a.lastSeen - b.lastSeen);
            for (const [oldId] of own.slice(0, Math.max(0, own.length - MAX_TRANSPORTS_PER_CALLER + 1))) forget(oldId);
            const newId = randomUUID();
            transports.set(newId, { accountId, keyId, lastSeen: now() });
            return {
                status: 200,
                headers: { "Mcp-Session-Id": newId },
                body: rpcResult(id, {
                    protocolVersion: SUPPORTED_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : SUPPORTED_VERSIONS[0],
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: { name: "outpost", version: packageJson.version },
                }),
            };
        }

        const transport = transportId ? transports.get(transportId) : null;
        if (!ownedBy(transport, accountId, keyId)) {
            return transportId
                ? { status: 404, body: rpcError(id, -32001, "Unknown MCP session; initialize again") }
                : { status: 400, body: rpcError(id, -32600, "Missing Mcp-Session-Id header") };
        }
        transport.lastSeen = now();

        if (id === undefined) return { status: 202 };

        const ctx = { accountId, agent, keyId, impersonatorId, transportId, ipAddress, userAgent, signal };
        switch (method) {
            case "ping":
                return { status: 200, body: rpcResult(id, {}) };
            case "tools/list": {
                const tools = (await availableProviders(ctx)).flatMap((provider) => provider.list(ctx));
                return { status: 200, body: rpcResult(id, { tools }) };
            }
            case "tools/call": {
                const provider = (await availableProviders(ctx)).find((p) => p.has(params.name, ctx));
                if (!provider) return { status: 200, body: rpcError(id, -32602, `Unknown tool: ${params.name}`) };
                return { status: 200, body: rpcResult(id, await provider.call(params.name, params.arguments ?? {}, ctx)) };
            }
            default:
                return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
        }
    };

    const end = ({ transportId, accountId, keyId = null }) => {
        if (!ownedBy(transports.get(transportId), accountId, keyId)) return { status: 404 };
        forget(transportId);
        return { status: 200 };
    };

    return { handle, end };
};

module.exports = { createMcpServer };
```

- [ ] **Step 4: Test laufen lassen, Erfolg prüfen**

Run: `cd /root/outpost && node --test server/lib/mcp/__tests__/server.test.js`
Expected: PASS (6 Tests).

- [ ] **Step 5: Failing test für das Abbruchsignal der Route schreiben**

`server/lib/mcp/__tests__/mcpRoute.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const express = require("express");

const fake = (path, exports) => {
    const resolved = require.resolve(path);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

const seen = [];
let reachedTool = () => {};
fake("../../../utils/permission", { hasAccountPermission: async () => true });
fake("../../browser", { getBrowserPool: () => ({}) });
fake("../../browser/tools", {
    createBrowserTools: () => ({
        list: () => [{ name: "browser_wait", description: "x", inputSchema: { type: "object", properties: {} } }],
        has: (name) => name === "browser_wait",
        call: async (name, args, ctx) => {
            seen.push(ctx);
            reachedTool();
            if (args.hang) await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve));
            return { content: [{ type: "text", text: "done" }] };
        },
        forgetTransport: () => {},
    }),
});

const router = require("../../../routes/mcp");

const listen = async (t) => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = { id: 7 };
        req.apiKey = { id: Number(req.header("x-test-key") ?? 3) };
        next();
    });
    app.use("/api/mcp", router);
    const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    return server;
};

const post = (server, body, headers = {}) => {
    const req = http.request({ port: server.address().port, path: "/api/mcp", method: "POST", headers: { "content-type": "application/json", ...headers } });
    const response = new Promise((resolve, reject) => {
        req.on("response", (res) => {
            let text = "";
            res.on("data", (chunk) => { text += chunk; });
            res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null }));
        });
        req.on("error", reject);
    });
    req.end(JSON.stringify(body));
    return { req, response };
};

test("the tool's signal aborts when the client hangs up before the answer, and only then; another key cannot use the transport", { timeout: 2000 }, async (t) => {
    const server = await listen(t);
    const init = await post(server, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }).response;
    const headers = { "mcp-session-id": init.headers["mcp-session-id"] };

    const done = await post(server, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_wait", arguments: {} } }, headers).response;
    assert.strictEqual(done.body.result.content[0].text, "done");
    assert.strictEqual(seen[0].keyId, 3);
    assert.strictEqual(seen[0].signal.aborted, false);

    const foreign = await post(server, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "browser_wait", arguments: {} } }, { ...headers, "x-test-key": "4" }).response;
    assert.strictEqual(foreign.status, 404);
    assert.strictEqual(foreign.body.error.code, -32001);
    assert.strictEqual(seen.length, 1);

    const reached = new Promise((resolve) => { reachedTool = resolve; });
    const hanging = post(server, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "browser_wait", arguments: { hang: true } } }, headers);
    hanging.response.catch(() => {});
    await reached;
    hanging.req.destroy();
    await new Promise((resolve) => seen[1].signal.addEventListener("abort", resolve));
    assert.strictEqual(seen[1].signal.aborted, true);
    assert.strictEqual(seen[0].signal.aborted, false);
});
```

- [ ] **Step 6: Test laufen lassen, Fehlschlag prüfen**

Run: `cd /root/outpost && node --test server/lib/mcp/__tests__/mcpRoute.test.js`
Expected: FAIL — `Cannot find module '../lib/browser/mcpServer'` (die Route zeigt noch auf den alten Pfad).

- [ ] **Step 7: Route auf Anbieter, Aufrufer und Signal umstellen**

`server/routes/mcp.js`, vorher (Z. 1-11):

```js
const { Router } = require("express");
const { hasAccountPermission } = require("../utils/permission");
const { Permission } = require("../permissions/registry");
const { createMcpServer } = require("../lib/browser/mcpServer");
const { createBrowserTools } = require("../lib/browser/tools");
const { getBrowserPool } = require("../lib/browser");

const mcp = createMcpServer({
    tools: createBrowserTools({ getPool: getBrowserPool }),
    canUseBrowser: (accountId) => hasAccountPermission(accountId, Permission.CONNECT_BROWSER),
});
```

nachher:

```js
const { Router } = require("express");
const { hasAccountPermission } = require("../utils/permission");
const { Permission } = require("../permissions/registry");
const { createMcpServer } = require("../lib/mcp/server");
const { createBrowserTools } = require("../lib/browser/tools");
const { getBrowserPool } = require("../lib/browser");
const logger = require("../utils/logger");

const browserTools = createBrowserTools({ getPool: getBrowserPool });
const browserProvider = {
    ...browserTools,
    name: "browser",
    available: (ctx) => hasAccountPermission(ctx.accountId, Permission.CONNECT_BROWSER),
};

const mcp = createMcpServer({ providers: [browserProvider] });

const callerOf = (req) => ({ accountId: req.user.id, keyId: req.apiKey?.id ?? null });
```

Vorher (Z. 33-45):

```js
app.post("/", async (req, res) => {
    try {
        reply(res, await mcp.handle({
            body: req.body,
            transportId: req.header("mcp-session-id"),
            accountId: req.user.id,
            ipAddress: req.ip,
            userAgent: req.header("user-agent") ?? null,
        }));
    } catch (err) {
        res.status(500).json({ jsonrpc: "2.0", id: req.body?.id ?? null, error: { code: -32603, message: err.message } });
    }
});
```

nachher (`writableEnded` unterscheidet den Verbindungsabbruch vom `close`, das Node auch nach jeder fertigen Antwort meldet):

```js
app.post("/", async (req, res) => {
    const controller = new AbortController();
    res.on("close", () => {
        if (!res.writableEnded) controller.abort();
    });
    try {
        reply(res, await mcp.handle({
            body: req.body,
            transportId: req.header("mcp-session-id"),
            ...callerOf(req),
            agent: req.agent ?? null,
            impersonatorId: req.session?.impersonatorId ?? null,
            ipAddress: req.ip,
            userAgent: req.header("user-agent") ?? null,
            signal: controller.signal,
        }));
    } catch (err) {
        logger.error("MCP request failed", { error: err.message, method: req.body?.method });
        res.status(500).json({ jsonrpc: "2.0", id: req.body?.id ?? null, error: { code: -32603, message: "Internal error" } });
    }
});
```

Vorher (Z. 56):

```js
app.delete("/", (req, res) => reply(res, mcp.end({ transportId: req.header("mcp-session-id"), accountId: req.user.id })));
```

nachher:

```js
app.delete("/", (req, res) => reply(res, mcp.end({ transportId: req.header("mcp-session-id"), ...callerOf(req) })));
```

Die JSDoc-Blöcke bleiben unverändert.

- [ ] **Step 8: Tests und Lint laufen lassen**

Run: `cd /root/outpost && node --test server/lib/mcp/__tests__/*.test.js server/lib/browser/__tests__/tools.test.js && yarn lint`
Expected: PASS (7 + 4 Tests), Lint ohne Befund.

Run: `cd /root/outpost && grep -rn "browser/mcpServer" server docs --include=*.js --include=*.md | grep -v docs/superpowers`
Expected: keine Ausgabe.

- [ ] **Step 9: Commit**

```bash
git add server/lib/mcp server/routes/mcp.js
git commit -m "Vault: MCP-Rahmen mit Werkzeug-Anbietern, Transport je Schlüssel und Abbruchsignal"
```

`git mv` hat das Löschen von `server/lib/browser/mcpServer.js` und `server/lib/browser/__tests__/mcpServer.test.js` bereits vorgemerkt.

---

### Task 10: Client-Grundlage — Texte, Rechte-Spiegel, Verfügbarkeit, Navigation, Route, Marker

**Files:**
- Modify: `client/public/assets/locales/en.json` (`common.sidebar` Z. 144–158, Wurzel zwischen `scripts` Z. 447 und `monitoring` Z. 448, `servers.contextMenu` Z. 1663–1706, `settings.pages` Z. 592–611, `settings.account.apiKeys` Ende Z. 749, `settings.browser` Ende Z. 1598)
- Modify: `client/public/assets/locales/de_DE.json` (dieselben Stellen; `servers.contextMenu` dort Z. 1661–1704)
- Modify: `client/src/common/utils/permissions.js` (Z. 16, 32)
- Create: `client/src/common/hooks/useVaultAvailable.js`
- Modify: `client/src/common/hooks/useSidebarNavigation.js` (Import Z. 5, Hook Z. 22–37)
- Modify: `client/src/common/utils/navigationConfig.jsx` (Import Z. 1 und Z. 20, `getSidebarNavigation` Z. 26, `getSettingsAdminPages` Z. 52)
- Modify: `client/src/App.jsx` (Z. 23, Z. 78)
- Create: `client/src/pages/Vault/index.js`, `client/src/pages/Vault/Vault.jsx` (Platzhalter, Task 12 ersetzt `Vault.jsx`)
- Create: `client/src/pages/Settings/pages/Vault/index.js`, `client/src/pages/Settings/pages/Vault/Vault.jsx` (Platzhalter, Task 15 füllt `Vault.jsx`)
- Modify: `client/src/common/hooks/useStateStream.js:6` (`STATE_TYPES`)
- Modify: `client/src/common/components/TabSwitcher/TabSwitcher.jsx:5, 29`, `client/src/common/components/IconInput/IconInput.jsx:5, 16`
- Test: `client/src/common/hooks/__tests__/useSidebarNavigation.test.jsx`

**Interfaces:**
- Consumes: nichts aus anderen Tasks. `GET /api/vault/available` (Task 5) wird erst zur Laufzeit gebraucht; bis dahin antwortet der Server `404`, und der Hook liefert „nicht verfügbar“.
- Produces (von Tasks 12–15 genutzt):
  - `useVaultAvailable()` (Named Export aus `@/common/hooks/useVaultAvailable.js`) `→ { loading: boolean, enabled: boolean, canUse: boolean, canManageOrgs: number[], canProvision: boolean, agentUrlSet: boolean, impersonating: boolean, trustProxyUnsafe: boolean, refresh: () => Promise<void> }`. Eine geteilte Anfrage je Konto (Modul-Cache wie `loadBrowserAvailable`); Fehler oder `404` → alle Felder `false` bzw. `[]`. Scheitert das erste Laden an einem Netzfehler (`fetch` wirft `TypeError`, etwa während eines Server-Neustarts), lädt der Hook nach 30 s genau einmal neu; eine HTTP-Antwort wie `404` oder `403` wird nicht wiederholt. `refresh()` lädt neu und aktualisiert alle eingehängten Hooks desselben Kontos (Listener je Konto im Modul), etwa die Seitenleiste nach dem Speichern in den Vault-Einstellungen.
  - `Permission.VAULT_USE = "vault.use"`, `Permission.VAULT_MANAGE = "vault.manage"`, `Permission.VAULT_REVEAL = "vault.reveal"`, `Permission.SETTINGS_VAULT = "settings.vault"`.
  - `STATE_TYPES.VAULT_APPROVALS = "VAULT_APPROVALS"` (Client; `StateStreamContext` legt den Handler-Satz daraus automatisch an).
  - `TabSwitcher` und `IconInput` nehmen das optionale Prop `dataUiId` und setzen es als `data-ui-id` auf ihr Wurzelelement (`div.tab-switcher` bzw. `div.input-container`); ohne Prop unverändert.
  - Navigation: `{ key: "vault", path: "/vault", icon: IconKeyRound }` zwischen `snippets` und `browser`, gefiltert über `useVaultAvailable().canUse`. Einstellungsseite `{ key: "vault", permission: Permission.SETTINGS_VAULT, content: <VaultSettings /> }` aus `@/pages/Settings/pages/Vault` (Default-Export, Task 15 füllt die Komponente `Vault` in `Vault.jsx`).
  - Route `/vault` unter `Root` mit `lazy(() => import("@/pages/Vault"))`; `client/src/pages/Vault/index.js` exportiert `Vault` aus `./Vault.jsx` als Default (Task 12 ersetzt nur `Vault.jsx`).
  - i18n — die vollständige Schlüsselliste für Tasks 12–15 (Tasks 12–15 benutzen sie nur, sie erweitern sie nicht):
    - `common.sidebar.vault`
    - `vault.page.{title, subtitle, addItem}`, `vault.scope.personal`, `vault.search.{placeholder, empty}`, `vault.types.{all, login, apiKey, ssh, database, other}`, `vault.list.{title, empty, error}`, `vault.detail.{empty, error, fields, secrets, scope, edit, delete, deleteConfirm, deleteFailed}`, `vault.fields.{name, description, username, origin, origins, hosts, header, headerName, headerTemplate, engine, host, port, database}`, `vault.secretFields.{password, token, privateKey, passphrase, value}`, `vault.secret.{show, hide, copy, copied, copyFailed, revealed, agentOnly}`, `vault.bindings.{entry, folder, tag, allServers, empty, emptyDialog, addServer, addFolder, addTag}`, `vault.policy.{required, notRequired, lastUsed}`, `vault.dialog.{title.create, title.edit, type, owner, ownerPersonal, fixed, enterSecret, secretStored, secretCleared, secretMissing, nameTaken, create, save, saving, saveFailed}` (Task 12)
    - `vault.agents.{claude, codex}`, `vault.approval.{title, who, pending, sending, expired, actions.once, actions.session, actions.deny}` (Task 13, 14, 15)
    - `servers.contextMenu.agentAccess`, `servers.agentAccess.title`, `servers.agentAccess.keys.{title, empty, created, lastUsed, boundTo, anywhere, revoke, revokeConfirm, revokeError, revokedForeign, revokedUnknown}`, `servers.agentAccess.setup.{cidrLabel, cidrInvalid, submit, loading, urlMissing, foreignAccount}`, `servers.agentAccess.ipBind.{label, on, off, seenOther, probeFailed, adopt, decline, trustProxy}`, `servers.agentAccess.result.{empty, configured, failed, success, successCodex, error, manual, copy, keyNotice, replaced}` (Task 14; `probeFailed` = Manifest rev 13 `UI-AGENT-ACCESS-IPBIND` `disabled`, `replaced` = `UI-AGENT-ACCESS-RESULT` `partial`, `seenOther` = erweiterte `partial`-Copy von `UI-AGENT-ACCESS-IPBIND`; `keys.revokedForeign` = Manifest rev 14 `UI-AGENT-ACCESS-KEYS` `partial` bei `registration === "foreign"`, `keys.revokedUnknown` = `disabled` bei `registration === "unknown"`, die Befehle aus `commands` mit dem Kopieren-Knopf `servers.agentAccess.result.copy`)
    - `settings.pages.vault`, `settings.vault.{loading, title, description, key.title, key.active, key.missing, key.missingText, key.mismatch, key.mismatchText, agentUrl.title, agentUrl.description, agentUrl.invalid, proxy.warning, saveSettings, saveSuccess, errors.loadSettings, errors.saveSettings}`, `settings.account.agentKeys.{sectionTitle, sectionDescription, edit, revoke, revokeConfirm, revokedForeign, revokedUnknown, lastUsed, boundTo, unbound, anywhere, empty}` (Task 15; `revokedForeign`/`revokedUnknown` = Manifest rev 14 `UI-API-KEYS-AGENTS` `partial`/`disabled`, gleiche Bedingungen wie in Task 14; Kopieren-Knopf ebenfalls `servers.agentAccess.result.copy`)
    - Wiederverwendet, nicht neu: `common.error`, `common.success`, `common.actions.cancel`, `common.actions.back`, `settings.account.apiKeys.neverUsed`, `settings.account.apiKeys.copyError`, `servers.time.*`.
    - Platzhalter: `vault.policy.lastUsed` `{{time}}`, `vault.detail.deleteConfirm` `{{name}}`, `vault.dialog.ownerPersonal` `{{username}}`, `vault.dialog.enterSecret` `{{field}}`, `vault.approval.who` `{{agent}}`/`{{server}}`, `vault.approval.pending` `{{count}}`, `servers.agentAccess.title` `{{name}}`, `…keys.created` `{{date}}`, `…keys.lastUsed` `{{time}}`, `…keys.boundTo` `{{address}}`, `…keys.revokeConfirm` `{{agent}}`/`{{server}}`, `…keys.revokedForeign` `{{server}}`, `…setup.foreignAccount` `{{user}}`/`{{server}}`, `…ipBind.seenOther` `{{seen}}`/`{{expected}}`, `…result.success`/`successCodex` `{{user}}`, `…result.error` `{{cli}}`, `settings.account.agentKeys.revokeConfirm` `{{agent}}`/`{{server}}`, `…revokedForeign` `{{server}}`, `…boundTo` `{{address}}`, `…lastUsed` `{{time}}`. Im Deutschen steht `{{server}}` dort, wo die Manifest-Copy das Beispiel `web01` zeigt.

**Design:**
- Screen: `UI-SHELL` (übernommen, nur ergänzt) — Artboard `docs/design/mockups/ui-shell.html` — Anleitung `docs/design/guides/ui-shell.md`; für Seite und Dialog nur die Grundlage: `docs/design/guides/ui-vault.md` (Abschnitte „Wo im Code“, „i18n“), `ui-vault-dialog.md`, `ui-agent-access.md`, `ui-api-keys.md`, `ui-vault-settings.md`, `ui-vault-approval.md` (je Abschnitt „i18n“), `ui-servers.md` Z. 37–39
- Zu bauende Elemente (Werte wörtlich übernehmen):

| ID | Element | Fachlicher Anker | Zustände | Copy |
|----|---------|------------------|----------|------|
| UI-SHELL-NAV | Bereiche | Die Bereiche der Anwendung — Server, Monitoring, Snippets, Vault, Audit — und dazwischen die Aktion Browser. Ein Eintrag je Bereich, der aktive hervorgehoben; Browser ist kein Bereich, sondern öffnet unter Server einen neuen Browser-Tab und wird deshalb nie hervorgehoben. Browser nur, wenn Browser-Tabs aktiviert sind und das Konto das Recht dazu hat; Vault nur, wenn der Vault eingeschaltet ist und das Konto vault.use hat oder Mitglied einer Organisation ist; Audit nur mit dem Recht dafür. Nicht: server_entry, session. | default, selected | — |
| UI-SHELL-MOBILE-NAV | Bereiche (schmaler Schirm) | Unter 768px ersetzt eine Leiste am unteren Rand die seitliche. Sie zeigt dieselben Einträge mit Beschriftung, Browser auch hier als Aktion ohne hervorgehobenen Zustand; ein Tipp auf den bereits offenen Bereich klappt dort die Serverliste auf. Nicht: server_entry, session. | default, selected | — |

- Locator: jedes Element trägt `data-ui-id="<ID>"`. Beide Marker sitzen bereits an `<nav>` (`Sidebar.jsx:166`, `MobileNav.jsx:20`) und bleiben unverändert; der Vault-Eintrag kommt allein über `getSidebarNavigation`, keine zweite Liste. Neu sind nur die `dataUiId`-Props an `TabSwitcher`/`IconInput`, die Task 12 für `UI-VAULT-SCOPE`, `UI-VAULT-TYPES`, `UI-VAULT-SEARCH` braucht.
- Icon: Lucide `KeyRound` für den Navigationseintrag (`ui-shell.md` Z. 32, `ui-shell.html`); die Einstellungsseite nimmt `Lock`.
- Tokens: keine neuen (Platzhalterseiten ohne Styles).

**Tests:** 1 Test `useSidebarNavigation.test.jsx` über die Naht Hook → `getSidebarNavigation` → `useVaultAvailable` → (gedoubeltes) `RequestUtil`: „Vault“ erscheint nach Snippets genau dann, wenn `vault/available` `canUse: true` liefert (zwei Konten, weil der Modul-Cache je Konto gilt); ein `refresh()` aus einem zweiten, eigenständig eingehängten `useVaultAvailable` desselben Kontos bringt den Eintrag auch in der schon eingehängten Navigation. Der Test läuft mit dem echten `en.json` und deckt damit `common.sidebar.vault` mit ab. Test-first (fester Vertrag aus Spec und Guide). Nicht getestet: Rechte-Konstanten, `STATE_TYPES`-Eintrag, `dataUiId`-Weiterreichung, Route und Platzhalterseiten (reine Verdrahtung), der einmalige Neuversuch nach 30 s (ein Timer um denselben Lader; ein Test bräuchte Fake-Timer und einen gedoubelten `fetch`-Fehler und prüfte nur `setTimeout`). Die übrigen Schlüssel prüft ein Paritätsbefehl (Step 5), kein Test; ihre Nutzung testen Tasks 12–15 mit `src/test/i18n.js`, das bei fehlenden Schlüsseln wirft.
SEC: SEC-RBAC-01 nur als Spiegel — Navigation und Rechte im Client blenden aus, durchgesetzt wird serverseitig (Tasks 1, 5). SEC-XSS-01: alle neuen Texte laufen über `t()` mit `escapeValue`-freier Interpolation nur in React-Textknoten, kein `dangerouslySetInnerHTML`.

**Parallel:** Task 1, 2, 7 (Welle A; keine gemeinsamen Dateien: Task 10 fasst nur `client/` an, die drei anderen nur `server/`). Tasks 12–15 (Welle B und C) setzen diesen Task voraus.

- [ ] **Step 1: Write the failing test**

`client/src/common/hooks/__tests__/useSidebarNavigation.test.jsx`:

```jsx
import { beforeEach, expect, test, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import testI18n from "@/test/i18n.js";
import { UserContext } from "@/common/contexts/UserContext.jsx";
import { useSidebarNavigation } from "../useSidebarNavigation.js";
import { useVaultAvailable } from "../useVaultAvailable.js";

const requestDouble = await vi.hoisted(async () => {
    const { createRequestDouble } = await import("@/test/requestDouble.js");
    return createRequestDouble();
});

vi.mock("@/common/utils/RequestUtil.js", () => requestDouble.asModule());

// navigationConfig.jsx imports every settings page, and the theme editor among them loads
// Monaco, which jsdom cannot run (document.queryCommandSupported).
vi.mock("monaco-editor", () => ({}));
vi.mock("@monaco-editor/react", () => ({ default: () => null, loader: { config: () => {} } }));

const wrapperFor = (accountId) => {
    const user = { id: accountId, isAdmin: false, permissions: [] };
    return ({ children }) => (
        <I18nextProvider i18n={testI18n}>
            <UserContext.Provider value={{ user, hasPermission: () => false }}>{children}</UserContext.Provider>
        </I18nextProvider>
    );
};

const navigationFor = (accountId) => renderHook(() => useSidebarNavigation(), { wrapper: wrapperFor(accountId) });

beforeEach(() => {
    requestDouble.reset();
    requestDouble.stub("getRequest", "browser/available", { enabled: false });
});

test("Vault erscheint nach Snippets nur, wenn vault/available canUse meldet; refresh() erreicht jeden eingehängten Hook des Kontos", async () => {
    requestDouble.stub("getRequest", "vault/available", { enabled: true, canUse: true });
    const allowed = navigationFor(1);
    await waitFor(() => expect(allowed.result.current.map((item) => item.key)).toEqual(["servers", "monitoring", "snippets", "vault"]));
    allowed.unmount();

    requestDouble.stub("getRequest", "vault/available", { enabled: true, canUse: false });
    const denied = navigationFor(2);
    await waitFor(() => expect(requestDouble.calls.filter((call) => call.path === "vault/available")).toHaveLength(2));
    expect(denied.result.current.map((item) => item.key)).toEqual(["servers", "monitoring", "snippets"]);

    requestDouble.stub("getRequest", "vault/available", { enabled: true, canUse: true });
    const settingsPage = renderHook(() => useVaultAvailable(), { wrapper: wrapperFor(2) });
    await act(() => settingsPage.result.current.refresh());
    await waitFor(() => expect(denied.result.current.map((item) => item.key)).toEqual(["servers", "monitoring", "snippets", "vault"]));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn --cwd client vitest run src/common/hooks/__tests__/useSidebarNavigation.test.jsx`
Expected: FAIL — Vitest kann `../useVaultAvailable.js` nicht auflösen (`Failed to resolve import "../useVaultAvailable.js"`); die Datei entsteht erst in Step 7.

- [ ] **Step 3: Texte in `en.json`**

`client/public/assets/locales/en.json`, sieben Einfügestellen (Zeilen vor dem Task; Reihenfolge der Schlüssel wie hier):

1. `common.sidebar` (Z. 144–158), nach `"snippets"`:

```json
      "vault": "Vault",
```

2. Wurzel: zwischen dem Ende von `"scripts"` (Z. 447 `  },`) und `"monitoring": {` (Z. 448):

```json
  "vault": {
    "page": {
      "title": "Vault",
      "subtitle": "Credentials for agents",
      "addItem": "New entry"
    },
    "scope": {
      "personal": "Personal"
    },
    "search": {
      "placeholder": "Search",
      "empty": "No entry matches the search."
    },
    "types": {
      "all": "All",
      "login": "Login",
      "apiKey": "API key",
      "ssh": "SSH",
      "database": "Database",
      "other": "Other"
    },
    "list": {
      "title": "Entries",
      "empty": "No entries yet. Agents use credentials from the vault without seeing the value.",
      "error": "Vault unreachable. Reload the page."
    },
    "detail": {
      "empty": "Select an entry on the left.",
      "error": "Entry unreadable — the vault key does not match this entry.",
      "fields": "Details",
      "secrets": "Secret value",
      "scope": "Applies to",
      "edit": "Edit",
      "delete": "Delete",
      "deleteConfirm": "Delete {{name}}? Agents lose access immediately.",
      "deleteFailed": "Deleting failed."
    },
    "fields": {
      "name": "Name",
      "description": "Description",
      "username": "User",
      "origin": "Origin",
      "origins": "Origins",
      "hosts": "Hosts",
      "header": "Header",
      "headerName": "Header name",
      "headerTemplate": "Header template",
      "engine": "Engine",
      "host": "Host",
      "port": "Port",
      "database": "Database"
    },
    "secretFields": {
      "password": "Password",
      "token": "Token",
      "privateKey": "Private key",
      "passphrase": "Passphrase",
      "value": "Value"
    },
    "secret": {
      "show": "Show",
      "hide": "Hide",
      "copy": "Copy",
      "copied": "Copied",
      "copyFailed": "Copying failed.",
      "revealed": "shown, hides in 30 s",
      "agentOnly": "usable by agents only"
    },
    "bindings": {
      "entry": "Server",
      "folder": "Folder",
      "tag": "Tag",
      "allServers": "All servers",
      "empty": "Not enabled for any server — no agent sees this entry.",
      "emptyDialog": "Not enabled for any server.",
      "addServer": "+ Server",
      "addFolder": "+ Folder",
      "addTag": "+ Tag"
    },
    "policy": {
      "required": "Approval required",
      "notRequired": "Usable without approval",
      "lastUsed": "last used {{time}}"
    },
    "dialog": {
      "title": {
        "create": "Create entry",
        "edit": "Edit entry"
      },
      "type": "Type",
      "owner": "Owner",
      "ownerPersonal": "Personal ({{username}})",
      "fixed": "fixed after creation",
      "enterSecret": "Enter {{field}}",
      "secretStored": "stored — leave empty to keep",
      "secretCleared": "Target changed — stored values will be discarded. Enter them again.",
      "secretMissing": "Value missing.",
      "nameTaken": "Name already taken.",
      "create": "Create",
      "save": "Save",
      "saving": "Saving …",
      "saveFailed": "Saving failed."
    },
    "agents": {
      "claude": "Claude Code",
      "codex": "Codex"
    },
    "approval": {
      "title": "Approval requested",
      "who": "{{agent}} on {{server}}",
      "pending": "{{count}} requests open",
      "sending": "Sending answer …",
      "expired": "Request has expired.",
      "actions": {
        "once": "Once",
        "session": "For this session",
        "deny": "Deny"
      }
    }
  },
```

3. `servers.contextMenu`, direkt nach `"duplicateServer"` (Z. 1693):

```json
      "agentAccess": "Agent access…",
```

   und hinter dem schließenden `},` von `servers.contextMenu` (Z. 1706), vor `"passwordHint": {`:

```json
    "agentAccess": {
      "title": "Agent access — {{name}}",
      "keys": {
        "title": "Agents on this server",
        "empty": "No agent set up on this server yet.",
        "created": "created {{date}}",
        "lastUsed": "last used {{time}}",
        "boundTo": "only {{address}}",
        "anywhere": "from anywhere",
        "revoke": "Revoke",
        "revokeConfirm": "Revoke access of {{agent}} on {{server}}? The agent loses access immediately.",
        "revokeError": "Revoking failed.",
        "revokedForeign": "Access revoked. The registration on {{server}} carries another account's key and stays in place.",
        "revokedUnknown": "Access revoked. The registration could not be removed — copy the command and run it on the server."
      },
      "setup": {
        "cidrLabel": "Additional address ranges",
        "cidrInvalid": "Invalid address range.",
        "submit": "Set up",
        "loading": "Setting up …",
        "urlMissing": "Outpost address for agents is missing — set it in Settings › Vault.",
        "foreignAccount": "Another account has already set up agent access for {{user}} on {{server}} — the registration will be replaced."
      },
      "ipBind": {
        "label": "Only from this server's IP",
        "on": "on",
        "off": "off — from anywhere",
        "seenOther": "Seen {{seen}} instead of {{expected}} — adopt as address range? Without adopting it, Outpost refuses the key.",
        "probeFailed": "The address could not be measured — the key applies to the server's resolved address.",
        "adopt": "Adopt",
        "decline": "No",
        "trustProxy": "TRUST_PROXY=true — IP binding has no effect."
      },
      "result": {
        "empty": "appears after setup",
        "configured": "set up",
        "failed": "failed",
        "success": "Set up for {{user}}. Restart Claude Code, then /mcp.",
        "successCodex": "Set up for {{user}}. Start Codex in a new shell; running Codex processes and tmux sessions do not know the key.",
        "error": "{{cli}} not found. Copy the command and run it on the server.",
        "manual": "Copy the command and run it on the server.",
        "copy": "Copy",
        "keyNotice": "The key is visible only now. Closing without adopting it deletes it.",
        "replaced": "Existing registration replaced — the old account key stays valid until you delete it under API Keys."
      }
    },
```

4. `settings.pages` (Z. 592–611): `"browser": "Browser"` (Z. 610) bekommt ein Komma, danach als letzter Schlüssel:

```json
      "vault": "Vault"
```

   `settings.account`: hinter dem schließenden `},` von `"apiKeys"` (Z. 749), vor `"microsoft": {`:

```json
      "agentKeys": {
        "sectionTitle": "Agent keys",
        "sectionDescription": "Agent keys only reach the MCP endpoint.",
        "edit": "Edit",
        "revoke": "Revoke",
        "revokeConfirm": "Revoke access of {{agent}} on {{server}}? The agent loses access immediately.",
        "revokedForeign": "Access revoked. The registration on {{server}} carries another account's key and stays in place.",
        "revokedUnknown": "Access revoked. The registration could not be removed — copy the command and run it on the server.",
        "lastUsed": "last used {{time}}",
        "boundTo": "only {{address}}",
        "unbound": "Binding removed",
        "anywhere": "from anywhere",
        "empty": "No agent access yet. Set it up from a server's context menu."
      },
```

5. `settings.browser` endet mit `    }` (Z. 1598) als letzter Block in `settings`; daraus wird `    },` und danach als letzter Schlüssel:

```json
    "vault": {
      "loading": "Loading vault settings...",
      "title": "Vault",
      "description": "System settings of the vault.",
      "key": {
        "title": "Vault key",
        "active": "Active",
        "missing": "Missing",
        "missingText": "VAULT_KEY is missing — the vault is off. Set the key as an environment variable or as the Docker secret vault_key.",
        "mismatch": "Mismatch",
        "mismatchText": "VAULT_KEY does not match the stored entries — the vault is off."
      },
      "agentUrl": {
        "title": "Outpost address for agents",
        "description": "Your servers reach Outpost at this address; the MCP URL for agents is built from it.",
        "invalid": "Not a valid http or https address."
      },
      "proxy": {
        "warning": "TRUST_PROXY=true — Outpost trusts every X-Forwarded-For, so IP binding of agent keys has no effect. Set a hop count or an address list."
      },
      "saveSettings": "Save settings",
      "saveSuccess": "Vault settings saved",
      "errors": {
        "loadSettings": "Could not load the vault settings",
        "saveSettings": "Could not save the vault settings"
      }
    }
```

- [ ] **Step 4: Texte in `de_DE.json`** (deutsche Werte = Manifest-Copy bzw. Artboard-Beschriftung wörtlich)

`client/public/assets/locales/de_DE.json`, sieben Einfügestellen (Zeilen vor dem Task; Reihenfolge der Schlüssel wie hier):

1. `common.sidebar` (Z. 144–158), nach `"snippets"`:

```json
      "vault": "Vault",
```

2. Wurzel: zwischen dem Ende von `"scripts"` (Z. 447 `  },`) und `"monitoring": {` (Z. 448):

```json
  "vault": {
    "page": {
      "title": "Vault",
      "subtitle": "Zugangsdaten für Agenten",
      "addItem": "Neuer Eintrag"
    },
    "scope": {
      "personal": "Persönlich"
    },
    "search": {
      "placeholder": "Suchen",
      "empty": "Kein Eintrag passt zur Suche."
    },
    "types": {
      "all": "Alle",
      "login": "Login",
      "apiKey": "API-Key",
      "ssh": "SSH",
      "database": "Datenbank",
      "other": "Sonstiges"
    },
    "list": {
      "title": "Einträge",
      "empty": "Noch keine Einträge. Zugangsdaten im Vault nutzen Agenten, ohne den Wert zu sehen.",
      "error": "Vault nicht erreichbar. Seite neu laden."
    },
    "detail": {
      "empty": "Eintrag links wählen.",
      "error": "Eintrag nicht lesbar — der Vault-Schlüssel passt nicht zu diesem Eintrag.",
      "fields": "Angaben",
      "secrets": "Geheimer Wert",
      "scope": "Gilt für",
      "edit": "Bearbeiten",
      "delete": "Löschen",
      "deleteConfirm": "{{name}} löschen? Agenten verlieren den Zugriff sofort.",
      "deleteFailed": "Löschen fehlgeschlagen."
    },
    "fields": {
      "name": "Name",
      "description": "Beschreibung",
      "username": "Benutzer",
      "origin": "Ursprung",
      "origins": "Ursprünge",
      "hosts": "Hosts",
      "header": "Header",
      "headerName": "Header-Name",
      "headerTemplate": "Header-Vorlage",
      "engine": "Engine",
      "host": "Host",
      "port": "Port",
      "database": "Datenbank"
    },
    "secretFields": {
      "password": "Passwort",
      "token": "Token",
      "privateKey": "Privater Schlüssel",
      "passphrase": "Passphrase",
      "value": "Wert"
    },
    "secret": {
      "show": "Anzeigen",
      "hide": "Verbergen",
      "copy": "Kopieren",
      "copied": "Kopiert",
      "copyFailed": "Kopieren fehlgeschlagen.",
      "revealed": "angezeigt, verbirgt sich in 30 s",
      "agentOnly": "nur für Agenten nutzbar"
    },
    "bindings": {
      "entry": "Server",
      "folder": "Ordner",
      "tag": "Tag",
      "allServers": "Alle Server",
      "empty": "Für keinen Server freigegeben — kein Agent sieht diesen Eintrag.",
      "emptyDialog": "Für keinen Server freigegeben.",
      "addServer": "+ Server",
      "addFolder": "+ Ordner",
      "addTag": "+ Tag"
    },
    "policy": {
      "required": "Freigabe erforderlich",
      "notRequired": "Ohne Freigabe nutzbar",
      "lastUsed": "zuletzt genutzt {{time}}"
    },
    "dialog": {
      "title": {
        "create": "Eintrag anlegen",
        "edit": "Eintrag bearbeiten"
      },
      "type": "Typ",
      "owner": "Besitzer",
      "ownerPersonal": "Persönlich ({{username}})",
      "fixed": "nach dem Anlegen fest",
      "enterSecret": "{{field}} eingeben",
      "secretStored": "gespeichert — leer lassen, um beizubehalten",
      "secretCleared": "Ziel geändert — gespeicherte Werte werden verworfen. Neu eingeben.",
      "secretMissing": "Wert fehlt.",
      "nameTaken": "Name schon vergeben.",
      "create": "Erstellen",
      "save": "Speichern",
      "saving": "Speichere …",
      "saveFailed": "Speichern fehlgeschlagen."
    },
    "agents": {
      "claude": "Claude Code",
      "codex": "Codex"
    },
    "approval": {
      "title": "Freigabe angefordert",
      "who": "{{agent}} auf {{server}}",
      "pending": "{{count}} Anfragen offen",
      "sending": "Antwort wird gesendet …",
      "expired": "Anfrage ist abgelaufen.",
      "actions": {
        "once": "Einmal",
        "session": "Für diese Sitzung",
        "deny": "Ablehnen"
      }
    }
  },
```

3. `servers.contextMenu`, direkt nach `"duplicateServer"` (Z. 1691):

```json
      "agentAccess": "Agenten-Zugang…",
```

   und hinter dem schließenden `},` von `servers.contextMenu` (Z. 1704), vor `"passwordHint": {`:

```json
    "agentAccess": {
      "title": "Agenten-Zugang — {{name}}",
      "keys": {
        "title": "Agenten auf diesem Server",
        "empty": "Noch kein Agent auf diesem Server eingerichtet.",
        "created": "angelegt {{date}}",
        "lastUsed": "zuletzt {{time}}",
        "boundTo": "nur {{address}}",
        "anywhere": "von überall",
        "revoke": "Entziehen",
        "revokeConfirm": "Zugang von {{agent}} auf {{server}} entziehen? Der Agent verliert sofort den Zugriff.",
        "revokeError": "Entziehen fehlgeschlagen.",
        "revokedForeign": "Zugang entzogen. Die Registrierung auf {{server}} trägt den Key eines anderen Kontos und bleibt stehen.",
        "revokedUnknown": "Zugang entzogen. Die Registrierung konnte nicht entfernt werden — Befehl kopieren und auf dem Server ausführen."
      },
      "setup": {
        "cidrLabel": "Zusätzliche Adressbereiche",
        "cidrInvalid": "Ungültiger Adressbereich.",
        "submit": "Einrichten",
        "loading": "Richte ein …",
        "urlMissing": "Outpost-Adresse für Agenten fehlt — in Einstellungen › Vault setzen.",
        "foreignAccount": "Für {{user}} auf {{server}} hat bereits ein anderes Konto Agenten-Zugang eingerichtet — die Registrierung wird ersetzt."
      },
      "ipBind": {
        "label": "Nur von der IP dieses Servers",
        "on": "an",
        "off": "aus — von überall",
        "seenOther": "Gesehen wurde {{seen}} statt {{expected}} — als Adressbereich übernehmen? Ohne Übernahme weist Outpost den Key ab.",
        "probeFailed": "Adresse konnte nicht gemessen werden — der Key gilt für die aufgelöste Adresse des Servers.",
        "adopt": "Übernehmen",
        "decline": "Nein",
        "trustProxy": "TRUST_PROXY=true — die IP-Bindung ist wirkungslos."
      },
      "result": {
        "empty": "erscheint erst nach dem Einrichten",
        "configured": "eingerichtet",
        "failed": "gescheitert",
        "success": "Eingerichtet für {{user}}. Claude Code neu starten, dann /mcp.",
        "successCodex": "Eingerichtet für {{user}}. Codex in einer neuen Shell starten; laufende Codex-Prozesse und tmux-Sitzungen kennen den Key nicht.",
        "error": "{{cli}} nicht gefunden. Befehl kopieren und auf dem Server ausführen.",
        "manual": "Befehl kopieren und auf dem Server ausführen.",
        "copy": "Kopieren",
        "keyNotice": "Der Key ist nur jetzt sichtbar. Schließen ohne Übernahme löscht ihn.",
        "replaced": "Bestehende Registrierung ersetzt — der alte Konto-Key bleibt gültig, bis du ihn unter API-Schlüssel löschst."
      }
    },
```

4. `settings.pages` (Z. 592–611): `"browser": "Browser"` (Z. 610) bekommt ein Komma, danach als letzter Schlüssel:

```json
      "vault": "Vault"
```

   `settings.account`: hinter dem schließenden `},` von `"apiKeys"` (Z. 749), vor `"microsoft": {`:

```json
      "agentKeys": {
        "sectionTitle": "Agenten-Schlüssel",
        "sectionDescription": "Agenten-Schlüssel erreichen nur den MCP-Endpunkt.",
        "edit": "Bearbeiten",
        "revoke": "Entziehen",
        "revokeConfirm": "Zugang von {{agent}} auf {{server}} entziehen? Der Agent verliert sofort den Zugriff.",
        "revokedForeign": "Zugang entzogen. Die Registrierung auf {{server}} trägt den Key eines anderen Kontos und bleibt stehen.",
        "revokedUnknown": "Zugang entzogen. Die Registrierung konnte nicht entfernt werden — Befehl kopieren und auf dem Server ausführen.",
        "lastUsed": "zuletzt {{time}}",
        "boundTo": "nur {{address}}",
        "unbound": "Bindung gelöst",
        "anywhere": "von überall",
        "empty": "Noch kein Agenten-Zugang. Einrichten über das Kontextmenü eines Servers."
      },
```

5. `settings.browser` endet mit `    }` (Z. 1598) als letzter Block in `settings`; daraus wird `    },` und danach als letzter Schlüssel:

```json
    "vault": {
      "loading": "Vault-Einstellungen werden geladen...",
      "title": "Vault",
      "description": "Systemeinstellungen des Vaults.",
      "key": {
        "title": "Vault-Schlüssel",
        "active": "Aktiv",
        "missing": "Fehlt",
        "missingText": "VAULT_KEY fehlt — der Vault ist aus. Schlüssel als Umgebungsvariable oder Docker-Secret vault_key setzen.",
        "mismatch": "Passt nicht",
        "mismatchText": "VAULT_KEY passt nicht zu den gespeicherten Einträgen — der Vault ist aus."
      },
      "agentUrl": {
        "title": "Outpost-Adresse für Agenten",
        "description": "Unter dieser Adresse erreichen deine Server Outpost; daraus entsteht die MCP-URL für Agenten.",
        "invalid": "Keine gültige http- oder https-Adresse."
      },
      "proxy": {
        "warning": "TRUST_PROXY=true — Outpost glaubt jedem X-Forwarded-For, die IP-Bindung von Agenten-Keys ist wirkungslos. Hop-Zahl oder Adressliste setzen."
      },
      "saveSettings": "Einstellungen speichern",
      "saveSuccess": "Vault-Einstellungen gespeichert",
      "errors": {
        "loadSettings": "Vault-Einstellungen konnten nicht geladen werden",
        "saveSettings": "Vault-Einstellungen konnten nicht gespeichert werden"
      }
    }
```

- [ ] **Step 5: Parität und Gültigkeit der Texte prüfen**

Run:

```bash
cd /root/outpost/client && node -e '
const flat = (o, p = "") => Object.entries(o).flatMap(([k, v]) => typeof v === "object" ? flat(v, p + k + ".") : [p + k]);
const pick = (f) => flat(require(`./public/assets/locales/${f}`)).filter((k) => /^(vault\.|servers\.agentAccess\.|servers\.contextMenu\.agentAccess$|settings\.vault\.|settings\.pages\.vault$|settings\.account\.agentKeys\.|common\.sidebar\.vault$)/.test(k));
const en = pick("en.json"), de = pick("de_DE.json");
console.log(en.length, de.length, en.filter((k) => !de.includes(k)), de.filter((k) => !en.includes(k)));'
```

Expected: `154 154 [] []`

- [ ] **Step 6: Rechte-Spiegel** — `client/src/common/utils/permissions.js`

Vorher (Z. 16):

```js
    SETTINGS_BROWSER: "settings.browser",
```

Nachher:

```js
    SETTINGS_BROWSER: "settings.browser",
    SETTINGS_VAULT: "settings.vault",
```

Vorher (Z. 32):

```js
    SCRIPTS_EXECUTE: "scripts.execute",
```

Nachher:

```js
    SCRIPTS_EXECUTE: "scripts.execute",
    VAULT_USE: "vault.use",
    VAULT_MANAGE: "vault.manage",
    VAULT_REVEAL: "vault.reveal",
```

- [ ] **Step 7: `useVaultAvailable`** — `client/src/common/hooks/useVaultAvailable.js` (neu)

```js
import { useCallback, useContext, useEffect, useState } from "react";
import { UserContext } from "@/common/contexts/UserContext.jsx";
import { getRequest } from "@/common/utils/RequestUtil.js";

const UNAVAILABLE = Object.freeze({
    enabled: false, canUse: false, canManageOrgs: [], canProvision: false,
    agentUrlSet: false, impersonating: false, trustProxyUnsafe: false,
});

const RETRY_MS = 30_000;

// Sidebar, mobile bar, quick action, the vault page and the server menu all mount this hook;
// they share one request per account, like loadBrowserAvailable.
let availability = { accountId: undefined, request: null };
const listeners = new Map();
const loadVaultAvailable = (accountId, force = false) => {
    if (force || availability.accountId !== accountId || !availability.request) {
        const request = getRequest("vault/available").then((answer) => ({ answer: { ...UNAVAILABLE, ...answer }, offline: false }), (error) => {
            console.debug("vault/available failed:", error);
            if (availability.request === request) availability = { accountId: undefined, request: null };
            return { answer: UNAVAILABLE, offline: error instanceof TypeError };
        });
        availability = { accountId, request };
    }
    return availability.request;
};

export const useVaultAvailable = () => {
    const { user } = useContext(UserContext);
    const accountId = user?.id;
    const [state, setState] = useState({ loading: true, ...UNAVAILABLE });

    useEffect(() => {
        if (!accountId) return;
        let active = true;
        let retry;
        const apply = (answer) => { if (active) setState({ loading: false, ...answer }); };
        if (!listeners.has(accountId)) listeners.set(accountId, new Set());
        const accountListeners = listeners.get(accountId);
        accountListeners.add(apply);
        loadVaultAvailable(accountId).then((result) => {
            apply(result.answer);
            if (active && result.offline) retry = setTimeout(() => loadVaultAvailable(accountId).then(({ answer }) => apply(answer)), RETRY_MS);
        });
        return () => {
            active = false;
            clearTimeout(retry);
            accountListeners.delete(apply);
            if (!accountListeners.size) listeners.delete(accountId);
        };
    }, [accountId]);

    const refresh = useCallback(async () => {
        if (!accountId) return;
        const { answer } = await loadVaultAvailable(accountId, true);
        for (const listener of listeners.get(accountId) ?? []) listener(answer);
    }, [accountId]);

    return { ...state, refresh };
};
```

- [ ] **Step 8: Navigation filtern** — `client/src/common/hooks/useSidebarNavigation.js`

Nach Z. 5 (`import { getRequest } …`) einfügen:

```js
import { useVaultAvailable } from "@/common/hooks/useVaultAvailable.js";
```

Vorher (Z. 25):

```js
    const [browserAvailable, setBrowserAvailable] = useState(false);
```

Nachher:

```js
    const [browserAvailable, setBrowserAvailable] = useState(false);
    const { canUse: vaultCanUse } = useVaultAvailable();
```

Vorher (Z. 35–36):

```js
    return useMemo(() => getSidebarNavigation(t).filter(item => (!item.permission || hasPermission(item.permission))
        && (item.key !== "browser" || browserAvailable)), [t, hasPermission, browserAvailable]);
```

Nachher:

```js
    return useMemo(() => getSidebarNavigation(t).filter(item => (!item.permission || hasPermission(item.permission))
        && (item.key !== "browser" || browserAvailable)
        && (item.key !== "vault" || vaultCanUse)), [t, hasPermission, browserAvailable, vaultCanUse]);
```

- [ ] **Step 9: Navigationseintrag und Einstellungsseite** — `client/src/common/utils/navigationConfig.jsx`

Z. 1: am Ende der Lucide-Importliste `Globe as IconGlobe` → `Globe as IconGlobe, Lock as IconLock` (`KeyRound as IconKeyRound` ist schon importiert).

Nach Z. 20 (`import Permissions from "@/pages/Settings/pages/Permissions";`):

```jsx
import VaultSettings from "@/pages/Settings/pages/Vault";
```

Nach Z. 26 (Eintrag `snippets`) in `getSidebarNavigation`:

```jsx
    { title: t('common.sidebar.vault'), key: "vault", path: "/vault", icon: IconKeyRound },
```

Nach Z. 52 (Eintrag `browser`) in `getSettingsAdminPages`:

```jsx
    { title: t("settings.pages.vault"), key: "vault", icon: IconLock, permission: Permission.SETTINGS_VAULT, content: <VaultSettings /> },
```

`client/src/pages/Settings/pages/Vault/index.js` (neu):

```js
export { Vault as default } from "./Vault.jsx";
```

`client/src/pages/Settings/pages/Vault/Vault.jsx` (neu, Platzhalter bis Task 15):

```jsx
export const Vault = () => <div className="vault-settings" />;
```

- [ ] **Step 10: Route `/vault`** — `client/src/App.jsx`

Nach Z. 23 (`const Snippets = lazy(…)`):

```jsx
const Vault = lazy(() => import("@/pages/Vault"));
```

Vorher (Z. 78):

```jsx
                { path: "/snippets", element: <Snippets /> }
```

Nachher:

```jsx
                { path: "/snippets", element: <Snippets /> },
                { path: "/vault", element: <Vault /> }
```

`client/src/pages/Vault/index.js` (neu):

```js
export { Vault as default } from "./Vault.jsx";
```

`client/src/pages/Vault/Vault.jsx` (neu, Platzhalter bis Task 12):

```jsx
export const Vault = () => <div className="vault-page" />;
```

- [ ] **Step 11: Zustandstyp** — `client/src/common/hooks/useStateStream.js:6`

Vorher:

```js
export const STATE_TYPES = { ENTRIES: "ENTRIES", IDENTITIES: "IDENTITIES", SNIPPETS: "SNIPPETS", CONNECTIONS: "CONNECTIONS", LIVE_SESSIONS: "LIVE_SESSIONS", SESSION_PRESENCE: "SESSION_PRESENCE", BROWSER_SESSIONS: "BROWSER_SESSIONS", LOGOUT: "LOGOUT" };
```

Nachher:

```js
export const STATE_TYPES = { ENTRIES: "ENTRIES", IDENTITIES: "IDENTITIES", SNIPPETS: "SNIPPETS", CONNECTIONS: "CONNECTIONS", LIVE_SESSIONS: "LIVE_SESSIONS", SESSION_PRESENCE: "SESSION_PRESENCE", BROWSER_SESSIONS: "BROWSER_SESSIONS", VAULT_APPROVALS: "VAULT_APPROVALS", LOGOUT: "LOGOUT" };
```

- [ ] **Step 12: `dataUiId` an `TabSwitcher` und `IconInput`**

`client/src/common/components/TabSwitcher/TabSwitcher.jsx`, Z. 5:

```jsx
export const TabSwitcher = ({ tabs, activeTab, onTabChange, variant = "default", iconOnly = false, dataUiId }) => {
```

Z. 29:

```jsx
        <div className={`tab-switcher tab-switcher-${variant}${iconOnly ? ' tab-switcher-icon-only' : ''}`} data-ui-id={dataUiId}>
```

`client/src/common/components/IconInput/IconInput.jsx`, Z. 4–5:

```jsx
export const IconInput = ({ type, id, name, required, icon, placeholder, customClass,
                              autoComplete, value, setValue, onChange, onBlur, onKeyDown, autoFocus, disabled, dataUiId }) => {
```

Z. 16:

```jsx
        <div className="input-container" data-ui-id={dataUiId}>
```

- [ ] **Step 13: Run test to verify it passes**

Run: `yarn --cwd client vitest run src/common/hooks/__tests__/useSidebarNavigation.test.jsx`
Expected: PASS (1 test).

Betroffene Bestandstests (`IconInput`/`TabSwitcher` stecken in diesen Dialogen und Seiten):

Run: `yarn --cwd client vitest run src/pages/Snippets src/pages/Servers/components/ServerDialog src/pages/Settings/pages/Identities src/common/hooks`
Expected: PASS.

Run: `yarn --cwd client eslint src/common src/pages/Vault src/pages/Settings/pages/Vault src/App.jsx`
Expected: keine Fehler (die vorhandene Warnung `react-hooks/set-state-in-effect` in `App.jsx:42` bleibt).

- [ ] **Step 14: Commit**

```bash
git add client/public/assets/locales/en.json client/public/assets/locales/de_DE.json \
  client/src/common/utils/permissions.js client/src/common/hooks/useVaultAvailable.js \
  client/src/common/hooks/useSidebarNavigation.js client/src/common/utils/navigationConfig.jsx client/src/App.jsx \
  client/src/pages/Vault/index.js client/src/pages/Vault/Vault.jsx \
  client/src/pages/Settings/pages/Vault/index.js client/src/pages/Settings/pages/Vault/Vault.jsx \
  client/src/common/hooks/useStateStream.js client/src/common/components/TabSwitcher/TabSwitcher.jsx \
  client/src/common/components/IconInput/IconInput.jsx client/src/common/hooks/__tests__/useSidebarNavigation.test.jsx
git commit -m "Vault: Client-Grundlage mit Texten, Rechten, Navigation und Route"
```

---

### Task 7: Browser I: Sitzungsbesitz für Agenten-Keys

**Files:**
- Modify: `server/lib/browser/BrowserSession.js` (Konstruktor Z. 45-48: Felder `keyId`, `contextKey`)
- Modify: `server/lib/browser/BrowserPool.js` (`getOwned` Z. 31-34, `listForAccount` Z. 36-40, neu `listForCaller` und `onContextEnded`; `open` Z. 63-131; `#attach` Z. 174-189; `#register` Z. 191-204; `#onClosed` Z. 206-217; `#adoptPopup` Z. 303-332)
- Modify: `server/lib/browser/tools.js` (neu `callerOf` vor Z. 82; `resolveSession` Z. 89-121 mit Aufrufer-Regeln; `browser_open` Z. 162-167; `browser_list` Z. 229-232; Rückgabeobjekt Z. 235-246)
- Modify: `server/lib/browser/errors.js` (Z. 14: neuer Code `VIA_NOT_ALLOWED`)
- Modify: `server/lib/browser/proxy.js` (`createEngineVia`, Rückgabe Z. 202-207: zusätzlich `entryId`)
- Modify: `server/lib/browser/__tests__/tools.test.js` (Fake-Pool Z. 41: `listForCaller` statt `listForAccount`)
- Create: `server/lib/browser/__tests__/agentScope.test.js`

**Interfaces:**
- Consumes:
  - Task 2: `ctx = { accountId, agent, keyId, impersonatorId, transportId, ipAddress, userAgent, signal }` an `provider.call(name, args, ctx)`; der Browser-Anbieter reicht `ctx` unverändert an `createBrowserTools().call`.
  - Task 4: nur die Form `ctx.agent = { keyId, entryId, agentType }` (`null` bei Login-Session und Konto-Key); gesetzt wird sie aus `req.agent` (Task 4) über Task 2. Dieser Task braucht Task 4 nicht fertig, der Test baut `ctx` selbst.
- Produces (von Task 9 und Task 11 genutzt):
  - `new BrowserSession({ …, keyId = null, contextKey = null })`; `session.keyId: number|null` (Id des API-Keys, der die Sitzung geöffnet hat; Popups erben sie), `session.contextKey: string` (`browserContextId` bei eigener ephemerer Sitzung, sonst `instanceKey`, also `account-<accountId>` bzw. `via-<uuid>`; Popups erben ihn).
  - `pool.open({ accountId, url, profile = "ephemeral", via = null, origin = "agent", keyId = null, allowVia = null }) → { session, navigationError }`. `allowVia: ((entryId: number) => boolean) | null` wird mit der aufgelösten Eintrags-ID des `via`-Ziels aufgerufen; `false` → `BrowserError(VIA_NOT_ALLOWED)`, bevor eine Instanz startet. `LIMIT_REACHED` nennt in `details.sessions` nur die Sitzungen von (`accountId`, `keyId`).
  - `pool.getOwned(accountId, sessionId, { keyId = null } = {}) → BrowserSession|null` — mit `keyId` nur Sitzungen dieses Keys (auch Popups), ohne `keyId` Bestand.
  - `pool.listForCaller({ accountId, keyId = null }) → summary[]`; `pool.listForAccount(accountId)` bleibt (= `listForCaller({ accountId })`, genutzt von `StateBroadcaster`).
  - `pool.onContextEnded(listener: (contextKey: string) => void) → () => void` (Abmelden). Feuert, wenn die Sitzung schließt, die ihren ephemeren Kontext angelegt hat (vorher schließt der Pool die Popups dieses Kontexts mit Grund `"opener closed"`), bzw. wenn die letzte Sitzung eines `persistent`- oder `via`-Kontexts schließt. Auch bei Absturz der Instanz.
  - Pool-Record `{ session, instanceKey, ownsContext, browserContextId, contextKey }`.
  - `createEngineVia(…) → { label, entryId, organizationId, resolverRule, close }` (neu `entryId`).
  - `BrowserErrorCode.VIA_NOT_ALLOWED = "VIA_NOT_ALLOWED"`.
  - `createBrowserTools(…)` liefert zusätzlich `resolveSession(ctx, sessionId) → BrowserSession` (Agenten-Regeln eingeschlossen; wirft `BrowserError` `UNKNOWN_SESSION` / `SESSION_CLOSED` / `NO_SESSION` / `AMBIGUOUS_SESSION`, `details.sessions` nur eigene Sitzungen des Aufrufers). Aufrufer mit `ctx.agent` sehen nur Sitzungen mit `session.keyId === ctx.agent.keyId`; sonst wie bisher alle des Kontos. Dieselbe Funktion nutzt `act` (Task 9); Task 11 ruft `getBrowserTools().resolveSession(ctx, sessionId)`. Kein weiterer Export aus `tools.js`, `module.exports` bleibt.
  - `tools.js`: modulweiter Helfer `callerOf(ctx) → { accountId, keyId }` (`keyId` nur bei `ctx.agent`, sonst `null`; Task 9 nutzt ihn in `browser_list`).
  - `browser_open` setzt `keyId: ctx.keyId ?? null` (jede Sitzung trägt den Key, der sie geöffnet hat; eingeschränkt wird nur bei `ctx.agent`). Mit `ctx.agent` und `profile: "persistent"` wirft es vor dem Pool `BrowserError(BrowserErrorCode.INVALID_PROFILE, "Agent keys can only open ephemeral sessions; call browser_open without profile=persistent.")`.

**Design:** kein UI-Anteil.

**Tests:** 2 Tests in `agentScope.test.js`, test-first (Vertrag steht in der Spec, Spec-Test 10 ohne den `browser_fill_credential`-Teil, den Task 11 prüft). Über die Naht `createBrowserTools` + echter `BrowserPool` mit `helpers/fakeCdp.js`, keine Pool-Fakes: (1) Agenten-Key sieht in `browser_list` nur eigene Sitzungen samt Popup, fremde `sessionId` (Nutzer, anderer Key) antwortet Wort für Wort wie eine unbekannte, ohne `sessionId` wird keine Nutzersitzung genommen, die Liste im `LIMIT_REACHED`-Fehler nennt nur eigene Sitzungen; Login-Session und Konto-Key sehen weiter alle. (2) `profile: "persistent"` und `via` zu einem fremden Server werden für einen Agenten-Key abgelehnt, bevor eine Instanz startet; `via` zum eigenen Server geht. Nicht getestet: `resolveSession` im Rückgabeobjekt einzeln (dieselbe Funktion, die Test 1 über `tools.call` prüft), `entryId` in `createEngineVia` (Weiterreichung), `onContextEnded` (über die Naht in Task 9, Test „Kontextende“). Bestehende Browser-Tests laufen unverändert mit (`tools.test.js` nur Fake-Anpassung). SEC-IDOR-01 (fremde Sitzung wie unbekannt), SEC-TENANT-01 (Agenten-Keys auf eigene Sitzungen, eigenen Server und ephemere Profile beschränkt).

**Parallel:** Task 1, Task 2, Task 10 (Welle A; keine gemeinsamen Dateien — Task 2 verschiebt nur `server/lib/browser/mcpServer.js` samt Test, dieser Task fasst beide nicht an; von Task 2 und Task 4 braucht er nur die Form von `ctx`, der Test baut `ctx` selbst).

- [ ] **Step 1: Write the failing test**

`server/lib/browser/__tests__/agentScope.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const { BrowserPool } = require("../BrowserPool");
const { createBrowserTools } = require("../tools");
const { createFakeCdp, flush } = require("./helpers/fakeCdp");

const ENTRIES = { nas: 7, web: 8 };

const setup = ({ maxSessions = 10 } = {}) => {
    let targets = 0;
    let contexts = 0;
    const instances = [];
    const launcher = {
        started: [],
        async start({ key }) {
            launcher.started.push(key);
            return { key, port: 9222 + launcher.started.length };
        },
        async stop() {},
        async endpoint(port) { return `ws://10.0.0.7:${port}/devtools/browser/x`; },
    };
    const connectCdp = async () => {
        const cdp = createFakeCdp({
            "Target.createBrowserContext": () => ({ browserContextId: `ctx-${++contexts}` }),
            "Target.createTarget": () => ({ targetId: `T${++targets}` }),
            "Target.attachToTarget": ({ targetId }) => ({ sessionId: `S-${targetId}` }),
        });
        instances.push(cdp);
        return cdp;
    };
    const createVia = async ({ via }) => ({ label: via, entryId: ENTRIES[via], organizationId: null, resolverRule: "MAP localhost:5173 outpost:40000", close() {} });
    const pool = new BrowserPool({ getSettings: async () => ({ enabled: true, maxSessions, idleMinutes: 30, callbackHost: "outpost" }), launcher, connectCdp, createVia });
    const tools = createBrowserTools({ getPool: () => pool, audit: async () => {} });
    const agent = (keyId, entryId, transportId) => ({ accountId: 1, keyId, agent: { keyId, entryId, agentType: "claude" }, transportId, ipAddress: "10.0.0.5", userAgent: "claude-code" });
    const login = (transportId) => ({ accountId: 1, keyId: null, agent: null, transportId, ipAddress: "10.0.0.9", userAgent: "firefox" });
    const accountKey = (transportId) => ({ accountId: 1, keyId: 99, agent: null, transportId, ipAddress: "10.0.0.9", userAgent: "script" });
    const text = (result) => result.content.map((c) => c.text).join("");
    const opened = (result) => /^Session: (\S+)/m.exec(text(result))[1];
    return { pool, tools, launcher, instances, agent, login, accountKey, text, opened };
};

test("an agent key lists, resolves and defaults to its own sessions and their popups only; account callers keep seeing all", async () => {
    const { pool, tools, instances, agent, login, accountKey, text, opened } = setup({ maxSessions: 5 });
    const { session: users } = await pool.open({ accountId: 1, url: "https://user.test/", origin: "user" });

    const noOwn = await tools.call("browser_snapshot", {}, agent(41, 7, "T41"));
    assert.strictEqual(noOwn.isError, true);
    assert.match(text(noOwn), /No browser session is open/);
    assert.ok(!text(noOwn).includes(users.id), "the user's unclaimed session is neither taken nor named");

    const own = opened(await tools.call("browser_open", { url: "https://a.test/" }, agent(41, 7, "T41")));
    const theirs = opened(await tools.call("browser_open", { url: "https://b.test/" }, agent(42, 8, "T42")));
    instances[0].emitEvent("Target.targetCreated", { targetInfo: { targetId: "POP", type: "page", openerId: pool.get(own).targetId } });
    await flush();
    const popup = pool.listForAccount(1).map((s) => s.id).find((id) => ![users.id, own, theirs].includes(id));

    assert.deepStrictEqual(text(await tools.call("browser_list", {}, agent(41, 7, "T41"))).split("\n").map((line) => line.split("  ")[0]),
        [`- ${own}`, `- ${popup}`]);
    assert.match(text(await tools.call("browser_snapshot", { sessionId: popup }, agent(41, 7, "T41"))), new RegExp(`^Session: ${popup}`));

    const unknown = text(await tools.call("browser_snapshot", { sessionId: "browser-unknown" }, agent(41, 7, "T41")));
    for (const foreign of [users.id, theirs]) {
        const refused = await tools.call("browser_snapshot", { sessionId: foreign }, agent(41, 7, "T41"));
        assert.strictEqual(refused.isError, true);
        assert.strictEqual(text(refused).replace(foreign, "X"), unknown.replace("browser-unknown", "X"), "a foreign session answers like an unknown one");
    }

    const full = await tools.call("browser_open", { url: "https://c.test/" }, agent(41, 7, "T41b"));
    assert.ok(!full.isError);
    const limited = text(await tools.call("browser_open", { url: "https://d.test/" }, agent(41, 7, "T41b")));
    assert.match(limited, /limit of 5/);
    assert.ok(!limited.includes(users.id) && !limited.includes(theirs), "the limit error lists only the key's own sessions");

    const everything = [users.id, own, theirs, popup, opened(full)].sort();
    for (const caller of [login("TL"), accountKey("TK")]) {
        const listed = text(await tools.call("browser_list", {}, caller)).split("\n").map((line) => line.split("  ")[0].slice(2));
        assert.deepStrictEqual(listed.sort(), everything);
    }
    assert.match(text(await tools.call("browser_snapshot", { sessionId: theirs }, login("TL"))), new RegExp(`^Session: ${theirs}`));
});

test("an agent key opens only ephemeral sessions and tunnels only through the server it belongs to", async () => {
    const { pool, tools, launcher, agent, text, opened } = setup();
    const persistent = await tools.call("browser_open", { url: "https://a.test/", profile: "persistent" }, agent(41, 7, "T41"));
    assert.strictEqual(persistent.isError, true);
    assert.match(text(persistent), /^Agent keys can only open ephemeral sessions; call browser_open without profile=persistent\.$/);
    const refused = await tools.call("browser_open", { url: "http://localhost:5173/", via: "web" }, agent(41, 7, "T41"));
    assert.strictEqual(refused.isError, true);
    assert.match(text(refused), /only tunnel through the server it was set up for/);
    assert.deepStrictEqual([launcher.started, pool.listForAccount(1)], [[], []]);

    const allowed = await tools.call("browser_open", { url: "http://localhost:5173/", via: "nas" }, agent(41, 7, "T41"));
    assert.ok(!allowed.isError);
    assert.strictEqual(pool.get(opened(allowed)).via, "nas");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/lib/browser/__tests__/agentScope.test.js`
Expected: FAIL in beiden Tests — (1) `noOwn.isError` ist `undefined`, weil `browser_snapshot` ohne `sessionId` die einzige freie Sitzung des Kontos nimmt (die des Nutzers); (2) `persistent.isError` ist `undefined`, weil der Agenten-Key ein `persistent`-Profil ohne Prüfung öffnet.

- [ ] **Step 3: `keyId` und `contextKey` an der Sitzung**

`server/lib/browser/BrowserSession.js`, Konstruktor (Z. 45-48) vorher:

```js
    constructor({ id, accountId, profile, via = null, origin, organizationId = null, cdp, targetId, cdpSessionId,
                  bufferLimit = VIEWER_BUFFER_LIMIT, stallMs = STALL_MS }) {
        super();
        Object.assign(this, { id, accountId, profile, via, origin, organizationId, cdp, targetId, cdpSessionId, bufferLimit, stallMs });
```

nachher:

```js
    constructor({ id, accountId, keyId = null, contextKey = null, profile, via = null, origin, organizationId = null, cdp, targetId, cdpSessionId,
                  bufferLimit = VIEWER_BUFFER_LIMIT, stallMs = STALL_MS }) {
        super();
        Object.assign(this, { id, accountId, keyId, contextKey, profile, via, origin, organizationId, cdp, targetId, cdpSessionId, bufferLimit, stallMs });
```

`summary()` bleibt unverändert: `keyId` und `contextKey` gehen nicht an den Client.

- [ ] **Step 4: Fehlercode und Eintrags-ID des `via`-Ziels**

`server/lib/browser/errors.js`, nach `VIA_INVALID: "VIA_INVALID",` (Z. 14):

```js
    VIA_NOT_ALLOWED: "VIA_NOT_ALLOWED",
```

`server/lib/browser/proxy.js`, Rückgabe von `createEngineVia` (Z. 202-207) nachher:

```js
    return {
        label: entry.name,
        entryId: entry.id,
        organizationId,
        resolverRule: hostResolverRule(target, settings.callbackHost, port),
        close: () => proxy.close(),
    };
```

- [ ] **Step 5: Pool — Besitz je Key, Kontextschlüssel, Kontextende**

`server/lib/browser/BrowserPool.js`, `getOwned` und `listForAccount` (Z. 31-40) ersetzen durch:

```js
    getOwned(accountId, sessionId, { keyId = null } = {}) {
        const session = this.get(sessionId);
        return session && session.accountId === accountId && (keyId === null || session.keyId === keyId) ? session : null;
    }

    listForAccount(accountId) {
        return this.listForCaller({ accountId });
    }

    listForCaller({ accountId, keyId = null }) {
        return [...this.sessions.values()]
            .filter(({ session }) => session.accountId === accountId && (keyId === null || session.keyId === keyId))
            .map(({ session }) => session.summary());
    }

    onContextEnded(listener) {
        this.on("contextEnded", listener);
        return () => this.off("contextEnded", listener);
    }
```

`open` (Z. 63): Signatur

```js
    async open({ accountId, url, profile = "ephemeral", via = null, origin = "agent", keyId = null, allowVia = null }) {
```

Z. 77, im `LIMIT_REACHED`-Zweig:

```js
            const own = this.listForCaller({ accountId, keyId });
```

Z. 92, direkt nach `if (via) viaHandle = await this.createVia({ accountId, via, url: href, settings });` einfügen (der `catch` von `open` schließt `viaHandle` bereits, weil noch keine Instanz läuft):

```js
            if (viaHandle && allowVia && !allowVia(viaHandle.entryId))
                throw new BrowserError(BrowserErrorCode.VIA_NOT_ALLOWED,
                    "An agent key can only tunnel through the server it was set up for. Pass that server's name or id as via, or leave out via.");
```

Z. 105-109 vorher:

```js
            const session = await this.#attach(instance, {
                id, accountId, profile: via ? "ephemeral" : profile, via: viaHandle?.label ?? null, origin,
                organizationId: viaHandle?.organizationId ?? null, browserContextId,
            });
            this.#register(session, instance, { ownsContext, browserContextId });
```

nachher:

```js
            const contextKey = ownsContext ? browserContextId : instanceKey;
            const session = await this.#attach(instance, {
                id, accountId, keyId, contextKey, profile: via ? "ephemeral" : profile, via: viaHandle?.label ?? null, origin,
                organizationId: viaHandle?.organizationId ?? null, browserContextId,
            });
            this.#register(session, instance, { ownsContext, browserContextId, contextKey });
```

`#attach` (Z. 174 und Z. 181):

```js
    async #attach(instance, { id, accountId, keyId, contextKey, profile, via, origin, organizationId, browserContextId = null, targetId = null }) {
```

```js
            session = new BrowserSession({ id, accountId, keyId, contextKey, profile, via, origin, organizationId, cdp: instance.cdp, targetId: target, cdpSessionId });
```

`#register` (Z. 191 und Z. 197):

```js
    #register(session, instance, { ownsContext, browserContextId, contextKey }) {
```

```js
        const record = { session, instanceKey: instance.key, ownsContext, browserContextId, contextKey };
```

`#onClosed` (Z. 206-210) vorher:

```js
    async #onClosed({ session, instanceKey, ownsContext, browserContextId }, instance) {
        this.sessions.delete(session.id);
        this.#forgetDownloads(new Set([session.id]));
        this.emit("change", session.accountId);
        instance.users.delete(session.id);
```

nachher (der neue Block steht vor der ersten `return`-Bedingung, damit er auch bei abgestürzter Instanz läuft):

```js
    async #onClosed({ session, instanceKey, ownsContext, browserContextId, contextKey }, instance) {
        this.sessions.delete(session.id);
        this.#forgetDownloads(new Set([session.id]));
        this.emit("change", session.accountId);
        instance.users.delete(session.id);
        if (ownsContext) {
            // Disposing the context below takes its popups with it; their sessions must not outlive the context.
            for (const record of [...this.sessions.values()]) if (record.contextKey === contextKey) record.session.close("opener closed");
            this.emit("contextEnded", contextKey);
        } else if (contextKey === instanceKey && ![...this.sessions.values()].some((record) => record.contextKey === contextKey)) {
            this.emit("contextEnded", contextKey);
        }
```

`#adoptPopup` (Z. 320-326) vorher:

```js
            const session = await this.#attach(instance, {
                id, accountId: parent.accountId, profile: parent.profile, via: parent.via,
                origin: parent.origin, organizationId: parent.organizationId, targetId,
            });
            // A popup is often the login the user paused the agent for; it must not arrive unpaused.
            session.agentPaused = parent.agentPaused;
            this.#register(session, instance, { ownsContext: false, browserContextId: null });
```

nachher (`opener` ist der Pool-Record des Öffners):

```js
            const session = await this.#attach(instance, {
                id, accountId: parent.accountId, keyId: parent.keyId, contextKey: opener.contextKey, profile: parent.profile, via: parent.via,
                origin: parent.origin, organizationId: parent.organizationId, targetId,
            });
            // A popup is often the login the user paused the agent for; it must not arrive unpaused.
            session.agentPaused = parent.agentPaused;
            this.#register(session, instance, { ownsContext: false, browserContextId: null, contextKey: opener.contextKey });
```

- [ ] **Step 6: Werkzeuge — Auflösung je Aufrufer, nur ephemer, `via` nur zum eigenen Server**

`server/lib/browser/tools.js`: vor `const createBrowserTools = ({` (Z. 82) einfügen:

```js
const callerOf = (ctx) => ({ accountId: ctx.accountId, keyId: ctx.agent ? ctx.agent.keyId : null });
```

In `createBrowserTools` den bisherigen `resolveSession` (Z. 89-121) ersetzen durch — derselbe Ablauf, mit `listForCaller`/`getOwned(…, { keyId })` statt `listForAccount`/`getOwned(…)`:

```js
    const resolveSession = (ctx, sessionId) => {
        const pool = getPool();
        const caller = callerOf(ctx);
        const owned = (id) => pool.getOwned(caller.accountId, id, { keyId: caller.keyId });
        if (sessionId) {
            const session = owned(sessionId);
            if (!session)
                throw new BrowserError(BrowserErrorCode.UNKNOWN_SESSION, `No open browser session ${sessionId} for this account.`, { sessions: pool.listForCaller(caller) });
            return session;
        }
        const remembered = defaults.get(ctx.transportId);
        if (remembered) {
            const session = owned(remembered);
            if (session) return session;
            // Falling back to "the only open session" here would hand this connection another
            // process's session exactly when its own is gone.
            throw new BrowserError(BrowserErrorCode.SESSION_CLOSED,
                `Your browser session ${remembered} has ended. Open a new one with browser_open or pass a sessionId.`,
                { sessions: pool.listForCaller(caller) });
        }
        // A session another connection opened stays its own: otherwise a connection whose own session
        // is gone (server restart, transport sweep) would act on someone else's (A11).
        const claimed = new Set(defaults.values());
        const all = pool.listForCaller(caller);
        const open = all.filter((session) => !claimed.has(session.id));
        if (open.length === 1) return owned(open[0].id);
        if (open.length === 0) {
            throw new BrowserError(BrowserErrorCode.NO_SESSION, all.length === 0
                ? "No browser session is open. Call browser_open first."
                : "No browser session of this connection is open; the open ones belong to other connections. Call browser_open, or pass sessionId.",
            { sessions: all });
        }
        throw new BrowserError(BrowserErrorCode.AMBIGUOUS_SESSION,
            "More than one browser session is open and this connection has none of its own. Pass sessionId.", { sessions: open });
    };
```

`act` (Z. 130-133) bleibt unverändert und ruft weiter `resolveSession(ctx, args.sessionId)`.

`browser_open` (Z. 162-167) nachher:

```js
        browser_open: async (args, ctx) => {
            if (args.url == null)
                throw new BrowserError(BrowserErrorCode.INVALID_URL, "browser_open needs a url. Include the scheme, e.g. https://example.com");
            if (ctx.agent && args.profile === "persistent")
                throw new BrowserError(BrowserErrorCode.INVALID_PROFILE, "Agent keys can only open ephemeral sessions; call browser_open without profile=persistent.");
            const { session, navigationError } = await getPool().open({
                accountId: ctx.accountId, url: args.url, via: args.via ?? null, profile: args.profile ?? "ephemeral", origin: "agent",
                keyId: ctx.keyId ?? null, allowVia: ctx.agent ? (entryId) => entryId === ctx.agent.entryId : null,
            });
```

`browser_list` (Z. 230):

```js
            const open = getPool().listForCaller(callerOf(ctx));
```

Rückgabeobjekt (Z. 245) nach `forgetTransport: (transportId) => defaults.delete(transportId),` ergänzen:

```js
        resolveSession,
```

`module.exports` (Z. 249) bleibt unverändert.

`server/lib/browser/__tests__/tools.test.js`, Fake-Pool Z. 41 vorher:

```js
        listForAccount: (accountId) => [...sessions.values()].filter((s) => s.accountId === accountId).map((s) => s.summary()),
```

nachher:

```js
        listForCaller: ({ accountId }) => [...sessions.values()].filter((s) => s.accountId === accountId).map((s) => s.summary()),
```

- [ ] **Step 7: Run test to verify it passes**

Run: `node --test server/lib/browser/__tests__/agentScope.test.js`
Expected: PASS, 2 Tests.

- [ ] **Step 8: Browser-Tests gegenprüfen**

Run: `node --test server/lib/browser/__tests__/*.test.js`
Expected: PASS (der Chromium-Test bleibt ohne `OUTPOST_BROWSER_E2E_LAUNCHER` übersprungen). `sessionLifecycle.test.js` belegt, dass ephemere Kontexte weiter mit `Target.disposeBrowserContext` enden und persistente Instanzen nachlaufen.

- [ ] **Step 9: Commit**

```bash
git add server/lib/browser/BrowserSession.js server/lib/browser/BrowserPool.js server/lib/browser/tools.js server/lib/browser/errors.js server/lib/browser/proxy.js server/lib/browser/__tests__/tools.test.js server/lib/browser/__tests__/agentScope.test.js
git commit -m "Vault: Browser-Sitzungen gehören dem Agenten-Key, der sie geöffnet hat"
```

---

### Task 3: Sichtbarkeit und Bindungen

**Files:**
- Create: `server/lib/vault/visibility.js`
- Create: `server/lib/vault/bindings.js`
- Modify: `server/controllers/entry.js` (Importe Z. 1-18; `deleteEntry` Z. 190-212: Bindungen vor `Entry.destroy` entfernen)
- Modify: `server/controllers/folder.js` (Importe Z. 1-13; `deleteFolder` Z. 131-168: nach der Rekursion Z. 147-150 und vor `Entry.destroy` Z. 152 Bindungen der Einträge dieses Ordners und des Ordners selbst entfernen)
- Modify: `server/controllers/tag.js` (Importe Z. 1-7; `deleteTag` Z. 48-60: Bindungen vor `Tag.destroy` entfernen)
- Modify: `server/controllers/integration.js` (Importe Z. 1-8; `reconcileIntegration` Z. 167-174: Bindungen veralteter Server und Knotenordner vor `Entry.destroy` Z. 168 bzw. `Folder.destroy` Z. 173 entfernen; `deleteIntegration` Z. 265-278: Bindungen aller Server und Ordner der Integration vor `Entry.destroy` Z. 271 und `Folder.destroy` Z. 272 entfernen)
- Test: `server/lib/vault/__tests__/visibility.test.js` (test-first)
- Test: `server/lib/vault/__tests__/bindings.test.js`

**Interfaces:**
- Consumes (Task 1):
  - Modelle `VaultItem { id, accountId, organizationId, name, type, description, fields, approvalRequired, allServers, createdBy, lastUsedAt }` und `VaultBinding { id, itemId, kind, targetId }` (`server/models/VaultItem.js`, `server/models/VaultBinding.js`). Der `afterFind`-Hook an `VaultItem` (Task 1) macht auch bei `query: { raw: true }` aus `fields` ein Objekt und aus `approvalRequired`/`allServers` Booleans; `visibility.js` normalisiert nichts selbst.
  - `VaultError`, `VaultErrorCode.ITEM_UNKNOWN` aus `server/lib/vault/errors.js`; `new VaultError(VaultErrorCode.ITEM_UNKNOWN)` nimmt den Standardtext aus `VaultErrorMessage` (Task 1), dieser Task setzt keinen eigenen.
  - `Permission.VAULT_USE`, `Permission.VAULT_MANAGE`, `Permission.VAULT_REVEAL` aus `server/permissions/registry.js`.
- Consumes (Bestand): `async resolveEntryScope(entry) → Promise<{ organizationId, ownerAccountId }>` und `async validateEntryAccess(accountId, entry) → Promise<{ valid: true, entry } | { code, message }>` aus `server/controllers/entry.js`; `hasAccountPermission`, `hasOrganizationAccess`, `hasOrganizationPermission`, `async validateFolderAccess(accountId, folderId) → Promise<{ valid, folder } | { valid: false, error }>` aus `server/utils/permission.js`.
- Produces (`server/lib/vault/visibility.js`, genutzt von Task 5, Task 8 und Task 11):
  - `activeOrganizationIds(accountId) → Promise<number[]>` — Organisationen mit `OrganizationMember.status = "active"`.
  - `ownedItems(accountId) → Promise<VaultItem[]>` — alle Einträge, die das Konto verwalten oder sehen darf: persönliche (nur mit `vault.use`) plus die seiner aktiven Organisationen, nach `name` sortiert, ohne Server- und Bindungsfilter.
  - `canUseVault(accountId) → Promise<boolean>` — `vault.use` oder aktives Mitglied mindestens einer Organisation.
  - `itemRef(item) → string` — `<name>` bzw. `org:<organizationId>/<name>`.
  - `parseItemRef(ref) → { organizationId: number|null, name: string }` — wirft `VaultError(ITEM_UNKNOWN)` bei ungültiger Form (kein String, Name verletzt `^[a-z0-9][a-z0-9._-]{0,63}$`, Organisations-ID keine positive Ganzzahl).
  - `visibleItems({ accountId, agent }) → Promise<VaultItem[]>` — Plain Objects, nach `name` sortiert, `fields` als Objekt, `approvalRequired`/`allServers` als Boolean (Hook aus Task 1). `agent = { keyId, entryId, agentType } | null`. Regeln: Kandidaten = `ownedItems(accountId)`. Ohne `agent.entryId` nur persönliche Einträge mit `allServers`. Mit Server: Server muss per `validateEntryAccess` erreichbar sein, sonst `[]`; Organisationseinträge nur, wenn `resolveEntryScope(entry).organizationId` gleich ihrer Organisation ist; dann `allServers` oder eine passende Bindung (`entry` = Server, `folder` = Ordner des Servers oder ein Vorfahre über `Folder.parentId`, `tag` = Tag des Servers über `EntryTag`, nur bei persönlichen Einträgen).
  - `findVisibleItem({ accountId, agent }, ref) → Promise<VaultItem>` — wirft `VaultError(ITEM_UNKNOWN)` mit identischer Meldung (Standardtext aus `VaultErrorMessage`) für ungültig, unbekannt und unsichtbar.
  - `canManageItem(accountId, item) → Promise<boolean>` — persönlich: Besitzer und `vault.use`; Organisation: aktive Mitgliedschaft **und** `vault.manage`.
  - `canRevealItem(accountId, item) → Promise<boolean>` — persönlich wie `canManageItem`; Organisation: aktive Mitgliedschaft **und** `vault.reveal`.
  - `canCreateFor(accountId, { organizationId }) → Promise<boolean>` — ohne Organisation `vault.use`; mit Organisation aktive Mitgliedschaft **und** `vault.manage`.
- Produces (`server/lib/vault/bindings.js`, genutzt von Task 5):
  - `removeBindings(kind: "entry"|"folder"|"tag", ids: number[]) → Promise<number>` (Anzahl gelöschter Zeilen; leere Liste → `0` ohne Abfrage).
  - `validateBindings({ accountId, organizationId }, bindings: { kind, targetId }[]) → Promise<{ valid: true } | { valid: false, message }>` — `tag` nur bei persönlichen Einträgen und nur Tags des Kontos; `entry` muss per `validateEntryAccess` erreichbar sein, bei Organisationseinträgen mit `resolveEntryScope(...).organizationId` gleich der Organisation; `folder` muss per `validateFolderAccess` erreichbar sein, bei Organisationseinträgen mit `folder.organizationId` gleich der Organisation; jede andere Art ist ungültig. Meldungen englisch, ohne Interna.
  - `setBindings(itemId, bindings) → Promise<void>` — ersetzt alle Bindungen des Eintrags in einer Transaktion, Duplikate werden zusammengefasst.
- Produces (Bestand geändert): `deleteEntry` entfernt `entry`-Bindungen des Servers; `deleteFolder` entfernt je Rekursionsebene vor dem Löschen die `entry`-Bindungen aller Einträge des Ordners und die `folder`-Bindung des Ordners — über die Rekursion also für den ganzen Teilbaum samt mitgelöschter Einträge; `deleteTag` entfernt `tag`-Bindungen; `deleteIntegration` entfernt die `entry`- und `folder`-Bindungen aller Server und Ordner der Integration, `reconcileIntegration` die der veralteten Server und Knotenordner. Entfernt wird jeweils **vor** dem Löschen der Zeilen, damit ein Abbruch keine Bindung an eine verwaiste ID hinterlässt.

**Design:** kein UI-Anteil.

**Tests:** 6 Tests, zwei Dateien, In-Memory-SQLite mit echten Modellen; gefakt wird nur `permissions/engine` (Rechte) und `utils/database` (In-Memory-Instanz).
- `visibility.test.js` (test-first, Kernlogik mit festem Vertrag aus der Spec): (1) Sichtbarkeit als Tabelle (Spec-Test 4: Server, Ordner mit Unterordner, Tag, `allServers` persönlich und Organisation inkl. Server außerhalb der Organisation, keine Bindung, Konto-Key/Login-Session ohne Server, ohne `vault.use`, Einladung `pending`, Organisation verlassen = Server ohne Zugriff), (2) Kennungen: Organisationskennung löst auf und liefert `fields` als Objekt und `allServers` als Boolean (fehlt der Hook aus Task 1, scheitert dieser Test), unbekannt/unsichtbar/fremd/ungültig ergeben denselben `vault.item_unknown`, (3) Verwalten/Anzeigen/Anlegen als Tabelle inkl. „Rechte ohne aktive Mitgliedschaft“, dazu `canUseVault` (nur `vault.use`, nur aktive Mitgliedschaft, keins von beidem).
- `bindings.test.js`: (4) Review Focus 5 — Ordner mit Unterordnern löschen entfernt Bindungen an Ordner, Unterordner und mitgelöschte Server, fremde Bindungen bleiben, (5) Server, Tag und Integration löschen entfernen genau ihre Bindungen, (6) `validateBindings` als Tabelle.
- Nicht getestet: `setBindings` für sich (wird in Test 4 und 5 als Fixture benutzt und dort über den Tabellenstand mitgeprüft), `removeBindings` für sich (Weiterreichung an `destroy`), `ownedItems` und `activeOrganizationIds` für sich (Kandidaten von `visibleItems`, in Test 1 mitgeprüft), das Aufräumen in `reconcileIntegration` (derselbe Aufruf wie in `deleteIntegration`; ein Test bräuchte Fakes für Provider und Zugangsdaten), Audit und Broadcast in den Löschpfaden (Bestand).
- SEC-Abdeckung: SEC-TENANT-01 (Organisationsfilter in `visibleItems`, Mitgliedschaftspflicht in `can*`, Bindungen nur in derselben Organisation — Tests 1, 3, 6), SEC-IDOR-01 (ein Fehler für unbekannt und unsichtbar — Test 2; `canManageItem`/`canRevealItem` für Task 5 — Test 3), SEC-RBAC-01 (`vault.use`/`vault.manage`/`vault.reveal` — Tests 1, 3), SEC-SQLI-01 (nur Sequelize-`where`-Objekte, keine SQL-Strings), SEC-PII-01 (Löschkonzept: Bindungen verschwinden mit ihren Zielen — Tests 4, 5).

**Parallel:** Task 4, Task 9, Task 12, Task 13, Task 14 (Welle B; keine gemeinsamen Dateien).

- [ ] **Step 1: Write the failing test**

`server/lib/vault/__tests__/visibility.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const { Sequelize } = require("sequelize");

const db = new Sequelize({ dialect: "sqlite", storage: ":memory:", logging: false, query: { raw: true }, foreignKeys: false });
const fake = (path, exports) => {
    const resolved = require.resolve(path);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

const systemPermissions = new Map();
const organizationPermissions = new Map();
fake("../../../utils/database", db);
fake("../../../permissions/engine", {
    getSystemPermissions: async (accountId) => ({ isAdmin: false, permissions: systemPermissions.get(accountId) ?? [] }),
    getOrganizationPermissions: async (accountId, organizationId) => ({
        isOwner: false, isAdmin: false, permissions: organizationPermissions.get(`${accountId}:${organizationId}`) ?? [],
    }),
});

const Entry = require("../../../models/Entry");
const Folder = require("../../../models/Folder");
const Tag = require("../../../models/Tag");
const EntryTag = require("../../../models/EntryTag");
const OrganizationMember = require("../../../models/OrganizationMember");
const VaultItem = require("../../../models/VaultItem");
const VaultBinding = require("../../../models/VaultBinding");
const { visibleItems, findVisibleItem, itemRef, canManageItem, canRevealItem, canCreateFor, canUseVault } = require("../visibility");
const { VaultErrorCode } = require("../errors");

const ANNA = 1;
const BEN = 2;
const world = {};

const server = (values) => Entry.create({ type: "server", name: "server", config: { ip: "192.0.2.1", protocol: "ssh" }, ...values });
const item = (values) => VaultItem.create({
    type: "login", fields: { username: "admin", origins: ["https://nas.lan"] }, approvalRequired: true, allServers: false, ...values,
});
const bind = (vaultItem, kind, target) => VaultBinding.create({ itemId: vaultItem.id, kind, targetId: target.id });
const member = (accountId, organizationId, status = "active") =>
    OrganizationMember.create({ organizationId, accountId, status, role: "member", invitedBy: 99 });
const agentOn = (entry) => ({ keyId: 1, entryId: entry.id, agentType: "claude" });
const names = async (caller) => (await visibleItems(caller)).map((visible) => visible.name).sort();

test.before(async () => {
    await db.sync();
    systemPermissions.set(ANNA, ["vault.use"]);
    systemPermissions.set(BEN, ["vault.use"]);
    await member(ANNA, 10);
    await member(ANNA, 20, "pending");

    const home = await Folder.create({ name: "home", accountId: ANNA });
    const lab = await Folder.create({ name: "lab", accountId: ANNA, parentId: home.id });
    const team = await Folder.create({ name: "team", organizationId: 10 });
    const teamNas = await Folder.create({ name: "team-nas", organizationId: 10, parentId: team.id });
    const other = await Folder.create({ name: "other", organizationId: 20 });
    const prod = await Tag.create({ accountId: ANNA, name: "prod", color: "#ff0000" });

    world.sDirect = await server({ accountId: ANNA });
    world.sNested = await server({ accountId: ANNA, folderId: lab.id });
    world.sTagged = await server({ accountId: ANNA });
    world.sPlain = await server({ accountId: ANNA });
    world.sOrg = await server({ folderId: teamNas.id });
    world.sOrg20 = await server({ folderId: other.id });
    await EntryTag.create({ entryId: world.sTagged.id, tagId: prod.id });

    await bind(await item({ accountId: ANNA, name: "direct" }), "entry", world.sDirect);
    await bind(await item({ accountId: ANNA, name: "folder" }), "folder", home);
    await bind(await item({ accountId: ANNA, name: "tagged" }), "tag", prod);
    await item({ accountId: ANNA, name: "everywhere", allServers: true });
    await item({ accountId: ANNA, name: "unbound" });
    await bind(await item({ organizationId: 10, name: "org-folder" }), "folder", team);
    await item({ organizationId: 10, name: "org-all", allServers: true });
    await item({ organizationId: 20, name: "org20-all", allServers: true });
    await item({ accountId: BEN, name: "foreign-all", allServers: true });
});

test("Sichtbarkeit je Aufrufer und Server (Spec-Test 4)", async (t) => {
    t.after(async () => {
        systemPermissions.set(ANNA, ["vault.use"]);
        await OrganizationMember.destroy({ where: { accountId: ANNA, organizationId: 10 } });
        await member(ANNA, 10);
    });

    const cases = [
        ["Konto-Key oder Login-Session ohne Server: nur persönliche Einträge mit allServers", null, ["everywhere"]],
        ["Server direkt gebunden", "sDirect", ["direct", "everywhere"]],
        ["Ordnerbindung gilt auch für Server im Unterordner", "sNested", ["everywhere", "folder"]],
        ["Tag des Servers", "sTagged", ["everywhere", "tagged"]],
        ["keine Bindung; allServers der Organisation gilt nicht außerhalb der Organisation", "sPlain", ["everywhere"]],
        ["Server im Ordner der Organisation (entry.organizationId leer)", "sOrg", ["everywhere", "org-all", "org-folder"]],
        ["Organisation mit offener Einladung", "sOrg20", []],
    ];
    for (const [label, serverKey, expected] of cases) {
        const agent = serverKey ? agentOn(world[serverKey]) : null;
        assert.deepStrictEqual(await names({ accountId: ANNA, agent }), expected, label);
    }

    systemPermissions.set(ANNA, []);
    assert.deepStrictEqual(await names({ accountId: ANNA, agent: agentOn(world.sOrg) }), ["org-all", "org-folder"],
        "ohne vault.use keine persönlichen Einträge");
    assert.deepStrictEqual(await names({ accountId: ANNA, agent: null }), [], "ohne vault.use und ohne Server nichts");
    systemPermissions.set(ANNA, ["vault.use"]);

    await OrganizationMember.destroy({ where: { accountId: ANNA, organizationId: 10 } });
    assert.deepStrictEqual(await names({ accountId: ANNA, agent: agentOn(world.sOrg) }), [],
        "Organisation verlassen: der Server ist nicht mehr erreichbar, der Key sieht nichts, auch keine persönlichen Einträge");
    assert.deepStrictEqual(await names({ accountId: ANNA, agent: agentOn(world.sDirect) }), ["direct", "everywhere"]);
});

test("Kennungen: unbekannt, unsichtbar, fremd und ungültig ergeben denselben Fehler", async () => {
    const onOrg = { accountId: ANNA, agent: agentOn(world.sOrg) };
    const orgAll = await findVisibleItem(onOrg, "org:10/org-all");
    assert.deepStrictEqual([itemRef(orgAll), orgAll.allServers, orgAll.fields.username], ["org:10/org-all", true, "admin"]);
    assert.strictEqual(itemRef(await findVisibleItem(onOrg, "everywhere")), "everywhere");

    const attempts = [
        [{ accountId: ANNA, agent: agentOn(world.sDirect) }, "org:10/org-all"],
        [onOrg, "missing"],
        [onOrg, "foreign-all"],
        [onOrg, "org-all"],
        [onOrg, "org:10/../org-all"],
        [onOrg, 42],
    ];
    const failures = [];
    for (const [caller, ref] of attempts) {
        const error = await findVisibleItem(caller, ref).then(() => null, (thrown) => thrown);
        failures.push({ ref, code: error?.code, message: error?.message });
    }
    for (const failure of failures) assert.strictEqual(failure.code, VaultErrorCode.ITEM_UNKNOWN, String(failure.ref));
    assert.strictEqual(new Set(failures.map((failure) => failure.message)).size, 1);
});

test("Verwalten, Anzeigen, Anlegen und Vault-Zugang verlangen Besitz bzw. aktive Mitgliedschaft und Recht", async () => {
    const CARL = 3;
    const DORA = 4;
    const ADMIN = 5;
    systemPermissions.set(CARL, ["vault.use"]);
    await member(CARL, 30);
    organizationPermissions.set(`${CARL}:30`, ["vault.manage"]);
    await member(DORA, 30);
    organizationPermissions.set(`${DORA}:30`, ["vault.reveal"]);
    organizationPermissions.set(`${ADMIN}:30`, ["vault.manage", "vault.reveal"]);
    const own = { id: 900, accountId: CARL, organizationId: null };
    const doras = { id: 901, accountId: DORA, organizationId: null };
    const shared = { id: 902, accountId: null, organizationId: 30 };

    const rows = [
        ["Besitzer eines persönlichen Eintrags", CARL, own, true, true],
        ["persönlicher Eintrag eines anderen Kontos", CARL, doras, false, false],
        ["Besitzer ohne vault.use", DORA, doras, false, false],
        ["Mitglied mit vault.manage", CARL, shared, true, false],
        ["Mitglied mit vault.reveal", DORA, shared, false, true],
        ["Rechte ohne aktive Mitgliedschaft", ADMIN, shared, false, false],
    ];
    for (const [label, accountId, vaultItem, manage, reveal] of rows)
        assert.deepStrictEqual([await canManageItem(accountId, vaultItem), await canRevealItem(accountId, vaultItem)], [manage, reveal], label);

    assert.deepStrictEqual([
        await canCreateFor(CARL, { organizationId: null }),
        await canCreateFor(CARL, { organizationId: 30 }),
        await canCreateFor(DORA, { organizationId: 30 }),
        await canCreateFor(ADMIN, { organizationId: 30 }),
    ], [true, true, false, false]);

    assert.deepStrictEqual([await canUseVault(CARL), await canUseVault(DORA), await canUseVault(ADMIN)], [true, true, false],
        "vault.use oder aktive Mitgliedschaft");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/lib/vault/__tests__/visibility.test.js`
Expected: FAIL — `Error: Cannot find module '../visibility'`.

- [ ] **Step 3: Implement `server/lib/vault/visibility.js`**

```js
const { Op } = require("sequelize");
const VaultItem = require("../../models/VaultItem");
const VaultBinding = require("../../models/VaultBinding");
const Entry = require("../../models/Entry");
const Folder = require("../../models/Folder");
const EntryTag = require("../../models/EntryTag");
const OrganizationMember = require("../../models/OrganizationMember");
const { hasAccountPermission, hasOrganizationAccess, hasOrganizationPermission } = require("../../utils/permission");
const { Permission } = require("../../permissions/registry");
const { resolveEntryScope, validateEntryAccess } = require("../../controllers/entry");
const { VaultError, VaultErrorCode } = require("./errors");

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const REF_PATTERN = /^(?:org:([1-9][0-9]{0,9})\/)?([^/]+)$/;

const unknownItem = () => new VaultError(VaultErrorCode.ITEM_UNKNOWN);

const itemRef = (item) => (item.organizationId ? `org:${item.organizationId}/${item.name}` : item.name);

const parseItemRef = (ref) => {
    const match = typeof ref === "string" ? REF_PATTERN.exec(ref) : null;
    if (!match || !NAME_PATTERN.test(match[2])) throw unknownItem();
    return { organizationId: match[1] ? Number(match[1]) : null, name: match[2] };
};

const activeOrganizationIds = async (accountId) =>
    (await OrganizationMember.findAll({ where: { accountId, status: "active" } })).map((membership) => membership.organizationId);

const canUseVault = async (accountId) =>
    (await hasAccountPermission(accountId, Permission.VAULT_USE)) || (await activeOrganizationIds(accountId)).length > 0;

const ownedItems = async (accountId) => {
    const owners = [];
    if (await hasAccountPermission(accountId, Permission.VAULT_USE)) owners.push({ accountId, organizationId: null });
    const organizationIds = await activeOrganizationIds(accountId);
    if (organizationIds.length) owners.push({ organizationId: { [Op.in]: organizationIds } });
    if (!owners.length) return [];
    return VaultItem.findAll({ where: { [Op.or]: owners }, order: [["name", "ASC"]] });
};

const folderLineage = async (folderId) => {
    const ids = [];
    let current = folderId;
    while (current && !ids.includes(current)) {
        const folder = await Folder.findByPk(current);
        if (!folder) break;
        ids.push(folder.id);
        current = folder.parentId;
    }
    return ids;
};

const serverContext = async (accountId, entryId) => {
    const entry = await Entry.findByPk(entryId);
    if (!entry || !(await validateEntryAccess(accountId, entry)).valid) return null;
    const { organizationId } = await resolveEntryScope(entry);
    const tagIds = (await EntryTag.findAll({ where: { entryId: entry.id } })).map((row) => row.tagId);
    return { entryId: entry.id, organizationId: organizationId ?? null, folderIds: await folderLineage(entry.folderId), tagIds };
};

const bindingMatches = (binding, server, item) => {
    if (binding.kind === "entry") return binding.targetId === server.entryId;
    if (binding.kind === "folder") return server.folderIds.includes(binding.targetId);
    return binding.kind === "tag" && !item.organizationId && server.tagIds.includes(binding.targetId);
};

const visibleItems = async ({ accountId, agent = null }) => {
    if (!agent?.entryId)
        return (await ownedItems(accountId)).filter((item) => !item.organizationId && item.allServers);

    const server = await serverContext(accountId, agent.entryId);
    if (!server) return [];

    const items = (await ownedItems(accountId))
        .filter((item) => !item.organizationId || item.organizationId === server.organizationId);
    if (!items.length) return [];

    const bindings = await VaultBinding.findAll({ where: { itemId: { [Op.in]: items.map((item) => item.id) } } });
    return items.filter((item) => item.allServers
        || bindings.some((binding) => binding.itemId === item.id && bindingMatches(binding, server, item)));
};

const findVisibleItem = async (caller, ref) => {
    const { organizationId, name } = parseItemRef(ref);
    const item = (await visibleItems(caller))
        .find((candidate) => candidate.name === name && (candidate.organizationId ?? null) === organizationId);
    if (!item) throw unknownItem();
    return item;
};

const memberWith = async (accountId, organizationId, permission) =>
    (await hasOrganizationAccess(accountId, organizationId)) && hasOrganizationPermission(accountId, organizationId, permission);

const canManageItem = async (accountId, item) => {
    if (item.organizationId) return memberWith(accountId, item.organizationId, Permission.VAULT_MANAGE);
    return item.accountId === accountId && hasAccountPermission(accountId, Permission.VAULT_USE);
};

const canRevealItem = async (accountId, item) => {
    if (item.organizationId) return memberWith(accountId, item.organizationId, Permission.VAULT_REVEAL);
    return canManageItem(accountId, item);
};

const canCreateFor = async (accountId, { organizationId = null } = {}) => {
    if (organizationId) return memberWith(accountId, organizationId, Permission.VAULT_MANAGE);
    return hasAccountPermission(accountId, Permission.VAULT_USE);
};

module.exports = {
    itemRef,
    parseItemRef,
    activeOrganizationIds,
    ownedItems,
    canUseVault,
    visibleItems,
    findVisibleItem,
    canManageItem,
    canRevealItem,
    canCreateFor,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/lib/vault/__tests__/visibility.test.js`
Expected: PASS — `# pass 3`, `# fail 0`.

- [ ] **Step 5: Write the failing test for bindings**

`server/lib/vault/__tests__/bindings.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const { Sequelize } = require("sequelize");

const db = new Sequelize({ dialect: "sqlite", storage: ":memory:", logging: false, query: { raw: true }, foreignKeys: false });
const fake = (path, exports) => {
    const resolved = require.resolve(path);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

const systemPermissions = new Map();
fake("../../../utils/database", db);
fake("../../../permissions/engine", {
    getSystemPermissions: async (accountId) => ({ isAdmin: false, permissions: systemPermissions.get(accountId) ?? [] }),
    getOrganizationPermissions: async () => ({ isOwner: false, isAdmin: false, permissions: [] }),
});

const Entry = require("../../../models/Entry");
const Folder = require("../../../models/Folder");
const Tag = require("../../../models/Tag");
const Integration = require("../../../models/Integration");
const OrganizationMember = require("../../../models/OrganizationMember");
const VaultItem = require("../../../models/VaultItem");
const VaultBinding = require("../../../models/VaultBinding");
const { deleteEntry } = require("../../../controllers/entry");
const { deleteFolder } = require("../../../controllers/folder");
const { deleteTag } = require("../../../controllers/tag");
const { deleteIntegration } = require("../../../controllers/integration");
const { setBindings, validateBindings } = require("../bindings");

const ANNA = 1;
const BEN = 2;

const login = (name) => VaultItem.create({
    accountId: ANNA, name, type: "login", fields: { username: "admin", origins: ["https://nas.lan"] }, approvalRequired: true, allServers: false,
});
const remaining = async (itemId) =>
    (await VaultBinding.findAll({ where: { itemId } })).map((binding) => `${binding.kind}:${binding.targetId}`).sort();

test.before(async () => {
    await db.sync();
    systemPermissions.set(ANNA, ["vault.use", "resources.manage"]);
});

test("Ordner mit Unterordnern löschen entfernt Bindungen an Ordner, Unterordner und mitgelöschte Server (Review Focus 5)", async () => {
    const root = await Folder.create({ name: "lab", accountId: ANNA });
    const sub = await Folder.create({ name: "nas", accountId: ANNA, parentId: root.id });
    const subSub = await Folder.create({ name: "backup", accountId: ANNA, parentId: sub.id });
    const outside = await Folder.create({ name: "prod", accountId: ANNA });
    const servers = [];
    for (const folder of [root, sub, subSub, outside])
        servers.push(await Entry.create({ accountId: ANNA, folderId: folder.id, type: "server", name: folder.name }));
    const kept = servers[3];
    const item = await login("nas-admin");
    await setBindings(item.id, [
        ...[root, sub, subSub, outside].map((folder) => ({ kind: "folder", targetId: folder.id })),
        ...servers.map((entry) => ({ kind: "entry", targetId: entry.id })),
    ]);

    assert.deepStrictEqual(await deleteFolder(ANNA, root.id), { success: true });

    assert.deepStrictEqual(await remaining(item.id), [`entry:${kept.id}`, `folder:${outside.id}`].sort());
    assert.strictEqual(await Entry.count({ where: { id: servers.slice(0, 3).map((entry) => entry.id) } }), 0);
});

test("Server, Tag oder Integration löschen entfernt genau deren Bindungen", async () => {
    const gone = await Entry.create({ accountId: ANNA, type: "server", name: "old-nas" });
    const stays = await Entry.create({ accountId: ANNA, type: "server", name: "new-nas" });
    const tag = await Tag.create({ accountId: ANNA, name: "prod", color: "#ff0000" });
    const pve = await Integration.create({ type: "proxmox", name: "pve", config: { ip: "192.0.2.80", port: 8006 }, status: "online" });
    const pveRoot = await Folder.create({ name: "pve", accountId: ANNA, integrationId: pve.id, type: "integration-root" });
    const pveVm = await Entry.create({ accountId: ANNA, folderId: pveRoot.id, integrationId: pve.id, type: "pve-qemu", name: "vm-100" });
    const item = await login("router");
    await setBindings(item.id, [
        { kind: "entry", targetId: gone.id },
        { kind: "entry", targetId: stays.id },
        { kind: "tag", targetId: tag.id },
        { kind: "folder", targetId: pveRoot.id },
        { kind: "entry", targetId: pveVm.id },
    ]);

    assert.deepStrictEqual(await deleteEntry(ANNA, gone.id), { success: true });
    assert.deepStrictEqual(await deleteTag(ANNA, tag.id), { success: true });
    assert.deepStrictEqual(await deleteIntegration(ANNA, pve.id), { success: true });

    assert.deepStrictEqual(await remaining(item.id), [`entry:${stays.id}`]);
});

test("Bindungen nur an zugängliche Ziele, Organisationseinträge nur an Server und Ordner der eigenen Organisation", async () => {
    await OrganizationMember.create({ organizationId: 10, accountId: ANNA, status: "active", role: "member", invitedBy: 99 });
    const own = await Entry.create({ accountId: ANNA, type: "server", name: "own" });
    const ownFolder = await Folder.create({ name: "own", accountId: ANNA });
    const ownTag = await Tag.create({ accountId: ANNA, name: "own", color: "#00ff00" });
    const foreign = await Entry.create({ accountId: BEN, type: "server", name: "foreign" });
    const foreignTag = await Tag.create({ accountId: BEN, name: "foreign", color: "#0000ff" });
    const teamFolder = await Folder.create({ name: "team", organizationId: 10 });
    const teamServer = await Entry.create({ folderId: teamFolder.id, type: "server", name: "team" });
    const otherFolder = await Folder.create({ name: "other", organizationId: 20 });
    const personal = { accountId: ANNA, organizationId: null };
    const team = { accountId: ANNA, organizationId: 10 };
    const to = (kind, target) => ({ kind, targetId: typeof target === "number" ? target : target.id });

    const cases = [
        ["persönlich: eigener Server, Ordner und Tag", personal, [to("entry", own), to("folder", ownFolder), to("tag", ownTag)], true],
        ["persönlich: zugänglicher Server der Organisation", personal, [to("entry", teamServer)], true],
        ["persönlich: Server eines anderen Kontos", personal, [to("entry", foreign)], false],
        ["persönlich: Tag eines anderen Kontos", personal, [to("tag", foreignTag)], false],
        ["persönlich: Ziel existiert nicht", personal, [to("entry", 999999)], false],
        ["persönlich: unbekannte Art", personal, [to("group", 1)], false],
        ["Organisation: Server und Ordner der Organisation", team, [to("entry", teamServer), to("folder", teamFolder)], true],
        ["Organisation: Tag", team, [to("tag", ownTag)], false],
        ["Organisation: persönlicher Server", team, [to("entry", own)], false],
        ["Organisation: Ordner einer anderen Organisation", team, [to("folder", otherFolder)], false],
    ];
    for (const [label, owner, bindings, valid] of cases) {
        const result = await validateBindings(owner, bindings);
        assert.strictEqual(result.valid, valid, label);
        if (!valid) assert.match(result.message, /\S/, label);
    }
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `node --test server/lib/vault/__tests__/bindings.test.js`
Expected: FAIL — `Error: Cannot find module '../bindings'`.

- [ ] **Step 7: Implement `server/lib/vault/bindings.js`**

```js
const { Op } = require("sequelize");
const db = require("../../utils/database");
const VaultBinding = require("../../models/VaultBinding");
const Entry = require("../../models/Entry");
const Tag = require("../../models/Tag");
const { validateFolderAccess } = require("../../utils/permission");

const removeBindings = async (kind, ids) => {
    const targetIds = (ids ?? []).filter((id) => id !== null && id !== undefined);
    if (!targetIds.length) return 0;
    return VaultBinding.destroy({ where: { kind, targetId: { [Op.in]: targetIds } } });
};

const bindingProblem = async ({ accountId, organizationId }, { kind, targetId }) => {
    // controllers/entry requires this module, so it is only complete once both have loaded.
    const { validateEntryAccess, resolveEntryScope } = require("../../controllers/entry");

    if (kind === "tag") {
        if (organizationId) return "Organization items cannot apply to tags";
        const tag = await Tag.findByPk(targetId);
        return tag && tag.accountId === accountId ? null : "Tag not found";
    }
    if (kind === "entry") {
        const entry = await Entry.findByPk(targetId);
        if (!entry || !(await validateEntryAccess(accountId, entry)).valid) return "Server not found";
        if (organizationId && (await resolveEntryScope(entry)).organizationId !== organizationId)
            return "Organization items can only apply to servers of the same organization";
        return null;
    }
    if (kind === "folder") {
        const access = await validateFolderAccess(accountId, targetId);
        if (!access.valid) return "Folder not found";
        if (organizationId && access.folder.organizationId !== organizationId)
            return "Organization items can only apply to folders of the same organization";
        return null;
    }
    return "Unknown binding kind";
};

const validateBindings = async ({ accountId, organizationId = null }, bindings = []) => {
    const owner = { accountId, organizationId: organizationId ? Number(organizationId) : null };
    for (const binding of bindings) {
        const message = await bindingProblem(owner, binding);
        if (message) return { valid: false, message };
    }
    return { valid: true };
};

const setBindings = async (itemId, bindings = []) => {
    const rows = new Map();
    for (const { kind, targetId } of bindings) rows.set(`${kind}:${Number(targetId)}`, { itemId, kind, targetId: Number(targetId) });

    await db.transaction(async (transaction) => {
        await VaultBinding.destroy({ where: { itemId }, transaction });
        if (rows.size) await VaultBinding.bulkCreate([...rows.values()], { transaction });
    });
};

module.exports = { removeBindings, validateBindings, setBindings };
```

- [ ] **Step 8: Hook the delete paths**

`server/controllers/entry.js` — Import nach Z. 18 (`const SessionManager = require("../lib/SessionManager");`):

```js
const { removeBindings } = require("../lib/vault/bindings");
```

`deleteEntry` (Z. 190-197) vorher:

```js
    if (!accessCheck.valid) return accessCheck;

    await Entry.destroy({ where: { id: entryId } });
```

nachher:

```js
    if (!accessCheck.valid) return accessCheck;

    await removeBindings("entry", [entry.id]);
    await Entry.destroy({ where: { id: entryId } });
```

`server/controllers/folder.js` — Import nach Z. 13 (`const SessionManager = require("../lib/SessionManager");`):

```js
const { removeBindings } = require("../lib/vault/bindings");
```

`deleteFolder` (Z. 147-152) vorher:

```js
    let subfolders = await Folder.findAll({ where: { parentId: folderId } });
    for (let subfolder of subfolders) {
        await module.exports.deleteFolder(accountId, subfolder.id);
    }

    await Entry.destroy({ where: { folderId: folderId } });
```

nachher:

```js
    let subfolders = await Folder.findAll({ where: { parentId: folderId } });
    for (let subfolder of subfolders) {
        await module.exports.deleteFolder(accountId, subfolder.id);
    }

    const entryIds = (await Entry.findAll({ where: { folderId: folder.id }, attributes: ["id"] })).map((entry) => entry.id);
    await removeBindings("entry", entryIds);
    await removeBindings("folder", [folder.id]);

    await Entry.destroy({ where: { folderId: folderId } });
```

`server/controllers/tag.js` — Import nach Z. 7 (`const { Op } = require("sequelize");`):

```js
const { removeBindings } = require("../lib/vault/bindings");
```

`deleteTag` (Z. 55-57) vorher:

```js
    await EntryTag.destroy({ where: { tagId } });

    await Tag.destroy({ where: { id: tagId } });
```

nachher:

```js
    await EntryTag.destroy({ where: { tagId } });

    await removeBindings("tag", [tag.id]);
    await Tag.destroy({ where: { id: tagId } });
```

`server/controllers/integration.js` — Import nach Z. 8 (`const { getProvider, entryKey } = require("../lib/hypervisors");`):

```js
const { removeBindings } = require("../lib/vault/bindings");
```

`reconcileIntegration` (Z. 167-174) vorher:

```js
    if (staleEntries.length > 0) {
        await Entry.destroy({ where: { id: staleEntries.map((entry) => entry.id) } });
    }

    const staleFolders = nodeFolders.filter((folder) => !seenFolderIds.has(folder.id));
    if (staleFolders.length > 0) {
        await Folder.destroy({ where: { id: staleFolders.map((folder) => folder.id) } });
    }
```

nachher:

```js
    if (staleEntries.length > 0) {
        await removeBindings("entry", staleEntries.map((entry) => entry.id));
        await Entry.destroy({ where: { id: staleEntries.map((entry) => entry.id) } });
    }

    const staleFolders = nodeFolders.filter((folder) => !seenFolderIds.has(folder.id));
    if (staleFolders.length > 0) {
        await removeBindings("folder", staleFolders.map((folder) => folder.id));
        await Folder.destroy({ where: { id: staleFolders.map((folder) => folder.id) } });
    }
```

`deleteIntegration` (Z. 271-272) vorher:

```js
    await Entry.destroy({ where: { integrationId } });
    await Folder.destroy({ where: { integrationId } });
```

nachher:

```js
    const entryIds = (await Entry.findAll({ where: { integrationId }, attributes: ["id"] })).map((entry) => entry.id);
    const folderIds = (await Folder.findAll({ where: { integrationId }, attributes: ["id"] })).map((folder) => folder.id);
    await removeBindings("entry", entryIds);
    await removeBindings("folder", folderIds);

    await Entry.destroy({ where: { integrationId } });
    await Folder.destroy({ where: { integrationId } });
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `node --test server/lib/vault/__tests__/bindings.test.js server/lib/vault/__tests__/visibility.test.js`
Expected: PASS — `# pass 6`, `# fail 0`.

- [ ] **Step 10: Run the affected existing tests**

Die vier Controller laden jetzt `server/lib/vault/bindings.js`; diese Bestandstests laden die echten Controller bzw. `controllers/entry` mit gefaktem `Folder`, `connectionServiceTimeout.test.js` lädt `controllers/integration` über `lib/ConnectionService`:

Run: `node --test server/lib/__tests__/entryScope.test.js server/lib/__tests__/reconnectSession.test.js server/lib/__tests__/directConnect.test.js server/lib/__tests__/directConnectReason.test.js server/lib/__tests__/connectionServiceTimeout.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 11: Commit**

```bash
git add server/lib/vault/visibility.js server/lib/vault/bindings.js server/controllers/entry.js server/controllers/folder.js server/controllers/tag.js server/controllers/integration.js server/lib/vault/__tests__/visibility.test.js server/lib/vault/__tests__/bindings.test.js
git commit -m "Vault: Sichtbarkeit je Server und Bindungen, Aufräumen beim Löschen von Servern, Ordnern, Tags und Integrationen"
```

---

### Task 4: Agenten-Authentifizierung

**Files:**
- Modify: `server/middlewares/auth.js` (Importe Z. 1-3; `authenticate` Z. 5-24, API-Key-Zweig; Z. 37 `next()` am Ende des Session-Zweigs)
- Create: `server/lib/vault/ipBinding.js`
- Modify: `server/controllers/apiKey.js` (`createApiKey` Z. 32, `listApiKeys` Z. 61-64, `deleteApiKey` Z. 66-73, `validateApiKey` Z. 89, `module.exports` Z. 94-100)
- Modify: `server/controllers/session.js` (`createSession` Z. 12-21)
- Modify: `server/routes/users.js` (Impersonations-Route Z. 62-67)
- Create: `server/middlewares/requireLoginSession.js`
- Modify: `server/routes/apiKey.js` (Import Z. 2; `POST /` Z. 36)
- Create: `server/utils/auditContext.js`
- Modify: `server/controllers/audit.js` (Importe Z. 1-14; `createAuditLog` heute Z. 201-225, nach Task 1 verschoben: vor `AuditLog.create` `details.impersonatorId` ergänzen)
- Modify: `server/utils/database.js` (SQL-Log-Callback Z. 34 und Z. 41 — SEC-TOKEN-01, siehe Step 9)
- Test: `server/lib/vault/__tests__/agentAuth.test.js` (test-first)

**Interfaces:**
- Consumes (Task 1):
  - `api_keys`-Spalten am Modell `ApiKey`: `kind` (`"account"|"agent"`, Standard `"account"`), `pending` (Standard `false`), `entryId`, `agentType`, `ipBinding` (Standard `true`), `allowedCidrs` (JSON; bei `raw: true` liefert SQLite Text, den der `afterFind`-Hook aus Task 1 zum Array macht — `ipBinding.js` verlässt sich darauf und parst nicht selbst; Text gilt als leere Liste), `identityId`, `remoteUser`, `seenIp`, `seenIpAdopted`.
  - `Session.impersonatorId` (INTEGER null).
  - `AUDIT_ACTIONS.VAULT_AGENT_IP_DENIED = "vault.agent_ip_denied"`, `AUDIT_ACTIONS.VAULT_REVEAL` (nur im Test), `RESOURCE_TYPES.VAULT = "vault"` aus `server/controllers/audit.js`.
  - `isVaultEnabled() → boolean` aus `server/lib/vault/state.js`.
- Consumes (Bestand): `async validateEntryAccess(accountId, entry) → Promise<{ valid: true, entry } | { code, message }>` aus `server/controllers/entry.js`; `auth.js` lädt ihn wie `state.js` erst im Agenten-Zweig (`bookmarkRoutes.test.js` lädt `auth.js` mit einer Datenbank-Attrappe ohne `define()`).
- Produces:
  - `authenticate` (`server/middlewares/auth.js`): Für `apiKey.kind === "agent"` setzt es `req.apiKey`, `req.user` und `req.agent = { keyId, entryId, agentType }`. Reihenfolge der Prüfungen: Vault aus (`!isVaultEnabled()`) → `401 { message: "The provided API key is not valid" }` wie ein ungültiger Key, auch für `pending`-Keys. Ein `pending`-Agenten-Key passiert nur `GET /api/vault/agent-keys/probe`, ohne IP-Prüfung; sonst `401` wie ein ungültiger Key. Ein endgültiger Agenten-Key passiert nur, wenn der Pfad von `req.originalUrl` (ohne Query) `/api/mcp` ist oder mit `/api/mcp/` beginnt, sonst `403 { code: 403, message: "Agent keys can only access the MCP endpoint" }`; danach muss das Konto den Server des Keys per `validateEntryAccess` erreichen, sonst `403 { code: 403, message: "The server of this agent key is no longer accessible" }`; danach IP-Bindung über `checkAgentIp`, Verstoß `403 { code: 403, message: "This agent key is not allowed from this address" }`. `lastUsedAt` eines Agenten-Keys setzt erst `authenticate` nach diesen Prüfungen (`touchApiKey`). Konto-Keys unverändert. Login-Sessions: `req.session` (mit `impersonatorId`) wie bisher; trägt die Sitzung `impersonatorId`, läuft `next` in `auditContext.run({ impersonatorId }, next)`.
  - `server/utils/auditContext.js`: `module.exports = new AsyncLocalStorage()` (`node:async_hooks`); Store `{ impersonatorId }`.
  - `createAuditLog` (`server/controllers/audit.js`): ergänzt `details.impersonatorId` aus `auditContext.getStore()`, wenn dort gesetzt und in `details` noch nicht vorhanden; sonst unverändert. Damit nennen alle Audits aus HTTP-Anfragen einer Impersonations-Sitzung den Impersonator, ohne dass Aufrufer ihn durchreichen. Audits aus WebSocket-Verbindungen (Terminal, SFTP, AI) tragen ihn noch nicht: Deren Authentifizierung (`wsAuth.resolveSessionToken`) öffnet keinen `auditContext`.
  - `server/lib/vault/ipBinding.js`:
    - `isAddressAllowed(apiKey, entry, ip) → Promise<boolean>` — ohne Audit; `true` bei `!apiKey.ipBinding`; sonst `normalizeIp(ip)` gegen `allowedCidrs` (Array aus dem Hook, sonst leer) und gegen `resolveHostAddresses(entry?.config?.ip)`; keine gültige Adresse → `false`. Genutzt von `checkAgentIp` und Task 8.
    - `checkAgentIp(apiKey, entry, rawIp) → Promise<boolean>` — `isAddressAllowed`; bei `false` Audit `vault.agent_ip_denied` (`accountId` des Keys, `details: { keyId, agentType, entryId, entryName, ip }`, `ipAddress`), höchstens einmal je (`keyId`, Adresse) in 10 min.
    - `matchesCidr(ip, cidr) → boolean` — IPv4/IPv6 über `net.BlockList`; Präfix `0..32` bzw. `0..128`; eine Adresse ohne Präfix gilt als `/32` bzw. `/128`; unterschiedliche Familien oder ungültige Angaben → `false`.
    - `resolveHostAddresses(host) → Promise<string[]>` — IP-Literal direkt, sonst `dns.promises.lookup(host, { all: true })` (A und AAAA), normalisiert; Cache 60 s je Host, auch für fehlgeschlagene Auflösungen (dann `[]` = Verstoß).
    - `_resetForTests()`.
  - `server/controllers/apiKey.js`: `listApiKeys`, `deleteApiKey` und die Obergrenze 50 in `createApiKey` gelten nur für `kind = "account"`; zusätzlich exportiert `hashToken(token) → string`, `generateToken() → string`, `TOKEN_PREFIX = "outpost_"`, `touchApiKey(id) → Promise<void>` (setzt `lastUsedAt`). `validateApiKey(token) → { account, apiKey } | null` liefert die neuen Spalten mit und setzt `lastUsedAt` nur noch für Konto-Keys.
  - `createSession(accountId, userAgent, { impersonatorId = null } = {}) → { token } | { code, message }` (`server/controllers/session.js`); `POST /api/users/:accountId/login` übergibt `{ impersonatorId: req.user.id }`.
  - `server/middlewares/requireLoginSession.js`: `module.exports = { requireLoginSession }`; `requireLoginSession(req, res, next)` antwortet `403 { code: 403, message: "This action requires a signed-in session" }`, wenn `req.apiKey` gesetzt ist, `req.session` fehlt oder `req.session.impersonatorId` gesetzt ist. Genutzt von Task 5 (Reveal), Task 6 (`POST /approvals/:id`), Task 8 (Einrichten, Bestätigen, Entziehen) und hier in `POST /api/accounts/api-keys` (`server/routes/apiKey.js`: wer impersoniert, legt keine dauerhaften Konto-Keys für das fremde Konto an).

**Design:** kein UI-Anteil.

**Tests:** 5 Tests in `agentAuth.test.js`, test-first (Spec-Tests 1 und 2 sind fester Vertrag), alle über die Naht `authenticate` mit echtem Express-Server, In-Memory-SQLite und echten Modellen `Account`, `Session`, `ApiKey`, `Entry`, `AuditLog` samt echtem `createAuditLog`. Die Quelladresse kommt über `X-Forwarded-For` bei `trust proxy = true` im Test-App. Gefakt: `utils/database` (In-Memory), `lib/vault/state` (`isVaultEnabled` schaltbar), `dns.promises.lookup` per `t.mock.method`. Keys werden über `validateApiKey` mit `raw: true` gelesen; fehlt der `afterFind`-Hook aus Task 1, kommt `allowedCidrs` als Text an und die CIDR-Fälle in Test 3 und 4 scheitern mit `403`.
1. Endgültiger Agenten-Key: `/api/entries`, `probe` und eine Reveal-Route → `403`; Vault aus → `401` wie ein ungültiger Key; Server inzwischen einem anderen Konto zugeordnet → `403`; nach diesen Abweisungen ist `lastUsedAt` noch leer; `/api/mcp` durch mit `req.agent` und gesetztem `lastUsedAt`; ein Konto-Key erreicht `/api/entries` weiter (Spec-Test 1).
2. `pending`-Key: `probe` durch von fremder Adresse ohne Audit; `/api/mcp` und `/api/entries` → `401` (Spec-Test 1, Einrichtung Schritt 1a).
3. IP-Bindung erlaubt: eigene Adresse, Hostname mit A- und AAAA-Eintrag (eine Auflösung für zwei Anfragen), IPv4-CIDR, IPv6-CIDR, `ipBinding: false` (Spec-Test 2).
4. Fremde Adresse (Docker-Gateway eines NAS): `403`, genau ein Audit je (Key, Adresse) über zwei Anfragen; nach Eintrag der Gateway-Adresse als `/32` durch (Spec-Test 2, Review Focus 3 Teil „ohne Übernahme 403“; die Übernahme per `confirm` testet Task 8).
5. `requireLoginSession` weist Impersonation (Sitzung aus `createSession(..., { impersonatorId })`) und Konto-Key ab, lässt die Login-Session durch; `POST /api/accounts/api-keys` (echter Router `routes/apiKey.js` im Test-App) antwortet der Impersonation `403`, der eigenen Sitzung `400` (fehlender Name, Wächter passiert); ein Audit aus der Impersonations-Sitzung trägt `details.impersonatorId`, das der anschließenden eigenen Sitzung nicht.
- Kein `ipBinding.test.js`: CIDR- und IPv6-Abgleich sind über die Naht abgedeckt (Tests 3 und 4); `isAddressAllowed` läuft in jedem dieser Fälle über `checkAgentIp` mit.
- Nicht getestet: Ablauf der Audit-Drossel nach 10 min und des DNS-Caches nach 60 s (Konstanten; ein Fake-`Date` im selben Prozess wie der HTTP-Server wäre unzuverlässig), die Weitergabe von `req.user.id` in `routes/users.js` (Weiterreichung), die SQL-Log-Schwärzung (Log-Ausgabe; manuelle Prüfung in Step 10). Die `Mcp-Session-Id` eines fremden Keys (Spec-Test 1, letzter Teil) testet Task 2.
- SEC-Abdeckung: SEC-TOKEN-01 (Bearer-Pfad, IP-Bindung — Tests 1–4; Query-Token des Zustandsstroms — Step 9/10), SEC-APIKEY-01 (Agenten-Keys gehasht und widerrufbar wie Konto-Keys, `pending` nur an `probe` — Test 2; Vergleich siehe Step 3), SEC-SESS-02 (Agenten-Key nur am MCP-Endpunkt, nur bei laufendem Vault und solange der Server zugänglich ist — Test 1), SEC-RBAC-01 und SEC-IDOR-01 vorbereitend über `requireLoginSession`, dazu kein Konto-Key-Anlegen aus Impersonation (Test 5), SEC-PII-01 (Impersonator in jedem Audit aus HTTP-Anfragen der Sitzung — Test 5), SEC-ERR-01 (Antworten ohne Interna, keine Auflösungsdetails in der `403`).

**Parallel:** Task 3, Task 9, Task 12, Task 13, Task 14 (Welle B; keine gemeinsamen Dateien).

- [ ] **Step 1: Write the failing test**

`server/lib/vault/__tests__/agentAuth.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const dns = require("node:dns");
const express = require("express");
const { Sequelize } = require("sequelize");

const db = new Sequelize({ dialect: "sqlite", storage: ":memory:", logging: false, query: { raw: true }, foreignKeys: false });
const fake = (path, exports) => {
    const resolved = require.resolve(path);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

const vault = { enabled: true };
fake("../../../utils/database", db);
fake("../state", { isVaultEnabled: () => vault.enabled });

const Account = require("../../../models/Account");
const ApiKey = require("../../../models/ApiKey");
const AuditLog = require("../../../models/AuditLog");
const Entry = require("../../../models/Entry");
const Session = require("../../../models/Session");
const { createAuditLog, AUDIT_ACTIONS } = require("../../../controllers/audit");
const { authenticate } = require("../../../middlewares/auth");
const { requireLoginSession } = require("../../../middlewares/requireLoginSession");
const { createSession } = require("../../../controllers/session");
const { createApiKey, generateToken, hashToken } = require("../../../controllers/apiKey");
const ipBinding = require("../ipBinding");

const REVEAL_PATH = "/api/vault/items/1/secrets/password";
const echo = (req, res) => res.json({ accountId: req.user.id, agent: req.agent ?? null });

const app = express();
app.set("trust proxy", true);
app.use("/api/mcp", authenticate, echo);
app.get("/api/vault/agent-keys/probe", authenticate, (req, res) => res.json({ seenIp: req.ip }));
app.use("/api/entries", authenticate, echo);
app.get(REVEAL_PATH, authenticate, requireLoginSession, echo);
app.use("/api/accounts/api-keys", require("../../../routes/apiKey"));
app.post("/api/audited", authenticate, async (req, res) => {
    await createAuditLog({ accountId: req.user.id, action: AUDIT_ACTIONS.VAULT_REVEAL, resource: "vault", details: { item: "nas-admin" } });
    res.json({});
});

const audits = () => AuditLog.findAll({ order: [["id", "ASC"]] });

let server;
let anna;
const servers = {};

const call = async (method, path, token, ip = "192.0.2.10") => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
        method, headers: { authorization: `Bearer ${token}`, "x-forwarded-for": ip },
    });
    return { status: response.status, body: await response.json() };
};

const agentKey = async (entry, values = {}) => {
    const token = generateToken();
    const key = await ApiKey.create({
        accountId: anna.id, name: `claude@${entry.name}`, tokenHash: hashToken(token), prefix: `${token.slice(0, 14)}…`,
        kind: "agent", pending: false, entryId: entry.id, agentType: "claude", ipBinding: true, allowedCidrs: null, ...values,
    });
    return { token, id: key.id };
};

test.before(async () => {
    await db.sync();
    anna = await Account.create({ firstName: "Anna", lastName: "Admin", username: "anna", password: "x" });
    const ssh = (name, ip) => Entry.create({ accountId: anna.id, type: "server", name, config: { ip, protocol: "ssh" } });
    servers.nas = await ssh("nas", "192.0.2.10");
    servers.dockerNas = await ssh("docker-nas", "192.0.2.20");
    servers.named = await ssh("named", "nas.lan");
    servers.handedOver = await ssh("handed-over", "192.0.2.40");
    server = await new Promise((resolve) => { const listening = app.listen(0, () => resolve(listening)); });
});

test.after(() => {
    server.closeAllConnections();
    server.close();
});

test.beforeEach(async () => {
    await AuditLog.destroy({ where: {} });
    ipBinding._resetForTests();
});

test("ein endgültiger Agenten-Key erreicht nur /api/mcp, nur bei laufendem Vault und zugänglichem Server; ein Konto-Key weiter alles (Spec-Test 1)", async (t) => {
    t.after(() => { vault.enabled = true; });
    const key = await agentKey(servers.nas);
    const handedOver = await agentKey(servers.handedOver);
    const lastUsedAt = async ({ id }) => (await ApiKey.findByPk(id)).lastUsedAt;

    for (const [method, path] of [["GET", "/api/entries"], ["GET", "/api/vault/agent-keys/probe"], ["GET", REVEAL_PATH]]) {
        const denied = await call(method, path, key.token);
        assert.deepStrictEqual(denied, { status: 403, body: { code: 403, message: "Agent keys can only access the MCP endpoint" } }, path);
    }

    vault.enabled = false;
    assert.deepStrictEqual(await call("POST", "/api/mcp", key.token),
        { status: 401, body: { message: "The provided API key is not valid" } }, "Vault aus: wie ein ungültiger Key");
    vault.enabled = true;

    await Entry.update({ accountId: 999 }, { where: { id: servers.handedOver.id } });
    assert.deepStrictEqual(await call("POST", "/api/mcp", handedOver.token, "192.0.2.40"),
        { status: 403, body: { code: 403, message: "The server of this agent key is no longer accessible" } });
    assert.deepStrictEqual([await lastUsedAt(key), await lastUsedAt(handedOver)], [null, null], "abgewiesene Anfragen setzen lastUsedAt nicht");

    const mcp = await call("POST", "/api/mcp", key.token);
    assert.deepStrictEqual([mcp.status, mcp.body.agent], [200, { keyId: key.id, entryId: servers.nas.id, agentType: "claude" }]);
    assert.notStrictEqual(await lastUsedAt(key), null);

    const accountKey = await createApiKey(anna.id, { name: "cli" });
    assert.strictEqual((await call("GET", "/api/entries", accountKey.token)).status, 200);
});

test("ein pending-Key passiert nur probe, dort ohne IP-Bindung (Spec-Test 1, Einrichtung 1a)", async () => {
    const key = await agentKey(servers.nas, { pending: true });

    const probe = await call("GET", "/api/vault/agent-keys/probe", key.token, "172.17.0.1");
    assert.deepStrictEqual([probe.status, probe.body], [200, { seenIp: "172.17.0.1" }]);

    assert.strictEqual((await call("POST", "/api/mcp", key.token)).status, 401);
    assert.strictEqual((await call("GET", "/api/entries", key.token)).status, 401);
    assert.strictEqual(await AuditLog.count(), 0);
});

test("die IP-Bindung lässt eigene Adressen, eingetragene Bereiche und gelöste Bindungen zu (Spec-Test 2)", async (t) => {
    const lookups = [];
    t.mock.method(dns.promises, "lookup", async (host, options) => {
        lookups.push([host, options]);
        return [{ address: "192.0.2.30", family: 4 }, { address: "2001:db8::30", family: 6 }];
    });

    const cases = [
        ["eigene Adresse, IP im Server-Eintrag", await agentKey(servers.nas), "192.0.2.10"],
        ["Hostname, A-Eintrag", await agentKey(servers.named), "192.0.2.30"],
        ["Hostname, AAAA-Eintrag", await agentKey(servers.named), "2001:db8::30"],
        ["zusätzlicher IPv4-Bereich", await agentKey(servers.nas, { allowedCidrs: ["198.51.100.0/24"] }), "198.51.100.7"],
        ["zusätzlicher IPv6-Bereich", await agentKey(servers.nas, { allowedCidrs: ["2001:db8:1::/64"] }), "2001:db8:1::5"],
        ["IP-Bindung aus", await agentKey(servers.nas, { ipBinding: false }), "203.0.113.9"],
    ];
    for (const [label, key, ip] of cases)
        assert.strictEqual((await call("POST", "/api/mcp", key.token, ip)).status, 200, label);

    assert.deepStrictEqual(lookups, [["nas.lan", { all: true }]], "eine Auflösung je Host innerhalb von 60 s");
    assert.strictEqual(await AuditLog.count(), 0);
});

test("fremde Adresse: 403 und ein Audit je Key und Adresse; die übernommene Gateway-Adresse gilt (Spec-Test 2, Review Focus 3)", async () => {
    const key = await agentKey(servers.dockerNas);

    for (let attempt = 0; attempt < 2; attempt++) {
        const denied = await call("POST", "/api/mcp", key.token, "172.17.0.1");
        assert.deepStrictEqual(denied, { status: 403, body: { code: 403, message: "This agent key is not allowed from this address" } });
    }
    assert.strictEqual((await call("POST", "/api/mcp", key.token, "172.17.0.2")).status, 403);

    assert.deepStrictEqual((await audits()).map((audit) => [audit.action, audit.accountId, audit.details.keyId, audit.details.ip]), [
        ["vault.agent_ip_denied", anna.id, key.id, "172.17.0.1"],
        ["vault.agent_ip_denied", anna.id, key.id, "172.17.0.2"],
    ]);

    await ApiKey.update({ allowedCidrs: ["172.17.0.1/32"] }, { where: { id: key.id } });
    assert.strictEqual((await call("POST", "/api/mcp", key.token, "172.17.0.1")).status, 200);
});

test("requireLoginSession weist Impersonation und Konto-Keys ab; Audits der Impersonation nennen den Impersonator", async () => {
    const ben = await Account.create({ firstName: "Ben", lastName: "User", username: "ben", password: "x" });
    const own = await Session.create({ accountId: ben.id, ip: "192.0.2.50", userAgent: "test" });
    const impersonated = await createSession(ben.id, "test", { impersonatorId: anna.id });
    const accountKey = await createApiKey(ben.id, { name: "cli" });

    assert.strictEqual((await call("GET", REVEAL_PATH, own.token)).status, 200);
    assert.deepStrictEqual(await call("GET", REVEAL_PATH, impersonated.token),
        { status: 403, body: { code: 403, message: "This action requires a signed-in session" } });
    assert.strictEqual((await call("GET", REVEAL_PATH, accountKey.token)).status, 403);

    assert.deepStrictEqual(await call("POST", "/api/accounts/api-keys", impersonated.token),
        { status: 403, body: { code: 403, message: "This action requires a signed-in session" } });
    assert.deepStrictEqual(await call("POST", "/api/accounts/api-keys", own.token),
        { status: 400, body: { message: "A name is required" } }, "eigene Sitzung passiert den Wächter");

    for (const token of [impersonated.token, own.token])
        assert.strictEqual((await call("POST", "/api/audited", token)).status, 200);
    assert.deepStrictEqual((await audits()).map((audit) => audit.details), [
        { item: "nas-admin", impersonatorId: anna.id },
        { item: "nas-admin" },
    ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/lib/vault/__tests__/agentAuth.test.js`
Expected: FAIL — `Error: Cannot find module '../../../middlewares/requireLoginSession'` (bzw. `'../ipBinding'`).

- [ ] **Step 3: Restrict and extend `server/controllers/apiKey.js`**

`createApiKey` Z. 32 vorher:

```js
    if (await ApiKey.count({ where: { accountId } }) >= 50)
```

nachher:

```js
    if (await ApiKey.count({ where: { accountId, kind: "account" } }) >= 50)
```

`listApiKeys` und `deleteApiKey` (Z. 61-73) nachher:

```js
const listApiKeys = async (accountId) => {
    const keys = await ApiKey.findAll({ where: { accountId, kind: "account" }, order: [["createdAt", "DESC"]] });
    return keys.map(serialize);
};

const deleteApiKey = async (accountId, id) => {
    const key = await ApiKey.findOne({ where: { id, accountId, kind: "account" } });
    if (!key) return { code: 404, message: "API key not found" };

    await ApiKey.destroy({ where: { id: key.id } });
    logger.system("API key deleted", { accountId, apiKeyId: id });
    return { success: true };
};

const touchApiKey = async (id) => {
    await ApiKey.update({ lastUsedAt: new Date() }, { where: { id } });
};
```

`validateApiKey` Z. 89 vorher:

```js
    await ApiKey.update({ lastUsedAt: new Date() }, { where: { id: key.id } });
```

nachher (Agenten-Keys stempelt `authenticate` erst nach seinen Prüfungen):

```js
    if (key.kind !== "agent") await touchApiKey(key.id);
```

`module.exports` (Z. 94-100) nachher:

```js
module.exports = {
    TOKEN_PREFIX,
    hashToken,
    generateToken,
    isApiKeyToken,
    createApiKey,
    listApiKeys,
    deleteApiKey,
    touchApiKey,
    validateApiKey,
};
```

SEC-APIKEY-01, Vergleich: `validateApiKey` sucht per `tokenHash = SHA-256(token)` in der Datenbank. Der Angreifer steuert damit nur die Eingabe des Hashs, nicht dessen Präfix; Zeitunterschiede im Index-Vergleich verraten keinen nutzbaren Teil eines gültigen Tokens. Bleibt unverändert; Agenten-Keys nutzen denselben Weg (`hashToken`, 256 Bit aus `generateToken`).

- [ ] **Step 4: Create `server/lib/vault/ipBinding.js`**

```js
const dns = require("node:dns");
const net = require("node:net");
const { normalizeIp } = require("../../utils/ip");

const RESOLVE_TTL_MS = 60 * 1000;
const DENIAL_AUDIT_INTERVAL_MS = 10 * 60 * 1000;
const MAX_TRACKED_DENIALS = 10000;

const resolved = new Map();
const deniedAt = new Map();

const familyOf = (ip) => ({ 4: "ipv4", 6: "ipv6" })[net.isIP(ip)];

const matchesCidr = (ip, cidr) => {
    const [network, prefixText, ...rest] = String(cidr).split("/");
    const family = familyOf(network);
    if (rest.length || !family || family !== familyOf(ip)) return false;
    const maxPrefix = family === "ipv4" ? 32 : 128;
    if (prefixText !== undefined && !/^\d{1,3}$/.test(prefixText)) return false;
    const prefix = prefixText === undefined ? maxPrefix : Number(prefixText);
    if (prefix > maxPrefix) return false;
    const list = new net.BlockList();
    list.addSubnet(network, prefix, family);
    return list.check(ip, family);
};

const resolveHostAddresses = async (host) => {
    if (!host || typeof host !== "string") return [];
    const name = host.trim();
    if (net.isIP(name)) return [normalizeIp(name)];

    const cached = resolved.get(name);
    if (cached && cached.expiresAt > Date.now()) return cached.addresses;

    const addresses = dns.promises.lookup(name, { all: true })
        .then((results) => results.map((result) => normalizeIp(result.address)), () => []);
    resolved.set(name, { addresses, expiresAt: Date.now() + RESOLVE_TTL_MS });
    return addresses;
};

const allowedCidrsOf = (apiKey) => (Array.isArray(apiKey.allowedCidrs) ? apiKey.allowedCidrs : []);

const recordDenial = async (apiKey, entry, ip) => {
    const key = `${apiKey.id}|${ip}`;
    const now = Date.now();
    if (deniedAt.get(key) > now - DENIAL_AUDIT_INTERVAL_MS) return;

    if (deniedAt.size >= MAX_TRACKED_DENIALS) {
        for (const [tracked, at] of deniedAt) if (at <= now - DENIAL_AUDIT_INTERVAL_MS) deniedAt.delete(tracked);
    }
    deniedAt.set(key, now);

    // Lazy like defaultAudit in lib/browser/tools.js: auth.js loads this module, and tests that fake
    // utils/database without define() load auth.js.
    const { createAuditLog, AUDIT_ACTIONS, RESOURCE_TYPES } = require("../../controllers/audit");
    await createAuditLog({
        accountId: apiKey.accountId,
        action: AUDIT_ACTIONS.VAULT_AGENT_IP_DENIED,
        resource: RESOURCE_TYPES.VAULT,
        details: { keyId: apiKey.id, agentType: apiKey.agentType, entryId: apiKey.entryId, entryName: entry?.name ?? null, ip },
        ipAddress: ip,
    });
};

const isAddressAllowed = async (apiKey, entry, rawIp) => {
    if (!apiKey.ipBinding) return true;

    const ip = normalizeIp(rawIp);
    if (!familyOf(ip)) return false;
    if (allowedCidrsOf(apiKey).some((cidr) => matchesCidr(ip, cidr))) return true;
    return (await resolveHostAddresses(entry?.config?.ip)).some((address) => matchesCidr(ip, address));
};

const checkAgentIp = async (apiKey, entry, rawIp) => {
    if (await isAddressAllowed(apiKey, entry, rawIp)) return true;

    await recordDenial(apiKey, entry, normalizeIp(rawIp));
    return false;
};

const _resetForTests = () => {
    resolved.clear();
    deniedAt.clear();
};

module.exports = { isAddressAllowed, checkAgentIp, matchesCidr, resolveHostAddresses, _resetForTests };
```

- [ ] **Step 5: Teach `authenticate` about agent keys**

`server/middlewares/auth.js` Z. 1-24 vorher:

```js
const Account = require("../models/Account");
const Session = require("../models/Session");
const { isApiKeyToken, validateApiKey } = require("../controllers/apiKey");

module.exports.authenticate = async (req, res, next) => {
    const authHeader = req.header("authorization");
    if (!authHeader)
        return res.status(400).json({ message: "You need to provide the 'authorization' header" });

    const headerTrimmed = authHeader.split(" ");
    if (headerTrimmed.length !== 2)
        return res.status(400).json({ message: "You need to provide the token in the 'authorization' header" });

    const token = headerTrimmed[1];

    if (isApiKeyToken(token)) {
        const result = await validateApiKey(token);
        if (!result)
            return res.status(401).json({ message: "The provided API key is not valid" });

        req.apiKey = result.apiKey;
        req.user = result.account;
        return next();
    }
```

nachher (Session-Zweig ab `req.session = await Session.findOne(...)` bis auf das abschließende `next()` unverändert, siehe unten):

```js
const Account = require("../models/Account");
const Session = require("../models/Session");
const Entry = require("../models/Entry");
const { isApiKeyToken, validateApiKey, touchApiKey } = require("../controllers/apiKey");
const { checkAgentIp } = require("../lib/vault/ipBinding");
const auditContext = require("../utils/auditContext");

const PROBE_PATH = "/api/vault/agent-keys/probe";
const INVALID_API_KEY = { message: "The provided API key is not valid" };

const pathOf = (req) => req.originalUrl.split("?")[0];
const isMcpPath = (path) => path === "/api/mcp" || path.startsWith("/api/mcp/");

const rejectAgentKey = async (req, apiKey) => {
    const { isVaultEnabled } = require("../lib/vault/state");
    if (!isVaultEnabled()) return { status: 401, body: INVALID_API_KEY };

    const path = pathOf(req);
    if (apiKey.pending)
        return req.method === "GET" && path === PROBE_PATH ? null : { status: 401, body: INVALID_API_KEY };

    if (!isMcpPath(path))
        return { status: 403, body: { code: 403, message: "Agent keys can only access the MCP endpoint" } };

    const { validateEntryAccess } = require("../controllers/entry");
    const entry = await Entry.findByPk(apiKey.entryId);
    if (!(await validateEntryAccess(apiKey.accountId, entry)).valid)
        return { status: 403, body: { code: 403, message: "The server of this agent key is no longer accessible" } };

    if (!(await checkAgentIp(apiKey, entry, req.ip)))
        return { status: 403, body: { code: 403, message: "This agent key is not allowed from this address" } };

    return null;
};

module.exports.authenticate = async (req, res, next) => {
    const authHeader = req.header("authorization");
    if (!authHeader)
        return res.status(400).json({ message: "You need to provide the 'authorization' header" });

    const headerTrimmed = authHeader.split(" ");
    if (headerTrimmed.length !== 2)
        return res.status(400).json({ message: "You need to provide the token in the 'authorization' header" });

    const token = headerTrimmed[1];

    if (isApiKeyToken(token)) {
        const result = await validateApiKey(token);
        if (!result)
            return res.status(401).json(INVALID_API_KEY);

        if (result.apiKey.kind === "agent") {
            const rejection = await rejectAgentKey(req, result.apiKey);
            if (rejection) return res.status(rejection.status).json(rejection.body);
            await touchApiKey(result.apiKey.id);
            req.agent = { keyId: result.apiKey.id, entryId: result.apiKey.entryId, agentType: result.apiKey.agentType };
        }

        req.apiKey = result.apiKey;
        req.user = result.account;
        return next();
    }
```

Ende des Session-Zweigs, Z. 33-37 vorher:

```js
    req.user = await Account.findByPk(req.session.accountId);
    if (req.user === null)
        return res.status(401).json({ message: "The account associated to the token is not registered" });

    next();
```

nachher:

```js
    req.user = await Account.findByPk(req.session.accountId);
    if (req.user === null)
        return res.status(401).json({ message: "The account associated to the token is not registered" });

    if (req.session.impersonatorId)
        return auditContext.run({ impersonatorId: req.session.impersonatorId }, next);

    next();
```

`state.js` (lädt `VaultSettings`) und `controllers/entry` lädt `rejectAgentKey` erst im Agenten-Zweig, wie `authenticateDownload` die Rechte-Module: `bookmarkRoutes.test.js` lädt `auth.js` mit einer Datenbank-Attrappe ohne `define()`.

`authenticateQuery` und `authenticateDownload` bleiben unverändert: Sie kennen nur Session-Tokens, ein Agenten-Key scheitert dort mit `401`. Dasselbe gilt für `wsAuth.resolveSessionToken` und `routes/state.js` — Agenten-Keys öffnen keine WebSockets.

- [ ] **Step 6: Create `server/middlewares/requireLoginSession.js`**

```js
const { sendError } = require("../utils/error");

const requireLoginSession = (req, res, next) => {
    if (req.apiKey || !req.session || req.session.impersonatorId)
        return sendError(res, 403, 403, "This action requires a signed-in session");
    next();
};

module.exports = { requireLoginSession };
```

`server/routes/apiKey.js`: `blockApiKeyAuth` bleibt lokal (nicht exportiert, Abweichung 2 im Plan-Kopf); nur `POST /` bekommt zusätzlich `requireLoginSession`, damit niemand während einer Impersonation einen dauerhaften Konto-Key für das fremde Konto anlegt. `GET /` und `DELETE /:id` bleiben unverändert.

Z. 2 vorher:

```js
const { authenticate } = require("../middlewares/auth");
```

nachher:

```js
const { authenticate } = require("../middlewares/auth");
const { requireLoginSession } = require("../middlewares/requireLoginSession");
```

Z. 36 vorher:

```js
app.post("/", authenticate, blockApiKeyAuth, async (req, res) => {
```

nachher (Konto-Keys erhalten weiter die bisherige Meldung von `blockApiKeyAuth`):

```js
app.post("/", authenticate, blockApiKeyAuth, requireLoginSession, async (req, res) => {
```

- [ ] **Step 7: Mark impersonation sessions and name the impersonator in every HTTP audit**

`server/controllers/session.js` Z. 12-21 nachher:

```js
module.exports.createSession = async (accountId, userAgent, { impersonatorId = null } = {}) => {
    const account = await Account.findByPk(accountId);

    if (account === null)
        return { code: 102, message: "The provided account does not exist" };

    const session = await Session.create({ accountId, ip: "Admin", userAgent, impersonatorId });

    return { token: session.token };
}
```

`server/routes/users.js` Z. 63 vorher:

```js
    const account = await createSession(req.params.accountId, req.headers["user-agent"]);
```

nachher:

```js
    const account = await createSession(req.params.accountId, req.headers["user-agent"], { impersonatorId: req.user.id });
```

`server/utils/auditContext.js` (`authenticate` öffnet den Kontext, siehe Step 5):

```js
module.exports = new (require("node:async_hooks").AsyncLocalStorage)();
```

`server/controllers/audit.js` — Import nach Z. 14 (`const { normalizeIp } = require("../utils/ip");`):

```js
const auditContext = require("../utils/auditContext");
```

`createAuditLog` vorher (heute Z. 211-216):

```js
        if (organizationId) {
            const settings = await getOrgAuditSettings(organizationId);
            if (!shouldAudit(action, settings)) return;
        }

        const auditLog = await AuditLog.create({
```

nachher:

```js
        if (organizationId) {
            const settings = await getOrgAuditSettings(organizationId);
            if (!shouldAudit(action, settings)) return;
        }

        const impersonatorId = auditContext.getStore()?.impersonatorId;
        if (impersonatorId && details?.impersonatorId == null) details = { ...details, impersonatorId };

        const auditLog = await AuditLog.create({
```

- [ ] **Step 8: Run test to verify it passes**

Run: `node --test server/lib/vault/__tests__/agentAuth.test.js`
Expected: PASS — `# pass 5`, `# fail 0`.

- [ ] **Step 9: SEC-TOKEN-01 — Token aus dem SQL-Log halten**

Befund der Prüfung (im Commit festhalten):
- Es gibt keinen Request-Logger: kein `morgan`/`express-winston` in `package.json`, keine Middleware in `server/index.js`, die URLs schreibt; `express-ws` loggt nicht. Die einzigen `req.originalUrl`-Logs (`routes/entryBookmarks.js:96`, `routes/bookmarks.js:61`) betreffen Pfade ohne Token. `?sessionToken=` aus `/api/ws/state` erreicht keinen Logger über die URL.
- Aber: Sequelize loggt jede Abfrage auf Stufe `debug` (`server/utils/database.js:34`, `:41`) und setzt `WHERE`-Werte inline ein, `INSERT`/`UPDATE` dagegen als `$1`. `routes/state.js:9` (`Session.findOne({ where: { token: sessionToken } })`), `middlewares/auth.js` (Bearer-Pfad), `wsAuth.js:27`, `routes/sftp.js:42`, `controllers/auth.js:67-68` und `controllers/deviceCode.js:67` landen damit bei `LOG_LEVEL=debug` als ``WHERE `sessions`.`token` = '<token>'`` im Log (geprüft mit Sequelize 6.37.8). Standard ist `LOG_LEVEL=system` (`Dockerfile.server:68`), dann wird nichts geschrieben.
- Maßnahme: Werte von Spalten namens `token` im SQL-Log schwärzen.

`server/utils/database.js` — nach `getCallerFromStack` (Z. 24) einfügen:

```js
const redactSql = (sql) => sql.replace(/(`token`\s*=\s*)'(?:[^'\\]|\\.|'')*'/g, "$1'[redacted]'");
const logSql = (msg) => logger.baseLogger.debug(redactSql(msg), { caller: getCallerFromStack() });
```

Z. 34 und Z. 41 vorher:

```js
        logging: (msg) => logger.baseLogger.debug(msg, { caller: getCallerFromStack() }),
```

nachher (beide Stellen):

```js
        logging: logSql,
```

- [ ] **Step 10: Manuell prüfen, dass kein Token im Debug-Log steht**

Run: `LOG_LEVEL=debug yarn dev`, im Browser anmelden, einmal neu laden (öffnet `/api/ws/state?sessionToken=…`), dann:
`grep -c "\`token\` = '[0-9a-f]" data/logs/$(date +%F).log`
Expected: `0`. Gegenprobe: `grep -c "\`token\` = '\[redacted\]'" data/logs/$(date +%F).log` liefert mindestens `1`.

- [ ] **Step 11: Run the affected existing tests**

`middlewares/auth.js` lädt jetzt `models/Entry`, `lib/vault/ipBinding` und `utils/auditContext`; `bookmarkRoutes.test.js` lädt `auth.js` mit einer Datenbank-Attrappe ohne `define()` (deshalb laden `ipBinding.js` das Audit und `rejectAgentKey` `state.js` und `controllers/entry` erst bei Bedarf). `apiKeyPrefix.test.js` nutzt `createApiKey`, `oidcLogout.test.js` das `Session`-Modell, `browserAudit.test.js` lädt das echte `controllers/audit.js`.

Run: `node --test server/lib/__tests__/bookmarkRoutes.test.js server/lib/__tests__/apiKeyPrefix.test.js server/lib/__tests__/oidcLogout.test.js server/lib/__tests__/browserSocketAuth.test.js server/lib/__tests__/browserAudit.test.js`
Expected: PASS, `# fail 0`.

- [ ] **Step 12: Commit**

```bash
git add server/middlewares/auth.js server/lib/vault/ipBinding.js server/controllers/apiKey.js server/controllers/session.js server/routes/users.js server/middlewares/requireLoginSession.js server/routes/apiKey.js server/utils/auditContext.js server/controllers/audit.js server/utils/database.js server/lib/vault/__tests__/agentAuth.test.js
git commit -m "Vault: Agenten-Keys nur am MCP-Endpunkt mit Vault-, Server- und IP-Prüfung, Login-Session-Pflicht (auch für neue Konto-Keys), Impersonator in HTTP-Audits, Token aus dem SQL-Log"
```

---

### Task 9: Browser II: Schwärzung und Sperren

**Files:**
- Create: `server/lib/browser/vaultGuard.js`
- Modify: `server/lib/browser/snapshot.js` (`MAX_TEXT` Z. 9, `describe` Z. 68-87, `buildSnapshot` Z. 89 und Z. 99, `module.exports` Z. 114)
- Modify: `server/lib/browser/BrowserSession.js` (Require Z. 6, `snapshot()` Z. 222-225, `type()` Z. 237-242, `screenshot()` Z. 257-267, `evaluate()` Z. 269-274 plus neue `readyState()`, `containsText()`, `#evaluate()`; Task 7 ändert dort keine Zeilenzahl)
- Modify: `server/lib/browser/actions.js` (`typeText` Z. 95-103: Option `clearWithoutSelection`; `module.exports` Z. 126: zusätzlich `parseKey`, `MODIFIERS`)
- Modify: `server/lib/browser/tools.js` (Requires, `formatSessions`/`errorResult`/`pageResult` Z. 62-68, `recordBrowserAudit` Z. 72-80 — beide nach Task 7 unverschoben, in `createBrowserTools`: `act`, `waitFor`-Prüfungen `load`/`text`, `catch` in `browser_open`, `browser_list`, `call`)
- Modify: `server/lib/browser/index.js` (Z. 3 Require, vor Z. 17: `pool.onContextEnded(vaultGuard.forgetContext)`)
- Modify: `server/lib/browser/__tests__/tools.test.js` (Fake-Pool: `get`)
- Create: `server/lib/browser/__tests__/vaultGuard.test.js`
- Modify: `server/lib/browser/__tests__/chromium.e2e.test.js` (ein neuer Test am Dateiende nach Z. 102; Requires, Testseite und Wert stehen im Testkörper, damit die Einfügungen von Task 11 nach Z. 8 und Z. 22 und dessen Namen `SECRET`/`createBrowserTools` auf Dateiebene gültig bleiben)

**Interfaces:**
- Consumes:
  - Task 1: `encryptValue(plaintext, aad) → { encrypted: Buffer, iv, authTag }`, `decryptValue({ encrypted, iv, authTag }, aad) → string` aus `server/lib/vault/crypto.js`; `VaultError`, `VaultErrorCode.SESSION_TAINTED`, `.EVALUATE_LOCKED`, `.SCREENSHOT_LOCKED`, `.INPUT_LOCKED` (`"vault.input_locked"`) aus `server/lib/vault/errors.js`; Audit-Aktionen `vault.evaluate_locked`, `vault.screenshot_locked`, `vault.input_locked` (`AUDIT_ACTIONS.VAULT_INPUT_LOCKED`, Task 1, `resource: "browser"`); `new VaultError(VaultErrorCode.X)` nimmt den Standardtext aus `VaultErrorMessage` (Task 1), `vaultGuard.js` schreibt keine eigenen Meldungen.
  - Task 7: `session.contextKey`, `pool.get(id)`, `pool.listForCaller(…)`, `pool.onContextEnded(listener)`, `resolveSession(ctx, sessionId)` und `callerOf(ctx)` in `tools.js` (beide modulintern, `act` und `browser_list` nutzen sie), Pool-Record `contextKey`.
- Produces (`server/lib/browser/vaultGuard.js`, Zustand je `contextKey` im Prozess; von Task 11 genutzt):
  - `markTainted(contextKey) → void`; `isTainted(contextKey) → boolean`.
  - `markFilled(contextKey, { targetId: string, backendNodeIds: number[], secret: string }) → void` (`targetId` Pflicht, sonst `TypeError`; gefüllte Knoten gelten je Sitzung, eine Hauptframe-Navigation leert nur die Menge dieser Sitzung) — prüft im selben synchronen Schritt den Taint und wirft dann `VaultError(SESSION_TAINTED)`, ohne etwas zu merken; legt sonst die Kopie `encryptValue(secret, "vault:ctx:<contextKey>")` an und merkt die Knoten. Wirft, wenn `VAULT_KEY` fehlt (Fehler aus `encryptValue`). Task 11 ruft es unmittelbar vor dem ersten `Input.insertText`.
  - `isFilled(contextKey) → boolean`; `filledNodeIds(contextKey) → number[]`.
  - `redactText(contextKey | contextKey[], text) → string` — ersetzt den Wert jeder Kopie roh, mit `encodeURIComponent` und formular-kodiert (`application/x-www-form-urlencoded`, Leerzeichen als `+`) und whitespace-normalisiert (Folgen von Leerraum zu einem Leerzeichen, außen getrimmt, wie `document.title` und `innerText` sie zeigen) durch `••••`, längste Form zuerst, leere Formen ausgelassen; Nicht-Strings unverändert; lässt sich eine Kopie nicht entschlüsseln, ist das Ergebnis nur `••••`.
  - `forgetContext(contextKey) → void` (in `server/lib/browser/index.js` an `pool.onContextEnded` gehängt).
  - `assertEvaluateAllowed(session) → void` — markiert zuerst den Taint, wirft dann im befüllten Kontext `VaultError(EVALUATE_LOCKED)`; synchron.
  - `assertScreenshotAllowed(session) → Promise<void>` — wirft `VaultError(SCREENSHOT_LOCKED)`, wenn ein befüllter Knoten per `DOM.describeNode` noch existiert und `type` nicht `password` ist.
  - `assertInputAllowed(session, tool, args) → void` — synchron: `browser_click` mit `button: "middle"` wirft immer `VaultError(INPUT_LOCKED)` (Mittelklick fügt die primäre Auswahl ein, die alle Kontexte einer Instanz teilen); im befüllten Kontext auch `browser_key` mit Control, Meta oder Shift (außer genau `Shift+Tab`, Zerlegung mit `parseKey` aus `actions.js` wie beim Senden) und `browser_click` mit `clickCount > 1`. Andere Werkzeuge und Argumente passieren.
  - `findPasswordFieldIds(session) → Promise<number[]>` — `DOM.getFlattenedDocument({ depth: -1, pierce: true })`, alle `<input type=password>` (auch Same-Process-iframes, Shadow-DOM).
  - `_resetForTests()`.
  - `snapshot.js`: `buildSnapshot(nodes, refs, { redactBackendIds = new Set() } = {})`, Export `REDACTED = "••••"`.
  - `actions.js`: zusätzliche Exporte `parseKey(combo) → { key, code, keyCode, text, modifiers }` und `MODIFIERS` (unverändert, nur exportiert); `typeText(send, backendNodeId, text, { submit = false, clearWithoutSelection = false } = {})` — mit `clearWithoutSelection` leert es das Ziel nach dem Klick per `DOM.resolveNode` + `Runtime.callFunctionOn("function () { this.value = ''; }")` statt Strg+A (`selectAll`), dann `Input.insertText`; ohne die Option unverändert.
  - `BrowserSession`: `evaluate(expression)` geht durch `assertEvaluateAllowed`; neu `readyState() → Promise<string>` und `containsText(text) → Promise<boolean>` für `browser_wait` (eigene, feste Ausdrücke, setzen keinen Taint und sind im befüllten Kontext erlaubt; `containsText` sucht im mit `redactText` geschwärzten `innerText`, ein Teilstring des Werts ist also nicht zu finden); `type()` setzt `clearWithoutSelection: vaultGuard.isFilled(this.contextKey)` (nur für Textfelder, die Auswahl in `<select>` bleibt); `screenshot()` prüft unmittelbar vor `Page.captureScreenshot`; `snapshot()` schwärzt Passwortfelder und befüllte Knoten.
  - `tools.js`: `act` ruft `vaultGuard.assertInputAllowed(session, name, args)` als Erstes nach dem Auflösen der Sitzung, vor `runAgent`; `vault.evaluate_locked`, `vault.screenshot_locked` und `vault.input_locked` schreibt `act` ins Audit (`LOCK_AUDIT`, `details: { url, sessionId, tool }`); `call` reicht `VaultError` als `<Meldung> (<vault-Code>)` durch statt `INTERNAL` (wie `browser_fill_credential` in Task 11; `BrowserError` bleibt ohne Code); `recordBrowserAudit` filtert jeden String in `details` mit `redactText(session.contextKey, …)`. Task 11 schreibt diese drei Audit-Aktionen nicht noch einmal.

**Design:** kein UI-Anteil.

**Tests:** 7 Tests: 6 in `vaultGuard.test.js` über die Naht `createBrowserTools` + echter `BrowserPool` + echte `BrowserSession` mit `helpers/fakeCdp.js` (Spec-Test 8 und 12 im Kleinen, Review Focus 1), 1 in `chromium.e2e.test.js` gegen echtes Chromium; die Chromium-Reihe in Task 11 prüft das Ausfüllen selbst. (1) Snapshot schwärzt das Passwortfeld mit Nutzereingabe und das befüllte Feld nach dem Typwechsel auf `text`; Screenshot erlaubt, solange das Feld `password` ist, danach `vault.screenshot_locked` mit Audit und ohne Aufnahme. (2) Eine GET-Formular-URL mit dem Wert (formular-kodiert und mit `encodeURIComponent`) und ein Titel mit dem Rohwert erscheinen in `URL:`, `Title:`, `browser_list`, der Liste „Open sessions:“ eines anderen Aufrufers und im Audit (`details.url`) nur als `••••`; `browser_wait` auf `text` findet sichtbaren Text, ein Teilstring des Werts endet mit `TIMEOUT`; der Test hat keinen Vault-Eintrag, die Schwärzung lebt allein aus der Kontextkopie (der Fall „Werte nach `PATCH` gelöscht“ läuft in Task 11 gegen Chromium). (3) `browser_evaluate` im Popup eines befüllten Kontexts: `vault.evaluate_locked`, Audit, kein `Runtime.evaluate` erreicht die Seite. (4) `browser_evaluate` markiert den Kontext, bevor `Runtime.evaluate` gesendet wird, auch wenn der Ausdruck dann scheitert; ein anschließendes `markFilled` wirft `vault.session_tainted`; ein anderer Kontext bleibt sauber. (5) Kontextende: ein Popup allein beendet nichts, der Öffner beendet Kontext und Popups, `persistent` endet mit der letzten Sitzung, danach ist der Zustand weg. (6) Auswahlsperre: Mittelklick ist schon vor dem Ausfüllen gesperrt (Antwort endet auf `(vault.input_locked)`), `Control+a` und Doppelklick erst danach; im befüllten Kontext enden `Control+a`, `Shift+ArrowLeft`, `clickCount: 2` und Mittelklick mit `vault.input_locked`, Audit je Versuch, kein `Input.*`-Ereignis erreicht die Seite; `Shift+Tab` und ein einfacher Klick gehen weiter; `browser_type` sendet vor dem Ausfüllen wie bisher Strg+A mit `selectAll`, im befüllten Kontext kein `Input.dispatchKeyEvent` mit `selectAll`, sondern leert per `Runtime.callFunctionOn` und tippt dann. (7) Chromium (per `OUTPOST_BROWSER_E2E_LAUNCHER` zugeschaltet): `browser_type` in ein echtes Passwortfeld, `markFilled` direkt auf dessen Knoten, Screenshot erlaubt; nach „Show password“ zeigt der Snapshot `value="••••"`, Screenshot und `browser_evaluate` sind gesperrt, Audit ohne Wert. Nicht getestet: `redactText` je Kodierung einzeln (steckt in Test 2) und für die whitespace-normalisierte Form (ein Eintrag in `variantsOf`), `_resetForTests`, die Verdrahtung in `index.js` (eine Zeile Weiterreichung; der Test hängt `forgetContext` genauso an), die Exporte in `actions.js` (Weiterreichung), `clearWithoutSelection` einzeln in `actions.test.js` (steckt in Test 6). SEC-SECRET-01 (kein Wert in Antwort, Audit, Fehlermeldung, Auswahl oder Zwischenablage), SEC-ERR-01 (Fehlermeldungen gefiltert).

**Parallel:** Task 3, Task 4, Task 12, Task 13, Task 14 (Welle B; keine gemeinsamen Dateien — Task 3 und Task 4 fassen `server/lib/browser/` nicht an, Tasks 12–14 nur `client/`; setzt Task 1 und Task 7 aus Welle A voraus).

- [ ] **Step 1: Write the failing test**

`server/lib/browser/__tests__/vaultGuard.test.js`:

```js
process.env.VAULT_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

const test = require("node:test");
const assert = require("node:assert");
const { BrowserPool } = require("../BrowserPool");
const { createBrowserTools } = require("../tools");
const vaultGuard = require("../vaultGuard");
const { VaultErrorCode } = require("../../vault/errors");
const { createFakeCdp, flush } = require("./helpers/fakeCdp");

const SECRET = "p@ss word&1";

const textbox = (nodeId, name, backendDOMNodeId, value) => ({
    nodeId, role: { value: "textbox" }, name: { value: name }, childIds: [], parentId: "1", backendDOMNodeId, value: { type: "string", value },
});
const input = (backendNodeId, type) => ({ backendNodeId, localName: "input", nodeName: "INPUT", attributes: ["type", type] });

const setup = () => {
    vaultGuard._resetForTests();
    let targets = 0;
    let contexts = 0;
    const instances = [];
    const page = {
        ax: [
            { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Login" }, childIds: ["2", "3", "4"] },
            textbox("2", "Username", 31, "alice"),
            textbox("3", "Password", 32, "hunter2"),
            textbox("4", "Token", 33, SECRET),
        ],
        dom: [input(31, "text"), input(32, "password"), input(33, "password")],
        history: new Map(),
        evaluate: () => ({ result: { type: "string", value: "ok" } }),
    };
    const launcher = {
        async start({ key }) { return { key, port: 9300 }; },
        async stop() {},
        async endpoint(port) { return `ws://10.0.0.7:${port}/devtools/browser/x`; },
    };
    const connectCdp = async () => {
        const cdp = createFakeCdp({
            "Target.createBrowserContext": () => ({ browserContextId: `ctx-${++contexts}` }),
            "Target.createTarget": () => ({ targetId: `T${++targets}` }),
            "Target.attachToTarget": ({ targetId }) => ({ sessionId: `S-${targetId}` }),
            "Page.getNavigationHistory": (params, sessionId) => ({
                currentIndex: 0, entries: [{ id: 1, ...(page.history.get(sessionId) ?? { url: "https://login.test/", title: "Login" }) }],
            }),
            "Accessibility.getFullAXTree": () => ({ nodes: page.ax }),
            "DOM.getFlattenedDocument": () => ({ nodes: page.dom }),
            "DOM.describeNode": ({ backendNodeId }) => {
                const node = page.dom.find((n) => n.backendNodeId === backendNodeId);
                if (!node) throw new Error("No node with given id found");
                return { node };
            },
            "DOM.getContentQuads": { quads: [[0, 0, 20, 0, 20, 20, 0, 20]] },
            "DOM.resolveNode": ({ backendNodeId }) => ({ object: { objectId: `obj-${backendNodeId}` } }),
            "Page.getLayoutMetrics": { cssLayoutViewport: { clientWidth: 1280, clientHeight: 800 } },
            "Page.captureScreenshot": { data: "UE5H" },
            "Runtime.evaluate": (params) => page.evaluate(params),
        });
        instances.push(cdp);
        return cdp;
    };
    const pool = new BrowserPool({ getSettings: async () => ({ enabled: true, maxSessions: 10, idleMinutes: 30 }), launcher, connectCdp });
    pool.onContextEnded(vaultGuard.forgetContext);
    const audit = [];
    const tools = createBrowserTools({ getPool: () => pool, audit: async (entry) => { audit.push(entry); }, sleep: async () => {} });
    const agent = (transportId) => ({ accountId: 1, keyId: 41, agent: { keyId: 41, entryId: 7, agentType: "claude" }, transportId, ipAddress: "10.0.0.5", userAgent: "claude-code" });
    const login = (transportId) => ({ accountId: 1, keyId: null, agent: null, transportId, ipAddress: "10.0.0.9", userAgent: "firefox" });
    const text = (result) => result.content.map((c) => c.text ?? "").join("");
    const openSession = async (ctx) => pool.get(/^Session: (\S+)/m.exec(text(await tools.call("browser_open", { url: "https://login.test/" }, ctx)))[1]);
    const openPopup = async (opener, targetId) => {
        instances[0].emitEvent("Target.targetCreated", { targetInfo: { targetId, type: "page", openerId: opener.targetId } });
        await flush();
        return [...pool.sessions.values()].find((record) => record.session.targetId === targetId).session;
    };
    return { pool, tools, page, audit, instances, agent, login, text, openSession, openPopup };
};

test("a password field is masked in the snapshot, the user's own input too; a filled field stays masked and locks screenshots once it shows its value", async () => {
    const { tools, page, audit, instances, agent, text, openSession } = setup();
    const session = await openSession(agent("T"));
    vaultGuard.markFilled(session.contextKey, { backendNodeIds: [33], secret: SECRET });

    const shot = await tools.call("browser_screenshot", {}, agent("T"));
    assert.deepStrictEqual(shot.content, [{ type: "image", data: "UE5H", mimeType: "image/png" }], "a filled field that is still a password field is no reason to refuse");

    page.dom = [input(31, "text"), input(32, "password"), input(33, "text")];
    const snapshot = text(await tools.call("browser_snapshot", {}, agent("T")));
    assert.match(snapshot, /- textbox "Username" \[ref=e\d+\] value="alice"/);
    assert.match(snapshot, /- textbox "Password" \[ref=e\d+\] value="••••"/);
    assert.match(snapshot, /- textbox "Token" \[ref=e\d+\] value="••••"/);
    assert.ok(!snapshot.includes("hunter2") && !snapshot.includes("p@ss"));

    const captures = instances[0].callsOf("Page.captureScreenshot").length;
    const refused = await tools.call("browser_screenshot", {}, agent("T"));
    assert.strictEqual(refused.isError, true);
    assert.match(text(refused), /browser_screenshot is locked/);
    assert.strictEqual(instances[0].callsOf("Page.captureScreenshot").length, captures);
    assert.deepStrictEqual(audit.filter((e) => e.action === "vault.screenshot_locked").map((e) => e.details.tool), ["browser_screenshot"]);
});

test("a GET form that put the filled password into the URL leaks it neither to URL:, Title:, browser_list, the open-sessions list nor the audit log, with only the context copy to go by", async () => {
    const { pool, tools, page, audit, instances, agent, login, text, openSession } = setup();
    const filled = await openSession(agent("T"));
    await pool.open({ accountId: 1, url: "https://other.test/", origin: "user" });
    vaultGuard.markFilled(filled.contextKey, { backendNodeIds: [33], secret: SECRET });

    page.history.set(filled.cdpSessionId, {
        url: "https://login.test/done?user=alice&pw=p%40ss+word%261&echo=p%40ss%20word%261",
        title: `Welcome ${SECRET}`,
    });
    instances[0].emitEvent("Page.frameNavigated", { frame: { id: filled.targetId, url: "https://login.test/done" } }, filled.cdpSessionId);
    await flush();
    page.evaluate = () => ({ result: { type: "string", value: `Welcome ${SECRET}\nSigned in` } });

    const snapshot = text(await tools.call("browser_snapshot", {}, agent("T")));
    const outputs = [
        snapshot,
        text(await tools.call("browser_click", { ref: /Username" \[ref=(e\d+)\]/.exec(snapshot)[1] }, agent("T"))),
        text(await tools.call("browser_list", {}, agent("T"))),
        text(await tools.call("browser_snapshot", { sessionId: "browser-unknown" }, login("L"))),
        text(await tools.call("browser_wait", { condition: "text", value: "Signed in", timeoutMs: 1 }, agent("T"))),
    ];
    assert.match(outputs[0], /^URL: https:\/\/login\.test\/done\?user=alice&pw=••••&echo=••••$/m);
    assert.match(outputs[0], /^Title: Welcome ••••$/m);
    assert.match(outputs[3], /Open sessions:[\s\S]*pw=••••/);
    assert.match(outputs[4], /^Title: Welcome ••••$/m, "browser_wait finds visible text");
    const probe = await tools.call("browser_wait", { condition: "text", value: "ss wo", timeoutMs: 1 }, agent("T"));
    assert.strictEqual(probe.isError, true);
    assert.strictEqual(text(probe), 'Condition text "ss wo" not met within 1 ms', "a part of the filled value is not on the page for browser_wait");
    for (const leaked of ["p@ss", "%40ss", "word&1", "word%261"]) {
        assert.ok(outputs.every((output) => !output.includes(leaked)), `${leaked} reached the agent`);
        assert.ok(!JSON.stringify(audit).includes(leaked), `${leaked} reached the audit log`);
    }
    assert.ok(audit.some((e) => e.action === "browser.click" && e.details.url.includes("pw=••••")));
});

test("after a fill, browser_evaluate is refused in every session of the context, a popup included, before anything reaches the page", async () => {
    const { tools, page, audit, instances, agent, text, openSession, openPopup } = setup();
    const opener = await openSession(agent("T"));
    const popup = await openPopup(opener, "POP");
    vaultGuard.markFilled(opener.contextKey, { backendNodeIds: [33], secret: SECRET });
    let sent = 0;
    page.evaluate = () => {
        sent++;
        return { result: { type: "string", value: "ok" } };
    };

    const refused = await tools.call("browser_evaluate", { sessionId: popup.id, expression: "document.querySelector('input').value" }, agent("T"));
    assert.strictEqual(refused.isError, true);
    assert.match(text(refused), /browser_evaluate is locked/);
    assert.strictEqual(sent, 0);
    assert.strictEqual(instances[0].callsOf("Runtime.evaluate", popup.cdpSessionId).length, 0);
    assert.deepStrictEqual(audit.filter((e) => e.action === "vault.evaluate_locked").map((e) => e.details.sessionId), [popup.id]);
});

test("browser_evaluate marks its context before the expression is sent, also when the expression then fails, and a later fill there is refused", async () => {
    const { tools, page, agent, openSession, openPopup } = setup();
    const opener = await openSession(agent("T"));
    const popup = await openPopup(opener, "POP");
    const other = await openSession(agent("U"));
    const taintedWhenSent = [];
    page.evaluate = () => {
        taintedWhenSent.push(vaultGuard.isTainted(opener.contextKey));
        return { exceptionDetails: { text: "Uncaught TypeError" } };
    };

    const failed = await tools.call("browser_evaluate", { sessionId: popup.id, expression: "window.opener.x()" }, agent("T"));
    assert.strictEqual(failed.isError, true);
    assert.deepStrictEqual(taintedWhenSent, [true]);
    assert.throws(() => vaultGuard.markFilled(opener.contextKey, { backendNodeIds: [33], secret: SECRET }),
        (err) => err.code === VaultErrorCode.SESSION_TAINTED);
    assert.strictEqual(vaultGuard.isTainted(other.contextKey), false, "another context stays clean");
});

test("the guard forgets a context when it ends: an ephemeral one with its opener, a persistent one with its last session", async () => {
    const { pool, agent, openSession, openPopup } = setup();
    const opener = await openSession(agent("T"));
    const first = await openPopup(opener, "POP1");
    const second = await openPopup(opener, "POP2");
    vaultGuard.markFilled(opener.contextKey, { backendNodeIds: [33], secret: SECRET });
    vaultGuard.markTainted(opener.contextKey);

    await pool.close(first.id, "test");
    await flush();
    assert.deepStrictEqual([vaultGuard.isFilled(opener.contextKey), vaultGuard.isTainted(opener.contextKey)], [true, true], "a popup closing ends nothing");

    await pool.close(opener.id, "test");
    await flush();
    assert.strictEqual(pool.get(second.id), null, "the popups end with the context");
    assert.deepStrictEqual([vaultGuard.isFilled(opener.contextKey), vaultGuard.isTainted(opener.contextKey)], [false, false]);
    assert.strictEqual(vaultGuard.redactText(opener.contextKey, SECRET), SECRET);

    const { session: p1 } = await pool.open({ accountId: 1, url: "https://a.test/", profile: "persistent" });
    const { session: p2 } = await pool.open({ accountId: 1, url: "https://b.test/", profile: "persistent" });
    vaultGuard.markTainted(p1.contextKey);
    await pool.close(p1.id, "test");
    await flush();
    assert.strictEqual(vaultGuard.isTainted(p2.contextKey), true);
    await pool.close(p2.id, "test");
    await flush();
    assert.strictEqual(vaultGuard.isTainted(p2.contextKey), false);
});

test("selecting text is locked once the context is filled and middle-click paste always; Shift+Tab, a plain click and browser_type without selection go on", async () => {
    const { tools, audit, instances, agent, text, openSession } = setup();
    const session = await openSession(agent("T"));
    const ref = /Username" \[ref=(e\d+)\]/.exec(text(await tools.call("browser_snapshot", {}, agent("T"))))[1];
    const locked = /^Selecting text and middle-click paste are locked in this session/;

    const early = await tools.call("browser_click", { ref, button: "middle" }, agent("T"));
    assert.strictEqual(early.isError, true);
    assert.match(text(early), locked, "middle-click pastes the selection another context may hold");
    assert.match(text(early), /\(vault\.input_locked\)$/, "the agent gets the code with the message");
    assert.ok(!(await tools.call("browser_key", { key: "Control+a" }, agent("T"))).isError, "before a fill, select-all is fine");
    assert.ok(!(await tools.call("browser_click", { ref, clickCount: 2 }, agent("T"))).isError);
    const callsDuring = async (call) => {
        const from = instances[0].calls.length;
        assert.ok(!(await call()).isError);
        return instances[0].calls.slice(from);
    };
    const selectsAll = (calls) => calls.some((c) => c.method === "Input.dispatchKeyEvent" && c.params.commands?.includes("selectAll"));
    assert.ok(selectsAll(await callsDuring(() => tools.call("browser_type", { ref, text: "bob" }, agent("T")))), "before a fill, browser_type selects as before");

    vaultGuard.markFilled(session.contextKey, { backendNodeIds: [33], secret: SECRET });
    const input = () => instances[0].calls.filter((c) => c.method.startsWith("Input.")).length;
    const before = input();
    for (const [tool, args] of [
        ["browser_key", { key: "Control+a" }],
        ["browser_key", { key: "Shift+ArrowLeft" }],
        ["browser_click", { ref, clickCount: 2 }],
        ["browser_click", { ref, button: "middle" }],
    ]) {
        const refused = await tools.call(tool, args, agent("T"));
        assert.strictEqual(refused.isError, true, `${tool} ${JSON.stringify(args)}`);
        assert.match(text(refused), locked);
    }
    assert.strictEqual(input(), before, "no input event reached the page");
    const typing = await callsDuring(() => tools.call("browser_type", { ref, text: "carol" }, agent("T")));
    assert.ok(!selectsAll(typing), "in a filled context browser_type clears without selecting");
    assert.deepStrictEqual(typing.filter((c) => c.method === "Runtime.callFunctionOn").map((c) => [c.params.objectId, c.params.functionDeclaration]),
        [["obj-31", "function () { this.value = ''; }"]]);
    assert.deepStrictEqual(typing.filter((c) => c.method === "Input.insertText").map((c) => c.params.text), ["carol"]);
    assert.ok(!(await tools.call("browser_key", { key: "Shift+Tab" }, agent("T"))).isError);
    assert.ok(!(await tools.call("browser_click", { ref }, agent("T"))).isError);
    assert.deepStrictEqual(audit.filter((e) => e.action === "vault.input_locked").map((e) => e.details.tool),
        ["browser_click", "browser_key", "browser_key", "browser_click", "browser_click"]);
});
```

`server/lib/browser/__tests__/chromium.e2e.test.js`, am Dateiende nach Z. 102 anhängen (mit einer Leerzeile davor):

```js
test("against a real Chromium: a filled field stays masked after Show password, and screenshot and evaluate lock",
    { skip: !LAUNCHER && "set OUTPOST_BROWSER_E2E_LAUNCHER and OUTPOST_BROWSER_E2E_PAGE_HOST" }, async (t) => {
        process.env.VAULT_KEY ??= "5a".repeat(32);
        const vaultGuard = require("../vaultGuard");
        const value = "guard pa55&word";
        const page = `<!doctype html><title>Guard</title>
<input id="pass" type="password" aria-label="Password">
<button type="button" onclick="const f = document.getElementById('pass'); f.type = f.type === 'password' ? 'text' : 'password'">Show password</button>`;
        const server = http.createServer((req, res) => {
            res.setHeader("content-type", "text/html");
            res.end(page);
        });
        await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
        t.after(() => server.close());
        const pool = new BrowserPool({
            getSettings: async () => ({ enabled: true, maxSessions: 4, idleMinutes: 30, callbackHost: PAGE_HOST }),
            launcher: createLauncherClient(async () => LAUNCHER),
            createVia: async () => { throw new Error("via is part of the manual acceptance"); },
        });
        t.after(() => {
            for (const instance of pool.live.values()) instance.cdp.close();
        });
        const audit = [];
        const tools = require("../tools").createBrowserTools({ getPool: () => pool, audit: async (entry) => { audit.push(entry); } });
        const ctx = { accountId: 1, keyId: null, agent: null, transportId: "E2E-GUARD", ipAddress: "127.0.0.1", userAgent: "e2e" };
        const text = (result) => result.content.map((c) => c.text ?? "").join("");

        const opened = text(await tools.call("browser_open", { url: `http://${PAGE_HOST}:${server.address().port}/` }, ctx));
        const session = pool.get(/^Session: (\S+)/m.exec(opened)[1]);
        const typed = text(await tools.call("browser_type", { ref: refOf(opened, 'textbox "Password"'), text: value }, ctx));
        assert.ok(!typed.includes("pa55"), "the typed password does not reach the snapshot");
        vaultGuard.markFilled(session.contextKey, { backendNodeIds: [session.refs.resolve(refOf(typed, 'textbox "Password"')).backendNodeId], secret: value });
        assert.strictEqual((await tools.call("browser_screenshot", {}, ctx)).content[0].type, "image", "the filled field is still a password field");

        const shown = text(await tools.call("browser_click", { ref: refOf(typed, 'button "Show password"') }, ctx));
        assert.match(shown, /- textbox "Password" \[ref=e\d+\] value="••••"/);
        assert.ok(!shown.includes("pa55"), "the value in plain text does not reach the snapshot");
        const shot = await tools.call("browser_screenshot", {}, ctx);
        assert.strictEqual(shot.isError, true);
        assert.match(text(shot), /browser_screenshot is locked/);
        const evaluated = await tools.call("browser_evaluate", { expression: "document.getElementById('pass').value" }, ctx);
        assert.strictEqual(evaluated.isError, true);
        assert.match(text(evaluated), /browser_evaluate is locked/);
        assert.deepStrictEqual(audit.filter((e) => e.action.startsWith("vault.")).map((e) => e.action), ["vault.screenshot_locked", "vault.evaluate_locked"]);
        assert.ok(!JSON.stringify(audit).includes("pa55"));
        await pool.close(session.id, "test");
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/lib/browser/__tests__/vaultGuard.test.js server/lib/browser/__tests__/chromium.e2e.test.js`
Expected: FAIL — `vaultGuard.test.js`: `Cannot find module '../vaultGuard'`; der neue Chromium-Test ist ohne `OUTPOST_BROWSER_E2E_LAUNCHER` übersprungen (mit Umgebung scheitert er am selben `require`).

- [ ] **Step 3: `buildSnapshot` schwärzt Werte nach `backendNodeId`**

`server/lib/browser/snapshot.js`, nach `const MAX_TEXT = 100;` (Z. 9):

```js
const REDACTED = "••••";
```

`describe` (Z. 68) Signatur und Wertzeile (Z. 81) nachher:

```js
const describe = (node, refs, options, redactBackendIds) => {
```

```js
    if (VALUE_ROLES.has(role) && value !== undefined && value !== "")
        line += ` value=${JSON.stringify(redactBackendIds.has(node.backendDOMNodeId) ? REDACTED : clip(value))}`;
```

`buildSnapshot` (Z. 89 und Z. 99):

```js
const buildSnapshot = (nodes, refs, { redactBackendIds = new Set() } = {}) => {
```

```js
            const line = describe(current, refs, options, redactBackendIds);
```

`module.exports` (Z. 114):

```js
module.exports = { RefTable, buildSnapshot, REDACTED };
```

- [ ] **Step 4: `vaultGuard.js` anlegen**

`server/lib/browser/vaultGuard.js`:

```js
const { encryptValue, decryptValue } = require("../vault/crypto");
const { VaultError, VaultErrorCode } = require("../vault/errors");
const { REDACTED } = require("./snapshot");
const { parseKey, MODIFIERS } = require("./actions");

const GONE = /No node (found|with given id)|detached from document/i;
const contexts = new Map();

const aadOf = (contextKey) => `vault:ctx:${contextKey}`;

const stateOf = (contextKey) => {
    if (!contexts.has(contextKey)) contexts.set(contextKey, { tainted: false, filled: false, nodeIds: new Set(), copies: [] });
    return contexts.get(contextKey);
};

const attributeOf = (node, name) => {
    const attributes = node.attributes ?? [];
    for (let i = 0; i + 1 < attributes.length; i += 2) if (attributes[i].toLowerCase() === name) return attributes[i + 1];
    return undefined;
};

const markTainted = (contextKey) => {
    stateOf(contextKey).tainted = true;
};

const isTainted = (contextKey) => contexts.get(contextKey)?.tainted === true;

const markFilled = (contextKey, { backendNodeIds, secret }) => {
    // Checked in the same synchronous step as the marking, like assertEvaluateAllowed: no evaluate can slip in between.
    if (isTainted(contextKey))
        throw new VaultError(VaultErrorCode.SESSION_TAINTED);
    const copy = encryptValue(String(secret), aadOf(contextKey));
    const state = stateOf(contextKey);
    state.filled = true;
    state.copies.push(copy);
    for (const id of backendNodeIds) state.nodeIds.add(id);
};

const isFilled = (contextKey) => contexts.get(contextKey)?.filled === true;

const filledNodeIds = (contextKey) => [...(contexts.get(contextKey)?.nodeIds ?? [])];

// document.title and innerText collapse runs of whitespace, so the value can show up in that form too.
const variantsOf = (secret) => [...new Set([
    secret,
    encodeURIComponent(secret),
    new URLSearchParams([["", secret]]).toString().slice(1),
    secret.replace(/\s+/g, " ").trim(),
])].filter(Boolean).sort((a, b) => b.length - a.length);

const redactText = (contextKeys, text) => {
    if (typeof text !== "string") return text;
    let result = text;
    for (const contextKey of [contextKeys].flat()) {
        for (const copy of contexts.get(contextKey)?.copies ?? []) {
            let secret;
            try {
                secret = decryptValue(copy, aadOf(contextKey));
            } catch {
                // Without the key the text cannot be checked, so none of it may leave.
                return REDACTED;
            }
            if (!secret) continue;
            for (const variant of variantsOf(secret)) result = result.split(variant).join(REDACTED);
        }
    }
    return result;
};

const forgetContext = (contextKey) => {
    contexts.delete(contextKey);
};

const assertEvaluateAllowed = (session) => {
    markTainted(session.contextKey);
    if (isFilled(session.contextKey))
        throw new VaultError(VaultErrorCode.EVALUATE_LOCKED);
};

const assertScreenshotAllowed = async (session) => {
    for (const backendNodeId of filledNodeIds(session.contextKey)) {
        let node;
        try {
            ({ node } = await session.agentSend("DOM.describeNode", { backendNodeId }));
        } catch (err) {
            if (GONE.test(err?.message ?? "")) continue;
            throw err;
        }
        if (attributeOf(node ?? {}, "type")?.toLowerCase() !== "password")
            throw new VaultError(VaultErrorCode.SCREENSHOT_LOCKED);
    }
};

const SELECTING = MODIFIERS.Control | MODIFIERS.Meta | MODIFIERS.Shift;

const assertInputAllowed = (session, tool, args) => {
    // Middle-click pastes the primary selection, which every context of the instance shares: a fill elsewhere may have put the value there.
    if (tool === "browser_click" && args.button === "middle")
        throw new VaultError(VaultErrorCode.INPUT_LOCKED);
    if (!isFilled(session.contextKey)) return;
    if (tool === "browser_click" && Math.trunc(Number(args.clickCount)) > 1)
        throw new VaultError(VaultErrorCode.INPUT_LOCKED);
    if (tool === "browser_key") {
        const { key, modifiers } = parseKey(args.key);
        if (modifiers & SELECTING && !(modifiers === MODIFIERS.Shift && key === "Tab"))
            throw new VaultError(VaultErrorCode.INPUT_LOCKED);
    }
};

const findPasswordFieldIds = async (session) => {
    const { nodes } = await session.agentSend("DOM.getFlattenedDocument", { depth: -1, pierce: true });
    return (nodes ?? [])
        .filter((node) => node.localName === "input" && attributeOf(node, "type")?.toLowerCase() === "password")
        .map((node) => node.backendNodeId);
};

const _resetForTests = () => contexts.clear();

module.exports = {
    markTainted, isTainted, markFilled, isFilled, filledNodeIds, redactText, forgetContext,
    assertEvaluateAllowed, assertScreenshotAllowed, assertInputAllowed, findPasswordFieldIds, _resetForTests,
};
```

`server/lib/browser/actions.js`, `typeText` (Z. 95-103) nachher:

```js
const typeText = async (send, backendNodeId, text, { submit = false, clearWithoutSelection = false } = {}) => {
    await click(send, backendNodeId);
    if (clearWithoutSelection) {
        // A selection of a filled field lands in the primary selection, which other contexts can paste.
        const { object } = await send("DOM.resolveNode", { backendNodeId });
        await send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: "function () { this.value = ''; }" });
    } else {
        // "commands" makes select-all work regardless of the platform's shortcut mapping.
        const selectAll = { key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: MODIFIERS.Control };
        await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...selectAll, commands: ["selectAll"] });
        await send("Input.dispatchKeyEvent", { type: "keyUp", ...selectAll });
    }
    await send("Input.insertText", { text: String(text) });
    if (submit) await pressKey(send, "Enter");
};
```

`module.exports` (Z. 126) nachher — die Sperre zerlegt Tastenkombinationen mit demselben Parser wie `pressKey`:

```js
module.exports = { clickablePoint, click, typeText, selectOption, pressKey, scroll, parseKey, MODIFIERS };
```

- [ ] **Step 5: `BrowserSession` — Snapshot, Eingabe, Screenshot, evaluate**

`server/lib/browser/BrowserSession.js`, nach `const actions = require("./actions");` (Z. 6):

```js
const vaultGuard = require("./vaultGuard");
```

`snapshot()` (Z. 222-225) nachher:

```js
    async snapshot() {
        // The accessibility tree does not know the input type; the DOM does.
        const [{ nodes }, passwordFieldIds] = await Promise.all([
            this.agentSend("Accessibility.getFullAXTree"),
            vaultGuard.findPasswordFieldIds(this),
        ]);
        const redactBackendIds = new Set([...passwordFieldIds, ...vaultGuard.filledNodeIds(this.contextKey)]);
        return buildSnapshot(nodes ?? [], this.refs, { redactBackendIds });
    }
```

`type()` (Z. 237-242) nachher — im befüllten Kontext leert `browser_type` das Feld ohne Auswahl:

```js
    async type(ref, text, options = {}) {
        const { backendNodeId, label, options: choices } = this.refs.resolve(ref);
        if (choices) await actions.selectOption(this.agentSend, backendNodeId, choices, text);
        else await actions.typeText(this.agentSend, backendNodeId, text, { ...options, clearWithoutSelection: vaultGuard.isFilled(this.contextKey) });
        return label;
    }
```

`screenshot()` (Z. 266), die letzte Zeile wird zu:

```js
        await vaultGuard.assertScreenshotAllowed(this);
        return (await this.agentSend("Page.captureScreenshot", params)).data;
```

`evaluate()` (Z. 269-274) ersetzen durch (zwischen `assertEvaluateAllowed` und dem Senden liegt kein `await`):

```js
    async evaluate(expression) {
        vaultGuard.assertEvaluateAllowed(this);
        return this.#evaluate(String(expression));
    }

    async readyState() {
        return this.#evaluate("document.readyState");
    }

    async containsText(text) {
        // Searching the redacted text: otherwise waiting for parts of the filled value would read it back guess by guess.
        const visible = vaultGuard.redactText(this.contextKey, await this.#evaluate("document.body?.innerText ?? ''"));
        return typeof visible === "string" && visible.includes(String(text));
    }

    async #evaluate(expression) {
        const { result, exceptionDetails } = await this.agentSend("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
        if (exceptionDetails)
            throw new BrowserError(BrowserErrorCode.EVALUATION_FAILED, exceptionDetails.exception?.description ?? exceptionDetails.text);
        return result?.value;
    }
```

- [ ] **Step 6: Werkzeuge — Textfilter, Eingabesperre, Sperr-Audit, `browser_wait` ohne Taint**

`server/lib/browser/tools.js`, nach `const { BrowserError, BrowserErrorCode } = require("./errors");`:

```js
const { VaultError, VaultErrorCode } = require("../vault/errors");
const vaultGuard = require("./vaultGuard");
```

`formatSessions`, `errorResult`, `pageResult` (Bestand Z. 62-68) ersetzen durch:

```js
// Each line is checked against its own session's context, whichever caller asks for the list.
const formatSessions = (sessions, pool) => sessions
    .map((s) => vaultGuard.redactText(pool.get(s.id)?.contextKey ?? [], `- ${s.id}  ${s.title || "(untitled)"}  ${s.url}`))
    .join("\n");
const errorResult = (err, pool) => {
    const list = err.details?.sessions?.length ? `\nOpen sessions:\n${formatSessions(err.details.sessions, pool)}` : "";
    const code = err instanceof VaultError ? ` (${err.code})` : "";
    return { isError: true, content: [{ type: "text", text: `${err.message}${code}${list}` }] };
};
const pageResult = (session, snapshot, note = "") =>
    textResult(vaultGuard.redactText(session.contextKey, `Session: ${session.id}\nURL: ${session.state.url}\nTitle: ${session.state.title}${note}\n\n${snapshot}`));
const redactError = (session, err) => {
    if (typeof err?.message === "string") err.message = vaultGuard.redactText(session.contextKey, err.message);
    return err;
};
const LOCK_AUDIT = Object.freeze({
    [VaultErrorCode.EVALUATE_LOCKED]: "vault.evaluate_locked",
    [VaultErrorCode.SCREENSHOT_LOCKED]: "vault.screenshot_locked",
    [VaultErrorCode.INPUT_LOCKED]: "vault.input_locked",
});
```

`recordBrowserAudit` (Bestand Z. 72-80), die `details`-Zeile wird zu:

```js
    details: Object.fromEntries(Object.entries({ url: auditUrl(session.state.url), sessionId: session.id, ...details })
        .map(([key, value]) => [key, vaultGuard.redactText(session.contextKey, value)])),
```

`act` in `createBrowserTools` nachher (Seitentexte in Fehlern, etwa ein `alert` mit dem Wert in `DIALOG_PENDING`, laufen durch denselben Filter; die Eingabesperre steht im `try`, damit ihr Audit über `LOCK_AUDIT` läuft, und vor `runAgent`, damit nichts die Seite erreicht):

```js
    const act = (name, fn) => async (args, ctx) => {
        const session = resolveSession(ctx, args.sessionId);
        try {
            vaultGuard.assertInputAllowed(session, name, args);
            return await session.runAgent(name, () => fn(session, args, ctx));
        } catch (err) {
            if (Object.hasOwn(LOCK_AUDIT, err?.code)) await record(ctx, session, LOCK_AUDIT[err.code], { tool: name });
            throw redactError(session, err);
        }
    };
```

`waitFor`, Prüfungen `load` und `text` (Bestand Z. 141-142) nachher — sonst setzte jedes `browser_wait` den Taint, und nach dem Ausfüllen wäre Warten auf `load` gesperrt:

```js
            load: async () => !session.state.loading && (await session.readyState()) === "complete",
            text: () => session.containsText(value),
```

`browser_open`, im `catch` die Zeile `throw err;` ersetzen durch:

```js
                throw redactError(session, err);
```

`browser_list` nachher:

```js
        browser_list: async (args, ctx) => {
            const open = getPool().listForCaller(callerOf(ctx));
            return textResult(open.length > 0 ? formatSessions(open, getPool()) : "No browser sessions are open.");
        },
```

`call`, im `catch` nachher:

```js
            } catch (err) {
                const known = err instanceof BrowserError || err instanceof VaultError;
                return errorResult(known ? err : new BrowserError(BrowserErrorCode.INTERNAL, err.message), getPool());
            }
```

`server/lib/browser/__tests__/tools.test.js`, im Fake-Pool vor `listForCaller` ergänzen (`formatSessions` schlägt den Kontext je Sitzung nach):

```js
        get: (id) => sessions.get(id) ?? null,
```

- [ ] **Step 7: Kontextende verdrahten**

`server/lib/browser/index.js`, nach `const { createEngineVia } = require("./proxy");` (Z. 3):

```js
const vaultGuard = require("./vaultGuard");
```

In `getBrowserPool`, vor `pool.reconcile();` (Z. 17):

```js
    pool.onContextEnded(vaultGuard.forgetContext);
```

- [ ] **Step 8: Run test to verify it passes**

Run: `node --test server/lib/browser/__tests__/vaultGuard.test.js`
Expected: PASS, 6 Tests.

Run (mit laufendem `outpost-browser`-Container): `OUTPOST_BROWSER_E2E_LAUNCHER=<Launcher-Adresse wie unter Einstellungen › Browser> OUTPOST_BROWSER_E2E_PAGE_HOST=<vom Container aus erreichbare Adresse dieses Rechners> node --test server/lib/browser/__tests__/chromium.e2e.test.js`
Expected: PASS, 2 Tests (der bestehende und der neue). Ohne Container bleibt der Lauf in Step 9 übersprungen; dann diesen Lauf in der Abnahme (Task 17) nachholen.

- [ ] **Step 9: Browser-Tests gegenprüfen**

Run: `node --test server/lib/browser/__tests__/*.test.js`
Expected: PASS (beide Chromium-Tests übersprungen ohne `OUTPOST_BROWSER_E2E_LAUNCHER`). `snapshot.test.js` und `snapshotStale.test.js` belegen, dass `buildSnapshot` ohne Optionen unverändert arbeitet; `sessionState.test.js` läuft mit dem zusätzlichen `DOM.getFlattenedDocument` (Fake antwortet `{}`); `tools.test.js` belegt, dass das Audit ohne befüllten Kontext unverändert bleibt.

- [ ] **Step 10: Commit**

```bash
git add server/lib/browser/vaultGuard.js server/lib/browser/snapshot.js server/lib/browser/actions.js server/lib/browser/BrowserSession.js server/lib/browser/tools.js server/lib/browser/index.js server/lib/browser/__tests__/tools.test.js server/lib/browser/__tests__/vaultGuard.test.js server/lib/browser/__tests__/chromium.e2e.test.js
git commit -m "Vault: Browser schwärzt Passwörter, sperrt evaluate, Screenshot und Textauswahl nach dem Ausfüllen und leert Felder dort ohne Auswahl"
```

---

### Task 12: Client — Vault-Seite und Eintrag-Dialog

**Files:**
- Modify: `client/src/pages/Vault/Vault.jsx` (Platzhalter aus Task 10 vollständig ersetzen; `index.js` aus Task 10 bleibt)
- Create: `client/src/pages/Vault/styles.sass`, `client/src/pages/Vault/vaultTypes.js`
- Create: `client/src/pages/Vault/components/VaultList/{index.js, VaultList.jsx, styles.sass}`
- Create: `client/src/pages/Vault/components/VaultDetail/{index.js, VaultDetail.jsx, SecretRow.jsx, styles.sass}`
- Create: `client/src/pages/Vault/components/VaultItemDialog/{index.js, VaultItemDialog.jsx, styles.sass}`
- Test: `client/src/pages/Vault/components/VaultDetail/__tests__/VaultDetail.test.jsx`, `client/src/pages/Vault/components/VaultItemDialog/__tests__/VaultItemDialog.test.jsx`

**Interfaces:**
- Consumes (Task 5, REST unter `/api/vault`, über `RequestUtil` relativ als `vault/…`):
  - `GET vault/items → { items: [{ id, ref, accountId, organizationId, ownerName, name, type, description, fields, approvalRequired, allServers, bindings: [{ kind, targetId, label }], secretFields: string[], lastUsedAt, canManage, canReveal, unreadable }] }` — nie Werte; `unreadable: true`, wenn ein gespeicherter Wert des Eintrags mit dem aktuellen `VAULT_KEY` nicht entschlüsselt werden konnte (Task 5 über `secrets.isUnreadable`).
  - `POST vault/items` body `{ organizationId?, name, type, description?, fields, secrets, approvalRequired, allServers, bindings }` → `201 { item }`.
  - `PATCH vault/items/:id` body `{ name, description, fields, secrets?, approvalRequired, allServers, bindings }` → `{ item, secretsCleared }`. Der Dialog schickt `secrets` nur mit mindestens einem neuen Wert und `description: null` zum Leeren.
  - `DELETE vault/items/:id → { success: true }`; `GET vault/items/:id/secrets/:field → { value }`.
  - Fehlerformen (laut Task 5): Namenskonflikt bei POST/PATCH → `409 { code: 409, message }`; Reveal bei Entschlüsselungsfehler → `422 { code: 422, message }`. `RequestUtil` wirft den Antwortkörper als Objekt, der Client prüft `error.code`. `bindings[].label` kann `null` sein (Ziel nicht mehr auflösbar) — der Client zeigt dann die ID.
  - `fields` je Typ: `login { username?, origins: string[] }`, `api_key { hosts: string[], headerName?, headerTemplate? }`, `ssh { username }`, `database { engine, host (Pflicht außer bei `sqlite`), port?: number, database, username? }`, `generic {}`; leere Strings schickt der Client nicht mit. Pflicht wie in Task 5 (`server/validations/vault.js`, `FIELDS`): `login.origins` und `api_key.hosts` mit mindestens einem Wert, `ssh.username`, `database.engine`, `database.database`, `database.host` außer bei `engine: "sqlite"`; solange eines fehlt, ist Speichern gesperrt (`missingFields`). Geheimwerte beim Anlegen: `login` `password`, `api_key` `token`, `ssh` `privateKey` oder `password`, `generic` `value` Pflicht; `database` `password` optional (Task 5 `CREATE_SECRETS`).
- Consumes (Task 10): `useVaultAvailable()` (`canManageOrgs`, `impersonating`), `Permission.VAULT_USE`, `TabSwitcher`/`IconInput` mit `dataUiId`, Route `/vault` + `client/src/pages/Vault/index.js`, alle `vault.*`-Schlüssel aus Task 10.
- Consumes (Bestand): `ServerContext` (`servers`-Baum aus `GET /entries/list`: Ordner `{ type: "folder", id, name, entries }`, Organisationen `{ type: "organization", id: "org-<id>", entries }`, Server `{ type: "server", id, name }`), `useTags()` (`tags: [{ id, name }]`), `getRequest("organizations") → [{ id, name }]`, `formatTimeAgo` (`common/utils/timeAgo.js`), `copyToClipboard` (`common/utils/clipboard.js`), `ActionConfirmDialog`, `DialogProvider`/`DialogCancelButton`, `SelectBox`, `ToggleSwitch`, `PageHeader`, `Button`.
- Produces (nur innerhalb von `pages/Vault`): `<VaultDetail item impersonating onEdit onDelete />`, `<VaultList items loading failed ownerEmpty selectedId onSelect canCreate onCreate />`, `<VaultItemDialog open onClose item owners defaultOwner onSaved />` (`owners: [{ value: "personal" | "org-<id>", label, organizationId }]`; mit neuem `key` je Öffnen gemountet), `vaultTypes.js` (`VAULT_TYPES`, `TYPE_KEYS`, `NAME_PATTERN`, `DB_ENGINES`, `ownerKey`, `isSecretMissing`, `missingFields`, `toFormFields`, `toPayloadFields`, `itemSubject`, `matchesSearch`, `detailRows`).

**Design:**
- Screen: `UI-VAULT` — Artboard `docs/design/mockups/ui-vault.html` — Anleitung `docs/design/guides/ui-vault.md`
- Zu bauende Elemente (Werte wörtlich übernehmen):

| ID | Element | Fachlicher Anker | Zustände | Copy |
|----|---------|------------------|----------|------|
| UI-VAULT-NEW | Neuer Eintrag | Öffnet den Eintrag-Dialog zum Anlegen. Nur sichtbar mit Recht vault.use oder vault.manage in mindestens einer Organisation. | default, disabled | — |
| UI-VAULT-SCOPE | Persönlich · Organisationen | Wechselt, wessen Einträge die Liste zeigt — die eigenen oder die einer Organisation. Ein Reiter je Besitzer. Nicht: server_folder, tag, item_type. | default, selected | — |
| UI-VAULT-SEARCH | Suchen | Filtert die Liste nach Name, Benutzer, Host, Ursprung und Beschreibung. Durchsucht nie geheime Werte. | default, empty | empty „Kein Eintrag passt zur Suche.“ |
| UI-VAULT-TYPES | Alle · Login · API-Key · SSH · Datenbank · Sonstiges | Filtert die Liste nach der Art der Zugangsdaten. Nicht: vault_owner, tag. | default, selected | — |
| UI-VAULT-LIST | Einträge | Die Vault-Einträge des gewählten Besitzers — je Zeile Typ-Icon, Name, darunter Benutzer oder Host; ein Schild-Kennzeichen, wenn eine Freigabe nötig ist. Nie ein geheimer Wert. Nicht: identity, api_key, server_entry, snippet. | default, selected, loading, empty, error | loading „Skeleton-Zeilen, keine Spinner.“ · empty „Noch keine Einträge. Zugangsdaten im Vault nutzen Agenten, ohne den Wert zu sehen. Neuer Eintrag“ · error „Vault nicht erreichbar. Seite neu laden.“ |
| UI-VAULT-DETAIL | Eintrag | Kopf des gewählten Eintrags — Name, Typ, Besitzer, Beschreibung — mit Bearbeiten und Löschen (nur mit Verwaltungsrecht). Nicht: identity, server_entry. | default, empty, error | empty „Eintrag links wählen.“ · error „Eintrag nicht lesbar — der Vault-Schlüssel passt nicht zu diesem Eintrag.“ |
| UI-VAULT-DETAIL-ACTIONS | Bearbeiten · Löschen | Bearbeiten öffnet den Eintrag-Dialog; Löschen fragt im Bestätigungsdialog nach und entfernt den Eintrag samt Werten und Bindungen. Nur mit Verwaltungsrecht (Besitzer persönlicher Einträge, vault.manage bei Organisationen); ohne das Recht nicht sichtbar. Nicht: vault_secret. | default, disabled, selected | disabled „ohne Verwaltungsrecht nicht sichtbar“ · selected „portal-login löschen? Agenten verlieren den Zugriff sofort.“ |
| UI-VAULT-DETAIL-FIELDS | Angaben | Die nicht geheimen Angaben des Eintrags je Typ — Login Benutzer und erlaubte Ursprünge, API-Key Hosts und Header, SSH Benutzer, Datenbank Engine, Host, Port, Datenbank, Benutzer. Nicht: vault_secret. | default | — |
| UI-VAULT-DETAIL-SECRET | Geheimer Wert | Je geheimem Feld eine Zeile mit genau zwölf Punkten, unabhängig von der Länge des Werts. Anzeigen und Kopieren nur für den Besitzer persönlicher Einträge oder mit vault.reveal, nie in einer Impersonations-Sitzung; sonst der Hinweis, dass der Wert nur für Agenten nutzbar ist. Ein angezeigter Wert verbirgt sich nach 30 Sekunden. Nicht: vault_item_fields, identity. | default, selected, disabled, success | selected „angezeigt, verbirgt sich in 30 s“ · disabled „nur für Agenten nutzbar“ · success „Kopiert“ |
| UI-VAULT-DETAIL-SCOPE | Gilt für | Für welche Server Agenten diesen Eintrag sehen — einzelne Server, Ordner mit Unterordnern, Tags oder alle Server. Nicht: vault_owner, permission. | default, empty | empty „Für keinen Server freigegeben — kein Agent sieht diesen Eintrag.“ |
| UI-VAULT-DETAIL-POLICY | Freigabe erforderlich | Ob jede Nutzung durch einen Agenten bestätigt werden muss, und wann der Eintrag zuletzt genutzt wurde. Nicht: permission, vault_binding. | default, disabled | disabled „Ohne Freigabe nutzbar“ |

- Screen: `UI-VAULT-DIALOG` — Artboard `docs/design/mockups/ui-vault-dialog.html` — Anleitung `docs/design/guides/ui-vault-dialog.md`
- Zu bauende Elemente (Werte wörtlich übernehmen):

| ID | Element | Fachlicher Anker | Zustände | Copy |
|----|---------|------------------|----------|------|
| UI-VAULT-DIALOG-TYPE | Typ | Art der Zugangsdaten — Login, API-Key, SSH, Datenbank, Sonstiges. Nur beim Anlegen wählbar, danach fest. Nicht: vault_owner. | default, disabled | disabled „nach dem Anlegen fest“ |
| UI-VAULT-DIALOG-OWNER | Besitzer | Wem der Eintrag gehört — dem eigenen Konto oder einer Organisation. Nur beim Anlegen wählbar. Nicht: vault_binding, server_folder. | default, disabled | disabled „nach dem Anlegen fest“ |
| UI-VAULT-DIALOG-FIELDS | Angaben | Name, Beschreibung und die nicht geheimen Angaben des gewählten Typs. Der Name ist die Kennung für Agenten, Kleinbuchstaben, Ziffern, Punkt, Bindestrich und Unterstrich. Nicht: vault_secret. | default, error | error „Name schon vergeben.“ |
| UI-VAULT-DIALOG-SECRET | Geheimer Wert | Eingabe der geheimen Felder des Typs. Beim Bearbeiten leer mit dem Hinweis, dass ein Wert gespeichert ist und leer lassen ihn behält. Nicht: vault_item_fields. | default, partial, error, empty | partial „gespeichert — leer lassen, um beizubehalten“ · error „Wert fehlt.“ · empty „Ziel geändert — gespeicherte Werte werden verworfen. Neu eingeben.“ |
| UI-VAULT-DIALOG-SCOPE | Gilt für | Auswahl, auf welchen Servern Agenten den Eintrag sehen — Server, Ordner (mit Unterordnern), Tags nur bei persönlichen Einträgen, oder Alle Server. Standard keine Auswahl. Nicht: vault_owner, permission. | default, empty, selected | empty „Für keinen Server freigegeben.“ · selected „Alle Server“ |
| UI-VAULT-DIALOG-APPROVAL | Freigabe erforderlich | Jede Nutzung durch einen Agenten muss im Outpost-Fenster bestätigt werden. Standard an. | default, selected | — |
| UI-VAULT-DIALOG-SAVE | Speichern | Legt den Eintrag an bzw. speichert Änderungen und schließt den Dialog; Beschriftung Erstellen beim Anlegen. | default, disabled, loading, error | loading „Speichere …“ · error „Speichern fehlgeschlagen.“ |

- Locator: jedes Element trägt `data-ui-id="<ID>"`. Zusätzlich `data-ui-id="UI-VAULT"` am Seiten-Wurzelknoten und `data-ui-id="UI-VAULT-DIALOG"` am Wurzel-`div` im `DialogProvider`. `UI-VAULT-DETAIL-SECRET` sitzt an jeder geheimen Zeile (`SecretRow`), `UI-VAULT-DETAIL-ACTIONS` am Wrapper der beiden Knöpfe (ohne Verwaltungsrecht nicht gerendert = Zustand `disabled`), `UI-VAULT-DIALOG-TYPE`/`-OWNER` am Wrapper um die `SelectBox`, `UI-VAULT-DIALOG-SAVE` am primären `Button` über `dataUiId`.
- Zustände im Code: LIST `loading` = drei Skeleton-Zeilen mit `aria-busy`, `empty` = Text + Knopf „Neuer Eintrag“ (nur mit Anlegerecht), `error` mit `role="alert"`; SEARCH `empty` als Hinweis unter dem Feld, sobald Typ/Suche alles herausfiltern; DETAIL `error` erscheint bei `item.unreadable` oder wenn Reveal mit `422` antwortet; SECRET `selected` = Klartext + „angezeigt, verbirgt sich in 30 s“, nach 30 s und beim Wechsel des Eintrags (Komponente mit `key` je Eintrag/Feld) wieder zwölf Punkte, `success` = „Kopiert“ 2 s + Toast; DIALOG-SECRET `partial` (gespeichertes Feld beim Bearbeiten: Platzhalter und Hilfetext), `empty` (Zielfeld `origins`/`hosts`/`host` geändert: Warnhinweis, Platzhalter „… eingeben“, Speichern gesperrt bis ein neuer Wert da ist), `error` „Wert fehlt.“ beim Anlegen ohne Wert; SAVE `loading` „Speichere …“ mit Spinner und gesperrt, `error` als Text neben dem Knopf; FIELDS `error` „Name schon vergeben.“ bei `409`.
- Tastatur: Seite `N` (Neuer Eintrag, nur mit Anlegerecht), `↑`/`↓` (Auswahl), `E` (Bearbeiten, nur `canManage`), `Esc` (schmal: zurück zur Liste) — nicht, solange ein Eingabefeld fokussiert oder ein Dialog (`.dialog-area`) offen ist; Dialog `Ctrl+Enter` speichert (`onKeyDown` am Dialog-Wurzelknoten).
- Schmal (`$mobile`, 768 px): eine Spalte; Tipp auf eine Zeile blendet die Liste aus und die Details ein, `PageHeader` zeigt dann `onBackClick` mit `ArrowLeft`.
- Icons (Lucide, nie farbig): Login `LogIn`, API-Key `KeyRound`, SSH `SquareTerminal`, Datenbank `Database`, Sonstiges `Lock`; Freigabe `Shield`/`ShieldOff`; Anzeigen `Eye`/`EyeOff`, Kopieren `Copy`/`Check`.
- Tokens: `--background`, `--lighter-background`, `--gray`, `--dark-gray`, `--primary`, `--primary-opacity`, `--subtext`, `--error`, `--warning`, `--success`, `--space-1…4`, `--radius-sm|md|lg`, `--type-title|body|caption|mono`, `--font-mono` (Sass über `@/common/styles/colors` und `@/common/styles/tokens`; Breakpoint `breakpoints.$mobile`). Keine Literale außer Layoutbreiten aus dem Artboard (20–26 rem Liste, 9 rem Labelspalte, 40 rem Dialog).

**Tests:** 5 Testfälle in 2 Dateien (4 Verhalten, (2) als `test.each` mit zwei Fällen), test-first (Verhalten steht in Spec und Manifest fest), über die Komponentengrenze mit gedoubeltem `RequestUtil` und echtem `en.json`:
- `VaultDetail.test.jsx`: (1) Anzeigen holt den Wert per `GET vault/items/5/secrets/password`, zeigt ihn mit Hinweis, nach 29,999 s noch, nach 30 s wieder zwölf Punkte (Fake-Uhr, `fireEvent`); (2) Tabelle mit zwei Fällen — ohne `canReveal` und in einer Impersonations-Sitzung: weder „Show“ noch „Copy“, Hinweis „usable by agents only“, keine Anfrage.
- `VaultItemDialog.test.jsx`: (3) Bearbeiten, Ursprung leeren → Zustand `empty`, Speichern gesperrt, mit neuem Passwort weiter gesperrt (Pflichtfeld `origins` fehlt); mit neuem Ursprung schickt `PATCH vault/items/5` neue `origins` und `secrets.password`; (4) Bearbeiten ohne Zieländerung schickt kein `secrets` (der gespeicherte Wert darf nicht durch einen leeren überschrieben werden).
Nicht getestet: Filter/Suche/Reiter, Tastenkürzel, Layout und schmale Ansicht, Liste und Löschen (Darstellung/Weiterreichung — prüft `/design-verify`), Zustand `error` bei `item.unreadable` (eine Bedingung auf ein Serverfeld), Rechteprüfungen des Servers (Task 5).
SEC: SEC-SECRET-01 (Wert nur auf Klick geholt, nur im Zustand der Zeile gehalten, nach 30 s und beim Wechsel verworfen, nie in Liste, Suche, Toast, Log oder URL; Dialog zeigt nie gespeicherte Werte, privater Schlüssel als `textarea` ohne Autovervollständigung); SEC-XSS-01 (alle Werte als React-Textknoten, kein `dangerouslySetInnerHTML`); SEC-RBAC-01/SEC-IDOR-01 nur als Spiegel über `canManage`/`canReveal`/`canManageOrgs`/`impersonating` — durchgesetzt wird in Task 5; SEC-INPUT-01 clientseitig nur als Hinweis (`NAME_PATTERN` und `missingFields` sperren Speichern), maßgeblich ist Joi in Task 5.

**Parallel:** Task 3, 4, 9, 13, 14 (Welle B; keine gemeinsamen Dateien; Task 12 fasst nur `client/src/pages/Vault/` an). Setzt Task 10 (Welle A) voraus; die REST-Form aus Task 5 (Welle C) steht im Vertrag oben fest, die Tests laufen gegen `requestDouble`.

- [ ] **Step 1: Write the failing test** — `client/src/pages/Vault/components/VaultDetail/__tests__/VaultDetail.test.jsx`

```jsx
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { VaultDetail } from "@/pages/Vault/components/VaultDetail/VaultDetail.jsx";
import { ToastProvider } from "@/common/contexts/ToastContext.jsx";
import { renderWithProviders } from "@/test/renderWithProviders.jsx";

const requestDouble = await vi.hoisted(async () => {
    const { createRequestDouble } = await import("@/test/requestDouble.js");
    return createRequestDouble();
});

vi.mock("@/common/utils/RequestUtil.js", () => requestDouble.asModule());

const MASK = "••••••••••••";

const item = {
    id: 5, ref: "portal-login", accountId: 1, organizationId: null, ownerName: null, name: "portal-login", type: "login",
    description: "", fields: { username: "ma.backes", origins: ["https://portal.example.com"] },
    approvalRequired: true, allServers: false, bindings: [], secretFields: ["password"], lastUsedAt: null,
    canManage: true, canReveal: true, unreadable: false,
};

const show = (shown, impersonating = false) => renderWithProviders(
    <VaultDetail item={shown} impersonating={impersonating} onEdit={() => {}} onDelete={() => {}} />,
    { providers: [ToastProvider] },
);

beforeEach(() => { requestDouble.reset(); });
afterEach(() => { vi.useRealTimers(); });

test("ein angezeigter Wert verbirgt sich nach 30 Sekunden wieder hinter zwölf Punkten", async () => {
    vi.useFakeTimers();
    requestDouble.stub("getRequest", "vault/items/5/secrets/password", { value: "Wn4-eTq8-Rz2x" });
    show(item);

    expect(screen.getByText(MASK)).toBeInTheDocument();
    // fireEvent instead of userEvent: userEvent schedules its own timers, which the fake clock would hold.
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Show" })); });
    expect(screen.getByText("Wn4-eTq8-Rz2x")).toBeInTheDocument();
    expect(screen.getByText("shown, hides in 30 s")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(29_999));
    expect(screen.getByText("Wn4-eTq8-Rz2x")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText("Wn4-eTq8-Rz2x")).not.toBeInTheDocument();
    expect(screen.getByText(MASK)).toBeInTheDocument();
});

test.each([
    ["ohne Anzeigerecht", { ...item, canReveal: false }, false],
    ["in einer Impersonations-Sitzung", item, true],
])("%s gibt es weder Anzeigen noch Kopieren, nur den Hinweis für Agenten", (_, shown, impersonating) => {
    show(shown, impersonating);

    expect(screen.queryByRole("button", { name: "Show" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy" })).not.toBeInTheDocument();
    expect(screen.getByText("usable by agents only")).toBeInTheDocument();
    expect(requestDouble.calls).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn --cwd client vitest run src/pages/Vault/components/VaultDetail`
Expected: FAIL — `Failed to resolve import "@/pages/Vault/components/VaultDetail/VaultDetail.jsx"`.

- [ ] **Step 3: Typ-Beschreibung** — `client/src/pages/Vault/vaultTypes.js` (neu)

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
        defaults: { hosts: "", headerName: "Authorization", headerTemplate: "Bearer {{secret}}" },
    },
    ssh: {
        labelKey: "vault.types.ssh", icon: IconSquareTerminal, secrets: ["privateKey", "password", "passphrase"], targets: [],
        defaults: { username: "" },
    },
    database: {
        labelKey: "vault.types.database", icon: IconDatabase, secrets: ["password"], targets: ["host"],
        defaults: { engine: "postgres", host: "", port: "", database: "", username: "" },
    },
    generic: { labelKey: "vault.types.other", icon: IconLock, secrets: ["value"], targets: [], defaults: {} },
};

export const TYPE_KEYS = Object.keys(VAULT_TYPES);

const LIST_FIELDS = ["origins", "hosts"];

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

export const toFormFields = (type, fields = {}) => Object.fromEntries(
    Object.entries({ ...VAULT_TYPES[type].defaults, ...fields })
        .filter(([key]) => key in VAULT_TYPES[type].defaults)
        .map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : value == null ? "" : String(value)]),
);

export const toPayloadFields = (formFields) => Object.fromEntries(Object.entries(formFields).flatMap(([key, value]) => {
    if (LIST_FIELDS.includes(key)) return [[key, value.split(/[\s,]+/).filter(Boolean)]];
    const trimmed = value.trim();
    if (!trimmed) return [];
    return [[key, key === "port" ? Number(trimmed) : trimmed]];
}));

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

- [ ] **Step 4: Geheime Zeile** — `client/src/pages/Vault/components/VaultDetail/SecretRow.jsx` (neu)

```jsx
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Eye as IconEye, EyeOff as IconEyeOff, Copy as IconCopy, Check as IconCheck } from "lucide-react";
import Button from "@/common/components/Button";
import { useToast } from "@/common/contexts/ToastContext.jsx";
import { getRequest } from "@/common/utils/RequestUtil.js";
import { copyToClipboard } from "@/common/utils/clipboard.js";

const MASK = "••••••••••••";
const HIDE_AFTER_MS = 30000;
const COPIED_MS = 2000;
const UNREADABLE = 422;

export const SecretRow = ({ itemId, field, canReveal, onUnreadable }) => {
    const { t } = useTranslation();
    const { sendToast } = useToast();
    const [value, setValue] = useState(null);
    const [copied, setCopied] = useState(false);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (value === null) return;
        const timer = setTimeout(() => setValue(null), HIDE_AFTER_MS);
        return () => clearTimeout(timer);
    }, [value]);

    useEffect(() => {
        if (!copied) return;
        const timer = setTimeout(() => setCopied(false), COPIED_MS);
        return () => clearTimeout(timer);
    }, [copied]);

    const fetchValue = async () => {
        setBusy(true);
        try {
            return (await getRequest(`vault/items/${itemId}/secrets/${field}`)).value;
        } catch (error) {
            if (error?.code === UNREADABLE) onUnreadable();
            else sendToast(t("common.error"), error?.message || t("vault.list.error"));
            return null;
        } finally {
            setBusy(false);
        }
    };

    const toggle = async () => {
        if (value !== null) {
            setValue(null);
            return;
        }
        const revealed = await fetchValue();
        if (revealed != null) setValue(revealed);
    };

    const copy = async () => {
        const revealed = await fetchValue();
        if (revealed == null) return;
        if (await copyToClipboard(revealed)) {
            setCopied(true);
            sendToast(t("common.success"), t("vault.secret.copied"));
        } else {
            sendToast(t("common.error"), t("vault.secret.copyFailed"));
        }
    };

    return (
        <div className="vault-secret" data-ui-id="UI-VAULT-DETAIL-SECRET">
            <span className="vault-secret-label">{t(`vault.secretFields.${field}`)}</span>
            <span className="vault-secret-value">{value ?? MASK}</span>
            {canReveal ? (
                <>
                    <Button icon={value === null ? IconEye : IconEyeOff} buttonType="button" disabled={busy}
                            title={t(value === null ? "vault.secret.show" : "vault.secret.hide")} onClick={toggle} />
                    <Button icon={copied ? IconCheck : IconCopy} buttonType="button" disabled={busy}
                            title={t("vault.secret.copy")} onClick={copy} />
                    {value !== null && <span className="vault-secret-hint">{t("vault.secret.revealed")}</span>}
                    {copied && <span className="vault-secret-hint vault-secret-hint--success">{t("vault.secret.copied")}</span>}
                </>
            ) : (
                <span className="vault-secret-hint">{t("vault.secret.agentOnly")}</span>
            )}
        </div>
    );
};
```

- [ ] **Step 5: Details** — `client/src/pages/Vault/components/VaultDetail/VaultDetail.jsx` (neu)

```jsx
import "./styles.sass";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pencil as IconPencil, Trash2 as IconTrash2, Shield as IconShield, ShieldOff as IconShieldOff, Lock as IconLock } from "lucide-react";
import Button from "@/common/components/Button";
import Icon from "@/common/components/Icon";
import ActionConfirmDialog from "@/common/components/ActionConfirmDialog";
import { formatTimeAgo } from "@/common/utils/timeAgo.js";
import { VAULT_TYPES, detailRows } from "../../vaultTypes.js";
import { SecretRow } from "./SecretRow.jsx";

export const VaultDetail = ({ item, impersonating, onEdit, onDelete }) => {
    const { t } = useTranslation();
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [unreadableId, setUnreadableId] = useState(null);

    if (!item) {
        return (
            <section className="vault-detail vault-detail--empty" data-ui-id="UI-VAULT-DETAIL">
                <p>{t("vault.detail.empty")}</p>
            </section>
        );
    }

    const type = VAULT_TYPES[item.type];
    const owner = item.organizationId ? item.ownerName : t("vault.scope.personal");
    const rows = detailRows(item);
    const lastUsed = item.lastUsedAt ? ` · ${t("vault.policy.lastUsed", { time: formatTimeAgo(item.lastUsedAt, t), interpolation: { escapeValue: false } })}` : "";

    return (
        <section className="vault-detail" data-ui-id="UI-VAULT-DETAIL">
            <header className="vault-detail-head">
                <div>
                    <h3>{item.name}</h3>
                    <div className="vault-detail-meta">
                        <Icon icon={type?.icon ?? IconLock} />
                        <span>{type ? t(type.labelKey) : item.type} · {owner}</span>
                    </div>
                    {item.description && <p className="vault-detail-description">{item.description}</p>}
                </div>
                {item.canManage && (
                    <div className="vault-detail-actions" data-ui-id="UI-VAULT-DETAIL-ACTIONS">
                        <Button text={t("vault.detail.edit")} icon={IconPencil} type="secondary" onClick={() => onEdit(item)} />
                        <Button text={t("vault.detail.delete")} icon={IconTrash2} type="danger" onClick={() => setConfirmOpen(true)} />
                    </div>
                )}
            </header>

            {(item.unreadable || unreadableId === item.id) && (
                <p className="vault-detail-error" role="alert">{t("vault.detail.error")}</p>
            )}

            {rows.length > 0 && (
                <div className="vault-detail-section" data-ui-id="UI-VAULT-DETAIL-FIELDS">
                    <h4>{t("vault.detail.fields")}</h4>
                    <dl className="vault-detail-fields">
                        {rows.map(([labelKey, value]) => (
                            <div key={labelKey}><dt>{t(labelKey)}</dt><dd>{value}</dd></div>
                        ))}
                    </dl>
                </div>
            )}

            {item.secretFields.length > 0 && (
                <div className="vault-detail-section">
                    <h4>{t("vault.detail.secrets")}</h4>
                    {item.secretFields.map((field) => (
                        <SecretRow key={`${item.id}:${field}`} itemId={item.id} field={field}
                                   canReveal={item.canReveal && !impersonating}
                                   onUnreadable={() => setUnreadableId(item.id)} />
                    ))}
                </div>
            )}

            <div className="vault-detail-section">
                <h4>{t("vault.detail.scope")}</h4>
                {item.allServers || item.bindings.length > 0 ? (
                    <ul className="vault-detail-chips" data-ui-id="UI-VAULT-DETAIL-SCOPE">
                        {item.allServers
                            ? <li>{t("vault.bindings.allServers")}</li>
                            : item.bindings.map((binding) => (
                                <li key={`${binding.kind}:${binding.targetId}`}>{t(`vault.bindings.${binding.kind}`)} {binding.label ?? binding.targetId}</li>
                            ))}
                    </ul>
                ) : (
                    <p className="vault-detail-hint" data-ui-id="UI-VAULT-DETAIL-SCOPE">{t("vault.bindings.empty")}</p>
                )}
            </div>

            <div className="vault-detail-section">
                <p className={`vault-detail-policy${item.approvalRequired ? "" : " vault-detail-policy--off"}`}
                   data-ui-id="UI-VAULT-DETAIL-POLICY">
                    <Icon icon={item.approvalRequired ? IconShield : IconShieldOff} />
                    {t(item.approvalRequired ? "vault.policy.required" : "vault.policy.notRequired")}{lastUsed}
                </p>
            </div>

            <ActionConfirmDialog open={confirmOpen} setOpen={setConfirmOpen} onConfirm={() => onDelete(item)}
                                 text={t("vault.detail.deleteConfirm", { name: item.name, interpolation: { escapeValue: false } })} />
        </section>
    );
};
```

`client/src/pages/Vault/components/VaultDetail/index.js` (neu):

```js
export { VaultDetail as default } from "./VaultDetail.jsx";
```

`client/src/pages/Vault/components/VaultDetail/styles.sass` (neu):

```sass
@use "@/common/styles/colors"
@use "@/common/styles/tokens"
@use "@/common/styles/breakpoints"

.vault-detail
  height: 100%
  overflow-y: auto

  &--empty
    display: flex
    align-items: center
    justify-content: center
    color: colors.$subtext

  .vault-detail-head
    display: flex
    align-items: flex-start
    justify-content: space-between
    gap: tokens.$space-3
    padding: tokens.$space-4
    border-bottom: 1px solid colors.$gray

    @media (max-width: breakpoints.$mobile)
      flex-direction: column
      padding: tokens.$space-3

    h3
      margin: 0 0 tokens.$space-1
      font: tokens.$type-title
      font-family: tokens.$font-mono

  .vault-detail-meta
    display: flex
    align-items: center
    gap: tokens.$space-2
    color: colors.$subtext
    font: tokens.$type-caption

    svg
      width: 1rem
      height: 1rem

  .vault-detail-description
    margin: tokens.$space-2 0 0
    color: colors.$subtext

  .vault-detail-actions
    display: flex
    gap: tokens.$space-2

  .vault-detail-error
    margin: 0
    padding: tokens.$space-3 tokens.$space-4
    color: colors.$error
    border-bottom: 1px solid colors.$gray

  .vault-detail-section
    padding: tokens.$space-3 tokens.$space-4
    border-bottom: 1px solid colors.$gray

    @media (max-width: breakpoints.$mobile)
      padding: tokens.$space-3

    h4
      margin: 0 0 tokens.$space-2
      font: tokens.$type-caption
      color: colors.$subtext

  .vault-detail-fields
    display: grid
    grid-template-columns: 9rem 1fr
    gap: tokens.$space-1 tokens.$space-3
    margin: 0

    @media (max-width: breakpoints.$mobile)
      grid-template-columns: 6rem 1fr

    div
      display: contents

    dt
      color: colors.$subtext

    dd
      margin: 0
      font: tokens.$type-mono
      word-break: break-all

  .vault-secret
    display: flex
    align-items: center
    flex-wrap: wrap
    gap: tokens.$space-2
    padding: tokens.$space-1 0

    .vault-secret-label
      width: 9rem
      color: colors.$subtext

      @media (max-width: breakpoints.$mobile)
        width: 6rem

    .vault-secret-value
      flex: 1
      min-width: 0
      font: tokens.$type-mono
      white-space: pre-wrap
      word-break: break-all

    .vault-secret-hint
      color: colors.$subtext
      font: tokens.$type-caption

      &--success
        color: colors.$success

  .vault-detail-chips
    display: flex
    flex-wrap: wrap
    gap: tokens.$space-2
    margin: 0
    padding: 0
    list-style: none

    li
      padding: tokens.$space-1 tokens.$space-2
      border: 1px solid colors.$gray
      border-radius: tokens.$radius-md
      background: colors.$lighter-background

  .vault-detail-hint
    margin: 0
    color: colors.$subtext

  .vault-detail-policy
    display: flex
    align-items: center
    gap: tokens.$space-2
    margin: 0

    svg
      width: 1rem
      height: 1rem

    &--off
      color: colors.$subtext
```

- [ ] **Step 6: Run test to verify it passes**

Run: `yarn --cwd client vitest run src/pages/Vault/components/VaultDetail`
Expected: PASS (3 Testfälle: 1 + 2 aus `test.each`).

- [ ] **Step 7: Write the failing test** — `client/src/pages/Vault/components/VaultItemDialog/__tests__/VaultItemDialog.test.jsx`

```jsx
import { beforeEach, expect, test, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VaultItemDialog } from "@/pages/Vault/components/VaultItemDialog/VaultItemDialog.jsx";
import { ServerContext } from "@/common/contexts/ServerContext.jsx";
import { TagContext } from "@/common/contexts/TagContext.jsx";
import { renderWithProviders } from "@/test/renderWithProviders.jsx";

const requestDouble = await vi.hoisted(async () => {
    const { createRequestDouble } = await import("@/test/requestDouble.js");
    return createRequestDouble();
});

vi.mock("@/common/utils/RequestUtil.js", () => requestDouble.asModule());

const item = {
    id: 5, ref: "portal-login", accountId: 1, organizationId: null, ownerName: null, name: "portal-login", type: "login",
    description: "", fields: { username: "ma.backes", origins: ["https://portal.example.com"] },
    approvalRequired: true, allServers: false, bindings: [], secretFields: ["password"], lastUsedAt: null,
    canManage: true, canReveal: true, unreadable: false,
};

const Targets = ({ children }) => (
    <ServerContext.Provider value={{ servers: [] }}>
        <TagContext.Provider value={{ tags: [] }}>{children}</TagContext.Provider>
    </ServerContext.Provider>
);

const editItem = () => renderWithProviders(
    <VaultItemDialog open onClose={() => {}} item={item} onSaved={() => {}} defaultOwner="personal"
                     owners={[{ value: "personal", label: "Personal (ma.backes)", organizationId: null }]} />,
    { providers: [Targets] },
);

beforeEach(() => {
    requestDouble.reset();
    requestDouble.stub("patchRequest", "vault/items/5", { item, secretsCleared: true });
});

test("ein geänderter Ursprung verwirft den gespeicherten Wert: Speichern erst mit neuem Passwort und Ursprung", async () => {
    const user = userEvent.setup();
    editItem();
    const save = screen.getByRole("button", { name: "Save" });
    expect(screen.getByLabelText("Password")).toHaveAttribute("placeholder", "stored — leave empty to keep");

    await user.clear(screen.getByLabelText("Origin"));

    expect(screen.getByText("Target changed — stored values will be discarded. Enter them again.")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toHaveAttribute("placeholder", "Enter Password");
    expect(save).toBeDisabled();

    await user.type(screen.getByLabelText("Password"), "Wn4-eTq8");
    expect(save).toBeDisabled();

    await user.type(screen.getByLabelText("Origin"), "https://login.example.com");
    await user.click(save);

    expect(requestDouble.calls).toEqual([{
        method: "patchRequest", path: "vault/items/5",
        body: expect.objectContaining({
            fields: { username: "ma.backes", origins: ["https://login.example.com"] },
            secrets: { password: "Wn4-eTq8" },
        }),
    }]);
});

test("ohne Zieländerung schickt Speichern kein leeres Geheimfeld mit, der gespeicherte Wert bleibt", async () => {
    const user = userEvent.setup();
    editItem();

    await user.clear(screen.getByLabelText("User"));
    await user.type(screen.getByLabelText("User"), "admin");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(requestDouble.calls).toHaveLength(1);
    expect(requestDouble.calls[0].body.fields).toEqual({ username: "admin", origins: ["https://portal.example.com"] });
    expect(requestDouble.calls[0].body).not.toHaveProperty("secrets");
});
```

- [ ] **Step 8: Run test to verify it fails**

Run: `yarn --cwd client vitest run src/pages/Vault/components/VaultItemDialog`
Expected: FAIL — `Failed to resolve import "@/pages/Vault/components/VaultItemDialog/VaultItemDialog.jsx"`.

- [ ] **Step 9: Eintrag-Dialog** — `client/src/pages/Vault/components/VaultItemDialog/VaultItemDialog.jsx` (neu)

```jsx
import "./styles.sass";
import { useContext, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
    KeyRound as IconKeyRound, Lock as IconLock, User as IconUser, Building2 as IconBuilding2, Globe as IconGlobe,
    Server as IconServer, Hash as IconHash, Database as IconDatabase, TextCursorInput as IconTextCursorInput,
    TextAlignStart as IconTextAlignStart,
} from "lucide-react";
import { DialogProvider, DialogCancelButton } from "@/common/components/Dialog";
import Button from "@/common/components/Button";
import Icon from "@/common/components/Icon";
import IconInput from "@/common/components/IconInput";
import SelectBox from "@/common/components/SelectBox";
import ToggleSwitch from "@/common/components/ToggleSwitch";
import { ServerContext } from "@/common/contexts/ServerContext.jsx";
import { useTags } from "@/common/contexts/TagContext.jsx";
import { patchRequest, postRequest } from "@/common/utils/RequestUtil.js";
import {
    DB_ENGINES, NAME_PATTERN, TYPE_KEYS, VAULT_TYPES, isSecretMissing, missingFields, ownerKey, toFormFields, toPayloadFields,
} from "../../vaultTypes.js";

const FIELD_INPUTS = {
    username: { labelKey: "vault.fields.username", icon: IconUser },
    origins: { labelKey: "vault.fields.origin", icon: IconGlobe },
    hosts: { labelKey: "vault.fields.hosts", icon: IconGlobe },
    headerName: { labelKey: "vault.fields.headerName", icon: IconTextCursorInput },
    headerTemplate: { labelKey: "vault.fields.headerTemplate", icon: IconTextCursorInput },
    host: { labelKey: "vault.fields.host", icon: IconServer },
    port: { labelKey: "vault.fields.port", icon: IconHash },
    database: { labelKey: "vault.fields.database", icon: IconDatabase },
};

const BINDING_KINDS = [["entry", "vault.bindings.addServer"], ["folder", "vault.bindings.addFolder"], ["tag", "vault.bindings.addTag"]];
const NO_BINDINGS = { entry: [], folder: [], tag: [] };

const groupBindings = (bindings = []) => ({
    entry: bindings.filter((b) => b.kind === "entry").map((b) => b.targetId),
    folder: bindings.filter((b) => b.kind === "folder").map((b) => b.targetId),
    tag: bindings.filter((b) => b.kind === "tag").map((b) => b.targetId),
});

const initialForm = (item, defaultOwner) => {
    const type = item?.type ?? "login";
    return {
        type,
        owner: item ? ownerKey(item) : defaultOwner,
        name: item?.name ?? "",
        description: item?.description ?? "",
        fields: toFormFields(type, item?.fields),
        approvalRequired: item?.approvalRequired ?? true,
        allServers: item?.allServers ?? false,
        bindings: groupBindings(item?.bindings),
    };
};

// Folders keep their path in the label, so two "Produktion" folders stay apart in the picker.
const collectTargets = (nodes, path = []) => nodes.flatMap((node) => {
    if (node.type === "folder") {
        const trail = [...path, node.name];
        return [{ kind: "folder", value: node.id, label: trail.join(" › ") }, ...collectTargets(node.entries || [], trail)];
    }
    return node.type === "server" ? [{ kind: "entry", value: node.id, label: node.name }] : [];
});

const ownerNodes = (servers, owner) => (owner === "personal"
    ? (servers || []).filter((node) => node.type !== "organization")
    : (servers || []).find((node) => node.type === "organization" && node.id === owner)?.entries || []);

// Mount with a fresh `key` per opening: the form is initialised from props once, not synced by an effect.
export const VaultItemDialog = ({ open, onClose, item = null, owners, defaultOwner, onSaved }) => {
    const { t } = useTranslation();
    const { servers } = useContext(ServerContext);
    const { tags } = useTags();
    const [form, setForm] = useState(() => initialForm(item, defaultOwner));
    const [pristine] = useState(() => JSON.stringify(initialForm(item, defaultOwner)));
    const [secrets, setSecrets] = useState({});
    const [showMissing, setShowMissing] = useState(false);
    const [saving, setSaving] = useState(false);
    const [failure, setFailure] = useState(null);

    const spec = VAULT_TYPES[form.type];
    const isEdit = item !== null;
    const payloadFields = toPayloadFields(form.fields);
    const storedFields = item ? toPayloadFields(toFormFields(item.type, item.fields)) : {};
    const targetChanged = isEdit && spec.targets.some((field) =>
        JSON.stringify(payloadFields[field] ?? null) !== JSON.stringify(storedFields[field] ?? null));
    const secretsMissing = isSecretMissing(form.type, secrets);
    const nameValid = NAME_PATTERN.test(form.name);
    const fieldsMissing = missingFields(form.type, payloadFields).length > 0;
    const saveBlocked = saving || !nameValid || fieldsMissing || (targetChanged && secretsMissing);

    const targets = useMemo(() => {
        const found = collectTargets(ownerNodes(servers, form.owner));
        const options = {
            entry: found.filter((target) => target.kind === "entry"),
            folder: found.filter((target) => target.kind === "folder"),
            tag: (tags || []).map((tag) => ({ value: tag.id, label: tag.name })),
        };
        for (const binding of item?.bindings || []) {
            if (!options[binding.kind].some((option) => option.value === binding.targetId)) {
                options[binding.kind].push({ value: binding.targetId, label: binding.label ?? String(binding.targetId) });
            }
        }
        return options;
    }, [servers, tags, form.owner, item]);

    const set = (key, value) => setForm((current) => ({ ...current, [key]: value }));
    const setField = (key, value) => setForm((current) => ({ ...current, fields: { ...current.fields, [key]: value } }));
    const setBindings = (kind, ids) => setForm((current) => ({ ...current, bindings: { ...current.bindings, [kind]: ids } }));

    const changeType = (type) => {
        setForm((current) => ({ ...current, type, fields: toFormFields(type) }));
        setSecrets({});
    };

    const changeOwner = (owner) => setForm((current) => ({ ...current, owner, bindings: NO_BINDINGS }));

    const isDirty = () => JSON.stringify(form) !== pristine || Object.values(secrets).some(Boolean);

    const submit = async () => {
        if (saveBlocked) return;
        if (!isEdit && secretsMissing) {
            setShowMissing(true);
            return;
        }
        setSaving(true);
        setFailure(null);
        const filled = Object.fromEntries(Object.entries(secrets).filter(([, value]) => value));
        const bindings = Object.entries(form.bindings).flatMap(([kind, ids]) => ids.map((targetId) => ({ kind, targetId })));
        const body = {
            name: form.name, fields: payloadFields, approvalRequired: form.approvalRequired,
            allServers: form.allServers, bindings,
        };
        try {
            const answer = isEdit
                ? await patchRequest(`vault/items/${item.id}`, {
                    ...body, description: form.description.trim() || null,
                    ...(Object.keys(filled).length > 0 ? { secrets: filled } : {}),
                })
                : await postRequest("vault/items", {
                    ...body, type: form.type, secrets: filled,
                    ...(form.description.trim() ? { description: form.description.trim() } : {}),
                    ...(form.owner !== "personal" ? { organizationId: owners.find((o) => o.value === form.owner)?.organizationId } : {}),
                });
            onSaved(answer.item);
            onClose();
        } catch (error) {
            setFailure(error?.code === 409 ? "nameTaken" : "saveFailed");
        } finally {
            setSaving(false);
        }
    };

    const onKeyDown = (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            submit();
        }
    };

    const secretPlaceholder = (field, label) => (isEdit && !targetChanged && item.secretFields.includes(field)
        ? t("vault.dialog.secretStored")
        : t("vault.dialog.enterSecret", { field: label }));

    return (
        <DialogProvider open={open} onClose={onClose} isDirty={isDirty}>
            <div className="vault-item-dialog" data-ui-id="UI-VAULT-DIALOG" onKeyDown={onKeyDown}>
                <h2 className="vault-item-dialog-title">
                    <Icon icon={IconKeyRound} />
                    {t(isEdit ? "vault.dialog.title.edit" : "vault.dialog.title.create")}
                </h2>

                <form onSubmit={(event) => { event.preventDefault(); submit(); }}>
                    <div className="vault-item-dialog-body">
                        <div className="vault-item-dialog-grid">
                            <div className="form-group" data-ui-id="UI-VAULT-DIALOG-TYPE">
                                <label>{t("vault.dialog.type")}</label>
                                <SelectBox disabled={isEdit} selected={form.type} setSelected={changeType}
                                           options={TYPE_KEYS.map((key) => ({ value: key, label: t(VAULT_TYPES[key].labelKey), icon: VAULT_TYPES[key].icon }))} />
                                {isEdit && <span className="vault-help">{t("vault.dialog.fixed")}</span>}
                            </div>
                            <div className="form-group" data-ui-id="UI-VAULT-DIALOG-OWNER">
                                <label>{t("vault.dialog.owner")}</label>
                                <SelectBox disabled={isEdit} selected={form.owner} setSelected={changeOwner}
                                           options={owners.map((owner) => ({ ...owner, icon: owner.value === "personal" ? IconUser : IconBuilding2 }))} />
                                {isEdit && <span className="vault-help">{t("vault.dialog.fixed")}</span>}
                            </div>
                        </div>

                        <div className="vault-item-dialog-grid" data-ui-id="UI-VAULT-DIALOG-FIELDS">
                            <div className="form-group">
                                <label htmlFor="vault-name">{t("vault.fields.name")}</label>
                                <IconInput id="vault-name" icon={IconTextCursorInput} customClass="vault-mono" value={form.name}
                                           setValue={(value) => { set("name", value); setFailure(null); }} placeholder="portal-login" />
                                {failure === "nameTaken" && <span className="vault-help vault-help--error" role="alert">{t("vault.dialog.nameTaken")}</span>}
                            </div>
                            {Object.keys(form.fields).map((key) => (key === "engine" ? (
                                <div className="form-group" key={key}>
                                    <label>{t("vault.fields.engine")}</label>
                                    <SelectBox options={DB_ENGINES} selected={form.fields.engine} setSelected={(value) => setField("engine", value)} />
                                </div>
                            ) : (
                                <div className="form-group" key={key}>
                                    <label htmlFor={`vault-field-${key}`}>{t(FIELD_INPUTS[key].labelKey)}</label>
                                    <IconInput id={`vault-field-${key}`} icon={FIELD_INPUTS[key].icon} customClass="vault-mono"
                                               value={form.fields[key]} setValue={(value) => setField(key, value)} />
                                </div>
                            )))}
                            <div className="form-group vault-item-dialog-wide">
                                <label htmlFor="vault-description">{t("vault.fields.description")}</label>
                                <IconInput id="vault-description" icon={IconTextAlignStart} value={form.description}
                                           setValue={(value) => set("description", value)} />
                            </div>
                        </div>

                        <div className="vault-item-dialog-secrets" data-ui-id="UI-VAULT-DIALOG-SECRET">
                            {spec.secrets.map((field) => {
                                const label = t(`vault.secretFields.${field}`);
                                const invalid = showMissing && secretsMissing;
                                return (
                                    <div className="form-group" key={field}>
                                        <label htmlFor={`vault-secret-${field}`}>{label}</label>
                                        {field === "privateKey" ? (
                                            // <input> drops line breaks, which would break a PEM key.
                                            <textarea id="vault-secret-privateKey" className="vault-textarea vault-mono" rows={4}
                                                      spellCheck={false} autoComplete="off" aria-invalid={invalid || undefined}
                                                      placeholder={secretPlaceholder(field, label)} value={secrets.privateKey || ""}
                                                      onChange={(event) => setSecrets((current) => ({ ...current, privateKey: event.target.value }))} />
                                        ) : (
                                            <IconInput id={`vault-secret-${field}`} type="password" icon={IconLock} customClass="vault-mono"
                                                       autoComplete="new-password" placeholder={secretPlaceholder(field, label)}
                                                       value={secrets[field] || ""}
                                                       setValue={(value) => setSecrets((current) => ({ ...current, [field]: value }))} />
                                        )}
                                        {isEdit && !targetChanged && item.secretFields.includes(field) && (
                                            <span className="vault-help">{t("vault.dialog.secretStored")}</span>
                                        )}
                                    </div>
                                );
                            })}
                            {targetChanged && <span className="vault-help vault-help--warning">{t("vault.dialog.secretCleared")}</span>}
                            {showMissing && secretsMissing && <span className="vault-help vault-help--error" role="alert">{t("vault.dialog.secretMissing")}</span>}
                        </div>

                        <div className="form-group" data-ui-id="UI-VAULT-DIALOG-SCOPE">
                            <label>{t("vault.detail.scope")}</label>
                            <div className={`vault-item-dialog-bindings${form.allServers ? " vault-item-dialog-bindings--all" : ""}`}>
                                {BINDING_KINDS.filter(([kind]) => kind !== "tag" || form.owner === "personal").map(([kind, placeholderKey]) => (
                                    <SelectBox key={kind} multiple searchable disabled={form.allServers} options={targets[kind]}
                                               selected={form.bindings[kind]} setSelected={(ids) => setBindings(kind, ids)}
                                               placeholder={t(placeholderKey)} />
                                ))}
                            </div>
                            {!form.allServers && Object.values(form.bindings).every((ids) => ids.length === 0) && (
                                <span className="vault-help">{t("vault.bindings.emptyDialog")}</span>
                            )}
                            <div className="vault-item-dialog-switch">
                                <label htmlFor="vault-all-servers">{t("vault.bindings.allServers")}</label>
                                <ToggleSwitch id="vault-all-servers" checked={form.allServers} onChange={(value) => set("allServers", value)} />
                            </div>
                        </div>

                        <div className="vault-item-dialog-switch" data-ui-id="UI-VAULT-DIALOG-APPROVAL">
                            <label htmlFor="vault-approval">{t("vault.policy.required")}</label>
                            <ToggleSwitch id="vault-approval" checked={form.approvalRequired} onChange={(value) => set("approvalRequired", value)} />
                        </div>
                    </div>

                    <div className="vault-item-dialog-actions">
                        {failure === "saveFailed" && <span className="vault-help vault-help--error" role="alert">{t("vault.dialog.saveFailed")}</span>}
                        <DialogCancelButton text={t("common.actions.cancel")} />
                        <Button dataUiId="UI-VAULT-DIALOG-SAVE" type="primary" buttonType="submit" disabled={saveBlocked}
                                loading={saving}
                                text={saving ? t("vault.dialog.saving") : t(isEdit ? "vault.dialog.save" : "vault.dialog.create")} />
                    </div>
                </form>
            </div>
        </DialogProvider>
    );
};
```

`client/src/pages/Vault/components/VaultItemDialog/index.js` (neu):

```js
export { VaultItemDialog as default } from "./VaultItemDialog.jsx";
```

`client/src/pages/Vault/components/VaultItemDialog/styles.sass` (neu):

```sass
@use "@/common/styles/colors"
@use "@/common/styles/tokens"
@use "@/common/styles/breakpoints"

.vault-item-dialog
  width: min(90vw, 40rem)
  max-height: 85vh
  display: flex
  flex-direction: column
  gap: tokens.$space-4
  overflow: hidden

  .vault-item-dialog-title
    display: flex
    align-items: center
    gap: tokens.$space-2
    margin: 0
    padding-bottom: tokens.$space-3
    border-bottom: 1px solid colors.$gray
    font: tokens.$type-title

    svg
      width: 1.25rem
      height: 1.25rem
      color: colors.$primary

  form
    display: flex
    flex-direction: column
    min-height: 0
    gap: tokens.$space-4

  .vault-item-dialog-body
    display: flex
    flex-direction: column
    gap: tokens.$space-4
    overflow-y: auto
    min-height: 0

  .vault-item-dialog-grid
    display: grid
    grid-template-columns: 1fr 1fr
    gap: tokens.$space-3

    @media (max-width: breakpoints.$mobile)
      grid-template-columns: 1fr

  .vault-item-dialog-wide
    grid-column: 1 / -1

  .form-group
    display: flex
    flex-direction: column
    gap: tokens.$space-2

    label
      color: colors.$subtext
      font: tokens.$type-caption

  .vault-mono
    font: tokens.$type-mono

  .vault-textarea
    width: 100%
    box-sizing: border-box
    padding: tokens.$space-3
    border: 1px solid colors.$gray
    border-radius: tokens.$radius-lg
    background: colors.$lighter-background
    color: colors.$white
    resize: vertical
    outline: none

    &:focus
      border-color: colors.$primary

  .vault-item-dialog-secrets
    display: flex
    flex-direction: column
    gap: tokens.$space-3

  .vault-item-dialog-bindings
    display: grid
    grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr))
    gap: tokens.$space-2

    &--all
      opacity: 0.45

  .vault-item-dialog-switch
    display: flex
    align-items: center
    justify-content: space-between
    gap: tokens.$space-3

  .vault-help
    color: colors.$subtext
    font: tokens.$type-caption

    &--warning
      color: colors.$warning

    &--error
      color: colors.$error

  .vault-item-dialog-actions
    display: flex
    align-items: center
    justify-content: flex-end
    gap: tokens.$space-3
    flex-shrink: 0
```

- [ ] **Step 10: Run test to verify it passes**

Run: `yarn --cwd client vitest run src/pages/Vault/components/VaultItemDialog`
Expected: PASS (2 Tests).

- [ ] **Step 11: Liste** — `client/src/pages/Vault/components/VaultList/VaultList.jsx` (neu)

```jsx
import "./styles.sass";
import { useTranslation } from "react-i18next";
import { Plus as IconPlus, Shield as IconShield, Lock as IconLock } from "lucide-react";
import Button from "@/common/components/Button";
import Icon from "@/common/components/Icon";
import { VAULT_TYPES, itemSubject } from "../../vaultTypes.js";

export const VaultList = ({ items, loading, failed, ownerEmpty, selectedId, onSelect, canCreate, onCreate }) => {
    const { t } = useTranslation();

    if (loading) {
        return (
            <div className="vault-list vault-list--loading" data-ui-id="UI-VAULT-LIST" aria-busy="true">
                {[0, 1, 2].map((row) => <div key={row} className="vault-list-skeleton"><span /><span /></div>)}
            </div>
        );
    }

    if (failed) {
        return (
            <div className="vault-list" data-ui-id="UI-VAULT-LIST">
                <p className="vault-list-note vault-list-note--error" role="alert">{t("vault.list.error")}</p>
            </div>
        );
    }

    if (ownerEmpty) {
        return (
            <div className="vault-list" data-ui-id="UI-VAULT-LIST">
                <div className="vault-list-note">
                    <p>{t("vault.list.empty")}</p>
                    {canCreate && <Button text={t("vault.page.addItem")} icon={IconPlus} type="primary" onClick={onCreate} />}
                </div>
            </div>
        );
    }

    return (
        <ul className="vault-list" data-ui-id="UI-VAULT-LIST" role="listbox" aria-label={t("vault.list.title")}>
            {items.map((item) => {
                const subject = itemSubject(item);
                return (
                    <li key={item.id} role="option" aria-selected={item.id === selectedId}
                        className={`vault-row${item.id === selectedId ? " vault-row--selected" : ""}`}
                        onClick={() => onSelect(item.id)}>
                        <Icon icon={VAULT_TYPES[item.type]?.icon ?? IconLock} className="vault-row-type" />
                        <span className="vault-row-text">
                            <span className="vault-row-name">{item.name}</span>
                            {subject && <span className="vault-row-subject">{subject}</span>}
                        </span>
                        {item.approvalRequired && <Icon icon={IconShield} className="vault-row-shield" title={t("vault.policy.required")} />}
                    </li>
                );
            })}
        </ul>
    );
};
```

`client/src/pages/Vault/components/VaultList/index.js` (neu):

```js
export { VaultList as default } from "./VaultList.jsx";
```

`client/src/pages/Vault/components/VaultList/styles.sass` (neu):

```sass
@use "@/common/styles/colors"
@use "@/common/styles/tokens"

.vault-list
  flex: 1
  min-height: 0
  overflow-y: auto
  list-style: none
  margin: 0
  padding: tokens.$space-1 0

.vault-row
  display: flex
  align-items: center
  gap: tokens.$space-2
  min-height: 2.5rem
  padding: tokens.$space-1 tokens.$space-2
  color: colors.$subtext
  cursor: pointer
  border-radius: tokens.$radius-sm

  &:hover
    background: colors.$dark-gray

  &--selected, &--selected:hover
    background: colors.$primary-opacity

  .vault-row-type, .vault-row-shield
    width: 1rem
    height: 1rem
    flex: none

  .vault-row-text
    flex: 1
    min-width: 0
    display: flex
    flex-direction: column

  .vault-row-name
    font: tokens.$type-body
    color: colors.$white

  .vault-row-subject
    font: tokens.$type-mono
    overflow: hidden
    text-overflow: ellipsis
    white-space: nowrap

.vault-list-skeleton
  height: 2.5rem
  margin: tokens.$space-1 tokens.$space-2
  display: flex
  align-items: center
  gap: tokens.$space-2

  span
    display: block
    border-radius: tokens.$radius-sm
    background: colors.$gray
    animation: vaultSkeleton 1.4s ease-in-out infinite

    &:first-child
      width: 1rem
      height: 1rem

    &:last-child
      width: 9rem
      height: 0.75rem

.vault-list-note
  padding: tokens.$space-4
  color: colors.$subtext
  display: flex
  flex-direction: column
  align-items: flex-start
  gap: tokens.$space-3

  p
    margin: 0

  &--error
    margin: 0
    color: colors.$error

@keyframes vaultSkeleton
  0%, 100%
    opacity: 0.5
  50%
    opacity: 1
```

- [ ] **Step 12: Seite** — `client/src/pages/Vault/Vault.jsx` (Platzhalter aus Task 10 vollständig ersetzen)

```jsx
import "./styles.sass";
import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
    KeyRound as IconKeyRound, Plus as IconPlus, ArrowLeft as IconArrowLeft, Search as IconSearch,
    User as IconUser, Building2 as IconBuilding2,
} from "lucide-react";
import PageHeader from "@/common/components/PageHeader";
import Button from "@/common/components/Button";
import TabSwitcher from "@/common/components/TabSwitcher";
import IconInput from "@/common/components/IconInput";
import { UserContext } from "@/common/contexts/UserContext.jsx";
import { useToast } from "@/common/contexts/ToastContext.jsx";
import { useVaultAvailable } from "@/common/hooks/useVaultAvailable.js";
import { deleteRequest, getRequest } from "@/common/utils/RequestUtil.js";
import { Permission } from "@/common/utils/permissions.js";
import VaultList from "./components/VaultList";
import VaultDetail from "./components/VaultDetail";
import VaultItemDialog from "./components/VaultItemDialog";
import { TYPE_KEYS, VAULT_TYPES, matchesSearch, ownerKey } from "./vaultTypes.js";

const NARROW = "(max-width: 768px)";

const useNarrow = () => {
    const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);
    useEffect(() => {
        const query = window.matchMedia(NARROW);
        const update = () => setNarrow(query.matches);
        query.addEventListener("change", update);
        return () => query.removeEventListener("change", update);
    }, []);
    return narrow;
};

export const Vault = () => {
    const { t } = useTranslation();
    const { user, hasPermission } = useContext(UserContext);
    const { sendToast } = useToast();
    const { canManageOrgs, impersonating } = useVaultAvailable();
    const narrow = useNarrow();
    const [items, setItems] = useState(null);
    const [loadFailed, setLoadFailed] = useState(false);
    const [organizations, setOrganizations] = useState([]);
    const [scope, setScope] = useState(null);
    const [typeFilter, setTypeFilter] = useState("all");
    const [search, setSearch] = useState("");
    const [selectedId, setSelectedId] = useState(null);
    const [showDetail, setShowDetail] = useState(false);
    const [dialog, setDialog] = useState({ open: false, item: null, key: 0 });

    const personalAllowed = hasPermission(Permission.VAULT_USE);

    const loadItems = useCallback(() => getRequest("vault/items").then(
        (answer) => { setItems(answer.items); setLoadFailed(false); },
        () => { setItems([]); setLoadFailed(true); },
    ), []);

    useEffect(() => { loadItems(); }, [loadItems]);

    useEffect(() => {
        getRequest("organizations").then(setOrganizations).catch((error) => console.error("Failed to load organizations", error));
    }, []);

    const scopes = useMemo(() => [
        ...(personalAllowed ? [{ key: "personal", label: t("vault.scope.personal"), icon: IconUser }] : []),
        ...organizations.map((org) => ({ key: `org-${org.id}`, label: org.name, icon: IconBuilding2, organizationId: org.id })),
    ], [personalAllowed, organizations, t]);

    const activeScope = scopes.some((entry) => entry.key === scope) ? scope : scopes[0]?.key ?? null;
    const canCreateIn = (key) => key === "personal"
        ? personalAllowed
        : canManageOrgs.includes(scopes.find((entry) => entry.key === key)?.organizationId);
    const canCreate = activeScope !== null && canCreateIn(activeScope);
    const showNew = personalAllowed || canManageOrgs.length > 0;

    const scopedItems = useMemo(() => (items || []).filter((item) => ownerKey(item) === activeScope), [items, activeScope]);
    const visibleItems = useMemo(() => scopedItems.filter((item) =>
        (typeFilter === "all" || item.type === typeFilter) && matchesSearch(item, search)), [scopedItems, typeFilter, search]);
    const selected = visibleItems.find((item) => item.id === selectedId) || null;
    const filterEmpty = scopedItems.length > 0 && visibleItems.length === 0;

    const owners = useMemo(() => [
        ...(personalAllowed ? [{ value: "personal", label: t("vault.dialog.ownerPersonal", { username: user?.username, interpolation: { escapeValue: false } }), organizationId: null }] : []),
        ...organizations.filter((org) => canManageOrgs.includes(org.id))
            .map((org) => ({ value: `org-${org.id}`, label: org.name, organizationId: org.id })),
    ], [personalAllowed, organizations, canManageOrgs, user?.username, t]);

    const openCreate = () => setDialog((current) => ({ open: true, item: null, key: current.key + 1 }));
    const openEdit = (item) => setDialog((current) => ({ open: true, item, key: current.key + 1 }));
    const closeDialog = () => setDialog((current) => ({ ...current, open: false }));

    const select = (id) => {
        setSelectedId(id);
        setShowDetail(true);
    };

    const saved = async (item) => {
        await loadItems();
        if (item) setSelectedId(item.id);
    };

    const remove = async (item) => {
        try {
            await deleteRequest(`vault/items/${item.id}`);
            setSelectedId(null);
            setShowDetail(false);
            await loadItems();
        } catch (error) {
            sendToast(t("common.error"), error?.message || t("vault.detail.deleteFailed"));
        }
    };

    useEffect(() => {
        const onKeyDown = (event) => {
            if (event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
            if (event.target?.closest?.("input, textarea, select, [contenteditable='true']")) return;
            if (document.querySelector(".dialog-area")) return;
            if (event.key === "n" || event.key === "N") {
                if (canCreate) {
                    event.preventDefault();
                    openCreate();
                }
            } else if ((event.key === "e" || event.key === "E") && selected?.canManage) {
                event.preventDefault();
                openEdit(selected);
            } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && visibleItems.length > 0) {
                event.preventDefault();
                const index = visibleItems.findIndex((item) => item.id === selectedId);
                const next = event.key === "ArrowDown" ? Math.min(index + 1, visibleItems.length - 1) : Math.max(index - 1, 0);
                setSelectedId(visibleItems[next].id);
            } else if (event.key === "Escape" && narrow && showDetail) {
                setShowDetail(false);
            }
        };
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
    });

    const typeTabs = [
        { key: "all", label: t("vault.types.all") },
        ...TYPE_KEYS.map((key) => ({ key, label: t(VAULT_TYPES[key].labelKey), icon: VAULT_TYPES[key].icon })),
    ];

    return (
        <div className={`vault-page${showDetail ? " vault-page--detail" : ""}`} data-ui-id="UI-VAULT">
            <PageHeader icon={IconKeyRound} title={t("vault.page.title")} subtitle={t("vault.page.subtitle")}
                        onBackClick={narrow && showDetail ? () => setShowDetail(false) : undefined} backIcon={IconArrowLeft}>
                {showNew && (
                    <Button dataUiId="UI-VAULT-NEW" text={t("vault.page.addItem")} icon={IconPlus} type="primary"
                            disabled={!canCreate} onClick={openCreate} />
                )}
            </PageHeader>

            <div className="vault-split">
                <aside className="vault-sidebar">
                    <div className="vault-scope">
                        <TabSwitcher dataUiId="UI-VAULT-SCOPE" tabs={scopes} activeTab={activeScope}
                                     onTabChange={(key) => { setScope(key); setSelectedId(null); }} />
                    </div>
                    <div className="vault-search">
                        <IconInput dataUiId="UI-VAULT-SEARCH" icon={IconSearch} value={search} setValue={setSearch}
                                   placeholder={t("vault.search.placeholder")} />
                        {filterEmpty && search.trim() && <p className="vault-hint">{t("vault.search.empty")}</p>}
                    </div>
                    <div className="vault-types">
                        <TabSwitcher dataUiId="UI-VAULT-TYPES" tabs={typeTabs} activeTab={typeFilter} onTabChange={setTypeFilter} />
                    </div>
                    <VaultList items={visibleItems} loading={items === null} failed={loadFailed}
                               ownerEmpty={scopedItems.length === 0} selectedId={selectedId} onSelect={select}
                               canCreate={canCreate} onCreate={openCreate} />
                </aside>
                <main className="vault-main">
                    <VaultDetail item={selected} impersonating={impersonating} onEdit={openEdit} onDelete={remove} />
                </main>
            </div>

            <VaultItemDialog key={dialog.key} open={dialog.open} onClose={closeDialog} item={dialog.item}
                             owners={dialog.item ? [{
                                 value: ownerKey(dialog.item),
                                 label: dialog.item.organizationId ? dialog.item.ownerName : t("vault.dialog.ownerPersonal", { username: user?.username, interpolation: { escapeValue: false } }),
                                 organizationId: dialog.item.organizationId,
                             }] : owners}
                             defaultOwner={canCreate ? activeScope : owners[0]?.value} onSaved={saved} />
        </div>
    );
};
```

`client/src/pages/Vault/styles.sass` (neu):

```sass
@use "@/common/styles/colors"
@use "@/common/styles/tokens"
@use "@/common/styles/breakpoints"

.vault-page
  display: flex
  flex-direction: column
  height: 100%
  background-color: colors.$background

  .vault-split
    flex: 1
    min-height: 0
    display: grid
    grid-template-columns: minmax(20rem, 26rem) 1fr
    border-top: 1px solid colors.$gray

    @media (max-width: breakpoints.$mobile)
      grid-template-columns: 1fr

  .vault-sidebar
    display: flex
    flex-direction: column
    min-height: 0
    min-width: 0
    background: colors.$lighter-background
    border-right: 1px solid colors.$gray

    @media (max-width: breakpoints.$mobile)
      border-right: 0

  .vault-main
    min-width: 0
    min-height: 0
    background: colors.$background

  @media (max-width: breakpoints.$mobile)
    .vault-main
      display: none

    &.vault-page--detail
      .vault-sidebar
        display: none

      .vault-main
        display: block

  .vault-scope, .vault-search, .vault-types
    padding: tokens.$space-2

  .vault-types
    border-bottom: 1px solid colors.$gray

    .tab-switcher-container
      overflow-x: auto

    .tab-switcher-tab
      flex: none
      padding: tokens.$space-1 tokens.$space-2
      font: tokens.$type-caption

  .vault-hint
    margin: tokens.$space-2 0 0
    font: tokens.$type-caption
    color: colors.$subtext
```

- [ ] **Step 13: Prüfen**

Run: `yarn --cwd client vitest run src/pages/Vault`
Expected: PASS (2 Dateien, 5 Testfälle).

Run: `yarn --cwd client eslint src/pages/Vault`
Expected: keine Fehler, keine Warnungen.

Run: `yarn --cwd client build`
Expected: Build erfolgreich, Chunks `Vault-*.js` und `Vault-*.css` entstehen (Sass kompiliert, alle Importe lösen auf).

- [ ] **Step 14: Commit**

```bash
git add client/src/pages/Vault
git commit -m "Vault: Seite mit Liste und Details, Eintrag-Dialog"
```

---

### Task 13: Client: Freigabe-Karte

**Files:**
- Create: `client/src/common/components/VaultApprovalCard/VaultApprovalStack.jsx` (Stapel, Zustandsstrom, Uhr, Antworten)
- Create: `client/src/common/components/VaultApprovalCard/VaultApprovalCard.jsx` (eine Karte, Tastatur, Countdown-Anzeige)
- Create: `client/src/common/components/VaultApprovalCard/styles.sass`
- Create: `client/src/common/components/VaultApprovalCard/index.js` (Default-Export `VaultApprovalStack`)
- Test: `client/src/common/components/VaultApprovalCard/__tests__/VaultApprovalStack.test.jsx`
- Modify: `client/src/common/layouts/Root.jsx` (Import nach Z. 30, `<VaultApprovalStack />` nach `<MobileNav />` Z. 146)
- Modify: `client/src/common/layouts/PopoutRoot.jsx` (Import nach Z. 21, `<VaultApprovalStack />` nach dem `<Suspense>` Z. 50-52)

**Interfaces:**
- Consumes (Task 6, über den Zustandsstrom): `STATE_TYPES.VAULT_APPROVALS` liefert die Liste aus `listOpenApprovals(accountId)` = `[{ id: string, agentType: "claude"|"codex"|null, entryName: string|null, item: string, target: string, expiresAt: number|string, remainingMs: number }]`. `item` ist die Kennung des Eintrags (`itemRef`, z. B. `portal-login` bzw. `org:3/portal-login`), kein Objekt. Die Karte rechnet ihre Frist lokal als Empfangszeit + `remainingMs` (`deadline`), damit eine abweichende Uhr zwischen Browser und Server den Countdown nicht verschiebt; `expiresAt` liest der Client nicht.
- Consumes (Task 6, REST): `POST /api/vault/approvals/:id` mit `{ decision: "once"|"session"|"deny" }` → `200` bei Erfolg; `404` (unbekannt oder einem anderen Konto zugeordnet), `409` (schon beantwortet) bzw. `410` (abgelaufen oder zurückgezogen) kommen über `RequestUtil` als geworfenes Objekt mit `code`.
- Consumes (Task 10): `STATE_TYPES.VAULT_APPROVALS` im Client (`@/common/hooks/useStateStream.js`, re-exportiert aus `@/common/contexts/StateStreamContext.jsx`); `useVaultAvailable()` als **benannter** Export aus `@/common/hooks/useVaultAvailable.js` (genutzt: `impersonating`); i18n-Schlüssel `vault.approval.*`, `vault.agents.*`, `common.error` (Liste am Ende dieses Tasks).
- Produces: `<VaultApprovalStack />` (keine Props; rendert `null` ohne offene Anfrage oder in einer Impersonations-Sitzung, sonst ein Portal nach `document.body`), als Default-Export von `client/src/common/components/VaultApprovalCard/index.js` und benannt aus `VaultApprovalStack.jsx`; `<VaultApprovalCard approval now sending onAnswer(decision) />` (`approval` trägt zusätzlich die lokale `deadline` in Millisekunden).

**Design:**
- Screen: `UI-VAULT-APPROVAL` — Artboard `docs/design/mockups/ui-vault-approval.html` — Anleitung `docs/design/guides/ui-vault-approval.md`
- Zu bauende Elemente (Werte wörtlich übernehmen):

| ID | Element | Fachlicher Anker | Zustände | Copy |
|----|---------|------------------|----------|------|
| UI-VAULT-APPROVAL-CARD | Freigabe angefordert | Eine Karte unten rechts über jeder Seite, nicht modal: ein Agent will einen Vault-Eintrag nutzen. Zeigt Agent und Server, Eintrag und Ziel (Ursprung oder Host) und die verbleibende Zeit; Antworten Einmal, Für diese Sitzung, Ablehnen. Mehrere Anfragen stapeln sich, die älteste unten. Der Stapel liegt über Dialogen und Toasts. Eine abgelaufene Karte zeigt fünf Sekunden den Fehlerzustand und verschwindet; scheitert das Senden einer Antwort, bleibt die Karte stehen und ein Toast nennt den Grund. Nicht: notification, toast, error. | default, empty, partial, loading, error | partial „3 Anfragen offen“ · loading „Antwort wird gesendet …“ · error „Anfrage ist abgelaufen.“ |

- Locator: jedes Element trägt `data-ui-id="<ID>"` — hier genau einmal am Portal-Wrapper des Stapels (`.vault-approval-stack`), auch bei mehreren Anfragen (`cardinality: many` meint die Anfragen, nicht den Marker). `empty` rendert nichts.
- Tokens: `--lighter-background`, `--shadow-xl`, `--radius-lg`, `--warning` (linker Rand 3 px), `--primary`/`--on-accent` (über `Button type="primary"`), `--gray` (Balkengrund), `--subtext` (Balken, Zeit, Zähler), `--space-2`/`--space-4`/`--space-6`, `--type-heading`/`--type-body`/`--type-mono`/`--type-caption`, Breakpoint `breakpoints.$mobile`, `--mobile-nav-height` (aus `main.sass`). Im Code über `@/common/styles/colors` und `@/common/styles/tokens`.
- Stapelordnung: Wrapper `z-index: 10003` (Dialog `10000`, Bestätigungs-Overlay `10001` in `Dialog/styles.sass`; Toast `10002` in `common/styles/toast.sass`).
- Reihenfolge im Stapel: neueste oben, älteste unten (Manifest). Das Artboard zeigt im `partial`-Rahmen die kürzeste Restzeit oben; das Manifest gilt (Konflikt gemeldet).

**Tests:** 5 Tests in `VaultApprovalStack.test.jsx`, test-first (das Verhalten steht im Manifest und im Vertrag aus Task 6 fest): (1) Countdown aus `remainingMs` ab Empfang, auch wenn `expiresAt` der Serveruhr eine Stunde vorausläuft; Ablauf zeigt fünf Sekunden „abgelaufen“ mit gesperrten Knöpfen, danach ist die Karte weg (Fake-Uhr); (2) „Einmal“ sendet `POST vault/approvals/:id` mit `{ decision: "once" }`, zeigt währenddessen „Antwort wird gesendet …“ und nimmt die Karte nach `200` weg; (3) `404`, `409` und `410` nehmen die Karte ohne Toast weg (`test.each`); (4) Sendefehler zeigt einen Toast mit dem Grund, die Karte bleibt und ist wieder bedienbar; (5) Esc auf der fokussierten Karte sendet `deny`. Echte Seams: `StateStreamContext` (Provider mit eigenem `registerHandler`), `ToastProvider`, `en.json` über `src/test/i18n.js`. Gemockt: nur `RequestUtil` (requestDouble) und `useVaultAvailable` (Modul-Cache je Konto aus Task 10 gehört nicht in diesen Test). Nicht getestet: Position, Stapelreihenfolge und Mobil-Layout (prüft `/design-verify`), das Einhängen in `Root.jsx`/`PopoutRoot.jsx` (reine Verdrahtung), `prefers-reduced-motion`. SEC: SEC-XSS-01 (nur React-Text, kein `dangerouslySetInnerHTML`; Ziel und Kennung kommen vom Agenten), SEC-SECRET-01 (Karte und Antwort tragen nur Kennung und Ziel, nie einen Wert); SEC-IDOR-01 und SEC-RATE-01 deckt die Route aus Task 6, der Client schickt nur die Anfrage-ID.

**Parallel:** Task 3, Task 4, Task 9, Task 12, Task 14 (Welle B; keine gemeinsamen Dateien; Task 14 teilt nur die i18n-Schlüssel aus Task 10, die hier nur gelesen werden). Setzt Task 10 (Welle A) voraus; Zustandsstrom und Route aus Task 6 (Welle C) stehen im Vertrag oben fest, die Tests laufen gegen `requestDouble` und einen eigenen `registerHandler`.

- [ ] **Step 1: Write the failing test**

`client/src/common/components/VaultApprovalCard/__tests__/VaultApprovalStack.test.jsx`:

```jsx
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import testI18n from "@/test/i18n.js";
import { renderWithProviders } from "@/test/renderWithProviders.jsx";
import { ToastProvider } from "@/common/contexts/ToastContext.jsx";
import { StateStreamContext, STATE_TYPES } from "@/common/contexts/StateStreamContext.jsx";
import { VaultApprovalStack } from "../VaultApprovalStack.jsx";

const requestDouble = await vi.hoisted(async () => {
    const { createRequestDouble } = await import("@/test/requestDouble.js");
    return createRequestDouble();
});

vi.mock("@/common/utils/RequestUtil.js", () => requestDouble.asModule());
vi.mock("@/common/hooks/useVaultAvailable.js", () => ({
    useVaultAvailable: () => ({ impersonating: false }),
}));

const t = (key, options) => testI18n.t(key, options);

// Module level, not inside a component: the stack registers from an effect, and the
// handler has to leave that effect without a write to an outer variable during render.
const stream = { handler: null };
const streamValue = {
    registerHandler: (type, handler) => {
        if (type === STATE_TYPES.VAULT_APPROVALS) stream.handler = handler;
        return () => {};
    },
};
const Stream = ({ children }) => (
    <StateStreamContext.Provider value={streamValue}>{children}</StateStreamContext.Provider>
);

const mount = () => renderWithProviders(<VaultApprovalStack />, { providers: [ToastProvider, Stream] });
const push = (list) => act(() => { stream.handler(list); });
// The server clock runs an hour ahead: only remainingMs may drive the countdown.
const SERVER_CLOCK_AHEAD_MS = 3_600_000;
const approval = (id, remainingMs) => ({
    id, agentType: "claude", entryName: "web01", item: "portal-login",
    target: "https://portal.example.com", expiresAt: Date.now() + SERVER_CLOCK_AHEAD_MS + remainingMs, remainingMs,
});
const stack = () => document.querySelector("[data-ui-id='UI-VAULT-APPROVAL-CARD']");
const button = (key) => screen.getByRole("button", { name: t(key) });

beforeEach(() => {
    requestDouble.reset();
    stream.handler = null;
});
afterEach(() => { vi.useRealTimers(); });

test("the countdown runs from remainingMs on receipt; an expired card shows its error state for five seconds, then goes", () => {
    vi.useFakeTimers({ now: 0 });
    mount();
    push([approval("a1", 90_000)]);

    expect(screen.getByText("1:30")).toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(30_000); });
    expect(screen.getByText("1:00")).toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByText(t("vault.approval.expired"))).toBeInTheDocument();
    expect(screen.getByText("0:00")).toBeInTheDocument();
    expect(button("vault.approval.actions.once")).toBeDisabled();

    act(() => { vi.advanceTimersByTime(5_000); });
    expect(stack()).toBeNull();
});

test("Once sends the decision, shows the sending state, and removes the card on success", async () => {
    const user = userEvent.setup();
    let resolve;
    requestDouble.stub("postRequest", "vault/approvals/a1", new Promise((r) => { resolve = r; }));
    mount();
    push([approval("a1", 120_000)]);

    await user.click(button("vault.approval.actions.once"));

    expect(screen.getByText(t("vault.approval.sending"))).toBeInTheDocument();
    expect(button("vault.approval.actions.deny")).toBeDisabled();
    expect(requestDouble.calls).toContainEqual({ method: "postRequest", path: "vault/approvals/a1", body: { decision: "once" } });

    await act(async () => { resolve({ success: true }); });
    expect(stack()).toBeNull();
});

test.each([404, 409, 410])("an answer the server refuses with %i removes the card without a toast", async (code) => {
    const user = userEvent.setup();
    requestDouble.stub("postRequest", "vault/approvals/a1", Object.assign(new Error("Approval closed"), { code }));
    mount();
    push([approval("a1", 120_000)]);

    await user.click(button("vault.approval.actions.deny"));

    await waitFor(() => expect(stack()).toBeNull());
    expect(screen.queryByText("Approval closed")).not.toBeInTheDocument();
});

test("a failed send keeps the card, re-enables it and names the reason in a toast", async () => {
    const user = userEvent.setup();
    requestDouble.stub("postRequest", "vault/approvals/a1", Object.assign(new Error("Too many requests"), { code: 429 }));
    mount();
    push([approval("a1", 120_000)]);

    await user.click(button("vault.approval.actions.session"));

    expect(await screen.findByText("Too many requests")).toBeInTheDocument();
    expect(stack()).not.toBeNull();
    expect(button("vault.approval.actions.session")).toBeEnabled();
});

test("Esc on the focused card denies", async () => {
    const user = userEvent.setup();
    requestDouble.stub("postRequest", "vault/approvals/a1", { success: true });
    mount();
    push([approval("a1", 120_000)]);

    act(() => { stack().querySelector(".vault-approval-card").focus(); });
    await user.keyboard("{Escape}");

    await waitFor(() => expect(requestDouble.calls).toContainEqual(
        { method: "postRequest", path: "vault/approvals/a1", body: { decision: "deny" } },
    ));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn --cwd client vitest run src/common/components/VaultApprovalCard/__tests__/VaultApprovalStack.test.jsx`
Expected: FAIL — `Failed to resolve import "../VaultApprovalStack.jsx"`.

- [ ] **Step 3: Implement the card**

`client/src/common/components/VaultApprovalCard/VaultApprovalCard.jsx`:

```jsx
import { useTranslation } from "react-i18next";
import Button from "@/common/components/Button";

// Only for the width of the bar. The server decides when a request has expired.
const APPROVAL_TTL_MS = 120000;

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
            <h3>{t("vault.approval.title")}</h3>
            {agent && (
                <div className="vault-approval-who">
                    {approval.entryName
                        ? t("vault.approval.who", { agent, server: approval.entryName, interpolation: { escapeValue: false } })
                        : agent}
                </div>
            )}
            <div className="vault-approval-target">{approval.item}</div>
            <div className="vault-approval-target">{approval.target}</div>
            {(sending || expired) && (
                <div className="vault-approval-status" role="status">
                    {t(expired ? "vault.approval.expired" : "vault.approval.sending")}
                </div>
            )}
            <div className="vault-approval-actions">
                <Button type="primary" text={t("vault.approval.actions.once")} disabled={disabled} loading={sending}
                        onClick={() => onAnswer("once")} />
                <Button text={t("vault.approval.actions.session")} disabled={disabled} onClick={() => onAnswer("session")} />
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

- [ ] **Step 4: Implement the stack**

`client/src/common/components/VaultApprovalCard/VaultApprovalStack.jsx`:

```jsx
import "./styles.sass";
import { useContext, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { StateStreamContext, STATE_TYPES } from "@/common/contexts/StateStreamContext.jsx";
import { useToast } from "@/common/contexts/ToastContext.jsx";
import { useVaultAvailable } from "@/common/hooks/useVaultAvailable.js";
import { postRequest } from "@/common/utils/RequestUtil.js";
import { VaultApprovalCard } from "./VaultApprovalCard.jsx";

const EXPIRED_VISIBLE_MS = 5000;
const DELIVERY_GRACE_MS = 1000;

export const VaultApprovalStack = () => {
    const { t } = useTranslation();
    const { registerHandler } = useContext(StateStreamContext);
    const { sendToast } = useToast();
    const { impersonating } = useVaultAvailable();
    const [approvals, setApprovals] = useState([]);
    const [now, setNow] = useState(() => Date.now());
    const [sending, setSending] = useState(() => new Set());
    const [answered, setAnswered] = useState(() => new Set());

    useEffect(() => registerHandler(STATE_TYPES.VAULT_APPROVALS, (list) => {
        const current = Date.now();
        const next = (Array.isArray(list) ? list : [])
            .map((approval) => ({ ...approval, deadline: current + approval.remainingMs }));
        const ids = new Set(next.map((approval) => approval.id));
        // The server drops a request the moment it times out. Keeping it here lets the card
        // show its expired state for five seconds; one answered elsewhere goes at once.
        setApprovals((prev) => [
            ...next,
            ...prev.filter((approval) => !ids.has(approval.id)
                && approval.deadline <= current + DELIVERY_GRACE_MS
                && approval.deadline + EXPIRED_VISIBLE_MS > current),
        ]);
        setNow(current);
    }), [registerHandler]);

    const visible = approvals
        .filter((approval) => !answered.has(approval.id) && now < approval.deadline + EXPIRED_VISIBLE_MS)
        .sort((a, b) => b.deadline - a.deadline);
    const hasCards = visible.length > 0;

    useEffect(() => {
        if (!hasCards) return;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [hasCards]);

    const markAnswered = (id) => setAnswered((prev) => new Set(prev).add(id));

    const answer = async (id, decision) => {
        setSending((prev) => new Set(prev).add(id));
        try {
            await postRequest(`vault/approvals/${id}`, { decision });
            markAnswered(id);
        } catch (err) {
            if ([404, 409, 410].includes(err?.code)) markAnswered(id);
            else sendToast(t("common.error"), err?.message || t("common.error"));
        } finally {
            setSending((prev) => {
                const next = new Set(prev);
                next.delete(id);
                return next;
            });
        }
    };

    if (impersonating || !hasCards) return null;

    return createPortal(
        <div className="vault-approval-stack" data-ui-id="UI-VAULT-APPROVAL-CARD">
            {visible.length > 1 && (
                <div className="vault-approval-count">{t("vault.approval.pending", { count: visible.length })}</div>
            )}
            {visible.map((approval) => (
                <VaultApprovalCard key={approval.id} approval={approval} now={now}
                                   sending={sending.has(approval.id)}
                                   onAnswer={(decision) => answer(approval.id, decision)} />
            ))}
        </div>,
        document.body,
    );
};
```

`client/src/common/components/VaultApprovalCard/index.js`:

```js
export { VaultApprovalStack as default } from "./VaultApprovalStack.jsx";
```

- [ ] **Step 5: Styles**

`client/src/common/components/VaultApprovalCard/styles.sass`:

```sass
@use "@/common/styles/colors"
@use "@/common/styles/tokens"
@use "@/common/styles/breakpoints"

.vault-approval-stack
  position: fixed
  right: tokens.$space-4
  bottom: tokens.$space-4
  // Above Dialog (10000), its confirm overlay (10001) and the toasts (10002).
  z-index: 10003
  width: 24rem
  display: flex
  flex-direction: column
  gap: tokens.$space-2

  @media (max-width: breakpoints.$mobile)
    left: 0
    right: 0
    bottom: var(--mobile-nav-height)
    width: auto

.vault-approval-count
  font: tokens.$type-caption
  color: colors.$subtext
  text-align: right

.vault-approval-card
  position: relative
  display: flex
  flex-direction: column
  gap: tokens.$space-2
  padding: tokens.$space-4 tokens.$space-4 tokens.$space-6
  overflow: hidden
  background: colors.$lighter-background
  color: colors.$white
  border-left: 3px solid colors.$warning
  border-radius: tokens.$radius-lg
  box-shadow: colors.$shadow-xl

  @media (max-width: breakpoints.$mobile)
    border-radius: tokens.$radius-lg tokens.$radius-lg 0 0

  h3
    margin: 0
    font: tokens.$type-heading

  .vault-approval-who,
  .vault-approval-status
    font: tokens.$type-body

  .vault-approval-target
    font: tokens.$type-mono
    overflow-wrap: anywhere

  .vault-approval-actions
    display: flex
    flex-wrap: wrap
    gap: tokens.$space-2
    margin-top: tokens.$space-2

    .btn:disabled
      opacity: 0.45
      cursor: default

  .vault-approval-timer
    display: flex
    justify-content: flex-end
    font: tokens.$type-caption
    color: colors.$subtext

  .vault-approval-bar
    position: absolute
    left: 0
    right: 0
    bottom: 0
    height: 2px
    background: colors.$gray

    i
      display: block
      height: 100%
      background: colors.$subtext
      transition: width 1s linear

      @media (prefers-reduced-motion: reduce)
        transition: none
```

- [ ] **Step 6: Run test to verify it passes**

Run: `yarn --cwd client vitest run src/common/components/VaultApprovalCard/__tests__/VaultApprovalStack.test.jsx`
Expected: PASS (7 Tests: 4 einzelne + 3 aus `test.each`). Schlägt ein Test mit `i18n: missing key "vault.…"` fehl, fehlt der Schlüssel aus Task 10: nicht nachtragen und nicht umbenennen, sondern anhalten und den fehlenden Schlüssel melden.

- [ ] **Step 7: In `Root.jsx` einhängen**

`client/src/common/layouts/Root.jsx` — nach Z. 30 (`import { useTranslation } from "react-i18next";`):

```jsx
import { useTranslation } from "react-i18next";
import VaultApprovalStack from "@/common/components/VaultApprovalCard";
```

Z. 146, vorher:

```jsx
                                                        <MobileNav />
                                                    </div>
```

nachher:

```jsx
                                                        <MobileNav />
                                                        <VaultApprovalStack />
                                                    </div>
```

(Innerhalb `StateStreamProvider`, `UserProvider` und `ToastProvider`; das Portal hebt die Karte aus `app-wrapper` heraus.)

- [ ] **Step 8: In `PopoutRoot.jsx` einhängen**

`client/src/common/layouts/PopoutRoot.jsx` — nach Z. 21 (`import ThemeLoader from "@/common/components/ThemeLoader";`):

```jsx
import ThemeLoader from "@/common/components/ThemeLoader";
import VaultApprovalStack from "@/common/components/VaultApprovalCard";
```

Z. 50-52, vorher:

```jsx
                                                                <Suspense fallback={<Loading />}>
                                                                    <Outlet />
                                                                </Suspense>
```

nachher:

```jsx
                                                                <Suspense fallback={<Loading />}>
                                                                    <Outlet />
                                                                </Suspense>
                                                                <VaultApprovalStack />
```

`ShareRoot` und `LinkRoot` bleiben ohne Karte (kein `StateStreamProvider`).

- [ ] **Step 9: Lint**

Run: `yarn --cwd client lint`
Expected: keine neuen Fehler in `VaultApprovalCard/`, `Root.jsx`, `PopoutRoot.jsx`.

- [ ] **Step 10: Commit**

```bash
git add client/src/common/components/VaultApprovalCard client/src/common/layouts/Root.jsx client/src/common/layouts/PopoutRoot.jsx
git commit -m "Vault: Freigabe-Karte über jeder Seite und im Popout"
```

**i18n-Schlüssel, die dieser Task benutzt (angelegt in Task 10):**

| Schlüssel | de_DE |
|---|---|
| `vault.approval.title` | Freigabe angefordert |
| `vault.approval.who` | {{agent}} auf {{server}} |
| `vault.approval.actions.once` | Einmal |
| `vault.approval.actions.session` | Für diese Sitzung |
| `vault.approval.actions.deny` | Ablehnen |
| `vault.approval.pending` | {{count}} Anfragen offen |
| `vault.approval.sending` | Antwort wird gesendet … |
| `vault.approval.expired` | Anfrage ist abgelaufen. |
| `vault.agents.claude` | Claude Code |
| `vault.agents.codex` | Codex |
| `common.error` | (Bestand) |

---

### Task 14: Client: Agenten-Zugang und Kontextmenü

**Files:**
- Create: `client/src/pages/Servers/components/AgentAccessDialog/AgentAccessDialog.jsx`
- Create: `client/src/pages/Servers/components/AgentAccessDialog/styles.sass`
- Create: `client/src/pages/Servers/components/AgentAccessDialog/index.js`
- Test: `client/src/pages/Servers/components/AgentAccessDialog/__tests__/AgentAccessDialog.test.jsx`
- Modify: `client/src/pages/Servers/components/ServerList/ServerList.jsx` (lucide-Import Z. 17, Importe nach Z. 29, Hook-Aufruf nach Z. 97, Zustand nach Z. 120, Menüpunkt nach dem Tags-Eintrag Z. 923-928, Dialog nach `ActionConfirmDialog` Z. 1034-1039)

**Interfaces:**
- Consumes (Task 8, REST):
  - `GET /api/vault/agent-keys?entryId=<id>` → `{ keys: AgentKey[], remoteUser: string|null, otherAccountConfigured: boolean }` mit `AgentKey = { id, entryId, agentType: "claude"|"codex", pending: boolean, ipBinding: boolean, allowedCidrs: string[], createdAt, lastUsedAt: string|null }` (`allowedCidrs` ohne Bereiche `[]`, nie `null`).
  - `POST /api/vault/agent-keys` body `{ entryId, agentTypes, ipBinding, allowedCidrs }` → `{ results: [{ id, agentType, status: "configured"|"manual", remoteUser, command?, probe: { seenIp, matches }|null, replacedRegistration, reason? }] }`. `reason: "cli_missing"|"exec_failed"` ist optional; fehlt es, zeigt das Ergebnis den allgemeinen Satz. `409`, solange für diesen Server schon eine Einrichtung läuft.
  - `POST /api/vault/agent-keys/:id/confirm` body `{}` bzw. `{ addSeenIp: true }` → `{ success }`; `404` (Key unbekannt oder schon weg) bzw. `410` (`pending`-Key abgelaufen oder nicht mehr übernehmbar) machen den Befehl mit diesem Key wertlos; `409` bei gescheiterter Übernahme der Messung.
  - `DELETE /api/vault/agent-keys/:id` → `{ success, registration: "removed"|"foreign"|"absent"|"unknown", commands? }` (Entziehen und Verwerfen eines `pending`-Keys); `commands` (Entfernbefehl als Text, nur mit Key-Präfix, nie mit Key) nur bei `unknown`; `404`, wenn der Key schon entzogen ist.
- Consumes (Task 10): `useVaultAvailable()` als **benannter** Export aus `@/common/hooks/useVaultAvailable.js` (genutzt: `agentUrlSet`, `trustProxyUnsafe`, `impersonating`, `canProvision`); i18n-Schlüssel `servers.agentAccess.*`, `servers.contextMenu.agentAccess`, `vault.agents.*` (Liste am Ende).
- Consumes (Bestand): `ServerContext.getServerById(id) → { id, name, ip, protocol, … } | null`; `copyToClipboard(text) → Promise<boolean>` aus `@/common/utils/clipboard.js`; `formatTimeAgo(timestamp, t)` aus `@/common/utils/timeAgo.js`; `Checkbox`, `ToggleSwitch`, `IconInput`, `Button`, `DialogProvider`.
- Produces: `<AgentAccessDialog open entryId onClose />` (Default-Export über `index.js`, benannt aus `AgentAccessDialog.jsx`). Task 15 öffnet ihn aus „Bearbeiten“ mit `entryId`. Name und Adresse des Servers holt der Dialog selbst aus `ServerContext`.
- Produces: `isValidCidr(value) → boolean` (IPv4/IPv6-Adresse mit oder ohne Präfix; ohne Präfix gilt `/32` bzw. `/128` wie in der Joi-Regel aus Task 8), `parseCidrs(text) → string[]` (benannte Exporte aus `AgentAccessDialog.jsx`).

**Design:**
- Screen: `UI-AGENT-ACCESS` — Artboard `docs/design/mockups/ui-agent-access.html` — Anleitung `docs/design/guides/ui-agent-access.md`; Ergänzung `UI-SERVERS-LIST-MENU` — Artboard `docs/design/mockups/ui-servers.html` — Anleitung `docs/design/guides/ui-servers.md`
- Zu bauende Elemente (Werte wörtlich übernehmen):

| ID | Element | Fachlicher Anker | Zustände | Copy |
|----|---------|------------------|----------|------|
| UI-AGENT-ACCESS-KEYS | Agenten auf diesem Server | Die Agenten-Keys dieses Servers — Agent, angelegt, zuletzt genutzt, IP-Bindung — je mit Entziehen. Entziehen widerruft den Key und entfernt die Registrierung auf dem Server. Nicht: api_key, vault_item, identity. | default, empty, loading, selected, error, partial, disabled | empty „Noch kein Agent auf diesem Server eingerichtet.“ · selected „Zugang von Claude Code auf web01 entziehen? Der Agent verliert sofort den Zugriff.“ · error „Entziehen fehlgeschlagen.“ · partial „Zugang entzogen. Die Registrierung auf web01 trägt den Key eines anderen Kontos und bleibt stehen.“ · disabled „Zugang entzogen. Die Registrierung konnte nicht entfernt werden — Befehl kopieren und auf dem Server ausführen.“ |
| UI-AGENT-ACCESS-SETUP | Einrichten | Welche Agenten eingerichtet werden (Claude Code, Codex) und welche zusätzlichen Adressbereiche (CIDR) ihr Key neben der IP dieses Servers akzeptiert. Nicht: api_key, vault_binding. | default, loading, error, disabled, partial | loading „Richte ein …“ · error „Ungültiger Adressbereich.“ · disabled „Outpost-Adresse für Agenten fehlt — in Einstellungen › Vault setzen.“ · partial „Für root auf web01 hat bereits ein anderes Konto Agenten-Zugang eingerichtet — die Registrierung wird ersetzt.“ |
| UI-AGENT-ACCESS-IPBIND | Nur von der IP dieses Servers | Ob der Key nur Anfragen von der Adresse dieses Servers (plus den eingetragenen Adressbereichen) akzeptiert. Standard an; aus heißt von überall. Nicht: vault_binding, allowed_origin. | default, selected, partial, disabled, error | selected „aus — von überall“ · partial „Gesehen wurde 172.17.0.1 statt 192.168.2.40 — als Adressbereich übernehmen? Ohne Übernahme weist Outpost den Key ab.“ · disabled „Adresse konnte nicht gemessen werden — der Key gilt für die aufgelöste Adresse des Servers.“ · error „TRUST_PROXY=true — die IP-Bindung ist wirkungslos.“ |
| UI-AGENT-ACCESS-RESULT | Ergebnis | Je Agent das Ergebnis der Einrichtung — eingerichtet, oder der fertige Befehl zum Kopieren, wenn die automatische Einrichtung scheiterte (CLI fehlt, Exec-Fehler). Der Key ist nur hier und nur jetzt sichtbar; ein Key, der weder automatisch eingerichtet noch kopiert wurde, wird beim Schließen gelöscht. Nicht: agent_key, toast. | default, empty, success, partial, error | empty „erscheint erst nach dem Einrichten“ · success „Eingerichtet für root. Claude Code neu starten, dann /mcp.“ · partial „Bestehende Registrierung ersetzt — der alte Konto-Key bleibt gültig, bis du ihn unter API-Schlüssel löschst.“ · error „codex nicht gefunden. Befehl kopieren und auf dem Server ausführen.“ |
| UI-SERVERS-LIST-MENU | Kontextmenü Server (übernommen, ergänzt) | Zweitweg für Aktionen auf einem Eintrag — Verbinden, SFTP öffnen, Notizen, Bearbeiten, Duplizieren, Session beitreten, Agenten-Zugang… (nur SSH, nur bei eingeschaltetem Vault), Löschen. Port weiterleiten erscheint nur in der Desktop-App (Tauri), im Web-Build nie. Nicht: primary_navigation. | default, disabled | Menüpunkt „Agenten-Zugang…“ |

- Stand: `docs/design/manifest.yaml` Revision 14. Zustände daraus: IPBIND `partial` bei `probe.matches === false` (Übernahme-Angebot), IPBIND `disabled` bei eingeschalteter IP-Bindung und `probe === null` in einem Ergebnis (Messung gescheitert), RESULT `partial` je Ergebnis mit `replacedRegistration: true`, KEYS `partial` nach dem Entziehen bei `registration === "foreign"`, KEYS `disabled` nach dem Entziehen bei `registration === "unknown"` (darunter `commands` in `<pre>` mit „Kopieren“). Beide stehen unter der Liste, bis erneut entzogen oder der Dialog geschlossen wird.
- Locator: jedes Element trägt `data-ui-id="<ID>"`; zusätzlich `data-ui-id="UI-AGENT-ACCESS"` genau einmal am Wurzelknoten innerhalb `DialogProvider`. `UI-SERVERS-LIST-MENU` sitzt schon am `ContextMenu` (Bestand), der Menüpunkt bekommt keine eigene ID.
- Tokens: `--space-1/2/3/4/6`, `--radius-sm/md`, `--success` (eingerichtet), `--error` (gescheitert, Entziehen-Fehler, ungültiger Bereich), `--warning`/`--warning-opacity` (Warnrand: fremdes Konto, gemessene Adresse, Proxy, Key-Hinweis), `--subtext`, `--gray`, `--dark-gray`, `--type-title/heading/caption/mono`. Im Code über `@/common/styles/colors` und `@/common/styles/tokens`.
- Layout: 40 rem, max. 85 vh; IPBIND liegt im DOM außerhalb von SETUP, optisch zwischen Agentenauswahl und Adressbereichen (SETUP-Formular `display: contents`, Reihenfolge über `order`).
- Nicht im Manifest, aus der Spec übernommen (gemeldet): Erfolgssatz für Codex („Codex in einer neuen Shell starten; laufende Codex-Prozesse und tmux-Sitzungen kennen den Key nicht.“), Statuswörter „eingerichtet“/„gescheitert“ und der Key-Hinweis stammen aus dem Artboard.

**Tests:** 4 Tests in `AgentAccessDialog.test.jsx`, test-first (Ablauf `pending`/`confirm`/`DELETE` steht in Spec Schritt 1a und 5, das Entziehen-Ergebnis im Manifest Revision 14): (1) Schließen ohne Übernahme löscht den `pending`-Key per `DELETE vault/agent-keys/:id`; (2) „Kopieren“ kopiert den Befehl, bestätigt per `POST …/confirm` mit `{}` und Schließen löscht danach nichts; (3) eine abweichende Messung bietet die Übernahme an, „Übernehmen“ sendet `confirm` mit `{ addSeenIp: true }`; (4) Entziehen mit `registration: "unknown"` zeigt nach dem Neuladen der Liste den Satz des Zustands `disabled` und den Entfernbefehl, „Kopieren“ kopiert ihn. Echte Seams: `DialogProvider` (Schließen über den Knopf plus `animationEnd`, das jsdom nicht feuert), `ToastProvider`, `ServerContext` (Provider mit festem `getServerById`), `en.json`. Gemockt: `RequestUtil` (requestDouble), `copyToClipboard` (jsdom hat keine Zwischenablage), `useVaultAvailable`. Nicht getestet: Menüpunkt in `ServerList.jsx` (reine Bedingung `protocol === "ssh" && canProvision && !impersonating`), Entziehen mit `registration: "foreign"` (dieselbe Verzweigung wie Test 4, nur ein anderer Satz ohne Befehl) und mit `404` (Neuladen der Liste), die Sperren `setupInFlight`/`revoking` gegen Doppelklick, die Fehlerzweige von `confirm` (`404`/`410` nimmt das Ergebnis samt Befehl weg; gescheitertes „Übernehmen“ stellt das Angebot wieder her) und das Neuladen im `catch` der Einrichtung (je eine Bedingung), CIDR-Prüfung im Client (Spiegel der Server-Validierung aus Task 8), die Hinweise `ipBind.probeFailed` und `result.replaced` (je eine Bedingung auf `probe === null` bzw. `replacedRegistration`), Darstellung (prüft `/design-verify`). SEC: SEC-SECRET-01 (Key nur im RESULT, nie in Liste, Toast oder Log; beim Schließen aus dem State gelöscht), SEC-APIKEY-01/SEC-SESS-02 (nicht übernommene `pending`-Keys werden beim Schließen verworfen), SEC-INPUT-01 (CIDR-Vorprüfung im Client; maßgeblich bleibt Task 8), SEC-XSS-01 (nur React-Text; Einrichtungs- und Entfernbefehl in `<pre>` als Text).

**Parallel:** Task 3, Task 4, Task 9, Task 12, Task 13 (Welle B; keine gemeinsamen Dateien). Nicht neben Task 15: der importiert `AgentAccessDialog` und übernimmt die Entziehen-Auswertung dieses Tasks; Task 15 startet erst nach dem Merge dieses Tasks (Welle C). Setzt Task 10 (Welle A) voraus; die REST-Form aus Task 8 (Welle C) steht im Vertrag oben fest, die Tests laufen gegen `requestDouble`.

- [ ] **Step 1: Write the failing test**

`client/src/pages/Servers/components/AgentAccessDialog/__tests__/AgentAccessDialog.test.jsx`:

```jsx
import { beforeEach, expect, test, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import testI18n from "@/test/i18n.js";
import { renderWithProviders } from "@/test/renderWithProviders.jsx";
import { ToastProvider } from "@/common/contexts/ToastContext.jsx";
import { ServerContext } from "@/common/contexts/ServerContext.jsx";
import { AgentAccessDialog } from "../AgentAccessDialog.jsx";

const requestDouble = await vi.hoisted(async () => {
    const { createRequestDouble } = await import("@/test/requestDouble.js");
    return createRequestDouble();
});
const clipboard = vi.hoisted(() => ({ copyToClipboard: vi.fn() }));

vi.mock("@/common/utils/RequestUtil.js", () => requestDouble.asModule());
vi.mock("@/common/utils/clipboard.js", () => clipboard);
vi.mock("@/common/hooks/useVaultAvailable.js", () => ({
    useVaultAvailable: () => ({ canProvision: true, agentUrlSet: true, trustProxyUnsafe: false, impersonating: false }),
}));

const t = (key, options) => testI18n.t(key, options);

const servers = { getServerById: (id) => (Number(id) === 7 ? { id: 7, name: "web01", ip: "192.168.2.40", protocol: "ssh" } : null) };
const Servers = ({ children }) => <ServerContext.Provider value={servers}>{children}</ServerContext.Provider>;

const open = (onClose = () => {}) => renderWithProviders(
    <AgentAccessDialog open entryId={7} onClose={onClose} />,
    { providers: [ToastProvider, Servers] },
);

const node = (id) => document.querySelector(`[data-ui-id='${id}']`);

const runSetup = async (user, results) => {
    requestDouble.stub("postRequest", "vault/agent-keys", { results });
    await user.click(within(node("UI-AGENT-ACCESS-SETUP")).getByRole("button"));
    await within(node("UI-AGENT-ACCESS-RESULT")).findByText(t(`vault.agents.${results[0].agentType}`));
};

// DialogProvider calls onClose from onAnimationEnd, which jsdom never fires.
const closeDialog = async (user) => {
    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    fireEvent.animationEnd(document.querySelector(".dialog"));
};

const manual = {
    id: 41, agentType: "codex", status: "manual", remoteUser: "root",
    command: "codex mcp add outpost --url http://192.168.2.10:6989/api/mcp --bearer-token-env-var OUTPOST_MCP_TOKEN",
    probe: null, replacedRegistration: false,
};

beforeEach(() => {
    requestDouble.reset();
    clipboard.copyToClipboard.mockReset();
    requestDouble.stub("getRequest", "vault/agent-keys?entryId=7", { keys: [], remoteUser: "root", otherAccountConfigured: false });
});

test("closing without copying or automatic setup deletes the pending key", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    open(onClose);
    await runSetup(user, [manual]);
    requestDouble.stub("deleteRequest", "vault/agent-keys/41", { success: true });

    await closeDialog(user);

    expect(requestDouble.calls).toContainEqual({ method: "deleteRequest", path: "vault/agent-keys/41", body: undefined });
    expect(onClose).toHaveBeenCalled();
});

test("copying the command confirms the key, so closing afterwards deletes nothing", async () => {
    const user = userEvent.setup();
    clipboard.copyToClipboard.mockResolvedValue(true);
    open();
    await runSetup(user, [manual]);
    requestDouble.stub("postRequest", "vault/agent-keys/41/confirm", { success: true });

    await user.click(within(node("UI-AGENT-ACCESS-RESULT")).getByRole("button", { name: t("servers.agentAccess.result.copy") }));

    expect(clipboard.copyToClipboard).toHaveBeenCalledWith(manual.command);
    await waitFor(() => expect(requestDouble.calls).toContainEqual(
        { method: "postRequest", path: "vault/agent-keys/41/confirm", body: {} },
    ));
    await waitFor(() => expect(screen.queryByText(t("servers.agentAccess.result.keyNotice"))).not.toBeInTheDocument());

    await closeDialog(user);
    expect(requestDouble.calls.filter((call) => call.method === "deleteRequest")).toEqual([]);
});

test("a measured address that differs is offered for adoption and confirmed with addSeenIp", async () => {
    const user = userEvent.setup();
    open();
    await runSetup(user, [{
        id: 42, agentType: "claude", status: "configured", remoteUser: "root",
        probe: { seenIp: "172.17.0.1", matches: false }, replacedRegistration: false,
    }]);
    requestDouble.stub("postRequest", "vault/agent-keys/42/confirm", { success: true });

    expect(within(node("UI-AGENT-ACCESS-IPBIND")).getByText(
        t("servers.agentAccess.ipBind.seenOther", { seen: "172.17.0.1", expected: "192.168.2.40" }),
    )).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: t("servers.agentAccess.ipBind.adopt") }));

    await waitFor(() => expect(requestDouble.calls).toContainEqual(
        { method: "postRequest", path: "vault/agent-keys/42/confirm", body: { addSeenIp: true } },
    ));
});

test("revoking a key whose registration could not be removed shows the command to run on the server", async () => {
    const user = userEvent.setup();
    clipboard.copyToClipboard.mockResolvedValue(true);
    const commands = "codex mcp remove outpost";
    requestDouble.stub("getRequest", "vault/agent-keys?entryId=7", {
        keys: [{ id: 43, entryId: 7, agentType: "codex", pending: false, ipBinding: false, allowedCidrs: [],
            createdAt: "2026-10-09T08:00:00.000Z", lastUsedAt: null }],
        remoteUser: "root", otherAccountConfigured: false,
    });
    requestDouble.stub("deleteRequest", "vault/agent-keys/43", { success: true, registration: "unknown", commands });
    open();
    const keys = node("UI-AGENT-ACCESS-KEYS");

    await user.click(await within(keys).findByRole("button", { name: t("servers.agentAccess.keys.revoke") }));
    requestDouble.stub("getRequest", "vault/agent-keys?entryId=7", { keys: [], remoteUser: "root", otherAccountConfigured: false });
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: t("servers.agentAccess.keys.revoke") }));

    expect(await within(keys).findByText(t("servers.agentAccess.keys.empty"))).toBeInTheDocument();
    expect(within(keys).getByText(t("servers.agentAccess.keys.revokedUnknown"))).toBeInTheDocument();
    expect(within(keys).getByText(commands)).toBeInTheDocument();

    await user.click(within(keys).getByRole("button", { name: t("servers.agentAccess.result.copy") }));
    expect(clipboard.copyToClipboard).toHaveBeenCalledWith(commands);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn --cwd client vitest run src/pages/Servers/components/AgentAccessDialog/__tests__/AgentAccessDialog.test.jsx`
Expected: FAIL — `Failed to resolve import "../AgentAccessDialog.jsx"`.

- [ ] **Step 3: Implement the dialog**

`client/src/pages/Servers/components/AgentAccessDialog/AgentAccessDialog.jsx`:

```jsx
import "./styles.sass";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy as IconCopy, KeyRound as IconKeyRound, Network as IconNetwork } from "lucide-react";
import { DialogProvider } from "@/common/components/Dialog";
import Button from "@/common/components/Button";
import Checkbox from "@/common/components/Checkbox";
import ToggleSwitch from "@/common/components/ToggleSwitch";
import IconInput from "@/common/components/IconInput";
import Icon from "@/common/components/Icon";
import { ServerContext } from "@/common/contexts/ServerContext.jsx";
import { useToast } from "@/common/contexts/ToastContext.jsx";
import { useVaultAvailable } from "@/common/hooks/useVaultAvailable.js";
import { deleteRequest, getRequest, postRequest } from "@/common/utils/RequestUtil.js";
import { copyToClipboard } from "@/common/utils/clipboard.js";
import { formatTimeAgo } from "@/common/utils/timeAgo.js";

const AGENT_TYPES = ["claude", "codex"];
const raw = { interpolation: { escapeValue: false } };

// The prefix is optional: Task 8 stores a bare address as /32 or /128.
const IPV4_CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/;
const IPV6_CIDR = /^([0-9a-f:]+)(?:\/(\d{1,3}))?$/i;

export const isValidCidr = (value) => {
    const v4 = IPV4_CIDR.exec(value);
    if (v4) return v4.slice(1, 5).every((octet) => Number(octet) <= 255) && (v4[5] === undefined || Number(v4[5]) <= 32);
    const v6 = IPV6_CIDR.exec(value);
    if (!v6 || (v6[2] !== undefined && Number(v6[2]) > 128)) return false;
    const address = v6[1];
    if ((address.match(/::/g) || []).length > 1) return false;
    const groups = address.split(":").filter(Boolean);
    return groups.length <= 8 && groups.every((group) => group.length <= 4)
        && (address.includes("::") || groups.length === 8);
};

export const parseCidrs = (text) => text.split(/[\s,]+/).filter(Boolean);

export const AgentAccessDialog = ({ open, entryId, onClose }) => {
    const { t } = useTranslation();
    const { sendToast } = useToast();
    const { getServerById } = useContext(ServerContext);
    const { agentUrlSet, trustProxyUnsafe, impersonating } = useVaultAvailable();
    const server = entryId ? getServerById(entryId) : null;
    const serverName = server?.name ?? String(entryId ?? "");
    const address = server?.ip ?? "";

    const [keys, setKeys] = useState(null);
    const [remoteUser, setRemoteUser] = useState(null);
    const [otherAccountConfigured, setOtherAccountConfigured] = useState(false);
    const [agents, setAgents] = useState({ claude: true, codex: true });
    const [ipBinding, setIpBinding] = useState(true);
    const [cidrText, setCidrText] = useState("");
    const [cidrInvalid, setCidrInvalid] = useState(false);
    const [settingUp, setSettingUp] = useState(false);
    const [results, setResults] = useState([]);
    const [adoptOffer, setAdoptOffer] = useState(null);
    const [adoptSeenIp, setAdoptSeenIp] = useState(false);
    const [probeFailed, setProbeFailed] = useState(false);
    const [revokeTarget, setRevokeTarget] = useState(null);
    const [revokeErrorId, setRevokeErrorId] = useState(null);
    const [revokeOutcome, setRevokeOutcome] = useState(null);
    const setupInFlight = useRef(false);
    const revoking = useRef(false);

    const agentLabel = (type) => t(`vault.agents.${type}`);

    const loadKeys = useCallback(async () => {
        try {
            const data = await getRequest(`vault/agent-keys?entryId=${entryId}`);
            setKeys((data.keys || []).filter((key) => !key.pending));
            setRemoteUser(data.remoteUser ?? null);
            setOtherAccountConfigured(data.otherAccountConfigured === true);
        } catch (err) {
            setKeys([]);
            sendToast(t("common.error"), err?.message || t("common.error"));
        }
    }, [entryId, sendToast, t]);

    useEffect(() => {
        if (open && entryId) loadKeys();
    }, [open, entryId, loadKeys]);

    const discardPending = (list) => Promise.all(list
        .filter((result) => !result.confirmed)
        .map((result) => deleteRequest(`vault/agent-keys/${result.id}`).catch(() => {})));

    const fieldsDisabled = settingUp || !agentUrlSet || impersonating;
    const setupDisabled = fieldsDisabled || !AGENT_TYPES.some((type) => agents[type]);

    const setup = async () => {
        if (setupDisabled || setupInFlight.current) return;
        const allowedCidrs = parseCidrs(cidrText);
        if (!allowedCidrs.every(isValidCidr)) {
            setCidrInvalid(true);
            return;
        }
        setCidrInvalid(false);
        setupInFlight.current = true;
        setSettingUp(true);
        try {
            await discardPending(results);
            setResults([]);
            setProbeFailed(false);
            const data = await postRequest("vault/agent-keys", {
                entryId,
                agentTypes: AGENT_TYPES.filter((type) => agents[type]),
                ipBinding,
                allowedCidrs,
            });
            const next = data.results.map((result) => ({ ...result, confirmed: result.status === "configured" }));
            const mismatch = ipBinding ? next.find((result) => result.probe?.matches === false) : null;
            setResults(next);
            setAdoptOffer(mismatch ? mismatch.probe.seenIp : null);
            setAdoptSeenIp(false);
            setProbeFailed(ipBinding && next.some((result) => result.probe === null));
            loadKeys();
        } catch (err) {
            sendToast(t("common.error"), err?.message || t("common.error"));
            loadKeys();
        } finally {
            setupInFlight.current = false;
            setSettingUp(false);
        }
    };

    const confirmBody = (result, adopted) => (adopted && result.probe?.matches === false ? { addSeenIp: true } : {});

    const adopt = async () => {
        const offer = adoptOffer;
        setAdoptOffer(null);
        setAdoptSeenIp(true);
        try {
            await Promise.all(results
                .filter((result) => result.confirmed && result.probe?.matches === false)
                .map((result) => postRequest(`vault/agent-keys/${result.id}/confirm`, confirmBody(result, true))));
            loadKeys();
        } catch (err) {
            setAdoptOffer(offer);
            setAdoptSeenIp(false);
            sendToast(t("common.error"), err?.message || t("common.error"));
        }
    };

    const copyCommand = async (result) => {
        if (!(await copyToClipboard(result.command))) {
            sendToast(t("common.error"), t("settings.account.apiKeys.copyError"));
            return;
        }
        if (result.confirmed) return;
        try {
            await postRequest(`vault/agent-keys/${result.id}/confirm`, confirmBody(result, adoptSeenIp));
            setResults((prev) => prev.map((entry) => (entry.id === result.id ? { ...entry, confirmed: true } : entry)));
            loadKeys();
        } catch (err) {
            if (err?.code === 404 || err?.code === 410) {
                setResults((prev) => prev.filter((entry) => entry.id !== result.id));
                loadKeys();
            }
            sendToast(t("common.error"), err?.message || t("common.error"));
        }
    };

    const revoke = async (key) => {
        if (revoking.current) return;
        revoking.current = true;
        setRevokeTarget(null);
        setRevokeOutcome(null);
        try {
            const data = await deleteRequest(`vault/agent-keys/${key.id}`);
            setRevokeErrorId(null);
            if (data.registration === "foreign" || data.registration === "unknown") {
                setRevokeOutcome({ registration: data.registration, commands: data.commands ?? null });
            }
            loadKeys();
        } catch (err) {
            if (err?.code === 404) loadKeys();
            else setRevokeErrorId(key.id);
        } finally {
            revoking.current = false;
        }
    };

    const copyRevokeCommands = async () => {
        if (!(await copyToClipboard(revokeOutcome.commands))) {
            sendToast(t("common.error"), t("settings.account.apiKeys.copyError"));
        }
    };

    const handleClose = () => {
        discardPending(results);
        setResults([]);
        setAdoptOffer(null);
        setAdoptSeenIp(false);
        setProbeFailed(false);
        setKeys(null);
        setCidrText("");
        setCidrInvalid(false);
        setRevokeTarget(null);
        setRevokeErrorId(null);
        setRevokeOutcome(null);
        onClose();
    };

    const onKeyDown = (event) => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            setup();
        }
    };

    const keyMeta = (key) => [
        t("servers.agentAccess.keys.created", {
            date: new Date(key.createdAt).toLocaleDateString(undefined, { day: "2-digit", month: "2-digit" }), ...raw,
        }),
        key.lastUsedAt
            ? t("servers.agentAccess.keys.lastUsed", { time: formatTimeAgo(key.lastUsedAt, t), ...raw })
            : t("settings.account.apiKeys.neverUsed"),
        key.ipBinding
            ? t("servers.agentAccess.keys.boundTo", { address: [address, ...key.allowedCidrs].filter(Boolean).join(", "), ...raw })
            : t("servers.agentAccess.keys.anywhere"),
    ].join(" · ");

    const resultText = (result) => {
        if (result.status === "configured") {
            return t(result.agentType === "codex" ? "servers.agentAccess.result.successCodex" : "servers.agentAccess.result.success",
                { user: result.remoteUser, ...raw });
        }
        return result.reason === "cli_missing"
            ? t("servers.agentAccess.result.error", { cli: result.agentType, ...raw })
            : t("servers.agentAccess.result.manual");
    };

    return (
        <DialogProvider open={open} onClose={handleClose} disableClosing={settingUp}>
            <div className="agent-access-dialog" data-ui-id="UI-AGENT-ACCESS" onKeyDown={onKeyDown}>
                <h2>{t("servers.agentAccess.title", { name: serverName, ...raw })}</h2>

                <section className="agent-access-keys" data-ui-id="UI-AGENT-ACCESS-KEYS" aria-busy={keys === null || undefined}>
                    <h3>{t("servers.agentAccess.keys.title")}</h3>
                    {keys === null ? (
                        <div className="agent-row is-loading">
                            <Icon icon={IconKeyRound} />
                            <span className="skeleton" />
                        </div>
                    ) : keys.length === 0 ? (
                        <p className="agent-access-empty">{t("servers.agentAccess.keys.empty")}</p>
                    ) : keys.map((key) => (
                        <div key={key.id}>
                            <div className="agent-row">
                                <Icon icon={IconKeyRound} />
                                <div className="agent-row-main">
                                    <span>{agentLabel(key.agentType)}</span>
                                    <span className="agent-row-meta">{keyMeta(key)}</span>
                                </div>
                                {!impersonating && (
                                    <Button type="secondary" buttonType="button" text={t("servers.agentAccess.keys.revoke")}
                                            onClick={() => setRevokeTarget(key)} />
                                )}
                            </div>
                            {revokeTarget?.id === key.id && (
                                <div className="agent-access-confirm" role="alertdialog" aria-label={t("servers.agentAccess.keys.revoke")}>
                                    <p>{t("servers.agentAccess.keys.revokeConfirm", { agent: agentLabel(key.agentType), server: serverName, ...raw })}</p>
                                    <div className="agent-access-actions">
                                        <Button type="secondary" buttonType="button" text={t("common.actions.cancel")}
                                                onClick={() => setRevokeTarget(null)} />
                                        <Button type="primary" buttonType="button" text={t("servers.agentAccess.keys.revoke")}
                                                onClick={() => revoke(key)} />
                                    </div>
                                </div>
                            )}
                            {revokeErrorId === key.id && (
                                <p className="agent-access-error" role="alert">{t("servers.agentAccess.keys.revokeError")}</p>
                            )}
                        </div>
                    ))}
                    {revokeOutcome && (
                        <div className="agent-access-revoked" role="status">
                            <p className="agent-access-notice">
                                {revokeOutcome.registration === "foreign"
                                    ? t("servers.agentAccess.keys.revokedForeign", { server: serverName, ...raw })
                                    : t("servers.agentAccess.keys.revokedUnknown")}
                            </p>
                            {revokeOutcome.commands && (
                                <div className="agent-result-command">
                                    <pre>{revokeOutcome.commands}</pre>
                                    <Button type="secondary" buttonType="button" icon={IconCopy}
                                            text={t("servers.agentAccess.result.copy")} onClick={copyRevokeCommands} />
                                </div>
                            )}
                        </div>
                    )}
                </section>

                <form className="agent-access-setup" data-ui-id="UI-AGENT-ACCESS-SETUP" aria-busy={settingUp || undefined}
                      onSubmit={(event) => event.preventDefault()}>
                    {otherAccountConfigured && remoteUser && (
                        <div className="agent-access-warning agent-access-foreign" role="status">
                            <p>{t("servers.agentAccess.setup.foreignAccount", { user: remoteUser, server: serverName, ...raw })}</p>
                        </div>
                    )}
                    <div className="agent-access-checks">
                        {AGENT_TYPES.map((type) => (
                            <div className="agent-access-check" key={type}>
                                <Checkbox id={`agent-access-${type}`} checked={agents[type]} disabled={fieldsDisabled}
                                          onChange={(checked) => setAgents((prev) => ({ ...prev, [type]: checked }))} />
                                <label htmlFor={`agent-access-${type}`}>{agentLabel(type)}</label>
                            </div>
                        ))}
                    </div>
                    <div className={`agent-access-cidr-field${cidrInvalid ? " is-error" : ""}`}>
                        <label htmlFor="agent-access-cidrs">{t("servers.agentAccess.setup.cidrLabel")}</label>
                        <IconInput id="agent-access-cidrs" icon={IconNetwork} value={cidrText} disabled={fieldsDisabled}
                                   setValue={(value) => { setCidrText(value); setCidrInvalid(false); }} />
                        {cidrInvalid && (
                            <span className="agent-access-help is-error" role="alert">{t("servers.agentAccess.setup.cidrInvalid")}</span>
                        )}
                    </div>
                    {!agentUrlSet && (
                        <p className="agent-access-notice agent-access-url-missing">{t("servers.agentAccess.setup.urlMissing")}</p>
                    )}
                    <div className="agent-access-submit">
                        <Button type="primary" buttonType="button" onClick={setup} disabled={setupDisabled} loading={settingUp} kbd="Ctrl+Enter"
                                text={settingUp ? t("servers.agentAccess.setup.loading") : t("servers.agentAccess.setup.submit")} />
                    </div>
                </form>

                <div className="agent-access-ipbind" data-ui-id="UI-AGENT-ACCESS-IPBIND">
                    <div className="agent-access-ipbind-row">
                        <div className="agent-access-ipbind-label">
                            <label htmlFor="agent-access-ipbind">{t("servers.agentAccess.ipBind.label")}</label>
                            <span className="agent-access-help">
                                {ipBinding
                                    ? <>{t("servers.agentAccess.ipBind.on")} · <span className="mono">{address}</span></>
                                    : t("servers.agentAccess.ipBind.off")}
                            </span>
                        </div>
                        <ToggleSwitch id="agent-access-ipbind" checked={ipBinding} onChange={setIpBinding} disabled={fieldsDisabled} />
                    </div>
                    {adoptOffer && (
                        <div className="agent-access-confirm" role="status">
                            <p>{t("servers.agentAccess.ipBind.seenOther", { seen: adoptOffer, expected: address, ...raw })}</p>
                            <div className="agent-access-actions">
                                <Button type="secondary" buttonType="button" text={t("servers.agentAccess.ipBind.decline")}
                                        onClick={() => setAdoptOffer(null)} />
                                <Button type="primary" buttonType="button" text={t("servers.agentAccess.ipBind.adopt")}
                                        onClick={adopt} />
                            </div>
                        </div>
                    )}
                    {probeFailed && (
                        <p className="agent-access-notice" role="status">{t("servers.agentAccess.ipBind.probeFailed")}</p>
                    )}
                    {trustProxyUnsafe && (
                        <div className="agent-access-warning" role="alert">
                            <p>{t("servers.agentAccess.ipBind.trustProxy")}</p>
                        </div>
                    )}
                </div>

                <section className="agent-access-result" data-ui-id="UI-AGENT-ACCESS-RESULT">
                    {results.length === 0 ? (
                        <p className="agent-access-empty">{t("servers.agentAccess.result.empty")}</p>
                    ) : results.map((result) => (
                        <div key={result.id} className={`agent-result ${result.status === "configured" ? "is-ok" : "is-fail"}`}>
                            <div className="agent-result-head">
                                <span>{agentLabel(result.agentType)}</span>
                                <span className="agent-result-status">
                                    {t(result.status === "configured" ? "servers.agentAccess.result.configured" : "servers.agentAccess.result.failed")}
                                </span>
                            </div>
                            <p className={`agent-access-help${result.status === "configured" ? "" : " is-error"}`}>{resultText(result)}</p>
                            {result.replacedRegistration && (
                                <p className="agent-access-notice">{t("servers.agentAccess.result.replaced")}</p>
                            )}
                            {result.status !== "configured" && (
                                <>
                                    <div className="agent-result-command">
                                        <pre>{result.command}</pre>
                                        <Button type="secondary" buttonType="button" icon={IconCopy}
                                                text={t("servers.agentAccess.result.copy")} onClick={() => copyCommand(result)} />
                                    </div>
                                    {!result.confirmed && (
                                        <p className="agent-access-notice">{t("servers.agentAccess.result.keyNotice")}</p>
                                    )}
                                </>
                            )}
                        </div>
                    ))}
                </section>
            </div>
        </DialogProvider>
    );
};
```

- [ ] **Step 4: `index.js` und Styles**

`client/src/pages/Servers/components/AgentAccessDialog/index.js`:

```js
export { AgentAccessDialog as default } from "./AgentAccessDialog.jsx";
```

`client/src/pages/Servers/components/AgentAccessDialog/styles.sass`:

```sass
@use "@/common/styles/colors"
@use "@/common/styles/tokens"

.agent-access-dialog
  display: flex
  flex-direction: column
  gap: tokens.$space-4
  width: 40rem
  max-width: 90vw
  max-height: 85vh
  overflow-y: auto

  h2
    margin: 0
    font: tokens.$type-title
    color: colors.$white

  h3
    margin: 0 0 tokens.$space-2
    font: tokens.$type-heading

  p
    margin: 0

  .mono
    font: tokens.$type-mono

  // The form only groups SETUP for its marker; with display: contents its parts
  // join this column, so IPBIND (outside SETUP) can sit between agent choice and ranges.
  .agent-access-setup
    display: contents

  .agent-access-keys
    order: 1

  .agent-access-foreign
    order: 2

  .agent-access-checks
    order: 3
    display: flex
    gap: tokens.$space-6

  .agent-access-ipbind
    order: 4
    display: flex
    flex-direction: column
    gap: tokens.$space-2

  .agent-access-cidr-field
    order: 5
    display: flex
    flex-direction: column
    gap: tokens.$space-1

    &.is-error .input
      border-color: colors.$error

  .agent-access-url-missing
    order: 6

  .agent-access-submit
    order: 7
    display: flex
    justify-content: flex-end

  .agent-access-result
    order: 8
    display: flex
    flex-direction: column
    gap: tokens.$space-2

  .agent-access-check
    display: flex
    align-items: center
    gap: tokens.$space-2

  .agent-row
    display: flex
    align-items: center
    gap: tokens.$space-3
    padding: tokens.$space-2 0

    svg
      flex-shrink: 0
      color: colors.$subtext

    .agent-row-main
      display: flex
      flex: 1
      flex-direction: column
      min-width: 0

    .agent-row-meta
      font: tokens.$type-mono
      color: colors.$subtext
      overflow-wrap: anywhere

    &.is-loading .skeleton
      flex: 1
      height: 1rem
      border-radius: tokens.$radius-sm
      background: colors.$gray

  .agent-access-empty
    color: colors.$subtext

  .agent-access-confirm,
  .agent-access-warning
    padding: tokens.$space-3
    border-left: 3px solid colors.$warning
    border-radius: tokens.$radius-md
    background: colors.$warning-opacity

  .agent-access-actions
    display: flex
    justify-content: flex-end
    gap: tokens.$space-2
    margin-top: tokens.$space-2

  .agent-access-ipbind-row
    display: flex
    align-items: center
    justify-content: space-between
    gap: tokens.$space-4

  .agent-access-ipbind-label
    display: flex
    flex-direction: column

  .agent-access-help
    font: tokens.$type-caption
    color: colors.$subtext

    &.is-error
      color: colors.$error

  .agent-access-error
    color: colors.$error

  .agent-access-revoked
    display: flex
    flex-direction: column
    gap: tokens.$space-1
    margin-top: tokens.$space-2

  .agent-access-notice
    font: tokens.$type-caption
    color: colors.$warning

  .agent-result
    display: flex
    flex-direction: column
    gap: tokens.$space-1
    padding: tokens.$space-2 tokens.$space-3
    border-left: 3px solid colors.$subtext

    &.is-ok
      border-left-color: colors.$success

    &.is-fail
      border-left-color: colors.$error

  .agent-result-head
    display: flex
    justify-content: space-between
    gap: tokens.$space-2

  .agent-result-status
    font: tokens.$type-caption
    color: colors.$subtext

  .agent-result-command
    display: flex
    align-items: flex-start
    gap: tokens.$space-2

    pre
      flex: 1
      margin: 0
      padding: tokens.$space-2
      font: tokens.$type-mono
      white-space: pre-wrap
      overflow-wrap: anywhere
      background: colors.$dark-gray
      border-radius: tokens.$radius-sm
```

- [ ] **Step 5: Run test to verify it passes**

Run: `yarn --cwd client vitest run src/pages/Servers/components/AgentAccessDialog/__tests__/AgentAccessDialog.test.jsx`
Expected: PASS (4 Tests). Fehlt ein Schlüssel aus Task 10 (`i18n: missing key "servers.agentAccess.…"`): nicht nachtragen und nicht umbenennen, sondern anhalten und den fehlenden Schlüssel melden.

- [ ] **Step 6: Menüpunkt in `ServerList.jsx`**

Z. 17: im lucide-Import nach `Waypoints as IconWaypoints` ergänzen: `, KeyRound as IconKeyRound`.

Nach Z. 29 (`import { Permission } from "@/common/utils/permissions.js";`):

```jsx
import { Permission } from "@/common/utils/permissions.js";
import { useVaultAvailable } from "@/common/hooks/useVaultAvailable.js";
import AgentAccessDialog from "@/pages/Servers/components/AgentAccessDialog";
```

Nach Z. 97 (`const demoEnabled = useDevFeature("demo", import.meta.env.DEV);`):

```jsx
    const demoEnabled = useDevFeature("demo", import.meta.env.DEV);
    const { canProvision, impersonating } = useVaultAvailable();
```

Nach Z. 120 (`const [deleteConfirmDialog, …] = useState(…);`):

```jsx
    const [deleteConfirmDialog, setDeleteConfirmDialog] = useState({ open: false, name: "", id: null, isFolder: false });
    const [agentAccessEntryId, setAgentAccessEntryId] = useState(null);
```

Z. 923-930, vorher:

```jsx
                                <ContextMenuItem
                                    icon={IconTag}
                                    label={t("servers.tags.title")}
                                >
                                    <TagsSubmenu entryId={contextClickedId} entryTags={server?.tags || []} />
                                </ContextMenuItem>

                                <ContextMenuSeparator />
```

nachher:

```jsx
                                <ContextMenuItem
                                    icon={IconTag}
                                    label={t("servers.tags.title")}
                                >
                                    <TagsSubmenu entryId={contextClickedId} entryTags={server?.tags || []} />
                                </ContextMenuItem>

                                {server?.protocol === "ssh" && canProvision && !impersonating && (
                                    <ContextMenuItem
                                        icon={IconKeyRound}
                                        label={t("servers.contextMenu.agentAccess")}
                                        onClick={() => setAgentAccessEntryId(server.id)}
                                    />
                                )}

                                <ContextMenuSeparator />
```

Z. 1034-1039, nach dem `ActionConfirmDialog` für das Löschen:

```jsx
                    <ActionConfirmDialog
                        open={deleteConfirmDialog.open}
                        setOpen={(open) => setDeleteConfirmDialog(prev => ({ ...prev, open }))}
                        onConfirm={handleDeleteConfirm}
                        text={t("servers.contextMenu.deleteConfirm", { name: deleteConfirmDialog.name })}
                    />

                    <AgentAccessDialog
                        open={agentAccessEntryId !== null}
                        entryId={agentAccessEntryId}
                        onClose={() => setAgentAccessEntryId(null)}
                    />
```

Der Dialog bleibt immer gemountet und wird über `open` gesteuert; nur so läuft sein `onClose` (Verwerfen der `pending`-Keys) nach der Schließ-Animation.

- [ ] **Step 7: Lint und betroffene Tests**

Run: `yarn --cwd client lint && yarn --cwd client vitest run src/pages/Servers`
Expected: keine neuen Lint-Fehler; alle Tests unter `src/pages/Servers` grün.

- [ ] **Step 8: Commit**

```bash
git add client/src/pages/Servers/components/AgentAccessDialog client/src/pages/Servers/components/ServerList/ServerList.jsx
git commit -m "Vault: Agenten-Zugang-Dialog und Menüpunkt im Server-Kontextmenü"
```

**i18n-Schlüssel, die dieser Task benutzt (angelegt in Task 10):**

| Schlüssel | de_DE |
|---|---|
| `servers.contextMenu.agentAccess` | Agenten-Zugang… |
| `servers.agentAccess.title` | Agenten-Zugang — {{name}} |
| `servers.agentAccess.keys.title` | Agenten auf diesem Server |
| `servers.agentAccess.keys.empty` | Noch kein Agent auf diesem Server eingerichtet. |
| `servers.agentAccess.keys.revoke` | Entziehen |
| `servers.agentAccess.keys.revokeConfirm` | Zugang von {{agent}} auf {{server}} entziehen? Der Agent verliert sofort den Zugriff. |
| `servers.agentAccess.keys.revokeError` | Entziehen fehlgeschlagen. |
| `servers.agentAccess.keys.revokedForeign` | Zugang entzogen. Die Registrierung auf {{server}} trägt den Key eines anderen Kontos und bleibt stehen. |
| `servers.agentAccess.keys.revokedUnknown` | Zugang entzogen. Die Registrierung konnte nicht entfernt werden — Befehl kopieren und auf dem Server ausführen. |
| `servers.agentAccess.keys.created` | angelegt {{date}} |
| `servers.agentAccess.keys.lastUsed` | zuletzt {{time}} |
| `servers.agentAccess.keys.boundTo` | nur {{address}} |
| `servers.agentAccess.keys.anywhere` | von überall |
| `servers.agentAccess.setup.submit` | Einrichten |
| `servers.agentAccess.setup.loading` | Richte ein … |
| `servers.agentAccess.setup.cidrLabel` | Zusätzliche Adressbereiche |
| `servers.agentAccess.setup.cidrInvalid` | Ungültiger Adressbereich. |
| `servers.agentAccess.setup.urlMissing` | Outpost-Adresse für Agenten fehlt — in Einstellungen › Vault setzen. |
| `servers.agentAccess.setup.foreignAccount` | Für {{user}} auf {{server}} hat bereits ein anderes Konto Agenten-Zugang eingerichtet — die Registrierung wird ersetzt. |
| `servers.agentAccess.ipBind.label` | Nur von der IP dieses Servers |
| `servers.agentAccess.ipBind.on` | an |
| `servers.agentAccess.ipBind.off` | aus — von überall |
| `servers.agentAccess.ipBind.seenOther` | Gesehen wurde {{seen}} statt {{expected}} — als Adressbereich übernehmen? Ohne Übernahme weist Outpost den Key ab. |
| `servers.agentAccess.ipBind.probeFailed` | Adresse konnte nicht gemessen werden — der Key gilt für die aufgelöste Adresse des Servers. |
| `servers.agentAccess.ipBind.adopt` | Übernehmen |
| `servers.agentAccess.ipBind.decline` | Nein |
| `servers.agentAccess.ipBind.trustProxy` | TRUST_PROXY=true — die IP-Bindung ist wirkungslos. |
| `servers.agentAccess.result.empty` | erscheint erst nach dem Einrichten |
| `servers.agentAccess.result.configured` | eingerichtet |
| `servers.agentAccess.result.failed` | gescheitert |
| `servers.agentAccess.result.success` | Eingerichtet für {{user}}. Claude Code neu starten, dann /mcp. |
| `servers.agentAccess.result.successCodex` | Eingerichtet für {{user}}. Codex in einer neuen Shell starten; laufende Codex-Prozesse und tmux-Sitzungen kennen den Key nicht. |
| `servers.agentAccess.result.error` | {{cli}} nicht gefunden. Befehl kopieren und auf dem Server ausführen. |
| `servers.agentAccess.result.manual` | Befehl kopieren und auf dem Server ausführen. |
| `servers.agentAccess.result.copy` | Kopieren |
| `servers.agentAccess.result.keyNotice` | Der Key ist nur jetzt sichtbar. Schließen ohne Übernahme löscht ihn. |
| `servers.agentAccess.result.replaced` | Bestehende Registrierung ersetzt — der alte Konto-Key bleibt gültig, bis du ihn unter API-Schlüssel löschst. |
| `vault.agents.claude` | Claude Code |
| `vault.agents.codex` | Codex |
| `settings.account.apiKeys.neverUsed`, `settings.account.apiKeys.copyError`, `common.actions.cancel`, `common.error`, `servers.time.*` | (Bestand) |

---

### Task 5: REST: Einträge, Reveal, Einstellungen, Verfügbarkeit

**Files:**
- Create: `server/validations/vault.js`
- Create: `server/controllers/vaultItems.js`
- Create: `server/controllers/vaultSettings.js`
- Modify: `server/routes/vault/items.js` (leeren `Router()`-Platzhalter aus Task 1 vollständig ersetzen)
- Modify: `server/routes/vault/settings.js` (leeren `Router()`-Platzhalter aus Task 1 vollständig ersetzen)
- Test: `server/lib/vault/__tests__/validation.test.js`
- Test: `server/lib/vault/__tests__/itemsRoute.test.js`

**Interfaces:**
- Consumes:
  - Task 1: Modelle `VaultItem` (mit `afterFind`-Hook: `fields` als Objekt, `approvalRequired`/`allServers` als Boolean, auch unter `query: { raw: true }`), `VaultSecret`, `VaultBinding`, `VaultSettings.getOrCreate()`; aus `server/lib/vault/state.js` `initVaultState() → Promise<{ keyStatus }>`, `getKeyStatus() → "active"|"missing"|"mismatch"`, `isVaultEnabled() → boolean`, `requireVaultEnabled(req, res, next)`, `_resetForTests()`; aus `server/lib/vault/secrets.js` `writeSecret(itemId, field, value) → Promise<void>`, `readSecret(itemId, field) → Promise<string|null>` (wirft `VaultError(ITEM_UNREADABLE)`), `clearSecrets(itemId) → Promise<number>`, `isUnreadable(itemId) → boolean` (Entschlüsselungsfehler von `readSecret` markiert, `writeSecret`/`clearSecrets` heben die Marke auf); `VaultError`, `VaultErrorCode` aus `server/lib/vault/errors.js`; `Permission.SETTINGS_VAULT`; `AUDIT_ACTIONS.VAULT_ITEM_CREATE|VAULT_ITEM_UPDATE|VAULT_ITEM_DELETE|VAULT_REVEAL|VAULT_ITEM_UNREADABLE`, `RESOURCE_TYPES.VAULT`.
  - Task 3: aus `server/lib/vault/visibility.js` `itemRef(item) → string`, `activeOrganizationIds(accountId) → Promise<number[]>`, `ownedItems(accountId) → Promise<VaultItem[]>` (eigene Einträge mit `vault.use` und die der Organisationen mit aktiver Mitgliedschaft, nach Name sortiert), `canUseVault(accountId) → Promise<boolean>`, `canManageItem(accountId, item) → Promise<boolean>`, `canRevealItem(accountId, item) → Promise<boolean>`, `canCreateFor(accountId, { organizationId }) → Promise<boolean>`; aus `server/lib/vault/bindings.js` `validateBindings({ accountId, organizationId }, bindings) → Promise<{ valid: true } | { valid: false, message }>`, `setBindings(itemId, bindings) → Promise<void>`.
  - Task 4: `const { requireLoginSession } = require("../../middlewares/requireLoginSession")` (benannter Export wie `authenticate`/`requirePermission`); `authenticate` setzt bei Login-Sessions `req.session` (mit `impersonatorId`), bei Konto-Keys `req.apiKey`.
- Produces (von Tasks 10, 12, 15 genutzt; Task 8 liest die Agenten-Adresse selbst aus `VaultSettings.getOrCreate()`):
  - `GET /api/vault/available` → immer `200 { enabled, canUse, canManageOrgs: number[], canProvision, agentUrlSet, impersonating, trustProxyUnsafe }`; bei ausgeschaltetem Vault `canUse:false`, `canManageOrgs:[]`, `canProvision:false` (`agentUrlSet`, `impersonating`, `trustProxyUnsafe` bleiben echte Werte).
  - `GET /api/vault/items` → `{ items: Item[] }`, `Item = { id, ref, accountId, organizationId, ownerName (Organisationsname, bei persönlichen Einträgen null), name, type, description, fields, approvalRequired, allServers, bindings: [{ kind, targetId, label|null }], secretFields: string[], unreadable, lastUsedAt, canManage, canReveal }`. `canReveal` ist in Impersonations-Sitzungen und mit Konto-Key immer `false`. `unreadable` ist `isUnreadable(item.id)`: `true`, sobald ein Wert seit dem Start nicht entschlüsselt werden konnte, bis er neu geschrieben oder gelöscht wird (Grundlage für den Zustand `error` von `UI-VAULT-DETAIL`, Task 12).
  - `POST /api/vault/items` → `201 { item }`; `400` (Joi, Bindung), `403` (kein Recht für diesen Besitzer; `approvalRequired: false` aus Impersonation oder mit Konto-Key → `403 { code: 403, message: "Turning off approvals requires a signed-in session" }`), `409` (Name beim Besitzer vergeben).
  - `PATCH /api/vault/items/:id` → `{ item, secretsCleared }`; `404` unbekannt oder fremder Mandant, `403` ohne Verwaltungsrecht oder beim Umschalten von `approvalRequired` auf `false` (Eintrag steht noch auf `true`) aus Impersonation/mit Konto-Key (Meldung wie bei `POST`); steht der Eintrag schon auf `false`, geht ein `PATCH` mit `approvalRequired: false` auch von dort durch, `409` Name vergeben (Vorabprüfung und `SequelizeUniqueConstraintError` beim Schreiben; dann sind weder neue Werte noch Bindungen gespeichert, bei neuem Ziel schon gelöschte Werte bleiben gelöscht).
  - `DELETE /api/vault/items/:id` → `{ success: true }` (Werte und Bindungen werden mitgelöscht).
  - `GET /api/vault/items/:id/secrets/:field` → `{ value }` mit `Cache-Control: no-store`; `403` ohne Recht/ohne Login-Session/Impersonation, `404` unbekannt, fremder Mandant, Feld nicht vom Typ oder kein Wert, `422 { code: 422, message }` wenn der Wert nicht entschlüsselt werden kann (Audit `vault.item_unreadable`; Grundlage für den Zustand `error` von `UI-VAULT-DETAIL`), `429` ab dem 31. Abruf je Minute und Konto.
  - `GET`/`PATCH /api/vault/settings` (Recht `settings.vault`, auch bei ausgeschaltetem Vault) → `{ keyStatus, agentUrl, trustProxyUnsafe }`; `agentUrl` wird ohne abschließenden Schrägstrich gespeichert, `""`/`null` löscht sie.
  - `server/controllers/vaultSettings.js`: `getVaultSettings() → Promise<{ keyStatus, agentUrl }>`, `updateVaultSettings({ agentUrl }) → Promise<{ keyStatus, agentUrl }>`, `getAgentUrl() → Promise<string|null>` (nur innerhalb dieser Datei genutzt, von `getVaultSettings` und `getVaultAvailability`; Task 8 nutzt es nicht), zusätzlich `getVaultAvailability(accountId, { impersonating, trustProxyUnsafe }) → Promise<object>` (Antwort von `available`).
  - `server/validations/vault.js`: `SECRET_FIELDS` (`{ login: ["password"], api_key: ["token"], ssh: ["privateKey","password","passphrase"], database: ["password"], generic: ["value"] }`), `createVaultItemValidation`, `updateVaultItemSchema(type) → Joi.ObjectSchema`, `updateVaultSettingsValidation`. Ursprünge werden auf `new URL(x).origin` normalisiert gespeichert (Kleinschreibung, Standardport entfernt) — Task 11 vergleicht gegen genau diese Form.

**Design:** kein UI-Anteil.

**Tests:** 5 Tests in 2 Dateien, test-first (der Vertrag steht in der Spec, Abschnitte „REST-Endpunkte“, „Impersonation“ und „Oberfläche“ → Eintrag-Dialog).
- `validation.test.js`, 1 Test mit Tabellenfällen: Felder je Typ, Ursprungsform und -normalisierung, Namensmuster, Geheimfelder je Typ (auch beim Ändern), Bindungsarten, `agentUrl` (SEC-INPUT-01).
- `itemsRoute.test.js`, 4 Tests über die Naht Router → Controller → echte Task-1/3/4-Module → In-Memory-SQLite; gefälscht werden nur `utils/database`, `permissions/engine`, `middlewares/auth` (setzt `req.user`/`req.session`/`req.apiKey` je Token) und `createAuditLog`:
  1. Spec-Test 3: Reveal als Besitzer persönlich `200`, mit `vault.reveal` in der Organisation `200`, aktives Mitglied ohne Recht `403`, nur eingeladenes Konto mit Org-Rechten `404`, fremdes persönliches Konto `404`, Feld eines anderen Typs `404`; genau zwei Audits `vault.reveal`, kein Wert im Audit; ein Wert, der sich nicht entschlüsseln lässt, gibt `422` mit Audit `vault.item_unreadable`, die Liste meldet `unreadable:true`, bis der Wert neu geschrieben ist (SEC-IDOR-01, SEC-TENANT-01, SEC-RBAC-01, SEC-SECRET-01, SEC-ERR-01).
  2. Spec-Test 11 Teil 2 (Reveal) und „Freigabe erforderlich“: Impersonations-Sitzung und Konto-Key bekommen beim Reveal `403`, beim Anlegen oder Umschalten auf `approvalRequired: false` `403` „Turning off approvals requires a signed-in session“ (nichts angelegt, Eintrag unverändert), alles ohne Audit; die Liste meldet dort `canReveal:false`; dieselbe Änderung aus der Login-Session gelingt; steht der Eintrag danach auf `false`, geht ein `PATCH` der Beschreibung mit `approvalRequired: false` auch aus der Impersonation durch (SEC-RBAC-01).
  3. Spec-Test 11 Teil 1: `PATCH` mit gleichem Ursprung in anderer Schreibweise behält den Wert, mit neuem Ursprung löscht er ihn im selben Vorgang (Audit `secretsCleared:true`), mit neuem Ursprung und neuem Wert steht nur der neue Wert; `GET /items` und Audit enthalten keinen der Werte.
  4. `available` inkl. `trustProxyUnsafe` (`trust proxy` `true` vs. Hop-Zahl), `impersonating`, `canManageOrgs` (nur aktive Mitgliedschaft), `agentUrlSet` nach `PATCH /settings`; Vault aus → Rechte leer, `/items` `404`, `/settings` meldet `missing`.
- Nicht getestet: Rate-Limit (Framework-Zusage von express-rate-limit, Konfiguration wie `bookmarkRateLimiter`), `DELETE` und Bindungs-Labels (reine Weiterreichung an `setBindings`/`clearSecrets`, deren Verhalten Task 1/3 testen), Rechte-Matrix von `canCreateFor`/`canManageItem` (Task 3), der `409` aus `SequelizeUniqueConstraintError` (nur bei gleichzeitigem Anlegen desselben Namens nach der Vorabprüfung erreichbar) und das Protokollieren eines fehlgeschlagenen Aufräumens in `createItem` (Log-Ausgabe), OpenAPI-Kommentare.
- SEC-Abdeckung dieses Tasks: SEC-INPUT-01, SEC-ERR-01 (500 ohne Details, 422 ohne Details), SEC-SECRET-01, SEC-RATE-01 (Reveal), SEC-SQLI-01 (nur Sequelize-`where`), SEC-IDOR-01, SEC-TENANT-01, SEC-RBAC-01, SEC-PII-01 (Löschen entfernt Werte und Bindungen; Audit ohne Werte).

**Parallel:** Task 6, Task 8, Task 15 (Welle C; keine gemeinsamen Dateien: Task 6 schreibt `lib/vault/approvals.js`, `StateBroadcaster.js`, `routes/state.js`, `routes/vault/approvals.js`, `validations/vaultApprovals.js`; Task 8 `provision.js`, `controllers/agentKeys.js`, `routes/vault/agentKeys.js`, `validations/vaultAgentKeys.js`, `execCommand.js`, `server/index.js`; Task 15 nur `client/`). `visibility.js` und `secrets.js` liest dieser Task nur.

- [ ] **Step 1: Validierungstest schreiben**

`server/lib/vault/__tests__/validation.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const {
    createVaultItemValidation, updateVaultItemSchema, updateVaultSettingsValidation,
} = require("../../../validations/vault");

const validate = (schema, value) => schema.validate(value, { allowUnknown: false });

const login = (overrides = {}) => ({
    name: "portal-login", type: "login",
    fields: { username: "ma", origins: ["https://portal.example.com"] },
    secrets: { password: "pw" },
    ...overrides,
});
const apiKey = (fields) => ({ name: "gh", type: "api_key", fields: { hosts: ["api.github.com"], ...fields }, secrets: { token: "t" } });

test("Einträge, Änderungen und Einstellungen werden je Typ per Whitelist geprüft und Ursprünge normalisiert", () => {
    const accepted = [
        [login({ fields: { username: "ma", origins: ["HTTPS://Portal.Example.com:443", "http://10.0.0.5:8080"] } }),
            (value) => assert.deepStrictEqual(value.fields.origins, ["https://portal.example.com", "http://10.0.0.5:8080"])],
        [{ name: "gh.token_1", type: "api_key", fields: { hosts: ["api.github.com"] }, secrets: { token: "t" } },
            (value) => assert.deepStrictEqual(
                [value.fields.headerName, value.fields.headerTemplate, value.organizationId, value.approvalRequired, value.allServers, value.bindings],
                ["Authorization", "Bearer {{secret}}", null, true, false, []])],
        [{ name: "nas-root", type: "ssh", fields: { username: "root" }, secrets: { privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----" } }],
        [{ name: "local-db", type: "database", fields: { engine: "sqlite", database: "/data/app.db" } },
            (value) => assert.deepStrictEqual(value.secrets, {})],
        [{ name: "misc", type: "generic", secrets: { value: "x" }, organizationId: 20, bindings: [{ kind: "folder", targetId: 3 }] },
            (value) => assert.deepStrictEqual(value.fields, {})],
    ];
    for (const [input, check] of accepted) {
        const { error, value } = validate(createVaultItemValidation, input);
        assert.strictEqual(error, undefined, `${input.name}: ${error?.message}`);
        check?.(value);
    }

    const rejected = [
        ["Ursprung mit Pfad", login({ fields: { origins: ["https://portal.example.com/login"] } })],
        ["Ursprung mit Benutzerteil", login({ fields: { origins: ["https://u:p@portal.example.com"] } })],
        ["Ursprung mit Schema ftp", login({ fields: { origins: ["ftp://portal.example.com"] } })],
        ["Ursprung ohne Host", login({ fields: { origins: ["https://"] } })],
        ["kein Ursprung", login({ fields: { origins: [] } })],
        ["Großbuchstaben im Namen", login({ name: "Portal" })],
        ["Name beginnt mit Punkt", login({ name: ".portal" })],
        ["Name mit 65 Zeichen", login({ name: "a".repeat(65) })],
        ["Geheimfeld eines anderen Typs", login({ secrets: { password: "pw", token: "t" } })],
        ["Login ohne Passwort", login({ secrets: {} })],
        ["leeres Passwort", login({ secrets: { password: "" } })],
        ["SSH ohne Schlüssel und Passwort", { name: "nas", type: "ssh", fields: { username: "root" }, secrets: { passphrase: "p" } }],
        ["unbekannte Engine", { name: "db", type: "database", fields: { engine: "oracle", host: "db", database: "x" } }],
        ["Postgres ohne Host", { name: "db", type: "database", fields: { engine: "postgres", database: "x" } }],
        ["Header-Vorlage ohne {{secret}}", apiKey({ headerTemplate: "Bearer" })],
        ["Host mit Pfad", apiKey({ hosts: ["api.github.com/v3"] })],
        ["Angaben bei Sonstiges", { name: "misc", type: "generic", fields: { note: "x" }, secrets: { value: "x" } }],
        ["Bindung an eine Gruppe", login({ bindings: [{ kind: "group", targetId: 1 }] })],
        ["unbekannter Typ", login({ type: "note" })],
        ["unbekanntes Feld", login({ owner: 3 })],
    ];
    for (const [label, input] of rejected) {
        assert.ok(validate(createVaultItemValidation, input).error, label);
    }

    const update = updateVaultItemSchema("login");
    assert.strictEqual(validate(update, { secrets: { password: "neu" } }).error, undefined);
    assert.deepStrictEqual(validate(update, { fields: { origins: ["https://Login.Example.net:443"] } }).value.fields.origins, ["https://login.example.net"]);
    for (const [label, input] of [
        ["Typwechsel", { type: "api_key" }],
        ["Besitzerwechsel", { organizationId: 20 }],
        ["leere Änderung", {}],
        ["Ursprung mit Pfad", { fields: { origins: ["https://login.example.net/path"] } }],
        ["Geheimfeld eines anderen Typs", { secrets: { token: "t" } }],
    ]) {
        assert.ok(validate(update, input).error, label);
    }

    const settings = (agentUrl) => validate(updateVaultSettingsValidation, { agentUrl });
    assert.strictEqual(settings("https://outpost.example.com/").value.agentUrl, "https://outpost.example.com");
    assert.strictEqual(settings("http://10.0.0.2:6989/outpost/").value.agentUrl, "http://10.0.0.2:6989/outpost");
    assert.strictEqual(settings("").error, undefined);
    for (const agentUrl of ["ftp://outpost.example.com", "https://outpost.example.com/?x=1", "https://u:p@outpost.example.com", "outpost.example.com"]) {
        assert.ok(settings(agentUrl).error, agentUrl);
    }
});
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag prüfen**

Run: `cd /root/outpost && node --test server/lib/vault/__tests__/validation.test.js`
Expected: FAIL — `Cannot find module '../../../validations/vault'`.

- [ ] **Step 3: `server/validations/vault.js` anlegen**

```js
const Joi = require("joi");

const TYPES = ["login", "api_key", "ssh", "database", "generic"];

const SECRET_FIELDS = Object.freeze({
    login: ["password"],
    api_key: ["token"],
    ssh: ["privateKey", "password", "passphrase"],
    database: ["password"],
    generic: ["value"],
});
const SECRET_MAX_LENGTH = { password: 4096, token: 8192, privateKey: 16384, passphrase: 4096, value: 65536 };

const name = Joi.string().pattern(/^[a-z0-9][a-z0-9._-]{0,63}$/)
    .messages({ "string.pattern.base": "name may only contain lowercase letters, digits, dot, dash and underscore (max. 64)" });
const description = Joi.string().max(2000).allow("", null);

// Only scheme, host and port: a path, credentials or a query would never match the frame origin
// browser_fill_credential compares against, and new URL().origin lowercases and drops default ports.
const origin = Joi.string().max(2048).custom((value, helpers) => {
    if (!/^https?:\/\/[^/?#@\s]+$/i.test(value)) return helpers.error("any.invalid");
    try {
        return new URL(value).origin;
    } catch {
        return helpers.error("any.invalid");
    }
}).messages({ "any.invalid": "origins must look like https://host[:port]" });

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
    ssh: Joi.object({
        username: Joi.string().max(255).required(),
    }),
    database: Joi.object({
        engine: Joi.string().valid("postgres", "mysql", "sqlite").required(),
        host: Joi.string().hostname().when("engine", { is: "sqlite", then: Joi.optional(), otherwise: Joi.required() }),
        port: Joi.number().integer().min(1).max(65535),
        database: Joi.string().max(1024).required(),
        username: Joi.string().max(255),
    }),
    generic: Joi.object({}),
};

const secretsOf = (type) => Joi.object(Object.fromEntries(
    SECRET_FIELDS[type].map((field) => [field, Joi.string().min(1).max(SECRET_MAX_LENGTH[field])]),
));

const CREATE_SECRETS = {
    login: secretsOf("login").fork(["password"], (schema) => schema.required()).required(),
    api_key: secretsOf("api_key").fork(["token"], (schema) => schema.required()).required(),
    ssh: secretsOf("ssh").or("privateKey", "password").required(),
    database: secretsOf("database").default({}),
    generic: secretsOf("generic").fork(["value"], (schema) => schema.required()).required(),
};

const CREATE_FIELDS = {
    login: FIELDS.login.required(),
    api_key: FIELDS.api_key.required(),
    ssh: FIELDS.ssh.required(),
    database: FIELDS.database.required(),
    generic: FIELDS.generic.default({}),
};

const byType = (schemas) => Joi.when("type", { switch: TYPES.map((type) => ({ is: type, then: schemas[type] })) });

const bindings = Joi.array().items(Joi.object({
    kind: Joi.string().valid("entry", "folder", "tag").required(),
    targetId: Joi.number().integer().positive().required(),
})).max(200);

module.exports.SECRET_FIELDS = SECRET_FIELDS;

module.exports.createVaultItemValidation = Joi.object({
    organizationId: Joi.number().integer().positive().allow(null).default(null),
    name: name.required(),
    type: Joi.string().valid(...TYPES).required(),
    description,
    fields: byType(CREATE_FIELDS),
    secrets: byType(CREATE_SECRETS),
    approvalRequired: Joi.boolean().default(true),
    allServers: Joi.boolean().default(false),
    bindings: bindings.default([]),
});

module.exports.updateVaultItemSchema = (type) => Joi.object({
    name,
    description,
    fields: FIELDS[type],
    secrets: secretsOf(type),
    approvalRequired: Joi.boolean(),
    allServers: Joi.boolean(),
    bindings,
}).min(1);

const agentUrl = Joi.string().max(2048).custom((value, helpers) => {
    let url;
    try {
        url = new URL(value);
    } catch {
        return helpers.error("any.invalid");
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
        return helpers.error("any.invalid");
    return url.origin + url.pathname.replace(/\/+$/, "");
}).messages({ "any.invalid": "agentUrl must be an http or https address without credentials, query or fragment" });

module.exports.updateVaultSettingsValidation = Joi.object({
    agentUrl: agentUrl.allow(null, "").required(),
});
```

`updateVaultItemSchema` ist eine Funktion (der Typ eines Eintrags steht erst nach dem Laden fest) und taucht deshalb nicht in der OpenAPI-Ausgabe auf; `extractSchemasFromValidation` (`server/utils/joiToOpenApi.js`) überspringt alles ohne `describe`. `CreateVaultItem` und `UpdateVaultSettings` erscheinen dort.

- [ ] **Step 4: Validierungstest grün**

Run: `cd /root/outpost && node --test server/lib/vault/__tests__/validation.test.js`
Expected: PASS (1 Test).

- [ ] **Step 5: Routentest schreiben**

`server/lib/vault/__tests__/itemsRoute.test.js`:

```js
process.env.ENCRYPTION_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
process.env.VAULT_KEY = "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";

const test = require("node:test");
const assert = require("node:assert");
const express = require("express");
const { Sequelize } = require("sequelize");

// foreignKeys: false - the vault models reference accounts and organizations; this test creates no accounts.
const db = new Sequelize({ dialect: "sqlite", storage: ":memory:", logging: false, query: { raw: true }, foreignKeys: false });
const fake = (path, exports) => {
    const resolved = require.resolve(path);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

// 1: vault.use, active member of 20 without org rights. 3: active member of 20 with vault.reveal and
// vault.manage, settings.vault. 4: vault.use, only invited to 20 - the engine would grant org rights,
// the membership must not.
const SYSTEM = { 1: ["vault.use"], 3: ["settings.vault"], 4: ["vault.use"] };
const ORG = { "3:20": ["vault.reveal", "vault.manage"], "4:20": ["vault.reveal", "vault.manage"] };
const CALLERS = {
    "s-owner": { user: { id: 1 }, session: { id: 11, accountId: 1, impersonatorId: null } },
    "s-imp": { user: { id: 1 }, session: { id: 12, accountId: 1, impersonatorId: 99 } },
    "k-owner": { user: { id: 1 }, apiKey: { id: 5, kind: "account" } },
    "s-revealer": { user: { id: 3 }, session: { id: 13, accountId: 3, impersonatorId: null } },
    "s-invited": { user: { id: 4 }, session: { id: 14, accountId: 4, impersonatorId: null } },
};

fake("../../../utils/database", db);
fake("../../../permissions/engine", {
    getSystemPermissions: async (accountId) => ({ isAdmin: false, permissions: SYSTEM[accountId] ?? [] }),
    getOrganizationPermissions: async (accountId, organizationId) =>
        ({ isOwner: false, isAdmin: false, permissions: ORG[`${accountId}:${organizationId}`] ?? [] }),
    hasSystemPermission: async (accountId, permission) => (SYSTEM[accountId] ?? []).includes(permission),
    hasOrganizationPermission: async (accountId, organizationId, permission) =>
        (ORG[`${accountId}:${organizationId}`] ?? []).includes(permission),
});
fake("../../../middlewares/auth", {
    authenticate: (req, res, next) => {
        const caller = CALLERS[(req.header("authorization") ?? "").replace(/^Bearer /, "")];
        if (!caller) return res.status(401).json({ message: "The provided token is not valid" });
        Object.assign(req, caller);
        next();
    },
});

const audits = [];
const audit = require("../../../controllers/audit");
audit.createAuditLog = async (entry) => { audits.push(entry); };

const state = require("../state");
const { writeSecret, readSecret } = require("../secrets");
const VaultItem = require("../../../models/VaultItem");
const VaultSecret = require("../../../models/VaultSecret");
const Organization = require("../../../models/Organization");
const OrganizationMember = require("../../../models/OrganizationMember");
const itemsRouter = require("../../../routes/vault/items");
const settingsRouter = require("../../../routes/vault/settings");

let personal;
let shared;

test.before(async () => {
    await db.sync();
    await state.initVaultState();
    await Organization.create({ id: 20, name: "Ops" });
    await OrganizationMember.bulkCreate([
        { organizationId: 20, accountId: 1, role: "member", status: "active", invitedBy: 3 },
        { organizationId: 20, accountId: 3, role: "member", status: "active", invitedBy: 3 },
        { organizationId: 20, accountId: 4, role: "member", status: "pending", invitedBy: 3 },
    ]);
    personal = await VaultItem.create({
        accountId: 1, name: "portal-login", type: "login",
        fields: { username: "ma", origins: ["https://portal.example.com"] }, approvalRequired: true, allServers: false, createdBy: 1,
    });
    await writeSecret(personal.id, "password", "hunter2-personal");
    shared = await VaultItem.create({
        organizationId: 20, name: "backup-db", type: "database",
        fields: { engine: "postgres", host: "db.internal", port: 5432, database: "backup", username: "backup" },
        approvalRequired: true, allServers: false, createdBy: 3,
    });
    await writeSecret(shared.id, "password", "hunter2-shared");
});

test.beforeEach(() => { audits.length = 0; });

const listen = async (t, { trustProxy = false } = {}) => {
    const app = express();
    app.set("trust proxy", trustProxy);
    app.use(express.json());
    app.use("/api/vault", itemsRouter);
    app.use("/api/vault", settingsRouter);
    const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    t.after(() => server.close());
    const call = (method) => async (path, token, body) => {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/api/vault${path}`, {
            method,
            headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        return { status: res.status, text, body: res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : null };
    };
    return { get: call("GET"), post: call("POST"), patch: call("PATCH") };
};

test("Reveal: Besitzer persönlich und vault.reveal in der Organisation ja, Mitglied ohne Recht 403, fremder Mandant 404, unlesbarer Wert 422; jeder Abruf auditiert", async (t) => {
    const { get } = await listen(t);
    const reveal = (token, item, field = "password") => get(`/items/${item.id}/secrets/${field}`, token);

    assert.deepStrictEqual((await reveal("s-owner", personal)).body, { value: "hunter2-personal" });
    assert.deepStrictEqual((await reveal("s-revealer", shared)).body, { value: "hunter2-shared" });
    assert.strictEqual((await reveal("s-owner", shared)).status, 403);
    assert.strictEqual((await reveal("s-invited", shared)).status, 404);
    assert.strictEqual((await reveal("s-revealer", personal)).status, 404);
    assert.strictEqual((await reveal("s-owner", personal, "token")).status, 404);

    assert.deepStrictEqual(
        audits.map((a) => [a.action, a.accountId, a.organizationId, a.resourceId, a.details.item, a.details.field]),
        [
            ["vault.reveal", 1, null, personal.id, "portal-login", "password"],
            ["vault.reveal", 3, 20, shared.id, "org:20/backup-db", "password"],
        ],
    );
    assert.doesNotMatch(JSON.stringify(audits), /hunter2/);

    audits.length = 0;
    const { valueEncrypted, valueIV, valueAuthTag } = await VaultSecret.findOne({ where: { itemId: personal.id, field: "password" } });
    await VaultSecret.update({ valueEncrypted, valueIV, valueAuthTag }, { where: { itemId: shared.id, field: "password" } });
    const unreadable = await reveal("s-revealer", shared);
    assert.deepStrictEqual([unreadable.status, unreadable.body.code], [422, 422]);
    const unreadableFlag = async () => (await get("/items", "s-revealer")).body.items.find((item) => item.id === shared.id).unreadable;
    assert.strictEqual(await unreadableFlag(), true);
    await writeSecret(shared.id, "password", "hunter2-shared");
    assert.strictEqual(await unreadableFlag(), false);
    assert.deepStrictEqual(audits.map((a) => [a.action, a.details.item, a.details.field]), [["vault.item_unreadable", "org:20/backup-db", "password"]]);
    assert.doesNotMatch(unreadable.text + JSON.stringify(audits), /hunter2/);
});

test("Reveal und das Abschalten der Freigabe verlangen eine Login-Session ohne Impersonation: Impersonation und Konto-Key bekommen 403, ohne Audit", async (t) => {
    const { get, post, patch } = await listen(t);
    const APPROVAL_OFF = "Turning off approvals requires a signed-in session";

    for (const token of ["s-imp", "k-owner"]) {
        const { status, text } = await get(`/items/${personal.id}/secrets/password`, token);
        assert.strictEqual(status, 403, token);
        assert.doesNotMatch(text, /hunter2/);

        const created = await post("/items", token, { name: "no-approval", type: "generic", secrets: { value: "x" }, approvalRequired: false });
        const patched = await patch(`/items/${personal.id}`, token, { approvalRequired: false });
        assert.deepStrictEqual([created.status, created.body.message, patched.status, patched.body.message], [403, APPROVAL_OFF, 403, APPROVAL_OFF], token);
    }
    assert.deepStrictEqual(audits, []);
    assert.strictEqual(await VaultItem.count({ where: { name: "no-approval" } }), 0);
    const listed = (await get("/items", "s-imp")).body.items.find((item) => item.id === personal.id);
    assert.deepStrictEqual([listed.canManage, listed.canReveal, listed.approvalRequired], [true, false, true]);

    const fromSession = await patch(`/items/${personal.id}`, "s-owner", { approvalRequired: false });
    assert.deepStrictEqual([fromSession.status, fromSession.body.item.approvalRequired], [200, false]);
    const alreadyOff = await patch(`/items/${personal.id}`, "s-imp", { description: "edited while impersonating", approvalRequired: false });
    assert.deepStrictEqual([alreadyOff.status, alreadyOff.body.item.description, alreadyOff.body.item.approvalRequired], [200, "edited while impersonating", false]);
    assert.strictEqual((await patch(`/items/${personal.id}`, "s-owner", { approvalRequired: true, description: "" })).body.item.approvalRequired, true);
});

test("PATCH mit geändertem Ursprung löscht die gespeicherten Werte im selben Vorgang; dieselbe Adresse anders geschrieben nicht; Listen tragen nie Werte", async (t) => {
    const { get, post, patch } = await listen(t);
    const created = await post("/items", "s-owner", {
        name: "shop-login", type: "login", fields: { username: "ma", origins: ["https://shop.example.com"] }, secrets: { password: "pw-one" },
    });
    assert.strictEqual(created.status, 201);
    const { item } = created.body;
    assert.deepStrictEqual([item.ref, item.secretFields, item.approvalRequired, item.canManage, item.canReveal], ["shop-login", ["password"], true, true, true]);

    const sameOrigin = await patch(`/items/${item.id}`, "s-owner", { fields: { username: "ma.backes", origins: ["HTTPS://Shop.Example.com:443"] } });
    assert.deepStrictEqual(
        [sameOrigin.body.secretsCleared, sameOrigin.body.item.secretFields, sameOrigin.body.item.fields],
        [false, ["password"], { username: "ma.backes", origins: ["https://shop.example.com"] }],
    );

    const moved = await patch(`/items/${item.id}`, "s-owner", { fields: { username: "ma.backes", origins: ["https://shop.example.net"] } });
    assert.deepStrictEqual([moved.status, moved.body.secretsCleared, moved.body.item.secretFields], [200, true, []]);
    assert.strictEqual(await readSecret(item.id, "password"), null);
    assert.strictEqual(audits.at(-1).action, "vault.item_update");
    assert.strictEqual(audits.at(-1).details.secretsCleared, true);

    const movedWithValue = await patch(`/items/${item.id}`, "s-owner", {
        fields: { username: "ma.backes", origins: ["https://login.example.net"] }, secrets: { password: "pw-two" },
    });
    assert.deepStrictEqual([movedWithValue.body.secretsCleared, movedWithValue.body.item.secretFields], [true, ["password"]]);
    assert.strictEqual(await readSecret(item.id, "password"), "pw-two");

    const list = await get("/items", "s-owner");
    assert.deepStrictEqual(list.body.items.map((entry) => entry.ref).sort(), ["org:20/backup-db", "portal-login", "shop-login"]);
    assert.doesNotMatch(list.text + JSON.stringify(audits), /pw-one|pw-two|hunter2/);
});

test("available meldet Schalter, Rechte, Agenten-Adresse, Impersonation und TRUST_PROXY=true; bei ausgeschaltetem Vault sind alle Rechte leer", async (t) => {
    const { get, patch } = await listen(t, { trustProxy: true });

    assert.strictEqual((await patch("/settings", "s-owner", { agentUrl: "https://outpost.example.com" })).status, 403);
    assert.deepStrictEqual((await patch("/settings", "s-revealer", { agentUrl: "https://outpost.example.com/" })).body,
        { keyStatus: "active", agentUrl: "https://outpost.example.com", trustProxyUnsafe: true });

    assert.deepStrictEqual((await get("/available", "s-imp")).body, {
        enabled: true, canUse: true, canManageOrgs: [], canProvision: true, agentUrlSet: true, impersonating: true, trustProxyUnsafe: true,
    });
    assert.deepStrictEqual((await get("/available", "s-revealer")).body, {
        enabled: true, canUse: true, canManageOrgs: [20], canProvision: true, agentUrlSet: true, impersonating: false, trustProxyUnsafe: true,
    });
    assert.deepStrictEqual((await get("/available", "s-invited")).body.canManageOrgs, []);

    const key = process.env.VAULT_KEY;
    try {
        process.env.VAULT_KEY = "";
        state._resetForTests();
        await state.initVaultState();
        assert.deepStrictEqual((await get("/available", "s-revealer")).body, {
            enabled: false, canUse: false, canManageOrgs: [], canProvision: false, agentUrlSet: true, impersonating: false, trustProxyUnsafe: true,
        });
        assert.strictEqual((await get("/items", "s-revealer")).status, 404);
        assert.strictEqual((await get("/settings", "s-revealer")).body.keyStatus, "missing");
    } finally {
        process.env.VAULT_KEY = key;
        state._resetForTests();
        await state.initVaultState();
    }

    const behindOneProxy = await listen(t, { trustProxy: 1 });
    assert.strictEqual((await behindOneProxy.get("/available", "s-owner")).body.trustProxyUnsafe, false);
});
```

- [ ] **Step 6: Routentest laufen lassen, Fehlschlag prüfen**

Run: `cd /root/outpost && node --test server/lib/vault/__tests__/itemsRoute.test.js`
Expected: FAIL — alle 4 Tests; die Platzhalter-Router aus Task 1 antworten `404` (z. B. `Expected values to be strictly deep-equal: null !== { value: 'hunter2-personal' }`).

- [ ] **Step 7: `server/controllers/vaultSettings.js` anlegen**

```js
const VaultSettings = require("../models/VaultSettings");
const { getKeyStatus, isVaultEnabled } = require("../lib/vault/state");
const { activeOrganizationIds, canUseVault, canCreateFor } = require("../lib/vault/visibility");

const getAgentUrl = async () => (await VaultSettings.getOrCreate()).agentUrl || null;

const getVaultSettings = async () => ({ keyStatus: getKeyStatus(), agentUrl: await getAgentUrl() });

const updateVaultSettings = async ({ agentUrl }) => {
    const settings = await VaultSettings.getOrCreate();
    await settings.update({ agentUrl: agentUrl || null });
    return getVaultSettings();
};

const getVaultAvailability = async (accountId, { impersonating, trustProxyUnsafe }) => {
    const enabled = isVaultEnabled();
    const result = {
        enabled, canUse: false, canManageOrgs: [], canProvision: false,
        agentUrlSet: Boolean(await getAgentUrl()), impersonating, trustProxyUnsafe,
    };
    if (!enabled) return result;
    const canUse = await canUseVault(accountId);
    for (const organizationId of await activeOrganizationIds(accountId)) {
        if (await canCreateFor(accountId, { organizationId })) result.canManageOrgs.push(organizationId);
    }
    return { ...result, canUse, canProvision: canUse };
};

module.exports = { getAgentUrl, getVaultSettings, updateVaultSettings, getVaultAvailability };
```

- [ ] **Step 8: `server/controllers/vaultItems.js` anlegen**

Jede Abfrage nach ID läuft über `findScopedItem` (eigene Einträge oder Organisationen mit aktiver Mitgliedschaft) und antwortet sonst `404` wie bei unbekannter ID; erst danach prüft `canManageItem`/`canRevealItem` das Recht (`403`). Diese Mandantenprüfung ersetzt keine Rechteprüfung, sie unterscheidet nur `404` von `403`; die Rechte kommen ausschließlich aus `canManageItem`/`canRevealItem`/`canCreateFor` (Task 3, inkl. aktiver Mitgliedschaft). Geheime Werte verlassen den Controller nur in `revealSecret`. Gelesene Zeilen kommen über den `afterFind`-Hook von `VaultItem` (Task 1) schon mit `fields` als Objekt und Booleans an. `approvalRequired: false` setzt nur eine Login-Session ohne Impersonation (`caller.revealAllowed`); ein Konto-Key oder ein Impersonator könnte sonst die Freigabe abschalten und danach ohne Karte ausfüllen lassen. `updateItem` sperrt nur das Umschalten (`item.approvalRequired !== false`): Der Eintrag-Dialog schickt `approvalRequired` bei jedem Speichern mit, ein schon abgeschalteter Eintrag bliebe aus der Impersonation sonst unbearbeitbar. `updateItem` schreibt in dieser Reihenfolge: Werte löschen (bei neuem Ziel) → Spalten (`409` bei `SequelizeUniqueConstraintError`) → neue Werte → Bindungen; scheitert das Spalten-Update, ist kein neuer Wert unter dem alten Ziel gespeichert; bei neuem Ziel schon gelöschte Werte bleiben gelöscht (sicherer Rückfall).

```js
const { Op } = require("sequelize");
const VaultItem = require("../models/VaultItem");
const VaultSecret = require("../models/VaultSecret");
const VaultBinding = require("../models/VaultBinding");
const Organization = require("../models/Organization");
const Entry = require("../models/Entry");
const Folder = require("../models/Folder");
const Tag = require("../models/Tag");
const { createAuditLog, AUDIT_ACTIONS, RESOURCE_TYPES } = require("./audit");
const {
    itemRef, activeOrganizationIds, ownedItems, canManageItem, canRevealItem, canCreateFor,
} = require("../lib/vault/visibility");
const { validateBindings, setBindings } = require("../lib/vault/bindings");
const { readSecret, writeSecret, clearSecrets, isUnreadable } = require("../lib/vault/secrets");
const { VaultError, VaultErrorCode } = require("../lib/vault/errors");
const { SECRET_FIELDS, updateVaultItemSchema } = require("../validations/vault");
const logger = require("../utils/logger");

const NOT_FOUND = { code: 404, message: "Vault entry not found" };
const FORBIDDEN = { code: 403, message: "You are not allowed to do this with this vault entry" };
const NAME_TAKEN = { code: 409, message: "A vault entry with this name already exists for this owner" };
const APPROVAL_OFF_FORBIDDEN = { code: 403, message: "Turning off approvals requires a signed-in session" };
const TARGET_FIELD = { login: "origins", api_key: "hosts", database: "host" };
const LABEL_MODELS = { entry: Entry, folder: Folder, tag: Tag };
const ITEM_COLUMNS = ["name", "description", "fields", "approvalRequired", "allServers"];

const targetOf = (type, fields) => JSON.stringify([].concat(fields?.[TARGET_FIELD[type]] ?? []).sort());

// SEC-TENANT-01: every lookup by id is scoped to the caller's own entries and active memberships.
const findScopedItem = async (accountId, id) => {
    if (!Number.isInteger(id)) return null;
    return VaultItem.findOne({
        where: { id, [Op.or]: [{ accountId }, { organizationId: { [Op.in]: await activeOrganizationIds(accountId) } }] },
    });
};

const nameTaken = async ({ accountId, organizationId }, name, exceptId = null) => Boolean(await VaultItem.findOne({
    where: {
        name, ...(organizationId ? { organizationId } : { accountId }),
        ...(exceptId ? { id: { [Op.ne]: exceptId } } : {}),
    },
    attributes: ["id"],
}));

const bindingLabels = async (bindings) => {
    const labels = {};
    for (const [kind, Model] of Object.entries(LABEL_MODELS)) {
        const ids = bindings.filter((binding) => binding.kind === kind).map((binding) => binding.targetId);
        if (!ids.length) continue;
        for (const row of await Model.findAll({ where: { id: ids }, attributes: ["id", "name"] })) labels[`${kind}:${row.id}`] = row.name;
    }
    return labels;
};

const serializeItems = async (caller, items) => {
    if (!items.length) return [];
    const ids = items.map((item) => item.id);
    const organizationIds = [...new Set(items.map((item) => item.organizationId).filter(Boolean))];
    const [secrets, bindings, organizations] = await Promise.all([
        VaultSecret.findAll({ where: { itemId: ids }, attributes: ["itemId", "field"] }),
        VaultBinding.findAll({ where: { itemId: ids }, attributes: ["itemId", "kind", "targetId"] }),
        organizationIds.length ? Organization.findAll({ where: { id: organizationIds }, attributes: ["id", "name"] }) : [],
    ]);
    const labels = await bindingLabels(bindings);
    return Promise.all(items.map(async (item) => ({
        id: item.id,
        ref: itemRef(item),
        accountId: item.accountId ?? null,
        organizationId: item.organizationId ?? null,
        ownerName: organizations.find((organization) => organization.id === item.organizationId)?.name ?? null,
        name: item.name,
        type: item.type,
        description: item.description ?? null,
        fields: item.fields ?? {},
        approvalRequired: item.approvalRequired,
        allServers: item.allServers,
        bindings: bindings.filter((binding) => binding.itemId === item.id)
            .map(({ kind, targetId }) => ({ kind, targetId, label: labels[`${kind}:${targetId}`] ?? null })),
        secretFields: secrets.filter((secret) => secret.itemId === item.id).map((secret) => secret.field).sort(),
        unreadable: isUnreadable(item.id),
        lastUsedAt: item.lastUsedAt ?? null,
        canManage: await canManageItem(caller.accountId, item),
        canReveal: caller.revealAllowed && await canRevealItem(caller.accountId, item),
    })));
};

const serializeOne = async (caller, id) => (await serializeItems(caller, [await VaultItem.findByPk(id)]))[0];

const audit = (caller, item, action, details = {}) => createAuditLog({
    accountId: caller.accountId,
    organizationId: item.organizationId ?? null,
    action,
    resource: RESOURCE_TYPES.VAULT,
    resourceId: item.id,
    details: {
        item: itemRef(item), type: item.type, ...details,
        ...(caller.impersonatorId ? { impersonatorId: caller.impersonatorId } : {}),
    },
    ipAddress: caller.ipAddress ?? null,
    userAgent: caller.userAgent ?? null,
});

const removeItem = async (id) => {
    await clearSecrets(id);
    await setBindings(id, []);
    await VaultItem.destroy({ where: { id } });
};

module.exports.listItems = async (caller) => ({ items: await serializeItems(caller, await ownedItems(caller.accountId)) });

module.exports.createItem = async (caller, body) => {
    const { organizationId, name, type, description, fields, secrets, approvalRequired, allServers, bindings } = body;
    if (!(await canCreateFor(caller.accountId, { organizationId }))) return FORBIDDEN;
    if (approvalRequired === false && !caller.revealAllowed) return APPROVAL_OFF_FORBIDDEN;
    const check = await validateBindings({ accountId: caller.accountId, organizationId }, bindings);
    if (!check.valid) return { code: 400, message: check.message };
    const owner = organizationId ? { accountId: null, organizationId } : { accountId: caller.accountId, organizationId: null };
    if (await nameTaken(owner, name)) return NAME_TAKEN;

    let item;
    try {
        item = await VaultItem.create({
            ...owner, name, type, description: description || null, fields, approvalRequired, allServers, createdBy: caller.accountId,
        });
    } catch (error) {
        if (error.name === "SequelizeUniqueConstraintError") return NAME_TAKEN;
        throw error;
    }
    try {
        for (const [field, value] of Object.entries(secrets)) await writeSecret(item.id, field, value);
        await setBindings(item.id, bindings);
    } catch (error) {
        await removeItem(item.id).catch((cleanupError) =>
            logger.error("Could not remove a half-created vault entry", { itemId: item.id, error: cleanupError.message }));
        throw error;
    }
    await audit(caller, item, AUDIT_ACTIONS.VAULT_ITEM_CREATE, { name, secretFields: Object.keys(secrets) });
    return { item: await serializeOne(caller, item.id) };
};

module.exports.updateItem = async (caller, id, body) => {
    const item = await findScopedItem(caller.accountId, id);
    if (!item) return NOT_FOUND;
    if (!(await canManageItem(caller.accountId, item))) return FORBIDDEN;
    const { error, value } = updateVaultItemSchema(item.type).validate(body, { errors: { wrap: { label: "" } }, allowUnknown: false });
    if (error) return { code: 400, message: error.details[0].message };
    if (value.approvalRequired === false && item.approvalRequired !== false && !caller.revealAllowed) return APPROVAL_OFF_FORBIDDEN;
    if (value.name !== undefined && value.name !== item.name && await nameTaken(item, value.name, item.id)) return NAME_TAKEN;
    if (value.bindings) {
        const check = await validateBindings({ accountId: caller.accountId, organizationId: item.organizationId ?? null }, value.bindings);
        if (!check.valid) return { code: 400, message: check.message };
    }

    // A new target with the old value would let vault.manage without vault.reveal send an
    // organization's password to a page of their choosing.
    const secretsCleared = value.fields !== undefined && targetOf(item.type, value.fields) !== targetOf(item.type, item.fields);
    if (secretsCleared) await clearSecrets(item.id);
    const changes = Object.fromEntries(ITEM_COLUMNS.filter((column) => value[column] !== undefined).map((column) => [column, value[column]]));
    if (changes.description === "") changes.description = null;
    if (Object.keys(changes).length) {
        try {
            await VaultItem.update(changes, { where: { id: item.id } });
        } catch (error) {
            if (error.name === "SequelizeUniqueConstraintError") return NAME_TAKEN;
            throw error;
        }
    }
    for (const [field, secret] of Object.entries(value.secrets ?? {})) await writeSecret(item.id, field, secret);
    if (value.bindings) await setBindings(item.id, value.bindings);

    await audit(caller, item, AUDIT_ACTIONS.VAULT_ITEM_UPDATE, {
        name: value.name ?? item.name,
        changed: [...Object.keys(changes), ...(value.bindings ? ["bindings"] : [])],
        secretFields: Object.keys(value.secrets ?? {}),
        secretsCleared,
    });
    return { item: await serializeOne(caller, item.id), secretsCleared };
};

module.exports.deleteItem = async (caller, id) => {
    const item = await findScopedItem(caller.accountId, id);
    if (!item) return NOT_FOUND;
    if (!(await canManageItem(caller.accountId, item))) return FORBIDDEN;
    await removeItem(item.id);
    await audit(caller, item, AUDIT_ACTIONS.VAULT_ITEM_DELETE, { name: item.name });
    return { success: true };
};

module.exports.revealSecret = async (caller, id, field) => {
    const item = await findScopedItem(caller.accountId, id);
    if (!item || !SECRET_FIELDS[item.type]?.includes(field)) return NOT_FOUND;
    if (!(await canRevealItem(caller.accountId, item))) return FORBIDDEN;
    let value;
    try {
        value = await readSecret(item.id, field);
    } catch (error) {
        if (!(error instanceof VaultError) || error.code !== VaultErrorCode.ITEM_UNREADABLE) throw error;
        logger.warn("Vault entry cannot be decrypted", { itemId: item.id });
        await audit(caller, item, AUDIT_ACTIONS.VAULT_ITEM_UNREADABLE, { field });
        return { code: 422, message: "This vault entry cannot be read with the current vault key" };
    }
    if (value === null) return NOT_FOUND;
    await audit(caller, item, AUDIT_ACTIONS.VAULT_REVEAL, { field });
    return { value };
};
```

- [ ] **Step 9: `server/routes/vault/settings.js` füllen**

Den Platzhalter aus Task 1 vollständig ersetzen. `available` und `settings` tragen kein `requireVaultEnabled` (Spec „REST-Endpunkte“: beide antworten auch bei ausgeschaltetem Vault).

```js
const { Router } = require("express");
const { authenticate } = require("../../middlewares/auth");
const { requirePermission } = require("../../middlewares/permission");
const { Permission } = require("../../permissions/registry");
const { validateSchema } = require("../../utils/schema");
const { sendError } = require("../../utils/error");
const { updateVaultSettingsValidation } = require("../../validations/vault");
const { getVaultSettings, updateVaultSettings, getVaultAvailability } = require("../../controllers/vaultSettings");
const logger = require("../../utils/logger");

const app = Router();

const trustProxyUnsafe = (req) => req.app.get("trust proxy") === true;

const failed = (res, error) => {
    logger.error("Vault settings request failed", { error: error.message });
    sendError(res, 500, 500, "Internal server error");
};

/**
 * GET /vault/available
 * @summary Vault Available
 * @description Whether the vault is on and what the account may do with it. Always answers 200, also while the vault is off; then every permission field is false or empty.
 * @tags Vault
 * @produces application/json
 * @security BearerAuth
 * @return {object} 200 - { enabled, canUse, canManageOrgs, canProvision, agentUrlSet, impersonating, trustProxyUnsafe }
 */
app.get("/available", authenticate, async (req, res) => {
    try {
        res.json(await getVaultAvailability(req.user.id, {
            impersonating: Boolean(req.session?.impersonatorId), trustProxyUnsafe: trustProxyUnsafe(req),
        }));
    } catch (error) {
        failed(res, error);
    }
});

/**
 * GET /vault/settings
 * @summary Get Vault Settings
 * @description Status of VAULT_KEY and the Outpost address agents use. Answers while the vault is off, so the page can show why.
 * @tags Vault
 * @produces application/json
 * @security BearerAuth
 * @return {object} 200 - { keyStatus, agentUrl, trustProxyUnsafe }
 * @return {object} 403 - Permission required
 */
app.get("/settings", authenticate, requirePermission(Permission.SETTINGS_VAULT), async (req, res) => {
    try {
        res.json({ ...(await getVaultSettings()), trustProxyUnsafe: trustProxyUnsafe(req) });
    } catch (error) {
        failed(res, error);
    }
});

/**
 * PATCH /vault/settings
 * @summary Update Vault Settings
 * @description Sets the Outpost address agents use (http or https; empty clears it). Works while the vault is off.
 * @tags Vault
 * @produces application/json
 * @security BearerAuth
 * @param {UpdateVaultSettings} request.body.required - { agentUrl }
 * @return {object} 200 - { keyStatus, agentUrl, trustProxyUnsafe }
 * @return {object} 400 - Invalid address
 * @return {object} 403 - Permission required
 */
app.patch("/settings", authenticate, requirePermission(Permission.SETTINGS_VAULT), async (req, res) => {
    try {
        const body = req.body ?? {};
        if (validateSchema(res, updateVaultSettingsValidation, body)) return;
        res.json({ ...(await updateVaultSettings(body)), trustProxyUnsafe: trustProxyUnsafe(req) });
    } catch (error) {
        failed(res, error);
    }
});

module.exports = app;
```

- [ ] **Step 10: `server/routes/vault/items.js` füllen**

Den Platzhalter aus Task 1 vollständig ersetzen. Reihenfolge der Middleware am Reveal: `authenticate` → `requireVaultEnabled` → `requireLoginSession` → Rate-Limit, damit Konto-Keys und Impersonation das Kontingent nicht verbrauchen.

```js
const { Router } = require("express");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const { authenticate } = require("../../middlewares/auth");
const { requireLoginSession } = require("../../middlewares/requireLoginSession");
const { requireVaultEnabled } = require("../../lib/vault/state");
const { validateSchema } = require("../../utils/schema");
const { sendError } = require("../../utils/error");
const { createVaultItemValidation } = require("../../validations/vault");
const { listItems, createItem, updateItem, deleteItem, revealSecret } = require("../../controllers/vaultItems");
const logger = require("../../utils/logger");

const app = Router();

const revealLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    keyGenerator: (req) => (req.user ? `acc:${req.user.id}` : `ip:${ipKeyGenerator(req.ip)}`),
    message: { code: 429, message: "Too many reveals. Please try again in a minute." },
    standardHeaders: true,
    legacyHeaders: false,
});

const callerOf = (req) => ({
    accountId: req.user.id,
    impersonatorId: req.session?.impersonatorId ?? null,
    ipAddress: req.ip,
    userAgent: req.header("user-agent") ?? null,
    revealAllowed: !req.apiKey && !req.session?.impersonatorId,
});

const itemIdOf = (req) => (/^\d+$/.test(req.params.id) ? Number(req.params.id) : null);

const handle = (action, status = 200) => async (req, res) => {
    try {
        const result = await action(req, res);
        if (res.headersSent) return;
        if (result.code) return sendError(res, result.code, result.code, result.message);
        res.status(status).json(result);
    } catch (error) {
        logger.error("Vault request failed", { error: error.message });
        sendError(res, 500, 500, "Internal server error");
    }
};

/**
 * GET /vault/items
 * @summary List Vault Entries
 * @description Lists the vault entries the account owns (with vault.use) and those of organizations it is an active member of. Never contains secret values, only the names of the stored secret fields.
 * @tags Vault
 * @produces application/json
 * @security BearerAuth
 * @return {object} 200 - { items }
 * @return {object} 404 - Vault is disabled
 */
app.get("/items", authenticate, requireVaultEnabled, handle((req) => listItems(callerOf(req))));

/**
 * POST /vault/items
 * @summary Create Vault Entry
 * @description Creates a personal entry (vault.use) or an organization entry (vault.manage in that organization) with its secret values and server bindings.
 * @tags Vault
 * @produces application/json
 * @security BearerAuth
 * @param {CreateVaultItem} request.body.required - The entry
 * @return {object} 201 - { item }
 * @return {object} 400 - Invalid input or binding
 * @return {object} 403 - Not allowed for this owner
 * @return {object} 409 - Name already taken for this owner
 */
app.post("/items", authenticate, requireVaultEnabled, handle((req, res) => {
    const body = req.body ?? {};
    if (validateSchema(res, createVaultItemValidation, body)) return null;
    return createItem(callerOf(req), body);
}, 201));

/**
 * PATCH /vault/items/{id}
 * @summary Update Vault Entry
 * @description Updates an entry. Changing its target (origins, hosts or host) deletes all stored secret values in the same request; only values sent along are stored again.
 * @tags Vault
 * @produces application/json
 * @security BearerAuth
 * @param {number} id.path.required - Entry id
 * @param {object} request.body.required - name, description, fields, secrets, approvalRequired, allServers, bindings
 * @return {object} 200 - { item, secretsCleared }
 * @return {object} 403 - Not allowed to manage this entry
 * @return {object} 404 - Unknown entry
 */
app.patch("/items/:id", authenticate, requireVaultEnabled, handle((req) => updateItem(callerOf(req), itemIdOf(req), req.body ?? {})));

/**
 * DELETE /vault/items/{id}
 * @summary Delete Vault Entry
 * @description Deletes an entry with its secret values and bindings.
 * @tags Vault
 * @produces application/json
 * @security BearerAuth
 * @param {number} id.path.required - Entry id
 * @return {object} 200 - { success: true }
 * @return {object} 403 - Not allowed to manage this entry
 * @return {object} 404 - Unknown entry
 */
app.delete("/items/:id", authenticate, requireVaultEnabled, handle((req) => deleteItem(callerOf(req), itemIdOf(req))));

/**
 * GET /vault/items/{id}/secrets/{field}
 * @summary Reveal Vault Secret
 * @description Returns one secret value. Owner of a personal entry or vault.reveal in the organization; signed-in session only (API keys and impersonation get 403). Every reveal is audited.
 * @tags Vault
 * @produces application/json
 * @security BearerAuth
 * @param {number} id.path.required - Entry id
 * @param {string} field.path.required - password, token, privateKey, passphrase or value
 * @return {object} 200 - { value }
 * @return {object} 403 - Not allowed to reveal
 * @return {object} 404 - Unknown entry or no value stored
 * @return {object} 422 - The value cannot be decrypted with the current vault key
 * @return {object} 429 - Too many reveals
 */
app.get("/items/:id/secrets/:field", authenticate, requireVaultEnabled, requireLoginSession, revealLimiter, handle((req, res) => {
    res.set("Cache-Control", "no-store");
    return revealSecret(callerOf(req), itemIdOf(req), req.params.field);
}));

module.exports = app;
```

- [ ] **Step 11: Beide Testdateien grün**

Run: `cd /root/outpost && node --test server/lib/vault/__tests__/validation.test.js server/lib/vault/__tests__/itemsRoute.test.js`
Expected: PASS (5 Tests).

- [ ] **Step 12: Lint der neuen Dateien**

Run: `cd /root/outpost && npx eslint server/validations/vault.js server/controllers/vaultItems.js server/controllers/vaultSettings.js server/routes/vault/items.js server/routes/vault/settings.js server/lib/vault/__tests__/validation.test.js server/lib/vault/__tests__/itemsRoute.test.js`
Expected: keine Meldungen.

- [ ] **Step 13: Commit**

```bash
git add server/validations/vault.js server/controllers/vaultItems.js server/controllers/vaultSettings.js server/routes/vault/items.js server/routes/vault/settings.js server/lib/vault/__tests__/validation.test.js server/lib/vault/__tests__/itemsRoute.test.js
git commit -m "Vault: REST für Einträge, Reveal, Einstellungen und Verfügbarkeit"
```

---

### Task 6: Freigaben

**Files:**
- Create: `server/lib/vault/approvals.js`
- Modify: `server/lib/StateBroadcaster.js` (`STATE_TYPES`/`BROADCASTABLE_TYPES` Z. 4-5, `register` Z. 15-21, neue Methode `hasConnection` danach, `getStateData` Z. 55-56, `sendStateToConnection` Z. 62-63)
- Modify: `server/routes/state.js` (Z. 17-18: `register` mit Impersonations-Flag, gemeinsames `conn`)
- Modify: `server/routes/vault/approvals.js` (leeren `Router()`-Platzhalter aus Task 1 vollständig ersetzen)
- Create: `server/validations/vaultApprovals.js`
- Test: `server/lib/vault/__tests__/approvals.test.js`

**Interfaces:**
- Consumes:
  - Task 1: `VaultError`, `VaultErrorCode` aus `server/lib/vault/errors.js` (`new VaultError(VaultErrorCode.X)` nimmt den Text aus `VaultErrorMessage`); `AUDIT_ACTIONS.VAULT_APPROVE|VAULT_DENY|VAULT_APPROVAL_TIMEOUT`, `RESOURCE_TYPES.VAULT`; `requireVaultEnabled(req, res, next)` aus `server/lib/vault/state.js`; Spalte `sessions.impersonatorId`.
  - Task 3: `itemRef(item) → string` aus `server/lib/vault/visibility.js` (Welle B, liegt vor Welle C bereit).
  - Task 4: `const { requireLoginSession } = require("../../middlewares/requireLoginSession")`.
- Produces (von Task 11 und Task 13 genutzt):
  - `server/lib/vault/approvals.js`:
    - `APPROVAL_TTL_MS = 120000`
    - `requestApproval({ accountId, keyId = null, transportId, agentType = null, entryName = null, item, target, signal }) → Promise<"once"|"session">` — `item` ist der gerade gelesene Eintrag mit `id`, `organizationId`, `name`, `updatedAt` und `fields.origins`. Sofort `"session"`, wenn `hasSessionApproval(transportId, item)`; sonst Prüfreihenfolge ohne `await` dazwischen: Sperre nach `deny` (60 s je `accountId`+`keyId`+Eintrag, transportübergreifend) → `APPROVAL_DENIED`; offene Anfrage für (`transportId`, Eintrag) → `APPROVAL_PENDING`; drei offene Anfragen dieses Aufrufers (`accountId`, `keyId`) → `APPROVAL_BUSY`; kein nicht impersonierendes Fenster → `APPROVAL_UNAVAILABLE`; `signal` schon abgebrochen → `CLIENT_GONE`. Danach Karte; nach 120 s `APPROVAL_TIMEOUT`, bei `signal`-Abbruch `CLIENT_GONE`.
    - Frühe Ablehnungen (die fünf Prüfungen oben, vor jeder Karte) wirft `approvals.js` als `new VaultError(code, undefined, { early: true })` und auditiert sie **nicht** selbst; Task 11 schreibt für jeden Fehler mit `err.details.early === true` `vault.use_denied` mit `code` und `stage: "before_approval"`, in derselben Form wie seine übrigen Ablehnungen (nur Task 11 kennt Sitzung, Ziel und Impersonation des Aufrufs). Fehler nach einer Karte tragen `details: {}` und sind schon von `approvals.js` auditiert (`vault.deny`, `vault.approval_timeout`); Task 11 schreibt dafür kein zweites Audit.
    - `answerApproval(id, accountId, decision: "once"|"session"|"deny", meta = { ipAddress, userAgent }) → { status: 200|404|409|410 }` — `404` unbekannt oder fremdes Konto, `409` schon beantwortet, `410` abgelaufen oder zurückgezogen. Der optionale vierte Parameter trägt IP und User-Agent ins Audit.
    - `listOpenApprovals(accountId) → [{ id, agentType, entryName, item, target, expiresAt, remainingMs }]` — `item` ist die Kennung (`itemRef`), `expiresAt` ISO-String, `remainingMs` die Restzeit in Millisekunden zum Zeitpunkt der Auslieferung (Task 13 rechnet die Frist lokal daraus, unabhängig von der Uhr des Browsers), `agentType` darf `null` sein (Konto-Key/Login-Session), älteste zuerst.
    - `hasSessionApproval(transportId, item) → boolean` — `true` nur, wenn für diesen Transport eine `session`-Freigabe mit demselben Stempel aus `updatedAt` und sortierten `fields.origins` des Eintrags gespeichert ist; nach jeder Änderung des Eintrags gibt es wieder eine Karte. `forgetTransport(transportId) → void` (vergisst `session`-Freigaben und zieht offene Anfragen des Transports als `client_gone` zurück); `_resetForTests()`.
    - Audit (`resource: "vault"`, `resourceId: item.id`, `details.item: itemRef(item)`, dazu `agentType`, `entryName`, `keyId`, `target`): `vault.approve` mit `decision`, `vault.deny`, `vault.approval_timeout` mit `reason: "expired"|"client_gone"`.
  - `server/validations/vaultApprovals.js`: `answerVaultApprovalValidation` (`{ decision: "once"|"session"|"deny" }`, in der OpenAPI-Ausgabe als `AnswerVaultApproval`).
  - `StateBroadcaster`: `STATE_TYPES.VAULT_APPROVALS = "VAULT_APPROVALS"` (auch in `BROADCASTABLE_TYPES`); `register(accountId, sessionId, ws, tabId = null, browserId = null, { impersonating = false } = {}) → conn` (gibt jetzt die Verbindung zurück); `hasConnection(accountId) → boolean` (nur offene, nicht impersonierende Fenster); Impersonations-Fenster bekommen `VAULT_APPROVALS` nie, auch nicht über `refresh` oder beim Verbinden.
  - `POST /api/vault/approvals/:id` body `{ decision }` → `200 { success: true }` | `400` | `403` (Konto-Key, Impersonation) | `404` | `409` | `410` | `429` (60 Antworten je Minute und Konto).

**Design:** kein UI-Anteil.

**Tests:** 9 Tests in `approvals.test.js`, test-first (Spec „Freigabe“ und Global Constraints legen den Vertrag fest). Echte `approvals.js` und echter `StateBroadcaster` mit gefälschten Fenstern (`{ readyState: 1, send }`), damit Verteilung, `hasConnection` und das Impersonations-Flag über die Naht laufen; Fake-Uhr über `t.mock.timers` (`setTimeout`, `Date`); `createAuditLog` wird vor dem Laden ersetzt.
1. `once` füllt genau einmal, eine weitere Anfrage zeigt wieder eine Karte; Antwort eines fremden Kontos `404`, zweite Antwort `409`; Kartenform genau `id`, `agentType`, `entryName`, `item`, `target`, `expiresAt`, `remainingMs`, ohne interne Felder (SEC-IDOR-01, SEC-TENANT-01).
2. `session` gilt für denselben Transport ohne neue Karte (auch bei anders sortierten Ursprüngen), nicht für einen anderen; ist der Eintrag seitdem geändert (`updatedAt` oder Ursprünge), gibt es eine neue Karte; `forgetTransport` vergisst sie (SEC-SESS-02).
3. `deny` → `approval_denied` ohne `early`; 60 s Sperre auch über einen neuen Transport, ohne Karte, als frühe Ablehnung ohne eigenes Audit; ein anderer Key desselben Kontos ist nicht gesperrt; nach 60 s wieder Karte.
4. Ablauf nach genau 120 s → `approval_timeout`, `remainingMs` zählt mit, Audit `reason: "expired"`, Karte weg, spätere Antwort `410`.
5. `signal` bricht ab → `client_gone`, Audit `reason: "client_gone"`, Karte weg, spätere Antwort `410`; ein schon abgebrochenes `signal` → frühe Ablehnung `client_gone` ohne Karte und ohne Audit.
6. Kein Fenster → `approval_unavailable`; nur ein Impersonations-Fenster → ebenfalls; beides frühe Ablehnungen ohne Audit; das Impersonations-Fenster erhält keine `VAULT_APPROVALS`-Nachricht.
7. Zweiter Aufruf für dieselbe offene Anfrage → frühe Ablehnung `approval_pending`; derselbe Eintrag über einen anderen Transport bekommt eine eigene Karte.
8. Vierte offene Anfrage desselben Aufrufers → frühe Ablehnung `approval_busy`; ein anderer Key ist davon unberührt (SEC-RATE-01 für die Werkzeugseite).
9. Route: Impersonation und Konto-Key `403`, ungültige Entscheidung `400`, Login-Session `200`, danach `409` (Spec-Test 11, Teil Freigabe).
- Nicht getestet: Rate-Limit der Route (Framework-Zusage, Muster `bookmarkRateLimiter`), `routes/state.js` (eine Zeile Weiterreichung des Flags; das Verhalten des Flags deckt Test 6 ab), `validations/vaultApprovals.js` für sich (Test 9 schickt eine ungültige Entscheidung durch die Route), „Freigabe nach mehr als 90 s füllt noch aus“, `session_tainted` während der Wartezeit und das Audit `vault.use_denied` der frühen Ablehnungen (Task 11, dort mit `runAgent`).
- SEC-Abdeckung dieses Tasks: SEC-IDOR-01, SEC-TENANT-01 (Anfragen und Antworten je Konto), SEC-RATE-01 (Antwort-Endpunkt, Obergrenze drei offene Anfragen, Sperre nach `deny`), SEC-SESS-02 (`session`-Freigabe endet mit dem Transport und gilt nur für den unveränderten Eintrag), SEC-ERR-01 (Fehler nur mit Code und festem Text), SEC-SECRET-01 (keine Werte in Karte oder Audit).

**Parallel:** Task 5, Task 8, Task 15 (Welle C; keine gemeinsamen Dateien: Task 5 schreibt `validations/vault.js`, `controllers/vaultItems.js`, `controllers/vaultSettings.js`, `routes/vault/items.js`, `routes/vault/settings.js`; Task 8 `provision.js`, `controllers/agentKeys.js`, `routes/vault/agentKeys.js`, `validations/vaultAgentKeys.js`, `execCommand.js`, `server/index.js`; Task 15 nur `client/`). Setzt Task 1, Task 3 (`itemRef` aus `server/lib/vault/visibility.js`) und Task 4 voraus, alle aus Wellen A/B.

- [ ] **Step 1: Test schreiben**

`server/lib/vault/__tests__/approvals.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const express = require("express");
const { Sequelize } = require("sequelize");

const db = new Sequelize({ dialect: "sqlite", storage: ":memory:", logging: false });
const fake = (path, exports) => {
    const resolved = require.resolve(path);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

const CALLERS = {
    "s-owner": { user: { id: 1 }, session: { id: 11, accountId: 1, impersonatorId: null } },
    "s-imp": { user: { id: 1 }, session: { id: 12, accountId: 1, impersonatorId: 99 } },
    "k-owner": { user: { id: 1 }, apiKey: { id: 5, kind: "account" } },
};
fake("../../../utils/database", db);
fake("../../../middlewares/auth", {
    authenticate: (req, res, next) => {
        const caller = CALLERS[(req.header("authorization") ?? "").replace(/^Bearer /, "")];
        if (!caller) return res.status(401).json({ message: "The provided token is not valid" });
        Object.assign(req, caller);
        next();
    },
});
fake("../state", { requireVaultEnabled: (req, res, next) => next(), isVaultEnabled: () => true });

const audits = [];
const audit = require("../../../controllers/audit");
audit.createAuditLog = async (entry) => { audits.push(entry); };

const stateBroadcaster = require("../../StateBroadcaster");
const approvals = require("../approvals");
const router = require("../../../routes/vault/approvals");

const ITEM = {
    id: 7, accountId: 1, organizationId: null, name: "portal-login", type: "login", updatedAt: "2026-10-10T08:00:00.000Z",
    fields: { username: "ma", origins: ["https://portal.example.com", "https://sso.example.com"] },
};
const OTHER_ITEMS = [8, 9, 10].map((id) => ({ ...ITEM, id, name: `login-${id}` }));
const call = (overrides = {}) => ({
    accountId: 1, keyId: 5, transportId: "t-1", agentType: "claude", entryName: "web-01",
    item: ITEM, target: "https://portal.example.com", signal: new AbortController().signal, ...overrides,
});
const flush = () => new Promise((resolve) => setImmediate(resolve));

let nextWindow = 100;
const openWindow = (t, accountId, { impersonating = false } = {}) => {
    const messages = [];
    const ws = { readyState: 1, send: (raw) => messages.push(JSON.parse(raw)) };
    stateBroadcaster.register(accountId, nextWindow++, ws, null, null, { impersonating });
    t.after(() => stateBroadcaster.unregister(accountId, ws));
    const approvalsSeen = () => messages.filter((m) => m.type === "VAULT_APPROVALS");
    return { approvalsSeen, cards: () => approvalsSeen().at(-1)?.data ?? [] };
};

test.beforeEach(() => {
    approvals._resetForTests();
    audits.length = 0;
});
test.after(() => approvals._resetForTests());

test("Einmal gibt genau ein Ausfüllen frei; die erste Antwort gewinnt, jede weitere bekommt 409, ein fremdes Konto 404", async (t) => {
    const window = openWindow(t, 1);
    const first = approvals.requestApproval(call());
    await flush();
    const [card] = window.cards();
    assert.deepStrictEqual(Object.keys(card).sort(), ["agentType", "entryName", "expiresAt", "id", "item", "remainingMs", "target"]);
    assert.deepStrictEqual([card.item, card.agentType, card.entryName, card.target], ["portal-login", "claude", "web-01", "https://portal.example.com"]);

    assert.deepStrictEqual(approvals.answerApproval(card.id, 2, "once"), { status: 404 });
    assert.deepStrictEqual(approvals.answerApproval(card.id, 1, "once"), { status: 200 });
    assert.deepStrictEqual(approvals.answerApproval(card.id, 1, "deny"), { status: 409 });
    assert.strictEqual(await first, "once");
    await flush();
    assert.deepStrictEqual(window.cards(), []);
    assert.deepStrictEqual(audits.map((a) => [a.action, a.resource, a.resourceId, a.details.decision, a.details.item]), [["vault.approve", "vault", 7, "once", "portal-login"]]);

    const second = approvals.requestApproval(call());
    await flush();
    assert.strictEqual(window.cards().length, 1, "once is not remembered");
    approvals.answerApproval(window.cards()[0].id, 1, "once");
    assert.strictEqual(await second, "once");
});

test("Für diese Sitzung gilt bis zum Ende des Transports, nur für ihn und nur für den unveränderten Eintrag", async (t) => {
    const window = openWindow(t, 1);
    const first = approvals.requestApproval(call());
    await flush();
    approvals.answerApproval(window.cards()[0].id, 1, "session");
    assert.strictEqual(await first, "session");

    assert.strictEqual(await approvals.requestApproval(call()), "session");
    const reordered = { ...ITEM, fields: { ...ITEM.fields, origins: [...ITEM.fields.origins].reverse() } };
    assert.strictEqual(approvals.hasSessionApproval("t-1", reordered), true);
    await flush();
    assert.deepStrictEqual(window.cards(), []);

    const moved = { ...ITEM, fields: { ...ITEM.fields, origins: ["https://portal.example.net"] } };
    assert.strictEqual(approvals.hasSessionApproval("t-1", moved), false);
    const edited = { ...ITEM, updatedAt: "2026-10-10T08:05:00.000Z" };
    const afterEdit = approvals.requestApproval(call({ item: edited }));
    await flush();
    assert.strictEqual(window.cards().length, 1, "an edited entry needs a new card");
    approvals.answerApproval(window.cards()[0].id, 1, "once");
    assert.strictEqual(await afterEdit, "once");

    const otherTransport = approvals.requestApproval(call({ transportId: "t-2" }));
    await flush();
    assert.strictEqual(window.cards().length, 1);
    approvals.answerApproval(window.cards()[0].id, 1, "once");
    await otherTransport;

    approvals.forgetTransport("t-1");
    assert.strictEqual(approvals.hasSessionApproval("t-1", ITEM), false);
});

test("Ablehnen sperrt denselben Aufrufer für denselben Eintrag 60 s, auch über einen neuen Transport", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
    const window = openWindow(t, 1);
    const first = approvals.requestApproval(call());
    await flush();
    approvals.answerApproval(window.cards()[0].id, 1, "deny");
    await assert.rejects(first, { code: "vault.approval_denied", details: {} });
    assert.deepStrictEqual(audits.map((a) => a.action), ["vault.deny"]);

    t.mock.timers.tick(59_999);
    await assert.rejects(approvals.requestApproval(call({ transportId: "t-2" })), { code: "vault.approval_denied", details: { early: true } });
    await flush();
    assert.deepStrictEqual(window.cards(), []);
    assert.deepStrictEqual(audits.map((a) => a.action), ["vault.deny"]);

    const otherCaller = approvals.requestApproval(call({ keyId: 6, transportId: "t-3" }));
    await flush();
    assert.strictEqual(window.cards().length, 1, "another key of the account is not locked");
    approvals.answerApproval(window.cards()[0].id, 1, "once");
    await otherCaller;

    t.mock.timers.tick(1);
    const afterLock = approvals.requestApproval(call({ transportId: "t-2" }));
    await flush();
    assert.strictEqual(window.cards().length, 1);
    approvals.answerApproval(window.cards()[0].id, 1, "once");
    assert.strictEqual(await afterLock, "once");
});

test("ohne Antwort läuft die Anfrage nach 120 s ab; eine spätere Antwort bekommt 410", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
    const window = openWindow(t, 1);
    const pending = approvals.requestApproval(call());
    const outcome = assert.rejects(pending, { code: "vault.approval_timeout", details: {} });
    await flush();
    const [card] = window.cards();
    assert.deepStrictEqual([card.expiresAt, card.remainingMs], [new Date(1_000_000 + approvals.APPROVAL_TTL_MS).toISOString(), approvals.APPROVAL_TTL_MS]);

    t.mock.timers.tick(approvals.APPROVAL_TTL_MS - 1);
    await flush();
    assert.strictEqual(window.cards().length, 1);
    assert.strictEqual(approvals.listOpenApprovals(1)[0].remainingMs, 1);
    t.mock.timers.tick(1);
    await outcome;
    await flush();
    assert.deepStrictEqual(window.cards(), []);
    assert.deepStrictEqual(audits.map((a) => [a.action, a.details.reason]), [["vault.approval_timeout", "expired"]]);
    assert.deepStrictEqual(approvals.answerApproval(card.id, 1, "once"), { status: 410 });
});

test("bricht der Client ab, wird die Anfrage sofort zurückgezogen und als client_gone auditiert; ein schon abgebrochener Aufruf bekommt keine Karte", async (t) => {
    const window = openWindow(t, 1);
    const controller = new AbortController();
    const pending = approvals.requestApproval(call({ signal: controller.signal }));
    await flush();
    const [card] = window.cards();

    controller.abort();
    await assert.rejects(pending, { code: "vault.client_gone", details: {} });
    await assert.rejects(approvals.requestApproval(call({ signal: AbortSignal.abort() })), { code: "vault.client_gone", details: { early: true } });
    await flush();
    assert.deepStrictEqual(window.cards(), []);
    assert.deepStrictEqual(audits.map((a) => [a.action, a.details.reason]), [["vault.approval_timeout", "client_gone"]]);
    assert.deepStrictEqual(approvals.answerApproval(card.id, 1, "once"), { status: 410 });
});

test("ohne verbundenes Fenster sofort approval_unavailable; ein Impersonations-Fenster zählt nicht und sieht keine Karte", async (t) => {
    await assert.rejects(approvals.requestApproval(call()), { code: "vault.approval_unavailable", details: { early: true } });

    const impersonated = openWindow(t, 1, { impersonating: true });
    await assert.rejects(approvals.requestApproval(call()), { code: "vault.approval_unavailable", details: { early: true } });
    assert.deepStrictEqual(audits, []);

    const window = openWindow(t, 1);
    const pending = approvals.requestApproval(call());
    await flush();
    assert.strictEqual(window.cards().length, 1);
    approvals.answerApproval(window.cards()[0].id, 1, "once");
    await pending;
    await flush();
    assert.deepStrictEqual(impersonated.approvalsSeen(), []);
});

test("ein zweiter Aufruf für dieselbe offene Anfrage bekommt sofort approval_pending", async (t) => {
    const window = openWindow(t, 1);
    const first = approvals.requestApproval(call());
    await assert.rejects(approvals.requestApproval(call()), { code: "vault.approval_pending", details: { early: true } });
    const otherTransport = approvals.requestApproval(call({ transportId: "t-2" }));
    await flush();
    assert.strictEqual(window.cards().length, 2);
    for (const card of window.cards()) approvals.answerApproval(card.id, 1, "once");
    assert.deepStrictEqual(await Promise.all([first, otherTransport]), ["once", "once"]);
});

test("ab der vierten offenen Anfrage desselben Aufrufers approval_busy", async (t) => {
    const window = openWindow(t, 1);
    const open = OTHER_ITEMS.map((item) => approvals.requestApproval(call({ item })));
    await assert.rejects(approvals.requestApproval(call()), { code: "vault.approval_busy", details: { early: true } });
    const otherKey = approvals.requestApproval(call({ keyId: 6, transportId: "t-9" }));
    await flush();
    assert.strictEqual(window.cards().length, 4);
    for (const card of window.cards()) approvals.answerApproval(card.id, 1, "once");
    await Promise.all([...open, otherKey]);
});

test("Freigabe-Antworten nur aus einer Login-Session: Impersonation und Konto-Key bekommen 403", async (t) => {
    openWindow(t, 1);
    const app = express();
    app.use(express.json());
    app.use("/api/vault", router);
    const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    t.after(() => server.close());
    const pending = approvals.requestApproval(call());
    const [{ id }] = approvals.listOpenApprovals(1);
    const answer = (token, body = { decision: "once" }) => fetch(`http://127.0.0.1:${server.address().port}/api/vault/approvals/${id}`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
    });

    assert.strictEqual((await answer("s-imp")).status, 403);
    assert.strictEqual((await answer("k-owner")).status, 403);
    assert.strictEqual((await answer("s-owner", { decision: "always" })).status, 400);
    assert.strictEqual((await answer("s-owner")).status, 200);
    assert.strictEqual(await pending, "once");
    assert.strictEqual((await answer("s-owner")).status, 409);
});
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag prüfen**

Run: `cd /root/outpost && node --test server/lib/vault/__tests__/approvals.test.js`
Expected: FAIL — `Cannot find module '../approvals'`.

- [ ] **Step 3: `StateBroadcaster` um `VAULT_APPROVALS`, Impersonations-Flag und `hasConnection` erweitern**

`server/lib/StateBroadcaster.js` Z. 4-5, vorher:

```js
const STATE_TYPES = { ENTRIES: "ENTRIES", IDENTITIES: "IDENTITIES", SNIPPETS: "SNIPPETS", CONNECTIONS: "CONNECTIONS", LIVE_SESSIONS: "LIVE_SESSIONS", SESSION_PRESENCE: "SESSION_PRESENCE", BROWSER_SESSIONS: "BROWSER_SESSIONS", LOGOUT: "LOGOUT" };
const BROADCASTABLE_TYPES = [STATE_TYPES.ENTRIES, STATE_TYPES.IDENTITIES, STATE_TYPES.SNIPPETS, STATE_TYPES.CONNECTIONS, STATE_TYPES.LIVE_SESSIONS, STATE_TYPES.BROWSER_SESSIONS];
```

nachher:

```js
const STATE_TYPES = { ENTRIES: "ENTRIES", IDENTITIES: "IDENTITIES", SNIPPETS: "SNIPPETS", CONNECTIONS: "CONNECTIONS", LIVE_SESSIONS: "LIVE_SESSIONS", SESSION_PRESENCE: "SESSION_PRESENCE", BROWSER_SESSIONS: "BROWSER_SESSIONS", VAULT_APPROVALS: "VAULT_APPROVALS", LOGOUT: "LOGOUT" };
const BROADCASTABLE_TYPES = [STATE_TYPES.ENTRIES, STATE_TYPES.IDENTITIES, STATE_TYPES.SNIPPETS, STATE_TYPES.CONNECTIONS, STATE_TYPES.LIVE_SESSIONS, STATE_TYPES.BROWSER_SESSIONS, STATE_TYPES.VAULT_APPROVALS];
```

`register` (Z. 15-21), vorher:

```js
    register(accountId, sessionId, ws, tabId = null, browserId = null) {
        if (!this.connections.has(accountId)) this.connections.set(accountId, new Set());
        const conn = { ws, tabId, browserId, sessionId };
        this.connections.get(accountId).add(conn);
        if (!this.sessionIndex.has(sessionId)) this.sessionIndex.set(sessionId, new Set());
        this.sessionIndex.get(sessionId).add(conn);
    }
```

nachher (gibt `conn` zurück und bekommt `hasConnection` dahinter):

```js
    register(accountId, sessionId, ws, tabId = null, browserId = null, { impersonating = false } = {}) {
        if (!this.connections.has(accountId)) this.connections.set(accountId, new Set());
        const conn = { ws, tabId, browserId, sessionId, impersonating };
        this.connections.get(accountId).add(conn);
        if (!this.sessionIndex.has(sessionId)) this.sessionIndex.set(sessionId, new Set());
        this.sessionIndex.get(sessionId).add(conn);
        return conn;
    }

    hasConnection(accountId) {
        for (const conn of this.connections.get(accountId) ?? []) {
            if (!conn.impersonating && conn.ws.readyState === 1) return true;
        }
        return false;
    }
```

`getStateData`, nach dem `case STATE_TYPES.BROWSER_SESSIONS` (Z. 55-56) einfügen:

```js
            case STATE_TYPES.VAULT_APPROVALS:
                return require("./vault/approvals").listOpenApprovals(accountId);
```

`sendStateToConnection` (Z. 62-63), vorher:

```js
    async sendStateToConnection(accountId, conn, stateType) {
        if (conn.ws.readyState !== 1) return;
```

nachher (deckt Verbinden, `refresh` und jede Verteilung ab):

```js
    async sendStateToConnection(accountId, conn, stateType) {
        if (conn.ws.readyState !== 1) return;
        if (conn.impersonating && stateType === STATE_TYPES.VAULT_APPROVALS) return;
```

- [ ] **Step 4: `server/routes/state.js` übergibt die Impersonation**

Z. 17-18, vorher:

```js
    const conn = { ws, tabId: tabId || null, browserId: browserId || null, sessionId: session.id };
    stateBroadcaster.register(user.id, session.id, ws, tabId || null, browserId || null);
```

nachher (dasselbe `conn`-Objekt für Registrierung und Erstversand, sonst trüge der Erstversand das Flag nicht):

```js
    const conn = stateBroadcaster.register(user.id, session.id, ws, tabId || null, browserId || null,
        { impersonating: Boolean(session.impersonatorId) });
```

- [ ] **Step 5: `server/lib/vault/approvals.js` anlegen**

Prüfen und Eintragen einer Anfrage laufen ohne `await` dazwischen (der `Promise`-Executor läuft synchron), damit zwei gleichzeitige Aufrufe die Obergrenzen nicht gemeinsam überspringen. Erledigte Anfragen bleiben `APPROVAL_TTL_MS` lang in `closed`, damit späte Antworten `409`/`410` statt `404` bekommen. `sessionGrants` ist `Map<transportId, Map<itemId, stamp>>`; der Stempel aus `updatedAt` (als Millisekunden, weil MySQL unter `raw` ein `Date` und SQLite einen Text liefert) und den sortierten Ursprüngen wird beim Erzeugen der Anfrage genommen, sodass eine Änderung des Eintrags während der Wartezeit die neue `session`-Freigabe schon nicht mehr passen lässt. Frühe Ablehnungen tragen `details.early` und werden hier nicht auditiert (Audit schreibt Task 11).

```js
const { randomUUID } = require("node:crypto");
const stateBroadcaster = require("../StateBroadcaster");
const { createAuditLog, AUDIT_ACTIONS, RESOURCE_TYPES } = require("../../controllers/audit");
const { VaultError, VaultErrorCode } = require("./errors");
const { itemRef } = require("./visibility");

const APPROVAL_TTL_MS = 120000;
const DENY_LOCK_MS = 60000;
const MAX_OPEN_PER_CALLER = 3;

let open = new Map();
let closed = new Map();
let sessionGrants = new Map();
let denials = new Map();

const callerKey = (accountId, keyId) => `${accountId}:${keyId ?? "session"}`;
const denialKey = (accountId, keyId, itemId) => `${callerKey(accountId, keyId)}:${itemId}`;
const grantStamp = (item) => `${new Date(item.updatedAt).getTime()}|${JSON.stringify([...(item.fields?.origins ?? [])].sort())}`;
const early = (code) => new VaultError(code, undefined, { early: true });

const publish = (accountId) =>
    stateBroadcaster.sendStateToAccount(accountId, stateBroadcaster.STATE_TYPES.VAULT_APPROVALS).catch(() => {});

const audit = (request, action, details = {}, meta = {}) => createAuditLog({
    accountId: request.accountId, organizationId: request.organizationId, action,
    resource: RESOURCE_TYPES.VAULT, resourceId: request.itemId,
    details: { item: request.item, agentType: request.agentType, entryName: request.entryName, keyId: request.keyId, target: request.target, ...details },
    ipAddress: meta.ipAddress ?? null, userAgent: meta.userAgent ?? null,
});

const prune = (now) => {
    for (const [id, entry] of closed) if (entry.until <= now) closed.delete(id);
    for (const [key, until] of denials) if (until <= now) denials.delete(key);
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

const hasSessionApproval = (transportId, item) => sessionGrants.get(transportId)?.get(item.id) === grantStamp(item);

const requestApproval = async ({ accountId, keyId = null, transportId, agentType = null, entryName = null, item, target, signal }) => {
    if (hasSessionApproval(transportId, item)) return "session";
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
            agentType, entryName, target, expiresAt: now + APPROVAL_TTL_MS, resolve, reject, signal,
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
    close(request, 409);
    if (decision === "deny") {
        denials.set(denialKey(request.accountId, request.keyId, request.itemId), now + DENY_LOCK_MS);
        audit(request, AUDIT_ACTIONS.VAULT_DENY, {}, meta);
        request.reject(new VaultError(VaultErrorCode.APPROVAL_DENIED));
    } else {
        if (decision === "session") {
            if (!sessionGrants.has(request.transportId)) sessionGrants.set(request.transportId, new Map());
            sessionGrants.get(request.transportId).set(request.itemId, request.stamp);
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
        .map(({ id, agentType, entryName, item, target, expiresAt }) => ({
            id, agentType, entryName, item, target,
            expiresAt: new Date(expiresAt).toISOString(), remainingMs: Math.max(0, expiresAt - now),
        }));
};

const forgetTransport = (transportId) => {
    sessionGrants.delete(transportId);
    for (const request of [...open.values()]) if (request.transportId === transportId) expire(request, "client_gone");
};

const _resetForTests = () => {
    for (const request of open.values()) clearTimeout(request.timer);
    open = new Map();
    closed = new Map();
    sessionGrants = new Map();
    denials = new Map();
};

module.exports = {
    APPROVAL_TTL_MS, requestApproval, answerApproval, listOpenApprovals, hasSessionApproval, forgetTransport, _resetForTests,
};
```

- [ ] **Step 6: Validierung anlegen und `server/routes/vault/approvals.js` füllen**

`server/validations/vaultApprovals.js` anlegen (eigene Datei, weil `server/validations/vault.js` zum parallel laufenden Task 5 gehört; `server/openapi.js` liest alle Module in `server/validations/` und führt das Schema als `AnswerVaultApproval`):

```js
const Joi = require("joi");

module.exports.answerVaultApprovalValidation = Joi.object({
    decision: Joi.string().valid("once", "session", "deny").required(),
});
```

Den Platzhalter `server/routes/vault/approvals.js` aus Task 1 vollständig ersetzen:

```js
const { Router } = require("express");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const { authenticate } = require("../../middlewares/auth");
const { requireLoginSession } = require("../../middlewares/requireLoginSession");
const { requireVaultEnabled } = require("../../lib/vault/state");
const { answerApproval } = require("../../lib/vault/approvals");
const { validateSchema } = require("../../utils/schema");
const { sendError } = require("../../utils/error");
const { answerVaultApprovalValidation } = require("../../validations/vaultApprovals");

const app = Router();

const answerLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    keyGenerator: (req) => (req.user ? `acc:${req.user.id}` : `ip:${ipKeyGenerator(req.ip)}`),
    message: { code: 429, message: "Too many approval answers. Please try again in a moment." },
    standardHeaders: true,
    legacyHeaders: false,
});

const MESSAGES = {
    404: "Approval request not found",
    409: "This approval request has already been answered",
    410: "This approval request has expired",
};

/**
 * POST /vault/approvals/{id}
 * @summary Answer Vault Approval
 * @description Answers an open approval request of the authenticated account: once allows exactly one fill, session allows the entry for the rest of the agent's MCP session, deny blocks the same caller for this entry for 60 seconds. Requires a signed-in session; API keys and impersonation sessions get 403.
 * @tags Vault
 * @produces application/json
 * @security BearerAuth
 * @param {string} id.path.required - Approval request id
 * @param {AnswerVaultApproval} request.body.required - { decision: "once" | "session" | "deny" }
 * @return {object} 200 - { success: true }
 * @return {object} 403 - Signed-in session required
 * @return {object} 404 - Unknown request or not owned by the account
 * @return {object} 409 - Already answered
 * @return {object} 410 - Expired or withdrawn
 */
app.post("/approvals/:id", authenticate, requireVaultEnabled, requireLoginSession, answerLimiter, (req, res) => {
    const body = req.body ?? {};
    if (validateSchema(res, answerVaultApprovalValidation, body)) return;
    const { status } = answerApproval(req.params.id, req.user.id, body.decision,
        { ipAddress: req.ip, userAgent: req.header("user-agent") ?? null });
    if (status !== 200) return sendError(res, status, status, MESSAGES[status]);
    res.json({ success: true });
});

module.exports = app;
```

- [ ] **Step 7: Test grün**

Run: `cd /root/outpost && node --test server/lib/vault/__tests__/approvals.test.js`
Expected: PASS (9 Tests; die Warnung `ExperimentalWarning: The MockTimers API` ist erwartet).

- [ ] **Step 8: Bestehende Tests rund um den Zustandsstrom**

Run: `cd /root/outpost && node --test server/lib/__tests__/reconnectSession.test.js`
Expected: PASS (nutzt `StateBroadcaster`; `register` liefert jetzt zusätzlich `conn`, sonst unverändert).

- [ ] **Step 9: Lint**

Run: `cd /root/outpost && npx eslint server/lib/vault/approvals.js server/lib/StateBroadcaster.js server/routes/state.js server/routes/vault/approvals.js server/validations/vaultApprovals.js server/lib/vault/__tests__/approvals.test.js`
Expected: keine Meldungen.

- [ ] **Step 10: Commit**

```bash
git add server/lib/vault/approvals.js server/lib/StateBroadcaster.js server/routes/state.js server/routes/vault/approvals.js server/validations/vaultApprovals.js server/lib/vault/__tests__/approvals.test.js
git commit -m "Vault: Freigaben mit Karte, Ablauf, Sperre und Antwort-Endpunkt"
```

---

### Task 8: Agenten-Einrichtung (Server)

**Files:**
- Create: `server/lib/vault/provision.js` (einziger Ort, an dem Einrichtungs-, Probe- und Entfernbefehle entstehen; SEC-INJECT-01)
- Create: `server/controllers/agentKeys.js`
- Create: `server/validations/vaultAgentKeys.js` (zusätzlich: `server/validations/vault.js` gehört Task 5, der parallel läuft)
- Modify: `server/routes/vault/agentKeys.js` (leerer `Router()`-Platzhalter aus Task 1 → ganze Datei ersetzen)
- Modify: `server/controllers/execCommand.js` (Signatur Z. 8, Aufruf `controlPlane.execCommand` Z. 48)
- Modify: `server/index.js` (eine Zeile direkt nach dem `try`/`catch` um `initVaultState()`, den Task 1 nach `await migrationRunner.runMigrations();` Z. 144 einfügt, plus der Import)
- Test: `server/lib/vault/__tests__/provision.test.js`, `server/lib/vault/__tests__/agentKeysRoute.test.js`

**Interfaces:**
- Consumes:
  - Task 1: `ApiKey`-Spalten `kind`, `pending`, `entryId`, `agentType`, `ipBinding`, `allowedCidrs`, `identityId`, `remoteUser`, `seenIp`, `seenIpAdopted` und der `afterFind`-Hook an `ApiKey` (`allowedCidrs` als Array, `pending`/`ipBinding`/`seenIpAdopted` als Boolean); `Session.impersonatorId`; `VaultSettings.getOrCreate() → { agentUrl, … }` (Instanz, `raw: false`); `initVaultState()`, `requireVaultEnabled(req, res, next)` aus `server/lib/vault/state.js`; `AUDIT_ACTIONS.VAULT_AGENT_KEY_CREATE`, `AUDIT_ACTIONS.VAULT_AGENT_KEY_REVOKE`, `RESOURCE_TYPES.VAULT`; Platzhalter `server/routes/vault/agentKeys.js`, den `server/routes/vault/index.js` schon per `app.use(require("./agentKeys"))` einhängt.
  - Task 3: `canUseVault(accountId) → Promise<boolean>` aus `server/lib/vault/visibility.js` (`vault.use` oder aktive Organisationsmitgliedschaft).
  - Task 4: `authenticate` (lässt `pending`-Agenten-Keys nur an `GET /api/vault/agent-keys/probe` durch, endgültige Agenten-Keys nur unter `/api/mcp` mit IP-Bindung, setzt bei Login-Sessions `req.session`); `requireLoginSession(req, res, next)` als **benannter** Export von `server/middlewares/requireLoginSession.js` (Muster `middlewares/permission.js`); `isAddressAllowed(apiKey, entry, ip) → Promise<boolean>` aus `server/lib/vault/ipBinding.js` (`true` bei `!apiKey.ipBinding`, sonst `allowedCidrs` und aufgelöste Adressen des Servers; `ip` schon normalisiert; ohne Audit); `hashToken`, `generateToken`, `TOKEN_PREFIX` aus `server/controllers/apiKey.js`.
  - Bestand: `execCommand` (`server/controllers/execCommand.js`), `resolveIdentity(entry, null, null, accountId)` (`server/utils/identityResolver.js:7`), `validateEntryAccess`, `resolveEntryScope` (`server/controllers/entry.js`), `normalizeIp` (`server/utils/ip.js`), `sendError`, `validateSchema`, `logger`.
  - Nicht genutzt: `getAgentUrl()` aus Task 5 (läuft parallel); die Agenten-Adresse wird direkt aus `VaultSettings.getOrCreate()` gelesen.
- Produces:
  - `provision.js` (alle Befehle laufen als `/bin/sh -c '<Skript>'` mit `umask 077` als erster Zeile, damit eine nicht-POSIX-Login-Shell des entfernten Benutzers sie nicht bricht):
    - `shQuote(value: string) → string` — `'…'` mit `'\''`; wirft `TypeError` bei Nicht-String oder NUL.
    - `findCliScript(name: "claude"|"codex") → string` — Snippet (Subshell), gibt den absoluten Pfad aus, Exit 0; sonst Exit 1 ohne Ausgabe. Sucht `command -v` in `bash -lc`, ersatzweise `sh -lc`, dann `~/.local/bin`, `~/.claude/local`, `~/.npm-global/bin`.
    - **Ergänzung:** `findCliCommand(name) → string` — `findCliScript` als ausführbarer Befehl.
    - `claudeSetupCommand({ cliPath, url, key }) → string` — `claude mcp get outpost`; vorhanden → `claude mcp remove --scope user outpost` (Fehler ignoriert); `claude mcp add --scope user --transport http outpost <url> --header "Authorization: Bearer <key>"`; `chmod 600 ~/.claude.json`. Gibt `OUTPOST_REPLACED=0|1` direkt nach `mcp get` aus, also vor `remove`: Scheitert danach `add`, weiß Outpost trotzdem, dass die alte Registrierung weg ist.
    - `codexEnvCommand({ key }) → string` — schreibt die Zeile `[ -f ~/.codex/outpost.env ] && . ~/.codex/outpost.env` je einmal in `~/.bashrc`, `~/.profile` und, falls vorhanden, `~/.bash_profile`, `~/.zshrc`, und zuletzt atomar `~/.codex/outpost.env` (`export OUTPOST_MCP_TOKEN='<key>'` nach `outpost.env.new`, `chmod 600`, `mv -f`).
    - `codexSetupCommand({ cliPath, url }) → string` — `codex mcp get/remove outpost`, dann `codex mcp add outpost --url <url> --bearer-token-env-var OUTPOST_MCP_TOKEN`; `OUTPOST_REPLACED=0|1` wie bei Claude vor `remove`.
    - **Ergänzung:** `setupCommand({ agentType, cliPath, url, key }) → string` — Claude: `claudeSetupCommand`; Codex: `codexSetupCommand && codexEnvCommand` (Abweichung von der Spec-Reihenfolge „Datei, dann `mcp add`“: Die Key-Datei ist der letzte Schritt, scheitert die Registrierung, liest die Shell weiter den alten Key, der bis zur Bestätigung gültig bleibt). Wird auch als Kopierbefehl ausgegeben (dann `cliPath` = `"claude"`/`"codex"`).
    - `probeCommand({ url, key }) → string` — `url` ist die volle Probe-URL; Key nur in einer `mktemp`-Datei (0600), `curl -fsS --max-time 10 -H @<datei>`, sonst `wget -qO- -T 10 -t 1 --config=<datei>`, sonst Exit 127; die Datei wird per `trap … EXIT` gelöscht.
    - `registrationCheckCommand({ agentType, keyPrefix }) → string` — gibt genau eine Zeile `MATCH` (Registrierung trägt `keyPrefix`), `OTHER` (anderer Key) oder `ABSENT` aus, ändert nichts. Dieselbe Erkennung wie `revokeCommands` (gemeinsame `registrationStateLines`).
    - `revokeCommands({ agentType, keyPrefix }) → string` — `keyPrefix` = `apiKey.prefix` ohne `…` (`/^[A-Za-z0-9_]{8,64}$/`, sonst `TypeError`, ebenso bei `registrationCheckCommand`); gibt genau eine Zeile `REMOVED`, `FOREIGN` oder `ABSENT` aus; entfernt nur, wenn die Registrierung mit `keyPrefix` beginnt; Exit 3 (CLI fehlt) bzw. 4 (Entfernen scheiterte) ohne Marker.
  - `agentKeys.js` (Controller; Fehler als `{ code, message }`):
    - `createAgentKeys({ accountId, entryId, agentTypes, ipBinding = true, allowedCidrs = [], ipAddress = null, userAgent = null }) → { results: [{ id, agentType, status: "configured"|"manual", reason: "cli_missing"|"exec_failed"|null, remoteUser, command?, probe: { seenIp, matches }|null, replacedRegistration }] }` — `ipAddress`/`userAgent` sind eine Ergänzung (nur fürs Audit); `reason` ist `null` bei `configured`, `cli_missing` wenn die CLI an keiner Stelle gefunden wurde, sonst `exec_failed` (keine Identität, Exec- oder Einrichtungsfehler); `command` (mit Key) nur bei `manual`; `replacedRegistration` auch bei `manual`, sobald die Ausgabe `OUTPOST_REPLACED=1` enthält. Die Agenten laufen parallel (`Promise.all`). Scheitert der Einrichtungs-Exec selbst (Exec-Fehler, Timeout), prüft `registrationCheckCommand` nach: `MATCH` → `configured`, sonst `manual`/`exec_failed`; ein Exit-Code ungleich 0 bleibt ohne Nachprüfung `exec_failed`. Fehler: `409` Agenten-Adresse fehlt oder für diesen Server läuft schon eine Einrichtung (`setupsInFlight`, je Server, im Speicher), `403` `canUseVault` falsch, `404` Eintrag fehlt/kein Zugriff, `400` kein SSH-Eintrag.
    - `probe(apiKey, rawIp) → { seenIp }` — antwortet mit `normalizeIp(rawIp)` und speichert nur die erste Messung an einem `pending`-Agenten-Key (`seenIp: null` in der Where-Bedingung).
    - `confirm(accountId, id, { addSeenIp = false } = {}, { ipAddress = null, userAgent = null } = {}, now = Date.now()) → { success: true }` — `404` fremder/unbekannter Key; `410 { message: "This setup has expired. Set up agent access again." }` für einen `pending`-Key älter als 15 min oder einen, den `sweepPending` währenddessen löscht. Mit `addSeenIp`: `409` ohne Messung, `409 { message: "The measured address is the address of your browser; Outpost sees a proxy, not the server" }` wenn `normalizeIp(ipAddress)` (Adresse des Bestätigenden) gleich `seenIp` ist, `409` nach 15 min oder bei zweiter Übernahme (Key noch da; sonst `410`); trägt `<seenIp>/32` bzw. `/128` ein. Macht `pending` endgültig und löscht danach die eigenen alten Keys für (Server, Agent, entfernter Benutzer) ohne Entfernbefehle, je gelöschtem Key ein Audit `vault.agent_key_revoke` mit `registration: "replaced"` (dasselbe beim Ersetzen in `createAgentKeys`).
    - `revoke(accountId, id, { ipAddress, userAgent } = {}) → { success: true, registration: "removed"|"foreign"|"absent"|"unknown", commands? }` — löscht zuerst den Key; `pending` → `absent` ohne Exec; sonst Entfernbefehl mit der gespeicherten `identityId`; Identität weg oder Exec gescheitert → `unknown` plus `commands` (Kopierbefehl).
    - `listAgentKeys(accountId, { entryId = null } = {}) → { keys, remoteUser?, otherAccountConfigured? }` — nur endgültige Keys; Key-Form `{ id, name, prefix, agentType, pending, entryId, entryName, remoteUser, ipBinding, allowedCidrs, createdAt, lastUsedAt }` (`pending` ist hier immer `false`); mit `entryId` zusätzlich `remoteUser` (Benutzer der Identität, die `resolveIdentity` wählen würde) und `otherAccountConfigured`.
    - `sweepPending(now = Date.now()) → Promise<number>`; `startPendingSweeper() → Timeout` (60 s, `unref`); `PENDING_TTL_MS = 900000`.
  - Routen unter `/api/vault` (alle mit `requireVaultEnabled` vor `authenticate`): `GET /agent-keys/probe` (nur `req.apiKey.kind === "agent"` und `pending`, sonst `403`; Rate-Limit 10/min je Key), `GET /agent-keys` (`?entryId=`), `POST /agent-keys` → `201`, `POST /agent-keys/:id/confirm` (reicht `req.ip` an `confirm` durch), `DELETE /agent-keys/:id` (die drei letzten mit `requireLoginSession` und Rate-Limit 30/min je Konto). Ein Error-Handler am Router-Ende (Muster `server/routes/entryBookmarks.js:93-98`) loggt und antwortet `500 { code: 500, message: "Could not complete the agent key request." }`.
  - `execCommand(accountId, entryId, identityId, command, { engineId = null } = {})`.
  - Audit `vault.agent_key_create`, `vault.agent_key_revoke` mit `resource: "vault"`, `resourceId: null`, `details: { keyId, agentType, entryId, entryName, remoteUser, … }` (create zusätzlich `ipBinding`, revoke zusätzlich `registration` — `removed|foreign|absent|unknown`, beim Ersetzen `replaced` — und `pending`), `organizationId` aus `resolveEntryScope` des Servers. Nie Key, Präfix-Vergleichsausgabe oder Exec-Ausgabe.
  - Joi: `createAgentKeysValidation`, `confirmAgentKeyValidation`, `listAgentKeysValidation`, `agentKeyIdValidation` (OpenAPI-Schemas `CreateAgentKeys`, `ConfirmAgentKey`, …).

**Design:** kein UI-Anteil.

**Tests:** 14 Tests in zwei Dateien. Die Befehle in `provision.test.js` werden **wirklich** in `/bin/sh` ausgeführt, in einem Temp-HOME mit Stub-Binaries (Node-Skripte für `claude`, `codex`, `curl`, `wget`; ein `sh`-Stub simuliert die Login-Shell) und einem PATH, der nur Stubs und acht Coreutils enthält — keine CLI, kein `curl` und kein `bash` der Testmaschine kann hineinwirken. Test-first, weil der Vertrag feststeht.
- `provision.test.js` (5): Spec-Test 9 für Claude (Argumente mit Sonderzeichen in URL und Key kommen unverändert an, keine Befehlsausführung aus den Werten, `~/.claude.json` danach 0600, `OUTPOST_REPLACED`); Spec-Test 9 für Codex (eingelesener Wert gleich Key, 0600, Source-Zeile genau einmal, `.zshrc` nur wenn vorhanden, auch ohne Zeilenende; scheitert `mcp add`, steht `OUTPOST_REPLACED=1` in der Ausgabe und die Key-Datei hält den alten Key); Probe (Key nie in der Argumentliste, Datei 0600 und danach gelöscht, `wget`-Ersatz, Exit 127 ohne Werkzeug); CLI-Suche (Login-Shell vor Installationsorten, sonst Exit 1); Review Focus 4 (fremde Registrierung bleibt stehen → `FOREIGN`, eigene → `REMOVED`, danach `ABSENT`, für Claude und Codex; `registrationCheckCommand` meldet dazu `OTHER`/`MATCH`/`ABSENT`; eine Projekt-Registrierung mit dem eigenen Key in `~/.claude.json` zählt nicht).
- `agentKeysRoute.test.js` (9), über die HTTP-Naht mit echtem `authenticate` (Task 4), echtem `execCommand`, echtem `canUseVault` (Task 3) und In-Memory-SQLite; gefakt sind nur `controlPlane` (spielt den entfernten Server: die Probe ruft Outpost per `fetch` mit dem Key aus der Befehlszeile zurück, über einen Proxy, der per `X-Forwarded-For` die Server-Adresse meldet; die Test-App setzt `trust proxy` auf `loopback`), `identityResolver`, `controllers/entry`, `ConnectionService`, Audit und Rechte-Engine: Review Focus 3 (probe nur mit `pending`-Key, andere `403`; gesehene Adresse; `engineId` erreicht `controlPlane`; ohne Übernahme `403` an `/api/mcp`, nach `confirm` mit `addSeenIp` `200`, zweite Übernahme `409`); nach 15 min `addSeenIp` `409` und `confirm` eines `pending`-Keys `410`; manuelle Einrichtung (`cli_missing`, Befehl, Key bleibt `pending` bis `confirm`; Exec-Timeout mit stehender Registrierung → `configured`, mit fremder → `exec_failed`); `sweepPending`; Ersetzen eigener alter Keys ohne Entfernbefehle mit Audit `registration: "replaced"`, gleichzeitige Einrichtung `409`, `otherAccountConfigured` für das zweite Konto; Spec-Test 11 Teil 2/3 (Impersonation und Konto-Key `403`, fremde Key-ID `404`); CIDR-Prüfung; Entscheidung 9 (zweite Probe überschreibt die Messung nicht, `addSeenIp` mit der Browser-Adresse `409`, ohne Übernahme `200`); Entziehen mit gespeicherter Identität bzw. Kopierbefehl ohne Identität. Das Limit 30/min je Konto gilt über die ganze Datei; Konto A kommt auf 26 Anfragen, der Entscheidung-9-Test läuft deshalb mit Konto B.
- Nicht getestet: `listAgentKeys` ohne `entryId` (Weiterreichung), `startPendingSweeper` (Timer), Rate-Limiter (Framework), Error-Handler (Bestandsmuster), die `410`-Zweige nach einem Wettlauf mit `sweepPending` (nur zeitabhängig erreichbar; der Ablauf-Zweig ist getestet), Joi-Standardfälle, Log-Ausgaben.
- SEC-Abdeckung: SEC-INJECT-01 (`provision.js`, Spec-Test 9), SEC-IDOR-01 (jede Key-Abfrage mit `accountId`, fremde ID `404`), SEC-TENANT-01 (Server nur nach `validateEntryAccess`, Audit mit Organisation des Servers), SEC-RATE-01 (Limiter an Einrichtung/Bestätigung/Entziehen/Probe), SEC-INPUT-01 (Joi für `agentTypes`, CIDRs, IDs), SEC-APIKEY-01 und SEC-SESS-02 (256-Bit-Key gehasht, `pending`-Ablauf 15 min, Widerruf), SEC-SECRET-01 (Exec-Ausgaben nie geloggt, Key nur im Kopierbefehl einer `manual`-Antwort), SEC-ERR-01 (feste Meldungen ohne Exec-Details), SEC-SQLI-01 (nur Sequelize-`where`).

**Parallel:** Task 5, Task 6, Task 15 (Welle C; keine gemeinsamen Dateien: Task 5 schreibt `routes/vault/items.js`, `routes/vault/settings.js`, `validations/vault.js`, `controllers/vaultItems.js`, `controllers/vaultSettings.js`; Task 6 `lib/vault/approvals.js`, `StateBroadcaster.js`, `routes/state.js`, `routes/vault/approvals.js`, `validations/vaultApprovals.js`; Task 15 nur `client/`; `server/index.js` fasst in Welle C nur Task 8 an). `visibility.js` (Task 3) und `ipBinding.js` (Task 4) liest dieser Task nur; beide stammen aus Welle B.

- [ ] **Step 0: CLI-Flags gegen echte Installationen prüfen**

Die Stubs in Step 1 spielen die CLIs nach; ob die echten Flags so heißen, prüft nur eine echte Installation. Auf einem Rechner mit aktueller Claude-Code- und Codex-CLI, in einem Wegwerf-HOME (`export HOME=$(mktemp -d)`), nichts im Repo:

Run: `claude mcp add --help; claude mcp remove --help; codex mcp add --help; codex mcp remove --help; claude mcp get outpost; echo "claude get: $?"; codex mcp get outpost; echo "codex get: $?"`
Expected: `claude mcp add` kennt `--scope user`, `--transport http` und `--header`, `claude mcp remove` kennt `--scope user`, `codex mcp add` kennt `--url` und `--bearer-token-env-var`; beide `get` enden ohne Registrierung mit Exit ungleich 0.

Run: `claude mcp add --scope user --transport http outpost https://example.invalid/api/mcp --header "Authorization: Bearer outpost_test" && cat ~/.claude.json; env -u OUTPOST_MCP_TOKEN codex mcp add outpost --url https://example.invalid/api/mcp --bearer-token-env-var OUTPOST_MCP_TOKEN; echo "codex add: $?"`
Expected: In `~/.claude.json` steht `"mcpServers"` mit zwei Leerzeichen Einzug auf oberster Ebene und `"outpost"` mit vier darunter (davon hängt `CLAUDE_REGISTRATION_AWK` ab); `codex add: 0` auch ohne gesetzte Variable, weil `codexSetupCommand` vor der Key-Datei läuft.

Weicht etwas ab: anhalten und melden (Stubs, Befehle und Spec gemeinsam anpassen), nicht raten.

- [ ] **Step 1: Failing test für die Befehle schreiben**

`server/lib/vault/__tests__/provision.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile, execFileSync } = require("node:child_process");
const provision = require("../provision");

// The commands run for real in /bin/sh. PATH holds only the stub directory and a handful of
// coreutils, so no CLI, curl, wget or bash of the test machine can leak in.
const TOOLS = ["awk", "chmod", "grep", "mkdir", "mktemp", "mv", "rm", "tail"];
const SOURCE_LINE = "[ -f ~/.codex/outpost.env ] && . ~/.codex/outpost.env";
const ODD_URL = "https://out post.example/a'b\"c$(touch \"$HOME/pwned\")`touch \"$HOME/pwned2\"`;&|*?!#\\x/api/mcp";
const ODD_KEY = "outpost_k'e\"y$(touch \"$HOME/pwned3\") `id` ;&|\\";

const node = (body) => `#!${process.execPath}\n${body}`;
const LOGIN_SH = `#!/bin/sh
if [ "$1" = "-lc" ]; then PATH="$HOME/login-bin:$PATH"; export PATH; exec /bin/sh -c "$2"; fi
exec /bin/sh "$@"
`;
const STUBS = {
    claude: node(`
const fs = require("fs");
const file = process.env.HOME + "/.claude.json";
fs.appendFileSync(process.env.HOME + "/claude-calls.log", JSON.stringify(process.argv.slice(2)) + "\\n");
const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { numStartups: 1 };
const servers = config.mcpServers || {};
const save = () => { config.mcpServers = servers; fs.writeFileSync(file, JSON.stringify(config, null, 2)); fs.chmodSync(file, 0o644); };
const [command, sub, ...rest] = process.argv.slice(2);
if (command !== "mcp") process.exit(2);
if (sub === "get") process.exit(servers[rest[0]] ? 0 : 1);
if (sub === "remove") { const name = rest[rest.length - 1]; if (!servers[name]) process.exit(1); delete servers[name]; save(); process.exit(0); }
if (sub !== "add") process.exit(2);
const options = {}; const positional = [];
for (let i = 0; i < rest.length; i++) { if (rest[i].startsWith("--")) options[rest[i]] = rest[++i]; else positional.push(rest[i]); }
const [headerName, ...headerValue] = options["--header"].split(": ");
servers[positional[0]] = { type: options["--transport"], url: positional[1], headers: { [headerName]: headerValue.join(": ") } };
save();
`),
    codex: node(`
const fs = require("fs");
const file = process.env.HOME + "/.codex/registrations.json";
fs.appendFileSync(process.env.HOME + "/codex-calls.log", JSON.stringify(process.argv.slice(2)) + "\\n");
const servers = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
const save = () => { fs.mkdirSync(process.env.HOME + "/.codex", { recursive: true }); fs.writeFileSync(file, JSON.stringify(servers)); };
const [command, sub, name, ...rest] = process.argv.slice(2);
if (command !== "mcp") process.exit(2);
if (sub === "get") process.exit(servers[name] ? 0 : 1);
if (sub === "remove") { if (!servers[name]) process.exit(1); delete servers[name]; save(); process.exit(0); }
if (sub !== "add" || fs.existsSync(process.env.HOME + "/fail-add")) process.exit(2);
servers[name] = rest;
save();
`),
    curl: node(`
const fs = require("fs");
const args = process.argv.slice(2);
const file = args[args.indexOf("-H") + 1].slice(1);
fs.writeFileSync(process.env.HOME + "/curl-call.json", JSON.stringify({ args, file, content: fs.readFileSync(file, "utf8"), mode: fs.statSync(file).mode & 0o777 }));
process.stdout.write('{"seenIp":"192.0.2.7"}');
`),
    wget: node(`
const fs = require("fs");
const args = process.argv.slice(2);
const file = args.find((arg) => arg.startsWith("--config=")).slice("--config=".length);
fs.writeFileSync(process.env.HOME + "/wget-call.json", JSON.stringify({ args, file, content: fs.readFileSync(file, "utf8"), mode: fs.statSync(file).mode & 0o777 }));
process.stdout.write('{"seenIp":"192.0.2.7"}');
`),
};

const makeHome = (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "outpost-provision-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const [home, bin, tools, tmp] = ["home", "bin", "tools", "tmp"].map((name) => path.join(root, name));
    for (const dir of [home, bin, tools, tmp]) fs.mkdirSync(dir);
    for (const tool of TOOLS)
        fs.symlinkSync(execFileSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim(), path.join(tools, tool));
    fs.writeFileSync(path.join(bin, "sh"), LOGIN_SH, { mode: 0o755 });

    const install = (name, dir = path.join(home, ".local/bin")) => {
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, name);
        fs.writeFileSync(file, STUBS[name], { mode: 0o755 });
        return file;
    };
    const run = (command) => new Promise((resolve) => {
        execFile("/bin/sh", ["-c", command], { env: { HOME: home, PATH: `${bin}:${tools}`, TMPDIR: tmp } },
            (error, stdout) => resolve({ code: error ? error.code : 0, stdout }));
    });
    const read = (name) => fs.readFileSync(path.join(home, name), "utf8");
    const calls = (name) => read(`${name}-calls.log`).trim().split("\n").map((line) => JSON.parse(line));
    const pwned = () => fs.readdirSync(home).filter((name) => name.startsWith("pwned"));
    return { home, bin, install, run, read, calls, pwned };
};

const newKey = () => `outpost_${crypto.randomBytes(32).toString("hex")}`;
const prefixOf = (key) => key.slice(0, "outpost_".length + 6);

test("Spec-Test 9: der Claude-Befehl reicht URL und Key mit Sonderzeichen unverändert weiter und macht ~/.claude.json privat", async (t) => {
    const env = makeHome(t);
    const cliPath = env.install("claude");
    fs.writeFileSync(path.join(env.home, ".claude.json"), JSON.stringify({
        mcpServers: { outpost: { type: "http", url: "http://old", headers: { Authorization: "Bearer outpost_old" } } },
    }, null, 2));

    const { code, stdout } = await env.run(provision.claudeSetupCommand({ cliPath, url: ODD_URL, key: ODD_KEY }));

    assert.strictEqual(code, 0);
    assert.match(stdout, /^OUTPOST_REPLACED=1$/m);
    assert.deepStrictEqual(env.calls("claude"), [
        ["mcp", "get", "outpost"],
        ["mcp", "remove", "--scope", "user", "outpost"],
        ["mcp", "add", "--scope", "user", "--transport", "http", "outpost", ODD_URL, "--header", `Authorization: Bearer ${ODD_KEY}`],
    ]);
    assert.strictEqual(fs.statSync(path.join(env.home, ".claude.json")).mode & 0o777, 0o600);
    assert.deepStrictEqual(env.pwned(), []);
});

test("Spec-Test 9: Codex liest den Key aus einer privaten Datei, die jede Shell genau einmal einbindet; scheitert die Registrierung, bleibt die alte Datei", async (t) => {
    const env = makeHome(t);
    const cliPath = env.install("codex");
    fs.writeFileSync(path.join(env.home, ".zshrc"), "export ZSH_SEEN=1");
    const command = provision.setupCommand({ agentType: "codex", cliPath, url: ODD_URL, key: ODD_KEY });

    assert.strictEqual((await env.run(command)).code, 0);
    const second = await env.run(command);

    assert.strictEqual(second.code, 0);
    assert.match(second.stdout, /^OUTPOST_REPLACED=1$/m);
    assert.strictEqual(fs.statSync(path.join(env.home, ".codex/outpost.env")).mode & 0o777, 0o600);
    assert.strictEqual((await env.run(". \"$HOME/.codex/outpost.env\"; printf '%s' \"$OUTPOST_MCP_TOKEN\"")).stdout, ODD_KEY);
    assert.strictEqual(env.read(".bashrc"), `${SOURCE_LINE}\n`);
    assert.strictEqual(env.read(".profile"), `${SOURCE_LINE}\n`);
    assert.strictEqual(env.read(".zshrc"), `export ZSH_SEEN=1\n${SOURCE_LINE}\n`);
    assert.strictEqual(fs.existsSync(path.join(env.home, ".bash_profile")), false);
    const add = ["mcp", "add", "outpost", "--url", ODD_URL, "--bearer-token-env-var", "OUTPOST_MCP_TOKEN"];
    assert.deepStrictEqual(env.calls("codex"), [["mcp", "get", "outpost"], add, ["mcp", "get", "outpost"], ["mcp", "remove", "outpost"], add]);
    assert.deepStrictEqual(env.pwned(), []);

    fs.writeFileSync(path.join(env.home, "fail-add"), "");
    const failed = await env.run(provision.setupCommand({ agentType: "codex", cliPath, url: ODD_URL, key: newKey() }));
    assert.notStrictEqual(failed.code, 0);
    assert.match(failed.stdout, /^OUTPOST_REPLACED=1$/m);
    assert.strictEqual((await env.run(". \"$HOME/.codex/outpost.env\"; printf '%s' \"$OUTPOST_MCP_TOKEN\"")).stdout, ODD_KEY);
});

test("die Probe gibt den Key nur über eine 0600-Datei an curl bzw. wget und löscht die Datei danach", async (t) => {
    const env = makeHome(t);
    const url = "https://outpost.example/x'y$(touch \"$HOME/pwned\")/api/vault/agent-keys/probe";
    const command = provision.probeCommand({ url, key: ODD_KEY });

    env.install("curl", env.bin);
    assert.deepStrictEqual(await env.run(command), { code: 0, stdout: "{\"seenIp\":\"192.0.2.7\"}" });
    const curl = JSON.parse(env.read("curl-call.json"));
    assert.deepStrictEqual([curl.content, curl.mode, curl.args.at(-1)], [`Authorization: Bearer ${ODD_KEY}\n`, 0o600, url]);
    assert.ok(!curl.args.some((arg) => arg.includes(ODD_KEY)));
    assert.strictEqual(fs.existsSync(curl.file), false);

    fs.rmSync(path.join(env.bin, "curl"));
    env.install("wget", env.bin);
    assert.strictEqual((await env.run(command)).code, 0);
    const wget = JSON.parse(env.read("wget-call.json"));
    assert.deepStrictEqual([wget.content, wget.mode, wget.args.at(-1)], [`header = Authorization: Bearer ${ODD_KEY}\n`, 0o600, url]);
    assert.strictEqual(fs.existsSync(wget.file), false);

    fs.rmSync(path.join(env.bin, "wget"));
    assert.strictEqual((await env.run(command)).code, 127);
    assert.deepStrictEqual(env.pwned(), []);
});

test("die CLI-Suche nimmt den Pfad der Login-Shell, sonst die bekannten Installationsorte", async (t) => {
    const env = makeHome(t);

    assert.deepStrictEqual(await env.run(provision.findCliCommand("codex")), { code: 1, stdout: "" });
    const fallback = env.install("codex");
    assert.strictEqual((await env.run(provision.findCliCommand("codex"))).stdout, `${fallback}\n`);
    const login = env.install("codex", path.join(env.home, "login-bin"));
    assert.strictEqual((await env.run(provision.findCliCommand("codex"))).stdout, `${login}\n`);
});

test("Review Focus 4: Prüfen und Entziehen erkennen nur eine Registrierung, die noch den eigenen Key trägt", async (t) => {
    const env = makeHome(t);
    const [mine, theirs] = [newKey(), newKey()];
    fs.writeFileSync(path.join(env.home, ".claude.json"), JSON.stringify({
        projects: { "/srv": { mcpServers: { outpost: { type: "http", url: "x", headers: { Authorization: `Bearer ${mine}` } } } } },
    }, null, 2));
    const registered = {
        claude: () => JSON.parse(env.read(".claude.json")).mcpServers?.outpost?.headers.Authorization ?? null,
        codex: () => (fs.existsSync(path.join(env.home, ".codex/outpost.env")) ? env.read(".codex/outpost.env") : null),
    };

    for (const agentType of ["claude", "codex"]) {
        const cliPath = env.install(agentType);
        assert.strictEqual((await env.run(provision.setupCommand({ agentType, cliPath, url: "https://outpost.example/api/mcp", key: theirs }))).code, 0);
        const revokeMine = provision.revokeCommands({ agentType, keyPrefix: prefixOf(mine) });
        const revokeTheirs = provision.revokeCommands({ agentType, keyPrefix: prefixOf(theirs) });
        const check = async (key) => (await env.run(provision.registrationCheckCommand({ agentType, keyPrefix: prefixOf(key) }))).stdout;

        assert.deepStrictEqual([await check(mine), await check(theirs)], ["OTHER\n", "MATCH\n"], agentType);
        assert.strictEqual((await env.run(revokeMine)).stdout, "FOREIGN\n", agentType);
        assert.match(registered[agentType](), new RegExp(theirs), agentType);
        assert.ok(!env.calls(agentType).some(([, sub]) => sub === "remove"), agentType);

        assert.strictEqual((await env.run(revokeTheirs)).stdout, "REMOVED\n", agentType);
        assert.strictEqual(registered[agentType](), null, agentType);
        assert.strictEqual((await env.run(revokeMine)).stdout, "ABSENT\n", agentType);
        assert.strictEqual(await check(theirs), "ABSENT\n", agentType);
    }
});
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag prüfen**

Run: `cd /root/outpost && node --test server/lib/vault/__tests__/provision.test.js`
Expected: FAIL — `Cannot find module '../provision'`.

- [ ] **Step 3: `server/lib/vault/provision.js` anlegen**

Hinweis zum Entziehen: Das Skript entscheidet selbst (entfernt nur, wenn die gefundene Registrierung mit `keyPrefix` beginnt; Spec „Zugang entziehen“). Verglichen wird auf dem Zielserver gegen das nicht geheime Präfix; der dort gefundene Key verlässt den Server nie, und Prüfen und Entfernen geschehen in einem Exec ohne Lücke dazwischen. Outpost liest nur den Marker, die übrige Ausgabe wird verworfen. `registrationCheckCommand` nutzt dieselbe Erkennung (`registrationStateLines`), ändert aber nichts; der Controller ruft es nur, wenn der Einrichtungs-Exec selbst scheiterte und offen ist, ob die Registrierung schon steht.

```js
const CLI_NAMES = new Set(["claude", "codex"]);
const CLI_DIRS = ["$HOME/.local/bin", "$HOME/.claude/local", "$HOME/.npm-global/bin"];
const CODEX_ENV = "$HOME/.codex/outpost.env";
const SOURCE_LINE = "[ -f ~/.codex/outpost.env ] && . ~/.codex/outpost.env";
const RC_FILES = ["$HOME/.bashrc", "$HOME/.profile", "$HOME/.bash_profile", "$HOME/.zshrc"];
const KEY_PREFIX = /^[A-Za-z0-9_]{8,64}$/;

// Relies on the layout Claude Code writes (JSON.stringify with two spaces): only the user-scope
// registration sits at this depth, project registrations are nested deeper and never match.
const CLAUDE_REGISTRATION_AWK = [
    "/^  \"mcpServers\": \\{/ { m = 1; next }",
    "m && /^  \\}/ { exit }",
    "m && /^    \"outpost\": \\{/ { o = 1; s = \"OTHER\"; next }",
    "o && /^    \\}/ { exit }",
    "o && index($0, p) { s = \"MATCH\"; exit }",
    "END { print s }",
].join("\n");

const shQuote = (value) => {
    if (typeof value !== "string" || value.includes("\0")) throw new TypeError("shQuote needs a string without NUL bytes");
    return `'${value.replace(/'/g, "'\\''")}'`;
};

const cliName = (name) => {
    if (!CLI_NAMES.has(name)) throw new TypeError(`Unknown agent CLI: ${name}`);
    return name;
};

// execCommand hands the string to the login shell of the remote user, which need not be POSIX.
const asCommand = (lines) => `/bin/sh -c ${shQuote(["umask 077", ...lines].join("\n"))}`;

const findCliScript = (name) => {
    const lookup = shQuote(`command -v ${cliName(name)}`);
    const candidates = ["\"$p\"", ...CLI_DIRS.map((dir) => `"${dir}/${name}"`)].join(" ");
    return [
        "(",
        `p=$(bash -lc ${lookup} 2>/dev/null </dev/null | tail -n 1)`,
        `[ -n "$p" ] || p=$(sh -lc ${lookup} 2>/dev/null </dev/null | tail -n 1)`,
        `for c in ${candidates}; do`,
        "case \"$c\" in /*) if [ -x \"$c\" ] && [ ! -d \"$c\" ]; then printf '%s\\n' \"$c\"; exit 0; fi ;; esac",
        "done",
        "exit 1",
        ")",
    ].join("\n");
};

const findCliCommand = (name) => asCommand([findCliScript(name)]);

const claudeSetupCommand = ({ cliPath, url, key }) => asCommand([
    `cli=${shQuote(cliPath)}`,
    "if \"$cli\" mcp get outpost >/dev/null 2>&1; then",
    "echo OUTPOST_REPLACED=1",
    "\"$cli\" mcp remove --scope user outpost >/dev/null 2>&1 || true",
    "else",
    "echo OUTPOST_REPLACED=0",
    "fi",
    `"$cli" mcp add --scope user --transport http outpost ${shQuote(url)} --header ${shQuote(`Authorization: Bearer ${key}`)} >/dev/null || exit 1`,
    "if [ -f \"$HOME/.claude.json\" ]; then chmod 600 \"$HOME/.claude.json\" || exit 1; fi",
]);

// The key file comes last and is swapped in whole: until then the previous key stays readable.
const codexEnvCommand = ({ key }) => asCommand([
    "mkdir -p \"$HOME/.codex\" || exit 1",
    `line=${shQuote(SOURCE_LINE)}`,
    `for rc in ${RC_FILES.map((file) => `"${file}"`).join(" ")}; do`,
    "case \"$rc\" in */.bash_profile|*/.zshrc) [ -f \"$rc\" ] || continue ;; esac",
    "grep -qxF \"$line\" \"$rc\" 2>/dev/null && continue",
    "if [ -s \"$rc\" ] && [ -n \"$(tail -c 1 \"$rc\")\" ]; then echo >> \"$rc\"; fi",
    "printf '%s\\n' \"$line\" >> \"$rc\" || exit 1",
    "done",
    `f="${CODEX_ENV}"`,
    "rm -f \"$f.new\"",
    `printf '%s\\n' ${shQuote(`export OUTPOST_MCP_TOKEN=${shQuote(key)}`)} > "$f.new" || exit 1`,
    "chmod 600 \"$f.new\" || exit 1",
    "mv -f \"$f.new\" \"$f\" || exit 1",
]);

const codexSetupCommand = ({ cliPath, url }) => asCommand([
    `cli=${shQuote(cliPath)}`,
    "if \"$cli\" mcp get outpost >/dev/null 2>&1; then",
    "echo OUTPOST_REPLACED=1",
    "\"$cli\" mcp remove outpost >/dev/null 2>&1 || true",
    "else",
    "echo OUTPOST_REPLACED=0",
    "fi",
    `"$cli" mcp add outpost --url ${shQuote(url)} --bearer-token-env-var OUTPOST_MCP_TOKEN >/dev/null || exit 1`,
]);

const setupCommand = ({ agentType, cliPath, url, key }) => (cliName(agentType) === "claude"
    ? claudeSetupCommand({ cliPath, url, key })
    : `${codexSetupCommand({ cliPath, url })} && ${codexEnvCommand({ key })}`);

const probeCommand = ({ url, key }) => asCommand([
    "f=$(mktemp) || exit 1",
    "trap 'rm -f \"$f\"' EXIT",
    "if command -v curl >/dev/null 2>&1; then",
    `printf '%s\\n' ${shQuote(`Authorization: Bearer ${key}`)} > "$f" || exit 1`,
    `curl -fsS --max-time 10 -H @"$f" ${shQuote(url)}`,
    "elif command -v wget >/dev/null 2>&1; then",
    `printf '%s\\n' ${shQuote(`header = Authorization: Bearer ${key}`)} > "$f" || exit 1`,
    `wget -qO- -T 10 -t 1 --config="$f" ${shQuote(url)}`,
    "else",
    "exit 127",
    "fi",
]);

// Sets $state to MATCH (the registration carries keyPrefix) or OTHER (another key); anything else means none.
const registrationStateLines = (agentType, keyPrefix) => {
    if (!KEY_PREFIX.test(keyPrefix)) throw new TypeError("Invalid key prefix");
    if (cliName(agentType) === "claude") return [
        "f=\"$HOME/.claude.json\"",
        `state=$([ -f "$f" ] && awk -v p=${shQuote(`Bearer ${keyPrefix}`)} ${shQuote(CLAUDE_REGISTRATION_AWK)} "$f")`,
    ];
    return [
        `f="${CODEX_ENV}"`,
        "state=ABSENT",
        `if [ -f "$f" ]; then state=OTHER; grep -Eq ${shQuote(`^export OUTPOST_MCP_TOKEN='?${keyPrefix}`)} "$f" && state=MATCH; fi`,
    ];
};

const registrationCheckCommand = ({ agentType, keyPrefix }) => asCommand([
    ...registrationStateLines(agentType, keyPrefix),
    "case \"$state\" in MATCH|OTHER) echo \"$state\" ;; *) echo ABSENT ;; esac",
]);

const revokeCommands = ({ agentType, keyPrefix }) => asCommand([
    ...registrationStateLines(agentType, keyPrefix),
    "case \"$state\" in",
    "MATCH) ;;",
    "OTHER) echo FOREIGN; exit 0 ;;",
    "*) echo ABSENT; exit 0 ;;",
    "esac",
    `cli=$( ${findCliScript(agentType)} ) || exit 3`,
    ...(agentType === "claude"
        ? ["\"$cli\" mcp remove --scope user outpost >/dev/null 2>&1 || exit 4"]
        : ["\"$cli\" mcp remove outpost >/dev/null 2>&1 || exit 4", "rm -f \"$f\""]),
    "echo REMOVED",
]);

module.exports = {
    shQuote,
    findCliScript,
    findCliCommand,
    claudeSetupCommand,
    codexEnvCommand,
    codexSetupCommand,
    setupCommand,
    probeCommand,
    registrationCheckCommand,
    revokeCommands,
};
```

- [ ] **Step 4: Test laufen lassen, Erfolg prüfen**

Run: `cd /root/outpost && node --test server/lib/vault/__tests__/provision.test.js`
Expected: PASS — `# pass 5`, `# fail 0`.

- [ ] **Step 5: `execCommand` reicht `engineId` weiter**

`server/controllers/execCommand.js` Z. 8, vorher:

```js
const execCommand = async (accountId, entryId, identityId, command) => {
```

nachher:

```js
const execCommand = async (accountId, entryId, identityId, command, { engineId = null } = {}) => {
```

Z. 48, vorher:

```js
    const execResult = await controlPlane.execCommand(host, port, params, command, jumpHosts);
```

nachher:

```js
    const execResult = await controlPlane.execCommand(host, port, params, command, jumpHosts, engineId);
```

Die bestehende Route `POST /api/connections/:entryId/exec` (`server/routes/serverSession.js:323`) bleibt unverändert und übergibt weiter keine Engine.

- [ ] **Step 6: Joi-Schemas anlegen**

`server/validations/vaultAgentKeys.js`:

```js
const net = require("node:net");
const Joi = require("joi");

const cidr = Joi.string().trim().max(64).custom((value, helpers) => {
    const [address, bits, ...rest] = value.split("/");
    const family = net.isIP(address);
    const max = family === 6 ? 128 : 32;
    if (!family || rest.length > 0) return helpers.error("any.invalid");
    if (bits === undefined) return `${address}/${max}`;
    if (!/^\d{1,3}$/.test(bits) || Number(bits) > max) return helpers.error("any.invalid");
    return `${address}/${Number(bits)}`;
}).messages({ "any.invalid": "{{#label}} must be an IP address or a CIDR range" });

module.exports.createAgentKeysValidation = Joi.object({
    entryId: Joi.number().integer().positive().required(),
    agentTypes: Joi.array().items(Joi.string().valid("claude", "codex")).min(1).unique().required(),
    ipBinding: Joi.boolean().default(true),
    allowedCidrs: Joi.array().items(cidr).max(16).unique().default([]),
});

module.exports.confirmAgentKeyValidation = Joi.object({
    addSeenIp: Joi.boolean().default(false),
});

module.exports.listAgentKeysValidation = Joi.object({
    entryId: Joi.number().integer().positive(),
});

module.exports.agentKeyIdValidation = Joi.object({
    id: Joi.number().integer().positive().required(),
});
```

- [ ] **Step 7: Failing Routentest schreiben**

`server/lib/vault/__tests__/agentKeysRoute.test.js`:

```js
process.env.VAULT_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

const test = require("node:test");
const assert = require("node:assert");
const express = require("express");
const { Sequelize } = require("sequelize");

// Foreign keys off: the fixtures create api_keys rows without the accounts/entries graph behind them.
const db = new Sequelize({ dialect: "sqlite", storage: ":memory:", logging: false, query: { raw: true }, foreignKeys: false });
const fake = (path, exports) => {
    const resolved = require.resolve(path);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

const ENTRY_ID = 5;
const ACCOUNT_A = 1;
const ACCOUNT_B = 2;
const audits = [];
const execs = [];
const SERVER_IP = "198.51.100.7";
const RESET = { cliFound: true, setupFails: false, registered: "ABSENT", revokeOutput: "REMOVED\n", probeFrom: SERVER_IP };
const state = { base: null, identityOf: {}, ...RESET };

fake("../../../utils/database", db);
fake("../../../controllers/audit", {
    createAuditLog: async (entry) => { audits.push(entry); },
    AUDIT_ACTIONS: {
        VAULT_AGENT_KEY_CREATE: "vault.agent_key_create",
        VAULT_AGENT_KEY_REVOKE: "vault.agent_key_revoke",
        VAULT_AGENT_IP_DENIED: "vault.agent_ip_denied",
    },
    RESOURCE_TYPES: { VAULT: "vault" },
});
fake("../../../permissions/engine", {
    getSystemPermissions: async () => ({ isAdmin: false, permissions: ["vault.use"] }),
    getOrganizationPermissions: async () => ({ isOwner: false, isAdmin: false, permissions: [] }),
});
fake("../../../controllers/entry", {
    validateEntryAccess: async (accountId, entry) => ([ACCOUNT_A, ACCOUNT_B].includes(accountId)
        ? { valid: true, entry } : { code: 403, message: "no" }),
    resolveEntryScope: async (entry) => ({ organizationId: entry.organizationId ?? null, ownerAccountId: entry.accountId }),
});
fake("../../../controllers/identity", { getIdentityCredentials: async () => ({ password: "pw" }) });
fake("../../ConnectionService", {
    buildSSHParams: (identity) => ({ username: identity.username }),
    resolveJumpHosts: async () => [],
});
fake("../../../utils/identityResolver", {
    resolveIdentity: async (entry, identityId, direct, accountId) => {
        const id = identityId ?? state.identityOf[accountId];
        return (id && (await Identity.findByPk(id))) || { identity: null, requiresIdentity: true };
    },
});
// Plays the remote server: the probe really calls Outpost back with the key from the command line,
// through a proxy that reports probeFrom (null: the probe arrives from the browser's own address).
fake("../../controlPlane/ControlPlaneServer", {
    hasEngine: () => true,
    execCommand: async (host, port, params, command, jumpHosts, engineId) => {
        execs.push({ host, username: params.username, command, engineId });
        const ok = (stdout) => ({ success: true, stdout, stderr: "", exitCode: 0 });
        if (command.includes("/api/vault/agent-keys/probe")) {
            const [token] = /outpost_[0-9a-f]{64}/.exec(command);
            const res = await fetch(`${state.base}/api/vault/agent-keys/probe`, {
                headers: { authorization: `Bearer ${token}`, ...(state.probeFrom ? { "x-forwarded-for": state.probeFrom } : {}) },
            });
            return { success: true, stdout: await res.text(), stderr: "", exitCode: res.ok ? 0 : 22 };
        }
        if (command.includes("mcp add")) {
            if (state.setupFails) throw new Error("exec timed out");
            return ok("OUTPOST_REPLACED=1\n");
        }
        if (command.includes("echo FOREIGN")) return ok(state.revokeOutput);
        if (command.includes("MATCH|OTHER")) return ok(`${state.registered}\n`);
        if (command.includes("command -v")) return state.cliFound ? ok("/home/deploy/.local/bin/claude\n") : { success: true, stdout: "", stderr: "", exitCode: 1 };
        throw new Error(`unexpected command ${command}`);
    },
});

const ApiKey = require("../../../models/ApiKey");
const Account = require("../../../models/Account");
const Session = require("../../../models/Session");
const Entry = require("../../../models/Entry");
const Identity = require("../../../models/Identity");
const VaultSettings = require("../../../models/VaultSettings");
const { createApiKey } = require("../../../controllers/apiKey");
const { initVaultState } = require("../state");
const { authenticate } = require("../../../middlewares/auth");
const { sweepPending } = require("../../../controllers/agentKeys");
const router = require("../../../routes/vault/agentKeys");

const tokens = {};

test.before(async () => {
    await db.sync();
    await initVaultState();
    await (await VaultSettings.getOrCreate()).update({ agentUrl: "https://outpost.example/" });
    for (const id of [ACCOUNT_A, ACCOUNT_B])
        await Account.create({ id, firstName: "F", lastName: "L", username: `user${id}`, password: "x" });
    await Entry.create({ id: ENTRY_ID, accountId: ACCOUNT_A, type: "server", name: "web01", config: { protocol: "ssh", ip: "192.0.2.10", engineId: "engine-7" } });
    for (const [id, accountId] of [[11, ACCOUNT_A], [12, ACCOUNT_B]]) {
        await Identity.create({ id, accountId, name: `deploy-${accountId}`, type: "password", username: "deploy" });
        state.identityOf[accountId] = id;
    }
    tokens.a = (await Session.create({ accountId: ACCOUNT_A, ip: "x", userAgent: "t" })).token;
    tokens.b = (await Session.create({ accountId: ACCOUNT_B, ip: "x", userAgent: "t" })).token;
    tokens.impersonated = (await Session.create({ accountId: ACCOUNT_A, ip: "x", userAgent: "t", impersonatorId: ACCOUNT_B })).token;
    tokens.accountKey = (await createApiKey(ACCOUNT_A, { name: "ci" })).token;
});

test.beforeEach(async () => {
    execs.length = 0;
    audits.length = 0;
    Object.assign(state, RESET);
    await ApiKey.destroy({ where: { kind: "agent" } });
});

const listen = async (t) => {
    const app = express();
    app.set("trust proxy", "loopback");
    app.use(express.json());
    app.use("/api/vault", router);
    app.post("/api/mcp", authenticate, (req, res) => res.json({ keyId: req.agent?.keyId ?? null }));
    const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    state.base = `http://127.0.0.1:${server.address().port}`;
    t.after(() => { server.closeAllConnections(); server.close(); });
};

const call = async (method, path, token, body, headers = {}) => {
    const res = await fetch(`${state.base}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
};

const setUp = async (token = tokens.a, body = {}) => call("POST", "/api/vault/agent-keys", token, { entryId: ENTRY_ID, agentTypes: ["claude"], ...body });
const keyFrom = (command) => /outpost_[0-9a-f]{64}/.exec(command)[0];
const PROBE = "/api/vault/agent-keys/probe";

test("Review Focus 3: probe misst die Adresse des pending-Keys, confirm übernimmt sie einmal, danach gilt der Key", async (t) => {
    await listen(t);

    const { status, body } = await setUp();

    assert.strictEqual(status, 201);
    const [result] = body.results;
    assert.deepStrictEqual(
        { agentType: result.agentType, status: result.status, reason: result.reason, remoteUser: result.remoteUser, probe: result.probe, replacedRegistration: result.replacedRegistration, command: result.command },
        { agentType: "claude", status: "configured", reason: null, remoteUser: "deploy", probe: { seenIp: SERVER_IP, matches: false }, replacedRegistration: true, command: undefined },
    );
    assert.ok(execs.every((exec) => exec.engineId === "engine-7" && exec.host === "192.0.2.10" && exec.username === "deploy"));
    const key = keyFrom(execs[0].command);

    assert.strictEqual((await call("GET", PROBE, key)).status, 403);
    assert.strictEqual((await call("GET", PROBE, tokens.a)).status, 403);
    assert.strictEqual((await call("GET", PROBE, tokens.accountKey)).status, 403);

    const fromServer = { "x-forwarded-for": SERVER_IP };
    assert.strictEqual((await call("POST", "/api/mcp", key, undefined, fromServer)).status, 403);
    assert.deepStrictEqual((await call("POST", `/api/vault/agent-keys/${result.id}/confirm`, tokens.a, { addSeenIp: true })).body, { success: true });
    assert.deepStrictEqual(await call("POST", "/api/mcp", key, undefined, fromServer), { status: 200, body: { keyId: result.id } });
    assert.strictEqual((await call("POST", `/api/vault/agent-keys/${result.id}/confirm`, tokens.a, { addSeenIp: true })).status, 409);
    assert.deepStrictEqual((await ApiKey.findByPk(result.id)).allowedCidrs, [`${SERVER_IP}/32`]);
});

test("nach 15 Minuten lässt sich die gemessene Adresse nicht mehr übernehmen und ein pending-Key nicht mehr bestätigen", async (t) => {
    await listen(t);
    const [{ id }] = (await setUp()).body.results;
    state.cliFound = false;
    const [pending] = (await setUp()).body.results;
    await db.query("UPDATE api_keys SET createdAt = :at WHERE id IN (:ids)",
        { replacements: { at: new Date(Date.now() - 16 * 60 * 1000).toISOString(), ids: [id, pending.id] } });

    assert.strictEqual((await call("POST", `/api/vault/agent-keys/${id}/confirm`, tokens.a, { addSeenIp: true })).status, 409);
    assert.strictEqual((await ApiKey.findByPk(id)).allowedCidrs, null);
    assert.strictEqual((await call("POST", `/api/vault/agent-keys/${pending.id}/confirm`, tokens.a, {})).status, 410);
    assert.strictEqual((await ApiKey.findByPk(pending.id)).pending, true);
});

test("scheitert die Einrichtung, kommt der Befehl zum Kopieren und der Key bleibt pending bis zur Bestätigung, außer die Registrierung steht trotz Exec-Fehler", async (t) => {
    await listen(t);
    state.cliFound = false;

    const [result] = (await setUp()).body.results;

    assert.deepStrictEqual([result.status, result.reason], ["manual", "cli_missing"]);
    const key = keyFrom(result.command);
    assert.match(result.command, /mcp add --scope user --transport http outpost/);
    assert.deepStrictEqual((await call("GET", `/api/vault/agent-keys?entryId=${ENTRY_ID}`, tokens.a)).body.keys, []);
    assert.strictEqual((await call("POST", "/api/mcp", key)).status, 401);

    assert.deepStrictEqual((await call("POST", `/api/vault/agent-keys/${result.id}/confirm`, tokens.a, {})).body, { success: true });
    assert.deepStrictEqual((await call("GET", `/api/vault/agent-keys?entryId=${ENTRY_ID}`, tokens.a)).body.keys.map((k) => k.id), [result.id]);

    Object.assign(state, { cliFound: true, setupFails: true, registered: "MATCH" });
    const [recovered] = (await setUp()).body.results;
    assert.deepStrictEqual([recovered.status, recovered.reason, recovered.command], ["configured", null, undefined]);
    assert.match(execs.at(-1).command, /MATCH\|OTHER/);
    state.registered = "OTHER";
    const [failed] = (await setUp()).body.results;
    assert.deepStrictEqual([failed.status, failed.reason, (await ApiKey.findByPk(failed.id)).pending], ["manual", "exec_failed", true]);
});

test("sweepPending löscht nur pending-Keys, die älter als 15 Minuten sind", async (t) => {
    await listen(t);
    const [configured] = (await setUp()).body.results;
    state.cliFound = false;
    const [pending] = (await setUp()).body.results;

    assert.strictEqual(await sweepPending(Date.now() + 14 * 60 * 1000), 0);
    assert.strictEqual(await sweepPending(Date.now() + 16 * 60 * 1000), 1);
    assert.strictEqual(await ApiKey.findByPk(pending.id), null);
    assert.ok(await ApiKey.findByPk(configured.id));
});

test("erneutes Einrichten ersetzt den eigenen alten Key ohne Entfernbefehle, eine gleichzeitige Einrichtung bekommt 409, ein anderes Konto sieht die Warnung", async (t) => {
    await listen(t);
    const [first] = (await setUp()).body.results;
    const [second] = (await setUp()).body.results;

    assert.strictEqual(await ApiKey.findByPk(first.id), null);
    assert.ok(!execs.some((exec) => exec.command.includes("echo FOREIGN")));
    const revokes = audits.filter((audit) => audit.action === "vault.agent_key_revoke");
    assert.deepStrictEqual(revokes.map((audit) => [audit.details.keyId, audit.details.registration]), [[first.id, "replaced"]]);
    const own = (await call("GET", `/api/vault/agent-keys?entryId=${ENTRY_ID}`, tokens.a)).body;
    assert.deepStrictEqual([own.keys.map((k) => k.id), own.remoteUser, own.otherAccountConfigured], [[second.id], "deploy", false]);
    const other = (await call("GET", `/api/vault/agent-keys?entryId=${ENTRY_ID}`, tokens.b)).body;
    assert.deepStrictEqual(other, { keys: [], remoteUser: "deploy", otherAccountConfigured: true });

    const parallel = await Promise.all([setUp(), setUp()]);
    assert.deepStrictEqual(parallel.map((res) => res.status).sort(), [201, 409]);
});

test("Spec-Test 11: Einrichten, Bestätigen und Entziehen antworten in Impersonation und mit Konto-Key mit 403", async (t) => {
    await listen(t);
    const [{ id }] = (await setUp()).body.results;
    execs.length = 0;

    for (const token of [tokens.impersonated, tokens.accountKey]) {
        assert.strictEqual((await setUp(token)).status, 403);
        assert.strictEqual((await call("POST", `/api/vault/agent-keys/${id}/confirm`, token, { addSeenIp: true })).status, 403);
        assert.strictEqual((await call("DELETE", `/api/vault/agent-keys/${id}`, token)).status, 403);
    }
    assert.strictEqual((await call("POST", `/api/vault/agent-keys/${id}/confirm`, tokens.b, {})).status, 404);
    assert.strictEqual((await call("DELETE", `/api/vault/agent-keys/${id}`, tokens.b)).status, 404);
    assert.deepStrictEqual(execs, []);
    assert.strictEqual(await ApiKey.count({ where: { kind: "agent" } }), 1);
});

test("zusätzliche Adressbereiche werden geprüft und eine einzelne Adresse wird zu /32 bzw. /128", async (t) => {
    await listen(t);

    for (const allowedCidrs of [["10.0.0.0/33"], ["web01"], ["10.0.0.1/8/1"]])
        assert.strictEqual((await setUp(tokens.a, { allowedCidrs })).status, 400, JSON.stringify(allowedCidrs));
    const [{ id }] = (await setUp(tokens.a, { allowedCidrs: ["10.1.2.3", "2001:db8::/32"] })).body.results;

    assert.deepStrictEqual((await ApiKey.findByPk(id)).allowedCidrs, ["10.1.2.3/32", "2001:db8::/32"]);
});

// Account B: the per-account limiter of account A (30 per minute) spans the whole file.
test("die Probe zählt nur die erste Messung, und die Adresse des bestätigenden Browsers lässt sich nicht übernehmen", async (t) => {
    await listen(t);
    state.cliFound = false;
    state.probeFrom = null;
    const [result] = (await setUp(tokens.b)).body.results;
    const confirmPath = `/api/vault/agent-keys/${result.id}/confirm`;

    assert.deepStrictEqual(result.probe, { seenIp: "127.0.0.1", matches: false });
    const again = await call("GET", PROBE, keyFrom(result.command), undefined, { "x-forwarded-for": "203.0.113.9" });
    assert.deepStrictEqual(again, { status: 200, body: { seenIp: "203.0.113.9" } });
    assert.strictEqual((await ApiKey.findByPk(result.id)).seenIp, "127.0.0.1");

    assert.deepStrictEqual((await call("POST", confirmPath, tokens.b, { addSeenIp: true })).body, {
        code: 409, message: "The measured address is the address of your browser; Outpost sees a proxy, not the server",
    });
    assert.deepStrictEqual((await call("POST", confirmPath, tokens.b, {})).body, { success: true });
    assert.deepStrictEqual((await ApiKey.findByPk(result.id)).allowedCidrs, null);
});

test("Entziehen läuft mit der gespeicherten Identität; ist sie gelöscht, kommt der Entfernbefehl zum Kopieren", async (t) => {
    await listen(t);
    const [first] = (await setUp()).body.results;
    state.revokeOutput = "FOREIGN\n";
    execs.length = 0;

    assert.deepStrictEqual((await call("DELETE", `/api/vault/agent-keys/${first.id}`, tokens.a)).body, { success: true, registration: "foreign" });
    assert.deepStrictEqual(execs.map((exec) => [exec.username, exec.engineId]), [["deploy", "engine-7"]]);
    assert.strictEqual(await ApiKey.findByPk(first.id), null);
    assert.deepStrictEqual([audits.at(-1).action, audits.at(-1).resourceId, audits.at(-1).details.keyId], ["vault.agent_key_revoke", null, first.id]);

    const [second] = (await setUp()).body.results;
    t.after(() => Identity.create({ id: 11, accountId: ACCOUNT_A, name: "deploy-1", type: "password", username: "deploy" }));
    await Identity.destroy({ where: { id: 11 } });
    execs.length = 0;
    const revoked = (await call("DELETE", `/api/vault/agent-keys/${second.id}`, tokens.a)).body;

    assert.deepStrictEqual([revoked.registration, execs.length], ["unknown", 0]);
    assert.match(revoked.commands, /mcp remove --scope user outpost/);
    assert.strictEqual(await ApiKey.findByPk(second.id), null);
});
```

- [ ] **Step 8: Test laufen lassen, Fehlschlag prüfen**

Run: `cd /root/outpost && node --test server/lib/vault/__tests__/agentKeysRoute.test.js`
Expected: FAIL — `Cannot find module '../../../controllers/agentKeys'`.

- [ ] **Step 9: Controller `server/controllers/agentKeys.js` anlegen**

`ApiKey`-Abfragen laufen mit dem globalen `raw: true`; der `afterFind`-Hook aus Task 1 liefert `allowedCidrs` als Array und die Flags als Boolean. `cidrsOf` fängt nur `null` und einen Text ab, der kein JSON war. `setupsInFlight` liegt wie die offenen Freigaben aus Task 6 nur im Speicher des Prozesses.

```js
const net = require("node:net");
const { Op } = require("sequelize");
const ApiKey = require("../models/ApiKey");
const Entry = require("../models/Entry");
const Identity = require("../models/Identity");
const VaultSettings = require("../models/VaultSettings");
const { generateToken, hashToken, TOKEN_PREFIX } = require("./apiKey");
const { execCommand } = require("./execCommand");
const { validateEntryAccess, resolveEntryScope } = require("./entry");
const { createAuditLog, AUDIT_ACTIONS, RESOURCE_TYPES } = require("./audit");
const { resolveIdentity } = require("../utils/identityResolver");
const { normalizeIp } = require("../utils/ip");
const { canUseVault } = require("../lib/vault/visibility");
const { isAddressAllowed } = require("../lib/vault/ipBinding");
const provision = require("../lib/vault/provision");
const logger = require("../utils/logger");

const PENDING_TTL_MS = 15 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
const REGISTRATION_MARKERS = new Set(["REMOVED", "FOREIGN", "ABSENT"]);
const GONE = { code: 410, message: "This setup has expired. Set up agent access again." };
const setupsInFlight = new Set();

const identityOf = (result) => (result?.identity === undefined ? result : result.identity);
const keyPrefixOf = (key) => key.prefix.replace(/…$/, "");
const hostCidr = (ip) => `${ip}/${net.isIP(ip) === 6 ? 128 : 32}`;
const endpoint = (agentUrl, path) => `${agentUrl.replace(/\/+$/, "")}${path}`;
const outputLines = (stdout) => String(stdout ?? "").split(/\r?\n/).map((line) => line.trim());
const cidrsOf = (value) => (Array.isArray(value) ? value : []);
const expired = (key, now) => now - new Date(key.createdAt).getTime() > PENDING_TTL_MS;

const serialize = (key, entryNames) => ({
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    agentType: key.agentType,
    pending: key.pending,
    entryId: key.entryId,
    entryName: entryNames.get(key.entryId) ?? null,
    remoteUser: key.remoteUser,
    ipBinding: key.ipBinding,
    allowedCidrs: cidrsOf(key.allowedCidrs),
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt,
});

const findEntry = async (accountId, entryId) => {
    const entry = await Entry.findByPk(entryId);
    if (!entry || !(await validateEntryAccess(accountId, entry)).valid) return null;
    return entry;
};

const remoteIdentity = async (entry, accountId) => identityOf(await resolveIdentity(entry, null, null, accountId)) || null;

// Never log stdout or stderr: the setup commands echo the key back on some CLIs.
const runRemote = async (accountId, entry, identityId, command) => {
    try {
        const result = await execCommand(accountId, entry.id, identityId, command, { engineId: entry.config?.engineId ?? null });
        if (result?.code || !result.success) return { ran: false, exitCode: null, stdout: "" };
        return { ran: true, exitCode: result.exitCode, stdout: result.stdout };
    } catch (err) {
        logger.warn("Agent key command could not run", { entryId: entry.id, error: err.message });
        return { ran: false, exitCode: null, stdout: "" };
    }
};

const probeResult = async (keyId, entry) => {
    const key = await ApiKey.findByPk(keyId);
    if (!key?.seenIp) return null;
    return { seenIp: key.seenIp, matches: await isAddressAllowed(key, entry, key.seenIp) };
};

const auditRevoke = async (key, entry, registration, { ipAddress = null, userAgent = null } = {}) => createAuditLog({
    accountId: key.accountId, organizationId: entry ? (await resolveEntryScope(entry)).organizationId ?? null : null,
    action: AUDIT_ACTIONS.VAULT_AGENT_KEY_REVOKE, resource: RESOURCE_TYPES.VAULT, resourceId: null,
    details: {
        keyId: key.id, agentType: key.agentType, entryId: key.entryId, entryName: entry?.name ?? null,
        remoteUser: key.remoteUser, registration, pending: key.pending,
    },
    ipAddress, userAgent,
});

const finalize = async (key, entry, context) => {
    const [updated] = await ApiKey.update({ pending: false }, { where: { id: key.id, pending: true } });
    if (!updated) return false;
    const replaced = await ApiKey.findAll({
        where: {
            accountId: key.accountId, kind: "agent", pending: false, entryId: key.entryId,
            agentType: key.agentType, remoteUser: key.remoteUser, id: { [Op.ne]: key.id },
        },
    });
    if (replaced.length > 0) {
        await ApiKey.destroy({ where: { id: replaced.map((old) => old.id) } });
        await Promise.all(replaced.map((old) => auditRevoke(old, entry, "replaced", context)));
    }
    return true;
};

const setupAgent = async ({ accountId, entry, identity, agentUrl, key, token }) => {
    const url = endpoint(agentUrl, "/api/mcp");
    const manual = (reason, probe = null, replacedRegistration = false) => ({
        status: "manual", reason, probe, replacedRegistration,
        command: provision.setupCommand({ agentType: key.agentType, cliPath: key.agentType, url, key: token }),
    });
    if (!identity) return manual("exec_failed");

    const run = (command) => runRemote(accountId, entry, identity.id, command);
    await run(provision.probeCommand({ url: endpoint(agentUrl, "/api/vault/agent-keys/probe"), key: token }));
    const probe = await probeResult(key.id, entry);

    const found = await run(provision.findCliCommand(key.agentType));
    if (!found.ran) return manual("exec_failed", probe);
    const cliPath = found.exitCode === 0 ? outputLines(found.stdout).filter((line) => line.startsWith("/")).pop() : null;
    if (!cliPath) return manual("cli_missing", probe);

    const setup = await run(provision.setupCommand({ agentType: key.agentType, cliPath, url, key: token }));
    const replacedRegistration = outputLines(setup.stdout).includes("OUTPOST_REPLACED=1");
    const configured = { status: "configured", reason: null, probe, replacedRegistration };
    if (setup.ran && setup.exitCode === 0) return configured;
    if (!setup.ran) {
        // An exec error or timeout says nothing about the remote side: the setup may have gone through.
        const check = await run(provision.registrationCheckCommand({ agentType: key.agentType, keyPrefix: keyPrefixOf(key) }));
        if (check.ran && outputLines(check.stdout).includes("MATCH")) return configured;
    }
    return manual("exec_failed", probe, replacedRegistration);
};

const setupOne = async ({ accountId, entry, identity, organizationId, agentUrl, agentType, ipBinding, allowedCidrs, context }) => {
    const token = generateToken();
    const remoteUser = identity?.username || null;
    const key = await ApiKey.create({
        accountId, name: `${agentType}@${entry.name}`, tokenHash: hashToken(token),
        prefix: `${token.slice(0, TOKEN_PREFIX.length + 6)}…`, kind: "agent", pending: true,
        entryId: entry.id, agentType, ipBinding, allowedCidrs: allowedCidrs.length > 0 ? allowedCidrs : null,
        identityId: identity?.id ?? null, remoteUser,
    });
    await createAuditLog({
        accountId, organizationId, action: AUDIT_ACTIONS.VAULT_AGENT_KEY_CREATE,
        resource: RESOURCE_TYPES.VAULT, resourceId: null,
        details: { keyId: key.id, agentType, entryId: entry.id, entryName: entry.name, remoteUser, ipBinding },
        ...context,
    });

    const outcome = await setupAgent({ accountId, entry, identity, agentUrl, key, token });
    if (outcome.status === "configured") await finalize(key, entry, context);
    return { id: key.id, agentType, remoteUser, ...outcome };
};

const createAgentKeys = async ({ accountId, entryId, agentTypes, ipBinding = true, allowedCidrs = [], ipAddress = null, userAgent = null }) => {
    const { agentUrl } = await VaultSettings.getOrCreate();
    if (!agentUrl) return { code: 409, message: "Set the Outpost address for agents in Settings › Vault first" };
    if (!(await canUseVault(accountId))) return { code: 403, message: "You are not allowed to set up agent access" };

    const entry = await findEntry(accountId, entryId);
    if (!entry) return { code: 404, message: "Entry not found" };
    if (entry.config?.protocol !== "ssh") return { code: 400, message: "Agent access needs an SSH server" };
    if (setupsInFlight.has(entry.id)) return { code: 409, message: "Agent access for this server is already being set up" };

    setupsInFlight.add(entry.id);
    try {
        const identity = await remoteIdentity(entry, accountId);
        const organizationId = (await resolveEntryScope(entry)).organizationId ?? null;
        const shared = { accountId, entry, identity, organizationId, agentUrl, ipBinding, allowedCidrs, context: { ipAddress, userAgent } };
        return { results: await Promise.all(agentTypes.map((agentType) => setupOne({ ...shared, agentType }))) };
    } finally {
        setupsInFlight.delete(entry.id);
    }
};

const probe = async (apiKey, rawIp) => {
    const seenIp = normalizeIp(rawIp);
    await ApiKey.update({ seenIp }, { where: { id: apiKey.id, kind: "agent", pending: true, seenIp: null } });
    return { seenIp };
};

const confirm = async (accountId, id, { addSeenIp = false } = {}, { ipAddress = null, userAgent = null } = {}, now = Date.now()) => {
    const key = await ApiKey.findOne({ where: { id, accountId, kind: "agent" } });
    if (!key) return { code: 404, message: "Agent key not found" };
    if (key.pending && expired(key, now)) return GONE;

    if (addSeenIp) {
        if (!key.seenIp) return { code: 409, message: "No measured address to adopt" };
        if (normalizeIp(ipAddress) === key.seenIp)
            return { code: 409, message: "The measured address is the address of your browser; Outpost sees a proxy, not the server" };
        if (expired(key, now)) return { code: 409, message: "The measured address can only be adopted within 15 minutes of the setup" };
        const allowedCidrs = [...new Set([...cidrsOf(key.allowedCidrs), hostCidr(key.seenIp)])];
        const [updated] = await ApiKey.update({ allowedCidrs, seenIpAdopted: true }, { where: { id: key.id, seenIpAdopted: false } });
        if (!updated) return (await ApiKey.count({ where: { id: key.id } })) > 0
            ? { code: 409, message: "The measured address was already adopted" } : GONE;
    }

    if (key.pending && !(await finalize(key, await Entry.findByPk(key.entryId), { ipAddress, userAgent })))
        return (await ApiKey.count({ where: { id: key.id, pending: false } })) > 0 ? { success: true } : GONE;
    return { success: true };
};

const parseRegistration = (stdout) => {
    const marker = outputLines(stdout).filter((line) => REGISTRATION_MARKERS.has(line)).pop();
    return marker ? marker.toLowerCase() : "unknown";
};

const revoke = async (accountId, id, { ipAddress = null, userAgent = null } = {}) => {
    const key = await ApiKey.findOne({ where: { id, accountId, kind: "agent" } });
    if (!key) return { code: 404, message: "Agent key not found" };
    await ApiKey.destroy({ where: { id: key.id } });

    const entry = await Entry.findByPk(key.entryId);
    let registration = "absent";
    let commands = null;
    if (!key.pending) {
        const command = provision.revokeCommands({ agentType: key.agentType, keyPrefix: keyPrefixOf(key) });
        const identity = key.identityId ? await Identity.findByPk(key.identityId) : null;
        const result = entry && identity ? await runRemote(accountId, entry, identity.id, command) : { ran: false, stdout: "" };
        registration = result.ran ? parseRegistration(result.stdout) : "unknown";
        if (registration === "unknown") commands = command;
    }

    await auditRevoke(key, entry, registration, { ipAddress, userAgent });
    return commands ? { success: true, registration, commands } : { success: true, registration };
};

const listAgentKeys = async (accountId, { entryId = null } = {}) => {
    const entry = entryId ? await findEntry(accountId, entryId) : null;
    if (entryId && !entry) return { code: 404, message: "Entry not found" };

    const keys = await ApiKey.findAll({
        where: { accountId, kind: "agent", pending: false, ...(entry ? { entryId: entry.id } : {}) },
        order: [["createdAt", "DESC"]],
    });
    const entryIds = [...new Set(keys.map((key) => key.entryId))];
    const entries = entryIds.length > 0 ? await Entry.findAll({ where: { id: entryIds }, attributes: ["id", "name"] }) : [];
    const names = new Map(entries.map((row) => [row.id, row.name]));
    const result = { keys: keys.map((key) => serialize(key, names)) };
    if (!entry) return result;

    const remoteUser = (await remoteIdentity(entry, accountId))?.username || null;
    const otherAccountConfigured = !!remoteUser && (await ApiKey.count({
        where: { kind: "agent", pending: false, entryId: entry.id, remoteUser, accountId: { [Op.ne]: accountId } },
    })) > 0;
    return { ...result, remoteUser, otherAccountConfigured };
};

const sweepPending = async (now = Date.now()) => ApiKey.destroy({
    where: { kind: "agent", pending: true, createdAt: { [Op.lt]: new Date(now - PENDING_TTL_MS) } },
});

const startPendingSweeper = () => {
    const timer = setInterval(() => {
        sweepPending().catch((err) => logger.warn("Pending agent key sweep failed", { error: err.message }));
    }, SWEEP_INTERVAL_MS);
    timer.unref?.();
    return timer;
};

module.exports = { createAgentKeys, probe, confirm, revoke, listAgentKeys, sweepPending, startPendingSweeper, PENDING_TTL_MS };
```

- [ ] **Step 10: Router `server/routes/vault/agentKeys.js` füllen**

Ganze Datei ersetzen (der Platzhalter aus Task 1 enthält nur einen leeren `Router()`):

```js
const { Router } = require("express");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const { authenticate } = require("../../middlewares/auth");
const { requireLoginSession } = require("../../middlewares/requireLoginSession");
const { requireVaultEnabled } = require("../../lib/vault/state");
const { validateSchema } = require("../../utils/schema");
const { sendError } = require("../../utils/error");
const logger = require("../../utils/logger");
const {
    createAgentKeysValidation, confirmAgentKeyValidation, listAgentKeysValidation, agentKeyIdValidation,
} = require("../../validations/vaultAgentKeys");
const { createAgentKeys, probe, confirm, revoke, listAgentKeys } = require("../../controllers/agentKeys");

const app = Router();

// Every setup runs several remote commands through the engine; the account bucket bounds that.
const agentKeyLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    keyGenerator: (req) => (req.user ? `acc:${req.user.id}` : `ip:${ipKeyGenerator(req.ip)}`),
    message: { code: 429, message: "Too many agent key changes. Please try again in a moment." },
    standardHeaders: true,
    legacyHeaders: false,
});

const probeLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    keyGenerator: (req) => (req.apiKey ? `key:${req.apiKey.id}` : `ip:${ipKeyGenerator(req.ip)}`),
    message: { code: 429, message: "Too many probes. Please try again in a moment." },
    standardHeaders: true,
    legacyHeaders: false,
});

const reply = (res, result, status = 200) => {
    if (result?.code) return sendError(res, result.code, result.code, result.message);
    res.status(status).json(result);
};

const requestContext = (req) => ({ ipAddress: req.ip, userAgent: req.headers["user-agent"] ?? null });

/**
 * GET /vault/agent-keys/probe
 * @summary Probe Agent Key Address
 * @description Called by the setup itself, with the pending agent key, from the server being set up. Answers with the address Outpost sees; only the first measurement is stored at the key. Any other caller gets 403.
 * @tags Vault
 * @produces application/json
 * @security BearerAuth
 * @return {object} 200 - The seen address
 */
app.get("/agent-keys/probe", requireVaultEnabled, authenticate, probeLimiter, async (req, res) => {
    if (req.apiKey?.kind !== "agent" || !req.apiKey.pending)
        return sendError(res, 403, 403, "Only a pending agent key can probe");
    res.json(await probe(req.apiKey, req.ip));
});

/**
 * GET /vault/agent-keys
 * @summary List Agent Keys
 * @description Lists the confirmed agent keys of the account. With entryId only those of one server, plus the remote user and whether another account already set up a key for it.
 * @tags Vault
 * @produces application/json
 * @security BearerAuth
 * @param {number} entryId.query - Server entry ID
 * @return {object} 200 - Agent keys
 */
app.get("/agent-keys", requireVaultEnabled, authenticate, async (req, res) => {
    const query = { ...req.query };
    if (validateSchema(res, listAgentKeysValidation, query)) return;
    reply(res, await listAgentKeys(req.user.id, { entryId: query.entryId ?? null }));
});

/**
 * POST /vault/agent-keys
 * @summary Set Up Agent Access
 * @description Creates one pending agent key per agent and sets it up on the server. The key is returned only inside a manual command, only in this response.
 * @tags Vault
 * @produces application/json
 * @security BearerAuth
 * @param {CreateAgentKeys} request.body.required - Server, agents and IP binding
 * @return {object} 201 - Result per agent
 */
app.post("/agent-keys", requireVaultEnabled, authenticate, requireLoginSession, agentKeyLimiter, async (req, res) => {
    if (validateSchema(res, createAgentKeysValidation, req.body)) return;
    reply(res, await createAgentKeys({ accountId: req.user.id, ...req.body, ...requestContext(req) }), 201);
});

/**
 * POST /vault/agent-keys/{id}/confirm
 * @summary Confirm Agent Key
 * @description Makes a pending agent key final. With addSeenIp the address measured by the probe is added to the allowed ranges, once, only within 15 minutes of the setup and never when it is the address of the confirming browser. A pending key older than 15 minutes answers 410.
 * @tags Vault
 * @produces application/json
 * @security BearerAuth
 * @param {number} id.path.required - Agent key ID
 * @param {ConfirmAgentKey} request.body - Options
 * @return {object} 200 - Confirmation
 */
app.post("/agent-keys/:id/confirm", requireVaultEnabled, authenticate, requireLoginSession, agentKeyLimiter, async (req, res) => {
    const params = { ...req.params };
    if (validateSchema(res, agentKeyIdValidation, params)) return;
    const body = { ...(req.body ?? {}) };
    if (validateSchema(res, confirmAgentKeyValidation, body)) return;
    reply(res, await confirm(req.user.id, params.id, body, requestContext(req)));
});

/**
 * DELETE /vault/agent-keys/{id}
 * @summary Revoke Agent Key
 * @description Deletes the agent key, then removes the registration on the server if it still carries this key.
 * @tags Vault
 * @produces application/json
 * @security BearerAuth
 * @param {number} id.path.required - Agent key ID
 * @return {object} 200 - Revocation result
 */
app.delete("/agent-keys/:id", requireVaultEnabled, authenticate, requireLoginSession, agentKeyLimiter, async (req, res) => {
    const params = { ...req.params };
    if (validateSchema(res, agentKeyIdValidation, params)) return;
    reply(res, await revoke(req.user.id, params.id, requestContext(req)));
});

// Express 5 hands a rejected async handler to the error middleware, and server/index.js installs
// none - the built-in fallback answers with err.stack whenever NODE_ENV is not "production".
app.use((error, req, res, _next) => {
    logger.error("Agent key route failed", { path: req.originalUrl, error: error.message });
    sendError(res, 500, 500, "Could not complete the agent key request.");
});

module.exports = app;
```

- [ ] **Step 11: Test laufen lassen, Erfolg prüfen**

Run: `cd /root/outpost && node --test server/lib/vault/__tests__/agentKeysRoute.test.js server/lib/vault/__tests__/provision.test.js`
Expected: PASS — `# pass 14`, `# fail 0`.

- [ ] **Step 12: Sweeper beim Start einhängen**

In `server/index.js` neben dem Import, den Task 1 für `initVaultState` anlegt:

```js
const { startPendingSweeper } = require("./controllers/agentKeys");
```

und direkt nach dem `try`/`catch` um `await initVaultState();` (Task 1, nach `await migrationRunner.runMigrations();`), nicht in den `try`-Block: Ein Fehler beim Schlüsselstatus soll den Sweeper nicht verhindern. Nachher:

```js
        try {
            await initVaultState();
        } catch (err) {
            logger.error("Could not determine the vault key status; the vault stays off", { error: err.message });
        }
        startPendingSweeper();

        await ensureInternalProvider();
```

Der Sweeper läuft auch bei ausgeschaltetem Vault: `pending`-Keys aus der Zeit davor sollen trotzdem verschwinden.

- [ ] **Step 13: Lint und betroffene Tests**

Run: `cd /root/outpost && npx eslint server/lib/vault/provision.js server/lib/vault/__tests__/provision.test.js server/lib/vault/__tests__/agentKeysRoute.test.js server/controllers/agentKeys.js server/controllers/execCommand.js server/routes/vault/agentKeys.js server/validations/vaultAgentKeys.js server/index.js && node --test server/lib/vault/__tests__/provision.test.js server/lib/vault/__tests__/agentKeysRoute.test.js server/lib/vault/__tests__/agentAuth.test.js`
Expected: keine Lint-Meldung; alle Tests PASS (`agentAuth.test.js` aus Task 4 bleibt grün, weil `authenticate` nicht angefasst wurde).

- [ ] **Step 14: Commit**

```bash
git add server/lib/vault/provision.js server/lib/vault/__tests__/provision.test.js server/lib/vault/__tests__/agentKeysRoute.test.js server/controllers/agentKeys.js server/controllers/execCommand.js server/routes/vault/agentKeys.js server/validations/vaultAgentKeys.js server/index.js
git commit -m "Vault: Agenten-Einrichtung per Exec mit Probe, Bestätigung und Entziehen"
```

---

### Task 15: Client: Einstellungen Vault und Agenten-Schlüssel

**Files:**
- Modify: `client/src/pages/Settings/pages/Vault/Vault.jsx` (Platzhalter aus Task 10 vollständig ersetzen)
- Create: `client/src/pages/Settings/pages/Vault/styles.sass`
- Test: `client/src/pages/Settings/pages/Vault/__tests__/VaultSettings.test.jsx`
- Create: `client/src/pages/Settings/pages/Account/components/AgentKeysSection/AgentKeysSection.jsx`
- Create: `client/src/pages/Settings/pages/Account/components/AgentKeysSection/index.js`
- Create: `client/src/pages/Settings/pages/Account/components/AgentKeysSection/styles.sass`
- Modify: `client/src/pages/Settings/pages/Account/Account.jsx` (Import nach Z. 16, `data-ui-id` am API-Schlüssel-Abschnitt Z. 431, `<AgentKeysSection />` vor `<MicrosoftConnections />` Z. 475)

**Interfaces:**
- Consumes (Task 5, REST): `GET /api/vault/settings` → `{ keyStatus: "active"|"missing"|"mismatch", agentUrl: string|null, trustProxyUnsafe: boolean }`; `PATCH /api/vault/settings` body `{ agentUrl: string|null }` → dieselbe Form (`null` leert die Adresse; gemeldet, falls Task 5 nur Text annimmt). Beide antworten auch bei ausgeschaltetem Vault.
- Consumes (Task 8, REST): `GET /api/vault/agent-keys` → `{ keys: AgentKey[] }` mit `AgentKey = { id, entryId, agentType: "claude"|"codex", pending, ipBinding, allowedCidrs: string[], createdAt, lastUsedAt }` (Form wie in Task 14; ohne Bereiche `[]`, nie `null`); `DELETE /api/vault/agent-keys/:id` → `{ success, registration: "removed"|"foreign"|"absent"|"unknown", commands? }` (`commands` als Text nur bei `unknown`), `404`, wenn der Key schon entzogen ist.
- Consumes (Task 4): `GET /api/accounts/api-keys` liefert nur noch `kind = "account"` — der Client filtert nichts selbst, die Bestandsliste bleibt unverändert.
- Consumes (Task 10): Registrierung der Seite `vault` in `getSettingsAdminPages` mit `permission: Permission.SETTINGS_VAULT` und `index.js` (`export { Vault as default } from "./Vault.jsx";`) — dieser Task füllt nur `Vault.jsx`/`styles.sass`; `useVaultAvailable()` als **benannter** Export aus `@/common/hooks/useVaultAvailable.js` (genutzt: `enabled`, `impersonating`, `refresh()`); i18n-Schlüssel `settings.vault.*`, `settings.account.agentKeys.*`, `vault.agents.*`, `servers.agentAccess.result.copy` (Liste am Ende).
- Consumes (Task 14): `AgentAccessDialog` (Default-Export aus `@/pages/Servers/components/AgentAccessDialog`) mit `{ open, entryId, onClose }`; die Auswertung des Entziehen-Ergebnisses (`foreign`/`unknown`, `revoking`-Ref, `404` → Neuladen) folgt `AgentAccessDialog.jsx#revoke`. Dieser Task startet erst nach dem Merge von Task 14.
- Produces: `export const Vault` (Seite), `export const isValidAgentUrl(value) → boolean`; `export const AgentKeysSection` (Default über `index.js`).

**Design:**
- Screens: `UI-VAULT-SETTINGS` — Artboard `docs/design/mockups/ui-vault-settings.html` — Anleitung `docs/design/guides/ui-vault-settings.md`; `UI-API-KEYS` — Artboard `docs/design/mockups/ui-api-keys.html` — Anleitung `docs/design/guides/ui-api-keys.md`
- Zu bauende Elemente (Werte wörtlich übernehmen):

| ID | Element | Fachlicher Anker | Zustände | Copy |
|----|---------|------------------|----------|------|
| UI-VAULT-SETTINGS-KEY | Vault-Schlüssel | Ob der Vault läuft — Schlüssel aktiv, fehlt (Vault aus) oder passt nicht zu den gespeicherten Daten (Vault aus). Bei fehlendem Schlüssel ein Satz, wie man VAULT_KEY setzt. Nicht: encryption_key, api_key. | default, disabled, error | default „Aktiv“ · disabled „Fehlt — VAULT_KEY fehlt — der Vault ist aus. Schlüssel als Umgebungsvariable oder Docker-Secret vault_key setzen.“ · error „Passt nicht — VAULT_KEY passt nicht zu den gespeicherten Einträgen — der Vault ist aus.“ |
| UI-VAULT-SETTINGS-URL | Outpost-Adresse für Agenten | Die Adresse, unter der Server Outpost erreichen; daraus entsteht die MCP-URL, die beim Einrichten eines Agenten eingetragen wird. Nicht: browser_launcher_url. | default, error | error „Keine gültige http- oder https-Adresse.“ |
| UI-VAULT-SETTINGS-PROXY | Hinweis Reverse-Proxy | Warnt, wenn Outpost jedem X-Forwarded-For glaubt (TRUST_PROXY=true) — dann ist die IP-Bindung von Agenten-Keys wirkungslos. Sonst nicht sichtbar. Nicht: vault_key_status, agent_base_url. | default, error | default „nicht sichtbar“ · error „TRUST_PROXY=true — Outpost glaubt jedem X-Forwarded-For, die IP-Bindung von Agenten-Keys ist wirkungslos. Hop-Zahl oder Adressliste setzen.“ |
| UI-VAULT-SETTINGS-SAVE | Einstellungen speichern | Speichert die Outpost-Adresse für Agenten, wie der Speichern-Knopf der Browser-Einstellungen. | default, disabled | – |
| UI-API-KEYS-LIST | API-Schlüssel | Die API-Keys des Kontos mit voller Kontoberechtigung — Name, Präfix, zuletzt genutzt, Ablauf; Anlegen und Löschen wie bisher. Nicht: agent_key. | default, empty | empty „Noch keine API-Schlüssel“ |
| UI-API-KEYS-AGENTS | Agenten-Schlüssel | Die Agenten-Keys des Kontos, gruppiert nach Server — Agent, zuletzt genutzt, IP-Bindung; je Server Bearbeiten (öffnet Agenten-Zugang) und je Key Entziehen. Agenten-Keys erreichen nur den MCP-Endpunkt. Nicht: api_key, vault_item. | default, empty, partial, disabled | empty „Noch kein Agenten-Zugang. Einrichten über das Kontextmenü eines Servers.“ · partial „Zugang entzogen. Die Registrierung auf web01 trägt den Key eines anderen Kontos und bleibt stehen.“ · disabled „Zugang entzogen. Die Registrierung konnte nicht entfernt werden — Befehl kopieren und auf dem Server ausführen.“ |

- Stand: `docs/design/manifest.yaml` Revision 14. AGENTS `partial` nach dem Entziehen bei `registration === "foreign"`, AGENTS `disabled` nach dem Entziehen bei `registration === "unknown"` (darunter `commands` in `<pre>` mit „Kopieren“); beide stehen über der Gruppenliste bis zum nächsten Entziehen.
- Locator: jedes Element trägt `data-ui-id="<ID>"`; zusätzlich `data-ui-id="UI-VAULT-SETTINGS"` am äußersten Wrapper der Seite. KEY und URL am Wrapper der Zeile, PROXY am Banner (nur gerendert bei `trustProxyUnsafe`), SAVE am `Button` (`dataUiId`), LIST am bestehenden `account-section`-Container, AGENTS am Wurzelknoten von `AgentKeysSection`.
- Tokens: `--success`/`--success-opacity` (Aktiv), `--warning`/`--warning-opacity` (Fehlt, Proxy-Hinweis, „von überall“, Entziehen-Ergebnis), `--error`/`--error-opacity` (Passt nicht, ungültige Adresse, Entziehen), `--subtext`, `--dark-gray` (Gruppenrahmen), `--space-1/2/3/4/8`, `--radius-sm/md`, `--type-heading/caption`. Im Code über `@/common/styles/colors` und `@/common/styles/tokens`. Seitenbreite höchstens 44 rem.
- Der Ordner heißt laut Vertrag `components/AgentKeysSection/`; die Anleitung `ui-api-keys.md` nennt `components/AgentKeys/` (gemeldet, Vertrag gilt).

**Tests:** 2 Tests (davon einer als `test.each` mit zwei Fällen) in `VaultSettings.test.jsx`, test-first (Zustände und Gültigkeitsregel stehen im Manifest und in Task 5): (1) `keyStatus` `missing` bzw. `mismatch` zeigt Pill und Satz aus dem Manifest; (2) eine Adresse ohne `http://`/`https://` zeigt den Fehler und sperrt Speichern, eine gültige wird per `PATCH vault/settings` gespeichert und `useVaultAvailable().refresh()` wird aufgerufen (damit der Agenten-Zugang-Dialog `agentUrlSet` sofort sieht). Echte Seams: `ToastProvider`, `en.json`. Gemockt: `RequestUtil` (requestDouble), `useVaultAvailable`. Nicht getestet: der Proxy-Hinweis (eine Bedingung auf `trustProxyUnsafe`), `AgentKeysSection` (Gruppierung ist Darstellung; das Entziehen-Ergebnis `partial`/`disabled` folgt derselben Auswertung, die Task 14 in Test 4 prüft; der Bestätigungsdialog ist Bestand), der `data-ui-id`-Zusatz an der Bestandsliste, die Rechtefilterung der Seite (Task 10, Bestand des `SettingsDialog`), Darstellung (prüft `/design-verify`). SEC: SEC-INPUT-01 (`agentUrl` nur http/https im Client, maßgeblich die Validierung aus Task 5), SEC-RBAC-01 (Seite nur mit `settings.vault`, Registrierung in Task 10; `PATCH` prüft der Server), SEC-SECRET-01 (die Seite zeigt nur den Status, nie `VAULT_KEY`; die Agenten-Liste zeigt kein Key-Präfix; nur der Entfernbefehl nach gescheitertem Entziehen trägt das Präfix des schon widerrufenen Keys, nie den Key), SEC-XSS-01 (nur React-Text; Entfernbefehl in `<pre>` als Text).

**Parallel:** Task 5, Task 6, Task 8 (Welle C; keine gemeinsamen Dateien). Nicht neben Task 14: `AgentKeysSection` importiert `AgentAccessDialog` und übernimmt dessen Entziehen-Auswertung, deshalb startet dieser Task erst nach dem Merge von Task 14 (Welle B). Setzt Task 10 (Welle A) voraus; die REST-Form aus Task 5 und Task 8 steht im Vertrag oben fest, die Tests laufen gegen `requestDouble`.

- [ ] **Step 1: Write the failing test**

`client/src/pages/Settings/pages/Vault/__tests__/VaultSettings.test.jsx`:

```jsx
import { beforeEach, expect, test, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import testI18n from "@/test/i18n.js";
import { renderWithProviders } from "@/test/renderWithProviders.jsx";
import { ToastProvider } from "@/common/contexts/ToastContext.jsx";
import { Vault } from "../Vault.jsx";

const requestDouble = await vi.hoisted(async () => {
    const { createRequestDouble } = await import("@/test/requestDouble.js");
    return createRequestDouble();
});
const vaultAvailable = vi.hoisted(() => ({ enabled: true, impersonating: false, refresh: vi.fn() }));

vi.mock("@/common/utils/RequestUtil.js", () => requestDouble.asModule());
vi.mock("@/common/hooks/useVaultAvailable.js", () => ({ useVaultAvailable: () => vaultAvailable }));

const t = (key, options) => testI18n.t(key, options);
const settings = (overrides = {}) => ({ keyStatus: "active", agentUrl: null, trustProxyUnsafe: false, ...overrides });
const mount = () => renderWithProviders(<Vault />, { providers: [ToastProvider] });

beforeEach(() => {
    requestDouble.reset();
    vaultAvailable.refresh.mockReset();
});

test.each([
    ["missing", "settings.vault.key.missing", "settings.vault.key.missingText"],
    ["mismatch", "settings.vault.key.mismatch", "settings.vault.key.mismatchText"],
])("key status %s says that the vault is off and why", async (keyStatus, pillKey, textKey) => {
    requestDouble.stub("getRequest", "vault/settings", settings({ keyStatus }));
    mount();

    expect(await screen.findByText(t(textKey))).toBeInTheDocument();
    expect(screen.getByText(t(pillKey))).toBeInTheDocument();
});

test("an address without http or https blocks saving; a valid one is saved and refreshes availability", async () => {
    const user = userEvent.setup();
    requestDouble.stub("getRequest", "vault/settings", settings());
    requestDouble.stub("patchRequest", "vault/settings", settings({ agentUrl: "http://192.168.2.10:6989" }));
    mount();
    const field = await screen.findByRole("textbox");
    const save = () => screen.getByRole("button", { name: t("settings.vault.saveSettings") });

    await user.type(field, "192.168.2.10:6989");
    expect(screen.getByText(t("settings.vault.agentUrl.invalid"))).toBeInTheDocument();
    expect(save()).toBeDisabled();

    await user.clear(field);
    await user.type(field, "http://192.168.2.10:6989");
    await user.click(save());

    await waitFor(() => expect(requestDouble.calls).toContainEqual(
        { method: "patchRequest", path: "vault/settings", body: { agentUrl: "http://192.168.2.10:6989" } },
    ));
    expect(vaultAvailable.refresh).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn --cwd client vitest run src/pages/Settings/pages/Vault/__tests__/VaultSettings.test.jsx`
Expected: FAIL — der Platzhalter aus Task 10 exportiert keine Seite mit diesem Inhalt (`Unable to find an element with the text: …` bzw. `requestDouble: no answer stubbed`/kein Aufruf von `vault/settings`).

- [ ] **Step 3: Implement the page**

`client/src/pages/Settings/pages/Vault/Vault.jsx` (ganze Datei):

```jsx
import "./styles.sass";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
    Check as IconCheck, CircleAlert as IconCircleAlert, Link as IconLink, Save as IconSave,
    TriangleAlert as IconTriangleAlert,
} from "lucide-react";
import { getRequest, patchRequest } from "@/common/utils/RequestUtil.js";
import Button from "@/common/components/Button";
import IconInput from "@/common/components/IconInput";
import Icon from "@/common/components/Icon";
import { useToast } from "@/common/contexts/ToastContext.jsx";
import { useVaultAvailable } from "@/common/hooks/useVaultAvailable.js";

const KEY_STATUS = {
    active: { icon: IconCheck, text: null },
    missing: { icon: IconTriangleAlert, text: "key.missingText" },
    mismatch: { icon: IconCircleAlert, text: "key.mismatchText" },
};

export const isValidAgentUrl = (value) => value === "" || /^https?:\/\/\S+$/i.test(value);

const SettingItem = ({ title, description, dataUiId, children }) => (
    <div className="setting-item" data-ui-id={dataUiId}>
        <div className="setting-label">
            <h4>{title}</h4>
            {description && <p>{description}</p>}
        </div>
        {children}
    </div>
);

export const Vault = () => {
    const { t } = useTranslation();
    const { sendToast } = useToast();
    const { refresh } = useVaultAvailable();
    const [settings, setSettings] = useState(null);
    const [agentUrl, setAgentUrl] = useState("");
    const [saving, setSaving] = useState(false);

    const s = (key) => t(`settings.vault.${key}`);

    useEffect(() => {
        getRequest("vault/settings")
            .then((data) => {
                setSettings(data);
                setAgentUrl(data.agentUrl ?? "");
            })
            .catch(() => sendToast(t("common.error"), t("settings.vault.errors.loadSettings")));
    }, [sendToast, t]);

    const trimmed = agentUrl.trim();
    const urlInvalid = !isValidAgentUrl(trimmed);

    const save = async () => {
        try {
            setSaving(true);
            const data = await patchRequest("vault/settings", { agentUrl: trimmed || null });
            setSettings(data);
            setAgentUrl(data.agentUrl ?? "");
            refresh();
            sendToast(t("common.success"), s("saveSuccess"));
        } catch {
            sendToast(t("common.error"), s("errors.saveSettings"));
        } finally {
            setSaving(false);
        }
    };

    if (!settings) return <div className="vault-settings-loading">{s("loading")}</div>;

    const statusKey = KEY_STATUS[settings.keyStatus] ? settings.keyStatus : "missing";
    const status = KEY_STATUS[statusKey];

    return (
        <div className="vault-settings" data-ui-id="UI-VAULT-SETTINGS">
            <div className="settings-section">
                <h2>{s("title")}</h2>
                <p>{s("description")}</p>
                <SettingItem title={s("key.title")} dataUiId="UI-VAULT-SETTINGS-KEY">
                    <div className="vault-key-status">
                        <span className={`vault-key-pill is-${statusKey}`}>
                            <Icon icon={status.icon} />
                            {s(`key.${statusKey}`)}
                        </span>
                        {status.text && <p>{s(status.text)}</p>}
                    </div>
                </SettingItem>
                <SettingItem title={s("agentUrl.title")} description={s("agentUrl.description")} dataUiId="UI-VAULT-SETTINGS-URL">
                    <div className={`setting-input${urlInvalid ? " is-error" : ""}`}>
                        <IconInput icon={IconLink} value={agentUrl} setValue={setAgentUrl} />
                        {urlInvalid && <p className="vault-url-error" role="alert">{s("agentUrl.invalid")}</p>}
                    </div>
                </SettingItem>
                {settings.trustProxyUnsafe && (
                    <div className="vault-proxy-warning" data-ui-id="UI-VAULT-SETTINGS-PROXY" role="alert">
                        <Icon icon={IconTriangleAlert} />
                        <p>{s("proxy.warning")}</p>
                    </div>
                )}
            </div>
            <div className="settings-actions">
                <Button text={s("saveSettings")} icon={IconSave} onClick={save} disabled={saving || urlInvalid}
                        type="primary" dataUiId="UI-VAULT-SETTINGS-SAVE" />
            </div>
        </div>
    );
};
```

`client/src/pages/Settings/pages/Vault/styles.sass`:

```sass
@use "@/common/styles/colors"
@use "@/common/styles/tokens"

.vault-settings
  display: flex
  flex-direction: column
  gap: tokens.$space-8
  max-width: 44rem
  margin-top: tokens.$space-4

  .vault-key-status
    display: flex
    flex-direction: column
    align-items: flex-end
    gap: tokens.$space-1

    p
      margin: 0
      font: tokens.$type-caption
      color: colors.$subtext
      text-align: right

  .vault-key-pill
    display: inline-flex
    align-items: center
    gap: tokens.$space-1
    padding: tokens.$space-1 tokens.$space-2
    border-radius: tokens.$radius-sm
    font: tokens.$type-caption

    &.is-active
      color: colors.$success
      background: colors.$success-opacity

    &.is-missing
      color: colors.$warning
      background: colors.$warning-opacity

    &.is-mismatch
      color: colors.$error
      background: colors.$error-opacity

  .setting-input.is-error .input
    border-color: colors.$error

  .vault-url-error
    margin: tokens.$space-1 0 0
    font: tokens.$type-caption
    color: colors.$error

  .vault-proxy-warning
    display: flex
    align-items: flex-start
    gap: tokens.$space-2
    padding: tokens.$space-3
    border-radius: tokens.$radius-md
    color: colors.$warning
    background: colors.$warning-opacity

    p
      margin: 0
      color: inherit

.vault-settings-loading
  padding: tokens.$space-8
  text-align: center
  color: colors.$subtext
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn --cwd client vitest run src/pages/Settings/pages/Vault/__tests__/VaultSettings.test.jsx`
Expected: PASS (3 Tests: 2 aus `test.each` + 1). Ein `i18n: missing key "settings.vault.…"` heißt: der Schlüssel fehlt aus Task 10 — nicht nachtragen und nicht umbenennen, sondern anhalten und den fehlenden Schlüssel melden.

- [ ] **Step 5: Abschnitt Agenten-Schlüssel**

`client/src/pages/Settings/pages/Account/components/AgentKeysSection/index.js`:

```js
export { AgentKeysSection as default } from "./AgentKeysSection.jsx";
```

`client/src/pages/Settings/pages/Account/components/AgentKeysSection/AgentKeysSection.jsx`:

```jsx
import "./styles.sass";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy as IconCopy, KeyRound as IconKeyRound, Pencil as IconPencil } from "lucide-react";
import Button from "@/common/components/Button";
import Icon from "@/common/components/Icon";
import ActionConfirmDialog from "@/common/components/ActionConfirmDialog";
import AgentAccessDialog from "@/pages/Servers/components/AgentAccessDialog";
import { ServerContext } from "@/common/contexts/ServerContext.jsx";
import { useToast } from "@/common/contexts/ToastContext.jsx";
import { useVaultAvailable } from "@/common/hooks/useVaultAvailable.js";
import { deleteRequest, getRequest } from "@/common/utils/RequestUtil.js";
import { copyToClipboard } from "@/common/utils/clipboard.js";
import { formatTimeAgo } from "@/common/utils/timeAgo.js";

const raw = { interpolation: { escapeValue: false } };

export const AgentKeysSection = () => {
    const { t } = useTranslation();
    const { sendToast } = useToast();
    const { getServerById } = useContext(ServerContext);
    const { enabled, impersonating } = useVaultAvailable();
    const [keys, setKeys] = useState([]);
    const [revokeOpen, setRevokeOpen] = useState(false);
    const [revokeTarget, setRevokeTarget] = useState(null);
    const [editEntryId, setEditEntryId] = useState(null);
    const [revokeOutcome, setRevokeOutcome] = useState(null);
    const revoking = useRef(false);

    const load = useCallback(async () => {
        try {
            const data = await getRequest("vault/agent-keys");
            setKeys((data.keys || []).filter((key) => !key.pending));
        } catch (err) {
            console.error("Failed to load agent keys:", err);
        }
    }, []);

    useEffect(() => {
        if (enabled) load();
    }, [enabled, load]);

    const serverName = (entryId) => getServerById(entryId)?.name ?? String(entryId);
    const agentLabel = (type) => t(`vault.agents.${type}`);

    const groups = [...keys.reduce((map, key) => map.set(key.entryId, [...(map.get(key.entryId) || []), key]), new Map())];

    const confirmRevoke = (key) => {
        setRevokeTarget(key);
        setRevokeOpen(true);
    };

    const revoke = async () => {
        if (!revokeTarget || revoking.current) return;
        revoking.current = true;
        setRevokeOutcome(null);
        try {
            const data = await deleteRequest(`vault/agent-keys/${revokeTarget.id}`);
            if (data.registration === "foreign" || data.registration === "unknown") {
                setRevokeOutcome({ registration: data.registration, server: serverName(revokeTarget.entryId), commands: data.commands ?? null });
            }
            load();
        } catch (err) {
            if (err?.code === 404) load();
            else sendToast(t("common.error"), err?.message || t("common.error"));
        } finally {
            revoking.current = false;
            setRevokeTarget(null);
        }
    };

    const copyCommands = async () => {
        if (!(await copyToClipboard(revokeOutcome.commands))) {
            sendToast(t("common.error"), t("settings.account.apiKeys.copyError"));
        }
    };

    const binding = (key) => {
        if (!key.ipBinding) {
            return (
                <>
                    <span>{t("settings.account.agentKeys.unbound")}</span>
                    <span className="agent-key-anywhere">{t("settings.account.agentKeys.anywhere")}</span>
                </>
            );
        }
        const address = [getServerById(key.entryId)?.ip, ...key.allowedCidrs].filter(Boolean).join(", ");
        return <span className="agent-key-address">{t("settings.account.agentKeys.boundTo", { address, ...raw })}</span>;
    };

    if (!enabled) return null;

    return (
        <div className="account-section agent-keys-section" data-ui-id="UI-API-KEYS-AGENTS">
            <ActionConfirmDialog
                open={revokeOpen}
                setOpen={setRevokeOpen}
                onConfirm={revoke}
                text={revokeTarget ? t("settings.account.agentKeys.revokeConfirm", {
                    agent: agentLabel(revokeTarget.agentType), server: serverName(revokeTarget.entryId), ...raw,
                }) : undefined}
            />
            <AgentAccessDialog open={editEntryId !== null} entryId={editEntryId}
                               onClose={() => { setEditEntryId(null); load(); }} />
            <div className="section-header">
                <div className="header-content">
                    <h2><Icon icon={IconKeyRound} size={0.8} className="agent-keys-title-icon" />{t("settings.account.agentKeys.sectionTitle")}</h2>
                    <p>{t("settings.account.agentKeys.sectionDescription")}</p>
                </div>
            </div>
            {revokeOutcome && (
                <div className="agent-keys-revoked" role="status">
                    <p>
                        {revokeOutcome.registration === "foreign"
                            ? t("settings.account.agentKeys.revokedForeign", { server: revokeOutcome.server, ...raw })
                            : t("settings.account.agentKeys.revokedUnknown")}
                    </p>
                    {revokeOutcome.commands && (
                        <div className="agent-keys-command">
                            <pre>{revokeOutcome.commands}</pre>
                            <Button type="secondary" icon={IconCopy} text={t("servers.agentAccess.result.copy")}
                                    onClick={copyCommands} />
                        </div>
                    )}
                </div>
            )}
            {groups.length === 0 ? (
                <div className="settings-list">
                    <div className="list-empty"><p>{t("settings.account.agentKeys.empty")}</p></div>
                </div>
            ) : (
                <div className="agent-key-groups">
                    {groups.map(([entryId, entryKeys]) => (
                        <div className="agent-key-group" key={entryId}>
                            <div className="agent-key-group-head">
                                <span className="agent-key-group-name">{serverName(entryId)}</span>
                                {!impersonating && (
                                    <Button type="secondary" icon={IconPencil} text={t("settings.account.agentKeys.edit")}
                                            onClick={() => setEditEntryId(entryId)} />
                                )}
                            </div>
                            <div className="settings-list">
                                {entryKeys.map((key) => (
                                    <div className="settings-list-item" key={key.id}>
                                        <div className="item-info">
                                            <Icon icon={IconKeyRound} className="item-icon" />
                                            <div className="item-details">
                                                <h3>{agentLabel(key.agentType)}</h3>
                                                <p className="item-meta agent-key-meta">
                                                    <span>
                                                        {key.lastUsedAt
                                                            ? t("settings.account.agentKeys.lastUsed", { time: formatTimeAgo(key.lastUsedAt, t), ...raw })
                                                            : t("settings.account.apiKeys.neverUsed")}
                                                    </span>
                                                    {binding(key)}
                                                </p>
                                            </div>
                                        </div>
                                        {!impersonating && (
                                            <div className="item-actions">
                                                <Button type="danger" text={t("settings.account.agentKeys.revoke")}
                                                        onClick={() => confirmRevoke(key)} />
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};
```

`client/src/pages/Settings/pages/Account/components/AgentKeysSection/styles.sass`:

```sass
@use "@/common/styles/colors"
@use "@/common/styles/tokens"

.agent-keys-section
  .agent-keys-title-icon
    margin-right: tokens.$space-2

  .agent-keys-revoked
    display: flex
    flex-direction: column
    gap: tokens.$space-2
    margin-bottom: tokens.$space-3
    padding: tokens.$space-3
    border-left: 3px solid colors.$warning
    border-radius: tokens.$radius-md
    background: colors.$warning-opacity

    p
      margin: 0

  .agent-keys-command
    display: flex
    align-items: flex-start
    gap: tokens.$space-2

    pre
      flex: 1
      margin: 0
      padding: tokens.$space-2
      font-family: tokens.$font-mono
      white-space: pre-wrap
      overflow-wrap: anywhere
      background: colors.$dark-gray
      border-radius: tokens.$radius-sm

  .agent-key-groups
    display: flex
    flex-direction: column
    gap: tokens.$space-3

  .agent-key-group
    padding: tokens.$space-3
    border: 1px solid colors.$dark-gray
    border-radius: tokens.$radius-md

  .agent-key-group-head
    display: flex
    align-items: center
    justify-content: space-between
    gap: tokens.$space-2
    margin-bottom: tokens.$space-2

  .agent-key-group-name
    font: tokens.$type-heading

  .agent-key-meta
    display: flex
    flex-wrap: wrap
    align-items: center
    gap: tokens.$space-3

  .agent-key-address
    font-family: tokens.$font-mono

  .agent-key-anywhere
    padding: 0 tokens.$space-2
    border-radius: tokens.$radius-sm
    color: colors.$warning
    background: colors.$warning-opacity

  .item-actions .btn
    color: colors.$error
```

- [ ] **Step 6: Kontoseite anpassen**

`client/src/pages/Settings/pages/Account/Account.jsx` — nach Z. 16 (`import MicrosoftConnections from "@/pages/Settings/pages/Account/components/MicrosoftConnections";`):

```jsx
import MicrosoftConnections from "@/pages/Settings/pages/Account/components/MicrosoftConnections";
import AgentKeysSection from "@/pages/Settings/pages/Account/components/AgentKeysSection";
```

Z. 431-434, vorher:

```jsx
            <div className="account-section">
                <div className="section-header">
                    <div className="header-content">
                        <h2><Icon icon={IconPlug} size={0.8} style={{marginRight: '8px'}} />{t("settings.account.apiKeys.sectionTitle")}</h2>
```

nachher:

```jsx
            <div className="account-section" data-ui-id="UI-API-KEYS-LIST">
                <div className="section-header">
                    <div className="header-content">
                        <h2><Icon icon={IconPlug} size={0.8} style={{marginRight: '8px'}} />{t("settings.account.apiKeys.sectionTitle")}</h2>
```

Z. 475, vorher:

```jsx
            <MicrosoftConnections />
```

nachher:

```jsx
            <AgentKeysSection />

            <MicrosoftConnections />
```

Liste, `loadApiKeys`, `deleteApiKey` und `AddApiKeyDialog` bleiben unverändert; dass `accounts/api-keys` nur `kind = "account"` liefert, macht Task 4 auf dem Server.

- [ ] **Step 7: Lint und betroffene Tests**

Run: `yarn --cwd client lint && yarn --cwd client vitest run src/pages/Settings`
Expected: keine neuen Lint-Fehler; alle Tests unter `src/pages/Settings` grün (Task 14 ist gemergt, der Import `@/pages/Servers/components/AgentAccessDialog` löst auf).

- [ ] **Step 8: Commit**

```bash
git add client/src/pages/Settings/pages/Vault client/src/pages/Settings/pages/Account/components/AgentKeysSection client/src/pages/Settings/pages/Account/Account.jsx
git commit -m "Vault: Einstellungsseite Vault und Agenten-Schlüssel in der Kontoseite"
```

**i18n-Schlüssel, die dieser Task benutzt (angelegt in Task 10):**

| Schlüssel | de_DE |
|---|---|
| `settings.vault.title` | Vault |
| `settings.vault.description` | Systemeinstellungen des Vaults. |
| `settings.vault.loading` | Vault-Einstellungen werden geladen... |
| `settings.vault.key.title` | Vault-Schlüssel |
| `settings.vault.key.active` | Aktiv |
| `settings.vault.key.missing` | Fehlt |
| `settings.vault.key.missingText` | VAULT_KEY fehlt — der Vault ist aus. Schlüssel als Umgebungsvariable oder Docker-Secret vault_key setzen. |
| `settings.vault.key.mismatch` | Passt nicht |
| `settings.vault.key.mismatchText` | VAULT_KEY passt nicht zu den gespeicherten Einträgen — der Vault ist aus. |
| `settings.vault.agentUrl.title` | Outpost-Adresse für Agenten |
| `settings.vault.agentUrl.description` | Unter dieser Adresse erreichen deine Server Outpost; daraus entsteht die MCP-URL für Agenten. |
| `settings.vault.agentUrl.invalid` | Keine gültige http- oder https-Adresse. |
| `settings.vault.proxy.warning` | TRUST_PROXY=true — Outpost glaubt jedem X-Forwarded-For, die IP-Bindung von Agenten-Keys ist wirkungslos. Hop-Zahl oder Adressliste setzen. |
| `settings.vault.saveSettings` | Einstellungen speichern |
| `settings.vault.saveSuccess` | Vault-Einstellungen gespeichert |
| `settings.vault.errors.loadSettings` | Vault-Einstellungen konnten nicht geladen werden |
| `settings.vault.errors.saveSettings` | Vault-Einstellungen konnten nicht gespeichert werden |
| `settings.account.agentKeys.sectionTitle` | Agenten-Schlüssel |
| `settings.account.agentKeys.sectionDescription` | Agenten-Schlüssel erreichen nur den MCP-Endpunkt. |
| `settings.account.agentKeys.edit` | Bearbeiten |
| `settings.account.agentKeys.revoke` | Entziehen |
| `settings.account.agentKeys.revokeConfirm` | Zugang von {{agent}} auf {{server}} entziehen? Der Agent verliert sofort den Zugriff. |
| `settings.account.agentKeys.unbound` | Bindung gelöst |
| `settings.account.agentKeys.anywhere` | von überall |
| `settings.account.agentKeys.boundTo` | nur {{address}} |
| `settings.account.agentKeys.lastUsed` | zuletzt {{time}} |
| `settings.account.agentKeys.empty` | Noch kein Agenten-Zugang. Einrichten über das Kontextmenü eines Servers. |
| `settings.account.agentKeys.revokedForeign` | Zugang entzogen. Die Registrierung auf {{server}} trägt den Key eines anderen Kontos und bleibt stehen. |
| `settings.account.agentKeys.revokedUnknown` | Zugang entzogen. Die Registrierung konnte nicht entfernt werden — Befehl kopieren und auf dem Server ausführen. |
| `servers.agentAccess.result.copy` | Kopieren (auch von Task 14 genutzt) |
| `vault.agents.claude` | Claude Code |
| `vault.agents.codex` | Codex |
| `settings.account.apiKeys.neverUsed`, `settings.account.apiKeys.copyError`, `common.error`, `common.success`, `servers.time.*` | (Bestand) |

---

### Task 11: Vault-MCP-Anbieter (`vault_list`, `browser_fill_credential`)

**Files:**
- Create: `server/lib/vault/fill.js` (Prüfungen 3a/3b, 4, 5, Fokusprüfung, Ausfüllen per CDP)
- Create: `server/lib/vault/mcpProvider.js` (`createVaultProvider`, Werkzeugdefinitionen, Ablauf mit Freigabe, Audit)
- Create: `server/lib/vault/__tests__/helpers/vaultBed.js` (Test-Helfer: ersetzt Sichtbarkeit, Werte, Rechte und Modelle über `require.cache`; von beiden Testdateien dieses Tasks genutzt, kein `*.test.js`, läuft also nicht selbst)
- Test: `server/lib/vault/__tests__/mcpProvider.test.js`
- Modify: `server/routes/mcp.js` (Stand nach Task 2: Kopf mit `browserTools`/`browserProvider`/`createMcpServer`)
- Modify: `server/lib/mcp/__tests__/mcpRoute.test.js` (aus Task 2: Fake für `vault/mcpProvider` vor `require("../../../routes/mcp")`)
- Modify: `server/lib/browser/__tests__/chromium.e2e.test.js` (Stand nach Task 9, der nur einen Test am Dateiende anhängt: neue `require`-Zeilen nach Z. 8, Testseiten und Helfer nach Z. 22, zwei neue Tests am Dateiende; die vorhandenen Tests bleiben unverändert)

**Interfaces:**
- Consumes:
  - Task 1: `VaultError(code, message = VaultErrorMessage[code], details = {})` (ohne Meldung gilt der Standardtext), `VaultErrorCode.{ITEM_UNKNOWN, WRONG_TYPE, ITEM_UNREADABLE, SESSION_TAINTED, VIA_NOT_ALLOWED, PERSISTENT_NOT_ALLOWED, ORIGIN_MISMATCH, NOT_PASSWORD_FIELD, BAD_USERNAME_FIELD, FOCUS_LOST, APPROVAL_TIMEOUT, APPROVAL_UNAVAILABLE, APPROVAL_PENDING, APPROVAL_BUSY, APPROVAL_DENIED, CLIENT_GONE, RATE_LIMITED, NO_SECRET}` (`server/lib/vault/errors.js`); `readSecret(itemId, field) → Promise<string|null>` (`secrets.js`); `isVaultEnabled() → boolean` (`state.js`); `Permission.VAULT_USE`; Audit-Aktionen `vault.use`, `vault.use_denied`, `vault.item_unreadable`, `vault.persistent_not_allowed`, Audit-Konvention `resource: "vault"`, `resourceId: item.id` (falls ein Eintrag feststeht), `details.item: itemRef(item)`; Modell `VaultItem` (`lastUsedAt`; der `afterFind`-Hook liefert `fields` als Objekt und `approvalRequired` als Boolean); Modell `ApiKey` (`pending`); `process.env.VAULT_KEY` (64 Hex) für `vaultGuard.markFilled`.
  - Task 2: `createMcpServer({ providers, now })` aus `server/lib/mcp/server.js`; `Provider = { name, available(ctx) → Promise<boolean>, list(ctx) → Tool[], has(name, ctx) → boolean, call(name, args, ctx) → Promise<ToolResult>, forgetTransport(transportId) → void }`; `ctx = { accountId, agent, keyId, impersonatorId, transportId, ipAddress, userAgent, signal }` (`impersonatorId` = `req.session?.impersonatorId ?? null`); `handle({ body, transportId, accountId, keyId = null, agent = null, impersonatorId = null, ipAddress, userAgent, signal })`. Der Rahmen ruft je Anfrage `await provider.available(ctx)` vor `list(ctx)`/`has(name, ctx)` mit demselben `ctx`-Objekt (Task 2, `availableProviders`); der Vault-Anbieter merkt sich darin `connect.browser` je `ctx` in einer `WeakMap`. Modulweite Konstante `browserTools` in `server/routes/mcp.js`; Testdatei `server/lib/mcp/__tests__/mcpRoute.test.js`.
  - Task 3: `itemRef(item) → string`, `visibleItems({ accountId, agent }) → Promise<VaultItem[]>`, `findVisibleItem({ accountId, agent }, ref) → Promise<VaultItem>` (wirft `VaultError(ITEM_UNKNOWN)`), `canUseVault(accountId) → Promise<boolean>` (`vault.use` oder aktives Mitglied einer Organisation).
  - Task 4: `server/utils/auditContext.js` und `createAuditLog` ergänzen `details.impersonatorId` in jedem Audit einer Impersonations-Session; dieser Task trägt die Kennung nicht selbst ein, `ctx.impersonatorId` steuert hier nur die Freigabepflicht.
  - Task 6: `requestApproval({ accountId, keyId, transportId, agentType, entryName, item, target, signal }) → Promise<"once"|"session">` — antwortet sofort `"session"`, wenn `hasSessionApproval(transportId, item)` gilt (Stempel aus `item.updatedAt` und den sortierten `item.fields.origins`); dieser Task übergibt deshalb den ganzen Eintrag, wie `findVisibleItem` ihn liefert. Frühe Ablehnungen (Sperre nach `deny` → `APPROVAL_DENIED`, `APPROVAL_PENDING`, `APPROVAL_BUSY`, `APPROVAL_UNAVAILABLE`, vorab abgebrochenes `CLIENT_GONE`) wirft `approvals.js` als `new VaultError(code, undefined, { early: true })` und auditiert sie nicht; Ablehnung per Antwort, Timeout und `client_gone` nach gezeigter Karte auditiert `approvals.js` selbst (`vault.deny`/`vault.approval_timeout`, Fehler mit `details: {}`). Dieser Task schreibt deshalb für einen Fehler aus `requestApproval` nur dann `vault.use_denied`, wenn `!APPROVAL_CODES.has(err.code) || err.details?.early`; jeder Fehler, den dieser Task selbst wirft (auch sein `CLIENT_GONE` nach der Freigabe), wird hier auditiert. `forgetTransport(transportId)`.
  - Task 7: `createBrowserTools(…).resolveSession(ctx, sessionId) → BrowserSession` (Agenten-Regeln eingeschlossen; wirft `BrowserError` `UNKNOWN_SESSION` / `SESSION_CLOSED` / `NO_SESSION` / `AMBIGUOUS_SESSION`), Aufruf `getBrowserTools().resolveSession(ctx, args.sessionId ?? null)`; `session.keyId`, `session.contextKey`; `pool.open({ accountId, url, origin, keyId })`, `pool.getOwned(accountId, sessionId, { keyId } = {})`, `pool.listForCaller({ accountId, keyId })`; Popups übernehmen `contextKey` vom Öffner. Der `via`-Verstoß beim Öffnen ist dort ein Browser-Fehler; Prüfung 3b dieses Tasks (Sitzung läuft bereits über `via` bzw. `persistent`) wirft `VaultError(VIA_NOT_ALLOWED|PERSISTENT_NOT_ALLOWED)`.
  - Task 9: `vaultGuard.isTainted(contextKey) → boolean`; `vaultGuard.markFilled(contextKey, { targetId, backendNodeIds, secret }) → void` (`targetId: session.targetId` ist Pflicht, sonst `TypeError`) (synchron; prüft im selben Schritt den Taint und wirft `VaultError(SESSION_TAINTED)`, ohne etwas zu merken — dieser Task ruft es unmittelbar vor dem ersten `Input.insertText` und behandelt den Wurf wie Prüfung 3a); `vaultGuard.isFilled(contextKey) → boolean`; `vaultGuard.redactText(contextKey, text) → string` (filtert hier die Fehlertexte von `browser_fill_credential`); `BrowserSession.evaluate()` ruft `assertEvaluateAllowed(session)` (markiert Taint); `vaultGuard.assertInputAllowed(session, tool, args)` in `act` (Mittelklick immer, im befüllten Kontext `browser_key` mit Strg/Meta/Umschalt außer `Shift+Tab` und `clickCount > 1` → `vault.input_locked`); Schwärzung in `buildSnapshot` und den Textfiltern von `tools.js`; Screenshot-Sperre. Die Audits `vault.evaluate_locked`/`vault.screenshot_locked`/`vault.input_locked` schreibt `tools.js`, nicht dieser Task.
- Produces:
  - `createVaultProvider({ getBrowserTools, approvals = require("./approvals"), audit = defaultAudit }) → Provider` mit `name: "vault"`; `available(ctx)` = `isVaultEnabled()` und `canUseVault(ctx.accountId)`; `list(ctx)` → `[vault_list]` bzw. `[vault_list, browser_fill_credential]` mit `connect.browser`; `has(name, ctx)` entsprechend; `forgetTransport(id)` → `approvals.forgetTransport(id)`.
  - `vault_list` → `{ content: [{ type: "text", text: JSON }] }`, JSON-Liste von `{ item, owner: "personal"|<Organisationsname>, type, description, username?, host?, origins?, hosts?, approvalRequired, usableBy: string[] }`; nie Werte.
  - `browser_fill_credential({ item, passwordRef, usernameRef?, sessionId? })` → Text exakt `Benutzername und Passwort von <item> eingetragen.` bzw. ohne `usernameRef` `Passwort von <item> eingetragen.`; Fehler als `{ isError: true }` mit `<Meldung> (<vault-Code>)`, die Meldung durch `vaultGuard.redactText` der Sitzung gefiltert. Freigabe, wenn `item.approvalRequired` oder `ctx.impersonatorId` gesetzt ist. Nach der Freigabe: `ctx.signal` abgebrochen → `CLIENT_GONE`; Key (`ctx.keyId`) nicht mehr vorhanden oder `pending` → `ITEM_UNKNOWN`; `findVisibleItem` neu (nicht mehr sichtbar → `ITEM_UNKNOWN`), Typ und Benutzername erneut, Ursprünge anders als bei der Anfrage → `ORIGIN_MISMATCH`; danach Prüfungen 3 bis 5 mit dem neuen Stand. `lastUsedAt` wird nach dem Audit `vault.use` mit `silent: true` gesetzt (`updatedAt` bleibt, sonst passte der Stempel einer „Für diese Sitzung“-Freigabe aus Task 6 nach jedem Ausfüllen nicht mehr); ein Fehler dabei wird nur geloggt.
  - `fill.js`: `checkFillTarget(session, { passwordRef, usernameRef }, origins) → Promise<{ passwordNodeId, usernameNodeId|null }>`; `fillCredential(session, { passwordNodeId, usernameNodeId, username, password }) → Promise<void>` (je Feld `DOM.focus`, Leeren über `DOM.resolveNode` + `Runtime.callFunctionOn("function () { this.value = ''; }")` statt Alles-Markieren, Fokusprüfung über `backendNodeId` durch Shadow-Roots und Frames, dann `vaultGuard.markFilled` unmittelbar vor dem ersten `Input.insertText`, nur mit dem Passwortfeld; ist die Sitzung inzwischen geschlossen, `BrowserError(SESSION_CLOSED)` ohne Eingabe); **zusätzlich** `assertFillableSession(session) → void` (Prüfungen 3a, 3b) und `normalizeOrigin(value) → string|null` (`new URL(value).origin`, also dieselbe Form, in der Task 5 `origins` speichert — auf gespeicherte Ursprünge angewandt ändert sie nichts; `null` bei opaken/ungültigen Ursprüngen). Verglichen wird `normalizeOrigin` des Frames und jedes Vorfahren-Frames gegen die Menge `origins.map(normalizeOrigin)`.
  - Fehler `VaultError(RATE_LIMITED)` bei mehr als 20 Ausfüllversuchen je Aufrufer (`accountId`, `keyId`) und Minute (SEC-RATE-01) und `VaultError(NO_SECRET)` für einen Login-Eintrag ohne gespeichertes Passwort; beide mit dem Standardtext aus `VaultErrorMessage`. `NO_SECRET` geht als `vault.use_denied` mit `code: "vault.no_secret"` ins Audit, nicht als `vault.item_unreadable` (das bleibt dem Entschlüsselungsfehler aus `readSecret`).
  - Audit: `vault.use` nach erfolgreichem Ausfüllen; jede Ablehnung als `vault.use_denied` (bzw. `vault.item_unreadable`/`vault.persistent_not_allowed`) mit `code`, `stage` (`before_approval`/`after_approval`) und `target`, auch frühe Ablehnungen der Freigabe (`details.early`); nicht noch einmal die Ablehnungen, die `approvals.js` selbst auditiert (Code aus `APPROVAL_CODES` ohne `details.early`).
  - Test-Helfer `vaultBed.js`: `state`, `reset({ items, secrets, permissions, memberships, orgs, entries, apiKeys })`.

**Design:** kein UI-Anteil.

**Tests:** 8 Tests: 6 in `mcpProvider.test.js`, test-first (der Vertrag steht in der Spec), und 2 in der Chromium-Reihe. (1)–(5) über die Naht echte `BrowserSession` auf `createFakeCdp` + echte `createBrowserTools` + Fake-Pool + Fake-Freigaben mit steuerbarer Antwort, (6) mit echtem `BrowserPool` auf `createFakeCdp`: (1) Spec-Test 5: serialisierte `vault_list`-Antwort enthält keinen gespeicherten Wert, `readSecret` wird nie aufgerufen, Organisationseintrag als `org:3/shop-api` mit Organisationsname; (2) Freigabe nach 100 s (Fake-Uhr) füllt noch, die Sitzung ist während der Wartezeit frei, ein zweiter Aufruf bekommt `vault.approval_pending` statt `BUSY` und landet als `vault.use_denied` im Audit, Audit `vault.use` ohne Wert, `lastUsedAt` mit `silent: true` gesetzt; ein Aufruf mit `impersonatorId` wartet auch bei einem Eintrag ohne Freigabepflicht auf die Freigabe; (3) Review Focus 2 und Prüfungen nach der Freigabe, je ein Fall: `browser_evaluate` während der Wartezeit → `vault.session_tainted`, Mitgliedschaft endet (Eintrag nicht mehr sichtbar) → `vault.item_unknown`, Ursprung hinzugefügt → `vault.origin_mismatch`, Key entzogen → `vault.item_unknown`; jedes Mal nichts getippt, Audit `vault.use_denied` mit Code, `after_approval`, Ziel; (4) über `createMcpServer`: ohne `connect.browser` nur `vault_list`, `browser_fill_credential` ist `-32602`; (5) Fokusverlust → `vault.focus_lost` ohne `Input.insertText`; (6) Spec-Test 10, Teil `browser_fill_credential`: ein Agenten-Key mit der `sessionId` einer Nutzersitzung (`keyId` null) oder einer Sitzung von Key 8 bekommt denselben Text wie für eine unbekannte (`UNKNOWN_SESSION`), ohne `sessionId` `NO_SESSION` ohne fremde Sitzung zu nennen; kein `DOM.focus`, kein `Input.insertText`, kein `readSecret`; Audit `vault.use_denied` mit dem Code. Chromium-Reihe (per `OUTPOST_BROWSER_E2E_LAUNCHER` zugeschaltet): (7) Spec-Test 7 inkl. Erfolg im eigenen iframe (Fokusprüfung durch Frames); (8) Spec-Test 8 + Review Focus 1 + Spec-Test 12, dazu Auswahl und Zwischenablage: nach dem Ausfüllen `browser_key` `Control+a` und `browser_click` mit `clickCount: 3` → `vault.input_locked`, ein zweites Ausfüllen leert die Felder statt sie zu markieren (Werte nicht doppelt), ein Mittelklick in einem neuen Kontext ist als Werkzeug gesperrt und fügt auch am Wächter vorbei kein Passwort ein; Positivkontrolle: ein per Dreifachklick markiertes `primary-probe` aus einem dritten Kontext kommt per Mittelklick an, sonst meldet der Test per `t.diagnostic`, dass die Negativprüfung in diesem Chromium nichts zeigt (dann manuell abnehmen), und schließt die Probe-Sitzung. Nicht getestet: Werkzeug-Schemas und Beschreibungen (Konstanten), Registrierung in `mcp.js` (Weiterreichung), Weiterreichung der übrigen Freigabe-Fehler (Task 6 testet sie; (2) zeigt das Audit an `approval_pending`), das Auslassen der von `approvals.js` selbst auditierten Ablehnungen (eine Bedingung; Task 6 testet deren Audit), Nachschlagen des Servernamens für die Karte, die Drossel von 20 Ausfüllungen je Minute (eine Zeile Zählung, Konfig-nah), `vault.no_secret` (eine Verzweigung mit Standardtext), `CLIENT_GONE` nach abgebrochenem `signal` und `SESSION_CLOSED` in `markOnce` (je eine Zeile ohne weitere Wirkung), der nur geloggte Fehler beim Setzen von `lastUsedAt` (Log-Ausgabe), die Impersonations-Kennung im Audit (kommt aus `createAuditLog`, Task 4 testet sie). SEC: SEC-INPUT-01 (Argumentprüfung), SEC-ERR-01 (unerwartete Fehler nur generisch, Fehlertexte durch `redactText`), SEC-SECRET-01 (Tests 1, 2, 8), SEC-IDOR-01/SEC-TENANT-01 (`findVisibleItem` vor und nach der Freigabe, `resolveSession`; Tests 3, 6), SEC-RBAC-01 (Freigabe bei Impersonation; Test 2), SEC-RATE-01 (Drossel), SEC-SESS-02 (`forgetTransport` an Freigaben, Key nach der Freigabe geprüft; Test 3), SEC-PII-01 (Audit ohne Benutzernamen und Werte).

**Parallel:** none — Welle D enthält nur diesen Task: Er setzt `approvals.js` (Task 6, Welle C), `resolveSession` (Task 7) und `vaultGuard` samt `assertInputAllowed` (Task 9) voraus und ändert `chromium.e2e.test.js` nach Task 9; Task 16 (Welle E) beschreibt sein Verhalten.

- [ ] **Step 1: Test-Helfer anlegen**

`server/lib/vault/__tests__/helpers/vaultBed.js`:

```js
const { Sequelize } = require("sequelize");
const { VaultError, VaultErrorCode } = require("../../errors");
const { Permission } = require("../../../../permissions/registry");

const fake = (path, exports) => {
    const resolved = require.resolve(path);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

const state = {
    enabled: true, items: [], secrets: new Map(), permissions: new Set(), memberships: 0,
    orgs: [], entries: new Map(), apiKeys: new Set(), updates: [], secretReads: 0,
};

const itemRef = (item) => (item.organizationId ? `org:${item.organizationId}/${item.name}` : item.name);

// Installed on require, before the provider is loaded: it destructures these modules.
fake("../../../../utils/database", new Sequelize({ dialect: "sqlite", storage: ":memory:", logging: false }));
fake("../../state", { isVaultEnabled: () => state.enabled });
fake("../../visibility", {
    itemRef,
    visibleItems: async () => state.items.map((item) => ({ ...item })),
    findVisibleItem: async (caller, ref) => {
        const item = state.items.find((candidate) => itemRef(candidate) === ref);
        if (!item) throw new VaultError(VaultErrorCode.ITEM_UNKNOWN, `No vault entry ${ref} is available to this connection.`);
        return { ...item };
    },
    canUseVault: async () => state.permissions.has(Permission.VAULT_USE) || state.memberships > 0,
});
fake("../../secrets", {
    readSecret: async (itemId, field) => {
        state.secretReads += 1;
        return state.secrets.get(`${itemId}:${field}`) ?? null;
    },
});
fake("../../../../utils/permission", { hasAccountPermission: async (accountId, permission) => state.permissions.has(permission) });
fake("../../../../models/VaultItem", {
    update: async (values, options) => {
        state.updates.push({ values, where: options.where, silent: options.silent });
        return [1];
    },
});
fake("../../../../models/ApiKey", { count: async ({ where }) => (where.pending === false && state.apiKeys.has(where.id) ? 1 : 0) });
fake("../../../../models/Organization", { findAll: async () => state.orgs });
fake("../../../../models/Entry", { findByPk: async (id) => state.entries.get(id) ?? null });

const reset = ({ items = [], secrets = {}, permissions = [], memberships = 0, orgs = [], entries = [], apiKeys = [] } = {}) => {
    Object.assign(state, {
        enabled: true, items, secrets: new Map(Object.entries(secrets)), permissions: new Set(permissions), memberships,
        orgs, entries: new Map(entries.map((entry) => [entry.id, entry])), apiKeys: new Set(apiKeys), updates: [], secretReads: 0,
    });
};

module.exports = { state, reset };
```

- [ ] **Step 2: Write the failing test**

`server/lib/vault/__tests__/mcpProvider.test.js`:

```js
process.env.VAULT_KEY = "ab".repeat(32);
const test = require("node:test");
const assert = require("node:assert");
const bed = require("./helpers/vaultBed");
const { BrowserSession } = require("../../browser/BrowserSession");
const { BrowserPool } = require("../../browser/BrowserPool");
const { createFakeCdp, flush } = require("../../browser/__tests__/helpers/fakeCdp");
const { createBrowserTools } = require("../../browser/tools");
const vaultGuard = require("../../browser/vaultGuard");
const { createMcpServer } = require("../../mcp/server");
const { Permission } = require("../../../permissions/registry");
const { VaultError, VaultErrorCode } = require("../errors");
const { createVaultProvider } = require("../mcpProvider");

const FILL = "browser_fill_credential";
const SECRET = "hunter2-vault";
const LOGIN = {
    id: 41, accountId: 1, organizationId: null, name: "github", type: "login", description: null,
    fields: { username: "ada", origins: ["https://login.test"] }, approvalRequired: false, allServers: true,
};
const ORG_API = {
    id: 42, accountId: null, organizationId: 3, name: "shop-api", type: "api_key", description: "Shop API",
    fields: { hosts: ["api.shop.test"], headerName: "Authorization", headerTemplate: "Bearer {{secret}}" }, approvalRequired: true, allServers: true,
};

const fakePage = () => {
    const page = {
        nodes: new Map([
            [11, { origin: "https://login.test", ancestors: [], input: true, type: "password", connected: true }],
            [12, { origin: "https://login.test", ancestors: [], input: true, type: "text", connected: true }],
        ]),
        focused: null,
        holdFocus: false,
    };
    const nodeId = (objectId) => Number(objectId.slice("node-".length));
    const cdp = createFakeCdp({
        "DOM.resolveNode": ({ backendNodeId }) => ({ object: { objectId: `node-${backendNodeId}` } }),
        "Runtime.evaluate": ({ expression }) => (expression === "document" ? { result: { objectId: "document" } } : { result: { value: 1 } }),
        "Runtime.callFunctionOn": ({ objectId }) => {
            if (objectId !== "document") return { result: { value: page.nodes.get(nodeId(objectId)) } };
            return { result: page.focused === null ? { type: "object", subtype: "null", value: null } : { objectId: `node-${page.focused}` } };
        },
        "DOM.describeNode": ({ objectId }) => ({ node: { backendNodeId: nodeId(objectId), nodeName: "INPUT" } }),
        "DOM.focus": ({ backendNodeId }) => {
            if (!page.holdFocus) page.focused = backendNodeId;
            return {};
        },
    });
    return { page, cdp };
};

let opened = 0;
const openSession = (cdp) => {
    opened += 1;
    const session = new BrowserSession({
        id: `browser-${opened}`, accountId: 1, profile: "ephemeral", origin: "agent", cdp, targetId: `T${opened}`, cdpSessionId: `S${opened}`,
    });
    session.keyId = null;
    session.contextKey = `ctx-${opened}`;
    session.state.url = "https://login.test/signin";
    session.refs.assign(11, 'textbox "Password"');
    session.refs.assign(12, 'textbox "User"');
    return session;
};

const fakePool = (sessions) => {
    const mine = (accountId, keyId) => sessions.filter((s) => s.accountId === accountId && (keyId === null || s.keyId === keyId));
    return {
        getOwned: (accountId, id, { keyId = null } = {}) => mine(accountId, keyId).find((s) => s.id === id) ?? null,
        listForCaller: ({ accountId, keyId = null }) => mine(accountId, keyId).map((s) => s.summary()),
        listForAccount: (accountId) => mine(accountId, null).map((s) => s.summary()),
    };
};

const fakeApprovals = () => {
    const open = [];
    return {
        open,
        requestApproval: (request) => {
            if (open.some((o) => o.request.transportId === request.transportId && o.request.item.id === request.item.id))
                return Promise.reject(new VaultError(VaultErrorCode.APPROVAL_PENDING, undefined, { early: true }));
            return new Promise((resolve) => {
                const pending = {
                    request,
                    answer: (decision) => {
                        open.splice(open.indexOf(pending), 1);
                        resolve(decision);
                    },
                };
                open.push(pending);
            });
        },
        forgetTransport: () => {},
    };
};

const setup = ({ items = [LOGIN], permissions = [Permission.VAULT_USE, Permission.CONNECT_BROWSER] } = {}) => {
    bed.reset({ items, secrets: { "41:password": SECRET, "42:token": "tok-123-secret" }, permissions, orgs: [{ id: 3, name: "Shop GmbH" }], apiKeys: [99] });
    const { page, cdp } = fakePage();
    const session = openSession(cdp);
    const pool = fakePool([session]);
    const audit = [];
    const record = async (entry) => { audit.push(entry); };
    const browserTools = createBrowserTools({ getPool: () => pool, audit: record });
    const approvals = fakeApprovals();
    const provider = createVaultProvider({ getBrowserTools: () => browserTools, approvals, audit: record });
    const ctx = (transportId = "A") => ({
        accountId: 1, keyId: null, agent: null, impersonatorId: null, transportId, ipAddress: "10.0.0.1", userAgent: "claude-code", signal: new AbortController().signal,
    });
    const text = (result) => result.content.map((c) => c.text).join("");
    const typed = () => cdp.callsOf("Input.insertText").map((call) => call.params.text);
    const vaultAudit = () => audit.filter((entry) => entry.action.startsWith("vault."));
    return { page, cdp, session, pool, audit, vaultAudit, browserTools, approvals, provider, ctx, text, typed };
};

const until = async (condition) => {
    for (let i = 0; i < 200 && !condition(); i++) await flush();
    assert.ok(condition(), "condition not reached");
};

const rpc = (id, method, params = {}) => ({ jsonrpc: "2.0", id, method, params });

test("vault_list names every visible entry without a stored value; organization entries as org:<id>/<name>", async () => {
    const { provider, ctx, text } = setup({ items: [LOGIN, ORG_API] });
    const result = await provider.call("vault_list", {}, ctx());

    const serialized = JSON.stringify(result);
    for (const value of [SECRET, "tok-123-secret"]) assert.ok(!serialized.includes(value), `vault_list leaks ${value}`);
    assert.strictEqual(bed.state.secretReads, 0, "vault_list never decrypts");
    assert.deepStrictEqual(JSON.parse(text(result)), [
        {
            item: "github", owner: "personal", type: "login", description: null, username: "ada",
            origins: ["https://login.test"], approvalRequired: false, usableBy: ["browser_fill_credential"],
        },
        {
            item: "org:3/shop-api", owner: "Shop GmbH", type: "api_key", description: "Shop API",
            hosts: ["api.shop.test"], approvalRequired: true, usableBy: [],
        },
    ]);
});

test("an approval answered after more than 90 s still fills: the wait runs outside runAgent and leaves the session free; an impersonated call always asks", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const env = setup({ items: [{ ...LOGIN, approvalRequired: true }] });
    const pending = env.provider.call(FILL, { item: "github", passwordRef: "e1", usernameRef: "e2" }, env.ctx("A"));
    await until(() => env.approvals.open.length === 1);
    assert.strictEqual(env.session.agentTool, null, "nobody holds the session while the user decides");
    assert.strictEqual(env.approvals.open[0].request.target, "https://login.test");

    const second = await env.provider.call(FILL, { item: "github", passwordRef: "e1" }, env.ctx("A"));
    assert.match(env.text(second), /\(vault\.approval_pending\)$/, "a second call meets the open approval, not a busy session");

    t.mock.timers.tick(100_000);
    env.approvals.open[0].answer("once");
    const result = await pending;

    assert.strictEqual(env.text(result), "Benutzername und Passwort von github eingetragen.");
    assert.deepStrictEqual(env.typed(), ["ada", SECRET]);
    assert.ok(vaultGuard.isFilled(env.session.contextKey));
    assert.deepStrictEqual(env.vaultAudit().map((entry) => [entry.action, entry.details.code]),
        [["vault.use_denied", "vault.approval_pending"], ["vault.use", undefined]]);
    const use = env.vaultAudit().find((entry) => entry.action === "vault.use");
    assert.deepStrictEqual([use.resource, use.resourceId, use.details.item, use.details.target, use.details.approval],
        ["vault", 41, "github", "https://login.test", "once"]);
    assert.ok(!JSON.stringify(env.audit).includes(SECRET));
    assert.deepStrictEqual(bed.state.updates.map(({ where, silent }) => ({ where, silent })), [{ where: { id: 41 }, silent: true }], "updatedAt stays, a session approval keeps matching");

    bed.state.items[0].approvalRequired = false;
    const impersonated = env.provider.call(FILL, { item: "github", passwordRef: "e1" }, { ...env.ctx("B"), impersonatorId: 7 });
    await until(() => env.approvals.open.length === 1);
    env.approvals.open[0].answer("once");
    assert.strictEqual(env.text(await impersonated), "Passwort von github eingetragen.", "an impersonated call waits for the user even where the entry needs no approval");
});

test("after the approval every check runs again with the entry as it is now; a failure types nothing and is audited after_approval", async () => {
    const cases = [
        ["browser_evaluate in the session", "vault.session_tainted", async (env) => {
            const evaluated = await env.browserTools.call("browser_evaluate", { expression: "1", sessionId: env.session.id }, env.ctx("A"));
            assert.ok(!evaluated.isError, "the session is free for other tools while the user decides");
        }],
        ["the membership that made the entry visible ends", "vault.item_unknown", () => {
            bed.state.items = [];
        }],
        ["an origin is added to the entry", "vault.origin_mismatch", () => {
            bed.state.items[0].fields = { ...LOGIN.fields, origins: [...LOGIN.fields.origins, "https://other.test"] };
        }],
        ["the key of the connection is revoked", "vault.item_unknown", () => {
            bed.state.apiKeys.clear();
        }],
    ];
    for (const [change, code, during] of cases) {
        const env = setup({ items: [{ ...LOGIN, approvalRequired: true }] });
        const pending = env.provider.call(FILL, { item: "github", passwordRef: "e1", usernameRef: "e2" }, { ...env.ctx("A"), keyId: 99 });
        await until(() => env.approvals.open.length === 1);
        await during(env);
        env.approvals.open[0].answer("once");
        const result = await pending;

        assert.strictEqual(result.isError, true, change);
        assert.ok(env.text(result).endsWith(`(${code})`), `${change}: ${env.text(result)}`);
        assert.deepStrictEqual(env.typed(), [], change);
        const denied = env.vaultAudit().find((entry) => entry.action === "vault.use_denied");
        assert.deepStrictEqual([denied.details.code, denied.details.stage, denied.details.target, denied.details.item],
            [code, "after_approval", "https://login.test", "github"], change);
    }
});

test("without connect.browser the MCP endpoint lists only vault_list and answers browser_fill_credential as an unknown tool", async () => {
    const env = setup({ permissions: [Permission.VAULT_USE] });
    const mcp = createMcpServer({ providers: [env.provider] });
    const init = await mcp.handle({
        body: rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "1" } }), accountId: 1,
    });
    const transportId = init.headers["Mcp-Session-Id"];
    const names = async () => (await mcp.handle({ body: rpc(2, "tools/list"), transportId, accountId: 1 })).body.result.tools.map((tool) => tool.name);

    assert.deepStrictEqual(await names(), ["vault_list"]);
    const called = await mcp.handle({ body: rpc(3, "tools/call", { name: FILL, arguments: { item: "github", passwordRef: "e1" } }), transportId, accountId: 1 });
    assert.strictEqual(called.body.error.code, -32602);
    assert.deepStrictEqual(env.typed(), []);

    bed.state.permissions.add(Permission.CONNECT_BROWSER);
    assert.deepStrictEqual(await names(), ["vault_list", FILL]);
});

test("when the page keeps the focus on another element the fill stops with vault.focus_lost before Input.insertText", async () => {
    const env = setup();
    env.page.focused = 99;
    env.page.holdFocus = true;
    const result = await env.provider.call(FILL, { item: "github", passwordRef: "e1" }, env.ctx("A"));

    assert.match(env.text(result), /\(vault\.focus_lost\)$/);
    assert.strictEqual(env.cdp.callsOf("Input.insertText").length, 0);
    assert.strictEqual(env.vaultAudit().find((entry) => entry.action === "vault.use_denied").details.code, "vault.focus_lost");
});

test("an agent key fills only in its own sessions: a foreign sessionId answers like an unknown one, none falls back to another's session", async () => {
    bed.reset({ items: [LOGIN], secrets: { "41:password": SECRET }, permissions: [Permission.VAULT_USE, Permission.CONNECT_BROWSER] });
    let targets = 0;
    let contexts = 0;
    const instances = [];
    const launcher = {
        started: [],
        async start({ key }) {
            launcher.started.push(key);
            return { key, port: 9222 + launcher.started.length };
        },
        async stop() {},
        async endpoint(port) { return `ws://10.0.0.7:${port}/devtools/browser/x`; },
    };
    const connectCdp = async () => {
        const cdp = createFakeCdp({
            "Target.createBrowserContext": () => ({ browserContextId: `ctx-${++contexts}` }),
            "Target.createTarget": () => ({ targetId: `T${++targets}` }),
            "Target.attachToTarget": ({ targetId }) => ({ sessionId: `S-${targetId}` }),
        });
        instances.push(cdp);
        return cdp;
    };
    const pool = new BrowserPool({
        getSettings: async () => ({ enabled: true, maxSessions: 4, idleMinutes: 30, callbackHost: "outpost" }), launcher, connectCdp,
        createVia: async () => { throw new Error("no via in this test"); },
    });
    const audit = [];
    const record = async (entry) => { audit.push(entry); };
    const browserTools = createBrowserTools({ getPool: () => pool, audit: record });
    const provider = createVaultProvider({ getBrowserTools: () => browserTools, approvals: fakeApprovals(), audit: record });
    const { session: users } = await pool.open({ accountId: 1, origin: "user" });
    const { session: theirs } = await pool.open({ accountId: 1, keyId: 8 });
    const agent = {
        accountId: 1, keyId: 41, agent: { keyId: 41, entryId: 7, agentType: "claude" }, impersonatorId: null,
        transportId: "T41", ipAddress: "10.0.0.5", userAgent: "claude-code", signal: new AbortController().signal,
    };
    const fillIn = async (sessionId) => {
        const result = await provider.call(FILL, { item: "github", passwordRef: "e1", ...(sessionId && { sessionId }) }, agent);
        assert.strictEqual(result.isError, true);
        return result.content.map((c) => c.text).join("");
    };

    const unknown = await fillIn("browser-unknown");
    for (const foreign of [users.id, theirs.id])
        assert.strictEqual((await fillIn(foreign)).replace(foreign, "X"), unknown.replace("browser-unknown", "X"), "a foreign session answers like an unknown one");
    const none = await fillIn(null);
    assert.match(none, /No browser session is open/);
    assert.ok(![users.id, theirs.id].some((id) => none.includes(id)), "neither the user's nor the other key's session is taken or named");

    for (const method of ["DOM.focus", "Input.insertText"])
        assert.deepStrictEqual(instances.flatMap((cdp) => cdp.callsOf(method)), [], method);
    assert.strictEqual(bed.state.secretReads, 0);
    assert.deepStrictEqual(audit.filter((entry) => entry.action === "vault.use_denied").map((entry) => entry.details.code),
        ["UNKNOWN_SESSION", "UNKNOWN_SESSION", "UNKNOWN_SESSION", "NO_SESSION"]);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test server/lib/vault/__tests__/mcpProvider.test.js`
Expected: FAIL, alle Tests brechen beim Laden ab mit `Error: Cannot find module '../mcpProvider'`.

- [ ] **Step 4: Implement `server/lib/vault/fill.js`**

```js
const vaultGuard = require("../browser/vaultGuard");
const { BrowserError, BrowserErrorCode } = require("../browser/errors");
const { VaultError, VaultErrorCode } = require("./errors");

const OBJECT_GROUP = "vault-fill";
const USERNAME_TYPES = new Set(["text", "email", "tel"]);
const FRAME_OWNERS = new Set(["IFRAME", "FRAME"]);
const MAX_FRAME_DEPTH = 16;
// Clearing instead of select-all: a selection would land in the primary selection, which every
// context of the browser instance shares and a middle click pastes elsewhere.
const CLEAR = "function () { this.value = ''; }";
const GONE = /No node (found|with given id)|detached from document|Could not find node/i;

// Runs in the realm of the element's own frame and reads only the global location, which is
// unforgeable there. Getters such as ownerDocument can be replaced by page script to fake an origin.
const INSPECT = `function () {
    const ancestors = [];
    for (let i = 0; i < location.ancestorOrigins.length; i++) ancestors.push(location.ancestorOrigins[i]);
    const input = this instanceof HTMLInputElement;
    return { origin: location.origin, ancestors, input, type: input ? this.type : null, connected: this.isConnected };
}`;
const DEEPEST_ACTIVE = `function () {
    let el = this.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el;
}`;

const normalizeOrigin = (value) => {
    try {
        const { origin } = new URL(String(value));
        return origin === "null" ? null : origin;
    } catch {
        return null;
    }
};

const staleRef = () => new BrowserError(BrowserErrorCode.STALE_REF, "The element no longer exists; take a new snapshot");
const unlessGone = (err) => {
    if (err instanceof BrowserError || err instanceof VaultError) throw err;
    if (GONE.test(err?.message ?? "")) throw staleRef();
    throw err;
};

const assertFillableSession = (session) => {
    if (vaultGuard.isTainted(session.contextKey)) throw new VaultError(VaultErrorCode.SESSION_TAINTED);
    if (session.via)
        throw new VaultError(VaultErrorCode.VIA_NOT_ALLOWED,
            `Session ${session.id} runs via ${session.via}; a password is never typed into a tunneled page. Open the login page with browser_open without via.`);
    if (session.profile === "persistent")
        throw new VaultError(VaultErrorCode.PERSISTENT_NOT_ALLOWED,
            `Session ${session.id} uses the persistent profile, where prepared pages survive on disk. Open a new session with browser_open without profile=persistent and fill there.`);
};

const inspect = async (session, ref) => {
    const { backendNodeId } = session.refs.resolve(ref);
    const info = await (async () => {
        const { object } = await session.agentSend("DOM.resolveNode", { backendNodeId, objectGroup: OBJECT_GROUP });
        const { result, exceptionDetails } = await session.agentSend("Runtime.callFunctionOn", {
            objectId: object.objectId, functionDeclaration: INSPECT, returnByValue: true, objectGroup: OBJECT_GROUP,
        });
        return exceptionDetails ? null : result?.value;
    })().catch(unlessGone);
    if (!info?.connected) throw staleRef();
    return { ref, backendNodeId, ...info };
};

const assertOrigins = (field, allowed) => {
    if ([field.origin, ...field.ancestors].every((origin) => allowed.has(normalizeOrigin(origin)))) return;
    const where = field.ancestors.length > 0 ? `${field.origin}, embedded in ${field.ancestors.join(" < ")}` : field.origin;
    throw new VaultError(VaultErrorCode.ORIGIN_MISMATCH,
        `${field.ref} is in a frame of ${where}, but this entry only fills on ${[...allowed].join(", ")}. Open the entry's login page directly; an embedding origin has to be added to the entry by the user.`);
};

const checkFillTarget = async (session, { passwordRef, usernameRef = null }, origins) => {
    const allowed = new Set(origins.map(normalizeOrigin).filter(Boolean));
    try {
        const password = await inspect(session, passwordRef);
        const username = usernameRef ? await inspect(session, usernameRef) : null;
        assertOrigins(password, allowed);
        if (username) assertOrigins(username, allowed);
        if (!password.input || password.type !== "password")
            throw new VaultError(VaultErrorCode.NOT_PASSWORD_FIELD,
                `${passwordRef} is not an <input type="password">; pass the ref of the password field from the latest snapshot.`);
        if (username && (!username.input || !USERNAME_TYPES.has(username.type) || username.origin !== password.origin))
            throw new VaultError(VaultErrorCode.BAD_USERNAME_FIELD,
                `${usernameRef} is not a text, email or tel input in the frame of the password field; pass another usernameRef or leave it out.`);
        return { passwordNodeId: password.backendNodeId, usernameNodeId: username?.backendNodeId ?? null };
    } finally {
        session.send("Runtime.releaseObjectGroup", { objectGroup: OBJECT_GROUP }).catch(() => {});
    }
};

const focusedNodeId = async (session) => {
    const top = await session.agentSend("Runtime.evaluate", { expression: "document", objectGroup: OBJECT_GROUP });
    let objectId = top.result?.objectId;
    for (let depth = 0; objectId && depth < MAX_FRAME_DEPTH; depth++) {
        const { result: active } = await session.agentSend("Runtime.callFunctionOn", { objectId, functionDeclaration: DEEPEST_ACTIVE, objectGroup: OBJECT_GROUP });
        if (!active?.objectId) return null;
        const { node } = await session.agentSend("DOM.describeNode", { objectId: active.objectId, depth: 1, pierce: true });
        if (!FRAME_OWNERS.has(node.nodeName)) return node.backendNodeId;
        if (!node.contentDocument) return null;
        ({ object: { objectId } } = await session.agentSend("DOM.resolveNode", { backendNodeId: node.contentDocument.backendNodeId, objectGroup: OBJECT_GROUP }));
    }
    return null;
};

const typeInto = async (session, backendNodeId, text, beforeInsert) => {
    await session.agentSend("DOM.focus", { backendNodeId }).catch((err) => {
        if (GONE.test(err?.message ?? "")) throw staleRef();
        throw new VaultError(VaultErrorCode.FOCUS_LOST, "The field cannot take the focus (hidden or disabled); nothing was typed into it. Take a new snapshot and pass the visible field.");
    });
    await (async () => {
        const { object } = await session.agentSend("DOM.resolveNode", { backendNodeId, objectGroup: OBJECT_GROUP });
        await session.agentSend("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: CLEAR, objectGroup: OBJECT_GROUP });
    })().catch(unlessGone);
    if ((await focusedNodeId(session)) !== backendNodeId)
        throw new VaultError(VaultErrorCode.FOCUS_LOST,
            "The page moved the focus away from the field before typing; nothing was typed into it. Take a new snapshot and call browser_fill_credential again.");
    beforeInsert();
    await session.agentSend("Input.insertText", { text });
};

const fillCredential = async (session, { passwordNodeId, usernameNodeId = null, username = null, password }) => {
    let marked = false;
    // markFilled checks the taint in the same synchronous step, so no browser_evaluate in a popup of
    // this context can slip in between the check and the first keystroke. Only the password field is
    // marked: a filled field that is no longer type=password locks screenshots.
    const markOnce = () => {
        if (marked) return;
        if (session.closed)
            throw new BrowserError(BrowserErrorCode.SESSION_CLOSED, `Session ${session.id} has ended; nothing was typed. Open a new session with browser_open and fill there.`);
        vaultGuard.markFilled(session.contextKey, { targetId: session.targetId, backendNodeIds: [passwordNodeId], secret: password });
        marked = true;
    };
    try {
        if (usernameNodeId !== null) await typeInto(session, usernameNodeId, username, markOnce);
        await typeInto(session, passwordNodeId, password, markOnce);
    } finally {
        session.send("Runtime.releaseObjectGroup", { objectGroup: OBJECT_GROUP }).catch(() => {});
    }
};

module.exports = { checkFillTarget, fillCredential, assertFillableSession, normalizeOrigin };
```

- [ ] **Step 5: Implement `server/lib/vault/mcpProvider.js`**

```js
const { VaultError, VaultErrorCode } = require("./errors");
const { isVaultEnabled } = require("./state");
const { itemRef, visibleItems, findVisibleItem, canUseVault } = require("./visibility");
const { readSecret } = require("./secrets");
const { checkFillTarget, fillCredential, assertFillableSession, normalizeOrigin } = require("./fill");
const { defaultAudit } = require("../browser/tools");
const vaultGuard = require("../browser/vaultGuard");
const { BrowserError, BrowserErrorCode } = require("../browser/errors");
const permission = require("../../utils/permission");
const { Permission } = require("../../permissions/registry");
const VaultItem = require("../../models/VaultItem");
const ApiKey = require("../../models/ApiKey");
const Organization = require("../../models/Organization");
const Entry = require("../../models/Entry");
const logger = require("../../utils/logger");

const LIST = "vault_list";
const FILL = "browser_fill_credential";
const FILL_WINDOW_MS = 60 * 1000;
const FILL_LIMIT = 20;
const REF_PATTERN = /^e\d{1,9}$/;
const APPROVAL_CODES = new Set([
    VaultErrorCode.APPROVAL_TIMEOUT, VaultErrorCode.APPROVAL_UNAVAILABLE, VaultErrorCode.APPROVAL_PENDING,
    VaultErrorCode.APPROVAL_BUSY, VaultErrorCode.APPROVAL_DENIED, VaultErrorCode.CLIENT_GONE,
]);
const DENIAL_ACTIONS = {
    [VaultErrorCode.ITEM_UNREADABLE]: "vault.item_unreadable",
    [VaultErrorCode.PERSISTENT_NOT_ALLOWED]: "vault.persistent_not_allowed",
};

const TOOL_DEFS = [
    {
        name: LIST,
        description: "List the vault entries this connection may use. Never returns a secret value: per entry its id for browser_fill_credential (item), owner, type, username or host, origins or hosts, whether the user approves each use, and the tools that can use it (usableBy).",
        inputSchema: { type: "object", properties: {} },
    },
    {
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
];

const textResult = (text) => ({ content: [{ type: "text", text }] });
const errorResult = (err) => ({
    isError: true,
    content: [{ type: "text", text: err instanceof VaultError ? `${err.message} (${err.code})` : err.message }],
});
const fieldsOf = (item) => item.fields ?? {};
const originsKey = (fields) => JSON.stringify((fields.origins ?? []).map(normalizeOrigin).sort());

const describeItem = (item, orgNames, canFill) => {
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
        approvalRequired: !!item.approvalRequired,
        usableBy: item.type === "login" && canFill ? [FILL] : [],
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

const createVaultProvider = ({ getBrowserTools, approvals = require("./approvals"), audit = defaultAudit }) => {
    const browserAllowed = new WeakMap();
    const recentFills = new Map();

    const canUseBrowser = (accountId) => permission.hasAccountPermission(accountId, Permission.CONNECT_BROWSER);

    const assertFillRate = ({ accountId, keyId = null }) => {
        const key = `${accountId}:${keyId}`;
        const now = Date.now();
        const recent = (recentFills.get(key) ?? []).filter((at) => now - at < FILL_WINDOW_MS);
        if (recent.length >= FILL_LIMIT)
            throw new VaultError(VaultErrorCode.RATE_LIMITED);
        recent.push(now);
        recentFills.set(key, recent);
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

    const describeCall = (note, ctx) => ({
        item: note.item, sessionId: note.sessionId, target: note.target,
        agentType: ctx.agent?.agentType ?? null, keyId: ctx.keyId ?? null, entryId: ctx.agent?.entryId ?? null,
    });

    const listItems = async (args, ctx) => {
        const items = await visibleItems({ accountId: ctx.accountId, agent: ctx.agent ?? null });
        const orgIds = [...new Set(items.map((item) => item.organizationId).filter(Boolean))];
        const orgs = orgIds.length > 0 ? await Organization.findAll({ where: { id: orgIds }, attributes: ["id", "name"] }) : [];
        const orgNames = new Map(orgs.map((org) => [org.id, org.name]));
        const canFill = await canUseBrowser(ctx.accountId);
        return textResult(items.length > 0
            ? JSON.stringify(items.map((item) => describeItem(item, orgNames, canFill)), null, 2)
            : "No vault entries are available to this connection.");
    };

    const fill = async (args, ctx) => {
        assertFillArgs(args);
        assertFillRate(ctx);
        const note = { item: args.item, sessionId: null, target: null, stage: "before_approval" };
        const caller = { accountId: ctx.accountId, agent: ctx.agent ?? null };
        const usernameRef = args.usernameRef ?? null;
        const refs = { passwordRef: args.passwordRef, usernameRef };
        let item = null;
        let fields = {};
        let session = null;
        let approval = null;
        let auditedByApprovals = false;
        const loadItem = async () => {
            item = await findVisibleItem(caller, args.item);
            fields = fieldsOf(item);
            note.item = itemRef(item);
            if (item.type !== "login")
                throw new VaultError(VaultErrorCode.WRONG_TYPE, `${note.item} is a ${item.type} entry; browser_fill_credential fills login entries only.`);
            if (usernameRef && !fields.username)
                throw new VaultError(VaultErrorCode.BAD_USERNAME_FIELD, `${note.item} stores no username; call again without usernameRef.`);
        };
        const locate = (sessionId) => getBrowserTools().resolveSession(ctx, sessionId);
        const verify = (current) => {
            assertFillableSession(current);
            return checkFillTarget(current, refs, fields.origins ?? []);
        };
        try {
            await loadItem();
            session = locate(args.sessionId ?? null);
            Object.assign(note, { sessionId: session.id, target: normalizeOrigin(session.state.url) });
            if (item.approvalRequired || ctx.impersonatorId != null) {
                await session.runAgent(FILL, () => verify(session));
                // Waited for outside runAgent: its 90 s limit is shorter than the 2 minutes of an approval,
                // so every check runs again afterwards, with the entry and the key as they are now.
                approval = await approvals.requestApproval({
                    accountId: ctx.accountId, keyId: ctx.keyId ?? null, transportId: ctx.transportId,
                    agentType: ctx.agent?.agentType ?? null, entryName: await entryNameOf(ctx.agent),
                    item, target: note.target, signal: ctx.signal,
                }).catch((err) => {
                    // approvals.js audits answers, timeouts and withdrawn cards itself; only early refusals come back unaudited.
                    auditedByApprovals = APPROVAL_CODES.has(err?.code) && !err.details?.early;
                    throw err;
                });
                note.stage = "after_approval";
                if (ctx.signal?.aborted) throw new VaultError(VaultErrorCode.CLIENT_GONE);
                if (!(await keyStillValid(ctx)))
                    throw new VaultError(VaultErrorCode.ITEM_UNKNOWN, "The key of this connection was revoked while the approval was open; nothing was filled.");
                const approvedOrigins = originsKey(fields);
                await loadItem();
                if (originsKey(fields) !== approvedOrigins)
                    throw new VaultError(VaultErrorCode.ORIGIN_MISMATCH,
                        `The origins of ${note.item} changed while the approval was open; nothing was filled. Call browser_fill_credential again so the user approves the entry as it is now.`);
                session = locate(session.id);
            }
            await session.runAgent(FILL, async () => {
                const nodes = await verify(session);
                const password = await readSecret(item.id, "password");
                if (password === null)
                    throw new VaultError(VaultErrorCode.NO_SECRET);
                await fillCredential(session, { ...nodes, username: usernameRef ? fields.username : null, password });
            });
        } catch (err) {
            if (session && typeof err?.message === "string") err.message = vaultGuard.redactText(session.contextKey, err.message);
            if (!auditedByApprovals) {
                if (err?.code === VaultErrorCode.ITEM_UNREADABLE) logger.warn("Vault entry unreadable", { itemId: item?.id ?? null });
                await record(ctx, item, DENIAL_ACTIONS[err?.code] ?? "vault.use_denied", {
                    ...describeCall(note, ctx), stage: note.stage, code: typeof err?.code === "string" ? err.code : "INTERNAL",
                });
            }
            throw err;
        }
        await record(ctx, item, "vault.use", { ...describeCall(note, ctx), approval });
        // silent: updatedAt is part of the stamp of a session approval (Task 6); touching it would end that approval after every fill.
        await VaultItem.update({ lastUsedAt: new Date() }, { where: { id: item.id }, silent: true })
            .catch((err) => logger.warn("Could not record the last use of a vault entry", { itemId: item.id, error: err.message }));
        return textResult(usernameRef ? `Benutzername und Passwort von ${note.item} eingetragen.` : `Passwort von ${note.item} eingetragen.`);
    };

    const handlers = { [LIST]: listItems, [FILL]: fill };

    return {
        name: "vault",
        available: async (ctx) => {
            if (!isVaultEnabled()) return false;
            const [canUse, browser] = await Promise.all([canUseVault(ctx.accountId), canUseBrowser(ctx.accountId)]);
            browserAllowed.set(ctx, browser);
            return canUse;
        },
        list: (ctx) => (browserAllowed.get(ctx) === true ? TOOL_DEFS : TOOL_DEFS.filter((tool) => tool.name !== FILL)),
        has: (name, ctx) => name === LIST || (name === FILL && browserAllowed.get(ctx) === true),
        call: async (name, args, ctx) => {
            try {
                if (!Object.hasOwn(handlers, name) || (name === FILL && !(await canUseBrowser(ctx.accountId))))
                    throw new BrowserError(BrowserErrorCode.INVALID_ARGUMENT, `Unknown tool: ${name}`);
                return await handlers[name](args ?? {}, ctx);
            } catch (err) {
                if (err instanceof VaultError || err instanceof BrowserError) return errorResult(err);
                logger.warn("Vault tool failed", { tool: name, error: err.message });
                return errorResult(new BrowserError(BrowserErrorCode.INTERNAL, `${name} failed unexpectedly; try again.`));
            }
        },
        forgetTransport: (transportId) => approvals.forgetTransport(transportId),
    };
};

module.exports = { createVaultProvider };
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test server/lib/vault/__tests__/mcpProvider.test.js`
Expected: PASS, `# tests 6`, `# pass 6`, `# fail 0`.

- [ ] **Step 7: Vault-Anbieter in `server/routes/mcp.js` registrieren**

Vorher (Stand nach Task 2, Kopf der Datei):

```js
const { createMcpServer } = require("../lib/mcp/server");
const { createBrowserTools } = require("../lib/browser/tools");
const { getBrowserPool } = require("../lib/browser");
const logger = require("../utils/logger");

const browserTools = createBrowserTools({ getPool: getBrowserPool });
const browserProvider = {
    ...browserTools,
    name: "browser",
    available: (ctx) => hasAccountPermission(ctx.accountId, Permission.CONNECT_BROWSER),
};

const mcp = createMcpServer({ providers: [browserProvider] });
```

Nachher:

```js
const { createMcpServer } = require("../lib/mcp/server");
const { createBrowserTools } = require("../lib/browser/tools");
const { getBrowserPool } = require("../lib/browser");
const { createVaultProvider } = require("../lib/vault/mcpProvider");
const logger = require("../utils/logger");

const browserTools = createBrowserTools({ getPool: getBrowserPool });
const browserProvider = {
    ...browserTools,
    name: "browser",
    available: (ctx) => hasAccountPermission(ctx.accountId, Permission.CONNECT_BROWSER),
};
const vaultProvider = createVaultProvider({ getBrowserTools: () => browserTools });

const mcp = createMcpServer({ providers: [browserProvider, vaultProvider] });
```

`approvals.forgetTransport` läuft über `vaultProvider.forgetTransport`, das der Rahmen beim Ende, beim Verdrängen und beim Aufräumen eines Transports für jeden Anbieter ruft.

`server/lib/mcp/__tests__/mcpRoute.test.js` (aus Task 2) lädt die Route jetzt mit dem Vault-Anbieter; ohne Fake zöge `mcpProvider` Modelle und Datenbank nach. Die Route lädt nur `mcpProvider`, deshalb genügt dieser eine Fake. Direkt nach der Zeile `fake("../../browser/tools", { … });` und vor `const router = require("../../../routes/mcp");` einfügen:

```js
fake("../../vault/mcpProvider", {
    createVaultProvider: () => ({
        name: "vault", available: async () => false, list: () => [], has: () => false,
        call: async () => ({ content: [] }), forgetTransport: () => {},
    }),
});
```

Run: `node --test server/lib/mcp/__tests__/server.test.js server/lib/mcp/__tests__/mcpRoute.test.js server/lib/vault/__tests__/mcpProvider.test.js`
Expected: PASS, `# fail 0`.

Run: `node -e "require('./server/routes/mcp')"` (aus `/root/outpost`)
Expected: kein Fehler (die Route lädt mit beiden Anbietern).

- [ ] **Step 8: Chromium-Reihe — `require`-Zeilen, Testseiten und Helfer**

In `server/lib/browser/__tests__/chromium.e2e.test.js` direkt nach Z. 8 (`const { createFakeViewer, flush } = require("./helpers/fakeCdp");`) einfügen; `vaultBed` muss vor `mcpProvider` geladen werden:

```js
const vaultBed = require("../../vault/__tests__/helpers/vaultBed");
const { createVaultProvider } = require("../../vault/mcpProvider");
const { createBrowserTools } = require("../tools");
const { click: rawClick } = require("../actions");
const { Permission } = require("../../../permissions/registry");
```

Nach Z. 22 (`const sleep = …`) einfügen:

```js
const SECRET = "pa ss&wörd+1";
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const LOGIN_PAGE = `<!doctype html><title>Vault login</title>
<h1>Sign in</h1>
<form method="get" action="/done">
<input name="user" aria-label="User">
<input name="pass" id="pass" type="password" aria-label="Password">
<button type="button" onclick="const f = document.getElementById('pass'); f.type = f.type === 'password' ? 'text' : 'password'">Show password</button>
<button type="submit">Sign in</button>
</form>
<button type="button" onclick="window.open('/popup', 'vault-popup', 'width=400,height=300')">Open popup</button>`;
const POPUP_PAGE = "<!doctype html><title>Vault popup</title><h1>Popup</h1>";
const FRAME_FIELD = `<!doctype html><title>Frame field</title>
<input name="pass" type="password" aria-label="Frame password">`;
const framePage = (src) => `<!doctype html><title>Frame host</title>
<h1>Frame host</h1>
<iframe src="${src}" width="600" height="320"></iframe>`;
const donePage = (url) => `<!doctype html><title>Signed in ${escapeHtml(new URL(url, "http://page.invalid").searchParams.get("pass") ?? "")}</title>
<h1>Signed in</h1>
<a href="/login">Back</a>`;

const startVaultPages = async (t) => {
    const bases = {};
    const serve = (other) => http.createServer((req, res) => {
        const pages = {
            "/login": () => LOGIN_PAGE,
            "/popup": () => POPUP_PAGE,
            "/frame": () => FRAME_FIELD,
            "/done": () => donePage(req.url),
            "/framed-self": () => framePage("/login"),
            "/frame-other": () => framePage(`${bases[other]}/frame`),
            "/embed-other": () => framePage(`${bases[other]}/login`),
        };
        const page = pages[req.url.split("?")[0]];
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(page ? page() : "<!doctype html><title>Not found</title>");
    });
    for (const [name, server] of [["a", serve("b")], ["b", serve("a")]]) {
        await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
        t.after(() => server.close());
        bases[name] = `http://${PAGE_HOST}:${server.address().port}`;
    }
    return bases;
};

const startVaultBed = async (t) => {
    process.env.VAULT_KEY ??= "5a".repeat(32);
    const bases = await startVaultPages(t);
    const pool = new BrowserPool({
        getSettings: async () => ({ enabled: true, maxSessions: 8, idleMinutes: 30, callbackHost: PAGE_HOST }),
        launcher: createLauncherClient(async () => LAUNCHER),
        // A via instance without a tunnel: enough for the refusal, which never reaches the network.
        createVia: async () => ({ label: "nas", organizationId: null, resolverRule: null, close() {} }),
    });
    t.after(() => {
        for (const instance of pool.live.values()) instance.cdp.close();
    });
    const audit = [];
    const record = async (entry) => { audit.push(entry); };
    const browserTools = createBrowserTools({ getPool: () => pool, audit: record });
    const vault = createVaultProvider({
        getBrowserTools: () => browserTools, audit: record,
        approvals: { requestApproval: async () => "once", forgetTransport() {} },
    });
    vaultBed.reset({
        items: [{
            id: 41, accountId: 1, organizationId: null, name: "e2e-login", type: "login", description: null,
            fields: { username: "ada", origins: [bases.a] }, approvalRequired: false, allServers: true,
        }],
        secrets: { "41:password": SECRET },
        permissions: [Permission.VAULT_USE, Permission.CONNECT_BROWSER],
    });
    const ctx = { accountId: 1, keyId: null, agent: null, impersonatorId: null, transportId: "e2e", ipAddress: "127.0.0.1", userAgent: "e2e", signal: new AbortController().signal };
    const call = (provider, name, args) => provider.call(name, args, ctx);
    const open = async (url, options = {}) => {
        const { session } = await pool.open({ accountId: 1, url, ...options });
        await session.settle();
        return session;
    };
    return {
        bases, pool, audit, browserTools, call, open,
        text: (result) => result.content.map((c) => c.text ?? "").join(""),
        snapshotOf: (session) => session.runAgent("browser_snapshot", () => session.snapshot()),
        fill: (session, args) => call(vault, "browser_fill_credential", { item: "e2e-login", sessionId: session.id, ...args }),
    };
};

// Raw CDP: reads the page past the evaluate lock, which only guards the agent's tools.
const valueIn = async (session, expression) => (await session.send("Runtime.evaluate", { expression, returnByValue: true })).result.value;

const until = async (probe, ms = 5000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
        const value = await probe();
        if (value) return value;
    }
    throw new Error("timed out");
};

const attributeOf = (node, name) => {
    const list = node.attributes ?? [];
    for (let i = 0; i < list.length; i += 2) if (list[i] === name) return list[i + 1];
    return null;
};

// The snapshot covers the main frame only; a ref into a frame is taken from the DOM, as a page could
// hand one out once frames are part of the snapshot.
const refInDocument = async (session, documentUrl, name) => {
    const { root } = await session.send("DOM.getDocument", { depth: -1, pierce: true });
    const stack = [[root, root.documentURL]];
    while (stack.length > 0) {
        const [node, url] = stack.pop();
        const here = node.nodeName === "#document" ? node.documentURL : url;
        if (node.nodeName === "INPUT" && here === documentUrl && attributeOf(node, "name") === name)
            return session.refs.assign(node.backendNodeId, `textbox "${name}"`);
        for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? []), ...(node.contentDocument ? [node.contentDocument] : [])])
            stack.push([child, here]);
    }
    throw new Error(`no input ${name} in ${documentUrl}; the frame may run out of process`);
};

const openPopup = async ({ pool, browserTools, call }, opener, buttonRef) => {
    const before = new Set(pool.listForAccount(1).map((s) => s.id));
    await call(browserTools, "browser_click", { sessionId: opener.id, ref: buttonRef });
    return until(() => pool.listForAccount(1).map((s) => s.id).find((id) => !before.has(id)));
};

const refused = (text, result, code) => {
    assert.strictEqual(result.isError, true, `expected ${code}, got: ${text(result)}`);
    assert.ok(text(result).includes(code), text(result));
};
```

- [ ] **Step 9: Chromium-Reihe — Spec-Test 7 am Dateiende**

```js
test("against a real Chromium: browser_fill_credential fills a matching origin and refuses foreign origins and frames, via, persistent and tainted contexts",
    { skip: !LAUNCHER && "set OUTPOST_BROWSER_E2E_LAUNCHER and OUTPOST_BROWSER_E2E_PAGE_HOST" }, async (t) => {
        const bed = await startVaultBed(t);
        const { bases, pool, browserTools, call, open, text, snapshotOf, fill } = bed;
        const PASS = "document.getElementById('pass').value";

        const own = await open(`${bases.a}/login`);
        let snapshot = await snapshotOf(own);
        const filled = await fill(own, { usernameRef: refOf(snapshot, 'textbox "User"'), passwordRef: refOf(snapshot, 'textbox "Password"') });
        assert.strictEqual(text(filled), "Benutzername und Passwort von e2e-login eingetragen.");
        assert.deepStrictEqual([await valueIn(own, "document.querySelector('[name=user]').value"), await valueIn(own, PASS)], ["ada", SECRET]);
        await pool.close(own.id, "test");

        const framed = await open(`${bases.a}/framed-self`);
        const inFrame = await fill(framed, { passwordRef: await refInDocument(framed, `${bases.a}/login`, "pass") });
        assert.strictEqual(text(inFrame), "Passwort von e2e-login eingetragen.", "the focus check follows the focus into a frame of the same origin");
        assert.strictEqual(await valueIn(framed, "document.querySelector('iframe').contentDocument.getElementById('pass').value"), SECRET);
        await pool.close(framed.id, "test");

        const foreign = await open(`${bases.b}/login`);
        snapshot = await snapshotOf(foreign);
        refused(text, await fill(foreign, { passwordRef: refOf(snapshot, 'textbox "Password"') }), "vault.origin_mismatch");
        assert.strictEqual(await valueIn(foreign, PASS), "");
        await pool.close(foreign.id, "test");

        const foreignFrame = await open(`${bases.a}/frame-other`);
        refused(text, await fill(foreignFrame, { passwordRef: await refInDocument(foreignFrame, `${bases.b}/frame`, "pass") }), "vault.origin_mismatch");
        await pool.close(foreignFrame.id, "test");

        const embedded = await open(`${bases.b}/embed-other`);
        refused(text, await fill(embedded, { passwordRef: await refInDocument(embedded, `${bases.a}/login`, "pass") }), "vault.origin_mismatch");
        assert.strictEqual(await valueIn(embedded, "document.querySelector('iframe') !== null"), true);
        await pool.close(embedded.id, "test");

        const wrongField = await open(`${bases.a}/login`);
        snapshot = await snapshotOf(wrongField);
        refused(text, await fill(wrongField, { passwordRef: refOf(snapshot, 'textbox "User"') }), "vault.not_password_field");
        assert.strictEqual(await valueIn(wrongField, "document.querySelector('[name=user]').value"), "");
        await pool.close(wrongField.id, "test");

        for (const [options, code] of [[{ via: "nas" }, "vault.via_not_allowed"], [{ profile: "persistent" }, "vault.persistent_not_allowed"]]) {
            const session = await open(`${bases.a}/login`, options);
            snapshot = await snapshotOf(session);
            refused(text, await fill(session, { passwordRef: refOf(snapshot, 'textbox "Password"') }), code);
            assert.strictEqual(await valueIn(session, PASS), "");
            await pool.close(session.id, "test");
        }

        const opener = await open(`${bases.a}/login`);
        snapshot = await snapshotOf(opener);
        const popupId = await openPopup(bed, opener, refOf(snapshot, 'button "Open popup"'));
        assert.ok(!(await call(browserTools, "browser_evaluate", { sessionId: popupId, expression: "document.title" })).isError);
        await call(browserTools, "browser_close", { sessionId: popupId });
        refused(text, await fill(opener, { passwordRef: refOf(snapshot, 'textbox "Password"') }), "vault.session_tainted");
        assert.strictEqual(await valueIn(opener, PASS), "");
        await pool.close(opener.id, "test");
    });
```

- [ ] **Step 10: Chromium-Reihe — Spec-Test 8, Review Focus 1 und Spec-Test 12 am Dateiende**

```js
test("against a real Chromium: after a fill the password stays out of evaluate, snapshots, screenshots, URL, Title, browser_list, audit and the selection",
    { skip: !LAUNCHER && "set OUTPOST_BROWSER_E2E_LAUNCHER and OUTPOST_BROWSER_E2E_PAGE_HOST" }, async (t) => {
        const bed = await startVaultBed(t);
        const { bases, pool, audit, browserTools, call, open, text, snapshotOf, fill } = bed;
        const session = await open(`${bases.a}/login`);
        const snapshot = await snapshotOf(session);
        const ref = (label) => refOf(snapshot, label);
        const tool = (name, args = {}) => call(browserTools, name, { sessionId: session.id, ...args });

        const filled = await fill(session, { usernameRef: ref('textbox "User"'), passwordRef: ref('textbox "Password"') });
        assert.ok(!filled.isError, text(filled));

        refused(text, await tool("browser_key", { key: "Control+a" }), "vault.input_locked");
        refused(text, await tool("browser_click", { ref: ref('textbox "Password"'), clickCount: 3 }), "vault.input_locked");
        const again = await fill(session, { usernameRef: ref('textbox "User"'), passwordRef: ref('textbox "Password"') });
        assert.ok(!again.isError, text(again));
        assert.deepStrictEqual([await valueIn(session, "document.querySelector('[name=user]').value"), await valueIn(session, "document.getElementById('pass').value")],
            ["ada", SECRET], "a second fill clears the fields instead of selecting their content");
        const elsewhere = await open(`${bases.b}/login`);
        const otherUser = refOf(await snapshotOf(elsewhere), 'textbox "User"');
        refused(text, await call(browserTools, "browser_click", { sessionId: elsewhere.id, ref: otherUser, button: "middle" }), "vault.input_locked");
        // Past the guard, as the user's own middle click would: the shared primary selection must not hold the password.
        await rawClick(elsewhere.send, elsewhere.refs.resolve(otherUser).backendNodeId, { button: "middle" });
        assert.ok(!(await valueIn(elsewhere, "document.querySelector('[name=user]').value")).includes(SECRET), "a middle click in another context pastes no password");
        const probe = await open(`${bases.b}/login`);
        const probeUser = refOf(await snapshotOf(probe), 'textbox "User"');
        await valueIn(probe, "document.querySelector('[name=user]').value = 'primary-probe'");
        await rawClick(probe.send, probe.refs.resolve(probeUser).backendNodeId, { clickCount: 3 });
        await rawClick(elsewhere.send, elsewhere.refs.resolve(otherUser).backendNodeId, { button: "middle" });
        if (!(await valueIn(elsewhere, "document.querySelector('[name=user]').value")).includes("primary-probe"))
            t.diagnostic("middle-click paste of a selection from another context did not work in this Chromium, so the check above shows nothing; repeat it in the manual acceptance");
        await pool.close(probe.id, "test");
        await pool.close(elsewhere.id, "test");

        assert.ok(!(await tool("browser_screenshot")).isError, "a screenshot is allowed while the filled field still hides its value");
        assert.strictEqual((await tool("browser_evaluate", { expression: "document.title = 'evaluated'" })).isError, true);
        const popupId = await openPopup(bed, session, ref('button "Open popup"'));
        const fromPopup = await call(browserTools, "browser_evaluate", { sessionId: popupId, expression: "window.opener.document.title = 'evaluated'" });
        assert.strictEqual(fromPopup.isError, true, "the popup shares the filled context");
        assert.strictEqual(await valueIn(session, "document.title"), "Vault login");
        await call(browserTools, "browser_close", { sessionId: popupId });

        const shown = await tool("browser_click", { ref: ref('button "Show password"') });
        assert.strictEqual(await valueIn(session, "document.getElementById('pass').type"), "text");
        assert.match(text(shown), /- textbox "Password" \[ref=e\d+\] value="••••"/);
        assert.ok(!text(shown).includes(SECRET));
        assert.strictEqual((await tool("browser_screenshot")).isError, true, "the shown password must not reach a screenshot");

        // What a PATCH with a changed origin does: the entry's stored values are gone.
        vaultBed.state.secrets.clear();
        await tool("browser_click", { ref: ref('button "Sign in"') });
        const after = await tool("browser_snapshot");
        assert.match(text(after), /URL: \S*pass=••••/);
        assert.match(text(after), /Title: Signed in ••••/);
        const listed = await call(browserTools, "browser_list", {});
        await tool("browser_click", { ref: refOf(text(after), 'link "Back"') });

        const leaks = [SECRET, encodeURIComponent(SECRET), new URLSearchParams({ pass: SECRET }).toString().slice("pass=".length)];
        for (const [where, output] of [["snapshot", text(after)], ["browser_list", text(listed)], ["audit", JSON.stringify(audit)]])
            for (const leak of leaks) assert.ok(!output.includes(leak), `${where} contains the password as ${leak}`);
        await pool.close(session.id, "test");
    });
```

- [ ] **Step 11: Chromium-Reihe ausführen**

Run (ohne Umgebung): `node --test server/lib/browser/__tests__/chromium.e2e.test.js`
Expected: `# fail 0`, `# tests 4`, `# skipped 4` (der Bestandstest, der aus Task 9 und die zwei dieses Tasks), die Datei lädt mit den neuen Modulen.

Run (mit laufendem `outpost-browser`-Container): `OUTPOST_BROWSER_E2E_LAUNCHER=<Launcher-Adresse wie unter Einstellungen › Browser> OUTPOST_BROWSER_E2E_PAGE_HOST=<vom Container aus erreichbare Adresse dieses Rechners> node --test server/lib/browser/__tests__/chromium.e2e.test.js`
Expected: `# pass 4`, `# fail 0`. Schlägt `refInDocument` mit „the frame may run out of process“ fehl, läuft das iframe in einem eigenen Prozess; dann erreicht auch ein Agent dessen Felder nicht. Der Test braucht dann für `a` und `b` denselben Host mit verschiedenen Ports (eine Site) und keinen zweiten Hostnamen.

- [ ] **Step 12: Betroffene Tests gemeinsam ausführen**

Run: `node --test server/lib/vault/__tests__/mcpProvider.test.js server/lib/mcp/__tests__/server.test.js server/lib/mcp/__tests__/mcpRoute.test.js server/lib/browser/__tests__/tools.test.js server/lib/browser/__tests__/vaultGuard.test.js server/lib/browser/__tests__/agentScope.test.js server/lib/browser/__tests__/chromium.e2e.test.js`
Expected: `# fail 0`.

Run: `yarn lint`
Expected: keine Fehler in `server/lib/vault/fill.js`, `server/lib/vault/mcpProvider.js`, `server/routes/mcp.js` und den Testdateien.

- [ ] **Step 13: Commit**

```bash
git add server/lib/vault/fill.js server/lib/vault/mcpProvider.js server/lib/vault/__tests__/helpers/vaultBed.js server/lib/vault/__tests__/mcpProvider.test.js server/routes/mcp.js server/lib/mcp/__tests__/mcpRoute.test.js server/lib/browser/__tests__/chromium.e2e.test.js
git commit -m "Vault: MCP-Werkzeuge vault_list und browser_fill_credential"
```

---

### Task 16: CSP Report-Only, Einbettungsschutz und Doku

**Files:**
- Modify: `server/lib/staticSite.js` (`mountStaticSite` Z. 13-19 bekommt als erste Middleware `setContentSecurityPolicy`; neu darüber `HOST_PATTERN`, `FRAME_ANCESTORS`, `buildContentSecurityPolicy`, `setContentSecurityPolicy`). Das ist die einzige Stelle, die das Client-`index.html` und die Assets ausliefert: `server/index.js` ruft `mountStaticSite(app, path.join(__dirname, "../dist"))` nur bei `NODE_ENV === "production"`, nach allen `/api`-Mounts (heute Z. 121-122; Tasks 1 und 8 verschieben die Nummern, maßgeblich ist der Code-Anker `mountStaticSite(app,`); `express.static` liefert `/` und `/assets/*`, der Fallback `app.get("*name")` liefert `index.html` für jede Client-Route.
- Create: `server/routes/cspReport.js` (Router mit Rate-Limit, `express.json` für beide Report-Typen, Zusammenfassung, Fehler-Handler ohne Body)
- Modify: `server/index.js` (eine Zeile direkt nach dem Code-Anker `app.use("/api/auth", require("./routes/authProviders"));`, heute Z. 71, nach Tasks 1 und 8 verschoben: `app.use("/api/csp-report", require("./routes/cspReport"));`)
- Create: `server/lib/__tests__/cspHeader.test.js`
- Modify: `server/lib/fileContent/download.js` (`contentHeaders` Z. 21-31: Vorschau-Antworten außer PDF bekommen `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups`)
- Modify: `server/lib/fileContent/__tests__/download.test.js` (ein Test nach dem Test „a download is an attachment, a preview is inline…“ Z. 32-41)
- Create: `docs/vault.md`
- Modify: `docs/.vitepress/config.mjs` (Sidebar, nach Z. 88 `{ text: "Browser Tabs & Claude", link: "/browser-tabs" }`)

**Interfaces:**
- Consumes (nur für die Doku, kein Code): Fehlercodes `VaultErrorCode` aus `server/lib/vault/errors.js` inkl. `INPUT_LOCKED = "vault.input_locked"` und Audit-Aktion `vault.input_locked` (Task 1); Rechte `vault.use`, `vault.manage`, `vault.reveal`, `settings.vault` (Task 1); Sichtbarkeitsregeln und Kennung `org:<organizationId>/<name>` (Task 3); IP-Bindung, `probe`, `pending`, 15-min-Fenster, Abweisung von Agenten-Keys bei ausgeschaltetem Vault (`401`) und ohne Serverzugriff (`403`) in `rejectAgentKey`, `impersonatorId` in jedem Audit aus HTTP-Anfragen über `auditContext`, WebSocket-Audits (Terminal, SFTP, AI) noch ohne, und `POST /api/accounts/api-keys` hinter `requireLoginSession` (Task 4); `403 "Turning off approvals requires a signed-in session"` beim Abschalten von „Freigabe erforderlich“ (Task 5); `APPROVAL_TTL_MS = 120000`, Sperre 60 s, höchstens 3 offene Anfragen, Sitzungsfreigabe an den Eintragsstempel `updatedAt|origins` gebunden (Task 6); `browser_open` mit `profile: "persistent"` für Agenten-Keys → `INVALID_PROFILE`, `via` auf einen fremden Server → Browser-Fehler `VIA_NOT_ALLOWED` (Task 7); Einrichtungs- und Entfernbefehle aus `server/lib/vault/provision.js`, Probe nur bei erster Messung, `confirm` mit `addSeenIp` → `409`, wenn die Adresse des Bestätigenden gleich `seenIp` ist, Entziehen-Ergebnis `registration` `removed`/`foreign`/`unknown` mit `commands` (Task 8); Schwärzung/Sperren inkl. `vaultGuard.assertInputAllowed` (Task 9); Felder von `vault_list`, Prüfreihenfolge von `browser_fill_credential` inkl. `vault.via_not_allowed` für jede Sitzung mit `via` (`assertFillableSession`) und Nachprüfung nach der Freigabe (Task 11); englische Oberflächentexte aus `client/public/assets/locales/en.json` (Task 10).
- Produces:
  - `mountStaticSite(app, distDir)` — Signatur unverändert; setzt auf jeder Antwort der statischen Seite `X-Frame-Options: SAMEORIGIN` und die Policy: im Normalfall `Content-Security-Policy-Report-Only` mit allen Direktiven außer `frame-ancestors` plus ein erzwungenes `Content-Security-Policy: frame-ancestors 'self'`; mit `process.env.CSP_ENFORCE === "true"` (je Anfrage gelesen) stattdessen nur `Content-Security-Policy` mit allen Direktiven einschließlich `frame-ancestors 'self'`. Bei `req.secure` zusätzlich `Reporting-Endpoints: csp="/api/csp-report"`.
  - `POST /api/csp-report` ohne Authentifizierung, Rate-Limit 30/min je IP (`ipKeyGenerator`), nimmt `application/csp-report` und `application/reports+json` (Limit 64 kB) → `204`; ungültiges JSON → `400`, zu groß → `413`, beide ohne Body; über dem Limit `429 { code: 429, message: "Too many CSP reports" }`.
  - `require("./routes/cspReport")` ist der Router; zusätzlich `summarizeReports(body) → Array<{ document: string|null, blocked: string|null, directive: string|null, source: string|null, line: number|null, disposition: string|null }>` (höchstens 10 je Anfrage; URLs auf `origin + pathname` gekürzt, andere Schemata nur `data:`/`blob:` …, Felder ≤ 200 Zeichen; `directive` nur ein Name aus der festen Liste `DIRECTIVES`, sonst `"[other]"`; `disposition` nur `"enforce"` oder `"report"`, sonst `null`; `script-sample`/`sample`, `original-policy`, `referrer` fallen weg).
  - Umgebungsvariable `CSP_ENFORCE` (`"true"` = scharf).
  - `contentHeaders({ fileName, size, ext, preview })` (`server/lib/fileContent/download.js`) — Signatur unverändert; bei `preview && ext !== "pdf"` zusätzlich `"Content-Security-Policy": "sandbox allow-scripts allow-forms allow-popups"`. Wirkt für alle drei Aufrufer: die Vorschau-Route `GET /api/entries/sftp/preview/<token>/<pfad>` (`server/routes/sftp.js` Z. 125, `preview: true`) und den Download mit `preview=true` von SFTP und OneDrive (`server/routes/sftp.js`, `server/routes/oneDriveContent.js`).
  - `docs/vault.md`, Sidebar-Eintrag `{ text: "Vault", link: "/vault" }`.

**Design:** kein UI-Anteil.

**Tests:** 5 Tests in `server/lib/__tests__/cspHeader.test.js`, test-first (fester Vertrag: Header und Endpunkt), über die echte Naht `express()` + `express.json()` global + Mount `/api/csp-report` + `mountStaticSite` wie in `server/index.js`: (1) `index.html` unter `/` und einer Client-Route trägt `Content-Security-Policy-Report-Only` mit `report-uri /api/csp-report` und `wss://<host>` (ohne `frame-ancestors`), dazu erzwungen genau `Content-Security-Policy: frame-ancestors 'self'` und `X-Frame-Options: SAMEORIGIN` (SEC-CSP-01, Einbettungsschutz ab dem ersten Tag); (2) `CSP_ENFORCE=true` schickt die ganze Policy samt `frame-ancestors 'self'` als `Content-Security-Policy` und keinen Report-Only-Header; (3) ein gefälschter `Host` mit `;` hängt keine Direktive an; (4) der Meldeendpunkt nimmt beide Content-Types ohne Auth mit `204` an; (5) `summarizeReports` entfernt Query-Strings, Fragmente und Samples und lässt für `directive`/`disposition` nur Schlüsselwörter der festen Liste durch, damit `?sessionToken=` aus `/api/ws/state` und frei gewählte Feldinhalte nie ins Log gelangen (SEC-TOKEN-01). Dazu 1 Test in `server/lib/fileContent/__tests__/download.test.js`, test-first über `contentHeaders` (die Funktion ist die Naht, alle Vorschau-Routen übernehmen ihre Header unverändert): eine HTML-, SVG- und Bild-Vorschau trägt genau `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups`, eine PDF-Vorschau und ein Download tragen keinen `Content-Security-Policy`-Header (SEC-CSP-01, Vorschau in neuem Tab). Der bestehende `staticSite.test.js` und die übrigen Tests in `download.test.js` laufen mit und bleiben grün. **Nicht** getestet: das Rate-Limit (Zusage von express-rate-limit), die Log-Ausgabe selbst, jede einzelne Direktive (Konfigurationskonstante), die Doku (dafür Schritt mit `vitepress build` und Abgleich der Oberflächentexte). Abgedeckt: SEC-CSP-01, SEC-TOKEN-01 (Meldungen), SEC-RATE-01 (neuer offener Endpunkt), SEC-INPUT-01 (Typ- und Größenlimit), SEC-ERR-01 (Fehlerantworten ohne Body), SEC-SECRET-01 (Doku zu `VAULT_KEY`).

**Parallel:** none — einziger Task der Welle E. Die Doku beschreibt das gebaute Verhalten der Tasks 1–15 (Fehlercodes, Sperren, Freigabe- und Entziehen-Regeln) und Schritt 11 gleicht sie gegen das fertige `en.json` aus Task 10 ab; das geht erst, wenn Welle D (Task 11) gemergt ist. `server/index.js` haben Task 1 und Task 8 in früheren Wellen schon geändert, daher hier nur über Code-Anker. Task 17 (Welle F) wartet auf diesen Task.

**Begründung der Policy** (aus dem echten Bedarf, geprüft an `client/index.html`, `client/vite.config.js`, einem Probe-Build und den Abhängigkeiten in `client/package.json`):

| Direktive | Wert | Begründung (ein Satz) |
|---|---|---|
| `default-src` | `'self'` | Alles nicht eigens Genannte, auch die PDF-/HTML-Vorschau-iframes (`FilePreviewWindow.jsx:134,152`, gleiche Herkunft `/api/entries/…`) und Audio/Video, lädt nur von Outpost selbst. |
| `script-src` | `'self' 'wasm-unsafe-eval'` | Der Build hat kein Inline-Skript (nur `<script type="module" src="/assets/…">`), Monaco ist gebündelt (`loader.config({ monaco })`, kein CDN), und `asciinema-player` instanziiert sein base64-eingebettetes WebAssembly (`WebAssembly.instantiate` in `asciinema-player/dist/opts-*.js`) im Hauptthread. |
| `style-src` | `'self' 'unsafe-inline'` | React setzt `style`-Attribute (94 Stellen in `client/src`), Monaco und xterm legen zur Laufzeit `<style>`-Elemente an, und Styles führen keinen Code aus. |
| `img-src` | `'self' data: blob:` | Avatare (`LetterAvatar`) und Vorschaubilder kommen aus der eigenen API, Vite inlined kleine Bilder als `data:` (im Build `url(data:image/svg+xml…)`, `data:image/png`), und der Avatar-Zuschnitt lädt die gewählte Datei über `URL.createObjectURL` (`imageUtils.js:5`). |
| `font-src` | `'self' data:` | Schriften sind selbst gehostet (`@fontsource/plus-jakarta-sans` gebündelt, `client/public/assets/fonts/*/index.css` mit relativen `url(./…woff2)`, kein Google Fonts), und Vite inlined kleine WOFF-Dateien als `data:font/woff`. |
| `connect-src` | `'self' ws://<host> wss://<host>` | REST, `i18next-http-backend` und alle WebSockets (`getWebSocketUrl` baut `ws(s)://${window.location.host}/api/ws/…`) gehen an denselben Host; `<host>` steht ausdrücklich da, weil Browser nach CSP Level 2 `'self'` nicht auf `ws:`/`wss:` anwenden. |
| `worker-src` | `'self' blob:` | Monaco startet jeden Worker aus einer `blob:`-URL (`getWorkerBootstrapUrl` in `monaco-editor/esm/vs/platform/webWorker/browser/webWorkerServiceImpl.js`), die per `import()` die gebündelten `/assets/*.worker-*.js` lädt. |
| `object-src` | `'none'` | Outpost nutzt keine Plugins. |
| `base-uri` | `'self'` | Ein eingeschleustes `<base>` kann die relativen Bundle-Adressen nicht umbiegen. |
| `form-action` | `'self'` | Kein Formular postet an eine fremde Seite (im Client gibt es kein `<form action=…>`). |
| `frame-ancestors` | `'self'` | Keine fremde Seite bettet Outpost ein und lässt den Nutzer etwa auf „Einmal“ der Freigabe-Karte klicken (Clickjacking); weil eine Report-Only-Policy nie blockiert und ein Einbettungsangriff nicht auf die Auswertung warten soll, geht die Direktive schon im Report-Only-Modus als eigenes erzwungenes `Content-Security-Policy` hinaus (und fehlt in der Report-Only-Policy, damit nichts doppelt gemeldet wird), dazu `X-Frame-Options: SAMEORIGIN` für Browser ohne CSP Level 2. |
| `report-uri` / `report-to` | `/api/csp-report` / `csp` | `report-uri` für Firefox und Klartext-HTTP im LAN; `report-to` nur bei `req.secure`, weil die Reporting API nur an sichere Endpunkte liefert und Chrome bei vorhandenem `report-to` das `report-uri` ignoriert. |

Nicht betroffen: die Desktop-App (`connector/src-tauri/tauri.conf.json:28` hat eine eigene CSP und lädt `client/dist` lokal), der Vite-Dev-Server, und Antworten der API — die Policy hängt nur an der statischen Seite. Die Vorschau-Antworten der API (außer PDF) tragen stattdessen eine eigene `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups` aus `contentHeaders`: Das `sandbox`-Attribut des iframes (`FilePreviewWindow.jsx:152`) wirkt nur im Fenster; öffnet jemand die Vorschau-Adresse direkt in einem neuen Tab (kopierte Adresse, „Frame in neuem Tab öffnen“, ein Link von außerhalb des iframes), liefe eine fremde HTML- oder SVG-Datei sonst mit der Herkunft von Outpost und könnte mit dessen Speicher Vault-Werte abrufen. Mit dem Header läuft sie auch dort in einer undurchsichtigen Herkunft, mit denselben Rechten wie im iframe. PDF bleibt ausgenommen, weil Chromium den PDF-Viewer in einem sandboxed Dokument nicht startet; ein PDF führt im Viewer kein Skript mit der Herkunft von Outpost aus. Der `Host`-Header wird nur übernommen, wenn er `HOST_PATTERN` erfüllt; sonst bleibt `connect-src 'self'` (kein Einschleusen weiterer Direktiven).

- [ ] **Step 1: Write the failing test**

`server/lib/__tests__/cspHeader.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");

const fake = (modulePath, exports) => {
    const resolved = require.resolve(modulePath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};
fake("../../utils/logger", { warn: () => {}, error: () => {}, info: () => {}, system: () => {} });

const { mountStaticSite } = require("../staticSite");
const cspReport = require("../../routes/cspReport");

const REPORT_ONLY = "content-security-policy-report-only";
const ENFORCED = "content-security-policy";

let server;
let baseUrl;
let distDir;

test.before(async () => {
    distDir = fs.mkdtempSync(path.join(os.tmpdir(), "outpost-csp-"));
    fs.writeFileSync(path.join(distDir, "index.html"), "<!doctype html><title>Outpost</title>");

    const app = express();
    app.use(express.json());
    app.use("/api/csp-report", cspReport);
    mountStaticSite(app, distDir);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
    delete process.env.CSP_ENFORCE;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(distDir, { recursive: true, force: true });
});

const getWithHost = (pathname, host) => new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${pathname}`, { headers: { host } }, (res) => {
        res.resume();
        res.on("end", () => resolve(res));
    });
    req.on("error", reject);
    req.end();
});

test("the client shell reports its policy but already refuses foreign framing (SEC-CSP-01)", async () => {
    for (const pathname of ["/", "/servers/42"]) {
        const res = await fetch(`${baseUrl}${pathname}`);
        const policy = res.headers.get(REPORT_ONLY);

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.headers.get(ENFORCED), "frame-ancestors 'self'", `${pathname} enforces nothing but frame-ancestors yet`);
        assert.strictEqual(res.headers.get("x-frame-options"), "SAMEORIGIN");
        assert.match(policy, /default-src 'self'/);
        assert.match(policy, /object-src 'none'/);
        assert.match(policy, /report-uri \/api\/csp-report/);
        assert.ok(!policy.includes("frame-ancestors"), "framing is enforced on its own header, not reported twice");
        assert.ok(policy.includes(`wss://${new URL(baseUrl).host}`), "the state stream socket to the same host is allowed");
    }
});

test("CSP_ENFORCE=true sends the whole policy as an enforcing header", async (t) => {
    process.env.CSP_ENFORCE = "true";
    t.after(() => { delete process.env.CSP_ENFORCE; });

    const res = await fetch(`${baseUrl}/servers/42`);
    const policy = res.headers.get(ENFORCED);

    assert.match(policy, /default-src 'self'/);
    assert.match(policy, /frame-ancestors 'self'/);
    assert.strictEqual(res.headers.get(REPORT_ONLY), null);
    assert.strictEqual(res.headers.get("x-frame-options"), "SAMEORIGIN");
});

test("a forged Host header cannot append directives to the policy", async () => {
    const res = await getWithHost("/", "evil.example; script-src *");
    const policy = res.headers[REPORT_ONLY];

    assert.ok(!policy.includes("script-src *"), policy);
    assert.ok(!policy.includes("evil.example"), policy);
});

test("the report endpoint accepts both report formats without authentication", async () => {
    const legacy = await fetch(`${baseUrl}/api/csp-report`, {
        method: "POST",
        headers: { "Content-Type": "application/csp-report" },
        body: JSON.stringify({ "csp-report": { "document-uri": `${baseUrl}/vault`, "blocked-uri": "inline", "effective-directive": "script-src-elem" } }),
    });
    const reporting = await fetch(`${baseUrl}/api/csp-report`, {
        method: "POST",
        headers: { "Content-Type": "application/reports+json" },
        body: JSON.stringify([{ type: "csp-violation", body: { documentURL: `${baseUrl}/vault`, blockedURL: "eval", effectiveDirective: "script-src" } }]),
    });

    assert.strictEqual(legacy.status, 204);
    assert.strictEqual(reporting.status, 204);
});

test("report summaries keep only origin, path and known keywords, so tokens never reach the log (SEC-TOKEN-01)", () => {
    const summaries = [
        ...cspReport.summarizeReports({ "csp-report": {
            "document-uri": "https://outpost.example/servers?token=doc-secret",
            "blocked-uri": "wss://outpost.example/api/ws/state?sessionToken=state-secret",
            "violated-directive": "connect-src",
            "script-sample": "sample-secret",
        } }),
        ...cspReport.summarizeReports([
            { type: "csp-violation", body: {
                documentURL: "https://outpost.example/vault#frag-secret",
                blockedURL: "https://cdn.example/x.js?key=url-secret",
                sourceFile: "https://outpost.example/assets/index.js?v=src-secret",
                effectiveDirective: "script-src-elem",
                disposition: "report",
                sample: "sample-secret",
            } },
            { type: "csp-violation", body: { effectiveDirective: "token=directive-secret", disposition: "disposition-secret" } },
        ]),
    ];
    const logged = JSON.stringify(summaries);

    assert.ok(!/secret/.test(logged), logged);
    assert.strictEqual(summaries[0].blocked, "wss://outpost.example/api/ws/state");
    assert.strictEqual(summaries[0].directive, "connect-src");
    assert.strictEqual(summaries[1].blocked, "https://cdn.example/x.js");
    assert.strictEqual(summaries[1].disposition, "report");
    assert.strictEqual(summaries[2].directive, "[other]");
    assert.strictEqual(summaries[2].disposition, null);
});
```

`server/lib/fileContent/__tests__/download.test.js` — direkt nach dem Test „a download is an attachment, a preview is inline, and both carry the encoded name“ (Z. 32-41) einfügen:

```js
// The iframe's sandbox attribute is gone once the preview URL is opened in a tab of its own; the
// header keeps a foreign page out of Outpost's origin there too.
test("a preview except a PDF is sandboxed even outside the iframe", () => {
    const SANDBOX = "sandbox allow-scripts allow-forms allow-popups";
    for (const ext of ["html", "svg", "png"]) {
        const headers = contentHeaders({ fileName: `x.${ext}`, size: 1, ext, preview: true });
        assert.strictEqual(headers["Content-Security-Policy"], SANDBOX, ext);
    }
    assert.strictEqual("Content-Security-Policy" in contentHeaders({ fileName: "x.pdf", size: 1, ext: "pdf", preview: true }), false,
        "Chromium does not start its PDF viewer in a sandboxed document");
    assert.strictEqual("Content-Security-Policy" in contentHeaders({ fileName: "x.html", size: 1, ext: "html", preview: false }), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /root/outpost && node --test server/lib/__tests__/cspHeader.test.js`
Expected: FAIL beim Laden mit `Error: Cannot find module '../../routes/cspReport'` (der Router existiert noch nicht; `staticSite.js` setzt noch keinen Header).

Run: `cd /root/outpost && node --test server/lib/fileContent/__tests__/download.test.js`
Expected: FAIL — genau der neue Test „a preview except a PDF is sandboxed even outside the iframe“ mit `AssertionError` (`undefined` statt der Sandbox-Policy); die übrigen 10 bestehen.

- [ ] **Step 3: Implement — `server/lib/staticSite.js` und `contentHeaders`**

Vorher (Z. 1-21): `require`s, JSDoc, `mountStaticSite` mit `express.static`, `/assets/*name` → 404, `*name` → `index.html`, Export `{ mountStaticSite }`. Nachher die vollständige Datei (JSDoc und Fallback unverändert, neu sind `HOST_PATTERN`, `FRAME_ANCESTORS`, `buildContentSecurityPolicy`, `setContentSecurityPolicy` und die erste Zeile in `mountStaticSite`). Die Datei hat außer dem JSDoc keine Kommentare und bekommt keine; das Warum steht in der Begründungstabelle oben: `HOST_PATTERN` lässt nur `host[:port]` in die Policy, `frame-ancestors` geht im Report-Only-Modus als eigener erzwungener Header hinaus, `report-to` nur bei `req.secure`.

```js
const express = require("express");
const path = require("node:path");

const HOST_PATTERN = /^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;
const FRAME_ANCESTORS = "frame-ancestors 'self'";

const buildContentSecurityPolicy = ({ host, secure, enforce }) => {
    const sockets = HOST_PATTERN.test(host || "") ? ` ws://${host} wss://${host}` : "";
    return [
        "default-src 'self'",
        "script-src 'self' 'wasm-unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        `connect-src 'self'${sockets}`,
        "worker-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        ...(enforce ? [FRAME_ANCESTORS] : []),
        "report-uri /api/csp-report",
        ...(secure ? ["report-to csp"] : []),
    ].join("; ");
};

const setContentSecurityPolicy = (req, res, next) => {
    const enforce = process.env.CSP_ENFORCE === "true";
    const policy = buildContentSecurityPolicy({ host: req.get("host"), secure: req.secure, enforce });
    if (enforce) {
        res.setHeader("Content-Security-Policy", policy);
    } else {
        res.setHeader("Content-Security-Policy", FRAME_ANCESTORS);
        res.setHeader("Content-Security-Policy-Report-Only", policy);
    }
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    if (req.secure) res.setHeader("Reporting-Endpoints", "csp=\"/api/csp-report\"");
    next();
};

/**
 * Serves the built client: the static files, then index.html for every client-side route.
 *
 * `/assets` is excluded from that fallback on purpose. Its filenames carry a content hash, so a
 * browser still running a previous build asks for chunks this build no longer ships. Answering
 * those with index.html hands the browser HTML where it expects a JS module: the import fails on
 * the MIME type, the feature dies without a trace, and nothing reaches the server log. A 404 makes
 * a stale tab say so.
 */
const mountStaticSite = (app, distDir) => {
    app.use(setContentSecurityPolicy);

    app.use(express.static(distDir));

    app.get("/assets/*name", (req, res) => res.sendStatus(404));

    app.get("*name", (req, res) => res.sendFile(path.join(distDir, "index.html")));
};

module.exports = { mountStaticSite };
```

`server/lib/fileContent/download.js` — `contentHeaders` Z. 29-30 vorher:

```js
    if (MIME_TYPES[ext]) headers["Content-Type"] = MIME_TYPES[ext];
    return headers;
```

nachher (Konstante `PREVIEW_SANDBOX` direkt über `contentHeaders`, nach `clampThumbSize` Z. 19):

```js
const PREVIEW_SANDBOX = "sandbox allow-scripts allow-forms allow-popups";
```

```js
    if (MIME_TYPES[ext]) headers["Content-Type"] = MIME_TYPES[ext];
    // Opened in a tab of its own, a preview loses the iframe's sandbox attribute. PDF is left out:
    // Chromium does not start its PDF viewer in a sandboxed document.
    if (preview && ext !== "pdf") headers["Content-Security-Policy"] = PREVIEW_SANDBOX;
    return headers;
```

`X-Content-Type-Options: nosniff` und `Cache-Control` der Vorschau-Route (`server/routes/sftp.js`) bleiben unverändert; die Route übernimmt die Header aus `contentHeaders` per Schleife und braucht keine Änderung.

- [ ] **Step 4: Implement — `server/routes/cspReport.js`**

Der Router trägt Rate-Limit und Parser selbst, damit `server/index.js` nur eine Zeile bekommt. Das globale `express.json()` in `server/index.js` (heute Z. 63, nach Tasks 1 und 8 verschoben; Code-Anker `app.use(express.json(`) parst nur `application/json` und lässt beide Report-Typen durch. Reihenfolge: erst das Limit, dann das Parsen. Muster des Limiters: `server/lib/bookmarkRateLimiter.js` (`ipKeyGenerator` ist Pflicht, sonst `ERR_ERL_KEY_GEN_IPV6`).

```js
const express = require("express");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const logger = require("../utils/logger");

const app = express.Router();

const MAX_REPORTS = 10;
const MAX_FIELD = 200;
const KEYWORD = /^[a-z-]{1,32}$/i;
const NETWORK_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"]);
const DIRECTIVES = new Set([
    "default-src", "script-src", "script-src-elem", "script-src-attr", "style-src", "style-src-elem", "style-src-attr",
    "img-src", "font-src", "connect-src", "media-src", "object-src", "frame-src", "child-src", "worker-src",
    "manifest-src", "base-uri", "form-action", "frame-ancestors", "require-trusted-types-for", "trusted-types",
]);
const DISPOSITIONS = new Set(["enforce", "report"]);

const cspReportLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    keyGenerator: (req) => `ip:${ipKeyGenerator(req.ip)}`,
    message: { code: 429, message: "Too many CSP reports" },
    standardHeaders: true,
    legacyHeaders: false,
});

const clip = (value) => (typeof value === "string" ? value.slice(0, MAX_FIELD) : null);

const directiveOf = (value) => {
    if (typeof value !== "string" || value.trim() === "") return null;
    const name = value.trim().split(/\s+/)[0].toLowerCase();
    return DIRECTIVES.has(name) ? name : "[other]";
};

// Query strings carry tokens (?sessionToken= on every WebSocket, ?token= on downloads); a report
// about a blocked socket would otherwise write a live session token into the log.
const stripUrl = (value) => {
    if (typeof value !== "string" || value === "") return null;
    try {
        const url = new URL(value);
        return clip(NETWORK_SCHEMES.has(url.protocol) ? `${url.origin}${url.pathname}` : url.protocol);
    } catch {
        return KEYWORD.test(value) ? value : "[unparsed]";
    }
};

const pick = (raw) => {
    const report = raw && typeof raw === "object" ? raw : {};
    const line = report.lineNumber ?? report["line-number"];
    return {
        document: stripUrl(report.documentURL ?? report["document-uri"]),
        blocked: stripUrl(report.blockedURL ?? report["blocked-uri"]),
        directive: directiveOf(report.effectiveDirective ?? report["effective-directive"] ?? report["violated-directive"]),
        source: stripUrl(report.sourceFile ?? report["source-file"]),
        line: Number.isInteger(line) ? line : null,
        disposition: DISPOSITIONS.has(report.disposition) ? report.disposition : null,
    };
};

const summarizeReports = (body) => {
    if (Array.isArray(body)) {
        return body.filter((entry) => entry?.type === "csp-violation").slice(0, MAX_REPORTS).map((entry) => pick(entry.body));
    }
    if (body && typeof body === "object" && body["csp-report"]) return [pick(body["csp-report"])];
    return [];
};

/**
 * POST /csp-report
 * @summary Receive Content Security Policy violation reports
 * @description Browsers post here when the page violates the Content-Security-Policy(-Report-Only) header. No authentication; rate limited per address. Accepts application/csp-report and application/reports+json.
 * @tags Security
 * @produces application/json
 * @return {object} 204 - Report accepted, empty body
 * @return {object} 429 - Too many reports
 */
app.post("/", cspReportLimiter, express.json({ type: ["application/csp-report", "application/reports+json"], limit: "64kb" }), (req, res) => {
    for (const report of summarizeReports(req.body)) logger.warn("CSP violation", report);
    res.status(204).end();
});

app.use((err, req, res, _next) => res.status(err.status === 413 ? 413 : 400).end());

module.exports = app;
module.exports.summarizeReports = summarizeReports;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /root/outpost && node --test server/lib/__tests__/cspHeader.test.js server/lib/__tests__/staticSite.test.js server/lib/fileContent/__tests__/download.test.js`
Expected: `# tests 19`, `# pass 19`, `# fail 0` (6 neue, 13 bestehende).

- [ ] **Step 6: Mount in `server/index.js`**

Vorher (Code-Anker; heute Z. 70-71, durch Tasks 1 und 8 verschoben — die Nummern nicht suchen, sondern die beiden Zeilen):

```js
app.use("/api/auth", require("./routes/auth"));
app.use("/api/auth", require("./routes/authProviders"));
```

Nachher:

```js
app.use("/api/auth", require("./routes/auth"));
app.use("/api/auth", require("./routes/authProviders"));
app.use("/api/csp-report", require("./routes/cspReport"));
```

Ohne `authenticate`: Browser schicken Meldungen ohne `Authorization`-Header. Der Mount steht vor `mountStaticSite(app, …)` (heute Z. 121-122, ebenfalls verschoben), damit der SPA-Fallback die Route nicht verdeckt.

- [ ] **Step 7: Lint und Gegenprobe der Fehlerpfade**

Run: `cd /root/outpost && yarn lint`
Expected: keine Errors (der Fehler-Handler nutzt `_next`, passend zu `argsIgnorePattern: "^_"` in `eslint.config.mjs`).

Run (Gegenprobe ohne Test, Fehlerpfade sind Framework-Verhalten):

```bash
cd /root/outpost && node - <<'EOF'
const express = require("express");
const app = express(); app.use(express.json());
app.use("/api/csp-report", require("./server/routes/cspReport"));
const s = app.listen(0, async () => {
    const u = `http://127.0.0.1:${s.address().port}/api/csp-report`;
    const post = (ct, body) => fetch(u, { method: "POST", headers: { "Content-Type": ct }, body });
    console.log((await post("application/csp-report", "{bad")).status, (await post("application/reports+json", "x".repeat(70000))).status);
    let last; for (let i = 0; i < 31; i++) last = await post("application/csp-report", "{}");
    console.log(last.status);
    s.close();
});
EOF
```

Expected: `400 413`, danach `429`. Die Ausgabe enthält keinen Stacktrace (SEC-ERR-01).

- [ ] **Step 8: Commit**

```bash
git add server/lib/staticSite.js server/routes/cspReport.js server/index.js server/lib/__tests__/cspHeader.test.js server/lib/fileContent/download.js server/lib/fileContent/__tests__/download.test.js
git commit -m "Vault: Content-Security-Policy als Report-Only mit Meldeendpunkt, Einbetten erzwungen gesperrt, Dateivorschau auch im eigenen Tab sandboxed"
```

- [ ] **Step 9: Doku `docs/vault.md` schreiben**

Vollständiger Inhalt (Englisch wie `docs/browser-tabs.md`; GitHub-Hinweisblöcke `> [!WARNING]` und `::: code-group` wie in `docs/browser-tabs.md` bzw. `docs/installation.md`):

````markdown
# 🔐 Vault

The vault keeps credentials in Outpost: website logins, API keys, SSH keys, database passwords and anything else a tool needs. AI agents such as Claude Code and Codex, running on your servers in Outpost terminals, can use these entries without ever seeing the value. Outpost inserts the secret itself and hands the agent only the result. Every use can require your approval, is limited to the servers you choose, and ends up in the audit log.

In this release, agents can use one kind of entry: a **login**, filled into a sign-in form in an Outpost browser tab (see [Browser Tabs & Claude](/browser-tabs)). The other types can already be stored and viewed; agent tools for them follow in later releases.

## 1. Create and set the vault key

The vault encrypts every value with its own key, `VAULT_KEY`. It is separate from `ENCRYPTION_KEY`. Generate a new one:

```sh
openssl rand -hex 32
```

The key is 64 hex characters. Set it as an environment variable or as the Docker secret `vault_key`:

::: code-group

```yaml [Environment variable]
services:
  outpost:
    environment:
      VAULT_KEY: "<64 hex characters>"
```

```yaml [Docker secret]
services:
  outpost:
    secrets:
      - vault_key

secrets:
  vault_key:
    file: ./vault_key.txt
```

:::

Outpost reads every file in `/run/secrets` and uses its name in upper case as the variable name, so the secret `vault_key` becomes `VAULT_KEY`. A value already set in the environment wins over the file.

Restart Outpost. **Settings → Vault** shows the state of the key:

| State | Meaning |
| - | - |
| Active | The vault is on. |
| Missing | No key, or not 64 hex characters. The vault is off: no navigation entry, no agent tools, agent keys are rejected with `401`, and the vault API answers `404`. |
| Mismatch | The key cannot decrypt what Outpost already stored with the previous key. The vault stays off, exactly as with a missing key, until the original key is back. |

Without a key, Outpost starts and behaves exactly as before.

> [!WARNING]
> Keep `VAULT_KEY` apart from your Outpost backups, for example in a password manager. Backups contain the vault entries encrypted. Restored without the same key, they cannot be read, and there is no way to recover them. Do not replace the key once entries exist: Outpost detects the mismatch and switches the vault off.

## 2. Permissions

| Permission | Scope | Allows |
| - | - | - |
| `vault.use` | System | Create personal entries and let your own agents use them. Off by default, marked dangerous. |
| `vault.manage` | Organization | Create, edit and delete the organization's entries. |
| `vault.reveal` | Organization | Show and copy the values of the organization's entries. Marked dangerous. |
| `settings.vault` | System | Open **Settings → Vault**. |

An agent may use an organization's entries as long as its account is an **active** member of that organization. Pending invitations do not count. No further permission is needed for that.

## 3. Entries

Once the vault is on, **Vault** appears in the main navigation for accounts with `vault.use` or an organization membership. The list has one tab per owner: your personal entries and one tab per organization.

| Type | Fields | Secret fields | Usable by agents |
| - | - | - | - |
| Login | username, allowed origins (`scheme://host[:port]`, at least one) | password | `browser_fill_credential` |
| API key | hosts, header name (default `Authorization`), header template (default `Bearer {{secret}}`) | token | not yet |
| SSH | username | private key and/or password, optional passphrase | not yet |
| Database | engine (`postgres`, `mysql`, `sqlite`), host, port, database, username | password | not yet |
| Other | – | value | not yet |

**Name.** The name is how agents refer to the entry: lower-case letters, digits, `.`, `-` and `_`, starting with a letter or digit, at most 64 characters, unique per owner. Agents see a personal entry as `<name>` and an organization entry always as `org:<organization id>/<name>`. That way an identifier never changes because an entry with the same name appears somewhere else.

**Applies to.** An agent sees an entry only on the servers it applies to. Combine any of:

- single servers,
- folders, including all their subfolders,
- tags (personal entries only, because tags belong to your account),
- **All servers** (for an organization entry: all servers of that organization).

The default is none: a new entry is invisible to every agent until you choose. Organization entries can only apply to servers and folders of the same organization. The agent's account must also still be allowed to open the server; once that access goes away, Outpost rejects the server's agent keys with `403`. A request without a server (an account API key or a signed-in session) sees only personal entries that apply to **All servers**.

**Approval required.** On by default. Every use by an agent then needs a click in an Outpost window, see [Approvals](#_5-approvals). Only a signed-in session can switch it off: saving an entry with approvals off through an account API key or during an impersonation session answers `403` ("Turning off approvals requires a signed-in session"). A fill requested during an impersonation session always asks for approval, even for entries with approvals off.

**Changing a target clears the values.** When you change the origins of a login, the hosts of an API key or the host of a database entry, Outpost deletes all stored values of that entry in the same step, and the dialog asks for them again. Otherwise someone who may edit an organization entry, but not see its values, could point it at a site of their own and let an agent fill the password there.

**Show and copy.** The list never carries values. **Show** fetches one value when you click it and hides it again after 30 seconds; **Copy** puts it on the clipboard. Both are available to the owner of a personal entry and, for organization entries, to members with `vault.reveal`. Every call is audited. Everyone else sees a note that the value can only be used by agents.

**Deleting.** Deleting an entry removes its values and bindings. Deleting an account or an organization deletes its entries. Deleting a server, folder or tag removes every binding to it, including the subfolders and servers deleted with a folder.

**Unreadable entries.** If a value can no longer be decrypted, the entry is shown as unreadable, the agent gets `vault.item_unreadable`, and the server log and the audit log name the entry.

## 4. Agent access

Agents sign in with an **agent key**. It belongs to one server, works only at the MCP endpoint `/api/mcp`, and by default only from that server's IP address. Every other Outpost API answers it with `403`. Outpost also rejects it with `401` while the vault is off, and with `403` once its account may no longer open the server. Agent keys do not expire; to rotate one, set up the access again, which replaces the old key. Agent keys are listed apart from your account API keys under **Settings → Account**.

### Before you start

Under **Settings → Vault**, set **Outpost address for agents**: the address under which your servers reach Outpost, for example `http://192.168.2.10:6989`. Outpost appends `/api/mcp`. Prefer an address on your LAN that reaches Outpost directly rather than through a public reverse proxy (see [time limits](#time-limits) and [section 6](#_6-reverse-proxy-and-trust-proxy)). Until the address is set, setup is disabled.

### Set up with one click

1. In the server list, right-click an SSH server and choose **Agent access…**. The entry exists only for SSH servers and only if you may use the vault.
2. Select **Claude Code**, **Codex** or both. Leave **Only from this server's IP** on. Add extra address ranges in CIDR notation if the agent's requests come from another network, for example `10.0.0.0/24`. These settings are fixed for the key; to change them, revoke the access and set it up again.
3. Start the setup.

Outpost then:

- creates one key per agent, named `claude@<server>` and `codex@<server>`;
- runs the setup over SSH with the identity Outpost would use to open this server, and names the remote user in the result, for example "set up for root";
- measures the address the server's requests arrive from (see [address check](#address-check));
- finds the CLI with `command -v` in a login shell and in `~/.local/bin`, `~/.claude/local` and `~/.npm-global/bin`;
- for **Claude Code**: runs `claude mcp add --scope user --transport http outpost <url> --header "Authorization: Bearer <key>"` with `umask 077` and then `chmod 600 ~/.claude.json`. An existing `outpost` registration, for example the account key from [Browser Tabs & Claude](/browser-tabs), is removed first and the result says so. That old account key stays valid in Outpost until you delete it under **Settings → Account**;
- for **Codex**: writes `export OUTPOST_MCP_TOKEN=<key>` to `~/.codex/outpost.env` with mode `600`, adds the line `[ -f ~/.codex/outpost.env ] && . ~/.codex/outpost.env` to `~/.bashrc`, `~/.profile` and, if they exist, `~/.bash_profile` and `~/.zshrc` (each only once), and runs `codex mcp add outpost --url <url> --bearer-token-env-var OUTPOST_MCP_TOKEN`.

Afterwards:

- **Claude Code:** restart Claude Code and run `/mcp`. `outpost` should be connected. Ask Claude to call `vault_list`.
- **Codex:** start Codex in a **new shell**. Codex processes that are already running, and tmux sessions started before the setup, do not have the key in their environment. Then run `/mcp` in Codex.

Setting up the same server, agent and remote user again replaces your previous key once the new one works. If the server user already had an `outpost` registration with an account API key, the result says it was replaced; that account key stays valid until you delete it under API Keys.

### Address check

While the new key is not yet in use, Outpost lets the server call `GET <Outpost address for agents>/api/vault/agent-keys/probe` with it, using `curl` or else `wget`. The key goes to the tool from a temporary file with mode `600` that the command deletes afterwards. Outpost stores the address the first request arrived from; later probe calls with the same key change nothing.

If that address differs from what the server's host name resolves to, the dialog says so and offers to add it, for example "Seen 172.17.0.1 instead of 192.168.2.40 — adopt as address range? Without adopting it, Outpost refuses the key." Typical causes are NAT, IPv6, and an agent on a Docker host whose requests reach an Outpost container through the Docker gateway. Accepting adds exactly the measured address as `/32` (IPv4) or `/128` (IPv6). This works once and only within 15 minutes of creating the key. If the measured address is the address your own browser reaches Outpost from, Outpost refuses to adopt it ("The measured address is the address of your browser; Outpost sees a proxy, not the server"): both requests then arrive through the same proxy, and the range would let in everyone behind it. Fix `TRUST_PROXY` (see [section 6](#_6-reverse-proxy-and-trust-proxy)) or use Outpost's LAN address as **Outpost address for agents**. Without it, the IP binding rejects the agent with `403`, and the audit log records `vault.agent_ip_denied`.

If the check fails (neither `curl` nor `wget`, or Outpost unreachable from the server), the result says so and the setup continues with the resolved addresses.

### Manual setup

If the automatic setup fails, for example because the CLI is missing or the SSH command failed, the dialog shows the finished command. Copy it and run it on the server in your own terminal, not inside an agent session, so the key does not end up in a transcript. Copying is what makes the key valid. The key is shown only in this dialog and only this once. Closing the dialog without copying deletes the key; a key that is never used or copied is deleted by the server after 15 minutes.

Use the command exactly as the dialog shows it. For Claude Code it has this form:

```bash
 claude mcp add --scope user --transport http outpost http://192.168.2.10:6989/api/mcp --header "Authorization: Bearer outpost_<key>"
```

The leading space keeps the command out of the shell history when `HISTCONTROL=ignorespace` is set.

### Several Outpost accounts on one server user

A server user has one `outpost` registration per agent. If another Outpost account has already set up agent access for the same server and remote user, the dialog warns before the setup: the registration is replaced, and the agents of that user then act with your entries and your approvals. The other account's key remains in Outpost until it is revoked.

### Revoke

Revoke a key under **Settings → Account** in the agent keys section (**Edit** per server opens the setup dialog) or in the setup dialog itself. Revoking deletes the key at once; the agent loses access immediately. Outpost then removes the registration from the server, but only if it still carries this key. It compares the key prefix inside Outpost; nothing read from the server is passed on. If another account's key is registered by now, the registration stays, and the result says that the access is revoked while the registration on the server carries another account's key and stays in place.

If the identity used for the setup has been deleted in the meantime, or removing the registration fails or cannot be confirmed, the key is revoked anyway and the result shows the removal command with a copy button. Run it on the server in your own terminal. Deleting the server entry deletes its agent keys.

## 5. Approvals

When an agent wants to use an entry with **Approval required**, a card appears bottom right in every Outpost window of the account that owns the agent key, including popouts. For organization entries this is the same user, not the organization's admins. The card shows agent and server, entry and target, and the time left.

| Answer | Effect |
| - | - |
| Once | Allows exactly one fill. |
| For this session | Allows this entry for the rest of the agent's MCP session (see below). |
| Deny | Refuses. For 60 seconds the same agent gets `vault.approval_denied` for this entry at once, without a new card, even over a new MCP session. |

- Without an answer within 2 minutes, the agent gets `vault.approval_timeout`.
- If no Outpost window of the account is open, the agent gets `vault.approval_unavailable` at once. Keep a tab open while agents work. Windows of an impersonation session neither receive cards nor count as open.
- The first answer wins; the card disappears in all other windows.
- Each MCP session has at most one open request per entry (`vault.approval_pending`), and each agent key at most three open requests (`vault.approval_busy`).

### "For this session" and `/clear`

The session is the agent's MCP connection to Outpost, not the chat. `/clear` in Claude Code starts a new conversation over the same connection, so an approval "for this session" keeps applying to it. It ends when the agent process exits or reconnects, when Outpost restarts, or after 12 hours without activity. It also ends as soon as the entry changes: after any save of the entry, for example new origins, the next use asks again. To withdraw it earlier, quit the agent or revoke its key.

### Time limits

The agent's request stays open while the card waits, up to 2 minutes. Everything between the agent and Outpost has to allow that:

- **Reverse proxy:** `proxy_read_timeout` of at least 150 seconds in nginx (the example in [Reverse Proxy](/reverse-proxy) uses 86400), `ProxyTimeout` likewise in Apache. This applies to `/api/mcp` and to `/api/vault/agent-keys`, whose setup request waits for the SSH commands on the server.
- **Cloudflare:** proxied requests end after 100 seconds. Use Outpost's LAN address as **Outpost address for agents**.
- **Codex:** waits 60 seconds per tool call by default. Raise it in `~/.codex/config.toml`, in the section the setup created:

  ```toml
  [mcp_servers.outpost]
  tool_timeout_sec = 180
  ```

- **Claude Code:** if you set `MCP_TOOL_TIMEOUT`, keep it at `150000` (milliseconds) or more.

If the agent gives up earlier, Outpost withdraws the request at once: the card disappears, the audit log records `vault.approval_timeout` with reason `client_gone`, and a late answer fills nothing.

## 6. Reverse proxy and TRUST_PROXY

The IP binding compares the address a request comes from. Behind a reverse proxy, Outpost learns that address only from `X-Forwarded-For`, and `TRUST_PROXY` decides whose `X-Forwarded-For` it believes.

| `TRUST_PROXY` | Effect on agent keys |
| - | - |
| unset or `false` | Outpost uses the address of the connection. Right when nothing sits in between. Behind a proxy, every request seems to come from the proxy: agent keys of other servers are rejected, and the key of a server that is the proxy host itself is accepted from anywhere. |
| address list, e.g. `172.18.0.2` or `loopback` | Outpost believes `X-Forwarded-For` only on connections from these addresses. **Recommended behind a proxy.** Direct connections keep their real address. |
| hop count, e.g. `1` | Outpost believes the last hops of `X-Forwarded-For` from anyone. Safe only if Outpost is reachable **exclusively** through the proxy. Otherwise an agent that calls Outpost directly writes its own `X-Forwarded-For` and passes any IP binding. |
| `true` | Outpost believes every `X-Forwarded-For`. The IP binding is useless; **Settings → Vault** and the setup dialog warn. Do not use it. |

The address list is comma separated and takes addresses, CIDR ranges and the names `loopback`, `linklocal` and `uniquelocal`. In Docker, give the proxy container a fixed address or a network of its own, because every address in a trusted range can set `X-Forwarded-For`.

The simplest setup: point **Outpost address for agents** at Outpost's direct LAN address. Agents then do not pass the proxy at all.

## 7. Security model and limits

- **Agents never receive a value.** No tool returns a secret, its length, a prefix or a hash. Outpost types the password into the page itself; the agent gets a confirmation.
- **The agent key is not secret from the agent.** Claude Code keeps it in `~/.claude.json`, Codex in its environment. The key only allows mediated actions, limited by the server binding, approvals and the audit log, and the IP binding makes it worthless outside its server.
- **Local users of the server.** The IP binding cannot tell users of the same server apart. Anyone with an account there can read the key from `~/.claude.json` or `~/.codex/outpost.env` if file permissions allow (root always can), and during the setup from the process list, because the key briefly appears on a command line. They can then use it from that server. Set up agent access only on servers whose local users you trust with your vault entries.
- **The live picture is not protected by `vault.reveal`.** If you watch an agent fill a login in your own browser tab, the page's "show password" button reveals the value, even without `vault.reveal`. For the agent, Outpost blanks the field in every snapshot (`value="••••"`) and refuses screenshots while a filled field is unmasked.
- **A browser context that received a password stays locked.** After a fill, `browser_evaluate` is refused in that browser context, including popups, and every text sent to the agent or written to the audit log (snapshots, `URL:`, titles, session lists, error messages) is scrubbed of the filled password, also in URL-encoded and form-encoded form. Outpost fills only in fresh sessions: not over `via`, not in the persistent profile, and not in a browser context in which `browser_evaluate` has ever run.
- **Selection and paste are locked.** A selected password ends up in the system's selection buffer, from where a middle click pastes it anywhere. Outpost therefore refuses the agent's middle click (`browser_click` with `button: "middle"`) in every session; your own clicks in the tab are not affected. To open a link in a new tab, the agent calls `browser_open` with the link's address instead. In a browser context that received a password, Outpost also refuses `browser_key` with a Control, Meta or Shift combination (Shift+Tab excepted) and `browser_click` with `clickCount` above 1. The agent gets `vault.input_locked`, and the audit log records `vault.input_locked`. Before typing, Outpost empties a field directly instead of selecting its content.
- **The page must match.** The password field and every frame above it must be on one of the entry's origins exactly (scheme, host, port). A foreign page that embeds the login is refused; if you want to allow an embedding, add the embedding origin.
- **"For this session" outlives `/clear`.** See [Approvals](#for-this-session-and-clear).
- **Impersonation.** Admins who sign in as another user see that user's entries but cannot show values, answer approvals, switch off **Approval required**, or set up or revoke agent access. Fills requested during impersonation always ask for approval. The admin cannot create API keys for that user during impersonation either (`403` "This action requires a signed-in session"), so no key outlives the impersonation. Every audit entry from an HTTP request of such a session, of any action, names the admin as `impersonatorId`; entries from WebSocket connections (terminal, SFTP, AI chat) do not carry it yet.
- **Leaving an organization** hides its entries at once, also for MCP sessions that are already running and for a request whose approval card is still waiting.
- **Agent keys open only ephemeral browser sessions.** `browser_open` with `profile: "persistent"` answers `INVALID_PROFILE` for an agent key before a browser starts, so an agent never sees the cookies and logins of your persistent profile.
- **Audit log.** Category Vault: `vault.item_create`, `vault.item_update`, `vault.item_delete`, `vault.reveal`, `vault.use`, `vault.use_denied`, `vault.approve`, `vault.deny`, `vault.approval_timeout`, `vault.agent_key_create`, `vault.agent_key_revoke`, `vault.agent_ip_denied`, `vault.item_unreadable`, `vault.evaluate_locked`, `vault.screenshot_locked`, `vault.input_locked`, `vault.persistent_not_allowed`. Entries name the vault entry, agent, server and target, never a value.
- **No master password.** Whoever controls the Outpost host or container, and with it `VAULT_KEY`, can decrypt the vault.

## 8. Content Security Policy

Outpost sends a Content Security Policy with the web client. It limits where the page may load scripts, styles, fonts and images from and where it may connect to. That matters for the vault: a foreign script running inside Outpost could fetch every value you are allowed to show.

The policy starts in **report-only** mode, with one exception: framing. Outpost sends `frame-ancestors 'self'` as an enforced `Content-Security-Policy` from the start, together with `X-Frame-Options: SAMEORIGIN`, because a report-only policy would never stop another site from embedding Outpost. Apart from that the browser blocks nothing; it reports what it would have blocked to `POST /api/csp-report`, and Outpost writes each report to its log as `CSP violation`, with page and blocked address shortened to origin and path (query strings removed), directive name, disposition, source file and line. Anything else in a report is dropped. The endpoint needs no sign-in and takes 30 reports per minute per address. Over HTTPS, browsers report through the Reporting API (`report-to`), over plain HTTP through `report-uri`.

Use Outpost normally for a while — terminals, remote desktop, the file editor, recordings, browser tabs and the vault. If the log shows no `CSP violation`, switch the policy on and restart Outpost:

```yaml
services:
  outpost:
    environment:
      CSP_ENFORCE: "true"
```

Outpost then sends the whole policy as `Content-Security-Policy` instead of `Content-Security-Policy-Report-Only`. If something stops working, remove the variable again and report the logged violation. Enforcing will become the default in a later release.

| Directive | Value | Why |
| - | - | - |
| `default-src` | `'self'` | Everything not listed below, including frames and media, loads only from Outpost itself. |
| `script-src` | `'self' 'wasm-unsafe-eval'` | Scripts come only from Outpost's own bundle; the recording player compiles its terminal emulator from WebAssembly. |
| `style-src` | `'self' 'unsafe-inline'` | React sets inline `style` attributes, and the code editor and terminal add style elements at runtime; styles cannot run code. |
| `img-src` | `'self' data: blob:` | Avatars and thumbnails come from Outpost's API, small icons are inlined as `data:`, and a chosen avatar is previewed from a `blob:` address. |
| `font-src` | `'self' data:` | All fonts are bundled; small ones are inlined as `data:`. No font is loaded from Google or another CDN. |
| `connect-src` | `'self' ws://<host> wss://<host>` | API calls, translations and the WebSockets for terminals, remote desktop, files, browser tabs and the live state go to Outpost only. |
| `worker-src` | `'self' blob:` | The code editor starts its workers from a `blob:` address that loads Outpost's own worker scripts. |
| `object-src` | `'none'` | Outpost uses no plugins. |
| `base-uri` | `'self'` | An injected `<base>` element cannot redirect the bundle's relative addresses. |
| `form-action` | `'self'` | No form posts to another site. |
| `frame-ancestors` | `'self'` | No other site can embed Outpost and trick you into clicking, for example, an approval. Enforced in both modes, together with `X-Frame-Options: SAMEORIGIN`: Outpost cannot be embedded in a page of another origin, for example a dashboard. |

File previews other than PDF carry a policy of their own, `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups`. An HTML or SVG file from a server therefore runs isolated from Outpost even when its preview address is opened in a tab of its own, not only inside the preview window. PDF previews are left out because browsers do not start their PDF viewer in a sandboxed document.

The desktop app ships its own policy; this one applies to Outpost in the browser. The development server (`yarn dev`) sends none.

## 9. Tools

The vault adds two MCP tools. They appear next to the [browser tools](/browser-tabs#tools) when the vault is on and the account has `vault.use` or is an active member of an organization. `browser_fill_credential` additionally needs the **Browser Sessions** permission; without it, it behaves like an unknown tool.

| Tool | Purpose |
| - | - |
| `vault_list` | Lists the entries the caller may use, each with `item` (the identifier for `browser_fill_credential`), `owner` (`personal` or the organization's name), `type`, `description`, `username` or `host`, `origins` or `hosts`, `approvalRequired` and `usableBy` (the tools that can use this type today). Never a value. |
| `browser_fill_credential` | `{ item, passwordRef, usernameRef?, sessionId? }`. Fills username and password of a login entry into the fields `passwordRef` and `usernameRef` from `browser_snapshot`. Answers only that both were filled. |

`browser_fill_credential` checks, in this order: the entry is visible and a login; the browser session belongs to the caller and is not paused; no `browser_evaluate` has run in its browser context; the session does not use `via` or the persistent profile; the frame of the password field and all frames above it match an allowed origin; `passwordRef` is a password field and `usernameRef` a text, email or phone field; the approval, if required. After the approval Outpost checks once more, right before typing, because the session was free for other tools while the card waited: the agent key is still valid, the entry is still visible to it with the same type and origins, and the session checks pass again. If the entry disappeared in the meantime, for example because you left its organization, the agent gets `vault.item_unknown`; if its origins changed, `vault.origin_mismatch`. Nothing is typed in either case.

With an agent key, the browser tools see only the sessions this key opened and their popups. `browser_list` hides your own tabs and those of other agents, a foreign `sessionId` answers like an unknown one, also for `browser_fill_credential`, `via` is limited to the key's own server (`browser_open` with another server answers `VIA_NOT_ALLOWED`), and `browser_open` opens only ephemeral sessions (`INVALID_PROFILE` for `profile: "persistent"`).

| Error | Meaning and next step |
| - | - |
| `vault.item_unknown` | No such entry, or it does not apply to this server. Call `vault_list`. |
| `vault.wrong_type` | The entry is not a login. |
| `vault.item_unreadable` | The stored value cannot be decrypted. Ask the user to check the entry. |
| `vault.no_secret` | The login entry has no stored password. Ask the user to enter it in Outpost. |
| `vault.session_tainted` | `browser_evaluate` ran in this browser context. Open a new session with `browser_open` without `profile: "persistent"` and fill there. |
| `vault.via_not_allowed` | The session runs over `via`. Outpost never types a password into a tunneled page, not even through the key's own server. Open a session without `via`. |
| `vault.persistent_not_allowed` | The session uses the persistent profile. Only an account API key can reach this; agent keys cannot open such a session. Open an ephemeral session. |
| `vault.origin_mismatch` | The page or a frame above the field is not on an allowed origin. Navigate to the entry's login page. |
| `vault.not_password_field` | `passwordRef` is not an `<input type="password">`. Take a new snapshot and pick the password field. |
| `vault.bad_username_field` | `usernameRef` is not a text field on the same origin. |
| `vault.focus_lost` | The focus left the target field before typing; nothing was typed. Try again. |
| `vault.evaluate_locked` | Credentials were filled in this browser context, so `browser_evaluate` is refused. Use `browser_snapshot` and `browser_click`. |
| `vault.screenshot_locked` | A filled field is currently unmasked. Use `browser_snapshot`. |
| `vault.input_locked` | Credentials were filled in this browser context, so key combinations that select or copy text and multi-clicks are refused; a middle click is refused in every session. Use `browser_click` and `browser_type` on single fields; to open a link in a new tab, call `browser_open` with its address. |
| `vault.approval_unavailable` | No Outpost window is open to answer. Ask the user to open Outpost. |
| `vault.approval_pending` | A request for this entry is already waiting. Wait for it. |
| `vault.approval_busy` | Three requests of this agent are already waiting. |
| `vault.approval_denied` | The user denied the request. Do not retry within 60 seconds. |
| `vault.approval_timeout` | Nobody answered within 2 minutes. |
| `vault.client_gone` | The agent closed the request before the answer arrived; check its tool timeout. |
| `vault.rate_limited` | More than 20 fills within a minute from this caller. Wait a minute and try again. |

Errors of the session checks that the browser tools also use, such as an unknown or paused session, keep their browser error codes.
````

Inhaltliche Quellen je Abschnitt, damit Abweichungen im Review auffallen: 1 = Spec „Betrieb“ und `server/utils/secrets.js` (Umgebung gewinnt, Dateiname groß geschrieben); 2 = Spec „Berechtigungen“; 3 = Spec „Datenmodell“, „Sichtbarkeit“, Spec `vault_secrets` (Zieländerung), UI-VAULT-DETAIL-SECRET (30 s), `403` beim Abschalten der Freigabe (Task 5), Abweisung ohne Serverzugriff (Task 4 `rejectAgentKey`); 4 = Spec „Einrichtung per Klick“ Schritte 1–8 und „Zugang entziehen“, Abweisung bei ausgeschaltetem Vault (Task 4), Probe nur erste Messung und `409` bei Proxy-Adresse (Task 8), Entziehen-Ergebnis `foreign`/`unknown` (Manifest rev 14 `UI-AGENT-ACCESS-KEYS`, `UI-API-KEYS-AGENTS`; Wortlaut der Oberfläche aus `en.json`, die Doku umschreibt ihn nur); 5 = Spec „Freigabe“, `TRANSPORT_IDLE_MS` (12 h) aus `server/lib/mcp/server.js` (Task 2), Eintragsstempel der Sitzungsfreigabe (Task 6), `proxy_read_timeout` auch für `/api/vault/agent-keys` (Task 8, Einrichtung über SSH); 6 = Spec „Authentifizierung“ (`TRUST_PROXY`), `parseTrustProxy` in `server/index.js` (heute Z. 43-55, durch Tasks 1 und 8 verschoben; maßgeblich die Funktion); 7 = Spec „Grenze des Modells“, „Folgen für die Browser-Sitzung“, „Impersonation“, „Audit“, `vaultGuard.assertInputAllowed` (Task 9), `impersonatorId` über `server/utils/auditContext.js` nur in HTTP-Audits und `POST /api/accounts/api-keys` mit `requireLoginSession` (Task 4), `INVALID_PROFILE` für Agenten-Keys (Task 7); 8 = dieser Task; 9 = Spec „`vault_list`“, „`browser_fill_credential`“, Nachprüfung nach der Freigabe (Task 11), `vault.via_not_allowed` für jede Sitzung mit `via` (`assertFillableSession`, Task 11) gegenüber dem Browser-Fehler `VIA_NOT_ALLOWED` und `INVALID_PROFILE` von `browser_open` (Task 7), `server/lib/vault/errors.js` inkl. `vault.input_locked` (Task 1). Weicht ein Wert im gebauten Code ab (z. B. Limit, Zeitspanne, Fehlercode), gilt die Spec; den Befund melden statt die Doku anzupassen.

- [ ] **Step 10: Sidebar-Eintrag in `docs/.vitepress/config.mjs`**

Vorher (Z. 88-89):

```js
                    { text: "Browser Tabs & Claude", link: "/browser-tabs" },
                    { text: "CLI", link: "/cli" },
```

Nachher:

```js
                    { text: "Browser Tabs & Claude", link: "/browser-tabs" },
                    { text: "Vault", link: "/vault" },
                    { text: "CLI", link: "/cli" },
```

- [ ] **Step 11: Oberflächentexte der Doku gegen `en.json` prüfen**

Die Doku nennt Knöpfe und Bereiche fett mit ihrem englischen Text. Diese Texte gehören Task 10 (`client/public/assets/locales/en.json`); die Doku folgt ihnen, nicht umgekehrt.

```bash
cd /root/outpost && node - <<'EOF'
const en = require("./client/public/assets/locales/en.json");
const values = new Set();
const walk = (node) => { for (const v of Object.values(node)) typeof v === "string" ? values.add(v) : walk(v); };
walk(en);
const labels = ["Vault", "Outpost address for agents", "Agent access…", "Only from this server's IP", "Approval required",
    "All servers", "Once", "For this session", "Deny", "Show", "Copy", "Edit"];
for (const label of labels) if (!values.has(label)) console.log("missing:", label);
EOF
```

Expected: keine Ausgabe. Meldet das Skript `missing: …`, in `docs/vault.md` jede Stelle dieses Texts durch den tatsächlichen Wert aus `en.json` ersetzen (`grep -n "<Text>" docs/vault.md`) und das Skript mit dem neuen Text erneut laufen lassen; `en.json` wird hier nicht geändert.

- [ ] **Step 12: Doku bauen (tote Links)**

Run: `cd /root/outpost && yarn docs:build`
Expected: `build complete`, keine `dead link`-Meldung; `docs/.vitepress/dist/vault.html` existiert. `docs/public/openapi.json` und `docs/.vitepress/dist` sind in `.gitignore` (Z. 141-143) und bleiben ungestaged. Die neue Route erscheint in der API-Referenz unter dem Tag „Security“.

- [ ] **Step 13: Commit**

```bash
git add docs/vault.md docs/.vitepress/config.mjs
git commit -m "Vault: Doku zu Schlüssel, Agenten-Zugang, Freigaben und Sicherheitsmodell"
```

---

### Task 17: Volle Prüfung, Sicherheitsabgleich, manuelle Tests mit Claude Code und Codex

**Files:**
- Modify: `docs/vault.md` (Abschnitt 8: der Satz „Enforcing will become the default in a later release.“ bekommt den Link auf das Issue aus Schritt 8 Punkt 15)
- Sonst keine eigenen Dateien. Befunde werden in der Datei behoben, die in der **Files:**-Zeile des jeweiligen Tasks steht (bei mehreren Kandidaten der Task der Spalte „Task(s)“ in SEC-COVERAGE), mit den betroffenen Tests geprüft und einzeln committet (`Vault: …`).

**Interfaces:**
- Consumes: alles aus Tasks 1–16; `docs/vault.md` Abschnitt 8 aus Task 16.
- Produces: GitHub-Issue „CSP standardmäßig scharf“ in `CallMeTechie/outpost` mit Zieldatum 2026-12-31, verlinkt aus `docs/vault.md`.

**Design:** kein UI-Anteil. (Der Abgleich der gebauten Oberfläche mit dem Manifest, Revision 14, läuft als `/mockingbird:design-verify` in Schritt 7.)

**Tests:** volle Suite (`yarn test`: Server-, Skript- und Client-Tests), die Chromium-Reihe mit gesetzten Umgebungsvariablen (sonst übersprungen: Spec-Tests 7, 8, 12, Review Focus 1, `vault.input_locked`), Lint beider Teile, Client-Build, Doku-Build, Sicherheitsabgleich über die Tabelle SEC-COVERAGE, manuelle Checkliste auf einem LAN-Server mit Claude Code und Codex, Migration 0047 einmal gegen MySQL (Schritt 9; die Suite läuft nur auf SQLite). Keine neuen Tests. Deckt alle SEC-IDs ab (Nachweis je ID in der Tabelle unten).

**Parallel:** none — einziger Task der Welle F; prüft den gemergten Gesamtstand aller Tasks einschließlich der Doku aus Task 16 (Welle E).

- [ ] **Step 1: Volle Suite**

Run: `cd /root/outpost && yarn test`
Expected: alle Server-, Skript- und Client-Tests grün. Die Chromium-Reihe meldet `# SKIP set OUTPOST_BROWSER_E2E_LAUNCHER and OUTPOST_BROWSER_E2E_PAGE_HOST` — sie läuft in Schritt 2.

- [ ] **Step 2: Chromium-Reihe gegen einen echten Launcher**

Der Launcher läuft vorübergehend auf dem NAS (Docker vorhanden), mit veröffentlichten Ports; die Testseiten liefert der Testprozess auf dieser Maschine aus.

```bash
ssh -i ~/.ssh/synology-manager-plus_ed25519 ma.backes@192.168.2.151 \
  'sudo /usr/local/bin/docker run -d --rm --name outpost-browser-e2e -p 9300:9300 -p 9222:9222 -p 9230-9269:9230-9269 ghcr.io/callmetechie/outpost-browser:latest'
cd /root/outpost && OUTPOST_BROWSER_E2E_LAUNCHER=http://192.168.2.151:9300 \
  OUTPOST_BROWSER_E2E_PAGE_HOST=$(hostname -I | awk '{print $1}') \
  node --test server/lib/browser/__tests__/chromium.e2e.test.js
ssh -i ~/.ssh/synology-manager-plus_ed25519 ma.backes@192.168.2.151 'sudo /usr/local/bin/docker stop outpost-browser-e2e'
```

Expected: alle Tests grün, keiner übersprungen (der Chromium-Test aus Task 9, Spec-Tests 7, 8, 12, Review Focus 1 und `vault.input_locked` aus Task 11). Der Container wird danach gestoppt; ohne `ALLOWED_CLIENTS` darf er nicht stehen bleiben.

- [ ] **Step 3: Lint**

Run: `cd /root/outpost && yarn lint && yarn --cwd client lint`
Expected: keine Errors.

- [ ] **Step 4: Client-Build**

Run: `cd /root/outpost && yarn --cwd client build`
Expected: Build erfolgreich (die bekannte Warnung „Some chunks are larger than 500 kB“ ist Bestand).

- [ ] **Step 5: Doku-Build**

Run: `cd /root/outpost && yarn docs:build`
Expected: `build complete`, keine `dead link`-Meldung; die API-Referenz enthält die Vault-Routen und `POST /csp-report`.

- [ ] **Step 6: Sicherheitsabgleich (SEC-*)**

```bash
cd /root/outpost
git diff main --stat -- package.json yarn.lock client/package.json client/yarn.lock
yarn audit --groups dependencies --level high; yarn --cwd client audit --groups dependencies --level high
grep -rn "dangerouslySetInnerHTML" client/src/pages/Vault client/src/common/components/VaultApprovalCard \
  client/src/pages/Servers/components/AgentAccessDialog client/src/pages/Settings/pages/Vault \
  client/src/pages/Settings/pages/Account/components/AgentKeysSection
grep -rn "sequelize\.query\|literal(" server/lib/vault server/routes/vault \
  server/controllers/vaultItems.js server/controllers/vaultSettings.js server/controllers/agentKeys.js
grep -n "afterFind" server/models/VaultSecret.js
grep -rn "rateLimit(\|Limiter" server/routes/vault server/routes/cspReport.js
grep -rn "requireLoginSession" server/routes/vault server/routes/apiKey.js
grep -rn "logger\.\(info\|warn\|error\|debug\|system\|verbose\)" server/lib/vault server/lib/browser/vaultGuard.js \
  server/controllers/vaultItems.js server/controllers/vaultSettings.js server/controllers/agentKeys.js server/routes/vault
grep -n "execCommand(" server/controllers/agentKeys.js
```

Expected, Zeile für Zeile:
1. keine Ausgabe (keine neuen Abhängigkeiten → SEC-DEP-01 ohne neue Angriffsfläche);
2. beide `yarn audit`-Läufe ohne neue Befunde gegenüber `main`;
3. keine Treffer (SEC-XSS-01);
4. keine Treffer (SEC-SQLI-01; Abfragen nur über Sequelize-`where`/`Op`);
5. keine Treffer (kein Klartext über Finder, Spec „`vault_secrets`“);
6. Limiter an Reveal (`items.js`), Freigabe-Antwort (`approvals.js`), Agenten-Einrichtung (`agentKeys.js`) und `cspReport.js` (SEC-RATE-01);
7. `requireLoginSession` an Reveal, `POST /approvals/:id`, `POST /agent-keys`, `POST /agent-keys/:id/confirm`, `DELETE /agent-keys/:id` und `POST /` in `server/routes/apiKey.js` (Konto-Key anlegen) (Impersonation und Konto-Keys → `403`);
8. jede Log-Zeile nennt nur IDs, Codes, Feldnamen, Ursprünge oder Adressen — keine Variable mit Wert, Key, Token oder fertigem Befehl (SEC-SECRET-01). Jede Zeile einzeln lesen;
9. jede Fundstelle übergibt einen Befehl, den eine Funktion aus `server/lib/vault/provision.js` gebaut hat — kein Template-String und keine Verkettung im Controller (SEC-INJECT-01). Danach `server/lib/vault/provision.js` lesen: jede Interpolation von URL, Key, CLI-Pfad und Key-Präfix steht in `shQuote(…)`.

Danach die Tabelle SEC-COVERAGE unten Zeile für Zeile abhaken: Testdatei öffnen und prüfen, dass der genannte Fall wirklich darin steht. Fehlt ein Nachweis → Befund.

- [ ] **Step 7: Design-Abgleich**

`/mockingbird:design-verify` für die Screens `UI-VAULT`, `UI-VAULT-DIALOG`, `UI-AGENT-ACCESS`, `UI-VAULT-SETTINGS`, `UI-API-KEYS`, `UI-VAULT-APPROVAL` und die ergänzten Bestandselemente `UI-SHELL-NAV`, `UI-SHELL-MOBILE-NAV`, `UI-SERVERS-LIST-MENU` (Manifest `docs/design/manifest.yaml`, Revision 14, inkl. der Entziehen-Zustände `partial`/`disabled` in `UI-AGENT-ACCESS-KEYS` und `UI-API-KEYS-AGENTS`). Befunde in den Dateien der Tasks 10, 12–15 beheben, betroffene vitest-Dateien laufen lassen (`yarn --cwd client vitest run <pfad>`), committen. Die übrigen Review-Ketten (footgun, code-review) laufen wie gewohnt einmal an diesem Phasenende, nicht je Task.

- [ ] **Step 8: Manuelle Prüfung auf einem LAN-Server mit Claude Code und Codex**

Aufbau: Branch-Image wie gewohnt auf die Testinstanz einspielen, mit Browser-Container (`docs/browser-tabs.md`), `VAULT_KEY` (`openssl rand -hex 32`) und **Einstellungen › Vault › Outpost-Adresse für Agenten** = LAN-Adresse der Testinstanz. Zielserver `web01`: SSH-Eintrag in Outpost, Claude Code und Codex für den SSH-Benutzer installiert. Testkonto A mit `vault.use` und `connect.browser`, Konto B (zweites Konto), Organisation mit A als aktivem Mitglied. Auf `web01` eine Anmeldeseite ausliefern:

```bash
mkdir -p ~/vault-login && cat > ~/vault-login/index.html <<'EOF'
<!doctype html><title>Vault login</title>
<form method="get" action="/done.html">
  <label>User <input name="user" type="text"></label>
  <label>Password <input id="pw" name="pw" type="password"></label>
  <button type="button" onclick="pw.type = pw.type === 'password' ? 'text' : 'password'">Show password</button>
  <button type="submit">Sign in</button>
</form>
EOF
echo '<!doctype html><title>Done</title><h1>Signed in</h1>' > ~/vault-login/done.html
cd ~/vault-login && python3 -m http.server 8080
```

Login-Eintrag `portal` (persönlich, Benutzer `ada`, Passwort `S3cr3t&p=1 x`, Ursprung `http://web01:8080`, Gilt für: `web01`, Freigabe an) und `other` (gebunden an einen anderen Server).

1. **Schlüsselzustand.** Ohne `VAULT_KEY`: kein Bereich „Vault“ in der Navigation, `GET /api/vault/items` → `404`, Einstellungen › Vault zeigt „Fehlt“. Mit Schlüssel: „Aktiv“. Danach mit einem anderen Schlüssel neu starten: „Passt nicht“, Vault aus; mit dem richtigen Schlüssel wieder „Aktiv“, Einträge lesbar.
2. **Einrichten.** Kontextmenü `web01` › „Agenten-Zugang…“ › Claude Code und Codex › Einrichten. Ergebnis „Eingerichtet für <benutzer>“ je Agent; Messung ohne Abweichung. Auf `web01`: `stat -c %a ~/.claude.json ~/.codex/outpost.env` → `600 600`; die `.bashrc` enthält die Zeile genau einmal (Einrichten ein zweites Mal ausführen, dann erneut prüfen). Einstellungen › Konto zeigt beide Keys unter Agenten-Schlüssel bei `web01`, nicht in der Liste der API-Schlüssel. Doppelklick auf „Einrichten“ → genau ein Einrichtungslauf: je Agent ein Key und ein Audit `vault.agent_key_create`; ein zweiter `POST /api/vault/agent-keys` für `web01` aus einem anderen Fenster, solange der erste läuft → `409`.
3. **`/mcp`.** Claude Code neu starten, `/mcp` → `outpost` verbunden. Codex in einer **neuen** Shell starten, `/mcp` → `outpost` gelistet; in einer vor der Einrichtung geöffneten tmux-Sitzung fehlt der Key (`echo ${OUTPOST_MCP_TOKEN:+gesetzt}` gibt nichts aus). Testinstanz kurz ohne `VAULT_KEY` neu starten → `/mcp` in Claude meldet den Fehler, `curl` mit dem Agenten-Key an `/api/mcp` → `401`; mit Schlüssel neu starten → wieder verbunden.
4. **`vault_list`.** Claude ruft `vault_list`: `portal` erscheint mit `usableBy: ["browser_fill_credential"]`, `other` fehlt. Das Transcript (`~/.claude/projects/…/*.jsonl` auf `web01`) enthält weder `S3cr3t` noch Teile davon. Mit einem Agenten-Key `GET /api/vault/items` per `curl` → `403` „Agent keys can only access the MCP endpoint“. Claude ruft `browser_open` mit `profile: "persistent"` → `INVALID_PROFILE` „Agent keys can only open ephemeral sessions; …“.
5. **Ausfüllen mit Freigabe.** Claude öffnet `http://web01:8080/`, macht einen Snapshot und ruft `browser_fill_credential` für `portal`. Die Freigabe-Karte erscheint in jedem Outpost-Fenster und im Popout; „Einmal“ → Antwort „eingetragen“, die Felder sind gefüllt. Snapshot zeigt `value="••••"`. „Show password“ klicken → Snapshot weiter `••••`, `browser_screenshot` → `vault.screenshot_locked`, `browser_evaluate` → `vault.evaluate_locked`. „Sign in“ klicken → `URL:` in der Antwort, `browser_list` und das Audit-Detail `url` zeigen `pw=••••` statt des Werts (auch kodiert). Audit-Log: `vault.approve`, `vault.use` mit Eintrag, Agent, Server, Ziel, ohne Wert. Danach in derselben Sitzung `browser_key` mit `Control+a` und `browser_click` mit `clickCount: 3` auf die Überschrift → beide `vault.input_locked`, Audit `vault.input_locked`; `browser_click` mit `button: "middle"` in einer neuen Sitzung ohne Ausfüllen → ebenfalls `vault.input_locked`. `Tab` und `Shift+Tab` gehen weiter. (Review Focus 1)
6. **Freigabe-Zeiten.** Neuer Aufruf, erst nach ca. 100 s „Einmal“ → Claude füllt noch aus. Während einer offenen Karte ruft Claude in derselben Sitzung `browser_evaluate` mit `1`; danach „Einmal“ → `vault.session_tainted`, nichts getippt (Review Focus 2). Codex mit Standard-`tool_timeout_sec`: nach 60 s verschwindet die Karte, Audit `vault.approval_timeout` mit `reason: "client_gone"`; mit `tool_timeout_sec = 180` in `~/.codex/config.toml` gelingt eine Freigabe nach 90 s.
7. **Antwortarten.** „Für diese Sitzung“ → zweites Ausfüllen ohne Karte; nach `/clear` in Claude weiterhin ohne Karte; Beschreibung von `portal` ändern und speichern → nächstes Ausfüllen wieder mit Karte (Freigabe an den Eintragsstand gebunden); erneut „Für diese Sitzung“, nach Neustart von Claude Code wieder mit Karte. „Ablehnen“ → `vault.approval_denied`, ein Folgeaufruf innerhalb von 60 s ebenso, ohne neue Karte. Alle Outpost-Fenster schließen → `vault.approval_unavailable`.
8. **Entziehen.** Einstellungen › Konto › Agenten-Schlüssel › Entziehen (Bestätigungsdialog) für Claude Code → `/mcp` meldet den Fehler; `claude mcp get outpost` auf `web01` findet nichts; die Antwort von `DELETE /api/vault/agent-keys/:id` (Netzwerk-Tab) trägt `registration: "removed"`. Für Codex: `~/.codex/outpost.env` ist weg, `codex mcp list` ohne `outpost`.
9. **Zwei Konten, ein Unix-Benutzer.** Konto A richtet Claude Code auf `web01` ein, danach Konto B für denselben Server und Benutzer: der Dialog warnt vor dem Einrichten. Konto A entzieht seinen Zugang → Antwort mit `registration: "foreign"` und entsprechendem Hinweis im Dialog, `claude mcp get outpost` zeigt weiter die Registrierung von B, B funktioniert. (Review Focus 4)
10. **NAS mit Docker-Gateway.** SSH-Eintrag für das NAS selbst (`192.168.2.151`), Outpost-Testinstanz läuft dort im Docker. Agenten-Zugang einrichten: CLI fehlt → Ergebnis zeigt den Befehl; Messung meldet „Gesehen wurde 172.x.0.1 statt 192.168.2.151“. **Ohne** Übernahme Befehl kopieren, dann auf dem NAS mit dem Key aus dem Befehl:

    ```bash
    read -rs KEY
    curl -s -o /dev/null -w '%{http_code}\n' -X POST http://192.168.2.151:6989/api/mcp \
      -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
      -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
    ```

    → `403`, Audit `vault.agent_ip_denied` genau einmal, auch nach drei Wiederholungen. Zugang entziehen, neu einrichten, diesmal die gemessene Adresse übernehmen → derselbe `curl` → `200`. Eine Übernahme mehr als 15 Minuten nach dem Anlegen wird abgelehnt, und `allowedCidrs` bleibt unverändert. (Review Focus 3)
11. **Impersonation.** Admin › Benutzer › als Konto A anmelden: Vault-Seite zeigt Einträge ohne „Anzeigen“/„Kopieren“, das Kontextmenü zeigt kein Einrichten, Freigabe-Karten erscheinen in diesem Fenster nicht. Ist nur das Impersonations-Fenster offen, bekommt Claude `vault.approval_unavailable`. `curl` mit dem Impersonations-Token (`localStorage.overrideToken`) auf `GET /api/vault/items/<id>/secrets/password` und `POST /api/vault/approvals/<id>` → `403`. „Freigabe erforderlich“ an `portal` ausschalten und speichern → `403` „Turning off approvals requires a signed-in session“; derselbe `PATCH` mit einem Konto-API-Key von A → ebenfalls `403`. Einstellungen › Konto › API-Schlüssel anlegen in der Impersonation scheitert, ebenso `curl -X POST http://<Testinstanz>/api/accounts/api-keys -H "Authorization: Bearer <Impersonations-Token>" -H 'Content-Type: application/json' -d '{"name":"x"}'` → `403` „This action requires a signed-in session“; die Liste der API-Schlüssel von A bleibt unverändert. In der Impersonations-Sitzung mehrere Aktionen über HTTP auslösen, die im Audit-Log landen — Vault-Eintrag anlegen, ändern, löschen, eine Identität anlegen (`identity.create`, außerhalb der Kategorie Vault) — und im Audit-Log prüfen: **jeder** Eintrag aus diesen HTTP-Anfragen trägt `details.impersonatorId` mit der ID des Admins. Gegenprobe zur dokumentierten Grenze: eine SSH-Verbindung zu `web01` aus der Impersonation (WebSocket) erzeugt `entry.ssh_connect` **ohne** `impersonatorId`; ein anderes Ergebnis → Befund für Task 4 und `docs/vault.md` Abschnitt 7.
12. **Organisation verlassen.** Server `web01-org` (SSH-Eintrag auf denselben Host, in einem Ordner der Organisation) mit Agenten-Zugang für Claude Code; Organisationseintrag `org:<id>/shared` (Login, Ursprung `http://web01:8080`, Freigabe an) mit Geltung für diesen Ordner; Claude sieht ihn in `vault_list`. (a) Claude ruft `browser_fill_credential` für `org:<id>/shared`; während die Karte wartet, wird A aus der Organisation entfernt; danach „Einmal“ → `vault.item_unknown`, nichts getippt (Nachprüfung nach der Freigabe). (b) Ab jetzt weist Outpost den Agenten-Key von `web01-org` ab: der nächste Werkzeugaufruf desselben laufenden Claude-Prozesses scheitert mit `403` an `/api/mcp`. A wird wieder aufgenommen → derselbe Key funktioniert wieder (Zugriffsprüfung je Anfrage, kein Widerruf).
13. **Zieländerung.** Ursprung von `portal` ändern → Dialog verlangt das Passwort neu (Zustand leer), Audit `vault.item_update` mit `secretsCleared: true`; Ausfüllen auf der alten Seite → `vault.origin_mismatch`.
14. **`TRUST_PROXY=true`.** Testinstanz damit starten → Warnung in Einstellungen › Vault und im Agenten-Zugang-Dialog; danach wieder entfernen.
15. **CSP.** In den Entwicklerwerkzeugen des Browsers (Konsole) und im Server-Log auf `CSP violation` bzw. `[Report Only]` achten bei: SSH-Terminal, RDP oder VNC, Datei-Editor mit einer `.json`- und einer `.ts`-Datei (Monaco-Worker), Aufzeichnung im Audit abspielen (WebAssembly), Browser-Tab, Vault-Seite, Popout, Datei-Vorschau (Bild, PDF, HTML). Erwartet: keine Meldung. Vorschau im eigenen Tab: auf `web01` `~/preview.html` mit `<script>document.title = window.origin + ":" + (() => { try { return localStorage.length; } catch { return "blocked"; } })();</script>` anlegen, in der Datei-Vorschau öffnen, die `src` des Vorschau-iframes aus den Entwicklerwerkzeugen kopieren und direkt in einen neuen Tab einfügen (nicht per Klick aus dem iframe: ein daraus geöffneter Tab erbt die Sandbox des iframes und zeigt den Header nicht) → Tab-Titel `null:blocked` (undurchsichtige Herkunft, kein Zugriff auf den Speicher von Outpost); Antwort-Header dort `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups`. Die PDF-Vorschau trägt diesen Header nicht und zeigt das PDF an. Ein anderer Titel → Befund für `contentHeaders` in `server/lib/fileContent/download.js` (Task 16). Schon im Report-Only-Modus trägt die Antwort auf `/` zusätzlich `Content-Security-Policy: frame-ancestors 'self'` und `X-Frame-Options: SAMEORIGIN`; eine Testseite auf `web01` mit `<iframe src="http://<Testinstanz>/">` zeigt Outpost nicht (Konsole: Verstoß gegen `frame-ancestors`). Danach `CSP_ENFORCE=true` setzen, neu starten, dieselben Stationen kurz wiederholen: alles funktioniert, Antwort-Header `Content-Security-Policy` mit allen Direktiven, kein Report-Only-Header. Jede Meldung → Befund für `server/lib/staticSite.js` (Task 16), Policy und Begründungstabelle in Task 16 und `docs/vault.md` gemeinsam anpassen.

    Zum Schluss das Issue für den Wechsel anlegen und in der Doku verlinken:

    ```bash
    cd /root/outpost && gh issue create --repo CallMeTechie/outpost --title "CSP standardmäßig scharf" \
      --body "Zieldatum: 2026-12-31. CSP_ENFORCE=true wird Standard (Report-Only nur noch per CSP_ENFORCE=false), sobald die Report-Only-Phase ohne CSP violation im Log abgeschlossen ist. Stationen und Begründung: docs/vault.md Abschnitt 8; Policy: server/lib/staticSite.js."
    ```

    In `docs/vault.md` Abschnitt 8 den Satz „Enforcing will become the default in a later release.“ ersetzen durch „Enforcing will become the default in a later release, planned by 2026-12-31 ([issue #<n>](https://github.com/CallMeTechie/outpost/issues/<n>)).“ (`<n>` aus der Ausgabe von `gh`), `yarn docs:build` ohne `dead link`, dann `git add docs/vault.md && git commit -m "Vault: Doku verlinkt das Issue zur scharfen CSP"`.

Befund → Fix in der betroffenen Datei, betroffene Tests laufen lassen, Commit `Vault: …`.

- [ ] **Step 9: Migration 0047 gegen MySQL (manuell)**

Die Suite prüft 0047 nur auf SQLite (`state.test.js`). MySQL legt Fremdschlüssel beim `addColumn` und Indizes anders an und verweigert das Löschen eines Index, den ein Fremdschlüssel braucht; deshalb einmal gegen einen echten MySQL-Server, vorübergehend auf dem NAS. Geprüft wird: frischer Lauf 0001–0047, zweiter Lauf von 0047 auf vollständigem Stand, Lauf auf einem Halbstand (ein Unique-Index und eine Spalte fehlen), danach die Fremdschlüssel.

```bash
ssh -i ~/.ssh/synology-manager-plus_ed25519 ma.backes@192.168.2.151 \
  'sudo /usr/local/bin/docker run -d --rm --name outpost-mysql-e2e -p 33306:3306 -e MYSQL_ROOT_PASSWORD=outpost-e2e -e MYSQL_DATABASE=outpost mysql:8.4'
sleep 30
cd /root/outpost && DB_TYPE=mysql DB_HOST=192.168.2.151 DB_PORT=33306 DB_NAME=outpost DB_USER=root DB_PASS=outpost-e2e node - <<'JS'
const db = require("./server/utils/database");
const MigrationRunner = require("./server/utils/migrationRunner");
const run = () => new MigrationRunner().runMigrations();
const forget0047 = () => db.query("DELETE FROM SequelizeMeta WHERE name = '0047-add-vault.js'");
(async () => {
    await run();
    await forget0047();
    await run();
    await db.query("ALTER TABLE vault_items ADD INDEX e2e_org (organizationId), DROP INDEX vault_items_organization_name_unique");
    await db.query("ALTER TABLE api_keys DROP COLUMN seenIpAdopted");
    await forget0047();
    await run();
    const [indexes] = await db.query("SHOW INDEX FROM vault_items WHERE Key_name = 'vault_items_organization_name_unique'", { raw: true });
    const [columns] = await db.query("SHOW COLUMNS FROM api_keys LIKE 'seenIpAdopted'", { raw: true });
    const [fks] = await db.query(`SELECT k.TABLE_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_NAME, r.DELETE_RULE
        FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r
          ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
        WHERE k.CONSTRAINT_SCHEMA = 'outpost'
          AND (k.TABLE_NAME LIKE 'vault%' OR (k.TABLE_NAME = 'api_keys' AND k.COLUMN_NAME IN ('entryId', 'identityId')))
        ORDER BY k.TABLE_NAME, k.COLUMN_NAME`, { raw: true });
    console.log("unique index back:", indexes.length > 0, "| column back:", columns.length === 1);
    console.table(fks);
    await db.close();
})().catch((error) => { console.error(error.message); process.exit(1); });
JS
ssh -i ~/.ssh/synology-manager-plus_ed25519 ma.backes@192.168.2.151 'sudo /usr/local/bin/docker stop outpost-mysql-e2e'
```

Expected: kein `Migration failed`, alle drei Läufe ohne Fehler; `unique index back: true | column back: true`; die Tabelle nennt genau sieben Fremdschlüssel: `api_keys.entryId → entries CASCADE`, `api_keys.identityId → identities SET NULL`, `vault_bindings.itemId → vault_items CASCADE`, `vault_items.accountId → accounts CASCADE`, `vault_items.createdBy → accounts SET NULL`, `vault_items.organizationId → organizations CASCADE`, `vault_secrets.itemId → vault_items CASCADE`. Fehlt ein Fremdschlüssel aus `addColumn` oder bricht ein Lauf ab → Befund für `server/migrations/0047-add-vault.js` (Task 1), mit `state.test.js` prüfen, committen. Der Container wird danach gestoppt (`--rm` löscht ihn samt Daten); ohne Passwortschutz nach außen darf er nicht stehen bleiben.

- [ ] **Step 10: Branch abschließen**

REQUIRED SUB-SKILL: superpowers:finishing-a-development-branch.

#### SEC-COVERAGE

Jede SEC-ID aus dem preflight-Block der Spec (`docs/superpowers/specs/2026-10-09-vault-core-design.md`, „Security Requirements“) mit Umsetzung, Task und Testnachweis.

| ID | Status | Umsetzung | Task(s) | Testnachweis |
|---|---|---|---|---|
| SEC-INPUT-01 | required | Joi-Whitelist für `fields` je Typ, Namensmuster `^[a-z0-9][a-z0-9._-]{0,63}$`, Ursprünge `scheme://host[:port]`, `agentUrl` nur http/https (`server/validations/vault.js`); CIDRs und `agentTypes` beim Einrichten; Argumente von `vault_list`/`browser_fill_credential`; `/api/csp-report` nur zwei Content-Types, 64 kB, `directive`/`disposition` nur als Schlüsselwort der festen Liste | 5, 8, 11, 16 | `server/lib/vault/__tests__/validation.test.js`; `agentKeysRoute.test.js` (Teilfall CIDR-Prüfung); Argumente der Vault-Werkzeuge per Code-Lesung: `assertFillArgs` in `server/lib/vault/mcpProvider.js` (Task 11; `item` String mit 1–200 Zeichen, `passwordRef`/`usernameRef` nach `REF_PATTERN`, `sessionId` String, sonst `INVALID_ARGUMENT`; kein eigener Test in `mcpProvider.test.js`); `cspHeader.test.js` (Test 4 Typen, Test 5 Schlüsselwörter) + Schritt 7 in Task 16 (`413`) |
| SEC-ERR-01 | required | `VaultError` mit festen englischen Texten (`server/lib/vault/errors.js`); Werkzeugfehler als `isError` mit Code, nie Stack; REST `{ code, message }`; „nicht lesbar“ ohne Details; Report-Endpunkt antwortet ohne Body | 1, 5, 11, 16 | `mcpProvider.test.js` (Fehlerantworten tragen Code und festen Text); `itemsRoute.test.js`; Task 16 Schritt 7 |
| SEC-SECRET-01 | required | `VAULT_KEY` per Umgebung oder `/run/secrets/vault_key`, AES-256-GCM mit AAD; Listen ohne Werte; Schwärzung in Snapshots, URLs, Listen, Audit; Auswahl und Zwischenablage im befüllten Kontext gesperrt (`vaultGuard.assertInputAllowed` → `vault.input_locked`, Mittelklick immer), Feld vor dem Tippen per `Runtime.callFunctionOn` geleert statt markiert; Key nur im Einrichtungsdialog, `command` nur bei `manual` | 1, 5, 8, 9, 11, 16 (Doku) | `crypto.test.js` (falsche AAD/Schlüssel wirft), `state.test.js`; `itemsRoute.test.js` (Liste ohne Wert); `vaultGuard.test.js`; `mcpProvider.test.js` (Spec-Test 5); `chromium.e2e.test.js` (Task 9: `browser_type` + „Show password“; Task 11: Spec-Test 8 und `Control+a`/`clickCount: 3` nach dem Ausfüllen → `vault.input_locked`, Mittelklick in neuem Kontext fügt nichts ein); Schritt 6 Zeile 8; Schritt 8 Punkt 5 |
| SEC-DEP-01 | required | keine neuen Abhängigkeiten; Lockfiles unverändert | alle | Schritt 6 Zeilen 1–2 |
| SEC-INJECT-01 | required | Einrichtungs-, Mess- und Entfernbefehle nur über `shQuote` in `server/lib/vault/provision.js`; `umask 077` | 8 | `provision.test.js` (Spec-Test 9: URL und Key mit Sonderzeichen; Entfernen nur bei passendem Präfix); Schritt 6 Zeile 9 |
| SEC-RATE-01 | required | Limiter an Reveal (30/min je Konto), Freigabe-Antwort, Agenten-Einrichtung/-Bestätigung/-Entzug, `/api/csp-report` (30/min je IP); Vault-Werkzeuge über die Freigabe-Grenzen (3 offene je Aufrufer, eine je Transport und Eintrag, 60 s nach `deny`) | 5, 6, 8, 11, 16 | `approvals.test.js` (`approval_busy`, `approval_pending`, Sperre nach `deny` auch über neuen Transport); Schritt 6 Zeile 6; Task 16 Schritt 7 (`429`) |
| SEC-RATE-02 | not-applicable | Login unverändert; Agenten-Keys mit 256 Bit Entropie | – | – |
| SEC-SQLI-01 | required | Sichtbarkeit, Bindungen, Agenten-Keys nur über Sequelize-Finder mit `where`/`Op` | 3, 4, 8 | `visibility.test.js`, `bindings.test.js` (In-Memory-SQLite); Schritt 6 Zeile 4 |
| SEC-XSS-01 | required | Vault-Seite, Freigabe-Karte und angezeigte Werte rendern als React-Kinder, kein `dangerouslySetInnerHTML`; CSP als zweite Linie | 12, 13, 16 | `VaultDetail.test.jsx`, `VaultApprovalStack.test.jsx`; Schritt 6 Zeile 3 |
| SEC-CSP-01 | required | `Content-Security-Policy-Report-Only` auf der statischen Seite, Meldeendpunkt, scharf mit `CSP_ENFORCE=true` nach Auswertung; `frame-ancestors 'self'` als erzwungenes `Content-Security-Policy` und `X-Frame-Options: SAMEORIGIN` schon im Report-Only-Modus; Vorschau-Antworten außer PDF mit `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups` (`contentHeaders`), auch im eigenen Tab; Issue „CSP standardmäßig scharf“ mit Zieldatum 2026-12-31, verlinkt in `docs/vault.md` | 16, 17 | `cspHeader.test.js` (Test 1: Report-Only plus erzwungenes `frame-ancestors` und `X-Frame-Options`; Test 2 scharf; Test 3 Host-Header; Test 4 beide Report-Typen); `server/lib/fileContent/__tests__/download.test.js` (Vorschau außer PDF sandboxed, Download und PDF ohne); Schritt 8 Punkt 15 (Einbetten scheitert, Vorschau im neuen Tab `null:blocked`, Issue angelegt) |
| SEC-UPLOAD-01 | not-applicable | Vault nimmt keine Dateien an | – | – |
| SEC-IDOR-01 | required | Einträge und Werte nur nach `canManageItem`/`canRevealItem`/Sichtbarkeit; Freigaben nur für das besitzende Konto (`404` sonst); Agenten-Keys je Konto; fremder MCP-Transport `404`; fremde Browser-Sitzung wie unbekannt, auch beim Ausfüllen; Agenten-Keys öffnen nur ephemere Sitzungen (`INVALID_PROFILE` für `persistent`) | 2, 5, 6, 7, 8, 11 | `server/lib/mcp/__tests__/server.test.js` (fremder Aufrufer `404`); `itemsRoute.test.js` (Spec-Test 3); `approvals.test.js` (Test 1: Antwort eines fremden Kontos → `404`); `agentKeysRoute.test.js` (fremde Key-ID `404`); `agentScope.test.js` (Spec-Test 10; `browser_open` mit `profile: "persistent"` → `INVALID_PROFILE`); `mcpProvider.test.js` (Spec-Test 10 Teil fill: fremde `sessionId` → `UNKNOWN_SESSION` wie unbekannt, ohne `sessionId` → `NO_SESSION`, nichts getippt) |
| SEC-TENANT-01 | required | Sichtbarkeit nur mit aktiver Mitgliedschaft; Organisationseinträge binden nur an Server/Ordner derselben Organisation; `allServers` = Server der Organisation laut `resolveEntryScope`; Reveal nach Organisationsrecht; Freigaben je Konto; nach der Freigabe Key, Sichtbarkeit (`findVisibleItem`), Typ und Ursprünge erneut geprüft | 3, 5, 6, 11 | `visibility.test.js` (Spec-Test 4 inkl. „Organisation verlassen“); `bindings.test.js` (Test 6: `validateBindings` mit Organisationsregel); `itemsRoute.test.js`; `mcpProvider.test.js` (Test 3: Mitgliedschaft während der Wartezeit entfernt → `vault.item_unknown`, Ursprung während der Wartezeit geändert → `vault.origin_mismatch`, jeweils nichts getippt); Schritt 8 Punkt 12 |
| SEC-RBAC-01 | required | `vault.use`, `vault.manage`, `vault.reveal`, `settings.vault` in `server/permissions/registry.js`, Client-Spiegel; Anbieter-`available`; `approvalRequired: false` nur mit Login-Session ohne Impersonation (sonst `403` „Turning off approvals requires a signed-in session“), Freigabe immer bei `ctx.impersonatorId`; kein Konto-Key-Anlegen aus Impersonation (`POST /api/accounts/api-keys` hinter `requireLoginSession`); `impersonatorId` in jedem Audit aus HTTP-Anfragen über `server/utils/auditContext.js` (WebSocket-Audits noch ohne, dokumentiert) | 1, 4, 5, 10, 11 | `itemsRoute.test.js` (Test 1: Mitglied ohne `vault.reveal` → `403`; Test 2: Impersonation und Konto-Key setzen `approvalRequired: false` → `403`); `agentAuth.test.js` (Test 5: `requireLoginSession`, `POST /api/accounts/api-keys` aus Impersonation → `403`, Audit aus einer Impersonations-Sitzung trägt `impersonatorId`); `mcpProvider.test.js` (Test 4: ohne `connect.browser` antwortet `browser_fill_credential` wie unbekannt); Schritt 8 Punkt 11 |
| SEC-APIKEY-01 | required | Agenten-Keys über `generateToken` (`outpost_` + 64 Hex), gespeichert als SHA-256 (`hashToken`), widerrufbar, `pending` nur an `probe`; Abgleich über den Hash als DB-Schlüssel (Bestand `validateApiKey`, kein `timingSafeEqual` — der Zeitunterschied verrät nur Präfixe des Hashes, nicht des Keys; im Review bestätigen) | 4, 8 | `agentAuth.test.js` (Spec-Test 1: nur `/api/mcp`, `pending` nur `probe`); `agentKeysRoute.test.js` (`pending`-Löschung, Entziehen) |
| SEC-SESS-02 | required | endgültige Agenten-Keys ohne Ablauf; Rotation durch Neu-Einrichten (ersetzt eigene alte Keys), Widerruf sofort; abgewiesen bei Zugriffsverlust auf den Server (`403`) und ausgeschaltetem Vault (`401`), `lastUsedAt` erst nach diesen Prüfungen; `pending` nach 15 min gelöscht; Sitzungsfreigaben an den Eintragsstempel (`updatedAt` und Ursprünge) gebunden und mit `forgetTransport` beendet; Transporte verfallen nach 12 h | 2, 4, 6, 8, 11 | `agentAuth.test.js` (Test 1: Agenten-Key ohne Serverzugriff → `403`); `agentKeysRoute.test.js` (`sweepPending`, Ersetzen, Entziehen); `approvals.test.js` (Test 2: Sitzungsfreigabe gilt nur für denselben Transport und denselben Eintragsstempel, nach geändertem Eintrag wieder Karte; `forgetTransport` vergisst sie); Schritt 8 Punkte 3 (Vault aus → `401`), 7, 8, 12 |
| SEC-TOKEN-01 | required | Bearer-Pfad in `authenticate` für Agenten-Keys mit IP-Bindung (`dns.lookup` all, Cache 60 s, Audit gedrosselt); `?sessionToken=` des Zustandsstroms nicht im Log (Prüfergebnis aus Task 4); CSP-Meldungen ohne Query-Strings | 4, 16 | `agentAuth.test.js` (Tests 3 und 4, Spec-Test 2); `cspHeader.test.js` (Test 5); Schritt 8 Punkt 10 |
| SEC-PII-01 | required | Benutzernamen nur in `fields`, nie in Logs; Audit der Nutzung ohne Werte; Löschen eines Eintrags entfernt Werte und Bindungen (CASCADE); Kontolöschung entfernt die Einträge des Kontos samt Werten und Bindungen per CASCADE, Organisationslöschung entfernt per `removeBindings` die Bindungen an Server und Ordner der Organisation und ihre Einträge per CASCADE | 1, 3, 5, 11 | `bindings.test.js` (Test 4, Review Focus 5: Löschen von Ordnern samt Unterordnern und Servern entfernt deren Bindungen; Test „Server, Tag, Integration oder Organisation löschen“: `deleteOrganization` entfernt die Bindungen an Server und Ordner der Organisation); `mcpProvider.test.js` (Test 2: Audit `vault.use` ohne Wert); Löschen eines Eintrags per Code-Lesung: `removeItem` in `server/controllers/vaultItems.js` (Task 5; `clearSecrets`, `setBindings(id, [])`, dann `VaultItem.destroy`; `DELETE` ist in `itemsRoute.test.js` bewusst ungetestet); Konto- und Organisationseinträge über die `CASCADE`-Fremdschlüssel aus Schritt 9, Bindungen an Organisationsziele über `removeBindings` in `server/controllers/organization.js` |

Hinweis: Mehrere Nachweise sind Teilfälle eines größeren Tests, nicht eigene Testfälle — CIDR-Prüfung (Task 8, `agentKeysRoute.test.js`), Organisationsregel von `validateBindings` (Task 3, `bindings.test.js` Test 6), Antwort eines fremden Kontos (Task 6, `approvals.test.js` Test 1), `forgetTransport` und Eintragsstempel (Task 6, `approvals.test.js` Test 2), `approvalRequired` (Task 5, `itemsRoute.test.js` Test 2), Nachprüfung nach der Freigabe (Task 11, `mcpProvider.test.js` Test 3), `impersonatorId` und `POST /api/accounts/api-keys` aus Impersonation (Task 4, `agentAuth.test.js` Test 5), Agenten-Key ohne Serverzugriff (Task 4, `agentAuth.test.js` Test 1), `INVALID_PROFILE` (Task 7, `agentScope.test.js`), `vault.input_locked` (Task 11, Chromium-Reihe). Schritt 6 prüft, dass jeder davon wirklich im genannten Test steht; fehlt einer, gehört er in den Task der Spalte „Task(s)“ und in dessen **Tests:**-Budget. Die Limiter selbst bleiben ungetestet (Zusage von express-rate-limit); Schritt 6 Zeile 6 prüft nur, dass sie hängen.

#### Spec-Tests und Review Focus → Nachweis

| Spec-Test / Review Focus | Task | Testdatei |
|---|---|---|
| 1 Agenten-Key nur `/api/mcp`, `pending` dort abgewiesen, fremde `Mcp-Session-Id` `404` | 4, 2 | `agentAuth.test.js`, `server/lib/mcp/__tests__/server.test.js` |
| 2 IP-Bindung | 4 | `agentAuth.test.js` (Tests 3, 4) |
| 3 Reveal | 5 | `itemsRoute.test.js` |
| 4 Sichtbarkeit (Tabelle) | 3 | `visibility.test.js` |
| 5 `vault_list` ohne Wert | 11 | `mcpProvider.test.js` |
| 6 Freigabe | 6, 11 | `approvals.test.js` (inkl. Eintragsstempel der Sitzungsfreigabe), `mcpProvider.test.js` (inkl. Nachprüfung nach der Freigabe) |
| 7, 8, 12 Chromium-Reihe | 9, 11 | `chromium.e2e.test.js` (Schritt 2; Spec-Test 8 im Kleinen auch aus Task 9) |
| 9 Quoting | 8 | `provision.test.js` |
| 10 Agenten-Key im Browser-Anbieter | 7, 11 | `agentScope.test.js` (Liste, fremde Sitzung, `via`, kein `persistent`); `mcpProvider.test.js` (Teil fill, Task 11: fremde `sessionId` → `UNKNOWN_SESSION` wie unbekannt, ohne `sessionId` → `NO_SESSION`, Audit `vault.use_denied`) |
| 11 `PATCH` löscht Werte, Impersonation `403`, `probe` | 5, 6, 8 | `itemsRoute.test.js`, `approvals.test.js`, `agentKeysRoute.test.js` |
| Review Focus 1 | 9, 11 | `vaultGuard.test.js`, `chromium.e2e.test.js`; Schritt 8 Punkt 5 |
| Review Focus 2 | 11 | `mcpProvider.test.js`; Schritt 8 Punkt 6 |
| Review Focus 3 | 4, 8 | `agentAuth.test.js`, `agentKeysRoute.test.js`; Schritt 8 Punkt 10 |
| Review Focus 4 | 8 | `provision.test.js`; Schritt 8 Punkt 9 |
| Review Focus 5 | 3 | `bindings.test.js` |

---

```
DESIGN-COVERAGE
UI-VAULT-NEW | covered | Task 12
UI-VAULT-SCOPE | covered | Task 12
UI-VAULT-SEARCH | covered | Task 12
UI-VAULT-TYPES | covered | Task 12
UI-VAULT-LIST | covered | Task 12
UI-VAULT-DETAIL | covered | Task 12
UI-VAULT-DETAIL-ACTIONS | covered | Task 12
UI-VAULT-DETAIL-FIELDS | covered | Task 12
UI-VAULT-DETAIL-SECRET | covered | Task 12
UI-VAULT-DETAIL-SCOPE | covered | Task 12
UI-VAULT-DETAIL-POLICY | covered | Task 12
UI-VAULT-DIALOG-TYPE | covered | Task 12
UI-VAULT-DIALOG-OWNER | covered | Task 12
UI-VAULT-DIALOG-FIELDS | covered | Task 12
UI-VAULT-DIALOG-SECRET | covered | Task 12
UI-VAULT-DIALOG-SCOPE | covered | Task 12
UI-VAULT-DIALOG-APPROVAL | covered | Task 12
UI-VAULT-DIALOG-SAVE | covered | Task 12
UI-AGENT-ACCESS-KEYS | covered | Task 14
UI-AGENT-ACCESS-SETUP | covered | Task 14
UI-AGENT-ACCESS-IPBIND | covered | Task 14
UI-AGENT-ACCESS-RESULT | covered | Task 14
UI-VAULT-SETTINGS-KEY | covered | Task 15
UI-VAULT-SETTINGS-URL | covered | Task 15
UI-VAULT-SETTINGS-PROXY | covered | Task 15
UI-VAULT-SETTINGS-SAVE | covered | Task 15
UI-API-KEYS-LIST | covered | Task 15
UI-API-KEYS-AGENTS | covered | Task 15
UI-VAULT-APPROVAL-CARD | covered | Task 13
UI-SHELL-NAV | covered | Task 10 (Bereich Vault ergänzt)
UI-SHELL-MOBILE-NAV | covered | Task 10 (Bereich Vault ergänzt)
UI-SERVERS-LIST-MENU | covered | Task 14 (Menüpunkt Agenten-Zugang…)
END
```

