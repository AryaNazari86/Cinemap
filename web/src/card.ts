import { type Art, artFor } from "./art";
import { type Catalog, genreColor } from "./data";
import type { Galaxy } from "./galaxy";
import type { Rect } from "./labels";

const NEIGHBORS_SHOWN = 8;
const MARGIN = 12;
const TOP_CLEARANCE = 72; // keep the popover below the search toolbar
const GAP = 22; // space between the dot and the popover's arrow tip
const ARROW_INSET = 22; // keep the arrow clear of the rounded corners
export const COMPACT_QUERY = window.matchMedia("(max-width: 700px)"); // matches the phone breakpoint in style.css

/**
 * Details for the selected film. On wide screens it's a popover beside the dot with
 * an arrow pointing at it; on phones it's a sheet docked to the bottom.
 */
export class Card {
  private idx = -1;
  private readonly arrow: HTMLElement;
  private readonly body: HTMLElement;

  constructor(
    private readonly el: HTMLElement,
    private readonly catalog: Catalog,
    private readonly galaxy: Galaxy,
    private readonly onPick: (idx: number) => void,
    private readonly onClose: () => void,
    private readonly onCompare: (idx: number) => void,
  ) {
    this.arrow = h("div", { className: "card-arrow", ariaHidden: "true" });
    this.body = h("div", { className: "card-inner" });
    el.append(this.arrow, this.body);
  }

  get open() {
    return this.idx >= 0;
  }

  show(idx: number) {
    this.idx = idx;
    const m = this.catalog.movies[idx];
    const genres = this.catalog.genres;
    this.el.setAttribute("aria-label", m.t);
    const meta = [m.y ? String(m.y) : null, m.g.map((g) => genres[g]).join(", ") || null].filter(Boolean).join(" · ");
    // Placeholders hold the artwork's space while it loads, so the popover doesn't jump.
    const cover = h("div", { className: "card-cover loading", ariaHidden: "true" });
    const poster = h("div", { className: "card-poster loading" });
    const header = h("header", { className: "card-header has-cover has-poster" }, [
      poster,
      h("div", { className: "card-heading" }, [
        h("h2", { className: "card-title", textContent: m.t }),
        h("p", { className: "card-meta", textContent: meta }),
        rating(m.r, m.n),
      ]),
    ]);

    this.body.replaceChildren(
      h("div", { className: "grabber", ariaHidden: "true" }),
      h("button", { className: "close-button card-close", ariaLabel: "Close", onclick: () => this.onClose() }, [
        icon("M6 6l12 12M18 6 6 18"),
      ]),
      cover,
      header,
      h("section", { className: "card-section" }, [
        h("h3", { className: "card-section-title", textContent: "More like this" }),
        h(
          "ol",
          { className: "similar" },
          m.nb.slice(0, NEIGHBORS_SHOWN).map((j, k) => {
            const n = this.catalog.movies[j];
            const pct = Math.round(Math.max(0, m.ns[k]) * 100);
            const row = h(
              "button",
              {
                className: "similar-row",
                onclick: () => this.onPick(j),
                ariaLabel: `${n.t}${n.y ? `, ${n.y}` : ""}, ${pct}% match`,
              },
              [
                h("span", { className: "swatch", ariaHidden: "true" }),
                h("span", { className: "similar-title", textContent: n.t }),
                h("span", { className: "similar-year", textContent: n.y ? String(n.y) : "" }),
                h("span", { className: "similar-match", textContent: `${pct}%` }),
              ],
            );
            row.style.setProperty("--c", genreColor(genres[n.pg]));
            return h("li", {}, [row]);
          }),
        ),
        h("p", { className: "card-footnote", textContent: "Match = how alike the two films' audiences are." }),
      ]),
      h("footer", { className: "card-actions" }, [
        m.im ? link(`https://www.imdb.com/title/tt${m.im}/`, "View on IMDb", "pill pill-filled") : null,
        h("button", { className: "pill pill-outline", textContent: "Compare", onclick: () => this.onCompare(idx) }),
        m.tm ? link(`https://www.themoviedb.org/movie/${m.tm}`, "TMDB", "pill pill-outline") : null,
      ]),
    );
    this.el.hidden = false;
    this.el.classList.remove("enter");
    void this.el.offsetWidth;
    this.el.classList.add("enter");
    this.body.scrollTop = 0;

    artFor([idx])
      .get(idx)!
      .then((art) => {
        if (this.idx === idx) fillArt(art, m.t, header, cover, poster);
      });
  }

  hide() {
    this.idx = -1;
    this.el.hidden = true;
  }

  /** Follow the dot each frame; returns the card's rect in map coordinates so labels avoid it. */
  update(): Rect | null {
    if (this.idx < 0) return null;
    const g = this.galaxy;
    const w = this.el.offsetWidth;
    const hgt = this.el.offsetHeight;
    if (COMPACT_QUERY.matches) {
      this.el.style.transform = "";
      return [0, g.height - hgt, g.width, g.height];
    }
    const sx = g.screenX[this.idx];
    const sy = g.screenY[this.idx];
    let side: "left" | "right" = "right";
    let x = sx + GAP;
    if (x + w > g.width - MARGIN) {
      side = "left";
      x = sx - GAP - w;
    }
    x = clamp(x, MARGIN, g.width - w - MARGIN);
    const y = clamp(sy - hgt * 0.3, TOP_CLEARANCE, Math.max(TOP_CLEARANCE, g.height - hgt - MARGIN));
    this.el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
    this.el.dataset.side = side;
    this.arrow.style.top = `${Math.round(clamp(sy - y, ARROW_INSET, hgt - ARROW_INSET))}px`;
    return [x - 8, y - 8, x + w + 8, y + hgt + 8];
  }
}

/**
 * Swap placeholders for artwork. A film with only a poster gets a blurred copy of it as
 * its cover, like Apple TV; with no artwork at all the popover falls back to text.
 */
function fillArt(art: Art | null, title: string, header: HTMLElement, cover: HTMLElement, poster: HTMLElement) {
  const coverSrc = art?.backdrop ?? art?.poster ?? null;
  if (coverSrc) {
    const img = h("img", { src: coverSrc, alt: "", decoding: "async" });
    img.addEventListener("load", () => cover.classList.remove("loading"), { once: true });
    img.addEventListener("error", () => cover.classList.remove("loading"), { once: true });
    cover.classList.toggle("blurred", !art?.backdrop);
    cover.append(img);
  } else {
    cover.remove();
    header.classList.remove("has-cover");
  }
  if (art?.poster) {
    const img = h("img", { src: art.poster, alt: `Poster for ${title}`, decoding: "async" });
    img.addEventListener("load", () => poster.classList.remove("loading"), { once: true });
    img.addEventListener("error", () => poster.classList.remove("loading"), { once: true });
    poster.append(img);
  } else {
    poster.remove();
    header.classList.remove("has-poster");
  }
}

function rating(r: number | null, n: number): HTMLElement {
  if (r === null) return h("p", { className: "card-rating", textContent: "No ratings yet" });
  return h("p", { className: "card-rating" }, [
    h("span", { className: "rating-star", ariaHidden: "true", textContent: "★" }),
    h("span", { className: "rating-value", textContent: r.toFixed(1) }),
    h("span", { className: "rating-scale", textContent: "/5" }),
    h("span", { className: "rating-count", textContent: `${compact(n)} ratings` }),
  ]);
}

function compact(n: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

function link(href: string, label: string, className: string): HTMLElement {
  return h("a", { href, className, target: "_blank", rel: "noopener noreferrer", textContent: label });
}

function icon(d: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  svg.append(path);
  return svg;
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
