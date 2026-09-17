import type { Page } from "@playwright/test";
import { expect, place, reachTheCity, test, walk } from "./support/game";

/**
 * The sound of the hunt, checked the way a phone would meet it.
 *
 * A WebView will not let a page make a sound until a finger has touched it, so the one
 * thing that must be true before anything else is that no AudioContext exists on a page
 * nobody has touched. The constructor is wrapped in an init script and counts its own
 * calls: the real context is still built, so what comes back is the browser's answer and
 * not a fake one.
 *
 * What actually played is read off `window.vettaiDebug.audio.played`, which the play screen
 * publishes while developing. A count only goes up when a sound really reached the mixer,
 * so it is also how muting is proved.
 *
 * 390x844, the phone every other check here is measured at.
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "";

test.use({ viewport: { width: 390, height: 844 } });

type AudioWatch = { count: number; resumes: number; live: AudioContext | null };

type AudioWindow = Window & {
  __audio?: AudioWatch;
  vettaiDebug?: { audio?: { played: Record<string, number> } };
};

/** Counts the contexts the page builds without stopping it from building a real one. */
async function watchAudio(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const spot = window as AudioWindow;
    spot.__audio = { count: 0, resumes: 0, live: null };
    const real = window.AudioContext;

    function counted(this: unknown): AudioContext {
      const made = new real();
      const resume = made.resume.bind(made);
      made.resume = () => {
        const watch = spot.__audio;
        if (watch) watch.resumes += 1;
        return resume();
      };
      const watch = spot.__audio;
      if (watch) {
        watch.count += 1;
        watch.live = made;
      }
      return made;
    }

    counted.prototype = real.prototype;
    window.AudioContext = counted as unknown as typeof AudioContext;
  });
}

async function skipTheLessons(page: Page): Promise<void> {
  await page.addInitScript(() => window.localStorage.setItem("vettai.firstminute", "seen"));
}

function contexts(page: Page): Promise<number> {
  return page.evaluate(() => (window as AudioWindow).__audio?.count ?? -1);
}

function contextState(page: Page): Promise<string | null> {
  return page.evaluate(() => (window as AudioWindow).__audio?.live?.state ?? null);
}

function played(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => (window as AudioWindow).vettaiDebug?.audio?.played ?? {});
}

/** The same touch a thumb makes on the street, which is what opens the speaker. */
async function touchTheStreet(page: Page): Promise<void> {
  await page.evaluate(() => {
    const surface = document.querySelector<HTMLElement>('[data-testid="surface"]');
    if (!surface) throw new Error("the play surface is not on the page");
    const box = surface.getBoundingClientRect();
    const at = { clientX: box.width * 0.3, clientY: box.height * 0.7 };
    const shared = { pointerId: 44, pointerType: "touch", isPrimary: true, bubbles: true, cancelable: true };
    surface.dispatchEvent(new PointerEvent("pointerdown", { ...shared, ...at }));
    surface.dispatchEvent(new PointerEvent("pointerup", { ...shared, ...at }));
  });
}

test("the speaker stays shut until the street is touched, and opens on the first touch", async ({
  wired,
}) => {
  await watchAudio(wired);
  await skipTheLessons(wired);
  await wired.goto(`${BASE}/play`);
  await reachTheCity(wired);

  // Signing in, loading the block and joining a room are all done, and nothing has been
  // touched. A context built here would be one the WebView refuses to start anyway.
  expect(await contexts(wired)).toBe(0);

  await touchTheStreet(wired);

  expect(await contexts(wired)).toBe(1);
  await expect.poll(() => contextState(wired), { timeout: 10_000 }).toBe("running");

  // A second touch must not build a second one: the whole engine is one context.
  await touchTheStreet(wired);
  expect(await contexts(wired)).toBe(1);
});

test("the mute button remembers itself and really stops the sound", async ({ wired }) => {
  await watchAudio(wired);
  await skipTheLessons(wired);
  await wired.goto(`${BASE}/play`);
  await reachTheCity(wired);
  await touchTheStreet(wired);

  // The spawn is inside the no-fire circle, so the trigger there is answered with the rule
  // and the refusal sound. It is the one thing that can be asked for over and over.
  await wired.getByTestId("fire").click();
  await expect(wired.getByTestId("office-note")).toBeVisible();
  const before = (await played(wired)).refused ?? 0;
  expect(before).toBeGreaterThan(0);

  await wired.getByTestId("mute").click();
  expect(await wired.evaluate(() => window.localStorage.getItem("vettai.muted"))).toBe("1");

  await wired.getByTestId("fire").click();
  await wired.waitForTimeout(300);
  expect((await played(wired)).refused ?? 0).toBe(before);

  // And back on, which is a tap the player hears and a phone that remembers.
  await wired.getByTestId("mute").click();
  expect(await wired.evaluate(() => window.localStorage.getItem("vettai.muted"))).toBe("0");
  expect((await played(wired)).tap ?? 0).toBeGreaterThan(0);
});

test("the trigger makes a shot once the player is out of the office circle", async ({ wired }) => {
  await watchAudio(wired);
  await skipTheLessons(wired);
  await wired.goto(`${BASE}/play`);
  await reachTheCity(wired);
  await touchTheStreet(wired);

  const office = await wired.evaluate(() =>
    fetch("/api/world/map")
      .then((answer) => answer.json())
      .then((map: { office: { x: number; z: number } }) => map.office),
  );
  const fromTheDoor = async () => {
    const at = await place(wired);
    return Math.hypot((at?.x ?? 0) - office.x, (at?.z ?? 0) - office.z);
  };

  // Backwards first, because the body spawns facing the door. The sideways pushes are
  // there for a street that turns.
  const pushes: [number, number][] = [
    [0, 1],
    [0, 1],
    [1, 0],
    [-1, 0],
    [0, 1],
  ];

  let shots = 0;
  const deadline = Date.now() + 45_000;
  while (shots === 0 && Date.now() < deadline) {
    if ((await wired.getByTestId("downed").count()) > 0) {
      await wired.waitForTimeout(3300);
      continue;
    }
    for (const push of pushes) {
      if ((await fromTheDoor()) > 15) break;
      await walk(wired, 2200, push[0], push[1]);
    }
    if ((await fromTheDoor()) <= 15) continue;
    await wired.getByTestId("fire").click();
    await wired.waitForTimeout(300);
    shots = (await played(wired)).shot ?? 0;
  }

  expect(shots).toBeGreaterThan(0);
});
