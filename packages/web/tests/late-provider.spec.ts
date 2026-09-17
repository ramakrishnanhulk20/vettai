import { expect, injectProvider, installSigner, reachTheCity, test } from "./support/game";

/**
 * Nimiq Pay can be slow to hand a cold start its wallet, slower than the fifteen seconds
 * the page waits. The page used to stop there and ask the player to open it in Nimiq Pay,
 * which is where they already were. Now it keeps looking and boots itself.
 */
test("a wallet that arrives late still boots the game", async ({ page, wallet }) => {
  await installSigner(page, wallet);

  const opened = Date.now();
  await page.goto("/play");

  await expect(page.getByText("Open Vettai inside Nimiq Pay")).toBeVisible({ timeout: 40_000 });

  const waited = Date.now() - opened;
  if (waited < 16_000) await page.waitForTimeout(16_000 - waited);

  await injectProvider(page, wallet);

  await reachTheCity(page);
});
