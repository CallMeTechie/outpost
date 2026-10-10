# Einstellungen › Vault — Umsetzungsanleitung (UI-VAULT-SETTINGS)

Artboard: docs/design/mockups/ui-vault-settings.html · Manifest-Revision: 12

Die Seite gibt es noch nicht. Sie folgt dem Bestand der Browser-Einstellungsseite (`client/src/pages/Settings/pages/Browser/`): gleiche Struktur, gleiche Registrierung, gleiche Rechtefilterung. Neu sind die Statusanzeige für `VAULT_KEY` und der Proxy-Hinweis. Nicht neu gebaut: Seitenrahmen, Einstellungsdialog, Rechtesystem.

## Wo im Code
- `client/src/pages/Settings/pages/Vault/Vault.jsx` — **neu**; Seite, `data-ui-id="UI-VAULT-SETTINGS"` am äußersten Wrapper → alle vier Elemente darin
- `client/src/pages/Settings/pages/Vault/index.js` — **neu**; `export { Vault as default } from "./Vault.jsx";` wie bei Browser
- `client/src/pages/Settings/pages/Vault/styles.sass` — **neu**; Layout und Pill, Werte nur aus `client/src/common/styles/_tokens.sass` und `_colors.sass`
- `client/src/common/utils/navigationConfig.jsx` — in `getSettingsAdminPages` eine Zeile `key: "vault"`, `permission: Permission.SETTINGS_VAULT`, `content: <Vault />`. Das Register filtert Seitenleiste und `QuickAction` schon nach `permission`.
- `client/src/common/utils/permissions.js` — `SETTINGS_VAULT: "settings.vault"` ergänzen (Spiegel von `server/permissions/registry.js`, wo die Spec das Recht anlegt).
- Wiederverwenden: `IconInput`, `Button`, `useToast` (`ToastContext`), `getRequest`/`patchRequest` aus `RequestUtil.js`; das `SettingItem`-Muster aus `Browser.jsx` (lokal kopieren, nicht exportiert).
- Status-Pill: kein Bestand (`Chip` ist ein Schalter-Button, ungeeignet) → lokale Komponente in `Vault.jsx`.

## Darstellung
- Panel, Seite „Vault“ in der Einstellungsfläche über `UI-SHELL`; Auslöser Konto › Einstellungen › Vault, nur mit Recht `settings.vault`. Schließen mit den Einstellungen (Esc).
- Aufbau von oben nach unten: Titel „Vault“, Intro „Systemeinstellungen des Vaults.“, Vault-Schlüssel, Outpost-Adresse, Proxy-Hinweis (nur bei Warnung), Speichern rechtsbündig. Breite höchstens 44 rem.
- Tastatur: Tab durch die Felder, sonst nichts Eigenes.
- Nicht sichtbar ohne `settings.vault`: Eintrag fehlt in Seitenleiste und Schnellsuche.

## Elemente — eins nach dem anderen
### UI-VAULT-SETTINGS-KEY — Vault-Schlüssel (neu)
- `data-ui-id` am Wrapper der Zeile (Label plus Pill plus Text) — genau einmal.
- Datenquelle: `GET /api/vault/settings` (Recht `settings.vault`), Feld `keyStatus: "active" | "missing" | "mismatch"` aus der Prüfung von `VAULT_KEY` beim Start. Der Endpunkt antwortet auch bei ausgeschaltetem Vault, sonst könnte die Seite den Grund nicht zeigen. **Nicht** den Schlüssel selbst und keinen API-Key (`not: encryption_key, api_key`); der Wert verlässt den Server nie.
- `default` (`active`): Pill „Aktiv“, `--success` auf `--success-opacity`, Haken.
- `disabled` (`missing`): Pill „Fehlt“, danach der Satz „VAULT_KEY fehlt — der Vault ist aus. Schlüssel als Umgebungsvariable oder Docker-Secret vault_key setzen.“; Pill `--warning` auf `--warning-opacity`.
- `error` (`mismatch`): Pill „Passt nicht“, danach der Satz „VAULT_KEY passt nicht zu den gespeicherten Einträgen — der Vault ist aus.“; Pill `--error` auf `--error-opacity`.
- Reine Anzeige, kein Eingabefeld.

### UI-VAULT-SETTINGS-URL — Outpost-Adresse für Agenten (neu)
- `data-ui-id` am Wrapper der Zeile (Label, `IconInput` mit Link-Icon, Hilfetext) — genau einmal.
- Datenquelle: `agentUrl` aus `GET /api/vault/settings`, geschrieben mit `PATCH /api/vault/settings`; muss eine http- oder https-Adresse sein. Das ist die Adresse, unter der Server Outpost erreichen — **nicht** die Launcher-Adresse der Browser-Einstellungen (`not: browser_launcher_url`), obwohl beide mit `IconInput` gebaut sind.
- `default`: Feld standardmäßig leer; `http://192.168.2.10:6989` im Artboard ist nur ein Beispiel, kein Vorgabewert. Hilfetext „Unter dieser Adresse erreichen deine Server Outpost; daraus entsteht die MCP-URL für Agenten.“
- `error`: Rahmen `--error`, Text „Keine gültige http- oder https-Adresse.“ über dem Hilfetext. Gültig = beginnt mit `http://` oder `https://`.

### UI-VAULT-SETTINGS-PROXY — Hinweis Reverse-Proxy (neu)
- `data-ui-id` am Wrapper des Hinweises, zwischen Adresse und Speichern. Im Zustand `default` nicht gerendert (kein Platzhalter, keine Lücke) — genau einmal im DOM, solange die Warnung gilt.
- Datenquelle: Feld `trustProxyUnsafe` (boolean) aus `GET /api/vault/settings`; `true` genau dann, wenn `TRUST_PROXY=true` (in `server/index.js` gelesen). Eine Hop-Zahl oder Adressliste ist `false`. Nur Anzeige, nicht über `PATCH` schreibbar.
- `default` (`false`): nicht sichtbar. Im Artboard steht dafür nur „nicht sichtbar“ als Zustandsbeschriftung, das ist nicht Produkt.
- `error` (`true`): Warnbanner mit Warndreieck-Icon, `--warning` auf `--warning-opacity`, `role="alert"`. Text: „TRUST_PROXY=true — Outpost glaubt jedem X-Forwarded-For, die IP-Bindung von Agenten-Keys ist wirkungslos. Hop-Zahl oder Adressliste setzen.“
- Hintergrund: Spec `docs/superpowers/specs/2026-10-09-vault-core-design.md`, Abschnitt „Authentifizierung“ (IP-Bindung von Agenten-Keys). Nicht der Schlüsselstatus und nicht die Adresse (`not: vault_key_status, agent_base_url`).
- Blockiert das Speichern nicht.

### UI-VAULT-SETTINGS-SAVE — Einstellungen speichern (neu)
- `data-ui-id` am `Button` (`type="primary"`, Icon Save), rechtsbündig in `settings-actions`.
- Speichert die Adresse per `PATCH /api/vault/settings` wie `save()` in `Browser.jsx` (`patchRequest`, Toast bei Erfolg und Fehler).
- `disabled` während des Speicherns und bei ungültiger Adresse.

## Ausdrücklich nicht
- Kein Eingabefeld, keine Anzeige und kein Erzeugen von `VAULT_KEY` in der Oberfläche.
- Keine weiteren Einstellungen (Ein/Aus-Schalter, Zeitlimits) — das Manifest kennt nur Status und Adresse.
- Der Artboard-Rahmen (gestrichelte Zustandsboxen, Tags, Code-Beschriftung mit der ID) ist Darstellung der Zustände, nicht Produkt.

## i18n
Neuer Block `settings.vault.*` neben `settings.browser` in `client/public/assets/locales/de_DE.json` (Quellsprache zuerst, dann `en.json`), plus `settings.pages.vault` („Vault“). Schema wie Browser: `title`, `description`, `key.title`, `key.active|missing|mismatch`, `agentUrl.title|description|invalid`, `proxy.title|warning`, `saveSettings`, `saveSuccess`, `loading`, `errors.loadSettings|saveSettings`.

## Fertig, wenn
- Vier Marker auf Tier A; `/design-verify --screen UI-VAULT-SETTINGS` MATCH.
