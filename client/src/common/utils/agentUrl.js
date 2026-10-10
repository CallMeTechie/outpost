export const isValidAgentUrl = (value) => {
    if (value === "") return true;
    try {
        const url = new URL(value);
        return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
    } catch {
        return false;
    }
};
