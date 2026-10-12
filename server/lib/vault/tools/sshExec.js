const { VaultError, VaultErrorCode } = require("../errors");
const { redactSecretText, truncateAndRedact } = require("../redact");
const { HIDDEN } = require("../sshRefs");
const { sshFailure } = require("../sshSession");
const { sshUse } = require("../sshUse");

const NAME = "ssh_exec";
const COMMAND_LIMIT = 8 * 1024;
const OUTPUT_LIMIT = 64 * 1024;
const AUDIT_COMMAND_LIMIT = 1024;
const DEFAULT_TIMEOUT_SEC = 60;
const MAX_TIMEOUT_SEC = 600;

const def = {
    name: NAME,
    description: "Run a shell command on one of the targets of a vault SSH entry. Outpost logs in itself with the entry's user and key or password; you never see them. No terminal: interactive programs and sudo password prompts do not work — use an entry for the user you need. If the entry requires approval, the user approves each call and sees the full command; a new target always asks. Output: exit code, stdout and stderr, each cut at 64 KB; the entry's password and key are replaced by ••••.",
    inputSchema: {
        type: "object",
        properties: {
            item: { type: "string", description: "Entry id as vault_list shows it, e.g. web-deploy or org:3/ops" },
            target: { type: "string", description: "Target as vault_list shows it under targets, e.g. server:12 or host:nas.lan:2222" },
            command: { type: "string", description: "Shell command, at most 8 KB; runs as the entry's user without a terminal" },
            timeoutSec: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_SEC, description: "Seconds before Outpost stops the command, 1–600, default 60; the process on the target may keep running" },
        },
        required: ["item", "target", "command"],
    },
};

const textResult = (text) => ({ content: [{ type: "text", text }] });

const assertCommand = (command, timeoutSec) => {
    if (typeof command !== "string" || command.length === 0 || Buffer.byteLength(command) > COMMAND_LIMIT || HIDDEN.test(command))
        throw new VaultError(VaultErrorCode.BAD_COMMAND);
    if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > MAX_TIMEOUT_SEC) throw new VaultError(VaultErrorCode.BAD_TIMEOUT);
};

const format = (run, timeoutSec, variants) => {
    const stream = (text) => truncateAndRedact(text ?? "", OUTPUT_LIMIT, variants).text;
    const head = `exit ${run.exitCode}${run.timedOut ? ` (timed out after ${timeoutSec} s)` : ""}`;
    return [head, "--- stdout ---", stream(run.stdout), "--- stderr ---", stream(run.stderr)].join("\n");
};

const handler = (args, ctx, deps) => {
    const { command } = args;
    const timeoutSec = args.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
    const details = { command: typeof command === "string" ? command.slice(0, AUDIT_COMMAND_LIMIT) : null };
    return sshUse(ctx, deps, {
        item: args.item, target: args.target, tool: NAME, access: "exec", auditExtra: details,
        validate: () => assertCommand(command, timeoutSec),
        card: () => ({ command }),
        act: async ({ target, open, variants }) => {
            details.command = redactSecretText(command, variants).slice(0, AUDIT_COMMAND_LIMIT);
            const session = await open({ execOnly: true, signal: ctx.signal });
            let run;
            try {
                details.commandSent = true;
                run = await session.client.exec(command, timeoutSec * 1000);
            } catch (err) {
                const failure = sshFailure(err, target, ctx.signal);
                if (failure.code !== VaultErrorCode.SSH_FAILED) throw failure;
                if (err?.message === "Failed to execute command") throw failure;
                throw new VaultError(VaultErrorCode.SSH_FAILED, failure.message.replace("; nothing was done.",
                    "; the command was sent and may have run in full or in part. Check on the target before running it again."));
            } finally {
                session.close();
            }
            Object.assign(details, {
                exitCode: run.exitCode, timedOut: run.timedOut === true,
                bytes: Buffer.byteLength(run.stdout ?? "") + Buffer.byteLength(run.stderr ?? ""),
            });
            return textResult(format(run, timeoutSec, variants));
        },
    });
};

module.exports = { def, handler, needsBrowser: false };
