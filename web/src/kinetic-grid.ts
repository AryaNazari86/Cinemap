/**
 * Page background: a grid of connected nodes that bends toward the pointer and ripples
 * on click, echoing the links between films on the map. Adapted from the "Kinetic Grid"
 * React component to plain canvas, a light palette, and the site's accent blue.
 *
 * It sits behind every section (white sections cover it, grey ones show it), draws only
 * while something is moving, and stays still for people who prefer reduced motion.
 */

interface Point {
  x: number;
  y: number;
}

interface Ripple {
  x: number;
  y: number;
  born: number;
}

const CELL_SIZE = 56;
const INFLUENCE_RADIUS = 260;
const MAX_WARP = 22;
const DOT_SPACING = 28;
const POINTER_EASE = 0.08;
const RIPPLE_SPEED = 400; // px per second
const RIPPLE_LIFE_S = 0.85;
const RIPPLE_WIDTH = 55;

// Faint graphite at rest, IMDb yellow (#f5c518) near the pointer.
// Sections can ask for another glow colour with data-grid-accent="r, g, b".
const DEFAULT_ACCENT = "245, 197, 24";
const LINE_REST = [0, 0, 0, 0.055] as const;
const NODE_REST = [0, 0, 0, 0.13] as const;
const NODE_RADIUS = [1.6, 3] as const;

type Rgba = readonly [number, number, number, number];

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (t: number) => t * t * (3 - 2 * t);
const rgba = (a: Rgba, b: Rgba, t: number) =>
  `rgba(${Math.round(mix(a[0], b[0], t))},${Math.round(mix(a[1], b[1], t))},${Math.round(mix(a[2], b[2], t))},${mix(a[3], b[3], t).toFixed(3)})`;

export class KineticGrid {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly dots = document.createElement("canvas");
  private readonly still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  private width = 0;
  private height = 0;
  private pointer: Point = { x: 0, y: 0 };
  private target: Point = { x: 0, y: 0 };
  /** 0..1: how strongly the pointer bends the grid; eases to 0 when it leaves the window. */
  private influence = 0;
  private influenceTarget = 0;
  private ripples: Ripple[] = [];
  private dirty = true;
  /** "r, g, b" of the glow, taken from the section under the pointer. */
  private accent = DEFAULT_ACCENT;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
    window.addEventListener("resize", () => this.resize());
    this.resize();
    if (this.still) return; // a static grid, drawn once per resize

    window.addEventListener("pointermove", (ev) => {
      if (ev.pointerType !== "mouse") return;
      this.target = { x: ev.clientX, y: ev.clientY };
      const region = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("[data-grid-accent]");
      this.accent = region?.dataset.gridAccent ?? DEFAULT_ACCENT;
      if (this.influenceTarget === 0) this.pointer = { ...this.target }; // don't sweep in from afar
      this.influenceTarget = 1;
      this.dirty = true;
    });
    document.documentElement.addEventListener("pointerleave", () => {
      this.influenceTarget = 0;
      this.dirty = true;
    });
    window.addEventListener("click", (ev) => {
      // A click can land after the frame's timestamp was taken, so its ripple may start a
      // moment "in the future"; ages are clamped at 0 so radii never go negative.
      this.ripples.push({ x: ev.clientX, y: ev.clientY, born: performance.now() });
      this.dirty = true;
    });
    requestAnimationFrame((t) => this.tick(t));
  }

  private resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    for (const c of [this.canvas, this.dots]) {
      c.width = Math.round(this.width * ratio);
      c.height = Math.round(this.height * ratio);
    }
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

    // The dot texture never moves, so render it once per size.
    const d = this.dots.getContext("2d")!;
    d.setTransform(ratio, 0, 0, ratio, 0, 0);
    d.fillStyle = "rgba(0, 0, 0, 0.05)";
    for (let x = DOT_SPACING / 2; x < this.width; x += DOT_SPACING) {
      for (let y = DOT_SPACING / 2; y < this.height; y += DOT_SPACING) {
        d.beginPath();
        d.arc(x, y, 0.7, 0, Math.PI * 2);
        d.fill();
      }
    }
    this.dirty = true;
    if (this.still) this.draw(performance.now());
  }

  private tick(now: number) {
    // Schedule first, so one bad frame can never stop the loop.
    requestAnimationFrame((t) => this.tick(t));
    const easing = Math.abs(this.influence - this.influenceTarget) > 0.001;
    const following = Math.abs(this.pointer.x - this.target.x) + Math.abs(this.pointer.y - this.target.y) > 0.3;
    if (this.dirty || easing || following || this.ripples.length) {
      this.pointer.x = mix(this.pointer.x, this.target.x, POINTER_EASE);
      this.pointer.y = mix(this.pointer.y, this.target.y, POINTER_EASE);
      this.influence = mix(this.influence, this.influenceTarget, POINTER_EASE);
      this.ripples = this.ripples.filter((r) => (now - r.born) / 1000 < RIPPLE_LIFE_S);
      this.draw(now);
      this.dirty = false;
    }
  }

  /** A grid point moved by the pointer and any passing ripples; proximity drives its colour. */
  private warp(gx: number, gy: number, col: number, row: number, cols: number, rows: number, now: number) {
    // Pin the outermost lines so the grid never pulls away from the edges.
    const colPin = Math.min(col / 1.5, (cols - 1 - col) / 1.5, 1);
    const rowPin = Math.min(row / 1.5, (rows - 1 - row) / 1.5, 1);
    const pin = colPin * colPin * rowPin * rowPin;

    const dx = gx - this.pointer.x;
    const dy = gy - this.pointer.y;
    const dist = Math.hypot(dx, dy);
    const proximity = Math.max(0, 1 - dist / INFLUENCE_RADIUS) * pin * this.influence;

    let x = gx;
    let y = gy;
    for (const r of this.ripples) {
      const age = Math.max(0, now - r.born) / 1000;
      const radius = age * RIPPLE_SPEED;
      const strength = Math.max(0, 1 - age / RIPPLE_LIFE_S);
      const rdx = gx - r.x;
      const rdy = gy - r.y;
      const diff = Math.hypot(rdx, rdy) - radius;
      if (Math.abs(diff) < RIPPLE_WIDTH) {
        const push = (1 - Math.abs(diff) / RIPPLE_WIDTH) * strength * 18 * pin * (diff < 0 ? 1 : -1);
        const angle = Math.atan2(rdy, rdx);
        x += Math.cos(angle) * push;
        y += Math.sin(angle) * push;
      }
    }

    if (dist > 0 && dist < INFLUENCE_RADIUS) {
      const t = dist / INFLUENCE_RADIUS;
      const amount = (1 - t) * (1 - t) * Math.min(1, dist / 60) * MAX_WARP * pin * this.influence;
      x -= (dx / dist) * amount;
      y -= (dy / dist) * amount;
    }
    return { x, y, proximity };
  }

  private draw(now: number) {
    const { ctx, width: W, height: H, accent } = this;
    if (!W || !H) return; // zero-size window (e.g. a collapsed pane): nothing to draw yet
    const [ar, ag, ab] = accent.split(",").map(Number);
    const lineActive: Rgba = [ar, ag, ab, 0.55];
    const nodeActive: Rgba = [ar, ag, ab, 0.9];
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(this.dots, 0, 0, W, H);

    const cols = Math.max(2, Math.ceil(W / CELL_SIZE)) + 1;
    const rows = Math.max(2, Math.ceil(H / CELL_SIZE)) + 1;
    const cellW = W / (cols - 1);
    const cellH = H / (rows - 1);
    const grid: { x: number; y: number; proximity: number }[][] = [];
    for (let row = 0; row < rows; row++) {
      grid[row] = [];
      for (let col = 0; col < cols; col++) {
        grid[row][col] = this.warp(col * cellW, row * cellH, col, row, cols, rows, now);
      }
    }

    const segment = (a: (typeof grid)[0][0], b: (typeof grid)[0][0]) => {
      const t = smooth((a.proximity + b.proximity) / 2);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = rgba(LINE_REST, lineActive, t);
      ctx.lineWidth = mix(0.8, 1.5, t);
      ctx.stroke();
    };
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        if (col < cols - 1) segment(grid[row][col], grid[row][col + 1]);
        if (row < rows - 1) segment(grid[row][col], grid[row + 1][col]);
      }
    }

    for (const row of grid) {
      for (const p of row) {
        const t = smooth(p.proximity);
        const r = mix(NODE_RADIUS[0], NODE_RADIUS[1], t);
        if (t > 0.3) {
          const halo = r + mix(0, 6, (t - 0.3) / 0.7);
          const glow = ctx.createRadialGradient(p.x, p.y, r * 0.5, p.x, p.y, halo);
          glow.addColorStop(0, `rgba(${accent},${(t * 0.25).toFixed(3)})`);
          glow.addColorStop(1, `rgba(${accent},0)`);
          ctx.beginPath();
          ctx.arc(p.x, p.y, halo, 0, Math.PI * 2);
          ctx.fillStyle = glow;
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fillStyle = rgba(NODE_REST, nodeActive, t);
        ctx.fill();
      }
    }

    for (const r of this.ripples) {
      const age = Math.max(0, now - r.born) / 1000;
      ctx.beginPath();
      ctx.arc(r.x, r.y, age * RIPPLE_SPEED, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${accent},${(Math.max(0, 1 - age / RIPPLE_LIFE_S) * 0.25).toFixed(3)})`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
}
