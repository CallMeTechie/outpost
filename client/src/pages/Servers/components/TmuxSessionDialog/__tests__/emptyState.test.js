import test from "node:test";
import assert from "node:assert";
import { emptyStateKey } from "../emptyState.js";

// The picker's empty state has more than one cause, and they must not be told
// apart by the caller - that is exactly the mix-up this function exists to
// prevent. Only the key is decided here; the wording lives in the locale files.

test("a listing with sessions has no empty state at all", () => {
    assert.strictEqual(emptyStateKey({ available: true, sessions: [{ name: "work" }] }), null);
});

test("no tmux server running says so instead of blaming the session count", () => {
    assert.strictEqual(
        emptyStateKey({ available: true, reason: "no_server", sessions: [] }),
        "servers.tmuxDialog.noServer",
    );
});

test("a running server without sessions keeps the plain empty wording", () => {
    assert.strictEqual(
        emptyStateKey({ available: true, sessions: [] }),
        "servers.tmuxDialog.empty",
    );
});

// The regression the previous condition allowed: available === false was not
// checked, so a host without tmux briefly claimed "no session is running yet".
// That sentence is simply untrue there - nothing about sessions can be said
// when tmux itself is missing. It now says what is actually wrong, and the
// dialog stays put instead of skipping on, so the sentence can be read.
test("a host without tmux names the missing tmux, not a session count", () => {
    assert.strictEqual(
        emptyStateKey({ available: false, reason: "not_installed", sessions: [] }),
        "servers.tmuxDialog.notInstalled",
    );
});

// available === false is the deciding field; a host that reports it without a
// reason must not fall through to session wording either.
test("an unavailable host without a reason still avoids session wording", () => {
    assert.strictEqual(
        emptyStateKey({ available: false, sessions: [] }),
        "servers.tmuxDialog.notInstalled",
    );
});
