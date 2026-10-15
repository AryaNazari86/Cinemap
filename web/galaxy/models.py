"""Saved taste profiles. Only signed-in people have one, and at most one: each upload replaces it.

What is kept: the matched ratings (map film index, stars, date), the titles that didn't
match, and what the model made of them. Never the Letterboxd username, the uploaded file
or anything else from the export.
"""

from django.conf import settings
from django.db import models


class TasteProfile(models.Model):
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="taste_profile")
    uploaded_at = models.DateTimeField()
    # films.Model.version at upload; film indices and the vector only mean something under it.
    model_version = models.CharField(max_length=64)
    vector = models.JSONField()  # the folded-in vector, one float per model dimension
    bias = models.FloatField()
    position = models.JSONField()  # [x, y, z] on the map
    n_rows = models.PositiveIntegerField()  # ratings in the upload, matched or not
    # Off unless the person ticks the box: may Cinemap use these ratings to improve itself later
    # (say, retraining with them)? Nothing does so yet.
    research_consent = models.BooleanField(default=False)
    research_consent_at = models.DateTimeField(null=True, blank=True)

    def __str__(self):
        return f"Taste profile of user {self.user_id}"


class ProfileRating(models.Model):
    profile = models.ForeignKey(TasteProfile, on_delete=models.CASCADE, related_name="ratings")
    film = models.PositiveIntegerField()  # map film index
    rating = models.FloatField()  # 0.5 to 5 stars
    rated_on = models.DateField(null=True, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["profile", "film"], name="one_rating_per_film")]


class ProfileUnmatchedFilm(models.Model):
    """A title from the upload that no map film matched, as it was written there."""

    profile = models.ForeignKey(TasteProfile, on_delete=models.CASCADE, related_name="unmatched")
    name = models.CharField(max_length=300)
    year = models.PositiveSmallIntegerField(null=True, blank=True)


class UnmatchedFilm(models.Model):
    """How many saved profiles have rated a film the map lacks: a to-do list for growing the catalog.

    Kept in step with the profiles: a replaced or deleted profile takes its counts with it.
    """

    title = models.CharField(max_length=300)  # matching.normalize() of the name
    year = models.PositiveSmallIntegerField(null=True, blank=True)
    profile_count = models.PositiveIntegerField(default=0)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["title", "year"], name="one_tally_per_title_year"),
            models.UniqueConstraint(
                fields=["title"], condition=models.Q(year__isnull=True), name="one_tally_per_yearless_title"
            ),
        ]
        indexes = [models.Index(fields=["-profile_count"])]

    def __str__(self):
        return f"{self.title} ({self.year}): {self.profile_count}"
