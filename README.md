# Panelbeater

Reshape 3D-printable bodies with typed numbers. Load an STL or 3MF, then stack up steps: widen the nose 6 mm, taper the bed, drop the doors, mirror a lopsided model. Export a watertight STL.

It runs entirely in your browser. Nothing gets uploaded, there are no accounts, and there's no build step.

Built for RC scale bodies, but it works on anything shell-shaped.

## Why it exists

Mesh editors have plenty of ways to sculpt by eye. Very few let you say exactly where something starts and how much it moves. Panelbeater does only that:

- **Slide, don't scale.** A stretch splits the model at a plane and slides the halves apart. Walls keep their thickness, and only the faces crossing the plane get longer.
- **Pins keep mounts rigid.** Put a pin over body-post holes and they move as one piece, so hole spacing still matches the chassis.
- **Recipes are shareable.** The step stack saves as a small JSON file. You can post "Blockhead, +6 mm nose" without redistributing someone else's model.

## Using it

1. **Open model**, or drop an STL or 3MF onto the page. The model is centred on X/Y and sits on Z = 0, and every number is in millimetres.
2. If the file was saved standing on end for printing, accept the **Rotate X 90°** suggestion so Y runs nose to tail.
3. Leave **Refine** (3 mm) as the first step. CAD exports use long thin triangles on flat faces, and blends need vertices to bend.
4. Add steps:

| Step | Does | Typical use |
|---|---|---|
| Rotate | 90° turns, then re-seats on the bed | Fix print orientation |
| Refine | Splits edges longer than N mm | Always first |
| Pin | Box whose contents move rigidly in later steps | Body posts, mounts, light buckets |
| Stretch | Split at a plane, slide one or both sides | Wider nose, longer wheelbase, lower doors (Z, − side) |
| Taper | Stretch whose amount varies along a second axis | Trapezoid bed, narrower roof |
| Move | Push a region along an axis | Raise a fender lip |
| Mirror | Cut at a plane, reflect the kept half | Symmetrise a lopsided source |

Any shaping step can be **limited to a region** (an axis-aligned box) with a blend distance so the edit fades out instead of creasing. The ⌖ buttons let you pick a coordinate by clicking the model.

5. Check the readout: size change per axis, face count, and whether the mesh is watertight. **Strain** colours faces by how much they stretched (grey 0, red 30%+). **Before** overlays the original outline.
6. **Export STL**. Use **Save recipe** to keep the steps.

## Running it

Any static file server works. ES modules don't load from `file://`.

```sh
python3 -m http.server 8080   # then open http://localhost:8080
```

To host it, turn on GitHub Pages: Settings → Pages → Deploy from branch → `main` / root.

## Project shape

```
index.html      markup + styles
app.js          UI: three.js viewer, step panel, pick-on-model, undo
core.js         geometry: STL/3MF import, weld, refine, ops, mirror, STL export, recipes
vendor/         three.js r170 + OrbitControls, pinned and vendored (MIT)
test/           node --test suite + tiny 3MF fixtures
examples/       original sample body, its recipe, and the script that made it
```

`core.js` has no dependencies and no DOM, so all of the geometry is tested in Node:

```sh
node --test
```

## Maintenance policy

The project is meant to need very little looking after.

- **No build, no npm dependencies.** three.js is vendored and only updated when a browser change forces it.
- **The recipe format is the contract.** `version: 1` recipes will keep loading. A change that would alter results for an existing recipe needs a new op type or a version bump, never a silent behaviour change.
- **Geometry changes come with tests.** A PR that touches `core.js` adds or updates a case in `test/core.test.js`.
- **Issues are the to-do list.** Bug reports are most useful with the source file (or a link to it), the recipe, and what you expected.
- **Scope stays narrow.** Numeric, region-based reshaping of shells, and nothing else.

### Not planned

Sculpt brushes, general booleans, NURBS/CAD conversion, slicing, accounts or cloud storage, and a plugin system.

### Maybe later

- Bend about a line
- Thickness snap-back (keep exact wall thickness under any deform)
- 3MF export
- Drag handles for planes and regions
- Self-intersection check after aggressive edits
- Refine only near the edits, for lighter output files

## Limits worth knowing

- Steps only move vertices, never add or remove triangles (Refine and Mirror excepted), so a watertight input stays watertight. The exception is folding: shrinks automatically widen their band to prevent it, but stacking aggressive steps can still self-intersect. Check the Strain view.
- Stretching moves everything on a side, mounts included. Pin what has to stay put.
- With a blend band of 0, the faces crossing the split plane take all of the stretch. On a curved crown, use a wider band to spread it out.

## License

MIT. three.js is MIT, see `vendor/LICENSE-three.txt`. The sample pickup is original and generated by `examples/make_sample.py`.
