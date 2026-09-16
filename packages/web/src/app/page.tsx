import Hero from "@/components/hero/Hero";
import CannotBeFaked from "@/components/landing/CannotBeFaked";
import Closing from "@/components/landing/Closing";
import ForBuilders from "@/components/landing/ForBuilders";
import HowItWorks from "@/components/landing/HowItWorks";
import Ladder from "@/components/landing/Ladder";
import SiteNav from "@/components/landing/SiteNav";

export default function LandingPage() {
  return (
    <main id="top">
      <SiteNav />
      <Hero />
      <HowItWorks />
      <CannotBeFaked />
      <Ladder />
      <ForBuilders />
      <Closing />
    </main>
  );
}
