import "./styles.sass";
import Icon from "@/common/components/Icon";
import { Check as IconCheck, X as IconX, Minus as IconMinus } from "lucide-react";

const STATES = [
    { key: "deny", icon: IconX },
    { key: "neutral", icon: IconMinus },
    { key: "allow", icon: IconCheck },
];

export const TriToggle = ({ value = "neutral", onChange, disabled = false, inherited = null, inheritedHint }) => {
    const active = STATES.some((s) => s.key === value) ? value : "neutral";
    const showInherited = active === "neutral" && (inherited === "allow" || inherited === "deny");

    return (
        <div className={`tri-toggle state-${active} ${disabled ? "disabled" : ""}`} role="radiogroup">
            {STATES.map((state) => {
                const isInherited = showInherited && inherited === state.key;
                return (
                    <button
                        key={state.key}
                        type="button"
                        role="radio"
                        aria-checked={active === state.key}
                        className={`tri-segment ${state.key} ${active === state.key ? "active" : ""} ${isInherited ? "inherited" : ""}`}
                        title={isInherited ? inheritedHint : undefined}
                        disabled={disabled}
                        onClick={() => !disabled && onChange && onChange(state.key)}
                    >
                        <Icon icon={state.icon} />
                    </button>
                );
            })}
        </div>
    );
};