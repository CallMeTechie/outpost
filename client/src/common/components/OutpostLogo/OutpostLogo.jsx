import { memo } from "react";

// Four posts of different heights, the last one lit. A palisade and a server list at once --
// a pattern rather than a picture, which is what survives at 20px in a favicon and next to a
// row of single-colour menu icons.
//
// Replaces the terminal chevron inherited from the fork, which said "terminal" rather than
// "outpost" and, more practically, carried a Gaussian blur: at favicon size that turned the
// whole mark into a smudge. There is no filter here and no gradient, one reason this renders
// identically at every size it is used at (24, 36, 40, 48, 64).
//
// Colour comes from currentColor, so the mark carries whatever accent the user has chosen and
// needs no second version for the light theme. The lit post is --success rather than the
// accent: it is the one part that should not change when someone picks a green accent, since
// then the mark would go flat.
export const OutpostLogo = memo(({ size = 40, className = "" }) => {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 32 32"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className={className}
            // The accent by default, since none of the five call sites sets a colour and the
            // mark would otherwise inherit the surrounding text colour. A className can still
            // override it -- that is why this is currentColor inside rather than a fixed fill.
            style={{ color: "var(--primary)" }}
            role="img"
            aria-label="Outpost"
        >
            <rect x="3.5" y="12" width="4.6" height="17" rx="2.3" fill="currentColor" opacity="0.55" />
            <rect x="10.7" y="6" width="4.6" height="23" rx="2.3" fill="currentColor" />
            <rect x="17.9" y="9" width="4.6" height="20" rx="2.3" fill="currentColor" opacity="0.8" />
            <rect x="25.1" y="15" width="4.6" height="14" rx="2.3" fill="var(--success, #29C16A)" />
        </svg>
    );
});

OutpostLogo.displayName = "OutpostLogo";
