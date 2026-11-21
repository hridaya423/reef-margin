import sys

import numpy as np
from scipy.spatial import cKDTree


def read_points(path):
    with open(path, "rb") as fh:
        header = []
        while True:
            line = fh.readline().decode().strip()
            header.append(line)
            if line == "end_header":
                break
        count = next(int(l.split()[2]) for l in header if l.startswith("element vertex"))
        names = [(l.split()[2], "<f4" if l.split()[1] == "float" else "u1") for l in header if l.startswith("property")]
        return np.frombuffer(fh.read(), dtype=np.dtype(names), count=count)


def rotation_from_z(n):
    z = n / np.linalg.norm(n, axis=1, keepdims=True)
    a = np.where(np.abs(z[:, :1]) < 0.9, np.array([[1.0, 0, 0]]), np.array([[0, 1.0, 0]]))
    x = np.cross(a, z)
    x /= np.linalg.norm(x, axis=1, keepdims=True)
    y = np.cross(z, x)
    m = np.stack([x, y, z], 2)
    tr = m[:, 0, 0] + m[:, 1, 1] + m[:, 2, 2]
    w = np.sqrt(np.maximum(1e-12, 1 + tr)) / 2
    return np.stack([w, (m[:, 2, 1] - m[:, 1, 2]) / (4 * w), (m[:, 0, 2] - m[:, 2, 0]) / (4 * w), (m[:, 1, 0] - m[:, 0, 1]) / (4 * w)], 1)


def convert(src, dst, keep=650_000):
    v = read_points(src)
    rng = np.random.default_rng(0)
    v = v[rng.choice(len(v), size=min(keep, len(v)), replace=False)]
    write(np.stack([v["x"], v["y"], v["z"]], 1).astype(np.float64), np.stack([v["nx"], v["ny"], v["nz"]], 1).astype(np.float64), np.stack([v["red"], v["green"], v["blue"]], 1), dst)


def write(pos, nor, rgb, dst, width=8.0):
    center = np.median(pos, 0)
    q = pos - center
    vals, vecs = np.linalg.eigh(np.cov(q.T))
    up = vecs[:, 0]
    if nor.mean(0) @ up < 0:
        up = -up
    x = vecs[:, 2]
    z = np.cross(x, up)
    r = np.stack([x, up, z])
    p = q @ r.T
    n = nor @ r.T
    span = np.percentile(p[:, 0], 98) - np.percentile(p[:, 0], 2)
    inside = (np.abs(p[:, 0]) < span * 0.55) & (np.abs(p[:, 2]) < span * 0.55)
    p, n, rgb = p[inside], n[inside], rgb[inside]
    p[:, 1] -= np.percentile(p[:, 1], 5)
    k = width / span
    p *= k

    d, _ = cKDTree(p).query(p, k=4)
    s = np.clip(np.median(d[:, 1:], 1) * 0.9, 1e-4, np.percentile(d[:, 3], 95))
    scale = np.stack([s, s, s * 0.15], 1)
    rot = rotation_from_z(n)

    order = np.argsort(-s)
    out = np.zeros(len(p), dtype=[("pos", "<f4", 3), ("scale", "<f4", 3), ("rgba", "u1", 4), ("rot", "u1", 4)])
    out["pos"] = p[order]
    out["scale"] = scale[order]
    out["rgba"] = np.concatenate([rgb[order], np.full((len(p), 1), 235, np.uint8)], 1)
    out["rot"] = np.clip(rot[order] * 128 + 128, 0, 255).astype(np.uint8)
    out.tofile(dst)
    print(dst, len(out), "splats", round(out.nbytes / 2**20, 1), "MB", "extent", np.ptp(p, 0).round(2))


if __name__ == "__main__":
    convert(sys.argv[1], sys.argv[2])
