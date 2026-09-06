import { useLayoutEffect, useRef, useState } from "react";
import Icon from "@/common/components/Icon";
import { WandSparkles as IconWandSparkles, ArrowRightToLine as IconArrowRightToLine, ChevronsUpDown as IconChevronsUpDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import "./styles.sass";

export const CommandSuggestion = ({ anchor, query, commands, selectedIndex, loading, error, onAccept, onCycle, foreground, fontFamily, fontSize }) => {
    const hintRef = useRef(null);
    const [maxWidth, setMaxWidth] = useState(null);
    const { t } = useTranslation();

    useLayoutEffect(() => {
        const containerWidth = hintRef.current?.parentElement?.clientWidth;
        if (!containerWidth) return;

        setMaxWidth(Math.max(0, containerWidth - anchor.left));
    }, [anchor.left, commands, query, fontSize]);

    const command = commands[selectedIndex] ?? commands[0];
    const asking = !loading && !error && !command;

    const hintStyle = {
        left: anchor.left,
        top: anchor.top,
        height: anchor.height,
        maxWidth,
        color: foreground,
        fontFamily,
        fontSize: `${fontSize}px`,
    };

    return (
        <div ref={hintRef}
             className={`command-suggestion${loading ? " loading" : ""}${error ? " error" : ""}${asking ? " asking" : ""}`}
             style={hintStyle} role="status" aria-live="polite">
            {loading && (
                <span className="command-suggestion__pending">
                    <Icon icon={IconWandSparkles} className="command-suggestion__key" />
                    <span className="command-suggestion__label">{t("servers.commandSuggestion.generating")}</span>
                </span>
            )}

            {!loading && error && (
                <span className="command-suggestion__pending">
                    <Icon icon={IconWandSparkles} className="command-suggestion__key" />
                    <span className="command-suggestion__label">{error}</span>
                </span>
            )}

            {asking && (
                <span className="command-suggestion__pending">
                    <Icon icon={IconWandSparkles} className="command-suggestion__key" />
                    <span className={`command-suggestion__label${query ? "" : " placeholder"}`}>
                        {query || t("servers.commandSuggestion.placeholder")}
                    </span>
                    <span className="command-suggestion__caret" />
                </span>
            )}

            {!loading && !error && command && (
                <>
                    <button type="button" className="command-suggestion__accept" onClick={() => onAccept(command)}
                            title={t("servers.commandSuggestion.accept")}>
                        <Icon icon={IconArrowRightToLine} className="command-suggestion__key" />
                        <span className="command-suggestion__label">{command}</span>
                    </button>
                    {commands.length > 1 && (
                        <button type="button" className="command-suggestion__cycle" onClick={() => onCycle(1)}
                                title={t("servers.commandSuggestion.cycle")}
                                aria-label={t("servers.commandSuggestion.cycle")}>
                            <Icon icon={IconChevronsUpDown} className="command-suggestion__cycle-icon" />
                            <span className="command-suggestion__counter">{selectedIndex + 1}/{commands.length}</span>
                        </button>
                    )}
                </>
            )}
        </div>
    );
};
