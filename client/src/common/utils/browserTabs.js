export const BROWSER_SESSION_TYPE = "browser";

const toBrowserFields = (item) => ({
    url: item.url,
    title: item.title,
    agentActive: !!item.agentActive,
    agentPaused: !!item.agentPaused,
    via: item.via ?? null,
});

// An absent list means "not known yet", never "nothing open".
export const syncBrowserTabs = (sessions, list, dismissed) => {
    if (!Array.isArray(list)) return { sessions, activate: null };

    const live = new Map(list.map((item) => [item.id, item]));
    const next = [];
    for (const session of sessions) {
        if (session.type !== BROWSER_SESSION_TYPE) {
            next.push(session);
            continue;
        }
        const item = live.get(session.id);
        if (item) next.push({ ...session, browser: toBrowserFields(item) });
    }

    let activate = null;
    const known = new Set(sessions.map((session) => session.id));
    for (const item of list) {
        if (known.has(item.id) || dismissed.has(item.id) || item.origin !== "agent") continue;
        next.push({ id: item.id, type: BROWSER_SESSION_TYPE, browser: toBrowserFields(item) });
        activate = item.id;
    }
    return { sessions: next, activate };
};
