#!/usr/bin/env node
// Statuszeile für Claude Code, die Outpost mitlesen kann.
//
// Einrichtung je Rechner, in ~/.claude/settings.json:
//
//   { "statusLine": { "type": "command", "command": "node /pfad/zu/outpost-statusline.js" } }
//
// Claude Code ruft das hier bei jeder Neuzeichnung auf und gibt ein JSON auf stdin, in dem
// der Pfad zum Transkript der eigenen Sitzung steht. Von dort kommt der Füllstand -- und
// zwar von innen, weil sich mehrere Sitzungen desselben Werkzeugs im selben Verzeichnis von
// außen nicht auseinanderhalten lassen (der Prozess hält seine Verlaufsdatei nicht offen).
//
// Ausgegeben wird eine gewöhnliche Statuszeile für den Menschen, mit der Marke ⟦ctx …⟧ darin
// für Outpost. Sichtbar statt versteckt: eine unsichtbare Escape-Folge müsste erst durch
// Claude Codes eigene Darstellung hindurch, und was du ohnehin sehen willst, muss sich nicht
// verstecken.

const fs = require("node:fs");
const path = require("node:path");
const { contextPercent, windowForModel, formatToken } = require(path.join(__dirname, "agentContext.js"));

const TOOL = "claude";

const readStdin = () => {
    try {
        return fs.readFileSync(0, "utf8");
    } catch {
        return "";
    }
};

// Das Eingabe-JSON ist nicht in allen Fassungen gleich aufgebaut. Deshalb wird jedes Feld
// einzeln und nachsichtig gesucht: fehlt eines, fällt nur der zugehörige Teil der Zeile weg,
// statt dass die Statuszeile ganz verschwindet.
const pick = (object, ...pathsToTry) => {
    for (const candidate of pathsToTry) {
        let value = object;
        for (const key of candidate.split(".")) value = value?.[key];
        if (typeof value === "string" && value) return value;
    }
    return null;
};

const main = () => {
    // Ohne Anfangswert: der würde in jedem Zweig überschrieben und ist damit tote Zuweisung.
    let input;
    try {
        input = JSON.parse(readStdin() || "{}");
    } catch {
        input = {};
    }

    const model = pick(input, "model.id", "model.display_name", "model");
    const cwd = pick(input, "workspace.current_dir", "cwd", "workspace.project_dir");
    const transcript = pick(input, "transcript_path");

    const parts = [];
    if (model) parts.push(model);
    if (cwd) parts.push(path.basename(cwd));

    let percent = null;
    if (transcript) {
        try {
            const lines = fs.readFileSync(transcript, "utf8").split("\n").filter(Boolean);
            percent = contextPercent(lines, windowForModel(model));
        } catch {
            // Transkript noch nicht angelegt oder nicht lesbar: kein Grund, die Zeile
            // wegzulassen -- sie zeigt dann eben nur Modell und Verzeichnis.
        }
    }

    if (percent !== null) parts.push(`ctx ${percent}%`, formatToken(TOOL, percent));

    process.stdout.write(parts.join("  ") || TOOL);
};

main();
