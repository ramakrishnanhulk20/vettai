/**
 * Beat two. Phone to server to chain, with the shortcut a cheater would want crossed
 * out. The two solid lines draw themselves from --k, which GSAP writes while the
 * section is pinned, so the drawing costs nothing but a CSS variable.
 */

const drawn = { strokeDashoffset: "calc(1 - var(--k, 1))" } as const;
const appears = { opacity: "var(--k, 1)" } as const;

export default function CallChainArt() {
  return (
    <svg
      viewBox="0 0 480 300"
      className="h-full w-full"
      fill="none"
      role="img"
      aria-label="The phone sends an intent, the server decides, the chain pays"
    >
      <g stroke="var(--paper)" strokeWidth="1.5" opacity="0.85">
        <rect x="8" y="104" width="74" height="118" rx="10" fill="#141a28" />
        <path d="M8 124h74M8 202h74" opacity="0.3" />
        <rect x="196" y="112" width="100" height="102" rx="6" fill="#141a28" />
        <path d="M196 146h100M196 180h100" opacity="0.3" />
      </g>
      <circle cx="282" cy="128" r="3.5" fill="var(--hunt)" className="beacon" />

      <g stroke="var(--hunt)" strokeWidth="1.5" fill="#1b1008">
        <rect x="360" y="96" width="36" height="36" rx="4" />
        <rect x="394" y="132" width="36" height="36" rx="4" />
        <rect x="428" y="168" width="36" height="36" rx="4" />
      </g>

      <g stroke="var(--hunt)" strokeWidth="1.6" pathLength="1" strokeDasharray="1" style={drawn}>
        <path d="M88 162H190" />
        <path d="M302 164 388 152" />
      </g>
      <g fill="var(--hunt)" style={appears}>
        <path d="M190 158l8 4-8 4z" />
        <path d="M388 147l8 5-9 3z" />
      </g>

      <path
        d="M46 234C130 300 320 300 420 228"
        fill="none"
        stroke="var(--bad)"
        strokeWidth="1.4"
        strokeDasharray="5 6"
        opacity="0.5"
      />
      <g stroke="var(--bad)" strokeWidth="2" opacity="0.9">
        <path d="M219 275l16 16M235 275l-16 16" />
      </g>

      <g fontFamily="var(--font-mono)" fontSize="9" letterSpacing="1.8">
        <g fill="var(--paper)" opacity="0.45">
          <text x="8" y="244">PHONE</text>
          <text x="196" y="244">SERVER</text>
        </g>
        <text x="360" y="244" fill="var(--hunt)" opacity="0.8">
          CHAIN
        </text>
        <g fill="var(--paper)" opacity="0.7" style={appears}>
          <text x="96" y="150">INTENT</text>
          <text x="308" y="140">PAYOUT</text>
        </g>
        <text x="250" y="288" fill="var(--bad)" fontSize="8.5" letterSpacing="1.4" opacity="0.75">
          A SCORE THE PHONE MADE UP
        </text>
      </g>
    </svg>
  );
}
