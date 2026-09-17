import { expect, test } from "@playwright/test";

type HeroLeg = {
  axisAligned: boolean;
  clearOfBuildings: boolean;
  length: number;
  dronesInViewAt3s: number;
};

type LabWindow = { vettaiHeroLeg?: HeroLeg };

/**
 * The hero is the first thing a judge sees, and for a while it flew down the longest
 * patrol leg on the map whether or not that leg was a street. Map version 3 made the
 * longest leg a diagonal through a block, so the shot opened on a facade. The canvas
 * publishes what it actually flew, and this reads it back.
 */
test("the hero camera flies a street, not a wall, with a drone in the opening frame", async ({
  page,
}) => {
  await page.goto("/lab");

  const shot = await page.waitForFunction(
    () => (window as unknown as LabWindow).vettaiHeroLeg ?? null,
    undefined,
    { timeout: 60_000, polling: 250 },
  );
  const leg = (await shot.jsonValue()) as HeroLeg;

  expect(leg.axisAligned).toBe(true);
  expect(leg.clearOfBuildings).toBe(true);
  expect(leg.length).toBeGreaterThan(0);
  expect(leg.dronesInViewAt3s).toBeGreaterThanOrEqual(1);

  // The programme is on its second cycle. The old label survived two passes of the copy.
  await expect(page.locator("body")).not.toContainText("Cycle III");
});
