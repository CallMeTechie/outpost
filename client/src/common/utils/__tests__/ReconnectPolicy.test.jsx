import { expect, test, vi } from "vitest";

const postRequest = vi.hoisted(() => vi.fn());
vi.mock("@/common/utils/RequestUtil", () => ({ postRequest }));

const { requestReconnect } = await import("../ReconnectPolicy.js");

const t = (key) => key;

test.each([
    ["200", { generation: 3 }, { outcome: "reconnected", generation: 3 }],
    ["409", { code: 409 }, { outcome: "reattach" }],
    ["404 Session ended", { code: 404, message: "Session ended" }, { outcome: "ended" }],
    ["404 other", { code: 404, message: "Not found" }, { outcome: "refused", error: { retryable: false, reconnectable: false, expired: false } }],
    ["403", { code: 403 }, { outcome: "refused", error: { retryable: false, reconnectable: false, expired: false } }],
    ["410", { code: 410 }, { outcome: "refused", error: { retryable: false, reconnectable: false, expired: true } }],
    ["500", { code: 500 }, { outcome: "failed" }],
    ["429", { code: 429 }, { outcome: "failed" }],
    ["network", new TypeError("Failed to fetch"), { outcome: "failed" }],
])("requestReconnect maps %s", async (_label, response, expected) => {
    if (expected.outcome === "reconnected") postRequest.mockResolvedValueOnce(response);
    else postRequest.mockRejectedValueOnce(response);
    const result = await requestReconnect("s1", t);
    expect(result).toMatchObject(expected);
    expect(postRequest).toHaveBeenLastCalledWith("/connections/s1/reconnect", expect.objectContaining({ displayDpi: expect.anything() }));
});
