"use client";

import { useEffect, useState } from "react";
import { getLadder, getStats, type Ladder, type Stats } from "./data";

export type Live<T> =
  | { state: "loading" }
  | { state: "offline" }
  | { state: "ready"; data: T };

function useFeed<T>(load: (signal: AbortSignal) => Promise<T>): Live<T> {
  const [live, setLive] = useState<Live<T>>({ state: "loading" });

  useEffect(() => {
    const abort = new AbortController();

    load(abort.signal)
      .then((data) => {
        if (abort.signal.aborted) return;
        setLive({ state: "ready", data });
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return;
        console.error(error);
        setLive({ state: "offline" });
      });

    return () => abort.abort();
    // The loaders are module functions, so this runs once per mounted section.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return live;
}

export function useStats(): Live<Stats> {
  return useFeed(() => getStats());
}

export function useLadder(): Live<Ladder> {
  return useFeed((signal) => getLadder(signal));
}

/** The deep link only works against the host the page is actually served from. */
export function useDeepLink(): string {
  const [host, setHost] = useState("");
  useEffect(() => setHost(window.location.host), []);
  return host ? `https://nimpay.app/miniapps/open/${host}/play` : "/play";
}

/** What a counter shows while the server has not answered yet, or cannot. */
export function reading<T>(live: Live<T>, value: (data: T) => string): string {
  if (live.state === "loading") return "...";
  if (live.state === "offline") return "offline";
  return value(live.data);
}
