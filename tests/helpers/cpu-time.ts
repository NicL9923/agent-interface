/**
 * CPU milliseconds of the best of several runs. Another process on the machine can delay a run but cannot make it use
 * more CPU, so a test that compares two of these numbers measured together does not follow the machine's load the way
 * a wall-clock budget does. Compare two sizes of the same work as a ratio: linear work grows with the input, quadratic
 * work grows with its square.
 */
export function cpuMs(work: () => void, runs = 7): number {
  let best = Infinity;
  for (let run = 0; run < runs; run++) {
    const before = process.cpuUsage();
    work();
    const used = process.cpuUsage(before);
    best = Math.min(best, (used.user + used.system) / 1000);
  }
  return best;
}
