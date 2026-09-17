import type { Page } from "@playwright/test";
import { expect, place, reachTheCity, test, walk } from "./support/game";

/**
 * The play screen read against reference/notes/GAME-DESIGN-AUDIT-2.md. Every case here
 * failed on the build that audit was taken from: a tutorial that blacked out the city and
 * a third card that never left, a street that never said what a job pays or when the day
 * ends, a trigger that drew a tracer for a shot the world always refuses, and a page that
 * came back from a phone call to a stopped game.
 *
 * 390x844, the size every number in that audit was measured at.
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "";

test.use({ viewport: { width: 390, height: 844 } });

/** Every alpha in a colour string, so a scrim can be read whatever notation it is in. */
function alphas(background: string): number[] {
  return Array.from(background.matchAll(/rgba?\([^)]*\)/g))
    .map((match) => /,\s*([\d.]+)\s*\)$/.exec(match[0]))
    .map((parts) => (parts ? Number(parts[1]) : 1));
}

/** The lessons are a first minute, and most of these cases are about the minute after it. */
async function skipTheLessons(page: Page): Promise<void> {
  await page.addInitScript(() => window.localStorage.setItem("vettai.firstminute", "seen"));
}

test("the first minute is a wash the city shows through, and it clears itself", async ({
  wired,
}) => {
  await wired.goto(`${BASE}/play`);
  await reachTheCity(wired);

  // The lesson over a city that is still drawing, which is what a judge opens on.
  await wired.waitForTimeout(1200);
  await wired.screenshot({ path: "lab-shots/hud-fixed-first-390.png" });

  const scrim = await wired
    .getByTestId("first-minute-scrim")
    .evaluate((node) => getComputedStyle(node).backgroundImage);
  expect(Math.max(...alphas(scrim))).toBeLessThanOrEqual(0.35);

  // Nothing is tapped and the board is never opened: each card has to hand over on its own.
  await expect(wired.getByTestId("first-minute-tap")).toContainText("3 / 3", { timeout: 15_000 });

  const carriedOn = Date.now();
  await expect(wired.getByTestId("first-minute")).toHaveCount(0, { timeout: 7000 });
  expect(Date.now() - carriedOn).toBeLessThan(7000);
  await expect(wired.getByTestId("board-count")).toHaveCount(0);
});

test("the street says what the job pays and the board says when the day ends", async ({
  wired,
}) => {
  await skipTheLessons(wired);
  await wired.goto(`${BASE}/play`);
  await reachTheCity(wired);

  await expect(wired.getByTestId("objective")).toContainText("NIM");

  await wired.getByTestId("hud-quests").click();
  await expect(wired.getByTestId("day-left")).toContainText("Today ends in");
});

test("a trigger pull at the office door is answered with the rule, not a tracer", async ({
  wired,
}) => {
  await skipTheLessons(wired);
  await wired.goto(`${BASE}/play`);
  await reachTheCity(wired);

  // The spawn is two metres from the office door, which is inside the ten metre circle the
  // world refuses every shot from.
  await wired.getByTestId("fire").click();

  await expect(wired.getByTestId("office-note")).toContainText("No shooting at the office");
  await expect(wired.getByTestId("shot-kick")).toHaveCount(0);
});

test("a page that goes away and comes back gets its socket straight back", async ({ wired }) => {
  await wired.addInitScript(() => {
    const live: WebSocket[] = [];
    const real = window.WebSocket;
    window.WebSocket = new Proxy(real, {
      construct(target, args: [string, (string | string[])?]) {
        const socket = new target(...args);
        live.push(socket);
        return socket;
      },
    });
    (window as unknown as { __sockets: WebSocket[] }).__sockets = live;
  });
  await skipTheLessons(wired);

  await wired.goto(`${BASE}/play`);
  await reachTheCity(wired);

  const sockets = () =>
    wired.evaluate(() => (window as unknown as { __sockets: WebSocket[] }).__sockets.length);
  const opened = await sockets();

  // The phone rings. The page is hidden, and the socket goes with it.
  await wired.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
    const live = (window as unknown as { __sockets: WebSocket[] }).__sockets;
    live[live.length - 1]?.close(4000, "the phone rang");
  });

  // Nothing is tried while nobody is looking: a throttled retry spends one of the eight the
  // player needs when they come back.
  await wired.waitForTimeout(1500);
  expect(await sockets()).toBe(opened);

  const back = Date.now();
  await wired.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    document.dispatchEvent(new Event("visibilitychange"));
  });

  await expect.poll(sockets, { timeout: 3000 }).toBeGreaterThan(opened);
  await expect(wired.getByTestId("link-banner")).toHaveCount(0, { timeout: 3000 });
  expect(Date.now() - back).toBeLessThan(3000);
});

test("outside the ring the shot is real, and the fight is on screen", async ({ wired }) => {
  await skipTheLessons(wired);
  await wired.goto(`${BASE}/play`);
  await reachTheCity(wired);

  // The circle is ten metres around the office door, and the door's own position comes from
  // the same map the world is running, not from a number written down here.
  const office = await wired.evaluate(() =>
    fetch("/api/world/map")
      .then((answer) => answer.json())
      .then((map: { office: { x: number; z: number } }) => map.office),
  );
  const fromTheDoor = async () => {
    const at = await place(wired);
    return Math.hypot((at?.x ?? 0) - office.x, (at?.z ?? 0) - office.z);
  };

  // Out of the circle, whichever way the street runs from the door. Being downed puts the
  // body back on the office step, so this is walked again whenever that happens.
  // Backwards first, twice: the body spawns facing the door, so away from it is behind.
  // The sideways pushes are there for a street that turns.
  const pushes = [
    [0, 1],
    [0, 1],
    [1, 0],
    [-1, 0],
    [0, 1],
  ];
  const leave = async () => {
    for (const push of pushes) {
      if ((await fromTheDoor()) > 15) return;
      await walk(wired, 2200, push[0] ?? 0, push[1] ?? 0);
    }
  };

  let fired = 0;
  const deadline = Date.now() + 40_000;
  while (fired === 0 && Date.now() < deadline) {
    if ((await wired.getByTestId("downed").count()) > 0) {
      await wired.waitForTimeout(3300);
      continue;
    }
    await leave();
    if ((await fromTheDoor()) <= 15) continue;
    await wired.getByTestId("fire").click();
    // The kick is drawn on the render after the trigger, so the count is read a beat later
    // rather than in the same breath as the tap.
    await wired.waitForTimeout(400);
    fired = await wired.getByTestId("shot-kick").count();
  }
  expect(fired).toBe(1);

  // A drone that has been shot at comes for the shooter. Three more rounds start the fight,
  // then the picture is taken of whatever the street looks like while it is on. Whether a
  // drone is close enough to be off the top of the screen is the room's business, so the
  // caret is waited for and not demanded.
  for (let round = 0; round < 3; round += 1) {
    await wired.getByTestId("fire").click();
    await wired.waitForTimeout(250);
  }
  for (let round = 0; round < 6; round += 1) {
    if ((await wired.getByTestId("overhead").count()) > 0) break;
    if ((await wired.getByTestId("downed").count()) > 0) break;
    await wired.waitForTimeout(400);
  }

  await wired.screenshot({ path: "lab-shots/hud-fixed-fight-390.png" });
});
