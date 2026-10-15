from django.conf import settings
from django.http import JsonResponse
from django.shortcuts import render
from django.views.decorators.csrf import ensure_csrf_cookie
from django.views.decorators.http import require_GET, require_POST

from . import art, films, letterboxd, matching, similarity, taste

MAX_FILMS = 24
UNMATCHED_SHOWN = 200


# The cookie lets the page's scripts send the CSRF token with uploads.
@ensure_csrf_cookie
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


@require_POST
def profile_preview(request):
    """Taste profile from an uploaded Letterboxd export (.zip) or ratings.csv, in the form field "file".

    Nothing is stored. The response includes the matched ratings so a later save can send them back.
    """
    upload = request.FILES.get("file")
    if upload is None:
        return JsonResponse({"error": "Upload your Letterboxd export as the file field."}, status=400)
    if upload.size > letterboxd.MAX_UPLOAD_BYTES:
        return JsonResponse({"error": "That file is too large. Upload ratings.csv on its own."}, status=413)
    try:
        ratings = letterboxd.read_upload(upload.name or "", upload.read())
    except letterboxd.LetterboxdError as err:
        return JsonResponse({"error": str(err)}, status=400)

    matches = matching.match_ratings(ratings.rows)
    match_summary = {
        "rows": len(ratings.rows),
        "skipped": ratings.skipped,
        "matched": len(matches.matched),
        "rate": round(matches.rate, 4),
        "unmatched": [{"name": n, "year": y} for n, y in matches.unmatched[:UNMATCHED_SHOWN]],
    }
    try:
        result = taste.profile(matches.matched)
    except taste.TooFewRatings as err:
        response = JsonResponse({"error": str(err), "match": match_summary}, status=422)
    else:
        del result["person"]
        result["match"] = match_summary
        result["ratings"] = [
            [m.film, m.rating, m.date.isoformat() if m.date else None] for m in matches.matched
        ]
        response = JsonResponse(result)
    # Someone's ratings: never cached anywhere.
    response["Cache-Control"] = "no-store"
    return response
