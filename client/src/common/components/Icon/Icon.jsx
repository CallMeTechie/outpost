import MdiIcon from "@mdi/react";
import "./styles.sass";

// The one place that knows two icon families are in play.
//
// Lucide carries the interface: everything a person navigates by -- menus, toolbars, tabs,
// dialogs -- is a Lucide component. Material Design Icons stay for exactly one job: the
// logos of operating systems, clouds and vendors (Ubuntu, Docker, AWS, GitHub), which Lucide
// deliberately does not draw. Those are also the icons whose *name* is stored in the database
// against a server entry, so dropping MDI would blank the icon of every server anyone has
// ever saved.
//
// So `icon` accepts either: a Lucide component, or an MDI path string.
export const Icon = ({ icon, path, size, spin, title, className, style, ...rest }) => {
    const value = icon ?? path;
    if (!value) return null;

    // An MDI path. Handed straight to @mdi/react, which still owns this family.
    if (typeof value === "string")
        return <MdiIcon path={value} size={size} spin={spin} title={title}
                        className={className} style={style} {...rest} />;

    const Lucide = value;

    // @mdi/react's unit, kept verbatim so no call site had to change its size when the
    // families were swapped: a number is a multiple of 1.5rem, a string is a length. Left
    // out, the icon carries Lucide's 24px width/height *attributes*, which any CSS rule
    // overrides -- and CSS is what sizes most icons here.
    const length = typeof size === "number" ? `${size * 1.5}rem` : size;

    return (
        <Lucide
            className={[spin ? "icon-spin" : null, className].filter(Boolean).join(" ") || undefined}
            style={length ? { width: length, height: length, ...style } : style}
            {...rest}>
            {/* Lucide has no title prop; as a child it becomes the accessible name, and its
                presence also drops the aria-hidden Lucide would otherwise add. */}
            {title ? <title>{title}</title> : null}
        </Lucide>
    );
};

export default Icon;
