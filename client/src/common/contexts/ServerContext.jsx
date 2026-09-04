import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { UserContext } from "@/common/contexts/UserContext.jsx";
import { StateStreamContext, STATE_TYPES } from "@/common/contexts/StateStreamContext.jsx";
import { getRequest } from "@/common/utils/RequestUtil.js";

export const ServerContext = createContext({});

export const ServerProvider = ({ children }) => {
    const [servers, setServers] = useState(null);
    // Distinguishes "still loading" from "loading failed": both leave servers
    // null, and without this the list rendered nothing at all in either case
    // (UI-SERVERS-LIST, states loading and error).
    const [loadError, setLoadError] = useState(null);
    const { user, sessionToken } = useContext(UserContext);
    const { registerHandler, connectionError } = useContext(StateStreamContext);

    // The list is filled by the state stream, not by loadServers -- so a broken
    // stream is the failure mode that actually happens, and without it the error
    // branch was unreachable while the skeletons ran forever. Declared after
    // connectionError on purpose: reading it earlier is a temporal dead zone.
    const serversError = loadError || (connectionError ? "stream" : null);

    useEffect(() => {
        if (user) return registerHandler(STATE_TYPES.ENTRIES, setServers);
    }, [user, registerHandler]);

    const loadServers = useCallback(async () => {
        try {
            setServers(await getRequest("/entries/list"));
            setLoadError(null);
        } catch (error) {
            console.error("Failed to load servers", error?.message);
            setLoadError(error?.message || "unknown");
        }
    }, []);

    const retrieveServerById = async (serverId) => {
        try {
            return await getRequest(`/entries/${serverId}`);
        } catch (error) {
            console.error("Failed to retrieve server", error.message);
        }
    };

    const getServerById = (serverId, entries = servers) => {
        for (const server of entries || []) {
            if (server.type === "folder" || server.type === "organization") {
                const result = getServerById(serverId, server.entries);
                if (result) return result;
            } else if (server.id === parseInt(serverId)) return server;
        }
        return null;
    };

    useEffect(() => { if (!sessionToken) setServers([]); }, [sessionToken]);

    return <ServerContext.Provider value={{ servers, serversError, loadServers, getServerById, retrieveServerById }}>{children}</ServerContext.Provider>;
};