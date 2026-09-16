import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Vettai: the hunt",
  robots: { index: false, follow: false },
};

export default function PlayPage() {
  return (
    <main className="flex min-h-[100svh] items-center justify-center px-6">
      <p className="label-type text-paper/50">The game loads here.</p>
    </main>
  );
}
