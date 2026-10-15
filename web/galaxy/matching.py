"""Match imported (title, year) pairs to map films.

Every film's title and its MovieLens alternates (original-language titles, "a.k.a."s) are
keys. A title matches when a key agrees after normalize() and the years are within
YEAR_SLACK, since release years differ between festival and theatrical dates. Looser
passes follow for what's left: without a leading article or spaces ("Oldboy" for "Old
Boy"); the full title with WIDE_YEAR_SLACK when only one film fits (MovieLens dates
2022's delayed "Death on the Nile" 2020); then MovieLens's title before its subtitle
("Star Wars: Episode IV - A New Hope" for Letterboxd's "Star Wars").
"""

import re
import unicodedata
from collections import defaultdict
from dataclasses import dataclass
from datetime import date
from functools import cache

from . import films

YEAR_SLACK = 1
WIDE_YEAR_SLACK = 2  # only for a single candidate
LEADING_ARTICLE = re.compile(r"^(the|a|an) ")
SUBTITLE = re.compile(r"\s*(:| - | – ).*$")


def _bare(key: str) -> str:
    return LEADING_ARTICLE.sub("", key).replace(" ", "")


def normalize(text: str) -> str:
    """Lowercase ASCII words: accents, apostrophes and punctuation dropped, "&" read as "and"."""
    text = unicodedata.normalize("NFKD", text)
    text = "".join(c for c in text if not unicodedata.combining(c)).lower()
    text = text.replace("&", " and ")
    text = re.sub(r"['’`]", "", text)
    return " ".join(re.sub(r"[^a-z0-9]+", " ", text).split())


@dataclass(frozen=True)
class Match:
    film: int
    rating: float
    date: date | None


@dataclass(frozen=True)
class Matches:
    matched: list[Match]
    unmatched: list[tuple[str, int | None]]  # (name, year) as uploaded

    @property
    def rate(self) -> float:
        total = len(self.matched) + len(self.unmatched)
        return len(self.matched) / total if total else 0.0


@cache
def _index() -> tuple[dict, dict, dict]:
    """normalized key -> [(film, year)] for full titles, bare titles (_bare) and pre-subtitle titles."""
    exact, bare, short = defaultdict(list), defaultdict(list), defaultdict(list)
    for film, (year, *names) in enumerate(films.titles()):
        keys = {normalize(n) for n in names} - {""}
        for key in keys:
            exact[key].append((film, year))
            bare[_bare(key)].append((film, year))
        for name in names:
            key = normalize(SUBTITLE.sub("", name))
            if key and key not in keys:
                short[key].append((film, year))
    return dict(exact), dict(bare), dict(short)


def _pick(
    candidates: list[tuple[int, int | None]], year: int | None, unique: bool, slack: int = YEAR_SLACK
) -> int | None:
    """The candidate whose year fits best; most rated on ties. None if nothing fits (or, when unique, if several do)."""
    if not candidates:
        return None
    if year is None:
        fits = [(0, film) for film, _ in candidates]
    else:
        fits = [(abs(y - year), film) for film, y in candidates if y is not None and abs(y - year) <= slack]
        # A MovieLens film without a year can only match on title, and only if it's the sole candidate.
        if not fits and len(candidates) == 1 and candidates[0][1] is None:
            fits = [(0, candidates[0][0])]
    films_fitting = {film for _, film in fits}
    if not fits or (unique and len(films_fitting) > 1):
        return None
    _, n_ratings = films.vectors()
    return min(fits, key=lambda f: (f[0], -n_ratings[f[1]]))[1]


def match_film(name: str, year: int | None) -> int | None:
    exact, bare, short = _index()
    key = normalize(name)
    if not key:
        return None
    film = _pick(exact.get(key, []), year, unique=False)
    if film is None:
        film = _pick(bare.get(_bare(key), []), year, unique=False)
    # The loosest passes insist on a year and a single candidate.
    if film is None and year is not None:
        film = _pick(exact.get(key, []), year, unique=True, slack=WIDE_YEAR_SLACK)
    if film is None and year is not None:
        film = _pick(short.get(key, []), year, unique=True)
    return film


def match_ratings(rows) -> Matches:
    """Match letterboxd.Rating rows. A film rated twice (rows matching the same film) keeps the latest rating."""
    by_film: dict[int, Match] = {}
    unmatched = []
    for row in rows:
        film = match_film(row.name, row.year)
        if film is None:
            unmatched.append((row.name, row.year))
            continue
        prev = by_film.get(film)
        if prev is None or (row.date and (prev.date is None or row.date >= prev.date)):
            by_film[film] = Match(film, row.rating, row.date)
    return Matches(list(by_film.values()), unmatched)
