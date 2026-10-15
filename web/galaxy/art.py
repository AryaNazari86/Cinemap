"""Film artwork, looked up on demand and cached so each film is fetched rarely.

Two sources:
- Wikipedia (default, no key): each film's article (matched ahead of time by
  scripts/link_wikipedia.py) has the poster as its lead image. Posters only, ~250px wide.
- TMDB, when TMDB_READ_TOKEN or TMDB_API_KEY is set: larger posters plus backdrops.
"""

import json
import logging
import ssl
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import certifi
from django.conf import settings
from django.core.cache import cache

from . import films

log = logging.getLogger(__name__)

CACHE_SECONDS = 7 * 24 * 3600
TIMEOUT_SECONDS = 6
# Wikimedia asks API clients to identify themselves.
USER_AGENT = "Cinemap/0.1 (https://github.com/AryaNazari86/Cinemap)"
# Some Python installs (python.org's macOS builds) ship without CA certificates.
SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())
TMDB_API = "https://api.themoviedb.org/3/movie/"
TMDB_IMAGES = "https://image.tmdb.org/t/p/"
NO_ART = {"poster": None, "backdrop": None}


def source() -> str:
    return "tmdb" if settings.TMDB_READ_TOKEN or settings.TMDB_API_KEY else "wikipedia"


def art_for(film_idxs: list[int]) -> dict[int, dict]:
    """{film index: {"poster": url | None, "backdrop": url | None}} for each film."""
    src = source()
    keys = {i: f"art:{src}:{i}" for i in film_idxs}
    found = cache.get_many(keys.values())
    result = {i: found[k] for i, k in keys.items() if k in found}
    missing = [i for i in film_idxs if i not in result]
    if missing:
        fetched = _from_tmdb(missing) if src == "tmdb" else _from_wikipedia(missing)
        # A network error leaves None: don't cache it, so the next request retries.
        cache.set_many({keys[i]: art for i, art in fetched.items() if art is not None}, CACHE_SECONDS)
        result.update({i: art or NO_ART for i, art in fetched.items()})
    return result


def _get_json(url: str, headers: dict | None = None):
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json", **(headers or {})})
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS, context=SSL_CONTEXT) as res:
        return json.load(res)


# ---------- Wikipedia ----------

def _from_wikipedia(film_idxs: list[int]) -> dict[int, dict | None]:
    titles = films.wikipedia_titles()
    linked = {i: titles[i] for i in film_idxs if i in titles}
    result: dict[int, dict | None] = {i: NO_ART for i in film_idxs if i not in linked}
    try:
        images = _wikipedia_images(list(set(linked.values())))
    except (urllib.error.URLError, TimeoutError, ValueError, KeyError) as err:
        log.warning("Wikipedia lookup failed: %s", err)
        return {**result, **{i: None for i in linked}}
    result.update({i: {"poster": images.get(title), "backdrop": None} for i, title in linked.items()})
    return result


def _wikipedia_images(titles: list[str]) -> dict[str, str]:
    """Article title -> lead image URL. Posters are non-free, so pilicense=any is needed."""
    if not titles:
        return {}
    params = {
        "action": "query",
        "prop": "pageimages",
        "piprop": "thumbnail",
        "pithumbsize": 500,
        "pilicense": "any",
        "titles": "|".join(titles),
        "redirects": 1,
        "format": "json",
        "formatversion": 2,
    }
    data = _get_json("https://en.wikipedia.org/w/api.php?" + urllib.parse.urlencode(params))["query"]
    # Map each requested title through normalization and redirects to the page it landed on.
    renamed = {r["from"]: r["to"] for r in data.get("normalized", []) + data.get("redirects", [])}
    by_page = {p["title"]: p["thumbnail"]["source"] for p in data.get("pages", []) if "thumbnail" in p}
    images = {}
    for title in titles:
        final = title
        while final in renamed:
            final = renamed[final]
        if final in by_page:
            images[title] = by_page[final].split("?", 1)[0]
    return images


# ---------- TMDB ----------

def _from_tmdb(film_idxs: list[int]) -> dict[int, dict | None]:
    tmdb, _ = films.ids()
    with ThreadPoolExecutor(max_workers=min(8, len(film_idxs))) as pool:
        return dict(zip(film_idxs, pool.map(lambda i: _tmdb_one(int(tmdb[i])), film_idxs)))


def _tmdb_one(tmdb_id: int) -> dict | None:
    if tmdb_id < 0:
        return NO_ART
    url = TMDB_API + str(tmdb_id)
    headers = {}
    if settings.TMDB_READ_TOKEN:
        headers["Authorization"] = f"Bearer {settings.TMDB_READ_TOKEN}"
    else:
        url += "?" + urllib.parse.urlencode({"api_key": settings.TMDB_API_KEY})
    try:
        data = _get_json(url, headers)
    except urllib.error.HTTPError as err:
        if err.code == 404:
            return NO_ART
        # 401 means the key is wrong; 429 means TMDB is rate limiting us.
        log.warning("TMDB returned %s for movie %s", err.code, tmdb_id)
        return None
    except (urllib.error.URLError, TimeoutError, ValueError):
        return None
    poster, backdrop = data.get("poster_path"), data.get("backdrop_path")
    return {
        "poster": TMDB_IMAGES + "w500" + poster if poster else None,
        "backdrop": TMDB_IMAGES + "w780" + backdrop if backdrop else None,
    }
