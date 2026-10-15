"""Taste profiles as the API shows them, and saving them for signed-in people."""

from datetime import date

from django.db import transaction
from django.db.models import F, Q
from django.utils import timezone

from . import films, matching, taste
from .letterboxd import MAX_ROWS, VALID_RATINGS
from .matching import Match
from .models import ProfileRating, ProfileUnmatchedFilm, TasteProfile, UnmatchedFilm

TALLY_CHUNK = 200  # (title, year) pairs per tally query


class InvalidProfile(ValueError):
    """A save request that doesn't describe ratings Cinemap could have matched; safe to show."""


def describe(matched: list[Match], unmatched: list[tuple[str, int | None]], n_rows: int, skipped: int = 0) -> dict:
    """The taste view's data: what preview, save and fetch all return. Raises taste.TooFewRatings."""
    total = len(matched) + len(unmatched)
    match_summary = {
        "rows": n_rows,
        "skipped": skipped,
        "matched": len(matched),
        "rate": round(len(matched) / total, 4) if total else 0.0,
        "unmatched": [{"name": n, "year": y} for n, y in unmatched],
    }
    try:
        result = taste.profile(matched)
    except taste.TooFewRatings as err:
        err.match = match_summary
        raise
    del result["person"]
    result["match"] = match_summary
    result["ratings"] = [[m.film, m.rating, m.date.isoformat() if m.date else None] for m in matched]
    return result


def parse_save_request(data) -> tuple[list[Match], list[tuple[str, int | None]], int, bool]:
    """Check a save request: the "ratings" and "unmatched" a preview returned, plus "consent".

    The server recomputes everything else, so nothing derived is taken from the browser.
    """
    if not isinstance(data, dict):
        raise InvalidProfile("Send a JSON object.")
    ratings, unmatched = data.get("ratings"), data.get("unmatched", [])
    consent = data.get("consent", False)
    if not isinstance(ratings, list) or not isinstance(unmatched, list) or not isinstance(consent, bool):
        raise InvalidProfile("Send ratings and unmatched as lists and consent as true or false.")
    if len(ratings) + len(unmatched) > MAX_ROWS:
        raise InvalidProfile(f"At most {MAX_ROWS:,} ratings.")

    count = films.count()
    by_film: dict[int, Match] = {}
    for item in ratings:
        if not (isinstance(item, list) and len(item) == 3):
            raise InvalidProfile("Each rating is [film, stars, date or null].")
        film, stars, when = item
        if type(film) is not int or not 0 <= film < count:
            raise InvalidProfile("A rating names a film that isn't on the map.")
        if type(stars) not in (int, float) or stars not in VALID_RATINGS:
            raise InvalidProfile("Ratings are 0.5 to 5 stars in halves.")
        try:
            rated_on = None if when is None else date.fromisoformat(when)
        except (TypeError, ValueError):
            raise InvalidProfile("Rating dates are YYYY-MM-DD or null.") from None
        by_film[film] = Match(film, float(stars), rated_on)

    titles = []
    for item in unmatched:
        name, year = (item.get("name"), item.get("year")) if isinstance(item, dict) else (None, None)
        if not isinstance(name, str) or not name.strip() or not (year is None or (type(year) is int and 1870 <= year <= 2100)):
            raise InvalidProfile("Each unmatched film is {name, year or null}.")
        titles.append((name.strip()[:300], year))
    return list(by_film.values()), titles, len(ratings) + len(titles), consent


def save(user, matched: list[Match], unmatched: list[tuple[str, int | None]], n_rows: int, consent: bool) -> TasteProfile:
    """Replace the user's profile with this one. Raises taste.TooFewRatings."""
    computed = taste.profile(matched)
    person = computed["person"]
    now = timezone.now()
    with transaction.atomic():
        old = TasteProfile.objects.select_for_update().filter(user=user).first()
        if old is not None:
            _tally(_unmatched_keys(old.unmatched.values_list("name", "year")), -1)
            old.delete()
        profile = TasteProfile.objects.create(
            user=user,
            uploaded_at=now,
            model_version=computed["model_version"],
            vector=[round(float(v), 6) for v in person.vector],
            bias=person.bias,
            position=computed["position"],
            n_rows=n_rows,
            research_consent=consent,
            research_consent_at=now if consent else None,
        )
        ProfileRating.objects.bulk_create(
            ProfileRating(profile=profile, film=m.film, rating=m.rating, rated_on=m.date) for m in matched
        )
        ProfileUnmatchedFilm.objects.bulk_create(
            ProfileUnmatchedFilm(profile=profile, name=name, year=year) for name, year in unmatched
        )
        _tally(_unmatched_keys(unmatched), +1)
    return profile


def load(user) -> TasteProfile | None:
    return TasteProfile.objects.filter(user=user).first()


def describe_saved(profile: TasteProfile) -> dict:
    """The saved profile as the taste view shows it. A profile from an older model can't be
    shown (its film indices may point elsewhere now), so it asks for a fresh upload instead."""
    saved = {
        "uploaded_at": profile.uploaded_at.isoformat(),
        "research_consent": profile.research_consent,
        "model_version": profile.model_version,
    }
    if profile.model_version != films.model().version:
        return {"stale": True, "saved": saved}
    matched = [Match(r.film, r.rating, r.rated_on) for r in profile.ratings.order_by("id")]
    unmatched = list(profile.unmatched.order_by("id").values_list("name", "year"))
    return {**describe(matched, unmatched, profile.n_rows), "stale": False, "saved": saved}


def set_consent(profile: TasteProfile, consent: bool) -> None:
    profile.research_consent = consent
    profile.research_consent_at = timezone.now() if consent else None
    profile.save(update_fields=["research_consent", "research_consent_at"])


def delete(user) -> bool:
    """Delete the user's profile and everything in it. False if there was none."""
    with transaction.atomic():
        profile = TasteProfile.objects.select_for_update().filter(user=user).first()
        if profile is None:
            return False
        _tally(_unmatched_keys(profile.unmatched.values_list("name", "year")), -1)
        profile.delete()  # cascades to its ratings and unmatched films
    return True


def _unmatched_keys(pairs) -> set[tuple[str, int | None]]:
    """Each distinct film once, however often a profile lists it."""
    return {(key, year) for name, year in pairs if (key := matching.normalize(name)[:300])}


def _tally(keys: set[tuple[str, int | None]], step: int) -> None:
    if not keys:
        return
    keys = sorted(keys, key=lambda k: (k[0], k[1] or 0))
    if step > 0:
        UnmatchedFilm.objects.bulk_create(
            [UnmatchedFilm(title=t, year=y) for t, y in keys], ignore_conflicts=True
        )
    for start in range(0, len(keys), TALLY_CHUNK):
        chunk = Q()
        for title, year in keys[start : start + TALLY_CHUNK]:
            chunk |= Q(title=title, year=year) if year is not None else Q(title=title, year__isnull=True)
        UnmatchedFilm.objects.filter(chunk).update(profile_count=F("profile_count") + step)
    if step < 0:
        UnmatchedFilm.objects.filter(profile_count__lte=0).delete()
