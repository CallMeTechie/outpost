const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile, execFileSync } = require("node:child_process");
const provision = require("../provision");

// The commands run for real in /bin/sh. PATH holds only the stub directory and a handful of
// coreutils, so no CLI, curl, wget or bash of the test machine can leak in.
const TOOLS = ["awk", "cat", "chmod", "grep", "mkdir", "mktemp", "mv", "rm", "tail"];
const SOURCE_LINE = "[ -f ~/.codex/outpost.env ] && . ~/.codex/outpost.env";
const ODD_URL = "https://out post.example/a'b\"c$(touch \"$HOME/pwned\")`touch \"$HOME/pwned2\"`;&|*?!#\\x/api/mcp";

const newKey = () => `outpost_${crypto.randomBytes(32).toString("hex")}`;
const prefixOf = (key) => key.slice(0, "outpost_".length + 6);
const ODD_KEY = newKey();

const node = (body) => `#!${process.execPath}\n${body}`;
const LOGIN_SH = `#!/bin/sh
if [ "$1" = "-lc" ]; then PATH="$HOME/login-bin:$PATH"; export PATH; exec /bin/sh -c "$2"; fi
exec /bin/sh "$@"
`;
const STUBS = {
    claude: node(`
const fs = require("fs");
const file = process.env.HOME + "/.claude.json";
fs.appendFileSync(process.env.HOME + "/claude-calls.log", JSON.stringify(process.argv.slice(2)) + "\\n");
const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { numStartups: 1 };
const servers = config.mcpServers || {};
const save = () => { config.mcpServers = servers; fs.writeFileSync(file, JSON.stringify(config, null, 2)); fs.chmodSync(file, 0o644); };
const [command, sub, ...rest] = process.argv.slice(2);
if (command !== "mcp") process.exit(2);
if (sub === "get") process.exit(servers[rest[0]] ? 0 : 1);
if (sub === "remove") { const name = rest[rest.length - 1]; if (!servers[name]) process.exit(1); delete servers[name]; save(); process.exit(0); }
if (sub !== "add") process.exit(2);
const options = {}; const positional = [];
for (let i = 0; i < rest.length; i++) { if (rest[i].startsWith("--")) options[rest[i]] = rest[++i]; else positional.push(rest[i]); }
const [headerName, ...headerValue] = options["--header"].split(": ");
servers[positional[0]] = { type: options["--transport"], url: positional[1], headers: { [headerName]: headerValue.join(": ") } };
save();
`),
    codex: node(`
const fs = require("fs");
const file = process.env.HOME + "/.codex/registrations.json";
fs.appendFileSync(process.env.HOME + "/codex-calls.log", JSON.stringify(process.argv.slice(2)) + "\\n");
const servers = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
const save = () => { fs.mkdirSync(process.env.HOME + "/.codex", { recursive: true }); fs.writeFileSync(file, JSON.stringify(servers)); };
const [command, sub, name, ...rest] = process.argv.slice(2);
if (command !== "mcp") process.exit(2);
if (sub === "get") process.exit(servers[name] ? 0 : 1);
if (sub === "remove") { if (!servers[name]) process.exit(1); delete servers[name]; save(); process.exit(0); }
if (sub !== "add" || fs.existsSync(process.env.HOME + "/fail-add")) process.exit(2);
servers[name] = rest;
save();
`),
    curl: node(`
const fs = require("fs");
const args = process.argv.slice(2);
const file = args[args.indexOf("-H") + 1].slice(1);
fs.writeFileSync(process.env.HOME + "/curl-call.json", JSON.stringify({ args, file, content: fs.readFileSync(file, "utf8"), mode: fs.statSync(file).mode & 0o777 }));
process.stdout.write('{"seenIp":"192.0.2.7"}');
`),
    wget: node(`
const fs = require("fs");
const args = process.argv.slice(2);
const file = args.find((arg) => arg.startsWith("--config=")).slice("--config=".length);
fs.writeFileSync(process.env.HOME + "/wget-call.json", JSON.stringify({ args, file, content: fs.readFileSync(file, "utf8"), mode: fs.statSync(file).mode & 0o777 }));
process.stdout.write('{"seenIp":"192.0.2.7"}');
`),
};

const makeHome = (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "outpost-provision-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const [home, bin, tools, tmp] = ["home", "bin", "tools", "tmp"].map((name) => path.join(root, name));
    for (const dir of [home, bin, tools, tmp]) fs.mkdirSync(dir);
    for (const tool of TOOLS)
        fs.symlinkSync(execFileSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim(), path.join(tools, tool));
    fs.writeFileSync(path.join(bin, "sh"), LOGIN_SH, { mode: 0o755 });

    const install = (name, dir = path.join(home, ".local/bin")) => {
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, name);
        fs.writeFileSync(file, STUBS[name], { mode: 0o755 });
        return file;
    };
    const run = (command) => new Promise((resolve) => {
        execFile("/bin/sh", ["-c", command], { env: { HOME: home, PATH: `${bin}:${tools}`, TMPDIR: tmp } },
            (error, stdout) => resolve({ code: error ? error.code : 0, stdout }));
    });
    const read = (name) => fs.readFileSync(path.join(home, name), "utf8");
    const calls = (name) => read(`${name}-calls.log`).trim().split("\n").map((line) => JSON.parse(line));
    const drop = (key) => run(provision.keyDropCommand({ keyPrefix: prefixOf(key), key }));
    const pwned = () => fs.readdirSync(home).filter((name) => name.startsWith("pwned"));
    return { home, bin, install, run, drop, read, calls, pwned };
};


test("Spec-Test 9: der Claude-Befehl reicht URL und Key mit Sonderzeichen unverändert weiter und macht ~/.claude.json privat", async (t) => {
    const env = makeHome(t);
    const cliPath = env.install("claude");
    fs.writeFileSync(path.join(env.home, ".claude.json"), JSON.stringify({
        mcpServers: { outpost: { type: "http", url: "http://old", headers: { Authorization: "Bearer outpost_old" } } },
    }, null, 2));

    const dropCommand = provision.keyDropCommand({ keyPrefix: prefixOf(ODD_KEY), key: ODD_KEY });
    const commands = [
        provision.claudeSetupCommand({ cliPath, url: ODD_URL, keyPrefix: prefixOf(ODD_KEY) }),
        provision.setupCommand({ agentType: "codex", cliPath, url: ODD_URL, keyPrefix: prefixOf(ODD_KEY) }),
        provision.probeCommand({ url: ODD_URL, keyPrefix: prefixOf(ODD_KEY) }),
        provision.keyCleanupCommand({ keyPrefix: prefixOf(ODD_KEY) }),
    ];
    assert.ok(dropCommand.includes(ODD_KEY));
    assert.ok(commands.every((command) => !command.includes(ODD_KEY)));
    assert.ok(!/claude|codex|curl|wget/.test(dropCommand));
    assert.throws(() => provision.keyDropCommand({ keyPrefix: prefixOf(ODD_KEY), key: "outpost_k'e$(id)" }), TypeError);
    assert.strictEqual((await env.drop(ODD_KEY)).code, 0);
    assert.strictEqual(fs.statSync(path.join(env.home, ".config/outpost")).mode & 0o777, 0o700);
    assert.strictEqual(fs.statSync(path.join(env.home, `.config/outpost/key-${prefixOf(ODD_KEY)}`)).mode & 0o777, 0o600);

    const { code, stdout } = await env.run(commands[0]);

    assert.strictEqual(code, 0);
    assert.match(stdout, /^OUTPOST_REPLACED=1$/m);
    assert.deepStrictEqual(env.calls("claude"), [
        ["mcp", "get", "outpost"],
        ["mcp", "remove", "--scope", "user", "outpost"],
        ["mcp", "add", "--scope", "user", "--transport", "http", "outpost", ODD_URL, "--header", `Authorization: Bearer ${ODD_KEY}`],
    ]);
    assert.strictEqual(fs.statSync(path.join(env.home, ".claude.json")).mode & 0o777, 0o600);
    assert.deepStrictEqual(fs.readdirSync(path.join(env.home, ".config/outpost")), []);
    assert.deepStrictEqual(env.pwned(), []);
});

test("Spec-Test 9: Codex liest den Key aus einer privaten Datei, die jede Shell genau einmal einbindet; scheitert die Registrierung, bleibt die alte Datei", async (t) => {
    const env = makeHome(t);
    const cliPath = env.install("codex");
    fs.writeFileSync(path.join(env.home, ".zshrc"), "export ZSH_SEEN=1");
    const command = provision.setupCommand({ agentType: "codex", cliPath, url: ODD_URL, keyPrefix: prefixOf(ODD_KEY) });

    await env.drop(ODD_KEY);
    assert.strictEqual((await env.run(command)).code, 0);
    await env.drop(ODD_KEY);
    const second = await env.run(command);

    assert.strictEqual(second.code, 0);
    assert.match(second.stdout, /^OUTPOST_REPLACED=1$/m);
    assert.strictEqual(fs.statSync(path.join(env.home, ".codex/outpost.env")).mode & 0o777, 0o600);
    assert.strictEqual((await env.run(". \"$HOME/.codex/outpost.env\"; printf '%s' \"$OUTPOST_MCP_TOKEN\"")).stdout, ODD_KEY);
    assert.strictEqual(env.read(".bashrc"), `${SOURCE_LINE}\n`);
    assert.strictEqual(env.read(".profile"), `${SOURCE_LINE}\n`);
    assert.strictEqual(env.read(".zshrc"), `export ZSH_SEEN=1\n${SOURCE_LINE}\n`);
    assert.strictEqual(fs.existsSync(path.join(env.home, ".bash_profile")), false);
    const add = ["mcp", "add", "outpost", "--url", ODD_URL, "--bearer-token-env-var", "OUTPOST_MCP_TOKEN"];
    assert.deepStrictEqual(env.calls("codex"), [["mcp", "get", "outpost"], add, ["mcp", "get", "outpost"], ["mcp", "remove", "outpost"], add]);
    assert.deepStrictEqual(env.pwned(), []);

    fs.writeFileSync(path.join(env.home, "fail-add"), "");
    const other = newKey();
    await env.drop(other);
    const failed = await env.run(provision.setupCommand({ agentType: "codex", cliPath, url: ODD_URL, keyPrefix: prefixOf(other) }));
    assert.notStrictEqual(failed.code, 0);
    assert.match(failed.stdout, /^OUTPOST_REPLACED=1$/m);
    assert.strictEqual((await env.run(". \"$HOME/.codex/outpost.env\"; printf '%s' \"$OUTPOST_MCP_TOKEN\"")).stdout, ODD_KEY);
});

test("die Probe gibt den Key nur über eine 0600-Datei an curl bzw. wget und löscht die Datei danach", async (t) => {
    const env = makeHome(t);
    const url = "https://outpost.example/x'y$(touch \"$HOME/pwned\")/api/vault/agent-keys/probe";
    const command = provision.probeCommand({ url, keyPrefix: prefixOf(ODD_KEY) });
    await env.drop(ODD_KEY);

    env.install("curl", env.bin);
    assert.deepStrictEqual(await env.run(command), { code: 0, stdout: "{\"seenIp\":\"192.0.2.7\"}" });
    const curl = JSON.parse(env.read("curl-call.json"));
    assert.deepStrictEqual([curl.content, curl.mode, curl.args.at(-1)], [`Authorization: Bearer ${ODD_KEY}\n`, 0o600, url]);
    assert.ok(!curl.args.some((arg) => arg.includes(ODD_KEY)));
    assert.strictEqual(fs.existsSync(curl.file), false);

    fs.rmSync(path.join(env.bin, "curl"));
    env.install("wget", env.bin);
    assert.strictEqual((await env.run(command)).code, 0);
    const wget = JSON.parse(env.read("wget-call.json"));
    assert.deepStrictEqual([wget.content, wget.mode, wget.args.at(-1)], [`header = Authorization: Bearer ${ODD_KEY}\n`, 0o600, url]);
    assert.strictEqual(fs.existsSync(wget.file), false);

    fs.rmSync(path.join(env.bin, "wget"));
    assert.strictEqual((await env.run(command)).code, 127);
    assert.deepStrictEqual(env.pwned(), []);
});

test("die CLI-Suche nimmt den Pfad der Login-Shell, sonst die bekannten Installationsorte", async (t) => {
    const env = makeHome(t);

    assert.deepStrictEqual(await env.run(provision.findCliCommand("codex")), { code: 1, stdout: "" });
    const fallback = env.install("codex");
    assert.strictEqual((await env.run(provision.findCliCommand("codex"))).stdout, `${fallback}\n`);
    const login = env.install("codex", path.join(env.home, "login-bin"));
    assert.strictEqual((await env.run(provision.findCliCommand("codex"))).stdout, `${login}\n`);
});

test("Review Focus 4: Prüfen und Entziehen erkennen nur eine Registrierung, die noch den eigenen Key trägt", async (t) => {
    const env = makeHome(t);
    const [mine, theirs] = [newKey(), newKey()];
    fs.writeFileSync(path.join(env.home, ".claude.json"), JSON.stringify({
        projects: { "/srv": { mcpServers: { outpost: { type: "http", url: "x", headers: { Authorization: `Bearer ${mine}` } } } } },
    }, null, 2));
    const registered = {
        claude: () => JSON.parse(env.read(".claude.json")).mcpServers?.outpost?.headers.Authorization ?? null,
        codex: () => (fs.existsSync(path.join(env.home, ".codex/outpost.env")) ? env.read(".codex/outpost.env") : null),
    };

    for (const agentType of ["claude", "codex"]) {
        const cliPath = env.install(agentType);
        await env.drop(theirs);
        assert.strictEqual((await env.run(provision.setupCommand({ agentType, cliPath, url: "https://outpost.example/api/mcp", keyPrefix: prefixOf(theirs) }))).code, 0);
        const revokeMine = provision.revokeCommands({ agentType, keyPrefix: prefixOf(mine) });
        const revokeTheirs = provision.revokeCommands({ agentType, keyPrefix: prefixOf(theirs) });
        const check = async (key) => (await env.run(provision.registrationCheckCommand({ agentType, keyPrefix: prefixOf(key) }))).stdout;

        assert.deepStrictEqual([await check(mine), await check(theirs)], ["OTHER\n", "MATCH\n"], agentType);
        assert.strictEqual((await env.run(revokeMine)).stdout, "FOREIGN\n", agentType);
        assert.match(registered[agentType](), new RegExp(theirs), agentType);
        assert.ok(!env.calls(agentType).some(([, sub]) => sub === "remove"), agentType);

        assert.strictEqual((await env.run(revokeTheirs)).stdout, "REMOVED\n", agentType);
        assert.strictEqual(registered[agentType](), null, agentType);
        assert.strictEqual((await env.run(revokeMine)).stdout, "ABSENT\n", agentType);
        assert.strictEqual(await check(theirs), "ABSENT\n", agentType);
    }
});
