import "./styles.sass";
import Icon from "@/common/components/Icon";
import { useTranslation } from "react-i18next";
import TriToggle from "@/common/components/TriToggle";
import Tooltip from "@/common/components/Tooltip";
import { Users as IconUsers, ShieldHalf as IconShieldHalf, Building2 as IconBuilding2, Cog as IconCog, Server as IconServer, ShieldCheck as IconShieldCheck, CircleCheck as IconCircleCheck, TriangleAlert as IconTriangleAlert, Terminal as IconTerminal, FolderSymlink as IconFolderSymlink, MonitorUp as IconMonitorUp } from "lucide-react";

// The keys are what the server puts on the wire (server/permissions/registry.js sends
// `icon: "mdiAccountGroup"`), not names of anything in this file. They stay as they are:
// an older connector talking to a newer server, or the reverse, would otherwise show a
// permission catalogue with no icons at all. Two of them land on the same drawing --
// Lucide has one Users icon where MDI had a group and a multiple.
const ICONS = {
    mdiAccountGroup: IconUsers,
    mdiAccountMultipleOutline: IconUsers,
    mdiShieldKeyOutline: IconShieldHalf,
    mdiDomain: IconBuilding2,
    mdiCogOutline: IconCog,
    mdiServerOutline: IconServer,
    mdiShieldCheckOutline: IconShieldCheck,
    mdiConsoleNetworkOutline: IconTerminal,
    mdiFolderNetworkOutline: IconFolderSymlink,
    mdiMonitorShare: IconMonitorUp,
};

export const PermissionMatrix = ({ catalog, values = {}, onChange, disabled = false, readOnly = false, granted = [], inherited = null }) => {
    const { t } = useTranslation();

    if (!catalog) return null;

    const grantedSet = new Set(granted);
    const inheritedSet = inherited && new Set(inherited);
    const byCategory = (categoryKey) => catalog.permissions.filter((p) => p.category === categoryKey);

    return (
        <div className="permission-matrix">
            {catalog.categories.map((category) => {
                const perms = byCategory(category.key);
                if (!perms.length) return null;

                return (
                    <div className="perm-category" key={category.key}>
                        <div className="category-header">
                            {ICONS[category.icon] && <Icon icon={ICONS[category.icon]} />}
                            <span>{category.label}</span>
                        </div>
                        <div className="perm-rows">
                            {perms.map((perm) => (
                                <div className={`perm-row ${perm.dangerous ? "dangerous" : ""}`} key={perm.id}>
                                    <div className="perm-info">
                                        <span className="perm-label">
                                            {perm.label}
                                            {perm.dangerous && (
                                                <Tooltip text={t("settings.permissions.dangerousHint")}>
                                                    <Icon icon={IconTriangleAlert} className="danger-icon" />
                                                </Tooltip>
                                            )}
                                        </span>
                                        <span className="perm-description">{perm.description}</span>
                                    </div>
                                    {readOnly ? (
                                        <span className={`perm-effective ${grantedSet.has(perm.id) ? "on" : "off"}`}>
                                            {grantedSet.has(perm.id) && <Icon icon={IconCircleCheck} />}
                                        </span>
                                    ) : (
                                        <div className="perm-control">
                                            <TriToggle
                                                value={values[perm.id] || "neutral"}
                                                disabled={disabled}
                                                inherited={inheritedSet ? (inheritedSet.has(perm.id) ? "allow" : "deny") : undefined}
                                                inheritedHint={inheritedSet ? t(inheritedSet.has(perm.id)
                                                    ? "settings.permissions.inheritsAllow"
                                                    : "settings.permissions.inheritsDeny") : undefined}
                                                onChange={(value) => onChange && onChange(perm.id, value)}
                                            />
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                );
            })}
        </div>
    );
};