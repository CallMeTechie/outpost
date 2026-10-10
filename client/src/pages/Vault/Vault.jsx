import "./styles.sass";
import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
    KeyRound as IconKeyRound, Plus as IconPlus, ArrowLeft as IconArrowLeft, Search as IconSearch,
    User as IconUser, Building2 as IconBuilding2,
} from "lucide-react";
import PageHeader from "@/common/components/PageHeader";
import Button from "@/common/components/Button";
import TabSwitcher from "@/common/components/TabSwitcher";
import IconInput from "@/common/components/IconInput";
import { UserContext } from "@/common/contexts/UserContext.jsx";
import { useToast } from "@/common/contexts/ToastContext.jsx";
import { useVaultAvailable } from "@/common/hooks/useVaultAvailable.js";
import { deleteRequest, getRequest } from "@/common/utils/RequestUtil.js";
import { Permission } from "@/common/utils/permissions.js";
import VaultList from "./components/VaultList";
import VaultDetail from "./components/VaultDetail";
import VaultItemDialog from "./components/VaultItemDialog";
import { TYPE_KEYS, VAULT_TYPES, matchesSearch, ownerKey } from "./vaultTypes.js";

const NARROW = "(max-width: 768px)";

const useNarrow = () => {
    const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);
    useEffect(() => {
        const query = window.matchMedia(NARROW);
        const update = () => setNarrow(query.matches);
        query.addEventListener("change", update);
        return () => query.removeEventListener("change", update);
    }, []);
    return narrow;
};

export const Vault = () => {
    const { t } = useTranslation();
    const { user, hasPermission } = useContext(UserContext);
    const { sendToast } = useToast();
    const { canManageOrgs, impersonating } = useVaultAvailable();
    const narrow = useNarrow();
    const [items, setItems] = useState(null);
    const [loadFailed, setLoadFailed] = useState(false);
    const [organizations, setOrganizations] = useState([]);
    const [scope, setScope] = useState(null);
    const [typeFilter, setTypeFilter] = useState("all");
    const [search, setSearch] = useState("");
    const [selectedId, setSelectedId] = useState(null);
    const [showDetail, setShowDetail] = useState(false);
    const [dialog, setDialog] = useState({ open: false, item: null, key: 0 });

    const personalAllowed = hasPermission(Permission.VAULT_USE);

    const loadItems = useCallback(() => getRequest("vault/items").then(
        (answer) => { setItems(answer.items); setLoadFailed(false); },
        () => { setItems([]); setLoadFailed(true); },
    ), []);

    useEffect(() => { loadItems(); }, [loadItems]);

    useEffect(() => {
        getRequest("organizations").then(setOrganizations).catch((error) => console.error("Failed to load organizations", error));
    }, []);

    const scopes = useMemo(() => [
        ...(personalAllowed ? [{ key: "personal", label: t("vault.scope.personal"), icon: IconUser }] : []),
        ...organizations.map((org) => ({ key: `org-${org.id}`, label: org.name, icon: IconBuilding2, organizationId: org.id })),
    ], [personalAllowed, organizations, t]);

    const activeScope = scopes.some((entry) => entry.key === scope) ? scope : scopes[0]?.key ?? null;
    const canCreateIn = (key) => key === "personal"
        ? personalAllowed
        : canManageOrgs.includes(scopes.find((entry) => entry.key === key)?.organizationId);
    const canCreate = activeScope !== null && canCreateIn(activeScope);
    const showNew = personalAllowed || canManageOrgs.length > 0;

    const scopedItems = useMemo(() => (items || []).filter((item) => ownerKey(item) === activeScope), [items, activeScope]);
    const visibleItems = useMemo(() => scopedItems.filter((item) =>
        (typeFilter === "all" || item.type === typeFilter) && matchesSearch(item, search)), [scopedItems, typeFilter, search]);
    const selected = visibleItems.find((item) => item.id === selectedId) || null;
    const filterEmpty = scopedItems.length > 0 && visibleItems.length === 0;

    const owners = useMemo(() => [
        ...(personalAllowed ? [{ value: "personal", label: t("vault.dialog.ownerPersonal", { username: user?.username, interpolation: { escapeValue: false } }), organizationId: null }] : []),
        ...organizations.filter((org) => canManageOrgs.includes(org.id))
            .map((org) => ({ value: `org-${org.id}`, label: org.name, organizationId: org.id })),
    ], [personalAllowed, organizations, canManageOrgs, user?.username, t]);

    const openCreate = () => setDialog((current) => ({ open: true, item: null, key: current.key + 1 }));
    const openEdit = (item) => setDialog((current) => ({ open: true, item, key: current.key + 1 }));
    const closeDialog = () => setDialog((current) => ({ ...current, open: false }));

    const select = (id) => {
        setSelectedId(id);
        setShowDetail(true);
    };

    const saved = async (item) => {
        await loadItems();
        if (item) setSelectedId(item.id);
    };

    const remove = async (item) => {
        try {
            await deleteRequest(`vault/items/${item.id}`);
            setSelectedId(null);
            setShowDetail(false);
            await loadItems();
        } catch (error) {
            sendToast(t("common.error"), error?.message || t("vault.detail.deleteFailed"));
        }
    };

    useEffect(() => {
        const onKeyDown = (event) => {
            if (event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
            if (event.target?.closest?.("input, textarea, select, [contenteditable='true']")) return;
            if (document.querySelector(".dialog-area")) return;
            if (event.key === "n" || event.key === "N") {
                if (canCreate) {
                    event.preventDefault();
                    openCreate();
                }
            } else if ((event.key === "e" || event.key === "E") && selected?.canManage) {
                event.preventDefault();
                openEdit(selected);
            } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && visibleItems.length > 0) {
                event.preventDefault();
                const index = visibleItems.findIndex((item) => item.id === selectedId);
                const next = event.key === "ArrowDown" ? Math.min(index + 1, visibleItems.length - 1) : Math.max(index - 1, 0);
                setSelectedId(visibleItems[next].id);
            } else if (event.key === "Escape" && narrow && showDetail) {
                setShowDetail(false);
            }
        };
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
    });

    const typeTabs = [
        { key: "all", label: t("vault.types.all") },
        ...TYPE_KEYS.map((key) => ({ key, label: t(VAULT_TYPES[key].labelKey), icon: VAULT_TYPES[key].icon })),
    ];

    return (
        <div className={`vault-page${showDetail ? " vault-page--detail" : ""}`} data-ui-id="UI-VAULT">
            <PageHeader icon={IconKeyRound} title={t("vault.page.title")} subtitle={t("vault.page.subtitle")}
                        onBackClick={narrow && showDetail ? () => setShowDetail(false) : undefined} backIcon={IconArrowLeft}>
                {showNew && (
                    <Button dataUiId="UI-VAULT-NEW" text={t("vault.page.addItem")} icon={IconPlus} type="primary"
                            disabled={!canCreate} onClick={openCreate} />
                )}
            </PageHeader>

            <div className="vault-split">
                <aside className="vault-sidebar">
                    <div className="vault-scope">
                        <TabSwitcher dataUiId="UI-VAULT-SCOPE" tabs={scopes} activeTab={activeScope}
                                     onTabChange={(key) => { setScope(key); setSelectedId(null); }} />
                    </div>
                    <div className="vault-search">
                        <IconInput dataUiId="UI-VAULT-SEARCH" icon={IconSearch} value={search} setValue={setSearch}
                                   placeholder={t("vault.search.placeholder")} />
                        {filterEmpty && search.trim() && <p className="vault-hint">{t("vault.search.empty")}</p>}
                    </div>
                    <div className="vault-types">
                        <TabSwitcher dataUiId="UI-VAULT-TYPES" tabs={typeTabs} activeTab={typeFilter} onTabChange={setTypeFilter} />
                    </div>
                    <VaultList items={visibleItems} loading={items === null} failed={loadFailed}
                               ownerEmpty={scopedItems.length === 0} selectedId={selectedId} onSelect={select}
                               canCreate={canCreate} onCreate={openCreate} />
                </aside>
                <main className="vault-main">
                    <VaultDetail item={selected} impersonating={impersonating} onEdit={openEdit} onDelete={remove} />
                </main>
            </div>

            <VaultItemDialog key={dialog.key} open={dialog.open} onClose={closeDialog} item={dialog.item}
                             owners={dialog.item ? [{
                                 value: ownerKey(dialog.item),
                                 label: dialog.item.organizationId ? dialog.item.ownerName : t("vault.dialog.ownerPersonal", { username: user?.username, interpolation: { escapeValue: false } }),
                                 organizationId: dialog.item.organizationId,
                             }] : owners}
                             defaultOwner={canCreate ? activeScope : owners[0]?.value} onSaved={saved} />
        </div>
    );
};
