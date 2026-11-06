/** The curve of a dark planet whose rim catches the light, as on the website: cold on the way in, warm where someone answers. Decorative; the page places it. */
export function Horizon({ tone = "ice", className = "" }: { tone?: "ice" | "ember"; className?: string }) {
  const light = tone === "ice" ? "var(--brand-300)" : "var(--ember)";
  return (
    <div aria-hidden className={`pointer-events-none absolute left-1/2 -z-10 w-[max(190vw,1100px)] -translate-x-1/2 md:w-[150vw] xl:w-[1900px] ${className}`}>
      {/* The glow is a gradient: a box-shadow this large stops on a visible straight edge. */}
      <div className="absolute inset-x-[12%] bottom-full h-[min(46vw,420px)] translate-y-16" style={{ background: `radial-gradient(ellipse 50% 100% at 50% 100%, color-mix(in oklab, ${light} 16%, transparent), transparent)` }} />
      <div className="relative aspect-[2.4/1] rounded-[100%] bg-background" style={{ boxShadow: `0 -1px 0 0 color-mix(in oklab, ${light} 70%, transparent), 0 -24px 80px -12px color-mix(in oklab, ${light} 36%, transparent)` }} />
    </div>
  );
}
