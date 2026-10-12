# Credentials Vault – Teilprojekt 2b: SSH (ssh_exec, ssh_put, ssh_get)

## Ziel

Ein Agent (Claude Code, Codex) führt Befehle auf anderen Rechnern aus und überträgt Dateien dorthin oder von dort, ohne den SSH-Schlüssel oder das Passwort je zu sehen. Outpost meldet sich selbst an, über seine Engine, mit Benutzer und Geheimnis aus einem Vault-Eintrag vom Typ `ssh`. Jeder Zugriff braucht eine Freigabe, wenn der Eintrag sie verlangt (Schalter „Freigabe erforderlich“ wie bei den anderen Typen), und die Verbindung zu einem neuen Ziel immer. Auf der Karte steht der vollständige Befehl, und alles steht im Audit-Log. Zwei Fälle sind gleich wichtig:

- **Andere Server steuern:** Ein Agent auf `appmonster` arbeitet auf `web02` oder einem NAS (Deploy, Logs, Neustart).
- **Anderer Benutzer auf dem eigenen Server:** Ein Agent führt auf seinem eigenen Server Befehle als `root` oder als Dienstbenutzer aus, dessen Zugang nur im Vault liegt.

Beim ersten Kontakt zu einem Ziel merkt sich Outpost dessen Host-Key. Weicht er später ab, bricht die Engine vor der Anmeldung ab. Heute prüft die Engine Host-Keys gar nicht (`engine/src/net/ssh_common.c`, Handshake ohne Abgleich); 2b schließt diese Lücke für die Verbindung zum Ziel eines Vault-Eintrags; Jump-Hosts und der eigene Server des Agenten bleiben ungeprüft (Grenze des Modells).

### Einordnung

Teilprojekt 2 des Vaults (`docs/superpowers/specs/2026-10-09-vault-core-design.md`, „Einordnung“) ist in drei Specs geschnitten: 2a Tokens (`docs/superpowers/specs/2026-10-10-vault-tokens-design.md`, ausgeliefert in 0.1.11), **2b SSH** (diese Spec), 2c `db_query`. 2b nutzt aus Teilprojekt 1 und 2a: Einträge, Bindung an Server, Agenten-Keys mit IP-Bindung, MCP-Endpunkt, Freigabe-Karte, Audit, den Vermittlungskern `server/lib/vault/broker.js` und die Schwärzung `server/lib/vault/redact.js`.

Umsetzung in zwei Phasen eines Plans: (1) Engine-Abgleich, Datenmodell, `ssh_exec`, Oberfläche; (2) `ssh_put`/`ssh_get`. Beide erscheinen im selben Release, weil der Server nur Engines seiner eigenen Version annimmt.

### Grenze des Modells

- Wie in Teilprojekt 1 und 2a gibt kein Werkzeug einen Wert heraus. Was ein Befehl ausgibt, bestimmt das Ziel. Outpost schwärzt darin das Passwort, die Passphrase und den privaten Schlüssel des Eintrags, aber nichts anderes. Wer auf `web02` als `deploy` Befehle ausführen darf, liest alles, was `deploy` dort lesen darf, auch fremde Geheimnisse in Dateien.
- Ein freigegebener Befehl kann alles, was der Ziel-Benutzer kann. Die Karte zeigt ihn vollständig. Ob er etwas verändert, lässt sich nicht erkennen; deshalb gibt es bei `ssh_exec` keine Unterscheidung in Lesen und Schreiben.
- Dateiinhalte laufen ungeschwärzt durch Outpost, aber nie durch den Kontext des Agenten.
- Auf dem Server des Agenten liest und schreibt Outpost Dateien für `ssh_put`/`ssh_get` als derselbe Benutzer, für den der Agenten-Zugang eingerichtet ist. Der Agent bekommt dort keine Rechte dazu.
- Die Host-Key-Sperre gilt für das Ziel. Die Host-Keys von Jump-Hosts prüft 2b nicht, ebenso wenig die SFTP-Verbindung zum eigenen Server des Agenten (die bestehende Verbindung des Agenten-Zugangs, wie heute).
- Wer als `root` Befehle auf dem Ziel freigegeben bekommt, kann spätere Anmeldungen mitschneiden (PAM, sshd) und so das Passwort des Eintrags erfahren; ein Schlüssel gibt nur einen Beweis preis. Für privilegierte Benutzer Schlüssel statt Passwort (Hinweis in `docs/vault.md`).

## Entscheidungen

| Thema | Entscheidung |
|---|---|
| Werkzeuge | `ssh_exec`, `ssh_put`, `ssh_get` als MCP-Werkzeuge, alle über `broker.use`. |
| Unterbau | Die Engine, über eine SFTP-Sitzung (`SessionType.SFTP`, `EngineSftpClient`): `exec` mit Zeitlimit, `readFile`/`writeFile`, `rename`, `unlink`, `stat`. Kein `ssh2` im Node-Server, kein `ExecCommand` (dort 30 s fest, ohne eigenes Zeitlimit). |
| Ziele | Je Eintrag Server aus der Serverliste (`servers`, Entry-IDs) und freie Hosts (`hosts`, `host[:port]`; nur mit dem Recht `connect.direct`). Bei Server-Zielen kommen Host, Port, Jump-Hosts und Engine vom Server-Eintrag, dessen Identität wird nie benutzt. Freie Hosts laufen über die Standard-Engine ohne Jump-Hosts. |
| Benutzer und Geheimnis | Immer aus dem Vault-Eintrag (`username`; `privateKey` mit optionaler `passphrase` und/oder `password`). |
| Host-Keys | Beim ersten Kontakt merken (TOFU) je Eintrag und Ziel, Fingerabdruck auf der Freigabe-Karte. Abgleich in der Engine nach dem Handshake und vor jeder Anmeldung. Abweichung: Abbruch, kein Geheimnis verlässt Outpost. |
| Freigabe | Nach `approvalRequired` des Eintrags wie bei den anderen Typen; ein neues Ziel (unbekannter Host-Key) immer. Karte mit Werkzeug, Ziel, `benutzer@host:port`, bei `ssh_exec` dem vollständigen Befehl, bei Dateien Quelle → Ziel mit Größe. „Für diese Sitzung“ nur mit `allowSession` am Eintrag (Standard aus), dann je Sitzung, Eintrag, Ziel, Art und Host-Key. |
| Arten | `ssh_exec` → `exec` (Abzeichen „führt aus“, rot), `ssh_put` → `write` („schreibt“), `ssh_get` → `read`. |
| Engine-Version | Der Server nimmt heute nur Engines mit genau seiner Version an (`ControlPlaneServer._handleEngineHello`, `server/lib/controlPlane/ControlPlaneServer.js`). Eine Engine ohne Host-Key-Abgleich kann sich deshalb nicht verbinden; ein eigenes Fähigkeits-Feld ist nicht nötig. Die Spec verlässt sich darauf und hält es mit einem Test fest. |

## Datenmodell

### `vault_items.fields` für Typ `ssh` (JSON, keine Spaltenänderung)

| Feld | Typ | Regel |
|---|---|---|
| `username` | String | Bestand, Pflicht, höchstens 255 Zeichen. |
| `servers` | Array von Ganzzahlen | Neu. Entry-IDs, höchstens 50, ohne Doppelte. Jede ID ist ein Eintrag mit `type: "server"` und `config.protocol: "ssh"`, den der Speichernde verbinden darf (`validateEntryAccess(…, Permission.CONNECT_SSH)`) — geprüft nur für IDs, die mit diesem Speichern neu hinzukommen; schon gespeicherte bleiben, die Nutzung prüft Schritt 2 für das Konto hinter dem Agenten-Key; bei Einträgen einer Organisation gehört der Server derselben Organisation (`resolveEntryScope`). Sonst `400` „Server <id> is not an SSH server you can use for this entry“. |
| `hosts` | Array von Strings | Neu. `host[:port]`, höchstens 50, Host als Hostname, IPv4 oder `[IPv6]`, Port 1–65535; ohne Port gilt 22. Klein geschrieben gespeichert, ohne Doppelte; `host:22` wird zu `host`. Hinzufügen eines Hosts, der noch nicht in `hosts` steht, verlangt `Permission.CONNECT_DIRECT` des Speichernden, sonst `400` „Free hosts need the permission to connect without an entry“ (wie direkte Verbindungen über die Engine; das Recht ist standardmäßig aus). Entfernen und Speichern unveränderter `hosts` verlangt es nicht. |
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
- Ein Server-Eintrag wird gelöscht: `removeBindings("entry", ids)` in `server/lib/vault/bindings.js` (aufgerufen von `entry.js`, `folder.js`, `integration.js` und `organization.js` vor jedem Löschen von Einträgen) entfernt zusätzlich die IDs aus `servers` aller SSH-Einträge und löscht deren Zeilen für `server:<id>`. Die Geheimnisse bleiben (das Ziel wird weniger, nicht anders).
- Ändern sich Host, Port, Jump-Hosts oder Engine eines Server-Eintrags, bleibt der gemerkte Key: derselbe Rechner passt, ein anderer ergibt `vault.host_key_changed`, bis jemand den Key in der Detailansicht vergisst. So kann niemand mit Bearbeitungsrecht am Server-Eintrag das Ziel unbemerkt umlenken.

## Vermittlung

Alle drei Werkzeuge laufen durch `broker.use` (`server/lib/vault/broker.js`) mit `lazySecret: true`. Neu:

- `access` kann `exec` sein. Die Karte zeigt dann das Abzeichen `UI-VAULT-APPROVAL-EXEC` statt `UI-VAULT-APPROVAL-WRITE`.
- `scope` = `<access>#<target>#<fingerprint>`, z. B. `exec#server:12#SHA256:…`; bei neuem Ziel der Fingerabdruck der Probe. Der Umfang enthält bewusst kein `|`: daran erkennt `broker.use` heute die Umfänge, die immer fragen (`fill|<origin>` aus 2a), und SSH folgt `approvalRequired`. Eine Sitzungsfreigabe für `web02` deckt `nas` nicht, eine für Lesen deckt weder Schreiben noch Ausführen, und keine deckt einen anderen Host-Key.
- `allowSession` der Anfrage = `(item) => item.fields?.allowSession === true` — nicht der rohe Feldwert, denn `broker.use` behandelt heute `undefined` als erlaubt (`valueOf(allowSession, item) !== false`, `broker.js`). Ist es aus, gilt die Regel aus 2a (`approvals.js`): kein „Für diese Sitzung“ auf der Karte, `session` wird serverseitig zu `once`, und eine bestehende Sitzungsfreigabe greift nicht.
- `grantStamp` (`approvals.js`) enthält zusätzlich `username`, `servers` und `allowSession` (`hosts` steht schon darin), für alle Typen. Wirkung: Ändert sich eines davon, während eine Karte offen ist, endet der Aufruf mit `vault.approval_stale` (`useStamp` in `broker.js`; dessen Kommentar, der `username` ausnimmt, wird angepasst; das gilt nun auch für Login- und Datenbank-Einträge). Sitzungsfreigaben enden ohnehin bei jeder Bearbeitung (`updatedAt` im Stempel). Der Fingerabdruck steht nicht im Stempel, sondern im Umfang.
- Die Freigabe-Anfrage trägt für SSH zusätzlich `sshTarget` (`{ ref, name, user, host, port }`), `command` (nur `ssh_exec`, ungekürzt), `file` (nur `ssh_put`/`ssh_get`: `{ from, to, bytes }`) und `hostKey` (`{ algorithm, fingerprint, new: true }`, nur bei unbekanntem Ziel). `VAULT_APPROVALS` im StateBroadcaster liefert sie mit; die Karte zeigt sie (Abschnitt „Oberfläche“). `broker.use` bekommt dafür die Option `card` (Wert oder Funktion des Eintrags, wie `target`); sie geht an `approvals.requestApproval({ …, card })`, wird am offenen Antrag gespeichert und von `listOpenApprovals` als `card` geliefert. `listOpenApprovals` legt die Felder von `card` flach an die Anfrage (`sshTarget`, `command`, `file`, `hostKey`), wie `docs/design/guides/ui-vault-approval.md` sie liest (`hostKey.new`).
- `broker.use` bekommt die Option `forceApproval` (Wert oder Funktion des Eintrags). Der Broker wertet sie wie `scope` und `card` erst **nach** `check(item, { phase: "before" })` aus, denn erst dort läuft die Probe (Schritt 5). Ist sie wahr, fragt der Broker auch bei `approvalRequired: false` (Bedingung des Freigabe-Zweigs: `approved !== null || approving || forced || scope enthält "|"`) und ruft `requestApproval` mit `skipSessionGrant: true` auf: `approvals.requestApproval` überspringt dann `hasSessionApproval`, speichert eine Antwort „Für diese Sitzung“ aber wie sonst. Die Probe läuft nur in Phase `before`; in Phase `after` vergleicht `check` nur den gemerkten mit dem geprüften Fingerabdruck.

### Ablauf je Aufruf

1. Eintrag sichtbar (`findVisibleItem`), Typ `ssh`, sonst `vault.wrong_type`.
2. Ziel gehört zum Eintrag, sonst `vault.target_not_allowed`. Server-Ziel: Eintrag existiert noch, ist SSH, gehört bei Einträgen einer Organisation noch derselben Organisation (`resolveEntryScope`), und das Konto hinter dem Agenten-Key darf ihn verbinden (`validateEntryAccess(…, Permission.CONNECT_SSH)`), sonst `vault.target_unavailable`. Freier Host: das Konto hinter dem Agenten-Key hat `Permission.CONNECT_DIRECT`, sonst `vault.target_unavailable`.
3. Werkzeugeigene Prüfungen (Befehl, Pfade, unten).
4. Drosselung: 30 Aufrufe pro Minute je Agenten-Key für alle drei Werkzeuge zusammen (`vault.rate_limited`), höchstens 2 gleichzeitig (`vault.busy`).
5. Die Engine des Ziels muss verbunden sein (Server-Ziel: `controlPlane.getEngineInfo(config.engineId)` bzw. ohne `engineId` `controlPlane.hasEngine()`; freier Host: `hasEngine()`), sonst `vault.ssh_failed` (Engine nicht verbunden) ohne Karte — auch bei bekanntem Key, sonst gäbe es eine Karte für einen Aufruf, der nicht laufen kann. Host-Key: Ist für (Eintrag, Ziel) keiner gemerkt, baut Outpost eine **Probe** auf (unten): Verbindung bis nach dem Handshake, keine Anmeldung. Ergebnis `hostKey.new` geht in die Freigabe-Anfrage. Scheitert die Probe (Netz, DNS, Zeit), endet der Aufruf mit `vault.ssh_failed` ohne Karte.
6. Freigabe nach den Regeln von 2a: Karte, wenn `approvalRequired` gesetzt ist oder bei Impersonation. Bei `hostKey.new` immer eine Karte (`forceApproval`, oben), auch wenn `approvalRequired` aus ist: ohne bestätigten Key keine Anmeldung.
7. Nach der Freigabe: Key noch gültig, Eintrag neu laden, Prüfungen 1–3 erneut; geänderte Ziele, Benutzer oder Schalter ergeben `vault.approval_stale`. War der Key neu, wird er jetzt gespeichert (`confirmedBy` = `ctx.accountId`, das Konto, dem Karte und Antwort gehören). Ein inzwischen von anderer Seite gemerkter, abweichender Key ergibt `vault.host_key_changed`.
8. Erst jetzt die Geheimnisse: `act` liest `privateKey`, `passphrase` und `password` je mit `readSecret` (`server/lib/vault/secrets.js`), nicht über den Einzelfeld-`read` des Brokers; fehlen `privateKey` und `password`, `vault.no_secret`. Dann der Lauf über die Engine mit dem gemerkten Fingerabdruck als Erwartung.
9. Ausgabe schwärzen, Audit `vault.use`, `lastUsedAt` per `silent: true`.

### Host-Key-Abweichung

Meldet die Engine `HostKeyMismatch`, endet der Aufruf mit `vault.host_key_changed` („The host key of <target> changed (expected <alt>, got <neu>); nothing was sent. Ask the user to check the server and forget the old key in Outpost.“). Dazu Audit `vault.ssh_host_key_mismatch` mit beiden Fingerabdrücken und ein Toast an alle Sitzungen des Kontos: `stateBroadcaster.push([accountId], STATE_TYPES.VAULT_NOTICE, { kind: "ssh_host_key_mismatch", item, target, name })` (neuer Typ in `server/lib/StateBroadcaster.js`, nicht in `BROADCASTABLE_TYPES`; `push` überspringt Verbindungen mit `conn.impersonating`, wie `VAULT_APPROVALS`); der Client zeigt „Host-Key von <Ziel> hat sich geändert — Verbindung abgebrochen“. Es gibt keine Karte und keinen Weg, die Abweichung zu überspringen; erst „Vergessen“ in der Detailansicht (`UI-VAULT-DETAIL-SSH-TARGETS`) gibt den Weg frei, und die nächste Verbindung zeigt den neuen Fingerabdruck auf der Karte.

### Sitzung zum Ziel

`server/lib/vault/sshSession.js` öffnet jede Engine-Sitzung der drei Werkzeuge. Sitzungs-ID `vault-ssh-<uuid>`, `SessionType.SFTP`. Server-Ziel: Host (`config.ip`), Port, Jump-Hosts (`resolveJumpHosts`) und Engine (`config.engineId`) vom Server-Eintrag; freier Host: Standard-Engine, keine Jump-Hosts. `openEngineSession` (`server/lib/ConnectionService.js`) bekommt ein optionales achtes Argument `options`, das an `openSession` geht (`{ expectedHostKey, execOnly }`); `sshSession.js` ruft es auf und danach `new EngineSftpClient(socket)` und `waitForReady()`. Ein `finally` ruft `client.close()` und `controlPlane.closeSession(id)`, auch bei Fehler und bei Abbruch über `ctx.signal`. Die Probe ruft `openSession(…, { probeHostKey: true })` ohne `waitForDataConnection`; auch sie ruft im `finally` `controlPlane.closeSession(id)`. Die Probe schickt als Parameter nur `username` (ohne ihn bricht `sftp_session_thread` mit „Missing username“ ab), nie `password`, `privateKey` oder `passphrase`; Jump-Hosts wie bei jeder Verbindung (`resolveJumpHosts`). Diese Sitzungen erscheinen nicht im `SessionManager`. `ssh_exec` öffnet seine Sitzung mit `execOnly: true` (unten, „Engine“): ein Ziel ohne SFTP-Dienst kann dann trotzdem Befehle ausführen; `ssh_put`/`ssh_get` öffnen ohne `execOnly` und brauchen SFTP.

## `ssh_exec`

```
ssh_exec({ item, target, command, timeoutSec? })
```

Beschreibung an den Agenten (englisch): Run a shell command on one of the targets of a vault SSH entry. Outpost logs in itself with the entry's user and key or password; you never see them. No terminal: interactive programs and sudo password prompts do not work — use an entry for the user you need. The user approves every call and sees the full command. Output: exit code, stdout and stderr, each cut at 64 KB; the entry's password and key are replaced by ••••.

Prüfungen:
- `command`: String, nicht leer, höchstens 8 KB, ohne NUL, sonst `vault.bad_command`.
- `timeoutSec`: Ganzzahl 1–600, Standard 60, sonst `vault.bad_timeout`.

Ausführung: Sitzung zum Ziel (oben), `EngineSftpClient.exec(command, timeoutSec * 1000)` (`server/lib/EngineSftpClient.js`), danach Sitzung schließen. Kein `stdin`.

Ergebnis an den Agenten:

```
exit <code>[ (timed out after <n> s)]
--- stdout ---
<stdout>
--- stderr ---
<stderr>
```

Ausgabe als UTF-8 (ungültige Folgen ersetzt). Jeder Strom läuft durch `truncateAndRedact(text, 65536, variants)` aus `server/lib/vault/redact.js`; gekürzt endet er wie bei `vault_http` mit `[truncated after 65536 bytes]`. Varianten: `password`, `passphrase`, der private Schlüssel als Ganzes und jede seiner Zeilen mit mindestens 16 Zeichen außer den Rahmenzeilen `-----BEGIN …`/`-----END …` (ein `cat` des Schlüssels erscheint zeilenweise), jeweils mit `variantsOf` aus `server/lib/vault/redact.js`. Kürzere Werte als 4 Zeichen werden nicht ersetzt (Regel aus 2a).

`access` = `exec`, `target` auf der Karte = `<name> · <benutzer@host:port>`.

## `ssh_put` und `ssh_get`

```
ssh_put({ item, target, localPath, remotePath, overwrite? })
ssh_get({ item, target, remotePath, localPath, overwrite? })
```

Beschreibung (englisch): Copy one file between your own server and a target of a vault SSH entry. Outpost reads and writes the file itself — on your server as your own user, on the target as the entry's user — so the content never passes through you. At most 100 MB; an existing file is only replaced with overwrite: true. Needs approval.

- Nur für Agenten-Keys mit Server (`ctx.agent.entryId`); sonst `vault.no_agent_server`. `vault_list` nennt die beiden Werkzeuge dann nicht.
- Pfade: absolut oder mit `~/` beginnend, höchstens 4 KB, ohne NUL und ohne Zeilenumbruch, sonst `vault.bad_path`. `~/` ersetzt Outpost durch `realpath(".")` der jeweiligen Sitzung (Heimatverzeichnis des Sitzungsbenutzers); andere Pfade bleiben unverändert.
- Quelle: `stat` muss eine reguläre Datei zeigen (`vault.not_a_file`), Größe höchstens 100 MB (`vault.file_too_large`). `ssh_put`: Die Quelle liegt auf dem Server des Agenten (Sitzung ohne Vault-Geheimnis); geprüft vor der Freigabe, die Karte zeigt die Größe. `ssh_get`: Die Quelle liegt auf dem Ziel, an dem sich Outpost erst nach der Freigabe anmeldet (Schritt 8); geprüft im `act` vor dem Lesen, die Karte zeigt „Größe nach der Freigabe“ (`file.bytes = null`), und das Lesen bricht über 100 MB ab wie unten.
- Ziel: existiert die Datei und fehlt `overwrite: true`, `vault.file_exists`. `ssh_get` (Ziel auf dem Server des Agenten): geprüft vor der Freigabe und erneut direkt vor dem Schreiben. `ssh_put` (Ziel auf dem Ziel-Rechner): erst im `act`, direkt vor dem Schreiben.
- `~/` in einem Pfad auf dem Ziel löst Outpost erst nach der Anmeldung auf; die Karte zeigt den Pfad so, wie der Agent ihn geschickt hat.
- Ablauf: zwei SFTP-Sitzungen — eine zum Server des Agenten (Identität `identityId` des Agenten-Keys aus `ApiKey`, wie bei der Einrichtung; ihr Benutzer muss `remoteUser` des Keys sein, sonst `vault.no_agent_server`; ohne Host-Key-Abgleich), eine zum Ziel (Vault-Benutzer, erwarteter Host-Key). `readFile` der Quelle wird in `writeFile` von `<ziel>.outpost-<8 Hex-Zeichen>.tmp` geleitet (zwei Clients, weil Quelle und Ziel verschiedene Rechner sind; der Quell-Client liest mit `readFile(path, { backpressure: true })` und dient nur diesem Lesen, so drosselt das Schreiben die Quelle, statt bis zu 100 MB im Node-Prozess zu puffern). Outpost zählt mit; über 100 MB oder bei einem Fehler wird abgebrochen und `<ziel>.outpost-<8 Hex-Zeichen>.tmp` gelöscht. Danach `rename` auf den Zielnamen (bei `overwrite` und einem `rename`, das am bestehenden Ziel scheitert — OpenSSH ersetzt bei SFTP v3 nicht —, vorher `unlink` des alten; scheitert danach das zweite `rename`, ist die alte Datei weg und das Ergebnis nennt `<ziel>.outpost-<8 Hex-Zeichen>.tmp`).
- Rechte: Outpost legt `<ziel>.outpost-<8 Hex-Zeichen>.tmp` zuerst leer an, setzt `chmod 0600`, schreibt dann (`O_TRUNC` behält die Rechte) und setzt vor dem `rename` die endgültigen Rechte, beim Ersetzen die der alten Zieldatei, sonst die der Quelle (`mode & 0o777`). Der Name der Temp-Datei ist je Aufruf zufällig, damit niemand auf dem Ziel dort vorab einen Symlink anlegen kann. Eigentümer der Zieldatei ist danach der Ziel-Benutzer des Eintrags; beim Ersetzen geht der alte Eigentümer verloren (kein `chown` in der Engine) — Hinweis in `docs/vault.md`.
- `ssh_get` läuft spiegelbildlich; die Sitzung zum Agenten-Server schreibt.
- Ergebnis: `Copied <bytes> bytes from <quelle> to <ziel>.`
- `access`: `ssh_put` = `write`, `ssh_get` = `read`.

## Engine

### Protokoll (`schema/control_plane.fbs`, `yarn schema:generate`)

- `SessionOpen` bekommt `expected_host_key:string` (`SHA256:…`, leer = keine Erwartung), `probe_host_key:bool` und `exec_only:bool`.
- `SessionOpenResult` bekommt `host_key_algorithm:string` und `host_key_fingerprint:string`, gefüllt bei jeder SFTP-Sitzung nach dem Handshake, auch bei `HostKeyMismatch`. `enum ErrorCode` bekommt `AuthFailed = 6` und `HostKeyMismatch = 7`. Neu `outpost_cp_send_session_result_ex(cp, sid, success, error_message, connection_id, error_code, host_key_algorithm, host_key_fingerprint)` in `engine/src/proto/control_plane.c`; `outpost_cp_send_session_result` bleibt als Hülle (`ConnectionFailed`, ohne Host-Key), seine übrigen Aufrufer in `ssh.c`, `telnet.c`, `websocket.c`, `connection.c` und `control_plane.c` bleiben unverändert. `sftp.c` ruft `_ex` und meldet `AuthFailed` nach gescheitertem `outpost_ssh_auth`.
- `ControlPlaneServer.openSession(sessionId, sessionType, host, port, params, jumpHosts, engineId, { expectedHostKey, probeHostKey, execOnly } = {})` (achtes Argument) löst mit `hostKey: { algorithm, fingerprint }` auf; im Fehlerfall trägt der Error `errorCode` und `hostKey`, durchgereicht im Zweig `MessageType.SessionOpenResult`. Bestehende Aufrufer ändern sich nicht.
- `schema/sftp_protocol.fbs`: `ExecRes` bekommt `timed_out:bool`. `fp_send_exec_result` (`engine/src/net/file_proto.c`) bekommt den Parameter `bool timed_out` (gesetzt aus `handle_exec` in `sftp.c`; `ftp.c` übergibt `false`). `EngineSftpClient` liest im Zweig `SftpMsgType.ExecResult` zusätzlich `timedOut: res.timedOut()`.

### C (`engine/src/net/sftp.c`, `engine/src/net/file_proto.c`, `engine/src/proto/control_plane.c`)

- Nach `outpost_ssh_setup_with_jumphosts` in `sftp_session_thread` (`engine/src/net/sftp.c`), das die Sitzung zum Ziel liefert (direkt oder hinter Jump-Hosts), und vor `outpost_ssh_auth` liest die Engine `libssh2_session_hostkey` (Typ) und `libssh2_hostkey_hash(ssh, LIBSSH2_HOSTKEY_HASH_SHA256)`, kodiert base64 ohne `=` und meldet beides. `ssh_common.c` bleibt unverändert.
- Ist `expected_host_key` gesetzt und weicht ab: Sitzung schließen, `SessionOpenResult` mit `error_code = HostKeyMismatch`, **ohne** `outpost_ssh_auth` aufzurufen.
- Liefert `libssh2_hostkey_hash` keinen Wert, gilt das bei gesetztem `expected_host_key` als Abweichung (`HostKeyMismatch`, ohne Anmeldung), bei einer Probe als Verbindungsfehler.
- Ist `probe_host_key` gesetzt: `sftp_session_thread` öffnet keine Datenverbindung (heute geschieht das vor dem Handshake), meldet nach dem Handshake `success = true` mit Host-Key und schließt; keine Anmeldung am Ziel (an Jump-Hosts wie bei jeder Verbindung).
- Ist `exec_only` gesetzt und scheitert `libssh2_sftp_init`, läuft die Sitzung ohne SFTP weiter: die Engine meldet Ready, führt `Exec` aus und beantwortet jede Dateioperation mit einem Fehler „SFTP not available“. Ohne `exec_only` bleibt ein gescheitertes `libssh2_sftp_init` ein Verbindungsfehler wie heute; die Engine meldet dann den Text „SFTP not available“, den `sshSession.js` als `vault.ssh_failed` (SFTP nicht verfügbar) weitergibt.
- Ohne die neuen Felder ändert sich nichts (Datei-Browser, Terminal, Agenten-Zugang).
- libssh2 wählt den Host-Key-Algorithmus nach eigener Vorliebe; eine Engine mit anderer libssh2-Version kann einen anderen Algorithmus wählen und für jeden gemerkten Key `vault.host_key_changed` melden. Hinweis in `docs/vault.md` (Abhilfe: Vergessen und neu bestätigen).

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
| `DELETE /api/vault/items/:id/host-keys/:target` | neu; Recht wie Bearbeiten (`canManageItem`); `204`, unbekanntes Ziel `404`; Audit `vault.ssh_host_key_forgotten`; `:target` ist der Ziel-Bezeichner, URL-kodiert (`encodeURIComponent`) |
| `POST /api/mcp` | Werkzeuge `ssh_exec`, `ssh_put`, `ssh_get` |

## Audit

- `vault.use` / `vault.use_denied` mit `tool`, `access`, `target` (Bezeichner), `host`, `port`, `user`; `ssh_exec`: `command` (auf 1 KB gekürzt, geschwärzt), `exitCode`, `timedOut`, `bytes` (stdout + stderr, wie die Engine sie geliefert hat, je Strom höchstens 256 KB); Dateien: `from`, `to`, `bytes`.
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
- `vault.ssh_failed` „The SSH connection to <target> failed (<kind>); nothing was done.“ — `<kind>`: Verbindung, Zeitüberschreitung, Anmeldung abgelehnt, Engine nicht verbunden, SFTP nicht verfügbar. Bei „Anmeldung abgelehnt“ zusätzlich „ask the user to check the entry's user and key“.

## Fehler- und Randfälle

- Geheimnis fehlt oder unlesbar: `vault.no_secret` bzw. `vault.item_unreadable` (wie heute).
- Eintrag oder Ziel während der offenen Karte geändert, Key entzogen: nichts läuft (`vault.approval_stale` bzw. `vault.item_unknown`).
- Befehl läuft länger als `timeoutSec`: Die Engine bricht ab und setzt `ExecRes.timed_out`; das Ergebnis meldet es mit der bis dahin gelesenen Ausgabe, Exit-Code `124` wie heute. Der Prozess auf dem Ziel kann weiterlaufen.
- Ausgabe enthält Binärdaten: Die Engine liefert je Strom höchstens 256 KB als C-String, nach dem ersten NUL-Byte fehlt der Rest; ungültiges UTF-8 wird ersetzt.
- Server-Ziel bekommt einen anderen Host oder Port: Der gemerkte Key bleibt; ein anderer Rechner ergibt `vault.host_key_changed` und den Toast, „Vergessen“ gibt den Weg frei.
- Zwei gleichzeitige Aufrufe desselben Eintrags aus derselben Verbindung: braucht auch der zweite eine Karte, endet er mit `vault.approval_pending`, solange die Karte des ersten offen ist (Regel aus 2a); ohne Karte läuft er (höchstens 2 gleichzeitig).
- Zwei Einträge mit demselben Ziel: je eigener gemerkter Key; ein falsch bestätigter betrifft nur seinen Eintrag.
- Engine nicht verbunden: `vault.ssh_failed` (Engine nicht verbunden), vor jeder Karte.
- Ziel ohne SFTP-Subsystem: `ssh_exec` läuft (`exec_only`), `ssh_put`/`ssh_get` enden mit `vault.ssh_failed` (SFTP nicht verfügbar).
- Freier Host ist zugleich in der Serverliste: Er gilt als freier Host (Standard-Engine, ohne Jump-Hosts).
- Abbruch des MCP-Aufrufs während einer Übertragung: Abbruch, die Temp-Datei wird gelöscht.

## Tests

Ein Test je Verhalten, möglichst über echte Nahtstellen:

1. **Ablauf über den Broker** (`server/lib/vault/__tests__/sshExec.test.js`) mit nachgebauter `openSession`/`EngineSftpClient`: unbekanntes Ziel → Probe, Karte mit Fingerabdruck, nach „Einmal“ gemerkt, und der Lauf schickt ihn als Erwartung; gemerkter Key, Engine meldet `host_key_mismatch` → `vault.host_key_changed`, keine Karte, Audit; ohne `allowSession` → kein „Für diese Sitzung“ und eine alte Sitzungsfreigabe greift nicht; mit `allowSession` deckt eine Freigabe für `server:12` nicht `host:nas`; `approvalRequired: false` und bekannter Key → Lauf ohne Karte, neuer Key → Karte; Server-Ziel ohne `connect.ssh` des Kontos → `vault.target_unavailable`; Ziel während der Karte entfernt → `vault.approval_stale`, kein Lauf; Ausgabe enthält Passwort und eine Zeile des Schlüssels → `••••`; Ausgabe über 64 KB → gekürzt mit Hinweis; freier Host ohne `connect.direct` des Kontos → `vault.target_unavailable`; Key vergessen, Probe liefert denselben Fingerabdruck und eine Sitzungsfreigabe für diesen Umfang besteht noch → trotzdem Karte (`skipSessionGrant`); Engine nicht verbunden → `vault.ssh_failed` ohne Karte.
2. **Datenmodell** (`server/lib/vault/__tests__/itemsRoute.test.js` erweitert): Zieländerung verwirft Geheimnisse und löscht gemerkte Keys entfernter Ziele; fremder oder Nicht-SSH-Server in `servers` → 400; `hosts` ohne `connect.direct` → 400; Server-Eintrag gelöscht → aus `servers` entfernt, Keys weg; `DELETE …/host-keys/:target` mit und ohne Recht.
3. **Dateien** (`sshTransfer.test.js`): Temp-Datei (zufälliger Name) und Umbenennen; `ssh_get` meldet sich vor der Freigabe nicht am Ziel an (Karte ohne Größe); Abbruch über 100 MB löscht die Temp-Datei; bestehendes Ziel ohne `overwrite` → `vault.file_exists`; Konto-Key → `vault.no_agent_server`, `vault_list` ohne die beiden Werkzeuge; die Temp-Datei hat während des Schreibens 0600; die neue Zieldatei hat danach die Rechte der Quelle (`mode & 0o777`), beim Ersetzen die der alten Zieldatei.
4. **Engine-Version**: abweichende Version beim Verbinden → abgelehnt.
5. **Live-Reihe gegen einen echten `sshd`** (`server/lib/vault/__tests__/sshLive.e2e.test.js`), übersprungen ohne `OUTPOST_SSH_E2E_ENGINE` und `OUTPOST_SSH_E2E_TARGET`: echte Engine (Container auf dem NAS) und ein `sshd`-Container mit Testbenutzer; Probe meldet den Fingerabdruck, der zu `ssh-keyscan` passt; richtiger Key → Befehl läuft; falscher erwarteter Key → `host_key_mismatch`, und das `sshd`-Log zeigt keinen Anmeldeversuch; `ssh_put` einer 5-MB-Datei kommt bitgleich an; ein `sshd` ohne `sftp`-Subsystem führt `ssh_exec` aus und lehnt `ssh_put` mit „SFTP nicht verfügbar“ ab.
6. **Client**: Karte mit Befehl (Einklappen ab 20 Zeilen), Abzeichen „führt aus“, Kasten „Neues Ziel“, Dateizeile; Dialog mit Server-Auswahl, freien Hosts und Schalter; Detail mit Host-Key und „Vergessen“.
7. **Handtest**: Ziel `web02` aus der Serverliste und ein NAS als freier Host; `docker compose ps` per `ssh_exec`, eine Datei hin und zurück, Host-Key eines Testcontainers tauschen → Abbruch und Toast, „Vergessen“, neue Karte.

## Betrieb und Doku

`docs/vault.md` bekommt einen Abschnitt „SSH“: Ziele und „Gilt für“, Host-Key beim ersten Mal und Vergessen, kein Terminal und kein `sudo` mit Passwortabfrage (eigener Eintrag für den nötigen Benutzer), Dateiübertragung, Grenzen (Jump-Hosts ungeprüft, freie Hosts nur über die Standard-Engine), Fehlercodes, Werkzeugtabelle. Die Engine erscheint im selben Release wie der Server; ältere Engines verbinden sich nach dem Update nicht, wie bisher bei jedem Release.

<!-- mockingbird:design:begin -->
<!-- design: manifest=docs/design/manifest.yaml design_rev=21 design_hash=sha256:69a0c4f1d82a8c97a9e21f95a0232e6df18fecae2b004ebc7f787eecf8bd3568 system=docs/design/design-system.md index=docs/design/mockups/index.html adapter=web screens=UI-VAULT,UI-VAULT-DIALOG,UI-VAULT-APPROVAL,UI-AGENT-ACCESS consumes=UI-SHELL-ACCOUNT,UI-SHELL-MOBILE-NAV,UI-SHELL-NAV -->
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
| UI-VAULT-DIALOG-SSH-HOSTS | Freie Hosts | UI-VAULT-DIALOG | required | Rechner außerhalb der Serverliste als host[:port], durch Komma oder Leerzeichen getrennt. Sie laufen über die Standard-Engine, ohne Jump-Hosts. Ändern verwirft die gespeicherten Geheimnisse und die gemerkten Host-Keys der entfernten Ziele. Nur mit dem Recht „Direkt verbinden“ (connect.direct); ohne es ist das Feld gesperrt mit Hinweis. Nicht: api_host, fill_origin, vault_binding. |
| UI-VAULT-DIALOG-SSH-SESSION | „Für diese Sitzung“ erlauben | UI-VAULT-DIALOG | required | Ob die Freigabe-Karte für SSH-Zugriffe dieses Eintrags „Für diese Sitzung“ anbietet. Aus: jeder Befehl und jede Datei mit Karte braucht „Einmal“. An: eine Sitzungsfreigabe gilt je Ziel, Art (ausführen, schreiben, lesen) und Host-Key für beliebige Befehle bis Sitzungsende. Ob überhaupt eine Karte kommt, sagt „Freigabe erforderlich“ des Eintrags; ein neues Ziel fragt immer. Standard aus. Nicht: approval_policy, vault_binding. |
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
| UI-VAULT-APPROVAL-CARD | Freigabe angefordert | UI-VAULT-APPROVAL | required | Eine Karte unten rechts über jeder Seite, nicht modal: ein Agent will einen Vault-Eintrag nutzen. Zeigt Agent und Server, Eintrag, Werkzeug und Ziel (Ursprung beim Eintragen, Methode mit Host und Pfad bei vault_http, Git mit Host und Repo) und die verbleibende Zeit; Antworten Einmal, Für diese Sitzung, Ablehnen. „Für diese Sitzung“ gilt getrennt für lesende und schreibende Zugriffe. Beim Eintragen eines Tokens nennt die Zeile auch das Feld, wie die Seite es bezeichnet („Eintragen auf https://github.com · Feld „Kommentar““); ist es kein Passwortfeld, gibt es nur „Einmal“ und „Ablehnen“. Bei SSH: Werkzeug (SSH-Befehl, Datei hochladen, Datei holen), Ziel als Name und benutzer@host:port, beim Befehl der Befehlsblock, bei Dateien Quelle → Ziel mit Größe (bei „Datei holen“ erst nach der Freigabe bekannt, dann „Größe nach der Freigabe“); „Für diese Sitzung“ nur, wenn der Eintrag es erlaubt, und dann je Ziel. Mehrere Anfragen stapeln sich, die älteste unten. Der Stapel liegt über Dialogen und Toasts. Eine abgelaufene Karte zeigt fünf Sekunden den Fehlerzustand und verschwindet; scheitert das Senden einer Antwort, bleibt die Karte stehen und ein Toast nennt den Grund. Nicht: notification, toast, error. |
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

<!-- preflight:security:begin -->
<!-- facts: network_surface=both has_accounts=yes auth_method=api-key
     has_privilege_levels=yes session_transport=bearer-header has_owned_data=yes
     is_multi_tenant=yes persistence=sql renders_html=yes accepts_uploads=no
     handles_pii=yes -->

## Security Requirements

| ID | Maßnahme | Geltungsbereich | Status | Begründung |
|----|----------|-----------------|--------|------------|
| SEC-INPUT-01 | Input-Validierung per Whitelist | Argumente von `ssh_exec`, `ssh_put`, `ssh_get`; neue `fields` (`servers`, `hosts`, `allowSession`); Ziel-Bezeichner im REST-Pfad | required | HTTP-API |
| SEC-ERR-01 | Fehlermeldungen ohne Stack-Traces und DB-Details | Werkzeugfehler ohne Geheimnis, Engine-Fehler nur als Art (`vault.ssh_failed`) | required | HTTP-API |
| SEC-SECRET-01 | Secrets außerhalb von Code und Repo | Passwort, Passphrase und privater Schlüssel nie in Log, Audit oder Antwort; Schwärzung der Befehlsausgabe; Entschlüsseln erst nach Freigabe | required | immer |
| SEC-DEP-01 | Abhängigkeiten auf bekannte Schwachstellen prüfen | keine neue Abhängigkeit geplant (libssh2 in der Engine vorhanden); neue nur nach Prüfung | required | immer |
| SEC-INJECT-01 | Fremde Eingaben nicht in Befehle oder Pfade bauen | Pfade nur über SFTP-Operationen, nie in Shell-Zeilen; der Befehl von `ssh_exec` ist gewollt fremd und läuft nur nach Freigabe mit dem vollständigen Text auf der Karte | required | immer |
| SEC-RATE-01 | Rate Limiting auf zustandsändernden Endpunkten | SSH-Werkzeuge 30/min und 2 gleichzeitig je Agenten-Key | required | HTTP-API |
| SEC-RATE-02 | Brute-Force-Bremse am Login | Login | not-applicable | (2026-10-11) 2b ändert den Login nicht; Agenten-Keys haben 256 Bit Entropie |
| SEC-SQLI-01 | Prepared Statements, keine String-Konkatenation | `vault_ssh_host_keys`, Aufräum-Hooks beim Bearbeiten und Löschen | required | SQL-Persistenz |
| SEC-XSS-01 | Kontextsensitives Output-Encoding | Freigabe-Karte mit Befehl, Pfaden und Ziel aus Agenten-Eingabe; Detailansicht | required | React-Oberfläche |
| SEC-CSP-01 | Content Security Policy | Bestand (Report-Only, Issue #16); 2b fügt keine Quellen hinzu | required | React-Oberfläche |
| SEC-IDOR-01 | Objektbezogene Autorisierung bei jedem Zugriff über eine ID | Eintrag über `findVisibleItem`, Server-Ziele über `validateEntryAccess`, `DELETE …/host-keys/:target` mit `canManageItem` | required | Einträge gehören Konten oder Organisationen |
| SEC-TENANT-01 | Mandanten-Scoping in jeder Abfrage | Server-Ziele von Organisations-Einträgen nur aus derselben Organisation | required | Organisationen als Mandanten |
| SEC-RBAC-01 | Rollen- oder Rechtemodell | `vault.use` für die Werkzeuge, Bearbeiten-Recht für „Vergessen“ | required | Berechtigungssystem |
| SEC-APIKEY-01 | API-Keys hoch entropisch, gehasht, widerrufbar, zeitkonstant verglichen | Agenten-Keys unverändert | required | Agenten-Keys |
| SEC-SESS-02 | Ablauf, Rotation, serverseitiger Widerruf | Sitzungsfreigaben je Ziel und Art, enden bei Änderung von Eintrag oder Host-Key und beim Widerruf | required | Bearer-Header |
| SEC-TOKEN-01 | Token-Validierung, Lebensdauer, sichere Ablage, Widerruf | Agenten-Key unverändert; Host-Key-Sperre verhindert, dass ein vorgetäuschtes Ziel Passwort oder Schlüsselbeweis erhält | required | Bearer-Header |
| SEC-PII-01 | Datensparsamkeit, Zugriffsprotokoll, Löschkonzept | Audit ohne Ausgaben, Dateiinhalte und Geheimnisse; Befehl gekürzt und geschwärzt | required | Audit der Nutzung mit Personenbezug |
<!-- preflight:security:end -->
