import { Server as IconServer, Braces as IconBraces, ChartColumn as IconChartColumn, ShieldCheck as IconShieldCheck, CircleUser as IconCircleUser, Users as IconUsers, Hourglass as IconHourglass, ShieldUser as IconShieldUser, Building2 as IconBuilding2, Sparkles as IconSparkles, KeyRound as IconKeyRound, SquareTerminal as IconSquareTerminal, Keyboard as IconKeyboard, CloudDownload as IconCloudDownload, ChartLine as IconChartLine, HardDrive as IconHardDrive, Folder as IconFolder, Engine as IconEngine, Palette as IconPalette, ShieldHalf as IconShieldHalf } from "lucide-react";
import { mdiMicrosoft } from "@mdi/js";
import Account from "@/pages/Settings/pages/Account";
import Appearance from "@/pages/Settings/pages/Appearance";
import Terminal from "@/pages/Settings/pages/Terminal";
import FileManager from "@/pages/Settings/pages/FileManager";
import Keymaps from "@/pages/Settings/pages/Keymaps";
import Identities from "@/pages/Settings/pages/Identities";
import Sessions from "@/pages/Settings/pages/Sessions";
import Organizations from "@/pages/Settings/pages/Organizations";
import Users from "@/pages/Settings/pages/Users";
import Authentication from "@/pages/Settings/pages/Authentication";
import Microsoft from "@/pages/Settings/pages/Microsoft";
import Sources from "@/pages/Settings/pages/Sources";
import Monitoring from "@/pages/Settings/pages/Monitoring";
import Backup from "@/pages/Settings/pages/Backup";
import AI from "@/pages/Settings/pages/AI";
import Engines from "@/pages/Settings/pages/Engines";
import Permissions from "@/pages/Settings/pages/Permissions";
import { Permission } from "@/common/utils/permissions.js";

export const getSidebarNavigation = t => [
    { title: t('common.sidebar.servers'), key: "servers", path: "/servers", icon: IconServer, toggleEvent: "toggleServerList" },
    { title: t('common.sidebar.monitoring'), key: "monitoring", path: "/monitoring", icon: IconChartColumn },
    { title: t('common.sidebar.snippets'), key: "snippets", path: "/snippets", icon: IconBraces },
    { title: t('common.sidebar.audit'), key: "audit", path: "/audit", icon: IconShieldCheck, permission: Permission.AUDIT_VIEW },
];

export const getSettingsUserPages = t => [
    { title: t("settings.pages.account"), key: "account", icon: IconCircleUser, content: <Account /> },
    { title: t("settings.pages.appearance"), key: "appearance", icon: IconPalette, content: <Appearance /> },
    { title: t("settings.pages.terminal"), key: "terminal", icon: IconSquareTerminal, content: <Terminal /> },
    { title: t("settings.pages.fileManager"), key: "fileManager", icon: IconFolder, content: <FileManager /> },
    { title: t("settings.pages.keymaps"), key: "keymaps", icon: IconKeyboard, content: <Keymaps /> },
    { title: t("settings.pages.identities"), key: "identities", icon: IconKeyRound, content: <Identities /> },
    { title: t("settings.pages.sessions"), key: "sessions", icon: IconHourglass, content: <Sessions /> },
    { title: t("settings.pages.organizations"), key: "organizations", icon: IconBuilding2, content: <Organizations /> },
];

export const getSettingsAdminPages = t => [
    { title: t("settings.pages.users"), key: "users", icon: IconUsers, permission: Permission.USERS_VIEW, content: <Users /> },
    { title: t("settings.pages.permissions"), key: "permissions", icon: IconShieldHalf, permission: Permission.PERMISSIONS_MANAGE, content: <Permissions /> },
    { title: t("settings.pages.authentication"), key: "authentication", icon: IconShieldUser, permission: Permission.SETTINGS_AUTH_PROVIDERS, content: <Authentication /> },
    { title: t("settings.pages.microsoft"), key: "microsoft", icon: mdiMicrosoft, permission: Permission.SETTINGS_MICROSOFT, content: <Microsoft /> },
    { title: t("settings.pages.sources"), key: "sources", icon: IconCloudDownload, permission: Permission.SETTINGS_SOURCES, content: <Sources /> },
    { title: t("settings.pages.monitoring"), key: "monitoring", icon: IconChartLine, permission: Permission.SETTINGS_MONITORING, content: <Monitoring /> },
    { title: t("settings.pages.engines"), key: "engines", icon: IconEngine, permission: Permission.SETTINGS_ENGINES, content: <Engines /> },
    { title: t("settings.pages.backup"), key: "backup", icon: IconHardDrive, permission: Permission.SETTINGS_BACKUP, content: <Backup /> },
    { title: t("settings.pages.ai"), key: "ai", icon: IconSparkles, permission: Permission.SETTINGS_AI, content: <AI /> },
];

export const getAllSettingsPages = t => [...getSettingsUserPages(t), ...getSettingsAdminPages(t)];
