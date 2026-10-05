import { expect, test, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/renderWithProviders.jsx";
import { ConnectionError } from "../ConnectionError.jsx";

test("der Countdown zeigt Restzeit und Versuch, Jetzt verbinden löst den Reconnect aus", async () => {
    const onReconnect = vi.fn();
    renderWithProviders(
        <ConnectionError message="The connection to the host was interrupted." retryable
                         reconnect={{ attempt: 2, maxAttempts: 5, nextAttemptAt: 18_000 }} now={10_000}
                         onReconnect={onReconnect} onClose={vi.fn()} />
    );

    expect(screen.getByText("Retrying in 8 s · Attempt 2/5")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /connect now/i }));
    expect(onReconnect).toHaveBeenCalledTimes(1);
});
