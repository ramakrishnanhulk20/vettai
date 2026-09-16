"use client";

import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import CallChainArt from "./beats/CallChainArt";
import DroneArt from "./beats/DroneArt";
import PayoutReceipt from "./beats/PayoutReceipt";
import { reading, useStats } from "./useLive";
import { whole } from "./data";

const BEATS = [
  {
    numeral: "01",
    title: "You hunt",
    line: "Bounty drones patrol an open city at night. You chase one down the street and take the shot from behind your own character.",
  },
  {
    numeral: "02",
    title: "The server calls the hit",
    line: "Your phone sends what you tried to do, never a score. The world runs twenty times a second on our machine, and that is where the hit is decided.",
  },
  {
    numeral: "03",
    title: "The chain pays you",
    line: "One signature, and the treasury sends NIM to your wallet with the quest id in the memo. The block number lands while you are still standing in the street.",
  },
] as const;

/** Where each beat is fully on, and how wide the crossfade between two beats is. */
const CENTRES = [1 / 6, 1 / 2, 5 / 6];
const HOLD = 0.62;
const FADE = 0.24;

export default function HowItWorks() {
  const wrap = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const [pinned, setPinned] = useState(false);
  const live = useStats();

  useEffect(() => setPinned(!reduced), [reduced]);

  useEffect(() => {
    if (!pinned) return;
    const scroller = wrap.current;
    const stage = frame.current;
    if (!scroller || !stage) return;

    gsap.registerPlugin(ScrollTrigger);

    const layers = Array.from(stage.querySelectorAll<HTMLElement>("[data-beat]"));

    // The whole section moves on two CSS variables. React never renders a frame of it.
    const write = (progress: number) => {
      stage.style.setProperty("--how", progress.toFixed(4));
      const eased = 1 / 6 + progress * (2 / 3);
      for (const layer of layers) {
        const centre = CENTRES[Number(layer.dataset.beat)] ?? 0;
        const distance = Math.abs(eased - centre) * 3;
        const k = Math.min(1, Math.max(0, (HOLD - distance) / FADE));
        layer.style.setProperty("--k", k.toFixed(3));
      }
    };

    const trigger = ScrollTrigger.create({
      trigger: scroller,
      start: "top top",
      end: "bottom bottom",
      pin: stage,
      pinSpacing: false,
      onUpdate: (self) => write(self.progress),
      onRefresh: (self) => write(self.progress),
    });

    write(0);

    return () => trigger.kill();
  }, [pinned]);

  const settled = reading(live, (stats) => whole(stats.claimsPaid));

  const art = [
    <DroneArt key="drone" />,
    <CallChainArt key="chain" />,
    <PayoutReceipt key="receipt" settled={settled} />,
  ];

  if (!pinned) {
    return (
      <section className="relative border-t border-line px-6 py-20 md:px-12">
        <p className="label-type text-paper/40">How the hunt works</p>
        <div className="mt-12 flex flex-col gap-24">
          {BEATS.map((beat, index) => (
            <div key={beat.numeral} className="flex flex-col gap-8">
              <span className="beat-numeral block" style={{ fontSize: "clamp(5rem, 16vw, 11rem)" }}>
                {beat.numeral}
              </span>
              <div className="flex h-[16rem] items-center">{art[index]}</div>
              <div>
                <h3 className="display-type uppercase leading-[0.9]" style={{ fontSize: "clamp(2.25rem, 6vw, 4rem)" }}>
                  {beat.title}
                </h3>
                <p className="mt-4 max-w-[52ch] text-base text-paper/70 md:text-lg">{beat.line}</p>
              </div>
            </div>
          ))}
        </div>
      </section>
    );
  }

  return (
    <div ref={wrap} className="relative h-[330svh] w-full">
      <div
        ref={frame}
        className="beat-frame relative flex h-[100svh] w-full flex-col overflow-hidden border-t border-line px-6 pb-10 pt-20 md:px-12 md:pb-12 md:pt-24"
      >
        <div
          aria-hidden
          className="pointer-events-none absolute -right-24 -top-24 h-[34rem] w-[34rem] rounded-full opacity-45"
          style={{
            background: "radial-gradient(circle, rgba(255,106,43,0.16), transparent 68%)",
          }}
        />

        <p className="label-type relative z-20 text-paper/40">How the hunt works</p>

        <div className="relative z-10 min-h-0 flex-1">
          <div
            aria-hidden
            className="pointer-events-none absolute -left-[3vw] top-2 select-none md:-left-[2vw] md:top-[2vh]"
          >
            {BEATS.map((beat, index) => (
              <span
                key={beat.numeral}
                data-beat={index}
                className="beat-numeral absolute left-0 top-0 block whitespace-nowrap"
                style={{ fontSize: "clamp(7rem, 24vw, 21rem)" }}
              >
                {beat.numeral}
              </span>
            ))}
          </div>

          <div className="absolute inset-0 flex items-center justify-center md:justify-end">
            {art.map((piece, index) => (
              <div
                key={BEATS[index].numeral}
                data-beat={index}
                className="beat-layer absolute inset-0 flex items-end justify-center pb-2 md:items-center md:justify-end md:pb-0"
              >
                <div className="flex h-full max-h-[20rem] w-full max-w-[30rem] items-center justify-center md:max-h-[28rem] md:max-w-[36rem] md:justify-end">
                  {piece}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="relative z-20 h-[15rem] shrink-0 sm:h-[13rem] md:h-[14rem]">
          {BEATS.map((beat, index) => (
            <div
              key={beat.numeral}
              data-beat={index}
              className="beat-layer absolute inset-x-0 bottom-0"
            >
              <h3
                className="display-type uppercase leading-[0.88]"
                style={{ fontSize: "clamp(2.5rem, 6.5vw, 5rem)", letterSpacing: "-0.02em" }}
              >
                {beat.title}
              </h3>
              <p className="mt-4 max-w-[54ch] text-base text-paper/70 md:text-lg">{beat.line}</p>
            </div>
          ))}
        </div>

        <div className="relative z-20 mt-7 shrink-0">
          <div className="relative h-px w-full bg-line">
            <div className="beat-rail absolute inset-0 bg-hunt" />
          </div>
          <div className="mt-3 flex justify-between">
            {BEATS.map((beat) => (
              <span key={beat.numeral} className="label-type text-paper/25">
                {beat.numeral}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
