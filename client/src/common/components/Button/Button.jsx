import "./styles.sass";
import Icon from "@mdi/react";

// dataUiId is additive and optional: it carries a design-manifest marker onto
// the real DOM node. The component destructures its props, so a bare
// data-ui-id passed from outside would be dropped silently and the element
// would be unverifiable (mockingbird locator tier C instead of A).
export const Button = ({onClick, text, icon, disabled, type, buttonType, title, dataUiId}) => {
    return (
        <button className={"btn" + (type ? " type-" + type : "") + (!text ? " icon-only" : "")} onClick={onClick} disabled={disabled} type={buttonType} data-ui-id={dataUiId} title={title}>
            {icon ? <Icon path={icon} /> : null}
            {text && <h3>{text}</h3>}
        </button>
    );
}