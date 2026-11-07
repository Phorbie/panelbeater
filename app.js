// Panelbeater UI: three.js viewer + operation stack. Geometry lives in core.js.
import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
import {
  loadMesh, evaluate, defaultOp, bbox, checkMesh, toSTL, makeRecipe, readRecipe, zipStore, pinBox,
} from './core.js';

const $ = (s) => document.querySelector(s);
const AXN = ['x', 'y', 'z'];
const AXI = { x: 0, y: 1, z: 2 };
const NAMES = { rotate: 'Rotate', refine: 'Refine', pin: 'Pin', stretch: 'Stretch', taper: 'Taper', move: 'Move', mirror: 'Mirror' };
const SETUP_TYPES = new Set(['rotate', 'refine', 'pin']);

const state = {
  fileName: '',
  base: null,
  sourceFaces: 0,
  ops: [],
  selected: -1,
  cache: [],
  view: { heat: 'none', ghost: false }, // heat: 'none' | 'strain' | 'moved'
  pick: null,
  result: null, // what's drawn
  info: null,   // notes + trace through the selected step
  full: null,   // notes + trace for every step (filled in when idle)
  moved: null,  // per-face displacement for the Moved view
  upTo: 0,
  check: null,
  clickPoint: null,
  clickPoint2: null, // shift-click: second point for measuring
  regionOpen: new WeakMap(),
  showIntro: false,
};
const OPS_HELP = {
  rotate: 'Turns the model in 90° steps and sets it back on the mat. Use it first if the file is stood on end for printing.',
  refine: 'Splits long triangles into smaller ones so later steps have points to bend. The shape doesn’t change.',
  pin: 'Marks a box that later steps can’t stretch. Whatever is inside moves as one solid piece, so holes and mounts keep their size and spacing.',
  stretch: 'Cuts the model at a plane and slides one or both sides apart. Walls keep their thickness; only faces crossing the plane get longer.',
  taper: 'A stretch whose amount changes along a second axis, so one end can widen while the other stays put. Good for a trapezoid bed.',
  move: 'Pushes everything inside the region along one axis. The blend distance sets how gently it fades into the rest.',
  mirror: 'Cuts at a plane, discards one side and replaces it with a reflection of the other.',
};

/* ================================================================ viewer */

const stage = $('#stage');

// The 3D view is optional. If the browser has WebGL switched off (a Firefox
// setting, a managed work machine, an old GPU driver), everything except the
// picture still works: open, steps, recipes, size readout, export.
let renderer = null;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.autoClear = false;
  stage.prepend(renderer.domElement);
} catch (err) {
  console.warn('Panelbeater: 3D view unavailable.', err);
  renderer = null;
  const note = document.createElement('div');
  note.className = 'nogl';
  note.setAttribute('role', 'status');
  note.innerHTML = '<strong>3D view unavailable</strong>'
    + '<p>This browser has WebGL turned off, so the model can\'t be drawn. Opening files, steps, recipes, the size readout and Export STL still work.</p>'
    + '<p>To turn it on in Firefox, go to <code>about:config</code> and set <code>webgl.disabled</code> to <code>false</code>, or turn on hardware acceleration in Settings › Performance. Chrome and Edge also work.</p>';
  stage.append(note);
}
const canvas = renderer ? renderer.domElement : document.createElement('canvas');

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 0.5, 5000);
camera.up.set(0, 0, 1);
camera.position.set(200, -260, 180);
scene.add(camera);
const controls = renderer ? new OrbitControls(camera, canvas) : null;
controls?.addEventListener('change', requestRender);

scene.add(new THREE.HemisphereLight(0xffffff, 0x50555a, 1.15));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.7);
keyLight.position.set(0.6, 0.9, 0.4);
camera.add(keyLight);
const fill = new THREE.DirectionalLight(0xffffff, 0.35);
fill.position.set(-1, -0.4, -0.6);
camera.add(fill);

const matGroup = new THREE.Group();
const meshGroup = new THREE.Group();
const ghostGroup = new THREE.Group();
const overlay = new THREE.Group();
scene.add(matGroup, meshGroup, ghostGroup, overlay);

const colors = {};
function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  for (const k of ['stage', 'mat', 'mat-line', 'mat-major', 'primer', 'accent', 'tape', 'ink', 'bad', 'heat-mid', 'heat-hi', 'ax-x', 'ax-y', 'ax-z']) {
    colors[k] = new THREE.Color(cs.getPropertyValue('--' + k).trim() || '#888');
  }
  colors.axes = [colors['ax-x'], colors['ax-y'], colors['ax-z']];
}
readTheme();

const bodyMat = new THREE.MeshStandardMaterial({ color: colors.primer, roughness: 0.62, metalness: 0.06, flatShading: true, side: THREE.DoubleSide });
const heatMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0, flatShading: true, side: THREE.DoubleSide });
let bodyMesh = null;
let shownKey = null;

function applyTheme() {
  readTheme();
  scene.background = colors.stage;
  bodyMat.color.copy(colors.primer);
  shownKey = null;
  buildMat();
  buildGizmo();
  if (state.result) { updateMesh(state.result.mesh); updateOverlays(); updateGhost(true); }
  requestRender();
}

// Cutting mat with a 10 mm grid, sized to the model.
let matExtent = 300;
function buildMat() {
  disposeGroup(matGroup);
  const s = matExtent;
  const mat = new THREE.Mesh(new THREE.PlaneGeometry(s, s), new THREE.MeshBasicMaterial({ color: colors.mat }));
  matGroup.add(mat);
  const minor = [], major = [];
  for (let v = -s / 2; v <= s / 2 + 1e-6; v += 10) {
    const arr = Math.round(v) % 50 === 0 ? major : minor;
    arr.push(v, -s / 2, 0.05, v, s / 2, 0.05, -s / 2, v, 0.05, s / 2, v, 0.05);
  }
  const lines = (arr, color, opacity) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
  };
  matGroup.add(lines(minor, colors['mat-line'], 0.9), lines(major, colors['mat-major'], 0.8));
  const axisLine = (a, color) => {
    const p = [0, 0, 0.1, 0, 0, 0.1];
    p[a] = -s / 2; p[a + 3] = s / 2;
    return lines(p, color, 0.9);
  };
  matGroup.add(axisLine(0, colors['ax-x']), axisLine(1, colors['ax-y']));
}

// Axis gizmo, drawn in the bottom-left corner.
const gizmoScene = new THREE.Scene();
const gizmoCam = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 10);
function buildGizmo() {
  disposeGroup(gizmoScene);
  AXN.forEach((name, a) => {
    const dir = new THREE.Vector3(); dir.setComponent(a, 1);
    gizmoScene.add(new THREE.ArrowHelper(dir, new THREE.Vector3(), 1, colors.axes[a], 0.28, 0.16));
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = '#' + colors.axes[a].getHexString();
    g.font = '600 44px ui-monospace, Menlo, monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(name.toUpperCase(), 32, 34);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
    sprite.scale.setScalar(0.55);
    sprite.position.copy(dir).multiplyScalar(1.38);
    gizmoScene.add(sprite);
  });
}

function disposeGroup(g) {
  for (const c of [...g.children]) {
    g.remove(c);
    c.traverse?.((o) => {
      o.geometry?.dispose();
      if (o.material) for (const m of [].concat(o.material)) { m.map?.dispose(); m.dispose(); }
    });
  }
}

let renderQueued = false;
function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderNow(); });
}
function renderNow() {
  if (!renderer) return;
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, w, h);
  renderer.clear();
  renderer.render(scene, camera);
  const s = 92;
  gizmoCam.position.set(0, 0, 4).applyQuaternion(camera.quaternion);
  gizmoCam.quaternion.copy(camera.quaternion);
  renderer.clearDepth();
  renderer.setScissorTest(true);
  renderer.setScissor(6, 6, s, s);
  renderer.setViewport(6, 6, s, s);
  renderer.render(gizmoScene, gizmoCam);
  renderer.setScissorTest(false);
}

new ResizeObserver(() => {
  const w = stage.clientWidth, h = stage.clientHeight;
  if (!w || !h || !renderer) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  requestRender();
}).observe(stage);

function frameView(name = 'iso') {
  if (!state.result) return;
  const bb = bbox(state.result.mesh);
  const dirs = { iso: [1.05, -1.45, 0.95], top: [0, -0.0001, 1], front: [0, -1, 0.0001], side: [1, 0, 0.0001] };
  const dir = name === 'keep' && controls
    ? camera.position.clone().sub(controls.target).normalize()
    : new THREE.Vector3(...(dirs[name] || dirs.iso)).normalize();
  const center = new THREE.Vector3(...bb.center);
  const r = Math.max(Math.hypot(...bb.size) / 2, 5);
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const dist = (r / Math.sin(fov / 2)) * (camera.aspect < 1 ? 1.25 / camera.aspect : 1.02);
  camera.position.copy(center).addScaledVector(dir, dist);
  camera.near = dist / 200;
  camera.far = dist * 20;
  camera.updateProjectionMatrix();
  if (controls) {
    controls.target.copy(center);
    controls.update();
  }
  requestRender();
}

/* ------------------------------------------------------------- mesh draw */

function heatColor(s, out) {
  if (s <= 0.003) return out.copy(colors.primer);
  if (s <= 0.1) return out.copy(colors.primer).lerp(colors['heat-mid'], s / 0.1);
  if (s <= 0.3) return out.copy(colors['heat-mid']).lerp(colors['heat-hi'], (s - 0.1) / 0.2);
  return out.copy(colors['heat-hi']);
}

// Face colour function for the current shading mode, or null for plain primer.
function faceColorFn(mesh) {
  if (state.view.heat === 'strain') return (f, c) => heatColor(mesh.strain[f], c);
  const mv = state.moved;
  if (state.view.heat === 'moved' && mv && mv.faces.length === mesh.indices.length / 3 && mv.max > 1e-4) {
    return (f, c) => {
      const t = Math.min(1, mv.faces[f] / mv.max);
      return t < 0.004 ? c.copy(colors.primer) : c.copy(colors.primer).lerp(colors.accent, 0.25 + 0.75 * t);
    };
  }
  return null;
}

// How far each face moved: across the selected step, or from the starting pose to the end.
// Only defined when both meshes share the same triangles (no Refine or Mirror in between).
function computeMoved() {
  if (!state.base || !state.result) return null;
  const sel = state.selected;
  let a, b;
  if (sel >= 0) {
    a = evaluate(state.base, state.ops, sel, state.cache).mesh;
    b = evaluate(state.base, state.ops, sel + 1, state.cache).mesh;
  } else {
    a = evaluate(state.base, state.ops, ghostIndex(), state.cache).mesh;
    b = state.result.mesh;
  }
  if (a.indices !== b.indices || a.positions.length !== b.positions.length) {
    return { faces: new Float32Array(0), max: 0, unavailable: true };
  }
  const nv = a.positions.length / 3, d = new Float32Array(nv);
  for (let v = 0; v < nv; v++) {
    const dx = b.positions[3 * v] - a.positions[3 * v], dy = b.positions[3 * v + 1] - a.positions[3 * v + 1], dz = b.positions[3 * v + 2] - a.positions[3 * v + 2];
    d[v] = Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  const I = b.indices, nf = I.length / 3, faces = new Float32Array(nf);
  let max = 0;
  for (let f = 0; f < nf; f++) {
    const m = Math.max(d[I[3 * f]], d[I[3 * f + 1]], d[I[3 * f + 2]]);
    faces[f] = m;
    if (m > max) max = m;
  }
  return { faces, max, unavailable: false };
}

function geometryFor(mesh, colorFn) {
  const P = mesh.positions, I = mesh.indices, nf = I.length / 3;
  const pos = new Float32Array(nf * 9);
  for (let f = 0; f < nf; f++) {
    for (let k = 0; k < 3; k++) {
      const v = I[3 * f + k] * 3, o = f * 9 + k * 3;
      pos[o] = P[v]; pos[o + 1] = P[v + 1]; pos[o + 2] = P[v + 2];
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.computeVertexNormals();
  if (colorFn) {
    const col = new Float32Array(nf * 9);
    const c = new THREE.Color();
    for (let f = 0; f < nf; f++) {
      colorFn(f, c);
      for (let k = 0; k < 3; k++) { col[f * 9 + k * 3] = c.r; col[f * 9 + k * 3 + 1] = c.g; col[f * 9 + k * 3 + 2] = c.b; }
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }
  g.computeBoundingSphere();
  return g;
}

function updateMesh(mesh) {
  const key = { mesh, heat: state.view.heat, moved: state.view.heat === 'moved' ? state.moved : null };
  if (shownKey && shownKey.mesh === mesh && shownKey.heat === key.heat && shownKey.moved === key.moved) return;
  shownKey = key;
  if (bodyMesh) { meshGroup.remove(bodyMesh); bodyMesh.geometry.dispose(); }
  const colorFn = faceColorFn(mesh);
  bodyMesh = new THREE.Mesh(geometryFor(mesh, colorFn), colorFn ? heatMat : bodyMat);
  meshGroup.add(bodyMesh);
  const bb = bbox(mesh);
  matGroup.position.z = bb.min[2] - 0.3;
  const extent = Math.max(200, Math.ceil((Math.max(bb.size[0], bb.size[1]) * 1.8) / 50) * 50);
  if (extent !== matExtent) { matExtent = extent; buildMat(); }
}

let ghostKey = null;
function ghostIndex() {
  let g = 0;
  while (g < state.ops.length && SETUP_TYPES.has(state.ops[g].type)) g++;
  return g;
}
// The starting pose: the model after the leading setup steps (rotate, refine, pin).
// Size deltas in the readout are measured against it.
function ghostMesh() {
  return evaluate(state.base, state.ops, ghostIndex(), state.cache).mesh;
}
// The Before outline: the selected step's input, so you see what that one step did;
// with nothing selected, the starting pose.
function outlineMesh() {
  if (state.selected >= 0 && !state.pick) return evaluate(state.base, state.ops, state.selected, state.cache).mesh;
  return ghostMesh();
}
function updateGhost(force) {
  if (!state.view.ghost || !state.base) { if (ghostGroup.children.length) disposeGroup(ghostGroup); ghostKey = null; return; }
  const m = outlineMesh();
  if (!force && ghostKey === m) return;
  ghostKey = m;
  disposeGroup(ghostGroup);
  const g = geometryFor(m, null);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(g, 28),
    new THREE.LineBasicMaterial({ color: colors.accent, transparent: true, opacity: 0.6, depthTest: false }));
  edges.renderOrder = 5;
  g.dispose();
  ghostGroup.add(edges);
}

/* -------------------------------------------------------------- overlays */

const n0 = (v, d = 0) => (v === null || v === '' || v === undefined || !Number.isFinite(+v) ? d : +v);

function quad(a, at, bb, m, color, opacity) {
  const [u, v] = [0, 1, 2].filter((k) => k !== a);
  const corners = [[bb.min[u] - m, bb.min[v] - m], [bb.max[u] + m, bb.min[v] - m], [bb.max[u] + m, bb.max[v] + m], [bb.min[u] - m, bb.max[v] + m]];
  const pts = corners.map(([cu, cv]) => { const p = [0, 0, 0]; p[a] = at; p[u] = cu; p[v] = cv; return p; });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([...pts[0], ...pts[1], ...pts[2], ...pts[0], ...pts[2], ...pts[3]], 3));
  const grp = new THREE.Group();
  grp.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false })));
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.Float32BufferAttribute([...pts[0], ...pts[1], ...pts[1], ...pts[2], ...pts[2], ...pts[3], ...pts[3], ...pts[0]], 3));
  grp.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color, transparent: true, opacity: Math.min(1, opacity * 3.5) })));
  return grp;
}

function boxMesh(min, max, color, fillOpacity, lineOpacity) {
  const size = [0, 1, 2].map((k) => Math.max(max[k] - min[k], 0.01));
  const g = new THREE.BoxGeometry(...size);
  const grp = new THREE.Group();
  grp.position.set(...[0, 1, 2].map((k) => (min[k] + max[k]) / 2));
  if (fillOpacity > 0) grp.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: fillOpacity, depthWrite: false })));
  grp.add(new THREE.LineSegments(new THREE.EdgesGeometry(g), new THREE.LineBasicMaterial({ color, transparent: true, opacity: lineOpacity, depthTest: lineOpacity < 0.5 })));
  return grp;
}

function arrow(origin, a, sign, len, color) {
  const dir = new THREE.Vector3(); dir.setComponent(a, sign);
  const h = Math.min(len * 0.4, 6);
  const ar = new THREE.ArrowHelper(dir, new THREE.Vector3(...origin), len, color, h, h * 0.6);
  ar.traverse((o) => { if (o.material) { o.material.depthTest = false; o.material.transparent = true; } });
  ar.renderOrder = 6;
  return ar;
}

// Centre of the region clipped to the model, so arrows sit where the step acts.
function regionCenter(reg, bb) {
  return [0, 1, 2].map((k) => {
    const lo = Math.max(bb.min[k], reg && reg.min[k] !== null && reg.min[k] !== '' ? +reg.min[k] : -Infinity);
    const hi = Math.min(bb.max[k], reg && reg.max[k] !== null && reg.max[k] !== '' ? +reg.max[k] : Infinity);
    return lo <= hi ? (lo + hi) / 2 : bb.center[k];
  });
}

function regionOverlay(region, bb, m) {
  if (!hasBounds(region)) return null;
  const lo = [0, 1, 2].map((k) => (region.min[k] === null || region.min[k] === '' ? bb.min[k] - m : +region.min[k]));
  const hi = [0, 1, 2].map((k) => (region.max[k] === null || region.max[k] === '' ? bb.max[k] + m : +region.max[k]));
  const f = Math.max(0, n0(region.falloff));
  const grp = new THREE.Group();
  grp.add(boxMesh(lo, hi, colors.ink, 0.035, 0.45));
  if (f > 0) {
    const flo = lo.map((v, k) => (region.min[k] === null || region.min[k] === '' ? v : v - f));
    const fhi = hi.map((v, k) => (region.max[k] === null || region.max[k] === '' ? v : v + f));
    grp.add(boxMesh(flo, fhi, colors.ink, 0, 0.28));
  }
  return grp;
}

// Drag grips: spheres drawn on top of everything; dragging one moves its value along its axis.
let grips = [];
let hoverGrip = null;
function addGrip(pos, color, size, g) {
  const grp = new THREE.Group();
  grp.position.set(...pos);
  // Opaque on purpose: transparent materials draw after opaque ones and would cover the ball.
  const halo = new THREE.Mesh(new THREE.SphereGeometry(size * 1.45, 20, 14),
    new THREE.MeshBasicMaterial({ color: colors.stage, depthTest: false, side: THREE.BackSide }));
  halo.renderOrder = 8;
  const ball = new THREE.Mesh(new THREE.SphereGeometry(size, 20, 14), new THREE.MeshBasicMaterial({ color, depthTest: false }));
  ball.renderOrder = 9;
  // A short stroke along the drag axis shows which way the grip moves.
  const p = [0, 0, 0, 0, 0, 0];
  p[g.axis] = -size * 3.2; p[g.axis + 3] = size * 3.2;
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  const stroke = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color, depthTest: false }));
  stroke.renderOrder = 9;
  grp.add(halo, stroke, ball);
  ball.userData.grip = g;
  if (hoverGrip && hoverGrip.i === g.i && hoverGrip.path === g.path) ball.scale.setScalar(1.3);
  grips.push(ball);
  overlay.add(grp);
}

function dot(p, size, color) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(size, 16, 12), new THREE.MeshBasicMaterial({ color, depthTest: false }));
  m.position.set(...p);
  m.renderOrder = 7;
  return m;
}

function updateOverlays() {
  disposeGroup(overlay);
  grips = [];
  const r = state.result;
  if (!r) return;
  const sel = state.selected;
  const op = sel >= 0 ? state.ops[sel] : null;
  const t = sel >= 0 && state.info ? state.info.trace[sel] : null;
  const bb = t ? t.bbox : bbox(r.mesh);
  const pins = t ? t.pins : r.pins;
  for (const p of pins) overlay.add(boxMesh(p.min, p.max, colors.tape, 0.18, 0.9));
  const big = Math.max(...bb.size);
  const dotSize = big * 0.006 + 0.35;
  if (state.clickPoint) overlay.add(dot(state.clickPoint, dotSize, colors.accent));
  if (state.clickPoint && state.clickPoint2) {
    overlay.add(dot(state.clickPoint2, dotSize, colors.accent));
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute([...state.clickPoint, ...state.clickPoint2], 3));
    const line = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: colors.accent, depthTest: false }));
    line.renderOrder = 7;
    overlay.add(line);
  }
  if (!op || op.enabled === false) return;
  const m = big * 0.06 + 3;
  const gs = big * 0.012 + 0.7;
  const showGrips = !state.pick;
  const up = (a) => (a !== 2 ? 2 : 1); // the axis a plane's grip tab sits along, at the top edge
  const alen = (amt) => Math.min(Math.max(Math.abs(amt) * 3, big * 0.06), big * 0.25);
  const regionGrips = (reg) => {
    if (!showGrips || !reg) return;
    const c = regionCenter(reg, bb);
    for (let k = 0; k < 3; k++) {
      for (const side of ['min', 'max']) {
        const v = reg[side][k];
        if (v === null || v === '') continue;
        const p = [...c]; p[k] = +v;
        addGrip(p, colors.ink, gs * 0.8, { i: sel, path: `region.${side}.${k}`, axis: k, label: `Region ${AX(AXN[k])} ${side === 'min' ? 'from' : 'to'}` });
      }
    }
  };
  switch (op.type) {
    case 'pin': overlay.add(boxMesh(pinBox(op).min, pinBox(op).max, colors.tape, 0.35, 1)); break;
    case 'stretch':
    case 'taper': {
      const a = AXI[op.axis];
      if (a === undefined) break;
      const at = n0(op.at), band = Math.max(0, n0(op.band));
      overlay.add(quad(a, at, bb, m, colors.axes[a], 0.16));
      if (showGrips) {
        const p = regionCenter(op.region, bb); p[a] = at; p[up(a)] = bb.max[up(a)] + m * 0.6;
        addGrip(p, colors.axes[a], gs, { i: sel, path: 'at', axis: a, label: `Split plane ${AX(op.axis)}` });
      }
      if (band > 0) {
        const lo = bb.min.map((v) => v - m), hi = bb.max.map((v) => v + m);
        lo[a] = at - band; hi[a] = at + band;
        overlay.add(boxMesh(lo, hi, colors.axes[a], 0.07, 0.25));
      }
      const c = regionCenter(op.region, bb); c[a] = at;
      const amounts = op.type === 'stretch' ? [n0(op.amount)] : [n0(op.amountFrom), n0(op.amountTo)];
      const b = AXI[op.along];
      amounts.forEach((amt, j) => {
        if (!amt) return;
        const o = [...c];
        if (op.type === 'taper' && b !== undefined) o[b] = j === 0 ? n0(op.from) : n0(op.to);
        const len = alen(amt), g = amt > 0 ? 1 : -1;
        const gap = Math.max(band, 1.5);
        if (op.side !== 'neg') { const p = [...o]; p[a] = at + gap; overlay.add(arrow(p, a, g, len, colors.accent)); }
        if (op.side !== 'pos') { const p = [...o]; p[a] = at - gap; overlay.add(arrow(p, a, -g, len, colors.accent)); }
      });
      if (op.type === 'taper' && b !== undefined && b !== a) {
        overlay.add(quad(b, n0(op.from), bb, m * 0.5, colors.axes[b], 0.06));
        overlay.add(quad(b, n0(op.to), bb, m * 0.5, colors.axes[b], 0.06));
        if (showGrips) {
          const w = [0, 1, 2].find((k) => k !== a && k !== b);
          for (const key of ['from', 'to']) {
            const p = regionCenter(op.region, bb); p[a] = at; p[b] = n0(op[key]); p[w] = bb.max[w] + m * 0.35;
            addGrip(p, colors.axes[b], gs * 0.85, { i: sel, path: key, axis: b, label: `Taper ${key} (${AX(op.along)})` });
          }
        }
      }
      const ro = regionOverlay(op.region, bb, m);
      if (ro) overlay.add(ro);
      regionGrips(op.region);
      break;
    }
    case 'move': {
      const a = AXI[op.axis];
      if (a === undefined) break;
      const amt = n0(op.amount);
      const reg = op.region;
      const c = regionCenter(reg, bb);
      if (amt) overlay.add(arrow(c, a, amt > 0 ? 1 : -1, alen(amt), colors.accent));
      const ro = regionOverlay(reg, bb, m);
      if (ro) overlay.add(ro);
      regionGrips(reg);
      break;
    }
    case 'mirror': {
      const a = AXI[op.axis];
      if (a === undefined) break;
      const at = n0(op.at);
      overlay.add(quad(a, at, bb, m, colors.axes[a], 0.2));
      if (showGrips) {
        const p = [...bb.center]; p[a] = at; p[up(a)] = bb.max[up(a)] + m * 0.6;
        addGrip(p, colors.axes[a], gs, { i: sel, path: 'at', axis: a, label: `Mirror plane ${AX(op.axis)}` });
      }
      const lo = bb.min.map((v) => v - m), hi = bb.max.map((v) => v + m);
      if (op.keep === 'neg') lo[a] = at; else hi[a] = at;
      if (hi[a] > lo[a]) overlay.add(boxMesh(lo, hi, colors.bad, 0.08, 0.2));
      break;
    }
  }
}

/* ============================================================ evaluation */

let evalQueued = false;
function scheduleEval() {
  if (evalQueued) return;
  evalQueued = true;
  requestAnimationFrame(() => { evalQueued = false; runEval(); });
}

const opsKey = () => JSON.stringify(state.ops);
const infoFrom = (r) => ({ notes: r.notes, trace: r.trace, out: bbox(r.mesh), n: r.notes.length, key: opsKey() });

let fullTimer = 0;
function runEval() {
  if (!state.base) return;
  const n = state.ops.length;
  const through = state.selected >= 0 ? state.selected + 1 : n;
  // While picking, draw the model as the selected step sees it (its input).
  const upTo = state.pick ? state.pick.i : through;
  const r = evaluate(state.base, state.ops, upTo, state.cache);
  const info = upTo === through ? r : evaluate(state.base, state.ops, through, state.cache);
  state.result = r;
  state.info = infoFrom(info);
  state.upTo = upTo;
  clearTimeout(fullTimer);
  if (through === n) state.full = state.info;
  else {
    // Notes for the steps after the selected one, computed once editing pauses.
    fullTimer = setTimeout(() => {
      if (!state.base) return;
      state.full = infoFrom(evaluate(state.base, state.ops, state.ops.length, state.cache));
      updateNotes();
    }, 300);
  }
  state.moved = state.view.heat === 'moved' ? computeMoved() : null;
  updateMesh(r.mesh);
  updateGhost();
  updateOverlays();
  updateNotes();
  updateReadout();
  scheduleCheck();
  scheduleSave();
  requestRender();
}

let checkTimer = 0;
function scheduleCheck() {
  clearTimeout(checkTimer);
  state.check = null;
  checkTimer = setTimeout(() => {
    if (!state.result) return;
    state.check = checkMesh(state.result.mesh);
    updateReadout();
  }, 220);
}

// What each step reports: its own note (warnings, counts) and how it changed the overall size.
function noteFor(i) {
  const op = state.ops[i];
  if (op.enabled === false) return { text: 'Turned off.', size: '', warn: false };
  const key = opsKey();
  const src = state.info && i < state.info.n ? state.info : state.full && state.full.key === key && i < state.full.n ? state.full : null;
  if (!src) return { text: '', size: '', warn: false };
  const text = src.notes[i] || '';
  const warn = /^Error|Nothing moved|holds nothing/.test(text);
  let size = '';
  if (!SETUP_TYPES.has(op.type) && !text.startsWith('Error')) {
    const before = src.trace[i].bbox;
    const after = i + 1 < src.n ? src.trace[i + 1].bbox : src.out;
    const parts = [0, 1, 2]
      .map((k) => ({ k, d: after.size[k] - before.size[k] }))
      .filter(({ d }) => Math.abs(d) >= 0.05)
      .map(({ k, d }) => `<span class="ax-${AXN[k]}">${AX(AXN[k])}</span> ${signed(d)}`);
    size = parts.length ? `${parts.join(' · ')} mm` : 'Outer size unchanged';
  }
  return { text, size, warn };
}

function updateNotes() {
  state.ops.forEach((op, i) => {
    const el = document.getElementById('note-' + i);
    if (!el) return;
    const { text, size, warn } = noteFor(i);
    el.innerHTML = [size && `<span class="num">${size}</span>`, text && `<span>${esc(text)}</span>`].filter(Boolean).join(' ');
    el.classList.toggle('err', warn);
  });
}

const fmtN = (v) => {
  const r = Math.round(v * 10) / 10;
  return (Object.is(r, -0) ? 0 : r).toFixed(1);
};
const signed = (v) => (v > 0 ? '+' : v < 0 ? '−' : '±') + fmtN(Math.abs(v));

function updateReadout() {
  const el = $('#readout');
  const r = state.result;
  if (!r) { el.innerHTML = ''; return; }
  const bb = bbox(r.mesh);
  const ref = bbox(ghostMesh());
  const parts = [];
  parts.push(AXN.map((a, k) => {
    const d = bb.size[k] - ref.size[k];
    return `<span><b class="num"><span class="ax-${a}">${a.toUpperCase()}</span> ${fmtN(bb.size[k])}</b>${Math.abs(d) >= 0.05 ? ` <span class="num delta">${signed(d)}</span>` : ''}</span>`;
  }).join('') + '<span>mm</span>');
  parts.push(`<span class="num">${(r.mesh.indices.length / 3).toLocaleString()} faces</span>`);
  const c = state.check;
  if (!c) parts.push('<span class="chip wait">Checking</span>');
  else if (c.watertight) parts.push('<span class="chip good">Watertight</span>');
  else parts.push(`<span class="chip bad" title="${c.boundary} open, ${c.nonManifold} non-manifold, ${c.flipped} flipped edges">${(c.boundary + c.nonManifold + c.flipped).toLocaleString()} problem edges</span>`);
  if (state.view.heat === 'strain') {
    let mx = 0;
    for (const s of r.mesh.strain) if (s > mx) mx = s;
    parts.push(`<span class="legend"><span>0</span><i></i><span>30%+</span><span class="num">max ${mx > 1 ? 'over 100' : Math.round(mx * 100)}%</span></span>`);
  } else if (state.view.heat === 'moved') {
    const mv = state.moved;
    const scope = state.selected >= 0 ? `step ${state.selected + 1}` : 'all steps';
    if (!mv || mv.unavailable) parts.push(`<span>Moved view can’t compare across a Refine or Mirror step</span>`);
    else parts.push(`<span class="legend moved"><span>0</span><i></i><span class="num">${fmtN(mv.max)} mm</span><span>${scope}</span></span>`);
  }
  const n = state.ops.length;
  if (state.pick) parts.push(`<span>Showing the model before step ${state.pick.i + 1}</span>`);
  else if (state.upTo < n) parts.push(`<span>Showing steps 1–${state.upTo} of ${n}</span>`);
  const pt = (p) => AXN.map((a, k) => `<span class="ax-${a}">${a.toUpperCase()}</span> ${fmtN(p[k])}`).join(' ');
  if (state.clickPoint && state.clickPoint2) {
    const d = [0, 1, 2].map((k) => state.clickPoint2[k] - state.clickPoint[k]);
    parts.push(`<span class="num">Distance <b>${fmtN(Math.hypot(...d))}</b> mm (${AXN.map((a, k) => `<span class="ax-${a}">Δ${a.toUpperCase()}</span> ${fmtN(Math.abs(d[k]))}`).join(' ')})</span>`);
  } else if (state.clickPoint) {
    parts.push(`<span class="num">Point ${pt(state.clickPoint)}</span><span class="hintline">Shift-click a second point to measure</span>`);
  }
  el.innerHTML = parts.join('');
}

/* ================================================================= panel */

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtIn = (v) => (v === null || v === undefined ? '' : String(v));
const shortN = (v) => { const r = Math.round(n0(v) * 100) / 100; return String(Object.is(r, -0) ? 0 : r).replace('-', '−'); };
const sgnS = (v) => (n0(v) > 0 ? '+' : '') + shortN(v);
const AX = (a) => (a || '?').toUpperCase();

function hasBounds(r) {
  if (!r) return false;
  return [0, 1, 2].some((k) => (r.min[k] !== null && r.min[k] !== '') || (r.max[k] !== null && r.max[k] !== ''));
}
function regionText(r) {
  if (!hasBounds(r)) return 'whole model';
  const parts = [];
  [0, 1, 2].forEach((k) => {
    const lo = r.min[k] !== null && r.min[k] !== '', hi = r.max[k] !== null && r.max[k] !== '';
    if (lo && hi) parts.push(`${AX(AXN[k])} ${shortN(r.min[k])}…${shortN(r.max[k])}`);
    else if (lo) parts.push(`${AX(AXN[k])} ≥ ${shortN(r.min[k])}`);
    else if (hi) parts.push(`${AX(AXN[k])} ≤ ${shortN(r.max[k])}`);
  });
  return parts.join(', ') + ` · blend ${shortN(r.falloff)}`;
}
const SIDE = { both: 'both sides', pos: '+ side', neg: '− side' };

function summary(op) {
  const reg = op.region && hasBounds(op.region) ? ' · region' : '';
  switch (op.type) {
    case 'rotate': return `${[90, 180, 270][((n0(op.turns) % 4) + 4) % 4 - 1] ?? 0}° about ${AX(op.axis)}`;
    case 'refine': return `edges ≤ ${shortN(op.maxEdge)} mm`;
    case 'pin': return `${op.size.map(shortN).join('×')} mm at (${op.center.map(shortN).join(', ')})`;
    case 'stretch': return `${AX(op.axis)} ${sgnS(op.amount)} mm at ${shortN(op.at)} · ${SIDE[op.side] || SIDE.both}${reg}`;
    case 'taper': return `${AX(op.axis)} ${sgnS(op.amountFrom)} → ${sgnS(op.amountTo)} mm along ${AX(op.along)} ${shortN(op.from)}…${shortN(op.to)}${reg}`;
    case 'move': return `${AX(op.axis)} ${sgnS(op.amount)} mm${reg}`;
    case 'mirror': return `keep ${op.keep === 'neg' ? '−' : '+'}${AX(op.axis)} of ${shortN(op.at)}`;
    default: return '';
  }
}

const ICON = {
  up: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 10l4-4 4 4"/></svg>',
  down: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 6l4 4 4-4"/></svg>',
  on: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>',
  off: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><path d="M2.5 13.5l11-11"/></svg>',
  del: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/></svg>',
  pick: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="4.5"/><path d="M8 1v3.5M8 11.5V15M1 8h3.5M11.5 8H15"/></svg>',
  dup: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5v-.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h.5"/></svg>',
  undo: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5.5 3L2.5 6l3 3"/><path d="M2.5 6h7a4 4 0 0 1 0 8H7"/></svg>',
  redo: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M10.5 3l3 3-3 3"/><path d="M13.5 6h-7a4 4 0 0 0 0 8H9"/></svg>',
};

function pickBtn(i, target, label) {
  const on = state.pick && state.pick.i === i && state.pick.target === target;
  return `<button type="button" class="pick" data-pick="${target}" data-i="${i}" aria-pressed="${!!on}" aria-label="Pick ${esc(label)} on the model" title="Pick on the model">${ICON.pick}</button>`;
}

function fieldsFor(op, i) {
  const id = (k) => `op${i}-${k}`;
  const axisSeg = (key, label, exclude) => `<div class="field"><span class="flabel">${label}</span><div class="seg" role="group" aria-label="${label}">${AXN
    .map((a) => `<button type="button" class="axbtn ax-${a}" data-set="${key}" data-val="${a}" data-i="${i}" aria-pressed="${op[key] === a}" ${exclude === a ? 'disabled title="Same as Axis"' : ''}>${a.toUpperCase()}</button>`)
    .join('')}</div></div>`;
  const seg = (key, label, opts) => `<div class="field"><span class="flabel">${label}</span><div class="seg" role="group" aria-label="${label}">${opts
    .map(([v, t]) => `<button type="button" data-set="${key}" data-val="${v}" data-num="${typeof v === 'number'}" data-i="${i}" aria-pressed="${op[key] === v}">${t}</button>`)
    .join('')}</div></div>`;
  const num = (key, label, o = {}) => `<div class="field"><label class="flabel scrub" for="${id(key)}" title="Drag sideways to adjust">${label}</label><span class="numwrap"><input id="${id(key)}" type="number" step="${o.step ?? 0.5}" ${o.min !== undefined ? `min="${o.min}"` : ''} value="${fmtIn(op[key])}" data-path="${key}" data-i="${i}"><span class="unit">mm</span>${o.pick ? pickBtn(i, o.pick, label) : '<span class="pick-spacer"></span>'}</span>${o.hint ? `<div class="fhint">${o.hint}</div>` : ''}</div>`;
  const vec = (key, label, pick) => `<div class="field"><span class="flabel">${label}</span><div class="vec">${[0, 1, 2]
    .map((k) => `<input class="ax-${AXN[k]}-line" id="${id(key + k)}" type="number" step="0.5" value="${fmtIn(op[key][k])}" data-path="${key}.${k}" data-i="${i}" aria-label="${label} ${AXN[k].toUpperCase()}" title="${AXN[k].toUpperCase()}">`)
    .join('')}${pick ? pickBtn(i, 'center', label) : '<span></span>'}</div></div>`;

  switch (op.type) {
    case 'rotate': return axisSeg('axis', 'About') + seg('turns', 'Turn', [[1, '90°'], [2, '180°'], [3, '270°']]);
    case 'refine': return num('maxEdge', 'Max edge', { min: 0.2, hint: 'Smaller is smoother but makes a bigger file. 3 mm suits most bodies.' });
    case 'pin': return vec('center', 'Centre', true) + vec('size', 'Size', false) + num('falloff', 'Blend', { hint: 'Distance around the box over which it eases back into the stretch.' });
    case 'stretch': return axisSeg('axis', 'Axis')
      + num('at', 'Split plane at', { pick: 'at' })
      + num('amount', 'Amount', { hint: 'Total change in length. Negative shrinks.' })
      + seg('side', 'Moves', [['both', 'Both'], ['pos', '+ side'], ['neg', '− side']])
      + num('band', 'Blend band', { min: 0, hint: '0 slides the halves apart. Wider spreads the stretch over more of the shell.' })
      + regionHtml(op, i);
    case 'taper': return axisSeg('axis', 'Axis')
      + num('at', 'Split plane at', { pick: 'at' })
      + seg('side', 'Moves', [['both', 'Both'], ['pos', '+ side'], ['neg', '− side']])
      + num('band', 'Blend band', { min: 0 })
      + axisSeg('along', 'Varies along', op.axis)
      + num('from', 'From', { pick: 'from' })
      + num('to', 'To', { pick: 'to' })
      + num('amountFrom', 'Amount at From')
      + num('amountTo', 'Amount at To', { hint: 'Change in width at each end, blended linearly between.' })
      + regionHtml(op, i);
    case 'move': return axisSeg('axis', 'Axis') + num('amount', 'Distance') + regionHtml(op, i);
    case 'mirror': return axisSeg('axis', 'Axis')
      + num('at', 'Mirror plane at', { pick: 'at' })
      + seg('keep', 'Keep', [['pos', '+ side'], ['neg', '− side']]);
    default: return '';
  }
}

function regionHtml(op, i) {
  const r = op.region;
  const open = state.regionOpen.has(op) ? state.regionOpen.get(op) : hasBounds(r);
  const rows = [0, 1, 2].map((k) => {
    const a = AXN[k];
    return `<div class="rrow"><span class="ax ax-${a}">${a.toUpperCase()}</span>`
      + `<input id="op${i}-rmin${k}" type="number" step="0.5" placeholder="no limit" value="${fmtIn(r.min[k])}" data-path="region.min.${k}" data-i="${i}" aria-label="${a.toUpperCase()} from">`
      + pickBtn(i, 'rmin:' + k, `${a.toUpperCase()} from`)
      + '<span class="to">to</span>'
      + `<input id="op${i}-rmax${k}" type="number" step="0.5" placeholder="no limit" value="${fmtIn(r.max[k])}" data-path="region.max.${k}" data-i="${i}" aria-label="${a.toUpperCase()} to">`
      + pickBtn(i, 'rmax:' + k, `${a.toUpperCase()} to`) + '</div>';
  }).join('');
  return `<details class="region" data-i="${i}" ${open ? 'open' : ''}><summary>Limit to a region <span class="num" id="rsum-${i}">${esc(regionText(r))}</span></summary><div class="rbody">${rows}`
    + `<div class="field"><label class="flabel scrub" for="op${i}-rfall" title="Drag sideways to adjust">Blend</label><span class="numwrap"><input id="op${i}-rfall" type="number" step="1" min="0" value="${fmtIn(r.falloff)}" data-path="region.falloff" data-i="${i}"><span class="unit">mm</span><span class="pick-spacer"></span></span><div class="fhint">Leave a bound empty for no limit. The step fades out over the blend distance beyond the box.</div></div>`
    + '</div></details>';
}

const stepTitle = (op) => (op.label && op.label.trim()) || NAMES[op.type] || op.type;

function renderOp(op, i) {
  const sel = i === state.selected;
  const n = state.ops.length;
  const named = !!(op.label && op.label.trim());
  return `<li class="op${sel ? ' sel' : ''}${op.enabled === false ? ' off' : ''}">
    <div class="op-head" data-act="select" data-i="${i}" role="button" tabindex="0" aria-expanded="${sel}" title="${sel ? 'Close this step' : 'Edit this step and show the model up to it'}">
      <span class="op-n">${i + 1}</span>
      <div class="op-title"><div class="op-name" id="title-${i}">${esc(stepTitle(op))}${op.type === 'pin' ? '<span class="tag">RIGID</span>' : ''}</div><div class="op-sum" id="sum-${i}">${named ? `<span class="op-type">${NAMES[op.type]}</span> · ` : ''}${esc(summary(op))}</div></div>
      <div class="op-tools">
        <button type="button" class="icon" data-act="up" data-i="${i}" aria-label="Move step up" title="Move up" ${i === 0 ? 'disabled' : ''}>${ICON.up}</button>
        <button type="button" class="icon" data-act="down" data-i="${i}" aria-label="Move step down" title="Move down" ${i === n - 1 ? 'disabled' : ''}>${ICON.down}</button>
        <button type="button" class="icon" data-act="dup" data-i="${i}" aria-label="Duplicate step" title="Duplicate (Ctrl/⌘+D)">${ICON.dup}</button>
        <button type="button" class="icon" data-act="toggle" data-i="${i}" aria-label="${op.enabled === false ? 'Turn step on' : 'Turn step off'}" title="${op.enabled === false ? 'Turn on' : 'Turn off'}">${op.enabled === false ? ICON.off : ICON.on}</button>
        <button type="button" class="icon" data-act="del" data-i="${i}" aria-label="Delete step" title="Delete (Del)">${ICON.del}</button>
      </div>
    </div>
    <div class="op-note" id="note-${i}"></div>
    ${sel ? `<div class="op-body">
      <p class="op-help">${OPS_HELP[op.type] || ''}</p>
      <div class="field"><label class="flabel" for="op${i}-label">Name</label><input class="textin" id="op${i}-label" type="text" maxlength="60" placeholder="${NAMES[op.type]}" value="${esc(op.label || '')}" data-kind="label" data-i="${i}"></div>
      ${fieldsFor(op, i)}</div>` : ''}
  </li>`;
}

function orientationNotice() {
  if (!state.base || state.ops.some((o) => o.type === 'rotate')) return '';
  const s = bbox(state.base).size;
  if (s[2] <= Math.max(s[0], s[1]) * 1.15) return '';
  return `<div class="notice"><span>This model is taller than it is long, so it may be stood on end for printing. Lay it down so Y runs nose to tail?</span><button type="button" class="btn" data-act="layflat">Add Rotate X 90°</button></div>`;
}

// Top view of a body split at a plane: the halves slide apart and only the strip between them stretches.
const INTRO_DIAGRAM = `<svg class="intro-fig" viewBox="0 0 320 96" role="img" aria-label="Diagram: a body seen from above is cut at a split plane. The two halves slide apart, and only the strip between them stretches.">
  <rect x="80" y="22" width="160" height="52" rx="16" fill="none" stroke="var(--muted)" stroke-dasharray="4 4"/>
  <path d="M164 22 H82 a16 16 0 0 0 -16 16 v20 a16 16 0 0 0 16 16 H164" transform="translate(-14 0)" fill="var(--primer)" fill-opacity=".55" stroke="var(--ink)" stroke-width="1.2"/>
  <path d="M156 22 H238 a16 16 0 0 1 16 16 v20 a16 16 0 0 1 -16 16 H156" transform="translate(14 0)" fill="var(--primer)" fill-opacity=".55" stroke="var(--ink)" stroke-width="1.2"/>
  <rect x="150" y="22" width="20" height="52" fill="var(--heat-mid)" fill-opacity=".55"/>
  <line x1="160" y1="8" x2="160" y2="88" stroke="var(--ax-x)" stroke-width="1.6" stroke-dasharray="5 3"/>
  <path d="M128 48 h-28 m6 -5 l-6 5 6 5 M192 48 h28 m-6 -5 l6 5 -6 5" fill="none" stroke="var(--accent)" stroke-width="2"/>
  <text x="166" y="14" font-size="10" fill="var(--muted)">split plane</text>
  <text x="160" y="94" font-size="10" fill="var(--muted)" text-anchor="middle">only this strip stretches</text>
  <text x="80" y="16" font-size="10" fill="var(--muted)">before</text>
</svg>`;

function introHtml() {
  if (!state.showIntro) return '';
  const sample = state.fileName === 'sample-pickup.stl';
  return `<section class="intro" aria-label="How Panelbeater works">
    <div class="intro-head"><h2 class="sec-title">How it works</h2><button type="button" class="icon" data-act="intro-close" aria-label="Close" title="Close">✕</button></div>
    ${INTRO_DIAGRAM}
    <ol class="intro-steps">
      <li><b>Open an STL or 3MF.</b> It sits centred on the mat, and every number is in millimetres.</li>
      <li><b>Add steps.</b> They run top to bottom. Click one to edit it; the view then shows the model up to that step.</li>
      <li><b>Drag the coloured grips or type numbers.</b> The line under each step says what it changed.</li>
      <li><b>Export STL</b> once the readout says Watertight.</li>
    </ol>
    <p class="hint">${sample ? 'This sample truck already has six named steps. Click through them to see what each one does.' : 'Your steps and model are saved in this browser, so a reload picks up where you left off.'}</p>
    <div class="intro-actions"><button type="button" class="btn" data-act="intro-close">Got it</button>${sample ? '' : '<button type="button" class="btn" data-act="sample">Open the sample truck</button>'}</div>
  </section>`;
}

function renderPanel() {
  const add = (t, label) => `<button type="button" class="add" data-add="${t}" title="${esc(OPS_HELP[t])}">+ ${label}</button>`;
  const ops = state.ops;
  $('#panel').innerHTML = `
    ${introHtml()}
    <div class="addbar">
      <h2 class="sec-title">Add a step</h2>
      <div class="addrow"><span class="lbl">Set up</span>${add('rotate', 'Rotate')}${add('refine', 'Refine')}${add('pin', 'Pin')}</div>
      <div class="addrow"><span class="lbl">Shape</span>${add('stretch', 'Stretch')}${add('taper', 'Taper')}${add('move', 'Move')}${add('mirror', 'Mirror')}</div>
    </div>
    ${orientationNotice()}
    <section>
      <div class="steps-head">
        <h2 class="sec-title">Steps <span class="num">${ops.length}</span></h2>
        <div class="hist">
          <button type="button" class="icon" id="btn-undo" data-act="undo" aria-label="Undo" title="Undo (Ctrl/⌘+Z)">${ICON.undo}</button>
          <button type="button" class="icon" id="btn-redo" data-act="redo" aria-label="Redo" title="Redo (Ctrl/⌘+Shift+Z)">${ICON.redo}</button>
        </div>
      </div>
      ${ops.length ? `<ol class="ops">${ops.map(renderOp).join('')}</ol>` : '<p class="hint">No steps yet. Each step applies to the whole model unless you limit it to a region.</p>'}
    </section>
    <div class="foot">
      <span>Millimetres. X and Y are centred on the model; it sits on Z&nbsp;=&nbsp;0. New steps go after the selected one. Work is saved in this browser.</span>
      <dl class="keys">
        <dt>Click</dt><dd>read a point · <kbd>Shift</kbd>-click to measure</dd>
        <dt>Double-click</dt><dd>orbit around that point</dd>
        <dt>Drag a field label</dt><dd>scrub its value · <kbd>↑</kbd><kbd>↓</kbd> step it (<kbd>Shift</kbd> ×10, <kbd>Alt</kbd> fine)</dd>
        <dt><kbd>F</kbd></dt><dd>fit the model in view</dd>
        <dt><kbd>Ctrl</kbd>/<kbd>⌘</kbd></dt><dd><kbd>Z</kbd> undo · <kbd>Shift</kbd>+<kbd>Z</kbd> redo · <kbd>D</kbd> duplicate step</dd>
        <dt><kbd>Del</kbd> · <kbd>Esc</kbd></dt><dd>delete · close the selected step</dd>
      </dl>
      <button type="button" class="linkbtn" data-act="sample">Start over with the sample truck</button>
    </div>`;
  updateNotes();
  updateHistoryButtons();
}

/* --------------------------------------------------------------- editing */

const r1 = (v) => Math.round(v * 10) / 10;

function setPath(op, path, raw) {
  const parts = path.split('.');
  const isBound = parts[0] === 'region' && (parts[1] === 'min' || parts[1] === 'max');
  let v = raw === '' ? null : Number(raw);
  if (v !== null && !Number.isFinite(v)) return false;
  if (v === null && !isBound) return false; // keep the last good number while typing
  let obj = op;
  for (const p of parts.slice(0, -1)) obj = obj[p];
  obj[parts[parts.length - 1]] = v;
  return true;
}

function refreshCardText(i) {
  const op = state.ops[i];
  const named = !!(op.label && op.label.trim());
  const s = document.getElementById('sum-' + i);
  if (s) s.innerHTML = `${named ? `<span class="op-type">${NAMES[op.type]}</span> · ` : ''}${esc(summary(op))}`;
  const t = document.getElementById('title-' + i);
  if (t) t.innerHTML = esc(stepTitle(op)) + (op.type === 'pin' ? '<span class="tag">RIGID</span>' : '');
  const rs = document.getElementById('rsum-' + i);
  if (rs) rs.textContent = regionText(op.region);
}

function inputBBox(index) {
  const r = evaluate(state.base, state.ops, index, state.cache);
  return bbox(r.mesh);
}

function addOp(type) {
  if (!state.base) { toast('Open a model first.'); return; }
  const at = state.selected >= 0 ? state.selected + 1 : state.ops.length;
  const bb = inputBBox(at);
  const op = defaultOp(type, bb);
  if (type === 'pin') {
    op.center = (state.clickPoint || [bb.center[0], bb.center[1], bb.max[2] - 2]).map(r1);
  }
  state.ops.splice(at, 0, op);
  state.selected = at;
  cancelPick(false);
  record(true);
  renderPanel();
  scheduleEval();
}

function startPick(i, target) {
  const op = state.ops[i];
  const label = {
    at: `${op.type === 'mirror' ? 'the mirror plane' : 'the split plane'} (${AX(op.axis)})`,
    from: `From (${AX(op.along)})`, to: `To (${AX(op.along)})`, center: 'the pin centre',
  }[target] || (target.startsWith('rmin') ? `the region start (${AX(AXN[+target.slice(5)])})` : `the region end (${AX(AXN[+target.slice(5)])})`);
  state.pick = { i, target };
  $('#banner').textContent = `Click the model to set ${label}. Esc cancels.`;
  $('#banner').hidden = false;
  stage.classList.add('picking');
  renderPanel();
  scheduleEval();
}

function cancelPick(rerender = true) {
  if (!state.pick) return;
  state.pick = null;
  $('#banner').hidden = true;
  stage.classList.remove('picking');
  if (rerender) { renderPanel(); scheduleEval(); }
}

function applyPick(p) {
  const { i, target } = state.pick;
  const op = state.ops[i];
  if (target === 'at') op.at = r1(p[AXI[op.axis]]);
  else if (target === 'from') op.from = r1(p[AXI[op.along]]);
  else if (target === 'to') op.to = r1(p[AXI[op.along]]);
  else if (target === 'center') op.center = p.map(r1);
  else if (target.startsWith('rmin:') || target.startsWith('rmax:')) {
    const k = +target.slice(5);
    op.region[target.startsWith('rmin') ? 'min' : 'max'][k] = r1(p[k]);
    state.regionOpen.set(op, true);
  }
  state.clickPoint = p;
  cancelPick(false);
  record(true);
  renderPanel();
  scheduleEval();
}

const panel = $('#panel');
panel.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act],[data-set],[data-pick],[data-add]');
  if (!el || el.disabled) return;
  const i = +el.dataset.i;
  if (el.dataset.add) return addOp(el.dataset.add);
  if (el.dataset.pick) {
    if (state.pick && state.pick.i === i && state.pick.target === el.dataset.pick) return cancelPick();
    return startPick(i, el.dataset.pick);
  }
  if (el.dataset.set) {
    const op = state.ops[i];
    op[el.dataset.set] = el.dataset.num === 'true' ? Number(el.dataset.val) : el.dataset.val;
    if (op.type === 'taper' && op.along === op.axis) op.along = AXN.find((a) => a !== op.axis && a !== 'z') || 'y';
    record(true);
    renderPanel();
    scheduleEval();
    return;
  }
  const act = el.dataset.act;
  const ops = state.ops;
  if (act === 'select') {
    state.selected = state.selected === i ? -1 : i;
    cancelPick(false);
  } else if (act === 'up' && i > 0) {
    [ops[i - 1], ops[i]] = [ops[i], ops[i - 1]];
    state.selected = i - 1;
  } else if (act === 'down' && i < ops.length - 1) {
    [ops[i + 1], ops[i]] = [ops[i], ops[i + 1]];
    state.selected = i + 1;
  } else if (act === 'toggle') {
    ops[i].enabled = ops[i].enabled === false;
  } else if (act === 'del') {
    deleteStep(i);
    return;
  } else if (act === 'dup') {
    duplicateStep(i);
    return;
  } else if (act === 'undo') {
    undo();
    return;
  } else if (act === 'redo') {
    redo();
    return;
  } else if (act === 'intro-close') {
    state.showIntro = false;
    try { localStorage.setItem('pb.intro', 'seen'); } catch {}
    renderPanel();
    return;
  } else if (act === 'sample') {
    loadSample();
    return;
  } else if (act === 'layflat') {
    ops.unshift({ ...defaultOp('rotate'), axis: 'x', turns: 1 });
    if (state.selected >= 0) state.selected++;
  } else return;
  if (act !== 'select') record(true);
  renderPanel();
  scheduleEval();
});
panel.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.op-head')) { e.preventDefault(); e.target.click(); }
});
panel.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.kind === 'label') {
    const op = state.ops[+t.dataset.i];
    if (t.value.trim()) op.label = t.value; else delete op.label;
    refreshCardText(+t.dataset.i);
    record();
    scheduleSave();
    return;
  }
  if (!t.matches('input[data-path]')) return;
  const i = +t.dataset.i;
  if (!setPath(state.ops[i], t.dataset.path, t.value)) return;
  refreshCardText(i);
  record();
  scheduleEval();
});

// Set a number field from code (keys, scrubbing, grips) and run it through the normal input path.
function nudgeInput(input, value) {
  const step = parseFloat(input.step) || 0.5;
  const decimals = step < 0.5 ? 2 : 1;
  let v = Math.round(value * 10 ** decimals) / 10 ** decimals;
  if (input.min !== '' && v < +input.min) v = +input.min;
  input.value = String(v);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
const multiplier = (e) => (e.shiftKey ? 10 : e.altKey ? 0.2 : 1);

panel.addEventListener('keydown', (e) => {
  const t = e.target;
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && t.matches('input[type="number"][data-path]')) {
    e.preventDefault();
    const step = parseFloat(t.step) || 0.5;
    const cur = t.value === '' ? 0 : +t.value;
    nudgeInput(t, cur + (e.key === 'ArrowUp' ? 1 : -1) * step * multiplier(e));
  }
});

// Drag left/right on a field's label to scrub its value: 6 px per step, Shift ×10, Alt fine.
let scrub = null;
panel.addEventListener('pointerdown', (e) => {
  const label = e.target.closest('label.flabel[for]');
  if (!label || e.button !== 0) return;
  const input = document.getElementById(label.htmlFor);
  if (!input || input.type !== 'number' || !input.dataset.path) return;
  scrub = { input, x: e.clientX, start: input.value === '' ? 0 : +input.value, moved: false, id: e.pointerId };
  label.setPointerCapture(e.pointerId);
});
panel.addEventListener('pointermove', (e) => {
  if (!scrub || e.pointerId !== scrub.id) return;
  const dx = e.clientX - scrub.x;
  if (!scrub.moved && Math.abs(dx) < 3) return;
  if (!scrub.moved) { scrub.moved = true; document.body.classList.add('scrubbing'); }
  const step = parseFloat(scrub.input.step) || 0.5;
  nudgeInput(scrub.input, scrub.start + Math.round(dx / 6) * step * multiplier(e));
});
const endScrub = (e) => {
  if (!scrub || (e && e.pointerId !== scrub.id)) return;
  if (scrub.moved) { document.body.classList.remove('scrubbing'); record(true); }
  else scrub.input.focus();
  scrub = null;
};
panel.addEventListener('pointerup', endScrub);
panel.addEventListener('pointercancel', endScrub);

function deleteStep(i) {
  const ops = state.ops;
  if (i < 0 || i >= ops.length) return;
  const name = stepTitle(ops[i]);
  ops.splice(i, 1);
  if (state.selected === i) state.selected = -1;
  else if (state.selected > i) state.selected--;
  cancelPick(false);
  record(true);
  renderPanel();
  scheduleEval();
  toast(`Deleted “${name}”. Ctrl/⌘+Z brings it back.`);
}

function duplicateStep(i) {
  const ops = state.ops;
  if (i < 0 || i >= ops.length) return;
  const copy = JSON.parse(JSON.stringify(ops[i]));
  if (copy.label) copy.label = `${copy.label} (copy)`;
  ops.splice(i + 1, 0, copy);
  state.selected = i + 1;
  cancelPick(false);
  record(true);
  renderPanel();
  scheduleEval();
}
panel.addEventListener('toggle', (e) => {
  if (e.target.matches('details.region')) state.regionOpen.set(state.ops[+e.target.dataset.i], e.target.open);
}, true);

/* ---------------------------------------------------------------- history */

const history = { stack: [], index: -1, timer: 0 };
const snapshot = () => JSON.stringify({ ops: state.ops, selected: state.selected });
function commit() {
  clearTimeout(history.timer);
  history.timer = 0;
  const s = snapshot();
  if (history.stack[history.index] === s) return;
  history.stack.length = history.index + 1;
  history.stack.push(s);
  if (history.stack.length > 300) history.stack.shift();
  history.index = history.stack.length - 1;
  updateHistoryButtons();
  scheduleSave();
}
function updateHistoryButtons() {
  const u = document.getElementById('btn-undo'), r = document.getElementById('btn-redo');
  if (u) u.disabled = history.index <= 0 && !history.timer;
  if (r) r.disabled = history.index >= history.stack.length - 1;
}
function record(now = false) {
  clearTimeout(history.timer);
  if (now) commit(); else history.timer = setTimeout(commit, 400);
}
function restore(s) {
  const o = JSON.parse(s);
  state.ops = o.ops;
  state.selected = Math.min(o.selected, state.ops.length - 1);
  cancelPick(false);
  renderPanel();
  scheduleEval();
  scheduleSave();
}
function undo() {
  if (history.timer) commit();
  if (history.index > 0) restore(history.stack[--history.index]);
}
function redo() {
  if (history.index < history.stack.length - 1) restore(history.stack[++history.index]);
}
function resetHistory() {
  history.stack = [];
  history.index = -1;
  commit();
}

window.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  const typing = e.target.matches('input, textarea, select, [contenteditable]');
  const key = e.key.toLowerCase();
  if (mod && key === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && key === 'y') { e.preventDefault(); redo(); return; }
  if (mod && key === 'd' && state.selected >= 0) { e.preventDefault(); duplicateStep(state.selected); return; }
  if (e.key === 'Escape') {
    if (drag) return;
    if (state.pick) cancelPick();
    else if (state.selected >= 0 && !typing) { state.selected = -1; renderPanel(); scheduleEval(); }
    return;
  }
  if (typing || mod || e.altKey) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected >= 0) { e.preventDefault(); deleteStep(state.selected); return; }
  if (key === 'f') { frameView('keep'); }
});

/* ------------------------------------------------------------ viewport io */

const raycaster = new THREE.Raycaster();
const ndcOf = (e) => {
  const r = canvas.getBoundingClientRect();
  return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
};
function hitModel(e) {
  if (!bodyMesh) return null;
  raycaster.setFromCamera(ndcOf(e), camera);
  const hit = raycaster.intersectObject(bodyMesh, false)[0];
  return hit ? [hit.point.x, hit.point.y, hit.point.z] : null;
}
function gripAt(e) {
  if (!grips.length) return null;
  raycaster.setFromCamera(ndcOf(e), camera);
  const hit = raycaster.intersectObjects(grips, false)[0];
  return hit ? hit.object : null;
}
// Where along the axis line through `origin` the mouse ray passes closest. Null when the
// axis points straight at the camera and can't be dragged along.
function axisParam(e, origin, axis) {
  raycaster.setFromCamera(ndcOf(e), camera);
  const O = raycaster.ray.origin, D = raycaster.ray.direction;
  const A = new THREE.Vector3(); A.setComponent(axis, 1);
  const w0 = origin.clone().sub(O);
  const b = A.dot(D), d = A.dot(w0), e2 = D.dot(w0);
  const denom = 1 - b * b;
  return denom < 1e-3 ? null : (b * e2 - d) / denom;
}
const getPath = (op, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), op);
const inputIdFor = (i, path) => {
  const m = path.match(/^region\.(min|max)\.(\d)$/);
  return m ? `op${i}-r${m[1]}${m[2]}` : `op${i}-${path}`;
};

const tip = document.createElement('div');
tip.className = 'griptip';
tip.hidden = true;
stage.append(tip);

let drag = null;
let downAt = null;

// Grips are grabbed in the capture phase so the orbit controls never see the press.
stage.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !renderer || e.target !== canvas) return;
  const obj = gripAt(e);
  if (!obj) return;
  const g = obj.userData.grip;
  const origin = obj.getWorldPosition(new THREE.Vector3());
  const t0 = axisParam(e, origin, g.axis);
  e.stopPropagation();
  e.preventDefault();
  if (t0 === null) { toast(`Turn the view a little to drag along ${AX(AXN[g.axis])}.`); return; }
  drag = { g, origin, t0, start: n0(getPath(state.ops[g.i], g.path)), id: e.pointerId };
  if (controls) controls.enabled = false;
  stage.setPointerCapture(e.pointerId);
  stage.classList.add('dragging');
}, true);

window.addEventListener('pointermove', (e) => {
  if (drag) {
    if (e.pointerId !== drag.id) return;
    const t = axisParam(e, drag.origin, drag.g.axis);
    if (t === null) return;
    const snap = e.shiftKey ? 0.1 : 0.5;
    const v = Math.round((Math.round((drag.start + (t - drag.t0)) / snap) * snap) * 100) / 100;
    const op = state.ops[drag.g.i];
    if (n0(getPath(op, drag.g.path)) !== v || getPath(op, drag.g.path) === null) {
      setPath(op, drag.g.path, String(v));
      const input = document.getElementById(inputIdFor(drag.g.i, drag.g.path));
      if (input) input.value = String(v);
      refreshCardText(drag.g.i);
      scheduleEval();
    }
    const r = stage.getBoundingClientRect();
    tip.textContent = `${drag.g.label}: ${shortN(v)} mm`;
    tip.style.left = `${e.clientX - r.left + 14}px`;
    tip.style.top = `${e.clientY - r.top + 14}px`;
    tip.hidden = false;
    return;
  }
  // Hover feedback for grips (only when no button is held, over the canvas).
  if (e.target !== canvas || e.buttons) return;
  const obj = gripAt(e);
  const g = obj ? obj.userData.grip : null;
  const same = (a, b) => (a && b ? a.i === b.i && a.path === b.path : a === b);
  if (same(g, hoverGrip)) return;
  hoverGrip = g;
  canvas.style.cursor = g ? 'grab' : '';
  canvas.title = g ? `${g.label}: drag to move (Shift for 0.1 mm)` : '';
  for (const o of grips) o.scale.setScalar(same(o.userData.grip, g) ? 1.3 : 1);
  requestRender();
});

const endDrag = (e) => {
  if (!drag || (e && e.pointerId !== drag.id)) return;
  drag = null;
  if (controls) controls.enabled = true;
  stage.classList.remove('dragging');
  tip.hidden = true;
  record(true);
};
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);

canvas.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4 || e.button !== 0) return;
  downAt = null;
  const p = hitModel(e);
  if (!p) {
    if (!state.pick && state.clickPoint) { state.clickPoint = state.clickPoint2 = null; updateOverlays(); updateReadout(); requestRender(); }
    return;
  }
  if (state.pick) { applyPick(p); return; }
  if (e.shiftKey && state.clickPoint) state.clickPoint2 = p;
  else { state.clickPoint = p; state.clickPoint2 = null; }
  updateOverlays();
  updateReadout();
  requestRender();
});
// Double-click the model to orbit around that point.
canvas.addEventListener('dblclick', (e) => {
  const p = hitModel(e);
  if (!p || !controls) return;
  controls.target.set(...p);
  controls.update();
  requestRender();
});

function setHeat(mode) {
  state.view.heat = mode;
  syncViewButtons();
  if (!state.result) return;
  state.moved = mode === 'moved' ? computeMoved() : null;
  updateMesh(state.result.mesh);
  updateReadout();
  requestRender();
}
function syncViewButtons() {
  $('#v-shaded').setAttribute('aria-pressed', String(state.view.heat === 'none'));
  $('#v-strain').setAttribute('aria-pressed', String(state.view.heat === 'strain'));
  $('#v-moved').setAttribute('aria-pressed', String(state.view.heat === 'moved'));
  $('#v-ghost').setAttribute('aria-pressed', String(state.view.ghost));
}
$('#v-shaded').addEventListener('click', () => setHeat('none'));
$('#v-strain').addEventListener('click', () => setHeat('strain'));
$('#v-moved').addEventListener('click', () => setHeat('moved'));
$('#v-ghost').addEventListener('click', () => {
  state.view.ghost = !state.view.ghost;
  syncViewButtons();
  updateGhost();
  requestRender();
});
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => frameView(b.dataset.view)));
$('#btn-help').addEventListener('click', () => {
  state.showIntro = !state.showIntro;
  renderPanel();
  if (state.showIntro) $('#panel').closest('.panel').scrollTo({ top: 0, behavior: 'smooth' });
});

/* ------------------------------------------------------------------ files */

let toastTimer = 0;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3800);
}

function setLoading(on, msg = 'Loading…') {
  const l = $('#loading');
  l.textContent = msg;
  l.hidden = !on;
}
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

async function openBuffer(name, buffer, recipe = null, { persist = true } = {}) {
  setLoading(true, `Loading ${name}…`);
  await nextFrame();
  const original = persist ? buffer.slice(0) : null;
  try {
    const mesh = await loadMesh(name, buffer);
    state.base = mesh;
    state.fileName = name;
    state.sourceFaces = mesh.indices.length / 3;
    state.cache = [];
    state.clickPoint = null;
    state.ops = recipe ? recipe.ops : [defaultOp('refine')];
    state.selected = -1;
    cancelPick(false);
    $('#filechip').textContent = `${name} · ${state.sourceFaces.toLocaleString()} faces`;
    resetHistory();
    renderPanel();
    runEval();
    frameView('iso');
    setLoading(false);
    if (original) idbPut('model', { name, buffer: original });
    return true;
  } catch (err) {
    console.error(err);
    setLoading(!state.base, 'Open an STL or 3MF file, or drop one here.');
    toast(`Couldn't open ${name}: ${err.message}`);
    return false;
  }
}

/* --------------------------------------------------------------- session */

// The open model and its steps stay in this browser (IndexedDB), so a reload
// picks up where you left off. Nothing is uploaded. Every call tolerates
// storage being blocked (private windows, strict settings): the app just
// starts fresh next time.
let dbPromise = null;
function idb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open('panelbeater', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('session');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch { resolve(null); }
    });
  }
  return dbPromise;
}
async function idbPut(key, value) {
  const db = await idb();
  if (!db) return;
  try {
    await new Promise((res, rej) => {
      const tx = db.transaction('session', 'readwrite');
      tx.objectStore('session').put(value, key);
      tx.oncomplete = res;
      tx.onerror = tx.onabort = () => rej(tx.error);
    });
  } catch (err) { console.warn('Panelbeater: could not save the session.', err); }
}
async function idbGet(key) {
  const db = await idb();
  if (!db) return null;
  try {
    return await new Promise((res, rej) => {
      const r = db.transaction('session', 'readonly').objectStore('session').get(key);
      r.onsuccess = () => res(r.result ?? null);
      r.onerror = () => rej(r.error);
    });
  } catch { return null; }
}

let saveTimer = 0;
function scheduleSave() {
  if (!state.base) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    idbPut('steps', { file: state.fileName, ops: JSON.parse(JSON.stringify(state.ops)), view: { ...state.view } });
  }, 600);
}

async function loadSample() {
  const btn = document.querySelector('.linkbtn[data-act="sample"]');
  const hasWork = state.base && state.fileName !== 'sample-pickup.stl' && state.ops.length > 1;
  if (hasWork && btn && btn.dataset.armed !== '1') {
    // Replacing someone's model can't be undone, so ask for a second click.
    btn.dataset.armed = '1';
    btn.textContent = 'This replaces your model. Click again to continue';
    setTimeout(() => { if (btn.isConnected) { btn.dataset.armed = ''; btn.textContent = 'Start over with the sample truck'; } }, 4000);
    return;
  }
  try {
    const [stl, recipe] = await Promise.all([
      fetch('examples/sample-pickup.stl').then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); }),
      fetch('examples/sample-pickup.recipe.json').then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }),
    ]);
    state.view.ghost = true;
    syncViewButtons();
    await openBuffer('sample-pickup.stl', stl, readRecipe(recipe));
  } catch {
    setLoading(!state.base, 'Open an STL or 3MF file, or drop one here.');
  }
}

function stem() {
  return (state.fileName || 'model').replace(/\.[^.]+$/, '');
}

let downloadsPromise = null;
function downloadsCap() {
  if (!downloadsPromise) {
    downloadsPromise = window.claude && typeof window.claude.use === 'function'
      ? window.claude.use('downloads').catch(() => null)
      : Promise.resolve(null);
  }
  return downloadsPromise;
}

// Inside a claude.ai artifact the page can only offer files through the
// downloads capability, which takes .zip/.json but not .stl, so the STL travels
// in a zip there. Everywhere else it is a normal browser download.
async function saveFile(name, data, mime, extras = []) {
  const dl = await downloadsCap();
  if (dl) {
    let filename = name, payload = data;
    if (!/\.(json|txt|md|csv|zip)$/i.test(name)) {
      payload = zipStore([{ name, data }, ...extras]);
      filename = name.replace(/\.[^.]+$/, '') + '.zip';
    }
    try {
      await dl.save({ filename, data: payload });
      toast(`Saved ${filename}`);
    } catch (e) {
      if (e && e.code === 'declined') return;
      toast(e && e.code === 'unavailable' ? 'Saving files is not available in this view.' : `Couldn't save: ${(e && e.message) || e}`);
    }
    return;
  }
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function currentRecipe() {
  return makeRecipe(state.ops, { name: state.fileName, faces: state.sourceFaces });
}

// Read the file before clearing the input: Safari can drop the File once value is reset.
// Clearing afterwards lets you pick the same file again.
$('#file-model').addEventListener('change', async (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  let buf;
  try { buf = await f.arrayBuffer(); } catch (err) { toast(`Couldn't read ${f.name}: ${err.message}`); return; } finally { e.target.value = ''; }
  openBuffer(f.name, buf);
});
$('#file-recipe').addEventListener('change', async (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  let text;
  try { text = await f.text(); } catch (err) { toast(`Couldn't read ${f.name}: ${err.message}`); return; } finally { e.target.value = ''; }
  applyRecipeText(text);
});

function applyRecipeText(text) {
  try {
    const r = readRecipe(JSON.parse(text));
    if (!state.base) { toast('Open the model this recipe is for, then load the recipe.'); return; }
    state.ops = r.ops;
    state.selected = -1;
    cancelPick(false);
    record(true);
    renderPanel();
    scheduleEval();
    const src = r.source;
    if (src && src.faces && src.faces !== state.sourceFaces) toast(`Recipe applied. It was made for ${src.name || 'another file'}, so check the numbers.`);
    else toast(`Recipe applied: ${r.ops.length} steps.`);
  } catch (err) {
    toast(`Couldn't read the recipe: ${err.message}`);
  }
}

$('#btn-recipe-save').addEventListener('click', () => {
  if (!state.base) return toast('Open a model first.');
  saveFile(`${stem()}.recipe.json`, JSON.stringify(currentRecipe(), null, 2), 'application/json');
});

$('#btn-export').addEventListener('click', async () => {
  if (!state.base) return toast('Open a model first.');
  setLoading(true, 'Building STL…');
  await nextFrame();
  const full = evaluate(state.base, state.ops, state.ops.length, state.cache);
  setLoading(false);
  const bad = full.notes.findIndex((n) => n && n.startsWith('Error'));
  if (bad >= 0) toast(`Step ${bad + 1} has an error and was skipped in the export.`);
  const recipe = JSON.stringify(currentRecipe(), null, 2);
  await saveFile(`${stem()}-panelbeater.stl`, toSTL(full.mesh), 'model/stl', [{ name: `${stem()}.recipe.json`, data: recipe }]);
});

// Drag and drop anywhere.
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; $('#drop').hidden = false; } });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#drop').hidden = true; });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop').hidden = true;
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  if (/\.json$/i.test(f.name)) applyRecipeText(await f.text());
  else openBuffer(f.name, await f.arrayBuffer());
});

/* ------------------------------------------------------------------- boot */

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
darkQuery.addEventListener?.('change', applyTheme);
new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
applyTheme();
renderPanel();
downloadsCap();

// Test hook for the browser checks: add ?debug to the URL.
if (new URLSearchParams(location.search).has('debug')) {
  window.panelbeater = {
    state,
    gripScreen(path) {
      const o = grips.find((g) => g.userData.grip.path === path);
      if (!o) return null;
      const v = o.getWorldPosition(o.position.clone()).project(camera);
      const r = canvas.getBoundingClientRect();
      return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
    },
  };
}

(async function boot() {
  try { state.showIntro = localStorage.getItem('pb.intro') !== 'seen'; } catch { state.showIntro = true; }
  renderPanel();
  // Pick up the last session if there is one; otherwise open the sample truck.
  const [model, steps] = await Promise.all([idbGet('model'), idbGet('steps')]);
  if (model && model.buffer && model.name) {
    let recipe = null;
    if (steps && steps.file === model.name && Array.isArray(steps.ops)) {
      try { recipe = readRecipe({ app: 'panelbeater', version: 1, ops: steps.ops }); } catch { recipe = null; }
      const v = steps.view || {};
      if (['none', 'strain', 'moved'].includes(v.heat)) state.view.heat = v.heat;
      state.view.ghost = !!v.ghost;
      syncViewButtons();
    }
    if (await openBuffer(model.name, model.buffer, recipe, { persist: false })) {
      toast(`Picked up where you left off: ${model.name}`);
      return;
    }
  }
  await loadSample();
})();
