// Shape of galaxy/static/galaxy/data/movies.json, written by ml/scripts/export_map.py.
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
  meta: {
    model: string;
    dataset: string;
    n_movies: number;
    n_users?: number; // people behind the ratings; missing in older exports
    n_ratings?: number; // training ratings
    dim: number;
  };
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

// Darker, saturated hues so every genre dot keeps at least 3:1 contrast on the light map (#f3f3f3).
const GENRE_COLORS: Record<string, string> = {
  Drama: "#c25e00",
  Comedy: "#9c7a00",
  Action: "#d9480f",
  Thriller: "#4c5ad6",
  Adventure: "#2b8a3e",
  "Sci-Fi": "#0b7ba3",
  Romance: "#d6336c",
  Crime: "#b02a37",
  Fantasy: "#8e44ad",
  Children: "#5c8a0d",
  Mystery: "#1971c2",
  Animation: "#e8590c",
  Horror: "#6f2dbd",
  War: "#7a7046",
  Musical: "#c2255c",
  Western: "#9c5b27",
  "Film-Noir": "#495057",
  Documentary: "#0b8a74",
};
const FALLBACK_COLOR = "#6b6b6b";

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
