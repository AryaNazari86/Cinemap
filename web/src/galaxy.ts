import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { type Catalog, genreColor } from "./data";

const HOME_CAMERA = new THREE.Vector3(0, 38, 235);
const INTRO_CAMERA = new THREE.Vector3(40, 140, 620);
const FOCUS_DISTANCE = 42;
const NEIGHBOR_LINES = 8;
const IDLE_BEFORE_DRIFT_MS = 20_000;
const CLICK_SLOP_PX = 5;

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uScale;
  uniform float uPixelRatio;
  attribute vec3 color;
  attribute float aSize;
  attribute float aBoost;
  attribute float aBright;
  attribute float aPhase;
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float dist = -mv.z;
    float twinkle = 0.88 + 0.12 * sin(uTime * 1.4 + aPhase);
    gl_PointSize = clamp(aSize * aBoost * uScale / dist, 2.0, 110.0) * uPixelRatio;
    // Far stars fade a little so the near side of the galaxy reads first.
    float fade = clamp(1.25 - dist / 520.0, 0.35, 1.0);
    vColor = color;
    vAlpha = aBright * twinkle * fade;
    gl_Position = projectionMatrix * mv;
  }
`;

const fragmentShader = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    float glow = pow(1.0 - d, 2.4);
    float core = smoothstep(0.32, 0.0, d);
    vec3 col = mix(vColor, vec3(1.0, 0.97, 0.9), core * 0.85);
    gl_FragColor = vec4(col, (glow * 0.85 + core) * vAlpha);
  }
`;

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
  private readonly viewProj = new THREE.Matrix4();
  private readonly clock = new THREE.Clock();

  private selected = -1;
  private hovered = -1;
  private genreFilter: Set<number> | null = null;
  private flight: Flight | null = null;
  private lastInteraction = performance.now();
  private pointerDown: { x: number; y: number } | null = null;
  private pointer: { x: number; y: number } | null = null;
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

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.5, 4000);
    this.camera.position.copy(reducedMotion ? HOME_CAMERA : INTRO_CAMERA);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.rotateSpeed = 0.55;
    this.controls.zoomSpeed = 0.9;
    this.controls.minDistance = 6;
    this.controls.maxDistance = 900;
    this.controls.autoRotate = !reducedMotion;
    this.controls.autoRotateSpeed = 0.22;
    this.controls.addEventListener("start", () => {
      this.flight = null;
      this.controls.autoRotate = false;
      this.lastInteraction = performance.now();
    });

    // Points: one glowing star per movie.
    this.positions = new Float32Array(n * 3);
    this.sizes = new Float32Array(n);
    this.boost = new Float32Array(n).fill(1);
    this.bright = new Float32Array(n).fill(1);
    const colors = new Float32Array(n * 3);
    const phases = new Float32Array(n);
    const maxLog = Math.log1p(Math.max(...catalog.movies.map((m) => m.n)));
    const color = new THREE.Color();
    catalog.movies.forEach((m, i) => {
      this.positions.set(m.p, i * 3);
      color.set(genreColor(catalog.genres[m.pg]));
      colors.set([color.r, color.g, color.b], i * 3);
      this.sizes[i] = 2.4 + 7.6 * Math.pow(Math.log1p(m.n) / maxLog, 1.6);
      phases[i] = Math.random() * Math.PI * 2;
    });
    this.geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    this.geometry.setAttribute("aSize", new THREE.BufferAttribute(this.sizes, 1));
    this.geometry.setAttribute("aBoost", new THREE.BufferAttribute(this.boost, 1));
    this.geometry.setAttribute("aBright", new THREE.BufferAttribute(this.bright, 1));
    this.geometry.setAttribute("aPhase", new THREE.BufferAttribute(phases, 1));

    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uScale: { value: 400 },
        uPixelRatio: { value: this.renderer.getPixelRatio() },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.scene.add(new THREE.Points(this.geometry, this.material));

    // Constellation lines from the selected movie to its nearest neighbours.
    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(NEIGHBOR_LINES * 6), 3));
    lineGeometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(NEIGHBOR_LINES * 6), 3));
    this.lines = new THREE.LineSegments(
      lineGeometry,
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.55,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.lines.visible = false;
    this.scene.add(this.lines);

    // Reticle around the selected movie, fixed size on screen.
    this.ring = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: makeReticleTexture(),
        sizeAttenuation: false,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.ring.visible = false;
    this.scene.add(this.ring);

    this.bindPointer();
    window.addEventListener("resize", () => this.resize());
    this.resize();
  }

  start() {
    if (!reducedMotion) this.flyCamera(HOME_CAMERA, new THREE.Vector3(), 2600, 0);
    const loop = () => {
      this.frame();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  select(idx: number, fly = true) {
    this.selected = idx;
    this.restyle();
    const lineAttr = this.lines.geometry.getAttribute("position") as THREE.BufferAttribute;
    const colorAttr = this.lines.geometry.getAttribute("color") as THREE.BufferAttribute;
    if (idx < 0) {
      this.lines.visible = false;
      this.ring.visible = false;
      this.lastInteraction = performance.now();
      return;
    }
    const movie = this.catalog.movies[idx];
    const gold = new THREE.Color("#ffd27a");
    const c = new THREE.Color();
    movie.nb.slice(0, NEIGHBOR_LINES).forEach((j, k) => {
      lineAttr.setXYZ(k * 2, ...movie.p);
      lineAttr.setXYZ(k * 2 + 1, ...this.catalog.movies[j].p);
      colorAttr.setXYZ(k * 2, gold.r, gold.g, gold.b);
      c.set(genreColor(this.catalog.genres[this.catalog.movies[j].pg])).multiplyScalar(0.6);
      colorAttr.setXYZ(k * 2 + 1, c.r, c.g, c.b);
    });
    lineAttr.needsUpdate = true;
    colorAttr.needsUpdate = true;
    this.lines.geometry.setDrawRange(0, Math.min(NEIGHBOR_LINES, movie.nb.length) * 2);
    this.lines.visible = true;
    this.ring.position.set(...movie.p);
    this.ring.visible = true;
    this.controls.autoRotate = false;
    if (fly) this.flyTo(idx);
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

  isFiltered(idx: number): boolean {
    return this.genreFilter !== null && !this.catalog.movies[idx].g.some((g) => this.genreFilter!.has(g));
  }

  flyTo(idx: number) {
    const movie = this.catalog.movies[idx];
    const target = new THREE.Vector3(...movie.p);
    // Back off far enough that most of the neighbour constellation is in frame.
    const spread = movie.nb
      .slice(0, NEIGHBOR_LINES)
      .map((j) => target.distanceTo(new THREE.Vector3(...this.catalog.movies[j].p)))
      .sort((a, b) => a - b);
    const reach = spread[Math.floor(spread.length * 0.75)] ?? 0;
    const distance = THREE.MathUtils.clamp(reach * 1.7, FOCUS_DISTANCE, 110);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    const toCam = target.clone().addScaledVector(dir, distance);
    const travel = this.controls.target.distanceTo(target);
    this.flyCamera(toCam, target, 900 + Math.min(travel, 250) * 4, travel * 0.35);
  }

  resetView() {
    this.flyCamera(HOME_CAMERA, new THREE.Vector3(), 1500, 0);
  }

  pointSizePx(idx: number): number {
    return (this.sizes[idx] * this.boost[idx] * this.material.uniforms.uScale.value) / Math.max(this.depth[idx], 1);
  }

  private restyle() {
    const movies = this.catalog.movies;
    const neighbors = new Set(this.selected >= 0 ? movies[this.selected].nb.slice(0, NEIGHBOR_LINES) : []);
    for (let i = 0; i < movies.length; i++) {
      let bright = this.isFiltered(i) ? 0.07 : 1;
      let boost = 1;
      if (this.selected >= 0) {
        if (i === this.selected) [bright, boost] = [1.4, 2.3];
        else if (neighbors.has(i)) [bright, boost] = [1.15, 1.5];
        else bright *= 0.5;
      }
      if (i === this.hovered && i !== this.selected) [bright, boost] = [1.3, Math.max(boost, 1.9)];
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
    const t = this.clock.getElapsedTime();
    if (!reducedMotion) this.material.uniforms.uTime.value = t;

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
    } else if (
      this.selected < 0 &&
      !reducedMotion &&
      !this.controls.autoRotate &&
      now - this.lastInteraction > IDLE_BEFORE_DRIFT_MS
    ) {
      this.controls.autoRotate = true;
    }

    if (!this.viewShift.equals(this.viewShiftGoal)) {
      this.viewShift.lerp(this.viewShiftGoal, 0.08);
      if (this.viewShift.distanceTo(this.viewShiftGoal) < 0.5) this.viewShift.copy(this.viewShiftGoal);
      this.applyViewShift();
    }

    this.controls.update();
    this.camera.updateMatrixWorld();

    if (this.ring.visible) {
      const pulse = reducedMotion ? 0 : Math.sin(t * 2.4) * 0.006;
      this.ring.scale.setScalar(0.085 + pulse);
      this.ring.material.rotation = reducedMotion ? 0 : t * 0.35;
    }

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

  /** Movie under a screen point: the nearest star whose glow covers it, front-most on ties. */
  private pick(x: number, y: number): number {
    let best = -1;
    let bestScore = Infinity;
    for (let i = 0, n = this.depth.length; i < n; i++) {
      if (!this.onScreen[i] || this.isFiltered(i)) continue;
      const dx = this.screenX[i] - x;
      const dy = this.screenY[i] - y;
      const d2 = dx * dx + dy * dy;
      const radius = Math.max(9, this.pointSizePx(i) * 0.32);
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

function makeReticleTexture(): THREE.Texture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const c = size / 2;
  ctx.strokeStyle = "rgba(255, 214, 140, 0.95)";
  ctx.lineWidth = 5;
  // Four arcs with gaps, like a viewfinder.
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2 + 0.25;
    ctx.beginPath();
    ctx.arc(c, c, c * 0.72, a, a + Math.PI / 2 - 0.5);
    ctx.stroke();
  }
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(255, 214, 140, 0.55)";
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2;
    ctx.beginPath();
    ctx.moveTo(c + Math.cos(a) * c * 0.8, c + Math.sin(a) * c * 0.8);
    ctx.lineTo(c + Math.cos(a) * c * 0.96, c + Math.sin(a) * c * 0.96);
    ctx.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
