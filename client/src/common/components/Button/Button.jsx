import "./styles.sass";
import Icon from "@mdi/react";

// dataUiId is additive and optional: it carries a design-manifest marker onto
// the real DOM node. The component destructures its props, so a bare
// data-ui-id passed from outside would be dropped silently and the element
// would be unverifiable (mockingbird locator tier C instead of A).
//
// `loading` and `kbd` are both optional and both concern the same button state.
// `loading` replaces the icon with a spinner and marks the button aria-busy; it
// does not disable on its own, so a caller that wants the click blocked passes
// `disabled` as well. `kbd` prints the key that triggers the same action, and it
// is hidden while the button is disabled -- advertising a shortcut that does
// nothing is worse than advertising none.
export const Button = ({onClick, text, icon, disabled, type, buttonType, title, dataUiId, ariaInvalid, kbd, loading}) => {
    return (
        <button className={"btn" + (type ? " type-" + type : "") + (!text ? " icon-only" : "") + (loading ? " is-loading" : "")} onClick={onClick} disabled={disabled} type={buttonType} data-ui-id={dataUiId} aria-invalid={ariaInvalid || undefined} aria-busy={loading || undefined} title={title}>
            {loading ? <span className="btn-spinner" aria-hidden="true" /> : icon ? <Icon path={icon} /> : null}
            {text && <h3>{text}</h3>}
            {kbd && !disabled && !loading && <kbd>{kbd}</kbd>}
        </button>
    );
}