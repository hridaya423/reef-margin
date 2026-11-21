import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export type Mix = { coral: number; rock: number; rubble: number; sand: number; seagrass: number };

export type Taxon = { file: string; name: string; tol: number; size: [number, number]; living: [number, number, number]; weight: number };

export const ATLANTIC: Taxon[] = [
  { file: "staghorn", name: "Staghorn coral", tol: 0.05, size: [0.7, 1.1], living: [0.5, 0.3, 0.12], weight: 3 },
  { file: "madracis", name: "Pencil coral", tol: 0.3, size: [0.4, 0.6], living: [0.55, 0.42, 0.2], weight: 1.5 },
  { file: "agaricia", name: "Lettuce coral", tol: 0.25, size: [0.4, 0.65], living: [0.47, 0.36, 0.2], weight: 1.5 },
  { file: "mussa", name: "Flower coral", tol: 0.5, size: [0.35, 0.55], living: [0.36, 0.4, 0.24], weight: 1 },
  { file: "meandrina", name: "Maze coral", tol: 0.5, size: [0.4, 0.6], living: [0.5, 0.42, 0.26], weight: 1 },
  { file: "pseudodiploria", name: "Brain coral", tol: 0.65, size: [0.5, 0.85], living: [0.42, 0.38, 0.22], weight: 2 },
];

export const PACIFIC: Taxon[] = [
  { file: "acropora", name: "Branching Acropora", tol: 0.05, size: [0.6, 1.0], living: [0.48, 0.32, 0.16], weight: 3 },
  { file: "pocillopora", name: "Cauliflower coral", tol: 0.12, size: [0.35, 0.55], living: [0.5, 0.28, 0.24], weight: 2.5 },
  { file: "montipora", name: "Montipora", tol: 0.2, size: [0.45, 0.7], living: [0.42, 0.28, 0.26], weight: 1.5 },
  { file: "lobophyllia", name: "Lobophyllia", tol: 0.45, size: [0.4, 0.6], living: [0.36, 0.4, 0.26], weight: 1 },
  { file: "goniastrea", name: "Honeycomb coral", tol: 0.55, size: [0.35, 0.6], living: [0.46, 0.4, 0.22], weight: 1 },
  { file: "turbinaria", name: "Turbinaria", tol: 0.75, size: [0.45, 0.7], living: [0.56, 0.48, 0.22], weight: 1 },
  { file: "diploastrea", name: "Diploastrea", tol: 0.8, size: [0.6, 0.95], living: [0.42, 0.42, 0.26], weight: 1 },
  { file: "porites_lobata", name: "Massive Porites", tol: 0.88, size: [0.7, 1.15], living: [0.5, 0.44, 0.24], weight: 2.5 },
  { file: "porites_haddoni", name: "Massive Porites", tol: 0.88, size: [0.55, 0.9], living: [0.48, 0.46, 0.3], weight: 1 },
];

const loader = new GLTFLoader().setDRACOLoader(new DRACOLoader().setDecoderPath("/draco/"));
const cache = new Map<string, Promise<THREE.Group>>();
const load = (f: string) => {
  if (!cache.has(f)) cache.set(f, loader.loadAsync(`/models/reef/${f}.glb`).then((g) => g.scene));
  return cache.get(f)!;
};

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const groundY = (x: number, z: number) => 0.07 * Math.sin(x * 1.3 + 0.4) * Math.cos(z * 1.1) + 0.04 * Math.sin(x * 3.1 - z * 2.3);

const CAUSTIC = `
uniform float uTime;
varying vec3 vWorldPos;
varying vec3 vWorldN;
float caustic(vec2 p, float t) {
  vec2 q = p * 1.4;
  float c = 0.0;
  for (int i = 0; i < 3; i++) {
    q += vec2(sin(q.y * 1.7 + t * 0.7), cos(q.x * 1.3 - t * 0.6));
    c += 1.0 / (1.0 + 9.0 * abs(sin(q.x) + sin(q.y)));
  }
  return c / 3.0;
}`;

type Patch = { time: { value: number }; bleach?: { value: number }; living?: { value: THREE.Color } };

function patch(mat: THREE.MeshStandardMaterial, u: Patch) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = u.time;
    if (u.bleach) shader.uniforms.uBleach = u.bleach;
    if (u.living) shader.uniforms.uLiving = u.living;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWorldPos;\nvarying vec3 vWorldN;")
      .replace(
        "#include <project_vertex>",
        `#include <project_vertex>
        vec4 wp = vec4(transformed, 1.0);
        vec3 wn = objectNormal;
        #ifdef USE_INSTANCING
          wp = instanceMatrix * wp;
          wn = mat3(instanceMatrix) * wn;
        #endif
        vWorldPos = (modelMatrix * wp).xyz;
        vWorldN = normalize(mat3(modelMatrix) * wn);`,
      );
    let frag = shader.fragmentShader.replace("#include <common>", `#include <common>\n${CAUSTIC}\n${u.bleach ? "uniform float uBleach;\nuniform vec3 uLiving;" : ""}`);
    if (u.bleach)
      frag = frag.replace(
        "#include <map_fragment>",
        `#include <map_fragment>
        float lum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
        vec3 living = uLiving * (0.5 + 0.95 * lum);
        vec3 bleached = vec3(0.97, 0.96, 0.93) * (0.8 + 0.28 * lum);
        float up = clamp(vWorldN.y * 0.5 + 0.5, 0.0, 1.0);
        float b = smoothstep(0.0, 1.0, clamp(uBleach * 1.6 - (1.0 - up) * 0.6, 0.0, 1.0));
        diffuseColor.rgb = mix(living, bleached, b);`,
      );
    frag = frag.replace(
      "#include <dithering_fragment>",
      `float up2 = clamp(vWorldN.y, 0.0, 1.0);
      gl_FragColor.rgb *= 1.0 + 0.3 * caustic(vWorldPos.xz, uTime) * up2;
      #include <dithering_fragment>`,
    );
    shader.fragmentShader = frag;
  };
  return mat;
}

type Colony = { obj: THREE.Object3D; bleach: { value: number }; threshold: number };

export function ReefScene({ seed, mix, taxa, risk, label }: { seed: number; mix: Mix; taxa: Taxon[]; risk: number; label: string }) {
  const host = useRef<HTMLDivElement>(null);
  const riskRef = useRef(risk);
  riskRef.current = risk;

  useEffect(() => {
    const el = host.current!;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const rand = rng(seed * 7919 + 13);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x5d9fb1, 0.085);
    const camera = new THREE.PerspectiveCamera(34, 1, 0.05, 80);
    camera.position.set(0, 2.4, 6.4);
    scene.add(new THREE.HemisphereLight(0xd6f3f7, 0x40625a, 1.5));
    const sun = new THREE.DirectionalLight(0xfff4dc, 2.6);
    sun.position.set(1.5, 6, 2);
    scene.add(sun);

    const time = { value: 0 };

    const ground = new THREE.PlaneGeometry(22, 22, 180, 180);
    ground.rotateX(-Math.PI / 2);
    const gp = ground.attributes.position as THREE.BufferAttribute;
    for (let k = 0; k < gp.count; k++) gp.setY(k, groundY(gp.getX(k), gp.getZ(k)));
    ground.computeVertexNormals();
    const sandColor = new THREE.Color(0xd8ccb0).lerp(new THREE.Color(0x9c9784), Math.min(0.6, mix.rock + mix.rubble * 0.6));
    scene.add(new THREE.Mesh(ground, patch(new THREE.MeshStandardMaterial({ color: sandColor, roughness: 1 }), { time })));

    const place = (r: number) => {
      const a = rand() * Math.PI * 2;
      const d = Math.sqrt(rand()) * r;
      return [Math.cos(a) * d, Math.sin(a) * d] as const;
    };

    const rockGeo = new THREE.IcosahedronGeometry(1, 4);
    const rp = rockGeo.attributes.position as THREE.BufferAttribute;
    for (let k = 0; k < rp.count; k++) {
      const v = new THREE.Vector3().fromBufferAttribute(rp, k);
      v.multiplyScalar(0.8 + 0.35 * Math.sin(v.x * 3.1 + v.z * 2.3) * Math.cos(v.y * 2.7));
      rp.setXYZ(k, v.x, v.y, v.z);
    }
    rockGeo.computeVertexNormals();
    const nRock = Math.round(4 + mix.rock * 30);
    const rocks = new THREE.InstancedMesh(rockGeo, patch(new THREE.MeshStandardMaterial({ color: 0x7a7c68, roughness: 1 }), { time }), nRock);
    const m4 = new THREE.Matrix4();
    for (let k = 0; k < nRock; k++) {
      const [x, z] = place(5.5);
      const s = 0.18 + rand() * 0.5;
      m4.compose(new THREE.Vector3(x, groundY(x, z) - s * 0.25, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rand() * 3, rand() * 3, rand() * 3)), new THREE.Vector3(s * (1 + rand() * 0.6), s * (0.45 + rand() * 0.25), s));
      rocks.setMatrixAt(k, m4);
    }
    scene.add(rocks);

    const nRubble = Math.round(60 + mix.rubble * 900);
    const rubble = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), patch(new THREE.MeshStandardMaterial({ color: 0xcfc4ad, roughness: 1, flatShading: true }), { time }), nRubble);
    for (let k = 0; k < nRubble; k++) {
      const [x, z] = place(5);
      const s = 0.025 + rand() * 0.05;
      m4.compose(new THREE.Vector3(x, groundY(x, z), z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rand() * 3, rand() * 3, rand() * 3)), new THREE.Vector3(s * 2.2, s, s));
      rubble.setMatrixAt(k, m4);
    }
    scene.add(rubble);

    if (mix.seagrass > 0.02) {
      const blade = new THREE.PlaneGeometry(0.025, 0.42, 1, 4);
      blade.translate(0, 0.21, 0);
      const nGrass = Math.round(mix.seagrass * 5000);
      const grassMat = new THREE.MeshStandardMaterial({ color: 0x5f8a45, roughness: 0.9, side: THREE.DoubleSide });
      grassMat.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = time;
        shader.vertexShader = shader.vertexShader
          .replace("#include <common>", "#include <common>\nuniform float uTime;")
          .replace("#include <begin_vertex>", "#include <begin_vertex>\nfloat sw = position.y * position.y * 0.6;\ntransformed.x += sin(uTime * 1.3 + instanceMatrix[3].x * 2.0) * sw;\ntransformed.z += cos(uTime * 1.1 + instanceMatrix[3].z * 2.0) * sw * 0.6;");
      };
      const grass = new THREE.InstancedMesh(blade, grassMat, nGrass);
      const cx = (rand() - 0.5) * 3, cz = (rand() - 0.5) * 3;
      for (let k = 0; k < nGrass; k++) {
        const a = rand() * Math.PI * 2, d = Math.sqrt(rand()) * 3.2;
        const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
        const s = 0.6 + rand() * 0.8;
        m4.compose(new THREE.Vector3(x, groundY(x, z), z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rand() * 3, (rand() - 0.5) * 0.3)), new THREE.Vector3(1, s, 1));
        grass.setMatrixAt(k, m4);
      }
      scene.add(grass);
    }

    const snowGeo = new THREE.BufferGeometry();
    const snow = new Float32Array(600 * 3);
    for (let k = 0; k < 600; k++) snow.set([(rand() - 0.5) * 12, rand() * 4, (rand() - 0.5) * 12], k * 3);
    snowGeo.setAttribute("position", new THREE.BufferAttribute(snow, 3));
    const flakes = new THREE.Points(snowGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.018, transparent: true, opacity: 0.55, depthWrite: false }));
    scene.add(flakes);

    const colonies: Colony[] = [];
    const nCol = Math.max(5, Math.min(24, Math.round(5 + mix.coral * 45)));
    const total = taxa.reduce((s, t) => s + t.weight, 0);
    const pickTaxon = () => {
      let x = rand() * total;
      for (const t of taxa) if ((x -= t.weight) <= 0) return t;
      return taxa[0];
    };
    const spots: [number, number, number][] = [];
    const plan: { t: Taxon; x: number; z: number; d: number; yaw: number; jitter: number }[] = [];
    for (let k = 0; k < nCol; k++) {
      const t = pickTaxon();
      const d = t.size[0] + rand() * (t.size[1] - t.size[0]);
      for (let tries = 0; tries < 40; tries++) {
        const [x, z] = place(k < 3 ? 1.2 : 3.4);
        if (spots.every(([sx, sz, sd]) => Math.hypot(sx - x, sz - z) > (sd + d) * 0.48)) {
          spots.push([x, z, d]);
          plan.push({ t, x, z, d, yaw: rand() * Math.PI * 2, jitter: (rand() - 0.5) * 0.12 });
          break;
        }
      }
    }

    let alive = true;
    Promise.all(plan.map((p) => load(p.t.file))).then((srcs) => {
      if (!alive) return;
      srcs.forEach((src, k) => {
        const p = plan[k];
        const obj = src.clone(true);
        const bleach = { value: 0 };
        const living = { value: new THREE.Color(...p.t.living) };
        obj.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          const mat = (mesh.material as THREE.MeshStandardMaterial).clone();
          mat.roughness = 0.85;
          mat.metalness = 0;
          mesh.material = patch(mat, { time, bleach, living });
        });
        const box = new THREE.Box3().setFromObject(obj);
        const size = box.getSize(new THREE.Vector3());
        const s = p.d / Math.max(size.x, size.z, 1e-6);
        obj.scale.setScalar(s);
        obj.rotation.y = p.yaw;
        const box2 = new THREE.Box3().setFromObject(obj);
        const c = box2.getCenter(new THREE.Vector3());
        obj.position.set(p.x - c.x, groundY(p.x, p.z) - box2.min.y - 0.04 * p.d, p.z - c.z);
        scene.add(obj);
        colonies.push({ obj, bleach, threshold: 0.22 + 0.62 * p.t.tol + p.jitter });
      });
      el.dataset.ready = "true";
    });

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0.35, 0);
    controls.enableDamping = true;
    controls.enablePan = false;
    controls.minDistance = 3;
    controls.maxDistance = 10;
    controls.maxPolarAngle = 1.38;
    controls.autoRotate = !reduce;
    controls.autoRotateSpeed = 0.35;

    const resize = () => {
      const w = el.clientWidth, h = el.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(h, 1);
      camera.position.setLength(camera.aspect < 1 ? 9 : 6.8);
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    const clock = new THREE.Clock();
    renderer.setAnimationLoop(() => {
      const dt = Math.min(clock.getDelta(), 0.05);
      if (!reduce) time.value += dt;
      const r = riskRef.current;
      for (const c of colonies) {
        const target = THREE.MathUtils.smoothstep(r, c.threshold - 0.07, c.threshold + 0.07);
        c.bleach.value += (target - c.bleach.value) * (reduce ? 1 : Math.min(1, dt * 5));
      }
      const pos = snowGeo.attributes.position as THREE.BufferAttribute;
      if (!reduce) {
        for (let k = 0; k < pos.count; k++) {
          let yv = pos.getY(k) - dt * 0.05;
          if (yv < 0) yv += 4;
          pos.setY(k, yv);
        }
        pos.needsUpdate = true;
      }
      controls.update();
      renderer.render(scene, camera);
    });

    return () => {
      alive = false;
      ro.disconnect();
      renderer.setAnimationLoop(null);
      controls.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
      });
      renderer.dispose();
      el.removeChild(renderer.domElement);
      el.dataset.ready = "false";
    };
  }, [seed, mix, taxa]);

  return <div ref={host} className="coral" role="img" aria-label={label} />;
}

