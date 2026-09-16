import type { Metadata } from "next";
import Hero from "@/components/hero/Hero";

export const metadata: Metadata = {
  title: "Vettai lab",
  robots: { index: false, follow: false },
};

export default function LabPage() {
  return (
    <main className="relative">
      <span className="label-type pointer-events-none fixed bottom-5 left-6 z-40 text-paper/30">
        lab: hero
      </span>
      <Hero />
    </main>
  );
}
