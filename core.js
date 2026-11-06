// Panelbeater geometry core.
//
// Pure functions over indexed triangle meshes. No dependencies; runs in modern
// browsers and Node 18+. Units are millimetres throughout.
//
// Mesh shape:
//   { positions: Float32Array(3 * V), indices: Uint32Array(3 * F), strain: Float32Array(F) }
//
// `strain` is a per-face record of how much each triangle has been stretched by
// the operations applied so far (0 = untouched, 0.1 = an edge changed length by 10%).

export const RECIPE_VERSION = 1;
export const AXES = ['x', 'y', 'z'];
const AX = { x: 0, y: 1, z: 2 };
const PLANE_EPS = 1e-5; // vertices closer than this to a cut plane count as on it (mm)

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

const emptyRegion = () => ({ min: [null, null, null], max: [null, null, null], falloff: 10 });
const r1 = (v) => Math.round(v * 10) / 10;

/** A sensible new operation of `type`, sized to the mesh it will act on. */
export function defaultOp(type, b = { min: [-10, -10, 0], max: [10, 10, 10], center: [0, 0, 5] }) {
  switch (type) {
    case 'stretch': return { type, enabled: true, axis: 'x', at: 0, amount: 4, band: 0, side: 'both', region: emptyRegion() };
    case 'taper': return {
      type, enabled: true, axis: 'x', at: 0, band: 0, side: 'both',
      along: 'y', from: r1(b.min[1]), to: r1(b.max[1]), amountFrom: 0, amountTo: -4, region: emptyRegion(),
    };
    case 'move': return { type, enabled: true, axis: 'z', amount: -2, region: emptyRegion() };
    case 'mirror': return { type, enabled: true, axis: 'x', at: 0, keep: 'pos' };
    case 'rotate': return { type, enabled: true, axis: 'x', turns: 1 };
    case 'refine': return { type, enabled: true, maxEdge: 3 };
    case 'pin': return { type, enabled: true, center: b.center.map(r1), size: [8, 8, 8], falloff: 2 };
    default: throw new Error(`Unknown operation "${type}"`);
  }
}

export const OP_TYPES = ['rotate', 'refine', 'pin', 'stretch', 'taper', 'move', 'mirror'];

/**
 * Run `ops` (up to index `upTo`, exclusive) over `base`.
 * `cache` (optional array) reuses unchanged prefixes between calls.
 * Returns the final mesh, the pins active at the end, per-op notes, and a
 * per-op trace of the input bbox and active pins (for drawing overlays).
 */
export function evaluate(base, ops, upTo = ops.length, cache = null) {
  let mesh = base;
  let pins = [];
  let sig = '';
  const notes = [], trace = [];
  const n = Math.min(upTo, ops.length);
  for (let i = 0; i < n; i++) {
    const op = ops[i];
    sig += '|' + JSON.stringify(op);
    const hit = cache && cache[i] && cache[i].sig === sig ? cache[i] : null;
    if (hit) {
      trace.push(hit.trace);
      notes.push(hit.note);
      mesh = hit.mesh; pins = hit.pins;
      continue;
    }
    const t = { bbox: bbox(mesh), pins: pins.map(clonePin) };
    let note = '';
    if (op.enabled !== false) {
      try {
        const r = applyOp(mesh, op, pins);
        mesh = r.mesh; pins = r.pins; note = r.note || '';
      } catch (e) {
        note = 'Error: ' + e.message;
      }
    }
    trace.push(t);
    notes.push(note);
    if (cache) { cache[i] = { sig, mesh, pins, note, trace: t }; cache.length = i + 1; }
  }
  return { mesh, pins, notes, trace };
}

function applyOp(mesh, op, pins) {
  switch (op.type) {
    case 'rotate': return rotateOp(mesh, op, pins);
    case 'refine': return refineOp(mesh, op, pins);
    case 'pin': return { mesh, pins: [...pins, pinBox(op)], note: '' };
    case 'mirror': return mirrorOp(mesh, op, pins);
    case 'stretch':
    case 'taper':
    case 'move': return deformOp(mesh, op, pins);
    default: throw new Error(`Unknown operation "${op.type}"`);
  }
}

const num = (v, d = 0) => (v === null || v === '' || v === undefined || !Number.isFinite(+v) ? d : +v);
const clonePin = (p) => ({ min: [...p.min], max: [...p.max], falloff: p.falloff });
const smooth = (t) => t * t * (3 - 2 * t);
const fmt = (v) => (Math.round(v * 100) / 100).toString();

export function pinBox(op) {
  const c = (op.center || [0, 0, 0]).map((v) => num(v));
  const s = (op.size || [8, 8, 8]).map((v) => Math.max(0, num(v)));
  return { min: c.map((v, k) => v - s[k] / 2), max: c.map((v, k) => v + s[k] / 2), falloff: Math.max(0, num(op.falloff)) };
}

function axisOf(name) {
  const a = AX[name];
  if (a === undefined) throw new Error(`axis must be x, y or z (got "${name}")`);
  return a;
}

// Displacement along the op axis for a point at signed distance t from the pivot.
// `amount` is the total change in length across the pivot: positive grows, negative shrinks.
function profile(t, amount, band, side) {
  if (t > -PLANE_EPS && t < PLANE_EPS) t = 0;
  if (band <= 0) {
    if (side === 'pos') return t > 0 ? amount : 0;
    if (side === 'neg') return t < 0 ? -amount : 0;
    return t > 0 ? amount / 2 : t < 0 ? -amount / 2 : 0;
  }
  const s = t >= band ? 1 : t <= -band ? -1 : t / band;
  if (side === 'pos') return (s + 1) * 0.5 * amount;
  if (side === 'neg') return (s - 1) * 0.5 * amount;
  return s * 0.5 * amount;
}

function regionFn(region) {
  if (!region) return () => 1;
  const lo = [0, 1, 2].map((k) => num(region.min && region.min[k], -Infinity));
  const hi = [0, 1, 2].map((k) => num(region.max && region.max[k], Infinity));
  const f = Math.max(0, num(region.falloff));
  if (lo.every((v) => v === -Infinity) && hi.every((v) => v === Infinity)) return () => 1;
  return (p) => {
    let w = 1;
    for (let k = 0; k < 3; k++) {
      const c = p[k];
      const d = c < lo[k] ? lo[k] - c : c > hi[k] ? c - hi[k] : 0;
      if (d > 0) {
        if (d >= f) return 0;
        w *= smooth(1 - d / f);
      }
    }
    return w;
  };
}

function pinWeight(p, pin) {
  let d2 = 0;
  for (let k = 0; k < 3; k++) {
    const d = p[k] < pin.min[k] ? pin.min[k] - p[k] : p[k] > pin.max[k] ? p[k] - pin.max[k] : 0;
    d2 += d * d;
  }
  if (d2 === 0) return 1;
  if (pin.falloff <= 0) return 0;
  const d = Math.sqrt(d2);
  return d >= pin.falloff ? 0 : smooth(1 - d / pin.falloff);
}

/** Build the scalar displacement field for a stretch/taper/move op. */
export function makeField(op) {
  const a = axisOf(op.axis);
  const inRegion = regionFn(op.region);
  if (op.type === 'move') {
    const amount = num(op.amount);
    return { axis: a, note: '', f: (p) => amount * inRegion(p) };
  }
  const at = num(op.at);
  const side = op.side === 'pos' || op.side === 'neg' ? op.side : 'both';
  let band = Math.max(0, num(op.band));
  let note = '';
  const widen = (minAmount) => {
    // Shrinking through a band compresses it; keep compression <= 50% so nothing folds.
    if (minAmount < 0 && band < -minAmount) {
      band = -minAmount;
      note = `Band widened to ${fmt(band)} mm so the shrink can't fold the mesh.`;
    }
  };
  if (op.type === 'stretch') {
    const amount = num(op.amount);
    widen(amount);
    return { axis: a, note, f: (p) => { const w = inRegion(p); return w && w * profile(p[a] - at, amount, band, side); } };
  }
  if (op.type === 'taper') {
    const b = axisOf(op.along);
    if (b === a) throw new Error('taper: "along" must be a different axis from "axis"');
    const from = num(op.from), to = num(op.to);
    if (from === to) throw new Error('taper: "from" and "to" must differ');
    const a0 = num(op.amountFrom), a1 = num(op.amountTo);
    widen(Math.min(a0, a1));
    return {
      axis: a, note,
      f: (p) => {
        const w = inRegion(p);
        if (!w) return 0;
        let u = (p[b] - from) / (to - from);
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        return w * profile(p[a] - at, a0 + (a1 - a0) * u, band, side);
      },
    };
  }
  throw new Error(`"${op.type}" is not a deform op`);
}

function pinCenter(pin) {
  return [0, 1, 2].map((k) => (pin.min[k] + pin.max[k]) / 2);
}

function deformOp(mesh, op, pins) {
  const field = makeField(op);
  const a = field.axis;
  const P = mesh.positions;
  const out = new Float32Array(P);
  const pinned = pins.map((pin) => ({ pin, d: field.f(pinCenter(pin)) }));
  const p = [0, 0, 0];
  for (let i = 0; i < P.length; i += 3) {
    p[0] = P[i]; p[1] = P[i + 1]; p[2] = P[i + 2];
    let d = field.f(p);
    if (pinned.length) {
      // Rigid islands: inside a pin, move with the pin's centre instead of deforming.
      let best = 0, bd = 0;
      for (const q of pinned) {
        const w = pinWeight(p, q.pin);
        if (w > best) { best = w; bd = q.d; }
      }
      if (best > 0) d += (bd - d) * best;
    }
    if (d) out[i + a] = P[i + a] + d;
  }
  const nextPins = pinned.map(({ pin, d }) => {
    const q = clonePin(pin);
    q.min[a] += d; q.max[a] += d;
    return q;
  });
  return { mesh: { positions: out, indices: mesh.indices, strain: addStrain(mesh, out) }, pins: nextPins, note: field.note };
}

// Per-face strain: the largest relative change in any edge length, accumulated across ops.
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

const ROT90 = [
  (x, y, z) => [x, -z, y], // about X
  (x, y, z) => [z, y, -x], // about Y
  (x, y, z) => [-y, x, z], // about Z
];

function rotateOp(mesh, op, pins) {
  const a = axisOf(op.axis);
  const turns = ((Math.round(num(op.turns)) % 4) + 4) % 4;
  if (!turns) return { mesh, pins, note: '' };
  const rot = (x, y, z) => {
    let v = [x, y, z];
    for (let t = 0; t < turns; t++) v = ROT90[a](v[0], v[1], v[2]);
    return v;
  };
  const P = mesh.positions;
  const out = new Float32Array(P.length);
  for (let i = 0; i < P.length; i += 3) {
    const v = rot(P[i], P[i + 1], P[i + 2]);
    out[i] = v[0]; out[i + 1] = v[1]; out[i + 2] = v[2];
  }
  const placed = normalizePlacement({ positions: out, indices: mesh.indices, strain: mesh.strain });
  const t = placed.offset;
  const nextPins = pins.map((pin) => {
    const c0 = rot(...pin.min), c1 = rot(...pin.max);
    return {
      min: [0, 1, 2].map((k) => Math.min(c0[k], c1[k]) + t[k]),
      max: [0, 1, 2].map((k) => Math.max(c0[k], c1[k]) + t[k]),
      falloff: pin.falloff,
    };
  });
  delete placed.offset;
  return { mesh: placed, pins: nextPins, note: '' };
}

/**
 * Cut the mesh at a plane, keep one side, and reflect it to make a symmetric
 * whole. Cut vertices are shared by both halves, so a watertight input gives
 * a watertight output.
 */
function mirrorOp(mesh, op, pins) {
  const a = axisOf(op.axis);
  const at = num(op.at);
  const sg = op.keep === 'neg' ? -1 : 1;
  const P = mesh.positions, I = mesh.indices, S = mesh.strain;
  const nv = P.length / 3, nf = I.length / 3;

  const dist = new Float64Array(nv);
  for (let i = 0; i < nv; i++) {
    const d = sg * (P[3 * i + a] - at);
    dist[i] = d > -PLANE_EPS && d < PLANE_EPS ? 0 : d;
  }

  const pos = [];
  const onPlane = [];
  const map = new Int32Array(nv).fill(-1);
  const keepVertex = (i) => {
    if (map[i] < 0) {
      map[i] = onPlane.length;
      pos.push(P[3 * i], P[3 * i + 1], P[3 * i + 2]);
      if (dist[i] === 0) pos[pos.length - 3 + a] = at;
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
      pos[3 * v + a] = at;
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

  const K = onPlane.length;
  const twin = new Int32Array(K);
  let extra = 0;
  for (let v = 0; v < K; v++) twin[v] = onPlane[v] ? v : K + extra++;
  const outP = new Float32Array((K + extra) * 3);
  outP.set(pos);
  for (let v = 0; v < K; v++) {
    if (onPlane[v]) continue;
    const m = twin[v];
    outP[3 * m] = pos[3 * v]; outP[3 * m + 1] = pos[3 * v + 1]; outP[3 * m + 2] = pos[3 * v + 2];
    outP[3 * m + a] = 2 * at - pos[3 * v + a];
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

  // Pins on the kept side are copied to the mirrored side; pins on the discarded side go.
  const nextPins = [];
  for (const pin of pins) {
    const lo = sg * (pin.min[a] - at), hi = sg * (pin.max[a] - at);
    if (Math.max(lo, hi) <= 0) continue;
    nextPins.push(clonePin(pin));
    if (Math.min(lo, hi) >= 0) {
      const q = clonePin(pin);
      q.min[a] = 2 * at - pin.max[a];
      q.max[a] = 2 * at - pin.min[a];
      nextPins.push(q);
    }
  }
  const removed = nf - T;
  return {
    mesh: { positions: outP, indices: outI, strain: outS },
    pins: nextPins,
    note: removed > 0 ? `Kept ${T.toLocaleString()} faces, mirrored to ${(2 * T).toLocaleString()}.` : '',
  };
}

/**
 * Split every edge longer than `maxEdge` at its midpoint until none remain.
 * CAD exports often use long thin triangles on flat faces; deforms only move
 * vertices, so a blend needs vertices to bend. Shape is unchanged.
 */
export function refine(mesh, maxEdge, maxFaces = 4e6) {
  const L2 = maxEdge * maxEdge;
  let P = Array.from(mesh.positions);
  let I = mesh.indices, S = mesh.strain;
  for (let pass = 0; pass < 16; pass++) {
    const nv = P.length / 3;
    const long = (i, j) => {
      const dx = P[3 * i] - P[3 * j], dy = P[3 * i + 1] - P[3 * j + 1], dz = P[3 * i + 2] - P[3 * j + 2];
      return dx * dx + dy * dy + dz * dz > L2;
    };
    const mids = new Map();
    const mid = (i, j) => {
      const lo = i < j ? i : j, hi = i < j ? j : i;
      const key = lo * nv + hi;
      let v = mids.get(key);
      if (v === undefined) {
        v = P.length / 3;
        P.push((P[3 * lo] + P[3 * hi]) / 2, (P[3 * lo + 1] + P[3 * hi + 1]) / 2, (P[3 * lo + 2] + P[3 * hi + 2]) / 2);
        mids.set(key, v);
      }
      return v;
    };
    const nf = I.length / 3;
    // Decide splits per edge first so both faces sharing an edge agree.
    const split = new Uint8Array(nf);
    let any = false;
    for (let f = 0; f < nf; f++) {
      const a = I[3 * f], b = I[3 * f + 1], c = I[3 * f + 2];
      const m = (long(a, b) ? 1 : 0) | (long(b, c) ? 2 : 0) | (long(c, a) ? 4 : 0);
      split[f] = m;
      if (m) any = true;
    }
    if (!any) break;
    const out = [], outS = [];
    const tri = (a, b, c, s) => { out.push(a, b, c); outS.push(s); };
    for (let f = 0; f < nf; f++) {
      let a = I[3 * f], b = I[3 * f + 1], c = I[3 * f + 2];
      let m = split[f];
      const s = S[f];
      if (!m) { tri(a, b, c, s); continue; }
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
      } else { // m === 3: edges ab and bc
        const ab = mid(a, b), bc = mid(b, c);
        tri(ab, b, bc, s); tri(ab, bc, c, s); tri(ab, c, a, s);
      }
    }
    I = new Uint32Array(out);
    S = new Float32Array(outS);
    if (I.length / 3 > maxFaces) throw new Error(`refine: would exceed ${maxFaces.toLocaleString()} faces; use a larger max edge`);
  }
  return { positions: new Float32Array(P), indices: I, strain: S };
}

function refineOp(mesh, op, pins) {
  const maxEdge = num(op.maxEdge, 3);
  if (maxEdge < 0.2) throw new Error('refine: max edge must be at least 0.2 mm');
  const before = mesh.indices.length / 3;
  const out = refine(mesh, maxEdge);
  const after = out.indices.length / 3;
  return { mesh: out, pins, note: after > before ? `${before.toLocaleString()} → ${after.toLocaleString()} faces.` : 'Already fine enough.' };
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
 * A recipe is the op stack as JSON. Recipes reference coordinates in the
 * centred frame `loadMesh` produces, so the same source file plus the same
 * recipe always gives the same result — and you can share a recipe without
 * redistributing someone else's model.
 */
export function makeRecipe(ops, source = null) {
  return { app: 'panelbeater', version: RECIPE_VERSION, source, ops: JSON.parse(JSON.stringify(ops)) };
}

export function readRecipe(obj) {
  if (!obj || obj.app !== 'panelbeater' || !Array.isArray(obj.ops)) throw new Error('Not a Panelbeater recipe');
  if (obj.version > RECIPE_VERSION) throw new Error(`Recipe version ${obj.version} is newer than this app supports (${RECIPE_VERSION})`);
  const ops = obj.ops.map((op) => {
    if (!OP_TYPES.includes(op.type)) throw new Error(`Unknown operation "${op.type}" in recipe`);
    const base = defaultOp(op.type);
    const merged = { ...base, ...op };
    if (base.region) merged.region = { ...base.region, ...(op.region || {}) };
    return merged;
  });
  return { ops, source: obj.source || null };
}
