import json

from django.conf import settings
from django.http import JsonResponse
from django.shortcuts import render
from django.urls import reverse
from django.views.decorators.csrf import ensure_csrf_cookie
from django.views.decorators.http import require_GET, require_http_methods, require_POST

from . import art, films, letterboxd, matching, profiles, similarity, taste

MAX_FILMS = 24


# The cookie lets the page's scripts send the CSRF token with uploads.
@ensure_csrf_cookie
def index(request):
    context = {"art_source": art.source(), "sign_in": settings.GOOGLE_SIGN_IN}
    return render(request, "galaxy/index.html", context)


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


def private(response: JsonResponse) -> JsonResponse:
    """Someone's ratings: never cached anywhere."""
    response["Cache-Control"] = "no-store"
    return response


@require_POST
def profile_preview(request):
    """Taste profile from an uploaded Letterboxd export (.zip) or ratings.csv, in the form field "file".

    Nothing is stored. The response includes the matched and unmatched ratings, which
    POST /api/profile/ takes to save it.
    """
    upload = request.FILES.get("file")
    if upload is None:
        return private(JsonResponse({"error": "Upload your Letterboxd export as the file field."}, status=400))
    if upload.size > letterboxd.MAX_UPLOAD_BYTES:
        return private(JsonResponse({"error": "That file is too large. Upload ratings.csv on its own."}, status=413))
    try:
        ratings = letterboxd.read_upload(upload.name or "", upload.read())
    except letterboxd.LetterboxdError as err:
        return private(JsonResponse({"error": str(err)}, status=400))
    matches = matching.match_ratings(ratings.rows)
    try:
        result = profiles.describe(matches.matched, matches.unmatched, len(ratings.rows), ratings.skipped)
    except taste.TooFewRatings as err:
        return private(JsonResponse({"error": str(err), "match": err.match}, status=422))
    return private(JsonResponse(result))


@require_http_methods(["GET", "POST", "PATCH", "DELETE"])
def profile(request):
    """The signed-in person's saved profile.

    GET     the saved profile, as preview shows it ({"profile": null} if none)
    POST    save a preview: {"ratings": [...], "unmatched": [...], "consent": bool}, replacing any earlier one
    PATCH   {"consent": bool}
    DELETE  the profile and every rating in it
    """
    if not request.user.is_authenticated:
        if not settings.GOOGLE_SIGN_IN:
            return private(JsonResponse({"error": "Saving isn't available yet.", "login_url": None}, status=401))
        return private(JsonResponse(
            {"error": "Sign in with Google to save your map.", "login_url": reverse("google_login")}, status=401
        ))
    if request.method == "GET":
        saved = profiles.load(request.user)
        return private(JsonResponse({"profile": profiles.describe_saved(saved) if saved else None}))
    if request.method == "DELETE":
        deleted = profiles.delete(request.user)
        return private(JsonResponse({"deleted": deleted}))

    try:
        data = json.loads(request.body)
    except (ValueError, UnicodeDecodeError):
        return private(JsonResponse({"error": "Send JSON."}, status=400))
    if request.method == "PATCH":
        saved = profiles.load(request.user)
        if saved is None:
            return private(JsonResponse({"error": "There is no saved profile."}, status=404))
        if not isinstance(data, dict) or not isinstance(data.get("consent"), bool):
            return private(JsonResponse({"error": "Send consent as true or false."}, status=400))
        profiles.set_consent(saved, data["consent"])
        return private(JsonResponse({"research_consent": saved.research_consent}))

    try:
        matched, unmatched, n_rows, consent = profiles.parse_save_request(data)
        saved = profiles.save(request.user, matched, unmatched, n_rows, consent)
    except profiles.InvalidProfile as err:
        return private(JsonResponse({"error": str(err)}, status=400))
    except taste.TooFewRatings as err:
        return private(JsonResponse({"error": str(err)}, status=422))
    return private(JsonResponse({"profile": profiles.describe_saved(saved)}, status=201))
