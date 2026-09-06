import "./styles.sass";
import Icon from "@/common/components/Icon";
import { Search as IconSearch } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useKeymaps, matchesKeybind } from "@/common/contexts/KeymapContext.jsx";

export const ServerSearch = ({search, setSearch}) => {

    const inputRef = useRef(null);
    const { t } = useTranslation();
    const { getParsedKeybind, formatKey } = useKeymaps();
    const searchKeybind = getParsedKeybind("search");

    useEffect(() => {
        const handleKeyDown = (e) => {
            if (searchKeybind && matchesKeybind(e, searchKeybind)) {
                e.preventDefault();
                inputRef.current.focus();
            }
        }
        document.addEventListener("keydown", handleKeyDown);
        return () => {
            document.removeEventListener("keydown", handleKeyDown);
        }
    }, [searchKeybind]);

    return (
        <div className="server-search" data-ui-id="UI-SERVERS-SEARCH">
            <Icon icon={IconSearch} className="search-icon" />
            <input className="search-input" placeholder={t("servers.searchPlaceholder")} ref={inputRef}
                value={search} onChange={(e) => setSearch(e.target.value)} />
            <div className="info-container" onClick={() => inputRef.current.focus()}>
                <p>{searchKeybind ? formatKey(searchKeybind.original) : "CTRL + S"}</p>
            </div>
        </div>
    )
}