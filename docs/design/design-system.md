# Outpost — Design-System (Servers-Arbeitsfläche, Runde 1)

Festschreibung des Bestands aus `client/src/common/styles/`; die in Runde 1
vorgeschlagene Typo- und Abstandsskala ist seitdem Bestand (`_tokens.sass`). Quelle der Werte: `_colors.sass`, `main.sass`,
`_breakpoints.sass`, gezählte Verwendung in `client/src/common/components/`.
Änderungen an Werten gehören zuerst dorthin, dann hierher, dann in
`mockups/tokens.css` — nie in umgekehrter Reihenfolge.

## Charakter

Dicht, schnell, tastaturgetrieben, dunkel als Standard. Näher am Cockpit als
an einer Consumer-App. Ein ernsthaftes Werkzeug für Leute, die wissen, was
sie tun — und trotzdem mit Leer- und Fehlerzuständen, die einem weniger
erfahrenen Mitnutzer sagen, was zu tun ist. (Quelle: Logo-Prompt + Dialog
2026-09-03.)

## Farben (Bestand)

Eine Akzentfarbe, sonst Grau-Stufen; Farbe nur als Bedeutung.

| Rolle | dunkel (Standard) | hell | OLED | Verwendung |
|---|---|---|---|---|
| `--accent-color` / `--primary` | `#314BD3` | `#314BD3` | `#314BD3` | die eine Akzentfarbe: aktive Auswahl, primäre Aktion |
| `--on-accent` | `#FFFFFF` | `#FFFFFF` | `#FFFFFF` | Text und Icons auf der Akzentfarbe — nie `--white`, das im hellen Thema schwarz wird |
| `--primary-opacity` | accent 25 % | accent 15 % | accent 25 % | Hintergrund aktiver/gehoverter Elemente |
| `--background` | `#000A12` | `#FFFFFF` | `#000000` | Seitenhintergrund |
| `--terminal` | `#13181C` | `#F5F5F5` | `#000000` | Terminal-Fläche |
| `--lighter-background` | `#0D161E` | `#F0F0F0` | `#0a0a0a` | Panels, Liste, Tabs-Leiste |
| `--dialog-background` | rgba(0,0,0,.25) | rgba(245,245,245,.31) | rgba(0,0,0,.5) | Dialog-Backdrop |
| `--gray-full` / `--darker-gray` / `--dark-gray` / `--gray` / `--gray-strong` | s. `_colors.sass` | | | Trenner, Hover, Zebra, aktive Tab-Fläche (`--gray-strong`, absichtlich Alpha statt Hex) |
| `--text` / `--subtext` | `#FFFFFF` / `#B7B7B7` | `#000000` / `#666666` | `#FFFFFF` / `#888888` | Text / Meta |
| `--error` (+`-opacity`) | `#a44747` | `#d85959` | `#a44747` | Fehler, destruktive Aktion |
| `--success` (+`-opacity`) | `#29C16A` | | | verbunden, erfolgreich |
| `--warning` (+`-opacity`) | `#DC5600` | | | Warnung, Schreibschutz-Hinweis |
| `--shadow-sm|md|lg|xl` | vierstufig | | | Elevation: Menü sm, Dialog lg, schwebendes Fenster xl |

Split-View-Zuordnungsfarben: verbindlich in
`/root/docs/superpowers/specs/2026-08-15-split-view-colors-design.md`
(sechs Farben, Kontrast- und Farbfehlsichtigkeits-Kriterien). Hier nicht
dupliziert.

## Typografie

Bestand: **Plus Jakarta Sans**, Basis `16px * var(--ui-scale)`, Überschriften
700. Seit Runde 1 als Tokens in `client/src/common/styles/_tokens.sass`.
Schriftfamilien: `--font-sans` (UI) und `--font-mono` — Letztere für
UI-Monospace wie Pfade, Hostnamen, Session-Namen, **nicht** für das Terminal,
dessen Schrift der Nutzer in den Darstellungseinstellungen wählt:

| Token | Wert | Zweck |
|---|---|---|
| `--type-title` | 700 1.25rem/1.3 | Dialog-/Panel-Titel |
| `--type-heading` | 600 1rem/1.4 | Abschnittsüberschrift, Ordnername |
| `--type-body` | 500 0.875rem/1.45 | Listeneinträge, Formulare |
| `--type-caption` | 500 0.75rem/1.4 | Meta, Tab-Untertitel, Tastenkürzel |
| `--type-mono` | 400 0.875rem/1.5 var(--font-mono) | Pfade, Hostnamen, Session-Namen (nicht das Terminal) |

## Abstände (Bestand seit Runde 1, aus der Verwendung abgeleitet)

Basis 0.125 rem. Beobachtete Häufungen: 0.375 · 0.5 · 0.625 · 0.75 · 1 rem.

| Token | Wert |
|---|---|
| `--space-1` | 0.25rem |
| `--space-2` | 0.5rem |
| `--space-3` | 0.75rem |
| `--space-4` | 1rem |
| `--space-6` | 1.5rem |
| `--space-8` | 2rem |

Zwischenwerte (0.375, 0.625) sind Bestand und bleiben erlaubt; neue Flächen
nutzen die Skala.

## Radien, Schatten, Bewegung (Bestand)

Radien `0.25 · 0.5 · 0.75 · 1 rem`, `50 %` für Avatare. Schatten `sm..xl`.
Bewegung: kurz (≤150 ms) für Hover/Fokus, keine dekorativen Animationen.

## Layout und Breakpoints

`$mobile: 768px`, `$tablet: 1024px`. Höhen als Variablen: `--title-bar-height`
(40 px Desktop), `--key-bar-height` (2.75 rem), `--mobile-nav-height`.
**Mindestbreiten (neu, aus „13-Zoll-Laptop"):** Terminal-Pane ≥ 40 rem,
Datei-Pane ≥ 22 rem; darunter greift automatisch der Fokus-Modus.

## Komponenteninventar (Bestand, Auszug für die Arbeitsfläche)

Button · Dialog (DialogProvider) · ContextMenu/-Item/-Separator · TabSwitcher
· ToggleSwitch · TriToggle · SelectBox · Input/IconInput · Chip · Tooltip ·
Loading · Sidebar · TitleBar · PageHeader · FloatingWindow · ResizeHandle ·
ActionConfirmDialog · LetterAvatar/AvatarStack · PaginatedTable.
Zustände je interaktiver Komponente: default · hover · focus-visible ·
active/selected · disabled; datenführende zusätzlich loading · empty · error.

## Copy und Ton

Knapp, technisch, keine Erklärtexte im Normalbetrieb. **Ausnahme Leer- und
Fehlerzustände:** eine Handlungsanweisung im Klartext (für den weniger
erfahrenen Mitnutzer). Destruktive Aktionen bestätigen (ActionConfirmDialog).
Sprache der Oberfläche über i18n (`t()`), Schlüssel unter `servers.*`,
`welcome.*`, `scripts.*`.

## Tastatur

Jede häufige Aktion hat eine Taste; Kontextmenüs sind Zweitweg. Fokus-Modus
(neu) per Tastenkürzel, sichtbar im Tab-Kontextmenü und im Aktionsmenü.

## Accessibility-Untergrenze

Kontrast ≥ 4.5:1 für Fließtext (beide Themen prüfen — `--subtext` hell
`#666666` auf `#FFFFFF` = 5.7:1, ok). Sichtbarer Fokusring (Akzent, 2 px).
Trefferflächen ≥ 44×44 px in der Tastenleiste und auf Touch.

## Do-not

- Nicht wie eine IDE: keine Aktivitätsleiste mit Icon-Spalte, keine Panels-in-
  Panels, keine Statusleiste voller Widgets.
- Nicht playful, nicht corporate (Logo-Prompt).
- Nichts, was nur per Maus geht.
- Keine zweite Akzentfarbe; Farbe nur als Bedeutung.
- Kein Onboarding-Overlay, keine Marketing-Leere im Leerzustand.

## Token-Quellen für `/design-verify`

Die `tokens`-Stufe liest `*.css`, `*.sass`, `*.scss`, `*.less` und Inline-
`style=`-Attribute in Komponenten. Rohwerte gelten als Verstoß, außer in den
Definitionsdateien: `docs/design/mockups/tokens.css` und
`client/src/common/styles/_colors.sass` und `_tokens.sass` (im Manifest unter
`token_definitions`).
