"""Per-film data for the server, from galaxy/data/films.npz (written by ml/scripts/export_map.py).

Rows are the map's film indices: the position in movies.json, the same number as #m=<idx> links.
"""

import json
from dataclasses import dataclass
from functools import cache
from pathlib import Path

import numpy as np

DATA = Path(__file__).resolve().parent / "data"
FILMS = DATA / "films.npz"
TITLES = DATA / "titles.json"  # [year, title, *alternate titles] per film
WIKIPEDIA = DATA / "wikipedia.json"  # written by scripts/link_wikipedia.py

# Reliability tiers in films.npz, from each film's training rating count (thresholds live in the export).
TIER_MAP = 1  # drawn on the map
TIER_RECOMMEND = 2  # trusted as a recommendation, a neighbour or a landmark for placing people


@dataclass(frozen=True)
class Model:
    """The trained model's film side: prediction = global_mean + user bias + bias + user . vectors."""

    version: str
    global_mean: float
    vectors: np.ndarray  # (films, dim) raw vectors
    bias: np.ndarray
    tier: np.ndarray
    xyz: np.ndarray  # map positions


@cache
def _data():
    return np.load(FILMS)


@cache
def vectors() -> tuple[np.ndarray, np.ndarray]:
    """(unit vectors, ratings count) per film."""
    return _data()["unit"].astype(np.float32), _data()["n_ratings"]


@cache
def model() -> Model:
    d = _data()
    unit, _ = vectors()
    return Model(
        version=str(d["model_version"]),
        global_mean=float(d["global_mean"]),
        vectors=unit * d["norm"][:, None],
        bias=d["bias"],
        tier=d["tier"],
        xyz=d["xyz"],
    )


@cache
def titles() -> list[list]:
    """[year or None, title, *alternate titles] per film."""
    return json.loads(TITLES.read_text())["films"]


@cache
def ids() -> tuple[np.ndarray, np.ndarray]:
    """(TMDB id, IMDb number without "tt") per film; -1 where MovieLens has no link."""
    return _data()["tmdb"], _data()["imdb"]


@cache
def wikipedia_titles() -> dict[int, str]:
    """English Wikipedia article title per film, for films that have one."""
    if not WIKIPEDIA.exists():
        return {}
    return {int(i): title for i, title in json.loads(WIKIPEDIA.read_text()).items()}


def count() -> int:
    return len(ids()[0])
