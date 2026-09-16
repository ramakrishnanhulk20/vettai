"use client";

import { useState } from "react";
import { AnimatePresence, motion, useMotionValueEvent, useScroll, useReducedMotion } from "framer-motion";
import { useDeepLink } from "./useLive";

const LINKS = [
  ["How", "#how"],
  ["Ladder", "#ladder"],
  ["Docs", "/docs"],
  ["GitHub", "https://github.com/ramakrishnanhulk20/vettai"],
];

export default function SiteNav() {
  const { scrollY } = useScroll();
  const [shown, setShown] = useState(false);
  const reduced = useReducedMotion();
  const openInPay = useDeepLink();

  // The bar belongs to the page below the poster, so it waits until the poster is gone.
  useMotionValueEvent(scrollY, "change", (y) => {
    const past = y > window.innerHeight * 0.85;
    setShown((was) => (was === past ? was : past));
  });

  return (
    <AnimatePresence>
      {shown && (
        <motion.header
          initial={{ y: -72, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -72, opacity: 0 }}
          transition={reduced ? { duration: 0 } : { duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          className="nav-blur fixed inset-x-0 top-0 z-40 border-b border-line bg-night/75"
        >
          <div className="flex items-center justify-between gap-6 px-6 py-3.5 md:px-12">
            <a href="#top" className="group flex items-center gap-3">
              <span
                aria-hidden
                className="h-3 w-3 shrink-0 bg-hunt transition-transform duration-300 group-hover:rotate-45"
              />
              <span
                className="display-type uppercase leading-none text-paper"
                style={{ fontSize: "1.375rem", letterSpacing: "-0.01em" }}
              >
                Vettai
              </span>
            </a>

            <nav className="hidden items-center gap-8 md:flex">
              {LINKS.map(([label, href]) => (
                <a
                  key={href}
                  href={href}
                  {...(href.startsWith("http") ? { target: "_blank", rel: "noreferrer" } : {})}
                  className="group relative label-type text-paper/55 transition-colors duration-300 hover:text-paper"
                >
                  {label}
                  <span
                    aria-hidden
                    className="absolute -bottom-1.5 left-0 right-0 h-px origin-left scale-x-0 bg-hunt transition-transform duration-300 group-hover:scale-x-100"
                  />
                </a>
              ))}
            </nav>

            <a
              href={openInPay}
              className="group inline-flex shrink-0 items-center gap-2 rounded-[8px] bg-hunt px-4 py-2.5 text-[0.8125rem] font-semibold text-night transition-[transform,background-color] duration-300 hover:-translate-y-0.5 hover:bg-[#ff8146] md:px-5"
            >
              Open in Nimiq Pay
              <span
                aria-hidden
                className="transition-transform duration-300 group-hover:translate-x-1"
              >
                &rarr;
              </span>
            </a>
          </div>
        </motion.header>
      )}
    </AnimatePresence>
  );
}
