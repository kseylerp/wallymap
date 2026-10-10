// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmptyState, EXAMPLE_QUESTIONS } from "@/components/EmptyState";

afterEach(cleanup);

describe("EmptyState", () => {
  it("shows the WallyMap wordmark without the logo, the subtitle and the six questions", () => {
    const onPick = vi.fn();
    render(<EmptyState onPick={onPick} />);
    expect(screen.getByTestId("empty-state")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "WallyMap" })).toBeTruthy();
    expect(screen.queryByTestId("wally-mark")).toBeNull();
    expect(screen.getByText("Ask the map. Every answer is drawn, cited, and exportable.")).toBeTruthy();
    expect(EXAMPLE_QUESTIONS).toHaveLength(6);
    fireEvent.click(screen.getByRole("button", { name: EXAMPLE_QUESTIONS[0] }));
    expect(onPick).toHaveBeenCalledWith(EXAMPLE_QUESTIONS[0]);
  });
});

describe("EmptyState close button", () => {
  it("shows a hairline × labelled Close suggestions that calls onClose", () => {
    const onClose = vi.fn();
    render(<EmptyState onPick={() => {}} onClose={onClose} />);
    const close = screen.getByRole("button", { name: "Close suggestions" });
    expect(close.textContent).toBe("×");
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("has no × without a close handler", () => {
    render(<EmptyState onPick={() => {}} />);
    expect(screen.queryByRole("button", { name: "Close suggestions" })).toBeNull();
  });
});
