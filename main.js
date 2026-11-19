import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import Lenis from 'lenis';

/* =========================================================
   Spy Chess home page scene
   Scroll drives the story, dragging turns the board, the
   pointer steers the lamp, clicks play "Find the spies".
   ========================================================= */

const THREE_CDN = 'https://cdn.jsdelivr.net/npm/three@0.170.0';
const root = document.documentElement;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const coarse = matchMedia('(pointer: coarse)').matches;

// ---------- math helpers ----------
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const ramp = (v, a, b) => clamp01((v - a) / (b - a));
const smooth = (t) => t * t * (3 - 2 * t);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const lerp = (a, b, t) => a + (b - a) * t;
const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));

const FILES = 'abcdefgh';
const square = (name) => new THREE.Vector3(FILES.indexOf(name[0]) - 3.5, 0, 3.5 - (Number(name[1]) - 1));

// ---------- renderer ----------
const canvas = document.getElementById('scene');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
} catch (err) {
  root.classList.add('no-webgl', 'ready');
  throw err;
}
let pixelRatio = Math.min(window.devicePixelRatio || 1, coarse ? 1.5 : 2);
renderer.setPixelRatio(pixelRatio);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#15152a');
scene.fog = new THREE.Fog(scene.background.clone(), 26, 56);

const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 120);

// ---------- themes ----------
// each pair is [story chapters, hero], so the hero can be lit mostly by the lamp
const THEMES = {
  dark: {
    bg: new THREE.Color('#15152a'),
    floor: new THREE.Color('#17172c'),
    sky: new THREE.Color('#596096'),
    ground: new THREE.Color('#0b0b16'),
    env: [0.42, 0.14],
    hemi: [0.35, 0.1],
    lamp: [260, 520],
    fill: [0.35, 0.02],
    rim: [1.3, 0.8],
  },
  light: {
    bg: new THREE.Color('#efe8d8'),
    floor: new THREE.Color('#e3d8c1'),
    sky: new THREE.Color('#fff6e4'),
    ground: new THREE.Color('#a8957a'),
    env: [0.95, 0.6],
    hemi: [0.7, 0.45],
    lamp: [200, 360],
    fill: [1.1, 0.5],
    rim: [0.5, 0.35],
  },
};
const mqLight = matchMedia('(prefers-color-scheme: light)');
const themeMeta = document.querySelector('meta[name="theme-color"]');
const toggle = document.getElementById('themeToggle');
const resolvedTheme = () => root.dataset.theme || (mqLight.matches ? 'light' : 'dark');
let themeGoal = resolvedTheme() === 'light' ? 1 : 0;
let themeMix = themeGoal;

function syncThemeUI() {
  const t = resolvedTheme();
  themeGoal = t === 'light' ? 1 : 0;
  toggle.setAttribute('aria-label', t === 'light' ? 'Switch to dark theme' : 'Switch to light theme');
  themeMeta.setAttribute('content', t === 'light' ? '#efe8d8' : '#15152a');
}
toggle.addEventListener('click', () => {
  const next = resolvedTheme() === 'light' ? 'dark' : 'light';
  root.dataset.theme = next;
  try {
    localStorage.setItem('spy-theme', next);
  } catch (e) {
    /* storage can be blocked; the choice still applies for this visit */
  }
  syncThemeUI();
});
mqLight.addEventListener('change', syncThemeUI);
syncThemeUI();

// ---------- lights ----------
const hemi = new THREE.HemisphereLight('#596096', '#0b0b16', 0.35);
scene.add(hemi);

const lamp = new THREE.SpotLight('#ffd9a8', 260, 0, Math.PI / 6, 0.65, 2);
lamp.position.set(1.2, 13, 3.5);
lamp.castShadow = true;
lamp.shadow.mapSize.set(coarse ? 1024 : 2048, coarse ? 1024 : 2048);
lamp.shadow.bias = -0.0002;
lamp.shadow.normalBias = 0.025;
lamp.shadow.camera.near = 6;
lamp.shadow.camera.far = 24;
scene.add(lamp, lamp.target);

const rim = new THREE.DirectionalLight('#a3b0ff', 1.3);
rim.position.set(-8, 7, -10);
scene.add(rim);

const fill = new THREE.DirectionalLight('#ffe7c4', 0.35);
fill.position.set(8, 10, 8);
fill.castShadow = !coarse;
fill.shadow.mapSize.set(1024, 1024);
fill.shadow.camera.left = fill.shadow.camera.bottom = -8;
fill.shadow.camera.right = fill.shadow.camera.top = 8;
fill.shadow.bias = -0.0003;
fill.shadow.normalBias = 0.03;
scene.add(fill);

const floorMat = new THREE.MeshStandardMaterial({ color: '#17172c', roughness: 0.92 });
const floor = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), floorMat);
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.3;
floor.receiveShadow = true;
scene.add(floor);

// ---------- markers on the board ----------
function merge(parts) {
  const list = parts.map((g) => (g.index ? g.toNonIndexed() : g));
  let count = 0;
  for (const g of list) count += g.attributes.position.count;
  const pos = new Float32Array(count * 3);
  let o = 0;
  for (const g of list) {
    pos.set(g.attributes.position.array, o);
    o += g.attributes.position.array.length;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return out;
}
function squareRingGeo(half, thick) {
  const k = Math.cos(Math.PI / 4);
  const g = new THREE.RingGeometry((half - thick) / k, half / k, 4, 1);
  g.rotateZ(Math.PI / 4);
  g.rotateX(-Math.PI / 2);
  return g;
}
function bracketGeo(half, len, thick) {
  const parts = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const a = new THREE.PlaneGeometry(len, thick);
      a.rotateX(-Math.PI / 2);
      a.translate(sx * (half - len / 2), 0, sz * (half - thick / 2));
      const b = new THREE.PlaneGeometry(thick, len);
      b.rotateX(-Math.PI / 2);
      b.translate(sx * (half - thick / 2), 0, sz * (half - len / 2));
      parts.push(a, b);
    }
  }
  return merge(parts);
}
function crossGeo(len, thick) {
  const a = new THREE.PlaneGeometry(len, thick);
  a.rotateZ(Math.PI / 4);
  const b = new THREE.PlaneGeometry(len, thick);
  b.rotateZ(-Math.PI / 4);
  const g = merge([a, b]);
  g.rotateX(-Math.PI / 2);
  return g;
}
const markerMat = (color) =>
  new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
  });
const RING_GEO = squareRingGeo(0.47, 0.05);
const BRACKET_GEO = bracketGeo(0.47, 0.17, 0.045);
const CROSS_GEO = crossGeo(0.5, 0.045);
const DOT_GEO = new THREE.CircleGeometry(0.09, 28).rotateX(-Math.PI / 2);
const SPY_RED = new THREE.Color('#d6434a');
const CREAM = new THREE.Color('#f4eedf');
const STONE = new THREE.Color('#9b968c');

const MARK_Y = 0.012;
function marker(geo, color) {
  const m = new THREE.Mesh(geo, markerMat(color));
  m.position.y = MARK_Y;
  m.visible = false;
  m.renderOrder = 3;
  scene.add(m);
  return m;
}

// ---------- the story position ----------
// type, colour, starting square, square in the move-9 position
const LAYOUT = [
  ['R', 'w', 'a1', 'a1'], ['N', 'w', 'b1', 'c3'], ['B', 'w', 'c1', 'c1'], ['Q', 'w', 'd1', 'd1'],
  ['K', 'w', 'e1', 'g1'], ['B', 'w', 'f1', 'c4'], ['N', 'w', 'g1', 'f3'], ['R', 'w', 'h1', 'f1'],
  ['P', 'w', 'a2', 'a2'], ['P', 'w', 'b2', 'b2'], ['P', 'w', 'c2', 'c2'], ['P', 'w', 'd2', 'd3'],
  ['P', 'w', 'e2', 'e4'], ['P', 'w', 'f2', 'f2'], ['P', 'w', 'g2', 'g2'], ['P', 'w', 'h2', 'h2'],
  ['R', 'b', 'a8', 'a8'], ['N', 'b', 'b8', 'c6'], ['B', 'b', 'c8', 'c8'], ['Q', 'b', 'd8', 'd8'],
  ['K', 'b', 'e8', 'h8'], ['B', 'b', 'f8', 'b6'], ['N', 'b', 'g8', 'e7'], ['R', 'b', 'h8', 'f8'],
  ['P', 'b', 'a7', 'a7'], ['P', 'b', 'b7', 'b7'], ['P', 'b', 'c7', 'c7'], ['P', 'b', 'd7', 'd6'],
  ['P', 'b', 'e7', 'e5'], ['P', 'b', 'f7', 'f7'], ['P', 'b', 'g7', 'g7'], ['P', 'b', 'h7', 'h7'],
];

const pieces = LAYOUT.map(([type, color, start, story], idx) => {
  const group = new THREE.Group();
  scene.add(group);
  return {
    idx, type, color,
    isWhite: color === 'w',
    group,
    start: square(start),
    story: square(story),
    baseRotY: 0,
    meshes: [],
    swaps: [],
    lookWhite: color === 'w',
    hover: 0,
    demo: null,
    ring: null,
    cross: null,
  };
});
const byStory = (sq) => pieces.find((p) => p.story.equals(square(sq)));
const spyKnight = byStory('e7');
const storySpies = [spyKnight, byStory('b6'), byStory('h7')];
const victim = byStory('c6');
const blackKing = byStory('h8');
const ghostTargets = ['f3', 'c1', 'a2'].map(byStory);
const C6 = square('c6');
// both parts of the capture share one clock, so the piece leaves exactly as the knight lands
const KNIGHT_HOP = [0.15, 0.85];
const VICTIM_OUT = [0.5, 0.9];
const FRAME_X = 4.5; // middle of the frame strip, beside the a- and h-files
const FRAME_Y = 0.03;
const VICTIM_SPOT = new THREE.Vector3(-FRAME_X, FRAME_Y, 0.9);

for (const p of pieces) {
  if (!p.isWhite) {
    p.ring = marker(RING_GEO, SPY_RED);
    // a loyal piece gets a quiet cream square after a wrong guess
    p.cross = marker(RING_GEO, CREAM);
  }
}
const ghostMarks = ghostTargets.map(() => marker(BRACKET_GEO, SPY_RED));
const kingRing = marker(RING_GEO, STONE);
const kingCross = marker(CROSS_GEO, STONE);
const moveDots = ['c8', 'c6', 'd5', 'f5', 'g6', 'g8'].map((sq) => {
  const d = marker(DOT_GEO, CREAM);
  d.position.copy(square(sq)).setY(MARK_Y);
  return d;
});

// the spy's hat, from the logo
const hat = new THREE.Group();
{
  const felt = new THREE.MeshStandardMaterial({ color: '#16141b', roughness: 0.85 });
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.28, 0.025, 48), felt);
  const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.17, 0.2, 48), felt);
  crown.position.y = 0.11;
  const band = new THREE.Mesh(
    new THREE.CylinderGeometry(0.172, 0.174, 0.045, 48),
    new THREE.MeshStandardMaterial({ color: '#a8262d', roughness: 0.6 })
  );
  band.position.y = 0.04;
  for (const m of [brim, crown, band]) m.castShadow = true;
  hat.add(brim, crown, band);
  hat.visible = false;
}

// ---------- loading the chess set ----------
const SET_SCALE = 16; // the model's squares are 0.0625 units wide
const BOARD_TOP = 0.0172; // height of the playing surface in model units
const loadbar = document.getElementById('loadbar');
const loaderPct = document.getElementById('loaderPct');
let shownProgress = 0;
const setProgress = (p) => {
  // progress only moves forward, so the bar and ring never jump back
  shownProgress = Math.max(shownProgress, p);
  root.style.setProperty('--p', Math.max(0.04, shownProgress).toFixed(3));
  if (loaderPct) loaderPct.textContent = `${Math.round(shownProgress * 100)}%`;
};

const draco = new DRACOLoader().setDecoderPath(`${THREE_CDN}/examples/jsm/libs/draco/gltf/`);
const ktx2 = new KTX2Loader().setTranscoderPath(`${THREE_CDN}/examples/jsm/libs/basis/`).detectSupport(renderer);
const gltfLoader = new GLTFLoader().setDRACOLoader(draco).setKTX2Loader(ktx2);

const pickables = [];

function typeOf(name) {
  if (name.startsWith('King')) return 'K';
  if (name.startsWith('Queen')) return 'Q';
  if (name.startsWith('Castle')) return 'R';
  if (name.startsWith('Knight')) return 'N';
  if (name.startsWith('Bishop')) return 'B';
  if (name.startsWith('Pawn_Body')) return 'P';
  return null;
}

let setMaterials = {};
function installSet(gltf) {
  const model = gltf.scene;
  const materials = {};
  setMaterials = materials;
  model.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    for (const m of [o.material].flat()) {
      materials[m.name] = m;
      if (m.map) m.map.anisotropy = renderer.capabilities.getMaxAnisotropy();
      // the glass pawn tops refract the scene; phones get a cheaper solid glass
      if (coarse && m.transmission > 0) {
        m.transmission = 0;
        m.roughness = Math.min(m.roughness, 0.15);
      }
    }
  });

  // board: turn it so White sits on +z and the a-file on -x, with the playing surface at y = 0
  const board = model.getObjectByName('Chessboard');
  const boardHolder = new THREE.Group();
  boardHolder.scale.setScalar(SET_SCALE);
  boardHolder.rotation.y = Math.PI;
  boardHolder.position.y = -BOARD_TOP * SET_SCALE;
  board.position.set(0, 0, 0);
  boardHolder.add(board);
  scene.add(boardHolder);
  floor.position.y = -BOARD_TOP * SET_SCALE - 0.002;

  // pieces: each model node is handed to one piece of the layout
  const pool = { w: {}, b: {} };
  for (const node of [...model.children]) {
    const t = typeOf(node.name || '');
    if (!t) continue;
    const col = /_W/.test(node.name) ? 'w' : 'b';
    (pool[col][t] ||= []).push(node);
  }
  const counterpart = (name) => (name.includes('Black') ? name.replace('Black', 'White') : name.replace('White', 'Black'));

  for (const p of pieces) {
    const node = pool[p.color][p.type].shift();
    const inner = new THREE.Group();
    inner.scale.setScalar(SET_SCALE);
    inner.rotation.y = Math.PI;
    node.position.set(0, node.position.y - BOARD_TOP, 0);
    inner.add(node);
    p.group.add(inner);
    if (p.type === 'N') p.baseRotY = p.isWhite ? 0.55 : -0.55;
    node.traverse((o) => {
      if (!o.isMesh) return;
      o.userData.piece = p;
      const own = o.material;
      const other = materials[counterpart(own.name)] || own;
      p.meshes.push(o);
      p.swaps.push(p.isWhite ? { white: own, black: other } : { white: other, black: own });
    });
  }

  // every piece gets a light invisible cylinder for picking, so hover tests stay cheap
  const proxyMat = new THREE.MeshBasicMaterial({ visible: false });
  for (const p of pieces) {
    p.group.updateMatrixWorld(true);
    const bb = new THREE.Box3();
    for (const m of p.meshes) bb.expandByObject(m);
    const h = Math.max(1, bb.max.y - p.group.position.y);
    const proxy = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, h, 12).translate(0, h / 2, 0), proxyMat);
    proxy.userData.piece = p;
    p.group.add(proxy);
    pickables.push(proxy);
  }

  // the hat sits on the spy knight's head: find the highest part of the mesh and centre the hat over it
  spyKnight.group.position.set(0, 0, 0);
  spyKnight.group.rotation.set(0, 0, 0);
  spyKnight.group.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  let top = -Infinity;
  const pts = [];
  for (const mesh of spyKnight.meshes) {
    const posAttr = mesh.geometry.attributes.position;
    for (let i = 0; i < posAttr.count; i += 3) {
      v.fromBufferAttribute(posAttr, i).applyMatrix4(mesh.matrixWorld);
      pts.push(v.x, v.y, v.z);
      if (v.y > top) top = v.y;
    }
  }
  // average the points in the top slice of the head, so the hat lands on the crown, not the ears
  let cx = 0, cz = 0, n = 0;
  for (let i = 0; i < pts.length; i += 3) {
    if (pts[i + 1] > top - 0.12) {
      cx += pts[i];
      cz += pts[i + 2];
      n++;
    }
  }
  cx /= n || 1;
  cz /= n || 1;
  // the brim rests on the tips of the ears, so no part of the head pokes through the hat
  hat.position.set(cx, top - 0.015, cz);
  hat.userData.y = hat.position.y;
  hat.userData.scale = 0.85;
  hat.rotation.set(0, 0, 0.08);
  spyKnight.group.add(hat);
}

function setLook(p, white) {
  if (p.lookWhite === white || !p.meshes.length) return;
  p.lookWhite = white;
  p.meshes.forEach((m, i) => {
    m.material = white ? p.swaps[i].white : p.swaps[i].black;
  });
}

// ---------- camera keyframes ----------
// target, radius, polar angle, azimuth (0 = White's side), side of the screen for the board (+1 right, -1 left)
const KEYS = [
  { t: [0, 0.2, -0.3], r: 25, phi: 0.95, th: 0.35, side: 0, sy: -0.2, psy: -0.22 },
  { t: [0, 0.3, -2.3], r: 14, phi: 0.82, th: -0.35, side: -1 },
  { t: [0.5, 0.9, -2.5], r: 8.2, phi: 1.04, th: 0.7, side: 1 },
  { t: [-0.8, 0.5, -1.8], r: 13, phi: 0.86, th: -0.2, side: -1 },
  { t: [0, 0, 0], r: 23, phi: 0.62, th: 1.35, side: 1 },
  { t: [0, 0, -1.6], r: 21, phi: 0.72, th: Math.PI, side: -1 },
  // the closing screen mirrors the hero: text on top, the whole board below, after a half turn back to White's side
  { t: [0, 0.2, -0.3], r: 25, phi: 0.95, th: Math.PI * 2 + 0.35, side: 0, sy: -0.2, psy: -0.22 },
];
const cam = { tx: 0, ty: 0, tz: 0, r: 25, phi: 0.95, th: 0.35, side: 0, sy: -0.2 };
const camGoal = { ...cam };

function sampleKeys(cc, out) {
  const i = Math.min(KEYS.length - 2, Math.floor(cc));
  const f = easeInOut(clamp01(cc - i));
  const a = KEYS[i];
  const b = KEYS[i + 1];
  out.tx = lerp(a.t[0], b.t[0], f);
  out.ty = lerp(a.t[1], b.t[1], f);
  out.tz = lerp(a.t[2], b.t[2], f);
  out.r = lerp(a.r, b.r, f);
  out.phi = lerp(a.phi, b.phi, f);
  out.th = lerp(a.th, b.th, f);
  out.side = lerp(a.side, b.side, f);
  // sy moves the board up or down the screen; psy is the same for portrait screens
  out.sy = lerp(a.sy ?? 0, b.sy ?? 0, f);
  out.psy = lerp(a.psy ?? 0.17, b.psy ?? 0.17, f);
}

// ---------- layout and scroll ----------
let W = 1;
let H = 1;
let portrait = false;
const sections = [...document.querySelectorAll('[data-chapter]')];
const middle = document.getElementById('middle');
let marks = [];

// the hero and the closing screen put their text across the top: the board is framed in the space below it
function frameBelowText(section, key) {
  const copy = section.querySelector('.copy');
  const frame = section.querySelector('.frame');
  if (!copy || !frame) return;
  const bottom = (copy.getBoundingClientRect().bottom - frame.getBoundingClientRect().top) / H;
  const free = clamp01(1 - bottom);
  // the board centre sits in the middle of the free space, a little low
  const centre = bottom + free * 0.54;
  const shift = 0.5 - centre;
  key.sy = shift;
  key.psy = shift;
  // the less room is left, the further back the camera stands
  key.r = 25 * THREE.MathUtils.clamp(0.56 / Math.max(free, 0.2), 0.9, 1.9);
}

function measure() {
  const vh = window.innerHeight;
  marks = sections.map((s) => {
    const top = s.getBoundingClientRect().top + window.scrollY;
    return { s0: top, s1: top + Math.max(0, s.offsetHeight - vh) };
  });
  // content between two chapters holds the earlier chapter until the next one arrives
  for (let i = 0; i < marks.length - 1; i++) marks[i].s1 = Math.max(marks[i].s1, marks[i + 1].s0 - vh);
  frameBelowText(sections[0], KEYS[0]);
  frameBelowText(sections[sections.length - 1], KEYS[KEYS.length - 1]);
}

function chapterAt(y) {
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i];
    if (y < m.s0) {
      const p = marks[i - 1];
      return p ? i - 1 + clamp01((y - p.s1) / (m.s0 - p.s1)) : 0;
    }
    if (y <= m.s1) return i;
  }
  return marks.length - 1;
}

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  // on phones the URL bar changes the height while scrolling; ignore small changes
  if (coarse && w === W && Math.abs(h - H) < H * 0.18) {
    measure();
    return;
  }
  W = w;
  H = h;
  portrait = W / H < 0.95;
  camera.fov = portrait ? 48 : 30;
  renderer.setSize(W, H, false);
  camera.aspect = W / H;
  camera.updateProjectionMatrix();
  measure();
}
window.addEventListener('resize', resize);

let cGoal = 0;
let c = 0;
let covered = false;
// once the footer scrolls in, the fixed scene scrolls up with the closing screen so the footer never covers the board
const footEl = document.querySelector('.foot');
let sceneLift = 0;
const nav = document.getElementById('nav');
let activeSide = '';
function onScroll() {
  const y = window.scrollY;
  cGoal = chapterAt(y);
  nav.classList.toggle('is-solid', y > 24);
  const nearest = sections[Math.round(Math.min(cGoal, sections.length - 1))];
  const side = nearest ? nearest.dataset.side : 'left';
  if (side !== activeSide) {
    activeSide = side;
    root.dataset.activeSide = side;
  }
  const r = middle.getBoundingClientRect();
  covered = r.top <= 0 && r.bottom >= window.innerHeight;
  const nextLift = footEl ? Math.max(0, Math.round(window.innerHeight - footEl.getBoundingClientRect().top)) : 0;
  if (nextLift !== sceneLift) {
    sceneLift = nextLift;
    root.style.setProperty('--lift', `${sceneLift}px`);
  }
}
window.addEventListener('scroll', onScroll, { passive: true });

// headings rise word by word from behind a mask
if (!reduceMotion) {
  document.querySelectorAll('h1, .copy h2, .section-head h2, .statement-text').forEach((el) => {
    const text = el.textContent.trim();
    el.setAttribute('aria-label', text);
    el.textContent = '';
    text.split(/\s+/).forEach((word, i, all) => {
      const outer = document.createElement('span');
      outer.className = 'w';
      outer.setAttribute('aria-hidden', 'true');
      const inner = document.createElement('span');
      inner.textContent = word;
      inner.style.setProperty('--i', i);
      outer.appendChild(inner);
      el.appendChild(outer);
      if (i < all.length - 1) el.appendChild(document.createTextNode(' '));
    });
  });
}
const revealIO = new IntersectionObserver(
  (entries) => entries.forEach((e) => e.isIntersecting && e.target.classList.add('in')),
  { rootMargin: '0px 0px -18% 0px' }
);
document.querySelectorAll('.statement, .section').forEach((el) => revealIO.observe(el));

const io = new IntersectionObserver(
  (entries) => entries.forEach((e) => e.target.classList.toggle('in', e.isIntersecting)),
  { rootMargin: '-30% 0px -30% 0px' }
);
sections.forEach((s) => io.observe(s));

// smooth scrolling, skipped for people who ask for reduced motion
let lenis = null;
if (!reduceMotion) {
  // lerp mode follows the wheel continuously, which reads smoother than fixed-duration tweens
  lenis = new Lenis({ lerp: 0.085, smoothWheel: true, wheelMultiplier: 0.9 });
  lenis.on('scroll', onScroll);
}
document.querySelectorAll('a[href^="#"]').forEach((a) => {
  a.addEventListener('click', (e) => {
    const id = a.getAttribute('href');
    const target = id === '#top' ? 0 : document.querySelector(id);
    if (target === null) return;
    e.preventDefault();
    if (lenis) lenis.scrollTo(target, { offset: 0 });
    else window.scrollTo({ top: target === 0 ? 0 : target.getBoundingClientRect().top + window.scrollY });
  });
});

// ---------- pointer: lamp, drag to turn, picking ----------
const pointer = new THREE.Vector2(0, 0);
const pointerSmooth = new THREE.Vector2(0, 0);
let pointerTime = -100;
let clock = 0;
const raycaster = new THREE.Raycaster();
const boardPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const hit = new THREE.Vector3();

function setPointer(x, y) {
  pointer.set((x / W) * 2 - 1, -((y + sceneLift) / H) * 2 + 1);
  pointerTime = clock;
}
function pointerOnBoard(out) {
  raycaster.setFromCamera(pointer, camera);
  if (!raycaster.ray.intersectPlane(boardPlane, out)) return false;
  out.x = THREE.MathUtils.clamp(out.x, -4.2, 4.2);
  out.z = THREE.MathUtils.clamp(out.z, -4.2, 4.2);
  return true;
}
function pickPiece() {
  if (!pickables.length) return null;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(pickables, false);
  return hits.length ? hits[0].object.userData.piece : null;
}

// orbit offset the visitor adds by dragging empty space; it eases home after a pause or a chapter change
const orbit = { th: 0, phi: 0, vth: 0, vphi: 0, active: false, t: -100, c: 0 };
// one press becomes a board turn, a piece drag or a tap on a piece
const press = { id: null, down: false, x: 0, y: 0, sx: 0, sy: 0, moved: false, piece: null };
const drag = { piece: null, mode: null, point: new THREE.Vector3() };

// pieces can be moved freely on the hero board and on the board in the starting position;
// the rule chapters keep their scripted story
const sandMode = () => (c < 0.35 ? 'hero' : c > 4.7 ? 'play' : null);
const sandbox = { hero: new Map(), play: new Map(), caps: { hero: { w: 0, b: 0 }, play: { w: 0, b: 0 } } };
// captured pieces stand upright on the frame: Black's on the a-file side, White's on the h-file side
const CAPTURED_SCALE = 0.72;
const capturedSpot = (color, k) =>
  new THREE.Vector3(color === 'w' ? FRAME_X : -FRAME_X, FRAME_Y, (color === 'w' ? -1 : 1) * (3.6 - (k % 14) * 0.55));
const basePos = (p, mode) => (mode === 'hero' ? p.story : p.start);
function squareOf(p, mode) {
  const e = sandbox[mode].get(p);
  if (e && e.captured) return null; // captured pieces stand beside the board
  return e ? e.pos : basePos(p, mode);
}
function setEntry(p, mode, pos, lie, from, extra) {
  sandbox[mode].set(p, { pos, lie, from: from.clone(), t0: clock, ...extra });
}
function clearSandbox(mode) {
  if (sel.mode === mode) deselect();
  // every moved piece glides back to its square
  for (const [p, e] of sandbox[mode]) setEntry(p, mode, basePos(p, mode).clone(), 0, p.group.position, { back: !!e.captured });
  sandbox.caps[mode] = { w: 0, b: 0 };
  setTimeout(() => {
    for (const [p, e] of sandbox[mode]) if (!e.captured && e.pos.equals(basePos(p, mode))) sandbox[mode].delete(p);
  }, 600);
}
// ---------- where a piece can go: tap it and its moves light up on the board ----------
// (normal chess moves that do not leave your own king in check; castling and en passant are left out)
const fileOf = (v) => Math.round(v.x + 3.5);
const rankOf = (v) => Math.round(3.5 - v.z);
function occupancy(mode) {
  const occ = new Map();
  for (const q of pieces) {
    const sq = squareOf(q, mode);
    if (sq) occ.set(fileOf(sq) + rankOf(sq) * 8, q);
  }
  return occ;
}
const KING_STEPS = [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];
const KNIGHT_STEPS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const RAYS = { B: KING_STEPS.slice(0, 4), R: KING_STEPS.slice(4), Q: KING_STEPS };
// squares a piece standing on (f0, r0) could move to; attacksOnly gives the squares it threatens
function pseudoMoves(p, f0, r0, occ, attacksOnly) {
  const out = [];
  const inside = (f, r) => f >= 0 && f < 8 && r >= 0 && r < 8;
  const tryAdd = (f, r) => {
    if (!inside(f, r)) return false;
    const q = occ.get(f + r * 8);
    if (!q) {
      out.push({ f, r, cap: null });
      return true;
    }
    if (q.color !== p.color) out.push({ f, r, cap: q });
    return false;
  };
  if (p.type === 'P') {
    const dir = p.isWhite ? 1 : -1;
    const one = r0 + dir;
    for (const df of [-1, 1]) {
      const f = f0 + df;
      if (!inside(f, one)) continue;
      const q = occ.get(f + one * 8);
      if (attacksOnly) out.push({ f, r: one, cap: q || null });
      else if (q && q.color !== p.color) out.push({ f, r: one, cap: q });
    }
    if (!attacksOnly && inside(f0, one) && !occ.has(f0 + one * 8)) {
      out.push({ f: f0, r: one, cap: null });
      const two = r0 + 2 * dir;
      if (r0 === (p.isWhite ? 1 : 6) && !occ.has(f0 + two * 8)) out.push({ f: f0, r: two, cap: null });
    }
  } else if (p.type === 'N' || p.type === 'K') {
    for (const [a, b] of p.type === 'N' ? KNIGHT_STEPS : KING_STEPS) tryAdd(f0 + a, r0 + b);
  } else {
    for (const [a, b] of RAYS[p.type]) {
      for (let k = 1; k < 8 && tryAdd(f0 + a * k, r0 + b * k); k++);
    }
  }
  return out;
}
function legalMoves(p, mode) {
  const at = squareOf(p, mode);
  if (!at) return [];
  const f0 = fileOf(at);
  const r0 = rankOf(at);
  const occ = occupancy(mode);
  return pseudoMoves(p, f0, r0, occ, false).filter((mv) => {
    if (mv.cap && mv.cap.type === 'K') return false;
    // play the move on a copy of the board and check that our king is not attacked afterwards
    const after = new Map(occ);
    after.delete(f0 + r0 * 8);
    after.set(mv.f + mv.r * 8, p);
    let king = -1;
    for (const [k, q] of after) if (q.type === 'K' && q.color === p.color) king = k;
    if (king < 0) return true;
    for (const [k, q] of after) {
      if (q.color === p.color) continue;
      if (pseudoMoves(q, k % 8, Math.floor(k / 8), after, true).some((a) => a.f + a.r * 8 === king)) return false;
    }
    return true;
  });
}

const HINT_GOLD = new THREE.Color('#e2b714');
const HINT_DOT_GEO = new THREE.CircleGeometry(0.14, 32).rotateX(-Math.PI / 2);
const hintDots = Array.from({ length: 28 }, () => marker(HINT_DOT_GEO, HINT_GOLD));
const hintRings = Array.from({ length: 8 }, () => marker(RING_GEO, HINT_GOLD));
const selRing = marker(RING_GEO, HINT_GOLD);
const sel = { piece: null, mode: null, moves: [], t0: 0 };
function selectPiece(p, mode) {
  sel.piece = p;
  sel.mode = mode;
  sel.moves = legalMoves(p, mode);
  sel.t0 = clock;
}
function deselect() {
  sel.piece = null;
  sel.moves = [];
}
// a tap on a lit square (or on a piece standing on one) plays the move
function tapMoveTarget(point, tappedPiece) {
  if (!sel.piece || sandMode() !== sel.mode) return null;
  if (tappedPiece === sel.piece) return null; // tapping the selected piece again puts it down
  const at = (f, r) => sel.moves.find((mv) => mv.f === f && mv.r === r) || null;
  // the lit square under the pointer wins, even when a piece in front of it catches the tap
  if (point) {
    const mv = at(Math.round(point.x + 3.5), Math.round(3.5 - point.z));
    if (mv) return mv;
  }
  // tapping an enemy piece that can be taken
  if (tappedPiece && tappedPiece.color !== sel.piece.color) {
    const sq = squareOf(tappedPiece, sel.mode);
    if (sq) return at(fileOf(sq), rankOf(sq));
  }
  return null;
}

function dropPiece(p, mode, point) {
  const from = p.group.position.clone();
  const fx = Math.round(point.x + 3.5);
  const rz = Math.round(3.5 - point.z);
  const home = squareOf(p, mode) || basePos(p, mode);
  if (fx < 0 || fx > 7 || rz < 0 || rz > 7) return setEntry(p, mode, home.clone(), 0, from);
  const target = new THREE.Vector3(fx - 3.5, 0, 3.5 - rz);
  if (target.distanceTo(home) < 0.1) return setEntry(p, mode, home.clone(), 0, from);
  // only legal moves land; anything else glides back home
  if (!legalMoves(p, mode).some((mv) => mv.f === fx && mv.r === rz)) return setEntry(p, mode, home.clone(), 0, from);
  const occupant = pieces.find((q) => {
    if (q === p) return false;
    const sq = squareOf(q, mode);
    return sq && sq.distanceTo(target) < 0.1;
  });
  if (occupant && occupant.color === p.color) return setEntry(p, mode, home.clone(), 0, from);
  // the captured piece hops off the board and stands in its owner's row on the frame
  if (occupant) {
    const k = sandbox.caps[mode][occupant.color]++;
    setEntry(occupant, mode, capturedSpot(occupant.color, k), 0, occupant.group.position, { captured: true });
  }
  setEntry(p, mode, target, 0, from);
}
function tapPiece(p) {
  if (demoActive() && !p.isWhite) {
    guess(p);
    return;
  }
  const mode = sandMode();
  if (mode && sel.piece === p) {
    deselect();
    return;
  }
  p.tap = clock; // a small jump and turn
  if (mode) selectPiece(p, mode);
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  setPointer(e.clientX, e.clientY);
  press.id = e.pointerId;
  press.down = true;
  press.x = press.sx = e.clientX;
  press.y = press.sy = e.clientY;
  press.moved = false;
  press.piece = pickPiece();
  orbit.vth = orbit.vphi = 0;
  orbit.c = cGoal;
});
window.addEventListener(
  'pointermove',
  (e) => {
    setPointer(e.clientX, e.clientY);
    if (!press.down || e.pointerId !== press.id) return;
    const dx = e.clientX - press.x;
    const dy = e.clientY - press.y;
    press.x = e.clientX;
    press.y = e.clientY;
    if (!press.moved && Math.hypot(e.clientX - press.sx, e.clientY - press.sy) > 6) {
      press.moved = true;
      const mode = sandMode();
      if (press.piece && mode) {
        drag.piece = press.piece;
        drag.mode = mode;
        drag.piece.tap = undefined;
        selectPiece(drag.piece, mode);
        root.classList.add('is-moving');
      } else {
        orbit.active = true;
        root.classList.add('is-dragging');
      }
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch (err) {
        /* capture is optional */
      }
    }
    if (drag.piece) {
      raycaster.setFromCamera(pointer, camera);
      if (raycaster.ray.intersectPlane(boardPlane, hit)) {
        drag.point.set(THREE.MathUtils.clamp(hit.x, -4.6, 4.6), 0, THREE.MathUtils.clamp(hit.z, -4.6, 4.6));
      }
    } else if (orbit.active) {
      const k = 4.2 / Math.max(600, W);
      orbit.vth = -dx * k;
      orbit.vphi = coarse ? 0 : -dy * k * 0.7;
      orbit.th += orbit.vth;
      orbit.phi = THREE.MathUtils.clamp(orbit.phi + orbit.vphi, -0.45, 0.35);
      orbit.t = clock;
    }
  },
  { passive: true }
);
function endPress(e, cancelled) {
  if (!press.down || e.pointerId !== press.id) return;
  press.down = false;
  if (drag.piece) {
    const home = squareOf(drag.piece, drag.mode) || basePos(drag.piece, drag.mode);
    if (cancelled) setEntry(drag.piece, drag.mode, home.clone(), 0, drag.piece.group.position);
    else dropPiece(drag.piece, drag.mode, drag.point);
    drag.piece = null;
    deselect();
  } else if (!press.moved && !cancelled) {
    raycaster.setFromCamera(pointer, camera);
    const onBoard = raycaster.ray.intersectPlane(boardPlane, hit) ? hit : null;
    const mv = tapMoveTarget(onBoard, press.piece);
    if (mv) {
      dropPiece(sel.piece, sel.mode, new THREE.Vector3(mv.f - 3.5, 0, 3.5 - mv.r));
      deselect();
    } else if (press.piece) tapPiece(press.piece);
    else deselect();
  }
  orbit.active = false;
  root.classList.remove('is-dragging', 'is-moving');
}
window.addEventListener('pointerup', (e) => endPress(e, false));
window.addEventListener('pointercancel', (e) => endPress(e, true));

// ---------- Find the spies ----------
const foundEl = document.getElementById('foundNum');
const guessEl = document.getElementById('guessNum');
const verdictEl = document.getElementById('verdict');
const demo = { spies: new Set(), guesses: 5, found: 0, over: false };
const candidates = pieces.filter((p) => !p.isWhite && p.type !== 'K');

function newRound() {
  demo.spies.clear();
  const pool = [...candidates];
  while (demo.spies.size < 3) demo.spies.add(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  demo.guesses = 5;
  demo.found = 0;
  demo.over = false;
  for (const p of pieces) if (p.demo) p.demo = { kind: 'clear', t0: clock, from: p.demo };
  if (sandbox.play.size) clearSandbox('play');
  renderScore('');
}
function renderScore(verdict) {
  foundEl.textContent = demo.found;
  guessEl.textContent = demo.guesses;
  verdictEl.textContent = verdict;
}
function guess(p) {
  if (demo.over) return;
  if (p.type === 'K') {
    renderScore('Kings can never be recruited.');
    return;
  }
  if (p.demo && p.demo.kind !== 'clear') return;
  demo.guesses--;
  const isSpy = demo.spies.has(p);
  if (isSpy) demo.found++;
  p.demo = { kind: isSpy ? 'hit' : 'miss', t0: clock };
  let verdict = isSpy ? 'A spy. It worked for White.' : 'Loyal. That one is still yours.';
  if (demo.found === 3) {
    demo.over = true;
    verdict = `All three found with ${demo.guesses} ${demo.guesses === 1 ? 'guess' : 'guesses'} to spare.`;
  } else if (demo.guesses === 0) {
    demo.over = true;
    verdict = "Out of guesses. The squares in red were White's spies.";
    let k = 0;
    for (const sp of demo.spies) if (!sp.demo || sp.demo.kind === 'clear') sp.demo = { kind: 'hit', t0: clock + 0.35 + k++ * 0.3 };
  }
  renderScore(verdict);
}
document.getElementById('newRound').addEventListener('click', newRound);
newRound();

const demoActive = () => Math.abs(c - 5) < 0.3;

// sign-up form: set data-endpoint on the form to the real list provider
const form = document.getElementById('joinForm');
const formNote = document.getElementById('formNote');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = form.elements.email;
  if (!email.value || !email.checkValidity()) {
    formNote.textContent = 'Enter an email address to join.';
    email.focus();
    return;
  }
  const endpoint = form.dataset.endpoint;
  if (!endpoint) {
    formNote.textContent = 'This preview is not connected to a mailing list yet.';
    return;
  }
  try {
    const res = await fetch(endpoint, { method: 'POST', body: new FormData(form) });
    formNote.textContent = res.ok ? 'You are on the list.' : 'That did not go through. Try again in a moment.';
  } catch (err) {
    formNote.textContent = 'That did not go through. Try again in a moment.';
  }
});

// ---------- per-frame state ----------
const tmp = new THREE.Vector3();
const lampAim = new THREE.Vector3(0, 0, -2);
const lampGoal = new THREE.Vector3();
let hovered = null;

function storyTransform(p, s, out) {
  out.copy(p.story);
  let rotY = p.baseRotY;
  let rotZ = 0;
  let flip = 0;
  let scale = 1;
  if (p === spyKnight) {
    const a = easeInOut(s.activate);
    out.y += Math.sin(Math.PI * a) * 0.8;
    rotY += a * Math.PI * 2;
    flip = smooth(ramp(a, 0.4, 0.6));
    // the capture: the knight jumps, high enough to clear the pawn on d6
    const m = easeInOut(ramp(s.command, KNIGHT_HOP[0], KNIGHT_HOP[1]));
    out.lerp(C6, m);
    out.y += Math.sin(Math.PI * m) * 2.2;
  }
  if (p === victim) {
    // taken while the knight is in the air: it hops along the empty b5-a4 diagonal and stands on the frame
    const m = easeInOut(ramp(s.command, VICTIM_OUT[0], VICTIM_OUT[1]));
    out.lerp(VICTIM_SPOT, m);
    out.y += Math.sin(Math.PI * m) * 1.4;
    scale = lerp(1, CAPTURED_SCALE, m);
  }
  return { rotY, rotZ, flip, scale };
}

function update(dt, rawDt) {
  clock += dt;
  c = reduceMotion ? cGoal : damp(c, cGoal, 4.5, rawDt);

  const s = {
    recruit: ramp(c, 0.25, 0.95),
    activate: ramp(c, 1.2, 1.9),
    command: ramp(c, 2.2, 2.9),
    limit: ramp(c, 3.2, 3.9),
  };
  const heroW = 1 - smooth(ramp(c, 0.05, 0.75));
  const inDemo = demoActive();

  // ----- theme blend -----
  themeMix = reduceMotion ? themeGoal : damp(themeMix, themeGoal, 3.5, rawDt);
  const D = THEMES.dark;
  const L = THEMES.light;
  const pick = (k) => lerp(lerp(D[k][0], D[k][1], heroW), lerp(L[k][0], L[k][1], heroW), themeMix);
  scene.background.copy(D.bg).lerp(L.bg, themeMix);
  scene.fog.color.copy(scene.background);
  floorMat.color.copy(D.floor).lerp(L.floor, themeMix);
  hemi.color.copy(D.sky).lerp(L.sky, themeMix);
  hemi.groundColor.copy(D.ground).lerp(L.ground, themeMix);
  hemi.intensity = pick('hemi');
  fill.intensity = pick('fill');
  rim.intensity = pick('rim');
  scene.environmentIntensity = pick('env');

  // ----- camera -----
  sampleKeys(c, camGoal);
  let shiftX = 0;
  if (portrait) {
    camGoal.r *= 1 + (1 - W / H) * 0.5;
    camGoal.sy = camGoal.psy;
  } else {
    // the board sits in the half of the page away from the text and never drifts to the screen edge
    shiftX = Math.min(0.23 * W, 380) / W;
  }
  // drag offset: inertia after release, then home after a pause or a chapter change
  if (!orbit.active) {
    orbit.vth *= Math.exp(-4 * rawDt);
    orbit.vphi *= Math.exp(-4 * rawDt);
    orbit.th += orbit.vth;
    orbit.phi = THREE.MathUtils.clamp(orbit.phi + orbit.vphi, -0.45, 0.35);
    if (clock - orbit.t > 4 || Math.abs(cGoal - orbit.c) > 0.5) {
      orbit.th = damp(orbit.th, 0, 1.6, rawDt);
      orbit.phi = damp(orbit.phi, 0, 1.6, rawDt);
    }
  }
  // opening shot: the camera starts high and far, then settles into the hero framing
  if (introStart >= 0 && clock - introStart > INTRO_HANG + 2) introStart = -1;
  const intro = introStart < 0 ? 1 : clamp01((clock - introStart) / 2.8);
  const introCam = 1 - easeInOut(intro);
  camGoal.r += introCam * 12;
  camGoal.phi -= introCam * 0.3;
  camGoal.th -= introCam * 0.6;

  pointerSmooth.x = damp(pointerSmooth.x, coarse || orbit.active ? 0 : pointer.x, 2.5, rawDt);
  pointerSmooth.y = damp(pointerSmooth.y, coarse || orbit.active ? 0 : pointer.y, 2.5, rawDt);
  const drift = reduceMotion ? 0 : Math.sin(clock * 0.12) * 0.03;
  camGoal.th += pointerSmooth.x * 0.06 + drift + orbit.th;
  camGoal.phi = THREE.MathUtils.clamp(camGoal.phi - pointerSmooth.y * 0.03 + orbit.phi, 0.25, 1.38);

  const lam = reduceMotion ? 60 : 2.6;
  delete camGoal.psy;
  for (const k of Object.keys(cam)) {
    // while dragging, the angles follow the hand closely so the board does not lag
    const l = orbit.active && (k === 'th' || k === 'phi') ? 18 : lam;
    cam[k] = damp(cam[k], camGoal[k], l, rawDt);
  }
  const sp = Math.sin(cam.phi);
  camera.position.set(
    cam.tx + cam.r * sp * Math.sin(cam.th),
    cam.ty + cam.r * Math.cos(cam.phi),
    cam.tz + cam.r * sp * Math.cos(cam.th)
  );
  camera.lookAt(cam.tx, cam.ty, cam.tz);
  camera.setViewOffset(W, H, -cam.side * shiftX * W, cam.sy * H, W, H);

  // ----- lamp -----
  const followPointer = clock - pointerTime < 3.5 && !orbit.active;
  if (followPointer && pointerOnBoard(hit)) lampGoal.copy(hit);
  else if (reduceMotion) lampGoal.set(0, 0, -2.2);
  else lampGoal.set(Math.sin(clock * 0.33) * 3.1, 0, -2.3 + Math.sin(clock * 0.57 + 1) * 1.1);
  lampGoal.lerp(tmp.set(cam.tx, 0, cam.tz), 1 - heroW);
  lampAim.x = damp(lampAim.x, lampGoal.x, 4, rawDt);
  lampAim.z = damp(lampAim.z, lampGoal.z, 4, rawDt);
  lamp.target.position.copy(lampAim);
  lamp.position.set(lampAim.x * 0.35 + 1.2, 13, lampAim.z * 0.35 + 3.5);
  lamp.angle = lerp(Math.PI / 4.6, Math.PI / 10.5, heroW);
  lamp.intensity = pick('lamp');

  // ----- hover: every piece answers the pointer -----
  if (!coarse && !press.down) {
    hovered = pickPiece();
    const guessable = !!hovered && inDemo && !hovered.isWhite && !demo.over && (!hovered.demo || hovered.demo.kind === 'clear');
    root.classList.toggle('is-pickable', guessable);
    root.classList.toggle('is-grabbable', !!hovered && !guessable && !!sandMode());
  }
  // moves on the hero board are put back once the visitor has scrolled well into the rules
  if (c > 1.5 && sandbox.hero.size) sandbox.hero.clear();

  // ----- the selected piece's moves -----
  if (sel.piece && sandMode() !== sel.mode) deselect();
  const hintA = sel.piece ? smooth(clamp01((clock - sel.t0) / 0.25)) : 0;
  let di = 0;
  let ri = 0;
  for (const mv of sel.moves) {
    const m = mv.cap ? hintRings[ri++] : hintDots[di++];
    if (!m) continue;
    m.position.set(mv.f - 3.5, MARK_Y, 3.5 - mv.r);
    m.visible = hintA > 0.002;
    m.material.opacity = hintA * (mv.cap ? 0.95 : 0.7);
  }
  for (; di < hintDots.length; di++) hintDots[di].visible = false;
  for (; ri < hintRings.length; ri++) hintRings[ri].visible = false;
  const selSq = sel.piece && !drag.piece ? squareOf(sel.piece, sel.mode) : null;
  selRing.visible = !!selSq && hintA > 0.002;
  if (selSq) {
    selRing.position.set(selSq.x, MARK_Y, selSq.z);
    selRing.material.opacity = hintA * 0.55;
  }

  // ----- pieces -----
  for (const p of pieces) {
    const st = storyTransform(p, s, tmp);
    const storyPos = tmp.clone();

    // the board resets into the starting position, staggered by file
    const stagger = ((p.idx % 8) / 8) * 0.35 + (p.isWhite ? 0 : 0.05);
    const rt = smooth(ramp(c, 4.15 + stagger, 4.55 + stagger));
    const pos = storyPos.clone().lerp(p.start, rt);
    const dist = storyPos.distanceTo(p.start);
    // pieces travelling home jump high enough to clear the pieces they pass over
    if (dist > 0.01) pos.y += Math.sin(Math.PI * rt) * Math.min(3, 1.2 + dist * 0.45);

    let rotY = lerp(st.rotY, p.baseRotY, rt);
    let rotZ = lerp(st.rotZ, 0, rt);
    let flip = st.flip * (1 - rt);
    let scale = lerp(st.scale, 1, rt);

    // moves the visitor made: the hero board fades them out as the story starts, the play board as it fades in
    for (const [mode, weight] of [['hero', heroW], ['play', rt]]) {
      const e = sandbox[mode].get(p);
      if (!e || weight <= 0) continue;
      const u = clamp01((clock - e.t0) / 0.45);
      const at = e.from.clone().lerp(e.pos, easeOut(u));
      // captured pieces and pieces coming back from the frame jump high enough to clear the others
      at.y += Math.sin(Math.PI * u) * (e.captured || e.back ? 1.4 : 0.5);
      pos.lerp(at, weight);
      if (e.captured) scale = lerp(scale, lerp(1, CAPTURED_SCALE, easeOut(u)), weight);
      else if (e.back) scale = lerp(scale, lerp(CAPTURED_SCALE, 1, easeOut(u)), weight);
    }

    let ring = 0;
    let crossA = 0;
    if (p.demo && rt > 0) {
      const d = p.demo;
      const t = clock - d.t0;
      if (d.kind === 'hit' && t > 0) {
        const u = clamp01(t / 1.0);
        const e = easeInOut(u);
        pos.y += Math.sin(Math.PI * e) * 0.8 * rt;
        rotY += e * Math.PI * 2;
        flip = Math.max(flip, smooth(ramp(u, 0.4, 0.6)) * rt);
        ring = smooth(ramp(u, 0.15, 0.6)) * rt;
      } else if (d.kind === 'miss') {
        const u = clamp01(t / 0.6);
        pos.x += Math.sin(t * 38) * 0.06 * (1 - u) * rt;
        crossA = smooth(ramp(t, 0.1, 0.4)) * 0.6 * rt;
      } else if (d.kind === 'clear') {
        const u = clamp01(t / 0.5);
        const prev = d.from;
        if (prev && prev.kind === 'hit') {
          flip = Math.max(flip, (1 - smooth(u)) * rt);
          ring = (1 - smooth(u)) * rt;
        }
        if (prev && prev.kind === 'miss') crossA = (1 - smooth(u)) * 0.6 * rt;
        if (u >= 1) p.demo = null;
      }
    }

    // opening shot: every piece hangs in the air over its square, then they fall onto the board one by one
    if (introStart >= 0) {
      const t = clock - introStart;
      const h1 = ((p.idx * 73) % 17) / 17;
      const h2 = ((p.idx * 37 + 11) % 23) / 23;
      const lift = 1.7 + h1 * 1.3;
      const fallAt = INTRO_HANG + h2 * 0.8;
      const bob = (at) => Math.sin(at * 2.2 + p.idx) * 0.09;
      if (t < fallAt) {
        pos.y += lift + bob(t);
        rotY += (fallAt - t) * 0.6 * (h1 - 0.5);
      } else if (t < fallAt + INTRO_FALL) {
        const u = (t - fallAt) / INTRO_FALL;
        pos.y += (lift + bob(fallAt)) * (1 - u * u);
      } else {
        // a small bounce as it lands
        const u = clamp01((t - fallAt - INTRO_FALL) / 0.3);
        pos.y += Math.sin(Math.PI * u) * 0.12;
      }
    }

    // a tap makes the piece hop and turn once
    if (p.tap !== undefined) {
      const u = clamp01((clock - p.tap) / 0.75);
      pos.y += Math.sin(Math.PI * u) * 0.7;
      rotY += easeInOut(u) * Math.PI * 2;
      if (u >= 1) p.tap = undefined;
    }

    const canHover = p === hovered && !(p.demo && p.demo.kind !== 'clear');
    p.hover = damp(p.hover, canHover ? 1 : 0, 12, rawDt);
    pos.y += p.hover * 0.22;

    // the piece in hand follows the pointer, lifted above the others
    if (p === drag.piece) {
      if (!p.dragPos) p.dragPos = pos.clone();
      p.dragPos.x = damp(p.dragPos.x, drag.point.x, 18, rawDt);
      p.dragPos.z = damp(p.dragPos.z, drag.point.z, 18, rawDt);
      p.dragPos.y = damp(p.dragPos.y, 0.9, 12, rawDt);
      pos.copy(p.dragPos);
    } else if (p.dragPos) {
      p.dragPos = null;
    }

    p.group.position.copy(pos);
    p.group.rotation.set(0, rotY, rotZ);
    p.group.scale.setScalar(scale);

    if (!p.isWhite) {
      setLook(p, flip > 0.5);

      const si = storySpies.indexOf(p);
      if (si >= 0) {
        const lampDist = Math.hypot(lampAim.x - p.story.x, lampAim.z - p.story.z);
        const heroReveal = (1 - smooth(ramp(lampDist, 0.5, 1.4))) * heroW;
        const recruit = smooth(ramp(s.recruit, si * 0.22, si * 0.22 + 0.45));
        ring = Math.max(ring, Math.max(heroReveal, recruit) * (1 - rt));
      }
      const rm = p.ring;
      rm.visible = ring > 0.002;
      if (rm.visible) {
        rm.position.set(pos.x, MARK_Y, pos.z);
        rm.material.opacity = ring;
        const sc = lerp(1.25, 1, easeOut(ring));
        rm.scale.set(sc, 1, sc);
      }
      const cm = p.cross;
      cm.visible = crossA > 0.002;
      if (cm.visible) {
        cm.position.set(pos.x, MARK_Y, pos.z);
        cm.material.opacity = crossA;
      }
    }
  }

  // the spy hat drops on once the knight has turned
  const rtKnight = smooth(ramp(c, 4.15 + (6 / 8) * 0.35 + 0.05, 4.55 + (6 / 8) * 0.35 + 0.05));
  const hatShow = smooth(ramp(easeInOut(s.activate), 0.6, 0.95)) * (1 - rtKnight);
  hat.visible = hatShow > 0.01 && hat.userData.y !== undefined;
  if (hat.visible) {
    hat.scale.setScalar(lerp(0.6, 1, hatShow) * (hat.userData.scale || 1));
    hat.position.y = hat.userData.y + (1 - hatShow) * 1.1;
  }

  const dotsA = smooth(ramp(s.command, 0, 0.08)) * (1 - smooth(ramp(s.command, 0.2, 0.4)));
  for (const d of moveDots) {
    d.visible = dotsA > 0.002;
    d.material.opacity = dotsA * 0.55;
  }

  const resetAll = smooth(ramp(c, 4.1, 4.4));
  const ghostA = smooth(s.limit) * (1 - resetAll);
  ghostTargets.forEach((p, i) => {
    const g = ghostMarks[i];
    const a = smooth(ramp(ghostA, i * 0.2, i * 0.2 + 0.6));
    g.visible = a > 0.002;
    g.position.set(p.story.x, MARK_Y, p.story.z);
    g.material.opacity = a * 0.8;
  });
  const kingA = smooth(ramp(s.limit, 0.35, 1)) * (1 - resetAll);
  for (const m of [kingRing, kingCross]) {
    m.visible = kingA > 0.002;
    m.position.set(blackKing.story.x, MARK_Y, blackKing.story.z);
    m.material.opacity = kingA * 0.85;
  }

}

// ---------- loop ----------
let introStart = -1;
const INTRO_HANG = 1.8; // seconds the pieces float before the first one falls
const INTRO_FALL = 0.5;
let last = performance.now();
let frames = 0;
let slowFrames = 0;
let started = false;

function frame(now) {
  const rawDt = Math.min(0.5, (now - last) / 1000);
  const dt = Math.min(0.05, rawDt);
  last = now;
  if (lenis) lenis.raf(now);
  // the middle sections hide the scene completely, so skip the GPU work there
  if (covered && started) return;
  update(dt, rawDt);
  renderer.render(scene, camera);
  if (!started) {
    started = true;
    root.classList.add('ready');
    if (!reduceMotion && cGoal < 0.5) introStart = clock;
  }
  // drop resolution once if the device struggles in the first seconds
  if (frames < 180) {
    frames++;
    if (rawDt > 0.024 && rawDt < 0.2) slowFrames++;
    if (frames === 180 && slowFrames > 80 && pixelRatio > 1) {
      pixelRatio = 1;
      renderer.setPixelRatio(1);
      renderer.setSize(W, H, false);
    }
  }
}

resize();
onScroll();
c = cGoal;
// smooth scrolling runs while the chess set is still downloading
renderer.setAnimationLoop((now) => {
  if (lenis) lenis.raf(now);
});

// first visit: a light preview of the set (smaller texture mips) and of the studio light shows the board fast;
// the full-resolution textures and light load right after and replace them, so the final look is unchanged
function loadEnv(url) {
  return new RGBELoader().loadAsync(url).then((tex) => {
    tex.mapping = THREE.EquirectangularReflectionMapping;
    const old = scene.environment;
    scene.environment = tex;
    scene.environmentRotation.y = 1.2;
    if (old) old.dispose();
  });
}
const envPromise = loadEnv('assets/env/studio-lite.hdr').catch(() => {});

const setPromise = gltfLoader.loadAsync('assets/models/chess-set-lite.glb', (e) => {
  if (e.total) setProgress((e.loaded / e.total) * 0.9);
});

function loadFullQuality() {
  loadEnv('assets/env/studio.hdr').catch(() => {});
  gltfLoader
    .loadAsync('assets/models/chess-set.glb')
    .then((full) => {
      const fullMats = {};
      full.scene.traverse((o) => {
        if (!o.isMesh) return;
        for (const m of [o.material].flat()) fullMats[m.name] = m;
        o.geometry.dispose(); // only the textures are needed
      });
      // one material per tick, so the texture uploads do not stall a frame
      const queue = Object.entries(setMaterials);
      const next = () => {
        const item = queue.shift();
        if (!item) return;
        const [name, m] = item;
        const f = fullMats[name];
        if (f) {
          for (const key of Object.keys(m)) {
            const old = m[key];
            if (old && old.isTexture && f[key] && f[key].isTexture) {
              f[key].anisotropy = old.anisotropy;
              m[key] = f[key];
              old.dispose();
            }
          }
        }
        setTimeout(next, 40);
      };
      next();
    })
    .catch(() => {});
}

Promise.all([setPromise, envPromise])
  .then(async ([gltf]) => {
    installSet(gltf);
    setProgress(0.95);
    update(0, 0);
    if (renderer.compileAsync) await renderer.compileAsync(scene, camera).catch(() => {});
    setProgress(1);
    last = performance.now();
    renderer.setAnimationLoop(frame);
    // the full textures wait until the opening drop has played, so decoding them never stutters it
    const introPlays = !reduceMotion && cGoal < 0.5;
    setTimeout(loadFullQuality, introPlays ? (INTRO_HANG + 2.3) * 1000 : 800);
  })
  .catch((err) => {
    console.error('Chess set failed to load', err);
    root.classList.add('no-webgl', 'ready');
  });

window.addEventListener('load', measure);
if (document.fonts) document.fonts.ready.then(measure);

