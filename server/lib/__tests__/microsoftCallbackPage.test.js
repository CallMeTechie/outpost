const test = require("node:test");
const assert = require("node:assert");
const { renderCallbackPage, CALLBACK_REASONS, MESSAGE_TYPE } = require("../microsoft/callbackPage");

test("the success page posts the connected status to the opener", () => {
    const html = renderCallbackPage({ status: "connected" });

    assert.ok(html.includes(MESSAGE_TYPE));
    assert.ok(html.includes('"connected"'));
    assert.ok(/window\.opener/.test(html));
    assert.ok(/window\.close\(\)/.test(html));
});

test("the message is posted to this origin only", () => {
    assert.ok(/postMessage\([^)]*window\.location\.origin/.test(renderCallbackPage({ status: "connected" })),
        "a wildcard target origin would leak the result to any embedding page");
});

test("every known reason renders", () => {
    for (const reason of CALLBACK_REASONS) {
        const html = renderCallbackPage({ status: "error", reason });
        assert.ok(html.includes(`"${reason}"`), `${reason} did not reach the page`);
    }
});

// The reason ultimately derives from Microsoft's query string. Nothing from there may be echoed.
test("an unknown reason collapses to the generic one", () => {
    const html = renderCallbackPage({ status: "error", reason: "totally_made_up" });

    assert.ok(!html.includes("totally_made_up"));
    assert.ok(html.includes('"authorize_failed"'));
});

test("an injected reason cannot escape the script", () => {
    const html = renderCallbackPage({ status: "error", reason: "</script><script>alert(1)</script>" });

    assert.ok(!html.includes("alert(1)"));
    assert.strictEqual(html.match(/<script>/g).length, 1);
});

test("an unknown status collapses to an error", () => {
    const html = renderCallbackPage({ status: "hacked" });

    assert.ok(!html.includes("hacked"));
    assert.ok(html.includes('"error"'));
});

test("a missing argument does not throw", () => {
    assert.ok(renderCallbackPage({}).length > 0);
    assert.ok(renderCallbackPage().length > 0);
});

// If the popup was blocked the user navigated here in the main tab and needs a way back.
test("the page offers a way back for the case without an opener", () => {
    assert.ok(renderCallbackPage({ status: "connected" }).includes('href="/"'));
});
