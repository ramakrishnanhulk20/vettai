/** Beat one. A bounty drone inside a gun sight, drawn by hand so it carries the grain. */
export default function DroneArt() {
  return (
    <svg
      viewBox="0 0 420 280"
      className="h-full w-full"
      fill="none"
      role="img"
      aria-label="A bounty drone held inside a targeting reticle"
    >
      <g stroke="var(--hunt)" strokeWidth="1.5" opacity="0.9">
        <path d="M58 96V58h38M362 96V58h-38M58 184v38h38M362 184v38h-38" />
      </g>
      <g stroke="var(--hunt)" strokeWidth="1" opacity="0.45">
        <path d="M210 42v20M210 218v20M42 140h20M358 140h20" />
      </g>

      <g className="drone-float">
        <g stroke="var(--paper)" strokeWidth="1.6" strokeLinecap="round" opacity="0.85">
          <path d="M182 130 118 104M238 130 302 104M184 156 120 182M236 156 300 182" />
        </g>

        <path
          d="M178 126h64l12 15-12 17h-64l-12-17z"
          fill="#141a28"
          stroke="var(--paper)"
          strokeWidth="1.6"
        />
        <path d="M188 134h44" stroke="var(--paper)" strokeWidth="1" opacity="0.4" />

        <g fill="#141a28" stroke="var(--paper)" strokeWidth="1.4">
          <circle cx="118" cy="104" r="6" />
          <circle cx="302" cy="104" r="6" />
          <circle cx="120" cy="182" r="6" />
          <circle cx="300" cy="182" r="6" />
        </g>

        <g className="rotor" stroke="var(--paper)" strokeWidth="1.2" opacity="0.55">
          <ellipse cx="118" cy="104" rx="32" ry="5" />
          <ellipse cx="302" cy="104" rx="32" ry="5" />
          <ellipse cx="120" cy="182" rx="32" ry="5" />
          <ellipse cx="300" cy="182" rx="32" ry="5" />
        </g>

        <path
          d="M200 158h20l-4 14h-12z"
          fill="#141a28"
          stroke="var(--paper)"
          strokeWidth="1.4"
        />
        <circle cx="210" cy="176" r="7" fill="#141a28" stroke="var(--paper)" strokeWidth="1.4" />
        <circle cx="210" cy="176" r="2.6" fill="var(--hunt)" />

        <circle className="beacon" cx="210" cy="118" r="4.5" fill="var(--bad)" />
      </g>

      <g className="sight-scan" stroke="var(--hunt)" strokeWidth="1" opacity="0.5">
        <path d="M62 100h296" />
      </g>

      <circle cx="210" cy="140" r="62" stroke="var(--hunt)" strokeWidth="1" opacity="0.25" />
    </svg>
  );
}
