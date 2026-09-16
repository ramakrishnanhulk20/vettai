import type { Metadata, Viewport } from "next";
import PlayScreen from "@/components/play/PlayScreen";

export const metadata: Metadata = {
  title: "Vettai: the hunt",
  robots: { index: false, follow: false },
};

// A game does not want a double tap to zoom the street, and `cover` is what puts the HUD
// under the notch rather than beside it.
export const viewport: Viewport = {
  themeColor: "#0b0f1a",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default function PlayPage() {
  return <PlayScreen />;
}
