/**
 * The Nimiq Pay wallet, as this game uses it.
 *
 * The mini app SDK is not imported: the spike proved a CDN module import dies inside the
 * Pay WebView and takes the page with it, so the handful of calls Vettai makes are typed
 * and written out here against the provider Pay injects on `window`.
 */

export type SignatureResult = { publicKey: string; signature: string };

export type ErrorResponse = { error?: { type?: string; message?: string } };

export type SendTransaction = {
  recipient: string;
  value: number;
  data?: string;
  fee?: number;
  validityStartHeight?: number;
};

export type NimiqProvider = {
  listAccounts(): Promise<string[] | ErrorResponse>;
  sign(message: string | { message: string; isHex?: boolean }): Promise<SignatureResult | ErrorResponse>;
  isConsensusEstablished(): Promise<boolean | ErrorResponse>;
  getBlockNumber(): Promise<number | ErrorResponse>;
  sendBasicTransactionWithData(tx: SendTransaction): Promise<string | ErrorResponse>;
};

const POLL_MS = 60;

/** The two addresses Pay hands back. The first is the one the player sees in the wallet. */
export type WalletAccounts = { visible: string; remote: string | null };

/**
 * Waits for Nimiq Pay to hand the page its wallet. Pay injects the provider before page
 * scripts on a warm start and a second or two late on a cold one, so this polls rather
 * than reading `window.nimiq` once.
 */
export function waitForProvider(timeoutMs: number): Promise<NimiqProvider> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const look = () => {
      if (typeof window !== "undefined" && window.nimiq) return resolve(window.nimiq);
      if (Date.now() - started > timeoutMs) {
        return reject(new Error("Nimiq Pay did not hand this page a wallet."));
      }
      setTimeout(look, POLL_MS);
    };
    look();
  });
}

/** True when the page is running inside Nimiq Pay, which seeds this before our scripts. */
export function isInsidePay(): boolean {
  return typeof window !== "undefined" && (window.nimiqPay !== undefined || window.nimiq !== undefined);
}

/**
 * The provider can fail two ways: it throws, or it resolves an object carrying an error.
 * Both have to leave here as a throw, or a refusal reads as a success.
 */
export function unwrap<T>(value: T | ErrorResponse): T {
  if (typeof value === "object" && value !== null && "error" in value) {
    const payload = (value as ErrorResponse).error;
    throw new Error(`${payload?.type ?? "Error"}: ${payload?.message ?? "the wallet refused"}`);
  }
  return value as T;
}

function wallet(): NimiqProvider {
  if (typeof window === "undefined" || !window.nimiq) {
    throw new Error("Nimiq Pay did not hand this page a wallet.");
  }
  return window.nimiq;
}

export async function listAccounts(): Promise<WalletAccounts> {
  const accounts = unwrap<string[]>(await wallet().listAccounts());
  const visible = accounts[0];
  if (!visible) throw new Error("This wallet has no address yet.");
  return { visible, remote: accounts[1] ?? null };
}

/** One native dialog. The message goes in as a plain string, hex comes back. */
export async function sign(message: string): Promise<SignatureResult> {
  return unwrap<SignatureResult>(await wallet().sign(message));
}

/** A NIM payment with a memo. `luna` is an integer: 1 NIM is 100,000 luna. */
export async function sendWithData(to: string, luna: number, memo: string): Promise<string> {
  return unwrap<string>(
    await wallet().sendBasicTransactionWithData({ recipient: to, value: luna, data: memo }),
  );
}

type MaybeError = {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  error?: { type?: unknown; message?: unknown };
};

/**
 * A tap on Cancel in the native dialog. The phone throws a plain
 * Error("User rejected the request."), proven on Ram's iPhone, so the message is the only
 * thing to go on; the EIP-1193 code is matched too when a build sends one.
 *
 * The test is deliberately narrow. Anything matched here is told the player that nothing
 * was sent, and a wallet that times out or drops the page while a transaction is in flight
 * says words like "cancelled" too. Getting that wrong tells somebody their money is safe
 * when it may already be on the chain, so only a plain refusal counts.
 */
export function isUserRejection(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const shape = error as MaybeError;
  if (shape.code === 4001) return true;
  const words = [shape.name, shape.message, shape.error?.type, shape.error?.message]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  return /reject|denied/i.test(words);
}
