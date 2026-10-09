# Agenten-Zugang — Umsetzungsanleitung (UI-AGENT-ACCESS)

Artboard: docs/design/mockups/ui-agent-access.html · Manifest-Revision: 13

Neuer Dialog; es gibt weder Client- noch Servercode zum Vault. Neu sind der Dialog, ein Menüpunkt im Bestandsmenü `UI-SERVERS-LIST-MENU`. Nicht neu gebaut werden: Dialog-Rahmen, Kontextmenü, Clipboard-Helfer, Toggle.

## Wo im Code
- `client/src/pages/Servers/components/ServerList/ServerList.jsx` — Menüpunkt im Zweig `contextClickedType === "server-object" && server?.type === "server"`, nach „Bearbeiten/Duplizieren“, vor dem Trenner über „Server löschen“. Das `ContextMenu` trägt `dataUiId="UI-SERVERS-LIST-MENU"` schon. Dialog-Zustand wie `deleteConfirmDialog` (`{ open, id }`), Dialog am Ende neben `ActionConfirmDialog` gerendert.
- `client/src/pages/Servers/components/AgentAccessDialog/AgentAccessDialog.jsx` + `styles.sass` + `index.js` — **neu**; Hänger für `UI-AGENT-ACCESS`, `-KEYS`, `-SETUP`, `-RESULT`. Muster: `DirectConnectDialog/` (ebenfalls `DialogProvider`, `data-ui-id` an Innenknoten).
- Wiederverwenden: `DialogProvider` (`common/components/Dialog`, Prop `disableClosing`), `Button`, `Checkbox`, `ToggleSwitch`, `Input`/`IconInput`, `ActionConfirmDialog`, `Icon`, `copyToClipboard` aus `common/utils/clipboard.js`, `getRequest`/`postRequest`/`deleteRequest` aus `common/utils/RequestUtil.js`, `useToast`.
- Styles: `styles.sass` im Dialog-Ordner; Werte nur aus den Tokens des Design-Systems (`--space-*`, `--radius-*`, `--success`, `--error`, `--subtext`, `--type-mono`).

## Darstellung
- Dialog, modal, über `UI-SERVERS`, mittig, 40 rem, max. 85 vh. Titel „Agenten-Zugang — <Servername>“.
- Auslöser: Menüpunkt „Agenten-Zugang…“ (Icon `KeyRound`) und „Bearbeiten“ in `UI-API-KEYS-AGENTS` (öffnet denselben Dialog mit `entryId`).
- Schließen: Esc, Backdrop, Schließen. Während die Einrichtung läuft `disableClosing`.
- RESULT ist vor dem Einrichten leer (`empty`). Tastatur: `Ctrl+Enter` = Einrichten (Dialog-`onKeyDown`, nur wenn Einrichten nicht `disabled`).
- Erscheint nicht: bei Einträgen ohne `protocol === "ssh"`, bei Pve-/Ordner-Einträgen, und wenn `GET /api/vault/available` `canProvision: false` liefert (Vault aus oder weder Recht `vault.use` noch Organisationsmitglied). Der Menüpunkt fehlt dann ganz, nicht `disabled`. `canProvision` einmal beim Laden des Server-Menüs holen, nach dem Muster von `GET /api/browser/available`.
- Aufbau: KEYS, SETUP, IPBIND (steht optisch zwischen Agentenauswahl und Adressbereichen), RESULT.

## Elemente
### UI-AGENT-ACCESS — Agenten-Zugang (neu)
- `data-ui-id` am Wurzelknoten innerhalb `DialogProvider`, genau einmal.

### UI-AGENT-ACCESS-KEYS — Agenten auf diesem Server (neu)
- `data-ui-id` am Listen-Container.
- Datenquelle: `GET /api/vault/agent-keys?entryId=<id>`. Liefert Agenten-Keys, **nicht** API-Keys, Vault-Einträge oder Identitäten.
- Zeile: Icon `KeyRound`, Agent als Klartext („Claude Code“, „Codex“, kein eigenes Icon), Meta in `--type-mono` `--subtext`: „angelegt 09.10. · zuletzt vor 5 Min. · nur 192.168.2.40“; rechts Ghost-Button „Entziehen“ → `ActionConfirmDialog`, dann `DELETE /api/vault/agent-keys/:id`.
- Nur bestätigte Keys listen; `pending` (noch nicht übernommen) erscheinen nicht.
- Zustände: `default` Zeilen; `empty` „Noch kein Agent auf diesem Server eingerichtet.“; `loading` Skeleton-Zeile mit `aria-busy`; `selected` Bestätigung im `ActionConfirmDialog`-Muster (Warnrand links): „Zugang von Claude Code auf web01 entziehen? Der Agent verliert sofort den Zugriff.“ mit „Abbrechen“ / „Entziehen“; `error` Zeile bleibt, darunter „Entziehen fehlgeschlagen.“ (`--error`, `role="alert"`).

### UI-AGENT-ACCESS-SETUP — Einrichten (neu)
- `data-ui-id` am Formular.
- Inhalt: zwei `Checkbox`en Claude Code und Codex (beide vorbelegt); Feld „Zusätzliche Adressbereiche“ (CIDR); primärer Button „Einrichten“ mit Hinweis `Ctrl+Enter`. Die IP-Bindung gehört nicht mehr zu SETUP, sondern ist `UI-AGENT-ACCESS-IPBIND`.
- Datenquelle: lokaler Formularzustand; Absenden `POST /api/vault/agent-keys` mit `entryId`, Agentenauswahl, Bindung (aus IPBIND), Bereichen.
- Zustände: `loading` alle Felder `disabled`, Button „Richte ein …“; `error` Feld in `--error`, darunter „Ungültiger Adressbereich.“ (`role="alert"`, `aria-invalid`); `disabled` Felder und Button `disabled`, Hinweis (`--warning`) „Outpost-Adresse für Agenten fehlt — in Einstellungen › Vault setzen.“ — gilt, solange `agentUrlSet` aus `GET /api/vault/available` `false` ist; `Ctrl+Enter` tut dann nichts; `partial` Warnhinweis (`--warning`, Warnrand links) **vor** den Feldern und dem Einrichten-Knopf: „Für root auf web01 hat bereits ein anderes Konto Agenten-Zugang eingerichtet — die Registrierung wird ersetzt.“ Einrichten bleibt bedienbar. Datenquelle: Spec Schritt 7 (anderes Konto hat für denselben Server und entfernten Benutzer schon einen Agenten-Key); Benutzer ist der über `resolveIdentity(entry, null, null, accountId)` bestimmte entfernte Benutzer (Schritt 2). Name im Text = `remoteUser` und Servername.

### UI-AGENT-ACCESS-IPBIND — Nur von der IP dieses Servers (neu)
- `data-ui-id` an der Toggle-Zeile (`ToggleSwitch`), eigenes Element außerhalb des SETUP-Knotens; im Layout zwischen Agentenauswahl und Adressbereichen. Der Bindungszustand liegt im Dialog-State, nicht im SETUP-Knoten.
- Datenquelle: aufgelöste Adresse des Server-Eintrags.
- Zustände: `default` an, Hinweis „an · 192.168.2.40“ (IP in `--type-mono`); `selected` aus, Hinweis „aus — von überall“. Aus = Key ohne IP-Bindung.
- `partial` Messung weicht ab: unter der Zeile eine Bestätigung im Warnrand-Muster (`--warning`): „Gesehen wurde 172.17.0.1 statt 192.168.2.40 — als Adressbereich übernehmen?“ mit „Nein“ (Ghost) / „Übernehmen“ (primär). Adressen in `--type-mono`. Datenquelle: das Probe-Ergebnis der Einrichtung (Spec „Einrichtung per Klick“ Schritt 1a: der Server ruft per Exec `GET <agentUrl>/api/vault/agent-keys/probe` mit dem `pending`-Key auf, die Antwort nennt `normalizeIp(req.ip)`). „Übernehmen“ ruft `POST /api/vault/agent-keys/:id/confirm` mit `{ addSeenIp: true }` (der Server trägt die von ihm gemessene Adresse ein, nie einen Wert vom Client; einmal, bis 15 Minuten nach dem Anlegen); „Nein“ verwirft den Vorschlag. Der Satz „Ohne Übernahme weist Outpost den Key ab.“ gehört zur Frage. Scheitert die Messung, erscheint `partial` nicht, sondern `disabled`.
- `disabled` Messung nicht möglich: unter der Zeile Hinweis in `--subtext`: „Adresse konnte nicht gemessen werden — der Key gilt für die aufgelöste Adresse des Servers.“ Datenquelle: `probe === null` in der Antwort von `POST /api/vault/agent-keys`. Der Toggle bleibt bedienbar.
- `error` Proxy-Vertrauen: unter der Zeile Warnhinweis in `--warning`, `role="alert"`: „TRUST_PROXY=true — die IP-Bindung ist wirkungslos.“ (`TRUST_PROXY=true` in `--type-mono`). Datenquelle: Feld `trustProxyUnsafe` aus `GET /api/vault/available`. Sichtbar nur, solange es `true` ist; der Toggle bleibt bedienbar.

### UI-AGENT-ACCESS-RESULT — Ergebnis (neu)
- `data-ui-id` am Ergebnis-Container; je Agent eine Zeile mit linkem 3-px-Rand (`--success` / `--error`).
- Datenquelle: Antwort von `POST /api/vault/agent-keys`, je Agent eingerichtet oder Fehlergrund plus fertiger Befehl.
- Zustände: `empty` „erscheint erst nach dem Einrichten“; `success` „Eingerichtet für root. Claude Code neu starten, dann /mcp.“ (`root` = `remoteUser` aus der Antwort von `POST /api/vault/agent-keys`, Spec Schritt 2); `error` z. B. „codex nicht gefunden. Befehl kopieren und auf dem Server ausführen.“ mit Befehl in `<pre>` und Button „Kopieren“ (`copyToClipboard`; Rückgabe `false` → Toast, kein Erfolg anzeigen — der Helfer deckt http ohne sicheren Kontext ab).
- `partial` Registrierung ersetzt: unter dem Ergebnis von Claude Code Hinweis in `--warning`: „Bestehende Registrierung ersetzt — der alte Konto-Key bleibt gültig, bis du ihn unter API-Schlüssel löschst.“ Datenquelle: `replacedRegistration === true` in der Antwort von `POST /api/vault/agent-keys` für diesen Agenten.
- Der Key steht nur hier, nur jetzt; Hinweis „Der Key ist nur jetzt sichtbar. Schließen ohne Übernahme löscht ihn.“ Der Key wird nie in KEYS, Toasts oder Logs gezeigt und nicht im State über das Schließen hinaus gehalten.
- Pending/Confirm: `POST /api/vault/agent-keys` legt Keys als `pending` an. Sie werden endgültig, sobald die automatische Einrichtung gelingt (der Server bestätigt dann selbst) oder der Nutzer „Kopieren“ klickt (`copyToClipboard` liefert `true` → `POST /api/vault/agent-keys/:id/confirm`). Schließen des Dialogs ohne eines von beiden → `DELETE /api/vault/agent-keys/:id` für jeden noch offenen Key. Was `pending` bleibt (Absturz, Tab zu), löscht der Server nach 15 Minuten; ein `pending`-Key ist nirgends nutzbar.
- Tokens: `--success` eingerichtet, `--error` fehlgeschlagen, sonst `--subtext`.

## Datenquellen (Spec, Abschnitt REST-Endpunkte)
- Beim Öffnen: `GET /api/vault/agent-keys?entryId=` → `keys`, `remoteUser`, `otherAccountConfigured` (Warnung `partial` von SETUP vor dem Einrichten).
- `GET /api/vault/available` → `agentUrlSet` (SETUP `disabled`), `trustProxyUnsafe` (IPBIND `error`). Nicht `GET /api/vault/settings`: das verlangt `settings.vault`.
- Nach dem Einrichten: Antwort von `POST /api/vault/agent-keys` je Agent `{ id, agentType, status, remoteUser, command?, probe, replacedRegistration }` → RESULT (`success`/`error`) und IPBIND `partial` (`probe.matches === false`, gesehene Adresse `probe.seenIp`), IPBIND `disabled` (`probe === null`) und RESULT `partial` (`replacedRegistration === true`).

## Ausdrücklich nicht
- Keine KI-, Sparkle- oder Roboter-Symbolik; Agenten nur mit Produktnamen.
- Kein Anzeigen von Key-Teilen (keine letzten Zeichen) in der Liste.
- Kein Autosave, kein Einrichten ohne Klick auf „Einrichten“.
- Kein zweiter Weg zum Key (kein Reveal): einmal im RESULT, danach nur Neu-Einrichten.
- Kein Eingriff in `AddApiKeyDialog`; er dient nur als Muster für „Token einmal zeigen“.

## i18n
Schema des Bestands (`servers.contextMenu.*`, `servers.dialog.*`); zuerst `client/public/assets/locales/de_DE.json`, dann die übrigen Sprachdateien:
- `servers.contextMenu.agentAccess` („Agenten-Zugang…“)
- `servers.agentAccess.title`, `.keys.empty`, `.keys.revoke`, `.keys.revokeConfirm`, `.keys.revokeError`, `.setup.submit`, `.setup.loading`, `.setup.cidrLabel`, `.setup.cidrInvalid`, `.setup.urlMissing`, `.ipBind.label`, `.ipBind.on`, `.ipBind.off`, `.result.empty`, `.result.success`, `.result.copy`, `.result.keyNotice`, `.setup.foreignAccount`, `.ipBind.seenOther`, `.ipBind.adopt`, `.ipBind.decline`, `.ipBind.trustProxy`
- Copy-Strings aus dem Manifest wörtlich; Allgemeines (`common.close`, `common.error`) wiederverwenden.

## Fertig, wenn
- Fünf Marker (`UI-AGENT-ACCESS`, `-KEYS`, `-SETUP`, `-IPBIND`, `-RESULT`) plus `UI-SERVERS-LIST-MENU` am Menüpunkt-Verhalten (nur SSH, nur Vault an); `/design-verify --screen UI-AGENT-ACCESS` MATCH.
