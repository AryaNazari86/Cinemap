// Shape of galaxy/static/galaxy/data/movies.json, written by scripts/export_map.py.
export interface RawMovie {
  t: string; // display title
  y: number | null; // year
  g: number[]; // genre ids
  pg: number; // primary genre id (rarest of its genres), -1 if none
  n: number; // training ratings
  r: number | null; // average training rating
  tm: number | null; // TMDB id
  im: string | null; // IMDb id, without the "tt"
  p: [number, number, number]; // 3D map position
  nb: number[]; // nearest neighbours in the full embedding, closest first
  ns: number[]; // cosine similarity to each neighbour
}

export interface MapData {
  meta: { model: string; dataset: string; n_movies: number; dim: number };
  genres: string[];
  movies: RawMovie[];
}

export interface Movie extends RawMovie {
  idx: number;
  searchKey: string;
}

export interface Catalog {
  meta: MapData["meta"];
  genres: string[];
  movies: Movie[];
  /** Movie indices, most rated first. */
  byPopularity: number[];
}

const GENRE_COLORS: Record<string, string> = {
  Drama: "#f0a64a",
  Comedy: "#ffd966",
  Action: "#ff6b3d",
  Thriller: "#7b86ff",
  Adventure: "#5fd39a",
  "Sci-Fi": "#42d4f4",
  Romance: "#ff7eb0",
  Crime: "#e04f5f",
  Fantasy: "#c79bff",
  Children: "#b4e36b",
  Mystery: "#5aa8ff",
  Animation: "#ffa37a",
  Horror: "#b14bff",
  War: "#c2b98a",
  Musical: "#ffb8d9",
  Western: "#d79a5f",
  "Film-Noir": "#c8d0dc",
  Documentary: "#7fe3cf",
};
const FALLBACK_COLOR = "#d9d4c7";

export function genreColor(name: string | undefined): string {
  return (name && GENRE_COLORS[name]) || FALLBACK_COLOR;
}

export function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export async function loadCatalog(url: string): Promise<Catalog> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url} (${res.status})`);
  const data: MapData = await res.json();
  const movies = data.movies.map((m, idx) => ({ ...m, idx, searchKey: normalize(m.t) }));
  const byPopularity = movies.map((m) => m.idx).sort((a, b) => movies[b].n - movies[a].n);
  return { meta: data.meta, genres: data.genres, movies, byPopularity };
}
