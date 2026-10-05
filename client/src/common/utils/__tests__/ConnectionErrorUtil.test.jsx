import { expect, test } from "vitest";
import { classifyConnectionError, mapConnectionError } from "../ConnectionErrorUtil.js";

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

test("Anmeldefehler, RDP-Abmeldung und Endpunkt-Absagen sind endgültig, Verbindungsabbrüche wiederholbar", () => {
    expect(classifyConnectionError({ message: "SSH authentication failed", code: 4017 }, t))
        .toMatchObject({ text: "common.errors.connection.authenticationFailed", retryable: false, reconnectable: true });
    expect(classifyConnectionError({ message: "Connection lost", code: 4017 }, t))
        .toMatchObject({ text: "common.errors.connection.connectionLost", retryable: true });
    expect(classifyConnectionError({ message: "Engine disconnected", code: 4017 }, t).retryable).toBe(true);
    expect(classifyConnectionError({ code: 1006 }, t))
        .toMatchObject({ text: "common.errors.connection.closedUnexpectedly", retryable: true });
    expect(classifyConnectionError({ code: 1000 }, t).retryable).toBe(false);
    expect(classifyConnectionError({ message: "Server refused connection." }, t))
        .toMatchObject({ text: "common.errors.connection.refused", retryable: true });
    expect(classifyConnectionError({ message: "Aborted. See logs.", statusCode: "523" }, t))
        .toMatchObject({ text: "common.errors.connection.rdpSessionClosed", retryable: false, reconnectable: false });
    expect(classifyConnectionError({ message: "Logged off." }, t)).toMatchObject({ retryable: false, reconnectable: false });
    expect(classifyConnectionError({ message: "Session terminated" }, t).retryable).toBe(false);
    expect(classifyConnectionError({ httpStatus: 410 }, t))
        .toMatchObject({ text: "common.errors.connection.expired", retryable: false });
    expect(classifyConnectionError({ httpStatus: 403 }, t).retryable).toBe(false);
    expect(classifyConnectionError({ httpStatus: 404 }, t).retryable).toBe(false);
});
