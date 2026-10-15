import csv
import io
import zipfile
from datetime import date
from pathlib import Path
from unittest import mock

import numpy as np
from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import SimpleTestCase, override_settings

from . import art, films, letterboxd, matching, taste
from .letterboxd import LetterboxdError, Rating
from .matching import Match

# Your own Letterboxd ratings.csv, if present, makes the sanity test also run on real taste.
# Only ratings.csv: the rest of an export (profile.csv) holds personal details.
LETTERBOXD_FIXTURE = Path(__file__).resolve().parent / "testdata" / "letterboxd_ratings.csv"
MOVIELENS_LAST_YEAR = 2022  # the 32M snapshot ends October 2023, so 2023 releases are mostly missing

# Four films in 2D: 0 and 1 nearly the same, 2 in between-ish, 3 opposite to 0.
FAKE_UNIT = np.array([[1, 0], [0.96, 0.28], [0.6, 0.8], [-1, 0]], dtype=np.float32)
FAKE_RATINGS = np.array([5000, 5000, 5000, 5000], dtype=np.int32)
FAKE_TMDB = np.array([862, 8844, -1, 603])
FAKE_IMDB = np.array([114709, 113497, 999, -1])

FAKE_TITLES = {0: "Toy Story", 1: "Jumanji"}

fake_films = [
    mock.patch.object(films, "vectors", return_value=(FAKE_UNIT, FAKE_RATINGS)),
    mock.patch.object(films, "ids", return_value=(FAKE_TMDB, FAKE_IMDB)),
    mock.patch.object(films, "wikipedia_titles", return_value=FAKE_TITLES),
]


class FakeFilmsMixin:
    def setUp(self):
        cache.clear()
        for patch in fake_films:
            patch.start()
            self.addCleanup(patch.stop)


@override_settings(TMDB_API_KEY="", TMDB_READ_TOKEN="")
class WikipediaArtTests(FakeFilmsMixin, SimpleTestCase):
    def get(self, films_param):
        return self.client.get("/api/art/", {"films": films_param}, HTTP_HOST="localhost")

    def test_looks_up_linked_articles(self):
        images = {"Toy Story": "https://upload.wikimedia.org/toy.jpg"}
        with mock.patch.object(art, "_wikipedia_images", return_value=images) as get_images:
            res = self.get("0,1,3")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(
            res.json(),
            {
                "0": {"poster": "https://upload.wikimedia.org/toy.jpg", "backdrop": None},
                "1": {"poster": None, "backdrop": None},
                "3": art.NO_ART,  # no Wikipedia article
            },
        )
        self.assertCountEqual(get_images.call_args.args[0], ["Toy Story", "Jumanji"])

    def test_caches_results(self):
        with mock.patch.object(art, "_wikipedia_images", return_value={}) as get_images:
            self.get("0")
            self.get("0")
        self.assertEqual(get_images.call_count, 1)

    def test_network_errors_are_not_cached(self):
        with mock.patch.object(art, "_wikipedia_images", side_effect=TimeoutError) as get_images:
            self.assertEqual(self.get("0").json(), {"0": art.NO_ART})
            self.get("0")
        self.assertEqual(get_images.call_count, 2)

    def test_rejects_bad_films(self):
        for films_param in ["", "abc", "-1", "4", ",".join(str(i % 4) for i in range(30))]:
            with self.subTest(films=films_param):
                expected = 200 if films_param.startswith("0,1,2,3") else 400
                with mock.patch.object(art, "art_for", return_value={}):
                    self.assertEqual(self.get(films_param).status_code, expected)


@override_settings(TMDB_API_KEY="test-key", TMDB_READ_TOKEN="")
class TmdbArtTests(FakeFilmsMixin, SimpleTestCase):
    def test_builds_image_urls(self):
        payload = {"poster_path": "/p.jpg", "backdrop_path": "/b.jpg"}
        with mock.patch.object(art, "_get_json", return_value=payload):
            res = self.client.get("/api/art/", {"films": "0,2"}, HTTP_HOST="localhost").json()
        self.assertEqual(res["0"]["poster"], "https://image.tmdb.org/t/p/w500/p.jpg")
        self.assertEqual(res["0"]["backdrop"], "https://image.tmdb.org/t/p/w780/b.jpg")
        self.assertEqual(res["2"], art.NO_ART)  # no TMDB link


@mock.patch("galaxy.similarity.BETWEEN_SHOWN", 1)
class CompareApiTests(FakeFilmsMixin, SimpleTestCase):
    def get(self, **params):
        return self.client.get("/api/compare/", params, HTTP_HOST="localhost")

    def test_similarity_rank_and_between(self):
        res = self.get(a=0, b=1).json()
        self.assertAlmostEqual(res["similarity"], 0.96, places=3)
        self.assertEqual(res["rank_b_for_a"], 1)
        self.assertEqual(res["closer_than"], 1.0)
        self.assertEqual(res["between"], [2])

    def test_opposite_films_rank_last(self):
        res = self.get(a=0, b=3).json()
        self.assertAlmostEqual(res["similarity"], -1.0, places=3)
        self.assertEqual(res["rank_b_for_a"], 3)
        self.assertEqual(res["closer_than"], 0.0)

    def test_rejects_bad_pairs(self):
        for params in [{}, {"a": 0}, {"a": "x", "b": 1}, {"a": 0, "b": 0}, {"a": 0, "b": 9}, {"a": -1, "b": 1}]:
            with self.subTest(params=params):
                self.assertEqual(self.get(**params).status_code, 400)


def ratings_csv(rows, header=("Date", "Name", "Year", "Letterboxd URI", "Rating")) -> bytes:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(header)
    writer.writerows(rows)
    return buf.getvalue().encode()


def zipped(files: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in files.items():
            archive.writestr(name, data)
    return buf.getvalue()


ROWS = [
    ["2024-03-01", "The Godfather", "1972", "https://boxd.it/x", "5"],
    ["2024-03-02", "Crouching Tiger, Hidden Dragon", "2000", "https://boxd.it/y", "4.5"],
    ["2024-03-03", "Amélie", "2001", "https://boxd.it/z", "3.5"],
]


class LetterboxdParserTests(SimpleTestCase):
    def test_reads_csv(self):
        result = letterboxd.read_upload("ratings.csv", ratings_csv(ROWS))
        self.assertEqual(result.skipped, 0)
        self.assertEqual(result.rows[1], Rating("Crouching Tiger, Hidden Dragon", 2000, 4.5, date(2024, 3, 2)))

    def test_reads_ratings_from_the_export_zip(self):
        export = zipped({"profile.csv": b"Username\nsomeone\n", "ratings.csv": ratings_csv(ROWS), "watched.csv": b"x"})
        self.assertEqual(len(letterboxd.read_upload("letterboxd-someone-2024.zip", export).rows), 3)

    def test_byte_order_mark_and_missing_optional_columns(self):
        content = "\ufeff".encode() + ratings_csv([["Heat", "1995", "4"]], header=("Name", "Year", "Rating"))
        self.assertEqual(letterboxd.read_upload("ratings.csv", content).rows, [Rating("Heat", 1995, 4.0, None)])

    def test_skips_bad_rows(self):
        rows = ROWS + [["2024-01-01", "", "1999", "u", "4"], ["x", "Heat", "1995", "u", "7"], ["x", "Heat", "1995", "u", ""],
                       ["not a date", "Heat", "19x5", "u", "0.5"]]
        result = letterboxd.read_upload("ratings.csv", ratings_csv(rows))
        self.assertEqual(result.skipped, 3)
        self.assertEqual(result.rows[-1], Rating("Heat", None, 0.5, None))

    def test_rejects_other_files(self):
        cases = {
            "wrong columns": ("ratings.csv", ratings_csv([["a", "b"]], header=("Title", "Stars"))),
            "zip without ratings": ("export.zip", zipped({"watched.csv": b"Name,Year\n"})),
            "broken zip": ("export.zip", b"PK\x03\x04 not really a zip"),
            "binary": ("ratings.csv", b"\xff\xfe\x00\x01"),
            "no ratings": ("ratings.csv", ratings_csv([])),
            "other type": ("ratings.json", b"{}"),
        }
        for label, (name, content) in cases.items():
            with self.subTest(label), self.assertRaises(LetterboxdError):
                letterboxd.read_upload(name, content)

    def test_caps_size_and_rows(self):
        with self.assertRaises(LetterboxdError):
            letterboxd.read_upload("ratings.csv", b"x" * (letterboxd.MAX_UPLOAD_BYTES + 1))
        with mock.patch.object(letterboxd, "MAX_ROWS", 2), self.assertRaises(LetterboxdError):
            letterboxd.read_upload("ratings.csv", ratings_csv(ROWS))
        # A zip that inflates past the limit is refused before it is read.
        bomb = zipped({"ratings.csv": b"Name,Year,Rating\n" + b" " * (letterboxd.MAX_CSV_BYTES + 1)})
        with self.assertRaises(LetterboxdError):
            letterboxd.read_upload("export.zip", bomb)


# [year, title, *alternates] per film, as in titles.json.
FAKE_TITLES = [
    [1995, "The Usual Suspects"],
    [2001, "Amelie", "Le Fabuleux destin d'Amélie Poulain"],
    [1977, "Star Wars: Episode IV - A New Hope"],
    [2003, "Old Boy"],
    [1994, "Dumb & Dumber", "Dumb and Dumber"],
    [2005, "Pride and Prejudice"],
    [1940, "Pride and Prejudice"],
    [None, "The Northman"],
    [1998, "Godzilla"],
    [1999, "Godzilla"],
    [1980, "Star Trek: The Motion Picture"],
    [1982, "Star Trek: The Wrath of Khan"],
    [1978, "Death on the Nile"],
    [2020, "Death on the Nile"],
    [2013, "Annie"],
    [2017, "Annie"],
]
FAKE_COUNTS = np.array([100, 100, 100, 100, 100, 100, 100, 100, 50, 900, 100, 100, 100, 100, 100, 100])


class MatchingTests(SimpleTestCase):
    def setUp(self):
        for patch in [
            mock.patch.object(films, "titles", return_value=FAKE_TITLES),
            mock.patch.object(films, "vectors", return_value=(None, FAKE_COUNTS)),
        ]:
            patch.start()
            self.addCleanup(patch.stop)
        matching._index.cache_clear()
        self.addCleanup(matching._index.cache_clear)

    def test_normalize(self):
        self.assertEqual(matching.normalize("  Amélie: L'Été & Co.! "), "amelie lete and co")
        self.assertEqual(matching.normalize("WALL·E"), "wall e")

    def test_matches(self):
        cases = {
            ("The Usual Suspects", 1995): 0,
            ("the usual suspects", 1996): 0,  # a year off is allowed
            ("The Usual Suspects", 1998): None,  # three is not
            ("Amélie", 2001): 1,
            ("Le fabuleux destin d'Amélie Poulain", 2001): 1,  # alternate title
            ("Usual Suspects", 1995): 0,  # without the article
            ("Oldboy", 2003): 3,  # without spaces
            ("Dumb and Dumber", 1994): 4,
            ("Pride & Prejudice", 2005): 5,
            ("Pride & Prejudice", 1940): 6,  # same title, the year decides
            ("Star Wars", 1977): 2,  # MovieLens title before its subtitle
            ("Star Wars", None): None,  # ...but only with a year
            ("Star Trek", 1981): None,  # ...and only when one film fits
            ("The Northman", 2022): 7,  # MovieLens has no year: the title alone, as the only candidate
            ("Godzilla", None): 9,  # no year given: the most rated
            ("Godzilla", 1998): 8,  # an exact year beats a near one, however popular
            ("Death on the Nile", 2022): 13,  # two years off, but the only film that close
            ("Annie", 2015): None,  # two years off and two films that close: too unsure
            ("Some Other Film", 2001): None,
            ("", 2001): None,
        }
        for (name, year), film in cases.items():
            with self.subTest(name=name, year=year):
                self.assertEqual(matching.match_film(name, year), film)

    def test_match_ratings(self):
        rows = [
            Rating("Amélie", 2001, 3.0, date(2020, 1, 1)),
            Rating("Amelie", 2001, 4.5, date(2023, 1, 1)),  # rated again later: this one counts
            Rating("Le fabuleux destin d'Amélie Poulain", 2001, 2.0, date(2021, 1, 1)),
            Rating("Old Boy", 2003, 5.0, None),
            Rating("Nothing Like It", 1990, 1.0, None),
        ]
        result = matching.match_ratings(rows)
        self.assertCountEqual(result.matched, [Match(1, 4.5, date(2023, 1, 1)), Match(3, 5.0, None)])
        self.assertEqual(result.unmatched, [("Nothing Like It", 1990)])
        self.assertAlmostEqual(result.rate, 2 / 3)


def fake_model(n=400, dim=8, seed=0) -> films.Model:
    rng = np.random.default_rng(seed)
    return films.Model(
        version="test",
        global_mean=3.5,
        vectors=rng.normal(0, 0.6, (n, dim)).astype(np.float32),
        bias=rng.normal(0, 0.3, n).astype(np.float32),
        tier=np.full(n, films.TIER_RECOMMEND, dtype=np.int8),
        xyz=rng.normal(0, 50, (n, 3)).astype(np.float32),
    )


class FoldInTests(SimpleTestCase):
    def setUp(self):
        self.model = fake_model()
        patch = mock.patch.object(films, "model", return_value=self.model)
        patch.start()
        self.addCleanup(patch.stop)

    def test_recovers_a_noiseless_person(self):
        rng = np.random.default_rng(1)
        true = taste.Person(rng.normal(0, 0.8, 8).astype(np.float32), 0.4)
        rated = rng.choice(400, 120, replace=False)
        with mock.patch.object(taste, "VECTOR_LAMBDA", 1e-6), mock.patch.object(taste, "BIAS_LAMBDA", 1e-6):
            person = taste.fold_in(rated, taste.predict(true, rated))
        np.testing.assert_allclose(person.vector, true.vector, atol=1e-4)
        self.assertAlmostEqual(person.bias, 0.4, places=4)

    def test_matches_the_ridge_solution(self):
        rng = np.random.default_rng(2)
        rated = rng.choice(400, 30, replace=False)
        ratings = rng.choice(np.arange(1, 11) / 2, 30)
        person = taste.fold_in(rated, ratings)
        # Ridge as least squares on an augmented system: sqrt(lambda) rows pull each weight to 0.
        x = np.hstack([self.model.vectors[rated], np.ones((30, 1))])
        penalty = np.diag(np.sqrt([taste.VECTOR_LAMBDA] * 8 + [taste.BIAS_LAMBDA]))
        y = ratings - 3.5 - self.model.bias[rated]
        expected = np.linalg.lstsq(np.vstack([x, penalty]), np.concatenate([y, np.zeros(9)]), rcond=None)[0]
        np.testing.assert_allclose(person.vector, expected[:-1], atol=1e-4)
        self.assertAlmostEqual(person.bias, expected[-1], places=4)

    def test_confidence(self):
        self.assertEqual([taste.confidence(n) for n in (5, 19, 20, 99, 100)], ["low", "low", "medium", "medium", "high"])


def held_out_rmse(film_idxs, ratings):
    """(fold-in RMSE, bias-only RMSE) on the second half when folding in from the first half."""
    order = np.random.default_rng(0).permutation(len(film_idxs))
    film_idxs, ratings = film_idxs[order], ratings[order]
    half = len(film_idxs) // 2
    person = taste.fold_in(film_idxs[:half], ratings[:half])
    test, truth = film_idxs[half:], ratings[half:]
    model = films.model()
    user_bias = (ratings[:half] - model.global_mean - model.bias[film_idxs[:half]]).mean()
    folded = np.clip(taste.predict(person, test), 0.5, 5)
    biases = np.clip(model.global_mean + user_bias + model.bias[test], 0.5, 5)
    return np.sqrt(((folded - truth) ** 2).mean()), np.sqrt(((biases - truth) ** 2).mean())


class RealModelTests(SimpleTestCase):
    """Sanity checks on the exported model itself (galaxy/data), not fakes."""

    def test_folded_in_person_beats_biases_on_held_out_ratings(self):
        # Someone who loves one corner of the map: their taste points at a real film's vector.
        model = films.model()
        rng = np.random.default_rng(3)
        reliable = np.flatnonzero(model.tier >= films.TIER_RECOMMEND)
        anchor = model.vectors[rng.choice(reliable)]
        true = taste.Person(anchor / np.linalg.norm(anchor) * 0.8, 0.2)
        rated = rng.choice(reliable, 200, replace=False)
        noisy = taste.predict(true, rated) + rng.normal(0, 0.5, 200)
        ratings = np.clip(np.round(noisy * 2) / 2, 0.5, 5)
        folded, biases = held_out_rmse(rated, ratings)
        self.assertLess(folded, biases * 0.95)

    def test_letterboxd_fixture(self):
        if not LETTERBOXD_FIXTURE.exists():
            self.skipTest(f"add your ratings.csv as {LETTERBOXD_FIXTURE.name} to run this")
        rows = letterboxd.read_upload("ratings.csv", LETTERBOXD_FIXTURE.read_bytes()).rows
        matches = matching.match_ratings(rows)
        # MovieLens 32M ends in October 2023, so later films can never match; of the rest, nearly all should.
        catalogued = [r for r in rows if r.year is not None and r.year <= MOVIELENS_LAST_YEAR]
        missed = [(n, y) for n, y in matches.unmatched if y is not None and y <= MOVIELENS_LAST_YEAR]
        self.assertLessEqual(len(missed), len(catalogued) * 0.1, missed)
        film_idxs = np.array([m.film for m in matches.matched])
        ratings = np.array([m.rating for m in matches.matched])
        folded, biases = held_out_rmse(film_idxs, ratings)
        self.assertLess(folded, biases)


class ProfilePreviewApiTests(SimpleTestCase):
    def post(self, content, name="ratings.csv"):
        return self.client.post("/api/profile/preview/", {"file": SimpleUploadedFile(name, content)}, HTTP_HOST="localhost")

    def test_preview(self):
        rows = [["2024-01-01", name, year, "u", rating] for name, year, rating in [
            ("The Godfather", 1972, 5), ("Goodfellas", 1990, 4.5), ("Taxi Driver", 1976, 4), ("Heat", 1995, 4.5),
            ("Fargo", 1996, 4), ("Mamma Mia!", 2008, 1), ("Twilight", 2008, 0.5), ("Not A Real Film", 2020, 3),
        ]]
        res = self.post(zipped({"ratings.csv": ratings_csv(rows)}), name="letterboxd-export.zip")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res["Cache-Control"], "no-store")
        data = res.json()
        self.assertEqual(data["match"]["matched"], 7)
        self.assertEqual(data["match"]["unmatched"], [{"name": "Not A Real Film", "year": 2020}])
        self.assertEqual(data["confidence"], "low")
        self.assertEqual(len(data["position"]), 3)
        self.assertEqual(len(data["axes"]), 10)
        self.assertEqual(len(data["ratings"]), 7)
        recs = data["recommendations"]
        self.assertEqual(len(recs), taste.RECOMMENDATIONS)
        rated = {r[0] for r in data["ratings"]}
        model = films.model()
        for rec in recs:
            self.assertNotIn(rec["film"], rated)
            self.assertGreaterEqual(model.tier[rec["film"]], films.TIER_RECOMMEND)
            self.assertTrue(set(rec["because"]) <= rated)
        self.assertEqual([r["predicted"] for r in recs], sorted((r["predicted"] for r in recs), reverse=True))

    def test_too_few_matches(self):
        res = self.post(ratings_csv(ROWS[:2]))
        self.assertEqual(res.status_code, 422)
        self.assertEqual(res.json()["match"]["matched"], 2)

    def test_rejects_bad_uploads(self):
        self.assertEqual(self.client.post("/api/profile/preview/", HTTP_HOST="localhost").status_code, 400)
        self.assertEqual(self.client.get("/api/profile/preview/", HTTP_HOST="localhost").status_code, 405)
        self.assertEqual(self.post(b"Title,Stars\nx,1\n").status_code, 400)
