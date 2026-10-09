# Vault — Umsetzungsanleitung (UI-VAULT)

Artboard: docs/design/mockups/ui-vault.html · Manifest-Revision: 12

Die Seite gibt es noch nicht; sie ist komplett **neu**. Bestand sind nur Rahmen und Bausteine (Shell, Navigation, `PageHeader`, `TabSwitcher`, `Button`, `ActionConfirmDialog`, Clipboard-Helfer). Der Eintrag-Dialog (`UI-VAULT-DIALOG`) und die Freigabe-Karte (`UI-VAULT-APPROVAL-CARD`) haben eigene Anleitungen; hier werden sie nur geöffnet bzw. eingebunden.

## Wo im Code
- `client/src/pages/Vault/index.js`, `Vault.jsx`, `styles.sass` — **neu**, nach dem Muster `pages/Snippets/` (`export { Vault as default }`). Alle Marker dieses Screens.
- `client/src/pages/Vault/components/VaultList/` — **neu**: Zeilen → `UI-VAULT-LIST`
- `client/src/pages/Vault/components/VaultDetail/` — **neu**: `UI-VAULT-DETAIL` und seine Unterbereiche (Aktionen, Angaben, Wert, Geltung, Freigabe); geheime Zeile als eigene Komponente `SecretRow` (Anzeigen/Kopieren/Timer).
- `client/src/App.jsx` — `const Vault = lazy(() => import("@/pages/Vault"))` und Route `{ path: "/vault", element: <Vault /> }` neben `/snippets` (Zeile 23 und 78).
- `client/src/common/utils/navigationConfig.jsx` — Eintrag in `getSidebarNavigation` zwischen `snippets` und `browser`: `{ key: "vault", path: "/vault", icon: IconKeyRound }` (Import-Schema `KeyRound as IconKeyRound`, wie im Artboard `ui-shell.html`). Kein `permission:` — die Sichtbarkeit kommt aus `useVaultAvailable().canUse`.
- `client/src/common/hooks/useSidebarNavigation.js` — `vault` zusätzlich filtern über `GET /api/vault/available` (`canUse`: Vault eingeschaltet und `vault.use` oder Org-Mitglied). Muster ist `loadBrowserAvailable` (eine geteilte Anfrage je Konto, Ergebnis gemerkt); Sidebar, `MobileNav` und `QuickAction` hängen alle an diesem Hook, daher dort und nur dort.
- `client/src/common/utils/permissions.js` — `Permission` kennt noch kein `vault.*`; `VAULT_USE`, `VAULT_MANAGE`, `VAULT_REVEAL` **neu** ergänzen. `vault.manage`/`vault.reveal` sind Organisationsrechte: gegen die Rechte der gewählten Organisation prüfen, nicht gegen `hasPermission` des Systems.
- Wiederverwenden: `PageHeader` (mit `onBackClick`/`backIcon` für den Zurück-Pfeil unter 768 px), `TabSwitcher` (`tabs=[{key,label,icon}]`, `activeTab`, `onTabChange`; neu: optionales `dataUiId`), `IconInput` (neu: optionales `dataUiId`), `Button` (Prop `dataUiId`), `ActionConfirmDialog` (Löschen), `copyToClipboard` aus `common/utils/clipboard.js` (hat den Fallback ohne sicheren Kontext), `useToast().sendToast`, `getRequest`/`deleteRequest` aus `common/utils/RequestUtil.js`, Lucide-Icons als `import { X as IconX } from "lucide-react"`.
- Styles: `pages/Vault/styles.sass` mit `@use "@/common/styles/colors"`; Breakpoint `$mobile` aus `common/styles/_breakpoints.sass`; Werte aus `_colors.sass`/`_tokens.sass`, keine Literale. Skeleton-Zeilen wie `.servers-skeleton` in `Servers/components/ServerList/styles.sass`.

## Darstellung
- Art: `page`, Route `/vault`, im Shell-Inhaltsbereich. Kein Schließen.
- Oben `PageHeader` (Titel Vault) mit `UI-VAULT-NEW` rechts, darunter `UI-VAULT-SCOPE`.
- Zweispaltig: links Liste auf `--lighter-background`, 20–26 rem; Such- und Typfilter darüber. Rechts Details auf `--background`.
- Unter 768 px eine Spalte: erst die Liste, Tipp auf eine Zeile zeigt die Details mit Zurück-Pfeil im Kopf (`PageHeader onBackClick`).
- Tastatur (`presentation`): `N` Neuer Eintrag (öffnet `UI-VAULT-DIALOG`); `↑`/`↓` wählt in der Liste; `E` Bearbeiten des gewählten Eintrags (nur mit Verwaltungsrecht); unter 768 px Zurück-Pfeil im Kopf der Details. Tastenkürzel nicht auslösen, solange ein Eingabefeld oder Dialog den Fokus hat.
- Erscheint nicht, wenn `GET /api/vault/available` `canUse: false` liefert (Vault ausgeschaltet, alle Endpunkte antworten `404`, oder das Konto hat weder `vault.use` noch ist Org-Mitglied): dann kein Navigationseintrag.
- Marker an Komponenten: `TabSwitcher` und `IconInput` bekommen ein optionales Prop `dataUiId`, das sie auf ihr Wurzelelement setzen — wie bei `Button`. Kein Umschließen mit eigenem `div`; ohne Prop bleibt das Verhalten unverändert.

## Elemente — eins nach dem anderen
### UI-VAULT-NEW — Neuer Eintrag (neu)
- `data-ui-id` an `Button` über `dataUiId`. Sichtbar nur mit `vault.use` (persönlich) oder `vault.manage` in mindestens einer Organisation; `disabled`, wenn der gewählte Besitzer kein Anlegen erlaubt.

### UI-VAULT-SCOPE — Persönlich · Organisationen (neu)
- `data-ui-id` über das neue optionale Prop `dataUiId` am `TabSwitcher`. Ein Reiter je Besitzer; „Persönlich“ nur mit `vault.use`; Organisationen aus `getRequest("organizations")` wie in `Snippets.jsx`. `selected` = aktiver Reiter.
- **Nicht** Server-Ordner, Tags oder Typ.

### UI-VAULT-SEARCH — Suchen (neu)
- `data-ui-id` über das neue optionale Prop `dataUiId` am `IconInput`. Filtert clientseitig Name, Benutzer, Host, Ursprung, Beschreibung — nie geheime Werte (die liefert die Liste nicht).
- `empty`: „Kein Eintrag passt zur Suche.“

### UI-VAULT-TYPES — Alle · Login · API-Key · SSH · Datenbank · Sonstiges (neu)
- `data-ui-id` über `dataUiId` am zweiten `TabSwitcher`. Icons: Login `LogIn`, API-Key `KeyRound`, SSH `SquareTerminal`, Datenbank `Database`, Sonstiges `Lock`.

### UI-VAULT-LIST — Einträge (neu)
- `data-ui-id` am Listen-Container. Zeile: Typ-Icon · Name · darunter Benutzer oder Host (`--type-mono`, `--subtext`) · Schild-Kennzeichen bei `approvalRequired`.
- Datenquelle: `GET /api/vault/items`, gefiltert nach Besitzer, Typ, Suche. Muss Einträge ohne Wert liefern, **nicht** Identitäten, API-Keys, Server oder Snippets.
- Zustände: `selected` = `--primary-opacity`; `loading` Skeleton-Zeilen, kein Spinner; `empty` „Noch keine Einträge. Zugangsdaten im Vault nutzen Agenten, ohne den Wert zu sehen.“ plus Aktion Neuer Eintrag; `error` „Vault nicht erreichbar. Seite neu laden.“

### UI-VAULT-DETAIL — Eintrag (neu)
- `data-ui-id` am Detail-Container. Kopf: Name, Typ, Besitzer, Beschreibung; rechts im Kopf `UI-VAULT-DETAIL-ACTIONS`.
- Zustände: `empty` „Eintrag links wählen.“; `error` „Eintrag nicht lesbar — der Vault-Schlüssel passt nicht zu diesem Eintrag.“

### UI-VAULT-DETAIL-ACTIONS — Bearbeiten · Löschen (neu)
- `data-ui-id` am Container der beiden Buttons im Detail-Kopf (Wrapper-`div` mit Marker; die Buttons selbst bleiben unmarkiert). Nur mit Verwaltungsrecht: Besitzer persönlicher Einträge, `vault.manage` bei Organisationen.
- Bearbeiten öffnet `UI-VAULT-DIALOG` mit dem Eintrag (auch Taste `E`).
- Löschen über `ActionConfirmDialog`; bei Bestätigung `DELETE /api/vault/items/:id` (`deleteRequest("vault/items/:id")`), danach Liste neu laden und Auswahl leeren. Der Eintrag wird samt Werten und Bindungen entfernt.
- Zustände: `default` beide Buttons; `disabled` ohne Verwaltungsrecht — die Buttons werden nicht gerendert („ohne Verwaltungsrecht nicht sichtbar“); `selected` Bestätigungsdialog „portal-login löschen? Agenten verlieren den Zugriff sofort.“ (Name des Eintrags einsetzen; Löschen-Button destruktiv).

### UI-VAULT-DETAIL-FIELDS — Angaben (neu)
- `data-ui-id` am Wrapper. Aus `fields` je Typ: Login Benutzer, Ursprünge; API-Key Hosts, Header; SSH Benutzer; Datenbank Engine, Host, Port, Datenbank, Benutzer. **Nie** ein geheimer Wert.

### UI-VAULT-DETAIL-SECRET — Geheimer Wert (neu)
- `data-ui-id` je geheimer Zeile (`SecretRow`), pro Feld einmal. Immer genau zwölf `•` in `--type-mono`, unabhängig von der Länge; nirgends Teile des Werts.
- Icon-Buttons `Eye` und `Copy` nur für den Besitzer persönlicher Einträge oder mit `vault.reveal`. Der Wert wird erst beim Klick per `GET /api/vault/items/:id/secrets/:field` geholt, nie vorgeladen und nicht im Listenstate gehalten.
- Zustände: `selected` Wert sichtbar, nach 30 s und beim Wechsel/Verlassen des Eintrags wieder zwölf Punkte (Timer in `useEffect` aufräumen); `disabled` statt der Buttons „nur für Agenten nutzbar“ in `--subtext`; `success` „Kopiert“ über `copyToClipboard` + `sendToast`.
- In Impersonations-Sitzungen (`impersonating` aus `GET /api/vault/available`) erscheinen weder `Eye` noch `Copy`; die Zeile zeigt die zwölf Punkte und den `disabled`-Hinweis „nur für Agenten nutzbar“. Die Sitzung beantwortet Reveal ohnehin mit `403` (Spec, Abschnitt „Impersonation“). Keine neuen Zustände.

### UI-VAULT-DETAIL-SCOPE — Gilt für (neu)
- `data-ui-id` am Listen-Wrapper. Datenquelle `vault_bindings` und `allServers`: Server, Ordner (mit Unterordnern), Tags, oder „alle Server“. **Nicht** Besitzer und nicht Rechte.
- `empty`: „Für keinen Server freigegeben — kein Agent sieht diesen Eintrag.“

### UI-VAULT-DETAIL-POLICY — Freigabe erforderlich (neu)
- `data-ui-id` am Statusknoten. Aus `approvalRequired` und `lastUsedAt` (relative Zeit). `disabled`: „Ohne Freigabe nutzbar“.

## Ausdrücklich nicht
- Nie ein Teil eines Werts anzeigen (keine letzten vier Zeichen), nie eine Länge andeuten; kein Wert in Liste, Suche, Toast, Log oder URL.
- Typ-Icons nie farbig; keine KI-Symbolik; keine IDE-Optik (keine Icon-Spalte, keine Panels in Panels).
- Keine eigene Toast-/Kopierlogik: `navigator.clipboard` nicht direkt aufrufen (fehlt über http im LAN).
- Kein Server-Ordnerbaum und keine Tag-Verwaltung auf dieser Seite; Geltung wird nur angezeigt, bearbeitet im Dialog.
- Freigabe-Karte nicht hier bauen — sie hängt global in der Shell und wird nur über `uses` referenziert.

## i18n
Neuer Namensraum `vault.*` nach dem Schema `snippets.*` (`page.title`, `page.subtitle`, `page.addItem`, `scope.personal`, `types.all|login|apiKey|ssh|database|other`, `list.empty|error`, `detail.empty|error|fields|scope|policy`, `detail.edit|delete|deleteConfirm`, `secret.show|copy|copied|agentOnly`) und `common.sidebar.vault` neben `common.sidebar.snippets`. Texte wörtlich aus `copy:` des Manifests. `de_DE.json` zuerst, dann `en.json`; die übrigen Sprachen folgen dem üblichen Nachzug.

## Fertig, wenn
- Alle Marker auf Tier A; `/design-verify --screen UI-VAULT` MATCH.
