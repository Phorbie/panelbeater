# Panelbeater

Reshape 3D-printable bodies with typed numbers. Load an STL or 3MF, then stack up steps: widen the nose 6 mm, taper the bed, drop the doors, mirror a lopsided model. Export a watertight STL.

It runs entirely in your browser. Nothing gets uploaded, there are no accounts, and there's no build step.

**Use it:** https://phorbie.github.io/panelbeater/

Built for RC scale bodies, but it works on anything shell-shaped.

## Why it exists

Mesh editors have plenty of ways to sculpt by eye. Very few let you say exactly where something starts and how much it moves. Panelbeater does only that:

- **Stretch a zone; slide the rest.** You pick the strip of body that grows. Everything beyond it slides along unchanged, so walls keep their thickness and details outside the strip keep their shape.
- **Rigid zones keep mounts true.** Put a zone over body-post holes and every step moves them as one piece, so hole spacing still matches the chassis.
- **Recipes are shareable.** The setup and steps save as a small JSON file. You can post "Blockhead, +6 mm nose" without redistributing someone else's model.

## Using it

1. **Open model**, or drop an STL or 3MF onto the page. The model is centred on X/Y and sits on Z = 0, and every number is in millimetres.
2. **Model → Orientation.** If the file was saved stood on end for printing, choose **Lay it down** (or turn it 90° about any axis) so Y runs nose to tail. Do this first: steps and zones keep their numbers if you turn the model later.
3. **Rigid zones.** Add a zone over each pair of body-post holes, light buckets, or anything else that must keep its size. Zones are defined once, on the starting shape, and every step keeps them rigid unless that step unticks them under **Keep rigid**.
4. **Steps.** Each step works through one box, its tool:

| Step | The box is… | Typical use |
|---|---|---|
| Stretch | the **stretch zone**: its length along the axis grows by the amount. Beyond it, the body slides. **Keep still** picks the end that stays put. | Wider nose (X), longer wheelbase (Y), lower doors (Z, keep end) |
| Taper | a stretch zone whose amount ramps from one face of the box to the opposite face | Trapezoid bed, narrower roof |
| Move | what moves: everything inside goes along the axis | Raise a fender lip |
| Mirror | a plane: one side is discarded and replaced by a reflection of the other | Symmetrise a lopsided source |

   - **Limit** the box's other sides to act on only part of the body, such as just the nose. Past a limit, the step fades out over the **soft edge**.
   - **Tilt** turns the tool (not the model) up to any angle, about the two axes across it. The box turns about its centre, and its numbers are then measured along the turned axes, marked ′.
   - Steps run top to bottom. Clicking one opens it and shows the model only up to that step. Name steps ("Widen the nose") so a recipe reads like instructions. The line under each step says how it changed the outer size, or warns when it moved nothing.
5. Set positions any of these ways:
   - **Drag the grips** in the 3D view. They sit on the box faces, the mirror plane and the zone faces. Hold Shift for 0.1 mm steps.
   - **Type a number**, press ↑/↓ (Shift ×10, Alt fine), or drag the field's label sideways.
   - **Click ⌖**, then click the model to take that point's coordinate.
6. Check your work:
   - The readout shows the size change per axis, the face count, and whether the mesh is watertight.
   - **Strain** colours faces by how much they stretched (grey 0, red 30%+).
   - **Moved** colours faces by how far they moved, in the selected step or across all steps.
   - **Before** outlines the model as it was before the selected step.
   - To measure, click a point, then Shift-click a second.
7. **Export STL**. Use **Save recipe** to keep the setup and steps as a file.

There is no refine step. Each step adds triangles only where it bends the shell: it cuts the mesh exactly along the stretch zone's faces, then subdivides where a soft edge or taper curves a surface by more than 0.03 mm. The Blockhead cab goes from 31.5k faces to about 33–38k for a typical edit.

Your model and steps are saved in this browser (IndexedDB), so a reload picks up where you left off. Nothing is uploaded.

| Keys | |
|---|---|
| Ctrl/⌘ + Z, Shift + Z | Undo, redo |
| Ctrl/⌘ + D | Duplicate the selected step |
| Del | Delete the selected step or zone |
| Esc | Close the selected step or zone / cancel a pick |
| F | Fit the model in view |
| Double-click the model | Orbit around that point |

## Running it

Any static file server works. ES modules don't load from `file://`.

The 3D view uses WebGL 2, falling back to WebGL 1. With WebGL off entirely, the app still opens, applies steps and exports; it just can't draw the model.

```sh
python3 -m http.server 8080   # then open http://localhost:8080
```

To host it, turn on GitHub Pages: Settings → Pages → Deploy from branch → `main` / root.

## Project shape

```
index.html      markup + styles
app.js          UI: three.js viewer, model setup, zones, step panel, grips, undo
core.js         geometry: STL/3MF import, weld, tool frames, steps, automatic refining, mirror, STL export, recipes
vendor/         three.js r162 + OrbitControls, pinned and vendored (MIT)
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
- **three.js stays at r162.** It's the last release that falls back to WebGL 1. r163+ needs WebGL 2, which some browsers and managed work machines turn off. Don't upgrade past it without a reason that beats that.
- **The recipe format is the contract.** `version: 2` recipes will keep loading and keep producing the same result. A change that would alter that needs a new step type, a new option, or a version bump, never a silent behaviour change. (Version 1 recipes, from the first week, are converted on load and may differ slightly.)
- **Geometry changes come with tests.** A PR that touches `core.js` adds or updates a case in `test/core.test.js`.
- **Issues are the to-do list.** Bug reports are most useful with the source file (or a link to it), the recipe, and what you expected.
- **Scope stays narrow.** Numeric, box-based reshaping of shells, and nothing else.

### Not planned

Sculpt brushes, general booleans, NURBS/CAD conversion, slicing, accounts or cloud storage, and a plugin system.

### Maybe later

- Bend about a line
- Thickness snap-back (keep exact wall thickness under any deform)
- A rotate ring on the box for dragging tilt
- Cross-section view to check wall thickness
- 3MF export
- Self-intersection check after aggressive edits

## Limits worth knowing

- A watertight input stays watertight: steps cut and subdivide with shared points, then only move points. The one way to get a bad shell is folding. Shrinks automatically widen their stretch zone to prevent it, but stacking aggressive steps can still self-intersect. Check the Strain view.
- Details inside a stretch zone stretch with it. Put the zone over plain panel, not across a grille or a light.
- Stretching moves everything beyond the zone, mounts included. Use rigid zones for what has to keep its size.

## License

MIT. three.js is MIT, see `vendor/LICENSE-three.txt`. The sample pickup is original and generated by `examples/make_sample.py`.
