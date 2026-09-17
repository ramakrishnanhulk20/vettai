import { expect, loop, reachTheCity, session, test } from "./support/game";

/**
 * The whole way in, end to end: the wallet answers, the world verifies a real signature,
 * a room says hello and the loop starts drawing. Everything else in this folder is about
 * what happens when one of those steps does not go to plan.
 */
test("a signed in wallet reaches the city and the loop runs", async ({ wired }) => {
  await wired.goto("/play");

  await reachTheCity(wired);

  expect(await session(wired)).not.toBeNull();
  await expect.poll(async () => (await loop(wired)).running).toBe(true);

  const first = await loop(wired);
  await wired.waitForTimeout(600);
  const second = await loop(wired);
  expect(second.frames).toBeGreaterThan(first.frames);
});
