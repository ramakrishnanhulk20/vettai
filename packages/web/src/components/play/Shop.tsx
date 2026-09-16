"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  createShopOrder,
  getMe,
  getShop,
  getShopOrder,
  type Gear,
  type ShopItem,
  type ShopOrder,
} from "@/lib/api";
import { isUserRejection, sendWithData } from "@/lib/nimiq";
import Sheet, { SheetRow } from "./Sheet";
import { explorer, nim, shortHash, type Network } from "./format";

/**
 * The shop, paid with a real NIM transaction carrying the order's memo. Nothing here
 * grants anything: the treasury watches the chain, matches the memo, and the world hands
 * the gear over on its own sweep. This screen only says truthfully where the payment is.
 */

export type ShopProps = {
  gear: Gear;
  network: Network | null;
  reduced: boolean;
  onClose: () => void;
};

const WHAT_IT_DOES: Record<string, string> = {
  "blaster-mk2": "Fires 6 shots a second instead of 4",
  sprint: "Run at 7 m/s instead of 6",
  "skin-neon": "A neon coat for your hunter",
  "skin-carbon": "A carbon black coat for your hunter",
  "skin-sand": "A desert sand coat for your hunter",
};

const POLL_MS = 3000;

type Buy =
  | { item: string; step: "opening" }
  | { item: string; step: "confirm"; order: ShopOrder }
  | { item: string; step: "wallet"; order: ShopOrder }
  | { item: string; step: "sent"; order: ShopOrder; hash: string; state: "pending" | "paid" | "expired" }
  | { item: string; step: "stopped"; text: string };

function owns(item: ShopItem, gear: Gear): boolean {
  const wanted = item.gear as Record<string, unknown>;
  const worn = gear as unknown as Record<string, unknown>;
  const keys = Object.keys(wanted);
  return keys.length > 0 && keys.every((key) => worn[key] === wanted[key]);
}

export default function Shop({ gear, network, reduced, onClose }: ShopProps) {
  const [items, setItems] = useState<ShopItem[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [worn, setWorn] = useState<Gear>(gear);
  const [buy, setBuy] = useState<Buy | null>(null);
  const attempt = useRef(0);

  useEffect(() => setWorn(gear), [gear]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [shop, me] = await Promise.all([getShop(), getMe()]);
      if (!alive) return;
      if (!shop.ok) {
        setFailed(`${shop.error} Close this and open the shop again.`);
        return;
      }
      setItems(shop.data.items);
      if (me.ok) setWorn(me.data.gear);
    })();
    return () => {
      alive = false;
    };
  }, []);

  // A payment is only really paid when the treasury has seen it in a block, so the order
  // is asked about until it says so or until its half hour runs out.
  useEffect(() => {
    if (!buy || buy.step !== "sent" || buy.state !== "pending") return;
    const order = buy.order;

    const timer = setInterval(() => {
      void (async () => {
        const result = await getShopOrder(order.orderId);
        if (!result.ok) return;
        setBuy((live) =>
          live && live.step === "sent" && live.order.orderId === order.orderId
            ? { ...live, state: result.data.state }
            : live,
        );
        if (result.data.state === "paid") {
          const me = await getMe();
          if (me.ok) setWorn(me.data.gear);
        }
      })();
    }, POLL_MS);

    return () => clearInterval(timer);
  }, [buy]);

  const open = useCallback(async (item: ShopItem) => {
    attempt.current += 1;
    const mine = attempt.current;

    setBuy({ item: item.id, step: "opening" });
    const order = await createShopOrder(item.id);
    if (attempt.current !== mine) return;

    if (!order.ok) {
      setBuy({ item: item.id, step: "stopped", text: `${order.error} Nothing was sent.` });
      return;
    }
    setBuy({ item: item.id, step: "confirm", order: order.data });
  }, []);

  const pay = useCallback(
    async (item: string, order: ShopOrder) => {
      attempt.current += 1;
      const mine = attempt.current;

      setBuy({ item, step: "wallet", order });
      try {
        const hash = await sendWithData(order.to, Number(order.luna), order.memo);
        if (attempt.current !== mine) return;
        setBuy({ item, step: "sent", order, hash, state: "pending" });
      } catch (error) {
        if (attempt.current !== mine) return;
        setBuy({
          item,
          step: "stopped",
          text: isUserRejection(error)
            ? "Payment cancelled. Nothing was sent."
            : `${error instanceof Error ? error.message : "The wallet did not answer."} Nothing was sent.`,
        });
      }
    },
    [],
  );

  const clear = useCallback(() => {
    attempt.current += 1;
    setBuy(null);
  }, []);

  return (
    <Sheet
      kicker="Vettai shop"
      title="Better kit"
      meta="Paid in NIM, straight from your wallet"
      watermark="Shop"
      reduced={reduced}
      onClose={onClose}
    >
      {failed && <p className="py-6 text-sm text-bad">{failed}</p>}
      {!items && !failed && <p className="py-6 text-sm text-paper/50">Opening the cabinet</p>}

      <ul>
        {(items ?? []).map((item, index) => (
          <SheetRow key={item.id} index={index} reduced={reduced}>
            <div className="relative border-b border-line py-4 pl-4" data-testid={`shop-${item.id}`}>
              <span
                aria-hidden
                className={`absolute left-0 top-4 h-8 w-[2px] ${
                  owns(item, worn) ? "bg-hunt" : "bg-paper/12"
                }`}
              />
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-[0.95rem] leading-snug text-paper">{item.name}</p>
                  <p className="label-type mt-1.5 text-paper/45">{WHAT_IT_DOES[item.id] ?? ""}</p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="display-type text-2xl leading-none text-hunt">{nim(item.priceLuna)}</p>
                  <p className="label-type mt-1 text-paper/35">NIM</p>
                </div>
              </div>

              <div className="mt-3">
                {owns(item, worn) ? (
                  <p className="text-sm text-hunt">Equipped</p>
                ) : buy && buy.item === item.id ? (
                  <Progress
                    buy={buy}
                    network={network}
                    onPay={() => (buy.step === "confirm" ? void pay(item.id, buy.order) : undefined)}
                    onClear={clear}
                  />
                ) : (
                  <motion.button
                    type="button"
                    onClick={() => void open(item)}
                    whileHover={reduced ? undefined : { scale: 1.015 }}
                    whileTap={reduced ? undefined : { scale: 0.985 }}
                    data-testid={`buy-${item.id}`}
                    className="group flex w-full items-center justify-between gap-3 rounded-btn border border-hunt px-4 py-3 text-left font-medium text-hunt transition-colors duration-200 hover:bg-hunt hover:text-night"
                  >
                    <span>Buy for {nim(item.priceLuna)} NIM</span>
                    <span
                      aria-hidden
                      className="transition-transform duration-300 group-hover:translate-x-1"
                    >
                      &#8594;
                    </span>
                  </motion.button>
                )}
              </div>
            </div>
          </SheetRow>
        ))}
      </ul>

      <p className="label-type mt-5 text-paper/30">
        The memo is what ties your payment to this order. The treasury reads it off the chain.
      </p>
    </Sheet>
  );
}

function Progress({
  buy,
  network,
  onPay,
  onClear,
}: {
  buy: Buy;
  network: Network | null;
  onPay: () => void;
  onClear: () => void;
}) {
  if (buy.step === "opening") {
    return <Waiting text="Opening the order" />;
  }

  if (buy.step === "stopped") {
    return (
      <div>
        <p className="text-sm text-bad">{buy.text}</p>
        <button
          type="button"
          onClick={onClear}
          className="label-type mt-2 rounded-btn border border-line px-3 py-2 text-paper/55 transition-colors duration-200 hover:border-hunt hover:text-paper"
        >
          Back
        </button>
      </div>
    );
  }

  if (buy.step === "confirm") {
    return (
      <div className="rounded-btn border border-line bg-paper/[0.03] px-3 py-3">
        <p className="label-type text-paper/40">Nimiq Pay will show</p>
        <dl className="mt-2 space-y-1.5 text-[13px]">
          <Line term="Recipient" value={buy.order.to} mono />
          <Line term="Amount" value={`${nim(buy.order.luna)} NIM`} />
          <Line term="Message" value={buy.order.memo} mono />
        </dl>
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={onPay}
            data-testid="pay-now"
            className="flex-1 rounded-btn bg-hunt px-4 py-2.5 font-medium text-night transition-transform duration-300 hover:scale-[1.02] active:scale-[0.99]"
          >
            Pay in Nimiq Pay
          </button>
          <button
            type="button"
            onClick={onClear}
            className="label-type rounded-btn border border-line px-3 py-2.5 text-paper/55 transition-colors duration-200 hover:border-hunt hover:text-paper"
          >
            Not now
          </button>
        </div>
      </div>
    );
  }

  if (buy.step === "wallet") {
    return <Waiting text="Confirm the payment in Nimiq Pay" />;
  }

  if (buy.state === "paid") {
    return <p className="text-sm text-hunt">Paid. Equipped.</p>;
  }

  if (buy.state === "expired") {
    return (
      <div>
        <p className="text-sm text-paper/70">
          This order ran out of time. If your payment did reach the chain, the treasury has the
          record; start a new order and it will not be charged twice.
        </p>
        <button
          type="button"
          onClick={onClear}
          className="label-type mt-2 rounded-btn border border-line px-3 py-2 text-paper/55 transition-colors duration-200 hover:border-hunt hover:text-paper"
        >
          Back
        </button>
      </div>
    );
  }

  const link = explorer(network, buy.hash);
  return (
    <div>
      <Waiting text="Sent. Waiting for the block" />
      {link ? (
        <a
          href={link}
          target="_blank"
          rel="noreferrer"
          className="label-type mt-2 inline-block text-hunt underline decoration-hunt/40 underline-offset-4 transition-colors duration-200 hover:decoration-hunt"
        >
          {shortHash(buy.hash)}
        </a>
      ) : (
        <p className="mt-2 font-mono text-[11px] text-paper/45" title={buy.hash}>
          {shortHash(buy.hash)}
        </p>
      )}
    </div>
  );
}

function Waiting({ text }: { text: string }) {
  return (
    <p className="flex items-center gap-2.5 text-sm text-paper/70">
      <span className="live-dot h-2 w-2 rounded-full bg-hunt" />
      {text}
    </p>
  );
}

function Line({ term, value, mono }: { term: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="label-type shrink-0 text-paper/35">{term}</dt>
      <dd className={`text-right break-all text-paper/85 ${mono ? "font-mono text-[11px]" : ""}`}>
        {value}
      </dd>
    </div>
  );
}
