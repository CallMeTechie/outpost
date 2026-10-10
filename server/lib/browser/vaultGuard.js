const { encryptValue, decryptValue } = require("../vault/crypto");
const { VaultError, VaultErrorCode } = require("../vault/errors");
const { REDACTED } = require("./snapshot");
const { parseKey, MODIFIERS } = require("./actions");

const GONE = /No node (found|with given id)|detached from document/i;
const contexts = new Map();

const aadOf = (contextKey) => `vault:ctx:${contextKey}`;

const stateOf = (contextKey) => {
    if (!contexts.has(contextKey)) contexts.set(contextKey, { tainted: false, filled: false, nodeIds: new Map(), copies: [] });
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

const markFilled = (contextKey, { backendNodeIds, secret, targetId = null }) => {
    // Checked in the same synchronous step as the marking, like assertEvaluateAllowed: no evaluate can slip in between.
    if (isTainted(contextKey))
        throw new VaultError(VaultErrorCode.SESSION_TAINTED);
    const copy = encryptValue(String(secret), aadOf(contextKey));
    const state = stateOf(contextKey);
    state.filled = true;
    state.copies.push(copy);
    if (!state.nodeIds.has(targetId)) state.nodeIds.set(targetId, new Set());
    for (const id of backendNodeIds) state.nodeIds.get(targetId).add(id);
};

const isFilled = (contextKey) => contexts.get(contextKey)?.filled === true;

// backendNodeIds only mean something in the target they were filled in; entries without a target apply to every session.
const filledNodeIds = (contextKey, targetId = null) =>
    [...(contexts.get(contextKey)?.nodeIds.get(targetId) ?? []), ...(targetId === null ? [] : contexts.get(contextKey)?.nodeIds.get(null) ?? [])];

// document.title and innerText collapse runs of whitespace, so the value can show up in that form too.
const lowerHex = (encoded) => encoded.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
const variantsOf = (secret) => {
    const percent = encodeURIComponent(secret);
    const form = new URLSearchParams([["", secret]]).toString().slice(1);
    return [secret, percent, lowerHex(percent), form, lowerHex(form), secret.replace(/\s+/g, " ").trim()];
};

const redactText = (contextKeys, text) => {
    if (typeof text !== "string") return text;
    const variants = new Set();
    for (const contextKey of [contextKeys].flat()) {
        for (const copy of contexts.get(contextKey)?.copies ?? []) {
            let secret;
            try {
                secret = decryptValue(copy, aadOf(contextKey));
            } catch {
                // Without the key the text cannot be checked, so none of it may leave.
                return REDACTED;
            }
            for (const variant of variantsOf(secret)) if (variant) variants.add(variant);
        }
    }
    // Longest first across all copies, or a shorter secret that is a prefix of a longer one leaves the tail behind.
    let result = text;
    for (const variant of [...variants].sort((x, y) => y.length - x.length)) result = result.split(variant).join(REDACTED);
    return result;
};

const noteNavigation = (contextKey, targetId) => {
    contexts.get(contextKey)?.nodeIds.delete(targetId);
    contexts.get(contextKey)?.nodeIds.delete(null);
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
    for (const [targetId, ids] of contexts.get(session.contextKey)?.nodeIds ?? [])
        if (targetId !== null && targetId !== session.targetId && ids.size > 0) throw new VaultError(VaultErrorCode.SCREENSHOT_LOCKED);
    for (const backendNodeId of filledNodeIds(session.contextKey, session.targetId)) {
        let node;
        try {
            ({ node } = await session.agentSend("DOM.describeNode", { backendNodeId }));
        } catch (err) {
            // A "show password" can swap in a new input; the old node being gone proves nothing until the page navigates.
            if (GONE.test(err?.message ?? "")) throw new VaultError(VaultErrorCode.SCREENSHOT_LOCKED);
            throw err;
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
    markTainted, isTainted, markFilled, isFilled, filledNodeIds, redactText, forgetContext, noteNavigation,
    assertEvaluateAllowed, assertScreenshotAllowed, assertInputAllowed, findPasswordFieldIds, _resetForTests,
};
