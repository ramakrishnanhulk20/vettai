/**
 * How many device pixels the renderer is allowed per CSS pixel. A phone inside the
 * Nimiq Pay WebView renders at 1, because the same scene has to run the live game there
 * and the fill rate is the budget that runs out first.
 */
export function scenePixelRatio(): number {
  if (typeof window === "undefined") return 1;
  const phone = window.innerWidth < 768 || window.nimiq !== undefined;
  if (phone) return 1;
  return Math.min(window.devicePixelRatio || 1, 1.5);
}
