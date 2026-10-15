from django.conf import settings
from django.http import JsonResponse
from django.shortcuts import render
from django.views.decorators.http import require_GET

from . import art, films, similarity

MAX_FILMS = 24


def index(request):
    return render(request, "galaxy/index.html", {"art_source": art.source()})


@require_GET
def artwork(request):
    """Poster and backdrop URLs for up to MAX_FILMS films: /api/art/?films=0,12 (map indices)."""
    try:
        idxs = list(dict.fromkeys(int(i) for i in request.GET.get("films", "").split(",") if i))
    except ValueError:
        return JsonResponse({"error": "films must be comma-separated film indices."}, status=400)
    if not idxs or len(idxs) > MAX_FILMS or not all(0 <= i < films.count() for i in idxs):
        return JsonResponse({"error": f"Send between 1 and {MAX_FILMS} valid film indices."}, status=400)

    response = JsonResponse({str(i): a for i, a in art.art_for(idxs).items()})
    # Artwork rarely changes: browsers keep it a day, Vercel's CDN a week.
    if not settings.DEBUG:
        response["Cache-Control"] = "public, max-age=86400, s-maxage=604800"
    return response


@require_GET
def compare(request):
    """How alike two films are: /api/compare/?a=0&b=2355 (map indices, as in #m= links)."""
    try:
        a, b = int(request.GET["a"]), int(request.GET["b"])
    except (KeyError, ValueError):
        return JsonResponse({"error": "Pass two film indices as a and b."}, status=400)
    count = films.count()
    if not (0 <= a < count and 0 <= b < count) or a == b:
        return JsonResponse({"error": f"a and b must be different indices from 0 to {count - 1}."}, status=400)
    response = JsonResponse(similarity.compare(a, b))
    # Fixed for a given model export; a new export ships with a new deploy.
    if not settings.DEBUG:
        response["Cache-Control"] = "public, max-age=3600, s-maxage=86400"
    return response
