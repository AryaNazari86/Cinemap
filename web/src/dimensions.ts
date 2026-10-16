import * as THREE from "three";
import type { Catalog } from "./data";
import type { Galaxy } from "./galaxy";
import type { Tag } from "./labels";

/** A named taste axis, from galaxy/data/axes.json via the page. */
export interface AxisName {
  name: string;
  low: string;
  high: string;
  variance: number;
}

const SD_UNITS = 44; // map units per standard deviation: most films land within the map's radius
const GUIDE_LENGTH = 3 * SD_UNITS;
const SLOTS = ["Left to right", "Bottom to top", "Back to front"];
const DEFAULT_AXES: [number, number, number] = [0, 1, 2];

/**
 * Two ways to lay out the films: the UMAP map (default) or three chosen taste axes, the
 * principal directions of the film vectors. Switching glides the films between them.
 */
export class Layouts {
  private readonly mapPositions: Float32Array;
  private coords: Float32Array | null = null; // film-major, SD units
  private nAxes = 0;
  /** Each axis's median over the films on the map, so the visible cloud sits at the centre. */
  private centre: number[] = [];
  private loading: Promise<void> | null = null;
  private readonly chosen: [number, number, number] = [...DEFAULT_AXES];
  private onAxes = false;
  private personMap: THREE.Vector3 | null = null;
  private personAxes: number[] | null = null; // SD units per axis index

  constructor(
    private readonly galaxy: Galaxy,
    private readonly catalog: Catalog,
    private readonly names: AxisName[],
    private readonly url: string,
    private readonly button: HTMLButtonElement,
    private readonly panel: HTMLElement,
  ) {
    this.mapPositions = new Float32Array(catalog.movies.flatMap((m) => m.p));
    if (!names.length) {
      button.hidden = true;
      return;
    }
    this.buildSelectors();
    button.addEventListener("click", () => void this.setOnAxes(!this.onAxes));
  }

  get axesShown() {
    return this.onAxes;
  }

  /** Where "you" are in each layout; null hides you. */
  setPerson(mapPosition: [number, number, number] | null, axisValues: number[] | null) {
    this.personMap = mapPosition ? new THREE.Vector3(...mapPosition) : null;
    this.personAxes = axisValues;
    this.placePerson();
  }

  /** Axis names at each end of the guides, and "You", for the labels layer. */
  tags(): Tag[] {
    const tags: Tag[] = [];
    const you = this.galaxy.personPosition;
    const youScreen = you && this.galaxy.toScreen(you);
    // Clear of the dot and most of its halo.
    if (youScreen) tags.push({ text: "You", x: youScreen.x + 24, y: youScreen.y, kind: "you" });
    if (!this.onAxes) return tags;
    this.chosen.forEach((axis, slot) => {
      for (const sign of [-1, 1]) {
        const end = new THREE.Vector3();
        end.setComponent(slot, sign * GUIDE_LENGTH);
        const at = this.galaxy.toScreen(end);
        const name = this.names[axis];
        if (at) tags.push({ text: sign < 0 ? name.low : name.high, x: at.x, y: at.y, kind: "axis" });
      }
    });
    return tags;
  }

  async setOnAxes(on: boolean) {
    if (on) {
      this.button.classList.add("busy");
      try {
        await this.load();
      } catch {
        this.button.classList.remove("busy");
        this.button.title = "Couldn't load the taste axes. Try again.";
        return;
      }
      this.button.classList.remove("busy");
    }
    this.onAxes = on;
    this.button.setAttribute("aria-pressed", String(on));
    this.button.classList.toggle("active", on);
    this.panel.hidden = !on;
    this.panel.closest(".map-frame")?.classList.toggle("axes-mode", on);
    this.galaxy.setGuides(on ? GUIDE_LENGTH : null);
    this.apply();
  }

  private load(): Promise<void> {
    this.loading ??= fetch(this.url)
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.json();
      })
      .then((data: { axes: number; coords: number[] }) => {
        this.nAxes = data.axes;
        this.coords = Float32Array.from(data.coords, (c) => c / 100);
        const shown = this.catalog.movies.filter((m) => m.shown).map((m) => m.idx);
        this.centre = Array.from({ length: this.nAxes }, (_, axis) => {
          const values = shown.map((i) => this.coords![i * this.nAxes + axis]).sort((a, b) => a - b);
          return values[Math.floor(values.length / 2)] ?? 0;
        });
      })
      .catch((err) => {
        this.loading = null; // let a later click retry
        throw err;
      });
    return this.loading;
  }

  private apply() {
    if (!this.onAxes || !this.coords) {
      this.galaxy.setLayout(this.mapPositions.slice());
    } else {
      const n = this.mapPositions.length / 3;
      const next = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        for (let slot = 0; slot < 3; slot++) {
          const axis = this.chosen[slot];
          next[i * 3 + slot] = (this.coords[i * this.nAxes + axis] - this.centre[axis]) * SD_UNITS;
        }
      }
      this.galaxy.setLayout(next);
    }
    this.placePerson();
  }

  private placePerson() {
    if (this.onAxes && this.personAxes) {
      const at = this.chosen.map((a) => ((this.personAxes![a] ?? 0) - (this.centre[a] ?? 0)) * SD_UNITS);
      this.galaxy.setPerson(new THREE.Vector3(...at));
    } else {
      this.galaxy.setPerson(this.personMap);
    }
  }

  private buildSelectors() {
    const list = this.panel.querySelector(".axes-selects")!;
    SLOTS.forEach((label, slot) => {
      const id = `axis-select-${slot}`;
      const row = document.createElement("div");
      row.className = "axes-row";
      const name = document.createElement("label");
      name.htmlFor = id;
      name.textContent = label;
      const select = document.createElement("select");
      select.id = id;
      this.names.forEach((axis, k) => {
        const option = document.createElement("option");
        option.value = String(k);
        option.textContent = `${axis.name}: ${axis.low} → ${axis.high}`;
        select.append(option);
      });
      select.value = String(this.chosen[slot]);
      select.addEventListener("change", () => {
        const axis = Number(select.value);
        // Showing one axis twice flattens the cloud onto a line: swap with the slot that had it.
        const other = this.chosen.indexOf(axis);
        if (other >= 0 && other !== slot) {
          this.chosen[other] = this.chosen[slot];
          (this.panel.querySelector(`#axis-select-${other}`) as HTMLSelectElement).value = String(this.chosen[other]);
        }
        this.chosen[slot] = axis;
        this.apply();
      });
      row.append(name, select);
      list.append(row);
    });
  }
}
