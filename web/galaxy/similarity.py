"""Compare any two films using the model's full vectors. Films are map indices."""

import numpy as np

from . import films

BETWEEN_SHOWN = 6
# Barely rated films have barely trained vectors that all look alike, so they make poor
# "in between" suggestions. Comparing them directly is still allowed.
BETWEEN_MIN_RATINGS = 1000


def compare(a: int, b: int) -> dict:
    unit, n_ratings = films.vectors()
    sims_a = unit @ unit[a]
    sims_b = unit @ unit[b]
    similarity = float(sims_a[b])

    # Films closer to a than b is (a itself excluded), and the same from b's side.
    ahead_of_b = int((sims_a > sims_a[b]).sum() - 1)
    ahead_of_a = int((sims_b > sims_b[a]).sum() - 1)
    rivals = len(unit) - 2  # every film except a and b

    # In between = liked by both audiences: rank by the weaker of the two matches, so a
    # tight cluster around one film (a run of sequels, say) can't fill the list alone.
    both = np.minimum(sims_a, sims_b)
    both[[a, b]] = -np.inf
    both[n_ratings < BETWEEN_MIN_RATINGS] = -np.inf
    top = np.argpartition(-both, BETWEEN_SHOWN)[:BETWEEN_SHOWN]
    between = top[np.argsort(-both[top])]

    return {
        "a": a,
        "b": b,
        "similarity": round(similarity, 4),
        # 1 = b is a's closest film of all, and vice versa.
        "rank_b_for_a": ahead_of_b + 1,
        "rank_a_for_b": ahead_of_a + 1,
        # Share of the other films that are less alike to a than b is (0..1).
        "closer_than": round((rivals - ahead_of_b) / max(rivals, 1), 4),
        "between": [int(i) for i in between if np.isfinite(both[i])],
    }
