const { BrowserError, BrowserErrorCode } = require("./errors");

const INTERACTIVE_ROLES = new Set([
    "button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "slider",
    "spinbutton", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "listbox", "treeitem",
]);
const VALUE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider"]);
const OPTION_ROLES = new Set(["option", "MenuListOption"]);
const MAX_TEXT = 100;
const REDACTED = "••••";

const clip = (value) => {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
};

const propertyOf = (node, name) => node.properties?.find((p) => p.name === name)?.value?.value;

class RefTable {
    constructor() {
        this.nextRef = 1;
        this.byBackendId = new Map();
        this.byRef = new Map();
    }

    assign(backendNodeId, label, extra = {}) {
        let ref = this.byBackendId.get(backendNodeId);
        if (!ref) {
            ref = `e${this.nextRef++}`;
            this.byBackendId.set(backendNodeId, ref);
        }
        this.byRef.set(ref, { backendNodeId, label, ...extra });
        return ref;
    }

    resolve(ref) {
        const hit = this.byRef.get(ref);
        if (hit) return hit;
        const number = /^e(\d+)$/.exec(String(ref))?.[1];
        if (number && Number(number) < this.nextRef)
            throw new BrowserError(BrowserErrorCode.STALE_REF, `Reference ${ref} is from an older snapshot; take a new snapshot`);
        throw new BrowserError(BrowserErrorCode.UNKNOWN_REF, `Reference ${ref} does not exist; take a snapshot first`);
    }

    reset() {
        this.byBackendId.clear();
        this.byRef.clear();
    }
}

const optionsOf = (node, byId) => {
    const options = [];
    const stack = [...(node.childIds ?? [])].reverse();
    while (stack.length > 0) {
        const child = byId.get(stack.pop());
        if (!child) continue;
        if (OPTION_ROLES.has(child.role?.value)) {
            options.push({
                name: String(child.name?.value ?? "").trim(),
                selected: propertyOf(child, "selected") === true,
                disabled: propertyOf(child, "disabled") === true,
            });
        }
        else for (const id of [...(child.childIds ?? [])].reverse()) stack.push(id);
    }
    return options;
};

const describe = (node, refs, options, redactBackendIds) => {
    const role = node.role?.value;
    const name = clip(node.name?.value);
    if (role === "heading") {
        if (!name) return null;
        const level = propertyOf(node, "level");
        return `- heading ${JSON.stringify(name)}${level ? ` level=${level}` : ""}`;
    }
    if (!INTERACTIVE_ROLES.has(role) || node.backendDOMNodeId === undefined) return null;

    const label = name ? `${role} ${JSON.stringify(name)}` : role;
    let line = `- ${label} [ref=${refs.assign(node.backendDOMNodeId, label, options.length > 0 ? { options } : {})}]`;
    const value = node.value?.value;
    if (VALUE_ROLES.has(role) && value !== undefined && value !== "")
        line += ` value=${JSON.stringify(redactBackendIds.has(node.backendDOMNodeId) ? REDACTED : clip(value))}`;
    const checked = propertyOf(node, "checked");
    if (checked === "mixed") line += " checked=mixed";
    else if (checked === "true" || checked === true) line += " checked";
    if (propertyOf(node, "disabled") === true) line += " disabled";
    return line;
};

const buildSnapshot = (nodes, refs, { redactBackendIds = new Set() } = {}) => {
    const byId = new Map(nodes.map((n) => [n.nodeId, n]));
    const root = nodes.find((n) => !n.parentId) ?? nodes[0];
    const lines = [];
    // Iterative on purpose: real pages nest deep enough to overflow a recursive walk.
    const stack = root ? [root] : [];
    while (stack.length > 0) {
        const current = stack.pop();
        if (!current.ignored) {
            const options = current.role?.value === "combobox" ? optionsOf(current, byId) : [];
            const line = describe(current, refs, options, redactBackendIds);
            if (line) lines.push(line);
            if (options.length > 0) {
                // A native select's options are chosen through its own ref (A23), so they get none.
                for (const option of options)
                    lines.push(`  - option ${JSON.stringify(clip(option.name))}${option.selected ? " selected" : ""}${option.disabled ? " disabled" : ""}`);
                continue;
            }
        }
        const children = (current.childIds ?? []).map((id) => byId.get(id)).filter(Boolean);
        for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
    }
    return lines.join("\n");
};

module.exports = { RefTable, buildSnapshot, REDACTED };
