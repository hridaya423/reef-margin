import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export type Species = "staghorn" | "pocillopora";

const LIVING: Record<Species, [number, number, number]> = {
  staghorn: [0.5, 0.29, 0.12],
  pocillopora: [0.5, 0.28, 0.2],
};

const loader = new GLTFLoader().setDRACOLoader(new DRACOLoader().setDecoderPath("/draco/"));
const cache = new Map<Species, Promise<THREE.Group>>();
const load = (s: Species) => {
  if (!cache.has(s)) cache.set(s, loader.loadAsync(`/models/${s}.glb`).then((g) => g.scene));
  return cache.get(s)!;
};

export function CoralView({ species, bleach, label }: { species: Species; bleach: number; label: string }) {
  const host = useRef<HTMLDivElement>(null);
  const uniforms = useRef({ uBleach: { value: bleach }, uLiving: { value: new THREE.Color(...LIVING[species]) } });

  useEffect(() => {
    uniforms.current.uBleach.value = bleach;
  }, [bleach]);

  useEffect(() => {
    const el = host.current!;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 100);
    scene.add(new THREE.HemisphereLight(0xfffdf6, 0xb9b2a4, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(2, 4, 3);
    scene.add(sun);
    const rim = new THREE.DirectionalLight(0xdfe9ff, 0.8);
    rim.position.set(-3, 1, -2);
    scene.add(rim);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.enablePan = false;
    controls.autoRotate = !reduce;
    controls.autoRotateSpeed = 0.6;

    uniforms.current.uLiving.value.setRGB(...LIVING[species]);
    let model: THREE.Object3D | null = null;
    const fit = { radius: 0 };
    const fitDistance = () => (fit.radius / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / Math.min(1, camera.aspect)) * 0.92;
    let alive = true;
    load(species).then((src) => {
      if (!alive) return;
      model = src.clone(true);
      model.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mat = (mesh.material as THREE.MeshStandardMaterial).clone();
        mat.roughness = 0.85;
        mat.metalness = 0;
        mat.onBeforeCompile = (shader) => {
          shader.uniforms.uBleach = uniforms.current.uBleach;
          shader.uniforms.uLiving = uniforms.current.uLiving;
          shader.vertexShader = shader.vertexShader
            .replace("#include <common>", "#include <common>\nvarying vec3 vWorldN;")
            .replace("#include <beginnormal_vertex>", "#include <beginnormal_vertex>\nvWorldN = normalize(mat3(modelMatrix) * objectNormal);");
          shader.fragmentShader = shader.fragmentShader
            .replace("#include <common>", "#include <common>\nuniform float uBleach;\nuniform vec3 uLiving;\nvarying vec3 vWorldN;")
            .replace(
              "#include <map_fragment>",
              `#include <map_fragment>
              float lum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
              vec3 living = uLiving * (0.55 + 0.9 * lum);
              vec3 bleached = vec3(0.97, 0.96, 0.93) * (0.82 + 0.25 * lum);
              float up = clamp(vWorldN.y * 0.5 + 0.5, 0.0, 1.0);
              float b = smoothstep(0.0, 1.0, clamp(uBleach * 1.7 - (1.0 - up) * 0.7, 0.0, 1.0));
              diffuseColor.rgb = mix(living, bleached, b);`,
            );
        };
        mesh.material = mat;
      });
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const centre = box.getCenter(new THREE.Vector3());
      model.position.sub(centre);
      const radius = size.length() / 2;
      fit.radius = radius;
      camera.position.set(radius * 1.6, radius * 1.1, radius * 2.4).setLength(fitDistance());
      camera.near = radius / 50;
      camera.far = radius * 50;
      camera.updateProjectionMatrix();
      controls.minDistance = radius * 1.2;
      controls.maxDistance = radius * 6;
      controls.target.set(0, 0, 0);
      scene.add(model);
      el.dataset.ready = "true";
    });

    const resize = () => {
      const w = el.clientWidth, h = el.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(h, 1);
      camera.updateProjectionMatrix();
      if (fit.radius) camera.position.setLength(fitDistance());
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();
    renderer.setAnimationLoop(() => {
      controls.update();
      renderer.render(scene, camera);
    });
    return () => {
      alive = false;
      ro.disconnect();
      renderer.setAnimationLoop(null);
      controls.dispose();
      renderer.dispose();
      el.removeChild(renderer.domElement);
      el.dataset.ready = "false";
    };
  }, [species]);

  return <div ref={host} className="coral" role="img" aria-label={label} />;
}
