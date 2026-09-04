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
- Mit gewähltem Eintrag sind beide Felder gefüllt und **gesperrt** — das Ziel steht dann fest, und ein editierbares Feld würde einen erlaubten Eintrag an einen beliebigen Host lenken. Ohne Eintrag sind sie die Eingabe für die Einmalverbindung.
- Serverseitig: `entryId` und `directTarget` schließen sich aus (`validations/serverSession.js`). Die Einmalverbindung verlangt die Systemberechtigung `connect.direct` (Voreinstellung **aus**, Administratoren haben sie), und die Grundpflicht einer Organisation greift weiter — sie wird über die Mitgliedschaften des Kontos gelesen, nicht über den fehlenden Eintrag. `ssh` und `telnet` sind die einzigen Protokolle; RDP, VNC und Proxmox brauchen einen Eintrag für Engine- und Renderer-Einstellungen.

### UI-DIRECT-CONNECT-AUTH
- `data-ui-id` am Block. Auswahl Passwort / SSH-Key / beides (`servers.dialog.identities.*`), dann Benutzername, Passwort, Key, Passphrase je nach Auswahl.
- Zugangsdaten gelten **nur für diese Verbindung** — nichts wird als Identität gespeichert. `error` „Anmeldung abgelehnt."

### UI-DIRECT-CONNECT-GO
- `data-ui-id` am Button „Verbinden". `disabled` ohne Host; `loading` „Verbinde …" mit gesperrtem Formular. Erfolg: neuer Session-Tab, Dialog schließt.

## Ausdrücklich nicht
- Kein „Als Server speichern"-Umweg im Dialog — dafür ist `UI-SERVER-DIALOG` da. Das Ziel einer Einmalverbindung wird auch intern **nicht** als Eintrag angelegt: es reist auf der Session und wird für den Verbindungsaufbau zu einem flüchtigen Entry-Objekt geformt (`utils/directTarget.js`).
- Eine Einmalverbindung lässt sich **nicht teilen** und ist **kein SFTP-Ziel**: beide Pfade brauchen einen gespeicherten Eintrag und lehnen sauber ab (`wsAuth.js` 4005, `share.js` 404; die Validierung lässt für `directTarget` ohnehin nur `ssh` und `telnet` zu). Sie erscheint auch nicht in den Live-Sessions einer Organisation, weil sie keiner angehört.
- Kein `error`-Zustand, der eine abgelehnte Anmeldung behauptet: `POST /connections` antwortet mit 201, **bevor** der SSH-Login versucht wird; die Ablehnung erreicht den Session-Tab, nie den Dialog. Der Fehlerzweig zeigt die echte Servermeldung (403, 400, 500) statt einer Ursache, die er nicht kennen kann.

## Fertig, wenn
- Drei Marker auf Tier A; `/design-verify --screen UI-DIRECT-CONNECT` MATCH.
