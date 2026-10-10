const CLI_NAMES = new Set(["claude", "codex"]);
const CLI_DIRS = ["$HOME/.local/bin", "$HOME/.claude/local", "$HOME/.npm-global/bin"];
const CODEX_ENV = "$HOME/.codex/outpost.env";
const SOURCE_LINE = "[ -f ~/.codex/outpost.env ] && . ~/.codex/outpost.env";
const RC_FILES = ["$HOME/.bashrc", "$HOME/.profile", "$HOME/.bash_profile", "$HOME/.zshrc"];
const KEY_PREFIX = /^[A-Za-z0-9_]{8,64}$/;
const KEY_TOKEN = /^[A-Za-z0-9_]{16,128}$/;
const KEY_FILE = /^key-\d{1,12}-[0-9a-f]{16}$/;
const KEY_DIR = "$HOME/.config/outpost";

// Relies on the layout Claude Code writes (JSON.stringify with two spaces): only the user-scope
// registration sits at this depth, project registrations are nested deeper and never match.
const CLAUDE_REGISTRATION_AWK = [
    "/^  \"mcpServers\": \\{/ { m = 1; next }",
    "m && /^  \\}/ { exit }",
    "m && /^    \"outpost\": \\{/ { o = 1; s = \"OTHER\"; next }",
    "o && /^    \\}/ { exit }",
    "o && index($0, p) { s = \"MATCH\"; exit }",
    "END { print s }",
].join("\n");

const shQuote = (value) => {
    if (typeof value !== "string" || value.includes("\0")) throw new TypeError("shQuote needs a string without NUL bytes");
    return `'${value.replace(/'/g, "'\\''")}'`;
};

const cliName = (name) => {
    if (!CLI_NAMES.has(name)) throw new TypeError(`Unknown agent CLI: ${name}`);
    return name;
};

// execCommand hands the string to the login shell of the remote user, which need not be POSIX.
const asCommand = (lines) => `/bin/sh -c ${shQuote(["umask 077", ...lines].join("\n"))}`;

const findCliScript = (name) => {
    const lookup = shQuote(`command -v ${cliName(name)}`);
    const candidates = ["\"$p\"", ...CLI_DIRS.map((dir) => `"${dir}/${name}"`)].join(" ");
    return [
        "(",
        `p=$(bash -lc ${lookup} 2>/dev/null </dev/null | tail -n 1)`,
        `[ -n "$p" ] || p=$(sh -lc ${lookup} 2>/dev/null </dev/null | tail -n 1)`,
        `for c in ${candidates}; do`,
        "case \"$c\" in /*) if [ -x \"$c\" ] && [ ! -d \"$c\" ]; then printf '%s\\n' \"$c\"; exit 0; fi ;; esac",
        "done",
        "exit 1",
        ")",
    ].join("\n");
};

const findCliCommand = (name) => asCommand([findCliScript(name)]);

const keyPath = (keyFile) => {
    if (typeof keyFile !== "string" || !KEY_FILE.test(keyFile)) throw new TypeError("Invalid key file name");
    return `${KEY_DIR}/${keyFile}`;
};

// The key travels in argv only inside keyDropCommand. Everything else reads it from the drop file via
// a builtin printf/redirect; a literal key is for the copy command shown to the user.
const keyWord = ({ keyFile, key }, before = "", after = "") => (keyFile !== undefined
    ? {
        setup: [`k="${keyPath(keyFile)}"`, "key=$(cat \"$k\") && [ -n \"$key\" ] || exit 1"],
        word: `"${before}$key${after}"`,
        cleanup: ["rm -f \"$k\""],
    }
    : { setup: [], word: shQuote(`${before}${key}${after}`), cleanup: [] });

const withCliPath = ["case \"$cli\" in /*) PATH=\"${cli%/*}:$PATH\"; export PATH ;; esac"];

const keyDropCommand = ({ keyFile, key }) => {
    if (typeof key !== "string" || !KEY_TOKEN.test(key)) throw new TypeError("Invalid key");
    return asCommand([
        `mkdir -p "${KEY_DIR}" || exit 1`,
        `chmod 700 "${KEY_DIR}" || exit 1`,
        `printf '%s' ${shQuote(key)} > "${keyPath(keyFile)}" || exit 1`,
    ]);
};

const keyCleanupCommand = ({ keyFile }) => asCommand([`rm -f "${keyPath(keyFile)}"`]);

const claudeSetupCommand = ({ cliPath, url, key, keyFile }) => {
    const header = keyWord({ keyFile, key }, "Authorization: Bearer ");
    return asCommand([
    `cli=${shQuote(cliPath)}`,
    ...withCliPath,
    ...header.setup,
    "if \"$cli\" mcp get outpost >/dev/null 2>&1; then",
    "echo OUTPOST_REPLACED=1",
    "\"$cli\" mcp remove --scope user outpost >/dev/null 2>&1 || true",
    "else",
    "echo OUTPOST_REPLACED=0",
    "fi",
    `"$cli" mcp add --scope user --transport http outpost ${shQuote(url)} --header ${header.word} >/dev/null || exit 1`,
    "if [ -f \"$HOME/.claude.json\" ]; then chmod 600 \"$HOME/.claude.json\" || exit 1; fi",
    ...header.cleanup,
    ]);
};

// The key file comes last and is swapped in whole: until then the previous key stays readable.
const codexEnvCommand = ({ key, keyFile }) => {
    const line = keyWord({ keyFile, key }, "export OUTPOST_MCP_TOKEN='", "'");
    return asCommand([
    ...line.setup,
    "mkdir -p \"$HOME/.codex\" || exit 1",
    `line=${shQuote(SOURCE_LINE)}`,
    `for rc in ${RC_FILES.map((file) => `"${file}"`).join(" ")}; do`,
    "case \"$rc\" in */.bash_profile|*/.zshrc) [ -f \"$rc\" ] || continue ;; esac",
    "grep -qxF \"$line\" \"$rc\" 2>/dev/null && continue",
    "if [ -s \"$rc\" ] && [ -n \"$(tail -c 1 \"$rc\")\" ]; then echo >> \"$rc\"; fi",
    "printf '%s\\n' \"$line\" >> \"$rc\" || exit 1",
    "done",
    `f="${CODEX_ENV}"`,
    "rm -f \"$f.new\"",
    `printf '%s\\n' ${line.word} > "$f.new" || exit 1`,
    "chmod 600 \"$f.new\" || exit 1",
    "mv -f \"$f.new\" \"$f\" || exit 1",
    ...line.cleanup,
    ]);
};

const codexSetupCommand = ({ cliPath, url, key, keyFile }) => asCommand([
    `cli=${shQuote(cliPath)}`,
    ...withCliPath,
    ...keyWord({ keyFile, key }).setup,
    "if \"$cli\" mcp get outpost >/dev/null 2>&1; then",
    "echo OUTPOST_REPLACED=1",
    "\"$cli\" mcp remove outpost >/dev/null 2>&1 || true",
    "else",
    "echo OUTPOST_REPLACED=0",
    "fi",
    `"$cli" mcp add outpost --url ${shQuote(url)} --bearer-token-env-var OUTPOST_MCP_TOKEN >/dev/null || exit 1`,
]);

const setupCommand = ({ agentType, cliPath, url, key, keyFile }) => (cliName(agentType) === "claude"
    ? claudeSetupCommand({ cliPath, url, key, keyFile })
    : `${codexSetupCommand({ cliPath, url, key, keyFile })} && ${codexEnvCommand({ key, keyFile })}`);

const probeCommand = ({ url, keyFile }) => {
    const bearer = keyWord({ keyFile }, "Authorization: Bearer ");
    const wgetHeader = keyWord({ keyFile }, "header = Authorization: Bearer ");
    return asCommand([
    ...bearer.setup,
    "f=$(mktemp) || exit 1",
    "trap 'rm -f \"$f\"' EXIT",
    "if command -v curl >/dev/null 2>&1; then",
    `printf '%s\\n' ${bearer.word} > "$f" || exit 1`,
    `curl -fsS --max-time 10 -H @"$f" ${shQuote(url)}`,
    "elif command -v wget >/dev/null 2>&1; then",
    `printf '%s\\n' ${wgetHeader.word} > "$f" || exit 1`,
    `wget -qO- -T 10 -t 1 --config="$f" ${shQuote(url)}`,
    "else",
    "exit 127",
    "fi",
    ]);
};

// Sets $state to MATCH (the registration carries keyPrefix) or OTHER (another key); anything else means none.
const registrationStateLines = (agentType, keyPrefix) => {
    if (!KEY_PREFIX.test(keyPrefix)) throw new TypeError("Invalid key prefix");
    if (cliName(agentType) === "claude") return [
        "f=\"$HOME/.claude.json\"",
        `state=$([ -f "$f" ] && awk -v p=${shQuote(`Bearer ${keyPrefix}`)} ${shQuote(CLAUDE_REGISTRATION_AWK)} "$f")`,
    ];
    return [
        `f="${CODEX_ENV}"`,
        "state=ABSENT",
        `if [ -f "$f" ]; then state=OTHER; grep -Eq ${shQuote(`^export OUTPOST_MCP_TOKEN='?${keyPrefix}`)} "$f" && state=MATCH; fi`,
    ];
};

const registrationCheckCommand = ({ agentType, keyPrefix }) => asCommand([
    ...registrationStateLines(agentType, keyPrefix),
    "case \"$state\" in MATCH|OTHER) echo \"$state\" ;; *) echo ABSENT ;; esac",
]);

const revokeCommands = ({ agentType, keyPrefix }) => asCommand([
    ...registrationStateLines(agentType, keyPrefix),
    "case \"$state\" in",
    "MATCH) ;;",
    "OTHER) echo FOREIGN; exit 0 ;;",
    "*) echo ABSENT; exit 0 ;;",
    "esac",
    `cli=$( ${findCliScript(agentType)} ) || exit 3`,
    ...withCliPath,
    ...(agentType === "claude"
        ? ["\"$cli\" mcp remove --scope user outpost >/dev/null 2>&1 || exit 4"]
        : ["\"$cli\" mcp remove outpost >/dev/null 2>&1 || exit 4", "rm -f \"$f\""]),
    "echo REMOVED",
]);

module.exports = {
    shQuote,
    keyDropCommand,
    keyCleanupCommand,
    findCliScript,
    findCliCommand,
    claudeSetupCommand,
    codexEnvCommand,
    codexSetupCommand,
    setupCommand,
    probeCommand,
    registrationCheckCommand,
    revokeCommands,
};
