/** The mark: an open c drawn as a cold line that ends on a warm bead. */
export function LogoMark({ id = "mark", className = "size-7" }: { id?: string; className?: string }) {
  const gradient = `coldlyne-${id}`;
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={`shrink-0 ${className}`}>
      <defs>
        <linearGradient id={gradient} gradientUnits="userSpaceOnUse" x1={9} y1={24} x2={23} y2={8}>
          <stop offset="0" style={{ stopColor: "var(--mark-from)" }} />
          <stop offset="1" style={{ stopColor: "var(--mark-to)" }} />
        </linearGradient>
      </defs>
      <path d="M22.4 21.4A8.6 8.6 0 1 1 22.4 10.6" fill="none" stroke={`url(#${gradient})`} strokeWidth={3.2} strokeLinecap="round" />
      <circle cx={22.4} cy={10.6} r={2.7} className="fill-ember" />
    </svg>
  );
}

/** Mark and wordmark: "coldlyne" in lowercase Geist, tight. */
export function Logo({ id }: { id?: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <LogoMark id={id} />
      <span className="truncate font-heading text-[1.1rem] font-semibold tracking-[-0.045em]">coldlyne</span>
    </span>
  );
}
