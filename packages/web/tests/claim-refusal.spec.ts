import { expect, reachTheCity, session, test } from "./support/game";

/**
 * A refused claim is about the claim, not about who is asking. The board says why and the
 * player carries on playing. Throwing the session away here used to cost them a signature
 * and their place in the city every time a claim was refused.
 */
test("a refused claim keeps the session and the board alive", async ({ wired }) => {
  await wired.route("**/api/quests/today", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        day: new Date().toISOString().slice(0, 10),
        quests: [
          {
            id: "quest-under-test",
            kind: "hunt",
            day: new Date().toISOString().slice(0, 10),
            target: 5,
            progress: 5,
            state: "done",
            rewardLuna: "50000",
            rewardNim: "0.5",
          },
        ],
      }),
    });
  });

  await wired.route("**/api/quests/*/claim/challenge", async (route) => {
    await route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ error: "that signature is from another wallet", code: "claim" }),
    });
  });

  await wired.goto("/play");
  await reachTheCity(wired);

  const before = await session(wired);
  expect(before).not.toBeNull();

  await wired.getByTestId("hud-quests").click();
  await wired.getByTestId("claim-hunt").click();

  await expect(wired.getByText("that signature is from another wallet")).toBeVisible();
  await expect(wired.getByTestId("board-count")).toBeVisible();
  expect(await session(wired)).toBe(before);
});
