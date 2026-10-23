"use client";

import type { SignShape } from "@/layers/types";
import { SIGN_COLORS, WHITE } from "@/lib/render/palette";

/**
 * A trail or piste sign's shape in its color, beside a difficulty level's swatch or chip (attributes that use sign
 * colors): a green circle, a blue square, a black diamond, two black diamonds.
 */
export function SignMark({ sign }: { sign: SignShape }) {
  const color = SIGN_COLORS[sign];
  const diamond = (cx: number) => <path d={`M${cx} 1 L${cx + 4} 5 L${cx} 9 L${cx - 4} 5 Z`} fill={color} stroke={WHITE} strokeWidth={0.75} />;
  if (sign === "double-black-diamond") {
    return (
      <svg aria-label="Double black diamond" role="img" viewBox="0 0 17 10" width={17} height={10} className="shrink-0 self-center">
        {diamond(4.5)}
        {diamond(12.5)}
      </svg>
    );
  }
  return (
    <svg aria-label={sign === "green-circle" ? "Green circle" : sign === "blue-square" ? "Blue square" : "Black diamond"} role="img" viewBox="0 0 10 10" width={10} height={10} className="shrink-0 self-center">
      {sign === "green-circle" && <circle cx={5} cy={5} r={4} fill={color} stroke={WHITE} strokeWidth={0.75} />}
      {sign === "blue-square" && <rect x={1.25} y={1.25} width={7.5} height={7.5} fill={color} stroke={WHITE} strokeWidth={0.75} />}
      {sign === "black-diamond" && diamond(5)}
    </svg>
  );
}
