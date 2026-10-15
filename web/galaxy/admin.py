from django.contrib import admin

from .models import UnmatchedFilm


@admin.register(UnmatchedFilm)
class UnmatchedFilmAdmin(admin.ModelAdmin):
    """Films people rate that the map lacks, most wanted first."""

    list_display = ["title", "year", "profile_count"]
    ordering = ["-profile_count", "title"]
    search_fields = ["title"]
