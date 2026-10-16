import type { Catalog } from "./data";
import type { Galaxy } from "./galaxy";

const MAX_LABELS = 28;
const CANDIDATES = 700;
const CHAR_WIDTH = 6.9;
const LABEL_HEIGHT = 18;
const GAP = 6;

export type Rect = [number, number, number, number];

/** A label that isn't a film: "You", or the name at an end of an axis. */
export interface Tag {
  text: string;
  x: number;
  y: number;
  kind: "you" | "axis";
}

/**
 * Floating titles beside the most prominent nearby dots. Priority goes to the hovered
 * movie, then the selected movie's neighbours, then the most rated movies;
 * a label is skipped if it would overlap one already placed.
 */
export class Labels {
  private readonly pool: HTMLDivElement[] = [];
  private readonly shown = new Map<number, HTMLDivElement>();
  private readonly tagEls: HTMLDivElement[] = [];
  hovered = -1;
  selected = -1;
  /** Films whose titles always show, e.g. the two being compared. */
  pinned: number[] = [];
  /** Screen areas labels must stay out of: the open film card, the toolbar, the controls. */
  avoid: Rect[] = [];
  /** Non-film labels, placed before any film's and always shown. */
  tags: Tag[] = [];

  constructor(
    private readonly layer: HTMLElement,
    private readonly catalog: Catalog,
    private readonly galaxy: Galaxy,
  ) {}

  update() {
    const g = this.galaxy;
    const movies = this.catalog.movies;
    const placed: Rect[] = [...this.avoid];
    const next = new Map<number, { x: number; y: number; kind: string; alpha: number }>();

    this.tags.forEach((tag, k) => {
      const el = (this.tagEls[k] ??= this.create());
      el.textContent = tag.text;
      el.className = `star-label tag-${tag.kind}`;
      el.style.opacity = "1";
      el.style.transform = `translate3d(${Math.round(tag.x)}px, ${Math.round(tag.y - LABEL_HEIGHT / 2)}px, 0)`;
      const w = tag.text.length * CHAR_WIDTH + 16;
      placed.push([tag.x - GAP, tag.y - LABEL_HEIGHT / 2 - GAP, tag.x + w + GAP, tag.y + LABEL_HEIGHT / 2 + GAP]);
    });
    for (const el of this.tagEls.slice(this.tags.length)) el.style.opacity = "0";

    const tryPlace = (i: number, kind: string, force = false) => {
      if (next.has(i) || i === this.selected || !g.onScreen[i] || g.isFiltered(i)) return;
      const offset = g.pointSizePx(i) / 2 + 6;
      const x = g.screenX[i] + offset;
      const y = g.screenY[i] - LABEL_HEIGHT / 2;
      const w = movies[i].t.length * CHAR_WIDTH + 16;
      const rect: Rect = [x - GAP, y - GAP, x + w + GAP, y + LABEL_HEIGHT + GAP];
      if (!force && placed.some((r) => overlaps(r, rect))) return;
      placed.push(rect);
      const alpha = kind === "pop" ? Math.min(1, Math.max(0.35, 1.6 - g.depth[i] / 260)) : 1;
      next.set(i, { x, y, kind, alpha });
    };

    if (this.hovered >= 0) tryPlace(this.hovered, "hover", true);
    for (const i of this.pinned) tryPlace(i, "neighbor", true);
    if (this.selected >= 0) {
      for (const j of movies[this.selected].nb.slice(0, 8)) tryPlace(j, "neighbor");
    }
    const popular = this.catalog.byPopularity;
    // Nearer stars first among the candidates, so zooming in reveals local names.
    const candidates = popular.slice(0, CANDIDATES).filter((i) => g.onScreen[i] && g.depth[i] < 420);
    candidates.sort((a, b) => score(b) - score(a));
    function score(i: number) {
      return Math.log1p(movies[i].n) - g.depth[i] / 60;
    }
    for (const i of candidates) {
      if (next.size >= MAX_LABELS + (this.selected >= 0 ? 8 : 0)) break;
      tryPlace(i, "pop");
    }

    for (const [i, el] of this.shown) {
      if (!next.has(i)) {
        el.style.opacity = "0";
        this.pool.push(el);
        this.shown.delete(i);
      }
    }
    for (const [i, { x, y, kind, alpha }] of next) {
      let el = this.shown.get(i);
      if (!el) {
        el = this.pool.pop() ?? this.create();
        const m = movies[i];
        el.textContent = m.t;
        if (m.y) {
          const year = document.createElement("span");
          year.textContent = ` ${m.y}`;
          el.append(year);
        }
        this.shown.set(i, el);
      }
      el.className = `star-label ${kind}`;
      el.style.opacity = String(alpha);
      el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
    }
  }

  private create(): HTMLDivElement {
    const el = document.createElement("div");
    el.className = "star-label";
    this.layer.append(el);
    return el;
  }
}

function overlaps(a: Rect, b: Rect) {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}
