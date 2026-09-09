import { expect, test } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/renderWithProviders.jsx";
import { useContextMenu } from "@/common/components/ContextMenu/useContextMenu.js";
import { ContextMenu } from "@/common/components/ContextMenu/ContextMenu.jsx";

// --- ContextMenu / useContextMenu ---

const Harness = () => {
    const contextMenu = useContextMenu();
    return (
        <>
            <button onClick={contextMenu.toggle}>Open</button>
            <button>Outside</button>
            {/* The menu stays mounted until the closing transition ends
                (ContextMenu.jsx:44-49, wired at :134 as onTransitionEnd), which jsdom
                never fires, so isOpen is the observable, not the DOM. */}
            <span data-testid="state">{contextMenu.isOpen ? "open" : "closed"}</span>
            <ContextMenu isOpen={contextMenu.isOpen} position={contextMenu.position}
                         onClose={contextMenu.close} trigger={contextMenu.triggerRef}>
                <div>Item</div>
            </ContextMenu>
        </>
    );
};

test("a mousedown on the trigger is exempt from the outside handler", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open" });
    const state = () => screen.getByTestId("state").textContent;

    await user.click(trigger);
    expect(state()).toBe("open");

    // fireEvent, not user.click: a click would also run toggle, and only the
    // document mousedown handler (ContextMenu.jsx:64-71) reads `trigger`.
    fireEvent.mouseDown(trigger);
    expect(state()).toBe("open");

    fireEvent.mouseDown(screen.getByRole("button", { name: "Outside" }));
    expect(state()).toBe("closed");
});
