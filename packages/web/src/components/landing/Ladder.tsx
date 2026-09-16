"use client";

import Reveal from "./Reveal";
import { nim, whole, type LadderEntry } from "./data";
import { useLadder } from "./useLive";

function prizeLine(prizes: string[]): string | null {
  const named = prizes.filter((prize) => Number(prize) > 0).map(nim);
  if (named.length === 0) return null;
  const last = named[named.length - 1];
  const rest = named.slice(0, -1);
  const list = rest.length > 0 ? `${rest.join(", ")} and ${last}` : last;
  return `The week closes on a payout of ${list} NIM to the hunters at the top.`;
}

function Row({ entry, share, delay }: { entry: LadderEntry; share: number; delay: number }) {
  const podium = entry.place <= 3;

  return (
    <Reveal
      as="li"
      delay={delay}
      distance={14}
      className="group relative border-t border-line last:border-b"
    >
      <div
        aria-hidden
        className="absolute inset-y-0 left-0 w-full origin-left bg-hunt/[0.07] transition-colors duration-500 group-hover:bg-hunt/[0.14]"
        style={{ transform: `scaleX(${share})` }}
      />
      <div className="relative flex items-center gap-5 py-4 transition-transform duration-500 group-hover:translate-x-1.5 md:gap-8">
        <span
          className={`display-type w-12 shrink-0 tabular-nums leading-none md:w-16 ${
            podium ? "text-hunt" : "text-paper/30"
          }`}
          style={{ fontSize: podium ? "clamp(2rem, 4vw, 3rem)" : "clamp(1.375rem, 2.4vw, 1.875rem)" }}
        >
          {String(entry.place).padStart(2, "0")}
        </span>
        <span className="flex-1 truncate font-mono text-sm text-paper/70 transition-colors duration-500 group-hover:text-paper md:text-base">
          {entry.address}
        </span>
        <span className="shrink-0 text-right font-mono text-sm tabular-nums text-paper md:text-base">
          {whole(entry.kills)}
          <span className="label-type ml-2 text-paper/35">down</span>
        </span>
      </div>
    </Reveal>
  );
}

export default function Ladder() {
  const live = useLadder();
  const entries = live.state === "ready" ? live.data.entries : [];
  const leader = entries[0]?.kills ?? 0;
  const prizes = live.state === "ready" ? prizeLine(live.data.prizesNim) : null;

  return (
    <section id="ladder" className="relative border-t border-line px-6 py-24 md:px-12 md:py-36">
      <div className="grid gap-10 md:grid-cols-12 md:gap-8">
        <div className="md:col-span-4">
          <Reveal>
            <div className="flex items-center gap-2.5">
              <span aria-hidden className="live-dot h-1.5 w-1.5 rounded-full bg-hunt" />
              <p className="label-type text-paper/40">
                {live.state === "ready" ? `Week ${live.data.week}` : "This week"}
              </p>
            </div>
            <h2
              className="display-type mt-6 uppercase text-paper"
              style={{
                fontSize: "clamp(2.5rem, 6.5vw, 5rem)",
                lineHeight: 0.86,
                letterSpacing: "-0.03em",
              }}
            >
              This week&apos;s
              <br />
              hunters
            </h2>
            <p className="mt-6 max-w-[34ch] text-base text-paper/60">
              Ranked on drones downed since Monday. The rows come straight off the
              server&apos;s own count.
            </p>
          </Reveal>
        </div>

        <div className="md:col-span-7 md:col-start-6">
          {live.state === "loading" && (
            <ul aria-busy="true">
              {[0, 1, 2, 3, 4].map((slot) => (
                <li key={slot} className="border-t border-line py-4 last:border-b">
                  <div className="h-6 w-full animate-pulse bg-paper/[0.06]" />
                </li>
              ))}
            </ul>
          )}

          {live.state === "offline" && (
            <p className="border-y border-line py-10 font-mono text-sm text-paper/45">
              The ladder is offline right now. It comes back with the world server.
            </p>
          )}

          {live.state === "ready" && entries.length === 0 && (
            <Reveal className="border-y border-line py-14">
              <p
                className="display-type uppercase text-paper/80"
                style={{ fontSize: "clamp(1.75rem, 4vw, 2.75rem)", lineHeight: 0.9 }}
              >
                The week has just started.
                <br />
                <span className="text-hunt">Be first.</span>
              </p>
            </Reveal>
          )}

          {live.state === "ready" && entries.length > 0 && (
            <ul>
              {entries.map((entry, index) => (
                <Row
                  key={entry.place}
                  entry={entry}
                  share={leader > 0 ? entry.kills / leader : 0}
                  delay={Math.min(index, 6) * 0.05}
                />
              ))}
            </ul>
          )}

          {prizes && (
            <p className="mt-6 max-w-[52ch] font-mono text-xs leading-relaxed text-paper/40">
              {prizes}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
