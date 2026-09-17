import { expect, test } from "./support/game";

/**
 * The socket upgrades and then says nothing. Before the watchdog this sat on the joining
 * panel for ever, which on a phone looks exactly like a game that has hung.
 */
test("a socket that never says hello reaches the error panel inside nine seconds", async ({
  wired,
}) => {
  await wired.routeWebSocket("**/ws?*", () => {
    // Taking the route and never answering is the whole point: the socket is open and the
    // world is silent.
  });

  await wired.goto("/play");

  await expect(wired.getByText("Taking a seat in the city")).toBeVisible({ timeout: 60_000 });
  const joined = Date.now();

  await expect(wired.getByText("The city did not answer")).toBeVisible({ timeout: 15_000 });
  expect(Date.now() - joined).toBeLessThan(9500);

  await expect(wired.getByTestId("try-again")).toBeVisible();
});
