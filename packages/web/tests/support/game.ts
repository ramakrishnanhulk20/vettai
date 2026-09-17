import { expect, test as base, type Page } from "@playwright/test";
import { newWallet, type Signed, type Wallet } from "./wallet";

/**
 * What every case needs: a wallet, a page that Nimiq Pay has handed that wallet to, and
 * the few readings the game publishes for a check to look at.
 *
 * The provider written onto `window.nimiq` is the same shape the real one has, and its
 * signatures are real: they are made by a real key pair in this process and the world
 * verifies them. Nothing else about the game is faked here.
 */

export type LoopReading = { running: boolean; frames: number };

export type Place = { x: number; z: number };

type DebugWindow = {
  vettaiDebug?: {
    loop: () => LoopReading;
    mapVersion: () => string;
    welcome: (frame: unknown) => void;
    readout: () => { calls: number; triangles: number } | null;
    heap: () => number | null;
    place: () => Place | null;
  };
  __vettaiSign?: (message: string) => Promise<Signed>;
  nimiq?: unknown;
};

/** The whole provider, as a function so it can be handed either to a fresh page or a live one. */
function writeProvider(address: string): void {
  const page = window as unknown as DebugWindow;
  const ask = (message: string) => {
    const sign = page.__vettaiSign;
    if (!sign) throw new Error("the test signer was not installed");
    return sign(message);
  };
  page.nimiq = {
    listAccounts: async () => [address],
    sign: async (message: string | { message: string }) =>
      ask(typeof message === "string" ? message : message.message),
    isConsensusEstablished: async () => true,
    getBlockNumber: async () => 1,
    sendBasicTransactionWithData: async () => "00".repeat(32),
  };
}

/** The signer alone. A page that gets this but no provider is a phone outside Nimiq Pay. */
export async function installSigner(page: Page, wallet: Wallet): Promise<void> {
  await page.exposeFunction("__vettaiSign", (message: string) => wallet.sign(message));
}

/** Pay hands the page its wallet before any page script runs, which is the warm start. */
export async function installProvider(page: Page, wallet: Wallet): Promise<void> {
  await page.addInitScript(writeProvider, wallet.address);
}

/** Pay hands the page its wallet long after the page gave up waiting, which is a cold start. */
export async function injectProvider(page: Page, wallet: Wallet): Promise<void> {
  await page.evaluate(writeProvider, wallet.address);
}

export const test = base.extend<{ wallet: Wallet; wired: Page }>({
  wallet: async ({}, use) => {
    await use(newWallet());
  },

  /** A page with the wallet already in it, not yet navigated anywhere. */
  wired: async ({ page, wallet }, use) => {
    await installSigner(page, wallet);
    await installProvider(page, wallet);
    await use(page);
  },
});

export { expect };

/** Waits for the city: the HUD is only on screen once a room has said hello. */
export async function reachTheCity(page: Page): Promise<void> {
  await expect(page.getByTestId("hud-quests")).toBeVisible({ timeout: 60_000 });
}

export function loop(page: Page): Promise<LoopReading> {
  return page.evaluate(() => {
    const debug = (window as unknown as DebugWindow).vettaiDebug;
    if (!debug) throw new Error("the game has not booted yet");
    return debug.loop();
  });
}

export function session(page: Page): Promise<string | null> {
  return page.evaluate(() => window.localStorage.getItem("vettai.session"));
}

/** Where the body is standing, as the render loop has it. Null before the city is built. */
export function place(page: Page): Promise<Place | null> {
  return page.evaluate(() => {
    const debug = (window as unknown as DebugWindow).vettaiDebug;
    return debug?.place() ?? null;
  });
}

/**
 * Pushes the walk stick for a while, with the same pointer events a thumb produces: down on
 * the left half of the surface, then a move every frame or so, because a stick that holds a
 * direction without moving for a second and a half is dropped on purpose.
 *
 * `dx` and `dy` are the push, in screen directions: dy of -1 is forward.
 */
export async function walk(page: Page, ms: number, dx: number, dy: number): Promise<void> {
  await page.evaluate(
    ({ ms, dx, dy }) =>
      new Promise<void>((done) => {
        const surface = document.querySelector<HTMLElement>('[data-testid="surface"]');
        if (!surface) throw new Error("the play surface is not on the page");

        const box = surface.getBoundingClientRect();
        const from = { x: box.width * 0.22, y: box.height * 0.72 };
        const to = { x: from.x + dx * 70, y: from.y + dy * 70 };
        const event = (kind: string, at: { x: number; y: number }) =>
          surface.dispatchEvent(
            new PointerEvent(kind, {
              pointerId: 21,
              pointerType: "touch",
              isPrimary: true,
              bubbles: true,
              cancelable: true,
              clientX: at.x,
              clientY: at.y,
            }),
          );

        event("pointerdown", from);
        const started = Date.now();
        const nudge = setInterval(() => {
          event("pointermove", to);
          if (Date.now() - started < ms) return;
          clearInterval(nudge);
          event("pointerup", to);
          done();
        }, 120);
      }),
    { ms, dx, dy },
  );
}
