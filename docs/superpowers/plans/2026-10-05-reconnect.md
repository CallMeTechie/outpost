# Reconnect für Terminal- und Remote-Desktop-Sitzungen — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eine abgebrochene ssh-/telnet-/pve-lxc-/rdp-/vnc-Sitzung wird im selben Tab unter derselben Sitzungs-ID neu aufgebaut — per Knopf oder automatisch —, ohne dass ein verspätetes Ereignis der alten Verbindung die neue beschädigt.

**Architecture:** Der Server legt beim Fehlerende einer unterstützten Sitzung einen ruhenden Eintrag (Tombstone) mit der vollständigen Konfiguration im Speicher ab; `POST /api/connections/:id/reconnect` baut daraus über denselben Kern wie `createSession` (`openSession`) eine neue *Generation* derselben ID auf, die in der Engine unter `<id>:<generation>` läuft. Eine 1-s-Karenz am Daten-Socket lässt die Engine-Meldung („connection lost“/Engine-Abbruch) über den Ausgang entscheiden; Generationswächter verwerfen alles, was von einer älteren Generation kommt. Der Client klassifiziert Fehler (wiederholbar/endgültig), zeigt die Fehlerkarte mit Countdown, steuert die Automatik (`useAutoReconnect`) und hängt Renderer über `key={id-generation-attachNonce}` neu ein.

**Tech Stack:** Node.js ≥ 22 (Express 5, Joi, express-rate-limit 8, `node:test`), React 19 + Vite, vitest/jsdom/Testing Library (`*.test.jsx`), guacamole-common-js, Engine in C (OpenSSL, poll).

**Spec:** `docs/superpowers/specs/2026-10-05-reconnect-design.md` (inkl. mockingbird-Block Manifest-Revision 7 und preflight-Sicherheitsblock). Die Spec ist maßgeblich; dieser Plan argumentiert aus ihr. Wo der Plan von ihr abweicht oder sie ergänzt, steht es ausdrücklich unter „Abweichungen und Ergänzungen zur Spec“.

**Design:** `docs/design/manifest.yaml` (rev 7) — Design-System: `docs/design/design-system.md` — Artboards: `docs/design/mockups/index.html`

**Design Scope:** UI-SERVERS (übernommen, nicht zu bauen: UI-SHELL-ACCOUNT, UI-SHELL-MOBILE-NAV, UI-SHELL-NAV)

## Global Constraints

- Design-Quelle: `docs/design/manifest.yaml` (rev 7). Bei Konflikt zwischen Plan-Text und Manifest gilt das Manifest; melde den Konflikt, statt ihn still aufzulösen.
- Jedes gebaute UI-Element trägt seine Manifest-ID im Code: Web `data-ui-id="UI-…"`, andere Medien nach `adapters:` im Manifest. Ohne ID ist das Element nicht prüfbar.
- Design-Tokens ausschließlich aus `docs/design/mockups/tokens.css` bzw. `docs/design/design-system.md`. Keine neuen Farben, Abstände, Radien oder Schriftgrößen.
- Sichtbare Texte (Labels, Leer-, Lade- und Fehlerzustände) wörtlich aus dem Manifest (`label`, `states[].copy`). Keine eigenen Formulierungen.
- Jeder im Manifest deklarierte Zustand eines Elements wird gebaut, nicht nur `default`.
- Umfang: ssh, telnet, pve-lxc (Xterm) und rdp, vnc (Guacamole). Nicht: SFTP/OneDrive, Skripte, Notizen, beigetretene Sitzungen, pve-shell, pve-qemu.
- Tombstone nur bei `protocol ∈ {ssh, telnet, pve-lxc, rdp, vnc}`, `configuration.type !== "sftp"`, `configuration.scriptId == null` und `code === 4017` — außer Guacamole-Status `0x0209`, `0x020A`, `0x020B` oder `0x03xx`.
- Tombstone: `expiresAt = now + 15 min`; Aufräumtimer alle 60 s; höchstens ein Tombstone pro ID, ein neuer ersetzt den alten; nur im Speicher.
- Karenz am Daten-Socket: **1 s** (ssh/telnet/pve-lxc in `ConnectionService.js`, `GuacdClient` mit Grund `connection closed`).
- Engine-Sitzungs-ID: Generation 1 = nackte Sitzungs-ID; ab Generation 2 `<sessionId>:<generation>`; Länge < 64 = `MAX_SESSION_ID_LEN` (`engine/src/core/session.h:8`).
- Reconnect-Antworten: `200 { sessionId, generation }`, `404` (fremd), `409` (lebt noch), `410` (kein/abgelaufener Tombstone), `403`/`404` (Rechte/Eintrag/Identität fehlen).
- Audit: `AUDIT_ACTIONS.RECONNECT = "entry.reconnect"`, Eintrag in `ACTION_LABELS`, unterliegt `enableServerConnectionAudit`, `details: { reconnectOf, generation, connectionReason }`; seine ID ist die `auditLogId` der neuen Generation.
- Automatik: Wartezeiten `[5, 10, 30, 60, 120]` s, 5 Versuche, danach nur Knopf; pro Sitzung ein laufender Versuch, danach 3 s Sperre („Jetzt verbinden“ umgeht sie); Zähler-Reset erst nach 10 s stabiler Verbindung; sofortiger Versuch bei `online`, wiederkehrender Status-Verbindung und `visibilitychange` → sichtbar; nur bei `terminal.autoReconnect`, wiederholbarem Fehler und `wasConnected`.
- Einstellung `terminal.autoReconnect: boolean`, Standard `true`, Gruppe `terminal.input`.
- Design-Quelle: `docs/design/manifest.yaml` (`design_rev=7`, Screen `UI-SERVERS`), Artboard `docs/design/mockups/ui-servers.html`, Anleitung `docs/design/guides/ui-servers.md`, Design-System `docs/design/design-system.md`. Design ändern heißt Manifest ändern, nicht Code.
- UI nach Manifest-Revision 7: `UI-SERVERS-VIEW-ERROR` (Zustände `default`, `countdown`, `loading`, `final`, `expired`), `UI-SERVERS-TAB-CONNECTION` (`default`, `loading`, `error`), Kontextmenüeintrag „Neu verbinden“ an erster Stelle nur bei getrennten Sessions; Wortlaut aus dem Manifest; Texte in `en.json` und `de_DE.json`. Alle übrigen Elemente von `UI-SERVERS` dürfen nicht regressieren.
- Keine neuen Abhängigkeiten (Server und Client).
- Code-Kommentare: fast keine — nur nicht offensichtliches Warum, Fallstricke, externe Constraints. Bestehende Kommentardichte einer Datei wird nicht erhöht.
- Tests: ein Test je Verhalten; Integration über die Naht vor Mocks; keine Tests für Weiterreichung, Konstanten, Getter, Framework-Zusagen, Logs. Je Task nur die betroffenen Tests, volle Suite einmal am Phasenende.
- Client-Tests: DOM/React als `*.test.jsx` (vitest); reine Hilfsfunktionen dürfen wie die Nachbarn in `client/src/common/utils/__tests__` als `*.test.js` mit `node:test` laufen. Server-Tests unter `server/lib/__tests__/*.test.js` (`node --test`).
- Commits: deutsche Betreffzeile im Stil des Repos („Reconnect: …“), **keine** `Co-Authored-By`-/KI-Zeilen (ein Commit-Hook lehnt sie ab).

## Review Focus

1. **Reconnect während der 1-s-Karenz** (Knopf sofort nach dem Abbruch, `online`-Ereignis im selben Moment): erwartet wird, dass der Endpunkt den Ausgang der Karenz abwartet und `200` liefert, nicht `409` oder `410`. → Test in Task 4 („ein Reconnect während der Karenz wartet deren Ausgang ab“).
2. **Sitzungssync `same_browser`/`same_tab`**: die neue Generation muss in `GET /connections` desselben Browsers/Tabs auftauchen, sonst verschwindet der Tab beim nächsten Broadcast. Die Spec führt `tabId`/`browserId` nicht im Tombstone. → Tombstone trägt beide (Task 2), Prüfung in Task 4, Test 2 (`tabId`/`browserId` der neuen Sitzung).
3. **DELETE eines fremden Tombstones** (ein zweites Konto kennt die UUID): erwartet `404`, der Tombstone bleibt. → Test in Task 4 („fremde Konten können weder löschen noch schlafen legen noch fortsetzen; DELETE gewinnt gegen laufenden Reconnect“).
4. **Verspätete Fehlermeldung des alten Renderers nach erfolgreichem Reconnect**: der frisch verbundene Tab darf nicht wieder als getrennt markiert werden. → Test in Task 5 (`shouldRecordError`, `sessionErrors.test.jsx`).
5. **Erstverbindung scheitert** (falsches Passwort, Host aus): keine Automatik, aber „Neu verbinden“ funktioniert. → Test in Task 5 (`useAutoReconnect`, dritter Test).

---

## Abweichungen und Ergänzungen zur Spec

Beim Lesen des Codes gefunden; im Plan so umgesetzt, beim Review bitte bestätigen:

1. **Tombstone trägt zusätzlich `tabId` und `browserId`.** `getSessions` filtert nach `account.sessionSync` über genau diese Felder (`server/controllers/serverSession.js:211-216`); ohne sie wäre die neue Generation für den eigenen Browser unsichtbar.
2. **Fehlerkörper des Endpunkts enthält `code`.** `RequestUtil.request` wirft bei Fehlern den geparsten Body, nicht den HTTP-Status (`client/src/common/utils/RequestUtil.js:136-143`). Damit der Client `409/410/403/404` unterscheiden kann, antwortet die Route mit `{ code, message }`.
3. **`classifyConnectionError(input, t)`** bekommt `t` als zweiten Parameter (der Text muss übersetzt werden) und ein eigenes Feld `httpStatus` für die Endpunkt-Antworten, getrennt vom Guacamole-Status `statusCode`. `protocol` wird nicht gebraucht und entfällt.
4. **Tombstone wird unmittelbar vor `SessionManager.create` entfernt** (Spec: nach Schritt 6). Sonst könnte ein sehr schnell scheiternder Verbindungsaufbau der neuen Generation seinen eigenen, neuen Tombstone anlegen, den Schritt 7 dann löscht.
5. **`DELETE /connections/:id` prüft den Besitz auch für lebende Sitzungen** (heute fehlt die Prüfung, `server/routes/serverSession.js:128-137`, `deleteSession` ohne `accountId`) und wartet auf das Ende der Sitzung, bevor es einen Tombstone verwirft. Nebenbefund: `deleteSession` wertete bisher ein Promise als Erfolg (`server/controllers/serverSession.js:270-276`). DELETE, hibernate, resume antworten bei fremden Sitzungen bewusst `404` statt `403` von `validateSessionOwnership` (keine Auskunft über fremde Sitzungen).
6. **Fehlerkarte wird vom Besitzer gerendert, nicht vom Renderer.** `XtermRenderer`/`GuacamoleRenderer` melden nur noch; `ViewContainer`, `Popout` und `Share` zeigen `ConnectionError`. Grund: die Karte braucht Reconnect-Zustand, Countdown und Handler des Besitzers, und `Share.jsx` würde sonst seine Fehleranzeige verlieren. `ScriptRenderer` behält seine eigene Karte (keine Automatik, keine Änderung außer dem Import).
7. **Countdown-Takt kommt aus `ViewContainer`** (Prop `now`), nicht aus der Karte — so verlangt es `docs/design/guides/ui-servers.md` („nicht aus einem eigenen Timer der Karte“), und `react-hooks/purity` verbietet `Date.now()` im Render.
8. **Identität fehlt beim Reconnect → `404`** statt der `400` aus `createSession` (Spec: „Fehlend → 403 bzw. 404“; `400` würde der Client als wiederholbar werten).
9. **Veraltete Verbindungsaufbauten werden verworfen.** Endet eine Generation, während ihr `openEngineSession` noch läuft, schließt `ConnectionService` den späten Daten-Socket und die Engine-Sitzung, statt sie verwaist liegen zu lassen (`setConnection` liefert `false`).
10. **`"Session terminated"` gilt als endgültig.** `closeAllWebSockets` schließt mit Code 1000 *und* Grund (`server/lib/SessionManager.js:312-325`); `Guacamole.WebSocketTunnel` wertet jeden Grund als Fehlerstatus (`vendor/.../Tunnel.js:997-1006`). Ohne die Regel würde ein bewusst beendetes RDP automatisch neu verbunden.
11. Ein Reconnect, der genau während des Audit-Schreibens per DELETE/Abmelden verworfen wird, kann einen `entry.reconnect`-Eintrag ohne Sitzung hinterlassen (Fenster = ein DB-Write).
12. Absagen des Endpunkts (`403`/`404`/`410`) zeigen die Karte ohne „Neu verbinden“ (`reconnectable: false`): ein erneuter Versuch kann ohne Änderung der Rechte nicht gelingen; Wiederaufnahme über erneutes Öffnen.

---

## Dateistruktur und Parallelgruppen

| Task | Phase | Dateien (Create/Modify) | Parallel zu |
|---|---|---|---|
| 1 Engine telnet/websocket | A | `engine/src/net/telnet.c`, `engine/src/net/websocket.c` | 2, 5 |
| 2 SessionManager-Kern | A | `server/lib/SessionManager.js`, `server/lib/ConnectionService.js` (nur Export), `server/lib/__tests__/sessionTombstone.test.js` | 1, 5 |
| 5 Client-Logik | A | `client/src/common/utils/ConnectionErrorUtil.js`, `client/src/common/utils/ReconnectPolicy.js`, `client/src/common/hooks/useAutoReconnect.js`, `client/src/common/utils/ConnectionUtil.js`, `.../ConnectionError/ConnectionError.jsx`, `.../ConnectionError/index.js`, Importzeilen in `XtermRenderer.jsx`, `GuacamoleRenderer.jsx`, `ScriptRenderer/ScriptRenderer.jsx`, `client/src/pages/Servers/utils/sessionErrors.js` (neu), `client/src/pages/Servers/utils/__tests__/sessionErrors.test.jsx` (neu), Tests | 1, 2 |
| 3 Server-Engine-Naht | B | `server/lib/ConnectionService.js`, `server/lib/GuacdClient.js`, `server/lib/engineEvents.js` (neu), `server/index.js`, `server/hooks/guacamole.js`, `server/lib/__tests__/engineSessionLifecycle.test.js` (neu), `server/lib/__tests__/rdpDisplayDpi.test.js` | 4, 6 |
| 6 Client-Oberfläche | B | `.../ConnectionError/ConnectionError.jsx`, `.../ConnectionError/styles.sass`, `.../ConnectionError/__tests__/ConnectionError.test.jsx` (neu), `.../ServerTabs/ServerTabs.jsx`, `.../ServerTabs/styles.sass`, `client/public/assets/locales/en.json`, `client/public/assets/locales/de_DE.json`, `client/src/common/contexts/PreferencesContext.jsx`, `client/src/pages/Settings/pages/Terminal/Terminal.jsx` | 3, 4 |
| 4 Server-Endpunkt | B | `server/controllers/serverSession.js`, `server/routes/serverSession.js`, `server/validations/serverSession.js`, `server/validations/preferences.js`, `server/controllers/audit.js`, `server/lib/__tests__/reconnectSession.test.js` (neu), `server/lib/__tests__/validations.test.js` | 3, 6 |
| 7a Renderer/Popout/Share | C | `.../renderer/XtermRenderer.jsx`, `.../renderer/GuacamoleRenderer.jsx`, `client/src/pages/Popout/Popout.jsx`, `client/src/pages/Popout/styles.sass`, `client/src/pages/Share/Share.jsx` | 7b |
| 7b Servers/ViewContainer | C | `client/src/pages/Servers/Servers.jsx`, `.../ViewContainer/ViewContainer.jsx` | 7a |
| 8 Abschluss | D | keine Code-Dateien | none |

Abkürzungen: `.../ConnectionError` = `client/src/pages/Servers/components/ViewContainer/renderer/components/ConnectionError`, `.../ServerTabs` = `client/src/pages/Servers/components/ViewContainer/components/ServerTabs`, `.../ViewContainer` = `client/src/pages/Servers/components/ViewContainer`, `.../renderer` = `client/src/pages/Servers/components/ViewContainer/renderer`.

Abhängigkeiten zwischen Phasen: Task 3 braucht Task 2 (Generation, Karenz, `engineSessionId`). Task 6 ändert `ConnectionError.jsx` nach Task 5 und importiert `ReconnectPolicy.js`. Task 4 braucht nur Task 2 (einschließlich des Exports `getEntryProtocol`) und läuft deshalb in Phase B neben Task 3 und 6. Task 7a/7b brauchen Task 5 und 6; untereinander nur die hier festgelegten Verträge (Props); die HTTP-Antworten von Task 4 sind dann bereits gemergt.

**Ausführung:** Jede parallele Task läuft in einem eigenen Worktree (superpowers:using-git-worktrees), abgezweigt vom Stand nach der vorigen Phase; am Phasenende werden die Worktree-Branches in `feature/reconnect` gemergt (dateidisjunkt, Reihenfolge egal). Danach volle Suite, Review-Kette einmal, kurzer Zwischenstand.

---

## Phase A — Kern (parallel: Task 1, Task 2, Task 5)

### Task 1: Engine — „connection lost“ bei telnet und pve-lxc, `session_closed` vor dem Schließen des Daten-Sockets

**Files:**
- Modify: `engine/src/net/telnet.c:147-181` (`telnet_bridge_poll`), `:183-236` (`telnet_session_thread`)
- Modify: `engine/src/net/websocket.c:107-124` (`ws_conn_t`, `ws_read`), `:340` (Initialisierung), `:402-471` (Schleife und Abbau)

**Interfaces:**
- Consumes: `outpost_cp_send_session_closed(cp, sid, reason)` (unverändert), Vorbild `ssh_bridge_poll` in `engine/src/net/ssh.c:127-172` (enum 127-132, `ssh_bridge_poll` ab 134) und Reihenfolge in `ssh.c:275-291`.
- Produces: Control-Plane-Meldung `SessionClosed` mit Grund `"connection lost"` bei Transportabbrüchen; sonst `"session ended"` (telnet) bzw. `"websocket session ended"` (pve-lxc/pve-shell). Der Server bildet `"connection lost"` auf 4017 ab (Task 3, `engineEvents.handleSessionClosed`).

**Design:** kein UI-Anteil.

**Tests:** keine automatisierten — die Engine hat keine Testumgebung im Repo, und ein Harness nur für diese zwei Pfade wäre teurer als der Nutzen. Absicherung: `gcc -fsyntax-only -Wall -Wextra` lokal (funktioniert, Header sind vorhanden), Review-Schritt gegen die Spec-Regeln, CI-Build des Engine-Images, manuelle Prüfung auf outpost-test (Task 8).

**Parallel:** Task 2, Task 5 (keine gemeinsamen Dateien).

- [ ] **Step 1: Syntaxprüfung vor der Änderung als Referenz**

Run: `cd /root/outpost/engine && gcc -fsyntax-only -std=gnu11 -Wall -Wextra -Isrc/core -Isrc/net -Isrc/proto -Isrc src/net/telnet.c src/net/websocket.c; echo rc=$?`
Expected: `rc=0`, keine Warnungen.

- [ ] **Step 2: `telnet_bridge_poll` dreiwertig machen**

In `engine/src/net/telnet.c` die Funktion `telnet_bridge_poll` (Z. 147-181) ersetzen durch:

```c
typedef enum {
    TELNET_CONTINUE = 0,
    TELNET_END_NORMAL,
    TELNET_END_LOST,
} telnet_end_reason_t;

static telnet_end_reason_t telnet_bridge_poll(outpost_session_t* session, int data_fd, int telnet_fd) {
    uint8_t buf[TELNET_BUF_SIZE];
    struct pollfd fds[2] = {
        { .fd = data_fd,   .events = POLLIN },
        { .fd = telnet_fd, .events = POLLIN },
    };

    telnet_apply_pending_resize(session, telnet_fd);

    int ret = poll(fds, 2, 200);
    if (ret < 0)
        return errno == EINTR ? TELNET_CONTINUE : TELNET_END_LOST;
    if (ret == 0)
        return TELNET_CONTINUE;

    if (fds[0].revents & POLLIN) {
        ssize_t n = read(data_fd, buf, sizeof(buf));
        if (n <= 0) return TELNET_END_NORMAL;
        if (outpost_write_exact(telnet_fd, buf, (size_t)n) != 0) return TELNET_END_LOST;
    }

    if (fds[1].revents & POLLIN) {
        ssize_t n = read(telnet_fd, buf, sizeof(buf));
        if (n < 0)
            return (errno == EINTR || errno == EAGAIN) ? TELNET_CONTINUE : TELNET_END_LOST;
        if (n == 0) return TELNET_END_NORMAL;
        if (telnet_process_and_forward(telnet_fd, data_fd, buf, (size_t)n) != 0)
            return TELNET_END_NORMAL;
    }

    if (fds[0].revents & (POLLERR | POLLHUP))
        return TELNET_END_NORMAL;
    if (fds[1].revents & POLLERR)
        return TELNET_END_LOST;
    if (fds[1].revents & POLLHUP)
        return TELNET_END_NORMAL;

    return TELNET_CONTINUE;
}
```

`telnet_process_and_forward` schreibt nur auf `data_fd` mit Rückgabewert (Aushandlungsantworten an `telnet_fd` ignorieren ihren Fehler schon heute) — ein Fehler dort ist ein Ende auf `data_fd`-Seite und damit normal.

- [ ] **Step 3: Thread übernimmt den Grund und meldet vor `close(data_fd)`**

In `telnet_session_thread` (Z. 183-236):

1. Nach `int telnet_fd = -1;` (Z. 188) einfügen — vor jedem `goto cleanup`, damit der Wert nie übersprungen wird:

```c
    telnet_end_reason_t end_reason = TELNET_END_NORMAL;
```

2. Die Schleife Z. 216-219 ersetzen durch:

```c
    while (session->state == SESSION_STATE_ACTIVE) {
        telnet_end_reason_t r = telnet_bridge_poll(session, data_fd, telnet_fd);
        if (r != TELNET_CONTINUE) { end_reason = r; break; }
    }

    LOG_INFO("Telnet session %s ending (reason=%s)", session->session_id,
        end_reason == TELNET_END_LOST ? "lost" : "normal");
```

3. Den Abbau Z. 221-232 ersetzen durch:

```c
cleanup:
    session->telnet_sock = -1;

    if (telnet_fd >= 0)
        close(telnet_fd);

    char sid[MAX_SESSION_ID_LEN];
    snprintf(sid, sizeof(sid), "%s", session->session_id);
    outpost_cp_send_session_closed(cp, sid,
        end_reason == TELNET_END_LOST ? "connection lost" : "session ended");

    if (data_fd >= 0)
        close(data_fd);

    outpost_sm_finish(&g_session_manager, sid);
```

- [ ] **Step 4: `websocket.c` — Transportfehler merken**

`ws_conn_t` (Z. 107-111) um ein Feld erweitern:

```c
typedef struct {
    SSL* ssl;
    int fd;
    bool tls;
    bool transport_error;
} ws_conn_t;
```

`ws_read` (Z. 117-124) ersetzen durch:

```c
static int ws_read(ws_conn_t* c, void* buf, size_t len) {
    if (c->tls) {
        int n = SSL_read(c->ssl, buf, (int)len);
        if (n <= 0) {
            int err = SSL_get_error(c->ssl, n);
            if (err == SSL_ERROR_SYSCALL || err == SSL_ERROR_SSL) c->transport_error = true;
        }
        return n;
    }
    ssize_t n = read(c->fd, buf, len);
    if (n < 0) c->transport_error = true;
    return (int)n;
}
```

`SSL_ERROR_ZERO_RETURN` (sauberes `close_notify`) und `read == 0` (EOF) setzen das Feld nicht und bleiben damit „websocket session ended“. `ws_read_frame` bleibt unverändert; der Aufrufer liest `conn.transport_error`.

Initialisierung Z. 340 ersetzen durch:

```c
    ws_conn_t conn = { .ssl = NULL, .fd = sock, .tls = use_tls, .transport_error = false };
```

- [ ] **Step 5: `websocket.c` — Schleife und Abbau**

Den Block Z. 402-471 (ab `uint8_t buf[WS_BUF_SIZE];` bis vor `free(args);`) ersetzen durch:

```c
    uint8_t buf[WS_BUF_SIZE];
    bool running = true;
    bool lost = false;

    int ws_fd = sock;
    int ssl_pending;

    while (running && session->state == SESSION_STATE_ACTIVE) {
        struct pollfd fds[2];
        fds[0].fd = data_fd;
        fds[0].events = POLLIN;
        fds[1].fd = ws_fd;
        fds[1].events = POLLIN;

        ssl_pending = conn.tls ? SSL_pending(conn.ssl) : 0;
        int timeout = ssl_pending > 0 ? 0 : 200;

        int ret = poll(fds, 2, timeout);
        if (ret < 0) {
            if (errno == EINTR) continue;
            break;
        }

        if (fds[0].revents & POLLIN) {
            ssize_t n = read(data_fd, buf, sizeof(buf));
            if (n <= 0) break;
            if (ws_send_frame(&conn, 0x01, buf, (size_t)n, true) != 0) { lost = true; break; }
        }
        if (fds[0].revents & (POLLERR | POLLHUP | POLLNVAL)) break;

        if ((fds[1].revents & POLLIN) || ssl_pending > 0) {
            ws_frame_t frame;
            if (ws_read_frame(&conn, &frame) != 0) { lost = conn.transport_error; break; }

            if (frame.opcode == 0x08) {
                ws_send_frame(&conn, 0x08, NULL, 0, true);
                free(frame.payload);
                break;
            } else if (frame.opcode == 0x09) {
                ws_send_frame(&conn, 0x0A, frame.payload, frame.payload_len, true);
            } else if (frame.opcode == 0x01 || frame.opcode == 0x02 || frame.opcode == 0x00) {
                if (frame.payload && frame.payload_len > 0) {
                    if (outpost_write_exact(data_fd, frame.payload, frame.payload_len) != 0) {
                        free(frame.payload);
                        break;
                    }
                }
            }
            free(frame.payload);
        }
        if (fds[1].revents & POLLERR) { lost = true; break; }
        if (fds[1].revents & (POLLHUP | POLLNVAL)) break;
    }

    LOG_INFO("WebSocket session %s ending (reason=%s)", session->session_id, lost ? "lost" : "normal");

    ws_send_frame(&conn, 0x08, NULL, 0, true);

    if (conn.tls) {
        SSL_shutdown(conn.ssl);
        SSL_free(conn.ssl);
        SSL_CTX_free(ssl_ctx);
    }
    close(sock);

    char sid[MAX_SESSION_ID_LEN];
    snprintf(sid, sizeof(sid), "%s", session->session_id);
    outpost_cp_send_session_closed(cp, sid, lost ? "connection lost" : "websocket session ended");

    close(data_fd);
    session->data_fd = -1;
    outpost_sm_finish(&g_session_manager, sid);
```

- [ ] **Step 6: Syntaxprüfung**

Run: `cd /root/outpost/engine && gcc -fsyntax-only -std=gnu11 -Wall -Wextra -Isrc/core -Isrc/net -Isrc/proto -Isrc src/net/telnet.c src/net/websocket.c; echo rc=$?`
Expected: `rc=0`, keine Warnungen (insbesondere keine „may be used uninitialized“ für `end_reason`).

- [ ] **Step 7: Review gegen die Spec-Regeln**

`git diff engine/` lesen und jede Zeile gegen die Spec abhaken:
- telnet „connection lost“: `read(telnet_fd) < 0` außer `EINTR`/`EAGAIN`; Schreibfehler auf `telnet_fd`; `POLLERR` auf `telnet_fd`; `poll < 0` außer `EINTR`.
- telnet „session ended“: `read(telnet_fd) == 0`; jedes Ende auf `data_fd`-Seite (Lesen, Schreiben in `telnet_process_and_forward`, `POLLHUP`/`POLLERR`); Austritt über `session->state`; jeder `goto cleanup` vor der Schleife.
- websocket „connection lost“: `read < 0`, `SSL_ERROR_SYSCALL`/`SSL_ERROR_SSL`, Schreibfehler zu Proxmox (`ws_send_frame` mit Daten), `POLLERR` auf dem WS-Socket. Close-Frame, EOF/`close_notify`, `data_fd`-Enden und `poll < 0` bleiben „websocket session ended“.
- Beide: `outpost_cp_send_session_closed` steht vor `close(data_fd)`.
Abweichung gefunden → zurück zu Step 2/4/5.

- [ ] **Step 8: Commit**

```bash
git add engine/src/net/telnet.c engine/src/net/websocket.c
git commit -m "Engine: telnet und pve-lxc melden Verbindungsabbrüche als connection lost"
```

---

### Task 2: SessionManager — Generationen, Engine-ID, Tombstones, Karenz, Generationswächter

**Files:**
- Modify: `server/lib/SessionManager.js` (`create` Z. 16-36, `setConnection` Z. 72-81, `onMasterConnectionClosed` Z. 113-123, `markFailed` Z. 330-335, `cleanupConnection` Z. 372-394, `remove` Z. 396-458, `removeAllByAccountId`/`removeAllByEntryId` Z. 533-549, neue Funktionen)
- Modify: `server/lib/ConnectionService.js` Exporte (nur `getEntryProtocol` in `module.exports` aufnehmen; Funktion besteht seit Z. 117)
- Create: `server/lib/__tests__/sessionTombstone.test.js`

**Interfaces:**
- Consumes: nichts aus anderen Tasks.
- Produces (von Task 3, 4 genutzt):
  - `create(accountId, entryId, configuration, connectionReason = null, tabId = null, browserId = null, auditLogId = null, organizationId = null, { sessionId = uuidv4(), generation = 1 } = {}) → session`; wirft `Error("Session id is still in use")`, wenn `sessionId` belegt ist. `session.generation: number`, `session.engineSessionId: string`, `session._closeGrace: { timer, promise, resolve } | null`, `session._removal: Promise<boolean>` (ab `remove`).
  - `resolveEngineSession(engineSessionId: string) → { sessionId: string, generation: number } | null` — nur `<uuid>` und `<uuid>:<n>`.
  - `setConnection(sessionId, connection, generation?) → boolean`
  - `markFailed(sessionId, reason, generation?) → void`
  - `onMasterConnectionClosed(sessionId, reason = "closed", { guacStatus = null, generation } = {}) → void`
  - `beginCloseGrace(sessionId, generation?) → void`; `CLOSE_GRACE_MS = 1000`
  - `remove(sessionId, { code?, reason?, guacStatus?, generation? } = {}) → Promise<boolean>` — `generation` angegeben und ungleich → `false`, ohne etwas zu ändern.
  - `whenEnded(sessionId) → Promise<void>` — wartet Karenz und Abbau ab; kehrt sofort zurück, wenn die Sitzung lebt und nicht endet.
  - `getTombstone(sessionId) → Tombstone | null` (abgelaufene gelten als nicht vorhanden), `dropTombstone(sessionId) → boolean`; `TOMBSTONE_TTL_MS = 15 * 60 * 1000`
  - `Tombstone = { accountId, organizationId, entryId, directTarget, configuration, connectionReason, tabId, browserId, generation, reason, expiresAt }`
  - `removeAllByAccountId(accountId)`, `removeAllByEntryId(entryId)` verwerfen zusätzlich die passenden Tombstones.
  - `ConnectionService.getEntryProtocol(entry) → string|undefined` (bestehend, nur exportiert; von Task 4 genutzt)

**Design:** kein UI-Anteil.

**Tests:** 4 Tests in `sessionTombstone.test.js`, test-first (Kernlogik mit festem Vertrag): (1) Tombstone-Regeln tabellarisch inkl. gespeicherter Felder, (2) Ablauf nach 15 min, (3) Abmelden/Eintrag löschen verwirft Tombstones (SEC-SESS-02), (4) Generationswächter und Engine-ID. Die Guacamole-Status-Ausnahmen und die Karenz werden über die Naht in Task 3 getestet, nicht hier.

**Parallel:** Task 1, Task 5 (keine gemeinsamen Dateien).

- [ ] **Step 1: Failing tests schreiben**

`server/lib/__tests__/sessionTombstone.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const SessionManager = require("../SessionManager");

const retire = async (configuration, options = { code: 4017, reason: "Connection lost" }, { accountId = 1, entryId = 2 } = {}) => {
    const session = SessionManager.create(accountId, entryId, configuration, "maintenance", "tab-1", "browser-1", 11, null);
    await SessionManager.remove(session.sessionId, options);
    return session.sessionId;
};

test("ein Fehlerende eines unterstützten Protokolls hinterlässt einen Tombstone, alles andere nicht", async () => {
    const directIdentity = { type: "password", username: "u", password: "p" };
    const id = await retire({ protocol: "ssh", type: null, scriptId: null, directIdentity, tmuxSession: "claude" });
    const tombstone = SessionManager.getTombstone(id);
    assert.deepStrictEqual(
        {
            accountId: tombstone.accountId, entryId: tombstone.entryId, generation: tombstone.generation,
            reason: tombstone.reason, connectionReason: tombstone.connectionReason,
            tabId: tombstone.tabId, browserId: tombstone.browserId,
        },
        {
            accountId: 1, entryId: 2, generation: 1, reason: "Connection lost", connectionReason: "maintenance",
            tabId: "tab-1", browserId: "browser-1",
        },
    );
    assert.deepStrictEqual(tombstone.configuration.directIdentity, directIdentity);
    assert.strictEqual(tombstone.configuration.tmuxSession, "claude");

    for (const protocol of ["telnet", "pve-lxc", "rdp", "vnc"]) {
        assert.ok(SessionManager.getTombstone(await retire({ protocol })), `${protocol} should be retired`);
    }

    const refused = [
        [{ protocol: "ssh" }, {}],
        [{ protocol: "ssh" }, { code: 1000 }],
        [{ protocol: "pve-shell" }, { code: 4017 }],
        [{ protocol: "pve-qemu" }, { code: 4017 }],
        [{ protocol: "ssh", type: "sftp" }, { code: 4017 }],
        [{ protocol: "ssh", scriptId: 5 }, { code: 4017 }],
    ];
    for (const [configuration, options] of refused) {
        assert.strictEqual(SessionManager.getTombstone(await retire(configuration, options)), null,
            JSON.stringify([configuration, options]));
    }
});

test("ein Tombstone läuft nach 15 Minuten ab", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const id = await retire({ protocol: "ssh" });
    t.mock.timers.tick(SessionManager.TOMBSTONE_TTL_MS - 1);
    assert.ok(SessionManager.getTombstone(id));
    t.mock.timers.tick(1);
    assert.strictEqual(SessionManager.getTombstone(id), null);
});

test("Abmelden und Löschen eines Eintrags verwerfen auch die Tombstones", async () => {
    const own = await retire({ protocol: "ssh" }, undefined, { accountId: 41, entryId: 7 });
    const other = await retire({ protocol: "ssh" }, undefined, { accountId: 42, entryId: 7 });
    const otherEntry = await retire({ protocol: "ssh" }, undefined, { accountId: 42, entryId: 8 });

    await SessionManager.removeAllByAccountId(41);
    assert.strictEqual(SessionManager.getTombstone(own), null);
    assert.ok(SessionManager.getTombstone(other));

    await SessionManager.removeAllByEntryId(7);
    assert.strictEqual(SessionManager.getTombstone(other), null);
    assert.ok(SessionManager.getTombstone(otherEntry));
});

test("Engine-ID-Format, belegte ID und Wächter für setConnection/markFailed/remove", async () => {
    const configuration = { protocol: "ssh" };
    const first = SessionManager.create(1, 2, configuration);
    const { sessionId } = first;
    assert.strictEqual(first.generation, 1);
    assert.strictEqual(first.engineSessionId, sessionId);
    assert.throws(() => SessionManager.create(1, 2, configuration, null, null, null, null, null, { sessionId, generation: 2 }),
        /still in use/);

    await SessionManager.remove(sessionId, { code: 4017, reason: "Connection lost" });
    const second = SessionManager.create(1, 2, configuration, null, null, null, null, null, { sessionId, generation: 2 });
    assert.strictEqual(second.engineSessionId, `${sessionId}:2`);
    assert.deepStrictEqual(SessionManager.resolveEngineSession(second.engineSessionId), { sessionId, generation: 2 });
    assert.deepStrictEqual(SessionManager.resolveEngineSession(sessionId), { sessionId, generation: 1 });
    assert.strictEqual(SessionManager.resolveEngineSession(`${sessionId}-xfer-1`), null);
    assert.strictEqual(SessionManager.resolveEngineSession(`${sessionId}:2;rm -rf /`), null);

    assert.strictEqual(await SessionManager.remove(sessionId, { generation: 1 }), false);
    assert.strictEqual(SessionManager.setConnection(sessionId, { type: "ssh" }, 1), false);
    SessionManager.markFailed(sessionId, "stale", 1);

    assert.strictEqual(SessionManager.get(sessionId), second);
    assert.strictEqual(second.masterConnection, null);
    assert.strictEqual(SessionManager.consumeFailedReason(sessionId), null);
    await SessionManager.remove(sessionId);
});
```

- [ ] **Step 2: Tests laufen lassen, Fehlschlag prüfen**

Run: `cd /root/outpost && node --test server/lib/__tests__/sessionTombstone.test.js`
Expected: FAIL — `SessionManager.getTombstone is not a function` bzw. `first.generation` ist `undefined`.

- [ ] **Step 3: Konstanten, Map und Hilfsfunktionen**

In `server/lib/SessionManager.js` nach Z. 14 (`const PRESENCE_THROTTLE_MS = 250;`) einfügen:

```js
const CLOSE_GRACE_MS = 1000;
const TOMBSTONE_TTL_MS = 15 * 60 * 1000;
const RETIRABLE_PROTOCOLS = new Set(["ssh", "telnet", "pve-lxc", "rdp", "vnc"]);
// guacd ended it on purpose: session conflict, session timeout, logoff (0x0209-0x020B), or a 0x03xx client error.
const FINAL_GUAC_STATUSES = new Set([0x0209, 0x020A, 0x020B]);
const ENGINE_SESSION_ID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?::([1-9][0-9]{0,8}))?$/;
const retired = new Map();

const engineSessionIdFor = (sessionId, generation) => (generation === 1 ? sessionId : `${sessionId}:${generation}`);

const isCurrentGeneration = (session, generation, action) => {
    if (generation === undefined || session.generation === generation) return true;
    logger.info(`Ignoring ${action} for an older generation`, { sessionId: session.sessionId, generation, current: session.generation });
    return false;
};

module.exports.CLOSE_GRACE_MS = CLOSE_GRACE_MS;
module.exports.TOMBSTONE_TTL_MS = TOMBSTONE_TTL_MS;

module.exports.resolveEngineSession = (engineSessionId) => {
    const match = ENGINE_SESSION_ID.exec(String(engineSessionId ?? ""));
    if (!match) return null;
    return { sessionId: match[1], generation: match[2] ? Number(match[2]) : 1 };
};
```

- [ ] **Step 4: `create` mit ID und Generation**

`module.exports.create` (Z. 16-36) ersetzen durch:

```js
module.exports.create = (accountId, entryId, configuration, connectionReason = null, tabId = null, browserId = null, auditLogId = null, organizationId = null, { sessionId = uuidv4(), generation = 1 } = {}) => {
    if (sessions.has(sessionId)) throw new Error("Session id is still in use");
    const session = {
        sessionId, generation, engineSessionId: engineSessionIdFor(sessionId, generation),
        accountId, entryId, configuration, connectionReason,
        tabId, browserId, auditLogId, organizationId,
        isHibernated: false,
        createdAt: new Date(),
        lastActivity: new Date(),
        masterConnection: null,
        logBuffer: "",
        activeWs: null,
        connectedWs: new Set(),
        sharedWs: new Set(),
        participants: new Map(),
        shareId: null,
        shareWritable: false,
        _closeGrace: null,
    };
    sessions.set(sessionId, session);
    logger.info(`Session created`, { sessionId, generation, accountId, entryId, organizationId });
    return session;
};
```

- [ ] **Step 5: Generationswächter für `setConnection`, `markFailed`, `onMasterConnectionClosed`**

`setConnection` (Z. 72-81) ersetzen durch:

```js
module.exports.setConnection = (sessionId, connection, generation) => {
    const session = module.exports.get(sessionId);
    if (!session || !isCurrentGeneration(session, generation, "setConnection")) return false;
    if (session.masterConnection) {
        logger.warn(`Session already has master connection`, { sessionId });
        return false;
    }
    session.masterConnection = connection;
    return true;
};
```

`onMasterConnectionClosed` (Z. 113-123) ersetzen durch:

```js
module.exports.onMasterConnectionClosed = (sessionId, reason = "closed", { guacStatus = null, generation } = {}) => {
    const session = module.exports.get(sessionId);
    if (!session) return;
    logger.info(`Master connection ${reason}, terminating session`, { sessionId });
    if (reason.startsWith("error:")) {
        module.exports.markFailed(sessionId, reason, generation);
        module.exports.remove(sessionId, { code: 4017, reason, guacStatus, generation });
    } else {
        module.exports.remove(sessionId, { generation });
    }
};
```

`markFailed` (Z. 330-335) ersetzen durch:

```js
module.exports.markFailed = (sessionId, reason, generation) => {
    const session = sessions.get(sessionId);
    if (session && !isCurrentGeneration(session, generation, "markFailed")) return;
    const existing = failedSessions.get(sessionId);
    if (existing) clearTimeout(existing.timeout);
    const timeout = setTimeout(() => failedSessions.delete(sessionId), FAILED_SESSION_TTL_MS);
    failedSessions.set(sessionId, { reason: reason || "Connection failed", timeout });
};
```

- [ ] **Step 6: Karenz, Ende-Abwarten, Tombstone-Zugriff**

Direkt vor `const closeCrossTransferClients` (Z. 365) einfügen:

```js
const clearCloseGrace = (session) => {
    if (!session._closeGrace) return;
    clearTimeout(session._closeGrace.timer);
    session._closeGrace.resolve();
    session._closeGrace = null;
};

module.exports.beginCloseGrace = (sessionId, generation) => {
    const session = sessions.get(sessionId);
    if (!session || session._removing || session._closeGrace) return;
    if (!isCurrentGeneration(session, generation, "beginCloseGrace")) return;
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    const timer = setTimeout(() => {
        module.exports.remove(sessionId, { generation: session.generation })
            .catch((error) => logger.error("Removing session after close grace failed", { sessionId, error: error.message }));
    }, CLOSE_GRACE_MS);
    session._closeGrace = { timer, promise, resolve };
};

module.exports.whenEnded = async (sessionId) => {
    for (let session = sessions.get(sessionId); session; session = sessions.get(sessionId)) {
        if (session._removal) await session._removal.catch(() => {});
        else if (session._closeGrace) await session._closeGrace.promise;
        else return;
    }
};

const retire = (session, { code, reason, guacStatus }) => {
    const { protocol, type, scriptId } = session.configuration || {};
    if (code !== 4017 || !RETIRABLE_PROTOCOLS.has(protocol) || type === "sftp" || scriptId != null) return;
    if (FINAL_GUAC_STATUSES.has(guacStatus) || (guacStatus >= 0x0300 && guacStatus <= 0x03FF)) return;
    retired.set(session.sessionId, {
        accountId: session.accountId,
        organizationId: session.organizationId,
        entryId: session.entryId ?? null,
        directTarget: session.configuration.directTarget ?? null,
        configuration: session.configuration,
        connectionReason: session.connectionReason,
        tabId: session.tabId,
        browserId: session.browserId,
        generation: session.generation,
        reason,
        expiresAt: Date.now() + TOMBSTONE_TTL_MS,
    });
    logger.info("Session retired", { sessionId: session.sessionId, generation: session.generation });
};

module.exports.getTombstone = (sessionId) => {
    const tombstone = retired.get(sessionId);
    if (!tombstone) return null;
    if (tombstone.expiresAt <= Date.now()) {
        retired.delete(sessionId);
        return null;
    }
    return tombstone;
};

module.exports.dropTombstone = (sessionId) => retired.delete(sessionId);
```

Der Tombstone enthält `configuration.directIdentity` (Passwort/Schlüssel). Er darf nie geloggt werden; die Log-Zeile oben nennt nur ID und Generation (SEC-SECRET-01).

- [ ] **Step 7: `cleanupConnection` schließt die Engine-Sitzung der eigenen Generation**

Z. 372 und Z. 374 ändern:

```js
const cleanupConnection = async (conn, engineSessionId) => {
    if (CONTROL_PLANE_TYPES.has(conn.type)) {
        try { require("./controlPlane/ControlPlaneServer").closeSession(engineSessionId); } catch {}
    }
```

(Rest der Funktion unverändert.)

- [ ] **Step 8: `remove` aufteilen in Wächter und `teardown`**

Den Kopf von `remove` (Z. 396-399):

```js
module.exports.remove = async (sessionId, options = {}) => {
    const session = module.exports.get(sessionId);
    if (!session || session._removing) return false;
    session._removing = true;
```

ersetzen durch:

```js
module.exports.remove = (sessionId, options = {}) => {
    const session = module.exports.get(sessionId);
    if (!session || !isCurrentGeneration(session, options.generation, "remove")) return Promise.resolve(false);
    clearCloseGrace(session);
    if (session._removing) return Promise.resolve(false);
    session._removing = true;
    session._removal = teardown(session, options);
    return session._removal;
};

const teardown = async (session, options) => {
    const { sessionId } = session;
```

Der restliche Körper (ab dem Kommentar Z. 401) bleibt der von `teardown`; darin drei Änderungen:

Z. 415:
```js
    const { code = 1000, reason = "Session terminated", guacStatus = null } = options;
```

Z. 439:
```js
            await cleanupConnection(session.masterConnection, session.engineSessionId);
```

`finally` (Z. 449-451):
```js
    } finally {
        retire(session, { code, reason, guacStatus });
        sessions.delete(sessionId);
    }
```

- [ ] **Step 9: Tombstones beim Abmelden/Eintrag-Löschen verwerfen, Aufräumtimer**

`removeAllByAccountId` (Z. 533-539) ersetzen durch:

```js
module.exports.removeAllByAccountId = async (accountId) => {
    const numericId = Number(accountId);
    const dropTombstones = () => {
        for (const [id, tombstone] of retired) if (Number(tombstone.accountId) === numericId) retired.delete(id);
    };
    // Repeated until nothing is left: a 4017 teardown still running retires its session in its finally,
    // and a reconnect in flight can claim that tombstone while later sessions are still being torn down.
    let count = 0;
    for (;;) {
        dropTombstones();
        const toRemove = [...sessions.entries()].filter(([, s]) => s.accountId === numericId).map(([id]) => id);
        if (toRemove.length === 0) break;
        for (const id of toRemove) {
            await module.exports.remove(id);
            await module.exports.whenEnded(id);
        }
        count += toRemove.length;
    }
    logger.info(`Removed all sessions for account`, { accountId, count });
    return count;
};
```

`removeAllByEntryId` (Z. 541-549) ersetzen durch:

```js
module.exports.removeAllByEntryId = async (entryId) => {
    const numericId = Number(entryId);
    const dropTombstones = () => {
        for (const [id, tombstone] of retired) if (Number(tombstone.entryId) === numericId) retired.delete(id);
    };
    let count = 0;
    for (;;) {
        dropTombstones();
        const toRemove = [...sessions.entries()].filter(([, s]) => s.entryId === numericId).map(([id]) => id);
        if (toRemove.length === 0) break;
        for (const id of toRemove) {
            await module.exports.remove(id);
            await module.exports.whenEnded(id);
        }
        count += toRemove.length;
    }
    if (count > 0) {
        logger.info(`Removed all sessions for entry`, { entryId, count });
    }
    return count;
};
```

Am Dateiende, nach dem bestehenden `setInterval(...).unref();` (Z. 556-567), anfügen:

```js
setInterval(() => {
    const now = Date.now();
    for (const [sessionId, tombstone] of retired) if (tombstone.expiresAt <= now) retired.delete(sessionId);
}, 60 * 1000).unref();
```

- [ ] **Step 10: Tests laufen lassen**

Run: `cd /root/outpost && node --test server/lib/__tests__/sessionTombstone.test.js server/lib/__tests__/sessionCleanup.test.js server/lib/__tests__/telnetSessionCleanup.test.js server/lib/__tests__/transferCleanup.test.js server/lib/__tests__/crossTransferClient.test.js`
Expected: alle PASS (die vier neuen plus die bestehenden SessionManager-Tests, die `create`/`remove`/`setConnection` positionell ohne Generation aufrufen).

- [ ] **Step 11: `getEntryProtocol` exportieren**

In `module.exports` von `server/lib/ConnectionService.js` (Z. 771-789) nach `createConnectionForSession,` ergänzen (die Funktion besteht seit Z. 117, nur der Export fehlt):
```js
    getEntryProtocol,
```

- [ ] **Step 12: Commit**

```bash
git add server/lib/SessionManager.js server/lib/ConnectionService.js server/lib/__tests__/sessionTombstone.test.js
git commit -m "Reconnect: ruhende Sitzungen, Generationen und Karenz im SessionManager"
```

---

### Task 5: Client-Logik — Fehlerklassifizierung, Reconnect-Politik, `useAutoReconnect`

**Files:**
- Create: `client/src/common/utils/ConnectionErrorUtil.js`
- Create: `client/src/common/utils/ReconnectPolicy.js`
- Create: `client/src/common/hooks/useAutoReconnect.js`
- Modify: `client/src/common/utils/ConnectionUtil.js` (neuer Export `getDisplayDpi` am Dateiende)
- Modify: `client/src/pages/Servers/components/ViewContainer/renderer/components/ConnectionError/ConnectionError.jsx:7-45` (`mapConnectionError` entfernen)
- Modify: `client/src/pages/Servers/components/ViewContainer/renderer/components/ConnectionError/index.js`
- Modify (nur Importzeile): `client/src/pages/Servers/components/ViewContainer/renderer/XtermRenderer.jsx:21`, `.../renderer/GuacamoleRenderer.jsx:10`, `.../renderer/ScriptRenderer/ScriptRenderer.jsx:14`
- Move: `.../ConnectionError/__tests__/mapConnectionError.test.jsx` → `client/src/common/utils/__tests__/ConnectionErrorUtil.test.jsx`
- Create: `client/src/common/hooks/__tests__/useAutoReconnect.test.jsx`
- Create: `client/src/pages/Servers/utils/sessionErrors.js`
- Create: `client/src/pages/Servers/utils/__tests__/sessionErrors.test.jsx`

**Interfaces:**
- Consumes: nichts aus anderen Tasks.
- Produces:
  - `mapConnectionError(rawMessage: string|null, t) → string` (wie bisher, um `connectionLost`, `engineDisconnected`, `hostKey`, `sessionEnded` erweitert)
  - `classifyConnectionError({ message?, code?, statusCode?, httpStatus? } = {}, t) → { text: string, retryable: boolean, reconnectable: boolean }` — `code` = WebSocket-Close-Code, `statusCode` = Guacamole-Status, `httpStatus` = Antwort des Reconnect-Endpunkts. `reconnectable: false` bei Guacamole-Status `0x020B`, `0x0209`, `0x020A`, `0x03xx` und bei den RDP-Texten „Logged off.“, „Manually logged off.“, „Forcibly disconnected.“, „Disconnected by other connection.“, „Session time limit exceeded“; sonst `true`.
  - `sessionProtocol(session) → string|null`, `isReconnectEligible(session) → boolean`, `shouldAttemptAutoReconnect({ enabled, session, errorInfo, wasConnected }) → boolean` (`errorInfo.retryable !== false`)
  - `useAutoReconnect({ activeSessions, reconnectSession, getSessionErrorInfo, enabled, serverConnected }) → { reconnectStates: { [sessionId]: { attempt, maxAttempts, nextAttemptAt } }, markSessionConnected(id), handleSessionErrored(id), reconnectNow(id) → Promise<boolean|null> }`; erwartet `reconnectSession(id) → Promise<{ connected: boolean }>`.
  - `getDisplayDpi() → number` (96…480)
  - `requestReconnect(sessionId, t) → Promise<{ outcome: "reconnected"|"reattach"|"ended"|"refused"|"failed", generation?, error? }>` — liest `error.code` und `error.message` des Fehlerkörpers `{ code, message }` (Task 4).
  - `shouldRecordError(existing, incoming, currentGeneration) → boolean` und `isSuperseded(existing, serverGeneration) → boolean` aus `client/src/pages/Servers/utils/sessionErrors.js` (von Task 7a, 7b genutzt)
  - Neue i18n-Schlüssel, die erst Task 6 anlegt: `common.errors.connection.{connectionLost, engineDisconnected, hostKey, sessionEnded, accessRevoked, expired}` — die Tests hier nutzen `t = (key) => key` und brauchen sie nicht.

**Design:** kein UI-Anteil.

**Tests:** 5 neue Tests + 1 verschobener: `ConnectionErrorUtil.test.jsx` — der bestehende RDP-Mapping-Test (verschoben, Import angepasst) und 1 neuer Klassifizierungstest (Spec-Client-Test 1); `useAutoReconnect.test.jsx` — (a) Wartezeiten und Zähler-Reset mit Fake-Timern (Spec-Client-Test 2), (b) `visibilitychange` → sofortiger Versuch (Outpost-Abweichung von Nexterm), (c) Erstverbindung ohne Automatik, Knopf geht trotzdem (Review Focus 5); `sessionErrors.test.jsx` — verspätete Meldung einer älteren Generation wird verworfen, erste Meldung je Generation gewinnt, überholter Fehler wird erkannt (Review Focus 4; gilt für Servers und Popout). `ReconnectPolicy` wird über den Hook getestet, nicht separat. Test-first (Verhalten steht fest).

**Parallel:** Task 1, Task 2 (keine gemeinsamen Dateien).

- [ ] **Step 1: Bestehenden Test verschieben und um die Klassifizierung erweitern**

```bash
git mv client/src/pages/Servers/components/ViewContainer/renderer/components/ConnectionError/__tests__/mapConnectionError.test.jsx client/src/common/utils/__tests__/ConnectionErrorUtil.test.jsx
```

Inhalt von `client/src/common/utils/__tests__/ConnectionErrorUtil.test.jsx`:

```jsx
import { expect, test } from "vitest";
import { classifyConnectionError, mapConnectionError } from "../ConnectionErrorUtil.js";

const t = (key) => key;

test("RDP disconnect reasons from guacd map to their own messages", () => {
    expect(mapConnectionError("Disconnected by other connection.", t)).toBe("common.errors.connection.rdpSessionConflict");
    expect(mapConnectionError("Idle session time limit exceeded.", t)).toBe("common.errors.connection.rdpSessionTimeout");
    expect(mapConnectionError("Active session time limit exceeded.", t)).toBe("common.errors.connection.rdpSessionTimeout");
    expect(mapConnectionError("Logged off.", t)).toBe("common.errors.connection.rdpSessionClosed");
    expect(mapConnectionError("Manually disconnected.", t)).toBe("common.errors.connection.rdpSessionClosed");
    expect(mapConnectionError("Disconnected.", t)).toBe("common.errors.connection.rdpSessionClosed");
    expect(mapConnectionError("Server refused connection.", t)).toBe("common.errors.connection.refused");
});

test("Anmeldefehler, RDP-Abmeldung und Endpunkt-Absagen sind endgültig, Verbindungsabbrüche wiederholbar", () => {
    expect(classifyConnectionError({ message: "SSH authentication failed", code: 4017 }, t))
        .toMatchObject({ text: "common.errors.connection.authenticationFailed", retryable: false, reconnectable: true });
    expect(classifyConnectionError({ message: "Connection lost", code: 4017 }, t))
        .toMatchObject({ text: "common.errors.connection.connectionLost", retryable: true });
    expect(classifyConnectionError({ message: "Engine disconnected", code: 4017 }, t).retryable).toBe(true);
    expect(classifyConnectionError({ code: 1006 }, t))
        .toMatchObject({ text: "common.errors.connection.closedUnexpectedly", retryable: true });
    expect(classifyConnectionError({ message: "Server refused connection." }, t))
        .toMatchObject({ text: "common.errors.connection.refused", retryable: true });
    expect(classifyConnectionError({ message: "Aborted. See logs.", statusCode: "523" }, t))
        .toMatchObject({ text: "common.errors.connection.rdpSessionClosed", retryable: false, reconnectable: false });
    expect(classifyConnectionError({ message: "Logged off." }, t)).toMatchObject({ retryable: false, reconnectable: false });
    expect(classifyConnectionError({ message: "Session terminated" }, t).retryable).toBe(false);
    expect(classifyConnectionError({ httpStatus: 410 }, t))
        .toMatchObject({ text: "common.errors.connection.expired", retryable: false });
    expect(classifyConnectionError({ httpStatus: 403 }, t).retryable).toBe(false);
    expect(classifyConnectionError({ httpStatus: 404 }, t).retryable).toBe(false);
});
```

- [ ] **Step 2: Hook-Tests schreiben**

`client/src/common/hooks/__tests__/useAutoReconnect.test.jsx`:

```jsx
import { afterEach, expect, test, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useAutoReconnect } from "../useAutoReconnect.js";

const activeSessions = [{ id: "s1", server: { type: "server", protocol: "ssh" } }];

const setup = (reconnectSession) => {
    const errors = new Map();
    const hook = renderHook(() => useAutoReconnect({
        activeSessions,
        reconnectSession,
        getSessionErrorInfo: (id) => errors.get(id) || null,
        enabled: true,
        serverConnected: true,
    }));
    return { hook, errors };
};

afterEach(() => vi.useRealTimers());

test("wartet 5, 10, 30 s zwischen den Versuchen und setzt den Zähler erst nach 10 s Stabilität zurück", async () => {
    vi.useFakeTimers({ now: 0 });
    const reconnectSession = vi.fn().mockResolvedValue({ connected: false });
    const { hook, errors } = setup(reconnectSession);

    act(() => hook.result.current.markSessionConnected("s1"));
    errors.set("s1", { retryable: true });
    act(() => hook.result.current.handleSessionErrored("s1"));
    expect(hook.result.current.reconnectStates.s1).toEqual({ attempt: 1, maxAttempts: 5, nextAttemptAt: 5000 });

    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(reconnectSession).toHaveBeenCalledTimes(1);
    expect(hook.result.current.reconnectStates.s1).toEqual({ attempt: 2, maxAttempts: 5, nextAttemptAt: 15000 });

    await act(() => vi.advanceTimersByTimeAsync(10000));
    expect(reconnectSession).toHaveBeenCalledTimes(2);
    expect(hook.result.current.reconnectStates.s1).toEqual({ attempt: 3, maxAttempts: 5, nextAttemptAt: 45000 });

    act(() => hook.result.current.markSessionConnected("s1"));
    await act(() => vi.advanceTimersByTimeAsync(9000));
    act(() => hook.result.current.handleSessionErrored("s1"));
    expect(hook.result.current.reconnectStates.s1.attempt).toBe(3);

    act(() => hook.result.current.markSessionConnected("s1"));
    await act(() => vi.advanceTimersByTimeAsync(10000));
    act(() => hook.result.current.handleSessionErrored("s1"));
    expect(hook.result.current.reconnectStates.s1).toEqual({ attempt: 1, maxAttempts: 5, nextAttemptAt: Date.now() + 5000 });
});

test("wird der Tab wieder sichtbar, versucht er es sofort statt den Countdown abzuwarten", async () => {
    vi.useFakeTimers({ now: 0 });
    const reconnectSession = vi.fn().mockResolvedValue({ connected: true });
    const { hook, errors } = setup(reconnectSession);

    act(() => hook.result.current.markSessionConnected("s1"));
    errors.set("s1", { retryable: true });
    act(() => hook.result.current.handleSessionErrored("s1"));

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });

    expect(reconnectSession).toHaveBeenCalledWith("s1");
    expect(hook.result.current.reconnectStates.s1).toBeUndefined();
});

test("scheitert schon die Erstverbindung, plant die Automatik nichts, der Knopf geht trotzdem", async () => {
    vi.useFakeTimers({ now: 0 });
    const reconnectSession = vi.fn().mockResolvedValue({ connected: false });
    const { hook, errors } = setup(reconnectSession);

    errors.set("s1", { retryable: true });
    act(() => hook.result.current.handleSessionErrored("s1"));
    expect(hook.result.current.reconnectStates.s1).toBeUndefined();

    await act(() => vi.advanceTimersByTimeAsync(130000));
    expect(reconnectSession).not.toHaveBeenCalled();

    await act(() => hook.result.current.reconnectNow("s1"));
    expect(reconnectSession).toHaveBeenCalledTimes(1);
});
```

`client/src/pages/Servers/utils/__tests__/sessionErrors.test.jsx`:

```jsx
import { expect, test } from "vitest";
import { isSuperseded, shouldRecordError } from "../sessionErrors.js";

test("eine verspätete Meldung des alten Renderers markiert die neue Generation nicht als getrennt", () => {
    expect(shouldRecordError(undefined, { message: "Connection lost", generation: 1 }, 2)).toBe(false);
    expect(shouldRecordError(undefined, { message: "Connection lost", generation: 2 }, 2)).toBe(true);
    expect(shouldRecordError({ message: "first", generation: 2 }, { message: "second", generation: 2 }, 2)).toBe(false);
    expect(shouldRecordError({ message: "old", generation: 1 }, { message: "new", generation: 2 }, 2)).toBe(true);
    expect(isSuperseded({ message: "Connection lost", generation: 1 }, 2)).toBe(true);
});
```

- [ ] **Step 3: Tests laufen lassen, Fehlschlag prüfen**

Run: `cd /root/outpost/client && yarn vitest run src/common/utils/__tests__/ConnectionErrorUtil.test.jsx src/common/hooks/__tests__/useAutoReconnect.test.jsx src/pages/Servers/utils/__tests__/sessionErrors.test.jsx`
Expected: FAIL — Module `../ConnectionErrorUtil.js`, `../useAutoReconnect.js` und `../sessionErrors.js` nicht gefunden.

- [ ] **Step 4: `ConnectionErrorUtil.js` anlegen**

`client/src/common/utils/ConnectionErrorUtil.js`:

```js
const RDP_CLOSED_MESSAGES = ["disconnected.", "logged off.", "manually logged off.", "manually disconnected.", "forcibly disconnected."];

const STATUS_KEYS = new Map([
    [0x0209, "common.errors.connection.rdpSessionConflict"],
    [0x020A, "common.errors.connection.rdpSessionTimeout"],
    [0x020B, "common.errors.connection.rdpSessionClosed"],
]);

const FINAL_KEYS = new Set([
    "common.errors.connection.authenticationFailed",
    "common.errors.connection.permissionDenied",
    "common.errors.connection.hostKey",
    "common.errors.connection.rdpSessionConflict",
    "common.errors.connection.rdpSessionTimeout",
    "common.errors.connection.rdpSessionClosed",
    "common.errors.connection.sessionEnded",
]);

const errorKey = (msg) => {
    if (msg.includes("disconnected by other connection")) return "common.errors.connection.rdpSessionConflict";
    if (msg.includes("session time limit exceeded")) return "common.errors.connection.rdpSessionTimeout";
    if (RDP_CLOSED_MESSAGES.includes(msg)) return "common.errors.connection.rdpSessionClosed";
    if (msg === "session terminated") return "common.errors.connection.sessionEnded";
    if (msg === "connection lost") return "common.errors.connection.connectionLost";
    if (msg === "engine disconnected") return "common.errors.connection.engineDisconnected";
    if (msg.includes("host key")) return "common.errors.connection.hostKey";
    if (msg.includes("connection not available") || msg.includes("not available")) return "common.errors.connection.hostUnreachable";
    if (msg.includes("no route to host") || msg.includes("unreachable")) return "common.errors.connection.hostUnreachable";
    if (msg.includes("connection refused") || msg.includes("refused")) return "common.errors.connection.refused";
    if (msg.includes("timeout") || msg.includes("timed out")) return "common.errors.connection.timeout";
    if (msg.includes("authentication") || msg.includes("auth")) return "common.errors.connection.authenticationFailed";
    if (msg.includes("permission denied")) return "common.errors.connection.permissionDenied";
    if (msg.includes("aborted") || msg.includes("see logs")) return "common.errors.connection.hostUnreachable";
    return null;
};

const clean = (rawMessage) => String(rawMessage).replace(/^error:\s*/i, "").trim();

const toStatus = (value) => {
    if (value === null || value === undefined || value === "") return null;
    const status = Number(value);
    return Number.isFinite(status) ? status : null;
};

export const mapConnectionError = (rawMessage, t) => {
    if (!rawMessage) return t("common.errors.connection.failed");
    const cleaned = clean(rawMessage);
    const key = errorKey(cleaned.toLowerCase());
    if (key) return t(key);
    return cleaned.replace(/\(see logs\)/gi, "").trim() || t("common.errors.connection.failed");
};

const NON_RECONNECTABLE_MESSAGES = ["logged off.", "manually logged off.", "forcibly disconnected."];

const isReconnectable = ({ message = null, statusCode = null }) => {
    const status = toStatus(statusCode);
    if (status !== null && (STATUS_KEYS.has(status) || (status >= 0x0300 && status <= 0x03FF))) return false;
    if (!message) return true;
    const msg = clean(message).toLowerCase();
    return !(NON_RECONNECTABLE_MESSAGES.includes(msg)
        || msg.includes("disconnected by other connection")
        || msg.includes("session time limit exceeded"));
};

const classifyRetryable = ({ message = null, code = null, statusCode = null, httpStatus = null } = {}, t) => {
    if (httpStatus === 410) return { text: t("common.errors.connection.expired"), retryable: false };
    if (httpStatus === 403 || httpStatus === 404) return { text: t("common.errors.connection.accessRevoked"), retryable: false };

    const status = toStatus(statusCode);
    const statusKey = STATUS_KEYS.get(status);
    const clientStatus = status !== null && status >= 0x0300 && status <= 0x03FF;
    if (statusKey) return { text: t(statusKey), retryable: false };

    if (!message) {
        const unexpected = code !== null && code !== 1000 && code !== 1005;
        return {
            text: t(unexpected ? "common.errors.connection.closedUnexpectedly" : "common.errors.connection.error"),
            retryable: !clientStatus,
        };
    }

    const key = errorKey(clean(message).toLowerCase());
    return { text: mapConnectionError(message, t), retryable: !clientStatus && !FINAL_KEYS.has(key) };
};

export const classifyConnectionError = (input = {}, t) => ({ ...classifyRetryable(input, t), reconnectable: isReconnectable(input) });
```

- [ ] **Step 5: `ReconnectPolicy.js` anlegen**

`client/src/common/utils/ReconnectPolicy.js`:

```js
import { postRequest } from "@/common/utils/RequestUtil";
import { getDisplayDpi } from "@/common/utils/ConnectionUtil.js";
import { classifyConnectionError } from "@/common/utils/ConnectionErrorUtil.js";

const RECONNECT_PROTOCOLS = new Set(["ssh", "telnet", "pve-lxc", "rdp", "vnc"]);
const LOCAL_TYPES = new Set(["notes", "onedrive", "sftp"]);

export const sessionProtocol = (session) => {
    const server = session?.server;
    if (!server) return null;
    return server.type === "server" ? (server.protocol ?? server.config?.protocol ?? null) : server.type;
};

export const isReconnectEligible = (session) => {
    if (!session || session.isJoined || session.scriptId || LOCAL_TYPES.has(session.type)) return false;
    return RECONNECT_PROTOCOLS.has(sessionProtocol(session));
};

export const shouldAttemptAutoReconnect = ({ enabled, session, errorInfo, wasConnected }) => (
    Boolean(enabled)
    && isReconnectEligible(session)
    && Boolean(wasConnected)
    && Boolean(errorInfo)
    && errorInfo.retryable !== false
);

// 409 means the session is still alive server-side (only the browser socket dropped): re-attach, no new generation.
export const requestReconnect = async (sessionId, t) => {
    try {
        const { generation } = await postRequest(`/connections/${sessionId}/reconnect`, { displayDpi: getDisplayDpi() });
        return { outcome: "reconnected", generation };
    } catch (error) {
        const status = error?.code;
        if (status === 409) return { outcome: "reattach" };
        if (status === 404 && error?.message === "Session ended") return { outcome: "ended" };
        if (status === 403 || status === 404 || status === 410) {
            const { text } = classifyConnectionError({ httpStatus: status }, t);
            return { outcome: "refused", error: { message: text, retryable: false, reconnectable: false, expired: status === 410 } };
        }
        return { outcome: "failed" };
    }
};
```

`client/src/pages/Servers/utils/sessionErrors.js`:

```js
export const shouldRecordError = (existing, incoming, currentGeneration) => {
    const generation = incoming.generation ?? currentGeneration;
    if (generation < currentGeneration) return false;
    return !existing || (existing.generation ?? 1) < generation;
};

export const isSuperseded = (existing, serverGeneration) => Boolean(existing) && (existing.generation ?? 1) < (serverGeneration ?? 1);
```

- [ ] **Step 6: `useAutoReconnect.js` anlegen**

`client/src/common/hooks/useAutoReconnect.js`:

```js
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { shouldAttemptAutoReconnect } from "@/common/utils/ReconnectPolicy.js";

const BACKOFFS = [5, 10, 30, 60, 120];
const MAX_ATTEMPTS = BACKOFFS.length;
const RECONNECT_COOLDOWN_MS = 3000;
const STABLE_CONNECTION_MS = 10000;

const clearTimerOf = (timers, id) => {
    const timer = timers.get(id);
    if (timer === undefined) return;
    clearTimeout(timer);
    timers.delete(id);
};

export const useAutoReconnect = ({ activeSessions, reconnectSession, getSessionErrorInfo, enabled, serverConnected }) => {
    const [reconnectStates, setReconnectStates] = useState({});
    const [prevEnabled, setPrevEnabled] = useState(enabled);
    if (prevEnabled !== enabled) {
        setPrevEnabled(enabled);
        if (!enabled) setReconnectStates({});
    }

    const connectedById = useRef(new Map());
    const attemptsById = useRef(new Map());
    const timersById = useRef(new Map());
    const stableTimersById = useRef(new Map());
    const lastAttemptById = useRef(new Map());
    const inFlightById = useRef(new Map());
    const scheduleRef = useRef(null);

    const latest = useRef({ activeSessions, enabled, reconnectSession, getSessionErrorInfo });
    useEffect(() => {
        latest.current = { activeSessions, enabled, reconnectSession, getSessionErrorInfo };
    });

    const mayAttempt = useCallback((id) => {
        const current = latest.current;
        return shouldAttemptAutoReconnect({
            enabled: current.enabled,
            session: current.activeSessions.find(s => s.id === id) || null,
            errorInfo: current.getSessionErrorInfo?.(id) || null,
            wasConnected: connectedById.current.get(id),
        });
    }, []);

    const clearState = useCallback((id) => {
        setReconnectStates(prev => {
            if (!(id in prev)) return prev;
            const next = { ...prev };
            delete next[id];
            return next;
        });
    }, []);

    const attempt = useCallback((id, { bypassCooldown = false } = {}) => {
        const running = inFlightById.current.get(id);
        if (running) return running;
        const now = Date.now();
        if (!bypassCooldown && now - (lastAttemptById.current.get(id) ?? -Infinity) < RECONNECT_COOLDOWN_MS) return Promise.resolve(null);
        lastAttemptById.current.set(id, now);
        const run = Promise.resolve(latest.current.reconnectSession?.(id))
            .then(result => result?.connected === true)
            .catch(() => false)
            .finally(() => inFlightById.current.delete(id));
        inFlightById.current.set(id, run);
        return run;
    }, []);

    const schedule = useCallback((id) => {
        if (timersById.current.has(id)) return;
        const attempts = attemptsById.current.get(id) || 0;
        if (!mayAttempt(id) || attempts >= MAX_ATTEMPTS) {
            clearState(id);
            return;
        }
        const delay = BACKOFFS[attempts] * 1000;
        setReconnectStates(prev => ({ ...prev, [id]: { attempt: attempts + 1, maxAttempts: MAX_ATTEMPTS, nextAttemptAt: Date.now() + delay } }));
        timersById.current.set(id, setTimeout(async () => {
            timersById.current.delete(id);
            attemptsById.current.set(id, attempts + 1);
            if (!mayAttempt(id)) {
                clearState(id);
                return;
            }
            const connected = await attempt(id);
            if (connected === true) clearState(id);
            else scheduleRef.current?.(id);
        }, delay));
    }, [mayAttempt, attempt, clearState]);

    useEffect(() => {
        scheduleRef.current = schedule;
    }, [schedule]);

    const markSessionConnected = useCallback((id) => {
        connectedById.current.set(id, true);
        clearTimerOf(timersById.current, id);
        clearState(id);
        clearTimerOf(stableTimersById.current, id);
        stableTimersById.current.set(id, setTimeout(() => {
            attemptsById.current.set(id, 0);
            stableTimersById.current.delete(id);
        }, STABLE_CONNECTION_MS));
    }, [clearState]);

    const handleSessionErrored = useCallback((id) => {
        if (!mayAttempt(id)) return;
        clearTimerOf(stableTimersById.current, id);
        schedule(id);
    }, [mayAttempt, schedule]);

    const reconnectNow = useCallback((id) => {
        clearTimerOf(timersById.current, id);
        clearState(id);
        attemptsById.current.set(id, 0);
        const run = attempt(id, { bypassCooldown: true });
        run.then(connected => { if (connected === false) scheduleRef.current?.(id); });
        return run;
    }, [clearState, attempt]);

    const retryReachable = useCallback(() => {
        for (const session of latest.current.activeSessions) {
            const id = session.id;
            if (!mayAttempt(id)) continue;
            const attempts = attemptsById.current.get(id) || 0;
            if (attempts >= MAX_ATTEMPTS) continue;
            if (Date.now() - (lastAttemptById.current.get(id) ?? -Infinity) < RECONNECT_COOLDOWN_MS) continue;
            clearTimerOf(timersById.current, id);
            clearState(id);
            attemptsById.current.set(id, attempts + 1);
            void attempt(id).then(connected => { if (connected === false) scheduleRef.current?.(id); });
        }
    }, [mayAttempt, attempt, clearState]);

    const wasServerConnected = useRef(serverConnected);
    useEffect(() => {
        const was = wasServerConnected.current;
        wasServerConnected.current = serverConnected;
        if (!was && serverConnected) retryReachable();
    }, [serverConnected, retryReachable]);

    useEffect(() => {
        const onVisible = () => { if (document.visibilityState === "visible") retryReachable(); };
        window.addEventListener("online", retryReachable);
        document.addEventListener("visibilitychange", onVisible);
        return () => {
            window.removeEventListener("online", retryReachable);
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, [retryReachable]);

    useEffect(() => {
        if (enabled) return;
        const timers = timersById.current;
        for (const timer of timers.values()) clearTimeout(timer);
        timers.clear();
    }, [enabled]);

    const liveIds = useMemo(() => new Set(activeSessions.map(s => s.id)), [activeSessions]);

    useEffect(() => {
        for (const timers of [timersById.current, stableTimersById.current]) {
            for (const id of [...timers.keys()]) if (!liveIds.has(id)) clearTimerOf(timers, id);
        }
        for (const map of [connectedById.current, attemptsById.current, lastAttemptById.current, inFlightById.current]) {
            for (const id of [...map.keys()]) if (!liveIds.has(id)) map.delete(id);
        }
    }, [liveIds]);

    useEffect(() => {
        const timers = timersById.current;
        const stableTimers = stableTimersById.current;
        return () => {
            for (const map of [timers, stableTimers]) {
                for (const timer of map.values()) clearTimeout(timer);
                map.clear();
            }
        };
    }, []);

    return useMemo(() => ({
        reconnectStates: enabled ? Object.fromEntries(Object.entries(reconnectStates).filter(([id]) => liveIds.has(id))) : {},
        markSessionConnected,
        handleSessionErrored,
        reconnectNow,
    }), [enabled, reconnectStates, liveIds, markSessionConnected, handleSessionErrored, reconnectNow]);
};
```

- [ ] **Step 7: `getDisplayDpi` in `ConnectionUtil.js`**

Am Ende von `client/src/common/utils/ConnectionUtil.js` anfügen:

```js
export const getDisplayDpi = () => Math.min(Math.max(Math.round((window.devicePixelRatio || 1) * 96), 96), 480);
```

- [ ] **Step 8: `mapConnectionError` aus `ConnectionError.jsx` entfernen, Importe umstellen**

In `ConnectionError.jsx` die Funktion `export const mapConnectionError = ...` (Z. 7-45) samt Leerzeile danach löschen. `index.js` wird zu:

```js
export { ConnectionError as default } from "./ConnectionError";
```

Importe (nur diese Zeilen):

`XtermRenderer.jsx:21`:
```js
import ConnectionError from "./components/ConnectionError";
import { mapConnectionError } from "@/common/utils/ConnectionErrorUtil.js";
```

`GuacamoleRenderer.jsx:10`:
```js
import ConnectionError from "./components/ConnectionError";
import { mapConnectionError } from "@/common/utils/ConnectionErrorUtil.js";
```

`ScriptRenderer/ScriptRenderer.jsx:14`:
```js
import ConnectionError from "../components/ConnectionError";
import { mapConnectionError } from "@/common/utils/ConnectionErrorUtil.js";
```

- [ ] **Step 9: Tests laufen lassen**

Run: `cd /root/outpost/client && yarn vitest run src/common/utils/__tests__/ConnectionErrorUtil.test.jsx src/common/hooks/__tests__/useAutoReconnect.test.jsx src/pages/Servers/utils/__tests__/sessionErrors.test.jsx src/pages/Servers/components/ViewContainer/renderer/__tests__/XtermRenderer.test.jsx`
Expected: alle PASS (6 Tests in den drei neuen Dateien, XtermRenderer-Test unverändert grün).

- [ ] **Step 10: Lint der geänderten Dateien**

Run: `cd /root/outpost/client && npx eslint src/common/utils/ConnectionErrorUtil.js src/common/utils/ReconnectPolicy.js src/common/hooks/useAutoReconnect.js src/common/utils/ConnectionUtil.js src/pages/Servers/utils src/pages/Servers/components/ViewContainer/renderer/components/ConnectionError src/pages/Servers/components/ViewContainer/renderer/XtermRenderer.jsx src/pages/Servers/components/ViewContainer/renderer/GuacamoleRenderer.jsx src/pages/Servers/components/ViewContainer/renderer/ScriptRenderer/ScriptRenderer.jsx`
Expected: keine Errors (bestehende Warnungen in den Renderern bleiben unverändert).

- [ ] **Step 11: Commit**

```bash
git add client/src/common/utils/ConnectionErrorUtil.js client/src/common/utils/ReconnectPolicy.js client/src/common/hooks/useAutoReconnect.js client/src/common/utils/ConnectionUtil.js client/src/common/utils/__tests__/ConnectionErrorUtil.test.jsx client/src/common/hooks/__tests__/useAutoReconnect.test.jsx client/src/pages/Servers/utils client/src/pages/Servers/components/ViewContainer/renderer
git commit -m "Reconnect: Fehlerklassifizierung und Automatik im Client"
```

---

### Phasenende A

- [ ] Worktree-Branches von Task 1, 2, 5 in `feature/reconnect` mergen.
- [ ] Engine-Image früh bauen (blockiert Phase B nicht): Branch pushen, `gh workflow run container-image.yml --ref feature/reconnect -f tag=test`; Ergebnis spätestens vor Phasenende B prüfen (`gh run list --workflow container-image.yml -L 1`). Build-Fehler aus Task 1 werden hier behoben, nicht erst in Task 8.
- [ ] Volle Suite: `cd /root/outpost && yarn test` → alle grün.
- [ ] Review-Kette einmal: `/code-review` auf `git diff <Stand vor Phase A>..HEAD`; `footgun` auf `server/lib/SessionManager.js`, `client/src/common/hooks/useAutoReconnect.js`, `engine/src/net/telnet.c`, `engine/src/net/websocket.c`. Befunde in den betroffenen Dateien beheben, je Befundgruppe ein Commit.
- [ ] Zwischenstand (3–5 Zeilen): was steht (Engine meldet Abbrüche, Tombstones/Generationen, Client-Logik), was offen ist (Server-Naht, Oberfläche, Endpunkt, Verdrahtung).

---

## Phase B — Nähte und Endpunkt (parallel: Task 3, Task 4, Task 6)

### Task 3: Server — Engine-IDs, Karenz am Daten-Socket, Engine-Ereignisse, Guacamole-Status

**Files:**
- Create: `server/lib/engineEvents.js`
- Modify: `server/lib/ConnectionService.js` (`openEngineSession` danach Z. 162, SFTP Z. 231-233, Aux-ID Z. 285, SSH Z. 487-527, Telnet Z. 608-641, PVE-LXC Z. 643-704, Guacamole Z. 706-769, Exporte Z. 771-789)
- Modify: `server/lib/GuacdClient.js` (Konstruktor Z. 24-36, Aufzeichnungsname Z. 95, `processData` Z. 137-147, `handleClose` Z. 181-190)
- Modify: `server/index.js:164-175`
- Modify: `server/hooks/guacamole.js:47`
- Create: `server/lib/__tests__/engineSessionLifecycle.test.js`
- Modify: `server/lib/__tests__/rdpDisplayDpi.test.js:27-31`

**Interfaces:**
- Consumes (Task 2): `session.generation`, `session.engineSessionId`, `SessionManager.beginCloseGrace(sessionId, generation)`, `setConnection(sessionId, conn, generation) → boolean`, `markFailed(sessionId, reason, generation)`, `remove(sessionId, { code, reason, guacStatus, generation })`, `onMasterConnectionClosed(sessionId, reason, { guacStatus, generation })`, `resolveEngineSession(engineSessionId)`, `whenEnded`, `getTombstone`, `CLOSE_GRACE_MS`.
- Produces:
  - `ConnectionService.bindDataSocketLifecycle(sessionId, generation, dataSocket, label, onEnd = null) → void`
  - `engineEvents.handleSessionClosed({ sessionId: engineSessionId, reason })`, `engineEvents.handleEngineDisconnected({ engineId, sessionIds })`
  - `new GuacdClient({ ..., generation, engineSessionId })`; `handleClose(reason, guacStatus = null)`
  - Masterverbindung trägt `conn.sessionId = engineSessionId` (ssh/telnet) — `hooks/ssh.js`/`hooks/telnet.js` senden Resize damit an die richtige Engine-Sitzung, ohne Änderung.

**Design:** kein UI-Anteil.

**Tests:** 4 Integrationstests über die Naht ConnectionService/GuacdClient → SessionManager → engineEvents in `engineSessionLifecycle.test.js` (Spec-Server-Tests 1 und 3): (1) Daten-Socket schließt vor der Engine-Meldung — „connection lost“ hinterlässt Tombstone, „session ended“ und stille Karenz nicht; (2) Guacamole-Status 0x020B ohne, 0x0202 mit Tombstone; (3) Engine-Abbruch nach geschlossenem Daten-Socket hinterlässt Tombstone; (4) verspätete Meldung und auslaufende Karenz der alten Generation lassen die neue leben. Exploratives Verdrahten zuerst, dann festnageln. `rdpDisplayDpi.test.js` wird nur an die neue Sitzungsform angepasst (kein neuer Test).

**Parallel:** Task 4, Task 6 (keine gemeinsamen Dateien).

- [ ] **Step 1: `engineEvents.js` anlegen**

`server/lib/engineEvents.js`:

```js
const SessionManager = require("./SessionManager");
const logger = require("../utils/logger");

const currentTarget = (engineSessionId, event) => {
    const target = SessionManager.resolveEngineSession(engineSessionId);
    if (!target) return null;
    const session = SessionManager.get(target.sessionId);
    if (!session) return null;
    if (session.generation !== target.generation) {
        logger.info(`Ignoring ${event} for an older generation`, { engineSessionId, current: session.generation });
        return null;
    }
    return target;
};

module.exports.handleSessionClosed = ({ sessionId: engineSessionId, reason }) => {
    logger.info(`Engine session closed: ${engineSessionId} (reason: ${reason})`);
    const target = currentTarget(engineSessionId, "sessionClosed");
    if (!target) return;
    const ending = reason === "connection lost" ? { code: 4017, reason: "Connection lost" } : {};
    SessionManager.remove(target.sessionId, { ...ending, generation: target.generation });
};

module.exports.handleEngineDisconnected = ({ engineId, sessionIds }) => {
    logger.warn(`Engine ${engineId} disconnected, cleaning up ${sessionIds.length} sessions`);
    for (const engineSessionId of sessionIds) {
        const target = currentTarget(engineSessionId, "engineDisconnected");
        if (target) SessionManager.remove(target.sessionId, { code: 4017, reason: "Engine disconnected", generation: target.generation });
    }
};
```

- [ ] **Step 2: `server/index.js` verdrahten**

Nach Z. 26 (`const SessionManager = require("./lib/SessionManager");`) einfügen:

```js
const engineEvents = require("./lib/engineEvents");
```

Z. 164-175 ersetzen durch:

```js
        controlPlane.on("sessionClosed", engineEvents.handleSessionClosed);
        controlPlane.on("engineDisconnected", engineEvents.handleEngineDisconnected);
```

Prüfen, ob `SessionManager` in `index.js` danach noch benutzt wird (`grep -n SessionManager server/index.js`); wenn nicht, die Importzeile Z. 26 entfernen (sonst schlägt `yarn lint` mit `no-unused-vars` fehl).

- [ ] **Step 3: Hilfsfunktionen in `ConnectionService.js`**

Nach `openEngineSession` (nach Z. 162) einfügen:

```js
const isCurrentGeneration = (sessionId, generation) => SessionManager.get(sessionId)?.generation === generation;

const discardStaleConnection = (engineSessionId, dataSocket, session = null) => {
    try { session?.recording?.stream?.end(); } catch {}
    dataSocket.removeAllListeners();
    dataSocket.destroy();
    try { controlPlane.closeSession(engineSessionId); } catch {}
    return { success: false, stale: true };
};

// The data socket and the engine's SessionClosed report arrive over two separate connections; ending
// the session on `close` right away usually beats the report and loses its reason (4017 vs. normal).
const bindDataSocketLifecycle = (sessionId, generation, dataSocket, label, onEnd = null) => {
    dataSocket.on("close", () => {
        onEnd?.();
        logger.info(`${label} data connection closed`, { sessionId });
        SessionManager.beginCloseGrace(sessionId, generation);
    });
    dataSocket.on("error", (err) => {
        onEnd?.();
        logger.error(`${label} data socket error`, { sessionId, error: err.message });
        SessionManager.markFailed(sessionId, err.message, generation);
        SessionManager.remove(sessionId, { code: 4017, reason: "Connection lost", generation });
    });
};
```

- [ ] **Step 4: SFTP und Aux-Sitzungen auf die Engine-ID**

Z. 231-233:
```js
        const dataSocket = await openEngineSession(
            session.engineSessionId, SessionType.SFTP, host, port, params, jumpHosts, entry.config?.engineId
        );
```

Z. 285:
```js
        const engineSessionId = `${session.engineSessionId}-${suffix}-${conn._auxGeneration}`;
```

(SFTP-Sitzungen haben immer Generation 1, die IDs bleiben also gleich; die Spec verlangt die Form `<engineSessionId>-<suffix>-<n>`.)

- [ ] **Step 5: SSH**

In `createSSHConnectionForSession` (Z. 487-527):

Nach Z. 489 (`if (session._connecting) return session._connecting;`) einfügen:
```js
    const { generation, engineSessionId } = session;
```

Z. 498-500 ersetzen durch:
```js
        const dataSocket = await openEngineSession(
            engineSessionId, SessionType.SSH, host, port, params, jumpHosts, entry.config?.engineId
        );
        if (!isCurrentGeneration(sessionId, generation)) return discardStaleConnection(engineSessionId, dataSocket, session);
```

Z. 505-513 (die beiden `dataSocket.on("close"/"error")`) ersetzen durch:
```js
        bindDataSocketLifecycle(sessionId, generation, dataSocket, "SSH");
```

Z. 521-527 ersetzen durch:
```js
        const attached = SessionManager.setConnection(sessionId, {
            dataSocket,
            sessionId: engineSessionId,
            type: "ssh",
            auditLogId: session.auditLogId,
            scriptLayer,
        }, generation);
        if (!attached) return discardStaleConnection(engineSessionId, dataSocket, session);
```

- [ ] **Step 6: Telnet**

`createTelnetConnectionForSession` (Z. 608-641) ersetzen durch:

```js
const createTelnetConnectionForSession = async (sessionId, entry, organizationId) => {
    requireEngine();
    const session = requireSession(sessionId);
    const { generation, engineSessionId } = session;
    const { ip, port = 23 } = entry.config || {};

    if (!ip) throw new Error("Missing host configuration");

    const dataSocket = await openEngineSession(
        engineSessionId, SessionType.Telnet, ip, port, {}, [], entry.config?.engineId
    );
    if (!isCurrentGeneration(sessionId, generation)) return discardStaleConnection(engineSessionId, dataSocket, session);

    await SessionManager.initRecording(sessionId, organizationId);

    dataSocket.on("data", (data) => SessionManager.appendLog(sessionId, data.toString()));
    bindDataSocketLifecycle(sessionId, generation, dataSocket, "Telnet");

    const attached = SessionManager.setConnection(sessionId, {
        dataSocket,
        sessionId: engineSessionId,
        type: "telnet",
        auditLogId: session.auditLogId,
    }, generation);
    if (!attached) return discardStaleConnection(engineSessionId, dataSocket, session);

    logger.info("Telnet connected", { sessionId, ip, port });
    return { success: true };
}
```

- [ ] **Step 7: PVE-LXC**

In `createPveLxcConnectionForSession` (Z. 643-704):

Nach Z. 645 (`const session = requireSession(sessionId);`) einfügen:
```js
    const { generation, engineSessionId } = session;
```

Z. 666-668 ersetzen durch:
```js
    const dataSocket = await openEngineSession(
        engineSessionId, SessionType.WebSocket, server.ip, Number(server.port) || 8006, params, [], entry.config?.engineId
    );
    if (!isCurrentGeneration(sessionId, generation)) return discardStaleConnection(engineSessionId, dataSocket, session);
```

Z. 683-693 (`dataSocket.on("close")` und `dataSocket.on("error")`) ersetzen durch:
```js
    bindDataSocketLifecycle(sessionId, generation, dataSocket, "PVE LXC", () => clearInterval(keepAliveTimer));
```

Z. 695-700 ersetzen durch:
```js
    const attached = SessionManager.setConnection(sessionId, {
        dataSocket,
        keepAliveTimer,
        type: "pve-lxc",
        auditLogId: session.auditLogId,
    }, generation);
    if (!attached) {
        clearInterval(keepAliveTimer);
        return discardStaleConnection(engineSessionId, dataSocket, session);
    }
```

- [ ] **Step 8: Guacamole**

In `prepareGuacamoleSession` (Z. 706-769):

Nach Z. 707 (`const session = requireSession(sessionId);`) einfügen:
```js
    const { generation, engineSessionId } = session;
```

Z. 730-732 ersetzen durch:
```js
    const dataSocket = await openEngineSession(
        engineSessionId, sessionType, host, port, params, jumpHosts, entry.config?.engineId
    );
    if (!isCurrentGeneration(sessionId, generation)) return discardStaleConnection(engineSessionId, dataSocket, session);
```

Z. 737:
```js
        controlPlane.registerRecordingSession(engineSessionId, session.auditLogId);
```

Z. 740-749 ersetzen durch:
```js
    const masterClient = new GuacdClient({
        sessionId,
        generation,
        engineSessionId,
        connectionSettings: {
            connection: { type: protocol, width: 1024, height: 768, ...params, dpi: guacDisplayDpi(session.configuration?.displayDpi) },
            enableAudio: entry.config?.enableAudio !== false,
        },
        recordingEnabled,
        auditLogId: session.auditLogId,
        existingSocket: dataSocket,
    });
```

Z. 758-765 ersetzen durch:
```js
    const attached = SessionManager.setConnection(sessionId, {
        guacdClient: masterClient,
        dataSocket,
        type: "guac",
        auditLogId: session.auditLogId,
    }, generation);
    if (!attached) {
        masterClient.close();
        try { controlPlane.closeSession(engineSessionId); } catch {}
        return { success: false, stale: true };
    }

    SessionManager.setGuacReady(sessionId);
```

(`setGuacReady` rückt hinter `setConnection`: eine veraltete Generation darf die Warteschlange der neuen nicht freigeben. Die Warter in `routes/guac.js` laufen ohnehin erst im nächsten Microtask weiter.)

- [ ] **Step 9: Exporte**

In `module.exports` (Z. 771-789) nach `createConnectionForSession,` ergänzen:
```js
    bindDataSocketLifecycle,
```

- [ ] **Step 10: `GuacdClient` — Generation, Engine-ID, Status, Karenz**

Im Konstruktor nach Z. 25 (`this.sessionId = options.sessionId;`) einfügen:
```js
        this.generation = options.generation;
        this.engineSessionId = options.engineSessionId || options.sessionId;
```

Z. 95:
```js
            conn['recording-name'] = this.engineSessionId;
```

In `processData` Z. 137-147 ersetzen durch:
```js
        // Match error instructions only at instruction boundaries (start of string or after ';')
        // to avoid false positives from filenames or clipboard text containing ".error,"
        const errorMatch = /(?:^|;)\d+\.error,\d+\.([^,]+),\d+\.(\d+);/.exec(dataToSend);
        if (errorMatch) {
            const [, errorMessage, status] = errorMatch;
            logger.error('Guacd error received', { sessionId: this.sessionId, error: errorMessage, status: Number(status) });
            // Forward data to client first so it can display the error message
            try { this.onDataCallback?.(dataToSend); } catch {}
            this.handleClose(`error: ${errorMessage}`, Number(status));
            return;
        }
```

`handleClose` (Z. 181-190) ersetzen durch:
```js
    handleClose(reason, guacStatus = null) {
        if (this.state === 'closed') return;
        this.state = 'closed';
        logger.info('Connection closed', { sessionId: this.sessionId, reason });
        this.cleanup();
        this.onCloseCallback?.(reason);
        if (this.joinConnectionId) return;
        if (reason === 'connection closed') SessionManager.beginCloseGrace(this.sessionId, this.generation);
        else SessionManager.onMasterConnectionClosed(this.sessionId, reason, { guacStatus, generation: this.generation });
    }
```

`cleanup()` und `onCloseCallback` bleiben sofort (Handshake-Abbruch in `prepareGuacamoleSession` hängt am Callback); nur die Sitzung wartet die Karenz ab.

- [ ] **Step 11: `hooks/guacamole.js` — Beitritt über die Engine-ID**

Z. 47:
```js
        joinSocket = await controlPlane.joinSession(SessionManager.get(sessionId)?.engineSessionId ?? sessionId);
```

- [ ] **Step 12: `rdpDisplayDpi.test.js` an die neue Sitzungsform anpassen**

Z. 27:
```js
    const session = { accountId: 1, entryId: 9, auditLogId: null, generation: 1, engineSessionId: "s1", configuration: { displayDpi } };
```

Z. 31:
```js
        [SessionManager, "setConnection", () => true],
```

- [ ] **Step 13: Integrationstests schreiben**

`server/lib/__tests__/engineSessionLifecycle.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const SessionManager = require("../SessionManager");
const controlPlane = require("../controlPlane/ControlPlaneServer");
const { bindDataSocketLifecycle } = require("../ConnectionService");
const GuacdClient = require("../GuacdClient");
const { handleSessionClosed, handleEngineDisconnected } = require("../engineEvents");

controlPlane.closeSession = () => {};

const fakeSocket = () => Object.assign(new EventEmitter(), { write() {}, end() {}, destroy() {} });

const connectedSession = (protocol = "ssh") => {
    const session = SessionManager.create(1, 2, { protocol });
    const socket = fakeSocket();
    bindDataSocketLifecycle(session.sessionId, session.generation, socket, "SSH");
    SessionManager.setConnection(session.sessionId,
        { type: protocol, dataSocket: socket, sessionId: session.engineSessionId }, session.generation);
    return { session, socket };
};

test("schließt der Daten-Socket vor der Engine-Meldung, entscheidet die Meldung über den Tombstone", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });

    const lost = connectedSession();
    lost.socket.emit("close");
    assert.ok(SessionManager.get(lost.session.sessionId), "während der Karenz lebt die Sitzung");
    handleSessionClosed({ sessionId: lost.session.engineSessionId, reason: "connection lost" });
    await SessionManager.whenEnded(lost.session.sessionId);
    assert.strictEqual(SessionManager.getTombstone(lost.session.sessionId)?.reason, "Connection lost");

    const ended = connectedSession();
    ended.socket.emit("close");
    handleSessionClosed({ sessionId: ended.session.engineSessionId, reason: "session ended" });
    await SessionManager.whenEnded(ended.session.sessionId);
    assert.strictEqual(SessionManager.getTombstone(ended.session.sessionId), null);

    const silent = connectedSession();
    silent.socket.emit("close");
    t.mock.timers.tick(SessionManager.CLOSE_GRACE_MS);
    await SessionManager.whenEnded(silent.session.sessionId);
    assert.strictEqual(SessionManager.get(silent.session.sessionId), null);
    assert.strictEqual(SessionManager.getTombstone(silent.session.sessionId), null);
});

test("ein RDP-Logoff (Guacamole-Status 0x020B) hinterlässt keinen Tombstone, ein Abbruch schon", async () => {
    const end = async (instruction) => {
        const session = SessionManager.create(1, 2, { protocol: "rdp" });
        const socket = fakeSocket();
        const client = new GuacdClient({
            sessionId: session.sessionId,
            generation: session.generation,
            engineSessionId: session.engineSessionId,
            existingSocket: socket,
            connectionSettings: { connection: { type: "rdp" } },
        });
        client.connect();
        socket.emit("data", "4.args,13.VERSION_1_5_0;");
        socket.emit("data", instruction);
        await SessionManager.whenEnded(session.sessionId);
        SessionManager.consumeFailedReason(session.sessionId);
        return SessionManager.getTombstone(session.sessionId);
    };

    assert.strictEqual(await end("5.error,11.Logged off.,3.523;"), null);
    assert.strictEqual((await end("5.error,15.Connection lost,3.514;"))?.reason, "error: Connection lost");
});

test("ein Engine-Abbruch hinterlässt einen Tombstone, auch wenn der Daten-Socket vorher schließt", async () => {
    const { session, socket } = connectedSession();
    socket.emit("close");
    handleEngineDisconnected({ engineId: "engine-1", sessionIds: [session.engineSessionId, `${session.sessionId}-xfer-1`] });
    await SessionManager.whenEnded(session.sessionId);
    assert.strictEqual(SessionManager.getTombstone(session.sessionId)?.reason, "Engine disconnected");
});

test("verspätete Meldungen der alten Generation lassen die neue leben", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const first = SessionManager.create(1, 2, { protocol: "ssh" });
    const { sessionId } = first;
    const oldSocket = fakeSocket();
    bindDataSocketLifecycle(sessionId, first.generation, oldSocket, "SSH");
    handleSessionClosed({ sessionId: first.engineSessionId, reason: "connection lost" });
    await SessionManager.whenEnded(sessionId);

    const second = SessionManager.create(1, 2, { protocol: "ssh" }, null, null, null, null, null, { sessionId, generation: 2 });
    handleSessionClosed({ sessionId: first.engineSessionId, reason: "session ended" });
    oldSocket.emit("close");
    t.mock.timers.tick(SessionManager.CLOSE_GRACE_MS);

    assert.strictEqual(SessionManager.get(sessionId), second);
    assert.strictEqual(second._removing, undefined);
    assert.strictEqual(second._closeGrace, null);
    await SessionManager.remove(sessionId);
});
```

Hinweis zum zweiten Test: `markFailed` startet einen 30-s-Timer, der den Testprozess sonst eine halbe Minute offen hält; `consumeFailedReason` räumt ihn ab.

- [ ] **Step 14: Tests laufen lassen**

Run: `cd /root/outpost && node --test server/lib/__tests__/engineSessionLifecycle.test.js server/lib/__tests__/rdpDisplayDpi.test.js server/lib/__tests__/sessionTombstone.test.js server/lib/__tests__/crossTransferClient.test.js server/lib/__tests__/identityAccessDenied.test.js`
Expected: alle PASS.

- [ ] **Step 15: Lint**

Run: `cd /root/outpost && yarn lint`
Expected: keine Errors.

- [ ] **Step 16: Commit**

```bash
git add server/lib/engineEvents.js server/lib/ConnectionService.js server/lib/GuacdClient.js server/index.js server/hooks/guacamole.js server/lib/__tests__/engineSessionLifecycle.test.js server/lib/__tests__/rdpDisplayDpi.test.js
git commit -m "Reconnect: Engine-Sitzung je Generation und Karenz zwischen Daten-Socket und Engine-Meldung"
```

---

### Task 6: Client-Oberfläche — Fehlerkarte, Tab-Zustand, Menüeintrag, Texte, Einstellung

**Files:**
- Modify: `.../ConnectionError/ConnectionError.jsx` (ganze Komponente), `.../ConnectionError/styles.sass:86-107` (`.connection-error__action`)
- Create: `.../ConnectionError/__tests__/ConnectionError.test.jsx`
- Modify: `.../ServerTabs/ServerTabs.jsx` (Import Z. 5, `DraggableTab`-Props Z. 19-39, `<h2>` Z. 216-220, Kontextmenü Z. 230-245, `ServerTabs`-Props Z. 320-349, `DraggableTab`-Aufruf Z. 477-486), `.../ServerTabs/styles.sass` (nach `.tab-participants`, Z. 315-316)
- Modify: `client/public/assets/locales/en.json`, `client/public/assets/locales/de_DE.json`
- Modify: `client/src/common/contexts/PreferencesContext.jsx:16-18, 540, 577, 615`
- Modify: `client/src/pages/Settings/pages/Terminal/Terminal.jsx:18-20, 141-143`

**Interfaces:**
- Consumes (Task 5): `isReconnectEligible(session)` aus `@/common/utils/ReconnectPolicy.js`.
- Produces:
  - `<ConnectionError message retryable={false} expired={false} reconnecting={false} reconnect={null | { attempt, maxAttempts, nextAttemptAt }} now={number} reconnectable={true} onReconnect? onClose? />` — Zustand wird abgeleitet: `expired` > `loading` (`reconnecting`) > `countdown` (`reconnect`) > `default` (`retryable`) / `final`. Ohne `onReconnect` oder bei `reconnectable={false}` kein Primärknopf (Skripte, beigetretene Sitzungen, Share; endgültig beendetes RDP). `now` ist nur bei `reconnect` nötig.
  - `<ServerTabs ... connectionStates={{ [sessionId]: "error" | "loading" }} reconnectable={{ [sessionId]: true }} onReconnect={(sessionId) => …} />`
  - `usePreferences()` liefert `autoReconnect: boolean` (Standard `true`) und `setAutoReconnect(enabled)`.
  - i18n-Schlüssel: `common.errors.connection.{connectionLost, engineDisconnected, hostKey, sessionEnded, accessRevoked, lostTitle, expiredTitle, expired, reconnect, reconnectNow, reconnecting, countdown}` (der Schließen-Knopf nutzt `common.close`; `common.errors.connection.close` entfällt), `servers.tabs.connection.{disconnected, reconnecting}`, `servers.tabs.contextMenu.reconnect`, `settings.terminal.input.autoReconnect`.

**Design:**
- Screen: `UI-SERVERS` — Artboard `docs/design/mockups/ui-servers.html`
- Zu bauende Elemente (Werte wörtlich übernehmen):

| ID | Element | Fachlicher Anker | Zustände | Copy |
|----|---------|------------------|----------|------|
| UI-SERVERS-VIEW-ERROR | Verbindungsfehler | Die Karte, die in der Arbeitsfläche an die Stelle einer abgebrochenen Session tritt: Icon, Titel, Fehlertext im Klartext, darunter eine Knopfzeile. Primär Neu verbinden (während der Automatik Jetzt verbinden), sekundär Schließen. Läuft die Automatik, steht über den Knöpfen der Countdown mit Versuchszähler. Neu verbinden baut dieselbe Session im selben Tab und an derselben Stelle im Layout wieder auf; es öffnet keinen neuen Tab. Nicht: server_entry, server_dialog. | default, countdown, loading, final, expired | default „Verbindung verloren. Neu verbinden oder schließen.“ · countdown „Neuer Versuch in 8 s · Versuch 2/5“ · loading „Verbinde neu …“ · final „Anmeldung abgelehnt. Zugangsdaten prüfen, dann neu verbinden. — Nach RDP-Abmelden oder -Trennung nur Schließen.“ · expired „Sitzung abgelaufen. Öffne den Server neu.“ |
| UI-SERVERS-TAB-CONNECTION | Verbindungszustand eines Tabs | Zeigt am Label, dass die Verbindung einer Session weg ist oder gerade neu aufgebaut wird: das Label wird in --subtext gedämpft, dahinter steht ein kleines Icon — Unplug bei getrennt, ein sich drehendes RotateCw beim Neuverbinden. Im Normalzustand ist nichts zu sehen. Marker und Kontextstreifen bleiben unberührt; ein Ring im Marker heißt weiterhin Fortschritt, nicht Verbindung. Nicht: session_activity, agent_context, pane_color. | default, loading, error | default „kein Zusatz“ · loading „Label gedämpft, RotateCw dreht sich“ · error „Label gedämpft, Unplug“ |
| UI-SERVERS-TABS | Sessions | Die aktuell offenen Sessions als Tabs, jede mit ihrer Split-View-Zuordnungsfarbe; Kontextmenü mit Umbenennen, Duplizieren, Teilen, Schlafen legen, Ausklinken, Schließen — bei einer getrennten Session zusätzlich Neu verbinden, an erster Stelle. Nicht: server_entry, folder. | default, selected, empty (Bestand) | Menüeintrag „Neu verbinden“ |

- Locator: jedes Element trägt `data-ui-id="<ID>"`.
- Tokens: `--subtext`, `--primary`, `--error`, `--terminal` aus `docs/design/mockups/tokens.css` (im Code über `client/src/common/styles/_colors.sass`).
- Dieser Task baut Karte, Tab-Zustand und Menüeintrag; das Anzeigen in der Arbeitsfläche verdrahtet Task 7b.

**Tests:** 1 Test `ConnectionError.test.jsx` (Spec-Client-Test 3: Countdown und „Jetzt verbinden“ löst den Reconnect aus). Er läuft mit den echten `en.json`-Texten (`client/src/test/i18n.js` wirft bei fehlenden Schlüsseln) und deckt damit auch die neuen Schlüssel ab. Keine Tests für `ServerTabs`-Darstellung (Prüfung über `/design-verify`), Einstellungsschalter und Präferenz-Getter (reine Weiterreichung).

**Parallel:** Task 3, Task 4 (keine gemeinsamen Dateien).

- [ ] **Step 1: Failing test schreiben**

`.../ConnectionError/__tests__/ConnectionError.test.jsx`:

```jsx
import { expect, test, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/renderWithProviders.jsx";
import { ConnectionError } from "../ConnectionError.jsx";

test("der Countdown zeigt Restzeit und Versuch, Jetzt verbinden löst den Reconnect aus", async () => {
    const onReconnect = vi.fn();
    renderWithProviders(
        <ConnectionError message="The connection to the host was interrupted." retryable
                         reconnect={{ attempt: 2, maxAttempts: 5, nextAttemptAt: 18_000 }} now={10_000}
                         onReconnect={onReconnect} onClose={vi.fn()} />
    );

    expect(screen.getByText("Retrying in 8 s · Attempt 2/5")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /connect now/i }));
    expect(onReconnect).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag prüfen**

Run: `cd /root/outpost/client && yarn vitest run src/pages/Servers/components/ViewContainer/renderer/components/ConnectionError/__tests__/ConnectionError.test.jsx`
Expected: FAIL — `i18n: missing key "common.errors.connection.lostTitle"` bzw. Countdown-Text nicht gefunden.

- [ ] **Step 3: Texte in `en.json`**

In `client/public/assets/locales/en.json` die Zeile
```json
        "rdpSessionClosed": "The RDP session was ended by the remote server or an administrator."
```
ersetzen durch:
```json
        "rdpSessionClosed": "The RDP session was ended by the remote server or an administrator.",
        "connectionLost": "The connection to the host was interrupted.",
        "engineDisconnected": "The connection engine was restarted or is unreachable.",
        "hostKey": "The host key of the server does not match.",
        "sessionEnded": "The session was ended.",
        "accessRevoked": "You no longer have access to this server or identity.",
        "lostTitle": "Connection lost",
        "expiredTitle": "Session expired",
        "expired": "Open the server again.",
        "reconnect": "Reconnect",
        "reconnectNow": "Connect now",
        "reconnecting": "Reconnecting …",
        "countdown": "Retrying in {{seconds}} s · Attempt {{attempt}}/{{max}}"
```

Im selben Block `common.errors.connection` die Zeile `"close": "Close tab",` löschen (der Schlüssel wird nach dem Umbau nicht mehr benutzt).

Die Zeile `"contextTooltip": "Context: {{tool}} at {{percent}}%",` ersetzen durch:
```json
      "contextTooltip": "Context: {{tool}} at {{percent}}%",
      "connection": {
        "disconnected": "Disconnected",
        "reconnecting": "Reconnecting"
      },
```

Die Zeile `"closeSession": "Disconnect"` ersetzen durch:
```json
        "closeSession": "Disconnect",
        "reconnect": "Reconnect"
```

Die Zeile `"passwordPromptDetection": "Password input detection",` ersetzen durch:
```json
        "passwordPromptDetection": "Password input detection",
        "autoReconnect": "Reconnect automatically",
```

- [ ] **Step 4: Texte in `de_DE.json`**

`"rdpSessionClosed": "Die RDP-Sitzung wurde vom entfernten Server oder einem Administrator beendet."` ersetzen durch:
```json
        "rdpSessionClosed": "Die RDP-Sitzung wurde vom entfernten Server oder einem Administrator beendet.",
        "connectionLost": "Die Verbindung zum Host wurde unterbrochen.",
        "engineDisconnected": "Die Verbindungs-Engine wurde neu gestartet oder ist nicht erreichbar.",
        "hostKey": "Der Host-Schlüssel des Servers stimmt nicht überein.",
        "sessionEnded": "Die Sitzung wurde beendet.",
        "accessRevoked": "Du hast keinen Zugriff mehr auf diesen Server oder diese Identität.",
        "lostTitle": "Verbindung verloren",
        "expiredTitle": "Sitzung abgelaufen",
        "expired": "Öffne den Server neu.",
        "reconnect": "Neu verbinden",
        "reconnectNow": "Jetzt verbinden",
        "reconnecting": "Verbinde neu …",
        "countdown": "Neuer Versuch in {{seconds}} s · Versuch {{attempt}}/{{max}}"
```

Im selben Block `common.errors.connection` die Zeile `"close": "Registerkarte schließen",` löschen (der Schlüssel wird nach dem Umbau nicht mehr benutzt).

`"contextTooltip": "Kontext: {{tool}} bei {{percent}} %",` ersetzen durch:
```json
      "contextTooltip": "Kontext: {{tool}} bei {{percent}} %",
      "connection": {
        "disconnected": "Getrennt",
        "reconnecting": "Verbinde neu"
      },
```

`"closeSession": "Trennen"` ersetzen durch:
```json
        "closeSession": "Trennen",
        "reconnect": "Neu verbinden"
```

`"passwordPromptDetection": "Erkennung der Passworteingabe",` ersetzen durch:
```json
        "passwordPromptDetection": "Erkennung der Passworteingabe",
        "autoReconnect": "Automatisch neu verbinden",
```

Run: `cd /root/outpost/client && node -e "for (const f of ['en','de_DE']) JSON.parse(require('fs').readFileSync('public/assets/locales/'+f+'.json','utf8')); console.log('ok')"`
Expected: `ok`

- [ ] **Step 5: `ConnectionError.jsx` neu**

`ConnectionError.jsx` (nach Task 5 ohne `mapConnectionError`) vollständig ersetzen durch:

```jsx
import { memo } from "react";
import Icon from "@/common/components/Icon";
import Button from "@/common/components/Button";
import { Laptop as IconLaptop, Server as IconServer, X as IconX, CircleAlert as IconCircleAlert, RotateCw as IconRotateCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import "./styles.sass";

const stateOf = ({ expired, reconnecting, reconnect, retryable }) => {
    if (expired) return "expired";
    if (reconnecting) return "loading";
    if (reconnect) return "countdown";
    return retryable ? "default" : "final";
};

export const ConnectionError = memo(({ message, retryable = false, expired = false, reconnecting = false, reconnect = null, now = null, reconnectable = true, onReconnect, onClose }) => {
    const { t } = useTranslation();
    const state = stateOf({ expired, reconnecting, reconnect, retryable });

    const title = state === "expired" ? t("common.errors.connection.expiredTitle")
        : state === "final" ? t("common.errors.connection.title")
        : t("common.errors.connection.lostTitle");
    const text = state === "expired" ? t("common.errors.connection.expired")
        : state === "loading" ? t("common.errors.connection.reconnecting")
        : message;
    const seconds = reconnect ? Math.max(0, Math.ceil((reconnect.nextAttemptAt - now) / 1000)) : 0;

    return (
        <div className="connection-error" data-ui-id="UI-SERVERS-VIEW-ERROR" data-ui-state={state} role="alert">
            <div className="connection-error__bar" />
            <div className="connection-error__visual">
                <div className="connection-error__device">
                    <Icon icon={IconLaptop} className="connection-error__device-icon" />
                </div>
                <div className="connection-error__link">
                    <span className="connection-error__link-line" />
                    <span className="connection-error__link-badge">
                        <Icon icon={IconCircleAlert} />
                    </span>
                    <span className="connection-error__link-line" />
                </div>
                <div className="connection-error__device connection-error__device--server">
                    <Icon icon={IconServer} className="connection-error__device-icon" />
                </div>
            </div>
            <div className="connection-error__text">
                <h2 className="connection-error__title">{title}</h2>
                <p className="connection-error__message">{text}</p>
                {state === "countdown" && (
                    <p className="connection-error__countdown">
                        {t("common.errors.connection.countdown", { seconds, attempt: reconnect.attempt, max: reconnect.maxAttempts })}
                    </p>
                )}
            </div>
            <div className="connection-error__actions">
                {onReconnect && state !== "expired" && reconnectable !== false && (
                    <Button type="primary" icon={IconRotateCw}
                            text={t(state === "countdown" ? "common.errors.connection.reconnectNow" : "common.errors.connection.reconnect")}
                            onClick={onReconnect} loading={state === "loading"} disabled={state === "loading"} />
                )}
                {onClose && (
                    <Button type="secondary" icon={IconX} text={t("common.close")} onClick={onClose} />
                )}
            </div>
        </div>
    );
});
ConnectionError.displayName = "ConnectionError";
```

Texte gehen ausschließlich als React-Kinder hinaus, nie über `dangerouslySetInnerHTML` (SEC-XSS-01).

- [ ] **Step 6: Stile der Knopfzeile**

In `.../ConnectionError/styles.sass` den Block `.connection-error__action` (Z. 86-107, bis zum Dateiende) ersetzen durch:

```sass
.connection-error__countdown
  margin: 0
  font: tokens.$type-body
  color: colors.$subtext
  font-variant-numeric: tabular-nums

.connection-error__actions
  display: flex
  flex-wrap: wrap
  justify-content: center
  gap: tokens.$space-3

  .btn.type-primary:not(:disabled)
    background-color: colors.$primary
    border-color: colors.$primary
```

Am Kopf von `styles.sass` neben dem vorhandenen `@use` ergänzen:
```sass
@use "@/common/styles/tokens"
```

- [ ] **Step 7: Test laufen lassen**

Run: `cd /root/outpost/client && yarn vitest run src/pages/Servers/components/ViewContainer/renderer/components/ConnectionError/__tests__/ConnectionError.test.jsx`
Expected: PASS.

- [ ] **Step 8: `ServerTabs` — Zustand am Label und Menüeintrag**

`ServerTabs.jsx` Z. 5: in die Lucide-Importliste `RotateCw as IconRotateCw, Unplug as IconUnplug` aufnehmen. Nach Z. 17 (`import RenameTabDialog ...`) einfügen:

```js
import { isReconnectEligible } from "@/common/utils/ReconnectPolicy.js";
```

`DraggableTab`-Props (Z. 19-39): nach `context = null,` ergänzen:
```js
    connectionState = null,
    onReconnect,
```

Das `<h2>` (Z. 216-220) ersetzen durch:
```jsx
                <h2 title={tabTooltip} data-ui-id="UI-SERVERS-TAB-LABEL" className={connectionState ? "is-disconnected" : undefined}>
                    <span className="tab-name">{tabLabel.name}</span>
                    {tabLabel.kind && <span className="tab-kind">{tabLabel.kind}</span>}
                    {tabLabel.number && <span className="tab-number">({tabLabel.number})</span>}
                </h2>
                {connectionState && (
                    <span className="tab-connection" data-ui-id="UI-SERVERS-TAB-CONNECTION" data-ui-state={connectionState}
                          role="img"
                          aria-label={t(connectionState === "loading" ? "servers.tabs.connection.reconnecting" : "servers.tabs.connection.disconnected")}>
                        <Icon icon={connectionState === "loading" ? IconRotateCw : IconUnplug} spin={connectionState === "loading"} />
                    </span>
                )}
```

Im `<ContextMenu>` direkt vor dem Kommentar `{/* Unconditional, unlike every item below it: ...` (Z. 236) einfügen:
```jsx
                {connectionState && onReconnect && isReconnectEligible(session) && (
                    <>
                        <ContextMenuItem
                            icon={IconRotateCw}
                            label={t("servers.tabs.contextMenu.reconnect")}
                            onClick={() => onReconnect(session.id)}
                            disabled={connectionState === "loading"}
                        />
                        <ContextMenuSeparator />
                    </>
                )}
```

`ServerTabs`-Props (Z. 320-349): nach `sessionContext = {},` ergänzen:
```js
    connectionStates = {},
    onReconnect,
    reconnectable = {},
```

Im `DraggableTab`-Aufruf (Z. 477-486) die neuen Props vor dem schließenden `/>` in Z. 486 (`liveTitle={liveTitles[session.id]} />`) einfügen, nicht nach dieser Zeile:
```jsx
                                connectionState={connectionStates[session.id] || null}
                                onReconnect={reconnectable[session.id] ? onReconnect : undefined}
```

- [ ] **Step 9: Stile für den Tab-Zustand**

In `.../ServerTabs/styles.sass` nach dem Block `.tab-participants` (Z. 315-316, Einrückung sechs Leerzeichen) einfügen:

```sass
      h2.is-disconnected .tab-name
        color: colors.$subtext

      .tab-connection
        display: inline-flex
        align-items: center
        flex: none
        margin-right: tokens.$space-1
        color: colors.$subtext

        svg
          width: 0.875rem
          height: 0.875rem
```

Am Kopf von `.../ServerTabs/styles.sass` neben dem vorhandenen `@use` ergänzen:
```sass
@use "@/common/styles/tokens"
```

Das Drehen kommt aus `Icon spin` → Klasse `.icon-spin` (`client/src/common/components/Icon/styles.sass`), die unter `prefers-reduced-motion: reduce` bereits stillsteht.

- [ ] **Step 10: Präferenz `terminal.autoReconnect`**

`PreferencesContext.jsx` nach Z. 18 (`"terminal.keyBar": "terminal.input",`) einfügen:
```js
    "terminal.autoReconnect": "terminal.input",
```

Nach Z. 540 (`const passwordPromptDetection = get("terminal.passwordPromptDetection", true);`) einfügen:
```js
    const autoReconnect = get("terminal.autoReconnect", true);
```

Nach Z. 577 (`const setPasswordPromptDetection = ...`) einfügen:
```js
    const setAutoReconnect = useCallback((enabled) => set("terminal.autoReconnect", enabled), [set]);
```

Nach Z. 615 (`passwordPromptDetection, setPasswordPromptDetection,`) einfügen:
```js
            autoReconnect, setAutoReconnect,
```

- [ ] **Step 11: Schalter unter Einstellungen → Terminal**

`Terminal.jsx` nach Z. 20 (`passwordPromptDetection, setPasswordPromptDetection,`) einfügen:
```js
        autoReconnect, setAutoReconnect,
```

Nach Z. 142 (Zeile mit `settings.terminal.input.passwordPromptDetection`) einfügen:
```jsx
                    {renderFontOption(t("settings.terminal.input.autoReconnect"), toggleOptions, autoReconnect.toString(), (value) => setAutoReconnect(value === "true"))}
```

- [ ] **Step 12: Tests und Lint**

Run: `cd /root/outpost/client && yarn vitest run src/pages/Servers/components/ViewContainer/renderer/components/ConnectionError/__tests__/ConnectionError.test.jsx src/pages/Servers/components/ViewContainer/renderer/__tests__/XtermRenderer.test.jsx && npx eslint src/pages/Servers/components/ViewContainer/renderer/components/ConnectionError src/pages/Servers/components/ViewContainer/components/ServerTabs src/common/contexts/PreferencesContext.jsx src/pages/Settings/pages/Terminal/Terminal.jsx`
Expected: Tests PASS, keine Lint-Errors.

- [ ] **Step 13: Commit**

```bash
git add client/src/pages/Servers/components/ViewContainer/renderer/components/ConnectionError client/src/pages/Servers/components/ViewContainer/components/ServerTabs client/public/assets/locales/en.json client/public/assets/locales/de_DE.json client/src/common/contexts/PreferencesContext.jsx client/src/pages/Settings/pages/Terminal/Terminal.jsx
git commit -m "Reconnect: Fehlerkarte mit Neu verbinden und Countdown, Verbindungszustand am Tab"
```

---

### Task 4: Server — `POST /api/connections/:id/reconnect`, gemeinsamer Kern `openSession`, Audit, DELETE, Präferenz

**Files:**
- Modify: `server/controllers/serverSession.js` (Import Z. 2, `createSession` Z. 82-205 → `openSession` + Wrapper, `getSessions` Z. 237-250, `hibernateSession`/`resumeSession` Z. 254-268, `deleteSession` Z. 270-276, `getSession` Z. 314-326, neu `reconnectSession`, Exporte Z. 443)
- Modify: `server/routes/serverSession.js` (Importe Z. 1-6, Limiter nach Z. 8, hibernate Z. 87, resume Z. 110, DELETE Z. 128-137, neue Route)
- Modify: `server/validations/serverSession.js` (neu `reconnectSessionValidation`)
- Modify: `server/validations/preferences.js:3-12`
- Modify: `server/controllers/audit.js:23-36, 76-89`
- Create: `server/lib/__tests__/reconnectSession.test.js`
- Modify: `server/lib/__tests__/validations.test.js` (Import + 1 Test)

**Interfaces:**
- Consumes (Task 2): `SessionManager.create(..., { sessionId, generation })`, `getTombstone`, `dropTombstone`, `whenEnded`, `consumeFailedReason`, `markFailed(…, generation)`, `remove(…, { generation })`, `session._removing`, `session._closeGrace`, `session.generation`; (Task 2): `getEntryProtocol(entry)` aus `ConnectionService`.
- Produces (HTTP, von Task 7a/7b genutzt):
  - `POST /api/connections/:id/reconnect`, Body `{ displayDpi? }` → `200 { sessionId, generation }`; Fehler `{ code, message }` mit `code ∈ {403, 404, 409, 410, 500}`; Validierungsfehler `400 { message }`; Limiter `429 { code: 429, message }`.
  - `GET /api/connections` und `GET /api/connections/:id` enthalten `generation`.
  - `DELETE /api/connections/:id`: fremde Sitzung oder fremder Tombstone → `404`; eigener Tombstone wird verworfen.
  - Controller: `reconnectSession(accountId, sessionId, { displayDpi, ipAddress, userAgent }) → Promise<{ sessionId, generation } | { code, message }>`, `deleteSession(accountId, sessionId)`, `hibernateSession(accountId, sessionId)`, `resumeSession(accountId, sessionId, tabId, browserId)` (fremde Sitzung → `404`).
  - `AUDIT_ACTIONS.RECONNECT = "entry.reconnect"`; Präferenz `terminal.autoReconnect: boolean`.

**Design:** kein UI-Anteil.

**Tests:** 8 Tests. `reconnectSession.test.js` (7, Controller-Ebene mit echtem SessionManager, Fakes nur für DB/Rechte/Verbindungsaufbau): Spec 2 (gespeicherte Konfiguration inkl. Review Focus 2 `tabId`/`browserId`), Spec 4 (Gleichzeitigkeit), Spec 5 (+ Rechte entzogen → 403, SEC-IDOR-01/SEC-RBAC-01), Spec 6 (Audit), Spec 8 (409), Review Focus 1 (Karenz), Review Focus 3 (DELETE fremder Tombstone). `validations.test.js` +1 (Reconnect-Body nur `displayDpi`, SEC-INPUT-01). Nicht getestet: Rate-Limiter (Framework-Zusage), Route-Weiterreichung, `terminal.autoReconnect`-Schema (Joi-Zusage; Spec-Test 7 entfällt laut Entscheidung 2026-10-05).

**Parallel:** Task 3, Task 6 (keine gemeinsamen Dateien; braucht nur Task 2).

- [ ] **Step 1: Failing tests schreiben**

`server/lib/__tests__/reconnectSession.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const Entry = require("../../models/Entry");
const entryController = require("../../controllers/entry");
const identityResolver = require("../../utils/identityResolver");
const permission = require("../../utils/permission");
const audit = require("../../controllers/audit");
const ConnectionService = require("../ConnectionService");
const stateBroadcaster = require("../StateBroadcaster");
const SessionManager = require("../SessionManager");

// Patched before the controller is required: it destructures these at load time.
let accessAllowed = true;
let beforeAccessCheck = async () => {};
const auditCalls = [];
const connectCalls = [];
entryController.validateEntryAccess = async () => { await beforeAccessCheck(); return { valid: accessAllowed }; };
identityResolver.resolveIdentity = async (entry, identityId, directIdentity) =>
    ({ identity: directIdentity ? { isDirect: true } : { id: identityId } });
permission.hasAccountPermission = async () => true;
audit.createAuditLog = async (entry) => { auditCalls.push(entry); return 900 + auditCalls.length; };
audit.getOrganizationAuditSettingsInternal = async () => null;
ConnectionService.createConnectionForSession = async (sessionId) => { connectCalls.push(sessionId); return { success: true }; };
stateBroadcaster.broadcast = () => {};

const { reconnectSession, deleteSession, hibernateSession, resumeSession } = require("../../controllers/serverSession");

Entry.findByPk = async (id) => (id === 101
    ? { id: 101, type: "server", organizationId: null, renderer: "terminal", config: { protocol: "ssh", ip: "10.0.0.1" } }
    : null);

const ACCOUNT = 7;
const request = { ipAddress: "10.0.0.9", userAgent: "test" };

const sshConfiguration = () => ({
    identityId: 3, type: null, directIdentity: null, scriptId: null, startPath: null,
    tmuxSession: "claude", tmuxCreate: false, tmuxWindowId: null, displayDpi: null,
    renderer: "terminal", directTarget: null, protocol: "ssh",
});

const liveSession = () => SessionManager.create(ACCOUNT, 101, sshConfiguration(), "maintenance", "tab-1", "browser-1", 11, null);

const retired = async (configuration = sshConfiguration(), entryId = 101) => {
    const session = SessionManager.create(ACCOUNT, entryId, configuration, "maintenance", "tab-1", "browser-1", 11, null);
    await SessionManager.remove(session.sessionId, { code: 4017, reason: "Connection lost" });
    return session.sessionId;
};

test("Reconnect liefert dieselbe ID mit nächster Generation und der gespeicherten Konfiguration", async () => {
    const id = await retired();
    assert.deepStrictEqual(await reconnectSession(ACCOUNT, id, { ...request, displayDpi: 144 }), { sessionId: id, generation: 2 });
    const session = SessionManager.get(id);
    assert.strictEqual(session.engineSessionId, `${id}:2`);
    assert.strictEqual(session.connectionReason, "maintenance");
    assert.strictEqual(session.configuration.tmuxSession, "claude");
    assert.strictEqual(session.configuration.tmuxCreate, true);
    assert.strictEqual(session.configuration.displayDpi, 144);
    assert.deepStrictEqual([session.tabId, session.browserId], ["tab-1", "browser-1"]);
    assert.strictEqual(SessionManager.getTombstone(id), null);
    assert.ok(connectCalls.includes(id));

    const directIdentity = { type: "password", username: "u", password: "p" };
    const directTarget = { host: "10.0.0.5", port: 22, protocol: "ssh" };
    const directId = await retired({ ...sshConfiguration(), identityId: null, tmuxSession: null, directIdentity, directTarget }, null);
    assert.strictEqual((await reconnectSession(ACCOUNT, directId, request)).generation, 2);
    assert.deepStrictEqual(SessionManager.get(directId).configuration.directIdentity, directIdentity);
    assert.deepStrictEqual(SessionManager.get(directId).configuration.directTarget, directTarget);

    await SessionManager.remove(id);
    await SessionManager.remove(directId);
});

test("zwei gleichzeitige Reconnects ergeben genau eine neue Sitzung", async () => {
    const id = await retired();
    const before = connectCalls.length;
    const [a, b] = await Promise.all([reconnectSession(ACCOUNT, id, request), reconnectSession(ACCOUNT, id, request)]);
    assert.deepStrictEqual(a, { sessionId: id, generation: 2 });
    assert.deepStrictEqual(b, a);
    assert.strictEqual(connectCalls.length - before, 1);
    await SessionManager.remove(id);
});

test("Reconnect lehnt ab: fremdes Konto 404, Rechte entzogen 403, abgelaufen 410", async (t) => {
    const id = await retired();
    assert.strictEqual((await reconnectSession(8, id, request)).code, 404);

    accessAllowed = false;
    try {
        assert.strictEqual((await reconnectSession(ACCOUNT, id, request)).code, 403);
    } finally {
        accessAllowed = true;
    }
    assert.ok(SessionManager.getTombstone(id), "eine Ablehnung verbraucht den Tombstone nicht");

    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    t.mock.timers.tick(SessionManager.TOMBSTONE_TTL_MS + 1);
    assert.strictEqual((await reconnectSession(ACCOUNT, id, request)).code, 410);
    assert.strictEqual((await reconnectSession(ACCOUNT, "00000000-0000-4000-8000-000000000000", request)).code, 410);

    const raced = await retired();
    beforeAccessCheck = () => SessionManager.removeAllByAccountId(ACCOUNT);
    try {
        assert.strictEqual((await reconnectSession(ACCOUNT, raced, request)).code, 410);
    } finally {
        beforeAccessCheck = async () => {};
    }
    assert.ok(!SessionManager.get(raced), "logout during a reconnect leaves no live generation");
});

test("Reconnect schreibt entry.reconnect ins Audit-Log und hängt die neue Generation daran", async () => {
    const id = await retired();
    await reconnectSession(ACCOUNT, id, request);
    const entry = auditCalls.at(-1);
    assert.strictEqual(entry.action, "entry.reconnect");
    assert.strictEqual(entry.action, audit.AUDIT_ACTIONS.RECONNECT);
    assert.deepStrictEqual(
        { resource: entry.resource, resourceId: entry.resourceId, details: entry.details, ipAddress: entry.ipAddress },
        { resource: "entry", resourceId: 101, details: { reconnectOf: id, generation: 2, connectionReason: "maintenance" }, ipAddress: "10.0.0.9" },
    );
    assert.strictEqual(SessionManager.get(id).auditLogId, 900 + auditCalls.length);
    await SessionManager.remove(id);
});

test("lebt die Sitzung noch, antwortet Reconnect 409 und ändert nichts", async () => {
    const session = liveSession();
    const audits = auditCalls.length;
    const connects = connectCalls.length;
    assert.strictEqual((await reconnectSession(ACCOUNT, session.sessionId, request)).code, 409);
    assert.strictEqual(SessionManager.get(session.sessionId), session);
    assert.strictEqual(session.generation, 1);
    assert.strictEqual(auditCalls.length, audits);
    assert.strictEqual(connectCalls.length, connects);
    await SessionManager.remove(session.sessionId);
});

test("ein Reconnect während der Karenz wartet deren Ausgang ab", async () => {
    const session = liveSession();
    SessionManager.beginCloseGrace(session.sessionId, 1);
    const pending = reconnectSession(ACCOUNT, session.sessionId, request);
    await SessionManager.remove(session.sessionId, { code: 4017, reason: "Connection lost", generation: 1 });
    assert.deepStrictEqual(await pending, { sessionId: session.sessionId, generation: 2 });
    await SessionManager.remove(session.sessionId);

    const ended = liveSession();
    SessionManager.beginCloseGrace(ended.sessionId, 1);
    const endedPending = reconnectSession(ACCOUNT, ended.sessionId, request);
    await SessionManager.remove(ended.sessionId, { generation: 1 });
    assert.deepStrictEqual(await endedPending, { code: 404, message: "Session ended" });
});

test("fremde Konten können weder löschen noch schlafen legen noch fortsetzen; DELETE gewinnt gegen laufenden Reconnect", async () => {
    const id = await retired();
    assert.strictEqual((await deleteSession(8, id)).code, 404);
    assert.ok(SessionManager.getTombstone(id));
    assert.deepStrictEqual(await deleteSession(ACCOUNT, id), { message: "Session deleted" });
    assert.strictEqual(SessionManager.getTombstone(id), null);

    const racing = await retired();
    const pending = reconnectSession(ACCOUNT, racing, request);
    await deleteSession(ACCOUNT, racing);
    assert.strictEqual((await pending).code, 410);
    assert.strictEqual(SessionManager.get(racing), null);

    const live = liveSession();
    assert.strictEqual(hibernateSession(8, live.sessionId).code, 404);
    assert.strictEqual(resumeSession(8, live.sessionId, "evil-tab", "evil-browser").code, 404);
    assert.deepStrictEqual([live.isHibernated, live.tabId, live.browserId], [false, "tab-1", "browser-1"]);
    await SessionManager.remove(live.sessionId);
});
```

In `server/lib/__tests__/validations.test.js` Z. 4 ersetzen durch:
```js
const { createSessionValidation, reconnectSessionValidation } = require("../../validations/serverSession");
```
und am Dateiende anfügen:
```js
test("reconnect: der Body kennt nur displayDpi im erlaubten Bereich", () => {
    assert.strictEqual(reconnectSessionValidation.validate({}).error, undefined);
    assert.strictEqual(reconnectSessionValidation.validate({ displayDpi: 144 }).error, undefined);
    for (const body of [{ displayDpi: 1000 }, { displayDpi: 1.5 }, { tmuxSession: "x" }, { directIdentity: {} }]) {
        assert.ok(reconnectSessionValidation.validate(body).error, `expected refusal for ${JSON.stringify(body)}`);
    }
});
```

- [ ] **Step 2: Tests laufen lassen, Fehlschlag prüfen**

Run: `cd /root/outpost && node --test server/lib/__tests__/reconnectSession.test.js server/lib/__tests__/validations.test.js`
Expected: FAIL — `reconnectSession is not a function`, `reconnectSessionValidation` undefined.

- [ ] **Step 3: Validierungen und Audit**

`server/validations/serverSession.js` am Ende anfügen:
```js
module.exports.reconnectSessionValidation = Joi.object({
    displayDpi: Joi.number().integer().min(48).max(480).optional(),
});
```

`server/validations/preferences.js`, in `terminalSchema` nach `keyBar: ...` (Z. 10) einfügen:
```js
    autoReconnect: Joi.boolean(),
```

`server/controllers/audit.js`: in `AUDIT_ACTIONS` nach `DEMO_CONNECT: "entry.demo_connect",` (Z. 32):
```js
    RECONNECT: "entry.reconnect",
```
in `ACTION_LABELS` nach `"entry.demo_connect": "Demo connection",` (Z. 85):
```js
    "entry.reconnect": "Session reconnected",
```
(`shouldAudit` braucht keine Änderung: `entry.reconnect` beginnt mit `entry.` und enthält weder `create`, `update` noch `delete` → `enableServerConnectionAudit`, `server/controllers/audit.js:166`.)

- [ ] **Step 4: `openSession` als gemeinsamer Kern**

`server/controllers/serverSession.js` Z. 2:
```js
const { createConnectionForSession, getEntryProtocol } = require("../lib/ConnectionService");
```

`createSession` (Z. 82-205) vollständig ersetzen durch:

```js
const openSession = async ({
    accountId, entryId = null, identityId = null, connectionReason = null, type = null, directIdentity = null,
    tabId = null, browserId = null, scriptId = null, startPath = null, ipAddress = null, userAgent = null,
    tmuxSession = null, tmuxCreate = false, tmuxWindowId = null, directTarget = null, displayDpi = null,
    reconnectOf = null,
}) => {
    const reconnecting = reconnectOf !== null;

    const stillClaimable = () => {
        const claimed = SessionManager.getTombstone(reconnectOf.sessionId);
        return claimed && claimed.accountId === accountId && claimed.generation + 1 === reconnectOf.generation
            && !SessionManager.get(reconnectOf.sessionId);
    };

    // Two ways in. The direct one has no entry behind it, so it cannot lean on
    // per-entry access rules and carries its own permission instead.
    let entry;
    if (directTarget) {
        if (!(await hasAccountPermission(accountId, Permission.CONNECT_DIRECT))) {
            return { code: 403, message: "Access denied" };
        }

        if (!reconnecting && !connectionReason && await directConnectionReasonRequired(accountId)) {
            return { code: 400, message: "Connection reason required" };
        }

        entry = buildTransientEntry(directTarget);
    } else {
        entry = await Entry.findByPk(entryId);
        if (!entry) {
            return { code: 404, message: "Entry not found" };
        }

        const requiredPermission = getRequiredConnectPermission(entry, type, scriptId);
        const accessResult = await validateEntryAccess(accountId, entry, "Access denied", requiredPermission);
        if (!accessResult.valid) {
            return { code: 403, message: "Access denied" };
        }

        if (directIdentity && entry.type?.startsWith('pve-')) {
            return { code: 400, message: "Direct connections are not supported for Proxmox entries" };
        }

        if (!reconnecting && entry.organizationId) {
            const auditSettings = await getOrganizationAuditSettingsInternal(entry.organizationId);
            if (auditSettings?.requireConnectionReason && !connectionReason) {
                return { code: 400, message: "Connection reason required" };
            }
        }
    }

    if (tmuxSession && directIdentity) {
        return { code: 400, message: "tmux sessions are not supported with a direct identity" };
    }

    const result = await resolveIdentity(entry, identityId, directIdentity, accountId);
    const identity = result?.identity !== undefined ? result.identity : result;

    if (result.accessDenied) {
        return { code: 403, message: "You don't have access to this identity" };
    }

    if (result.requiresIdentity && !identity) {
        return { code: reconnecting ? 404 : 400, message: "Identity not found" };
    }

    if (tmuxSession && !tmuxCreate) {
        const listingStartedAt = Date.now();
        const listing = await getTmuxSessions(accountId, entryId, identityId);
        logger.debug("tmux allowlist lookup", {
            entryId, durationMs: Date.now() - listingStartedAt,
            sessions: listing?.sessions?.length ?? 0, code: listing?.code ?? 200,
        });
        if (listing?.code) return listing;
        if (!listing.available) {
            return { code: 400, message: "tmux is not available on this host" };
        }
        if (!isAllowedSession(tmuxSession, listing.sessions)) {
            return { code: 400, message: "Unknown tmux session" };
        }
    }

    if (reconnecting && !stillClaimable()) return { code: 410, message: "Session expired" };

    const auditLogId = await createAuditLog({
        accountId,
        organizationId: entry.organizationId,
        action: reconnecting ? AUDIT_ACTIONS.RECONNECT : getAuditAction(entry, scriptId),
        resource: scriptId ? RESOURCE_TYPES.SCRIPT : RESOURCE_TYPES.ENTRY,
        resourceId: scriptId || entry.id,
        // A direct connection has no entry to point at, so the target itself is
        // the record. Without this the audit trail would show an account
        // connecting somewhere with no way to learn where.
        details: {
            ...(reconnecting && { reconnectOf: reconnectOf.sessionId, generation: reconnectOf.generation }),
            connectionReason,
            ...(scriptId && { serverId: entry.id }),
            ...(directTarget && { directTarget: `${directTarget.host}:${directTarget.port}`, protocol: directTarget.protocol }),
        },
        ipAddress,
        userAgent,
    });

    const configuration = {
        identityId: identity ? identity.id : null,
        type: type || null,
        directIdentity: directIdentity || null,
        scriptId: scriptId || null,
        startPath: startPath || null,
        tmuxSession: tmuxSession || null,
        tmuxCreate: Boolean(tmuxCreate),
        tmuxWindowId: tmuxWindowId || null,
        displayDpi: displayDpi || null,
        renderer: type === "sftp" ? "sftp" : entry.renderer,
        // Carried on the session so ConnectionService can rebuild the same
        // transient entry later; there is no row to load it back from.
        directTarget: directTarget || null,
        protocol: getEntryProtocol(entry),
    };

    // Claimed right before create, not after it: a connection that fails fast would otherwise leave
    // the new generation's tombstone behind for this line to delete. Re-read here because DELETE,
    // logout or entry deletion may have dropped it during the awaits above.
    if (reconnecting) {
        if (!stillClaimable()) return { code: 410, message: "Session expired" };
        SessionManager.consumeFailedReason(reconnectOf.sessionId);
        SessionManager.dropTombstone(reconnectOf.sessionId);
    }

    const session = SessionManager.create(accountId, entryId ?? null, configuration, connectionReason, tabId, browserId, auditLogId, entry.organizationId,
        reconnecting ? { sessionId: reconnectOf.sessionId, generation: reconnectOf.generation } : {});
    const { sessionId, generation } = session;

    stateBroadcaster.broadcast("CONNECTIONS", { accountId });
    if (entry.organizationId) stateBroadcaster.broadcast("LIVE_SESSIONS", { organizationId: entry.organizationId });

    createConnectionForSession(sessionId, accountId)
        .then(() => {
            logger.info("Session connection established", { sessionId, generation, entryId, type: entry.type });
        })
        .catch((error) => {
            logger.error("Failed to create connection for session", {
                sessionId,
                generation,
                error: error.message,
                stack: error.stack
            });
            SessionManager.markFailed(sessionId, error.message, generation);
            SessionManager.remove(sessionId, { code: 4017, reason: error.message, generation });
        });

    return { sessionId, generation };
};

const createSession = async (accountId, entryId, identityId, connectionReason, type = null, directIdentity = null, tabId = null, browserId = null, scriptId = null, startPath = null, ipAddress = null, userAgent = null, tmuxSession = null, tmuxCreate = false, tmuxWindowId = null, directTarget = null, { displayDpi = null } = {}) => {
    const result = await openSession({
        accountId, entryId, identityId, connectionReason, type, directIdentity, tabId, browserId, scriptId, startPath,
        ipAddress, userAgent, tmuxSession, tmuxCreate, tmuxWindowId, directTarget, displayDpi,
    });
    return result.code ? result : { sessionId: result.sessionId };
};

const reconnectOperations = new Map();

const runReconnect = async (accountId, sessionId, { displayDpi = null, ipAddress = null, userAgent = null }) => {
    const live = SessionManager.get(sessionId);
    if (live) {
        if (!live._removing && !live._closeGrace) return { code: 409, message: "Session is still connected" };
        await SessionManager.whenEnded(sessionId);
        if (SessionManager.get(sessionId)) return { code: 409, message: "Session is still connected" };
        if (!SessionManager.getTombstone(sessionId)) return { code: 404, message: "Session ended" };
    }

    const tombstone = SessionManager.getTombstone(sessionId);
    if (!tombstone || tombstone.accountId !== accountId) return { code: 410, message: "Session expired" };

    const { configuration } = tombstone;
    return openSession({
        accountId,
        entryId: tombstone.entryId,
        identityId: configuration.identityId,
        connectionReason: tombstone.connectionReason,
        type: configuration.type,
        directIdentity: configuration.directIdentity,
        tabId: tombstone.tabId,
        browserId: tombstone.browserId,
        startPath: configuration.startPath,
        ipAddress,
        userAgent,
        tmuxSession: configuration.tmuxSession,
        tmuxCreate: Boolean(configuration.tmuxSession),
        tmuxWindowId: configuration.tmuxWindowId,
        directTarget: tombstone.directTarget,
        displayDpi: displayDpi ?? configuration.displayDpi,
        reconnectOf: { sessionId, generation: tombstone.generation + 1 },
    });
};

const reconnectSession = (accountId, sessionId, options = {}) => {
    const owner = SessionManager.get(sessionId)?.accountId ?? SessionManager.getTombstone(sessionId)?.accountId;
    if (owner !== undefined && owner !== accountId) return Promise.resolve({ code: 404, message: "Session not found" });

    let operation = reconnectOperations.get(sessionId);
    if (!operation) {
        operation = runReconnect(accountId, sessionId, options).finally(() => reconnectOperations.delete(sessionId));
        reconnectOperations.set(sessionId, operation);
    }
    return operation;
};
```

`reconnectSession` ist absichtlich nicht `async`: der Eintrag in `reconnectOperations` muss synchron vor jedem `await` stehen, sonst laufen zwei gleichzeitige Aufrufe doppelt. `tmuxSession` stammt ausschließlich aus dem Tombstone (beim Anlegen validiert) und läuft weiter durch `isValidAttachName` und das Quoting in `server/lib/tmux/commands.js` (SEC-INJECT-01).

- [ ] **Step 5: `getSessions`, `getSession`, `deleteSession`**

In `getSessions` im zurückgegebenen Objekt (Z. 237-250) nach `sessionId: session.sessionId,`:
```js
            generation: session.generation,
```

In `getSession` (Z. 314-326) nach `id: session.sessionId,`:
```js
        generation: session.generation,
```

`hibernateSession` und `resumeSession` (Z. 254-268) ersetzen durch:
```js
const hibernateSession = (accountId, sessionId) => {
    if (SessionManager.get(sessionId)?.accountId !== accountId) return { code: 404, message: "Session not found" };
    SessionManager.hibernate(sessionId);
    return { message: "Session hibernated" };
};

const resumeSession = (accountId, sessionId, tabId = null, browserId = null) => {
    if (SessionManager.get(sessionId)?.accountId !== accountId) return { code: 404, message: "Session not found" };
    SessionManager.resume(sessionId, tabId, browserId);
    return { message: "Session resumed" };
};
```

`deleteSession` (Z. 270-276) ersetzen durch:
```js
const deleteSession = async (accountId, sessionId) => {
    const live = SessionManager.get(sessionId);
    if (live && live.accountId !== accountId) return { code: 404, message: "Session not found" };

    const removed = live ? await SessionManager.remove(sessionId) : false;
    await SessionManager.whenEnded(sessionId);
    const tombstone = SessionManager.getTombstone(sessionId);
    const dropped = tombstone?.accountId === accountId && SessionManager.dropTombstone(sessionId);

    if (removed || dropped) return { message: "Session deleted" };
    return { code: 404, message: "Session not found" };
};
```

Exporte Z. 443:
```js
module.exports = { createSession, reconnectSession, getSessions, getSession, hibernateSession, resumeSession, deleteSession, startSharing, stopSharing, updateSharePermissions, duplicateSession, pasteIdentityPassword, directConnectionReasonRequired };
```

- [ ] **Step 6: Route, Limiter, DELETE**

`server/routes/serverSession.js` Z. 2:
```js
const { createSession, reconnectSession, getSessions, getSession, hibernateSession, resumeSession, deleteSession, startSharing, stopSharing, updateSharePermissions, duplicateSession, pasteIdentityPassword } = require("../controllers/serverSession");
```
Z. 4:
```js
const { createSessionValidation, sessionIdValidation, resumeSessionValidation, duplicateSessionValidation, reconnectSessionValidation } = require("../validations/serverSession");
```
Nach Z. 6 einfügen:
```js
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
```
Nach Z. 8 (`const app = Router();`) einfügen:
```js
// Keyed on account and session (bookmarkRateLimiter.js keys on the account); ipKeyGenerator is required by express-rate-limit 8 for IPv6.
const reconnectLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    keyGenerator: (req) => (req.user ? `acc:${req.user.id}:${req.params.id}` : `ip:${ipKeyGenerator(req.ip)}`),
    message: { code: 429, message: "Too many reconnect attempts. Please try again in a moment." },
    standardHeaders: true,
    legacyHeaders: false,
});
```

DELETE (Z. 131):
```js
    const result = await deleteSession(req.user.id, req.params.id);
```

hibernate- und resume-Route:
```js
    const result = await hibernateSession(req.user.id, req.params.id);
```
```js
    const result = await resumeSession(req.user.id, req.params.id, tabId, browserId);
```
`result.code` wird wie in den übrigen Routen behandelt.

Nach der DELETE-Route (nach Z. 137) einfügen:
```js
/**
 * POST /connections/{id}/reconnect
 * @summary Reconnect Connection
 * @description Rebuilds a connection that ended with an error under the same session id and the next generation, using the configuration stored when it ended.
 * @tags Connection
 * @produces application/json
 * @security BearerAuth
 * @param {string} id.path.required - Session ID
 * @return {object} 200 - Session id and generation
 */
app.post("/:id/reconnect", reconnectLimiter, async (req, res) => {
    if (validateSchema(res, sessionIdValidation, req.params)) return;
    if (validateSchema(res, reconnectSessionValidation, req.body ?? {})) return;

    try {
        const result = await reconnectSession(req.user.id, req.params.id, {
            displayDpi: req.body?.displayDpi,
            ipAddress: req.ip || req.socket?.remoteAddress || 'unknown',
            userAgent: req.headers['user-agent'] || 'unknown',
        });
        if (result?.code) return res.status(result.code).json({ code: result.code, message: result.message });
        res.json(result);
    } catch (error) {
        console.error('Error reconnecting session:', error);
        res.status(500).json({ code: 500, message: 'Internal server error' });
    }
});
```

Die Route hängt unter `app.use("/api/connections", authenticate, …)` (`server/index.js:89`) — gültige Login-Sitzung ist Pflicht (SEC-SESS-02, SEC-TOKEN-01). Antworten tragen nur feste Texte, nie `error.message` oder Stacks (SEC-ERR-01).

- [ ] **Step 7: Tests laufen lassen**

Run: `cd /root/outpost && node --test server/lib/__tests__/reconnectSession.test.js server/lib/__tests__/validations.test.js server/lib/__tests__/directConnectReason.test.js server/lib/__tests__/directConnect.test.js server/lib/__tests__/identityAccessDenied.test.js`
Expected: alle PASS.

- [ ] **Step 8: Lint**

Run: `cd /root/outpost && yarn lint`
Expected: keine Errors.

- [ ] **Step 9: Commit**

```bash
git add server/controllers/serverSession.js server/routes/serverSession.js server/validations/serverSession.js server/validations/preferences.js server/controllers/audit.js server/lib/__tests__/reconnectSession.test.js server/lib/__tests__/validations.test.js
git commit -m "Reconnect: Endpunkt baut die Sitzung aus dem Tombstone neu auf, DELETE prüft den Besitz"
```

---

### Phasenende B

- [ ] Worktree-Branches von Task 3, 4 und 6 mergen.
- [ ] Volle Suite: `cd /root/outpost && yarn test` → alle grün.
- [ ] Review-Kette einmal: `/code-review` auf den Phasen-Diff; `footgun` auf `server/lib/ConnectionService.js`, `server/lib/GuacdClient.js`, `server/lib/engineEvents.js`, `server/controllers/serverSession.js`, `server/routes/serverSession.js`; `/design-verify --screen UI-SERVERS` (erwartet: `UI-SERVERS-VIEW-ERROR` und `UI-SERVERS-TAB-CONNECTION` auf Tier A auffindbar; die Verdrahtung folgt in Phase C, Befunde zum *Zeigen* der Karte daher erst dort werten).
- [ ] Nach dem Merge Image neu bauen: `gh workflow run container-image.yml --ref feature/reconnect -f tag=test`, abwarten (`gh run watch`), auf outpost-test einspielen. Früher Rauchtest: telnet- und pve-lxc-Sitzung je einmal mit `exit` beenden und einmal hart trennen; Reconnect per API auslösen (`curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}' https://<outpost-test>/api/connections/<sessionId>/reconnect`) → nach `exit` `410` bzw. `404 Session ended`, nach hartem Trennen `200 { generation: 2 }`. Abweichung → Befund an Task 1/3/4, vor Phase C beheben.
- [ ] Zwischenstand: Server erkennt Abbrüche korrekt, legt Tombstones an und baut per Endpunkt neu auf; Oberfläche steht; offen: Verdrahtung.

---

## Phase C — Verdrahtung (parallel: Task 7a, Task 7b)

### Task 7a: Client — Renderer melden nur noch, Popout und Share zeigen die Fehlerkarte

**Files:**
- Modify: `.../renderer/XtermRenderer.jsx` (Props Z. 43, Zustand Z. 93, Effekt Z. 398-401, `reportError` Z. 613-616, `onclose`/`onerror` Z. 679-698, `onmessage` Z. 709-712, Render Z. 980-982, Import Z. 21 nach Task 5)
- Modify: `.../renderer/GuacamoleRenderer.jsx` (Props Z. 38-48, Z. 92-102, Instruktionen Z. 538-540, Zustandswechsel Z. 622-645, Render Z. 763-765, Import Z. 10 nach Task 5)
- Modify: `client/src/pages/Popout/Popout.jsx` (ganze Datei), `client/src/pages/Popout/styles.sass`
- Modify: `client/src/pages/Share/Share.jsx`

**Interfaces:**
- Consumes (Task 5): `classifyConnectionError`, `isReconnectEligible`, `requestReconnect`, `shouldRecordError`; (Task 6): `ConnectionError`-Props; (Task 4, bereits gemergt): `POST /connections/:id/reconnect` → `200 { sessionId, generation }` oder Fehlerkörper `{ code, message }`; `GET /connections/:id` liefert `generation`.
- Produces (Vertrag mit Task 7b): Renderer-Props
  - `markSessionErrored(sessionId, { message, retryable, reconnectable, generation })`
  - `markSessionConnected?(sessionId)` — Xterm beim ersten Datenpaket, Guacamole bei `CONNECTED`
  - `disconnectFromServer(sessionId, generation)`
  - `getSessionError(sessionId) → string|null` (unverändert, nur beim Mount gelesen)
  - Renderer rendern **keine** `ConnectionError` mehr.

**Design:**
- Screen: `UI-SERVERS` — Artboard `docs/design/mockups/ui-servers.html`
- Zu bauende Elemente (Werte wörtlich übernehmen):

| ID | Element | Fachlicher Anker | Zustände | Copy |
|----|---------|------------------|----------|------|
| UI-SERVERS-VIEW-ERROR | Verbindungsfehler | Die Karte, die in der Arbeitsfläche an die Stelle einer abgebrochenen Session tritt: Icon, Titel, Fehlertext im Klartext, darunter eine Knopfzeile. Primär Neu verbinden (während der Automatik Jetzt verbinden), sekundär Schließen. Läuft die Automatik, steht über den Knöpfen der Countdown mit Versuchszähler. Neu verbinden baut dieselbe Session im selben Tab und an derselben Stelle im Layout wieder auf; es öffnet keinen neuen Tab. Nicht: server_entry, server_dialog. | default, countdown, loading, final, expired | default „Verbindung verloren. Neu verbinden oder schließen.“ · countdown „Neuer Versuch in 8 s · Versuch 2/5“ · loading „Verbinde neu …“ · final „Anmeldung abgelehnt. Zugangsdaten prüfen, dann neu verbinden. — Nach RDP-Abmelden oder -Trennung nur Schließen.“ · expired „Sitzung abgelaufen. Öffne den Server neu.“ |

- Locator: jedes Element trägt `data-ui-id="<ID>"`.
- Tokens: `--subtext`, `--primary`, `--error`, `--terminal` aus `docs/design/mockups/tokens.css` (im Code über `client/src/common/styles/_colors.sass`).
- Dieser Task zeigt die in Task 6 gebaute Karte in Popout und Share; keine neue Optik.

**Tests:** keine neuen — reine Verdrahtung; Guacamole-Client in jsdom ist ohne großen Doppelaufwand nicht sinnvoll testbar. Abgesichert durch den bestehenden `XtermRenderer.test.jsx`, die Klassifizierungstests (Task 5) und die manuelle Prüfung (Task 8: RDP mit getrenntem VM-Netz, Popout, Share).

**Parallel:** Task 7b (keine gemeinsamen Dateien; Vertrag zu Task 4 ist bereits gemergt).

- [ ] **Step 1: XtermRenderer**

Import (Z. 21 nach Task 5, zwei Zeilen) ersetzen durch:
```js
import { classifyConnectionError } from "@/common/utils/ConnectionErrorUtil.js";
```

Props Z. 43: nach `getSessionError,` ergänzen `markSessionConnected,`.

Z. 93 (`const [connectionError, setConnectionError] = useState(...)`) löschen. Im Effekt Z. 401 die Zeile `setConnectionError(null);` löschen.

`reportError` (Z. 613-616) ersetzen durch:
```js
        const reportError = (message, code = null) => {
            const { text, retryable, reconnectable } = classifyConnectionError({ message, code }, t);
            markSessionErrored?.(session.id, { message: text, retryable, reconnectable, generation: session.generation ?? 1 });
        };
```

In `ws.onclose` den Block Z. 684-690 ersetzen durch:
```js
            if (event.code >= 4000 && event.reason) {
                reportError(event.reason, event.code);
            } else if (event.code !== 1000 && event.code !== 1005) {
                reportError(null, event.code);
            } else {
                disconnectFromServer(session.id, session.generation ?? 1);
            }
```

In `ws.onerror` Z. 696 `reportError(t("common.errors.connection.error"));` ersetzen durch `reportError(null);`.

In `ws.onmessage` den Block Z. 709-712 ersetzen durch:
```js
            if (!hostSpoke) {
                hostSpoke = true;
                lastSentSize = null;
                markSessionConnected?.(session.id);
            }
```

Render Z. 980-982 (`{connectionError && (<ConnectionError … />)}`) löschen.

- [ ] **Step 2: GuacamoleRenderer**

Import (Z. 10 nach Task 5, zwei Zeilen) ersetzen durch:
```js
import { classifyConnectionError } from "@/common/utils/ConnectionErrorUtil.js";
```

Props (Z. 38-48): nach `getSessionError,` ergänzen `markSessionConnected,`.

Z. 92-102 ersetzen durch:
```js
    const errorMessageRef = useRef(null);
    const errorStatusRef = useRef(null);
    const wasConnectedRef = useRef(false);
    const errorShownRef = useRef(!!getSessionError?.(session.id));

    const reportError = (rawMessage, statusCode = null) => {
        if (errorShownRef.current) return;
        errorShownRef.current = true;
        const { text, retryable, reconnectable } = classifyConnectionError({ message: rawMessage, statusCode }, t);
        markSessionErrored?.(session.id, { message: text, retryable, reconnectable, generation: session.generation ?? 1 });
    };
```

Z. 538-540 ersetzen durch:
```js
            if (opcode === "error" && args?.length) {
                errorMessageRef.current = args[0] || "Connection failed";
                errorStatusRef.current = args[1] ?? null;
            }
```

`client.onstatechange` und `tunnel.onstatechange`/`tunnel.onerror` (Z. 622-645) ersetzen durch:
```js
        const reportClosed = () => {
            if (errorShownRef.current) return;
            if (errorMessageRef.current) reportError(errorMessageRef.current, errorStatusRef.current);
            else if (wasConnectedRef.current) reportError("Connection lost");
            else disconnectFromServer(s.id, s.generation ?? 1);
        };
        client.onstatechange = (st) => {
            if (isCleaningUp) return;
            if (st === Guacamole.Client.State.CONNECTED) {
                wasConnectedRef.current = true;
                markSessionConnected?.(s.id);
                lastSentRef.current = { w: 0, h: 0, monitor: -1, at: 0 };
                confirmAttemptsRef.current = 0;
                resizeHandler();
            }
            if (st === Guacamole.Client.State.DISCONNECTED || st === Guacamole.Client.State.ERROR) reportClosed();
        };
        tunnel.onstatechange = (st) => {
            if (isCleaningUp || st !== Guacamole.Tunnel.State.CLOSED) return;
            reportClosed();
        };
        tunnel.onerror = (status) => {
            if (isCleaningUp) return;
            reportError(status?.message || errorMessageRef.current || null, errorStatusRef.current);
        };
```

Render Z. 763-765 (`{connectionError && (<ConnectionError … />)}`) löschen.

- [ ] **Step 3: Popout mit eigenem Zustand**

`client/src/pages/Popout/Popout.jsx` vollständig ersetzen durch:

```jsx
import "./styles.sass";
import { useEffect, useState, useRef, useContext, useCallback } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { UserContext } from "@/common/contexts/UserContext.jsx";
import { getRequest } from "@/common/utils/RequestUtil";
import { isReconnectEligible, requestReconnect } from "@/common/utils/ReconnectPolicy.js";
import { shouldRecordError } from "@/pages/Servers/utils/sessionErrors.js";
import GuacamoleRenderer from "@/pages/Servers/components/ViewContainer/renderer/GuacamoleRenderer.jsx";
import XtermRenderer from "@/pages/Servers/components/ViewContainer/renderer/XtermRenderer.jsx";
import ConnectionError from "@/pages/Servers/components/ViewContainer/renderer/components/ConnectionError";
import Loading from "@/common/components/Loading";
import TitleBar from "@/common/components/TitleBar";
import { isTauri } from "@/common/utils/TauriUtil.js";
import { notifyPopoutClosed, onForceClose } from "@/common/utils/PopoutUtil.js";

const noop = () => {};

export const Popout = () => {
    const { sessionId, monitor } = useParams();
    const { t } = useTranslation();
    const { user } = useContext(UserContext);
    const [session, setSession] = useState(null);
    const [loading, setLoading] = useState(true);
    const [connection, setConnection] = useState({ error: null, generation: 1, attachNonce: 0 });
    const [reconnecting, setReconnecting] = useState(false);
    const refs = useRef({});
    const isConnectorMode = isTauri();

    const parsedMonitor = Number.parseInt(monitor, 10);
    const pinnedMonitor = Number.isInteger(parsedMonitor) && parsedMonitor >= 0 ? parsedMonitor : null;

    const titleOf = (name) => pinnedMonitor === null
        ? name : `${name} - ${t("servers.monitors.title", { number: pinnedMonitor + 1 })}`;

    useEffect(() => {
        if (!sessionId || !user) return;
        getRequest(`/connections/${sessionId}`)
            .then(data => {
                setSession(data);
                setConnection(prev => ({ ...prev, generation: data.generation ?? 1 }));
                if (data.server?.name) document.title = `${titleOf(data.server.name)} - Outpost`;
            })
            .finally(() => setLoading(false));
    }, [sessionId, user, pinnedMonitor]);

    useEffect(() => {
        if (isConnectorMode) return;
        const cleanup = () => notifyPopoutClosed(sessionId, pinnedMonitor);
        window.addEventListener("beforeunload", cleanup);
        return () => window.removeEventListener("beforeunload", cleanup);
    }, [sessionId, isConnectorMode, pinnedMonitor]);

    useEffect(() => onForceClose(() => window.close()), []);

    const markSessionErrored = useCallback((_id, error) => {
        setConnection(prev => (shouldRecordError(prev.error, error, prev.generation) ? { ...prev, error } : prev));
    }, []);

    const reconnect = async () => {
        setReconnecting(true);
        try {
            const result = await requestReconnect(sessionId, t);
            if (result.outcome === "reconnected") {
                setConnection(prev => ({ ...prev, error: null, generation: result.generation }));
            } else if (result.outcome === "reattach") {
                setConnection(prev => ({ ...prev, error: null, attachNonce: prev.attachNonce + 1 }));
            } else if (result.outcome === "ended") {
                window.close();
            } else if (result.outcome === "refused") {
                setConnection(prev => ({ ...prev, error: { ...result.error, generation: prev.generation } }));
            }
        } finally {
            setReconnecting(false);
        }
    };

    if (loading) return <Loading />;
    if (!session || session.error) return null;

    const renderer = session.type || session.server?.renderer;
    const closeWindow = () => window.close();
    const fullscreen = () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
    const liveSession = { ...session, generation: connection.generation };
    const rendererKey = `${session.id}-${connection.generation}-${connection.attachNonce}`;
    const getSessionError = () => connection.error?.message ?? null;

    return (
        <div className="popout-container">
            {isConnectorMode && <TitleBar title={titleOf(session.server?.name || "Session")} />}
            {renderer === "guac" && <GuacamoleRenderer key={rendererKey} session={liveSession} disconnectFromServer={closeWindow}
                                                      markSessionErrored={markSessionErrored} getSessionError={getSessionError}
                                                      registerGuacamoleRef={noop} onFullscreenToggle={fullscreen}
                                                      pinnedMonitor={pinnedMonitor} />}
            {renderer === "terminal" && <XtermRenderer key={rendererKey} session={liveSession} disconnectFromServer={closeWindow}
                                                       markSessionErrored={markSessionErrored} getSessionError={getSessionError}
                                                       registerTerminalRef={noop} broadcastMode={false} terminalRefs={refs}
                                                       updateProgress={noop} layoutMode="single" onBroadcastToggle={noop}
                                                       onFullscreenToggle={fullscreen} />}
            {connection.error && (
                <ConnectionError message={connection.error.message} retryable={connection.error.retryable}
                                 expired={connection.error.expired} reconnecting={reconnecting}
                                 reconnectable={connection.error.reconnectable}
                                 onReconnect={isReconnectEligible(session) ? reconnect : undefined}
                                 onClose={closeWindow} />
            )}
        </div>
    );
};
```

`client/src/pages/Popout/styles.sass`, im Block `.popout-container` ergänzen:
```sass
  position: relative
```

- [ ] **Step 4: Share zeigt Fehler weiterhin an**

`client/src/pages/Share/Share.jsx`:

Z. 2: `import { useEffect, useState, useRef, useCallback } from "react";`
Nach Z. 10 einfügen:
```js
import ConnectionError from "@/pages/Servers/components/ViewContainer/renderer/components/ConnectionError";
```
Nach Z. 20 (`const [disconnected, setDisconnected] = useState(false);`) einfügen:
```js
    const [connectionError, setConnectionError] = useState(null);
    const markSessionErrored = useCallback((_id, error) => setConnectionError(prev => prev ?? error), []);
```

Die beiden Renderer-Zeilen Z. 64-65 und das schließende `</div>` ersetzen durch:
```jsx
            {renderer === "guac" && <GuacamoleRenderer session={session} disconnectFromServer={handleDisconnect} markSessionErrored={markSessionErrored} registerGuacamoleRef={noop} onFullscreenToggle={fullscreen} isShared />}
            {renderer === "terminal" && <XtermRenderer session={session} disconnectFromServer={handleDisconnect} markSessionErrored={markSessionErrored} registerTerminalRef={noop} broadcastMode={false} terminalRefs={refs} updateProgress={noop} layoutMode="single" onBroadcastToggle={noop} onFullscreenToggle={fullscreen} isShared />}
            {connectionError && <ConnectionError message={connectionError.message} retryable={false} reconnectable={connectionError.reconnectable} onClose={handleDisconnect} />}
        </div>
```

`.share-container` hat bereits `position: relative` (`client/src/pages/Share/styles.sass`).

- [ ] **Step 5: Tests und Lint**

Run: `cd /root/outpost/client && yarn vitest run src/pages/Servers/components/ViewContainer/renderer/__tests__/XtermRenderer.test.jsx && npx eslint src/pages/Servers/components/ViewContainer/renderer/XtermRenderer.jsx src/pages/Servers/components/ViewContainer/renderer/GuacamoleRenderer.jsx src/pages/Popout src/pages/Share`
Expected: PASS, keine Lint-Errors (kein `no-unused-vars` für entfernte `ConnectionError`/`useState`-Reste).

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/Servers/components/ViewContainer/renderer/XtermRenderer.jsx client/src/pages/Servers/components/ViewContainer/renderer/GuacamoleRenderer.jsx client/src/pages/Popout client/src/pages/Share/Share.jsx
git commit -m "Reconnect: Renderer melden Abbrüche mit Generation, Popout verbindet neu"
```

---

### Task 7b: Client — `Servers.jsx` und `ViewContainer` verdrahten

**Files:**
- Modify: `client/src/pages/Servers/Servers.jsx` (Importe Z. 16-23, Z. 68, Fehlerzustand Z. 95-102, `handleConnectionsUpdate` Z. 136-190, `performConnection` Z. 517, `disconnectFromServer` Z. 689-700, `ViewContainer`-Props Z. 1018-1031)
- Modify: `client/src/pages/Servers/components/ViewContainer/ViewContainer.jsx` (Importe Z. 4-19, Props Z. 62-79, Takt nach Z. 120, Renderer-Props Z. 598-614, `renderAllSessions` Z. 709-728, `ServerTabs` Z. 730-746)

**Interfaces:**
- Consumes (Task 5): `useAutoReconnect`, `requestReconnect`, `shouldRecordError`, `isSuperseded`, `isReconnectEligible`, `getDisplayDpi`; (Task 6): `ConnectionError`-Props, `ServerTabs`-Props `connectionStates`/`onReconnect`, `usePreferences().autoReconnect`; (Task 7a, Vertrag): Renderer-Props `markSessionErrored(id, { message, retryable, reconnectable, generation })`, `markSessionConnected(id)`, `disconnectFromServer(id, generation)`; (Task 4, bereits gemergt): HTTP-Antworten, `generation` in `GET /connections`.
- Produces: Session-Objekte in `activeSessions` tragen `generation` (vom Server) und `attachNonce` (lokal, Start `0`).

**Design:**
- Screen: `UI-SERVERS` — Artboard `docs/design/mockups/ui-servers.html`
- Zu bauende Elemente (Werte wörtlich übernehmen):

| ID | Element | Fachlicher Anker | Zustände | Copy |
|----|---------|------------------|----------|------|
| UI-SERVERS-VIEW | Arbeitsfläche | Der Inhalt der aktiven Session, einzeln oder als Split; Terminal und Datei-Pane nebeneinander sind der Kernfall. Nicht: server_entry. | loading, error (Bestand; error zeigt UI-SERVERS-VIEW-ERROR) | – |
| UI-SERVERS-VIEW-ERROR | Verbindungsfehler | Die Karte, die in der Arbeitsfläche an die Stelle einer abgebrochenen Session tritt: Icon, Titel, Fehlertext im Klartext, darunter eine Knopfzeile. Primär Neu verbinden (während der Automatik Jetzt verbinden), sekundär Schließen. Läuft die Automatik, steht über den Knöpfen der Countdown mit Versuchszähler. Neu verbinden baut dieselbe Session im selben Tab und an derselben Stelle im Layout wieder auf; es öffnet keinen neuen Tab. Nicht: server_entry, server_dialog. | default, countdown, loading, final, expired | default „Verbindung verloren. Neu verbinden oder schließen.“ · countdown „Neuer Versuch in 8 s · Versuch 2/5“ · loading „Verbinde neu …“ · final „Anmeldung abgelehnt. Zugangsdaten prüfen, dann neu verbinden. — Nach RDP-Abmelden oder -Trennung nur Schließen.“ · expired „Sitzung abgelaufen. Öffne den Server neu.“ |
| UI-SERVERS-TAB-CONNECTION | Verbindungszustand eines Tabs | Zeigt am Label, dass die Verbindung einer Session weg ist oder gerade neu aufgebaut wird: das Label wird in --subtext gedämpft, dahinter steht ein kleines Icon — Unplug bei getrennt, ein sich drehendes RotateCw beim Neuverbinden. Im Normalzustand ist nichts zu sehen. Marker und Kontextstreifen bleiben unberührt; ein Ring im Marker heißt weiterhin Fortschritt, nicht Verbindung. Nicht: session_activity, agent_context, pane_color. | default, loading, error | default „kein Zusatz“ · loading „Label gedämpft, RotateCw dreht sich“ · error „Label gedämpft, Unplug“ |
| UI-SERVERS-TABS | Sessions | Die aktuell offenen Sessions als Tabs, jede mit ihrer Split-View-Zuordnungsfarbe; Kontextmenü mit Umbenennen, Duplizieren, Teilen, Schlafen legen, Ausklinken, Schließen — bei einer getrennten Session zusätzlich Neu verbinden, an erster Stelle. Nicht: server_entry, folder. | default, selected, empty (Bestand) | Menüeintrag „Neu verbinden“ |

- Locator: jedes Element trägt `data-ui-id="<ID>"`.
- Tokens: `--subtext`, `--primary`, `--error`, `--terminal` aus `docs/design/mockups/tokens.css` (im Code über `client/src/common/styles/_colors.sass`).
- Dieser Task verdrahtet Zustände (`countdown`, `loading`, `expired`, Tab `loading`/`error`, Menüeintrag) mit echten Daten.

**Tests:** keine neuen — Verdrahtung; die Generationsregel testet Task 5 (`sessionErrors.test.jsx`), der Rest wird in Task 8 manuell geprüft.

**Parallel:** Task 7a (keine gemeinsamen Dateien).

- [ ] **Step 1: `Servers.jsx` — Importe und Kontexte**

Nach Z. 16 (`import { useActiveSessions } ...`) einfügen:
```js
import { usePreferences } from "@/common/contexts/PreferencesContext.jsx";
import { useAutoReconnect } from "@/common/hooks/useAutoReconnect.js";
import { requestReconnect } from "@/common/utils/ReconnectPolicy.js";
import { shouldRecordError, isSuperseded } from "@/pages/Servers/utils/sessionErrors.js";
```
Z. 23:
```js
import { getTabId, getBrowserId, requiresIdentity, canConnectWithoutPrompt, getDisplayDpi } from "@/common/utils/ConnectionUtil.js";
```
Z. 68:
```js
    const { registerHandler, isConnected } = useContext(StateStreamContext);
```
Nach Z. 70 (`const { t } = useTranslation();`) einfügen:
```js
    const { autoReconnect } = usePreferences();
```

- [ ] **Step 2: `Servers.jsx` — Fehlerzustand, Reconnect, Automatik**

`markSessionErrored`/`getSessionError` (Z. 95-102) ersetzen durch:

```js
    const activeSessionsRef = useRef(activeSessions);
    useEffect(() => {
        activeSessionsRef.current = activeSessions;
    }, [activeSessions]);
    const [sessionErrors, setSessionErrors] = useState({});
    const [reconnecting, setReconnecting] = useState({});
    // A reconnected session is briefly missing from a CONNECTIONS broadcast computed before it existed.
    const pendingAttachRef = useRef(new Set());
    const handleSessionErroredRef = useRef(null);
    const disconnectFromServerRef = useRef(null);

    const setSessionError = useCallback((sessionId, error) => {
        if (error) erroredSessionsRef.current.set(sessionId, error);
        else erroredSessionsRef.current.delete(sessionId);
        setSessionErrors(Object.fromEntries(erroredSessionsRef.current));
    }, []);

    const markSessionErrored = useCallback((sessionId, error) => {
        const generation = activeSessionsRef.current.find(s => s.id === sessionId)?.generation ?? 1;
        const incoming = typeof error === "string" ? { message: error, retryable: false, generation } : error;
        if (!shouldRecordError(erroredSessionsRef.current.get(sessionId), incoming, generation)) return;
        setSessionError(sessionId, incoming);
        handleSessionErroredRef.current?.(sessionId);
    }, [setSessionError]);

    const getSessionError = useCallback((sessionId) => erroredSessionsRef.current.get(sessionId)?.message || null, []);
    const getSessionErrorInfo = useCallback((sessionId) => erroredSessionsRef.current.get(sessionId) || null, []);

    const reconnectSession = useCallback(async (sessionId) => {
        setReconnecting(prev => ({ ...prev, [sessionId]: true }));
        try {
            const result = await requestReconnect(sessionId, t);
            if (!activeSessionsRef.current.some(s => s.id === sessionId)) return { connected: false };
            switch (result.outcome) {
                case "reconnected":
                    pendingAttachRef.current.add(sessionId);
                    setSessionError(sessionId, null);
                    setActiveSessions(prev => prev.map(s => (s.id === sessionId ? { ...s, generation: result.generation } : s)));
                    return { connected: true };
                case "reattach":
                    setSessionError(sessionId, null);
                    setActiveSessions(prev => prev.map(s => (s.id === sessionId ? { ...s, attachNonce: (s.attachNonce ?? 0) + 1 } : s)));
                    return { connected: true };
                case "ended":
                    disconnectFromServerRef.current?.(sessionId);
                    return { connected: false };
                case "refused": {
                    const generation = activeSessionsRef.current.find(s => s.id === sessionId)?.generation ?? 1;
                    setSessionError(sessionId, { ...result.error, generation });
                    return { connected: false };
                }
                default:
                    return { connected: false };
            }
        } finally {
            setReconnecting(prev => {
                const next = { ...prev };
                delete next[sessionId];
                return next;
            });
        }
    }, [setActiveSessions, setSessionError, t]);

    const { reconnectStates, markSessionConnected, handleSessionErrored, reconnectNow } = useAutoReconnect({
        activeSessions,
        reconnectSession,
        getSessionErrorInfo,
        enabled: autoReconnect,
        serverConnected: isConnected,
    });
    useEffect(() => {
        handleSessionErroredRef.current = handleSessionErrored;
    }, [handleSessionErrored]);
```

- [ ] **Step 3: `Servers.jsx` — `handleConnectionsUpdate`**

Im gemappten Objekt (Z. 135-152) nach `id: session.sessionId,` einfügen:
```js
                generation: session.generation ?? 1,
```

Die Zusammenführung Z. 170-173 ersetzen durch:
```js
            const merged = activeMapped.map(newSession => {
                const existing = prevMap.get(newSession.id);
                return existing ? { ...newSession, generation: Math.max(newSession.generation ?? 1, existing.generation ?? 1), attachNonce: existing.attachNonce ?? 0, scriptId: existing.scriptId || newSession.scriptId, scriptName: existing.scriptName, osName: newSession.osName || existing.osName } : newSession;
            });
```

Vor `setActiveSessions(prev => {` in `handleConnectionsUpdate` einfügen:
```js
        let supersededErrors = false;
        for (const s of activeMapped) {
            if (isSuperseded(erroredSessionsRef.current.get(s.id), s.generation)) {
                erroredSessionsRef.current.delete(s.id);
                supersededErrors = true;
            }
        }
        if (supersededErrors) setSessionErrors(Object.fromEntries(erroredSessionsRef.current));
```

Z. 175-178 ersetzen durch:
```js
            const pinned = prev.filter(s =>
                (erroredSessionsRef.current.has(s.id) || pendingAttachRef.current.has(s.id)) && !mergedIds.has(s.id) && !isLocalSession(s)
            );
            mergedSessions = [...merged, ...pinned, ...localOnly];
```

Nach dem `setActiveSessions(prev => { … });`-Aufruf (nach Z. 180) einfügen:
```js
        newActiveIds.forEach(id => pendingAttachRef.current.delete(id));
```

- [ ] **Step 4: `Servers.jsx` — `performConnection`, `disconnectFromServer`, Props**

Z. 517:
```js
                displayDpi: getDisplayDpi(),
```

`disconnectFromServer` (Z. 689-700) ersetzen durch:
```js
    const disconnectFromServer = useCallback((sessionId, generation) => {
        const current = activeSessionsRef.current.find(s => s.id === sessionId)?.generation ?? 1;
        if (generation !== undefined && generation < current) return;
        setSessionError(sessionId, null);
        pendingAttachRef.current.delete(sessionId);
        setActiveSessions(prev => {
            const newSessions = prev.filter(session => session.id !== sessionId);
            setActiveSessionId(currentActiveId => {
                if (newSessions.length === 0) return null;
                if (sessionId === currentActiveId) return newSessions.at(-1)?.id || null;
                return currentActiveId;
            });
            return newSessions;
        });
    }, [setActiveSessions, setActiveSessionId, setSessionError]);
    useEffect(() => {
        disconnectFromServerRef.current = disconnectFromServer;
    }, [disconnectFromServer]);
```

Am `<ViewContainer …>` (Z. 1018-1031) nach `getSessionError={getSessionError}` ergänzen:
```jsx
                               sessionErrors={sessionErrors}
                               reconnectStates={reconnectStates}
                               reconnecting={reconnecting}
                               reconnectSession={reconnectNow}
                               markSessionConnected={markSessionConnected}
```

`closeSession` (Z. 702-711) bleibt: sie sendet für nicht-lokale Tabs `DELETE /connections/:id` (entfernt jetzt auch den Tombstone) und ruft `disconnectFromServer(sessionId)` ohne Generation.

- [ ] **Step 5: `ViewContainer` — Karte, Keys, Takt, Tab-Zustand**

Z. 4:
```js
import { useState, useRef, useCallback, useEffect } from "react";
```
Nach Z. 19 (`import { barKeySequence } ...`) einfügen:
```js
import ConnectionError from "@/pages/Servers/components/ViewContainer/renderer/components/ConnectionError";
import { isReconnectEligible } from "@/common/utils/ReconnectPolicy.js";
```

Props (Z. 62-79): nach `getSessionError,` ergänzen:
```js
                                  sessionErrors = {},
                                  reconnectStates = {},
                                  reconnecting = {},
                                  reconnectSession,
                                  markSessionConnected,
```

Nach Z. 120 (`const { showKeyBar } = usePreferences();`) einfügen:
```js
    const hasCountdown = Object.keys(reconnectStates).length > 0;
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!hasCountdown) return;
        const tick = () => setNow(Date.now());
        tick();
        const timer = setInterval(tick, 1000);
        return () => clearInterval(timer);
    }, [hasCountdown]);

    const connectionStates = {};
    for (const id of Object.keys(sessionErrors)) connectionStates[id] = "error";
    for (const id of Object.keys(reconnecting)) connectionStates[id] = "loading";
    const reconnectable = {};
    for (const [id, error] of Object.entries(sessionErrors)) if (!error.expired && error.reconnectable !== false) reconnectable[id] = true;
    for (const id of Object.keys(reconnecting)) reconnectable[id] = true;
```

In `renderRenderer`: beim `GuacamoleRenderer` (Z. 598-604) nach `getSessionError={getSessionError}` und beim `XtermRenderer` (Z. 606-614) nach `getSessionError={getSessionError}` jeweils ergänzen (der `key` steht direkt am Renderer-Element, nicht an einem Fragment):
```jsx
                                          key={`${session.id}-${session.generation ?? 1}-${session.attachNonce ?? 0}`}
                                          markSessionConnected={markSessionConnected}
```

In `renderAllSessions` (Z. 721-727) hinter der Zeile `{renderRenderer(session)}` einfügen:
```jsx
                {sessionErrors[session.id] && !session.scriptId && (
                    <ConnectionError message={sessionErrors[session.id].message}
                                     retryable={sessionErrors[session.id].retryable}
                                     expired={sessionErrors[session.id].expired}
                                     reconnectable={sessionErrors[session.id].reconnectable}
                                     reconnecting={!!reconnecting[session.id]}
                                     reconnect={reconnectStates[session.id] || null}
                                     now={now}
                                     onReconnect={isReconnectEligible(session) ? () => reconnectSession(session.id) : undefined}
                                     onClose={() => closeSession(session.id)} />
                )}
```

(Skript-Tabs zeigen weiter ihre eigene Karte aus `ScriptRenderer`; der Key baut Xterm und Guacamole bei jeder neuen Generation und jedem `409` frisch auf, weil beide `getSessionError` nur beim Mount lesen.)

Am `<ServerTabs …>` (Z. 731-745) nach `onNewSession={onNewSession} openSFTP={openSFTP}` ergänzen:
```jsx
                    connectionStates={connectionStates} reconnectable={reconnectable} onReconnect={reconnectSession}
```

- [ ] **Step 6: Tests und Lint**

Run: `cd /root/outpost/client && yarn vitest run src/pages/Servers && npx eslint src/pages/Servers/Servers.jsx src/pages/Servers/components/ViewContainer/ViewContainer.jsx src/pages/Servers/utils`
Expected: alle Tests unter `src/pages/Servers` PASS; keine Lint-Errors; Warnungen nur `react-hooks/refs` an bestehenden Stellen und `react-hooks/set-state-in-effect` am Countdown-Takt (gewollt: sofortiger Takt beim Start des Countdowns).

- [ ] **Step 7: Commit**

```bash
git add client/src/pages/Servers/Servers.jsx client/src/pages/Servers/components/ViewContainer/ViewContainer.jsx
git commit -m "Reconnect: Tabs verbinden im selben Platz neu, automatisch oder per Knopf"
```

---

### Phasenende C

- [ ] Worktree-Branches von Task 7a, 7b mergen.
- [ ] Volle Suite: `cd /root/outpost && yarn test` → alle grün.
- [ ] Review-Kette einmal: `/code-review` auf den Phasen-Diff; `footgun` auf `client/src/pages/Servers/Servers.jsx`, `client/src/pages/Servers/components/ViewContainer/ViewContainer.jsx`, `client/src/pages/Servers/components/ViewContainer/renderer/GuacamoleRenderer.jsx`; `/design-verify --screen UI-SERVERS`.
- [ ] Zwischenstand: Funktion vollständig; offen: Abschlussprüfungen und manuelle Tests.

---

## Phase D — Abschluss

### Task 8: Volle Prüfung, Sicherheitsabgleich, manuelle Tests auf outpost-test

**Files:** keine Code-Dateien (Befunde werden in den betroffenen Dateien behoben und einzeln committet).

**Interfaces:** Consumes: alles aus Task 1–7b. Produces: nichts.

**Design:** kein UI-Anteil.

**Tests:** volle Suite (`yarn test`: Server-, Skript- und Client-Tests), Lint beider Teile, Client-Build, Engine-Syntaxprüfung, manuelle Checkliste. Keine neuen Tests.

**Parallel:** none — prüft den gemergten Gesamtstand.

- [ ] **Step 1: Volle Suite**

Run: `cd /root/outpost && yarn test`
Expected: alle Server-, Skript- und Client-Tests grün.

- [ ] **Step 2: Lint**

Run: `cd /root/outpost && yarn lint && yarn --cwd client lint`
Expected: keine Errors.

- [ ] **Step 3: Client-Build**

Run: `cd /root/outpost && yarn --cwd client build`
Expected: Build erfolgreich.

- [ ] **Step 4: Engine-Syntax**

Run: `cd /root/outpost/engine && gcc -fsyntax-only -std=gnu11 -Wall -Wextra -Isrc/core -Isrc/net -Isrc/proto -Isrc src/net/telnet.c src/net/websocket.c; echo rc=$?`
Expected: `rc=0`. Der echte Engine-Build läuft im CI (`Dockerfile.engine`, `.github/workflows/container-image.yml`).

- [ ] **Step 5: Sicherheitsabgleich (SEC-*)**

```bash
cd /root/outpost
git diff main --stat -- package.json yarn.lock client/package.json client/yarn.lock
grep -n "logger\.\(info\|warn\|error\|debug\)" server/lib/SessionManager.js server/lib/engineEvents.js | grep -i "configuration\|directIdentity\|tombstone)"
grep -rn "dangerouslySetInnerHTML" client/src/pages/Servers/components/ViewContainer/renderer/components/ConnectionError client/src/pages/Servers/components/ViewContainer/components/ServerTabs
grep -n "reconnectLimiter" server/routes/serverSession.js
yarn audit --groups dependencies --level high; yarn --cwd client audit --groups dependencies --level high
```
Expected: erste Zeile leer (keine neuen Abhängigkeiten → SEC-DEP-01 ohne neue Angriffsfläche), zweite und dritte ohne Treffer, vierte zeigt Definition und Verwendung an der Route, die beiden `yarn audit`-Läufe: keine neuen Befunde gegenüber `main`. Danach die Tabelle „Sicherheitsanforderungen → Tasks“ unten Zeile für Zeile abhaken.

- [ ] **Step 6: Manuelle Prüfung auf outpost-test (DS918+)**

Branch-Image wie gewohnt auf outpost-test einspielen, dann:
1. SSH mit tmux (`tmux new -A -s claude`, Claude Code läuft). Engine-Prozess/-Container neu starten → Fehlerkarte „Verbindung verloren“ mit „Neuer Versuch in 5 s · Versuch 1/5“, Tab-Label gedämpft mit `Unplug`; nach dem Versuch zurück in derselben tmux-Sitzung, gleicher Tab, gleiche Stelle im Split. Audit-Log zeigt „Session reconnected“ mit `reconnectOf`/`generation`.
2. Netz zum SSH-Ziel kurz trennen → „connection lost“ → automatischer Neuaufbau. „Jetzt verbinden“ während des Countdowns verbindet sofort.
3. telnet: `exit` → Tab schließt normal; Ziel hart trennen → Fehlerkarte, Reconnect.
4. pve-lxc: `exit` → Tab schließt normal; Proxmox-Verbindung kappen → Fehlerkarte, Reconnect.
5. RDP-Sitzung, VM-Netz kurz trennen → wiederholbarer Abbruch, Reconnect. RDP abmelden → endgültige Karte ohne Countdown und ohne „Neu verbinden“, nur „Schließen“.
6. Handy in Standby, nach > 30 s zurück → `visibilitychange` → `409` → Terminal hängt sich ohne neue Generation wieder an (Log-Puffer erscheint).
7. Tab während des Countdowns schließen → keine weiteren Reconnect-Requests (Netzwerk-Tab), `DELETE` gesendet.
8. Server neu starten oder 15 min warten → „Sitzung abgelaufen. Öffne den Server neu.“ nur mit „Schließen“.
9. Einstellungen → Terminal → „Automatisch neu verbinden“ aus → kein Countdown, Knopf funktioniert.
10. Popout einer SSH-Sitzung, Abbruch → Karte im Popout, „Neu verbinden“ baut im Popout neu auf.
11. Zwei Browserfenster derselben Sitzung, beide klicken „Neu verbinden“ → genau eine neue Generation.
12. Share-Link-Zuschauer bei Abbruch → Fehlerkarte mit „Schließen“ wie bisher.
13. VNC-Sitzung, Netz zum VNC-Ziel kurz trennen → Fehlerkarte mit Countdown, Reconnect erfolgreich (nicht „Sitzung abgelaufen“). Erscheint 410: guacd schickte keine `error`-Instruktion — Befund melden, nicht still lösen.

Befund → Fix in der betroffenen Datei, betroffene Tests laufen lassen, Commit `Reconnect: …`.

- [ ] **Step 7: Branch abschließen**

REQUIRED SUB-SKILL: superpowers:finishing-a-development-branch.

---

## Sicherheitsanforderungen → Tasks

| ID | Umsetzung | Task |
|---|---|---|
| SEC-INPUT-01 | `sessionIdValidation` (UUID) + `reconnectSessionValidation` (nur `displayDpi` 48–480, unbekannte Felder abgelehnt), `terminal.autoReconnect: Joi.boolean()`; Test in `validations.test.js` | 4 |
| SEC-ERR-01 | Route antwortet nur `{ code, message }` mit festen Texten; `500` generisch; Stacks nur im Server-Log | 4 |
| SEC-SECRET-01 | Tombstone (inkl. `directIdentity`) nur in einer Map im Speicher; Logs nennen nur ID/Generation; `getSessions` entfernt `directIdentity` weiterhin; Audit-Details ohne Zugangsdaten | 2, 4, Prüfung 8 |
| SEC-DEP-01 | Keine neuen Abhängigkeiten; Nexterm-Bausteine als eigener Code übernommen; Lockfiles unverändert | 5, Prüfung 8 |
| SEC-INJECT-01 | Engine-ID nur aus UUID und Ganzzahl-Generation; `resolveEngineSession` erkennt nur `<uuid>`/`<uuid>:<n>` (Test 4 in Task 2); `tmuxSession` nur aus dem Tombstone, weiter `isValidAttachName` + `quote` | 2, 3, 4 |
| SEC-RATE-01 | `reconnectLimiter` (10/min je Konto und Sitzung) an `POST /:id/reconnect` | 4 |
| SEC-SQLI-01 | Audit über `createAuditLog` (Sequelize `create`), Rechte über bestehende ORM-Funktionen; kein Roh-SQL | 4 |
| SEC-XSS-01 | `ConnectionError` und Tab-Zustand rendern Texte als React-Kinder, Icons ohne HTML-Strings | 6 |
| SEC-IDOR-01 | Fremde lebende Sitzung/fremder Tombstone → `404`; `DELETE`, `hibernate`, `resume` mit Besitzprüfung; Tests in Task 4 | 4 |
| SEC-RBAC-01 | `openSession` prüft wie `createSession`: `getRequiredConnectPermission`/`validateEntryAccess`, `CONNECT_DIRECT`, `resolveIdentity` (Test „Rechte entzogen → 403“) | 4 |
| SEC-SESS-02 | Route hinter `authenticate`; `removeAllByAccountId`/`removeAllByEntryId` verwerfen Tombstones vor und nach dem Abbau und warten laufende Abbauten ab; `openSession` bricht mit `410` ab, wenn der Tombstone während der Prüfungen verschwand (Tests in Task 2 und Task 4) | 2, 4 |
| SEC-TOKEN-01 | Keine neue Authentifizierung; Mount `/api/connections` mit `authenticate` (`server/index.js:89`) | 4 |

## Spec-Abdeckung

| Spec-Abschnitt | Task |
|---|---|
| Ruhende Sitzung (Tombstone), Regeln, Ablauf, `removeAllBy*` | 2 (Regeln/Ablauf), 3 (Guac-Status, Karenz), 4 (DELETE) |
| Engine-Abbruch (`engineDisconnected` → 4017), 1-s-Karenz | 3 |
| Engine: telnet/pve-lxc „connection lost“, Reihenfolge `session_closed` | 1 |
| Endpunkt Schritte 1–8, `openSession`, Audit | 4 |
| Generationen und Engine-Sitzungs-IDs (`openEngineSession`, `waitForDataConnection`, `closeSession`, Resize, `joinSession`, Aux-IDs, Aufzeichnung) | 2, 3 |
| Aufzeichnung, Freigaben (neue `auditLogId`, `shareId` endet) | 4 (`auditLogId`), 2 (`shareIndex` unverändert im Abbau) |
| Einstellung `terminal.autoReconnect` | 4 (Server), 6 (Client) |
| Fehlerklassifizierung | 5 |
| `useAutoReconnect`, `ReconnectPolicy` | 5 |
| Anbindung `Servers.jsx`, `ViewContainer`, Renderer, Popout | 7a, 7b |
| Oberfläche (Manifest Rev. 7) | 6, Verdrahtung 7b |
| Fehler- und Randfälle-Tabelle | 2–4 (Tests), 7b, manuell 8 |
| Tests Server 1–8, Client 1–3 | 3 (1, 3), 4 (2, 4, 5, 6, 8; 7 entfällt laut Entscheidung 2026-10-05), 5 (Client 1, 2), 6 (Client 3) |

## Design-Abdeckung

DESIGN-COVERAGE
UI-SERVERS-VIEW-ERROR | covered | Task 6, Schritt 5; Task 7b, Schritt 5; Task 7a, Schritt 3–4
UI-SERVERS-TAB-CONNECTION | covered | Task 6, Schritt 8–9; Task 7b, Schritt 5
UI-SERVERS-TABS | covered | Task 6, Schritt 8 (Menüeintrag Neu verbinden)
UI-SERVERS-VIEW | covered | Task 7b, Schritt 5 (Zustand error zeigt UI-SERVERS-VIEW-ERROR)
UI-SERVERS-LIST | covered | Bestand, unverändert
UI-SERVERS-SEARCH | covered | Bestand, unverändert
UI-SERVERS-LIST-MENU | covered | Bestand, unverändert
UI-SERVERS-TAB-MARKER | covered | Bestand, unverändert
UI-SERVERS-TAB-CONTEXT | covered | Bestand, unverändert
UI-SERVERS-TAB-LABEL | covered | Bestand; Task 6, Schritt 8 (nur Klasse für --subtext)
UI-SERVERS-FOCUS | covered | Bestand, unverändert
UI-SERVERS-KEYBAR | covered | Bestand, unverändert
UI-SERVERS-ACTIONS | covered | Bestand, unverändert
UI-SERVERS-WELCOME | covered | Bestand, unverändert
END
