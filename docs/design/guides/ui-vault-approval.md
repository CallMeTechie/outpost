# Freigabe-Karte — Umsetzungsanleitung (UI-VAULT-APPROVAL)

Artboard: docs/design/mockups/ui-vault-approval.html · Manifest-Revision: 21

Den Screen gibt es nicht. Neu: eine seitenübergreifende Karte, die offene Freigabe-Anfragen aus dem
Zustandsstrom rendert und per `POST /api/vault/approvals/:id` beantwortet. Kein Toast, kein Dialog:
`Dialog` wird nicht wiederverwendet (Dialoge sind modal), und die Karte selbst ist kein Toast (Toasts schließen sich selbst). `ToastContext` dient nur dazu, einen fehlgeschlagenen Versand zu melden.

## Wo im Code
- `client/src/common/components/VaultApprovalCard/VaultApprovalCard.jsx` — **neu**; `UI-VAULT-APPROVAL-CARD`
- `client/src/common/components/VaultApprovalCard/styles.sass` — **neu**; Werte aus `_colors.sass` / `_tokens.sass`, Breakpoint `breakpoints.$mobile`
- `client/src/common/layouts/Root.jsx` — Einhängen in `AppContent`, innerhalb `StateStreamProvider`, neben `<MobileNav />`
- `client/src/common/layouts/PopoutRoot.jsx` — dieselbe Komponente innerhalb `StateStreamProvider` (die Spec verlangt „inkl. Popout“)
- `client/src/common/hooks/useStateStream.js` und `server/lib/StateBroadcaster.js` — je ein neuer Typ `VAULT_APPROVALS` in `STATE_TYPES` (beide Dateien führen die Liste getrennt), serverseitig auch in `BROADCASTABLE_TYPES` und `getStateData`
- `server/lib/vault/approvals.js` — **neu** (Spec „Freigabe“); liefert die offenen Anfragen des Kontos
- Wiederverwenden: `Button` (mit `loading`, `kbd`), `Icon`, `postRequest` aus `RequestUtil.js`, `useTranslation`, `useToast` (`ToastContext`) für Sendefehler
- Styles: `--space-*`, `--radius-lg`, `--shadow-xl`, `--warning`, `--lighter-background`, `--type-*` aus den Token-Definitionsdateien; keine Rohwerte

## Darstellung
- Art: schwebende Karte (shared), nicht modal, kein Backdrop, kein Fokusfang. Über `UI-SHELL` und jeder Seite, auch im Popout.
- Stapelordnung: Der Stapel liegt über Dialogen und Toasts. Bestand: `Dialog` `z-index: 10000` (`Dialog/styles.sass`), Bestätigungs-Overlay `10001` (ebenda), Toast `10002` (`client/src/common/styles/toast.sass`). Der Wrapper bekommt daher `z-index: 10003`.
- Auslöser: Anfrage im Strom `VAULT_APPROVALS`. Schließen: nur durch Antwort oder Ablauf, kein Schließen-Knopf.
- Ablauf: Eine abgelaufene Karte zeigt fünf Sekunden den Zustand `error` und verschwindet dann aus dem Stapel.
- Sendefehler: Scheitert das `POST`, bleibt die Karte stehen (Knöpfe wieder bedienbar, `loading` endet) und ein Toast über `ToastContext` nennt den Grund.
- Position: `position: fixed`, unten rechts, Abstand `--space-4`, 24 rem breit. Unter `breakpoints.$mobile` (768px): volle Breite, `bottom: var(--mobile-nav-height)` (steht in `main.sass`), nur obere Ecken gerundet.
- Aufbau je Karte von oben: Kopfzeile „Freigabe angefordert“ (`--type-heading`) · Agent und Server („Claude Code auf web01“) · Eintrag und Ziel je eine Zeile in `--type-mono` · Knöpfe · Zeit (`m:ss`) rechts · 2 px Balken am unteren Rand in `--subtext`. Links 3 px Rand `--warning`.
- Knöpfe: *Einmal* (primär) · *Für diese Sitzung* · *Ablehnen*, in dieser Reihenfolge. Entsprechen `once` / `session` / `deny` des Endpunkts.
- Stapel: mehrere Karten untereinander, die älteste unten; darüber die Zeile „N Anfragen offen“ (`partial`, rechtsbündig `--type-caption`). Jede Karte wird einzeln beantwortet.
- Tastatur: Tab erreicht die Karte (`tabIndex={0}` an der Karte); solange sie den Fokus hat, Enter = Einmal, Esc = Ablehnen. `onKeyDown` an der Karte, nicht global — sonst gewinnt sie gegen Dialoge, die Esc selbst brauchen.
- Bewegung: der Balken läuft über `transition`/Animation ab; unter `@media (prefers-reduced-motion: reduce)` (Muster in `Button/styles.sass`) läuft er ohne Bewegung; der Sekundentext läuft immer.
- Nicht auf: Layouts ohne `StateStreamProvider` (`ShareRoot`, `LinkRoot`).

## Elemente — eins nach dem anderen
### UI-VAULT-APPROVAL-CARD — Freigabe angefordert (neu)
- `data-ui-id="UI-VAULT-APPROVAL-CARD"` am äußeren Wrapper der Karte bzw. des Stapels — genau einmal im DOM, auch bei mehreren Anfragen (`cardinality: many` meint die Anfragen, nicht den Marker). Der Wrapper ist ein Portal nach `document.body`, damit `overflow` im `app-wrapper` ihn nicht beschneidet.
- Datenquelle: offene Freigabe-Anfragen des Kontos über `registerHandler(STATE_TYPES.VAULT_APPROVALS, …)` (`StateStreamContext`), Form laut Spec `{ id, agentType, entryName, item, tool, target, access, expiresAt }`. Die Restzeit kommt aus `expiresAt`, nicht aus einem eigenen 2-Minuten-Zähler. **Nicht** Toasts, Audit-Einträge oder Benachrichtigungen.
- Zustände:
  - `default` — eine offene Anfrage.
  - `empty` — Liste leer: Komponente rendert `null`, keine Karte, kein Platzhalter. Der Artboard-Rahmen dazu ist nur Darstellung.
  - `partial` — mehr als eine Anfrage: „3 Anfragen offen“ (`vault.approval.pending`, Zahl als Variable).
  - `loading` — nach Klick, bis `POST` antwortet: „Antwort wird gesendet …“ (`vault.approval.sending`); alle drei Knöpfe `disabled`, gedimmt.
  - `error` — Anfrage abgelaufen: „Anfrage ist abgelaufen.“ (`vault.approval.expired`), Knöpfe `disabled`, Zeit „0:00“; nach fünf Sekunden verschwindet die Karte.
- Tokens: Fläche `--lighter-background`, Primärknopf `--accent-color` / `--on-accent`, Balkengrund `--gray`.
- Rev. 16 — Werkzeug und Ziel: Unter dem Eintrag steht eine Zeile in `--type-mono` mit Werkzeug und Ziel. Datenquelle sind die neuen Felder der Anfrage `tool`, `target` und `access`; die Form ist jetzt `{ id, agentType, entryName, item, tool, target, access, expiresAt }`. Beispiele: `vault_http` · `POST api.github.com/repos/o/r/issues`; `git` · `push github.com/o/r`; `browser_fill_secret` · `https://coolify.example.net`. `target` ist je Werkzeug anders aufgebaut (Methode mit Host und Pfad bei vault_http, Host und Repo bei Git, Ursprung beim Eintragen) und kommt fertig vom Server; der Client setzt es nicht zusammen. Beispielzeile der Karte: „Claude Code auf web01 · github-pat · POST api.github.com/repos/o/r/issues · 1:42“.
- „Für diese Sitzung“ gilt getrennt für lesende und schreibende Zugriffe (`access`); eine Sitzungsfreigabe für Lesen gibt Schreiben nicht frei. Der Knopf bleibt unverändert beschriftet.
- Rev. 18 — Feld und `disabled`: Trägt die Anfrage eines Fill-Werkzeugs `field`, lautet die Zeile „Eintragen auf {{origin}} · Feld „{{field}}““ (`vault.approval.target.fillField`, als Text, nie als HTML), und bei `allowSession === false` (kein Passwortfeld) fehlt der Knopf „Für diese Sitzung“; der Server nimmt `session` dann ohnehin als `once`.

### UI-VAULT-APPROVAL-WRITE — schreibt (neu in Rev. 16)
- `data-ui-id="UI-VAULT-APPROVAL-WRITE"` am Abzeichen-Element (`span`) in der Kopfzeile der Karte, rechts neben „Freigabe angefordert“, **je Karte**, nicht am Stapel. Bei mehreren schreibenden Anfragen steht der Marker mehrfach im DOM, einmal pro Karte; er gehört in `VaultApprovalCard.jsx`.
- Datenquelle: `access` der Anfrage; das Abzeichen wird nur gerendert, wenn `access === "write"` (POST, PUT, PATCH, DELETE, `git push`, Eintragen im Browser). Bei `read` nicht rendern, kein Platzhalter.
- Aussehen: Icon `PenLine` (Lucide, `import { PenLine as IconPenLine } from "lucide-react"`, über `Icon`) und Text „schreibt“ (`vault.approval.write`); Schrift `--type-caption`, Farbe `--warning` auf Hintergrund `--warning-opacity`, Ecken `--radius-sm`, Innenabstand aus `--space-*`.
- Zustände: `default` „schreibt“; `empty` nicht sichtbar bei lesendem Zugriff.
- Nicht: kein `--error` und kein Toast-Stil (`not: error, warning_toast`); kein zusätzlicher Knopf und keine andere Beschriftung der Antworten. Das Abzeichen ist Information, keine Warnmeldung.


### UI-VAULT-APPROVAL-EXEC — führt aus (neu in Rev. 20)
- Abzeichen in der Kopfzeile wie `-WRITE`, aber `--error` auf `--error-opacity`, Icon `SquareTerminal`. Nur bei `tool === "ssh_exec"` (`access: "exec"`); nie zusammen mit „schreibt“.

### UI-VAULT-APPROVAL-COMMAND — Befehl (neu in Rev. 20)
- `<pre>` in `--type-mono` auf `--terminal`, `white-space: pre-wrap`, `overflow-wrap: anywhere`. Der Text kommt unverändert aus der Anfrage (kein Kürzen, kein Markup). Ab 20 Zeilen auf 20 Zeilen begrenzt mit Knopf „Ganz anzeigen (n Zeilen)“; ausgeklappt scrollt der Block (max. 40vh), die Knöpfe der Karte bleiben sichtbar.

### UI-VAULT-APPROVAL-HOSTKEY — Neues Ziel (neu in Rev. 20)
- Kasten über dem Befehl, Warnrand links, `--warning-opacity`; „Neues Ziel — <Algorithmus> <SHA256:…>. Mit ssh-keyscan oder an der Konsole vergleichen.“ Fingerabdruck in `--type-mono`, vollständig (nicht gekürzt). Nur wenn die Anfrage `hostKey.new === true` trägt.

### UI-VAULT-APPROVAL-CARD — SSH (Rev. 20)
- Zielzeile `<Werkzeug> · <Name> · <benutzer@host:port>` (Werkzeug: „SSH-Befehl“, „Datei hochladen“, „Datei holen“). Bei Dateien zusätzlich `quelle → ziel · <Größe>`; bei „Datei holen“ ist `file.bytes` `null` (Outpost meldet sich am Ziel erst nach der Freigabe an), dann steht dort „Größe nach der Freigabe“. „Für diese Sitzung“ nur bei `allowSession === true` der Anfrage.

## Ausdrücklich nicht
- Die Karte ist kein Toast und kein Dialog: keine Auto-Ausblendung der offenen Anfrage (nur der abgelaufenen Karte), kein Backdrop, kein Modal (`semantic_anchor.not`: notification, toast, error). `--warning` ist Randfarbe, die Karte ist keine Fehlermeldung.
- Kein Schließen-X, kein Wegwischen: nur Antwort oder Ablauf.
- Kein Wert, kein Teil eines Werts in Karte oder Antwort; nur Name und Ziel des Eintrags.
- Keine Agenten-Icons, kein Sparkle/Roboter; Agent als Klartext („Claude Code“, „Codex“).
- Kein globales Tastenkürzel für Enter/Esc.
- Kein Zählen der 2 Minuten im Client als Wahrheit; der Server entscheidet (`vault.approval_timeout`).

## i18n
Neuer Bereich `vault.approval.*` (Namensschema des Bestands: camelCase unter Bereichsschlüssel): `title`, `actions.once`, `actions.session`, `actions.deny`, `pending`, `sending`, `expired`, `write`. Zuerst `client/public/assets/locales/en.json` (Fallback), dann `de_DE.json`; die übrigen Sprachdateien folgen dem Bestandsverfahren.

## Fertig, wenn
- Marker auf Tier A; `/design-verify --screen UI-VAULT-APPROVAL` MATCH.
