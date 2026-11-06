"""Generate examples/sample-pickup.stl — an original, boxy 1/24-scale pickup shell.

Only needed to regenerate the sample: pip install manifold3d trimesh
"""
import numpy as np, trimesh
from manifold3d import Manifold, set_circular_segments

set_circular_segments(48)
T = 1.6  # wall thickness, mm

def hull(pts):
    return Manifold.hull_points(np.array(pts, dtype=float))

def box(x0, x1, y0, y1, z0, z1):
    return Manifold.cube([x1 - x0, y1 - y0, z1 - z0]).translate([x0, y0, z0])

def shell_parts(t, zb):
    """Outer volumes (t = 0) or the same volumes shrunk by t, dropped to zb."""
    hood = hull([[sx * (34 - t), y, z] for sx in (-1, 1) for y in (-90 + t, -38) for z in (zb, 32 - t)]
                + [[sx * (30 - t), y, 36 - t] for sx in (-1, 1) for y in (-87 + t, -38)])
    cab = hull([[sx * (35 - t), y, z] for sx in (-1, 1) for y in (-40 + t, 8 - t) for z in (zb, 40)]
               + [[sx * (30 - t), y, 58 - t] for sx in (-1, 1) for y in (-28 + t, 5 - t)])
    return hood, cab

hood, cab = shell_parts(0, 8)
bed = box(-35, 35, 6, 90, 8, 40)
outer = hood + cab + bed

hood_in, cab_in = shell_parts(T, -1)
bed_tub = box(-35 + T, 35 - T, 8 - T + 2 * T, 90 - T, 24 + T, 60)   # open-top load bed
under = box(-35 + T, 35 - T, -40 + T, 90 - T, -1, 24)               # open bottom
body = outer - (hood_in + cab_in + bed_tub + under)

# Glass and detail
body -= hull([[sx * 26, y, z] for sx in (-1, 1) for (y, z) in ((-44, 41.5), (-34, 56.5), (-30, 56.5), (-40, 41.5))])  # windshield
body -= box(-40, 40, -24, 1, 43, 54.5)        # side windows
body -= box(-22, 22, 2, 12, 44, 54)           # rear window
for k in range(4):                            # grille slots
    body -= box(-22, 22, -93, -85, 15 + 4.5 * k, 17.5 + 4.5 * k)
for y in (-62, 60):                           # wheel arches
    body -= Manifold.cylinder(90, 17).rotate([0, 90, 0]).translate([-45, y, 10])
for x, y in ((-8, -64), (8, -64), (-8, 28), (8, 28)):  # body-post holes
    body -= Manifold.cylinder(30, 2.2).translate([x, y, 15])

m = body.to_mesh()
tm = trimesh.Trimesh(vertices=m.vert_properties[:, :3], faces=m.tri_verts)
assert tm.is_watertight, 'sample should be watertight'
tm.export(__file__.replace('make_sample.py', 'sample-pickup.stl'))
print(len(tm.faces), 'faces', tm.extents)
