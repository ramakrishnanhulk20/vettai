import { expect, reachTheCity, test } from "./support/game";

/**
 * The claims feed is the only way a phone learns that money landed. A read that fails used
 * to end the polling for the rest of the session, so a payout could arrive and the player
 * would never be told. Now it backs off and keeps asking.
 */
test("a failed claims read keeps the feed asking", async ({ wired }) => {
  let asked = 0;

  await wired.route("**/api/claims", async (route) => {
    asked += 1;
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "The world server fell over reading your payouts." }),
    });
  });

  await wired.goto("/play");
  await reachTheCity(wired);

  // The waits are 3 s, 6 s then 12 s, so a first read plus two retries land inside this.
  await expect.poll(() => asked, { timeout: 14_000, intervals: [500] }).toBeGreaterThanOrEqual(3);

  await wired.getByTestId("hud-quests").click();
  await expect(wired.getByTestId("claims-error")).toBeVisible();
});
