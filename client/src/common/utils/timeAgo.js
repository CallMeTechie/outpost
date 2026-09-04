// A timestamp as "vor 12 Minuten", through the servers.time.* catalogue that already exists for
// this. Split out of WelcomePanel, where the same shape was hardcoded English ("Just now",
// "5m ago") and therefore stayed English in all eleven locales.
//
// `now` is a parameter rather than a Date.now() call inside, so a caller can pass the value it
// already has and so this stays a pure function a test can pin to a fixed instant.
export const formatTimeAgo = (timestamp, t, now = Date.now()) => {
    const minutes = Math.floor((now - new Date(timestamp).getTime()) / 60000);
    if (!Number.isFinite(minutes)) return "";
    if (minutes < 1) return t("servers.time.justNow");
    if (minutes < 60) return t(minutes === 1 ? "servers.time.minuteAgo" : "servers.time.minutesAgo", { count: minutes });

    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t(hours === 1 ? "servers.time.hourAgo" : "servers.time.hoursAgo", { count: hours });

    const days = Math.floor(hours / 24);
    return t(days === 1 ? "servers.time.dayAgo" : "servers.time.daysAgo", { count: days });
};
