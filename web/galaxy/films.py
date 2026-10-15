"""Per-film data for the server, from galaxy/data/films.npz (written by ml/scripts/export_map.py).

Rows are the map's film indices: the position in movies.json, the same number as #m=<idx> links.
"""

import json
from functools import cache
from pathlib import Path

import numpy as np

DATA = Path(__file__).resolve().parent / "data"
FILMS = DATA / "films.npz"
WIKIPEDIA = DATA / "wikipedia.json"  # written by scripts/link_wikipedia.py


@cache
def _data():
    return np.load(FILMS)


@cache
def vectors() -> tuple[np.ndarray, np.ndarray]:
    """(unit vectors, ratings count) per film."""
    return _data()["unit"].astype(np.float32), _data()["n_ratings"]


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
