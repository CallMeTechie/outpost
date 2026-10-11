# Credentials Vault – Teilprojekt 2b: SSH (ssh_exec, ssh_put, ssh_get)

## Ziel

Ein Agent (Claude Code, Codex) führt Befehle auf anderen Rechnern aus und überträgt Dateien dorthin oder von dort, ohne den SSH-Schlüssel oder das Passwort je zu sehen. Outpost meldet sich selbst an, über seine Engine, mit Benutzer und Geheimnis aus einem Vault-Eintrag vom Typ `ssh`. Jeder Zugriff braucht eine Freigabe, auf der Karte steht der vollständige Befehl, und alles steht im Audit-Log. Zwei Fälle sind gleich wichtig:

- **Andere Server steuern:** Ein Agent auf `appmonster` arbeitet auf `web02` oder einem NAS (Deploy, Logs, Neustart).
- **Anderer Benutzer auf dem eigenen Server:** Ein Agent führt auf seinem eigenen Server Befehle als `root` oder als Dienstbenutzer aus, dessen Zugang nur im Vault liegt.

Beim ersten Kontakt zu einem Ziel merkt sich Outpost dessen Host-Key. Weicht er später ab, bricht die Engine vor der Anmeldung ab. Heute prüft die Engine Host-Keys gar nicht (`engine/src/net/ssh_common.c`, Handshake ohne Abgleich); 2b schließt diese Lücke für alle Verbindungen, die ein Vault-Eintrag aufbaut.

### Einordnung

Teilprojekt 2 des Vaults (`docs/superpowers/specs/2026-10-09-vault-core-design.md`, „Einordnung“) ist in drei Specs geschnitten: 2a Tokens (`docs/superpowers/specs/2026-10-10-vault-tokens-design.md`, ausgeliefert in 0.1.11), **2b SSH** (diese Spec), 2c `db_query`. 2b nutzt aus Teilprojekt 1 und 2a: Einträge, Bindung an Server, Agenten-Keys mit IP-Bindung, MCP-Endpunkt, Freigabe-Karte, Audit, den Vermittlungskern `server/lib/vault/broker.js` und die Schwärzung `server/lib/vault/redact.js`.

### Grenze des Modells

- Wie in Teilprojekt 1 und 2a gibt kein Werkzeug einen Wert heraus. Was ein Befehl ausgibt, bestimmt das Ziel. Outpost schwärzt darin das Passwort, die Passphrase und den privaten Schlüssel des Eintrags, aber nichts anderes. Wer auf `web02` als `deploy` Befehle ausführen darf, liest alles, was `deploy` dort lesen darf, auch fremde Geheimnisse in Dateien.
- Ein freigegebener Befehl kann alles, was der Ziel-Benutzer kann. Die Karte zeigt ihn vollständig. Ob er etwas verändert, lässt sich nicht erkennen; deshalb gibt es bei `ssh_exec` keine Unterscheidung in Lesen und Schreiben.
- Dateiinhalte laufen ungeschwärzt durch Outpost, aber nie durch den Kontext des Agenten.
- Auf dem Server des Agenten liest und schreibt Outpost Dateien für `ssh_put`/`ssh_get` als derselbe Benutzer, für den der Agenten-Zugang eingerichtet ist. Der Agent bekommt dort keine Rechte dazu.
- Die Host-Key-Sperre gilt für das Ziel. Die Host-Keys von Jump-Hosts prüft 2b nicht, ebenso wenig die SFTP-Verbindung zum eigenen Server des Agenten (die bestehende Verbindung des Agenten-Zugangs, wie heute).

## Entscheidungen

| Thema | Entscheidung |
|---|---|
| Werkzeuge | `ssh_exec`, `ssh_put`, `ssh_get` als MCP-Werkzeuge, alle über `broker.use`. |
| Unterbau | Die Engine, über eine SFTP-Sitzung (`SessionType.SFTP`, `EngineSftpClient`): `exec` mit Zeitlimit, `readFile`/`writeFile`, `rename`, `unlink`, `stat`. Kein `ssh2` im Node-Server, kein `ExecCommand` (dort 30 s fest, ohne eigenes Zeitlimit). |
| Ziele | Je Eintrag Server aus der Serverliste (`servers`, Entry-IDs) und freie Hosts (`hosts`, `host[:port]`). Bei Server-Zielen kommen Host, Port, Jump-Hosts und Engine vom Server-Eintrag, dessen Identität wird nie benutzt. Freie Hosts laufen über die Standard-Engine ohne Jump-Hosts. |
| Benutzer und Geheimnis | Immer aus dem Vault-Eintrag (`username`; `privateKey` mit optionaler `passphrase` und/oder `password`). |
| Host-Keys | Beim ersten Kontakt merken (TOFU) je Eintrag und Ziel, Fingerabdruck auf der Freigabe-Karte. Abgleich in der Engine nach dem Handshake und vor jeder Anmeldung. Abweichung: Abbruch, kein Geheimnis verlässt Outpost. |
| Freigabe | Karte mit Werkzeug, Ziel, `benutzer@host:port`, bei `ssh_exec` dem vollständigen Befehl, bei Dateien Quelle → Ziel mit Größe. „Für diese Sitzung“ nur mit `allowSession` am Eintrag (Standard aus), dann je Sitzung, Eintrag, Ziel und Art. |
| Arten | `ssh_exec` → `exec` (Abzeichen „führt aus“, rot), `ssh_put` → `write` („schreibt“), `ssh_get` → `read`. |
| Engine-Version | Der Server nimmt heute nur Engines mit genau seiner Version an (`ControlPlaneServer._handleEngineHello`, `server/lib/controlPlane/ControlPlaneServer.js`). Eine Engine ohne Host-Key-Abgleich kann sich deshalb nicht verbinden; ein eigenes Fähigkeits-Feld ist nicht nötig. Die Spec verlässt sich darauf und hält es mit einem Test fest. |

## Datenmodell

### `vault_items.fields` für Typ `ssh` (JSON, keine Spaltenänderung)

| Feld | Typ | Regel |
|---|---|---|
| `username` | String | Bestand, Pflicht, höchstens 255 Zeichen. |
| `servers` | Array von Ganzzahlen | Neu. Entry-IDs, höchstens 50, ohne Doppelte. Jede ID ist ein Eintrag mit `type: "server"` und `config.protocol: "ssh"`, den der Speichernde sieht (`validateEntryAccess`); bei Einträgen einer Organisation gehört der Server derselben Organisation (`resolveEntryScope`). Sonst `400` „Server <id> is not an SSH server you can use for this entry“. |
| `hosts` | Array von Strings | Neu. `host[:port]`, höchstens 50, Host als Hostname, IPv4 oder `[IPv6]`, Port 1–65535; ohne Port gilt 22. Klein geschrieben gespeichert, ohne Doppelte; `host:22` wird zu `host`. |
| `allowSession` | Boolean | Neu, Standard `false`. |

`TARGET_FIELDS` in `server/controllers/vaultItems.js` bekommt `ssh: ["servers", "hosts"]`: Eine Änderung verwirft die gespeicherten Geheimnisse wie bei den anderen Typen (Hinweis `vault.dialog.secretCleared`), denn sonst lenkt jemand mit Bearbeitungs-, aber ohne Aufdeck-Recht den Eintrag auf einen eigenen Rechner um und liest das Passwort mit. Eine Änderung von `allowSession` oder `username` verwirft nichts.

Ein Eintrag darf ohne Ziele gespeichert werden; die Werkzeuge melden dann `vault.no_targets`.

### Ziel-Bezeichner

Ein Ziel heißt nach außen `server:<entryId>` oder `host:<host>[:<port>]` (Port nur, wenn nicht 22). So steht es in `vault_list`, in den Werkzeugen, in der Tabelle unten und im Audit.

### Neue Tabelle `vault_ssh_host_keys` (Migration `0050-add-vault-ssh-host-keys.js`)

| Spalte | Typ | Regel |
|---|---|---|
| `id` | Integer, PK | |
| `itemId` | Integer | FK `vault_items.id`, `ON DELETE CASCADE` |
| `target` | String(300) | Ziel-Bezeichner |
| `algorithm` | String(40) | z. B. `ssh-ed25519`, `ecdsa-sha2-nistp256`, `ssh-rsa` |
| `fingerprint` | String(60) | `SHA256:<base64 ohne =>` |
| `confirmedBy` | Integer, nullable | `accounts.id` des Freigebenden, `SET NULL` beim Löschen des Kontos |
| `confirmedAt` | Date | |

Eindeutig: (`itemId`, `target`). Modell `server/models/VaultSshHostKey.js`.

Aufräumen:
- Ein Ziel verschwindet aus `servers` oder `hosts` (Bearbeiten): seine Zeile wird im selben Vorgang gelöscht.
- Ein Server-Eintrag wird gelöscht: Neben `removeBindings("entry", …)` (`server/controllers/entry.js`) entfernt ein Hook die ID aus `servers` aller SSH-Einträge und löscht deren Zeilen für `server:<id>`. Die Geheimnisse bleiben (das Ziel wird weniger, nicht anders).
- Ändern sich Host oder Port eines Server-Eintrags, löscht derselbe Hook die Zeilen für `server:<id>`: Der gemerkte Key gehörte zum alten Rechner.

## Vermittlung

Alle drei Werkzeuge laufen durch `broker.use` (`server/lib/vault/broker.js`) mit `lazySecret: true`. Neu:

- `access` kann `exec` sein. Die Karte zeigt dann das Abzeichen `UI-VAULT-APPROVAL-EXEC` statt `UI-VAULT-APPROVAL-WRITE`.
- `scope` = `<access>|<target>`, z. B. `exec|server:12`. Eine Sitzungsfreigabe für `web02` deckt `nas` nicht, eine für Lesen deckt weder Schreiben noch Ausführen.
- `allowSession` der Anfrage = `fields.allowSession` des Eintrags. Ist es aus, gilt die Regel aus 2a (`approvals.js`): kein „Für diese Sitzung“ auf der Karte, `session` wird serverseitig zu `once`, und eine bestehende Sitzungsfreigabe greift nicht.
- `grantStamp` (`approvals.js`) enthält zusätzlich `username`, `servers`, `hosts`, `allowSession` und den gemerkten Fingerabdruck des Ziels; jede Änderung beendet Sitzungsfreigaben.
- Die Freigabe-Anfrage trägt für SSH zusätzlich `sshTarget` (`{ ref, name, user, host, port }`), `command` (nur `ssh_exec`, ungekürzt), `file` (nur `ssh_put`/`ssh_get`: `{ from, to, bytes }`) und `hostKey` (`{ algorithm, fingerprint, new: true }`, nur bei unbekanntem Ziel). `VAULT_APPROVALS` im StateBroadcaster liefert sie mit; die Karte zeigt sie (Abschnitt „Oberfläche“).

### Ablauf je Aufruf

1. Eintrag sichtbar (`findVisibleItem`), Typ `ssh`, sonst `vault.wrong_type`.
2. Ziel gehört zum Eintrag, sonst `vault.target_not_allowed`. Server-Ziel: Eintrag existiert noch, ist SSH, und das Konto hinter dem Agenten-Key sieht ihn (`validateEntryAccess`), sonst `vault.target_unavailable`.
3. Werkzeugeigene Prüfungen (Befehl, Pfade, unten).
4. Drosselung: 30 Aufrufe pro Minute je Agenten-Key für alle drei Werkzeuge zusammen (`vault.rate_limited`), höchstens 2 gleichzeitig (`vault.busy`).
5. Host-Key: Ist für (Eintrag, Ziel) keiner gemerkt, baut Outpost eine **Probe** auf (unten): Verbindung bis nach dem Handshake, keine Anmeldung. Ergebnis `hostKey.new` geht in die Freigabe-Anfrage. Scheitert die Probe (Netz, DNS, Zeit), endet der Aufruf mit `vault.ssh_failed` ohne Karte.
6. Freigabe nach den Regeln von 2a. Bei `hostKey.new` immer eine Karte, auch wenn `approvalRequired` aus ist: ohne bestätigten Key keine Anmeldung.
7. Nach der Freigabe: Key noch gültig, Eintrag neu laden, Prüfungen 1–3 erneut; geänderte Ziele, Benutzer oder Schalter ergeben `vault.approval_stale`. War der Key neu, wird er jetzt gespeichert (`confirmedBy` = Konto, das freigegeben hat; bei einem Eintrag ohne Freigabepflicht und bekanntem Key entfällt der Schritt). Ein inzwischen von anderer Seite gemerkter, abweichender Key ergibt `vault.host_key_changed`.
8. Erst jetzt `readSecret` (Geheimnis entschlüsseln), dann der Lauf über die Engine mit dem gemerkten Fingerabdruck als Erwartung.
9. Ausgabe schwärzen, Audit `vault.use`, `lastUsedAt` per `silent: true`.

### Host-Key-Abweichung

Meldet die Engine `host_key_mismatch`, endet der Aufruf mit `vault.host_key_changed` („The host key of <target> changed (expected <alt>, got <neu>); nothing was sent. Ask the user to check the server and forget the old key in Outpost.“). Dazu Audit `vault.ssh_host_key_mismatch` mit beiden Fingerabdrücken und ein Toast an alle Sitzungen des Kontos über den StateBroadcaster („Host-Key von <Ziel> hat sich geändert — Verbindung abgebrochen“). Es gibt keine Karte und keinen Weg, die Abweichung zu überspringen; erst „Vergessen“ in der Detailansicht (`UI-VAULT-DETAIL-SSH-TARGETS`) gibt den Weg frei, und die nächste Verbindung zeigt den neuen Fingerabdruck auf der Karte.

## `ssh_exec`

```
ssh_exec({ item, target, command, timeoutSec? })
```

Beschreibung an den Agenten (englisch): Run a shell command on one of the targets of a vault SSH entry. Outpost logs in itself with the entry's user and key or password; you never see them. No terminal: interactive programs and sudo password prompts do not work — use an entry for the user you need. The user approves every call and sees the full command. Output: exit code, stdout and stderr, each cut at 64 KB; the entry's password and key are replaced by ••••.

Prüfungen:
- `command`: String, nicht leer, höchstens 8 KB, ohne NUL, sonst `vault.bad_command`.
- `timeoutSec`: Ganzzahl 1–600, Standard 60, sonst `vault.bad_timeout`.

Ausführung: SFTP-Sitzung zum Ziel (unten), `EngineSftpClient.exec(command, timeoutSec * 1000)` (`server/lib/EngineSftpClient.js`), danach Sitzung schließen. Kein `stdin`.

Ergebnis an den Agenten:

```
exit <code>[ (timed out after <n> s)]
--- stdout[ (truncated after 65536 bytes)] ---
<stdout>
--- stderr[ (truncated after 65536 bytes)] ---
<stderr>
```

Ausgabe als UTF-8 (ungültige Folgen ersetzt). Kürzen wie bei `vault_http`: erst auf 64 KB kürzen, am Ende jeden Rest entfernen, der Anfang einer Variante ist, dann schwärzen. Varianten: `password`, `passphrase`, der private Schlüssel als Ganzes und jede seiner Zeilen mit mindestens 16 Zeichen (ein `cat` des Schlüssels erscheint zeilenweise), jeweils mit `variantsOf` aus `server/lib/browser/vaultGuard.js`. Kürzere Werte als 4 Zeichen werden nicht ersetzt (Regel aus 2a).

`access` = `exec`, `target` auf der Karte = `<name> · <benutzer@host:port>`.

## `ssh_put` und `ssh_get`

```
ssh_put({ item, target, localPath, remotePath, overwrite? })
ssh_get({ item, target, remotePath, localPath, overwrite? })
```

Beschreibung (englisch): Copy one file between your own server and a target of a vault SSH entry. Outpost reads and writes the file itself — on your server as your own user, on the target as the entry's user — so the content never passes through you. At most 100 MB; an existing file is only replaced with overwrite: true. Needs approval.

- Nur für Agenten-Keys mit Server (`ctx.agent.entryId`); sonst `vault.no_agent_server`. `vault_list` nennt die beiden Werkzeuge dann nicht.
- Pfade: absolut oder mit `~/` beginnend, höchstens 4 KB, ohne NUL und ohne Zeilenumbruch, sonst `vault.bad_path`. `~/` löst `realpath` der jeweiligen Sitzung auf.
- Quelle: `stat` muss eine reguläre Datei zeigen (`vault.not_a_file`), Größe höchstens 100 MB (`vault.file_too_large`), vor der Freigabe ermittelt und auf der Karte gezeigt.
- Ziel: existiert die Datei und fehlt `overwrite: true`, `vault.file_exists` — geprüft vor der Freigabe und erneut direkt vor dem Schreiben.
- Ablauf: zwei SFTP-Sitzungen — eine zum Server des Agenten (Identität des Agenten-Zugangs: der Benutzer `remoteUser` des Agenten-Keys über `resolveIdentity` für dessen Eintrag, ohne Host-Key-Abgleich), eine zum Ziel (Vault-Benutzer, erwarteter Host-Key). `readFile` der Quelle wird in `writeFile` von `<ziel>.outpost-tmp` geleitet (zwei Clients, nicht einer: `EngineSftpClient` blockiert bei gleichzeitigem Lesen und Schreiben auf demselben Client). Outpost zählt mit; über 100 MB oder bei einem Fehler wird abgebrochen und `<ziel>.outpost-tmp` gelöscht. Danach `rename` auf den Zielnamen (bei `overwrite` vorher `unlink` des alten, wenn `rename` nicht ersetzt).
- `ssh_get` läuft spiegelbildlich; die Sitzung zum Agenten-Server schreibt.
- Ergebnis: `Copied <bytes> bytes from <quelle> to <ziel>.`
- `access`: `ssh_put` = `write`, `ssh_get` = `read`.

## Engine

### Protokoll (`schema/control_plane.fbs`, `yarn schema:generate`)

- `SessionOpen` bekommt `expected_host_key:string` (`SHA256:…`, leer = keine Erwartung) und `probe_host_key:bool`.
- `SessionOpenResult` bekommt `host_key_algorithm:string` und `host_key_fingerprint:string`, gefüllt bei jeder SSH-Sitzung nach dem Handshake, und den Fehlercode `host_key_mismatch` in `error_code`.
- `ControlPlaneServer.openSession` (`server/lib/controlPlane/ControlPlaneServer.js`) nimmt ein Optionsobjekt `{ expectedHostKey, probeHostKey }` und gibt `hostKey` aus dem Ergebnis zurück. Bestehende Aufrufer ändern sich nicht.

### C (`engine/src/net/ssh_common.c`, `engine/src/net/sftp.c`)

- Nach `libssh2_session_handshake` der **letzten** Verbindung (direkt in `outpost_ssh_setup`, hinter Jump-Hosts in `ssh_setup_on_channel` für das Ziel) liest die Engine `libssh2_session_hostkey` (Typ) und `libssh2_hostkey_hash(session, LIBSSH2_HOSTKEY_HASH_SHA256)`, kodiert base64 ohne `=` und meldet beides.
- Ist `expected_host_key` gesetzt und weicht ab: Sitzung schließen, `SessionOpenResult` mit `error_code = host_key_mismatch`, **ohne** `outpost_ssh_auth` aufzurufen.
- Ist `probe_host_key` gesetzt: nach dem Melden schließen, keine Anmeldung, keine Datenverbindung.
- Ohne die beiden Felder ändert sich nichts (Datei-Browser, Terminal, Agenten-Zugang).

### Version

Engine und Server erscheinen im selben Release; der Versionsabgleich beim Verbinden (oben) verhindert eine Engine ohne Abgleich. Ein Test in `server/lib/__tests__/` hält fest, dass `_handleEngineHello` eine abweichende Version ablehnt.

## `vault_list`

SSH-Einträge zeigen `username`, `allowSession`, `targets` (je `{ ref, name, host, port, hostKeyKnown }`; `name` bei Server-Zielen der Name des Server-Eintrags, sonst der Host) und `usableBy`: `ssh_exec`, dazu `ssh_put` und `ssh_get` bei Agenten-Keys mit Server. Ziele, die der Aufrufer nicht sieht, fehlen. Ohne Ziel: `usableBy` leer.

## Oberfläche

Nach Manifest Revision 20 (Design-Block unten), Umsetzungsanleitungen in `docs/design/guides/`:

- **Eintrag-Dialog** (`ui-vault-dialog.md`): bei Typ SSH in „Nutzung durch Agenten“ `UI-VAULT-DIALOG-SSH-SERVERS` (Chips, „+ Server“ mit Suche über die SSH-Server aus `ServerContext`), `UI-VAULT-DIALOG-SSH-HOSTS`, `UI-VAULT-DIALOG-SSH-SESSION`. `vaultTypes.js`: `ssh.targets = ["servers", "hosts"]`, `USAGE_FIELDS` um `servers`, `hosts`, `allowSession`.
- **Detail** (`ui-vault.md`): `UI-VAULT-DETAIL-SSH-TARGETS` mit Host-Key je Ziel und „Vergessen“; `UI-VAULT-DETAIL-USAGE` bei SSH „Nur Einmal“ bzw. „Sitzungsfreigabe erlaubt“.
- **Freigabe-Karte** (`ui-vault-approval.md`): Zielzeile, `UI-VAULT-APPROVAL-COMMAND`, `UI-VAULT-APPROVAL-EXEC`, `UI-VAULT-APPROVAL-HOSTKEY`, Dateizeile.
- **Anleitung im Agenten-Zugang** (`ui-agent-access.md`): Karte „SSH“ in „So funktioniert's“, Karte „SSH ohne Terminal“ in „Gut zu wissen“.
- Toast bei Host-Key-Abweichung (kein Manifest-Element).
- Texte in `client/public/assets/locales/de_DE.json` und `en.json`.

## REST-Endpunkte

| Endpunkt | Änderung |
|---|---|
| `POST /api/vault/items`, `PATCH /api/vault/items/:id` | `fields.servers`, `fields.hosts`, `fields.allowSession` bei Typ `ssh` |
| `GET /api/vault/items/:id` | bei Typ `ssh` zusätzlich `hostKeys`: je Ziel `{ target, algorithm, fingerprint, confirmedAt, confirmedBy: { id, name } }` |
| `DELETE /api/vault/items/:id/host-keys/:target` | neu; Recht wie Bearbeiten (`canManageItem`); `204`, unbekanntes Ziel `404`; Audit `vault.ssh_host_key_forgotten` |
| `POST /api/mcp` | Werkzeuge `ssh_exec`, `ssh_put`, `ssh_get` |

## Audit

- `vault.use` / `vault.use_denied` mit `tool`, `access`, `target` (Bezeichner), `host`, `port`, `user`; `ssh_exec`: `command` (auf 1 KB gekürzt, geschwärzt), `exitCode`, `timedOut`, `bytes` (stdout + stderr vor dem Kürzen); Dateien: `from`, `to`, `bytes`.
- Neu: `vault.ssh_host_key_pinned` (`target`, `algorithm`, `fingerprint`), `vault.ssh_host_key_mismatch` (`target`, `expected`, `actual`), `vault.ssh_host_key_forgotten` (`target`, `fingerprint`).
- Nie Geheimnisse, nie Dateiinhalte, nie Ausgaben.

## Fehlercodes

Neu in `server/lib/vault/errors.js` (Meldung englisch, ohne Geheimnis):

- `vault.no_targets` „This SSH entry has no targets; ask the user to add a server or host in Outpost.“
- `vault.target_not_allowed` „This target is not one of the entry's targets (vault_list shows them).“
- `vault.target_unavailable` „This server is no longer available to you in Outpost; nothing was done.“
- `vault.bad_command` „command must be a non-empty string of at most 8 KB.“
- `vault.bad_timeout` „timeoutSec must be a whole number from 1 to 600.“
- `vault.bad_path` „Paths must be absolute or start with ~/, at most 4 KB, on one line.“
- `vault.not_a_file` „<path> is not a regular file.“
- `vault.file_too_large` „<path> is larger than 100 MB.“
- `vault.file_exists` „<path> exists; pass overwrite: true to replace it.“
- `vault.no_agent_server` „File transfer needs an agent key set up on a server; this connection has none.“
- `vault.host_key_changed` (oben)
- `vault.ssh_failed` „The SSH connection to <target> failed (<kind>); nothing was done.“ — `<kind>`: Verbindung, Zeitüberschreitung, Anmeldung abgelehnt, Engine nicht verbunden. Bei „Anmeldung abgelehnt“ zusätzlich „ask the user to check the entry's user and key“.

## Fehler- und Randfälle

- Geheimnis fehlt oder unlesbar: `vault.no_secret` bzw. `vault.item_unreadable` (wie heute).
- Eintrag oder Ziel während der offenen Karte geändert, Key entzogen: nichts läuft (`vault.approval_stale` bzw. `vault.item_unknown`).
- Befehl läuft länger als `timeoutSec`: Die Engine bricht ab (`timed_out`), das Ergebnis meldet es mit der bis dahin gelesenen Ausgabe; Exit-Code dann `-1`.
- Ausgabe enthält Binärdaten: als UTF-8 mit Ersatzzeichen, gekürzt.
- Server-Ziel bekommt einen anderen Host oder Port: gemerkter Key wird verworfen, die nächste Verbindung zeigt wieder eine Karte mit Fingerabdruck.
- Zwei Einträge mit demselben Ziel: je eigener gemerkter Key; ein falsch bestätigter betrifft nur seinen Eintrag.
- Engine nicht verbunden: `vault.ssh_failed` (Engine nicht verbunden), vor jeder Karte.
- Freier Host ist zugleich in der Serverliste: Er gilt als freier Host (Standard-Engine, ohne Jump-Hosts).
- Abbruch des MCP-Aufrufs während einer Übertragung: Abbruch, `.outpost-tmp` wird gelöscht.

## Tests

Ein Test je Verhalten, möglichst über echte Nahtstellen:

1. **Ablauf über den Broker** (`server/lib/vault/__tests__/sshExec.test.js`) mit nachgebauter `openSession`/`EngineSftpClient`: unbekanntes Ziel → Probe, Karte mit Fingerabdruck, nach „Einmal“ gemerkt, und der Lauf schickt ihn als Erwartung; gemerkter Key, Engine meldet `host_key_mismatch` → `vault.host_key_changed`, keine Karte, Audit; ohne `allowSession` → kein „Für diese Sitzung“ und eine alte Sitzungsfreigabe greift nicht; mit `allowSession` deckt eine Freigabe für `server:12` nicht `host:nas`; Ziel während der Karte entfernt → `vault.approval_stale`, kein Lauf; Ausgabe enthält Passwort und eine Zeile des Schlüssels → `••••`; Ausgabe über 64 KB → gekürzt mit Hinweis.
2. **Datenmodell** (`vaultItemsRoute`-Test erweitert): Zieländerung verwirft Geheimnisse und löscht gemerkte Keys entfernter Ziele; fremder oder Nicht-SSH-Server in `servers` → 400; Server-Eintrag gelöscht → aus `servers` entfernt, Keys weg; `DELETE …/host-keys/:target` mit und ohne Recht.
3. **Dateien** (`sshTransfer.test.js`): Temp-Datei und Umbenennen; Abbruch über 100 MB löscht die Temp-Datei; bestehendes Ziel ohne `overwrite` → `vault.file_exists`; Konto-Key → `vault.no_agent_server`, `vault_list` ohne die beiden Werkzeuge.
4. **Engine-Version**: abweichende Version beim Verbinden → abgelehnt.
5. **Live-Reihe gegen einen echten `sshd`** (`server/lib/vault/__tests__/sshLive.e2e.test.js`), übersprungen ohne `OUTPOST_SSH_E2E_ENGINE` und `OUTPOST_SSH_E2E_TARGET`: echte Engine (Container auf dem NAS) und ein `sshd`-Container mit Testbenutzer; Probe meldet den Fingerabdruck, der zu `ssh-keyscan` passt; richtiger Key → Befehl läuft; falscher erwarteter Key → `host_key_mismatch`, und das `sshd`-Log zeigt keinen Anmeldeversuch; `ssh_put` einer 5-MB-Datei kommt bitgleich an.
6. **Client**: Karte mit Befehl (Einklappen ab 20 Zeilen), Abzeichen „führt aus“, Kasten „Neues Ziel“, Dateizeile; Dialog mit Server-Auswahl, freien Hosts und Schalter; Detail mit Host-Key und „Vergessen“.
7. **Handtest**: Ziel `web02` aus der Serverliste und ein NAS als freier Host; `docker compose ps` per `ssh_exec`, eine Datei hin und zurück, Host-Key eines Testcontainers tauschen → Abbruch und Toast, „Vergessen“, neue Karte.

## Betrieb und Doku

`docs/vault.md` bekommt einen Abschnitt „SSH“: Ziele und „Gilt für“, Host-Key beim ersten Mal und Vergessen, kein Terminal und kein `sudo` mit Passwortabfrage (eigener Eintrag für den nötigen Benutzer), Dateiübertragung, Grenzen (Jump-Hosts ungeprüft, freie Hosts nur über die Standard-Engine), Fehlercodes, Werkzeugtabelle. Die Engine erscheint im selben Release wie der Server; ältere Engines verbinden sich nach dem Update nicht, wie bisher bei jedem Release.

<!-- mockingbird:design:begin -->
<!-- design: manifest=docs/design/manifest.yaml design_rev=20 design_hash=sha256:ad95d8c11ed0ab13f945d1cefc1be5498ed2a7b33e2ef7e834c20c0c6e523774 system=docs/design/design-system.md index=docs/design/mockups/index.html adapter=web screens=UI-VAULT,UI-VAULT-DIALOG,UI-VAULT-APPROVAL,UI-AGENT-ACCESS consumes=UI-SHELL-ACCOUNT,UI-SHELL-MOBILE-NAV,UI-SHELL-NAV -->
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
| UI-VAULT-DETAIL-USAGE | Nutzung durch Agenten | UI-VAULT | required | Was Agenten mit diesem Wert tun dürfen: nur lesen, auch über http, für Git (mit Benutzername), Eintragen im Browser auf den genannten Origins. Ausgeschaltetes fehlt als Zeile. Bei API-Key und Sonstiges; bei SSH nur die Zeile „Nur Einmal“ oder „Sitzungsfreigabe erlaubt“. Nicht: vault_binding, approval_policy, permission. |
| UI-VAULT-DETAIL-SSH-TARGETS | Ziele | UI-VAULT | required | Je Ziel eines SSH-Eintrags eine Zeile: Name bzw. Host, benutzer@host:port und der gemerkte Host-Key (Algorithmus, SHA256-Fingerabdruck, bestätigt am, von wem) oder „noch nie verbunden“. „Vergessen“ löscht den gemerkten Host-Key; die nächste Verbindung zeigt den Fingerabdruck wieder auf der Freigabe-Karte. Nur bei SSH sichtbar. Nicht: vault_binding, identity, ssh_key. |
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
| UI-VAULT-DIALOG-SSH-SERVERS | Ziele aus der Serverliste | UI-VAULT-DIALOG | required | Server aus Outposts Serverliste, auf denen ssh_exec, ssh_put und ssh_get mit diesem Benutzer und Geheimnis arbeiten dürfen. Host, Port, Jump-Hosts und Engine kommen vom Server-Eintrag, dessen Identität wird nicht benutzt. Nur SSH-Server; bei Organisations-Einträgen nur Server derselben Organisation. Nicht „Gilt für“: das sagt, von welchem Server aus ein Agent den Eintrag nutzt. Nicht: vault_binding, identity, jump_host. |
| UI-VAULT-DIALOG-SSH-HOSTS | Freie Hosts | UI-VAULT-DIALOG | required | Rechner außerhalb der Serverliste als host[:port], durch Komma oder Leerzeichen getrennt. Sie laufen über die Standard-Engine, ohne Jump-Hosts. Ändern verwirft die gespeicherten Geheimnisse und die gemerkten Host-Keys der entfernten Ziele. Nicht: api_host, fill_origin, vault_binding. |
| UI-VAULT-DIALOG-SSH-SESSION | „Für diese Sitzung“ erlauben | UI-VAULT-DIALOG | required | Ob die Freigabe-Karte für SSH-Zugriffe dieses Eintrags „Für diese Sitzung“ anbietet. Aus: jeder Befehl und jede Datei braucht „Einmal“. An: eine Sitzungsfreigabe gilt je Ziel und Art (ausführen, schreiben, lesen) für beliebige Befehle bis Sitzungsende. Standard aus. Nicht: approval_policy, vault_binding. |
| UI-VAULT-DIALOG-SAVE | Speichern | UI-VAULT-DIALOG | required | Legt den Eintrag an bzw. speichert Änderungen und schließt den Dialog; Beschriftung Erstellen beim Anlegen. |
| UI-AGENT-ACCESS-KEYS | Agenten auf diesem Server | UI-AGENT-ACCESS | required | Die Agenten-Keys dieses Servers — Agent, angelegt, zuletzt genutzt, IP-Bindung — je mit Entziehen. Entziehen widerruft den Key und entfernt die Registrierung auf dem Server. Nicht: api_key, vault_item, identity. |
| UI-AGENT-ACCESS-SETUP | Einrichten | UI-AGENT-ACCESS | required | Welche Agenten eingerichtet werden (Claude Code, Codex, Git) und welche zusätzlichen Adressbereiche (CIDR) ihr Key neben der IP dieses Servers akzeptiert. Git richtet in der globalen gitconfig des entfernten Benutzers den Git-Proxy von Outpost ein. Nicht: api_key, vault_binding. |
| UI-AGENT-ACCESS-URL | Outpost-Adresse für diesen Server | UI-AGENT-ACCESS | required | Die Adresse, unter der dieser Server Outpost erreicht; daraus entstehen MCP-URL und Adressprüfung dieses Keys. Vorbelegt mit der Adresse der letzten Einrichtung auf diesem Server, sonst mit der Standardadresse aus den Einstellungen. Für Server außerhalb des LANs zum Beispiel die Domain über einen Reverse-Proxy. Nicht: browser_launcher_url, vault_binding. |
| UI-AGENT-ACCESS-IPBIND | Nur von der IP dieses Servers | UI-AGENT-ACCESS | required | Ob der Key nur Anfragen von der Adresse dieses Servers (plus den eingetragenen Adressbereichen) akzeptiert. Vorbelegt mit dem Standard aus Einstellungen › Vault; aus heißt von überall. Nicht: vault_binding, allowed_origin. |
| UI-AGENT-ACCESS-RESULT | Ergebnis | UI-AGENT-ACCESS | required | Je Agent das Ergebnis der Einrichtung — eingerichtet, oder der fertige Befehl zum Kopieren, wenn die automatische Einrichtung scheiterte (CLI fehlt, Exec-Fehler). Der Key ist nur hier und nur jetzt sichtbar; ein Key, der weder automatisch eingerichtet noch kopiert wurde, wird beim Schließen gelöscht. Nicht: agent_key, toast. |
| UI-AGENT-ACCESS-GIT-NOTE | Hinweis Git über SSH | UI-AGENT-ACCESS | required | Steht im Agenten-Zugang, sobald Git ausgewählt ist — Remotes über SSH (git@github.com:…) laufen nicht über den Vault und müssen auf https umgestellt werden. Nicht: error, agent_setup_result. |
| UI-AGENT-ACCESS-UNREACHABLE | Outpost nicht erreicht | UI-AGENT-ACCESS | required | Warnung über dem Ergebnis, wenn der Server Outpost während der Einrichtung nicht unter der eingetragenen Adresse zurückgerufen hat (probeFailure eines eingerichteten Agenten) — unabhängig von der IP-Bindung. unreachable: der Rückruf lief und kam nicht an, typisch https vor einem Port, an dem Outpost nur http spricht; ohne ihn kann sich auch kein Agent verbinden. no_client: auf dem Server fehlen curl und wget, die Adresse ist ungeprüft, nicht falsch. Nicht: ip_binding, agent_setup_result, toast. |
| UI-AGENT-ACCESS-HELP | Anleitung | UI-AGENT-ACCESS | required | Fragezeichen-Knopf rechts neben dem Titel des Agenten-Zugangs; öffnet die Einrichtungsanleitung (UI-AGENT-ACCESS-GUIDE) über dem Dialog. Der Agenten-Zugang bleibt mit allen Eingaben offen und lässt sich, solange die Anleitung offen ist, nicht schließen. Nicht: support_dialog, tooltip, agent_setup_result. |
| UI-AGENT-ACCESS-GUIDE | Agenten-Zugang einrichten | UI-AGENT-ACCESS | required | Modale Anleitung über dem Agenten-Zugang, randlos gerahmt mit Kopf (Titel, ein Satz), Abschnittsleiste links (auf dem Handy oben, nur Nummern plus aktiver Abschnitt) und Fuß mit Fortschritt, Zurück und Weiter. Fünf Abschnitte, je einer sichtbar: So funktioniert's (Agent → Outpost → Dienst, Karten je Agent mit dem Schritt danach, dazu ein Absatz zu SSH: Befehle und Dateien auf Zielen des Eintrags, Host-Key beim ersten Mal), Voraussetzungen (SSH, erreichbare Adresse mit richtigen und falschen Beispielen, curl/wget und claude/codex/git), Git mit GitHub (acht Schritte in drei Phasen vom Fine-grained PAT bis zum ersten Clone, Feldtabellen mit den Beschriftungen des Vault-Dialogs, Kopieren-Knöpfe für Werte und Befehle), Git mit GitLab (Feldtabelle), Gut zu wissen (SSH-Remotes, Freigabe-Karte, IP-Bindung, Entziehen, SSH ohne Terminal: kein sudo mit Passwortabfrage). Fertig, Esc, Backdrop oder Schließen führen zurück in den Dialog. Nicht: support_dialog, agent_setup_result, documentation_page. |
| UI-VAULT-APPROVAL-CARD | Freigabe angefordert | UI-VAULT-APPROVAL | required | Eine Karte unten rechts über jeder Seite, nicht modal: ein Agent will einen Vault-Eintrag nutzen. Zeigt Agent und Server, Eintrag, Werkzeug und Ziel (Ursprung beim Eintragen, Methode mit Host und Pfad bei vault_http, Git mit Host und Repo) und die verbleibende Zeit; Antworten Einmal, Für diese Sitzung, Ablehnen. „Für diese Sitzung“ gilt getrennt für lesende und schreibende Zugriffe. Beim Eintragen eines Tokens nennt die Zeile auch das Feld, wie die Seite es bezeichnet („Eintragen auf https://github.com · Feld „Kommentar““); ist es kein Passwortfeld, gibt es nur „Einmal“ und „Ablehnen“. Bei SSH: Werkzeug (SSH-Befehl, Datei hochladen, Datei holen), Ziel als Name und benutzer@host:port, beim Befehl der Befehlsblock, bei Dateien Quelle → Ziel mit Größe; „Für diese Sitzung“ nur, wenn der Eintrag es erlaubt, und dann je Ziel. Mehrere Anfragen stapeln sich, die älteste unten. Der Stapel liegt über Dialogen und Toasts. Eine abgelaufene Karte zeigt fünf Sekunden den Fehlerzustand und verschwindet; scheitert das Senden einer Antwort, bleibt die Karte stehen und ein Toast nennt den Grund. Nicht: notification, toast, error. |
| UI-VAULT-APPROVAL-WRITE | schreibt | UI-VAULT-APPROVAL | required | Abzeichen in der Kopfzeile der Freigabe-Karte, wenn der Zugriff etwas verändert; bei lesenden Zugriffen fehlt es. Eine Sitzungsfreigabe für Lesen gibt Schreiben nicht frei. Nicht: error, warning_toast. |
| UI-VAULT-APPROVAL-EXEC | führt aus | UI-VAULT-APPROVAL | required | Rotes Abzeichen in der Kopfzeile der Freigabe-Karte bei ssh_exec. Ein Shell-Befehl kann alles, was der Ziel-Benutzer darf; ob er schreibt, lässt sich nicht erkennen. Steht anstelle von „schreibt“, nie zusammen damit. Nicht: write_access, error, warning_toast. |
| UI-VAULT-APPROVAL-COMMAND | Befehl | UI-VAULT-APPROVAL | required | Der vollständige Befehl einer ssh_exec-Anfrage in Monospace, so wie er auf dem Ziel läuft — nichts gekürzt oder umformuliert. Ab 20 Zeilen eingeklappt mit „Ganz anzeigen (n Zeilen)“; die Karte bleibt dabei bedienbar. Nicht: audit_log, terminal. |
| UI-VAULT-APPROVAL-HOSTKEY | Neues Ziel | UI-VAULT-APPROVAL | required | Hervorgehobener Kasten auf der Karte, wenn Outpost dieses Ziel für diesen Eintrag noch nie gesehen hat: Algorithmus und SHA256-Fingerabdruck des Host-Keys mit dem Rat, ihn mit ssh-keyscan oder an der Konsole zu vergleichen. Mit „Einmal“ oder „Für diese Sitzung“ wird er gemerkt; danach bricht jede Verbindung mit anderem Key vor der Anmeldung ab. Nicht: error, toast. |

**Übernommene Elemente** (hier nicht zu bauen, nur zu verwenden):
- `UI-SHELL-ACCOUNT` — Konto
- `UI-SHELL-MOBILE-NAV` — Bereiche (schmaler Schirm)
- `UI-SHELL-NAV` — Bereiche

Artboards: `docs/design/mockups/index.html` · Design-System: `docs/design/design-system.md`
<!-- mockingbird:design:end -->
