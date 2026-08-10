const { validateTransferStart, buildTransferAuditEntries } = require("./transferAuth");
const { createConflictBroker, createProgressThrottle } = require("./transferSession");

const CONFLICT_TIMEOUT = 120_000;
const PROGRESS_INTERVAL = 250;

const buildTransferHandlers = (OP, ctx) => {
    const { transfers, deps } = ctx;
    const send = deps.send;

    const finish = (transferId, key) => {
        // Read the entry BEFORE deleting it: it carries the source session, and without it only
        // the destination client would be released — the source aux connection would stay open
        // for the rest of the session.
        const entry = transfers.get(transferId);
        transfers.delete(transferId);
        try { deps.registry.release(key); } catch {}
        for (const sessionId of [entry?.sourceSessionId, ctx.sessionId].filter(Boolean)) {
            try { deps.releaseCrossClient(deps.getConnection(sessionId), key); } catch {}
        }
    };

    return {
        async start(payload) {
            let transferId = null;
            let key = null;
            let reserved = false;
            let ownEntry = null;
            let sourceSessionId = null;
            let auditPaths = null;
            let destScopeForAudit = null;
            try {
                const request = validateTransferStart(payload, ctx.sessionId);
                auditPaths = request.paths;
                ({ transferId, sourceSessionId } = request);

                // Taken synchronously, before the first await: ws does not wait for the listener's
                // promise, so two messages with the same id would otherwise both pass this check.
                if (transfers.has(transferId)) throw new Error("Invalid transfer request");
                ownEntry = { pending: true };
                transfers.set(transferId, ownEntry);

                const { sourceEntry, sourceScope } = await deps.authorizeSource(
                    { user: ctx.user, sourceSessionId, action: request.action });

                // Only now: a stat is a real round trip on a foreign connection, and its error text
                // distinguishes "no such file" from "permission denied". Before the chain it would
                // turn sourceSessionId into an existence oracle over foreign hosts.
                const sourceConn = deps.getConnection(sourceSessionId);
                let sourceIsFolder = false;
                for (const p of request.paths) {
                    let info = null;
                    try { info = await sourceConn?.sftpClient?.stat(p); } catch { info = null; }
                    if (!info) throw new Error("Transfer not permitted");
                    if (info.isDir) sourceIsFolder = true;
                }

                // Never ctx.entry: on a shared socket it carries a reduced attribute set without
                // organizationId, and the permission check would silently fall back to system-wide
                // rights. authorizeDestination refuses an undefined scope, but load it properly.
                const destEntry = await deps.findEntry(ctx.serverSession?.entryId ?? ctx.entry.id);
                if (!destEntry) throw new Error("Transfer not permitted");

                const { destScope } = await deps.authorizeDestination({
                    user: ctx.user, destEntry, onConflict: request.onConflict, sourceIsFolder });
                destScopeForAudit = destScope;

                key = `${ctx.sessionId}:${transferId}`;
                if (!deps.registry.reserve(key, [sourceSessionId, ctx.sessionId])) {
                    // A refusal here has two unrelated causes registry.reserve does not tell
                    // apart: this key string is already taken (most likely a zombie transfer whose
                    // source session vanished mid-run, see SessionManager.js — release() only
                    // arrives when that run actually ends), or one of the two sessions is genuinely
                    // at its own limit. On a session shared across two sockets the first can fire
                    // long before either side is anywhere near MAX_CROSS_TRANSFERS — "too many
                    // transfers" would then blame the wrong thing and hide that simply retrying
                    // with a different id works immediately. Neither message names a session: the
                    // collision case has nothing session-specific to say, and the quota case only
                    // ever reports on the two sessions this very request already carries.
                    const ownQuotaFull = deps.registry.countFor(sourceSessionId) >= deps.registry.MAX_CROSS_TRANSFERS
                        || deps.registry.countFor(ctx.sessionId) >= deps.registry.MAX_CROSS_TRANSFERS;
                    throw new Error(ownQuotaFull ? "Too many concurrent transfers" : "Transfer id already in use");
                }
                reserved = true;

                // user.id, never session.accountId: it decides in resolveIdentity which credentials
                // may be used, so the session owner's identity must not be borrowed here.
                // And `key`, never the bare transferId: the client picks that id, and the register
                // lets two destination sessions run the same one against a single source. On that
                // source the aux client is cached under this name, so the bare id would serve the
                // second caller the first one's connection — opened under a foreign account, past
                // the identity check — and the first to finish would close the other's.
                const sourceClient = await deps.getCrossClient(sourceSessionId, sourceEntry, ctx.user.id, key);
                const destClient = await deps.getCrossClient(ctx.sessionId, destEntry, ctx.user.id, key);

                const broker = createConflictBroker({
                    send: (info) => send(OP.TRANSFER_CONFLICT, { transferId, ...info }),
                    timeoutMs: CONFLICT_TIMEOUT,
                });
                let lastProgress = null;
                const throttle = createProgressThrottle({
                    send: (p) => send(OP.TRANSFER_PROGRESS, { transferId, ...p }),
                    intervalMs: PROGRESS_INTERVAL,
                });

                const transfer = deps.createTransfer({
                    source: deps.createAdapter(sourceClient, deps.getCapabilities(sourceEntry)),
                    dest: deps.createAdapter(destClient, deps.getCapabilities(destEntry)),
                    destCleanup: deps.createAdapter(
                        deps.getConnection(ctx.sessionId)?.sftpClient, deps.getCapabilities(destEntry)),
                    onProgress: (p) => { lastProgress = p; throttle.report(p); },
                    onConflict: (info) => broker.ask(info),
                });

                ownEntry = { transfer, broker, key, sourceSessionId };
                transfers.set(transferId, ownEntry);

                for (const entry of buildTransferAuditEntries({
                    user: ctx.user, sourceScope, destScope, sourceEntryId: sourceEntry.id,
                    destEntryId: destEntry.id, sourceSessionId, paths: request.paths,
                    destination: request.destination, action: request.action,
                    ipAddress: ctx.ipAddress, userAgent: ctx.userAgent,
                })) deps.createAuditLog(entry);

                // Deliberately not awaited: the dispatcher would otherwise block every further
                // opcode of this socket — including the cancel.
                transfer.run(request.paths, request.destination,
                    { action: request.action, onConflict: request.onConflict })
                    .then((result) => {
                        if (lastProgress) throttle.flush(lastProgress);
                        send(OP.TRANSFER_DONE, { transferId, ...result });
                    })
                    .catch((err) => send(OP.TRANSFER_ERROR, { transferId, message: err.message,
                        leftovers: err.leftovers ?? [], sourceLeftovers: err.sourceLeftovers ?? [] }))
                    .finally(() => {
                        // A question can still be open when the run ends for any other reason
                        // (internal cancel, source error). Nothing else reaches that promise, so
                        // without this it lingers with a live timer until the 120 s window fires.
                        broker.cancel();
                        finish(transferId, key);
                    })
                    // Terminal, because nothing awaits this chain: a throw out of the reporting
                    // above — a closed socket makes send() throw — would otherwise end as an
                    // unhandled rejection. The finally has already done the cleanup by then.
                    // Silent on purpose, not by oversight: nothing under fileTransfer/ reaches for
                    // a logger, everything it talks to comes through deps, and a report channel
                    // invented just for this spot would be the only one of its kind. The realistic
                    // arrival here is a socket that is already gone — nobody left to tell.
                    .catch(() => {});
            } catch (err) {
                // Only ever this call's own entry, compared by identity: a second start for an id
                // that is already running lands here too, and a plain delete would disown the
                // RUNNING transfer — its cleanup would no longer find the source session, leaving
                // that aux connection open, and its cancel would stop reaching it.
                if (ownEntry && transfers.get(transferId) === ownEntry) transfers.delete(transferId);
                if (reserved && key) {
                    try { deps.registry.release(key); } catch {}
                    for (const sessionId of [sourceSessionId, ctx.sessionId].filter(Boolean)) {
                        try { deps.releaseCrossClient(deps.getConnection(sessionId), key); } catch {}
                    }
                }
                // A refused attempt is exactly what an audit trail is for. Logged on the
                // destination side, the one organization known to be the caller's; the source
                // scope is often not resolved yet, and paths are logged as a count so a refusal
                // never writes attacker-chosen strings into the trail. Wrapped because a failing
                // audit must not replace the refusal the client is waiting for.
                if (auditPaths) {
                    try {
                        for (const entry of buildTransferAuditEntries({
                            user: ctx.user, destScope: destScopeForAudit, sourceSessionId,
                            paths: auditPaths, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent,
                            refused: true,
                        })) deps.createAuditLog(entry);
                    } catch {}
                }

                // Everything that depends on sourceSessionId must look the same from outside; only
                // the client's own quota, a malformed payload, and an own-id collision may carry
                // their own text — none of the three says anything a foreign session could leak.
                const own = /^Invalid |^Too many |^Transfer id already in use$/.test(err.message);
                send(OP.TRANSFER_ERROR, { transferId: transferId ?? null,
                    message: own ? err.message : "Transfer not permitted" });
            }
        },

        cancel(payload) {
            const entry = transfers.get(payload?.transferId);
            if (!entry?.transfer) return;
            // The broker first: a waiting conflict question is a plain in-memory promise that
            // closing the clients cannot reach, so without this a cancel would wait out the
            // whole 120 s window.
            entry.broker?.cancel();
            entry.transfer.cancel();
        },

        resolve(payload) {
            const entry = transfers.get(payload?.transferId);
            if (!entry?.broker) return;
            entry.broker.resolve(payload);
        },
    };
};

module.exports = { buildTransferHandlers, CONFLICT_TIMEOUT, PROGRESS_INTERVAL };
