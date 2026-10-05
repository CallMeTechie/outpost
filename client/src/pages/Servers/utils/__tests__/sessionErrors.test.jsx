import { expect, test } from "vitest";
import { isSuperseded, shouldRecordError } from "../sessionErrors.js";

test("eine verspätete Meldung des alten Renderers markiert die neue Generation nicht als getrennt", () => {
    expect(shouldRecordError(undefined, { message: "Connection lost", generation: 1 }, 2)).toBe(false);
    expect(shouldRecordError(undefined, { message: "Connection lost", generation: 2 }, 2)).toBe(true);
    expect(shouldRecordError({ message: "first", generation: 2 }, { message: "second", generation: 2 }, 2)).toBe(false);
    expect(shouldRecordError({ message: "old", generation: 1 }, { message: "new", generation: 2 }, 2)).toBe(true);
    expect(isSuperseded({ message: "Connection lost", generation: 1 }, 2)).toBe(true);
});
