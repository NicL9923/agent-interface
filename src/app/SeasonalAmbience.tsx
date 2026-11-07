import type { CSSProperties } from "react";
import type { Season } from "./season";

/** One small shape per season, drawn on a 24-unit grid. */
const motifs: Record<Season, { d: string; stroke?: boolean }> = {
  winter: { d: "M12 2.5v19M3.8 7.25l16.4 9.5M3.8 16.75l16.4-9.5M12 2.5l-2 2M12 2.5l2 2M12 21.5l-2-2M12 21.5l2-2", stroke: true },
  clover: { d: "M15.6 7.6a3.6 3.6 0 1 1-7.2 0a3.6 3.6 0 1 1 7.2 0ZM11.6 14a3.6 3.6 0 1 1-7.2 0a3.6 3.6 0 1 1 7.2 0ZM19.6 14a3.6 3.6 0 1 1-7.2 0a3.6 3.6 0 1 1 7.2 0ZM11.3 15h1.4v7h-1.4Z" },
  spring: { d: "M12 3C16.5 7 16.5 15 12 21C7.5 15 7.5 7 12 3Z" },
  stars: { d: "M12 2.5l2.8 6 6.5.7-4.9 4.4 1.4 6.4L12 16.8 6.2 20l1.4-6.4L2.7 9.2l6.5-.7Z" },
  spooky: { d: "M12 9.5c.7-1.6 1.8-2 1.8-2l.4 1.7c2.2-1.6 5.2-2 8.3-1.2-2.1.9-3.1 3-3.1 5-1.5-1-3.1-1-4.1.2-.8-1.1-2.5-1.5-3.3 0-.8-1.5-2.5-1.1-3.3 0-1-1.2-2.6-1.2-4.1-.2 0-2-1-4.1-3.1-5 3.1-.8 6.1-.4 8.3 1.2l.4-1.7s1.1.4 1.8 2Z" },
  harvest: { d: "M5 19C5 10.5 10.5 4.5 20 4.5c0 9-6 14.5-15 14.5ZM5 19l9-9", stroke: true },
};

const MOTES = 9;

/**
 * A few seasonal shapes drifting behind home, faint enough to read past. Decorative only:
 * hidden from assistive technology, never in the way of a pointer, and still under Reduce Motion.
 */
export function SeasonalAmbience({ season }: { season: Season }) {
  const motif = motifs[season];
  return <div className="season-ambience" aria-hidden="true">
    {Array.from({ length: MOTES }, (_, index) => <span key={index} className="season-mote" style={{
      // Spread across the width and through the cycle without a random source, so renders agree.
      ["--x" as string]: `${(index * 37 + 11) % 96}%`,
      ["--y" as string]: `${(index * 23 + 7) % 92}%`,
      ["--size" as string]: `${10 + (index * 5) % 9}px`,
      ["--duration" as string]: `${16 + (index * 7) % 11}s`,
      ["--delay" as string]: `${-((index * 4.3) % 16).toFixed(1)}s`,
      ["--sway" as string]: `${index % 2 ? 14 : -14}px`,
    } as CSSProperties}>
      <svg viewBox="0 0 24 24" fill={motif.stroke ? "none" : "currentColor"} stroke={motif.stroke ? "currentColor" : "none"} strokeWidth={1.8} strokeLinecap="round"><path d={motif.d} /></svg>
    </span>)}
  </div>;
}
