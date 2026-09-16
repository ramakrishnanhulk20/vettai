import { createMDX } from "fumadocs-mdx/next";
import type { NextConfig } from "next";

const apiOrigin = process.env.API_ORIGIN ?? "http://localhost:8788";

const nextConfig: NextConfig = {
  // Verification builds write to a second folder so they never touch the .next
  // folder the dev server is holding open.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",

  // The dev overlay button parks itself over the walk stick and the loading bar, which is
  // the one corner of the screen a phone screenshot cannot afford to lose.
  devIndicators: false,

  // Next writes its own AGENTS.md and CLAUDE.md on every dev start. This repo
  // keeps those names for its own private files, so the generator stays off.
  agentRules: false,

  // Inside the Nimiq Pay WebView the game and the world server have to look like
  // one origin, or the socket and the API would both need CORS and a second
  // hostname for the wallet to trust.
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${apiOrigin}/api/:path*` },
      { source: "/ws", destination: `${apiOrigin}/ws` },
      { source: "/health", destination: `${apiOrigin}/health` },
    ];
  },
};

// The docs route reads its pages from content/docs at build time.
const withMDX = createMDX();

export default withMDX(nextConfig);
