const test = require("node:test");
const assert = require("node:assert");
const { secretVariants, truncateAndRedact } = require("../redact");

const TOKEN = "ghp_tok en/+42secret";
const USER = "x-access-token";
const base64 = (text) => Buffer.from(text, "utf8").toString("base64");

test("truncateAndRedact cuts on the byte limit without leaving the start of a variant behind and blanks the token in its encoded forms", () => {
    const variants = secretVariants({ token: TOKEN, headerValue: `Bearer ${TOKEN}`, gitUsername: USER });
    const encoded = [TOKEN, encodeURIComponent(TOKEN), base64(TOKEN), base64(`${USER}:${TOKEN}`), `Bearer ${TOKEN}`];
    const head = `{"seen":${JSON.stringify(encoded)},"pad":"`;
    // The cut falls 7 bytes into the token that follows 150 two-byte characters: "ghp_tok" would be left over.
    const limit = Buffer.byteLength(head) + 300 + 7;
    const text = `${head}${"ä".repeat(150)}${TOKEN}${"z".repeat(500)}"}`;

    assert.deepStrictEqual(truncateAndRedact(text, limit, variants), {
        text: `{"seen":["••••","••••","••••","••••","••••"],"pad":"${"ä".repeat(150)}\n[truncated after ${limit} bytes]`,
        truncated: true,
    });
    assert.deepStrictEqual(truncateAndRedact("ää", 3, variants), { text: "ä\n[truncated after 3 bytes]", truncated: true },
        "a character cut in half is dropped, not turned into U+FFFD");
    assert.deepStrictEqual(truncateAndRedact(`ok ${TOKEN}`, 1000, variants), { text: "ok ••••", truncated: false });
});
