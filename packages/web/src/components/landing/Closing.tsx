"use client";

import Reveal from "./Reveal";
import { useDeepLink } from "./useLive";

const REPO = "https://github.com/ramakrishnanhulk20/vettai";

const SKYLINE =
  "M0 220V150h34v-26h40v42h30v-62h46v34h38v-58h52v76h28v-40h44v54h36v-88h50v70h34v-30h42v46h30v-64h48v82h32v-44h40v28h36v-72h54v92h30v-38h44v50h34v-66h46v78h30v-28h42v40h36v-58h50v70h34v-34h40v54h30v-46h48v60h32v-24h40v34h36v-50h50v66h30V220Z";

/** Lit windows, each one placed inside a building the path above actually draws. */
const WINDOWS: [number, number][] = [
  [200, 96], [214, 96], [200, 110], [214, 110],
  [360, 98], [374, 98], [360, 112],
  [672, 114], [686, 114], [672, 128],
  [114, 120], [128, 120],
  [516, 120], [530, 134],
  [282, 132], [296, 146],
  [444, 138],
  [834, 152],
];

export default function Closing() {
  const openInPay = useDeepLink();

  return (
    <footer className="relative flex min-h-[92svh] w-full flex-col overflow-hidden border-t border-line bg-night">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(90% 62% at 50% 86%, rgba(255,106,43,0.32), rgba(255,106,43,0.08) 42%, transparent 66%)",
        }}
      />

      <svg
        aria-hidden
        viewBox="0 0 1440 220"
        preserveAspectRatio="none"
        className="pointer-events-none absolute inset-x-0 bottom-[4.5rem] h-[34vh] w-full"
      >
        <path d={SKYLINE} fill="#04070e" />
        <path d={SKYLINE} fill="none" stroke="rgba(255,106,43,0.45)" strokeWidth="1" />
        <g fill="var(--hunt)" opacity="0.55">
          {WINDOWS.map(([x, y]) => (
            <rect key={`${x}-${y}`} x={x} y={y} width="5" height="6" />
          ))}
        </g>
        <g fill="var(--bad)" opacity="0.9">
          <rect x="212" y="76" width="4" height="4" className="beacon" />
          <rect x="371" y="78" width="4" height="4" />
        </g>
      </svg>

      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "linear-gradient(to top, rgba(11,15,26,0.96) 4%, rgba(11,15,26,0.45) 22%, transparent 58%)",
        }}
      />
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="grain-layer" />
      </div>

      <div className="relative z-10 flex flex-1 flex-col justify-between px-6 pb-8 pt-24 md:px-12 md:pb-10 md:pt-32">
        <Reveal className="max-w-[46rem]">
          <p className="label-type text-paper/40">Nimiq Mini Apps, Cycle III</p>
          <h2
            className="display-type mt-6 uppercase text-paper"
            style={{
              fontSize: "clamp(2.75rem, 7vw, 5.5rem)",
              lineHeight: 0.86,
              letterSpacing: "-0.03em",
            }}
          >
            The city is
            <br />
            <span className="text-hunt">already awake.</span>
          </h2>

          <div className="mt-9 flex flex-col gap-4 sm:flex-row sm:items-center">
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
            <p className="max-w-[28ch] font-mono text-xs leading-relaxed text-paper/40">
              Opens inside the wallet. Nothing to install, nothing to sign up for.
            </p>
          </div>
        </Reveal>

        <Reveal
          delay={0.22}
          distance={14}
          className="pointer-events-none absolute right-12 top-32 hidden w-52 border-t border-line pt-5 text-right md:block"
        >
          <p className="label-type leading-[2.1] text-paper/40">Vettai</p>
          <p className="label-type leading-[2.1] text-paper/25">Tamil for the hunt</p>
          <p className="label-type leading-[2.1] text-paper/25">Plays inside Nimiq Pay</p>
        </Reveal>

        <Reveal
          delay={0.1}
          distance={16}
          className="mt-20 flex flex-col gap-4 border-t border-line pt-6 md:flex-row md:items-center md:justify-between"
        >
          <div className="flex items-center gap-3">
            <span aria-hidden className="h-3 w-3 shrink-0 bg-hunt" />
            <span className="label-type text-paper/60">Vettai</span>
            <span className="label-type text-paper/25">MIT</span>
          </div>

          <p className="label-type max-w-[34ch] leading-[1.9] text-paper/25">
            City Kit and characters by Kenney, CC0
          </p>

          <nav className="flex items-center gap-6">
            {[
              ["GitHub", REPO],
              ["Docs", "/docs"],
            ].map(([label, href]) => (
              <a
                key={href}
                href={href}
                {...(href.startsWith("http") ? { target: "_blank", rel: "noreferrer" } : {})}
                className="group relative label-type text-paper/55 transition-colors duration-300 hover:text-paper"
              >
                {label}
                <span
                  aria-hidden
                  className="absolute -bottom-1.5 left-0 right-0 h-px origin-left scale-x-0 bg-hunt transition-transform duration-300 group-hover:scale-x-100"
                />
              </a>
            ))}
          </nav>
        </Reveal>
      </div>
    </footer>
  );
}
