import "./styles.sass";
import { UserCog as IconUserCog } from "lucide-react";
import Icon from "@/common/components/Icon";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useContext } from "react";
import { UserContext } from "@/common/contexts/UserContext.jsx";
import { getSidebarNavigation } from "@/common/utils/navigationConfig.jsx";

export const MobileNav = () => {
    const { t } = useTranslation();
    const { pathname } = useLocation();
    const navigate = useNavigate();
    const { hasPermission } = useContext(UserContext);
    const navigation = getSidebarNavigation(t).filter(item => !item.permission || hasPermission(item.permission));

    const handleClick = (item) => {
        if (pathname.startsWith(item.path) && item.toggleEvent) window.dispatchEvent(new CustomEvent(item.toggleEvent));
        else navigate(item.path);
    };

    return (
        <nav className="mobile-nav">
            <div className="mobile-nav-scroll">
                {navigation.map((item, i) => (
                    <div key={i} onClick={() => handleClick(item)} className={`mobile-nav-item${pathname.startsWith(item.path) ? " active" : ""}`}>
                        <Icon icon={item.icon} /><span>{item.title}</span>
                    </div>
                ))}
            </div>
            <div className="mobile-nav-fixed">
                <div className="mobile-nav-item" onClick={() => window.dispatchEvent(new CustomEvent("openSettings", { detail: { tab: "account" } }))}>
                    <Icon icon={IconUserCog} /><span>{t('common.sidebar.account')}</span>
                </div>
            </div>
        </nav>
    );
};

export default MobileNav;
