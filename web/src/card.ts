import { type Catalog, genreColor } from "./data";
import type { Galaxy } from "./galaxy";

const NEIGHBORS_SHOWN = 8;
const MARGIN = 14;
const DOCKED_QUERY = window.matchMedia("(max-width: 640px)");

/** The ticket-stub popup for the selected movie, pinned beside its star. */
export class Card {
  private idx = -1;

  constructor(
    private readonly el: HTMLElement,
    private readonly catalog: Catalog,
    private readonly galaxy: Galaxy,
    private readonly onPick: (idx: number) => void,
    private readonly onClose: () => void,
  ) {}

  get open() {
    return this.idx >= 0;
  }

  show(idx: number) {
    this.idx = idx;
    const m = this.catalog.movies[idx];
    const genres = this.catalog.genres;
    const color = genreColor(genres[m.pg]);
    this.el.style.setProperty("--accent", color);
    this.el.setAttribute("aria-label", m.t);
    this.el.replaceChildren(
      h("button", { className: "card-close", ariaLabel: "Close", textContent: "×", onclick: () => this.onClose() }),
      h("div", { className: "card-head" }, [
        h("div", {
          className: "card-slate",
          textContent: `No. ${String(idx + 1).padStart(4, "0")} · ${genres[m.pg] ?? "Film"}`,
        }),
        h("h2", { className: "card-title", textContent: m.t }),
        h("div", { className: "card-year", textContent: m.y ? String(m.y) : "Year unknown" }),
        h(
          "div",
          { className: "card-genres" },
          m.g.map((g) => {
            const chip = h("span", { className: "chip", textContent: genres[g] });
            chip.style.setProperty("--c", genreColor(genres[g]));
            return chip;
          }),
        ),
        h("div", { className: "card-stats" }, [rating(m.r), h("span", { textContent: `${m.n.toLocaleString()} ratings` })]),
      ]),
      h("div", { className: "card-perf", ariaHidden: "true" }),
      h("div", { className: "card-body" }, [
        h("div", { className: "card-section", textContent: "Closest in taste" }),
        h(
          "ol",
          { className: "card-neighbors" },
          m.nb.slice(0, NEIGHBORS_SHOWN).map((j, k) => {
            const n = this.catalog.movies[j];
            const pct = Math.round(Math.max(0, m.ns[k]) * 100);
            const btn = h("button", { className: "neighbor", onclick: () => this.onPick(j) }, [
              h("span", { className: "genre-dot" }),
              h("span", { className: "neighbor-title", textContent: n.t }),
              h("span", { className: "neighbor-year", textContent: n.y ? String(n.y) : "" }),
              h("span", { className: "neighbor-match", title: "Cosine similarity of the two movie vectors" }, [
                h("span", { className: "match-bar" }),
                h("span", { textContent: `${pct}%` }),
              ]),
            ]);
            btn.style.setProperty("--c", genreColor(genres[n.pg]));
            btn.style.setProperty("--pct", `${pct}%`);
            return h("li", {}, [btn]);
          }),
        ),
        h("div", { className: "card-links" }, [
          m.tm ? link(`https://www.themoviedb.org/movie/${m.tm}`, "TMDB") : null,
          m.im ? link(`https://www.imdb.com/title/tt${m.im}/`, "IMDb") : null,
        ]),
      ]),
    );
    this.el.hidden = false;
    this.el.classList.remove("enter");
    void this.el.offsetWidth;
    this.el.classList.add("enter");
  }

  hide() {
    this.idx = -1;
    this.el.hidden = true;
  }

  /** Follow the star each frame; returns the card's screen rect so labels can avoid it. */
  update(): [number, number, number, number] | null {
    if (this.idx < 0) return null;
    const g = this.galaxy;
    const w = this.el.offsetWidth;
    const hgt = this.el.offsetHeight;
    if (DOCKED_QUERY.matches) {
      this.el.style.transform = "";
      return [0, g.height - hgt, g.width, g.height];
    }
    const sx = g.screenX[this.idx];
    const sy = g.screenY[this.idx];
    const gap = 46;
    let x = sx + gap;
    if (x + w > g.width - MARGIN) x = sx - gap - w;
    x = clamp(x, MARGIN, g.width - w - MARGIN);
    const y = clamp(sy - hgt * 0.35, 76, g.height - hgt - MARGIN);
    this.el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
    return [x - 8, y - 8, x + w + 8, y + hgt + 8];
  }
}

function rating(r: number | null): HTMLElement {
  if (r === null) return h("span", { textContent: "No ratings yet" });
  const stars = h("span", { className: "stars", ariaHidden: "true" });
  stars.style.setProperty("--fill", `${(r / 5) * 100}%`);
  return h("span", { className: "rating", title: "Average rating in the training data" }, [
    stars,
    h("span", { textContent: r.toFixed(2) }),
  ]);
}

function link(href: string, label: string): HTMLElement {
  return h("a", { href, target: "_blank", rel: "noopener noreferrer", textContent: `${label} ↗` });
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & Record<string, unknown>,
  children: (Node | null)[] = [],
): HTMLElementTagNameMap[K] {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...children.filter((c): c is Node => c !== null));
  return el;
}
