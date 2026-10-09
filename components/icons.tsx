import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

/** Small stroked icons on a 20px grid; they inherit `currentColor`. */
function Icon({ children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 20 20"
      width={18}
      height={18}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      {children}
    </svg>
  );
}

export const PlusIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10 4.5v11M4.5 10h11" />
  </Icon>
);

export const MinusIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4.5 10h11" />
  </Icon>
);

export const GlobeIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="10" cy="10" r="6.75" />
    <path d="M3.25 10h13.5M10 3.25c1.9 2 2.85 4.25 2.85 6.75S11.9 14.75 10 16.75C8.1 14.75 7.15 12.5 7.15 10S8.1 5.25 10 3.25Z" />
  </Icon>
);

export const EyeIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.5 10s2.75-5 7.5-5 7.5 5 7.5 5-2.75 5-7.5 5-7.5-5-7.5-5Z" />
    <circle cx="10" cy="10" r="2.25" />
  </Icon>
);

export const EyeOffIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8.2 5.2A7.6 7.6 0 0 1 10 5c4.75 0 7.5 5 7.5 5a12.6 12.6 0 0 1-2.1 2.7M5.6 6.6C3.6 8 2.5 10 2.5 10s2.75 5 7.5 5c1.3 0 2.4-.37 3.37-.92" />
    <path d="M3.5 3.5l13 13" />
  </Icon>
);

export const ArrowUpIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10 15.5v-11M5.25 9.25 10 4.5l4.75 4.75" />
  </Icon>
);

export const StopIcon = (p: IconProps) => (
  <Icon {...p} fill="currentColor" stroke="none">
    <rect x="6" y="6" width="8" height="8" rx="1.5" />
  </Icon>
);

export const ChevronDownIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m5.5 8 4.5 4.5L14.5 8" />
  </Icon>
);

export const ChevronUpIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m5.5 12 4.5-4.5 4.5 4.5" />
  </Icon>
);

/** Topographic peaks: the Outdoors map. */
export const PeaksIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.5 15.5 7.5 7l3 5 2-3 5 6.5Z" />
  </Icon>
);

/** Imagery seen from above. */
export const SatelliteIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3.25" y="3.25" width="13.5" height="13.5" rx="3" />
    <path d="M3.5 12.5c2.5-1 4.5-.5 6.5 1s4 1.5 6.5.5M8 3.5c-.5 2.5.5 4.5 3 5.5" />
  </Icon>
);

/** Peaks laid over imagery: the hybrid. */
export const HybridIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3.25" y="3.25" width="13.5" height="13.5" rx="3" />
    <path d="M5 14.25 8.5 8.5l2.25 3.5 1.5-2 2.75 4.25Z" />
  </Icon>
);
