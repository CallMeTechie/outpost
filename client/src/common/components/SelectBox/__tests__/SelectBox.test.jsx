import { expect, test, vi } from "vitest";
import { renderWithProviders } from "@/test/renderWithProviders.jsx";
import { SelectBox } from "@/common/components/SelectBox/SelectBox.jsx";

const OPTIONS = [
    { value: "a", label: "Alpha" },
    { value: "b", label: "Beta" },
];

// --- SelectBox ---

test("options arriving late never reach setSelected", () => {
    // Observed on setSelected, deliberately not on the visible text:
    // SelectBox.jsx:24 substitutes options[0] as the *displayed* option when
    // `selected` is empty. After the late arrival the trigger therefore shows
    // "Alpha" even though setSelected was never called - an assertion on the
    // visible text would be red while the finding itself is correct.
    const setSelected = vi.fn();

    const { rerender } = renderWithProviders(
        <SelectBox options={[]} selected={undefined} setSelected={setSelected} />,
    );
    rerender(<SelectBox options={OPTIONS} selected={undefined} setSelected={setSelected} />);

    expect(setSelected).not.toHaveBeenCalled();
});

test("options present at mount do reach setSelected, exactly once", () => {
    // The counterpart. Only the two together show that the gap hangs on
    // `options` and not on the effect as a whole.
    const setSelected = vi.fn();

    renderWithProviders(
        <SelectBox options={OPTIONS} selected={undefined} setSelected={setSelected} />,
    );

    expect(setSelected).toHaveBeenCalledTimes(1);
    expect(setSelected).toHaveBeenCalledWith("a");
});
