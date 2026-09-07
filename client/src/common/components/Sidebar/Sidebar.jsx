import "./styles.sass";
import OutpostLogo from "@/common/components/OutpostLogo";
import { Cog as IconCog, LogOut as IconLogOut, UserCog as IconUserCog, Star as IconStar, LifeBuoy as IconLifeBuoy, Server as IconServer, Plus as IconPlus, X as IconX } from "lucide-react";
import Icon from "@/common/components/Icon";
import { useLocation, useNavigate } from "react-router-dom";
import { useContext, useState, useRef, useEffect } from "react";
import { UserContext } from "@/common/contexts/UserContext.jsx";
import { ActionConfirmDialog } from "@/common/components/ActionConfirmDialog/ActionConfirmDialog.jsx";
import SupportDialog from "@/common/components/SupportDialog";
import Tooltip from "@/common/components/Tooltip";
import LetterAvatar from "@/common/components/LetterAvatar";
import { useTranslation } from "react-i18next";
import { SettingsDialog } from "@/common/components/SettingsDialog/SettingsDialog.jsx";
import { getSidebarNavigation } from "@/common/utils/navigationConfig.jsx";
import { GITHUB_URL } from "@/App.jsx";
import { openExternalUrl } from "@/common/utils/TauriUtil.js";
import { usePreferences } from "@/common/contexts/PreferencesContext.jsx";
import { getServers, getActiveServerId, getServerDisplayName, switchServer, removeServer } from "@/common/utils/ConnectorServers.js";
import { getAvatarLabel } from "@/common/utils/avatar.js";

export const Sidebar = ({ onToggleCollapse }) => {
    const { t } = useTranslation();
    const location = useLocation();
    const navigate = useNavigate();
    const { logout, isConnectorMode, user, setAddingServer, hasPermission } = useContext(UserContext);
    const { uiScale } = usePreferences();
    const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
    const [settingsTab, setSettingsTab] = useState("account");
    const [logoutDialogOpen, setLogoutDialogOpen] = useState(false);
    const [removeServerDialogOpen, setRemoveServerDialogOpen] = useState(false);
    const [serverToRemove, setServerToRemove] = useState(null);
    const [supportDialogOpen, setSupportDialogOpen] = useState(false);
    const [userMenuOpen, setUserMenuOpen] = useState(false);
    const hoverTimeoutRef = useRef(null);
    const menuRef = useRef(null);
    const accountBtnRef = useRef(null);
    const openedByKeyRef = useRef(false);

    const servers = isConnectorMode ? getServers() : [];
    const activeServerId = isConnectorMode ? getActiveServerId() : null;

    // Überfahren öffnet, aber nur mit der Maus. Ein Finger löst auf den meisten Browsern
    // zusätzlich ein nachgebildetes Enter-Ereignis aus; zusammen mit dem Klick unten hätte
    // das Menü sich im selben Tipp geöffnet und sofort wieder geschlossen.
    const isMousePointer = (event) => !event.pointerType || event.pointerType === "mouse";
    const handlePointerEnter = (event) => {
        if (!isMousePointer(event)) return;
        clearTimeout(hoverTimeoutRef.current);
        setUserMenuOpen(true);
    };
    const handlePointerLeave = (event) => {
        if (!isMousePointer(event)) return;
        hoverTimeoutRef.current = setTimeout(() => setUserMenuOpen(false), 150);
    };

    // Der Weg ohne Maus. Ohne ihn war das Konto-Menü — Einstellungen, Unterstützung,
    // Abmelden — per Finger und per Tastatur überhaupt nicht erreichbar: geöffnet wurde
    // es allein vom Überfahren des Elternknotens. Auf einem Tablet oberhalb des
    // Mobil-Breakpoints, wo die Seitenleiste sichtbar ist und die untere Leiste mit
    // ihrem eigenen Konto-Eintrag fehlt, gab es gar keinen Zugang.
    const toggleUserMenu = () => {
        clearTimeout(hoverTimeoutRef.current);
        setUserMenuOpen(open => !open);
    };
    const handleAccountKeyDown = (event) => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            // Mit der Tastatur geöffnet heißt: der Fokus gehört in das Menü. Mit der Maus
            // nicht -- dort würde ein Sprung den Zeiger überholen.
            openedByKeyRef.current = !userMenuOpen;
            toggleUserMenu();
        } else if (event.key === "Escape" && userMenuOpen) {
            setUserMenuOpen(false);
        } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            openedByKeyRef.current = true;
            if (!userMenuOpen) setUserMenuOpen(true); else focusMenuItem(event.key === "ArrowUp" ? -1 : 0);
        }
    };

    // Ein role="menu" verspricht die Pfeiltasten. Es zu vergeben, ohne sie zu liefern,
    // wäre schlechter als gar keine Rolle: ein Screenreader kündigt dann eine Bedienung
    // an, die es nicht gibt.
    const menuItems = () => Array.from(menuRef.current?.querySelectorAll('[role="menuitem"]') ?? []);
    const focusMenuItem = (index) => {
        const items = menuItems();
        if (items.length) items[(index + items.length) % items.length].focus();
    };
    const closeUserMenu = (refocus) => {
        setUserMenuOpen(false);
        if (refocus) accountBtnRef.current?.focus();
    };
    const handleMenuKeyDown = (event) => {
        const items = menuItems();
        if (!items.length) return;
        const current = items.indexOf(document.activeElement);
        const keys = {
            ArrowDown: () => focusMenuItem(current + 1),
            ArrowUp: () => focusMenuItem(current - 1),
            Home: () => focusMenuItem(0),
            End: () => focusMenuItem(items.length - 1),
            Escape: () => closeUserMenu(true),
        };
        if (keys[event.key]) {
            event.preventDefault();
            event.stopPropagation();
            keys[event.key]();
        } else if (event.key === "Enter" || event.key === " ") {
            // Die Einträge sind divs, kein button -- Enter und Leertaste kommen nicht von
            // selbst. Hier oben statt an jedem Eintrag, damit während des Renderns keine
            // Handler-Fabrik läuft.
            if (current >= 0) {
                event.preventDefault();
                items[current].click();
            }
        } else if (event.key === "Tab") {
            // Tab verlässt das Menü, statt zwischen unsichtbaren Einträgen zu wandern.
            closeUserMenu(false);
        }
    };

    useEffect(() => () => clearTimeout(hoverTimeoutRef.current), []);

    // Mit der Maus schließt das Verlassen des Bereichs das Menü. Ein Tipp hat kein
    // Verlassen, also schließt hier der Tipp daneben — sonst bliebe es offen stehen.
    // Nach dem Öffnen per Tastatur auf den ersten Eintrag springen. Die Abfrage steht
    // hier statt über focusMenuItem, damit der Effekt keine bei jedem Render neu
    // gebildete Funktion in seiner Abhängigkeitsliste braucht.
    useEffect(() => {
        if (!userMenuOpen || !openedByKeyRef.current) return;
        openedByKeyRef.current = false;
        menuRef.current?.querySelector('[role="menuitem"]')?.focus();
    }, [userMenuOpen]);

    useEffect(() => {
        if (!userMenuOpen) return;
        const closeOnOutside = (event) => {
            if (!event.target.closest?.(".user-account-area")) setUserMenuOpen(false);
        };
        document.addEventListener("pointerdown", closeOnOutside, true);
        return () => document.removeEventListener("pointerdown", closeOnOutside, true);
    }, [userMenuOpen]);
    useEffect(() => {
        const handleOpenSettings = event => { setSettingsTab(event.detail?.tab || "account"); setSettingsDialogOpen(true); };
        window.addEventListener("openSettings", handleOpenSettings);
        return () => window.removeEventListener("openSettings", handleOpenSettings);
    }, []);

    const navigation = getSidebarNavigation(t).filter(item => !item.permission || hasPermission(item.permission));

    return (<>
        <div className="sidebar">
            <ActionConfirmDialog open={logoutDialogOpen} setOpen={setLogoutDialogOpen} text={t('common.sidebar.logoutConfirmText', { username: user?.username })} onConfirm={logout} />
            {isConnectorMode && <ActionConfirmDialog open={removeServerDialogOpen} setOpen={setRemoveServerDialogOpen}
                text={t('common.serverSwitcher.removeConfirmText', { server: serverToRemove ? getServerDisplayName(serverToRemove) : '' })}
                onConfirm={() => {
                    if (!serverToRemove) return;
                    if (serverToRemove.id === activeServerId) logout();
                    else { removeServer(serverToRemove.id); setServerToRemove(null); }
                }} />}
            <div className="sidebar-top">
                <Tooltip text={t('common.sidebar.collapseTitle')}>
                    <div className="sidebar-logo outpost-logo" data-ui-id="UI-SHELL-LOGO" onClick={onToggleCollapse} title={t('common.sidebar.collapseTitle')}><OutpostLogo size={42 * uiScale} /></div>
                </Tooltip>
                <nav data-ui-id="UI-SHELL-NAV">
                    {navigation.map((item, i) => (
                        <Tooltip key={i} text={item.title}>
                            <div onClick={() => navigate(item.path)} className={`nav-item${location.pathname.startsWith(item.path) ? " nav-item-active" : ""}`}><Icon icon={item.icon} /></div>
                        </Tooltip>
                    ))}
                </nav>
            </div>
            <div className="sidebar-bottom">
                <div className="user-account-area" onPointerEnter={handlePointerEnter} onPointerLeave={handlePointerLeave}>
                    <Tooltip text={user?.username || t('common.sidebar.account')} disabled={userMenuOpen}>
                        <div className={`user-btn ${userMenuOpen ? 'active' : ''}`} data-ui-id="UI-SHELL-ACCOUNT"
                             ref={accountBtnRef}
                             role="button" tabIndex={0}
                             aria-controls="sidebar-account-menu"
                             aria-haspopup="menu" aria-expanded={userMenuOpen}
                             aria-label={user?.username || t('common.sidebar.account')}
                             onClick={toggleUserMenu} onKeyDown={handleAccountKeyDown}><Icon icon={IconUserCog} /></div>
                    </Tooltip>
                    {/* Geschlossen ist das Menü aus der Vorlesereihenfolge genommen -- es bleibt
                        im DOM, weil die Öffnungsbewegung daran hängt. Der Fokus landet nur im
                        offenen Zustand darin, ein aria-hidden über fokussiertem Inhalt kann
                        also nicht entstehen. */}
                    <div className={`user-menu ${userMenuOpen ? 'open' : ''}`}
                         id="sidebar-account-menu" ref={menuRef}
                         role="menu" aria-label={t('common.sidebar.account')}
                         aria-hidden={!userMenuOpen}
                         onKeyDown={handleMenuKeyDown}>
                        <div className="user-menu-header" role="presentation">
                            <LetterAvatar user={user} size="md" showTooltip={false} />
                            <div className="user-info">
                                <span className="user-name">{getAvatarLabel(user, t('common.sidebar.account'))}</span>
                                <span className="user-username">@{user?.username}</span>
                            </div>
                        </div>
                        {isConnectorMode && servers.length > 0 && (<>
                            <div className="user-menu-separator" role="separator" />
                            <div className="user-menu-section-label" role="presentation">{t('common.serverSwitcher.title')}</div>
                            {servers.map(server => (
                                <div key={server.id} className={`user-menu-item server-item ${server.id === activeServerId ? 'active' : ''}`}
                                     role="menuitem" tabIndex={-1} onClick={() => { if (server.id !== activeServerId) { closeUserMenu(false); switchServer(server.id); } }}>
                                    <Icon icon={IconServer} className="menu-icon" />
                                    <span className="menu-label">{getServerDisplayName(server)}</span>
                                    <button className="server-remove-btn" tabIndex={-1}
                                            onClick={(e) => { e.stopPropagation(); setServerToRemove(server); setRemoveServerDialogOpen(true); }}>
                                        <Icon icon={IconX} size={0.55} />
                                    </button>
                                </div>
                            ))}
                            <div className="user-menu-item add-server" role="menuitem" tabIndex={-1} onClick={() => { closeUserMenu(false); setAddingServer(true); }}>
                                <Icon icon={IconPlus} className="menu-icon" />
                                <span className="menu-label">{t('common.serverSwitcher.addServer')}</span>
                            </div>
                        </>)}
                        <div className="user-menu-separator" role="separator" />
                        <div className={`user-menu-item ${settingsDialogOpen ? 'active' : ''}`} role="menuitem" tabIndex={-1} onClick={() => { setSettingsDialogOpen(true); closeUserMenu(false); }}>
                            <Icon icon={IconCog} className="menu-icon" /><span className="menu-label">{t('common.sidebar.settings')}</span>
                        </div>
                        <div className="user-menu-separator" role="separator" />
                        <div className="user-menu-item star" role="menuitem" tabIndex={-1} onClick={() => { openExternalUrl(GITHUB_URL); closeUserMenu(true); }}>
                            <Icon icon={IconStar} className="menu-icon" /><span className="menu-label">{t('common.sidebar.starOnGitHub')}</span>
                        </div>
                        <div className={`user-menu-item support ${supportDialogOpen ? 'active' : ''}`} role="menuitem" tabIndex={-1} onClick={() => { setSupportDialogOpen(true); closeUserMenu(false); }}>
                            <Icon icon={IconLifeBuoy} className="menu-icon" /><span className="menu-label">{t('common.sidebar.support')}</span>
                        </div>
                        <div className="user-menu-separator" role="separator" />
                        <div className="user-menu-item danger" role="menuitem" tabIndex={-1} onClick={() => { setLogoutDialogOpen(true); closeUserMenu(false); }}>
                            <Icon icon={IconLogOut} className="menu-icon" /><span className="menu-label">{t('common.sidebar.logout')}</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        <SettingsDialog open={settingsDialogOpen} onClose={() => setSettingsDialogOpen(false)} initialTab={settingsTab} />
        <SupportDialog open={supportDialogOpen} onClose={() => setSupportDialogOpen(false)} />
    </>);
};