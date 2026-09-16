"use client";

import { useEffect, useState } from "react";
import { getLadderWeek, type LadderWeek } from "@/lib/api";
import Sheet, { SheetRow } from "./Sheet";
import { localMoment, weekEnds } from "./format";

/**
 * The week's hunters, ranked by kills the server itself counted. The prize split comes
 * from the same place the treasury reads it, so nothing on this screen is a promise the
 * payout code would not keep.
 */

export type LadderProps = {
  address: string;
  reduced: boolean;
  onClose: () => void;
};

/** The server shortens addresses before it sends them, so a row is matched the same way. */
function shortAddress(address: string): string {
  const stripped = address.replace(/\s+/g, "").toUpperCase();
  return `${stripped.slice(0, 8)}...${stripped.slice(-4)}`;
}

export default function Ladder({ address, reduced, onClose }: LadderProps) {
  const [week, setWeek] = useState<LadderWeek | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void getLadderWeek().then((result) => {
      if (!alive) return;
      if (result.ok) setWeek(result.data);
      else setFailed(`${result.error} Close this and open it again.`);
    });
    return () => {
      alive = false;
    };
  }, []);

  const mine = shortAddress(address);
  const ends = week ? weekEnds(week.week) : null;

  return (
    <Sheet
      kicker="Weekly ladder"
      title="This week's hunters"
      meta={ends ? `Closes ${localMoment(ends)} your time` : "Monday to Sunday, UTC"}
      watermark="Week"
      reduced={reduced}
      onClose={onClose}
    >
      {failed && <p className="py-6 text-sm text-bad">{failed}</p>}
      {!week && !failed && <p className="py-6 text-sm text-paper/50">Counting the week</p>}

      {week && (
        <>
          <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2 border-b border-line pb-4">
            {week.prizesNim.map((prize, index) => (
              <span key={prize + String(index)} className="flex items-baseline gap-1.5">
                <span className="label-type text-paper/35">{["1st", "2nd", "3rd"][index]}</span>
                <span className="display-type text-xl leading-none text-hunt">{prize}</span>
                <span className="label-type text-paper/35">NIM</span>
              </span>
            ))}
          </div>

          {week.entries.length === 0 ? (
            <p className="py-6 text-sm text-paper/60">
              Nobody has downed a drone this week. The first name on this list could be yours.
            </p>
          ) : (
            <ul data-testid="ladder-rows">
              {week.entries.map((entry, index) => {
                const yours = entry.address === mine;
                return (
                  <SheetRow key={entry.address + String(entry.place)} index={index} reduced={reduced}>
                    <div
                      className={`flex items-center gap-4 border-b border-line py-3 pl-3 ${
                        yours ? "bg-hunt/10" : ""
                      }`}
                    >
                      <span
                        aria-hidden
                        className={`w-[2px] self-stretch ${yours ? "bg-hunt" : "bg-paper/12"}`}
                      />
                      <span
                        className={`display-type w-8 shrink-0 text-2xl leading-none ${
                          entry.place <= 3 ? "text-hunt" : "text-paper/35"
                        }`}
                      >
                        {entry.place}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-paper/80">
                        {entry.address}
                      </span>
                      {yours && <span className="label-type shrink-0 text-hunt">You</span>}
                      <span className="shrink-0 text-right">
                        <span className="font-mono text-sm text-paper">{entry.kills}</span>
                        <span className="label-type ml-1.5 text-paper/35">
                          {entry.kills === 1 ? "kill" : "kills"}
                        </span>
                      </span>
                    </div>
                  </SheetRow>
                );
              })}
            </ul>
          )}

          <p className="label-type mt-5 text-paper/30">
            Kills are counted by the world server. The treasury pays the top three once the week
            closes.
          </p>
        </>
      )}
    </Sheet>
  );
}
