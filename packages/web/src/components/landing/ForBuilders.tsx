"use client";

import { useEffect, useState } from "react";
import Reveal from "./Reveal";
import { nim, whole } from "./data";
import { reading, useStats } from "./useLive";

const REPO = "https://github.com/ramakrishnanhulk20/vettai";
const COMMAND = "npm run prove";

function CopyCommand() {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(COMMAND).then(
          () => setCopied(true),
          () => setCopied(false),
        );
      }}
      className="group flex w-full items-center justify-between gap-6 rounded-[8px] border border-line bg-night/70 px-5 py-4 text-left transition-colors duration-300 hover:border-hunt/60"
    >
      <code className="font-mono text-sm text-paper md:text-base">
        <span className="text-hunt">$</span> {COMMAND}
      </code>
      <span className="label-type shrink-0 text-paper/35 transition-colors duration-300 group-hover:text-hunt">
        {copied ? "Copied" : "Copy"}
      </span>
    </button>
  );
}

export default function ForBuilders() {
  const live = useStats();

  const counters: [string, string][] = [
    ["Hunters all time", reading(live, (stats) => whole(stats.playersAllTime))],
    ["Drones downed today", reading(live, (stats) => whole(stats.killsToday))],
    ["NIM paid out", reading(live, (stats) => nim(stats.paidNim))],
  ];

  return (
    <section className="relative border-t border-line bg-[#070a12] px-6 py-24 md:px-12 md:py-32">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-hunt/50 to-transparent"
      />

      <div className="grid gap-14 md:grid-cols-12 md:gap-8">
        <div className="md:col-span-7">
          <Reveal>
            <p className="label-type text-paper/40">For builders and judges</p>
            <h2
              className="display-type mt-6 uppercase text-paper"
              style={{
                fontSize: "clamp(2.25rem, 5.5vw, 4.25rem)",
                lineHeight: 0.88,
                letterSpacing: "-0.03em",
              }}
            >
              Do not take our
              <br />
              word for it.
            </h2>
          </Reveal>

          <Reveal delay={0.1} className="mt-9 max-w-[32rem]">
            <CopyCommand />
          </Reveal>

          <Reveal delay={0.16}>
            <p className="mt-6 max-w-[58ch] text-base text-paper/65 md:text-lg">
              It starts the real world in one process, plays it with a scripted wallet
              through the real socket, then attacks it: forged signatures, replays,
              somebody else&apos;s quest, the caps, a short shop payment, a flood on the
              socket, and a payout the treasury has already sent. Every refusal prints
              with the reason the server gave.
            </p>
          </Reveal>
        </div>

        <div className="md:col-span-4 md:col-start-9 md:border-l md:border-line md:pl-8">
          <Reveal delay={0.08}>
            <ul className="flex flex-col">
              {[
                ["Source on GitHub", REPO],
                ["Read the docs", "/docs"],
              ].map(([label, href]) => (
                <li key={href}>
                  <a
                    href={href}
                    className="group flex items-center justify-between border-b border-line py-4 text-base text-paper/75 transition-colors duration-300 hover:text-paper"
                    {...(href.startsWith("http")
                      ? { target: "_blank", rel: "noreferrer" }
                      : {})}
                  >
                    {label}
                    <span
                      aria-hidden
                      className="text-hunt transition-transform duration-300 group-hover:translate-x-1"
                    >
                      &rarr;
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </Reveal>

          <Reveal delay={0.16}>
            <dl className="mt-9 flex flex-col gap-3">
              {counters.map(([label, value]) => (
                <div key={label} className="flex items-baseline justify-between gap-4">
                  <dt className="label-type text-paper/35">{label}</dt>
                  <dd className="font-mono text-sm tabular-nums text-paper">{value}</dd>
                </div>
              ))}
            </dl>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
