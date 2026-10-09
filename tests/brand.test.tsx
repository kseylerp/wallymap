// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WallyMark, Wordmark } from "@/components/Brand";

afterEach(cleanup);

describe("brand", () => {
  it("renders the WallyMap wordmark with the logo and no theme toggle", () => {
    render(<Wordmark />);
    expect(screen.getByText("WallyMap")).toBeTruthy();
    expect(screen.getByTestId("wally-mark")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders the light Wally logo PNG at the requested size", () => {
    render(<WallyMark size={20} />);
    const box = screen.getByTestId("wally-mark");
    expect(box.style.width).toBe("20px");
    expect(box.style.height).toBe("20px");
    expect(screen.getByAltText("Wally").getAttribute("src")).toContain("wally-logo-light.png");
  });
});
