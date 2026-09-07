# Rahmen — Umsetzungsanleitung (UI-SHELL)

Artboard: docs/design/mockups/ui-shell.html · Manifest-Revision: 2

Bestehend und vollständig gebaut. Diese Anleitung schreibt fest, was bisher nur im Code stand — der Screen wurde am 2026-09-07 nachgezeichnet, nachdem Logo, Icons und Größen ohne Artboard geändert worden waren.

## Wo im Code
- `client/src/common/layouts/Root.jsx` — hält den Ein-/Ausklappzustand (`isLeftPaneCollapsed`) und rendert die Leiste, den Streifen und `MobileNav`
- `client/src/common/components/Sidebar/` — Leiste: Logo, Navigation, Konto samt Menü
- `client/src/common/components/MobileNav/` — die untere Leiste unter 768 px
- `client/src/common/utils/navigationConfig.jsx` — `getSidebarNavigation(t)`, die **einzige** Quelle der Bereiche; beide Leisten lesen sie
- `client/src/common/components/OutpostLogo/` — die Bildmarke
- Wiederverwenden: `Icon` (`@/common/components/Icon`), `Tooltip`, `LetterAvatar`

## Darstellung
- Art: Rahmen um jede Seite, immer sichtbar. Über 768 px eine 5 rem breite Leiste links, darunter eine 3,5 rem hohe Leiste am unteren Rand — nie beide gleichzeitig.
- Tastatur: Reihenfolge Logo → Navigation → Konto. Enter und Leertaste holen die eingeklappte Leiste zurück.

## Elemente

### UI-SHELL-LOGO
- `data-ui-id` am klickbaren Wrapper (`.sidebar-logo`), nicht am SVG: der Klick klappt die Leiste ein und aus, das SVG ist nur der Inhalt.
- 42 px × `uiScale`. Die Marke ist vier Pfosten unterschiedlicher Höhe; der letzte trägt `--success` und **nicht** den Akzent — bei einem grünen Akzent würde die Marke sonst flach.
- `selected` heißt hier: die Leiste ist eingeklappt. Sichtbar ist dann nur noch `UI-SHELL-REVEAL`.

### UI-SHELL-NAV
- `data-ui-id` an `<nav>`, nicht an den einzelnen Einträgen — geprüft wird, dass die Bereiche vollständig und in dieser Reihenfolge erscheinen.
- Quelle ist `getSidebarNavigation(t)`, gefiltert über `hasPermission(item.permission)`. Audit fehlt ohne `AUDIT_VIEW`, und das ist richtig so, kein Ladefehler.
- Icon 2 rem in einer Fläche von 3,25 rem, Radius 1 rem, Abstand 0,75 rem. Aktiv: `--dark-gray` Fläche, 1 px `--gray` Rand, Icon in `--primary`.
- Die Icons kommen aus `lucide-react`, nicht aus `@mdi/js`. Neue Bereiche nehmen ebenfalls Lucide; MDI bleibt allein den Marken- und Systemlogos vorbehalten (siehe `client/src/common/components/Icon/Icon.jsx`).

### UI-SHELL-ACCOUNT
- `data-ui-id` am Knopf (`.user-btn`). Das Menü öffnet auf Hover und schließt mit 150 ms Verzögerung — ohne die reißt der Weg zwischen Knopf und Menü ab.
- `selected` ist das offene Menü: Kopf mit Namenskürzel und `@username`, dann Einstellungen, GitHub, Unterstützung, Abmelden in `--error`.
- Im Connector-Betrieb steht zwischen Kopf und Einstellungen die Serverliste mit „Server hinzufügen".

### UI-SHELL-REVEAL
- `data-ui-id` am Streifen (`.left-pane-hover-bar`). Er ist ein Knopf: `role="button"`, `tabIndex` 0 solange die Leiste eingeklappt ist, Enter und Leertaste wie ein Klick.
- Mit Maus fährt die Leiste beim Überfahren vorübergehend ein (`mousemove` in `Root.jsx`); Tipp oder Klick holt sie **dauerhaft** zurück. Beides ist nötig: Touch schickt keine Mausbewegung, und auf einem Falt-Handy liegt der Streifen in der Fläche der Zurück-Geste.
- 1 rem breit, bei `@media (pointer: coarse)` 1,5 rem und voll deckend — dort gibt es keinen Hover, der ihn hervorheben könnte.

### UI-SHELL-MOBILE-NAV
- `data-ui-id` an `<nav class="mobile-nav">`. Unter 768 px sichtbar, darüber `display: none`; die seitliche Leiste verhält sich genau umgekehrt.
- Dieselben Bereiche wie `UI-SHELL-NAV`, hier mit Text unter dem Icon.
- Ein Tipp auf den **bereits offenen** Bereich navigiert nicht, sondern sendet dessen `toggleEvent` — bei Server klappt das die Serverliste als Schublade auf. Das ist die einzige Stelle, an der ein Navigationseintrag zwei Bedeutungen hat.

## Ausdrücklich nicht
- **Keine zweite Quelle für die Bereiche.** Wer einen Eintrag ergänzt, ergänzt ihn in `navigationConfig.jsx`; beide Leisten und die Einstellungen lesen dieselbe Liste. Eine Kopie in `MobileNav` würde erst auffallen, wenn die beiden Leisten Verschiedenes zeigen.
- **Die Titelleiste gehört nicht zu diesem Screen.** `TitleBar` beendet sich mit `if (!isTauri()) return null` und existiert nur in der Desktop-App. Sie zu gestalten hieße, etwas zu gestalten, das im Browser nie erscheint.
- **Der Fokus-Modus versteckt die Leiste nicht auf schmalen Schirmen.** `body.session-focus .left-pane-slot { display: none }` gilt erst ab 769 px. Unter der Schwelle liegt die Serverliste als `position: fixed`-Schublade darüber und nimmt keine Breite weg — es gäbe nichts zurückzugewinnen, und die Regel hätte die Liste unerreichbar gemacht.
- **Kein Einklappen ohne Rückweg.** Jede Änderung am Einklappen muss `UI-SHELL-REVEAL` erreichbar lassen, und zwar ohne Maus.

## Fertig, wenn
- Fünf Marker auf Tier A; `/design-verify --screen UI-SHELL` MATCH.
- Die Bereiche in beiden Leisten stimmen überein, ohne dass eine zweite Liste im Code existiert.
