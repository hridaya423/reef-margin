import sys

import numpy as np

C0 = 0.28209479177387814


def read_ply(path):
    with open(path, "rb") as fh:
        header = []
        while True:
            line = fh.readline().decode().strip()
            header.append(line)
            if line == "end_header":
                break
        count = next(int(l.split()[2]) for l in header if l.startswith("element vertex"))
        props = [l.split()[2] for l in header if l.startswith("property float")]
        data = np.frombuffer(fh.read(count * 4 * len(props)), dtype=np.float32).reshape(count, len(props))
    return {p: data[:, k] for k, p in enumerate(props)}


def quat_mul(a, b):
    aw, ax, ay, az = a[..., 0], a[..., 1], a[..., 2], a[..., 3]
    bw, bx, by, bz = b[..., 0], b[..., 1], b[..., 2], b[..., 3]
    return np.stack([
        aw * bw - ax * bx - ay * by - az * bz,
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
    ], -1)


def mat_to_quat(m):
    w = np.sqrt(max(1e-12, 1 + m[0, 0] + m[1, 1] + m[2, 2])) / 2
    return np.array([w, (m[2, 1] - m[1, 2]) / (4 * w), (m[0, 2] - m[2, 0]) / (4 * w), (m[1, 0] - m[0, 1]) / (4 * w)])


def convert(src, dst, width=8.0, flip=False):
    v = read_ply(src)
    pos = np.stack([v["x"], v["y"], v["z"]], 1)
    alpha = 1 / (1 + np.exp(-v["opacity"]))
    scale = np.exp(np.stack([v["scale_0"], v["scale_1"], v["scale_2"]], 1))
    rgb = np.clip(0.5 + C0 * np.stack([v["f_dc_0"], v["f_dc_1"], v["f_dc_2"]], 1), 0, 1)
    rot = np.stack([v["rot_0"], v["rot_1"], v["rot_2"], v["rot_3"]], 1)
    rot /= np.linalg.norm(rot, axis=1, keepdims=True)

    center = np.median(pos, 0)
    d = np.linalg.norm(pos - center, axis=1)
    keep = (alpha > 0.04) & (d < np.percentile(d, 98.5)) & (scale.max(1) < np.percentile(scale.max(1), 99.5))
    pos, alpha, scale, rgb, rot = pos[keep], alpha[keep], scale[keep], rgb[keep], rot[keep]

    center = np.median(pos, 0)
    q = pos - center
    vals, vecs = np.linalg.eigh(np.cov(q.T))
    up = vecs[:, 0]
    h = q @ up
    if (np.mean((h - h.mean()) ** 3) < 0) != flip:
        up = -up
    x = vecs[:, 2]
    z = np.cross(x, up)
    r = np.stack([x, up, z])
    if np.linalg.det(r) < 0:
        r[2] = -r[2]
    p = q @ r.T
    p[:, 1] -= np.percentile(p[:, 1], 5)
    k = width / (np.percentile(p[:, 0], 98) - np.percentile(p[:, 0], 2))
    p *= k
    scale *= k
    rq = np.broadcast_to(mat_to_quat(r), rot.shape)
    rot = quat_mul(rq, rot)
    rot /= np.linalg.norm(rot, axis=1, keepdims=True)

    order = np.argsort(-(scale.prod(1) * alpha))
    out = np.zeros(len(p), dtype=[("pos", "<f4", 3), ("scale", "<f4", 3), ("rgba", "u1", 4), ("rot", "u1", 4)])
    out["pos"] = p[order]
    out["scale"] = scale[order]
    out["rgba"] = np.clip(np.concatenate([rgb[order], alpha[order, None]], 1) * 255, 0, 255).astype(np.uint8)
    out["rot"] = np.clip(rot[order] * 128 + 128, 0, 255).astype(np.uint8)
    out.tofile(dst)
    print(dst, len(out), "splats", round(out.nbytes / 2**20, 1), "MB", "extent", np.ptp(p, 0).round(2))


if __name__ == "__main__":
    convert(sys.argv[1], sys.argv[2], flip=len(sys.argv) > 3 and sys.argv[3] == "flip")
