const SKIP_AUTO_LOGIN_KEY = "outpost_skip_oidc_auto_login";

export const markExplicitLogout = () => {
    try {
        window.sessionStorage.setItem(SKIP_AUTO_LOGIN_KEY, "1");
    } catch {}
};

export const consumeExplicitLogout = () => {
    try {
        const value = window.sessionStorage.getItem(SKIP_AUTO_LOGIN_KEY);
        window.sessionStorage.removeItem(SKIP_AUTO_LOGIN_KEY);
        return value === "1";
    } catch {
        return false;
    }
};

export const createAutoLoginSuppressionGuard = (consume = consumeExplicitLogout) => {
    let dialogOpen = false;
    let skipAutoLogin = false;

    return (open) => {
        if (!open) {
            dialogOpen = false;
            skipAutoLogin = false;
            return false;
        }

        if (!dialogOpen) {
            dialogOpen = true;
            skipAutoLogin = consume();
        }

        return skipAutoLogin;
    };
};
