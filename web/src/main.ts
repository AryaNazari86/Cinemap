import "./style.css";
import { artFor } from "./art";
import { COMPACT_QUERY, Card } from "./card";
import { Carousel } from "./carousel";
import { Compare, tile } from "./compare";
import { type Catalog, genreColor, loadCatalog } from "./data";
import { Galaxy } from "./galaxy";
import { Labels, type Rect } from "./labels";
import { Search } from "./search";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const CARD_SHIFT_PX = 190; // about half the popover's width plus its gap from the dot
const CLASSICS = 16;
// The comparison shown before anyone picks: two classics with an interesting score.
const DEFAULT_PAIR: [string, string] = ["The Godfather", "Pulp Fiction"];
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

async function boot() {
  const catalog = await loadCatalog(document.body.dataset.moviesUrl!);
  const frame = $("#map-frame");
  const toolbar = $(".map-toolbar");
  const controls = $(".map-controls");

  let selected = -1;
  const select = (idx: number, fly = true) => {
    selected = idx;
    galaxy.select(idx, fly);
    labels.selected = idx;
    labels.pinned = [];
    // Slide the focused dot aside so the popover fits next to it; compact maps dock a sheet below instead.
    if (idx < 0) galaxy.setViewShift(0, 0);
    else if (COMPACT_QUERY.matches) galaxy.setViewShift(0, galaxy.height * 0.25);
    else galaxy.setViewShift(CARD_SHIFT_PX, 0);
    if (idx < 0) {
      card.hide();
      history.replaceState(null, "", location.pathname + location.search);
    } else {
      card.show(idx);
      history.replaceState(null, "", `#m=${idx}`);
    }
  };

  const galaxy = new Galaxy($("#stage"), catalog, {
    onHover: (idx) => (labels.hovered = idx),
    onClick: (idx) => select(idx),
    onFrame: () => {
      const avoid: Rect[] = [rectIn(toolbar, frame), rectIn(controls, frame)];
      const cardRect = card.update();
      if (cardRect) avoid.push(cardRect);
      labels.avoid = avoid;
      labels.update();
    },
    onScrollPast: () => nudgeHint(),
  });
  const labels = new Labels($("#labels"), catalog, galaxy);
  const card = new Card(
    $("#card"),
    catalog,
    galaxy,
    (idx) => select(idx),
    () => select(-1),
    (idx) => {
      // Start a comparison with this film, keeping the other slot if it holds a different one.
      compare.set("a", idx);
      $("#compare").scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
      setTimeout(() => compare.focus("b"), reducedMotion ? 0 : 450);
    },
  );
  const compare = new Compare(
    $("#compare"),
    catalog,
    (a, b) => {
      select(-1);
      galaxy.showPair(a, b);
      labels.pinned = [a, b];
      showMap();
    },
    (idx) => {
      showMap();
      select(idx);
    },
  );
  const byTitle = (t: string) => catalog.byPopularity.find((i) => catalog.movies[i].t === t) ?? -1;
  const [pairA, pairB] = DEFAULT_PAIR.map(byTitle);
  if (pairA >= 0 && pairB >= 0) {
    compare.set("a", pairA);
    compare.set("b", pairB);
  }
  const searchInput = $<HTMLInputElement>("#search");
  new Search(searchInput, $<HTMLUListElement>("#search-results"), catalog, (idx) => select(idx));

  // One popover at a time: the film popover steps aside while the genre panel is open.
  const genrePanel = buildGenrePicker(
    catalog,
    (filter) => galaxy.setGenreFilter(filter),
    (open) => $("#card").classList.toggle("suppressed", open),
  );
  const expand = bindExpand(frame, galaxy);
  fillNumbers(catalog);
  buildCarousel(catalog, (idx) => {
    showMap();
    select(idx);
  });

  $("#zoom-in").addEventListener("click", () => galaxy.zoomBy(0.7));
  $("#zoom-out").addEventListener("click", () => galaxy.zoomBy(1 / 0.7));
  $("#reset").addEventListener("click", () => {
    select(-1);
    galaxy.resetView();
  });

  // "Find a film" scrolls to the map and puts the cursor in its search field.
  for (const link of document.querySelectorAll<HTMLAnchorElement>("[data-focus-search]")) {
    link.addEventListener("click", (ev) => {
      ev.preventDefault();
      showMap();
      setTimeout(() => searchInput.focus({ preventScroll: true }), reducedMotion ? 0 : 450);
    });
  }

  window.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape" || document.activeElement === searchInput) return;
    if (genrePanel.isOpen()) genrePanel.close();
    else if (selected >= 0) select(-1);
    else if (expand.isExpanded()) expand.set(false);
  });

  galaxy.start();

  const hashMovie = () => {
    const raw = new URLSearchParams(location.hash.slice(1)).get("m");
    const idx = raw === null ? NaN : Number(raw);
    return Number.isInteger(idx) && catalog.movies[idx] ? idx : -1;
  };
  window.addEventListener("hashchange", () => {
    const idx = hashMovie();
    if (idx !== selected) select(idx);
  });
  const fromHash = hashMovie();
  document.body.classList.add("ready");
  if (fromHash >= 0) {
    showMap();
    select(fromHash);
  }
}

function showMap() {
  $("#map-frame").scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
}

/** An element's rect relative to the map frame, as [left, top, right, bottom]. */
function rectIn(el: HTMLElement, frame: HTMLElement): Rect {
  const a = el.getBoundingClientRect();
  const f = frame.getBoundingClientRect();
  return [a.left - f.left - 6, a.top - f.top - 6, a.right - f.left + 6, a.bottom - f.top + 6];
}

let hintTimer = 0;
/** A plain scroll over the map scrolls the page; briefly say how to zoom instead. */
function nudgeHint() {
  const hint = $("#map-hint");
  if (!hint.classList.contains("nudge")) hint.textContent = "Pinch or hold ⌘ while scrolling to zoom";
  hint.classList.add("nudge");
  clearTimeout(hintTimer);
  hintTimer = window.setTimeout(() => {
    hint.classList.remove("nudge");
    hint.textContent = "Drag to rotate · Pinch or ⌘-scroll to zoom";
  }, 1600);
}

function bindExpand(frame: HTMLElement, galaxy: Galaxy) {
  const button = $<HTMLButtonElement>("#expand");
  const set = (on: boolean) => {
    frame.classList.toggle("expanded", on);
    document.body.classList.toggle("map-expanded", on);
    button.setAttribute("aria-pressed", String(on));
    button.setAttribute("aria-label", on ? "Exit expanded map" : "Expand map");
    button.title = on ? "Exit expanded map" : "Expand map";
    galaxy.setExpanded(on);
    if (!on) showMap();
  };
  button.addEventListener("click", () => set(!frame.classList.contains("expanded")));
  return { set, isExpanded: () => frame.classList.contains("expanded") };
}

function buildGenrePicker(
  catalog: Catalog,
  onChange: (filter: Set<number>) => void,
  onOpenChange: (open: boolean) => void,
) {
  const { genres, movies } = catalog;
  const button = $<HTMLButtonElement>("#genre-button");
  const buttonLabel = $("#genre-button-label");
  const panel = $("#genre-panel");
  const list = $("#genre-list");
  const clear = $<HTMLButtonElement>("#genre-clear");
  const counts = genres.map((_, g) => movies.filter((m) => m.g.includes(g)).length);
  const active = new Set<number>();
  const boxes: HTMLInputElement[] = [];

  const sync = () => {
    clear.hidden = active.size === 0;
    buttonLabel.textContent = active.size ? `Genres · ${active.size}` : "Genres";
    button.classList.toggle("active", active.size > 0);
    onChange(active);
  };
  genres.forEach((name, g) => {
    const label = document.createElement("label");
    label.className = "genre-row";
    label.style.setProperty("--c", genreColor(name));
    const box = document.createElement("input");
    box.type = "checkbox";
    box.addEventListener("change", () => {
      box.checked ? active.add(g) : active.delete(g);
      sync();
    });
    boxes.push(box);
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.textContent = name;
    const count = document.createElement("span");
    count.className = "genre-count";
    count.textContent = counts[g].toLocaleString();
    label.append(box, swatch, text, count);
    const li = document.createElement("li");
    li.append(label);
    list.append(li);
  });
  clear.addEventListener("click", () => {
    active.clear();
    for (const box of boxes) box.checked = false;
    sync();
  });

  const isOpen = () => !panel.hidden;
  const setOpen = (open: boolean) => {
    panel.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    onOpenChange(open);
  };
  button.addEventListener("click", () => setOpen(!isOpen()));
  document.addEventListener("pointerdown", (ev) => {
    if (isOpen() && !panel.contains(ev.target as Node) && !button.contains(ev.target as Node)) setOpen(false);
  });
  return {
    isOpen,
    close: () => {
      setOpen(false);
      button.focus();
    },
  };
}

function fillNumbers(catalog: Catalog) {
  const films = catalog.movies.length.toLocaleString();
  $("#hero-films").textContent = films;
  $("#how-dims").textContent = String(catalog.meta.dim);
  $<HTMLInputElement>("#search").placeholder = `Search ${films} films`;
}

/** The most rated films as an endless, slowly drifting row of poster tiles. */
function buildCarousel(catalog: Catalog, onPick: (idx: number) => void) {
  const track = $("#classics");
  const picks = catalog.byPopularity.slice(0, CLASSICS);
  artFor(picks); // one request for every poster in the row
  const copy = () => {
    const list = document.createElement("ul");
    list.className = "tiles";
    list.append(...picks.map((idx) => tile(catalog, idx, () => onPick(idx))));
    return list;
  };
  // The second copy only exists to make the loop seamless: hide it from assistive tech and Tab.
  const clone = copy();
  clone.dataset.clone = "";
  clone.setAttribute("aria-hidden", "true");
  clone.inert = true;
  track.append(copy(), clone);
  new Carousel(track, $<HTMLButtonElement>("#carousel-toggle"));
}

boot().catch((err) => {
  console.error(err);
  $("#loader-text").textContent = "Couldn't load the films. Check your connection and reload the page.";
  document.body.classList.add("failed");
});
