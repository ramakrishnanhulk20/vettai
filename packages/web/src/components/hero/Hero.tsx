"use client";

import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import CityCanvas from "./CityCanvas";

const META = ["Nimiq Pay", "Open city", "Daily bounties", "Mainnet"];

const EASE = [0.16, 1, 0.3, 1] as const;

type Stats = {
  playersToday: number;
  killsToday: number;
  paidNim: string;
};

type Live =
  | { state: "loading" }
  | { state: "offline" }
  | { state: "ready"; stats: Stats };

function whole(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function nim(value: string): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return value;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(amount);
}

export default function Hero() {
  const root = useRef<HTMLElement>(null);
  const reduced = useReducedMotion();
  const [live, setLive] = useState<Live>({ state: "loading" });
  const [host, setHost] = useState("");

  useEffect(() => setHost(window.location.host), []);

  useEffect(() => {
    const abort = new AbortController();

    fetch("/api/stats", { signal: abort.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`the server answered ${response.status}`);
        return response.json() as Promise<Stats>;
      })
      .then((stats) => setLive({ state: "ready", stats }))
      .catch((error: unknown) => {
        if (abort.signal.aborted) return;
        console.error(error);
        setLive({ state: "offline" });
      });

    return () => abort.abort();
  }, []);

  useEffect(() => {
    if (reduced) return;
    const el = root.current;
    if (!el) return;

    gsap.registerPlugin(ScrollTrigger);

    // The progress goes out as a CSS variable, so the title and the city drift apart
    // without React rendering a frame.
    const trigger = ScrollTrigger.create({
      trigger: el,
      start: "top top",
      end: "bottom top",
      onUpdate: (self) => el.style.setProperty("--hero-scroll", self.progress.toFixed(4)),
    });

    return () => trigger.kill();
  }, [reduced]);

  const rise = (delay: number) => ({
    initial: { opacity: 0, y: 40 },
    animate: { opacity: 1, y: 0 },
    transition: reduced ? { duration: 0 } : { duration: 0.9, delay, ease: EASE },
  });

  const openInPay = host ? `https://nimpay.app/miniapps/open/${host}/play` : "/play";

  const reading = (value: string) => {
    if (live.state === "loading") return "...";
    if (live.state === "offline") return "offline";
    return value;
  };

  const stats = live.state === "ready" ? live.stats : null;

  return (
    <>
      <section
        ref={root}
        className="relative min-h-[100svh] w-full overflow-hidden bg-night"
      >
        <div className="parallax-city absolute inset-0">
          <CityCanvas />
        </div>

        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "linear-gradient(to top, #0b0f1a 0%, rgba(11,15,26,0.88) 22%, rgba(11,15,26,0.34) 45%, rgba(11,15,26,0) 55%)",
          }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-44"
          style={{
            background: "linear-gradient(to bottom, rgba(11,15,26,0.8), transparent)",
          }}
        />
        <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="grain-layer" />
        </div>

        <div className="relative z-10 flex min-h-[100svh] w-full flex-col px-6 pb-12 pt-6 md:px-12 md:pb-14">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={reduced ? { duration: 0 } : { duration: 0.9, delay: 0.05 }}
            className="flex items-start gap-3"
          >
            <span aria-hidden className="mt-[3px] h-3 w-3 shrink-0 bg-hunt" />
            <span className="label-type leading-[1.7] text-paper/65">
              Vettai
              <span className="block text-paper/35">A Nimiq Pay mini app</span>
            </span>
          </motion.div>

          <div className="flex flex-1 flex-col justify-end">
            <div className="parallax-title relative">
              <motion.ul
                {...rise(0.06)}
                className="flex flex-wrap items-center gap-x-3 gap-y-2 md:gap-x-4"
              >
                {META.map((item, index) => (
                  <li key={item} className="flex items-center gap-3 md:gap-4">
                    {index > 0 && (
                      <span aria-hidden className="h-1 w-1 rounded-full bg-hunt/80" />
                    )}
                    <span className="label-type text-paper/60">{item}</span>
                  </li>
                ))}
              </motion.ul>

              <motion.h1
                {...rise(0.14)}
                className="display-type mt-4 -ml-[0.04em] uppercase text-paper"
                style={{
                  fontSize: "clamp(4.5rem, 17vw, 15rem)",
                  letterSpacing: "-0.04em",
                  lineHeight: 0.85,
                }}
              >
                Vettai
              </motion.h1>

              <motion.p
                {...rise(0.26)}
                className="mt-4 max-w-[46ch] text-lg text-paper/80 md:text-xl"
              >
                The hunt pays in <span className="text-hunt">NIM</span>.
              </motion.p>

              <motion.div
                {...rise(0.38)}
                className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-5"
              >
                <a
                  href={openInPay}
                  className="group inline-flex w-full items-center justify-center gap-2.5 rounded-[8px] bg-hunt px-7 py-4 text-[0.9375rem] font-semibold tracking-wide text-night transition-[transform,background-color,box-shadow] duration-300 hover:-translate-y-0.5 hover:scale-[1.02] hover:bg-[#ff8146] hover:shadow-[0_20px_48px_-20px_rgba(255,106,43,0.85)] sm:w-auto"
                >
                  Open in Nimiq Pay
                  <span
                    aria-hidden
                    className="transition-transform duration-300 group-hover:translate-x-1"
                  >
                    &rarr;
                  </span>
                </a>
                <a
                  href="#how"
                  className="group relative inline-flex w-full items-center justify-center rounded-[8px] border border-line px-7 py-4 text-[0.9375rem] text-paper/75 transition-colors duration-300 hover:border-paper/40 hover:text-paper sm:w-auto"
                >
                  How it works
                  <span
                    aria-hidden
                    className="absolute bottom-3 left-7 right-7 h-px origin-left scale-x-0 bg-hunt transition-transform duration-300 group-hover:scale-x-100"
                  />
                </a>
              </motion.div>
            </div>

            <motion.dl
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={reduced ? { duration: 0 } : { duration: 0.8, delay: 0.9, ease: EASE }}
              className="mt-9 flex flex-col gap-2 border-l border-line pl-4 md:absolute md:right-12 md:top-24 md:mt-0 md:items-end md:gap-2.5 md:border-l-0 md:border-r md:pl-0 md:pr-5"
            >
              <div className="flex items-center gap-2.5">
                <span aria-hidden className="live-dot h-1.5 w-1.5 rounded-full bg-hunt" />
                <span className="label-type text-paper/40">Live from the block</span>
              </div>
              {[
                ["Hunters today", reading(whole(stats?.playersToday ?? 0))],
                ["Drones downed today", reading(whole(stats?.killsToday ?? 0))],
                ["NIM paid", reading(nim(stats?.paidNim ?? "0"))],
              ].map(([label, value]) => (
                <div key={label} className="flex items-baseline gap-3 md:justify-end">
                  <dt className="label-type text-paper/40">{label}</dt>
                  <dd className="font-mono text-[0.9375rem] tabular-nums text-paper">{value}</dd>
                </div>
              ))}
            </motion.dl>
          </div>
        </div>
      </section>

      <div id="how" className="h-0 w-full" />
    </>
  );
}
