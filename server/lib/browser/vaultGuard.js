const crypto = require("node:crypto");
const { encryptValue, decryptValue } = require("../vault/crypto");
const { VaultError, VaultErrorCode } = require("../vault/errors");
const { REDACTED } = require("./snapshot");
const { parseKey, MODIFIERS } = require("./actions");

const GONE = /No node (found|with given id)|detached from document/i;
const contexts = new Map();
const DIGEST_KEY = crypto.randomBytes(32);

const aadOf = (contextKey) => `vault:ctx:${contextKey}`;

const stateOf = (contextKey) => {
    if (!contexts.has(contextKey)) contexts.set(contextKey, { tainted: false, filled: false, nodeIds: new Map(), copies: [], digests: new Set() });
    return contexts.get(contextKey);
};

const attributeOf = (node, name) => {
    const attributes = node.attributes ?? [];
    for (let i = 0; i + 1 < attributes.length; i += 2) if (attributes[i].toLowerCase() === name) return attributes[i + 1];
    return undefined;
};

const markTainted = (contextKey) => {
    stateOf(contextKey).tainted = true;
};

const isTainted = (contextKey) => contexts.get(contextKey)?.tainted === true;

const markFilled = (contextKey, { backendNodeIds, secret, targetId }) => {
    if (typeof targetId !== "string" || targetId === "") throw new TypeError("markFilled needs the targetId of the session it ran in");
    // Checked in the same synchronous step as the marking, like assertEvaluateAllowed: no evaluate can slip in between.
    if (isTainted(contextKey))
        throw new VaultError(VaultErrorCode.SESSION_TAINTED);
    const state = stateOf(contextKey);
    state.filled = true;
    const digest = crypto.createHmac("sha256", DIGEST_KEY).update(String(secret)).digest("hex");
    if (!state.digests.has(digest)) {
        state.copies.push(encryptValue(String(secret), aadOf(contextKey)));
        state.digests.add(digest);
    }
    if (!state.nodeIds.has(targetId)) state.nodeIds.set(targetId, { ids: new Set(), navigated: false });
    const filled = state.nodeIds.get(targetId);
    filled.navigated = false;
    for (const id of backendNodeIds) filled.ids.add(id);
};

const isFilled = (contextKey) => contexts.get(contextKey)?.filled === true;

// backendNodeIds only mean something in the target they were filled in.
const filledNodeIds = (contextKey, targetId) => [...(contexts.get(contextKey)?.nodeIds.get(targetId)?.ids ?? [])];

// document.title and innerText collapse runs of whitespace, so the value can show up in that form too.
const lowerHex = (encoded) => encoded.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
const variantsOf = (secret) => {
    const percent = encodeURIComponent(secret);
    const form = new URLSearchParams([["", secret]]).toString().slice(1);
    return [secret, percent, lowerHex(percent), form, lowerHex(form), secret.replace(/\s+/g, " ").trim()];
};

const unchanged = (text) => text;

const redactorFor = (contextKeys) => {
    const variants = new Set();
    for (const contextKey of [contextKeys].flat()) {
        for (const copy of contexts.get(contextKey)?.copies ?? []) {
            let secret;
            try {
                secret = decryptValue(copy, aadOf(contextKey));
            } catch {
                // Without the key the text cannot be checked, so none of it may leave.
                return (text) => (typeof text === "string" ? REDACTED : text);
            }
            for (const variant of variantsOf(secret)) if (variant) variants.add(variant);
        }
    }
    if (!variants.size) return unchanged;
    // Longest first across all copies, or a shorter secret that is a prefix of a longer one leaves the tail behind.
    const sorted = [...variants].sort((x, y) => y.length - x.length);
    return (text) => {
        if (typeof text !== "string") return text;
        let result = text;
        for (const variant of sorted) result = result.split(variant).join(REDACTED);
        return result;
    };
};

const redactText = (contextKeys, text) => redactorFor(contextKeys)(text);

// The ids stay: a page restored from the back/forward cache brings its filled nodes back with the same ids.
const noteNavigation = (contextKey, targetId) => {
    const filled = contexts.get(contextKey)?.nodeIds.get(targetId);
    if (filled) filled.navigated = true;
};

const forgetTarget = (contextKey, targetId) => {
    contexts.get(contextKey)?.nodeIds.delete(targetId);
};

const forgetContext = (contextKey) => {
    contexts.delete(contextKey);
};

const assertEvaluateAllowed = (session) => {
    markTainted(session.contextKey);
    if (isFilled(session.contextKey))
        throw new VaultError(VaultErrorCode.EVALUATE_LOCKED);
};

const assertScreenshotAllowed = async (session) => {
    // Nodes filled in another session cannot be inspected from here, so they keep this one locked.
    for (const [targetId, { ids, navigated }] of contexts.get(session.contextKey)?.nodeIds ?? [])
        if (targetId !== session.targetId && ids.size > 0 && !navigated) throw new VaultError(VaultErrorCode.SCREENSHOT_LOCKED);
    const own = contexts.get(session.contextKey)?.nodeIds.get(session.targetId);
    for (const backendNodeId of own?.ids ?? []) {
        let node;
        try {
            ({ node } = await session.agentSend("DOM.describeNode", { backendNodeId }));
        } catch (err) {
            // A "show password" can swap in a new input; the old node being gone proves nothing until the page navigates.
            if (!GONE.test(err?.message ?? "")) throw err;
            if (!own.navigated) throw new VaultError(VaultErrorCode.SCREENSHOT_LOCKED);
            continue;
        }
        if (attributeOf(node ?? {}, "type")?.toLowerCase() !== "password")
            throw new VaultError(VaultErrorCode.SCREENSHOT_LOCKED);
    }
};

const SELECTING = MODIFIERS.Control | MODIFIERS.Meta | MODIFIERS.Shift;

const assertInputAllowed = (session, tool, args) => {
    // Middle-click pastes the primary selection, which every context of the instance shares: a fill elsewhere may have put the value there.
    if (tool === "browser_click" && args.button === "middle")
        throw new VaultError(VaultErrorCode.INPUT_LOCKED);
    if (!isFilled(session.contextKey)) return;
    if (tool === "browser_click" && Math.trunc(Number(args.clickCount)) > 1)
        throw new VaultError(VaultErrorCode.INPUT_LOCKED);
    if (tool === "browser_key") {
        const { key, modifiers } = parseKey(args.key);
        if (modifiers & SELECTING && !(modifiers === MODIFIERS.Shift && key === "Tab"))
            throw new VaultError(VaultErrorCode.INPUT_LOCKED);
    }
};

const findPasswordFieldIds = async (session) => {
    const { nodes } = await session.agentSend("DOM.getFlattenedDocument", { depth: -1, pierce: true });
    return (nodes ?? [])
        .filter((node) => node.localName === "input" && attributeOf(node, "type")?.toLowerCase() === "password")
        .map((node) => node.backendNodeId);
};

const _resetForTests = () => contexts.clear();

module.exports = {
    markTainted, isTainted, markFilled, isFilled, filledNodeIds, redactorFor, redactText, forgetContext, forgetTarget, noteNavigation,
    assertEvaluateAllowed, assertScreenshotAllowed, assertInputAllowed, findPasswordFieldIds, _resetForTests,
};
