import type { Metadata } from "next";
import CityLook from "@/components/lab/CityLook";

export const metadata: Metadata = {
  title: "Vettai lab: the city look",
  robots: { index: false, follow: false },
};

export default function LookLabPage() {
  return (
    <main className="fixed inset-0 overflow-hidden">
      <CityLook />
    </main>
  );
}
