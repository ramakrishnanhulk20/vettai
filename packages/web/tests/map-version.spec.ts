import { expect, reachTheCity, test } from "./support/game";

type DebugWindow = {
  vettaiDebug?: { mapVersion: () => string; welcome: (frame: unknown) => void };
};

/**
 * The city on screen was built from the map the world served at boot. A room running a
 * different block would put the player through walls that are no longer there, so the
 * welcome that says so sends the game back for a fresh load.
 */
test("a room on a different block sends the game back for a fresh load", async ({ wired }) => {
  await wired.goto("/play");
  await reachTheCity(wired);

  const version = await wired.evaluate(() => {
    const debug = (window as unknown as DebugWindow).vettaiDebug;
    if (!debug) throw new Error("the game has not booted yet");
    return debug.mapVersion();
  });
  expect(version).not.toBe("");

  await wired.evaluate(() => {
    const debug = (window as unknown as DebugWindow).vettaiDebug;
    if (!debug) throw new Error("the game has not booted yet");
    debug.welcome({
      t: "welcome",
      you: "a-player",
      room: "a-room",
      tick: 1,
      mapVersion: "a-block-this-game-did-not-load",
      players: [],
      drones: [],
      quests: [],
    });
  });

  // Back through the loading screen, then into the city again on the block the world serves.
  await expect(wired.getByTestId("loading-mark")).toBeVisible({ timeout: 15_000 });
  await reachTheCity(wired);

  const after = await wired.evaluate(() => {
    const debug = (window as unknown as DebugWindow).vettaiDebug;
    if (!debug) throw new Error("the game has not booted yet");
    return debug.mapVersion();
  });
  expect(after).toBe(version);
});
