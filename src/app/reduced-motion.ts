/** Whether the system asks for reduced motion now. False where media queries are unavailable. */
export function prefersReducedMotion() {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}
