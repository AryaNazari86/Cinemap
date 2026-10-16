import * as api from "./api";
import type { SavedProfile, TasteAxis, TasteProfile } from "./api";
import { artFor } from "./art";
import { type Catalog, genreColor } from "./data";
import { ExportError, ratingsCsv } from "./letterboxd";

const RECS_FIRST = 12;
const LEANINGS_SHOWN = 4;
const UNMATCHED_SHOWN = 60;
// A preview survives the trip to Google and back in this tab only, then is saved and forgotten.
const PENDING_SAVE = "cinemap:pending-save";

export interface TasteEvents {
  /** A profile to show on the map, or null to clear it. */
  onProfile(profile: TasteProfile | null): void;
  /** Open a film on the map. */
  onPick(idx: number): void;
  /** Fly the map to "you". */
  onShowMe(): void;
}

interface PendingSave {
  ratings: TasteProfile["ratings"];
  match: TasteProfile["match"];
  consent: boolean;
}

/**
 * "Your taste": upload a Letterboxd export, see where you sit on the map and on the taste
 * axes, get recommendations, and (signed in) save them.
 */
export class TasteView {
  private profile: TasteProfile | null = null;
  private saved: SavedProfile["saved"] | null = null;
  private busy = false;
  private readonly upload: HTMLElement;
  private readonly dropzone: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly status: HTMLElement;
  private readonly result: HTMLElement;

  constructor(
    root: HTMLElement,
    private readonly catalog: Catalog,
    private readonly events: TasteEvents,
  ) {
    this.upload = root.querySelector("#taste-upload")!;
    this.dropzone = root.querySelector("#dropzone")!;
    this.input = root.querySelector("#taste-file")!;
    this.status = root.querySelector("#taste-status")!;
    this.result = root.querySelector("#taste-result")!;

    this.input.addEventListener("change", () => {
      const file = this.input.files?.[0];
      this.input.value = ""; // choosing the same file again should still upload it
      if (file) void this.handleFile(file);
    });
    // Drop anywhere on the section, not just the box.
    root.addEventListener("dragover", (ev) => {
      if (!ev.dataTransfer?.types.includes("Files")) return;
      ev.preventDefault();
      this.dropzone.classList.add("over");
    });
    root.addEventListener("dragleave", (ev) => {
      if (!root.contains(ev.relatedTarget as Node)) this.dropzone.classList.remove("over");
    });
    root.addEventListener("drop", (ev) => {
      ev.preventDefault();
      this.dropzone.classList.remove("over");
      const file = ev.dataTransfer?.files[0];
      if (file) void this.handleFile(file);
    });
  }

  /** On page load: finish a save started before signing in, or show the saved profile. */
  async restore(): Promise<boolean> {
    if (!api.signedIn) return false;
    const pending = takePending();
    try {
      if (pending) {
        this.setStatus("Saving your map…", "busy");
        this.showSaved(await api.save(pending, pending.consent));
        this.setStatus("Saved to your account.", "done");
        return true;
      }
      const saved = await api.loadSaved();
      if (!saved) return false;
      if (saved.stale) {
        this.saved = saved.saved;
        this.setStatus(
          "Cinemap's model has changed since you saved your map. Upload your export again to refresh it.",
          "error",
        );
        this.renderStaleControls();
        return true;
      }
      this.showSaved(saved);
      return true;
    } catch (err) {
      this.setStatus(err instanceof Error ? err.message : "Couldn't load your saved map.", "error");
      return false;
    }
  }

  private async handleFile(file: File) {
    if (this.busy) return;
    this.busy = true;
    this.dropzone.classList.add("busy");
    try {
      this.setStatus("Reading your export…", "busy", 1);
      const csv = await ratingsCsv(file);
      const rows = Math.max(0, (await csv.text()).trim().split(/\r?\n/).length - 1);
      this.setStatus(`Matching ${rows.toLocaleString()} ratings to the map…`, "busy", 2);
      const profile = await api.preview(csv);
      this.saved = null;
      this.show(profile);
      const { matched, rows: total } = profile.match;
      this.setStatus(`Matched ${matched.toLocaleString()} of ${total.toLocaleString()} ratings (${pct(profile.match.rate)}).`, "done", 3);
    } catch (err) {
      if (err instanceof api.ApiError && err.match) {
        const { matched, rows } = err.match;
        this.setStatus(`${err.message} (${matched} of ${rows} ratings matched.)`, "error");
      } else {
        this.setStatus(err instanceof ExportError || err instanceof Error ? err.message : "That upload failed.", "error");
      }
    } finally {
      this.busy = false;
      this.dropzone.classList.remove("busy");
    }
  }

  private showSaved(saved: SavedProfile) {
    this.saved = saved.saved;
    this.show(saved as TasteProfile);
  }

  private show(profile: TasteProfile) {
    this.profile = profile;
    this.events.onProfile(profile);
    this.render();
  }

  private clear() {
    this.profile = null;
    this.saved = null;
    this.events.onProfile(null);
    this.result.hidden = true;
    this.result.replaceChildren();
    this.upload.hidden = false;
  }

  private setStatus(text: string, state: "busy" | "done" | "error" | "", step = 0) {
    this.status.dataset.state = state;
    this.status.replaceChildren();
    if (state === "busy") this.status.append(h("span", { className: "spinner", ariaHidden: "true" }));
    this.status.append(h("span", { textContent: text }));
    if (step) {
      const bar = h("span", { className: "upload-progress", ariaHidden: "true" });
      bar.style.setProperty("--p", String(step / 3));
      this.status.append(bar);
    }
  }

  private render() {
    const p = this.profile!;
    this.upload.hidden = true;
    this.result.hidden = false;
    const parts = [
      this.renderHeader(p),
      h("div", { className: "taste-grid" }, [this.renderLeanings(p.axes), this.renderNear(p)]),
      this.renderRecommendations(p),
      this.renderUnmatched(p),
      this.renderSave(),
    ];
    this.result.replaceChildren(...parts.filter((part): part is HTMLElement => part !== null));
  }

  private renderHeader(p: TasteProfile): HTMLElement {
    const confidence = {
      low: "Low confidence: rate a few more films on Letterboxd for a sharper picture.",
      medium: "Medium confidence.",
      high: "High confidence.",
    }[p.confidence];
    const showMe = h("button", { className: "pill pill-filled", textContent: "See yourself on the map", onclick: () => this.events.onShowMe() });
    const again = h("button", { className: "pill pill-outline", textContent: "Upload another export", onclick: () => this.uploadAgain() });
    const hide = h("button", { className: "pill pill-outline", textContent: "Close", onclick: () => this.clear() });
    return h("header", { className: "taste-head" }, [
      h("p", { className: "taste-stat" }, [
        h("strong", { textContent: `${p.n_ratings.toLocaleString()} films` }),
        document.createTextNode(` placed you, ${pct(p.match.rate)} of your ratings.`),
      ]),
      h("p", { className: `taste-confidence confidence-${p.confidence}`, textContent: confidence }),
      h("div", { className: "taste-actions" }, [showMe, again, this.saved ? null : hide]),
    ]);
  }

  private uploadAgain() {
    this.upload.hidden = false;
    this.input.click();
  }

  private renderLeanings(axes: TasteAxis[]): HTMLElement {
    const lean = (a: TasteAxis) => {
      const high = a.percentile >= 50;
      const share = high ? a.percentile : 100 - a.percentile;
      const side = high ? a.high : a.low;
      const sentence = `More ${side.toLowerCase()} than ${share}% of MovieLens raters`;
      const dot = h("span", { className: "lean-dot" });
      dot.style.left = `${Math.min(Math.max(a.percentile, 2), 98)}%`;
      return h("li", { className: "lean" }, [
        h("p", { className: "lean-name", textContent: a.name }),
        h("div", { className: "lean-track", role: "img", ariaLabel: `${a.name}: ${sentence}` } as Partial<HTMLDivElement>, [
          h("span", { className: "lean-mid", ariaHidden: "true" }),
          dot,
        ]),
        h("div", { className: "lean-ends", ariaHidden: "true" }, [
          h("span", { textContent: a.low, className: high ? "" : "strong" }),
          h("span", { textContent: a.high, className: high ? "strong" : "" }),
        ]),
        h("p", { className: "lean-text", textContent: sentence }),
      ]);
    };
    const more = axes.slice(LEANINGS_SHOWN);
    return h("section", { className: "panel leanings" }, [
      h("h3", { className: "panel-title", textContent: "Where your taste leans" }),
      h("ul", { className: "lean-list" }, axes.slice(0, LEANINGS_SHOWN).map(lean)),
      more.length
        ? h("details", { className: "lean-more" }, [
            h("summary", { textContent: `All ${axes.length} axes` }),
            h("ul", { className: "lean-list" }, more.map(lean)),
          ])
        : null,
      h("p", { className: "panel-note", textContent: "Axes are the directions films differ along most, named by the films at each end. Try them on the map with Taste axes." }),
    ]);
  }

  private renderNear(p: TasteProfile): HTMLElement {
    return h("section", { className: "panel near" }, [
      h("h3", { className: "panel-title", textContent: "Films nearest your taste" }),
      h(
        "ol",
        { className: "near-list" },
        p.near.map((idx) => {
          const m = this.catalog.movies[idx];
          const row = h("button", { className: "similar-row", onclick: () => this.events.onPick(idx) }, [
            h("span", { className: "swatch", ariaHidden: "true" }),
            h("span", { className: "similar-title", textContent: m.t }),
            h("span", { className: "similar-year", textContent: m.y ? String(m.y) : "" }),
          ]);
          row.style.setProperty("--c", genreColor(this.catalog.genres[m.pg]));
          return h("li", {}, [row]);
        }),
      ),
      h("p", { className: "panel-note", textContent: "You sit among these on the map; the films you rated are ringed there." }),
    ]);
  }

  private renderRecommendations(p: TasteProfile): HTMLElement {
    const list = h("ul", { className: "recs" });
    const add = (from: number, to: number) => {
      const recs = p.recommendations.slice(from, to);
      artFor(recs.map((r) => r.film));
      list.append(...recs.map((r) => this.recCard(r.film, r.predicted, r.because)));
    };
    add(0, RECS_FIRST);
    const more =
      p.recommendations.length > RECS_FIRST
        ? h("button", {
            className: "pill pill-outline recs-more",
            textContent: `Show ${p.recommendations.length - RECS_FIRST} more`,
            onclick: () => {
              add(RECS_FIRST, p.recommendations.length);
              more!.remove();
            },
          })
        : null;
    return h("section", { className: "recs-section" }, [
      h("h3", { className: "taste-subtitle", textContent: "Films you'll likely love" }),
      list,
      more,
    ]);
  }

  private recCard(idx: number, predicted: number, because: number[]): HTMLLIElement {
    const m = this.catalog.movies[idx];
    const liked = because.map((i) => this.catalog.movies[i].t);
    const poster = h("span", { className: "tile-poster loading" }, [h("span", { className: "tile-fallback", textContent: m.t })]);
    const button = h(
      "button",
      {
        className: "rec",
        onclick: () => this.events.onPick(idx),
        ariaLabel: `${m.t}${m.y ? `, ${m.y}` : ""}. Predicted ${predicted.toFixed(1)} stars.${liked.length ? ` Because you liked ${liked.join(", ")}.` : ""}`,
      },
      [
        poster,
        h("span", { className: "rec-body" }, [
          h("span", { className: "tile-title", textContent: m.t }),
          h("span", { className: "tile-meta", textContent: [m.y, `★ ${predicted.toFixed(1)} for you`].filter(Boolean).join(" · ") }),
          liked.length ? h("span", { className: "rec-because", textContent: `Because you liked ${liked.join(", ")}` }) : null,
        ]),
      ],
    );
    button.style.setProperty("--c", genreColor(this.catalog.genres[m.pg]));
    artFor([idx])
      .get(idx)!
      .then((art) => {
        if (!art?.poster) return poster.classList.remove("loading");
        const img = h("img", { src: art.poster, alt: "", decoding: "async" });
        img.addEventListener("load", () => poster.classList.replace("loading", "has-image"), { once: true });
        img.addEventListener("error", () => poster.classList.remove("loading"), { once: true });
        poster.prepend(img);
      });
    return h("li", {}, [button]);
  }

  private renderUnmatched(p: TasteProfile): HTMLElement | null {
    const missing = p.match.unmatched;
    if (!missing.length) return null;
    const shown = missing.slice(0, UNMATCHED_SHOWN);
    return h("details", { className: "unmatched" }, [
      h("summary", { textContent: `${missing.length.toLocaleString()} ${missing.length === 1 ? "film" : "films"} Cinemap couldn't find` }),
      h("p", {
        className: "panel-note",
        textContent:
          "Most are newer than the ratings Cinemap learned from (they end in late 2023) or too rarely rated to place. They don't count toward your map.",
      }),
      h(
        "ul",
        { className: "unmatched-list" },
        shown.map((u) => h("li", { textContent: u.year ? `${u.name} (${u.year})` : u.name })),
      ),
      missing.length > shown.length ? h("p", { className: "panel-note", textContent: `…and ${missing.length - shown.length} more.` }) : null,
    ]);
  }

  private renderSave(): HTMLElement {
    const box = h("section", { className: "panel save", ariaLabel: "Save your map" } as Partial<HTMLElement>);
    if (!api.signInEnabled) {
      box.append(h("p", { className: "panel-note", textContent: "Your map lives in this tab only; nothing was stored. Saving to an account is coming soon." }));
      return box;
    }
    const consent = consentBox(this.saved?.research_consent ?? false);

    if (this.saved) {
      const status = h("p", { className: "save-status", role: "status" } as Partial<HTMLElement>);
      consent.input.addEventListener("change", async () => {
        consent.input.disabled = true;
        try {
          await api.setConsent(consent.input.checked);
          status.textContent = consent.input.checked ? "Thanks. You can turn this off anytime." : "Turned off.";
        } catch (err) {
          consent.input.checked = !consent.input.checked;
          status.textContent = err instanceof Error ? err.message : "Couldn't change that.";
        } finally {
          consent.input.disabled = false;
        }
      });
      const remove = h("button", { className: "pill pill-outline danger", textContent: "Delete my saved map" });
      remove.addEventListener("click", async () => {
        if (remove.dataset.confirm !== "1") {
          remove.dataset.confirm = "1";
          remove.textContent = "Delete it for good?";
          return;
        }
        remove.disabled = true;
        try {
          await api.deleteSaved();
          this.clear();
          this.setStatus("Deleted your saved map and every rating in it.", "done");
        } catch (err) {
          remove.disabled = false;
          status.textContent = err instanceof Error ? err.message : "Couldn't delete it.";
        }
      });
      remove.addEventListener("blur", () => {
        delete remove.dataset.confirm;
        remove.textContent = "Delete my saved map";
      });
      const signOut = h("button", { className: "text-button", textContent: "Sign out", onclick: () => api.submitAuth(document.body.dataset.logoutUrl!) });
      box.append(
        h("h3", { className: "panel-title", textContent: "Saved to your account" }),
        h("p", { className: "panel-note", textContent: `Uploaded ${new Date(this.saved.uploaded_at).toLocaleDateString()}. A new upload replaces it.` }),
        consent.label,
        h("div", { className: "save-actions" }, [remove, signOut]),
        status,
      );
      return box;
    }

    const status = h("p", { className: "save-status", role: "status" } as Partial<HTMLElement>);
    const action = h("button", {
      className: "pill pill-filled",
      textContent: api.signedIn ? "Save to my account" : "Sign in with Google to save your map",
    });
    action.addEventListener("click", async () => {
      const p = this.profile!;
      if (!api.signedIn) {
        storePending({ ratings: p.ratings, match: p.match, consent: consent.input.checked });
        api.submitAuth(document.body.dataset.loginUrl!, "/#taste");
        return;
      }
      action.disabled = true;
      status.textContent = "Saving…";
      try {
        this.showSaved(await api.save(p, consent.input.checked));
      } catch (err) {
        action.disabled = false;
        status.textContent = err instanceof Error ? err.message : "Couldn't save.";
      }
    });
    box.append(
      h("h3", { className: "panel-title", textContent: "Keep your map" }),
      h("p", {
        className: "panel-note",
        textContent: "Nothing is stored unless you save. Saving keeps your matched ratings and your map, never your Letterboxd username or the file.",
      }),
      consent.label,
      h("div", { className: "save-actions" }, [action]),
      status,
    );
    return box;
  }

  /** A saved map from an older model: offer to delete it while waiting for a new upload. */
  private renderStaleControls() {
    this.upload.hidden = false;
    const remove = h("button", { className: "text-button", textContent: "Delete the old saved map" });
    remove.addEventListener("click", async () => {
      await api.deleteSaved().catch(() => undefined);
      this.saved = null;
      remove.remove();
      this.setStatus("Deleted your old saved map.", "done");
    });
    this.status.after(remove);
  }
}

function consentBox(checked: boolean) {
  const input = h("input", { type: "checkbox", checked });
  const label = h("label", { className: "consent" }, [
    input,
    h("span", {
      textContent: "Let Cinemap use my ratings to improve its recommendations later. Optional, off by default, and you can change it anytime.",
    }),
  ]);
  return { input, label };
}

function storePending(pending: PendingSave) {
  try {
    sessionStorage.setItem(PENDING_SAVE, JSON.stringify(pending));
  } catch {
    // Private mode or full storage: the person will just upload again after signing in.
  }
}

function takePending(): PendingSave | null {
  try {
    const raw = sessionStorage.getItem(PENDING_SAVE);
    sessionStorage.removeItem(PENDING_SAVE);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & Record<string, unknown>,
  children: (Node | null)[] = [],
): HTMLElementTagNameMap[K] {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...children.filter((c): c is Node => c !== null));
  return el;
}
