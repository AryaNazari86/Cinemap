"""Export trained movie embeddings as the point cloud the website renders.

Reads the movie vectors from a saved MatrixFactorization state dict, squashes
them to 3D with UMAP for the map layout, and finds each movie's nearest
neighbours in the full embedding space. Writes one JSON file for the frontend.

    python web/scripts/export_map.py                  # 32M model (default)
    python web/scripts/export_map.py \
        --model models/mf_small.pt \
        --processed data/processed/ml-latest-small \
        --raw data/raw/ml-latest-small
"""

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
import torch
import umap

ROOT = Path(__file__).resolve().parents[2]

# Articles MovieLens moves to the end of a title, e.g. "Usual Suspects, The".
ARTICLES = "The|A|An|Le|La|Les|L'|Il|Lo|I|Gli|El|Los|Las|Un|Une|Una|Der|Die|Das|Den|Det|De|O|Os"
N_NEIGHBORS = 12
MAP_RADIUS = 100.0


def parse_titles(movies):
    title = movies["title"].str.strip()
    year = title.str.extract(r"\((\d{4})\)\)?$")[0].astype("Int64")
    name = title.str.replace(r"\s*\(\d{4}\)\)?$", "", regex=True)
    name = name.str.replace(r"(?<=\S)(\s*\([^()]*\))+$", "", regex=True)
    name = name.str.replace(rf"^(.*), ({ARTICLES})$", r"\2 \1", regex=True)
    name = name.str.replace(r"^(L') ", r"\1", regex=True)
    return name, year


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


def nearest_neighbors(vectors, k, chunk=2048):
    unit = vectors / np.linalg.norm(vectors, axis=1, keepdims=True).clip(min=1e-8)
    idx = np.empty((len(unit), k), dtype=np.int64)
    sim = np.empty((len(unit), k), dtype=np.float32)
    for start in range(0, len(unit), chunk):
        block = unit[start : start + chunk] @ unit.T
        block[np.arange(len(block)), np.arange(start, start + len(block))] = -np.inf
        top = np.argpartition(-block, k, axis=1)[:, :k]
        top_sim = np.take_along_axis(block, top, axis=1)
        order = np.argsort(-top_sim, axis=1)
        idx[start : start + chunk] = np.take_along_axis(top, order, axis=1)
        sim[start : start + chunk] = np.take_along_axis(top_sim, order, axis=1)
    return idx, sim


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="models/mf_32m.pt")
    parser.add_argument("--processed", default="data/processed/ml-32m")
    parser.add_argument("--raw", default="data/raw/ml-32m")
    parser.add_argument("--out", default="web/galaxy/static/galaxy/data/movies.json")
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    state = torch.load(ROOT / args.model, map_location="cpu")
    vectors = state["movie_vectors.weight"].numpy().astype(np.float32)
    n_movies, dim = vectors.shape

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
    movies["name"], movies["year"] = parse_titles(movies)

    ratings = pd.read_csv(processed / "train.csv", usecols=["movie_idx", "rating"])
    stats = (
        ratings.groupby("movie_idx")["rating"]
        .agg(["size", "mean"])
        .reindex(range(n_movies))
    )
    movies["n_ratings"] = stats["size"].fillna(0).astype(int).values
    movies["avg_rating"] = stats["mean"].values

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

    print(f"UMAP: {n_movies:,} movies x {dim} dims -> 3D")
    xyz = layout_3d(vectors, args.seed)
    print(f"nearest neighbours (k={N_NEIGHBORS}, cosine)")
    nb_idx, nb_sim = nearest_neighbors(vectors, N_NEIGHBORS)

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
            "dataset": Path(args.processed).name,
            "n_movies": n_movies,
            "dim": dim,
        },
        "genres": genres,
        "movies": records,
    }
    out.write_text(json.dumps(payload, separators=(",", ":"), ensure_ascii=False))
    print(f"wrote {out.relative_to(ROOT)} ({out.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
