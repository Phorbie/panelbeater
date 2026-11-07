import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  loadMesh, parseSTL, weld, bbox, checkMesh, volume, evaluate, defaultOp,
  toSTL, makeRecipe, readRecipe, normalizePlacement,
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

/* ---------- ops ---------- */

const base = () => normalizePlacement(denseBox([-20, -40, 0], [20, 40, 30], 8));

test('stretch (both sides) slides halves apart without scaling them', () => {
  const m = base();
  const op = { ...defaultOp('stretch'), axis: 'x', at: 0, amount: 6, band: 0 };
  const { mesh } = evaluate(m, [op]);
  const b = bbox(mesh);
  near(b.size[0], 46);
  near(b.size[1], 80);
  assert.ok(checkMesh(mesh).watertight);
  // Only faces crossing the plane are strained; side walls are just moved.
  const strained = mesh.strain.filter((s) => s > 1e-6).length;
  assert.ok(strained > 0 && strained < mesh.strain.length / 3, `strained ${strained}`);
});

test('stretch one side only, with a band', () => {
  const m = base();
  const op = { ...defaultOp('stretch'), axis: 'z', at: 15, amount: -4, band: 6, side: 'neg' };
  const { mesh, notes } = evaluate(m, [op]);
  const b = bbox(mesh);
  near(b.max[2], 30); // top untouched
  near(b.min[2], 4); // bottom moved up by 4 (shrink)
  assert.equal(notes[0], '');
});

test('shrink with too narrow a band is widened instead of folding', () => {
  const op = { ...defaultOp('stretch'), axis: 'x', amount: -10, band: 1 };
  const { mesh, notes } = evaluate(base(), [op]);
  assert.match(notes[0], /Band widened to 10/);
  near(bbox(mesh).size[0], 30);
  assert.ok(volume(mesh) > 0);
});

test('region limits a stretch, falloff blends it', () => {
  const op = { ...defaultOp('stretch'), axis: 'x', amount: 8, region: { min: [null, 20, null], max: [null, null, null], falloff: 10 } };
  const { mesh } = evaluate(base(), [op]);
  const P = mesh.positions;
  let maxXRear = -Infinity, maxXFront = -Infinity;
  for (let i = 0; i < P.length; i += 3) {
    if (P[i + 1] < 5) maxXRear = Math.max(maxXRear, P[i]);
    if (P[i + 1] > 25) maxXFront = Math.max(maxXFront, P[i]);
  }
  near(maxXRear, 20); // outside region + falloff: untouched
  near(maxXFront, 24); // inside region: full half-amount
});

test('taper varies the amount along a second axis', () => {
  const op = { ...defaultOp('taper'), axis: 'x', along: 'y', from: -40, to: 40, amountFrom: 0, amountTo: -10, band: 0 };
  const { mesh, notes } = evaluate(base(), [op]);
  assert.match(notes[0], /widened/);
  const P = mesh.positions;
  let wFront = -Infinity, wBack = -Infinity;
  for (let i = 0; i < P.length; i += 3) {
    if (Math.abs(P[i + 1] + 40) < 1e-4) wBack = Math.max(wBack, P[i]);
    if (Math.abs(P[i + 1] - 40) < 1e-4) wFront = Math.max(wFront, P[i]);
  }
  near(wBack, 20);
  near(wFront, 15);
  assert.ok(checkMesh(mesh).watertight);
});

test('move with region', () => {
  const op = { ...defaultOp('move'), axis: 'z', amount: -5, region: { min: [null, null, null], max: [null, null, 1], falloff: 0 } };
  const { mesh } = evaluate(base(), [op]);
  near(bbox(mesh).min[2], -5);
  near(bbox(mesh).max[2], 30);
});

test('pins keep a zone rigid and travel with later ops', () => {
  const m = base();
  // Pin a 6 mm zone straddling the stretch plane: it must not be stretched.
  const pin = { ...defaultOp('pin'), center: [0, 0, 30], size: [12, 12, 2], falloff: 0 };
  const stretch = { ...defaultOp('stretch'), axis: 'x', amount: 10, band: 0 };
  const { mesh, trace } = evaluate(m, [pin, stretch, { ...stretch, axis: 'y' }]);
  const P0 = m.positions, P1 = mesh.positions;
  for (let i = 0; i < P0.length; i += 3) {
    const inPin = Math.abs(P0[i]) <= 6 && Math.abs(P0[i + 1]) <= 6 && P0[i + 2] >= 29;
    if (inPin) {
      near(P1[i] - P0[i], 0, 1e-4, 'pinned x unchanged');
      near(P1[i + 1] - P0[i + 1], 0, 1e-4, 'pinned y unchanged');
    }
  }
  assert.equal(trace[2].pins.length, 1);
});

test('rotate turns the model and re-seats it', () => {
  const { mesh } = evaluate(base(), [{ ...defaultOp('rotate'), axis: 'x', turns: 1 }]);
  const b = bbox(mesh);
  near(b.size[1], 30);
  near(b.size[2], 80);
  near(b.min[2], 0);
  assert.ok(volume(mesh) > 0);
});

test('mirror makes a watertight symmetric whole from a lopsided mesh', () => {
  const m = icosphere(20, 3);
  const op = { ...defaultOp('mirror'), axis: 'x', at: 3.3, keep: 'neg' };
  const { mesh } = evaluate(m, [op]);
  const c = checkMesh(mesh);
  assert.ok(c.watertight, JSON.stringify(c));
  const b = bbox(mesh);
  near(b.min[0] + b.max[0], 2 * 3.3, 1e-3);
  assert.ok(volume(mesh) > 0);
});

test('mirror at a plane through existing vertices', () => {
  const m = base(); // dense box has vertices exactly on x = 0
  const { mesh } = evaluate(m, [{ ...defaultOp('mirror'), axis: 'x', at: 0, keep: 'pos' }]);
  assert.ok(checkMesh(mesh).watertight);
  near(volume(mesh), volume(m), 1e-2);
});

test('stage cache reuses unchanged prefixes', () => {
  const m = base();
  const ops = [{ ...defaultOp('stretch') }, { ...defaultOp('move') }];
  const cache = [];
  const a = evaluate(m, ops, ops.length, cache);
  ops[1] = { ...ops[1], amount: -3 };
  const b = evaluate(m, ops, ops.length, cache);
  assert.equal(cache.length, 2);
  assert.notEqual(a.mesh, b.mesh);
  near(bbox(b.mesh).min[2], -3);
});

test('recipes round-trip and fill defaults', () => {
  const ops = [defaultOp('rotate'), { type: 'stretch', axis: 'y', amount: 5 }];
  const r = readRecipe(JSON.parse(JSON.stringify(makeRecipe(ops, { name: 'x.stl' }))));
  assert.equal(r.ops[1].side, 'both');
  assert.equal(r.ops[1].amount, 5);
  assert.deepEqual(r.ops[1].region.min, [null, null, null]);
  assert.throws(() => readRecipe({ app: 'panelbeater', version: 99, ops: [] }), /newer/);
});

test('refine splits long edges, keeps shape and watertightness', () => {
  const m = box([0, 0, 0], [40, 10, 10]);
  const { mesh, notes } = evaluate(m, [{ type: 'refine', maxEdge: 3 }]);
  assert.ok(mesh.indices.length / 3 > 200, notes[0]);
  assert.ok(checkMesh(mesh).watertight);
  near(volume(mesh), 4000, 1e-2);
  const P = mesh.positions, I = mesh.indices;
  for (let f = 0; f < I.length; f += 3) for (let k = 0; k < 3; k++) {
    const a = 3 * I[f + k], b = 3 * I[f + ((k + 1) % 3)];
    assert.ok(Math.hypot(P[a] - P[b], P[a + 1] - P[b + 1], P[a + 2] - P[b + 2]) <= 3 + 1e-6);
  }
});

test('refine lets a falloff blend across what was one long triangle', () => {
  const m = box([-10, -50, 0], [10, 50, 10]);
  const stretch = { ...defaultOp('stretch'), axis: 'x', amount: 4, region: { min: [null, null, null], max: [null, -20, null], falloff: 20 } };
  const coarse = evaluate(m, [stretch]).mesh;
  const fine = evaluate(m, [{ type: 'refine', maxEdge: 2 }, stretch]).mesh;
  const widthAt = (mesh, y) => {
    let w = -Infinity; const P = mesh.positions;
    for (let i = 0; i < P.length; i += 3) if (Math.abs(P[i + 1] - y) < 1.01) w = Math.max(w, P[i]);
    return w;
  };
  assert.equal(widthAt(coarse, -10), -Infinity); // no vertices in the blend zone at all
  const mid = widthAt(fine, -10);
  assert.ok(mid > 10.2 && mid < 12, `blended half-width ${mid}`);
  assert.ok(checkMesh(fine).watertight);
});

test('zipStore output is a readable zip', async () => {
  const { zipStore } = await import('../core.js');
  const { execFileSync } = await import('node:child_process');
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(tmpdir() + '/pb-');
  writeFileSync(dir + '/t.zip', Buffer.from(zipStore([{ name: 'a.stl', data: toSTL(box([0, 0, 0], [1, 1, 1])) }, { name: 'r.json', data: '{}' }])));
  const out = execFileSync('python3', ['-I', '-c', `import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);print(z.testzip(),sorted(z.namelist()))`, dir + '/t.zip']).toString();
  assert.match(out, /None \['a.stl', 'r.json'\]/);
});

test('a step that moves nothing says so', () => {
  const op = { ...defaultOp('stretch'), amount: 5, region: { min: [null, 500, null], max: [null, null, null], falloff: 0 } };
  const { notes } = evaluate(base(), [op]);
  assert.match(notes[0], /Nothing moved/);
  const ok = evaluate(base(), [{ ...defaultOp('stretch'), amount: 5 }]);
  assert.doesNotMatch(ok.notes[0], /Nothing moved/);
});

test('pins report what they hold', () => {
  const held = evaluate(base(), [{ ...defaultOp('pin'), center: [0, 0, 30], size: [10, 10, 2] }]).notes[0];
  assert.match(held, /Holds \d+ points/);
  const empty = evaluate(base(), [{ ...defaultOp('pin'), center: [0, 0, 300], size: [4, 4, 4] }]).notes[0];
  assert.match(empty, /holds nothing/);
});

test('step labels survive recipes and do not invalidate the cache', () => {
  const m = base();
  const ops = [{ ...defaultOp('refine'), maxEdge: 4 }, { ...defaultOp('stretch'), label: 'Widen nose' }];
  const cache = [];
  const a = evaluate(m, ops, ops.length, cache);
  ops[1] = { ...ops[1], label: 'Wider nose' };
  const b = evaluate(m, ops, ops.length, cache);
  assert.equal(a.mesh, b.mesh, 'rename reuses the cached result');
  const r = readRecipe(JSON.parse(JSON.stringify(makeRecipe(ops))));
  assert.equal(r.ops[1].label, 'Wider nose');
});
