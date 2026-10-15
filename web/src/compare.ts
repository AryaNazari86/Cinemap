import { artFor } from "./art";
import { type Catalog, genreColor } from "./data";
import { Search } from "./search";

type Slot = "a" | "b";

/** The /api/compare/ response; see galaxy/similarity.py. */
interface Comparison {
  a: number;
  b: number;
  similarity: number;
  rank_b_for_a: number;
  rank_a_for_b: number;
  closer_than: number;
  between: number[];
}

const endpoint = document.body.dataset.compareUrl ?? "";

/** Verdict from where b ranks among all films by closeness to a. */
function verdict(closerThan: number): string {
  if (closerThan >= 0.999) return "Nearly the same audience";
  if (closerThan >= 0.98) return "Very alike";
  if (closerThan >= 0.9) return "Alike";
  if (closerThan >= 0.7) return "A little alike";
  return "Not alike";
}

/** Two film pickers, the match score between them, and films both audiences love. */
export class Compare {
  private films: Record<Slot, number> = { a: -1, b: -1 };
  private request = 0;
  private readonly result: HTMLElement;
  private readonly between: HTMLElement;
  private readonly betweenList: HTMLElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly catalog: Catalog,
    private readonly onShowPair: (a: number, b: number) => void,
    private readonly onOpenFilm: (idx: number) => void,
  ) {
    this.result = root.querySelector("#compare-result")!;
    this.between = root.querySelector("#compare-between")!;
    this.betweenList = root.querySelector("#compare-between-list")!;
    for (const slot of ["a", "b"] as Slot[]) this.buildSlot(slot);
  }

  /** Put a film in a slot; once both are filled, compare them. */
  set(slot: Slot, idx: number) {
    this.films[slot] = idx;
    this.renderSlot(slot);
    void this.update();
  }

  get(slot: Slot) {
    return this.films[slot];
  }

  focus(slot: Slot) {
    this.input(slot).focus({ preventScroll: true });
  }

  private input(slot: Slot): HTMLInputElement {
    return this.root.querySelector(`[data-slot="${slot}"] input`)!;
  }

  private buildSlot(slot: Slot) {
    const el = this.root.querySelector<HTMLElement>(`[data-slot="${slot}"]`)!;
    const label = slot === "a" ? "First film" : "Second film";
    el.innerHTML = `
      <div class="compare-poster"><span class="compare-poster-empty">Pick a film</span></div>
      <div class="compare-picker search">
        <svg class="search-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>
        <input type="search" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="false"
          aria-autocomplete="list" placeholder="Search films" />
        <ul role="listbox" hidden></ul>
      </div>
      <p class="compare-meta"></p>`;
    const input = el.querySelector("input")!;
    const list = el.querySelector("ul")!;
    input.setAttribute("aria-label", label);
    list.id = `compare-${slot}-results`;
    list.setAttribute("aria-label", `Films for the ${label.toLowerCase()}`);
    input.setAttribute("aria-controls", list.id);
    new Search(input, list, this.catalog, (idx) => this.set(slot, idx), { shortcut: false });
  }

  private renderSlot(slot: Slot) {
    const idx = this.films[slot];
    const el = this.root.querySelector<HTMLElement>(`[data-slot="${slot}"]`)!;
    const poster = el.querySelector<HTMLElement>(".compare-poster")!;
    const meta = el.querySelector<HTMLElement>(".compare-meta")!;
    const m = this.catalog.movies[idx];
    const genre = this.catalog.genres[m.pg];
    this.input(slot).value = m.t;
    meta.textContent = [m.y, genre].filter(Boolean).join(" · ");
    poster.style.setProperty("--c", genreColor(genre));
    poster.replaceChildren(Object.assign(document.createElement("span"), { className: "compare-poster-title", textContent: m.t }));
    poster.classList.add("loading");
    artFor([idx])
      .get(idx)!
      .then((art) => {
        if (this.films[slot] !== idx) return;
        poster.classList.remove("loading");
        if (!art?.poster) return;
        const img = Object.assign(document.createElement("img"), { src: art.poster, alt: `Poster for ${m.t}` });
        img.addEventListener("load", () => poster.replaceChildren(img), { once: true });
      });
  }

  private async update() {
    const { a, b } = this.films;
    if (a < 0 || b < 0) return;
    if (a === b) {
      this.result.replaceChildren(text("p", "compare-hint", "Pick two different films."));
      this.between.hidden = true;
      return;
    }
    const ticket = ++this.request;
    this.result.classList.add("busy");
    let data: Comparison;
    try {
      const res = await fetch(`${endpoint}?a=${a}&b=${b}`);
      if (!res.ok) throw new Error(String(res.status));
      data = await res.json();
    } catch {
      if (ticket !== this.request) return;
      this.result.classList.remove("busy");
      this.result.replaceChildren(text("p", "compare-hint", "Couldn't compare those two. Check your connection and try again."));
      return;
    }
    if (ticket !== this.request) return; // a newer pick superseded this one
    this.result.classList.remove("busy");
    this.render(data);
  }

  private render(c: Comparison) {
    const ma = this.catalog.movies[c.a];
    const mb = this.catalog.movies[c.b];
    const pct = Math.max(0, Math.round(c.similarity * 100));
    const others = (this.catalog.movies.length - 2).toLocaleString();
    const detail =
      c.rank_b_for_a === 1
        ? `${mb.t} is the single closest film to ${ma.t}.`
        : `${mb.t} is closer to ${ma.t} than ${formatShare(c.closer_than)} of the other ${others} films.`;

    const show = text("button", "pill pill-filled", "See both on the map");
    show.addEventListener("click", () => this.onShowPair(c.a, c.b));
    this.result.replaceChildren(
      text("p", "compare-score", `${pct}%`),
      text("p", "compare-score-label", "match"),
      text("p", "compare-verdict", verdict(c.closer_than)),
      text("p", "compare-detail", detail),
      show,
    );

    artFor(c.between); // one request for all six posters
    this.betweenList.replaceChildren(...c.between.map((i) => tile(this.catalog, i, () => this.onOpenFilm(i))));
    this.between.hidden = c.between.length === 0;
  }
}

/** A poster tile with the title underneath; used for "Loved by both audiences". */
export function tile(catalog: Catalog, idx: number, onPick: () => void): HTMLLIElement {
  const m = catalog.movies[idx];
  const li = document.createElement("li");
  const button = document.createElement("button");
  button.className = "tile";
  button.style.setProperty("--c", genreColor(catalog.genres[m.pg]));
  button.innerHTML = `<span class="tile-poster loading"><span class="tile-fallback"></span></span>
    <span class="tile-title"></span><span class="tile-meta"></span>`;
  button.querySelector(".tile-fallback")!.textContent = m.t;
  button.querySelector(".tile-title")!.textContent = m.t;
  button.querySelector(".tile-meta")!.textContent = [m.y, m.r !== null ? `★ ${m.r.toFixed(1)}` : null]
    .filter(Boolean)
    .join(" · ");
  button.addEventListener("click", onPick);
  li.append(button);

  const poster = button.querySelector<HTMLElement>(".tile-poster")!;
  artFor([idx])
    .get(idx)!
    .then((art) => {
      if (!art?.poster) return poster.classList.remove("loading");
      const img = Object.assign(document.createElement("img"), { src: art.poster, alt: "", decoding: "async" });
      img.addEventListener("load", () => poster.classList.replace("loading", "has-image"), { once: true });
      img.addEventListener("error", () => poster.classList.remove("loading"), { once: true });
      poster.prepend(img);
    });
  return li;
}

function formatShare(share: number): string {
  const pct = Math.min(share * 100, 99.9);
  return `${pct >= 99 ? pct.toFixed(1) : Math.round(pct)}%`;
}

function text<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, content: string) {
  return Object.assign(document.createElement(tag), { className, textContent: content });
}
