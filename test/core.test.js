import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  loadMesh, parseSTL, weld, bbox, checkMesh, volume, evaluate, defaultOp,
  toSTL, makeRecipe, readRecipe, normalizePlacement, makeZone, zoneHolds,
  orient, turnOrientation, IDENTITY_ORIENTATION, slice, refine, zipStore,
} from '../core.js';

const fixture = (name) => {
  const b = readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
const near = (a, b, eps = 1e-3, msg) => assert.ok(Math.abs(a - b) <= eps, msg || `${a} ≈ ${b}`);

/* ---------- test meshes ---------- */

function box(min, max) {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const V = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const T = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return weld(new Float32Array(T.flatMap((t) => t.flatMap((i) => V[i]))));
}

// Subdivided box: same shape, many vertices, so deforms have something to bend.
function denseBox(min, max, n) {
  const soup = [];
  const L = (a, b, t) => a + (b - a) * t;
  const face = (o, u, v) => {
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const p = (s, t) => [0, 1, 2].map((k) => o[k] + u[k] * s + v[k] * t);
      const a = p(i / n, j / n), b = p((i + 1) / n, j / n), c = p((i + 1) / n, (j + 1) / n), d = p(i / n, (j + 1) / n);
      soup.push(...a, ...b, ...c, ...a, ...c, ...d);
    }
  };
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  face([x0, y0, z0], [0, dy, 0], [dx, 0, 0]); // bottom (-z)
  face([x0, y0, z1], [dx, 0, 0], [0, dy, 0]); // top (+z)
  face([x0, y0, z0], [dx, 0, 0], [0, 0, dz]); // front (-y)
  face([x0, y1, z0], [0, 0, dz], [dx, 0, 0]); // back (+y)
  face([x0, y0, z0], [0, 0, dz], [0, dy, 0]); // left (-x)
  face([x1, y0, z0], [0, dy, 0], [0, 0, dz]); // right (+x)
  void L;
  return weld(new Float32Array(soup));
}

function icosphere(r, levels) {
  const t = (1 + Math.sqrt(5)) / 2;
  let V = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
  let F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (let l = 0; l < levels; l++) {
    const cache = new Map();
    const mid = (a, b) => {
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (!cache.has(k)) { V.push(V[a].map((v, i) => (v + V[b][i]) / 2)); cache.set(k, V.length - 1); }
      return cache.get(k);
    };
    F = F.flatMap(([a, b, c]) => { const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a); return [[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]]; });
  }
  V = V.map((v) => { const l = Math.hypot(...v); return v.map((x) => (x / l) * r); });
  return weld(new Float32Array(F.flatMap((f) => f.flatMap((i) => V[i]))));
}

/* ---------- import / export ---------- */

test('binary STL round-trips and welds', () => {
  const m = box([0, 0, 0], [10, 20, 30]);
  const back = weld(parseSTL(toSTL(m)));
  assert.equal(back.indices.length / 3, 12);
  assert.equal(back.positions.length / 3, 8);
  assert.ok(checkMesh(back).watertight);
  near(volume(back), 6000);
});

test('ASCII STL parses', () => {
  const txt = `solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n`;
  const soup = parseSTL(new TextEncoder().encode(txt).buffer);
  assert.equal(soup.length, 9);
});

test('3MF: components in separate parts + build transform', async () => {
  const m = await loadMesh('a.3mf', fixture('component-rotated.3mf'));
  const b = bbox(m);
  assert.equal(m.indices.length / 3, 12);
  b.size.forEach((s) => near(s, 10));
  near(b.min[2], 0); // normalised onto the bed
  near(b.center[0], 0);
  assert.ok(checkMesh(m).watertight);
  assert.ok(volume(m) > 0, 'winding preserved');
});

test('3MF: inch units, stored/zip64 entries, mirrored item keeps outward winding', async () => {
  const m = await loadMesh('b.3mf', fixture('inch-zip64.3mf'));
  bbox(m).size.forEach((s) => near(s, 254));
  assert.ok(volume(m) > 0);
  assert.ok(checkMesh(m).watertight);
});

/* ---------- steps ---------- */

const base = () => normalizePlacement(denseBox([-20, -40, 0], [20, 40, 30], 8));
const plan = (ops, zones = []) => ({ zones, ops });
const run = (m, ops, zones) => evaluate(m, plan(ops, zones));
const stretch = (o = {}) => ({ ...defaultOp('stretch'), ...o });
const xs = (mesh, pred) => { const out = []; const P = mesh.positions; for (let i = 0; i < P.length; i += 3) if (pred(P[i], P[i + 1], P[i + 2])) out.push([P[i], P[i + 1], P[i + 2]]); return out; };

test('stretch grows the zone; the far sides slide, walls keep their shape', () => {
  const { mesh, notes } = run(base(), [stretch({ box: { min: [-2, null, null], max: [2, null, null] }, amount: 6 })]);
  const b = bbox(mesh);
  near(b.size[0], 46);
  near(b.size[1], 80);
  assert.ok(checkMesh(mesh).watertight);
  assert.equal(notes[0], '');
  // Only faces inside the zone are strained; the side walls just moved.
  const strained = mesh.strain.filter((s) => s > 1e-6).length;
  assert.ok(strained > 0 && strained < mesh.strain.length / 3, `strained ${strained}`);
});

test('keep start / end decides which side stays still', () => {
  const zone = { min: [null, null, 12], max: [null, null, 16] };
  const end = bbox(run(base(), [stretch({ axis: 'z', box: zone, amount: 4, keep: 'end' })]).mesh);
  near(end.max[2], 30); near(end.min[2], -4);
  const start = bbox(run(base(), [stretch({ axis: 'z', box: zone, amount: 4, keep: 'start' })]).mesh);
  near(start.min[2], 0); near(start.max[2], 34);
});

test('the zone is cut exactly, so a pure stretch adds few faces', () => {
  const m = box([-20, -40, 0], [20, 40, 30]);
  const { mesh } = run(m, [stretch({ box: { min: [-2, null, null], max: [2, null, null] }, amount: 6 })]);
  assert.ok(mesh.indices.length / 3 <= 64, `faces ${mesh.indices.length / 3}`); // 12 + two cut lines
  assert.ok(checkMesh(mesh).watertight);
  near(bbox(mesh).size[0], 46);
});

test('shrinking more than half the zone widens it instead of folding', () => {
  const { mesh, notes } = run(base(), [stretch({ box: { min: [-1, null, null], max: [1, null, null] }, amount: -10 })]);
  assert.match(notes[0], /widened to 20 mm/);
  near(bbox(mesh).size[0], 30);
  assert.ok(volume(mesh) > 0);
});

test('limits across the axis confine a stretch; the soft edge blends it', () => {
  const op = stretch({ box: { min: [-2, null, null], max: [2, -20, null] }, soft: 10, amount: 8 });
  const { mesh } = run(base(), [op]);
  const maxX = (pred) => Math.max(...xs(mesh, pred).map((p) => p[0]));
  near(maxX((x, y) => y > -5), 20);       // beyond the soft edge: untouched
  near(maxX((x, y) => y < -25), 24);      // inside the limit: full half-amount
  const mid = maxX((x, y) => Math.abs(y + 15) < 0.01); // the soft edge got cut, so points exist here
  assert.ok(mid > 20.5 && mid < 23.5, `blended ${mid}`);
  assert.ok(checkMesh(mesh).watertight);
});

test('automatic refining adds points only where the shell bends', () => {
  const coarse = box([-10, -50, 0], [10, 50, 10]);
  const op = stretch({ box: { min: [-1, null, null], max: [1, -20, null] }, soft: 20, amount: 4 });
  const { mesh } = run(coarse, [op]);
  assert.ok(checkMesh(mesh).watertight);
  const faces = mesh.indices.length / 3;
  assert.ok(faces > 50 && faces < 3000, `faces ${faces}`);
  // Side wall points in the blend should follow the smooth curve closely.
  const s = (t) => t * t * (3 - 2 * t);
  for (const [x, y] of xs(mesh, (x, y) => x > 10 && y > -20 && y < 0)) {
    near(x, 10 + 2 * s(1 - (y + 20) / 20), 0.05, `point at y=${y.toFixed(2)} x=${x.toFixed(3)}`);
  }
});

test('taper ramps the amount across the box', () => {
  const op = { ...defaultOp('taper'), box: { min: [-6, -40, null], max: [6, 40, null] }, vary: 'y', amountStart: 0, amountEnd: -10 };
  const { mesh, notes } = run(base(), [op]);
  assert.match(notes[0], /widened to 20 mm/);
  const w = (yy) => Math.max(...xs(mesh, (x, y) => Math.abs(y - yy) < 1e-3).map((p) => p[0]));
  near(w(-40), 20);
  near(w(40), 15);
  assert.ok(checkMesh(mesh).watertight);
});

test('move pushes what is in the box', () => {
  const op = { ...defaultOp('move'), axis: 'z', amount: -5, box: { min: [null, null, null], max: [null, null, 1] }, soft: 1 };
  const { mesh } = run(base(), [op]);
  near(bbox(mesh).min[2], -5);
  near(bbox(mesh).max[2], 30);
  assert.ok(checkMesh(mesh).watertight);
});

test('tilt turns the tool: points move along the tilted axis', () => {
  const op = stretch({ box: { min: [-2, null, null], max: [2, null, null] }, amount: 6, tilt: [0, 30] });
  const m = base();
  const { mesh } = run(m, [op]);
  assert.ok(checkMesh(mesh).watertight);
  // A corner well clear of the zone moves amount/2 along (cos30, sin30, 0).
  const P0 = m.positions, P1 = mesh.positions;
  let found = false;
  for (let i = 0; i < P0.length; i += 3) {
    if (P0[i] === 20 && P0[i + 1] === 40 && P0[i + 2] === 30) {
      near(P1[i] - 20, 3 * Math.cos(Math.PI / 6), 1e-3);
      near(P1[i + 1] - 40, 3 * Math.sin(Math.PI / 6), 1e-3);
      found = true;
    }
  }
  assert.ok(found);
});

test('rigid zones hold in every step unless a step excepts them', () => {
  const zone = makeZone('z1', 'Posts', [0, 0, 30], [12, 12, 2], 0);
  const op = stretch({ box: { min: [-1, null, null], max: [1, null, null] }, amount: 10 });
  const inZone = (x, y, z) => Math.abs(x) <= 6 && Math.abs(y) <= 6 && z >= 29;
  const m = base();
  const held = run(m, [op], [zone]).mesh;
  for (const [x] of xs(m, inZone)) void x;
  const spread = (mesh) => { const pts = xs(mesh, (x, y, z) => Math.abs(y) <= 6 && z >= 29.9 && Math.abs(x) <= 12); return Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0])); };
  const free = run(m, [{ ...op, rigidExcept: ['z1'] }], [zone]).mesh;
  assert.ok(spread(free) > spread(held) + 5, `held ${spread(held)} free ${spread(free)}`);
  assert.ok(checkMesh(held).watertight);
  assert.equal(zoneHolds(m, zone) > 0, true);
});

test('zones travel with the model', () => {
  const zone = makeZone('z1', 'Posts', [15, 0, 30], [4, 4, 2], 1);
  const op = stretch({ box: { min: [-1, null, null], max: [1, null, null] }, amount: 10 });
  const { trace, zones } = run(base(), [op, { ...op }], [zone]);
  near(trace[1].zones[0].min[0], 18);
  near(zones[0].min[0], 23);
});

test('orientation turns the model and re-seats it', () => {
  const M = turnOrientation(IDENTITY_ORIENTATION, 'x');
  const m = orient(base(), M);
  const b = bbox(m);
  near(b.size[1], 30); near(b.size[2], 80); near(b.min[2], 0);
  assert.ok(volume(m) > 0);
  assert.deepEqual(turnOrientation(turnOrientation(turnOrientation(M, 'x'), 'x'), 'x'), IDENTITY_ORIENTATION);
});

test('mirror makes a watertight symmetric whole from a lopsided mesh', () => {
  const m = icosphere(20, 3);
  const { mesh } = run(m, [{ ...defaultOp('mirror'), axis: 'x', at: 3.3, side: 'neg' }]);
  assert.ok(checkMesh(mesh).watertight);
  const b = bbox(mesh);
  near(b.min[0] + b.max[0], 2 * 3.3, 1e-3);
  assert.ok(volume(mesh) > 0);
});

test('mirror at a plane through existing vertices keeps the volume', () => {
  const m = base();
  const { mesh } = run(m, [{ ...defaultOp('mirror'), axis: 'x', at: 0, side: 'pos' }]);
  assert.ok(checkMesh(mesh).watertight);
  near(volume(mesh), volume(m), 1e-2);
});

test('tilted mirror stays watertight', () => {
  const { mesh } = run(icosphere(20, 3), [{ ...defaultOp('mirror'), axis: 'x', at: 2, tilt: [0, 12] }]);
  assert.ok(checkMesh(mesh).watertight);
  assert.ok(volume(mesh) > 0);
});

test('slice keeps both sides watertight', () => {
  const s = slice(icosphere(10, 2), [0.3, 0.5, 0.81].map((v, _, a) => v / Math.hypot(...a)), 1.7);
  assert.ok(checkMesh(s).watertight);
  near(volume(s), volume(icosphere(10, 2)), 1e-3);
});

test('a step that moves nothing says so', () => {
  const { notes } = run(base(), [stretch({ box: { min: [-1, 500, null], max: [1, null, null] }, soft: 1, amount: 5 })]);
  assert.match(notes[0], /Nothing moved/);
});

test('a stretch without a zone reports an error instead of guessing', () => {
  const { notes } = run(base(), [stretch({ box: { min: [null, null, null], max: [null, null, null] } })]);
  assert.match(notes[0], /^Error: set where the stretch zone/);
});

test('stage cache reuses unchanged prefixes; names and labels never recompute', () => {
  const m = base();
  const zones = [makeZone('z1', 'A', [0, 0, 30], [4, 4, 4])];
  const ops = [stretch({ label: 'Wide' }), { ...defaultOp('move'), amount: -2 }];
  const cache = [];
  const a = evaluate(m, { zones, ops }, ops.length, cache);
  const b = evaluate(m, { zones: [{ ...zones[0], name: 'Renamed' }], ops: [{ ...ops[0], label: 'Wider' }, ops[1]] }, ops.length, cache);
  assert.equal(a.mesh, b.mesh);
  ops[1] = { ...ops[1], amount: -3 };
  const c = evaluate(m, { zones, ops }, ops.length, cache);
  assert.notEqual(c.mesh, a.mesh);
  near(bbox(c.mesh).min[2], -3);
});

/* ---------- recipes ---------- */

test('recipes round-trip and fill defaults', () => {
  const zones = [makeZone('z1', 'Posts', [0, 0, 30], [4, 4, 4])];
  const ops = [{ type: 'stretch', axis: 'y', amount: 5, box: { min: [null, -3, null], max: [null, 3, null] } }];
  const r = readRecipe(JSON.parse(JSON.stringify(makeRecipe({ orientation: turnOrientation(IDENTITY_ORIENTATION, 'z'), zones, ops }, { name: 'x.stl' }))));
  assert.equal(r.ops[0].keep, 'middle');
  assert.deepEqual(r.ops[0].tilt, [0, 0]);
  assert.deepEqual(r.ops[0].rigidExcept, []);
  assert.equal(r.zones[0].name, 'Posts');
  assert.deepEqual(r.orientation, turnOrientation(IDENTITY_ORIENTATION, 'z'));
  assert.throws(() => readRecipe({ app: 'panelbeater', version: 99, ops: [] }), /newer/);
});

test('version 1 recipes convert to the box model', () => {
  const v1 = {
    app: 'panelbeater', version: 1, ops: [
      { type: 'rotate', axis: 'x', turns: 1 },
      { type: 'refine', maxEdge: 3 },
      { type: 'stretch', axis: 'x', at: 0, amount: 6, band: 0, side: 'both', region: { min: [null, null, null], max: [null, -42, null], falloff: 14 }, label: 'Nose' },
      { type: 'pin', center: [0, -64, 27], size: [24, 8, 4], falloff: 3, label: 'Hood posts' },
      { type: 'taper', axis: 'x', at: 0, band: 0, side: 'both', along: 'y', from: 90, to: 10, amountFrom: -8, amountTo: 0, region: { min: [null, 8, null], max: [null, null, null], falloff: 4 } },
      { type: 'stretch', axis: 'z', at: 10, amount: 4, band: 0, side: 'neg', region: { min: [null, -40, null], max: [null, 8, null], falloff: 8 } },
      { type: 'mirror', axis: 'x', at: 0, keep: 'neg' },
    ],
  };
  const r = readRecipe(v1);
  assert.deepEqual(r.orientation, turnOrientation(IDENTITY_ORIENTATION, 'x'));
  assert.equal(r.ops.length, 4);
  assert.equal(r.zones.length, 1);
  assert.equal(r.zones[0].name, 'Hood posts');
  const [nose, taper, doors, mirror] = r.ops;
  assert.equal(nose.label, 'Nose');
  assert.deepEqual(nose.box.min.slice(0, 1), [-0.5]);
  assert.equal(nose.box.max[1], -42);
  assert.deepEqual(nose.rigidExcept, ['z1'], 'the pin came after this step, so it did not hold here');
  assert.deepEqual(taper.rigidExcept, []);
  assert.equal(taper.vary, 'y');
  assert.equal(taper.box.min[1], 10); assert.equal(taper.box.max[1], 90);
  assert.equal(taper.amountStart, 0); assert.equal(taper.amountEnd, -8);
  assert.equal(doors.keep, 'end');
  assert.equal(mirror.side, 'neg');
  assert.match(r.notes[0], /older recipe/);
});

/* ---------- export ---------- */

test('zipStore output is a readable zip', async () => {
  const { execFileSync } = await import('node:child_process');
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(tmpdir() + '/pb-');
  writeFileSync(dir + '/t.zip', Buffer.from(zipStore([{ name: 'a.stl', data: toSTL(box([0, 0, 0], [1, 1, 1])) }, { name: 'r.json', data: '{}' }])));
  const out = execFileSync('python3', ['-I', '-c', `import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);print(z.testzip(),sorted(z.namelist()))`, dir + '/t.zip']).toString();
  assert.match(out, /None \['a.stl', 'r.json'\]/);
});

test('uniform refine splits long edges and keeps the shape', () => {
  const m = refine(box([0, 0, 0], [40, 10, 10]), 3);
  assert.ok(m.indices.length / 3 > 200);
  assert.ok(checkMesh(m).watertight);
  near(volume(m), 4000, 1e-2);
});
