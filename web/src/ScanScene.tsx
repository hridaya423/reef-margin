import { SparkRenderer, SplatMesh, dyno } from "@sparkjsdev/spark";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const BLEACH_GLSL = `
  float scanHash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float scanNoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(scanHash(i), scanHash(i + vec3(1, 0, 0)), f.x), mix(scanHash(i + vec3(0, 1, 0)), scanHash(i + vec3(1, 1, 0)), f.x), f.y),
      mix(mix(scanHash(i + vec3(0, 0, 1)), scanHash(i + vec3(1, 0, 1)), f.x), mix(scanHash(i + vec3(0, 1, 1)), scanHash(i + vec3(1, 1, 1)), f.x), f.y),
      f.z);
  }
`;

export function ScanScene({ url, white, dead, label, onReady }: { url: string; white: number; dead: number; label: string; onReady: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const ready = useRef(onReady);
  ready.current = onReady;
  const target = useRef({ white, dead });
  target.current = { white, dead };

  useEffect(() => {
    const el = host.current!;
    el.dataset.ready = "false";
    const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.add(new SparkRenderer({ renderer }));
    const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 200);
    camera.position.set(0, 3.6, 6.2);

    const uWhite = dyno.dynoFloat(target.current.white);
    const uDead = dyno.dynoFloat(target.current.dead);
    const splats = new SplatMesh({
      url,
      onLoad: () => {
        el.dataset.ready = "true";
        ready.current();
      },
    });
    splats.objectModifier = dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
      const block = new dyno.Dyno({
        inTypes: { gsplat: dyno.Gsplat, white: "float", dead: "float" },
        outTypes: { gsplat: dyno.Gsplat },
        globals: () => [BLEACH_GLSL],
        statements: ({ inputs, outputs }) =>
          dyno.unindentLines(`
            ${outputs.gsplat} = ${inputs.gsplat};
            vec3 c = ${inputs.gsplat}.rgba.rgb;
            vec3 p = ${inputs.gsplat}.center;
            float hi = max(c.r, max(c.g, c.b));
            float lo = min(c.r, min(c.g, c.b));
            float lum = dot(c, vec3(0.299, 0.587, 0.114));
            float living = smoothstep(0.04, 0.16, hi - lo) * (1.0 - smoothstep(0.62, 0.85, lum)) * smoothstep(0.05, 0.35, p.y);
            float colony = smoothstep(0.18, 0.82, scanNoise(p * 2.6) * 0.75 + scanNoise(p * 9.0) * 0.25);
            float isDead = 1.0 - smoothstep(${inputs.dead} - 0.03, ${inputs.dead} + 0.03, colony);
            float isWhite = (1.0 - smoothstep(${inputs.dead} + ${inputs.white} - 0.03, ${inputs.dead} + ${inputs.white} + 0.03, colony)) * (1.0 - isDead);
            vec3 bleached = vec3(0.97, 0.96, 0.93) * (0.62 + 0.55 * lum);
            vec3 algae = mix(vec3(0.33, 0.38, 0.29) * (0.6 + 0.6 * lum), vec3(0.3), 0.2);
            vec3 outc = mix(c, bleached, isWhite);
            outc = mix(outc, algae, isDead);
            ${outputs.gsplat}.rgba.rgb = mix(c, outc, living);
          `),
      });
      return { gsplat: block.apply({ gsplat, white: uWhite, dead: uDead }).gsplat };
    });
    splats.updateGenerator();
    scene.add(splats);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0.2, 0.6);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.35;
    controls.minDistance = 2;
    controls.maxDistance = 14;
    controls.maxPolarAngle = Math.PI * 0.47;
    controls.addEventListener("start", () => (controls.autoRotate = false));

    const resize = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      const fit = w / h < 1 ? 1.45 : 1;
      camera.position.setLength(6.6 * fit);
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    let raf = 0;
    let last = performance.now();
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      const k = 1 - Math.exp(-(now - last) / 220);
      last = now;
      const w = uWhite.value + (target.current.white - uWhite.value) * k;
      const d = uDead.value + (target.current.dead - uDead.value) * k;
      if (Math.abs(w - uWhite.value) + Math.abs(d - uDead.value) > 0.0005) {
        uWhite.value = w;
        uDead.value = d;
        splats.updateVersion();
      }
      controls.update();
      renderer.render(scene, camera);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      splats.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      el.dataset.ready = "false";
    };
  }, [url]);

  return <div ref={host} className="coral scan-coral" role="img" aria-label={label} />;
}
