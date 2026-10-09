# Einstellungen › Konto › API-Schlüssel — Umsetzungsanleitung (UI-API-KEYS)

Artboard: docs/design/mockups/ui-api-keys.html · Manifest-Revision: 11

Der Abschnitt „API-Schlüssel“ der Kontoseite existiert. Neu: die Liste zeigt nur noch `kind = account`, und darunter kommt ein zweiter Abschnitt mit den Agenten-Schlüsseln nach Server. Anlegen und Löschen eigener Schlüssel bleiben unverändert; `AddApiKeyDialog` wird nicht angefasst.

## Wo im Code
- `client/src/pages/Settings/pages/Account/Account.jsx` (Bestand) — Abschnitt `account-section` ab dem `<h2>` mit `settings.account.apiKeys.sectionTitle` → `UI-API-KEYS-LIST`; direkt dahinter der neue Abschnitt.
- `client/src/pages/Settings/pages/Account/components/AgentKeys/` — **neu** (`AgentKeys.jsx`, `index.js`, `styles.sass`, nach dem Muster von `components/MicrosoftConnections/`) → `UI-API-KEYS-AGENTS`.
- `server/controllers/apiKey.js` (Bestand) — `listApiKeys` ist die Stelle für den Filter: `where: { accountId, kind: "account" }`. Erst damit zeigt `GET accounts/api-keys` keine Agenten-Schlüssel mehr. `serialize` bleibt (id, name, prefix, lastUsedAt, expiresAt, createdAt); `kind` wird nicht ausgeliefert.
- `deleteApiKey` (Bestand) — ebenfalls auf `kind: "account"` einschränken, damit ein Agenten-Schlüssel nicht über `DELETE accounts/api-keys/:id` fällt. `createApiKey` zählt das 50er-Limit (Obergrenze) nur über `kind: "account"`.
- `GET /api/vault/agent-keys` und `DELETE /api/vault/agent-keys/:id` — **neu**, gehören zum Vault-Backend (Spec `2026-10-09-vault-core-design.md`), nicht zu diesem Screen.
- Wiederverwenden: `Button`, `Icon`, `DialogProvider`/Bestätigungsdialog wie `deleteApiKeyOpen` in `Account.jsx`, CSS-Klassen `account-section`, `settings-list`, `settings-list-item`, `list-empty`.
- Styles: `Account/styles.sass` und `AgentKeys/styles.sass`; Werte aus den Tokens der Runde 11 (`docs/design/design-system.md`), keine Hex-Werte.

## Darstellung
- Art: Panel, Abschnitt der Kontoseite, über `UI-SHELL`. Auslöser: Konto › Einstellungen › Konto. Schließen: Einstellungen schließen.
- Von oben nach unten: API-Schlüssel, dann Agenten-Schlüssel.
- Tastatur: Tab durchläuft Schaltflächen und Aktionen der Listen, Enter löst aus.

## Elemente
### UI-API-KEYS-LIST — API-Schlüssel (Bestand)
- `data-ui-id="UI-API-KEYS-LIST"` am `account-section`-Container (Kopf mit Hinzufügen-Button und Liste), genau einmal.
- Datenquelle: `GET accounts/api-keys` über `loadApiKeys`, nur `kind = account`. **Nicht** Agenten-Schlüssel.
- `default`: je Schlüssel Name, `prefix`, zuletzt genutzt, Ablauf (nur wenn gesetzt), Löschen mit Bestätigung — unverändert.
- `empty`: „Noch keine API-Schlüssel“ (Bestandsschlüssel `settings.account.apiKeys.noKeys`).

### UI-API-KEYS-AGENTS — Agenten-Schlüssel (neu)
- `data-ui-id="UI-API-KEYS-AGENTS"` am Wurzelknoten von `AgentKeys.jsx`, genau einmal.
- Datenquelle: `GET /api/vault/agent-keys` ohne Parameter (liefert alle Agenten-Schlüssel des Kontos), im Client nach Server gruppiert. **Nicht** `accounts/api-keys`, **nicht** Vault-Einträge.
- `default`: je Server eine Gruppe mit Servername und „Bearbeiten“ (öffnet `UI-AGENT-ACCESS` für diesen Server); je Schlüssel Agent, zuletzt genutzt, IP-Bindung (Adresse bzw. „Bindung gelöst“ mit Hinweis „von überall“) und „Entziehen“. Entziehen fragt per Bestätigungsdialog nach (wie `deleteApiKeyOpen`); erst nach Bestätigung `DELETE /api/vault/agent-keys/:id`, danach Liste neu laden.
- `empty`: „Noch kein Agenten-Zugang. Einrichten über das Kontextmenü eines Servers.“
- Beschreibung im Kopf: Agenten-Schlüssel erreichen nur den MCP-Endpunkt.
- Tokens: Gruppenrahmen `--dark-gray`, Entziehen `--error`, Hinweis „von überall“ `--warning` / `--warning-opacity`, IP in `--font-mono`.

## Ausdrücklich nicht
- Agenten-Schlüssel erscheinen nicht in `UI-API-KEYS-LIST` und lassen sich dort weder löschen noch anlegen.
- Kein Anlegen von Agenten-Schlüsseln hier — nur über `UI-AGENT-ACCESS`. Kein Token wird angezeigt.
- Keine neue Seite oder Route; kein Eintrag in der Einstellungs-Navigation.

## i18n
Neue Schlüssel unter `settings.account.agentKeys.*` (`sectionTitle` „Agenten-Schlüssel“, `sectionDescription`, `edit`, `revoke`, `revokeConfirm`, `unbound`, `anywhere`, `empty`), zuerst `de_DE.json`, dann `en.json` (Fallback-Sprache), übrige Sprachdateien zuletzt. Bestehende `settings.account.apiKeys.*` bleiben unverändert und werden weiterverwendet (u. a. `sectionTitle`, `noKeys`); nichts wird umbenannt.
