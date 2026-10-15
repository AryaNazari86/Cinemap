import { type Catalog, genreColor, normalize } from "./data";

const MAX_RESULTS = 8;

export class Search {
  private results: number[] = [];
  private active = -1;

  constructor(
    private readonly input: HTMLInputElement,
    private readonly list: HTMLUListElement,
    private readonly catalog: Catalog,
    private readonly onChoose: (idx: number) => void,
    /** Only one search on the page should answer the "/" shortcut. */
    { shortcut = true }: { shortcut?: boolean } = {},
  ) {
    input.addEventListener("input", () => this.run());
    input.addEventListener("focus", () => this.run());
    input.addEventListener("blur", () => setTimeout(() => this.close(), 120));
    input.addEventListener("keydown", (ev) => this.onKey(ev));
    if (!shortcut) return;
    window.addEventListener("keydown", (ev) => {
      const typing = ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement;
      if (ev.key === "/" && !typing) {
        ev.preventDefault();
        input.focus();
        input.select();
      }
    });
  }

  private run() {
    const q = normalize(this.input.value);
    this.results = q ? this.match(q) : [];
    this.active = this.results.length ? 0 : -1;
    this.render(q);
  }

  /** Title prefix beats word prefix beats substring; popularity breaks ties. */
  private match(q: string): number[] {
    const scored: [number, number][] = [];
    for (const m of this.catalog.movies) {
      const key = m.searchKey;
      let s = 0;
      if (key.startsWith(q)) s = 3;
      else if (key.includes(` ${q}`)) s = 2;
      else if (key.includes(q)) s = 1;
      else if (m.y && `${key} ${m.y}`.includes(q)) s = 0.5;
      if (s) scored.push([m.idx, s + Math.log1p(m.n) / 100]);
    }
    return scored
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_RESULTS)
      .map(([i]) => i);
  }

  private render(q: string) {
    this.list.replaceChildren();
    if (!q) return this.close();
    if (!this.results.length) {
      const li = document.createElement("li");
      li.className = "search-empty";
      li.textContent = "No films match. Try part of the title, like “godfather”.";
      this.list.append(li);
    }
    this.results.forEach((idx, k) => {
      const m = this.catalog.movies[idx];
      const li = document.createElement("li");
      li.id = `${this.list.id}-opt-${k}`;
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", String(k === this.active));
      li.className = "search-result";
      const genre = this.catalog.genres[m.pg];
      const dot = document.createElement("span");
      dot.className = "swatch";
      dot.setAttribute("aria-hidden", "true");
      dot.style.setProperty("--c", genreColor(genre));
      const title = document.createElement("span");
      title.className = "search-title";
      title.textContent = m.t;
      const year = document.createElement("span");
      year.className = "search-meta";
      year.textContent = [m.y, genre].filter(Boolean).join(" · ");
      li.append(dot, title, year);
      li.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        this.choose(idx);
      });
      this.list.append(li);
    });
    this.list.hidden = false;
    this.input.setAttribute("aria-expanded", "true");
    this.input.setAttribute("aria-activedescendant", this.active >= 0 ? `${this.list.id}-opt-${this.active}` : "");
  }

  private onKey(ev: KeyboardEvent) {
    if (ev.key === "Escape") {
      this.input.value = "";
      this.close();
      this.input.blur();
      return;
    }
    if (!this.results.length) return;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      const step = ev.key === "ArrowDown" ? 1 : -1;
      this.active = (this.active + step + this.results.length) % this.results.length;
      this.render(normalize(this.input.value));
    } else if (ev.key === "Enter" && this.active >= 0) {
      ev.preventDefault();
      this.choose(this.results[this.active]);
    }
  }

  private choose(idx: number) {
    this.input.value = this.catalog.movies[idx].t;
    this.close();
    this.input.blur();
    this.onChoose(idx);
  }

  private close() {
    this.list.hidden = true;
    this.input.setAttribute("aria-expanded", "false");
  }
}
