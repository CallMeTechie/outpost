# tmux-Sessions — Umsetzungsanleitung (UI-TMUX-DIALOG)

Artboard: docs/design/mockups/ui-tmux-dialog.html · Manifest-Revision: 1

Bestehend: `client/src/pages/Servers/components/TmuxSessionDialog/`
(`TmuxWindowView`, `WindowGrid`). Vgl. Spec
`/root/docs/superpowers/specs/2026-08-07-nexterm-tmux-session-verwaltung-design.md`
und den Commit „read a missing socket as an empty picker, not an error".

## Wo im Code
- `TmuxSessionDialog.jsx` — Container; Session-Liste → `UI-TMUX-DIALOG-SESSIONS`; `WindowGrid` → `UI-TMUX-DIALOG-WINDOWS`; Fußzeile → `UI-TMUX-DIALOG-NEW`, `UI-TMUX-DIALOG-ATTACH`
- Wiederverwenden: `DialogProvider`, `Button`, `Icon`; Monospace über `--type-mono`

## Darstellung
- Art: Dialog, modal, über `UI-SERVERS`, nur bei bestehender SSH-Session zum Server.
- Öffnen: Kontextmenü › Session beitreten, Aktionsmenü, Taste `T`. Schließen: Esc, Backdrop, Abbrechen; nach Beitreten automatisch.
- Größe: mittig, 52 rem breit, max. 80 vh; links Liste (18 rem), rechts Raster.
- Tastatur: ↑/↓ Session, ←/→ Fenster, Enter = Beitreten, `N` = Neue Session.

## Elemente
### UI-TMUX-DIALOG-SESSIONS
- `data-ui-id` an der Liste. Datenquelle: `tmux list-sessions` auf dem verbundenen Server — **nicht** Outposts Tabs, nicht die Server-Liste.
- Zustände: `loading` · `empty` „Keine tmux-Session. Neue Session starten." (fehlender Socket = leer, kein Fehler) · `error` „tmux nicht erreichbar." · `selected`.

### UI-TMUX-DIALOG-WINDOWS
- `data-ui-id` am `WindowGrid`. Datenquelle: `tmux list-windows` der gewählten Session; aktives Fenster markiert. `empty` bei Session ohne Fenster.

### UI-TMUX-DIALOG-ATTACH / -NEW
- `data-ui-id` je Button. Beitreten `disabled` ohne Auswahl. Neue Session startet und hängt an; Name aus dem Namensfeld, sonst `outpost`. (Eine Server-Einstellung für einen Standard-Sessionnamen gibt es nicht — der Entry kennt nur `tmuxEnabled`. Der Anker im Manifest verlangt sie auch nicht; diese Anleitung tat es, das war erfunden.)

## Ausdrücklich nicht
- Keine Vermischung von tmux-Sessions und Outpost-Tabs in einer Liste.
- Kein Fehlerzustand für „kein Socket" — das ist `empty`.

## Fertig, wenn
- Vier Marker auf Tier A; `/design-verify --screen UI-TMUX-DIALOG` MATCH.
