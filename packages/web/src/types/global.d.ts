export {};

declare global {
  interface Window {
    /** Set by the Nimiq Pay WebView before any page script runs. */
    nimiq?: unknown;
    nimiqPay?: unknown;
  }
}
