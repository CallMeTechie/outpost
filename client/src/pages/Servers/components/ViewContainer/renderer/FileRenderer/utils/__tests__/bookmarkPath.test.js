import test from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizeBookmarkPath } from "../bookmarkPath.js";

// The very same table the server test reads. Two implementations that drift apart would let the
// active chip go unhighlighted on exactly the paths where the two spellings differ, and no test
// that only looked at one side would notice.
const fixtureUrl = new URL(
    "../../../../../../../../../../server/lib/__tests__/fixtures/bookmarkPaths.json",
    import.meta.url,
);
const cases = JSON.parse(readFileSync(fileURLToPath(fixtureUrl), "utf8"));

test("the client normalization matches the shared fixture", () => {
    for (const { in: input, out } of cases) {
        assert.strictEqual(normalizeBookmarkPath(input), out, `input ${JSON.stringify(input)}`);
    }
});
