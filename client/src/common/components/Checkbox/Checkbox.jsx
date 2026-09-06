import Icon from "@/common/components/Icon";
import { Check as IconCheck } from "lucide-react";
import "./styles.sass";

export const Checkbox = ({ checked, onChange, id, disabled = false, size = "medium" }) => {
    const handleChange = (e) => {
        if (onChange) onChange(e.target.checked);
    };

    return (
        <div className={`checkbox ${checked ? "checked" : ""} ${disabled ? "disabled" : ""} size-${size}`}>
            <input type="checkbox" checked={checked} onChange={handleChange} disabled={disabled} id={id} />
            <label htmlFor={id} className="checkbox-box">
                <Icon icon={IconCheck} />
            </label>
        </div>
    );
};
