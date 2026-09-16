import type { Metadata, Viewport } from "next";
import { Big_Shoulders, Geist_Mono, Inter } from "next/font/google";
import SmoothScroll from "@/components/SmoothScroll";
import "./globals.css";

const display = Big_Shoulders({
  subsets: ["latin"],
  weight: ["700", "900"],
  display: "swap",
  variable: "--font-display-face",
});

const body = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-body-face",
});

const mono = Geist_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono-face",
});

export const metadata: Metadata = {
  title: "Vettai",
  description:
    "Hunt drones across an open city from inside Nimiq Pay. The bounty pays in NIM.",
};

export const viewport: Viewport = {
  themeColor: "#0b0f1a",
};

// Nimiq Pay injects its provider before page scripts run, so the wallet lands on
// the game and everyone else lands on the poster, with no flash of the wrong one.
const payRedirect =
  "if (location.pathname === '/' && (window.nimiqPay || window.nimiq)) location.replace('/play')";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${body.variable} ${mono.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: payRedirect }} />
      </head>
      <body className="bg-night text-paper antialiased">
        <SmoothScroll />
        {children}
        <div aria-hidden className="pointer-events-none fixed inset-0 z-50 overflow-hidden">
          <div className="grain-layer" />
        </div>
      </body>
    </html>
  );
}
