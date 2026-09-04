# Direkt verbinden — Umsetzungsanleitung (UI-DIRECT-CONNECT)

Artboard: docs/design/mockups/ui-direct-connect.html · Manifest-Revision: 1

Bestehend: `client/src/pages/Servers/components/DirectConnectDialog/`.

## Wo im Code
- `DirectConnectDialog.jsx` — Host/Port → `UI-DIRECT-CONNECT-HOST`; Auth-Block → `UI-DIRECT-CONNECT-AUTH`; Button → `UI-DIRECT-CONNECT-GO`
- Wiederverwenden: `DialogProvider`, `Input`, `SelectBox` (`authOptions`), `Button`

## Darstellung
- Art: Dialog, modal, über `UI-SERVERS`. Öffnen: Welcome › Schnellverbindung, Kontextmenü › Direkt verbinden, Taste `Ctrl+K`. Schließen: Esc, Backdrop; nach Verbinden automatisch.
- Größe: mittig, 32 rem breit. Tastatur: Enter = Verbinden.

## Elemente
### UI-DIRECT-CONNECT-HOST
- `data-ui-id` am Zeilen-Wrapper (Host + Port). `error` „Host nicht erreichbar."

### UI-DIRECT-CONNECT-AUTH
- `data-ui-id` am Block. Auswahl Passwort / SSH-Key / beides (`servers.dialog.identities.*`), dann Benutzername, Passwort, Key, Passphrase je nach Auswahl.
- Zugangsdaten gelten **nur für diese Verbindung** — nichts wird als Identität gespeichert. `error` „Anmeldung abgelehnt."

### UI-DIRECT-CONNECT-GO
- `data-ui-id` am Button „Verbinden". `disabled` ohne Host; `loading` „Verbinde …" mit gesperrtem Formular. Erfolg: neuer Session-Tab, Dialog schließt.

## Ausdrücklich nicht
- Kein „Als Server speichern"-Umweg im Dialog — dafür ist `UI-SERVER-DIALOG` da.

## Fertig, wenn
- Drei Marker auf Tier A; `/design-verify --screen UI-DIRECT-CONNECT` MATCH.
