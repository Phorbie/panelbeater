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
  view: { strain: false, ghost: false },
  pick: null,
  result: null,
  upTo: 0,
  check: null,
  clickPoint: null,
  regionOpen: new WeakMap(),
};

/* ================================================================ viewer */

const stage = $('#stage');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.autoClear = false;
stage.prepend(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 0.5, 5000);
camera.up.set(0, 0, 1);
camera.position.set(200, -260, 180);
scene.add(camera);
const controls = new OrbitControls(camera, renderer.domElement);
controls.addEventListener('change', requestRender);

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
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  requestRender();
}).observe(stage);

function frameView(name = 'iso') {
  if (!state.result) return;
  const bb = bbox(state.result.mesh);
  const dirs = { iso: [1.05, -1.45, 0.95], top: [0, -0.0001, 1], front: [0, -1, 0.0001], side: [1, 0, 0.0001] };
  const dir = new THREE.Vector3(...(dirs[name] || dirs.iso)).normalize();
  const center = new THREE.Vector3(...bb.center);
  const r = Math.max(Math.hypot(...bb.size) / 2, 5);
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const dist = (r / Math.sin(fov / 2)) * (camera.aspect < 1 ? 1.25 / camera.aspect : 1.02);
  camera.position.copy(center).addScaledVector(dir, dist);
  camera.near = dist / 200;
  camera.far = dist * 20;
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
  requestRender();
}

/* ------------------------------------------------------------- mesh draw */

function heatColor(s, out) {
  if (s <= 0.003) return out.copy(colors.primer);
  if (s <= 0.1) return out.copy(colors.primer).lerp(colors['heat-mid'], s / 0.1);
  if (s <= 0.3) return out.copy(colors['heat-mid']).lerp(colors['heat-hi'], (s - 0.1) / 0.2);
  return out.copy(colors['heat-hi']);
}

function geometryFor(mesh, heat) {
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
  if (heat) {
    const col = new Float32Array(nf * 9);
    const c = new THREE.Color();
    for (let f = 0; f < nf; f++) {
      heatColor(mesh.strain[f], c);
      for (let k = 0; k < 3; k++) { col[f * 9 + k * 3] = c.r; col[f * 9 + k * 3 + 1] = c.g; col[f * 9 + k * 3 + 2] = c.b; }
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }
  g.computeBoundingSphere();
  return g;
}

function updateMesh(mesh) {
  const key = { mesh, heat: state.view.strain };
  if (shownKey && shownKey.mesh === mesh && shownKey.heat === key.heat) return;
  shownKey = key;
  if (bodyMesh) { meshGroup.remove(bodyMesh); bodyMesh.geometry.dispose(); }
  bodyMesh = new THREE.Mesh(geometryFor(mesh, key.heat), key.heat ? heatMat : bodyMat);
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
function ghostMesh() {
  return evaluate(state.base, state.ops, ghostIndex(), state.cache).mesh;
}
function updateGhost(force) {
  if (!state.view.ghost || !state.base) { if (ghostGroup.children.length) disposeGroup(ghostGroup); ghostKey = null; return; }
  const m = ghostMesh();
  if (!force && ghostKey === m) return;
  ghostKey = m;
  disposeGroup(ghostGroup);
  const g = geometryFor(m, false);
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

function updateOverlays() {
  disposeGroup(overlay);
  const r = state.result;
  if (!r) return;
  const sel = state.selected;
  const op = sel >= 0 ? state.ops[sel] : null;
  const t = sel >= 0 ? r.trace[sel] : null;
  const bb = t ? t.bbox : bbox(r.mesh);
  const pins = t ? t.pins : r.pins;
  for (const p of pins) overlay.add(boxMesh(p.min, p.max, colors.tape, 0.18, 0.9));
  if (state.clickPoint) {
    const s = Math.max(...bb.size) * 0.006 + 0.35;
    const dot = new THREE.Mesh(new THREE.SphereGeometry(s, 16, 12), new THREE.MeshBasicMaterial({ color: colors.accent, depthTest: false }));
    dot.position.set(...state.clickPoint);
    dot.renderOrder = 7;
    overlay.add(dot);
  }
  if (!op || op.enabled === false) return;
  const m = Math.max(...bb.size) * 0.06 + 3;
  const big = Math.max(...bb.size);
  const alen = (amt) => Math.min(Math.max(Math.abs(amt) * 3, big * 0.06), big * 0.25);
  switch (op.type) {
    case 'pin': overlay.add(boxMesh(pinBox(op).min, pinBox(op).max, colors.tape, 0.35, 1)); break;
    case 'stretch':
    case 'taper': {
      const a = AXI[op.axis];
      if (a === undefined) break;
      const at = n0(op.at), band = Math.max(0, n0(op.band));
      overlay.add(quad(a, at, bb, m, colors.axes[a], 0.16));
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
      }
      const ro = regionOverlay(op.region, bb, m);
      if (ro) overlay.add(ro);
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
      break;
    }
    case 'mirror': {
      const a = AXI[op.axis];
      if (a === undefined) break;
      const at = n0(op.at);
      overlay.add(quad(a, at, bb, m, colors.axes[a], 0.2));
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

function runEval() {
  if (!state.base) return;
  const n = state.ops.length;
  let upTo = state.selected >= 0 ? state.selected + 1 : n;
  if (state.pick) upTo = state.pick.i; // pick against the model as this step sees it
  const r = evaluate(state.base, state.ops, upTo, state.cache);
  if (upTo < n && state.selected >= 0 && !r.trace[state.selected]) {
    // Picking: still need the selected step's input for overlays.
    const t = evaluate(state.base, state.ops, state.selected + 1, state.cache);
    r.trace = t.trace;
    r.notes = t.notes;
  }
  state.result = r;
  state.upTo = upTo;
  updateMesh(r.mesh);
  updateGhost();
  updateOverlays();
  updateNotes();
  updateReadout();
  scheduleCheck();
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

function updateNotes() {
  const notes = state.result ? state.result.notes : [];
  state.ops.forEach((op, i) => {
    const el = document.getElementById('note-' + i);
    if (!el) return;
    const note = op.enabled === false ? 'Turned off.' : notes[i] ?? '';
    el.textContent = note;
    el.classList.toggle('err', note.startsWith('Error'));
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
  if (state.view.strain) {
    let mx = 0;
    for (const s of r.mesh.strain) if (s > mx) mx = s;
    parts.push(`<span class="legend"><span>0</span><i></i><span>30%+</span><span class="num">max ${mx > 1 ? 'over 100' : Math.round(mx * 100)}%</span></span>`);
  }
  const n = state.ops.length;
  if (state.pick) parts.push(`<span>Showing the model before step ${state.pick.i + 1}</span>`);
  else if (state.upTo < n) parts.push(`<span>Showing steps 1–${state.upTo} of ${n}</span>`);
  if (state.clickPoint) parts.push(`<span class="num">Point ${AXN.map((a, k) => `<span class="ax-${a}">${a.toUpperCase()}</span> ${fmtN(state.clickPoint[k])}`).join(' ')}</span>`);
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
  const num = (key, label, o = {}) => `<div class="field"><label class="flabel" for="${id(key)}">${label}</label><span class="numwrap"><input id="${id(key)}" type="number" step="${o.step ?? 0.5}" ${o.min !== undefined ? `min="${o.min}"` : ''} value="${fmtIn(op[key])}" data-path="${key}" data-i="${i}"><span class="unit">mm</span>${o.pick ? pickBtn(i, o.pick, label) : '<span class="pick-spacer"></span>'}</span>${o.hint ? `<div class="fhint">${o.hint}</div>` : ''}</div>`;
  const vec = (key, label, pick) => `<div class="field"><span class="flabel">${label}</span><div class="vec">${[0, 1, 2]
    .map((k) => `<input class="ax-${AXN[k]}-line" id="${id(key + k)}" type="number" step="0.5" value="${fmtIn(op[key][k])}" data-path="${key}.${k}" data-i="${i}" aria-label="${label} ${AXN[k].toUpperCase()}" title="${AXN[k].toUpperCase()}">`)
    .join('')}${pick ? pickBtn(i, 'center', label) : '<span></span>'}</div></div>`;

  switch (op.type) {
    case 'rotate': return axisSeg('axis', 'About') + seg('turns', 'Turn', [[1, '90°'], [2, '180°'], [3, '270°']]);
    case 'refine': return num('maxEdge', 'Max edge', { min: 0.2, hint: 'Splits long triangles so blends have vertices to bend. Shape is unchanged.' });
    case 'pin': return vec('center', 'Centre', true) + vec('size', 'Size', false) + num('falloff', 'Blend', { hint: 'Everything in the box moves as one piece in later steps. Use it for body-post holes and mounts.' });
    case 'stretch': return axisSeg('axis', 'Axis')
      + num('at', 'Split plane at', { pick: 'at' })
      + num('amount', 'Amount', { hint: 'Total change in length. Negative shrinks.' })
      + seg('side', 'Moves', [['both', 'Both sides'], ['pos', '+ side'], ['neg', '− side']])
      + num('band', 'Blend band', { min: 0, hint: '0 slides the halves apart. Wider spreads the stretch over more of the shell.' })
      + regionHtml(op, i);
    case 'taper': return axisSeg('axis', 'Axis')
      + num('at', 'Split plane at', { pick: 'at' })
      + seg('side', 'Moves', [['both', 'Both sides'], ['pos', '+ side'], ['neg', '− side']])
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
      + seg('keep', 'Keep', [['pos', '+ side'], ['neg', '− side']])
      + '<div class="fhint">Cuts at the plane and reflects the kept half. Good for fixing a lopsided source model.</div>';
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
    + `<div class="field"><label class="flabel" for="op${i}-rfall">Blend</label><span class="numwrap"><input id="op${i}-rfall" type="number" step="1" min="0" value="${fmtIn(r.falloff)}" data-path="region.falloff" data-i="${i}"><span class="unit">mm</span><span class="pick-spacer"></span></span><div class="fhint">Leave a bound empty for no limit. The step fades out over the blend distance beyond the box.</div></div>`
    + '</div></details>';
}

function renderOp(op, i) {
  const sel = i === state.selected;
  const n = state.ops.length;
  return `<li class="op${sel ? ' sel' : ''}${op.enabled === false ? ' off' : ''}">
    <div class="op-head" data-act="select" data-i="${i}" role="button" tabindex="0" aria-expanded="${sel}">
      <span class="op-n">${i + 1}</span>
      <div class="op-title"><div class="op-name">${NAMES[op.type] || op.type}${op.type === 'pin' ? '<span class="tag">RIGID</span>' : ''}</div><div class="op-sum" id="sum-${i}">${esc(summary(op))}</div></div>
      <div class="op-tools">
        <button type="button" class="icon" data-act="up" data-i="${i}" aria-label="Move step up" ${i === 0 ? 'disabled' : ''}>${ICON.up}</button>
        <button type="button" class="icon" data-act="down" data-i="${i}" aria-label="Move step down" ${i === n - 1 ? 'disabled' : ''}>${ICON.down}</button>
        <button type="button" class="icon" data-act="toggle" data-i="${i}" aria-label="${op.enabled === false ? 'Turn step on' : 'Turn step off'}" title="${op.enabled === false ? 'Turn on' : 'Turn off'}">${op.enabled === false ? ICON.off : ICON.on}</button>
        <button type="button" class="icon" data-act="del" data-i="${i}" aria-label="Delete step" title="Delete">${ICON.del}</button>
      </div>
    </div>
    <div class="op-note" id="note-${i}"></div>
    ${sel ? `<div class="op-body">${fieldsFor(op, i)}</div>` : ''}
  </li>`;
}

function orientationNotice() {
  if (!state.base || state.ops.some((o) => o.type === 'rotate')) return '';
  const s = bbox(state.base).size;
  if (s[2] <= Math.max(s[0], s[1]) * 1.15) return '';
  return `<div class="notice"><span>This model is taller than it is long, so it may be stood on end for printing. Lay it down so Y runs nose to tail?</span><button type="button" class="btn" data-act="layflat">Add Rotate X 90°</button></div>`;
}

function renderPanel() {
  const add = (t, label) => `<button type="button" class="add" data-add="${t}">+ ${label}</button>`;
  const ops = state.ops;
  $('#panel').innerHTML = `
    <div class="addbar">
      <h2 class="sec-title">Add a step</h2>
      <div class="addrow"><span class="lbl">Set up</span>${add('rotate', 'Rotate')}${add('refine', 'Refine')}${add('pin', 'Pin')}</div>
      <div class="addrow"><span class="lbl">Shape</span>${add('stretch', 'Stretch')}${add('taper', 'Taper')}${add('move', 'Move')}${add('mirror', 'Mirror')}</div>
    </div>
    ${orientationNotice()}
    <section>
      <h2 class="sec-title steps-title">Steps <span class="num">${ops.length}</span></h2>
      ${ops.length ? `<ol class="ops">${ops.map(renderOp).join('')}</ol>` : '<p class="hint">No steps yet. Each step applies to the whole model unless you limit it to a region.</p>'}
    </section>
    <div class="foot">
      <span>Millimetres. X and Y are centred on the model and it sits on Z&nbsp;=&nbsp;0. New steps go after the selected one.</span>
      <span>Drag to orbit, right-drag to pan, scroll to zoom. Click the model to read a point. <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>Z</kbd> undoes, <kbd>Esc</kbd> deselects.</span>
    </div>`;
  updateNotes();
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
  const s = document.getElementById('sum-' + i);
  if (s) s.textContent = summary(op);
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
    ops.splice(i, 1);
    if (state.selected >= ops.length) state.selected = ops.length - 1;
    if (state.selected === i) state.selected = -1;
    else if (state.selected > i) state.selected--;
    cancelPick(false);
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
  if (!t.matches('input[data-path]')) return;
  const i = +t.dataset.i;
  if (!setPath(state.ops[i], t.dataset.path, t.value)) return;
  refreshCardText(i);
  record();
  scheduleEval();
});
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
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (e.key === 'Escape') {
    if (state.pick) cancelPick();
    else if (state.selected >= 0 && !e.target.matches('input')) { state.selected = -1; renderPanel(); scheduleEval(); }
  }
});

/* ------------------------------------------------------------ viewport io */

const raycaster = new THREE.Raycaster();
let downAt = null;
renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4 || e.button !== 0) return;
  downAt = null;
  if (!bodyMesh) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObject(bodyMesh, false)[0];
  if (!hit) {
    if (!state.pick && state.clickPoint) { state.clickPoint = null; updateOverlays(); updateReadout(); requestRender(); }
    return;
  }
  const p = [hit.point.x, hit.point.y, hit.point.z];
  if (state.pick) applyPick(p);
  else { state.clickPoint = p; updateOverlays(); updateReadout(); requestRender(); }
});

function toggleView(key, el) {
  state.view[key] = !state.view[key];
  el.setAttribute('aria-pressed', String(state.view[key]));
  syncViewButtons();
  if (state.result) { updateMesh(state.result.mesh); updateGhost(); updateReadout(); requestRender(); }
}
function syncViewButtons() {
  $('#v-shaded').setAttribute('aria-pressed', String(!state.view.strain));
  $('#v-strain').setAttribute('aria-pressed', String(state.view.strain));
  $('#v-ghost').setAttribute('aria-pressed', String(state.view.ghost));
}
$('#v-shaded').addEventListener('click', () => { if (state.view.strain) toggleView('strain', $('#v-strain')); });
$('#v-strain').addEventListener('click', (e) => { if (!state.view.strain) toggleView('strain', e.currentTarget); });
$('#v-ghost').addEventListener('click', (e) => toggleView('ghost', e.currentTarget));
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => frameView(b.dataset.view)));

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

async function openBuffer(name, buffer, recipe = null) {
  setLoading(true, `Loading ${name}…`);
  await nextFrame();
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
  } catch (err) {
    console.error(err);
    setLoading(!state.base, 'Open an STL or 3MF file, or drop one here.');
    toast(`Couldn't open ${name}: ${err.message}`);
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

$('#btn-open').addEventListener('click', () => $('#file-model').click());
$('#btn-recipe-load').addEventListener('click', () => $('#file-recipe').click());
$('#file-model').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) openBuffer(f.name, await f.arrayBuffer());
});
$('#file-recipe').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) applyRecipeText(await f.text());
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

(async function boot() {
  try {
    const [stl, recipe] = await Promise.all([
      fetch('examples/sample-pickup.stl').then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); }),
      fetch('examples/sample-pickup.recipe.json').then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }),
    ]);
    state.view.ghost = true;
    syncViewButtons();
    await openBuffer('sample-pickup.stl', stl, readRecipe(recipe));
  } catch {
    setLoading(true, 'Open an STL or 3MF file, or drop one here.');
  }
})();
