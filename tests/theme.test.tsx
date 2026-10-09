// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeToggle, WallyMark, Wordmark } from "@/components/Brand";
import { THEME_INIT_SCRIPT, THEME_STORAGE_KEY, setTheme } from "@/lib/theme/useTheme";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("theme", () => {
  it("defaults to light and toggles to dark, persisting the choice", () => {
    render(<ThemeToggle />);
    const button = screen.getByTestId("theme-toggle");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(button.getAttribute("aria-label")).toBe("Switch to dark mode");

    fireEvent.click(button);
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(button.getAttribute("aria-label")).toBe("Switch to light mode");

    fireEvent.click(button);
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  it("picks up a stored dark preference", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    render(<ThemeToggle />);
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(screen.getByTestId("theme-toggle").getAttribute("aria-label")).toBe("Switch to light mode");
  });

  it("still works when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<ThemeToggle />);
    expect(document.documentElement.dataset.theme).toBe("light");
    act(() => setTheme("dark"));
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("ships an init script that applies the stored theme before paint", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    new Function(THEME_INIT_SCRIPT)();
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});

describe("brand", () => {
  it("renders the WallyMap wordmark with the mark", () => {
    render(<Wordmark variant="hero" />);
    expect(screen.getByText("WallyMap")).toBeTruthy();
    expect(screen.getByTestId("wally-mark")).toBeTruthy();
  });

  it("renders the Wally logo PNG at the requested size", () => {
    render(<WallyMark size={20} />);
    const box = screen.getByTestId("wally-mark");
    expect(box.style.width).toBe("20px");
    expect(box.style.height).toBe("20px");
    const img = screen.getByAltText("Wally");
    expect(img.getAttribute("src")).toContain("wally-logo.png");
  });
});
