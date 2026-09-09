import { expect, test, vi } from "vitest";
import { renderWithProviders } from "@/test/renderWithProviders.jsx";
import { ActionBar } from "@/pages/Servers/components/ViewContainer/renderer/FileRenderer/components/ActionBar/ActionBar.jsx";

const breadcrumbs = (container) =>
    [...container.querySelectorAll(".breadcrumb-container .path-part")].map((el) => el.textContent);

const renderBar = (path) =>
    renderWithProviders(
        <ActionBar path={path} updatePath={vi.fn()} historyIndex={0} historyLength={1} />,
    );

test("a short path shows every part and no ellipsis", () => {
    const { container } = renderBar("/home/user");

    expect(breadcrumbs(container)).toEqual(["home", "user"]);
});

test("a long path renders the parts the width measurement yields", () => {
    const { container } = renderBar("/home/user/projects/outpost/client/src");

    expect(breadcrumbs(container)).toEqual(["home", "...", "user", "projects", "outpost", "client", "src"]);
});
