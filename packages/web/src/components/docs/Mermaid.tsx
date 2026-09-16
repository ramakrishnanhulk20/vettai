"use client";

import { useEffect, useId, useState } from "react";

const THEME = {
  fontFamily: "var(--docs-body)",
  fontSize: "17px",
  primaryColor: "#151c2c",
  primaryTextColor: "#f3efe7",
  primaryBorderColor: "#ff6a2b",
  lineColor: "#ff6a2b",
  edgeLabelBackground: "#0b0f1a",
  tertiaryTextColor: "#f3efe7",
  secondaryColor: "#111728",
  tertiaryColor: "#0b0f1a",
  background: "#0b0f1a",
  mainBkg: "#151c2c",
  nodeBorder: "#ff6a2b",
  clusterBkg: "rgba(243, 239, 231, 0.04)",
  clusterBorder: "rgba(243, 239, 231, 0.18)",
  actorBkg: "#151c2c",
  actorBorder: "#ff6a2b",
  actorTextColor: "#f3efe7",
  signalColor: "#f3efe7",
  signalTextColor: "#f3efe7",
  labelBoxBkgColor: "#151c2c",
  labelBoxBorderColor: "#ff6a2b",
  labelTextColor: "#f3efe7",
  noteBkgColor: "rgba(255, 106, 43, 0.12)",
  noteBorderColor: "#ff6a2b",
  noteTextColor: "#f3efe7",
};

// Mermaid keeps one global config and one hidden measuring element, so two diagrams
// drawing at the same moment can read each other's layout. They queue instead.
let queue: Promise<unknown> = Promise.resolve();

function draw(id: string, source: string) {
  const next = queue.then(async () => {
    const { default: mermaid } = await import("mermaid");

    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "dark",
      fontFamily: "var(--docs-body)",
      themeVariables: THEME,
      // Natural size, never squeezed to the column: a shrunk diagram turns its
      // labels into 9px mush. The frame scrolls sideways when one is too wide.
      flowchart: { useMaxWidth: false },
      sequence: {
        useMaxWidth: false,
        actorFontSize: 15,
        noteFontSize: 14,
        messageFontSize: 14,
      },
    });

    const { svg } = await mermaid.render(id, source);
    return svg;
  });

  queue = next.catch(() => undefined);
  return next;
}

export function Mermaid({ chart }: { chart: string }) {
  const id = `vettai-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  // Mermaid measures rendered text to lay a diagram out, so it only runs in the
  // browser. The frame is server-rendered, so the page does not jump when the
  // drawing arrives.
  useEffect(() => {
    let live = true;

    draw(id, chart)
      .then((drawn) => live && setSvg(drawn))
      .catch(() => live && setFailed(true));

    return () => {
      live = false;
    };
  }, [chart, id]);

  return (
    <figure className="docs-diagram" data-drawn={svg ? "1" : "0"}>
      {svg ? (
        <div className="docs-diagram-svg" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <pre className="docs-diagram-fallback">{failed ? chart : null}</pre>
      )}
    </figure>
  );
}
