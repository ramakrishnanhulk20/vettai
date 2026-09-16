"use client";

import { useEffect } from "react";

// Lenis smooths the whole window and keeps doing it while a dialog is open, so the
// page slides around behind the search box. Lenis skips any wheel event whose path
// carries data-lenis-prevent, so every dialog the docs UI portals into the body
// gets that attribute as it appears.
export default function ModalScrollLock() {
  useEffect(() => {
    const mark = (element: Element | null | undefined) => {
      element?.setAttribute("data-lenis-prevent", "");
    };

    const tag = (node: Element) => {
      if (node.matches("[role=dialog]")) mark(node.parentElement);
      if (node.querySelector("[role=dialog]")) mark(node);
    };

    for (const child of Array.from(document.body.children)) tag(child);

    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          if (node instanceof Element) tag(node);
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return null;
}
