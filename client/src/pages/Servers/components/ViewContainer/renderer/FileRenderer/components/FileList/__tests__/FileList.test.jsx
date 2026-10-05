import { expect, test, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { renderWithProviders } from "@/test/renderWithProviders.jsx";
import { FileList } from "@/pages/Servers/components/ViewContainer/renderer/FileRenderer/components/FileList/FileList.jsx";

vi.mock("@/common/contexts/PreferencesContext.jsx", () => ({
    usePreferences: () => ({
        showThumbnails: false,
        showHiddenFiles: true,
        confirmBeforeDelete: true,
        dragDropAction: "ask",
    }),
}));

const items = [
    { name: ".env", type: "file", size: 10, mode: 0o644, last_modified: 0 },
    { name: "notes.txt", type: "file", size: 10, mode: 0o644, last_modified: 0 },
];

const renderList = (props = {}) =>
    renderWithProviders(
        <FileList items={items} path="/home" session={{ id: "s1" }} updatePath={vi.fn()}
                  sendOperation={vi.fn()} setCurrentFile={vi.fn()} downloadFile={vi.fn()} {...props} />,
    );

const row = (container, name) =>
    [...container.querySelectorAll(".file-item")].find((el) => el.querySelector("h2")?.textContent === name);

test("shown hidden entries are dimmed, ordinary ones are not", () => {
    const { container } = renderList();

    expect(row(container, ".env").classList.contains("dimmed")).toBe(true);
    expect(row(container, "notes.txt").classList.contains("dimmed")).toBe(false);
});

test("pressing the dots opens the menu and keeps the row from starting a drag", () => {
    const { container } = renderList();
    const entry = row(container, "notes.txt");

    fireEvent.pointerDown(entry.querySelector(".dots-menu"), { button: 0, isPrimary: true, pointerId: 1 });

    expect(document.querySelector("[data-ui-id='UI-FILES-LIST-MENU']")).not.toBeNull();
    expect(fireEvent.dragStart(entry)).toBe(false);
});
