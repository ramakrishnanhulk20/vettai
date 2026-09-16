export type Payout = {
  to: string;
  nim: string;
  memo: string;
  block: string;
};

/**
 * Beat three. The receipt a payout leaves behind. /api/stats does not expose the last
 * paid claim today, so with no payout passed in the card shows a made-up one and says
 * so on its face. The only number here that came from the server is the settled count.
 */
const EXAMPLE: Payout = {
  to: "NQ07 8CT6 ...9F2K",
  nim: "0.5",
  memo: "vettai:9f3c1a20",
  block: "4 812 907",
};

type Props = {
  payout?: Payout | null;
  settled: string;
};

export default function PayoutReceipt({ payout = null, settled }: Props) {
  const shown = payout ?? EXAMPLE;
  const isExample = payout === null;

  return (
    <div className="relative w-full max-w-[22rem]">
      <div className="receipt-card relative -rotate-[1.6deg] bg-paper px-6 pb-12 pt-6 text-night shadow-[0_40px_80px_-40px_rgba(0,0,0,0.9)]">
        <div className="flex items-start justify-between">
          <span className="label-type text-night/50">Nimiq testnet</span>
          <span aria-hidden className="h-3 w-3 bg-hunt" />
        </div>

        <p className="display-type mt-4 leading-[0.85]" style={{ fontSize: "clamp(2.75rem, 7vw, 4rem)" }}>
          {shown.nim} NIM
        </p>

        <div className="mt-5 border-t border-dashed border-night/25 pt-4">
          {[
            ["To", shown.to],
            ["Memo", shown.memo],
            ["Block", shown.block],
          ].map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between gap-4 py-1.5">
              <span className="label-type text-night/45">{label}</span>
              <span
                className={`font-mono text-[0.8125rem] tabular-nums ${
                  label === "Memo" ? "text-hunt" : "text-night/85"
                }`}
              >
                {value}
              </span>
            </div>
          ))}
        </div>

        {isExample && (
          <span className="label-type absolute bottom-4 right-5 -rotate-[9deg] border border-night/30 px-2 py-1 text-night/40">
            Example
          </span>
        )}
      </div>

      <p className="mt-5 max-w-[24ch] text-sm text-paper/45">
        <span className="font-mono tabular-nums text-paper">{settled}</span> payouts have
        settled this way so far.
      </p>
    </div>
  );
}
