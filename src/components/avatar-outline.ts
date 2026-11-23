/**
 * The samples a shape morphs along: 72 points spaced evenly round its outside, clockwise from the
 * top. ios/AgentInterface/AvatarView.swift (`AvatarGeometry.points`) walks an outline the same
 * way, step for step, so a morph looks the same on both.
 */
export type Points = readonly (readonly number[])[];
export const OUTLINE_SAMPLES = 72;

/**
 * The outside contour as a polyline. Reads absolute M L H V Q C Z, the commands every outline is
 * written in, and stops at the first Z: a later contour is a hole, and walking it too would draw a
 * line from the outside to the hole.
 */
export function flattenOutline(path: string) {
  const points: number[][] = [];
  const tokens = path.match(/[MLHVQCZ]|-?\d*\.?\d+/g) ?? [];
  let index = 0;
  let command = "M";
  let x = 0;
  let y = 0;
  const value = () => Number(tokens[index++]);
  while (index < tokens.length) {
    if (/[MLHVQCZ]/.test(tokens[index])) {
      command = tokens[index++];
      if (command !== "Z") continue;
      points.push(points[0]);
      break;
    }
    if (command === "M" || command === "L") {
      x = value();
      y = value();
      points.push([x, y]);
      command = "L";
    } else if (command === "H") {
      x = value();
      points.push([x, y]);
    } else if (command === "V") {
      y = value();
      points.push([x, y]);
    } else if (command === "Q") {
      const [cx, cy, ex, ey] = [value(), value(), value(), value()];
      for (let i = 1; i <= 30; i++) {
        const t = i / 30;
        const u = 1 - t;
        points.push([
          u * u * x + 2 * u * t * cx + t * t * ex,
          u * u * y + 2 * u * t * cy + t * t * ey,
        ]);
      }
      [x, y] = [ex, ey];
    } else {
      const [ax, ay, bx, by, ex, ey] = [value(), value(), value(), value(), value(), value()];
      for (let i = 1; i <= 40; i++) {
        const t = i / 40;
        const u = 1 - t;
        const [a, b, c, d] = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
        points.push([a * x + b * ax + c * bx + d * ex, a * y + b * ay + c * by + d * ey]);
      }
      [x, y] = [ex, ey];
    }
  }
  return points;
}

/** Twice the area the points enclose: positive when they run clockwise on screen, where y grows down. */
export function signedArea(points: Points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x, y] = points[i];
    const [nx, ny] = points[(i + 1) % points.length];
    sum += x * ny - nx * y;
  }
  return sum;
}

/**
 * The same samples, clockwise, starting at the top: the sample nearest the vertical through the
 * middle of the shape, among those above the middle. Sample `i` of one shape moves to sample `i`
 * of the next, so two outlines that start on different sides or run opposite ways would cross
 * over each other mid-morph and the body would collapse to a sliver.
 */
export function alignSamples(points: Points): Points {
  const ordered = signedArea(points) < 0 ? [...points].reverse() : [...points];
  const cx = ordered.reduce((sum, [x]) => sum + x, 0) / ordered.length;
  const cy = ordered.reduce((sum, [, y]) => sum + y, 0) / ordered.length;
  let start = -1;
  for (let i = 0; i < ordered.length; i++) {
    const [x, y] = ordered[i];
    if (y >= cy) continue;
    if (start < 0) {
      start = i;
      continue;
    }
    const [bestX, bestY] = ordered[start];
    const closer = Math.abs(x - cx) - Math.abs(bestX - cx);
    // Within a millionth of a unit two samples are equally central, and the higher one starts.
    if (closer < -1e-6 || (closer <= 1e-6 && y < bestY)) start = i;
  }
  return start <= 0 ? ordered : [...ordered.slice(start), ...ordered.slice(0, start)];
}

/** An outline's samples, kept by path: a shape's never change, and every avatar on a page asks for them. */
const kept = new Map<string, Points>();
const KEPT_OUTLINES = 256;
export function sampleOutline(path: string): Points {
  const before = kept.get(path);
  if (before) return before;
  const line = flattenOutline(path);
  const lengths = line.slice(1).map(([x, y], i) => Math.hypot(x - line[i][0], y - line[i][1]));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  const samples: number[][] = [];
  for (let index = 0; index < OUTLINE_SAMPLES; index++) {
    const position = (total * index) / OUTLINE_SAMPLES;
    let walked = 0;
    for (let segment = 0; segment < lengths.length; segment++) {
      if (walked + lengths[segment] >= position || segment === lengths.length - 1) {
        const t = lengths[segment] === 0 ? 0 : (position - walked) / lengths[segment];
        const [ax, ay] = line[segment];
        const [bx, by] = line[segment + 1];
        samples.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
        break;
      }
      walked += lengths[segment];
    }
  }
  const aligned = alignSamples(samples);
  kept.set(path, aligned);
  // The avatar editor makes no new outlines, but a caller could; the oldest go past the cap.
  if (kept.size > KEPT_OUTLINES) kept.delete(kept.keys().next().value!);
  return aligned;
}
