#!/usr/bin/env node
// Die Kontextfüllung des Agenten, der in einem tmux-Pane läuft — für Werkzeuge ohne eigene
// Statuszeile.
//
// Einrichtung je Rechner, in ~/.tmux.conf:
//
//   set -g status-right "#(node /pfad/zu/outpost-ctx.js #{pane_pid}) %d.%m. %H:%M "
//   set -g status-interval 5
//
// tmux zeichnet seine Statusleiste in dasselbe Terminal, das Outpost anzeigt. Damit landet
// die Marke im Strom, ohne dass das Werkzeug selbst etwas davon wissen muss — und sie
// erneuert sich auch, während der Agent nur wartet.
//
// Ein neues Werkzeug braucht genau einen Eintrag in READERS. Findet sich keiner, wird nichts
// ausgegeben; die Statusleiste bleibt dann eben ohne diesen Teil.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
    qwenContextPercent, QWEN_DEFAULT_WINDOW, formatToken,
} = require(path.join(__dirname, "agentContext.js"));

const home = () => process.env.HOME || os.homedir();

// Die Prozesse unterhalb eines Panes, in der Reihenfolge, in der sie gestartet wurden.
// Nicht nur das Kind: der Agent läuft oft unter einer Shell oder einem Wrapper.
const descendants = (pid) => {
    try {
        const out = execFileSync("ps", ["-eo", "pid=,ppid=,comm="], { encoding: "utf8" });
        const rows = out.split("\n").map((l) => l.trim().split(/\s+/)).filter((r) => r.length >= 3);
        const byParent = new Map();
        for (const [id, parent, ...rest] of rows) {
            const list = byParent.get(parent) ?? [];
            list.push({ pid: id, comm: rest.join(" ") });
            byParent.set(parent, list);
        }
        const found = [];
        const walk = (id, depth) => {
            if (depth > 6) return;
            for (const child of byParent.get(String(id)) ?? []) {
                found.push(child);
                walk(child.pid, depth + 1);
            }
        };
        walk(pid, 0);
        return found;
    } catch {
        return [];
    }
};

const readLines = (file) => {
    try {
        return fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    } catch {
        return [];
    }
};

// Je Werkzeug: woran man seinen Prozess erkennt, und wie sich daraus der Füllstand ergibt.
const READERS = {
    qwen: {
        matches: (comm) => comm === "qwen",
        percent: (pid) => {
            const sessionFile = path.join(home(), ".qwen", "sessions", `${pid}.json`);
            let session;
            try {
                session = fs.readFileSync(sessionFile, "utf8");
            } catch {
                return null;
            }
            const usageDir = path.join(home(), ".qwen", "usage");
            let files;
            try {
                files = fs.readdirSync(usageDir).filter((f) => f.startsWith("token-usage-")).sort();
            } catch {
                return null;
            }
            // Nur die beiden jüngsten Monatsdateien: eine laufende Sitzung steht nicht in
            // einer Datei von vorletztem Jahr, und alles zu lesen kostet bei jedem
            // tmux-Takt unnötig.
            const lines = files.slice(-2).flatMap((f) => readLines(path.join(usageDir, f)));
            const window = Number(process.env.OUTPOST_CTX_WINDOW) || QWEN_DEFAULT_WINDOW;
            return qwenContextPercent(session, lines, window);
        },
    },
};

const main = () => {
    const panePid = process.argv[2];
    if (!panePid || !/^\d+$/.test(panePid)) return;

    for (const proc of descendants(panePid)) {
        for (const [tool, reader] of Object.entries(READERS)) {
            if (!reader.matches(proc.comm)) continue;
            const percent = reader.percent(proc.pid);
            // Kein Messwert heißt: nichts ausgeben. Eine 0 würde behaupten, gemessen worden
            // zu sein.
            if (percent === null) return;
            process.stdout.write(`${formatToken(tool, percent)} `);
            return;
        }
    }
};

main();
