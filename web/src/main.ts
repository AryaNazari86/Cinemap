import "./style.css";
import { Card } from "./card";
import { genreColor, loadCatalog } from "./data";
import { Galaxy } from "./galaxy";
import { Labels } from "./labels";
import { Search } from "./search";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const MIN_LOADER_MS = 1400;
const CARD_SHIFT_PX = 190; // about half the card's width plus its gap from the star

async function boot() {
  const started = performance.now();
  const catalog = await loadCatalog(`${import.meta.env.BASE_URL}data/movies.json`);

  let selected = -1;
  const select = (idx: number, fly = true) => {
    selected = idx;
    galaxy.select(idx, fly);
    labels.selected = idx;
    // Slide the focused star left so the card fits beside it; on phones the card docks below instead.
    const docked = window.innerWidth <= 640;
    if (idx < 0) galaxy.setViewShift(0, 0);
    else if (docked) galaxy.setViewShift(0, window.innerHeight * 0.22);
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
      labels.avoid = card.update();
      labels.update();
    },
  });
  const labels = new Labels($("#labels"), catalog, galaxy);
  const card = new Card($("#card"), catalog, galaxy, (idx) => select(idx), () => select(-1));
  new Search($<HTMLInputElement>("#search"), $<HTMLUListElement>("#search-results"), catalog, (idx) => select(idx));

  buildLegend(catalog.genres, catalog.movies.map((m) => m.g), (filter) => galaxy.setGenreFilter(filter));

  $("#count").textContent = catalog.movies.length.toLocaleString();
  $("#about-dims").textContent = String(catalog.meta.dim);
  $("#about-dims-2").textContent = String(catalog.meta.dim);
  $("#reset").addEventListener("click", () => {
    select(-1);
    galaxy.resetView();
  });
  const about = $<HTMLDialogElement>("#about");
  $("#about-open").addEventListener("click", () => about.showModal());
  about.addEventListener("click", (ev) => {
    if (ev.target === about || (ev.target as HTMLElement).matches("[data-close]")) about.close();
  });
  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && selected >= 0 && !about.open && document.activeElement?.id !== "search") select(-1);
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
  const wait = Math.max(0, MIN_LOADER_MS - (performance.now() - started));
  setTimeout(() => {
    document.body.classList.add("ready");
    if (fromHash >= 0) {
      setTimeout(() => select(fromHash), 900);
    }
  }, wait);
}

function buildLegend(genres: string[], movieGenres: number[][], onChange: (filter: Set<number>) => void) {
  const list = $("#legend-list");
  const counts = genres.map((_, g) => movieGenres.filter((gs) => gs.includes(g)).length);
  const active = new Set<number>();
  const clear = $<HTMLButtonElement>("#legend-clear");
  const sync = () => {
    for (const btn of list.querySelectorAll<HTMLButtonElement>("button")) {
      const on = active.has(Number(btn.dataset.genre));
      btn.setAttribute("aria-pressed", String(on));
    }
    list.classList.toggle("filtering", active.size > 0);
    clear.hidden = active.size === 0;
    onChange(active);
  };
  genres.forEach((name, g) => {
    const btn = document.createElement("button");
    btn.className = "legend-chip";
    btn.dataset.genre = String(g);
    btn.style.setProperty("--c", genreColor(name));
    btn.setAttribute("aria-pressed", "false");
    btn.innerHTML = `<span class="genre-dot"></span><span></span><span class="legend-count"></span>`;
    btn.children[1].textContent = name;
    btn.children[2].textContent = String(counts[g]);
    btn.addEventListener("click", () => {
      active.has(g) ? active.delete(g) : active.add(g);
      sync();
    });
    list.append(btn);
  });
  clear.addEventListener("click", () => {
    active.clear();
    sync();
  });
  $("#legend-toggle").addEventListener("click", () => $("#legend").classList.toggle("collapsed"));
  if (window.innerWidth < 1100 || window.innerHeight < 760) $("#legend").classList.add("collapsed");
}

boot().catch((err) => {
  console.error(err);
  $("#loader-text").textContent = "The projector jammed. Couldn't load the map data.";
  document.body.classList.add("failed");
});
