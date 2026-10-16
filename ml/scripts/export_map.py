"""Export trained movie embeddings as the point cloud the website renders.

This is the only hand-off between ml/ and web/. It reads a model from ml/models and writes:

- web/galaxy/static/galaxy/data/movies.json: the map the browser draws.
- web/galaxy/data/films.npz: what Django needs to compare films, find posters and fold a new
  person into the model (see FILMS_NPZ below). Never the user table.
- web/galaxy/data/titles.json: [year, title, *alternate titles] per film, for matching
  imported ratings. Titles are cleaned ("Usual Suspects, The" -> "The Usual Suspects") but
  not normalized; the server normalizes both sides with one function.

Squashes the movie vectors to 3D with UMAP for the map layout and finds each movie's nearest
neighbours in the full embedding space.

    python ml/scripts/export_map.py                   # 32M model (default)
    python ml/scripts/export_map.py \
        --model ml/models/mf_small.pt \
        --processed ml/data/processed/ml-latest-small \
        --raw ml/data/raw/ml-latest-small
"""

import argparse
import hashlib
import json
import re
from pathlib import Path

import numpy as np
import pandas as pd
import torch
import umap

ROOT = Path(__file__).resolve().parents[2]  # repo root; paths below are relative to it

# Articles MovieLens moves to the end of a title, e.g. "Usual Suspects, The".
ARTICLES = "The|A|An|Le|La|Les|L'|Il|Lo|I|Gli|El|Los|Las|Un|Une|Una|Der|Die|Das|Den|Det|De|O|Os"
ARTICLE_LAST = re.compile(rf"^(.*), ({ARTICLES})$")
# "(1995)" at the end, or the first year of a range like "(2006–2007)"; a few titles have a stray ")".
YEAR_END = re.compile(r"\s*\((\d{4})(?:[–-]\d{4})?\)\)?$")
# A trailing parenthetical is an alternate title: "Postman, The (Postino, Il)".
LAST_PAREN = re.compile(r"(?<=\S)\s*\(([^()]*)\)$")
AKA = re.compile(r"^a\.k\.a\.\s*", re.IGNORECASE)

N_NEIGHBORS = 12
MAP_RADIUS = 100.0

# Reliability tiers from a film's training rating count. Rarely rated films have barely
# trained vectors, so they are kept out of the places where a wrong vector shows.
TIER_HIDDEN, TIER_MAP, TIER_RECOMMEND = 0, 1, 2
MAP_MIN_RATINGS = 50  # drawn on the map
RECOMMEND_MIN_RATINGS = 200  # eligible as a recommendation or a "more like this" neighbour


def article_first(name):
    name = ARTICLE_LAST.sub(r"\2 \1", name)
    return re.sub(r"^(L') ", r"\1", name)


def split_title(title):
    """'Postman, The (Postino, Il) (1994)' -> ('The Postman', 1994, ['Il Postino'])."""
    title = title.strip()
    year_match = YEAR_END.search(title)
    year = int(year_match.group(1)) if year_match else None
    rest = title[: year_match.start()] if year_match else title
    alternates = []
    while paren := LAST_PAREN.search(rest):
        alternates.insert(0, paren.group(1))
        rest = rest[: paren.start()]
    name = article_first(rest.strip())
    alternates = [article_first(AKA.sub("", a).strip()) for a in alternates]
    return name, year, [a for a in dict.fromkeys(alternates) if a and a != name]


def layout_3d(vectors, seed):
    reducer = umap.UMAP(
        n_components=3,
        n_neighbors=10,
        min_dist=0.05,
        metric="cosine",
        random_state=seed,
    )
    xyz = reducer.fit_transform(vectors)
    xyz -= np.median(xyz, axis=0)
    # Scale so 95% of movies sit inside MAP_RADIUS; the rest are outliers drifting further out.
    xyz *= MAP_RADIUS / np.percentile(np.linalg.norm(xyz, axis=1), 95)
    return xyz


def nearest_neighbors(unit, k, candidates, chunk=2048):
    """Each film's k most similar films among `candidates` (sorted indices), closest first."""
    pool = unit[candidates]
    idx = np.empty((len(unit), k), dtype=np.int64)
    sim = np.empty((len(unit), k), dtype=np.float32)
    for start in range(0, len(unit), chunk):
        block = unit[start : start + chunk] @ pool.T
        # A film is never its own neighbour.
        rows = np.arange(start, start + len(block))
        pos = np.searchsorted(candidates, rows).clip(max=len(candidates) - 1)
        own = candidates[pos] == rows
        block[own.nonzero()[0], pos[own]] = -np.inf
        top = np.argpartition(-block, k, axis=1)[:, :k]
        top_sim = np.take_along_axis(block, top, axis=1)
        order = np.argsort(-top_sim, axis=1)
        idx[start : start + chunk] = candidates[np.take_along_axis(top, order, axis=1)]
        sim[start : start + chunk] = np.take_along_axis(top_sim, order, axis=1)
    return idx, sim


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="ml/models/mf_32m.pt")
    parser.add_argument("--processed", default="ml/data/processed/ml-32m")
    parser.add_argument("--raw", default="ml/data/raw/ml-32m")
    parser.add_argument("--out", default="web/galaxy/static/galaxy/data/movies.json")
    parser.add_argument("--films-out", default="web/galaxy/data/films.npz")
    parser.add_argument("--titles-out", default="web/galaxy/data/titles.json")
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    state = torch.load(ROOT / args.model, map_location="cpu")
    vectors = state["movie_vectors.weight"].numpy().astype(np.float32)
    biases = state["movie_biases.weight"].numpy().astype(np.float32).ravel()
    n_movies, dim = vectors.shape
    # Ties a saved profile to the exact weights it was computed with.
    digest = hashlib.sha256(vectors.tobytes() + biases.tobytes()).hexdigest()
    model_version = f"{Path(args.model).stem}-{digest[:8]}"

    processed = ROOT / args.processed
    movies = (
        pd.read_csv(processed / "movie_table.csv")
        .sort_values("movie_idx")
        .reset_index(drop=True)
    )
    assert (
        len(movies) == n_movies and (movies["movie_idx"] == np.arange(n_movies)).all()
    )

    links = pd.read_csv(
        ROOT / args.raw / "links.csv", dtype={"imdbId": "string", "tmdbId": "Int64"}
    )
    movies = movies.merge(links, on="movieId", how="left")
    parsed = movies["title"].map(split_title)
    movies["name"] = parsed.str[0]
    movies["year"] = parsed.str[1].astype("Int64")
    alternates = parsed.str[2]

    ratings = pd.read_csv(processed / "train.csv", usecols=["movie_idx", "rating"])
    # The model's global mean isn't in its state dict; training used the train split's mean.
    global_mean = float(ratings["rating"].mean())
    stats = (
        ratings.groupby("movie_idx")["rating"]
        .agg(["size", "mean"])
        .reindex(range(n_movies))
    )
    movies["n_ratings"] = stats["size"].fillna(0).astype(int).values
    movies["avg_rating"] = stats["mean"].values
    n_ratings = movies["n_ratings"].to_numpy()
    tier = np.select(
        [n_ratings >= RECOMMEND_MIN_RATINGS, n_ratings >= MAP_MIN_RATINGS],
        [TIER_RECOMMEND, TIER_MAP],
        TIER_HIDDEN,
    ).astype(np.int8)

    # A movie's colour on the map is its rarest genre, the most telling one:
    # Toy Story is Animation rather than Comedy.
    genre_lists = (
        movies["genres"]
        .fillna("")
        .str.split("|")
        .apply(
            lambda gs: [g for g in gs if g and g not in ("(no genres listed)", "IMAX")]
        )
    )
    genre_counts = genre_lists.explode().value_counts()
    genres = list(genre_counts.index)
    genre_id = {g: i for i, g in enumerate(genres)}

    norm = np.linalg.norm(vectors, axis=1).clip(min=1e-8)
    unit = vectors / norm[:, None]
    reliable = tier >= TIER_RECOMMEND

    print(f"UMAP: {n_movies:,} movies x {dim} dims -> 3D")
    xyz = layout_3d(vectors, args.seed)
    print(f"nearest neighbours (k={N_NEIGHBORS}, cosine, among {reliable.sum():,} films)")
    nb_idx, nb_sim = nearest_neighbors(unit, N_NEIGHBORS, np.flatnonzero(reliable))

    records = []
    for i, row in movies.iterrows():
        gs = genre_lists[i]
        records.append(
            {
                "t": row["name"],
                "y": None if pd.isna(row["year"]) else int(row["year"]),
                "g": [genre_id[g] for g in gs],
                "pg": genre_id[min(gs, key=lambda g: genre_counts[g])] if gs else -1,
                "n": int(row["n_ratings"]),
                "r": (
                    None
                    if pd.isna(row["avg_rating"])
                    else round(float(row["avg_rating"]), 2)
                ),
                "tm": None if pd.isna(row["tmdbId"]) else int(row["tmdbId"]),
                "im": None if pd.isna(row["imdbId"]) else str(row["imdbId"]),
                "p": [round(float(c), 2) for c in xyz[i]],
                "nb": nb_idx[i].tolist(),
                "ns": [round(float(s), 3) for s in nb_sim[i]],
            }
        )

    out = ROOT / args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "meta": {
            "model": args.model,
            "model_version": model_version,
            "dataset": Path(args.processed).name,
            "n_movies": n_movies,
            "n_users": int(state["user_vectors.weight"].shape[0]),
            "n_ratings": int(movies["n_ratings"].sum()),
            "dim": dim,
            # Training ratings a film needs for each tier; "n" per movie is that count.
            "tiers": {"map": MAP_MIN_RATINGS, "recommend": RECOMMEND_MIN_RATINGS},
        },
        "genres": genres,
        "movies": records,
    }
    out.write_text(json.dumps(payload, separators=(",", ":"), ensure_ascii=False))
    print(f"wrote {out.relative_to(ROOT)} ({out.stat().st_size / 1e6:.1f} MB)")

    # FILMS_NPZ: one row per map film index. Unit vectors are float16: a dot product is the
    # cosine the site reports as "match", and float16 halves the file while moving similarities
    # by well under 0.1 percentage points. The raw vector the model uses is unit * norm.
    films_out = ROOT / args.films_out
    films_out.parent.mkdir(parents=True, exist_ok=True)
    np.savez(
        films_out,
        unit=unit.astype(np.float16),
        norm=norm.astype(np.float32),
        bias=biases,
        global_mean=np.float64(global_mean),
        dim=np.int32(dim),
        model_version=np.str_(model_version),
        n_ratings=movies["n_ratings"].to_numpy(np.int32),
        tier=tier,
        # Map positions, as in movies.json, for placing a new person among the films.
        xyz=xyz.astype(np.float32),
        # -1 where MovieLens has no link; IMDb ids without the "tt" prefix.
        tmdb=movies["tmdbId"].fillna(-1).to_numpy(np.int64),
        imdb=movies["imdbId"].astype("Float64").fillna(-1).to_numpy(np.int64),
    )
    print(f"wrote {films_out.relative_to(ROOT)} ({films_out.stat().st_size / 1e6:.1f} MB)")

    titles_out = ROOT / args.titles_out
    titles = [
        [None if pd.isna(y) else int(y), name, *alts]
        for name, y, alts in zip(movies["name"], movies["year"], alternates)
    ]
    titles_out.write_text(
        json.dumps({"films": titles}, separators=(",", ":"), ensure_ascii=False)
    )
    print(f"wrote {titles_out.relative_to(ROOT)} ({titles_out.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
