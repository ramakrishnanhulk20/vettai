import Link from "next/link";

const paths = [
  {
    href: "/docs/start/getting-started",
    label: "Getting started",
    note: "Open Vettai inside Nimiq Pay, sign once, take the first quest.",
  },
  {
    href: "/docs/start/how-it-works",
    label: "How it works",
    note: "The loop, and why the server decides what happened.",
  },
  {
    href: "/docs/playing/claiming",
    label: "Claiming",
    note: "Sign, queue, pay. What a hold means and when it lifts.",
  },
  {
    href: "/docs/under-the-hood/api",
    label: "API reference",
    note: "Every route, its auth, its body and its answer.",
  },
  {
    href: "/docs/trust/proof",
    label: "The prove-it run",
    note: "Twelve checks against the live testnet, and the last output.",
  },
];

export default function StartHere() {
  return (
    <nav className="docs-paths not-prose">
      {paths.map((path, index) => (
        <Link key={path.href} href={path.href} className="docs-path">
          <small>{String(index + 1).padStart(2, "0")}</small>
          <span>
            <b>{path.label}</b>
            <em>{path.note}</em>
          </span>
          <i aria-hidden>&rarr;</i>
        </Link>
      ))}
    </nav>
  );
}
