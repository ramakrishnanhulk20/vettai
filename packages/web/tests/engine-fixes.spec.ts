import { expect, reachTheCity, test } from "./support/game";

/**
 * The engine half of the round two game design audit, at the size every reading in that
 * audit was taken at. Each case here failed against the build the audit was written from:
 * the first screen printed "NaN m" twice, the game opened by sending a new player on a
 * 121 m walk past six drones, the aim ring lit up inside the circle where the world
 * refuses every shot, and the city cost 90 draw calls from a standstill.
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "";

/** The most calls a standing view may cost. The whole live game shares this budget. */
const CALL_BUDGET = 60;

type Probe = {
  __vettaiNaN?: string[];
  vettaiDebug?: {
    stats: () => { calls: number; triangles: number } | null;
    crosshair?: () => { hot: boolean; insideSafeCircle: boolean; droneAboveView: boolean };
  };
};

/**
 * Watches the two lines a judge reads first, ten times a second, from before the page has
 * run a line of its own. The metres are written as a CSS variable rather than as text, so
 * the sweep reads the variables as well as the elements.
 */
function watchForNaN(): void {
  const page = window as unknown as { __vettaiNaN?: string[] };
  const seen: string[] = [];
  page.__vettaiNaN = seen;

  const read = () => {
    const style = getComputedStyle(document.documentElement);
    const parts = [
      document.querySelector('[data-testid="objective"]')?.textContent ?? "",
      document.querySelector('[data-testid="prompt-note"]')?.textContent ?? "",
      document.querySelector('[data-testid="interact"]')?.textContent ?? "",
      style.getPropertyValue("--objective-range"),
      style.getPropertyValue("--cmp-t-range"),
    ];
    for (const part of parts) {
      if (part.toLowerCase().includes("nan")) seen.push(part.trim());
    }
  };

  setInterval(read, 100);
  read();
}

test.use({ viewport: { width: 390, height: 844 } });

test("the first screen never prints NaN, and the first job is the hunt", async ({ wired }) => {
  await wired.addInitScript(() => window.localStorage.setItem("vettai.firstminute", "seen"));
  await wired.addInitScript(watchForNaN);
  await wired.goto(`${BASE}/play`);
  await reachTheCity(wired);

  // Five seconds of city. The old build's NaN window was open from the first frame to
  // about two and a half seconds, which is most of the time a judge spends looking.
  await wired.waitForTimeout(5000);

  const sightings = await wired.evaluate(() => (window as unknown as Probe).__vettaiNaN ?? []);
  expect(sightings).toEqual([]);

  const objective = await wired.getByTestId("objective").textContent();
  expect(objective?.toLowerCase()).toContain("hunt");
});

test("the aim ring is dark inside the office circle, and the spawn view fits the budget", async ({
  wired,
}) => {
  await wired.addInitScript(() => window.localStorage.setItem("vettai.firstminute", "seen"));
  await wired.goto(`${BASE}/play`);
  await reachTheCity(wired);
  await wired.waitForTimeout(3000);

  const reading = await wired.evaluate(() => {
    const debug = (window as unknown as Probe).vettaiDebug;
    return {
      crosshair: debug?.crosshair?.() ?? null,
      stats: debug?.stats() ?? null,
      aimOn: getComputedStyle(document.documentElement).getPropertyValue("--aim-on").trim(),
    };
  });

  // The spawn stands two metres from the office door, well inside the circle the world
  // refuses shots from.
  expect(reading.crosshair?.insideSafeCircle).toBe(true);
  expect(reading.crosshair?.hot).toBe(false);
  expect(reading.aimOn).not.toBe("1");

  const calls = reading.stats?.calls ?? Number.POSITIVE_INFINITY;
  console.log(`draw calls at the spawn: ${calls}, triangles ${reading.stats?.triangles ?? 0}`);
  expect(calls).toBeLessThanOrEqual(CALL_BUDGET);
});
