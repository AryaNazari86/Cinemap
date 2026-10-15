"""Match every film to its English Wikipedia article, once, ahead of time.

Wikidata's query service maps IMDb ids to articles but is too flaky to call on every
page view, so this runs offline with retries and writes galaxy/data/wikipedia.json
({film index: article title}). The server then needs only Wikipedia itself for posters.
Rerun after exporting a new map:

    ../.venv/bin/python scripts/link_wikipedia.py
"""

import json
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import certifi
import numpy as np

WEB = Path(__file__).resolve().parents[1]
FILMS = WEB / "galaxy" / "data" / "films.npz"
OUT = WEB / "galaxy" / "data" / "wikipedia.json"
BATCH = 250
USER_AGENT = "Cinemap/0.1 (https://github.com/AryaNazari86/Cinemap)"
SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())


def query(imdb_ids: list[str]) -> dict[str, str]:
    values = " ".join(f'"{i}"' for i in imdb_ids)
    sparql = (
        f"SELECT ?imdb ?article WHERE {{ VALUES ?imdb {{ {values} }} ?film wdt:P345 ?imdb . "
        "?article schema:about ?film ; schema:isPartOf <https://en.wikipedia.org/> . }"
    )
    url = "https://query.wikidata.org/sparql?" + urllib.parse.urlencode({"query": sparql, "format": "json"})
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    for attempt in range(6):
        try:
            with urllib.request.urlopen(request, timeout=60, context=SSL_CONTEXT) as res:
                rows = json.load(res)["results"]["bindings"]
            break
        except (urllib.error.URLError, TimeoutError, ValueError) as err:
            wait = 2 ** attempt
            print(f"  retry in {wait}s ({err})", file=sys.stderr)
            time.sleep(wait)
    else:
        raise SystemExit("Wikidata kept failing; try again later.")
    titles = {}
    for row in rows:
        article = urllib.parse.unquote(row["article"]["value"].rsplit("/wiki/", 1)[1]).replace("_", " ")
        titles.setdefault(row["imdb"]["value"], article)
    return titles


def main():
    imdb = np.load(FILMS)["imdb"]
    film_by_imdb = {f"tt{n:07d}": i for i, n in enumerate(imdb) if n >= 0}
    ids = list(film_by_imdb)
    linked: dict[int, str] = {}
    for start in range(0, len(ids), BATCH):
        for imdb_id, title in query(ids[start:start + BATCH]).items():
            linked[film_by_imdb[imdb_id]] = title
        print(f"{min(start + BATCH, len(ids)):,}/{len(ids):,} films checked, {len(linked):,} linked")
        time.sleep(1)  # be gentle with a shared public service
    OUT.write_text(json.dumps({str(i): t for i, t in sorted(linked.items())}, ensure_ascii=False, separators=(",", ":")))
    print(f"wrote {OUT.relative_to(WEB)}: {len(linked):,} of {len(imdb):,} films have a Wikipedia article")


if __name__ == "__main__":
    main()
