import { expect, test } from "./support/game";

/**
 * A world that closes the socket with 1008 has made a decision about this client. Coming
 * straight back with the same client gets the same answer, so the player is told rather
 * than left under a banner that promises a reconnection which is never coming.
 */
test("a 1008 close lands on the error panel, not the reconnect banner", async ({ wired }) => {
  await wired.routeWebSocket("**/ws?*", (socket) => {
    socket.close({ code: 1008, reason: "this ticket is spent" });
  });

  await wired.goto("/play");

  await expect(wired.getByText("The city closed the connection")).toBeVisible({ timeout: 60_000 });
  await expect(wired.getByTestId("try-again")).toBeVisible();
  await expect(wired.getByTestId("link-banner")).toHaveCount(0);

  // A fatal close stops the retries dead, so the panel is still there a few seconds later
  // rather than being replaced by another round of hope.
  await wired.waitForTimeout(4000);
  await expect(wired.getByText("The city closed the connection")).toBeVisible();
});
