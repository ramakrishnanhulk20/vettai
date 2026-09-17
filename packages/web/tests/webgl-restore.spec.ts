import { expect, loop, reachTheCity, test } from "./support/game";

const CANVAS_EVENT = (kind: string) => {
  const canvas = document.querySelector("canvas");
  if (!canvas) throw new Error("there is no canvas on the page");
  canvas.dispatchEvent(new Event(kind, { cancelable: true }));
};

/**
 * A phone under pressure takes the graphics away from a background tab or a hot app. The
 * page used to keep asking for frames against a dead context, which is a black screen with
 * a HUD on top. Now it stops, says so, and builds the city again on a fresh canvas.
 */
test("a lost graphics context stops the loop and the restore rebuilds the city", async ({
  wired,
}) => {
  await wired.goto("/play");
  await reachTheCity(wired);

  await wired.evaluate(CANVAS_EVENT, "webglcontextlost");

  await expect(wired.getByText("Restarting the picture")).toBeVisible();

  const stopped = await loop(wired);
  expect(stopped.running).toBe(false);
  await wired.waitForTimeout(500);
  expect((await loop(wired)).frames).toBe(stopped.frames);

  await wired.evaluate(CANVAS_EVENT, "webglcontextrestored");

  await reachTheCity(wired);
  await expect.poll(async () => (await loop(wired)).running).toBe(true);
  expect((await loop(wired)).frames).toBeGreaterThan(stopped.frames);
});
