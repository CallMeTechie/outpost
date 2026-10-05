import { postRequest } from "@/common/utils/RequestUtil";
import { getDisplayDpi } from "@/common/utils/ConnectionUtil.js";
import { classifyConnectionError } from "@/common/utils/ConnectionErrorUtil.js";

const RECONNECT_PROTOCOLS = new Set(["ssh", "telnet", "pve-lxc", "rdp", "vnc"]);
const LOCAL_TYPES = new Set(["notes", "onedrive", "sftp"]);

export const sessionProtocol = (session) => {
    const server = session?.server;
    if (!server) return null;
    return server.type === "server" ? (server.protocol ?? server.config?.protocol ?? null) : server.type;
};

export const isReconnectEligible = (session) => {
    if (!session || session.isJoined || session.scriptId || LOCAL_TYPES.has(session.type)) return false;
    return RECONNECT_PROTOCOLS.has(sessionProtocol(session));
};

export const shouldAttemptAutoReconnect = ({ enabled, session, errorInfo, wasConnected }) => (
    Boolean(enabled)
    && isReconnectEligible(session)
    && Boolean(wasConnected)
    && Boolean(errorInfo)
    && errorInfo.retryable !== false
);

// 409 means the session is still alive server-side (only the browser socket dropped): re-attach, no new generation.
export const requestReconnect = async (sessionId, t) => {
    try {
        const { generation } = await postRequest(`/connections/${sessionId}/reconnect`, { displayDpi: getDisplayDpi() });
        return { outcome: "reconnected", generation };
    } catch (error) {
        const status = error?.code;
        if (status === 409) return { outcome: "reattach" };
        if (status === 404 && error?.message === "Session ended") return { outcome: "ended" };
        if (status === 403 || status === 404 || status === 410) {
            const { text } = classifyConnectionError({ httpStatus: status }, t);
            return { outcome: "refused", error: { message: text, retryable: false, reconnectable: false, expired: status === 410 } };
        }
        return { outcome: "failed" };
    }
};
