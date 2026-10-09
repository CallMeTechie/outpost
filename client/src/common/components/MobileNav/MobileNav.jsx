import "./styles.sass";
import { UserCog as IconUserCog } from "lucide-react";
import Icon from "@/common/components/Icon";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useSidebarNavigation } from "@/common/hooks/useSidebarNavigation.js";

export const MobileNav = () => {
    const { t } = useTranslation();
    const { pathname } = useLocation();
    const navigate = useNavigate();
    const navigation = useSidebarNavigation();

    const handleClick = (item) => {
        if (pathname.startsWith(item.path) && item.toggleEvent) window.dispatchEvent(new CustomEvent(item.toggleEvent));
        else navigate(item.path);
    };

    return (
        <nav className="mobile-nav" data-ui-id="UI-SHELL-MOBILE-NAV">
            <div className="mobile-nav-scroll">
                {navigation.map((item, i) => (
                    <div key={i} role="link" tabIndex={0} onClick={() => handleClick(item)}
                         onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), handleClick(item))} className={`mobile-nav-item${pathname.startsWith(item.path) ? " active" : ""}`}>
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
