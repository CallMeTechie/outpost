import { expect, test } from "vitest";
import { mapConnectionError } from "../ConnectionError.jsx";

const t = (key) => key;

test("RDP disconnect reasons from guacd map to their own messages", () => {
    expect(mapConnectionError("Disconnected by other connection.", t)).toBe("common.errors.connection.rdpSessionConflict");
    expect(mapConnectionError("Idle session time limit exceeded.", t)).toBe("common.errors.connection.rdpSessionTimeout");
    expect(mapConnectionError("Active session time limit exceeded.", t)).toBe("common.errors.connection.rdpSessionTimeout");
    expect(mapConnectionError("Logged off.", t)).toBe("common.errors.connection.rdpSessionClosed");
    expect(mapConnectionError("Manually disconnected.", t)).toBe("common.errors.connection.rdpSessionClosed");
    expect(mapConnectionError("Disconnected.", t)).toBe("common.errors.connection.rdpSessionClosed");
    expect(mapConnectionError("Server refused connection.", t)).toBe("common.errors.connection.refused");
});
