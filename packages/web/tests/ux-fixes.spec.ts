import { expect, installSigner, reachTheCity, test } from "./support/game";
import type { Page } from "@playwright/test";

/**
 * The phone-first pass over the play screen, written off the findings in
 * reference/notes/UX-AUDIT.md. Every case here failed against the build that audit was
 * taken from: the deep link that took sixteen seconds to appear, the quest strip that
 * disappeared into a lit shop front, the claim button nine hundred pixels down the board,
 * nine pixel type, and the point codes nobody could read.
 *
 * The screen is 390x844, which is the size every measurement in the audit was taken at.
 */

/** A build under test that is not the one the config points at, for a verification run. */
const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "";

const TODAY = new Date().toISOString().slice(0, 10);

test.use({ viewport: { width: 390, height: 844 } });

/** The day's jobs as the world would send them, with one of each state that matters. */
function questsBody(huntReward: string): string {
  return JSON.stringify({
    day: TODAY,
    quests: [
      {
        id: "quest-hunt",
        kind: "hunt",
        day: TODAY,
        target: 5,
        progress: 5,
        state: "done",
        rewardLuna: huntReward,
        rewardNim: "0.5",
      },
      {
        id: "quest-courier",
        kind: "courier",
        day: TODAY,
        target: 1,
        progress: 0,
        state: "open",
        rewardLuna: "20000",
        rewardNim: "0.2",
        route: { from: 6, to: 1 },
        carrying: false,
      },
      {
        id: "quest-streak",
        kind: "streak",
        day: TODAY,
        target: 1,
        progress: 1,
        state: "done",
        rewardLuna: "20000",
        rewardNim: "0.2",
        streakDay: 4,
      },
    ],
  });
}

/** A payout the treasury could not send, the one screen that names the community. */
const FAILED_CLAIM = {
  id: "claim-failed",
  questId: "quest-streak",
  kind: "streak",
  state: "failed",
  amountLuna: "20000",
  amountNim: "0.2",
  memo: "vettai:9f3c1a20",
  txHash: null,
  blockNumber: null,
  createdAt: `${TODAY}T08:00:00.000Z`,
  paidAt: null,
  error: "the treasury could not send it",
};

async function boardOpen(page: Page, huntReward: string, claims: unknown[]): Promise<void> {
  await page.addInitScript(() => window.localStorage.setItem("vettai.firstminute", "seen"));
  await page.route("**/api/quests/today", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: questsBody(huntReward) }),
  );
  await page.route("**/api/claims", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ claims }),
    }),
  );

  await page.goto(`${BASE}/play`);
  await reachTheCity(page);
  await page.getByTestId("hud-quests").click();
  await expect(page.getByTestId("board-count")).toBeVisible();
}

/**
 * Everything on screen that a person reads or taps, with the decoration left out: a compass
 * tick or a crosshair arm is marked aria-hidden and is not type.
 */
async function measure(page: Page) {
  return page.evaluate(() => {
    const small: { text: string; size: number }[] = [];
    const tiny: { label: string; height: number }[] = [];

    for (const node of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      if (node.closest('[aria-hidden="true"]')) continue;
      const box = node.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const style = getComputedStyle(node);
      if (style.visibility === "hidden" || style.display === "none") continue;
      if (Number(style.opacity) === 0) continue;

      const own = Array.from(node.childNodes)
        .filter((child) => child.nodeType === Node.TEXT_NODE)
        .map((child) => child.textContent?.trim() ?? "")
        .join(" ")
        .trim();

      if (own !== "" && Number.parseFloat(style.fontSize) < 11) {
        small.push({ text: own.slice(0, 40), size: Number.parseFloat(style.fontSize) });
      }
      if ((node.tagName === "BUTTON" || node.tagName === "A") && box.height < 44) {
        tiny.push({ label: (node.textContent ?? "").trim().slice(0, 40), height: box.height });
      }
    }

    return { small, tiny };
  });
}

test("the way in shows the deep link rather than a progress dot", async ({ page, wallet }) => {
  await installSigner(page, wallet);

  await page.goto(`${BASE}/play`);
  const opened = Date.now();

  await expect(page.getByTestId("open-in-pay")).toBeVisible({ timeout: 3000 });
  expect(Date.now() - opened).toBeLessThan(3000);

  // One thing to do, one quiet way to move the link, and nothing asking for a retry the
  // page is already making on its own.
  await expect(page.getByTestId("copy-link")).toBeVisible();
  await expect(page.getByTestId("try-again")).toHaveCount(0);
  await expect(page.getByTestId("loading-status")).toContainText("still looking for the wallet");

  await page.screenshot({ path: "lab-shots/ux-fixed-nowallet-390.png" });
});

test("the quest strip carries its own plate over the street", async ({ wired }) => {
  // The first minute teaches the two thumbs over a dimmed city. This case is about the
  // HUD a player sees after that, so the lessons are marked as already read.
  await wired.addInitScript(() => window.localStorage.setItem("vettai.firstminute", "seen"));
  await wired.goto(`${BASE}/play`);
  await reachTheCity(wired);

  const plate = await wired.getByTestId("quest-strip").evaluate((node) => {
    const style = getComputedStyle(node);
    return { background: style.backgroundColor, border: style.borderRightWidth };
  });

  expect(plate.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(plate.background).not.toBe("transparent");
  expect(Number.parseFloat(plate.border)).toBeGreaterThan(0);

  const readings = await measure(wired);
  expect(readings.small).toEqual([]);
  expect(readings.tiny).toEqual([]);

  await wired.screenshot({ path: "lab-shots/ux-fixed-hud-390.png" });
});

test("the board leads with the claim and says what it can pay", async ({ wired }) => {
  await boardOpen(wired, "50000", [FAILED_CLAIM]);

  const claim = wired.getByTestId("claim-hunt");
  await expect(claim).toBeVisible();
  const box = await claim.boundingBox();
  expect(box).not.toBeNull();
  // The headline is the money, so the button that collects it is on the same screen as the
  // headline rather than four job rows below it.
  expect(box?.y ?? 9999).toBeLessThan(600);

  // The day of the streak is the server's own count, not one worked out from claim rows.
  await expect(wired.getByTestId("quest-streak")).toContainText("day 4");

  const words = (await wired.locator("body").innerText()).replace(/\s+/g, " ");
  expect(words).not.toMatch(/\bP\d\b/);
  expect(words).toContain("Nimiq Mini Apps community on Skool");
  expect(words).not.toContain("ask in Skool");

  const readings = await measure(wired);
  expect(readings.small).toEqual([]);
  expect(readings.tiny).toEqual([]);

  await wired.screenshot({ path: "lab-shots/ux-fixed-board-390.png" });
});

test("a claim the day's cap cannot cover says so on the button", async ({ wired }) => {
  await boardOpen(wired, "50000", [
    {
      id: "claim-paid",
      questId: "quest-other",
      kind: "hunt",
      state: "paid",
      amountLuna: "490000",
      amountNim: "4.9",
      memo: "vettai:earlier",
      txHash: null,
      blockNumber: 1,
      createdAt: `${TODAY}T06:00:00.000Z`,
      paidAt: `${TODAY}T06:00:30.000Z`,
      error: null,
    },
  ]);

  await expect(wired.getByTestId("claim-hunt")).toContainText("held until tomorrow");
  await expect(wired.getByTestId("held-ahead-hunt")).toContainText("midnight UTC");
});

test("the landing page counters never lead with a zero", async ({ page }) => {
  await page.goto(`${BASE}/`);

  const counters = page.locator("dl").first();
  await expect(counters).toContainText("Hunters");
  await expect(counters).not.toContainText("offline");

  const words = (await counters.innerText()).replace(/\s+/g, " ");
  expect(words).not.toMatch(/(Hunters|NIM paid|Drones downed today)\s*\n?\s*0\b/);

  // The receipt names the chain the world server is actually paying on, so it can never
  // disagree with the chip row above it, and it says nothing about settled payouts until
  // there is a number worth saying.
  const chain = page.getByTestId("receipt-network").first();
  await expect(chain).toHaveText(/^Nimiq (mainnet|testnet)$/);
  const settled = await page.getByText("payouts have settled").count();
  expect(settled).toBe(0);

  // The hero counters arrive last, nearly two seconds in. A shot taken before that is a
  // picture of the entrance, not of the page.
  await page.waitForTimeout(2200);
  await page.screenshot({ path: "lab-shots/ux-fixed-landing-390.png" });
});
