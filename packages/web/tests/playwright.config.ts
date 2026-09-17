import { defineConfig, devices } from "@playwright/test";

/**
 * The browser checks that stand between a phone and a dead end.
 *
 * They run against the real local world on 8788 and the real dev server on 3004: the only
 * thing stubbed is the wallet, because a native dialog cannot be tapped from here. Where a
 * case is about a socket or an endpoint misbehaving, that one call is intercepted in the
 * browser and everything else stays real.
 *
 * Both servers are started if they are not already up. One worker: the cases watch timing,
 * and a dev server compiling four pages at once is not a fair clock.
 */
export default defineConfig({
  testDir: ".",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  // Anything a failed run leaves behind goes under a name this repo already ignores, so a
  // screenshot of a broken frame can never end up in a commit.
  outputDir: "../.next-test-results",
  use: {
    baseURL: "http://localhost:3004",
    ...devices["Pixel 7"],
    isMobile: true,
    hasTouch: true,
    trace: "off",
    video: "off",
  },
  webServer: [
    {
      command: "npm start",
      cwd: "../../server",
      url: "http://localhost:8788/health",
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: "npm run dev",
      cwd: "..",
      url: "http://localhost:3004/play",
      reuseExistingServer: true,
      timeout: 180_000,
    },
  ],
});
