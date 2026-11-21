import sys

import numpy as np
import trimesh

from points_convert import write


def colours(mesh, fidx, pts):
    bary = trimesh.triangles.points_to_barycentric(mesh.triangles[fidx], pts)
    vis = mesh.visual
    if isinstance(vis, trimesh.visual.TextureVisuals) and vis.uv is not None:
        mat = vis.material
        img = getattr(mat, "baseColorTexture", None) or getattr(mat, "image", None)
        if img is not None:
            uv = (vis.uv[mesh.faces[fidx]] * bary[:, :, None]).sum(1) % 1.0
            arr = np.asarray(img.convert("RGB"))
            h, w = arr.shape[:2]
            return arr[((1 - uv[:, 1]) * (h - 1)).astype(int), (uv[:, 0] * (w - 1)).astype(int)]
    vc = mesh.visual.to_color().vertex_colors[:, :3].astype(np.float64)
    return (vc[mesh.faces[fidx]] * bary[:, :, None]).sum(1).astype(np.uint8)


def convert(src, dst, total=650_000):
    scene = trimesh.load(src, force="scene")
    meshes = []
    for node in scene.graph.nodes_geometry:
        tf, name = scene.graph[node]
        g = scene.geometry[name]
        if isinstance(g, trimesh.Trimesh) and len(g.faces):
            g = g.copy()
            g.apply_transform(tf)
            meshes.append(g)
    areas = np.array([m.area for m in meshes])
    pos, nor, rgb = [], [], []
    for m, a in zip(meshes, areas):
        n = max(1, int(total * a / areas.sum()))
        pts, fidx = trimesh.sample.sample_surface(m, n, seed=0)
        pos.append(pts)
        nor.append(m.face_normals[fidx])
        rgb.append(colours(m, fidx, pts))
    write(np.concatenate(pos), np.concatenate(nor), np.concatenate(rgb).astype(np.uint8), dst)


if __name__ == "__main__":
    convert(sys.argv[1], sys.argv[2])
