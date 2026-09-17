"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  claimChallenge,
  getQuestsToday,
  submitClaim,
  type ClaimView,
  type QuestKind,
  type QuestView,
} from "@/lib/api";
import { isUserRejection, sign } from "@/lib/nimiq";
import type { WorldMap } from "@/game/map";
import {
  chooseObjective,
  groundRange,
  metres,
  nearestSpot,
  trackable,
  worldSpots,
  type MarkerSpot,
} from "@/game/markers";
import Sheet, { SheetRow } from "./Sheet";
import type { ClaimsFeed } from "./useClaims";
import { explorer, localMoment, nim, shortHash, streakDay, utcDate, type Network } from "./format";

/**
 * The board at the Vettai office: what today asks of you, what it pays, and the one door
 * to the money. A quest that is done is claimed with a single signature; after that every
 * state the treasury can be in has a line of its own, because a payout that is quietly
 * waiting looks exactly like a payout that is lost.
 */

export type QuestBoardProps = {
  quests: QuestView[];
  claims: ClaimsFeed;
  network: Network | null;
  /** What one wallet may be paid in a day, as the world states it, or null when it will not. */
  dailyCapNim: string | null;
  reduced: boolean;
  /** The claim that just landed, so the row that earned it lights up. */
  celebrate: string | null;
  /** The city, for working out how far each job is from the door the player is standing at. */
  map: WorldMap | null;
  /** Where the player is standing. The body holds still while the board is up. */
  place: { x: number; z: number } | null;
  /** The job the player pinned, or null while the game is choosing for them. */
  tracked: string | null;
  onTrack: (questId: string | null) => void;
  onQuests: (quests: QuestView[]) => void;
  onLadder: () => void;
  onClose: () => void;
};

const NAMES: Record<QuestKind, string> = {
  hunt: "Hunt five drones",
  courier: "Run the courier route",
  landmarks: "Visit four landmarks",
  landlord: "Hold a stake for the day",
  streak: "Daily streak",
};

const ORDER: QuestKind[] = ["hunt", "courier", "landmarks", "landlord", "streak"];

const LUNA = 100_000;

/** The states the treasury has already committed money to. A hold was never granted. */
const GRANTED = new Set<ClaimView["state"]>(["queued", "sending", "sent", "paid"]);

/**
 * What is left of this wallet's day. The claims list is the same evidence the server
 * counts the cap from, so the board can say it without being told. A world that does not
 * publish its cap gets no line at all rather than a guess.
 */
function payableLeft(rows: ClaimView[], capNim: string | null, today: string): string | null {
  if (capNim === null) return null;
  const cap = Number(capNim);
  if (!Number.isFinite(cap) || cap <= 0) return null;

  const used = rows
    .filter((row) => row.createdAt.slice(0, 10) === today && GRANTED.has(row.state))
    .reduce((sum, row) => sum + Number(row.amountLuna), 0);

  return `Today: ${nim(Math.max(0, cap * LUNA - used))} of ${capNim} NIM still payable`;
}

type Busy = { questId: string; step: "signing" | "sending" };

function progressOf(quest: QuestView): { done: number; text: string } {
  if (quest.kind === "landmarks") {
    const reached = quest.visited?.filter(Boolean).length ?? quest.progress;
    return { done: reached, text: `${reached} of ${quest.target} reached` };
  }
  if (quest.kind === "hunt") {
    const down = Math.min(quest.progress, quest.target);
    return { done: down, text: `${down} of ${quest.target} drones down` };
  }
  if (quest.kind === "courier") {
    return {
      done: quest.progress,
      text: quest.carrying
        ? "Parcel in hand. Take it to the drop point"
        : "Pick the parcel up, then deliver it inside two minutes",
    };
  }
  if (quest.kind === "landlord") {
    return { done: quest.progress, text: "Waiting for the treasury's daily read of your stake" };
  }
  return { done: quest.progress, text: "Turning up is the whole job" };
}

export type Wayline = {
  /** The same sentence the objective line uses, so the board and the HUD never disagree. */
  sentence: string;
  /** Metres from where the player is standing, or null when the target is a live drone. */
  range: string | null;
  /** The courier's two ends, each with its own distance. */
  legs: { text: string; range: string | null }[];
};

/**
 * What a single job asks for, measured from the door the player is standing at. The
 * sentence comes from the same chooser the tracked objective uses, handed one quest.
 */
function waylineFor(
  quest: QuestView,
  map: WorldMap | null,
  place: { x: number; z: number } | null,
  spots: MarkerSpot[],
): Wayline | null {
  const objective = chooseObjective({ quests: [quest], pinned: quest.id, seenShop: true });
  if (!objective) return null;

  const rangeTo = (x: number, z: number) => (place ? metres(groundRange(place, { x, z })) : null);
  const spot = place ? nearestSpot(objective, spots, place) : null;

  const legs: Wayline["legs"] = [];
  if (quest.kind === "courier" && quest.route && map) {
    const from = map.courier[quest.route.from];
    const to = map.courier[quest.route.to];
    if (from) {
      legs.push({ text: `pick up at P${quest.route.from + 1}`, range: rangeTo(from.x, from.z) });
    }
    if (to) legs.push({ text: `drop at P${quest.route.to + 1}`, range: rangeTo(to.x, to.z) });
  }

  return {
    sentence: objective.sentence,
    range: spot && place ? metres(groundRange(place, spot)) : null,
    legs,
  };
}

/** Midnight UTC in the reader's own clock, which is when a capped claim is looked at again. */
function tomorrowLocal(): string {
  const now = new Date();
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return localMoment(new Date(midnight));
}

function heldLine(reason: string | null): string {
  if (reason === "pool") return "Pool exhausted, held for review";
  if (reason === "ip cap") {
    return `Held until tomorrow: too many wallets from this connection today. Looked at again after ${tomorrowLocal()}`;
  }
  return `Held until tomorrow: you reached today's cap. Looked at again after ${tomorrowLocal()}`;
}

export default function QuestBoard({
  quests,
  claims,
  network,
  dailyCapNim,
  reduced,
  celebrate,
  map,
  place,
  tracked,
  onTrack,
  onQuests,
  onLadder,
  onClose,
}: QuestBoardProps) {
  const [day, setDay] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [trouble, setTrouble] = useState<{ questId: string; text: string } | null>(null);
  const attempt = useRef(0);

  const reload = useCallback(async () => {
    const result = await getQuestsToday();
    if (!result.ok) return;
    setDay(result.data.day);
    onQuests(result.data.quests);
  }, [onQuests]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const cancel = useCallback(() => {
    // The wallet's own dialog cannot be closed from here, so a cancel is a promise this
    // page makes: whatever comes back is dropped and nothing is sent to the server.
    attempt.current += 1;
    setBusy(null);
    setTrouble(null);
  }, []);

  const claim = useCallback(
    async (quest: QuestView) => {
      attempt.current += 1;
      const mine = attempt.current;
      const alive = () => attempt.current === mine;

      setTrouble(null);
      setBusy({ questId: quest.id, step: "signing" });

      const challenge = await claimChallenge(quest.id);
      if (!alive()) return;
      if (!challenge.ok) {
        setBusy(null);
        setTrouble({ questId: quest.id, text: `${challenge.error} Nothing was sent.` });
        void reload();
        return;
      }

      let signed;
      try {
        signed = await sign(challenge.data.message);
      } catch (error) {
        if (!alive()) return;
        setBusy(null);
        setTrouble({
          questId: quest.id,
          // A claim is a signature, not a payment, and the claim only goes to the office
          // after this comes back. So the honest thing to say is that nothing was claimed,
          // rather than a promise about money that this line cannot make.
          text: isUserRejection(error)
            ? "Claim cancelled. Nothing was sent."
            : `${error instanceof Error ? error.message : "The wallet did not confirm."} No claim reached the office. Try it again.`,
        });
        return;
      }
      if (!alive()) return;

      setBusy({ questId: quest.id, step: "sending" });
      const posted = await submitClaim(quest.id, {
        message: challenge.data.message,
        publicKey: signed.publicKey,
        signature: signed.signature,
      });
      if (!alive()) return;
      setBusy(null);

      if (!posted.ok) {
        setTrouble({ questId: quest.id, text: posted.error });
      }
      await Promise.all([claims.refresh(), reload()]);
    },
    [claims, reload],
  );

  const sorted = [...quests].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  const spots = map ? worldSpots(map, quests) : [];
  const today = day ?? new Date().toISOString().slice(0, 10);
  const ready = sorted.filter(
    (quest) => quest.state === "done" && !claims.byQuest.has(quest.id) && quest.rewardLuna !== "0",
  );
  const readyLuna = ready.reduce((sum, quest) => sum + Number(quest.rewardLuna), 0);
  const capLine = payableLeft(claims.claims, dailyCapNim, today);

  return (
    <Sheet
      kicker="Vettai office"
      title="Today's jobs"
      meta={utcDate(today)}
      watermark="Board"
      reduced={reduced}
      onClose={onClose}
    >
      {capLine && (
        <p className="label-type pb-3 text-paper/40" data-testid="cap-line">
          {capLine}
        </p>
      )}

      {claims.error && (
        <p className="label-type pb-3 text-bad" data-testid="claims-error">
          {claims.error} The board keeps asking; your payouts are safe where they are.
        </p>
      )}

      <motion.div
        initial={{ opacity: 0, y: reduced ? 0 : 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={reduced ? { duration: 0 } : { duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
        className="flex items-end justify-between gap-4 border-b border-line pb-4"
      >
        {readyLuna > 0 ? (
          <p className="display-type text-[2rem] uppercase leading-none tracking-[-0.02em] text-hunt">
            {nim(readyLuna)} NIM ready
          </p>
        ) : (
          <p className="text-sm text-paper/50">Nothing ready to claim yet. The street is out there.</p>
        )}
        <span className="label-type shrink-0 pb-1 text-paper/35" data-testid="board-count">
          {sorted.length} jobs
        </span>
      </motion.div>

      <div className="flex items-center justify-between gap-3 pt-3">
        <span className="label-type text-paper/35">
          {tracked === null ? "Tracking the next job for you" : "Tracking your pick"}
        </span>
        {tracked !== null && (
          <button
            type="button"
            onClick={() => onTrack(null)}
            data-testid="track-auto"
            className="label-type rounded-btn border border-line px-3 py-1.5 text-paper/60 transition-colors duration-200 hover:border-hunt hover:text-paper"
          >
            Auto
          </button>
        )}
      </div>

      <ul>
        {sorted.map((quest, index) => (
          <SheetRow key={quest.id} index={index} reduced={reduced}>
            <Row
              quest={quest}
              wayline={waylineFor(quest, map, place, spots)}
              tracking={tracked === quest.id}
              onTrack={() => onTrack(tracked === quest.id ? null : quest.id)}
              claim={claims.byQuest.get(quest.id) ?? null}
              busy={busy?.questId === quest.id ? busy.step : null}
              trouble={trouble?.questId === quest.id ? trouble.text : null}
              streak={quest.kind === "streak" ? streakDay(claims.claims, today) : 0}
              network={network}
              reduced={reduced}
              celebrating={celebrate !== null && claims.byQuest.get(quest.id)?.id === celebrate}
              onClaim={() => void claim(quest)}
              onCancel={cancel}
            />
          </SheetRow>
        ))}
      </ul>

      <button
        type="button"
        onClick={onLadder}
        data-testid="open-ladder"
        className="group mt-5 flex w-full items-center justify-between gap-3 rounded-btn border border-line px-4 py-3 text-left text-sm text-paper/75 transition-colors duration-200 hover:border-hunt hover:text-paper"
      >
        <span>This week&#39;s hunters</span>
        <span aria-hidden className="transition-transform duration-300 group-hover:translate-x-1">
          &#8594;
        </span>
      </button>

      <p className="label-type mt-5 text-paper/30">
        Every payout carries the quest id in its memo, so the chain is the receipt.
      </p>
    </Sheet>
  );
}

type RowProps = {
  quest: QuestView;
  wayline: Wayline | null;
  tracking: boolean;
  onTrack: () => void;
  claim: ClaimView | null;
  busy: "signing" | "sending" | null;
  trouble: string | null;
  streak: number;
  network: Network | null;
  reduced: boolean;
  celebrating: boolean;
  onClaim: () => void;
  onCancel: () => void;
};

function Row({
  quest,
  wayline,
  tracking,
  onTrack,
  claim,
  busy,
  trouble,
  streak,
  network,
  reduced,
  celebrating,
  onClaim,
  onCancel,
}: RowProps) {
  const progress = progressOf(quest);
  const name = quest.kind === "streak" && streak > 0 ? `${NAMES.streak}, day ${streak}` : NAMES[quest.kind];
  const claimable = quest.state === "done" && !claim && quest.rewardLuna !== "0";
  /** An open job with nothing to say under it, so the row does not carry empty space. */
  const quiet = quest.state === "open" && !busy && !claim && trouble === null;

  return (
    <motion.div
      animate={{
        backgroundColor: celebrating ? "rgba(255,106,43,0.12)" : "rgba(255,106,43,0)",
      }}
      transition={{ duration: reduced ? 0 : 1.1, ease: "easeOut" }}
      className="relative border-b border-line py-4 pl-4"
      data-testid={`quest-${quest.kind}`}
    >
      <span
        aria-hidden
        className={`absolute left-0 top-4 h-8 w-[2px] ${claimable ? "bg-hunt" : "bg-paper/12"}`}
      />

      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[0.95rem] leading-snug text-paper">{name}</p>
          <p className="label-type mt-1.5 text-paper/45">{progress.text}</p>
        </div>
        <div className="shrink-0 text-right">
          <p className="display-type text-2xl leading-none text-hunt">{nim(quest.rewardLuna)}</p>
          <p className="label-type mt-1 text-paper/35">NIM</p>
        </div>
      </div>

      {quest.state === "open" && (
        <div aria-hidden className="mt-3 h-[2px] w-full bg-paper/10">
          <motion.div
            className="h-full bg-hunt/70"
            initial={{ scaleX: 0 }}
            animate={{ scaleX: Math.min(1, progress.done / Math.max(1, quest.target)) }}
            transition={{ duration: reduced ? 0 : 0.6, ease: "easeOut" }}
            style={{ originX: 0 }}
          />
        </div>
      )}

      {wayline && (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="display-type text-[1.05rem] uppercase leading-none tracking-[0.01em] text-paper">
            {wayline.sentence}
            {wayline.range && (
              <span className="ml-2 font-mono text-xs normal-case tracking-normal text-hunt">
                {wayline.range}
              </span>
            )}
          </p>
          {trackable(quest) && (
            <button
              type="button"
              onClick={onTrack}
              data-testid={`track-${quest.kind}`}
              className={`label-type ml-auto rounded-btn px-3 py-2 transition-colors duration-200 ${
                tracking
                  ? "bg-hunt text-night"
                  : "border border-line text-paper/60 hover:border-hunt hover:text-paper"
              }`}
            >
              {tracking ? "Tracking" : "Track"}
            </button>
          )}
        </div>
      )}

      {wayline && wayline.legs.length > 0 && (
        <p className="label-type mt-2 text-paper/45" data-testid={`legs-${quest.kind}`}>
          {wayline.legs
            .map((leg) => (leg.range === null ? leg.text : `${leg.text} ${leg.range}`))
            .join(", ")}
        </p>
      )}

      <div className={quiet ? "" : "mt-3"}>
        <State
          quest={quest}
          claim={claim}
          busy={busy}
          network={network}
          reduced={reduced}
          onClaim={onClaim}
          onCancel={onCancel}
        />
        {trouble && <p className="mt-2 text-sm text-bad">{trouble}</p>}
      </div>
    </motion.div>
  );
}

function State({
  quest,
  claim,
  busy,
  network,
  reduced,
  onClaim,
  onCancel,
}: Omit<RowProps, "trouble" | "streak" | "celebrating" | "wayline" | "tracking" | "onTrack">) {
  if (busy) {
    return (
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2.5">
          <span className="live-dot h-2 w-2 rounded-full bg-hunt" />
          <span className="text-sm text-paper/70">
            {busy === "signing" ? "Waiting for your signature" : "Sending the claim"}
          </span>
        </span>
        {busy === "signing" && (
          <button
            type="button"
            onClick={onCancel}
            className="label-type rounded-btn border border-line px-3 py-2 text-paper/55 transition-colors duration-200 hover:border-hunt hover:text-paper"
          >
            Cancel
          </button>
        )}
      </div>
    );
  }

  if (claim) {
    if (claim.state === "paid") {
      const link = claim.txHash ? explorer(network, claim.txHash) : null;
      return (
        <div className="rounded-btn border border-hunt/45 bg-hunt/10 px-3 py-2.5">
          <p className="text-sm text-paper">
            Paid {nim(claim.amountLuna)} NIM
            {claim.blockNumber !== null && `, block ${claim.blockNumber}`}
          </p>
          {claim.txHash && link && (
            <a
              href={link}
              target="_blank"
              rel="noreferrer"
              className="label-type mt-1 inline-block text-hunt underline decoration-hunt/40 underline-offset-4 transition-colors duration-200 hover:decoration-hunt"
            >
              {shortHash(claim.txHash)}
            </a>
          )}
          {claim.txHash && !link && (
            <p className="mt-1 font-mono text-[11px] text-paper/45" title={claim.txHash}>
              {shortHash(claim.txHash)}
            </p>
          )}
        </div>
      );
    }

    if (claim.state === "held") {
      return <p className="text-sm text-paper/70">{heldLine(claim.error)}</p>;
    }

    if (claim.state === "failed") {
      return (
        <p className="text-sm text-bad">
          That payout did not go through. Nothing was taken from you and the treasury keeps the
          record; ask in Skool and it is paid by hand.
        </p>
      );
    }

    return (
      <p className="flex items-center gap-2.5 text-sm text-paper/70">
        <span className="live-dot h-2 w-2 rounded-full bg-hunt" />
        {claim.state === "queued"
          ? "Paid soon, the treasury sends it within a minute"
          : "Sent. Waiting for the block"}
      </p>
    );
  }

  if (quest.state === "claimed") {
    return <p className="text-sm text-paper/55">Claimed. The payout is on its way.</p>;
  }

  if (quest.state === "done" && quest.rewardLuna === "0") {
    return (
      <p className="text-sm text-paper/70">
        Nothing left to pay today: this wallet has used its daily cap. It resets at midnight UTC.
      </p>
    );
  }

  if (quest.state === "done") {
    return (
      <motion.button
        type="button"
        onClick={onClaim}
        whileHover={reduced ? undefined : { scale: 1.015 }}
        whileTap={reduced ? undefined : { scale: 0.985 }}
        data-testid={`claim-${quest.kind}`}
        className="group flex w-full items-center justify-between gap-3 rounded-btn bg-hunt px-4 py-3 text-left font-medium text-night"
      >
        <span>Claim {nim(quest.rewardLuna)} NIM</span>
        <span aria-hidden className="transition-transform duration-300 group-hover:translate-x-1">
          &#8594;
        </span>
      </motion.button>
    );
  }

  // An open job says nothing here on purpose: the progress line and the rail above have
  // already said it, and three rows repeating one sentence reads as filler.
  return null;
}
