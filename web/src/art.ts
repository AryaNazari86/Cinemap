// Poster and backdrop URLs from the Django /api/art/ endpoint (Wikipedia, or TMDB with a key).
export interface Art {
  poster: string | null;
  backdrop: string | null;
}

const MAX_FILMS = 24; // matches galaxy/views.py
const endpoint = document.body.dataset.artUrl ?? "";
const known = new Map<number, Promise<Art | null>>();

/** Artwork per film index; null when there is none. Repeat calls reuse earlier requests. */
export function artFor(films: number[]): Map<number, Promise<Art | null>> {
  const fresh = [...new Set(films)].filter((i) => !known.has(i));
  for (let i = 0; i < fresh.length; i += MAX_FILMS) {
    const batch = fresh.slice(i, i + MAX_FILMS);
    const request = fetchBatch(batch);
    for (const film of batch) known.set(film, request.then((res) => res[film] ?? null));
  }
  return new Map(films.map((i) => [i, known.get(i)!]));
}

async function fetchBatch(films: number[]): Promise<Record<string, Art>> {
  try {
    const res = await fetch(`${endpoint}?films=${films.join(",")}`);
    if (!res.ok) throw new Error(String(res.status));
    return await res.json();
  } catch {
    // Forget failures so a later click can retry.
    for (const film of films) known.delete(film);
    return {};
  }
}
