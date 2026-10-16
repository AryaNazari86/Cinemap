/**
 * An endless, slowly drifting row. The items are rendered twice; when the scroll position
 * passes the first copy it jumps back by exactly one copy's width, which looks seamless.
 * People can still scroll it by hand. It pauses on hover, keyboard focus, the pause button,
 * when it's off screen, and doesn't move at all with reduced motion.
 */
const SPEED_PX_PER_S = 28;
const RESUME_AFTER_MS = 2500;

export class Carousel {
  private paused = false; // the person pressed pause
  private holds = new Set<string>(); // temporary reasons to stand still
  private last = 0;
  private resumeTimer = 0;
  private pos: number | null = null; // sub-pixel position while drifting, since scrollLeft rounds
  private stopped = false;
  private readonly visibility: IntersectionObserver;

  constructor(
    private readonly track: HTMLElement,
    private readonly toggle: HTMLButtonElement,
    /** What the pause button names, e.g. "Pause the recommendations". */
    private readonly name = "carousel",
  ) {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) this.setPaused(true);

    toggle.addEventListener("click", () => this.setPaused(!this.paused));
    track.addEventListener("pointerenter", () => this.holds.add("hover"));
    track.addEventListener("pointerleave", () => this.holds.delete("hover"));
    track.addEventListener("focusin", () => this.holds.add("focus"));
    track.addEventListener("focusout", () => this.holds.delete("focus"));
    // Hand scrolling (wheel, trackpad, touch) takes over for a moment, then the drift resumes.
    for (const type of ["wheel", "touchstart", "pointerdown"]) {
      track.addEventListener(type, () => this.holdBriefly(), { passive: true });
    }
    track.addEventListener("scroll", () => this.wrap(), { passive: true });
    this.visibility = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) this.holds.delete("offscreen");
      else this.holds.add("offscreen");
    });
    this.visibility.observe(track);

    requestAnimationFrame((t) => this.tick(t));
  }

  /** For a row that's being replaced: end the drift loop for good. */
  stop() {
    this.stopped = true;
    this.visibility.disconnect();
  }

  /** Width of one copy of the items: where the second copy starts. */
  private get loopWidth(): number {
    const clone = this.track.querySelector<HTMLElement>("[data-clone]");
    return clone ? clone.offsetLeft - (this.track.firstElementChild as HTMLElement).offsetLeft : 0;
  }

  private tick(now: number) {
    if (this.stopped) return;
    const dt = this.last ? Math.min(now - this.last, 100) : 0;
    this.last = now;
    if (!this.paused && this.holds.size === 0 && this.loopWidth > 0) {
      this.pos = (this.pos ?? this.track.scrollLeft) + (SPEED_PX_PER_S * dt) / 1000;
      this.track.scrollLeft = this.pos;
      this.wrap();
    } else {
      this.pos = null;
    }
    requestAnimationFrame((t) => this.tick(t));
  }

  /**
   * Keep the position within one copy's width, in both directions. Never resting at 0
   * means scrolling left from the start still moves, onto the matching copy.
   */
  private wrap() {
    const width = this.loopWidth;
    if (width <= 0) return;
    let x = this.pos ?? this.track.scrollLeft;
    if (x >= width + 1) x -= width;
    else if (x < 1) x += width;
    else return;
    this.track.scrollLeft = x;
    if (this.pos !== null) this.pos = x;
  }

  private holdBriefly() {
    this.holds.add("manual");
    clearTimeout(this.resumeTimer);
    this.resumeTimer = window.setTimeout(() => this.holds.delete("manual"), RESUME_AFTER_MS);
  }

  private setPaused(paused: boolean) {
    this.paused = paused;
    this.toggle.setAttribute("aria-pressed", String(paused));
    this.toggle.setAttribute("aria-label", `${paused ? "Play" : "Pause"} the ${this.name}`);
    this.toggle.classList.toggle("paused", paused);
  }
}
