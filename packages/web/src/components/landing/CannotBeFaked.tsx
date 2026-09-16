"use client";

import Reveal from "./Reveal";

const PROOFS = [
  {
    label: "Intents not scores",
    line: "The phone sends a button press. It never sends a number the server is asked to believe.",
  },
  {
    label: "Hits called by the server",
    line: "The world ticks twenty times a second on our machine. Every shot and every drone down is decided there.",
  },
  {
    label: "One signature per claim",
    line: "A claim is a single-use challenge signed by your wallet. Replay it and the server refuses with a reason.",
  },
  {
    label: "The quest id rides on chain",
    line: "Each payout carries vettai: plus the quest in its memo. Anyone can open the explorer and check it against the ladder.",
  },
];

export default function CannotBeFaked() {
  return (
    <section className="relative border-t border-line px-6 py-24 md:px-12 md:py-36">
      <div className="grid gap-14 md:grid-cols-12 md:gap-8">
        <div className="md:col-span-5 md:self-start">
          <Reveal>
            <p className="label-type text-paper/40">Why it holds</p>
            <h2
              className="display-type mt-6 -ml-[0.02em] uppercase text-paper"
              style={{
                fontSize: "clamp(2.75rem, 7.5vw, 6rem)",
                lineHeight: 0.86,
                letterSpacing: "-0.03em",
              }}
            >
              Nobody can
              <br />
              <span className="text-hunt">fake</span> a bounty.
            </h2>
            <p className="mt-6 max-w-[38ch] text-base text-paper/60 md:text-lg">
              A game that pays real money is a game people will try to cheat. So the phone
              is never trusted with anything worth money.
            </p>
          </Reveal>
        </div>

        <ul className="md:col-span-6 md:col-start-7 md:pt-3">
          {PROOFS.map((proof, index) => (
            <Reveal
              as="li"
              key={proof.label}
              delay={index * 0.08}
              distance={20}
              className="group border-t border-line py-7 transition-colors duration-500 last:border-b hover:border-hunt/60"
            >
              <div className="flex items-start gap-5 transition-transform duration-500 group-hover:translate-x-1.5">
                <span className="label-type mt-1 w-8 shrink-0 text-paper/25 transition-colors duration-500 group-hover:text-hunt">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div>
                  <p className="label-type text-paper/70 transition-colors duration-500 group-hover:text-hunt">
                    {proof.label}
                  </p>
                  <p className="mt-3 max-w-[46ch] text-base text-paper/65 md:text-lg">
                    {proof.line}
                  </p>
                </div>
              </div>
            </Reveal>
          ))}
        </ul>
      </div>
    </section>
  );
}
