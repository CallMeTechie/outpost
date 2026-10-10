const vaultGuard = require("../browser/vaultGuard");
const { BrowserError, BrowserErrorCode } = require("../browser/errors");
const { VaultError, VaultErrorCode } = require("./errors");

const OBJECT_GROUP = "vault-fill";
const USERNAME_TYPES = new Set(["text", "email", "tel"]);
const FRAME_OWNERS = new Set(["IFRAME", "FRAME"]);
const MAX_FRAME_DEPTH = 16;
// Clearing instead of select-all: a selection would land in the primary selection, which every
// context of the browser instance shares and a middle click pastes elsewhere.
const CLEAR = "function () { this.value = ''; }";
const GONE = /No node (found|with given id)|detached from document|Could not find node/i;

// Runs in the realm of the element's own frame and reads only the global location, which is
// unforgeable there. Getters such as ownerDocument can be replaced by page script to fake an origin.
const INSPECT = `function () {
    const ancestors = [];
    for (let i = 0; i < location.ancestorOrigins.length; i++) ancestors.push(location.ancestorOrigins[i]);
    const input = this instanceof HTMLInputElement;
    return { origin: location.origin, ancestors, input, type: input ? this.type : null, connected: this.isConnected };
}`;
const DEEPEST_ACTIVE = `function () {
    let el = this.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el;
}`;

const normalizeOrigin = (value) => {
    try {
        const { origin } = new URL(String(value));
        return origin === "null" ? null : origin;
    } catch {
        return null;
    }
};

const staleRef = () => new BrowserError(BrowserErrorCode.STALE_REF, "The element no longer exists; take a new snapshot");
const unlessGone = (err) => {
    if (err instanceof BrowserError || err instanceof VaultError) throw err;
    if (GONE.test(err?.message ?? "")) throw staleRef();
    throw err;
};

const assertFillableSession = (session) => {
    if (vaultGuard.isTainted(session.contextKey)) throw new VaultError(VaultErrorCode.SESSION_TAINTED);
    if (session.via)
        throw new VaultError(VaultErrorCode.VIA_NOT_ALLOWED,
            `Session ${session.id} runs via ${session.via}; a password is never typed into a tunneled page. Open the login page with browser_open without via.`);
    if (session.profile === "persistent")
        throw new VaultError(VaultErrorCode.PERSISTENT_NOT_ALLOWED,
            `Session ${session.id} uses the persistent profile, where prepared pages survive on disk. Open a new session with browser_open without profile=persistent and fill there.`);
};

const inspect = async (session, ref) => {
    const { backendNodeId } = session.refs.resolve(ref);
    const info = await (async () => {
        const { object } = await session.agentSend("DOM.resolveNode", { backendNodeId, objectGroup: OBJECT_GROUP });
        const { result, exceptionDetails } = await session.agentSend("Runtime.callFunctionOn", {
            objectId: object.objectId, functionDeclaration: INSPECT, returnByValue: true, objectGroup: OBJECT_GROUP,
        });
        return exceptionDetails ? null : result?.value;
    })().catch(unlessGone);
    if (!info?.connected) throw staleRef();
    return { ref, backendNodeId, ...info };
};

const assertOrigins = (field, allowed) => {
    if ([field.origin, ...field.ancestors].every((origin) => allowed.has(normalizeOrigin(origin)))) return;
    const where = field.ancestors.length > 0 ? `${field.origin}, embedded in ${field.ancestors.join(" < ")}` : field.origin;
    throw new VaultError(VaultErrorCode.ORIGIN_MISMATCH,
        `${field.ref} is in a frame of ${where}, but this entry only fills on ${[...allowed].join(", ")}. Open the entry's login page directly; an embedding origin has to be added to the entry by the user.`);
};

const checkFillTarget = async (session, { passwordRef, usernameRef = null }, origins) => {
    const allowed = new Set(origins.map(normalizeOrigin).filter(Boolean));
    try {
        const password = await inspect(session, passwordRef);
        const username = usernameRef ? await inspect(session, usernameRef) : null;
        assertOrigins(password, allowed);
        if (username) assertOrigins(username, allowed);
        if (!password.input || password.type !== "password")
            throw new VaultError(VaultErrorCode.NOT_PASSWORD_FIELD,
                `${passwordRef} is not an <input type="password">; pass the ref of the password field from the latest snapshot.`);
        if (username && (!username.input || !USERNAME_TYPES.has(username.type) || username.origin !== password.origin))
            throw new VaultError(VaultErrorCode.BAD_USERNAME_FIELD,
                `${usernameRef} is not a text, email or tel input in the frame of the password field; pass another usernameRef or leave it out.`);
        return { passwordNodeId: password.backendNodeId, usernameNodeId: username?.backendNodeId ?? null };
    } finally {
        session.send("Runtime.releaseObjectGroup", { objectGroup: OBJECT_GROUP }).catch(() => {});
    }
};

const focusedNodeId = async (session) => {
    const top = await session.agentSend("Runtime.evaluate", { expression: "document", objectGroup: OBJECT_GROUP });
    let objectId = top.result?.objectId;
    for (let depth = 0; objectId && depth < MAX_FRAME_DEPTH; depth++) {
        const { result: active } = await session.agentSend("Runtime.callFunctionOn", { objectId, functionDeclaration: DEEPEST_ACTIVE, objectGroup: OBJECT_GROUP });
        if (!active?.objectId) return null;
        const { node } = await session.agentSend("DOM.describeNode", { objectId: active.objectId, depth: 1, pierce: true });
        if (!FRAME_OWNERS.has(node.nodeName)) return node.backendNodeId;
        if (!node.contentDocument) return null;
        ({ object: { objectId } } = await session.agentSend("DOM.resolveNode", { backendNodeId: node.contentDocument.backendNodeId, objectGroup: OBJECT_GROUP }));
    }
    return null;
};

const typeInto = async (session, backendNodeId, text, beforeInsert) => {
    await session.agentSend("DOM.focus", { backendNodeId }).catch((err) => {
        if (GONE.test(err?.message ?? "")) throw staleRef();
        throw new VaultError(VaultErrorCode.FOCUS_LOST, "The field cannot take the focus (hidden or disabled); nothing was typed into it. Take a new snapshot and pass the visible field.");
    });
    await (async () => {
        const { object } = await session.agentSend("DOM.resolveNode", { backendNodeId, objectGroup: OBJECT_GROUP });
        await session.agentSend("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: CLEAR, objectGroup: OBJECT_GROUP });
    })().catch(unlessGone);
    if ((await focusedNodeId(session)) !== backendNodeId)
        throw new VaultError(VaultErrorCode.FOCUS_LOST,
            "The page moved the focus away from the field before typing; nothing was typed into it. Take a new snapshot and call browser_fill_credential again.");
    beforeInsert();
    await session.agentSend("Input.insertText", { text });
};

const fillCredential = async (session, { passwordNodeId, usernameNodeId = null, username = null, password }) => {
    let marked = false;
    // markFilled checks the taint in the same synchronous step, so no browser_evaluate in a popup of
    // this context can slip in between the check and the first keystroke. Only the password field is
    // marked: a filled field that is no longer type=password locks screenshots.
    const markOnce = () => {
        if (marked) return;
        if (session.closed)
            throw new BrowserError(BrowserErrorCode.SESSION_CLOSED, `Session ${session.id} has ended; nothing was typed. Open a new session with browser_open and fill there.`);
        vaultGuard.markFilled(session.contextKey, { targetId: session.targetId, backendNodeIds: [passwordNodeId], secret: password });
        marked = true;
    };
    try {
        if (usernameNodeId !== null) await typeInto(session, usernameNodeId, username, markOnce);
        await typeInto(session, passwordNodeId, password, markOnce);
    } finally {
        session.send("Runtime.releaseObjectGroup", { objectGroup: OBJECT_GROUP }).catch(() => {});
    }
};

module.exports = { checkFillTarget, fillCredential, assertFillableSession, normalizeOrigin };
