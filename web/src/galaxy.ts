import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { type Catalog, genreColor } from "./data";

const HOME_CAMERA = new THREE.Vector3(0, 38, 235);
const FOCUS_DISTANCE = 42;
const NEIGHBOR_LINES = 8;
const CLICK_SLOP_PX = 5;
const ACCENT = "#f5c518"; // IMDb yellow ring
const LINE = "#b8900a"; // deeper gold so links stay visible on the light map

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const vertexShader = /* glsl */ `
  uniform float uScale;
  uniform float uPixelRatio;
  attribute vec3 color;
  attribute float aSize;
  attribute float aBoost;
  attribute float aBright;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vPx;

  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float dist = -mv.z;
    float px = clamp(aSize * aBoost * uScale / dist, 2.0, 20.0);
    gl_PointSize = px * uPixelRatio;
    vPx = px * uPixelRatio;
    // Far dots recede a little so the near side of the map reads first.
    float fade = clamp(1.3 - dist / 480.0, 0.5, 1.0);
    // Rarely rated films are fainter so dense regions keep their structure.
    float fame = clamp((aSize - 0.9) / 3.0, 0.0, 1.0);
    float presence = aBoost > 1.01 ? 1.0 : mix(0.55, 1.0, fame);
    vColor = color;
    vAlpha = aBright * fade * presence;
    gl_Position = projectionMatrix * mv;
  }
`;

const fragmentShader = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  varying float vPx;

  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float aa = 2.0 / max(vPx, 1.0);
    float disc = 1.0 - smoothstep(1.0 - aa, 1.0, d);
    if (disc <= 0.0) discard;
    // A hairline white rim separates overlapping dots, like a printed scatter plot.
    float rim = smoothstep(1.0 - aa * 2.5, 1.0 - aa, d);
    vec3 col = mix(vColor, vec3(1.0), rim * step(6.0, vPx) * 0.9);
    gl_FragColor = vec4(col, disc * vAlpha);
  }
`;

// Rings around chosen films (the ones a person rated): a hairline circle just outside each
// dot, sized like the dot itself so it follows zoom, filters and the dot's state.
const ringVertexShader = /* glsl */ `
  uniform float uScale;
  uniform float uPixelRatio;
  attribute float aSize;
  attribute float aBoost;
  attribute float aBright;
  varying float vAlpha;
  varying float vPx;

  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float px = clamp(aSize * aBoost * uScale / -mv.z, 2.0, 20.0) + 8.0;
    gl_PointSize = px * uPixelRatio;
    vPx = px * uPixelRatio;
    vAlpha = aBright;
    gl_Position = projectionMatrix * mv;
  }
`;

const ringFragmentShader = /* glsl */ `
  uniform vec3 uColor;
  varying float vAlpha;
  varying float vPx;

  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float aa = 2.0 / max(vPx, 1.0);
    float band = 3.0 / max(vPx, 1.0);
    float ring = smoothstep(1.0 - band - aa, 1.0 - band, d) * (1.0 - smoothstep(1.0 - aa, 1.0, d));
    if (ring <= 0.0 || vAlpha <= 0.0) discard;
    gl_FragColor = vec4(uColor, ring * 0.75 * vAlpha);
  }
`;

const YOU_SIZE = 0.085; // of the view's height
const HALO_PERIOD_MS = 2200;

interface Flight {
  fromCam: THREE.Vector3;
  toCam: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  start: number;
  duration: number;
  arc: number;
}

export interface GalaxyEvents {
  onHover(idx: number): void;
  onClick(idx: number): void;
  onFrame(): void;
  /** A plain scroll over the map, which scrolls the page instead of zooming. */
  onScrollPast(): void;
}

export class Galaxy {
  readonly camera: THREE.PerspectiveCamera;
  readonly screenX: Float32Array;
  readonly screenY: Float32Array;
  readonly depth: Float32Array;
  /** 1 when the movie projects inside the viewport, in front of the camera. */
  readonly onScreen: Uint8Array;
  width = 0;
  height = 0;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly controls: OrbitControls;
  private readonly material: THREE.ShaderMaterial;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly positions: Float32Array;
  private readonly sizes: Float32Array;
  private readonly boost: Float32Array;
  private readonly bright: Float32Array;
  private readonly lines: THREE.LineSegments;
  private readonly ring: THREE.Sprite;
  private readonly ring2: THREE.Sprite;
  /** "You": the person whose taste is shown, a dark dot no genre uses. */
  private readonly you: THREE.Sprite;
  /** A soft glow that pulses out from "you" so the dot is easy to spot. */
  private readonly halo: THREE.Sprite;
  /** Rings around the films a person rated; draws only the indexed films. */
  private readonly ratedGeometry = new THREE.BufferGeometry();
  private readonly rated: THREE.Points;
  private readonly viewProj = new THREE.Matrix4();

  private selected = -1;
  /** Two films being compared: both ringed, joined by one line. */
  private pair: [number, number] | null = null;
  private hovered = -1;
  private genreFilter: Set<number> | null = null;
  private flight: Flight | null = null;
  private pointerDown: { x: number; y: number } | null = null;
  private pointer: { x: number; y: number } | null = null;
  /** Full-window mode: the map owns the scroll wheel and every touch. */
  private expanded = false;
  /** Shift of the view, in px, so the focused star clears the movie card. */
  private readonly viewShift = new THREE.Vector2();
  private readonly viewShiftGoal = new THREE.Vector2();

  constructor(
    private readonly container: HTMLElement,
    private readonly catalog: Catalog,
    private readonly events: GalaxyEvents,
  ) {
    const n = catalog.movies.length;
    this.screenX = new Float32Array(n);
    this.screenY = new Float32Array(n);
    this.depth = new Float32Array(n);
    this.onScreen = new Uint8Array(n);

    // Transparent, so the frame's CSS gradient shows through behind the dots.
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.5, 4000);
    this.camera.position.copy(HOME_CAMERA);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.rotateSpeed = 0.55;
    this.controls.zoomSpeed = 0.9;
    this.controls.minDistance = 6;
    this.controls.maxDistance = 900;
    // On the scrolling page a plain wheel scrolls the page; zoom is pinch, ⌘/Ctrl-scroll or the buttons.
    this.controls.enableZoom = false;
    this.controls.addEventListener("start", () => {
      this.flight = null;
    });

    // Points: one dot per movie.
    this.positions = new Float32Array(n * 3);
    this.sizes = new Float32Array(n);
    this.boost = new Float32Array(n).fill(1);
    this.bright = new Float32Array(n).fill(1);
    const colors = new Float32Array(n * 3);
    const maxLog = Math.log1p(Math.max(...catalog.movies.map((m) => m.n)));
    const color = new THREE.Color();
    catalog.movies.forEach((m, i) => {
      this.positions.set(m.p, i * 3);
      color.set(genreColor(catalog.genres[m.pg]));
      colors.set([color.r, color.g, color.b], i * 3);
      this.sizes[i] = 0.9 + 3.0 * Math.pow(Math.log1p(m.n) / maxLog, 2.2);
    });
    this.geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    this.geometry.setAttribute("aSize", new THREE.BufferAttribute(this.sizes, 1));
    this.geometry.setAttribute("aBoost", new THREE.BufferAttribute(this.boost, 1));
    this.geometry.setAttribute("aBright", new THREE.BufferAttribute(this.bright, 1));

    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uScale: { value: 400 },
        uPixelRatio: { value: this.renderer.getPixelRatio() },
      },
      transparent: true,
      depthWrite: false,
    });
    this.scene.add(new THREE.Points(this.geometry, this.material));

    // Lines from the selected movie to the films most like it.
    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(NEIGHBOR_LINES * 6), 3));
    this.lines = new THREE.LineSegments(
      lineGeometry,
      // Yellow lines vanish on the light map (1.6:1), so these are near-black.
      new THREE.LineBasicMaterial({ color: LINE, transparent: true, opacity: 0.7, depthWrite: false }),
    );
    this.lines.visible = false;
    this.scene.add(this.lines);

    // Ring around the selected movie, fixed size on screen.
    this.ring = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: makeRingTexture(),
        sizeAttenuation: false,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.ring.visible = false;
    this.scene.add(this.ring);
    this.ring2 = this.ring.clone();
    this.scene.add(this.ring2);

    this.ring.scale.setScalar(0.07);
    this.ring2.scale.setScalar(0.07);

    this.you = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: makeYouTexture(),
        sizeAttenuation: false,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.you.scale.setScalar(YOU_SIZE);
    this.you.renderOrder = 3;
    this.you.visible = false;
    this.scene.add(this.you);
    this.halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: makeHaloTexture(),
        sizeAttenuation: false,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.halo.renderOrder = 2;
    this.halo.visible = false;
    this.scene.add(this.halo);

    // Shares the dots' attributes, so the rings hide and grow with their films.
    for (const name of ["position", "aSize", "aBoost", "aBright"]) {
      this.ratedGeometry.setAttribute(name, this.geometry.getAttribute(name));
    }
    this.rated = new THREE.Points(
      this.ratedGeometry,
      new THREE.ShaderMaterial({
        vertexShader: ringVertexShader,
        fragmentShader: ringFragmentShader,
        uniforms: {
          uScale: this.material.uniforms.uScale,
          uPixelRatio: this.material.uniforms.uPixelRatio,
          uColor: { value: new THREE.Color("#1d1d1f") },
        },
        transparent: true,
        depthWrite: false,
      }),
    );
    this.rated.frustumCulled = false;
    this.rated.visible = false;
    this.scene.add(this.rated);

    this.bindPointer();
    this.bindWheel();
    this.setExpanded(false);
    // The map area changes size when the sidebar opens or closes, not only with the window.
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  start() {
    const loop = () => {
      this.frame();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  select(idx: number, fly = true) {
    this.selected = idx;
    this.pair = null;
    this.ring2.visible = false;
    this.restyle();
    if (idx < 0) {
      this.lines.visible = false;
      this.ring.visible = false;
      return;
    }
    this.lines.visible = true;
    this.ring.visible = true;
    this.placeMarks();
    if (fly) this.flyTo(idx);
  }

  /** Ring two films, join them with a line and frame both. */
  showPair(a: number, b: number) {
    this.selected = -1;
    this.pair = [a, b];
    this.restyle();
    this.lines.visible = true;
    this.ring.visible = this.ring2.visible = true;
    this.placeMarks();
    const pa = this.pos(a);
    const pb = this.pos(b);

    const mid = pa.clone().add(pb).multiplyScalar(0.5);
    const distance = THREE.MathUtils.clamp(pa.distanceTo(pb) * 1.4, FOCUS_DISTANCE, 320);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    const travel = this.controls.target.distanceTo(mid);
    this.flyCamera(mid.clone().addScaledVector(dir, distance), mid, 900 + Math.min(travel, 250) * 4, travel * 0.35);
  }

  /** Slide the focused star this many px left of / above centre (eased); 0, 0 recentres. */
  setViewShift(x: number, y: number) {
    this.viewShiftGoal.set(x, y);
    if (reducedMotion) this.viewShift.set(x, y);
    this.applyViewShift();
  }

  setGenreFilter(filter: Set<number> | null) {
    this.genreFilter = filter && filter.size ? filter : null;
    this.restyle();
  }

  /** Hidden from the map: too rarely rated to place, or outside the genre filter. */
  isFiltered(idx: number): boolean {
    const movie = this.catalog.movies[idx];
    return !movie.shown || (this.genreFilter !== null && !movie.g.some((g) => this.genreFilter!.has(g)));
  }

  /** Ring these films, e.g. the ones a person rated, leaving the map otherwise as it is; null clears. */
  setRated(films: Iterable<number> | null) {
    const idx = films ? [...films] : [];
    this.ratedGeometry.setIndex(idx);
    this.rated.visible = idx.length > 0;
  }

  /** Show "you" at this point, or hide it with null. */
  setPerson(position: THREE.Vector3 | null) {
    this.you.visible = this.halo.visible = position !== null;
    if (position) {
      this.you.position.copy(position);
      this.halo.position.copy(position);
    }
  }

  get personPosition(): THREE.Vector3 | null {
    return this.you.visible ? this.you.position : null;
  }

  /** A 3D point in screen px within the map, or null when it's behind the camera. */
  toScreen(point: THREE.Vector3): { x: number; y: number } | null {
    const v = point.clone().project(this.camera);
    if (v.z > 1) return null;
    return { x: (v.x + 1) * (this.width / 2), y: (1 - v.y) * (this.height / 2) };
  }

  /** Fly to a point that isn't a film, such as "you". */
  flyToPoint(point: THREE.Vector3, distance = FOCUS_DISTANCE * 1.6) {
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    const travel = this.controls.target.distanceTo(point);
    this.flyCamera(point.clone().addScaledVector(dir, distance), point.clone(), 900 + Math.min(travel, 250) * 4, travel * 0.35);
  }

  flyTo(idx: number) {
    const movie = this.catalog.movies[idx];
    const target = this.pos(idx);
    // Back off far enough that most of the neighbour constellation is in frame.
    const spread = movie.nb
      .slice(0, NEIGHBOR_LINES)
      .map((j) => target.distanceTo(this.pos(j)))
      .sort((a, b) => a - b);
    const reach = spread[Math.floor(spread.length * 0.75)] ?? 0;
    const distance = THREE.MathUtils.clamp(reach * 1.7, FOCUS_DISTANCE, 110);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    const toCam = target.clone().addScaledVector(dir, distance);
    const travel = this.controls.target.distanceTo(target);
    this.flyCamera(toCam, target, 900 + Math.min(travel, 250) * 4, travel * 0.35);
  }

  resetView() {
    this.flyCamera(HOME_CAMERA, new THREE.Vector3(), 1100, 0);
  }

  /** Expanded: wheel zooms and touches always drive the map. Inline: vertical swipes scroll the page. */
  setExpanded(expanded: boolean) {
    this.expanded = expanded;
    this.controls.enableZoom = expanded;
    // OrbitControls sets touch-action: none; inline, let a vertical swipe scroll the page instead.
    this.renderer.domElement.style.touchAction = expanded ? "none" : "pan-y";
  }

  /** Move the camera toward (factor < 1) or away from (factor > 1) what it's looking at. */
  zoomBy(factor: number) {
    const target = this.controls.target.clone();
    const offset = this.camera.position.clone().sub(target);
    const distance = THREE.MathUtils.clamp(
      offset.length() * factor,
      this.controls.minDistance,
      this.controls.maxDistance,
    );
    this.flyCamera(target.clone().addScaledVector(offset.normalize(), distance), target, 260, 0);
  }

  /** On-screen dot diameter in CSS px, matching the clamp in the vertex shader. */
  pointSizePx(idx: number): number {
    const px = (this.sizes[idx] * this.boost[idx] * this.material.uniforms.uScale.value) / Math.max(this.depth[idx], 1);
    return Math.min(Math.max(px, 2), 20);
  }

  private pos(i: number): THREE.Vector3 {
    const p = this.positions;
    return new THREE.Vector3(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
  }

  /** Put the neighbour lines and rings on their films. */
  private placeMarks() {
    const lineAttr = this.lines.geometry.getAttribute("position") as THREE.BufferAttribute;
    if (this.pair) {
      const [pa, pb] = this.pair.map((i) => this.pos(i));
      lineAttr.setXYZ(0, pa.x, pa.y, pa.z);
      lineAttr.setXYZ(1, pb.x, pb.y, pb.z);
      this.lines.geometry.setDrawRange(0, 2);
      this.ring.position.copy(pa);
      this.ring2.position.copy(pb);
    } else if (this.selected >= 0) {
      const from = this.pos(this.selected);
      const nb = this.catalog.movies[this.selected].nb.slice(0, NEIGHBOR_LINES);
      nb.forEach((j, k) => {
        const to = this.pos(j);
        lineAttr.setXYZ(k * 2, from.x, from.y, from.z);
        lineAttr.setXYZ(k * 2 + 1, to.x, to.y, to.z);
      });
      this.lines.geometry.setDrawRange(0, nb.length * 2);
      this.ring.position.copy(from);
    }
    lineAttr.needsUpdate = true;
  }

  private restyle() {
    const movies = this.catalog.movies;
    const neighbors = new Set(this.selected >= 0 ? movies[this.selected].nb.slice(0, NEIGHBOR_LINES) : []);
    for (let i = 0; i < movies.length; i++) {
      let bright = !movies[i].shown ? 0 : this.isFiltered(i) ? 0.07 : 1;
      let boost = 1;
      if (this.pair) {
        if (this.pair.includes(i)) [bright, boost] = [1, 2.2];
        else bright *= 0.45;
      } else if (this.selected >= 0) {
        if (i === this.selected) [bright, boost] = [1, 2.2];
        else if (neighbors.has(i)) [bright, boost] = [1, 1.6];
        else bright *= 0.45;
      }
      if (i === this.hovered && i !== this.selected) [bright, boost] = [1, Math.max(boost, 1.8)];
      this.bright[i] = bright;
      this.boost[i] = boost;
    }
    this.geometry.getAttribute("aBright").needsUpdate = true;
    this.geometry.getAttribute("aBoost").needsUpdate = true;
  }

  private flyCamera(toCam: THREE.Vector3, toTarget: THREE.Vector3, duration: number, arc: number) {
    this.flight = {
      fromCam: this.camera.position.clone(),
      toCam,
      fromTarget: this.controls.target.clone(),
      toTarget,
      start: performance.now(),
      duration: reducedMotion ? 1 : duration,
      arc,
    };
  }

  private frame() {
    const now = performance.now();

    if (this.flight) {
      const f = this.flight;
      const p = Math.min((now - f.start) / f.duration, 1);
      const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      this.controls.target.lerpVectors(f.fromTarget, f.toTarget, e);
      this.camera.position.lerpVectors(f.fromCam, f.toCam, e);
      // Pull back mid-flight on long hops so the trip reads as a swoop, not a zoom.
      if (f.arc > 0) {
        const away = this.camera.position.clone().sub(this.controls.target).normalize();
        this.camera.position.addScaledVector(away, Math.sin(Math.PI * e) * f.arc);
      }
      if (p >= 1) this.flight = null;
    }

    if (this.halo.visible) {
      // Breathe outward and fade; held at a soft steady glow for reduced motion.
      const t = reducedMotion ? 0.35 : (now % HALO_PERIOD_MS) / HALO_PERIOD_MS;
      this.halo.scale.setScalar(YOU_SIZE * (1.2 + t * 1.3));
      this.halo.material.opacity = reducedMotion ? 0.5 : 0.65 * (1 - t);
    }

    if (!this.viewShift.equals(this.viewShiftGoal)) {
      this.viewShift.lerp(this.viewShiftGoal, 0.08);
      if (this.viewShift.distanceTo(this.viewShiftGoal) < 0.5) this.viewShift.copy(this.viewShiftGoal);
      this.applyViewShift();
    }

    this.controls.update();
    this.camera.updateMatrixWorld();

    this.project();
    if (this.pointer && !this.pointerDown) this.updateHover();
    this.events.onFrame();
    this.renderer.render(this.scene, this.camera);
  }

  private project() {
    this.viewProj.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    const e = this.viewProj.elements;
    const pos = this.positions;
    const w2 = this.width / 2;
    const h2 = this.height / 2;
    for (let i = 0, n = this.depth.length; i < n; i++) {
      const x = pos[i * 3];
      const y = pos[i * 3 + 1];
      const z = pos[i * 3 + 2];
      const w = e[3] * x + e[7] * y + e[11] * z + e[15];
      this.depth[i] = w;
      if (w < 1) {
        this.onScreen[i] = 0;
        continue;
      }
      const sx = ((e[0] * x + e[4] * y + e[8] * z + e[12]) / w + 1) * w2;
      const sy = (1 - (e[1] * x + e[5] * y + e[9] * z + e[13]) / w) * h2;
      this.screenX[i] = sx;
      this.screenY[i] = sy;
      this.onScreen[i] = sx > -20 && sx < this.width + 20 && sy > -20 && sy < this.height + 20 ? 1 : 0;
    }
  }

  /** Movie under a screen point: the nearest dot within reach, front-most on ties. */
  private pick(x: number, y: number): number {
    let best = -1;
    let bestScore = Infinity;
    for (let i = 0, n = this.depth.length; i < n; i++) {
      if (!this.onScreen[i] || this.isFiltered(i)) continue;
      const dx = this.screenX[i] - x;
      const dy = this.screenY[i] - y;
      const d2 = dx * dx + dy * dy;
      const radius = Math.max(8, this.pointSizePx(i) / 2 + 3);
      if (d2 > radius * radius) continue;
      const score = Math.sqrt(d2) / radius + this.depth[i] * 1e-4;
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best;
  }

  private updateHover() {
    const idx = this.pick(this.pointer!.x, this.pointer!.y);
    if (idx === this.hovered) return;
    this.hovered = idx;
    this.renderer.domElement.style.cursor = idx >= 0 ? "pointer" : "";
    this.restyle();
    this.events.onHover(idx);
  }

  private bindPointer() {
    const el = this.renderer.domElement;
    const local = (ev: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    };
    el.addEventListener("pointermove", (ev) => {
      this.pointer = local(ev);
    });
    el.addEventListener("pointerleave", () => {
      this.pointer = null;
      if (this.hovered >= 0) {
        this.hovered = -1;
        this.restyle();
        this.events.onHover(-1);
      }
    });
    el.addEventListener("pointerdown", (ev) => {
      this.pointerDown = local(ev);
    });
    el.addEventListener("pointerup", (ev) => {
      const down = this.pointerDown;
      this.pointerDown = null;
      if (!down || ev.button !== 0) return;
      const up = local(ev);
      if (Math.hypot(up.x - down.x, up.y - down.y) > CLICK_SLOP_PX) return;
      this.events.onClick(this.pick(up.x, up.y));
    });
  }

  private bindWheel() {
    this.renderer.domElement.addEventListener(
      "wheel",
      (ev) => {
        if (this.expanded) return; // OrbitControls zooms
        if (!ev.ctrlKey && !ev.metaKey) {
          this.events.onScrollPast();
          return;
        }
        // Trackpad pinches arrive as ctrl+wheel with small deltas; mouse wheels with big ones.
        ev.preventDefault();
        this.flight = null;
        const target = this.controls.target;
        const offset = this.camera.position.clone().sub(target);
        const distance = THREE.MathUtils.clamp(
          offset.length() * Math.exp(ev.deltaY * (ev.ctrlKey ? 0.01 : 0.002)),
          this.controls.minDistance,
          this.controls.maxDistance,
        );
        this.camera.position.copy(target).addScaledVector(offset.normalize(), distance);
      },
      { passive: false },
    );
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.applyViewShift();
    this.material.uniforms.uScale.value = h / 2;
    this.material.uniforms.uPixelRatio.value = this.renderer.getPixelRatio();
  }

  private applyViewShift() {
    const { x, y } = this.viewShift;
    if (x === 0 && y === 0) this.camera.clearViewOffset();
    else this.camera.setViewOffset(this.width, this.height, x, y, this.width, this.height);
    this.camera.updateProjectionMatrix();
  }
}

function makeRingTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const c = size / 2;
  // A near-black outline under the yellow ring keeps it visible on the light map.
  ctx.lineWidth = 12;
  ctx.strokeStyle = "#1d1d1f";
  ctx.beginPath();
  ctx.arc(c, c, c * 0.7, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 5;
  ctx.strokeStyle = ACCENT;
  ctx.beginPath();
  ctx.arc(c, c, c * 0.7, 0, Math.PI * 2);
  ctx.stroke();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** "You": a near-black dot ringed in white, so it reads over any genre colour. */
function makeYouTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const c = size / 2;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(c, c, c * 0.92, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#1d1d1f";
  ctx.beginPath();
  ctx.arc(c, c, c * 0.72, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = ACCENT;
  ctx.beginPath();
  ctx.arc(c, c, c * 0.3, 0, Math.PI * 2);
  ctx.fill();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makeHaloTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const c = size / 2;
  const glow = ctx.createRadialGradient(c, c, c * 0.35, c, c, c);
  glow.addColorStop(0, "rgba(245, 197, 24, 0.6)");
  glow.addColorStop(1, "rgba(245, 197, 24, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
