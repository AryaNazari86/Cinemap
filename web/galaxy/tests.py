from unittest import mock

import numpy as np
from django.core.cache import cache
from django.test import SimpleTestCase, override_settings

from . import art, films

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
