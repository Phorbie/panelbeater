// Panelbeater UI: three.js viewer, model setup, rigid zones and the step list.
// Geometry lives in core.js.
import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
import {
  loadMesh, orient, turnOrientation, validOrientation, isIdentityOrientation, IDENTITY_ORIENTATION,
  evaluate, defaultOp, defaultPivot, toolFrame, frameExtent, bbox, checkMesh, toSTL,
  makeRecipe, readRecipe, zipStore, makeZone, zoneBox, zoneHolds,
} from './core.js';

const $ = (s) => document.querySelector(s);
const AXN = ['x', 'y', 'z'];
const AXI = { x: 0, y: 1, z: 2 };
const OTHER = [[1, 2], [0, 2], [0, 1]];
const NAMES = { stretch: 'Stretch', taper: 'Taper', move: 'Move', mirror: 'Mirror' };
const OPS_HELP = {
  stretch: 'Makes the box’s length grow. Whatever is beyond the box slides along with it; choose which end stays still. Limit the box’s other sides to stretch only part of the body.',
  taper: 'A stretch whose amount changes across the box, so one end can widen while the other stays put. Good for a trapezoid bed.',
  move: 'Pushes everything inside the box along the axis. The soft edge sets how gently it fades into the rest.',
  mirror: 'Cuts at a plane, discards one side and replaces it with a reflection of the other.',
};

const state = {
  fileName: '',
  raw: null,         // the loaded file, centred
  base: null,        // raw turned to the chosen orientation
  sourceFaces: 0,
  orientation: IDENTITY_ORIENTATION.map((r) => [...r]),
  zones: [],
  ops: [],
  selected: -1,      // selected step index
  selectedZone: null, // selected zone id
  cache: [],
  view: { heat: 'none', ghost: false }, // heat: 'none' | 'strain' | 'moved'
  pick: null,        // { i, target } for a step, or { zone, target } for a zone
  result: null,      // what's drawn
  info: null,        // notes + trace through the selected step
  full: null,        // notes + trace for every step (filled in when idle)
  moved: null,       // per-face movement for the Moved view
  upTo: 0,
  check: null,
  clickPoint: null,
  clickPoint2: null, // shift-click: second point for measuring
  open: new WeakMap(), // which <details> are open, per step
  showIntro: false,
};
const plan = () => ({ zones: state.zones, ops: state.ops });

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

// How far each face moved: in the selected step, or in all steps.
function computeMoved() {
  const r = state.result;
  if (!r || state.pick || state.selectedZone) return { faces: new Float32Array(0), max: 0, why: 'Select a step, or nothing, to see movement' };
  const mesh = r.mesh, nf = mesh.indices.length / 3;
  const sel = state.selected;
  let perVertex;
  if (sel >= 0) {
    const op = state.ops[sel];
    const note = state.info?.notes[sel] || '';
    if (op.type === 'mirror' || op.enabled === false || note.startsWith('Error') || !mesh.lastMove) {
      return { faces: new Float32Array(nf), max: 0, why: 'This step doesn’t move anything' };
    }
    perVertex = mesh.lastMove;
  } else {
    if (!mesh.disp) return { faces: new Float32Array(nf), max: 0, why: 'Nothing has moved yet' };
    const D = mesh.disp, nv = D.length / 3;
    perVertex = new Float32Array(nv);
    for (let v = 0; v < nv; v++) perVertex[v] = Math.hypot(D[3 * v], D[3 * v + 1], D[3 * v + 2]);
  }
  const I = mesh.indices, faces = new Float32Array(nf);
  let max = 0;
  for (let f = 0; f < nf; f++) {
    const m = Math.max(perVertex[I[3 * f]], perVertex[I[3 * f + 1]], perVertex[I[3 * f + 2]]);
    faces[f] = m;
    if (m > max) max = m;
  }
  return { faces, max, why: max > 1e-4 ? '' : 'Nothing has moved yet' };
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

// The Before outline: the selected step's input (what this one step changed),
// or with nothing selected, the starting shape.
let ghostKey = null;
function outlineMesh() {
  if (state.selected >= 0 && !state.pick) return evaluate(state.base, plan(), state.selected, state.cache).mesh;
  return state.base;
}
function updateGhost(force) {
  if (!state.view.ghost || !state.base || state.selectedZone) { if (ghostGroup.children.length) disposeGroup(ghostGroup); ghostKey = null; return; }
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
const isSet = (v) => v !== null && v !== '' && v !== undefined && Number.isFinite(+v);
const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);

// A box given in a tool frame (lo/hi per frame axis), drawn in the world.
function frameBox(F, lo, hi, color, fillOpacity, lineOpacity) {
  const size = [0, 1, 2].map((k) => Math.max(hi[k] - lo[k], 0.01));
  const g = new THREE.BoxGeometry(...size);
  const grp = new THREE.Group();
  grp.position.copy(v3(F.toWorld([0, 1, 2].map((k) => (lo[k] + hi[k]) / 2))));
  if (F.tilted) grp.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(v3(F.axisDir(0)), v3(F.axisDir(1)), v3(F.axisDir(2))));
  if (fillOpacity > 0) grp.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: fillOpacity, depthWrite: false, side: THREE.DoubleSide })));
  grp.add(new THREE.LineSegments(new THREE.EdgesGeometry(g), new THREE.LineBasicMaterial({ color, transparent: true, opacity: lineOpacity, depthTest: lineOpacity < 0.5 })));
  return grp;
}
const WORLD = { tilted: false, toWorld: (f) => [...f], axisDir: (k) => [0, 1, 2].map((i) => (i === k ? 1 : 0)) };

function arrow(origin, dirv, len, color) {
  const h = Math.min(len * 0.4, 6);
  const ar = new THREE.ArrowHelper(v3(dirv).normalize(), v3(origin), len, color, h, h * 0.6);
  ar.traverse((o) => { if (o.material) { o.material.depthTest = false; o.material.transparent = true; } });
  ar.renderOrder = 6;
  return ar;
}

function dot(p, size, color) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(size, 16, 12), new THREE.MeshBasicMaterial({ color, depthTest: false }));
  m.position.set(...p);
  m.renderOrder = 7;
  return m;
}

// Drag grips: spheres drawn on top of everything; dragging one moves its value along `dir`.
let grips = [];
let hoverGrip = null;
const sameGrip = (a, b) => (a && b ? a.key === b.key : a === b);
function addGrip(pos, color, size, g) {
  const grp = new THREE.Group();
  grp.position.set(...pos);
  // Opaque on purpose: transparent materials draw after opaque ones and would cover the ball.
  const halo = new THREE.Mesh(new THREE.SphereGeometry(size * 1.45, 20, 14),
    new THREE.MeshBasicMaterial({ color: colors.stage, depthTest: false, side: THREE.BackSide }));
  halo.renderOrder = 8;
  const ball = new THREE.Mesh(new THREE.SphereGeometry(size, 20, 14), new THREE.MeshBasicMaterial({ color, depthTest: false }));
  ball.renderOrder = 9;
  // A short stroke along the drag direction shows which way the grip moves.
  const d = g.dir;
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.Float32BufferAttribute([-d[0], -d[1], -d[2], d[0], d[1], d[2]].map((x) => x * size * 3.2), 3));
  const stroke = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color, depthTest: false }));
  stroke.renderOrder = 9;
  grp.add(halo, stroke, ball);
  ball.userData.grip = g;
  if (sameGrip(hoverGrip, g)) ball.scale.setScalar(1.3);
  grips.push(ball);
  overlay.add(grp);
}

function stepOverlay(op, i, bb) {
  const big = Math.max(...bb.size);
  const m = big * 0.06 + 3;
  const gs = big * 0.012 + 0.7;
  const showGrips = !state.pick;
  const alen = (amt) => Math.min(Math.max(Math.abs(amt) * 3, big * 0.06), big * 0.25);
  let F;
  try { F = toolFrame(op, bb); } catch { return; }
  const a = F.a;
  const ext = frameExtent(bb, F);
  const bmin = op.box ? op.box.min : [null, null, null], bmax = op.box ? op.box.max : [null, null, null];
  const lo = [0, 1, 2].map((k) => (isSet(bmin[k]) ? +bmin[k] : ext.min[k] - m));
  const hi = [0, 1, 2].map((k) => (isSet(bmax[k]) ? +bmax[k] : ext.max[k] + m));
  const mid = [0, 1, 2].map((k) => {
    const l = Math.max(lo[k], ext.min[k]), h = Math.min(hi[k], ext.max[k]);
    return l <= h ? (l + h) / 2 : (lo[k] + hi[k]) / 2;
  });
  const grip = (k, side, color, size, label) => {
    const v = side === 'min' ? bmin[k] : bmax[k];
    if (!isSet(v)) return;
    const f = [...mid]; f[k] = +v;
    addGrip(F.toWorld(f), color, size, { key: `${i}:box.${side}.${k}`, i, path: `box.${side}.${k}`, dir: F.axisDir(k), label });
  };
  const soft = Math.max(1, n0(op.soft, 10));
  const softOutline = (axes) => {
    if (!axes.some((k) => isSet(bmin[k]) || isSet(bmax[k]))) return;
    const sl = [...lo], sh = [...hi];
    for (const k of axes) { if (isSet(bmin[k])) sl[k] -= soft; if (isSet(bmax[k])) sh[k] += soft; }
    overlay.add(frameBox(F, sl, sh, colors.ink, 0, 0.2));
  };
  const lab = (k) => `${AX(AXN[k])}${F.tilted ? '′' : ''}`;

  if (op.type === 'mirror') {
    const at = n0(op.at);
    const pl = [...ext.min.map((v) => v - m)], ph = [...ext.max.map((v) => v + m)];
    pl[a] = at - 0.02; ph[a] = at + 0.02;
    overlay.add(frameBox(F, pl, ph, colors.axes[a], 0.2, 0.7));
    const dl = [...ext.min.map((v) => v - m)], dh = [...ext.max.map((v) => v + m)];
    if (op.side === 'neg') dl[a] = at; else dh[a] = at;
    if (dh[a] > dl[a]) overlay.add(frameBox(F, dl, dh, colors.bad, 0.07, 0.15));
    if (showGrips) {
      const up = a !== 2 ? 2 : 1;
      const f = [...bb.center]; f[a] = at; f[up] = ext.max[up] + m * 0.6;
      addGrip(F.toWorld(f), colors.axes[a], gs, { key: `${i}:at`, i, path: 'at', dir: F.dir, label: `Mirror plane ${lab(a)}` });
    }
    return;
  }

  if (op.type === 'move') {
    const any = [0, 1, 2].some((k) => isSet(bmin[k]) || isSet(bmax[k]));
    overlay.add(frameBox(F, lo, hi, colors.accent, any ? 0.1 : 0.04, 0.8));
    softOutline([0, 1, 2]);
    const amt = n0(op.amount);
    if (amt) overlay.add(arrow(F.toWorld(mid), F.dir.map((x) => x * Math.sign(amt)), alen(amt), colors.accent));
    if (showGrips) for (let k = 0; k < 3; k++) for (const s of ['min', 'max']) grip(k, s, colors.ink, gs * 0.8, `Box ${lab(k)} ${s === 'min' ? 'from' : 'to'}`);
    return;
  }

  // stretch / taper
  const [v, w] = [F.v, F.w];
  const z0 = Math.min(lo[a], hi[a]), z1 = Math.max(lo[a], hi[a]);
  // The stretch zone: the box itself.
  overlay.add(frameBox(F, lo, hi, colors.axes[a], 0.14, 0.9));
  // The part that slides: the limits carried the length of the model.
  if ([v, w].some((k) => isSet(bmin[k]) || isSet(bmax[k]))) {
    const tl = [...lo], th = [...hi];
    tl[a] = ext.min[a] - m; th[a] = ext.max[a] + m;
    overlay.add(frameBox(F, tl, th, colors.ink, 0, 0.35));
    softOutline([v, w]);
  }
  const keep = op.keep === 'start' || op.keep === 'end' ? op.keep : 'middle';
  const amounts = op.type === 'stretch' ? [[n0(op.amount), null]] : [[n0(op.amountStart), 'min'], [n0(op.amountEnd), 'max']];
  const vary = op.type === 'taper' ? AXI[op.vary] : undefined;
  for (const [amt, end] of amounts) {
    if (!amt) continue;
    const o = [...mid];
    if (end && vary !== undefined) o[vary] = end === 'min' ? Math.max(lo[vary], ext.min[vary]) : Math.min(hi[vary], ext.max[vary]);
    const len = alen(amt), g = Math.sign(amt), gap = 1.5;
    if (keep !== 'end') { const p = [...o]; p[a] = z1 + gap; overlay.add(arrow(F.toWorld(p), F.dir.map((x) => x * g), len, colors.accent)); }
    if (keep !== 'start') { const p = [...o]; p[a] = z0 - gap; overlay.add(arrow(F.toWorld(p), F.dir.map((x) => -x * g), len, colors.accent)); }
  }
  if (showGrips) {
    grip(a, 'min', colors.axes[a], gs, `Stretch zone ${lab(a)} start`);
    grip(a, 'max', colors.axes[a], gs, `Stretch zone ${lab(a)} end`);
    for (const k of [v, w]) for (const s of ['min', 'max']) grip(k, s, colors.ink, gs * 0.8, `Limit ${lab(k)} ${s === 'min' ? 'from' : 'to'}`);
  }
}

function zoneOverlay(zones, bb, highlightId) {
  const big = Math.max(...bb.size);
  const gs = big * 0.01 + 0.6;
  for (const z of zones) {
    const hot = z.id === highlightId;
    overlay.add(frameBox(WORLD, z.min, z.max, colors.tape, hot ? 0.35 : 0.18, hot ? 1 : 0.85));
    if (hot && !state.pick) {
      const c = [0, 1, 2].map((k) => (z.min[k] + z.max[k]) / 2);
      for (let k = 0; k < 3; k++) for (const s of ['min', 'max']) {
        const p = [...c]; p[k] = z[s][k];
        addGrip(p, colors.tape, gs, { key: `zone:${z.id}:${s}.${k}`, zone: z.id, side: s, k, dir: WORLD.axisDir(k), label: `Zone ${s === 'min' ? '−' : '+'}${AX(AXN[k])} face` });
      }
    }
  }
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
  const big = Math.max(...bb.size);
  if (state.selectedZone) {
    zoneOverlay(state.zones.map(zoneBox), bbox(state.base), state.selectedZone);
  } else {
    zoneOverlay(t ? t.zones : r.zones, bb, null);
  }
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
  if (op && op.enabled !== false) stepOverlay(op, sel, bb);
}

/* ============================================================ evaluation */

let evalQueued = false;
function scheduleEval() {
  if (evalQueued) return;
  evalQueued = true;
  requestAnimationFrame(() => { evalQueued = false; runEval(); });
}

const opsKey = () => JSON.stringify([state.zones, state.ops]);
const infoFrom = (r) => ({ notes: r.notes, trace: r.trace, out: bbox(r.mesh), n: r.notes.length, key: opsKey() });

let fullTimer = 0;
function runEval() {
  if (!state.base) return;
  const n = state.ops.length;
  const through = state.selectedZone ? 0 : state.selected >= 0 ? state.selected + 1 : n;
  // While picking for a step, draw the model as that step sees it (its input).
  const upTo = state.pick && state.pick.i !== undefined ? state.pick.i : through;
  const r = evaluate(state.base, plan(), upTo, state.cache);
  const info = upTo === through ? r : evaluate(state.base, plan(), through, state.cache);
  state.result = r;
  state.info = infoFrom(info);
  state.upTo = upTo;
  clearTimeout(fullTimer);
  if (through === n) state.full = state.info;
  else {
    // Notes for the steps after the selected one, computed once editing pauses.
    fullTimer = setTimeout(() => {
      if (!state.base) return;
      state.full = infoFrom(evaluate(state.base, plan(), state.ops.length, state.cache));
      updateNotes();
    }, 300);
  }
  state.moved = state.view.heat === 'moved' ? computeMoved() : null;
  updateMesh(r.mesh);
  updateGhost();
  updateOverlays();
  updateNotes();
  updateZoneNotes();
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

const fmtN = (v) => {
  const r = Math.round(v * 10) / 10;
  return (Object.is(r, -0) ? 0 : r).toFixed(1);
};
const signed = (v) => (v > 0 ? '+' : v < 0 ? '−' : '±') + fmtN(Math.abs(v));

// What each step reports: its own note (warnings) and how it changed the outer size.
function noteFor(i) {
  const op = state.ops[i];
  if (op.enabled === false) return { text: 'Turned off.', size: '', warn: false };
  const key = opsKey();
  const src = state.info && i < state.info.n ? state.info : state.full && state.full.key === key && i < state.full.n ? state.full : null;
  if (!src) return { text: '', size: '', warn: false };
  const text = src.notes[i] || '';
  const warn = /^Error|Nothing moved/.test(text);
  let size = '';
  if (op.type !== 'mirror' && !text.startsWith('Error')) {
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

function updateZoneNotes() {
  if (!state.base) return;
  for (const z of state.zones) {
    const el = document.getElementById('znote-' + z.id);
    if (!el) continue;
    const n = zoneHolds(state.base, z);
    el.textContent = n ? `Holds ${n.toLocaleString()} points` : "Doesn't touch the model, so it holds nothing";
    el.classList.toggle('err', !n);
  }
}

function updateReadout() {
  const el = $('#readout');
  const r = state.result;
  if (!r) { el.innerHTML = ''; return; }
  const bb = bbox(r.mesh);
  const ref = bbox(state.base);
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
    if (!mv || mv.why) parts.push(`<span>${mv ? mv.why : ''}</span>`);
    else parts.push(`<span class="legend moved"><span>0</span><i></i><span class="num">${fmtN(mv.max)} mm</span><span>${state.selected >= 0 ? `step ${state.selected + 1}` : 'all steps'}</span></span>`);
  }
  const n = state.ops.length;
  if (state.selectedZone) parts.push('<span>Showing the starting shape</span>');
  else if (state.pick && state.pick.i !== undefined) parts.push(`<span>Showing the model before step ${state.pick.i + 1}</span>`);
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
const r1 = (v) => Math.round(v * 10) / 10;
const isTilted = (op) => !!op.tilt && (Math.abs(n0(op.tilt[0])) > 1e-9 || Math.abs(n0(op.tilt[1])) > 1e-9);

function limitText(op, axes) {
  const parts = [];
  for (const k of axes) {
    const lo = op.box.min[k], hi = op.box.max[k];
    const L = AX(AXN[k]);
    if (isSet(lo) && isSet(hi)) parts.push(`${L} ${shortN(lo)}…${shortN(hi)}`);
    else if (isSet(lo)) parts.push(`${L} ≥ ${shortN(lo)}`);
    else if (isSet(hi)) parts.push(`${L} ≤ ${shortN(hi)}`);
  }
  return parts.length ? `${parts.join(', ')} · soft ${shortN(op.soft)}` : 'whole model';
}
const KEEP = { start: 'start still', middle: 'middle still', end: 'end still' };

function summary(op) {
  const tilt = isTilted(op) ? ` · tilt ${shortN(op.tilt[0])}°/${shortN(op.tilt[1])}°` : '';
  const a = AXI[op.axis];
  const others = a === undefined ? [] : OTHER[a];
  switch (op.type) {
    case 'stretch': {
      const lim = limitText(op, others);
      return `${AX(op.axis)} ${sgnS(op.amount)} mm · zone ${shortN(op.box.min[a])}…${shortN(op.box.max[a])} · ${KEEP[op.keep] || KEEP.middle}${lim === 'whole model' ? '' : ' · limited'}${tilt}`;
    }
    case 'taper': return `${AX(op.axis)} ${sgnS(op.amountStart)} → ${sgnS(op.amountEnd)} mm across ${AX(op.vary)} · zone ${shortN(op.box.min[a])}…${shortN(op.box.max[a])}${tilt}`;
    case 'move': return `${AX(op.axis)} ${sgnS(op.amount)} mm · ${limitText(op, [0, 1, 2]) === 'whole model' ? 'whole model' : 'in box'}${tilt}`;
    case 'mirror': return `keep ${op.side === 'neg' ? '−' : '+'}${AX(op.axis)} of ${shortN(op.at)}${tilt}`;
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
  turn: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12.5 8a4.5 4.5 0 1 1-1.3-3.2"/><path d="M12 2.5v2.8H9.2"/></svg>',
};

// owner: { i } for a step or { zone } for a zone
function pickBtn(owner, target, label) {
  const p = state.pick;
  const on = p && p.target === target && (owner.zone ? p.zone === owner.zone : p.i === owner.i);
  const data = owner.zone ? `data-zone-pick="${esc(owner.zone)}"` : `data-i="${owner.i}"`;
  return `<button type="button" class="pick" data-pick="${target}" ${data} aria-pressed="${!!on}" aria-label="Pick ${esc(label)} on the model" title="Pick on the model">${ICON.pick}</button>`;
}

function numField(id, label, value, data, o = {}) {
  return `<div class="field"><label class="flabel scrub" for="${id}" title="Drag sideways to adjust">${label}</label><span class="numwrap"><input id="${id}" type="number" step="${o.step ?? 0.5}" ${o.min !== undefined ? `min="${o.min}"` : ''} value="${fmtIn(value)}" ${data}><span class="unit">${o.unit ?? 'mm'}</span>${o.pick || '<span class="pick-spacer"></span>'}</span>${o.hint ? `<div class="fhint">${o.hint}</div>` : ''}</div>`;
}

function fieldsFor(op, i) {
  const id = (k) => `op${i}-${k}`;
  const dataI = `data-i="${i}"`;
  const a = AXI[op.axis];
  const tiltMark = isTilted(op) ? '′' : '';
  const L = (k) => `${AX(AXN[k])}${tiltMark}`;
  const seg = (key, label, opts, hint) => `<div class="field"><span class="flabel">${label}</span><div class="seg" role="group" aria-label="${label}">${opts
    .map(([v, t, cls = '']) => `<button type="button" class="${cls}" data-set="${key}" data-val="${v}" ${dataI} aria-pressed="${op[key] === v}">${t}</button>`)
    .join('')}</div>${hint ? `<div class="fhint">${hint}</div>` : ''}</div>`;
  const axisSeg = (key, label, choices = AXN) => seg(key, label, choices.map((x) => [x, x.toUpperCase(), `axbtn ax-${x}`]));
  const num = (key, label, o = {}) => numField(id(key), label, op[key], `data-path="${key}" ${dataI}`, { ...o, pick: o.pick ? pickBtn({ i }, o.pick, label) : '' });
  const boundRow = (k, label) => `<div class="rrow"><span class="ax ax-${AXN[k]}">${label}</span>`
    + `<input id="op${i}-bmin${k}" type="number" step="0.5" placeholder="no limit" value="${fmtIn(op.box.min[k])}" data-path="box.min.${k}" ${dataI} aria-label="${label} from">`
    + pickBtn({ i }, `box.min.${k}`, `${label} from`)
    + '<span class="to">to</span>'
    + `<input id="op${i}-bmax${k}" type="number" step="0.5" placeholder="no limit" value="${fmtIn(op.box.max[k])}" data-path="box.max.${k}" ${dataI} aria-label="${label} to">`
    + pickBtn({ i }, `box.max.${k}`, `${label} to`) + '</div>';
  const soft = () => numField(id('soft'), 'Soft edge', op.soft, `data-path="soft" ${dataI}`, { step: 1, min: 1, hint: 'How far past a limit the step fades out.' });
  const details = (key, title, sumText, body, openByDefault = false) => {
    const open = state.open.get(op)?.[key] ?? openByDefault;
    return `<details class="region" data-details="${key}" ${dataI} ${open ? 'open' : ''}><summary>${title} <span class="num" id="${id(key + '-sum')}">${esc(sumText)}</span></summary><div class="rbody">${body}</div></details>`;
  };
  const tilt = () => {
    if (a === undefined) return '';
    const [v, w] = OTHER[a];
    const sum = isTilted(op) ? `${shortN(op.tilt[0])}° / ${shortN(op.tilt[1])}°` : 'none';
    const body = numField(id('tilt0'), `About ${AX(AXN[v])}`, op.tilt[0], `data-path="tilt.0" ${dataI}`, { step: 1, unit: '°' })
      + numField(id('tilt1'), `About ${AX(AXN[w])}`, op.tilt[1], `data-path="tilt.1" ${dataI}`, { step: 1, unit: '°' })
      + `<div class="fhint">Turns the tool, not the model. The box turns about its centre; its numbers are then measured along the turned axes (marked ′).${isTilted(op) ? ' <button type="button" class="linkbtn" data-act="untilt" data-i="' + i + '">Reset tilt</button>' : ''}</div>`;
    return details('tilt', 'Tilt', sum, body, isTilted(op));
  };
  const rigid = () => {
    if (!state.zones.length) return `<div class="field"><span class="flabel">Keep rigid</span><div class="chks"><button type="button" class="linkbtn" data-act="zone-new" data-i="${i}">+ Add a rigid zone</button></div></div>`;
    const except = new Set(op.rigidExcept || []);
    return `<div class="field"><span class="flabel">Keep rigid</span><div class="chks">${state.zones
      .map((z) => `<label class="chk"><input type="checkbox" data-rigid="${esc(z.id)}" ${dataI} ${except.has(z.id) ? '' : 'checked'}> ${esc(z.name)}</label>`)
      .join('')}<button type="button" class="linkbtn" data-act="zone-new" data-i="${i}">+ Add a zone</button></div></div>`;
  };

  switch (op.type) {
    case 'stretch':
    case 'taper': {
      const [v, w] = OTHER[a];
      const zoneRow = `<div class="field"><span class="flabel">Stretch zone</span><div class="rrow solo">${boundRow(a, L(a)).replace(/^<div class="rrow">|<\/div>$/g, '')}</div><div class="fhint">The part of the body that gets longer. Pick a plain stretch of panel; details inside it stretch too.</div></div>`;
      let html = axisSeg('axis', 'Axis') + zoneRow;
      if (op.type === 'stretch') html += num('amount', 'Amount', { hint: 'How much longer the zone gets. Negative shrinks it.' });
      html += seg('keep', 'Keep still', [['start', 'Start'], ['middle', 'Middle'], ['end', 'End']], `Start is the −${L(a)} end of the zone.`);
      if (op.type === 'taper') {
        const vv = AXI[op.vary];
        html += axisSeg('vary', 'Varies along', [AXN[v], AXN[w]]);
        html += num('amountStart', `At −${vv !== undefined ? L(vv) : '?'} side`);
        html += num('amountEnd', `At +${vv !== undefined ? L(vv) : '?'} side`, { hint: `The amount ramps across the box along ${vv !== undefined ? L(vv) : '?'}. Set the limits for that axis to choose where the ramp starts and ends.` });
      }
      html += details('limit', 'Limit', limitText(op, [v, w]), boundRow(v, L(v)) + boundRow(w, L(w)) + soft() + '<div class="fhint">Leave a limit empty for no limit. Limits stretch only part of the body, such as the nose.</div>', limitText(op, [v, w]) !== 'whole model');
      return html + tilt() + rigid();
    }
    case 'move':
      return axisSeg('axis', 'Direction') + num('amount', 'Distance')
        + details('limit', 'Box', limitText(op, [0, 1, 2]), boundRow(0, L(0)) + boundRow(1, L(1)) + boundRow(2, L(2)) + soft() + '<div class="fhint">Everything inside the box moves. Leave a side empty for no limit.</div>', true)
        + tilt() + rigid();
    case 'mirror':
      return axisSeg('axis', 'Axis') + num('at', 'Mirror plane at', { pick: 'at' }) + seg('side', 'Keep', [['pos', `+${L(a)} side`], ['neg', `−${L(a)} side`]]) + tilt();
    default:
      return '';
  }
}

const stepTitle = (op) => (op.label && op.label.trim()) || NAMES[op.type] || op.type;

function renderOp(op, i) {
  const sel = i === state.selected;
  const n = state.ops.length;
  const named = !!(op.label && op.label.trim());
  return `<li class="op${sel ? ' sel' : ''}${op.enabled === false ? ' off' : ''}">
    <div class="op-head" data-act="select" data-i="${i}" role="button" tabindex="0" aria-expanded="${sel}" title="${sel ? 'Close this step' : 'Edit this step and show the model up to it'}">
      <span class="op-n">${i + 1}</span>
      <div class="op-title"><div class="op-name" id="title-${i}">${esc(stepTitle(op))}</div><div class="op-sum" id="sum-${i}">${named ? `<span class="op-type">${NAMES[op.type]}</span> · ` : ''}${esc(summary(op))}</div></div>
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

function renderZone(z) {
  const sel = z.id === state.selectedZone;
  const zid = esc(z.id);
  const data = `data-zone="${zid}"`;
  const vec = (key, label, pick) => `<div class="field"><span class="flabel">${label}</span><div class="vec">${[0, 1, 2]
    .map((k) => `<input class="ax-${AXN[k]}-line" id="zone-${zid}-${key}${k}" type="number" step="0.5" value="${fmtIn(z[key][k])}" data-zpath="${key}.${k}" ${data} aria-label="${label} ${AXN[k].toUpperCase()}" title="${AXN[k].toUpperCase()}">`)
    .join('')}${pick ? pickBtn({ zone: z.id }, 'center', label) : '<span></span>'}</div></div>`;
  return `<li class="op zone${sel ? ' sel' : ''}">
    <div class="op-head" data-act="zone-select" ${data} role="button" tabindex="0" aria-expanded="${sel}" title="${sel ? 'Close this zone' : 'Edit this zone on the starting shape'}">
      <span class="op-n"><i class="tapechip"></i></span>
      <div class="op-title"><div class="op-name" id="ztitle-${zid}">${esc(z.name)}</div><div class="op-sum">${z.size.map(shortN).join('×')} mm at (${z.center.map(shortN).join(', ')})</div></div>
      <div class="op-tools"><button type="button" class="icon" data-act="zone-del" ${data} aria-label="Delete zone" title="Delete">${ICON.del}</button></div>
    </div>
    <div class="op-note" id="znote-${zid}"></div>
    ${sel ? `<div class="op-body">
      <p class="op-help">Whatever is inside this box moves as one solid piece in every step, so holes and mounts keep their size and spacing. A step can let it bend under Keep rigid.</p>
      <div class="field"><label class="flabel" for="zone-${zid}-name">Name</label><input class="textin" id="zone-${zid}-name" type="text" maxlength="60" value="${esc(z.name)}" data-kind="zone-name" ${data}></div>
      ${vec('center', 'Centre', true)}${vec('size', 'Size', false)}
      ${numField(`zone-${zid}-blend`, 'Blend', z.blend, `data-zpath="blend" ${data}`, { step: 1, min: 1, hint: 'Distance around the box over which it eases into the surrounding stretch.' })}
    </div>` : ''}
  </li>`;
}

const upAxisText = () => {
  const M = validOrientation(state.orientation);
  const row = M[2];
  const k = row.findIndex((v) => v !== 0);
  return `File’s ${row[k] > 0 ? '+' : '−'}${AX(AXN[k])} is up`;
};

function modelHtml() {
  if (!state.base) return '';
  const s = bbox(state.base).size;
  const tall = s[2] > Math.max(s[0], s[1]) * 1.15;
  return `<section class="model">
    <h2 class="sec-title">Model</h2>
    <div class="field"><span class="flabel">Orientation</span><div class="turns">
      ${AXN.map((a) => `<button type="button" class="btn small" data-turn="${a}" title="Turn the model 90° about ${a.toUpperCase()}">${ICON.turn}${a.toUpperCase()}</button>`).join('')}
      <button type="button" class="linkbtn" data-act="orient-reset" ${isIdentityOrientation(state.orientation) ? 'hidden' : ''}>Reset</button>
    </div><div class="fhint">${isIdentityOrientation(state.orientation) ? 'As saved in the file.' : esc(upAxisText()) + '.'} Set this first: it decides which way Front, Top and the axes point.</div></div>
    ${tall ? `<div class="notice"><span>The model is taller than it is long, so it may be stood on end for printing. Lay it down so Y runs nose to tail?</span><button type="button" class="btn" data-turn="x">Lay it down</button></div>` : ''}
  </section>`;
}

// Top view of a body: the stretch zone grows and the ends slide out with it.
const INTRO_DIAGRAM = `<svg class="intro-fig" viewBox="0 0 320 96" role="img" aria-label="Diagram: a body seen from above. A box across the middle is the stretch zone; it grows and the two ends slide out with it.">
  <rect x="80" y="22" width="160" height="52" rx="16" fill="none" stroke="var(--muted)" stroke-dasharray="4 4"/>
  <path d="M150 22 H82 a16 16 0 0 0 -16 16 v20 a16 16 0 0 0 16 16 H150" transform="translate(-12 0)" fill="var(--primer)" fill-opacity=".55" stroke="var(--ink)" stroke-width="1.2"/>
  <path d="M170 22 H238 a16 16 0 0 1 16 16 v20 a16 16 0 0 1 -16 16 H170" transform="translate(12 0)" fill="var(--primer)" fill-opacity=".55" stroke="var(--ink)" stroke-width="1.2"/>
  <rect x="138" y="16" width="44" height="64" fill="var(--ax-x)" fill-opacity=".14" stroke="var(--ax-x)" stroke-width="1.4"/>
  <path d="M120 48 h-26 m6 -5 l-6 5 6 5 M200 48 h26 m-6 -5 l6 5 -6 5" fill="none" stroke="var(--accent)" stroke-width="2"/>
  <text x="160" y="11" font-size="10" fill="var(--muted)" text-anchor="middle">stretch zone grows</text>
  <text x="160" y="94" font-size="10" fill="var(--muted)" text-anchor="middle">the ends slide; their walls keep their shape</text>
  <text x="80" y="16" font-size="10" fill="var(--muted)">before</text>
</svg>`;

function introHtml() {
  if (!state.showIntro) return '';
  const sample = state.fileName === 'sample-pickup.stl';
  return `<section class="intro" aria-label="How Panelbeater works">
    <div class="intro-head"><h2 class="sec-title">How it works</h2><button type="button" class="icon" data-act="intro-close" aria-label="Close" title="Close">✕</button></div>
    ${INTRO_DIAGRAM}
    <ol class="intro-steps">
      <li><b>Open an STL or 3MF.</b> If it was saved stood on end, turn it under Model. Every number is in millimetres.</li>
      <li><b>Mark rigid zones</b> over post holes and mounts. Every step moves them as one solid piece.</li>
      <li><b>Add steps.</b> Each one works through a box: drag its grips or type numbers. Click a step to see the model up to it.</li>
      <li><b>Export STL</b> once the readout says Watertight.</li>
    </ol>
    <p class="hint">${sample ? 'This sample truck has two rigid zones and three named steps. Click through them to see what each one does.' : 'Your model and steps are saved in this browser, so a reload picks up where you left off.'}</p>
    <div class="intro-actions"><button type="button" class="btn" data-act="intro-close">Got it</button>${sample ? '' : '<button type="button" class="btn" data-act="sample">Open the sample truck</button>'}</div>
  </section>`;
}

function renderPanel() {
  const add = (t, label) => `<button type="button" class="add" data-add="${t}" title="${esc(OPS_HELP[t])}">+ ${label}</button>`;
  const ops = state.ops;
  $('#panel').innerHTML = `
    ${introHtml()}
    ${modelHtml()}
    <section>
      <div class="steps-head">
        <h2 class="sec-title">Rigid zones <span class="num">${state.zones.length}</span></h2>
        <button type="button" class="add" data-act="zone-new" ${state.base ? '' : 'disabled'} title="A box whose contents every step moves as one piece">+ Zone</button>
      </div>
      ${state.zones.length ? `<ol class="ops">${state.zones.map(renderZone).join('')}</ol>` : '<p class="hint">None yet. Put one over each pair of body-post holes, or anything else that must keep its size.</p>'}
    </section>
    <section>
      <div class="steps-head">
        <h2 class="sec-title">Steps <span class="num">${ops.length}</span></h2>
        <div class="hist">
          <button type="button" class="icon" id="btn-undo" data-act="undo" aria-label="Undo" title="Undo (Ctrl/⌘+Z)">${ICON.undo}</button>
          <button type="button" class="icon" id="btn-redo" data-act="redo" aria-label="Redo" title="Redo (Ctrl/⌘+Shift+Z)">${ICON.redo}</button>
        </div>
      </div>
      <div class="addrow">${add('stretch', 'Stretch')}${add('taper', 'Taper')}${add('move', 'Move')}${add('mirror', 'Mirror')}</div>
      ${ops.length ? `<ol class="ops">${ops.map(renderOp).join('')}</ol>` : '<p class="hint">No steps yet. A new step goes after the selected one.</p>'}
    </section>
    <div class="foot">
      <span>Millimetres. X and Y are centred on the model; it sits on Z&nbsp;=&nbsp;0. Work is saved in this browser.</span>
      <dl class="keys">
        <dt>Click</dt><dd>read a point · <kbd>Shift</kbd>-click to measure</dd>
        <dt>Double-click</dt><dd>orbit around that point</dd>
        <dt>Drag a field label</dt><dd>scrub its value · <kbd>↑</kbd><kbd>↓</kbd> step it (<kbd>Shift</kbd> ×10, <kbd>Alt</kbd> fine)</dd>
        <dt><kbd>F</kbd></dt><dd>fit the model in view</dd>
        <dt><kbd>Ctrl</kbd>/<kbd>⌘</kbd></dt><dd><kbd>Z</kbd> undo · <kbd>Shift</kbd>+<kbd>Z</kbd> redo · <kbd>D</kbd> duplicate step</dd>
        <dt><kbd>Del</kbd> · <kbd>Esc</kbd></dt><dd>delete · close the selected step or zone</dd>
      </dl>
      <button type="button" class="linkbtn" data-act="sample">Start over with the sample truck</button>
    </div>`;
  updateNotes();
  updateZoneNotes();
  updateHistoryButtons();
}

/* --------------------------------------------------------------- editing */

function setPath(obj, path, raw) {
  const parts = path.split('.');
  const nullable = parts[0] === 'box';
  let v = raw === '' ? null : Number(raw);
  if (v !== null && !Number.isFinite(v)) return false;
  if (v === null && !nullable) return false; // keep the last good number while typing
  let o = obj;
  for (const p of parts.slice(0, -1)) o = o[p];
  o[parts[parts.length - 1]] = v;
  return true;
}
const getPath = (o, path) => path.split('.').reduce((x, k) => (x == null ? x : x[k]), o);

function refreshCardText(i) {
  const op = state.ops[i];
  if (!op) return;
  const named = !!(op.label && op.label.trim());
  const s = document.getElementById('sum-' + i);
  if (s) s.innerHTML = `${named ? `<span class="op-type">${NAMES[op.type]}</span> · ` : ''}${esc(summary(op))}`;
  const t = document.getElementById('title-' + i);
  if (t) t.textContent = stepTitle(op);
  const a = AXI[op.axis];
  const ls = document.getElementById(`op${i}-limit-sum`);
  if (ls && a !== undefined) ls.textContent = limitText(op, op.type === 'move' ? [0, 1, 2] : OTHER[a]);
  const ts = document.getElementById(`op${i}-tilt-sum`);
  if (ts) ts.textContent = isTilted(op) ? `${shortN(op.tilt[0])}° / ${shortN(op.tilt[1])}°` : 'none';
}

// The model as step `index` sees it.
function inputBBox(index) {
  if (state.info && index < state.info.n) return state.info.trace[index].bbox;
  return bbox(evaluate(state.base, plan(), index, state.cache).mesh);
}

// A tilted tool turns about a fixed point, set once when it is first tilted,
// so dragging one face never shifts the others.
function syncPivot(op, i) {
  if (op.type === undefined) return;
  if (isTilted(op)) {
    if (!op.pivot) op.pivot = defaultPivot({ ...op, tilt: [0, 0] }, inputBBox(i)).map(r1);
  } else delete op.pivot;
}

function addOp(type) {
  if (!state.base) { toast('Open a model first.'); return; }
  const at = state.selected >= 0 ? state.selected + 1 : state.ops.length;
  const bb = inputBBox(at);
  const op = defaultOp(type, bb);
  if (state.clickPoint && (type === 'stretch' || type === 'taper')) {
    // Centre a new zone on the last clicked point.
    op.box.min[0] = r1(state.clickPoint[0] - 5);
    op.box.max[0] = r1(state.clickPoint[0] + 5);
  }
  if (type === 'mirror' && state.clickPoint) op.at = r1(state.clickPoint[0]);
  state.ops.splice(at, 0, op);
  state.selected = at;
  state.selectedZone = null;
  state.open.set(op, { limit: type === 'move' });
  cancelPick(false);
  record(true);
  renderPanel();
  scheduleEval();
}

function nextZoneId() {
  let n = 1;
  const used = new Set(state.zones.map((z) => z.id));
  while (used.has(`z${n}`)) n++;
  return `z${n}`;
}

function addZone() {
  if (!state.base) { toast('Open a model first.'); return; }
  const bb = bbox(state.base);
  const id = nextZoneId();
  const c = state.clickPoint && state.selected < 0 ? state.clickPoint : [bb.center[0], bb.center[1], bb.max[2] - 2];
  state.zones.push(makeZone(id, `Zone ${state.zones.length + 1}`, c));
  state.selectedZone = id;
  state.selected = -1;
  cancelPick(false);
  record(true);
  renderPanel();
  scheduleEval();
  toast('Zone added. Click ⌖ next to Centre, then click the model where it should go.');
}

function deleteZone(id) {
  const z = state.zones.find((x) => x.id === id);
  if (!z) return;
  state.zones = state.zones.filter((x) => x.id !== id);
  for (const op of state.ops) if (op.rigidExcept) op.rigidExcept = op.rigidExcept.filter((x) => x !== id);
  if (state.selectedZone === id) state.selectedZone = null;
  cancelPick(false);
  record(true);
  renderPanel();
  scheduleEval();
  toast(`Deleted “${z.name}”. Ctrl/⌘+Z brings it back.`);
}

function setOrientation(M) {
  state.orientation = validOrientation(M);
  state.base = orient(state.raw, state.orientation);
  state.cache = [];
  state.clickPoint = state.clickPoint2 = null;
  ghostKey = null;
  if (state.zones.length || state.ops.length) toast('Steps and zones keep their numbers, so check them after turning the model.');
  record(true);
  renderPanel();
  runEval();
  frameView('iso');
}

const PICK_LABEL = (target, op) => {
  if (target === 'at') return `the mirror plane (${AX(op.axis)})`;
  if (target === 'center') return 'the zone’s centre';
  const m = target.match(/^box\.(min|max)\.(\d)$/);
  if (!m) return 'a point';
  const k = +m[2];
  const zone = op && op.type !== 'move' && AXI[op.axis] === k;
  return `${zone ? 'the stretch zone' : 'the limit'} ${m[1] === 'min' ? 'start' : 'end'} (${AX(AXN[k])})`;
};

function startPick(owner, target) {
  const op = owner.zone ? null : state.ops[owner.i];
  state.pick = owner.zone ? { zone: owner.zone, target } : { i: owner.i, target };
  $('#banner').textContent = `Click the model to set ${PICK_LABEL(target, op)}. Esc cancels.`;
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
  const pk = state.pick;
  if (pk.zone) {
    const z = state.zones.find((x) => x.id === pk.zone);
    if (z) z.center = p.map(r1);
  } else {
    const op = state.ops[pk.i];
    // Picked points are in the world; the step's numbers are in its (possibly tilted) frame.
    const F = toolFrame(op, inputBBox(pk.i));
    const f = F.into(p, [0, 0, 0]);
    if (pk.target === 'at') op.at = r1(f[F.a]);
    else {
      const m = pk.target.match(/^box\.(min|max)\.(\d)$/);
      if (m) {
        op.box[m[1]][+m[2]] = r1(f[+m[2]]);
        const k = +m[2];
        if (!(op.type !== 'move' && k === F.a)) state.open.set(op, { ...(state.open.get(op) || {}), limit: true });
      }
    }
  }
  state.clickPoint = p;
  cancelPick(false);
  record(true);
  renderPanel();
  scheduleEval();
}

function changeAxis(op, i, axis) {
  const from = AXI[op.axis], to = AXI[axis];
  if (from === to) return;
  if (op.box && op.type !== 'move') {
    // The stretch zone follows the axis; the old zone row becomes a limit-free row.
    const bb = inputBBox(i);
    [op.box.min[from], op.box.min[to]] = [op.box.min[to], op.box.min[from]];
    [op.box.max[from], op.box.max[to]] = [op.box.max[to], op.box.max[from]];
    if (!isSet(op.box.min[to]) || !isSet(op.box.max[to])) {
      op.box.min[to] = r1(bb.center[to] - 5);
      op.box.max[to] = r1(bb.center[to] + 5);
    }
    op.box.min[from] = null;
    op.box.max[from] = null;
  }
  op.axis = axis;
  if (op.type === 'taper' && AXI[op.vary] === to) op.vary = AXN[OTHER[to][0]];
  if (op.type === 'mirror') op.at = r1(inputBBox(i).center[to]);
  op.tilt = [0, 0];
  delete op.pivot;
}

const panel = $('#panel');
panel.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act],[data-set],[data-pick],[data-add],[data-turn]');
  if (!el || el.disabled) return;
  const i = +el.dataset.i;
  if (el.dataset.add) return addOp(el.dataset.add);
  if (el.dataset.turn) return setOrientation(turnOrientation(state.orientation, el.dataset.turn));
  if (el.dataset.pick) {
    const owner = el.dataset.zonePick ? { zone: el.dataset.zonePick } : { i };
    const p = state.pick;
    if (p && p.target === el.dataset.pick && (owner.zone ? p.zone === owner.zone : p.i === owner.i)) return cancelPick();
    return startPick(owner, el.dataset.pick);
  }
  if (el.dataset.set) {
    const op = state.ops[i];
    const key = el.dataset.set, val = el.dataset.val;
    if (key === 'axis') changeAxis(op, i, val); else op[key] = val;
    record(true);
    renderPanel();
    scheduleEval();
    return;
  }
  const act = el.dataset.act;
  const ops = state.ops;
  const zid = el.dataset.zone;
  switch (act) {
    case 'select':
      state.selected = state.selected === i ? -1 : i;
      state.selectedZone = null;
      cancelPick(false);
      break;
    case 'zone-select':
      state.selectedZone = state.selectedZone === zid ? null : zid;
      state.selected = -1;
      cancelPick(false);
      break;
    case 'up':
      if (i > 0) { [ops[i - 1], ops[i]] = [ops[i], ops[i - 1]]; state.selected = i - 1; record(true); }
      break;
    case 'down':
      if (i < ops.length - 1) { [ops[i + 1], ops[i]] = [ops[i], ops[i + 1]]; state.selected = i + 1; record(true); }
      break;
    case 'toggle':
      ops[i].enabled = ops[i].enabled === false;
      record(true);
      break;
    case 'untilt':
      ops[i].tilt = [0, 0];
      delete ops[i].pivot;
      record(true);
      break;
    case 'del': return deleteStep(i);
    case 'dup': return duplicateStep(i);
    case 'undo': return undo();
    case 'redo': return redo();
    case 'zone-new': return addZone();
    case 'zone-del': return deleteZone(zid);
    case 'orient-reset': return setOrientation(IDENTITY_ORIENTATION);
    case 'sample': return loadSample();
    case 'intro-close':
      state.showIntro = false;
      try { localStorage.setItem('pb.intro', 'seen'); } catch {}
      break;
    default: return;
  }
  renderPanel();
  scheduleEval();
});
panel.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.op-head')) { e.preventDefault(); e.target.click(); }
});
panel.addEventListener('change', (e) => {
  const t = e.target;
  if (!t.dataset.rigid) return;
  const op = state.ops[+t.dataset.i];
  const except = new Set(op.rigidExcept || []);
  if (t.checked) except.delete(t.dataset.rigid); else except.add(t.dataset.rigid);
  op.rigidExcept = [...except];
  record(true);
  scheduleEval();
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
  if (t.dataset.kind === 'zone-name') {
    const z = state.zones.find((x) => x.id === t.dataset.zone);
    if (!z) return;
    z.name = t.value || 'Zone';
    const el = document.getElementById('ztitle-' + z.id);
    if (el) el.textContent = z.name;
    record();
    scheduleSave();
    return;
  }
  if (t.dataset.zpath) {
    const z = state.zones.find((x) => x.id === t.dataset.zone);
    if (!z || !setPath(z, t.dataset.zpath, t.value)) return;
    record();
    scheduleEval();
    return;
  }
  if (!t.matches('input[data-path]')) return;
  const i = +t.dataset.i;
  const op = state.ops[i];
  if (!setPath(op, t.dataset.path, t.value)) return;
  if (t.dataset.path.startsWith('tilt')) syncPivot(op, i);
  refreshCardText(i);
  record();
  scheduleEval();
});
panel.addEventListener('toggle', (e) => {
  const d = e.target;
  if (!d.matches || !d.matches('details[data-details]')) return;
  const op = state.ops[+d.dataset.i];
  if (op) state.open.set(op, { ...(state.open.get(op) || {}), [d.dataset.details]: d.open });
}, true);

// Set a number field from code (keys, scrubbing) and run it through the normal input path.
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
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && t.matches('input[type="number"]')) {
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
  if (!input || input.type !== 'number') return;
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

/* ---------------------------------------------------------------- history */

const history = { stack: [], index: -1, timer: 0 };
const snapshot = () => JSON.stringify({ orientation: state.orientation, zones: state.zones, ops: state.ops, selected: state.selected, selectedZone: state.selectedZone });
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
  if (now) commit(); else { history.timer = setTimeout(commit, 400); updateHistoryButtons(); }
}
function restore(s) {
  const o = JSON.parse(s);
  const turned = JSON.stringify(o.orientation) !== JSON.stringify(state.orientation);
  state.orientation = o.orientation;
  state.zones = o.zones;
  state.ops = o.ops;
  state.selected = Math.min(o.selected, state.ops.length - 1);
  state.selectedZone = o.selectedZone && state.zones.some((z) => z.id === o.selectedZone) ? o.selectedZone : null;
  if (turned) { state.base = orient(state.raw, state.orientation); state.cache = []; }
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
    else if ((state.selected >= 0 || state.selectedZone) && !typing) { state.selected = -1; state.selectedZone = null; renderPanel(); scheduleEval(); }
    return;
  }
  if (typing || mod || e.altKey) return;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (state.selected >= 0) { e.preventDefault(); deleteStep(state.selected); }
    else if (state.selectedZone) { e.preventDefault(); deleteZone(state.selectedZone); }
    return;
  }
  if (key === 'f') frameView('keep');
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
// Where along the line through `origin` in direction `dir` the mouse ray passes
// closest. Null when that line points straight at the camera.
function lineParam(e, origin, dir) {
  raycaster.setFromCamera(ndcOf(e), camera);
  const O = raycaster.ray.origin, D = raycaster.ray.direction;
  const A = v3(dir).normalize();
  const w0 = origin.clone().sub(O);
  const b = A.dot(D), d = A.dot(w0), e2 = D.dot(w0);
  const denom = 1 - b * b;
  return denom < 1e-3 ? null : (b * e2 - d) / denom;
}

const tip = document.createElement('div');
tip.className = 'griptip';
tip.hidden = true;
stage.append(tip);

let drag = null;
let downAt = null;

function gripValue(g) {
  if (g.zone) {
    const z = state.zones.find((x) => x.id === g.zone);
    return z ? n0(z.center[g.k]) + (g.side === 'max' ? 1 : -1) * n0(z.size[g.k]) / 2 : 0;
  }
  return n0(getPath(state.ops[g.i], g.path));
}
function setGripValue(g, v) {
  if (g.zone) {
    const z = state.zones.find((x) => x.id === g.zone);
    if (!z) return;
    const lo = n0(z.center[g.k]) - n0(z.size[g.k]) / 2, hi = n0(z.center[g.k]) + n0(z.size[g.k]) / 2;
    let nlo = g.side === 'min' ? v : lo, nhi = g.side === 'max' ? v : hi;
    if (nhi - nlo < 0.5) { if (g.side === 'min') nlo = nhi - 0.5; else nhi = nlo + 0.5; }
    z.center[g.k] = Math.round(((nlo + nhi) / 2) * 100) / 100;
    z.size[g.k] = Math.round((nhi - nlo) * 100) / 100;
    for (const key of ['center', 'size']) {
      const input = document.getElementById(`zone-${z.id}-${key}${g.k}`);
      if (input) input.value = String(z[key][g.k]);
    }
    return;
  }
  const op = state.ops[g.i];
  setPath(op, g.path, String(v));
  const m = g.path.match(/^box\.(min|max)\.(\d)$/);
  const input = document.getElementById(m ? `op${g.i}-b${m[1]}${m[2]}` : `op${g.i}-${g.path}`);
  if (input) input.value = String(v);
  refreshCardText(g.i);
}

// Grips are grabbed in the capture phase so the orbit controls never see the press.
stage.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !renderer || e.target !== canvas) return;
  const obj = gripAt(e);
  if (!obj) return;
  const g = obj.userData.grip;
  const origin = obj.getWorldPosition(new THREE.Vector3());
  const t0 = lineParam(e, origin, g.dir);
  e.stopPropagation();
  e.preventDefault();
  if (t0 === null) { toast('Turn the view a little to drag this grip.'); return; }
  drag = { g, origin, t0, start: gripValue(g), id: e.pointerId };
  if (controls) controls.enabled = false;
  stage.setPointerCapture(e.pointerId);
  stage.classList.add('dragging');
}, true);

window.addEventListener('pointermove', (e) => {
  if (drag) {
    if (e.pointerId !== drag.id) return;
    const t = lineParam(e, drag.origin, drag.g.dir);
    if (t === null) return;
    const snap = e.shiftKey ? 0.1 : 0.5;
    const v = Math.round((Math.round((drag.start + (t - drag.t0)) / snap) * snap) * 100) / 100;
    if (v !== drag.last) {
      drag.last = v;
      setGripValue(drag.g, v);
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
  if (sameGrip(g, hoverGrip)) return;
  hoverGrip = g;
  canvas.style.cursor = g ? 'grab' : '';
  canvas.title = g ? `${g.label}: drag to move (Shift for 0.1 mm)` : '';
  for (const o of grips) o.scale.setScalar(sameGrip(o.userData.grip, g) ? 1.3 : 1);
  requestRender();
});

const endDrag = (e) => {
  if (!drag || (e && e.pointerId !== drag.id)) return;
  drag = null;
  if (controls) controls.enabled = true;
  stage.classList.remove('dragging');
  tip.hidden = true;
  record(true);
  renderPanel();
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
  scheduleSave();
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
  scheduleSave();
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
  toastTimer = setTimeout(() => { t.hidden = true; }, 4200);
}

function setLoading(on, msg = 'Loading…') {
  const l = $('#loading');
  l.textContent = msg;
  l.hidden = !on;
}
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

// recipe: { orientation, zones, ops } or null for a fresh start.
async function openBuffer(name, buffer, recipe = null, { persist = true } = {}) {
  setLoading(true, `Loading ${name}…`);
  await nextFrame();
  const original = persist ? buffer.slice(0) : null;
  try {
    const mesh = await loadMesh(name, buffer);
    state.raw = mesh;
    state.fileName = name;
    state.sourceFaces = mesh.indices.length / 3;
    state.orientation = validOrientation(recipe ? recipe.orientation : IDENTITY_ORIENTATION);
    state.base = orient(mesh, state.orientation);
    state.zones = recipe ? recipe.zones : [];
    state.ops = recipe ? recipe.ops : [];
    state.cache = [];
    state.clickPoint = state.clickPoint2 = null;
    state.selected = -1;
    state.selectedZone = null;
    ghostKey = null;
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
  return makeRecipe({ orientation: state.orientation, zones: state.zones, ops: state.ops }, { name: state.fileName, faces: state.sourceFaces });
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
    if (!state.raw) { toast('Open the model this recipe is for, then load the recipe.'); return; }
    state.orientation = r.orientation;
    state.base = orient(state.raw, state.orientation);
    state.zones = r.zones;
    state.ops = r.ops;
    state.cache = [];
    state.selected = -1;
    state.selectedZone = null;
    cancelPick(false);
    record(true);
    renderPanel();
    runEval();
    const src = r.source;
    if (r.notes.length) toast(r.notes[0]);
    else if (src && src.faces && src.faces !== state.sourceFaces) toast(`Recipe applied. It was made for ${src.name || 'another file'}, so check the numbers.`);
    else toast(`Recipe applied: ${r.zones.length} zones, ${r.ops.length} steps.`);
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
  const full = evaluate(state.base, plan(), state.ops.length, state.cache);
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

/* --------------------------------------------------------------- session */

// The open model and its plan stay in this browser (IndexedDB), so a reload
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
    idbPut('steps', { file: state.fileName, recipe: JSON.parse(JSON.stringify(currentRecipe())), view: { ...state.view } });
  }, 600);
}

async function loadSample() {
  const btn = document.querySelector('.linkbtn[data-act="sample"]');
  const hasWork = state.base && state.fileName !== 'sample-pickup.stl' && (state.ops.length || state.zones.length);
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

/* ------------------------------------------------------------------- boot */

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
darkQuery.addEventListener?.('change', applyTheme);
new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
applyTheme();
downloadsCap();

// Test hook for the browser checks: add ?debug to the URL.
if (new URLSearchParams(location.search).has('debug')) {
  window.panelbeater = {
    state,
    gripScreen(key) {
      const o = grips.find((g) => g.userData.grip.key.endsWith(key));
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
  const [model, saved] = await Promise.all([idbGet('model'), idbGet('steps')]);
  if (model && model.buffer && model.name) {
    let recipe = null;
    if (saved && saved.file === model.name) {
      try {
        // Sessions saved before recipes had a version 2 hold a bare step list.
        recipe = saved.recipe ? readRecipe(saved.recipe) : Array.isArray(saved.ops) ? readRecipe({ app: 'panelbeater', version: 1, ops: saved.ops }) : null;
      } catch { recipe = null; }
      const v = saved.view || {};
      if (['none', 'strain', 'moved'].includes(v.heat)) state.view.heat = v.heat;
      state.view.ghost = !!v.ghost;
      syncViewButtons();
    }
    if (await openBuffer(model.name, model.buffer, recipe, { persist: false })) {
      toast(recipe && recipe.notes.length ? `Picked up where you left off. ${recipe.notes[0]}` : `Picked up where you left off: ${model.name}`);
      return;
    }
  }
  await loadSample();
})();
