"""Fold a new person into the trained model, then place them, explain them and recommend films.

The model is never changed. With the film vectors and biases fixed, a person's own vector
and bias come from ridge regression on their ratings: a closed-form solve of a
(dim + 1)-square system, which takes about a millisecond.
"""

from dataclasses import dataclass

import numpy as np

from . import films
from .matching import Match

# Ridge strength on the person's vector and on their bias. Chosen by folding in 3,000
# MovieLens users from half their training ratings and scoring the other half; at 20
# ratings this beats a bias-only guess by 0.065 RMSE (0.874 vs 0.939).
VECTOR_LAMBDA = 10.0
BIAS_LAMBDA = 5.0
MIN_RATINGS = 5  # below this there is too little to place anyone
LOW_CONFIDENCE_BELOW = 20
HIGH_CONFIDENCE_FROM = 100

PLACE_NEIGHBORS = 15
RECOMMENDATIONS = 30
BECAUSE_SHOWN = 3
# "Because you liked" draws on films rated at least this, or on the person's top quarter if none are.
LIKED_RATING = 4.0


class TooFewRatings(ValueError):
    pass


@dataclass(frozen=True)
class Person:
    vector: np.ndarray
    bias: float


def fold_in(film_idxs: np.ndarray, ratings: np.ndarray) -> Person:
    """Ridge regression of (rating - global_mean - film bias) on the film vectors, plus a bias column."""
    model = films.model()
    x = np.hstack([model.vectors[film_idxs].astype(np.float64), np.ones((len(film_idxs), 1))])
    y = ratings - model.global_mean - model.bias[film_idxs]
    reg = np.diag([VECTOR_LAMBDA] * model.vectors.shape[1] + [BIAS_LAMBDA])
    solution = np.linalg.solve(x.T @ x + reg, x.T @ y)
    return Person(solution[:-1].astype(np.float32), float(solution[-1]))


def predict(person: Person, film_idxs: np.ndarray | None = None) -> np.ndarray:
    model = films.model()
    idx = slice(None) if film_idxs is None else film_idxs
    return model.global_mean + person.bias + model.bias[idx] + model.vectors[idx] @ person.vector


def confidence(n: int) -> str:
    if n < LOW_CONFIDENCE_BELOW:
        return "low"
    return "high" if n >= HIGH_CONFIDENCE_FROM else "medium"


def place(person: Person) -> list[float]:
    """A map position for the person.

    UMAP can't place new points, so the person sits at the similarity-weighted average
    position of the films whose vectors point most their way.
    """
    model = films.model()
    unit, _ = films.vectors()
    sims = unit @ _unit(person.vector)
    sims[model.tier < films.TIER_RECOMMEND] = -np.inf
    near = _top(sims, PLACE_NEIGHBORS)
    weights = np.clip(sims[near], 1e-6, None)
    position = (model.xyz[near] * weights[:, None]).sum(axis=0) / weights.sum()
    return [round(float(c), 2) for c in position]


def recommend(person: Person, rated: np.ndarray, ratings: np.ndarray) -> list[dict]:
    """Unrated reliable films by predicted rating, each with the liked films most like it."""
    model = films.model()
    unit, _ = films.vectors()
    scores = predict(person)
    scores[model.tier < films.TIER_RECOMMEND] = -np.inf
    scores[rated] = -np.inf
    top = _top(scores, RECOMMENDATIONS)

    liked = rated[ratings >= LIKED_RATING]
    if len(liked) == 0:
        liked = rated[ratings >= np.quantile(ratings, 0.75)]
    sims = unit[top] @ unit[liked].T  # (recommendations, liked films)
    result = []
    for row, film in enumerate(top):
        best = np.argsort(-sims[row])[:BECAUSE_SHOWN]
        result.append({
            "film": int(film),
            "predicted": round(float(np.clip(scores[film], 0.5, 5.0)), 2),
            "because": [int(liked[j]) for j in best if sims[row, j] > 0],
        })
    return result


def profile(matched: list[Match]) -> dict:
    """Everything the taste view shows, from matched ratings. Raises TooFewRatings."""
    if len(matched) < MIN_RATINGS:
        raise TooFewRatings(f"Cinemap needs at least {MIN_RATINGS} rated films it knows; it found {len(matched)}.")
    rated = np.array([m.film for m in matched])
    ratings = np.array([m.rating for m in matched], dtype=np.float64)
    person = fold_in(rated, ratings)
    position = place(person)
    return {
        "person": person,
        "model_version": films.model().version,
        "n_ratings": len(matched),
        "confidence": confidence(len(matched)),
        "bias": round(person.bias, 3),
        "position": position,
        "recommendations": recommend(person, rated, ratings),
    }


def _unit(v: np.ndarray) -> np.ndarray:
    return v / max(float(np.linalg.norm(v)), 1e-8)


def _top(scores: np.ndarray, k: int) -> np.ndarray:
    """Indices of the k highest finite scores, highest first."""
    k = min(k, int(np.isfinite(scores).sum()))
    if k == 0:
        return np.array([], dtype=np.int64)
    top = np.argpartition(-scores, k - 1)[:k]
    return top[np.argsort(-scores[top])]
