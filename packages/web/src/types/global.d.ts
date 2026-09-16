import type { NimiqProvider } from "@/lib/nimiq";

export {};

declare global {
  interface Window {
    /** Set by the Nimiq Pay WebView before any page script runs. */
    nimiq?: NimiqProvider;
    nimiqPay?: { language?: string; userFiat?: string };
  }
}
