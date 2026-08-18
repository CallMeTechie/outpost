const escapeColons = (t) => t.replace(/:/g, "\\x3A");
const unescapeColons = (t) => t.replace(/\\x3A/g, ":");

const parseOptions = (str) => {
    const s = str.replace(/\\"/g, "\"");
    const opts = [];
    let cur = "", inQ = false;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === "\"" && (i === 0 || s[i - 1] === " ")) inQ = true;
        else if (c === "\"" && inQ) { inQ = false; opts.push(cur.trim()); cur = ""; }
        else if (c === " " && !inQ) { if (cur.trim()) { opts.push(cur.trim()); cur = ""; } }
        else cur += c;
    }
    if (cur.trim()) opts.push(cur.trim());
    return opts;
};

const checkSudoPrompt = (output) => {
    const patterns = ["[sudo] password for", "Password:", "sudo: a password is required", "sudo: a terminal is required"];
    if (!patterns.some(p => output.includes(p))) return null;
    const m = output.match(/\[sudo\] password for ([^:]+):/);
    return { variable: "SUDO_PASSWORD", prompt: `Enter sudo password for ${m?.[1] || "user"}`, default: "", isSudoPassword: true, type: "password" };
};

const transformScript = (content) => {
    const esc = (t) => t.replace(/:/g, "\\x3A");
    let t = content
        .replace(/^(\s*)sudo(?!\s+-S)(\s+)/gm, "$1sudo -S$2")
        .replace(/^(\s*)@OUTPOST:STEP\s+"((?:\\.|[^"\\])*)"/gm, "$1echo \"OUTPOST_STEP:$2\"")
        .replace(/^(\s*)@OUTPOST:INPUT\s+(\S+)\s+"((?:\\.|[^"\\])*)"(?:\s+"((?:\\.|[^"\\]*)*)")?/gm, (_, i, v, p, d) =>
            `${i}echo "OUTPOST_INPUT:${v}:${esc(p)}:${d ? esc(d) : ""}" && read -r ${v}`)
        .replace(/^(\s*)@OUTPOST:SELECT\s+"((?:\\.|[^"\\])*)"\s+"((?:\\.|[^"\\])*)"\s+(.+)/gm, (_, i, v, p, o) =>
            `${i}echo "OUTPOST_SELECT:${v}:${esc(p)}:${esc(o).replace(/"/g, "\\\"")}" && read -r ${v}`)
        .replace(/^(\s*)@OUTPOST:SELECT\s+(\S+)\s+"((?:\\.|[^"\\])*)"\s+(.+)/gm, (_, i, v, p, o) =>
            `${i}echo "OUTPOST_SELECT:${v}:${esc(p)}:${esc(o).replace(/"/g, "\\\"")}" && read -r ${v}`)
        .replace(/^(\s*)@OUTPOST:WARN\s+"((?:\\.|[^"\\])*)"/gm, (_, i, m) => `${i}echo "OUTPOST_WARN:${esc(m)}"`)
        .replace(/^(\s*)@OUTPOST:INFO\s+"((?:\\.|[^"\\])*)"/gm, (_, i, m) => `${i}echo "OUTPOST_INFO:${esc(m)}"`)
        .replace(/^(\s*)@OUTPOST:CONFIRM\s+"((?:\\.|[^"\\])*)"/gm, (_, i, m) =>
            `${i}echo "OUTPOST_CONFIRM:${esc(m)}" && read -r OUTPOST_CONFIRM_RESULT`)
        .replace(/^(\s*)@OUTPOST:PROGRESS\s+(\$?\w+|\d+)/gm, "$1echo \"OUTPOST_PROGRESS:$2\"")
        .replace(/^(\s*)@OUTPOST:SUCCESS\s+"((?:\\.|[^"\\])*)"/gm, (_, i, m) => `${i}echo "OUTPOST_SUCCESS:${esc(m)}"`)
        .replace(/^(\s*)@OUTPOST:SUMMARY\s+"((?:\\.|[^"\\])*)"\s+(.+)/gm, (_, i, ti, d) =>
            `${i}echo "OUTPOST_SUMMARY:${esc(ti).replace(/"/g, "\\\"")}:${esc(d).replace(/"/g, "\\\"")}" && read -r OUTPOST_SUMMARY_RESULT`)
        .replace(/^(\s*)@OUTPOST:TABLE\s+"((?:\\.|[^"\\])*)"\s+(.+)/gm, (_, i, ti, d) =>
            `${i}echo "OUTPOST_TABLE:${esc(ti).replace(/"/g, "\\\"")}:${esc(d).replace(/"/g, "\\\"")}" && read -r OUTPOST_TABLE_RESULT`)
        .replace(/^(\s*)@OUTPOST:MSGBOX\s+"((?:\\.|[^"\\])*)"\s+"((?:\\.|[^"\\])*)"/gm, (_, i, ti, m) =>
            `${i}echo "OUTPOST_MSGBOX:${esc(ti)}:${esc(m)}" && read -r OUTPOST_MSGBOX_RESULT`);

    const script = `#!/bin/bash\nset -e\n${t}\n`;
    const b64 = Buffer.from(script).toString("base64");
    return { b64, command: null };
};

const getScriptCommands = (b64) => {
    const CHUNK_SIZE = 2000;
    const commands = [];

    commands.push(`_nts=$(mktemp) && _ntb=$(mktemp)`);
    
    for (let i = 0; i < b64.length; i += CHUNK_SIZE) {
        const chunk = b64.slice(i, i + CHUNK_SIZE);
        commands.push(`printf '%s' '${chunk}' >> "$_ntb"`);
    }
    
    commands.push(`base64 -d < "$_ntb" > "$_nts" && rm -f "$_ntb" && chmod +x "$_nts" && echo "OUTPOST_READY" && "$_nts"; _exit=$?; rm -f "$_nts"; echo "OUTPOST_END:$_exit"`);
    
    return commands;
};

const stripAnsi = (s) => s.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");

const findNextermCommand = (line) => {
    const clean = stripAnsi(line);
    if (clean.match(/echo\s+["']?OUTPOST_/i) || clean.trim().match(/^[$#>]\s+.*OUTPOST_/)) return null;
    const m = clean.match(/OUTPOST_(INPUT|SELECT|STEP|WARN|INFO|CONFIRM|PROGRESS|SUCCESS|SUMMARY|TABLE|MSGBOX|END):(.*)/s);
    return m ? { command: `OUTPOST_${m[1]}`, rest: m[2] } : null;
};

const processNextermLine = (line) => {
    const found = findNextermCommand(line);
    if (!found) return null;
    const { command, rest } = found;
    const parts = rest.split(":");
    const unescape = unescapeColons;

    switch (command) {
        case "OUTPOST_INPUT":
            return { type: "input", variable: parts[0], prompt: unescape(parts[1] || ""), default: parts[2] ? unescape(parts[2]) : "" };
        case "OUTPOST_SELECT": {
            const opts = parseOptions(unescape(parts.slice(2).join(":")));
            return { type: "select", variable: parts[0], prompt: unescape(parts[1] || ""), options: opts, default: opts[0] || "" };
        }
        case "OUTPOST_STEP": return { type: "step", description: rest.trim() };
        case "OUTPOST_WARN": return { type: "warning", message: unescape(rest) };
        case "OUTPOST_INFO": return { type: "info", message: unescape(rest) };
        case "OUTPOST_CONFIRM": return { type: "confirm", message: unescape(rest) };
        case "OUTPOST_PROGRESS": return { type: "progress", percentage: parseInt(rest.split(":")[0]) || 0 };
        case "OUTPOST_SUCCESS": return { type: "success", message: unescape(rest) };
        case "OUTPOST_SUMMARY": {
            const data = parseOptions(unescape(parts.slice(1).join(":")));
            return { type: "summary", title: unescape(parts[0] || ""), data };
        }
        case "OUTPOST_TABLE": {
            const data = parseOptions(unescape(parts.slice(1).join(":")));
            return { type: "table", title: unescape(parts[0] || ""), data };
        }
        case "OUTPOST_MSGBOX": return { type: "msgbox", title: unescape(parts[0] || ""), message: unescape(parts.slice(1).join(":")) };
        case "OUTPOST_END": return { type: "end", exitCode: parseInt(rest.trim()) || 0 };
        default: return null;
    }
};

module.exports = { escapeColons, unescapeColons, parseOptions, checkSudoPrompt, transformScript, getScriptCommands, stripAnsi, findNextermCommand, processNextermLine };