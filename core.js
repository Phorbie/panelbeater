// Panelbeater geometry core.
//
// Pure functions over indexed triangle meshes. No dependencies; runs in modern
// browsers and Node 18+. Units are millimetres throughout.
//
// Mesh shape:
//   { positions: Float32Array(3 * V), indices: Uint32Array(3 * F), strain: Float32Array(F),
//     disp?: Float32Array(3 * V), lastMove?: Float32Array(V) }
//
// `strain` is a per-face record of how much each triangle has been stretched by
// the steps so far (0 = untouched, 0.1 = an edge changed length by 10%).
// `disp` is each point's total movement so far, and `lastMove` how far it moved
// in the most recent step; both feed the Moved view.

export const RECIPE_VERSION = 2;
export const AXES = ['x', 'y', 'z'];
const AX = { x: 0, y: 1, z: 2 };

/* ------------------------------------------------------------------ import */

/** Load an STL (binary or ASCII) or 3MF file into a welded, centred mesh. */
export async function loadMesh(fileName, buffer) {
  const head = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
  const isZip = head[0] === 0x50 && head[1] === 0x4b; // "PK"
  const soup = isZip ? await parse3MF(buffer) : parseSTL(buffer);
  const mesh = weld(soup);
  if (mesh.indices.length === 0) throw new Error(`No triangles found in ${fileName}`);
  return normalizePlacement(mesh);
}

/** Parse STL into a triangle soup (9 floats per triangle). */
export function parseSTL(buffer) {
  const dv = new DataView(buffer);
  const n = buffer.byteLength >= 84 ? dv.getUint32(80, true) : -1;
  if (n >= 0 && 84 + n * 50 === buffer.byteLength) return parseBinarySTL(dv, n);
  const start = new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 512)));
  if (/^\s*solid/i.test(start)) {
    const soup = parseAsciiSTL(new TextDecoder().decode(buffer));
    if (soup.length) return soup;
  }
  if (n >= 0 && 84 + n * 50 <= buffer.byteLength) return parseBinarySTL(dv, n); // padded binary
  throw new Error('Not a recognisable STL file');
}

function parseBinarySTL(dv, n) {
  const soup = new Float32Array(n * 9);
  for (let f = 0; f < n; f++) {
    const o = 84 + f * 50 + 12; // skip the stored normal; we recompute
    for (let k = 0; k < 9; k++) soup[f * 9 + k] = dv.getFloat32(o + k * 4, true);
  }
  return soup;
}

function parseAsciiSTL(text) {
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
  const out = [];
  let m;
  while ((m = re.exec(text))) out.push(+m[1], +m[2], +m[3]);
  out.length -= out.length % 9;
  return new Float32Array(out);
}

const UNIT_MM = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };

/** Parse a 3MF package into a triangle soup in millimetres, with all build and component transforms applied. */
export async function parse3MF(buffer) {
  const zip = await unzip(buffer);
  const td = new TextDecoder();
  const text = async (name) => {
    const bytes = await zip.read(name);
    return bytes ? td.decode(bytes) : null;
  };

  let mainPath = null;
  const rels = await text('_rels/.rels');
  if (rels) {
    for (const m of rels.matchAll(/<(?:\w+:)?Relationship\b[^>]*>/g)) {
      const a = attrs(m[0]);
      if (/3dmodel$/i.test(a.Type || '')) { mainPath = a.Target; break; }
    }
  }
  const modelNames = zip.names.filter((n) => /\.model$/i.test(n));
  if (!mainPath) mainPath = modelNames[0];
  if (!mainPath) throw new Error('3MF: no model found in package');

  const models = new Map();
  for (const name of modelNames) models.set(partKey(name), parseModelXml(await text(name)));
  const rootKey = partKey(mainPath);
  const root = models.get(rootKey);
  if (!root) throw new Error(`3MF: main model ${mainPath} is missing`);

  const chunks = [];
  const emit = (modelKey, id, M, depth) => {
    const model = models.get(modelKey);
    const obj = model && model.objects.get(id);
    if (!obj || depth > 32) return;
    if (obj.type === 'support' || obj.type === 'solidsupport') return;
    const v = obj.vertices, t = obj.triangles, nv = v.length / 3;
    if (t.length) {
      const flip = det3(M) < 0; // mirrored transform: keep outward normals
      const out = new Float32Array(t.length * 3);
      let w = 0;
      for (let i = 0; i < t.length; i += 3) {
        const a = t[i], b = flip ? t[i + 2] : t[i + 1], c = flip ? t[i + 1] : t[i + 2];
        if (a >= nv || b >= nv || c >= nv) continue;
        for (const k of [a, b, c]) {
          const x = v[3 * k], y = v[3 * k + 1], z = v[3 * k + 2];
          out[w++] = x * M[0] + y * M[3] + z * M[6] + M[9];
          out[w++] = x * M[1] + y * M[4] + z * M[7] + M[10];
          out[w++] = x * M[2] + y * M[5] + z * M[8] + M[11];
        }
      }
      chunks.push(out.subarray(0, w));
    }
    for (const c of obj.components) {
      emit(c.path ? partKey(c.path) : modelKey, c.objectid, mulTransform(c.transform, M), depth + 1);
    }
  };

  if (root.build.length) {
    for (const item of root.build) emit(item.path ? partKey(item.path) : rootKey, item.objectid, item.transform, 0);
  } else {
    for (const id of root.objects.keys()) emit(rootKey, id, IDENTITY, 0);
  }

  const scale = UNIT_MM[root.unit] ?? 1;
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const soup = new Float32Array(total);
  let o = 0;
  for (const c of chunks) {
    if (scale === 1) soup.set(c, o);
    else for (let i = 0; i < c.length; i++) soup[o + i] = c[i] * scale;
    o += c.length;
  }
  return soup;
}

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

function partKey(path) {
  return String(path).replace(/^\/+/, '').toLowerCase();
}

function attrs(s) {
  const o = {};
  for (const m of s.matchAll(/([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) o[m[1]] = m[2] ?? m[3];
  return o;
}

function pathAttr(a) {
  for (const k in a) if (k === 'path' || k.endsWith(':path')) return a[k];
  return null;
}

function parseTransform(s) {
  if (!s) return IDENTITY;
  const n = s.trim().split(/\s+/).map(Number);
  return n.length === 12 && n.every(Number.isFinite) ? n : IDENTITY;
}

// 3MF transforms are 3x4, row-vector convention: p' = p * M.
// mulTransform(A, B) applies A first, then B.
function mulTransform(A, B) {
  const R = new Array(12);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      R[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
    }
  }
  for (let c = 0; c < 3; c++) R[9 + c] = A[9] * B[c] + A[10] * B[3 + c] + A[11] * B[6 + c] + B[9 + c];
  return R;
}

function det3(M) {
  return M[0] * (M[4] * M[8] - M[5] * M[7]) - M[1] * (M[3] * M[8] - M[5] * M[6]) + M[2] * (M[3] * M[7] - M[4] * M[6]);
}

// Minimal streaming-free XML scan. 3MF model files are flat and regular, so a
// tag tokenizer is faster than a DOM and works in Node without dependencies.
function parseModelXml(xml) {
  const model = { unit: 'millimeter', objects: new Map(), build: [] };
  if (!xml) return model;
  const re = /<(\/?)(?:[A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
  let obj = null;
  let m;
  while ((m = re.exec(xml))) {
    const tag = m[2];
    if (m[1]) { if (tag === 'object') obj = null; continue; }
    const rest = m[3];
    switch (tag) {
      case 'vertex':
        if (obj) { const a = attrs(rest); obj.vertices.push(+a.x, +a.y, +a.z); }
        break;
      case 'triangle':
        if (obj) { const a = attrs(rest); obj.triangles.push(a.v1 | 0, a.v2 | 0, a.v3 | 0); }
        break;
      case 'object': {
        const a = attrs(rest);
        obj = { type: a.type || 'model', vertices: [], triangles: [], components: [] };
        model.objects.set(a.id, obj);
        if (/\/\s*$/.test(rest)) obj = null;
        break;
      }
      case 'component':
        if (obj) {
          const a = attrs(rest);
          obj.components.push({ objectid: a.objectid, transform: parseTransform(a.transform), path: pathAttr(a) });
        }
        break;
      case 'item': {
        const a = attrs(rest);
        model.build.push({ objectid: a.objectid, transform: parseTransform(a.transform), path: pathAttr(a) });
        break;
      }
      case 'model': {
        const a = attrs(rest);
        if (a.unit) model.unit = a.unit;
        break;
      }
    }
  }
  return model;
}

// Just enough ZIP to read a 3MF: central directory, stored + deflate, ZIP64.
async function unzip(buffer) {
  const u8 = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('3MF: not a valid zip archive');
  let count = dv.getUint16(eocd + 10, true);
  let cdOffset = dv.getUint32(eocd + 16, true);
  if (cdOffset === 0xffffffff || count === 0xffff) {
    const loc = eocd - 20;
    if (loc >= 0 && dv.getUint32(loc, true) === 0x07064b50) {
      const z = Number(dv.getBigUint64(loc + 8, true));
      if (dv.getUint32(z, true) === 0x06064b50) {
        count = Number(dv.getBigUint64(z + 32, true));
        cdOffset = Number(dv.getBigUint64(z + 48, true));
      }
    }
  }

  const td = new TextDecoder();
  const entries = new Map();
  let p = cdOffset;
  for (let n = 0; n < count && p + 46 <= u8.length; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    let csize = dv.getUint32(p + 20, true);
    let usize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    let local = dv.getUint32(p + 42, true);
    const name = td.decode(u8.subarray(p + 46, p + 46 + nameLen));
    let e = p + 46 + nameLen;
    const end = e + extraLen;
    while (e + 4 <= end) {
      const id = dv.getUint16(e, true);
      const size = dv.getUint16(e + 2, true);
      if (id === 0x0001) {
        let q = e + 4;
        if (usize === 0xffffffff) { usize = Number(dv.getBigUint64(q, true)); q += 8; }
        if (csize === 0xffffffff) { csize = Number(dv.getBigUint64(q, true)); q += 8; }
        if (local === 0xffffffff) { local = Number(dv.getBigUint64(q, true)); q += 8; }
      }
      e += 4 + size;
    }
    entries.set(partKey(name), { name, method, csize, local });
    p += 46 + nameLen + extraLen + commentLen;
  }

  return {
    names: [...entries.values()].map((x) => x.name),
    async read(name) {
      const ent = entries.get(partKey(name));
      if (!ent) return null;
      const lp = ent.local;
      if (dv.getUint32(lp, true) !== 0x04034b50) throw new Error(`3MF: damaged zip entry ${ent.name}`);
      const start = lp + 30 + dv.getUint16(lp + 26, true) + dv.getUint16(lp + 28, true);
      const data = u8.subarray(start, start + ent.csize);
      if (ent.method === 0) return data;
      if (ent.method !== 8) throw new Error(`3MF: unsupported compression in ${ent.name}`);
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    },
  };
}

/** Merge identical vertices (exact bit match) and drop degenerate triangles. */
export function weld(soup) {
  const nv = soup.length / 3;
  let cap = 16;
  while (cap < nv * 2) cap <<= 1;
  const mask = cap - 1;
  const table = new Int32Array(cap).fill(-1);
  const pos = new Float32Array(soup.length);
  const bits = new Uint32Array(pos.buffer);
  const remap = new Uint32Array(nv);
  const tmp = new Float32Array(3);
  const tb = new Uint32Array(tmp.buffer);
  let count = 0;
  for (let i = 0; i < nv; i++) {
    tmp[0] = soup[3 * i] + 0; // + 0 folds -0 into 0
    tmp[1] = soup[3 * i + 1] + 0;
    tmp[2] = soup[3 * i + 2] + 0;
    const a = tb[0], b = tb[1], c = tb[2];
    let h = (Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791)) & mask;
    for (;;) {
      const e = table[h];
      if (e === -1) {
        table[h] = count;
        bits[3 * count] = a; bits[3 * count + 1] = b; bits[3 * count + 2] = c;
        remap[i] = count++;
        break;
      }
      if (bits[3 * e] === a && bits[3 * e + 1] === b && bits[3 * e + 2] === c) { remap[i] = e; break; }
      h = (h + 1) & mask;
    }
  }
  const nf = nv / 3;
  const idx = new Uint32Array(nf * 3);
  let fc = 0;
  for (let f = 0; f < nf; f++) {
    const i0 = remap[3 * f], i1 = remap[3 * f + 1], i2 = remap[3 * f + 2];
    if (i0 === i1 || i1 === i2 || i0 === i2) continue;
    idx[3 * fc] = i0; idx[3 * fc + 1] = i1; idx[3 * fc + 2] = i2;
    fc++;
  }
  return { positions: pos.slice(0, count * 3), indices: idx.slice(0, fc * 3), strain: new Float32Array(fc) };
}

/* --------------------------------------------------------------- measuring */

export function bbox(mesh) {
  const P = mesh.positions;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = P[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  if (!P.length) return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0], center: [0, 0, 0] };
  return {
    min, max,
    size: [0, 1, 2].map((k) => max[k] - min[k]),
    center: [0, 1, 2].map((k) => (max[k] + min[k]) / 2),
  };
}

/** Centre X/Y on the origin and sit the model on Z = 0. */
export function normalizePlacement(mesh) {
  const b = bbox(mesh);
  const t = [-b.center[0], -b.center[1], -b.min[2]];
  const P = new Float32Array(mesh.positions);
  for (let i = 0; i < P.length; i += 3) { P[i] += t[0]; P[i + 1] += t[1]; P[i + 2] += t[2]; }
  return { positions: P, indices: mesh.indices, strain: mesh.strain, offset: t };
}

/** Edge topology check. Watertight = every edge shared by exactly two consistently wound faces. */
export function checkMesh(mesh) {
  const I = mesh.indices, nf = I.length / 3;
  let cap = 16;
  while (cap < nf * 4) cap <<= 1;
  const mask = cap - 1;
  const kl = new Int32Array(cap).fill(-1), kh = new Int32Array(cap), cnt = new Int32Array(cap), dir = new Int32Array(cap);
  for (let f = 0; f < nf; f++) {
    for (let k = 0; k < 3; k++) {
      const u = I[3 * f + k], v = I[3 * f + ((k + 1) % 3)];
      const lo = u < v ? u : v, hi = u < v ? v : u;
      let h = (Math.imul(lo, -1640531535) ^ Math.imul(hi, -2048144777)) & mask;
      while (kl[h] !== -1 && (kl[h] !== lo || kh[h] !== hi)) h = (h + 1) & mask;
      if (kl[h] === -1) { kl[h] = lo; kh[h] = hi; }
      cnt[h]++;
      dir[h] += u < v ? 1 : -1;
    }
  }
  let boundary = 0, nonManifold = 0, flipped = 0;
  for (let h = 0; h < cap; h++) {
    if (kl[h] === -1) continue;
    if (cnt[h] === 1) boundary++;
    else if (cnt[h] > 2) nonManifold++;
    else if (dir[h] !== 0) flipped++;
  }
  return { boundary, nonManifold, flipped, watertight: boundary === 0 && nonManifold === 0 && flipped === 0 };
}

export function volume(mesh) {
  const P = mesh.positions, I = mesh.indices;
  let v = 0;
  for (let f = 0; f < I.length; f += 3) {
    const a = 3 * I[f], b = 3 * I[f + 1], c = 3 * I[f + 2];
    v += P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1])
       - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c])
       + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]);
  }
  return v / 6;
}

/* -------------------------------------------------------------- operations */
//
// Every shaping step works through one box: its tool. The tool points along an
// axis (X, Y or Z), can be tilted, and its box says where the step acts.
//
//   stretch  The box's length along the axis is the stretch zone. It grows by
//            `amount`; the model beyond it slides along, and `keep` says which
//            end stays still (start, middle or end). The box's other two sides
//            limit which part of the model is affected.
//   taper    A stretch whose amount ramps from `amountStart` to `amountEnd`
//            across the box along `vary`.
//   move     Everything in the box moves `amount` along the axis.
//   mirror   Cut at a plane (`at` along the axis) and reflect the kept `side`.
//
// Box bounds are in the tool's frame. With no tilt that is plain world X/Y/Z.
// A null bound means no limit. `soft` is how far past a limit the step fades out.
//
// Rigid zones are boxes defined once on the starting shape. Every step keeps
// them rigid (each moves as one piece) unless the step lists it in `rigidExcept`.
// Zones travel with the model from step to step.

const r1 = (v) => Math.round(v * 10) / 10;
const num = (v, d = 0) => (v === null || v === '' || v === undefined || !Number.isFinite(+v) ? d : +v);
const isSet = (v) => v !== null && v !== '' && v !== undefined && Number.isFinite(+v);
const smooth = (t) => t * t * (3 - 2 * t);
const fmt = (v) => (Math.round(v * 100) / 100).toString();
const clone = (o) => JSON.parse(JSON.stringify(o));

const MIN_ZONE = 1;          // mm: narrowest stretch zone
const MIN_SOFT = 1;          // mm: hardest edge a limit or rigid zone can have
const REFINE_TOL = 0.03;     // mm: how far a flat triangle may sit from the true shape
const REFINE_MIN_EDGE = 0.4; // mm: edges shorter than this are never split
const ZONE_EDGE = 4;         // mm: longest edge allowed where it passes near a rigid zone

export const OP_TYPES = ['stretch', 'taper', 'move', 'mirror'];
const OTHER = [[1, 2], [0, 2], [0, 1]]; // the two axes across each axis
const DEFAULT_BB = { min: [-10, -10, 0], max: [10, 10, 10], center: [0, 0, 5], size: [20, 20, 10] };

function axisOf(name) {
  const a = AX[name];
  if (a === undefined) throw new Error(`axis must be x, y or z (got "${name}")`);
  return a;
}

const emptyBox = () => ({ min: [null, null, null], max: [null, null, null] });

/** A sensible new step of `type`, sized to the model `b` (a bbox) it will act on. */
export function defaultOp(type, b = DEFAULT_BB) {
  const c = b.center.map(r1);
  const zoneBoxAt = (a, half = 5) => {
    const box = emptyBox();
    box.min[a] = r1(c[a] - half);
    box.max[a] = r1(c[a] + half);
    return box;
  };
  switch (type) {
    case 'stretch':
      return { type, enabled: true, axis: 'x', tilt: [0, 0], box: zoneBoxAt(0), soft: 10, amount: 4, keep: 'middle', rigidExcept: [] };
    case 'taper':
      return { type, enabled: true, axis: 'x', tilt: [0, 0], box: zoneBoxAt(0), soft: 10, vary: 'y', amountStart: 0, amountEnd: -4, keep: 'middle', rigidExcept: [] };
    case 'move':
      return { type, enabled: true, axis: 'z', tilt: [0, 0], box: emptyBox(), soft: 10, amount: -2, rigidExcept: [] };
    case 'mirror':
      return { type, enabled: true, axis: 'x', tilt: [0, 0], at: c[0], side: 'pos' };
    default:
      throw new Error(`Unknown step "${type}"`);
  }
}

/* ---- orientation: which way is front and up, as a signed permutation ---- */

export const IDENTITY_ORIENTATION = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const QUARTER = {
  x: [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
  y: [[0, 0, 1], [0, 1, 0], [-1, 0, 0]],
  z: [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
};
const mat3mul = (A, B) => A.map((row) => [0, 1, 2].map((c) => row[0] * B[0][c] + row[1] * B[1][c] + row[2] * B[2][c]));

/** Orientation after a further quarter turn about `axis`. */
export function turnOrientation(M, axis) {
  return mat3mul(QUARTER[axis], validOrientation(M));
}

export function validOrientation(M) {
  if (!Array.isArray(M) || M.length !== 3) return clone(IDENTITY_ORIENTATION);
  const ok = M.every((r) => Array.isArray(r) && r.length === 3 && r.every((v) => v === 0 || v === 1 || v === -1));
  if (!ok) return clone(IDENTITY_ORIENTATION);
  const det = M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
  return det === 1 && M.every((r) => r.filter(Boolean).length === 1) ? M.map((r) => [...r]) : clone(IDENTITY_ORIENTATION);
}

export const isIdentityOrientation = (M) => JSON.stringify(validOrientation(M)) === JSON.stringify(IDENTITY_ORIENTATION);

/** Turn the model to `M` and sit it back on the mat, centred. */
export function orient(mesh, M) {
  const R = validOrientation(M);
  if (isIdentityOrientation(R)) return mesh;
  const P = mesh.positions, out = new Float32Array(P.length);
  for (let i = 0; i < P.length; i += 3) {
    for (let r = 0; r < 3; r++) out[i + r] = R[r][0] * P[i] + R[r][1] * P[i + 1] + R[r][2] * P[i + 2];
  }
  const placed = normalizePlacement({ positions: out, indices: mesh.indices, strain: mesh.strain });
  delete placed.offset;
  return placed;
}

/* ---- rigid zones ---- */

/** A rigid zone: a box on the starting shape that steps move as one piece. */
export function makeZone(id, name, center, size = [8, 8, 8], blend = 3) {
  return { id, name, center: center.map(r1), size: [...size], blend };
}

export function zoneBox(z) {
  const c = (z.center || [0, 0, 0]).map((v) => num(v));
  const s = (z.size || [8, 8, 8]).map((v) => Math.max(0, num(v)));
  return { id: z.id, min: c.map((v, k) => v - s[k] / 2), max: c.map((v, k) => v + s[k] / 2), blend: Math.max(MIN_SOFT, num(z.blend, 3)) };
}

/** How many of the model's points sit inside a zone. */
export function zoneHolds(mesh, z) {
  const b = zoneBox(z), P = mesh.positions;
  let n = 0;
  for (let i = 0; i < P.length; i += 3) {
    if (P[i] >= b.min[0] && P[i] <= b.max[0] && P[i + 1] >= b.min[1] && P[i + 1] <= b.max[1] && P[i + 2] >= b.min[2] && P[i + 2] <= b.max[2]) n++;
  }
  return n;
}

const cloneZoneBox = (z) => ({ id: z.id, min: [...z.min], max: [...z.max], blend: z.blend });
const zoneCenter = (z) => [0, 1, 2].map((k) => (z.min[k] + z.max[k]) / 2);

function zoneWeight(p, z) {
  let d2 = 0;
  for (let k = 0; k < 3; k++) {
    const d = p[k] < z.min[k] ? z.min[k] - p[k] : p[k] > z.max[k] ? p[k] - z.max[k] : 0;
    d2 += d * d;
  }
  if (d2 === 0) return 1;
  const d = Math.sqrt(d2);
  return d >= z.blend ? 0 : smooth(1 - d / z.blend);
}

/* ---- the tool frame ---- */

function rotAbout(k, deg) {
  const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  if (k === 0) return [[1, 0, 0], [0, c, -s], [0, s, c]];
  if (k === 1) return [[c, 0, s], [0, 1, 0], [-s, 0, c]];
  return [[c, -s, 0], [s, c, 0], [0, 0, 1]];
}
const unit = (k) => [0, 1, 2].map((i) => (i === k ? 1 : 0));
const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];

/** The point a tilted tool turns about: the centre of its box (model centre where unbounded). */
export function defaultPivot(op, bb) {
  const c = [...bb.center];
  if (op.type === 'mirror') { c[axisOf(op.axis)] = num(op.at); return c; }
  const box = op.box || emptyBox();
  for (let k = 0; k < 3; k++) {
    const lo = isSet(box.min[k]) ? +box.min[k] : bb.min[k];
    const hi = isSet(box.max[k]) ? +box.max[k] : bb.max[k];
    if (lo <= hi) c[k] = (lo + hi) / 2;
  }
  return c;
}

/**
 * The step's frame. `tilt` is two angles in degrees: about the first and the
 * second of the other two axes (for X: about Y, then about Z). With no tilt the
 * frame is the world, so box numbers are plain coordinates.
 */
export function toolFrame(op, bb = DEFAULT_BB) {
  const a = axisOf(op.axis);
  const [v, w] = OTHER[a];
  const t = op.tilt || [0, 0];
  const t0 = num(t[0]), t1 = num(t[1]);
  if (Math.abs(t0) < 1e-9 && Math.abs(t1) < 1e-9) {
    return {
      a, v, w, tilted: false, q: [0, 0, 0], dir: unit(a),
      axisDir: unit,
      into: (p, out) => { out[0] = p[0]; out[1] = p[1]; out[2] = p[2]; return out; },
      toWorld: (f) => [f[0], f[1], f[2]],
    };
  }
  const R = mat3mul(rotAbout(w, t1), rotAbout(v, t0));
  const q = Array.isArray(op.pivot) && op.pivot.length === 3 ? op.pivot.map((x) => num(x)) : defaultPivot(op, bb);
  const axisDir = (k) => [R[0][k], R[1][k], R[2][k]];
  return {
    a, v, w, tilted: true, q, R, dir: axisDir(a), axisDir,
    // frame = Rᵀ (p − q) + q
    into: (p, out) => {
      const x = p[0] - q[0], y = p[1] - q[1], z = p[2] - q[2];
      out[0] = R[0][0] * x + R[1][0] * y + R[2][0] * z + q[0];
      out[1] = R[0][1] * x + R[1][1] * y + R[2][1] * z + q[1];
      out[2] = R[0][2] * x + R[1][2] * y + R[2][2] * z + q[2];
      return out;
    },
    toWorld: (f) => {
      const x = f[0] - q[0], y = f[1] - q[1], z = f[2] - q[2];
      return [0, 1, 2].map((r) => R[r][0] * x + R[r][1] * y + R[r][2] * z + q[r]);
    },
  };
}

/** The model's extent measured in the tool's frame. */
export function frameExtent(bb, F) {
  if (!F.tilted) return { min: [...bb.min], max: [...bb.max] };
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity], f = [0, 0, 0];
  for (const x of [bb.min[0], bb.max[0]]) for (const y of [bb.min[1], bb.max[1]]) for (const z of [bb.min[2], bb.max[2]]) {
    F.into([x, y, z], f);
    for (let k = 0; k < 3; k++) { if (f[k] < min[k]) min[k] = f[k]; if (f[k] > max[k]) max[k] = f[k]; }
  }
  return { min, max };
}

// A world plane { n·p = off } equal to the frame plane { f[k] = c }.
function framePlane(F, k, c) {
  const n = F.axisDir(k);
  return { n, off: F.tilted ? c - F.q[k] + dot(n, F.q) : c };
}

/**
 * The step's displacement field: f(p) is how far point p moves along `dir`.
 * Also returns the planes where the field has a crease, so the mesh can be
 * cut there exactly before anything moves.
 */
export function makeField(op, bb = DEFAULT_BB) {
  const F = toolFrame(op, bb);
  const a = F.a;
  const box = op.box || emptyBox();
  const soft = Math.max(MIN_SOFT, num(op.soft, 10));
  const lo = [0, 1, 2].map((k) => (isSet(box.min[k]) ? +box.min[k] : -Infinity));
  const hi = [0, 1, 2].map((k) => (isSet(box.max[k]) ? +box.max[k] : Infinity));
  const limitAxes = op.type === 'move' ? [0, 1, 2] : [F.v, F.w];
  const notes = [];
  const planes = [];
  for (const k of limitAxes) {
    if (lo[k] > -Infinity) planes.push([k, lo[k]], [k, lo[k] - soft]);
    if (hi[k] < Infinity) planes.push([k, hi[k]], [k, hi[k] + soft]);
  }
  const fp = [0, 0, 0];
  const weight = () => {
    let w = 1;
    for (const k of limitAxes) {
      const c = fp[k];
      const d = c < lo[k] ? lo[k] - c : c > hi[k] ? c - hi[k] : 0;
      if (d > 0) {
        if (d >= soft) return 0;
        w *= smooth(1 - d / soft);
      }
    }
    return w;
  };
  const done = (f) => ({ F, dir: F.dir, notes, cuts: planes.map(([k, c]) => framePlane(F, k, c)), f });

  if (op.type === 'move') {
    const A = num(op.amount);
    return done((p) => { F.into(p, fp); const w = weight(); return w ? A * w : 0; });
  }
  if (op.type !== 'stretch' && op.type !== 'taper') throw new Error(`"${op.type}" doesn't move points`);

  if (!isSet(box.min[a]) || !isSet(box.max[a])) throw new Error('set where the stretch zone starts and ends');
  let z0 = Math.min(+box.min[a], +box.max[a]), z1 = Math.max(+box.min[a], +box.max[a]);
  const widen = (L, why) => { const c = (z0 + z1) / 2; z0 = c - L / 2; z1 = c + L / 2; notes.push(why); };
  if (z1 - z0 < MIN_ZONE) widen(MIN_ZONE, `Stretch zone widened to ${MIN_ZONE} mm.`);

  let A0, A1, vary = -1, vlo = 0, vhi = 1;
  if (op.type === 'stretch') {
    A0 = A1 = num(op.amount);
  } else {
    vary = axisOf(op.vary);
    if (vary === a) throw new Error('taper: "varies along" must be a different axis');
    A0 = num(op.amountStart);
    A1 = num(op.amountEnd);
    const ext = frameExtent(bb, F);
    vlo = isSet(box.min[vary]) ? +box.min[vary] : ext.min[vary];
    vhi = isSet(box.max[vary]) ? +box.max[vary] : ext.max[vary];
    if (vhi - vlo < 1e-6) throw new Error('taper: the box needs some length to vary along');
  }
  const minA = Math.min(A0, A1);
  // Shrinking compresses the zone; keep it to half its length so nothing folds.
  if (minA < -(z1 - z0) / 2) widen(-2 * minA, `Stretch zone widened to ${fmt(-2 * minA)} mm so the shrink can't fold the shell.`);
  planes.push([a, z0], [a, z1]);
  const L = z1 - z0;
  const k0 = op.keep === 'start' ? 0 : op.keep === 'end' ? -1 : -0.5;
  return done((p) => {
    F.into(p, fp);
    const w = weight();
    if (!w) return 0;
    const t = fp[a];
    const s = t <= z0 ? 0 : t >= z1 ? 1 : (t - z0) / L;
    let A = A0;
    if (vary >= 0) {
      let u = (fp[vary] - vlo) / (vhi - vlo);
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      A = A0 + (A1 - A0) * u;
    }
    return w * A * (s + k0);
  });
}

/* ---- running the steps ---- */

/**
 * Run the plan's steps (up to index `upTo`, exclusive) over `base`.
 * `plan` is { zones, ops }. `cache` (optional array) reuses unchanged prefixes.
 * Returns the mesh, the zones as they stand at the end, a note per step, and a
 * per-step trace of the input bbox and zones (for drawing overlays).
 */
export function evaluate(base, plan, upTo = (plan.ops || []).length, cache = null) {
  const ops = plan.ops || [];
  let zones = (plan.zones || []).map(zoneBox);
  let mesh = base;
  // Names and labels don't change geometry, so renaming never recomputes.
  let sig = JSON.stringify(plan.zones || [], (k, v) => (k === 'name' ? undefined : v));
  const notes = [], trace = [];
  const n = Math.min(upTo, ops.length);
  for (let i = 0; i < n; i++) {
    const op = ops[i];
    sig += '|' + JSON.stringify(op, (k, v) => (k === 'label' ? undefined : v));
    const hit = cache && cache[i] && cache[i].sig === sig ? cache[i] : null;
    if (hit) {
      trace.push(hit.trace);
      notes.push(hit.note);
      mesh = hit.mesh; zones = hit.zones;
      continue;
    }
    const bb = bbox(mesh);
    const t = { bbox: bb, zones: zones.map(cloneZoneBox) };
    let note = '';
    if (op.enabled !== false) {
      try {
        const r = op.type === 'mirror' ? mirrorOp(mesh, op, zones, bb) : deformOp(mesh, op, zones, bb);
        mesh = r.mesh; zones = r.zones; note = r.note || '';
      } catch (e) {
        note = 'Error: ' + e.message;
      }
    }
    trace.push(t);
    notes.push(note);
    if (cache) { cache[i] = { sig, mesh, zones, note, trace: t }; cache.length = i + 1; }
  }
  return { mesh, zones, notes, trace };
}

function deformOp(mesh, op, zones, bb) {
  if (!OP_TYPES.includes(op.type)) throw new Error(`Unknown step "${op.type}"`);
  const field = makeField(op, bb);
  const dir = field.dir;
  const except = new Set(op.rigidExcept || []);
  const rigid = zones.filter((z) => !except.has(z.id)).map((z) => ({ z, d: field.f(zoneCenter(z)) }));
  // Inside a rigid zone a point moves with the zone's centre instead of deforming.
  const F = (p) => {
    let d = field.f(p);
    if (rigid.length) {
      let best = 0, bd = 0;
      for (const r of rigid) {
        const w = zoneWeight(p, r.z);
        if (w > best) { best = w; bd = r.d; }
      }
      if (best > 0) d += (bd - d) * best;
    }
    return d;
  };

  // Automatic refining: cut exactly where the field creases, then split only
  // where a triangle would sit visibly off the bent shape.
  let m = mesh;
  for (const c of field.cuts) m = slice(m, c.n, c.off);
  m = refineForField(m, F, dir, rigid.map((r) => r.z));

  const P = m.positions, nv = P.length / 3;
  const out = new Float32Array(P);
  const disp = m.disp ? new Float32Array(m.disp) : new Float32Array(P.length);
  const lastMove = new Float32Array(nv);
  const p = [0, 0, 0];
  let moved = 0;
  for (let v = 0; v < nv; v++) {
    p[0] = P[3 * v]; p[1] = P[3 * v + 1]; p[2] = P[3 * v + 2];
    const d = F(p);
    if (!d) continue;
    for (let k = 0; k < 3; k++) { out[3 * v + k] += d * dir[k]; disp[3 * v + k] += d * dir[k]; }
    lastMove[v] = Math.abs(d);
    if (Math.abs(d) > 1e-4) moved++;
  }

  const nextZones = zones.map((z) => {
    const r = rigid.find((x) => x.z === z);
    const d = r ? r.d : F(zoneCenter(z));
    const q = cloneZoneBox(z);
    for (let k = 0; k < 3; k++) { q.min[k] += d * dir[k]; q.max[k] += d * dir[k]; }
    return q;
  });
  const notes = [...field.notes];
  if (!moved) notes.push('Nothing moved. Check the box, the amount and the limits.');
  return {
    mesh: { positions: out, indices: m.indices, strain: addStrain(m, out), disp, lastMove },
    zones: nextZones,
    note: notes.join(' '),
  };
}

// Per-face strain: the largest relative change in any edge length, accumulated across steps.
function addStrain(mesh, next) {
  const P = mesh.positions, I = mesh.indices;
  const S = new Float32Array(mesh.strain);
  const len = (A, i, j) => {
    const dx = A[3 * i] - A[3 * j], dy = A[3 * i + 1] - A[3 * j + 1], dz = A[3 * i + 2] - A[3 * j + 2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  };
  for (let f = 0; f < S.length; f++) {
    const i0 = I[3 * f], i1 = I[3 * f + 1], i2 = I[3 * f + 2];
    let s = 0;
    for (const [i, j] of [[i0, i1], [i1, i2], [i2, i0]]) {
      // Measure against at least 0.05 mm so microscopic slivers don't read as wildly strained.
      const l0 = len(P, i, j);
      const r = Math.abs(len(next, i, j) - l0) / Math.max(l0, 0.05);
      if (r > s) s = r;
    }
    S[f] += s;
  }
  return S;
}

/**
 * Cut the mesh along the plane { n·p = off }, keeping both sides. Cut points are
 * shared by the faces either side of each edge, so watertight stays watertight.
 */
export function slice(mesh, n, off) {
  const P = mesh.positions, I = mesh.indices, S = mesh.strain, D = mesh.disp;
  const nv = P.length / 3, nf = I.length / 3;
  const dist = new Float64Array(nv);
  let pos = false, neg = false;
  for (let v = 0; v < nv; v++) {
    let d = n[0] * P[3 * v] + n[1] * P[3 * v + 1] + n[2] * P[3 * v + 2] - off;
    if (d > -1e-3 && d < 1e-3) d = 0;
    dist[v] = d;
    if (d > 0) pos = true; else if (d < 0) neg = true;
  }
  if (!pos || !neg) return mesh;
  const extraP = [], extraD = [];
  const cuts = new Map();
  const cut = (i, j) => {
    const lo = i < j ? i : j, hi = i < j ? j : i;
    const key = lo * nv + hi;
    let v = cuts.get(key);
    if (v === undefined) {
      const t = dist[lo] / (dist[lo] - dist[hi]);
      v = nv + extraP.length / 3;
      for (let k = 0; k < 3; k++) extraP.push(P[3 * lo + k] + t * (P[3 * hi + k] - P[3 * lo + k]));
      if (D) for (let k = 0; k < 3; k++) extraD.push(D[3 * lo + k] + t * (D[3 * hi + k] - D[3 * lo + k]));
      cuts.set(key, v);
    }
    return v;
  };
  const tris = [], tS = [];
  for (let f = 0; f < nf; f++) {
    const id = [I[3 * f], I[3 * f + 1], I[3 * f + 2]];
    const d = [dist[id[0]], dist[id[1]], dist[id[2]]];
    const crosses = (d[0] > 0 || d[1] > 0 || d[2] > 0) && (d[0] < 0 || d[1] < 0 || d[2] < 0);
    if (!crosses) { tris.push(id[0], id[1], id[2]); tS.push(S[f]); continue; }
    for (const sg of [1, -1]) {
      const poly = [];
      for (let k = 0; k < 3; k++) {
        const k2 = (k + 1) % 3;
        if (sg * d[k] >= 0) poly.push(id[k]);
        if (d[k] * d[k2] < 0) poly.push(cut(id[k], id[k2]));
      }
      for (let k = 1; k + 1 < poly.length; k++) { tris.push(poly[0], poly[k], poly[k + 1]); tS.push(S[f]); }
    }
  }
  const outP = new Float32Array(P.length + extraP.length);
  outP.set(P); outP.set(extraP, P.length);
  let outD = null;
  if (D) { outD = new Float32Array(D.length + extraD.length); outD.set(D); outD.set(extraD, D.length); }
  return { positions: outP, indices: new Uint32Array(tris), strain: new Float32Array(tS), disp: outD };
}

/**
 * One pass of midpoint subdivision on the edges `split(i, j)` picks. Both faces
 * that share an edge see the same decision and the same midpoint, so the mesh
 * stays watertight. Shape is unchanged.
 */
export function subdivide(mesh, split) {
  const P = Array.from(mesh.positions);
  const D = mesh.disp ? Array.from(mesh.disp) : null;
  const I = mesh.indices, S = mesh.strain;
  const nv = P.length / 3, nf = I.length / 3;
  const mids = new Map();
  const mid = (i, j) => {
    const lo = i < j ? i : j, hi = i < j ? j : i;
    const key = lo * nv + hi;
    let v = mids.get(key);
    if (v === undefined) {
      v = P.length / 3;
      for (let k = 0; k < 3; k++) P.push((P[3 * lo + k] + P[3 * hi + k]) / 2);
      if (D) for (let k = 0; k < 3; k++) D.push((D[3 * lo + k] + D[3 * hi + k]) / 2);
      mids.set(key, v);
    }
    return v;
  };
  const out = [], outS = [];
  const tri = (a, b, c, s) => { out.push(a, b, c); outS.push(s); };
  let any = false;
  for (let f = 0; f < nf; f++) {
    let a = I[3 * f], b = I[3 * f + 1], c = I[3 * f + 2];
    let m = (split(a, b) ? 1 : 0) | (split(b, c) ? 2 : 0) | (split(c, a) ? 4 : 0);
    const s = S[f];
    if (!m) { tri(a, b, c, s); continue; }
    any = true;
    if (m === 7) {
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      tri(a, ab, ca, s); tri(ab, b, bc, s); tri(ca, bc, c, s); tri(ab, bc, ca, s);
      continue;
    }
    // Rotate so the split edges start at edge ab.
    while (m !== 1 && m !== 3) {
      [a, b, c] = [b, c, a];
      m = ((m >> 1) | ((m & 1) << 2)) & 7;
    }
    if (m === 1) {
      const ab = mid(a, b);
      tri(ab, b, c, s); tri(ab, c, a, s);
    } else {
      const ab = mid(a, b), bc = mid(b, c);
      tri(ab, b, bc, s); tri(ab, bc, c, s); tri(ab, c, a, s);
    }
  }
  if (!any) return mesh;
  return { positions: new Float32Array(P), indices: new Uint32Array(out), strain: new Float32Array(outS), disp: D ? new Float32Array(D) : null };
}

/** Split edges longer than `maxEdge` until none remain (uniform refining). */
export function refine(mesh, maxEdge, maxFaces = 4e6) {
  const L2 = maxEdge * maxEdge;
  let m = mesh;
  for (let pass = 0; pass < 16; pass++) {
    const P = m.positions;
    const next = subdivide(m, (i, j) => {
      const dx = P[3 * i] - P[3 * j], dy = P[3 * i + 1] - P[3 * j + 1], dz = P[3 * i + 2] - P[3 * j + 2];
      return dx * dx + dy * dy + dz * dz > L2;
    });
    if (next === m) break;
    m = next;
    if (m.indices.length / 3 > maxFaces) throw new Error(`refine: would exceed ${maxFaces.toLocaleString()} faces`);
  }
  return m;
}

// Does the segment p→q pass through the box?
function segHitsBox(p, q, min, max) {
  let t0 = 0, t1 = 1;
  for (let k = 0; k < 3; k++) {
    const d = q[k] - p[k];
    if (Math.abs(d) < 1e-12) {
      if (p[k] < min[k] || p[k] > max[k]) return false;
    } else {
      let a = (min[k] - p[k]) / d, b = (max[k] - p[k]) / d;
      if (a > b) [a, b] = [b, a];
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) return false;
    }
  }
  return true;
}

/**
 * Split edges until moving the vertices along `dir` by F reproduces the bent
 * shape to within REFINE_TOL. The error is measured across the surface (a flat
 * face sliding within its own plane needs no new points), and edges near rigid
 * zones are kept short so the zone's blend ring has points to bend.
 */
function refineForField(mesh, F, dir, zones, maxFaces = 3e6) {
  let m = mesh;
  const near = zones.map((z) => ({ min: z.min.map((v) => v - z.blend), max: z.max.map((v) => v + z.blend) }));
  const minL2 = REFINE_MIN_EDGE * REFINE_MIN_EDGE, zoneL2 = ZONE_EDGE * ZONE_EDGE;
  const p = [0, 0, 0], pi = [0, 0, 0], pj = [0, 0, 0];
  for (let pass = 0; pass < 12; pass++) {
    const P = m.positions, I = m.indices, nv = P.length / 3, nf = I.length / 3;
    const fv = new Float64Array(nv);
    for (let v = 0; v < nv; v++) { p[0] = P[3 * v]; p[1] = P[3 * v + 1]; p[2] = P[3 * v + 2]; fv[v] = F(p); }
    const marks = new Set();
    for (let f = 0; f < nf; f++) {
      const i0 = I[3 * f], i1 = I[3 * f + 1], i2 = I[3 * f + 2];
      const ux = P[3 * i1] - P[3 * i0], uy = P[3 * i1 + 1] - P[3 * i0 + 1], uz = P[3 * i1 + 2] - P[3 * i0 + 2];
      const vx = P[3 * i2] - P[3 * i0], vy = P[3 * i2 + 1] - P[3 * i0 + 1], vz = P[3 * i2 + 2] - P[3 * i0 + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const nl = Math.hypot(nx, ny, nz);
      const g = nl > 0 ? Math.abs(nx * dir[0] + ny * dir[1] + nz * dir[2]) / nl : 1;
      for (const [i, j] of [[i0, i1], [i1, i2], [i2, i0]]) {
        const key = i < j ? i * nv + j : j * nv + i;
        if (marks.has(key)) continue;
        for (let k = 0; k < 3; k++) { pi[k] = P[3 * i + k]; pj[k] = P[3 * j + k]; }
        const l2 = (pi[0] - pj[0]) ** 2 + (pi[1] - pj[1]) ** 2 + (pi[2] - pj[2]) ** 2;
        if (l2 < minL2) continue;
        if (l2 > zoneL2 && near.some((b) => segHitsBox(pi, pj, b.min, b.max))) { marks.add(key); continue; }
        if (g < 1e-3) continue;
        let err = 0;
        for (const s of [0.25, 0.5, 0.75]) {
          for (let k = 0; k < 3; k++) p[k] = pi[k] + s * (pj[k] - pi[k]);
          const e = Math.abs(F(p) - (fv[i] + s * (fv[j] - fv[i])));
          if (e > err) err = e;
        }
        if (err * g > REFINE_TOL) marks.add(key);
      }
    }
    if (!marks.size) break;
    const keyNv = nv;
    m = subdivide(m, (i, j) => marks.has(i < j ? i * keyNv + j : j * keyNv + i));
    if (m.indices.length / 3 > maxFaces) throw new Error(`the edit needs more than ${maxFaces.toLocaleString()} faces; use a softer edge or a smaller amount`);
  }
  return m;
}

/**
 * Cut at a plane, keep one side and reflect it to make a symmetric whole. Cut
 * points are shared by both halves, so a watertight input gives a watertight output.
 */
function mirrorOp(mesh, op, zones, bb) {
  const F = toolFrame(op, bb);
  const a = F.a;
  const at = num(op.at);
  const sg = op.side === 'neg' ? -1 : 1;
  const { n, off } = framePlane(F, a, at);
  const P = mesh.positions, I = mesh.indices, S = mesh.strain, Dp = mesh.disp;
  const nv = P.length / 3, nf = I.length / 3;

  const dist = new Float64Array(nv);
  for (let i = 0; i < nv; i++) {
    const d = sg * (n[0] * P[3 * i] + n[1] * P[3 * i + 1] + n[2] * P[3 * i + 2] - off);
    dist[i] = d > -1e-5 && d < 1e-5 ? 0 : d;
  }

  const pos = [], dsp = [];
  const onPlane = [];
  const map = new Int32Array(nv).fill(-1);
  const keepVertex = (i) => {
    if (map[i] < 0) {
      map[i] = onPlane.length;
      pos.push(P[3 * i], P[3 * i + 1], P[3 * i + 2]);
      if (Dp) dsp.push(Dp[3 * i], Dp[3 * i + 1], Dp[3 * i + 2]);
      if (dist[i] === 0 && !F.tilted) pos[pos.length - 3 + a] = at;
      onPlane.push(dist[i] === 0 ? 1 : 0);
    }
    return map[i];
  };
  const cuts = new Map();
  const cutVertex = (i, j) => {
    const lo = i < j ? i : j, hi = i < j ? j : i; // canonical order: both faces get the same point
    const key = lo * nv + hi;
    let v = cuts.get(key);
    if (v === undefined) {
      const t = dist[lo] / (dist[lo] - dist[hi]);
      v = onPlane.length;
      for (let k = 0; k < 3; k++) pos.push(P[3 * lo + k] + t * (P[3 * hi + k] - P[3 * lo + k]));
      if (Dp) for (let k = 0; k < 3; k++) dsp.push(Dp[3 * lo + k] + t * (Dp[3 * hi + k] - Dp[3 * lo + k]));
      if (!F.tilted) pos[3 * v + a] = at;
      onPlane.push(1);
      cuts.set(key, v);
    }
    return v;
  };

  const tris = [];
  const tStrain = [];
  for (let f = 0; f < nf; f++) {
    const id = [I[3 * f], I[3 * f + 1], I[3 * f + 2]];
    const d = [dist[id[0]], dist[id[1]], dist[id[2]]];
    if (d[0] >= 0 && d[1] >= 0 && d[2] >= 0) {
      if (d[0] === 0 && d[1] === 0 && d[2] === 0) continue; // lies in the mirror plane
      tris.push(keepVertex(id[0]), keepVertex(id[1]), keepVertex(id[2]));
      tStrain.push(S[f]);
      continue;
    }
    if (d[0] <= 0 && d[1] <= 0 && d[2] <= 0) continue;
    const poly = [];
    for (let k = 0; k < 3; k++) {
      const k2 = (k + 1) % 3;
      if (d[k] >= 0) poly.push(keepVertex(id[k]));
      if ((d[k] > 0 && d[k2] < 0) || (d[k] < 0 && d[k2] > 0)) poly.push(cutVertex(id[k], id[k2]));
    }
    for (let k = 1; k + 1 < poly.length; k++) {
      tris.push(poly[0], poly[k], poly[k + 1]);
      tStrain.push(S[f]);
    }
  }
  if (!tris.length) throw new Error('mirror: nothing on the kept side of the plane');

  const reflectP = (x) => { const s = 2 * (dot(n, x) - off); return [x[0] - s * n[0], x[1] - s * n[1], x[2] - s * n[2]]; };
  const reflectV = (x) => { const s = 2 * dot(n, x); return [x[0] - s * n[0], x[1] - s * n[1], x[2] - s * n[2]]; };

  const K = onPlane.length;
  const twin = new Int32Array(K);
  let extra = 0;
  for (let v = 0; v < K; v++) twin[v] = onPlane[v] ? v : K + extra++;
  const outP = new Float32Array((K + extra) * 3);
  outP.set(pos);
  const outD = Dp ? new Float32Array((K + extra) * 3) : null;
  if (outD) outD.set(dsp);
  for (let v = 0; v < K; v++) {
    if (onPlane[v]) continue;
    const m = twin[v];
    const r = reflectP([pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]]);
    outP[3 * m] = r[0]; outP[3 * m + 1] = r[1]; outP[3 * m + 2] = r[2];
    if (!F.tilted) outP[3 * m + a] = 2 * at - pos[3 * v + a];
    if (outD) {
      const rd = reflectV([dsp[3 * v], dsp[3 * v + 1], dsp[3 * v + 2]]);
      outD[3 * m] = rd[0]; outD[3 * m + 1] = rd[1]; outD[3 * m + 2] = rd[2];
    }
  }
  const T = tris.length / 3;
  const outI = new Uint32Array(T * 6);
  outI.set(tris);
  for (let t = 0; t < T; t++) {
    // Reflection flips handedness, so reverse the winding to keep normals outward.
    outI[3 * (T + t)] = twin[tris[3 * t]];
    outI[3 * (T + t) + 1] = twin[tris[3 * t + 2]];
    outI[3 * (T + t) + 2] = twin[tris[3 * t + 1]];
  }
  const outS = new Float32Array(T * 2);
  outS.set(tStrain);
  outS.set(tStrain, T);

  // Zones on the kept side are copied to the mirrored side; zones on the discarded side go.
  const nextZones = [];
  for (const z of zones) {
    let kept = false, all = true;
    const corners = [];
    for (const x of [z.min[0], z.max[0]]) for (const y of [z.min[1], z.max[1]]) for (const zz of [z.min[2], z.max[2]]) {
      const c = [x, y, zz];
      corners.push(c);
      const d = sg * (dot(n, c) - off);
      if (d > 0) kept = true; else all = false;
    }
    if (!kept) continue;
    nextZones.push(cloneZoneBox(z));
    if (all) {
      const r = corners.map(reflectP);
      nextZones.push({
        id: z.id,
        min: [0, 1, 2].map((k) => Math.min(...r.map((c) => c[k]))),
        max: [0, 1, 2].map((k) => Math.max(...r.map((c) => c[k]))),
        blend: z.blend,
      });
    }
  }
  return {
    mesh: { positions: outP, indices: outI, strain: outS, disp: outD },
    zones: nextZones,
    note: `Kept ${T.toLocaleString()} faces, mirrored to ${(2 * T).toLocaleString()}.`,
  };
}

/* ------------------------------------------------------------------ export */

/** Binary STL. */
export function toSTL(mesh) {
  const P = mesh.positions, I = mesh.indices, nf = I.length / 3;
  const buf = new ArrayBuffer(84 + nf * 50);
  const dv = new DataView(buf);
  const header = 'Panelbeater export (binary STL, mm)';
  for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i));
  dv.setUint32(80, nf, true);
  let o = 84;
  for (let f = 0; f < nf; f++) {
    const a = 3 * I[3 * f], b = 3 * I[3 * f + 1], c = 3 * I[3 * f + 2];
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    for (const v of [nx, ny, nz, P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], P[c], P[c + 1], P[c + 2]]) {
      dv.setFloat32(o, v, true);
      o += 4;
    }
    o += 2;
  }
  return buf;
}

let CRC_TABLE = null;
function crc32(u8) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Uncompressed ZIP of [{ name, data }] where data is a string, ArrayBuffer or Uint8Array. */
export function zipStore(files) {
  const enc = new TextEncoder();
  const items = files.map((f) => {
    const data = typeof f.data === 'string' ? enc.encode(f.data) : new Uint8Array(f.data);
    return { name: enc.encode(f.name), data, crc: crc32(data) };
  });
  const size = items.reduce((s, it) => s + 30 + it.name.length + it.data.length + 46 + it.name.length, 22);
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  let o = 0;
  const offsets = [];
  for (const it of items) {
    offsets.push(o);
    dv.setUint32(o, 0x04034b50, true); dv.setUint16(o + 4, 20, true); dv.setUint16(o + 6, 0x0800, true);
    dv.setUint32(o + 14, it.crc, true); dv.setUint32(o + 18, it.data.length, true); dv.setUint32(o + 22, it.data.length, true);
    dv.setUint16(o + 26, it.name.length, true);
    u8.set(it.name, o + 30); u8.set(it.data, o + 30 + it.name.length);
    o += 30 + it.name.length + it.data.length;
  }
  const cd = o;
  items.forEach((it, i) => {
    dv.setUint32(o, 0x02014b50, true); dv.setUint16(o + 4, 20, true); dv.setUint16(o + 6, 20, true); dv.setUint16(o + 8, 0x0800, true);
    dv.setUint32(o + 16, it.crc, true); dv.setUint32(o + 20, it.data.length, true); dv.setUint32(o + 24, it.data.length, true);
    dv.setUint16(o + 28, it.name.length, true); dv.setUint32(o + 42, offsets[i], true);
    u8.set(it.name, o + 46);
    o += 46 + it.name.length;
  });
  dv.setUint32(o, 0x06054b50, true); dv.setUint16(o + 8, items.length, true); dv.setUint16(o + 10, items.length, true);
  dv.setUint32(o + 12, o - cd, true); dv.setUint32(o + 16, cd, true);
  return buf;
}

/* ----------------------------------------------------------------- recipes */

/**
 * A recipe is the model's orientation, its rigid zones and the step list as
 * JSON. Coordinates are in the centred frame `loadMesh` + `orient` produce, so
 * the same source file plus the same recipe always gives the same result, and
 * you can share a recipe without redistributing someone else's model.
 */
export function makeRecipe(plan, source = null) {
  return {
    app: 'panelbeater',
    version: RECIPE_VERSION,
    source,
    orientation: validOrientation(plan.orientation),
    zones: clone(plan.zones || []),
    ops: clone(plan.ops || []),
  };
}

const arr3 = (a) => [0, 1, 2].map((k) => (Array.isArray(a) && isSet(a[k]) ? +a[k] : null));

function normalizeZone(z, i) {
  return {
    id: String(z.id || `z${i + 1}`),
    name: String(z.name || `Zone ${i + 1}`),
    center: arr3(z.center).map((v) => v ?? 0),
    size: arr3(z.size).map((v) => v ?? 8),
    blend: num(z.blend, 3),
  };
}

function normalizeOp(op) {
  if (!OP_TYPES.includes(op.type)) throw new Error(`Unknown step "${op.type}" in recipe`);
  const base = defaultOp(op.type);
  const merged = { ...base, ...op };
  if (base.box) merged.box = { min: arr3(op.box && op.box.min), max: arr3(op.box && op.box.max) };
  merged.tilt = [num(op.tilt && op.tilt[0]), num(op.tilt && op.tilt[1])];
  if (base.rigidExcept) merged.rigidExcept = Array.isArray(op.rigidExcept) ? op.rigidExcept.map(String) : [];
  return merged;
}

/** Read a recipe (version 1 or 2). Version 1 recipes are converted. */
export function readRecipe(obj) {
  if (!obj || obj.app !== 'panelbeater' || !Array.isArray(obj.ops)) throw new Error('Not a Panelbeater recipe');
  const version = obj.version || 1;
  if (version > RECIPE_VERSION) throw new Error(`Recipe version ${version} is newer than this app supports (${RECIPE_VERSION})`);
  if (version < 2) return convertV1(obj);
  const zones = (obj.zones || []).map(normalizeZone);
  return { orientation: validOrientation(obj.orientation), zones, ops: obj.ops.map(normalizeOp), source: obj.source || null, notes: [] };
}

// Version 1 had Rotate, Refine and Pin as steps, and stretches defined by a
// split plane + band + side + region. Convert to the box model as closely as
// it maps; the results are close but not identical.
function convertV1(obj) {
  let orientation = clone(IDENTITY_ORIENTATION);
  const zones = [], ops = [], notes = ['Converted from an older recipe format, so results may differ slightly.'];
  let leading = true;
  for (const op of obj.ops) {
    const region = op.region || { min: [null, null, null], max: [null, null, null], falloff: 10 };
    const label = op.label ? { label: op.label } : {};
    const enabled = op.enabled !== false;
    switch (op.type) {
      case 'rotate': {
        if (!leading) { notes.push('A Rotate step after other steps was dropped.'); break; }
        const turns = ((Math.round(num(op.turns)) % 4) + 4) % 4;
        for (let t = 0; t < turns; t++) orientation = turnOrientation(orientation, op.axis);
        break;
      }
      case 'refine':
        break; // automatic now
      case 'pin': {
        const id = `z${zones.length + 1}`;
        zones.push(normalizeZone({ id, name: op.label || `Zone ${zones.length + 1}`, center: op.center, size: op.size, blend: op.falloff }, zones.length));
        // In version 1 a pin only affected the steps below it.
        for (const prev of ops) if (prev.rigidExcept) prev.rigidExcept.push(id);
        break;
      }
      case 'stretch':
      case 'taper': {
        leading = false;
        const a = axisOf(op.axis);
        const half = Math.max(num(op.band), 0.5);
        const box = { min: arr3(region.min), max: arr3(region.max) };
        box.min[a] = r1(num(op.at) - half);
        box.max[a] = r1(num(op.at) + half);
        const keep = op.side === 'pos' ? 'start' : op.side === 'neg' ? 'end' : 'middle';
        const v2 = { type: op.type, enabled, ...label, axis: op.axis, tilt: [0, 0], box, soft: num(region.falloff, 10), keep, rigidExcept: [] };
        if (op.type === 'stretch') v2.amount = num(op.amount);
        else {
          const b = axisOf(op.along);
          const from = num(op.from), to = num(op.to);
          box.min[b] = Math.min(from, to);
          box.max[b] = Math.max(from, to);
          v2.vary = op.along;
          v2.amountStart = from <= to ? num(op.amountFrom) : num(op.amountTo);
          v2.amountEnd = from <= to ? num(op.amountTo) : num(op.amountFrom);
        }
        ops.push(normalizeOp(v2));
        break;
      }
      case 'move':
        leading = false;
        ops.push(normalizeOp({ type: 'move', enabled, ...label, axis: op.axis, tilt: [0, 0], box: { min: arr3(region.min), max: arr3(region.max) }, soft: num(region.falloff, 10), amount: num(op.amount), rigidExcept: [] }));
        break;
      case 'mirror':
        leading = false;
        ops.push(normalizeOp({ type: 'mirror', enabled, ...label, axis: op.axis, tilt: [0, 0], at: num(op.at), side: op.keep === 'neg' ? 'neg' : 'pos' }));
        break;
      default:
        throw new Error(`Unknown step "${op.type}" in recipe`);
    }
  }
  return { orientation, zones, ops, source: obj.source || null, notes };
}
