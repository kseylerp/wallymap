"use client";

import { useSyncExternalStore } from "react";

/** The phone layout's breakpoint (under Tailwind's `md`). */
export const PHONE_QUERY = "(max-width: 767px)";

/** True on a phone-sized screen; follows rotation and resizing. False on the server. */
export function useIsPhone(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const mq = window.matchMedia(PHONE_QUERY);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(PHONE_QUERY).matches,
    () => false,
  );
}
