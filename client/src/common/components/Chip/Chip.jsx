import "./styles.sass";
import Icon from "@/common/components/Icon";

export const Chip = ({ label, selected, onClick, icon, disabled = false }) => {
    return (
        <button
            className={`chip ${selected ? "selected" : ""} ${disabled ? "disabled" : ""}`}
            onClick={() => !disabled && onClick?.(!selected)}
            disabled={disabled}
            type="button"
        >
            {icon && <Icon icon={icon} />}
            <span>{label}</span>
        </button>
    );
};
