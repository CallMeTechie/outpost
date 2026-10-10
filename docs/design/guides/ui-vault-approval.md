# Freigabe-Karte — Umsetzungsanleitung (UI-VAULT-APPROVAL)

Artboard: docs/design/mockups/ui-vault-approval.html · Manifest-Revision: 11

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
- Datenquelle: offene Freigabe-Anfragen des Kontos über `registerHandler(STATE_TYPES.VAULT_APPROVALS, …)` (`StateStreamContext`), Form laut Spec `{ id, agentType, entryName, item, target, expiresAt }`. Die Restzeit kommt aus `expiresAt`, nicht aus einem eigenen 2-Minuten-Zähler. **Nicht** Toasts, Audit-Einträge oder Benachrichtigungen.
- Zustände:
  - `default` — eine offene Anfrage.
  - `empty` — Liste leer: Komponente rendert `null`, keine Karte, kein Platzhalter. Der Artboard-Rahmen dazu ist nur Darstellung.
  - `partial` — mehr als eine Anfrage: „3 Anfragen offen“ (`vault.approval.pending`, Zahl als Variable).
  - `loading` — nach Klick, bis `POST` antwortet: „Antwort wird gesendet …“ (`vault.approval.sending`); alle drei Knöpfe `disabled`, gedimmt.
  - `error` — Anfrage abgelaufen: „Anfrage ist abgelaufen.“ (`vault.approval.expired`), Knöpfe `disabled`, Zeit „0:00“; nach fünf Sekunden verschwindet die Karte.
- Tokens: Fläche `--lighter-background`, Primärknopf `--accent-color` / `--on-accent`, Balkengrund `--gray`.

## Ausdrücklich nicht
- Die Karte ist kein Toast und kein Dialog: keine Auto-Ausblendung der offenen Anfrage (nur der abgelaufenen Karte), kein Backdrop, kein Modal (`semantic_anchor.not`: notification, toast, error). `--warning` ist Randfarbe, die Karte ist keine Fehlermeldung.
- Kein Schließen-X, kein Wegwischen: nur Antwort oder Ablauf.
- Kein Wert, kein Teil eines Werts in Karte oder Antwort; nur Name und Ziel des Eintrags.
- Keine Agenten-Icons, kein Sparkle/Roboter; Agent als Klartext („Claude Code“, „Codex“).
- Kein globales Tastenkürzel für Enter/Esc.
- Kein Zählen der 2 Minuten im Client als Wahrheit; der Server entscheidet (`vault.approval_timeout`).

## i18n
Neuer Bereich `vault.approval.*` (Namensschema des Bestands: camelCase unter Bereichsschlüssel): `title`, `actions.once`, `actions.session`, `actions.deny`, `pending`, `sending`, `expired`. Zuerst `client/public/assets/locales/en.json` (Fallback), dann `de_DE.json`; die übrigen Sprachdateien folgen dem Bestandsverfahren.

## Fertig, wenn
- Marker auf Tier A; `/design-verify --screen UI-VAULT-APPROVAL` MATCH.
