// The taste-profile endpoints in galaxy/views.py. Shapes follow galaxy/profiles.py's describe().

export interface TasteAxis {
  axis: number;
  name: string;
  low: string;
  high: string;
  value: number; // standard deviations of the films along this axis
  percentile: number; // share of MovieLens raters below this point, 0..100
}

export interface Recommendation {
  film: number;
  predicted: number;
  because: number[];
}

export interface MatchSummary {
  rows: number;
  skipped: number;
  matched: number;
  rate: number;
  unmatched: { name: string; year: number | null }[];
}

export interface TasteProfile {
  model_version: string;
  n_ratings: number;
  confidence: "low" | "medium" | "high";
  bias: number;
  position: [number, number, number];
  near: number[];
  axes: TasteAxis[]; // strongest leanings first
  recommendations: Recommendation[];
  match: MatchSummary;
  ratings: [number, number, string | null][]; // [film, stars, date]
}

export interface SavedProfile extends Partial<TasteProfile> {
  stale: boolean; // computed with an older model: ask for a new upload
  saved: { uploaded_at: string; research_consent: boolean; model_version: string };
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly match?: MatchSummary,
  ) {
    super(message);
  }
}

const body = document.body.dataset;
export const signInEnabled = body.signIn === "1";
export const signedIn = body.signedIn === "1";

function csrfToken(): string {
  return document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/)?.[1] ?? "";
}

async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { "X-CSRFToken": csrfToken(), ...(init.headers ?? {}) },
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError("Couldn't reach Cinemap. Check your connection and try again.", 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const fallback = res.status === 413 ? "That file is too large." : "Something went wrong. Please try again.";
    throw new ApiError(data.error ?? fallback, res.status, data.match);
  }
  return data as T;
}

/** Match an export and fold it into the model. Nothing is stored. */
export function preview(ratingsCsv: Blob): Promise<TasteProfile> {
  const form = new FormData();
  form.append("file", ratingsCsv, "ratings.csv");
  return call(body.previewUrl!, { method: "POST", body: form });
}

export async function loadSaved(): Promise<SavedProfile | null> {
  return (await call<{ profile: SavedProfile | null }>(body.profileUrl!)).profile;
}

export async function save(profile: Pick<TasteProfile, "ratings" | "match">, consent: boolean): Promise<SavedProfile> {
  const payload = { ratings: profile.ratings, unmatched: profile.match.unmatched, consent };
  const res = await call<{ profile: SavedProfile }>(body.profileUrl!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.profile;
}

export function setConsent(consent: boolean): Promise<{ research_consent: boolean }> {
  return call(body.profileUrl!, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ consent }),
  });
}

export function deleteSaved(): Promise<{ deleted: boolean }> {
  return call(body.profileUrl!, { method: "DELETE" });
}

/** Sign in or out: allauth wants a POST with the CSRF token, then redirects. */
export function submitAuth(url: string, next = "") {
  const form = document.createElement("form");
  form.method = "post";
  form.action = url;
  form.hidden = true;
  for (const [name, value] of [["csrfmiddlewaretoken", csrfToken()], ["next", next]]) {
    if (!value) continue;
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.append(input);
  }
  document.body.append(form);
  form.submit();
}
