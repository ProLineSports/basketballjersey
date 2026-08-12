'use client';
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useUser, useClerk, UserButton } from '@clerk/nextjs';
import { useRouter } from 'next/navigation';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DecalGeometry } from 'three/addons/geometries/DecalGeometry.js';

// ── PART / COLOR ZONES ───────────────────────────────────────────────────────
// `parts` uses the exact mesh/node names exported in SpeedFlex.glb.
// Shell, Side Screws, and Top Screws intentionally share one color control.
const ZONES = [
  { id: 'shell',             label: 'Shell',                    parts: ['Shell', 'Side Screws', 'Top Screws'], defaultColor: '#1a3a6b' },
  { id: 'bumpers',           label: 'Bumpers',                  parts: ['Bumpers'],                           defaultColor: '#ffffff' },
  { id: 'facemask',          label: 'Facemask',                 parts: ['Facemask'],                          defaultColor: '#c8102e' },
  { id: 'facemaskclips',     label: 'Facemask Clips',           parts: ['Facemask Clips'],                    defaultColor: '#212121' },
  { id: 'facemaskhardware',  label: 'Facemask Clips Hardware',  parts: ['Facemask Clips Hardware'],           defaultColor: '#aaaaaa' },
  { id: 'innerpads',         label: 'Inner Pads',                parts: ['Inner Pads'],                        defaultColor: '#212121' },
  { id: 'visor',             label: 'Visor',                     parts: ['Visor'],                             defaultColor: '#000000' },
  { id: 'visorclips',        label: 'Visor Clips',               parts: ['Visor Clips'],                       defaultColor: '#212121' },
  { id: 'chinguardinner',    label: 'Chin Guard - Inner',        parts: ['Chin Guard - Inner'],                defaultColor: '#eaeaea' },
  { id: 'chinguardouter',    label: 'Chin Guard - Outer',        parts: ['Chin Guard - Outer'],                defaultColor: '#eaeaea' },
  { id: 'metalparts',        label: 'Metal Parts',               parts: ['Metal Parts'],                       defaultColor: '#888888' },
  { id: 'strapclipslower',   label: 'Strap Clips - Lower',       parts: ['Strap Clips - Lower'],               defaultColor: '#212121' },
  { id: 'strapclipsupper',   label: 'Strap Clips - Upper',       parts: ['Strap Clips - Upper'],               defaultColor: '#212121' },
  { id: 'straps',            label: 'Straps',                    parts: ['Straps'],                            defaultColor: '#eaeaea' },
];

const FINISHES = [
  { id: 'gloss',    label: 'Gloss',     roughness: 0.05, metalness: 0.1,  clearcoat: 1.0, clearcoatRoughness: 0.05, iridescence: 0.0 },
  { id: 'matte',    label: 'Matte',     roughness: 0.9,  metalness: 0.0,  clearcoat: 0.0, clearcoatRoughness: 0.0,  iridescence: 0.0 },
  { id: 'satin',    label: 'Satin',     roughness: 0.4,  metalness: 0.05, clearcoat: 0.3, clearcoatRoughness: 0.2,  iridescence: 0.0 },
  // iridescence dialed way down from 1.0 — full-strength iridescence produced a rainbow oil-slick
  // look that read as "broken" rather than sparkly metallic paint. 0.35 gives a subtle pearlescent shift.
  { id: 'carpaint', label: 'Car Paint', roughness: 0.15, metalness: 0.2,  clearcoat: 1.0, clearcoatRoughness: 0.02, iridescence: 0.35, iridescenceIOR: 1.8, iridescenceThicknessRange: [100, 300] },
  { id: 'chrome',   label: 'Chrome',    roughness: 0.0,  metalness: 1.0,  clearcoat: 0.0, clearcoatRoughness: 0.0,  iridescence: 0.0 },
];

const CREDITS_INITIAL = 3;

// Materials that make up the shell — the only materials the Finish selector (and its
// environment map / glitter map) is allowed to touch. Hardware (screws, shiny metal)
// intentionally does NOT get an env map anymore — that was the other source of the
// "everything looks washed out" complaint.
const SHELL_MATERIAL_NAMES = ['Helmet Main Shell'];
const FACEMASK_MATERIAL_NAMES = ['facemask'];

// ── ENV MAP ROUTING ─────────────────────────────────────────────────────────
// Environment reflections are scoped to exactly the finishes that need them, and the
// intensity is tuned per-finish so Car Paint doesn't blow out toward white while
// Chrome still reads as a proper mirror.
function applyEnvMapToMaterials(materialNames, materialsMap, scene, useChrome, useCarPaint) {
  const envTex = useChrome
    ? (scene.userData.chromeEnvTexture || scene.userData.envTexture || null)
    : useCarPaint
      ? (scene.userData.envTexture || null)
      : null;
  const intensity = useChrome ? 1.6 : useCarPaint ? 0.85 : 0;
  materialNames.forEach(name => {
    const mats = materialsMap[name]; // array — a name can be shared by multiple meshes on purpose
    if (!mats) return;
    mats.forEach(mat => {
      mat.envMap = envTex;
      mat.envMapIntensity = intensity;
      mat.needsUpdate = true;
    });
  });
}
function applyShellEnvMap(materialsMap, scene, finishId) {
  applyEnvMapToMaterials(SHELL_MATERIAL_NAMES, materialsMap, scene, finishId === 'chrome', finishId === 'carpaint');
}
function applyFacemaskEnvMap(materialsMap, scene, facemaskFinishId) {
  applyEnvMapToMaterials(FACEMASK_MATERIAL_NAMES, materialsMap, scene, facemaskFinishId === 'chrome', false);
}

// ── CAR PAINT GLITTER FLAKE TEXTURES ────────────────────────────────────────
// Packs the standard glTF "ORM" layout — R = Ambient Occlusion, G = Roughness, B =
// Metalness — into one tileable canvas, used as aoMap + roughnessMap + metalnessMap
// simultaneously. This is the actual fix for the whitewash: roughness/metalness alone
// only shape SPECULAR reflections, but three.js also adds environment-driven INDIRECT
// DIFFUSE light on top of the base color everywhere the material isn't fully metallic —
// that ambient wash was what was tinting the base color even between flakes. The AO
// channel is the one thing that blocks indirect/env-driven light specifically (direct
// key/fill/rim lights are untouched by it), so:
//   Base coat → AO≈0.14 (env contribution nearly zeroed → true base color shows through
//               under the regular scene lights), rough, non-metallic.
//   Flecks    → AO≈1.0 (full env exposure), near-zero roughness, near-full metalness
//               → sharp bright glints only exactly where a flake is.
// A second canvas — black everywhere except tinted dots at the exact same flake
// positions — drives emissiveMap, so the sparkle color can be picked independently of
// the paint's own base color (which stays on mat.color / the Zone Colors swatch).
// `intensity` (0–1, Glitter slider) controls flake density; `colorHex` is the chosen
// Sparkle Color.
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return { r: 255, g: 255, b: 255 };
  const int = parseInt(m[1], 16);
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

function createFlakeTextures(intensity, colorHex) {
  const size = 256;
  const ormCanvas = document.createElement('canvas');
  ormCanvas.width = size; ormCanvas.height = size;
  const ormCtx = ormCanvas.getContext('2d');
  const baseAO     = 35;  // R channel ≈ 0.14 — blocks almost all env/indirect light
  const baseRough  = 178; // G channel ≈ 0.70 roughness
  const baseMetal  = 25;  // B channel ≈ 0.10 metalness — mostly true paint color
  ormCtx.fillStyle = `rgb(${baseAO},${baseRough},${baseMetal})`;
  ormCtx.fillRect(0, 0, size, size);

  const colorCanvas = document.createElement('canvas');
  colorCanvas.width = size; colorCanvas.height = size;
  const colorCtx = colorCanvas.getContext('2d');
  colorCtx.fillStyle = 'rgb(0,0,0)';
  colorCtx.fillRect(0, 0, size, size);

  const { r, g, b } = hexToRgb(colorHex);
  const flakeCount = Math.round(intensity * 420); // 0 → no flakes, 1 → dense
  for (let i = 0; i < flakeCount; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const rad = 0.4 + Math.random() * 1.0;

    const flakeAO     = Math.round(235 + Math.random() * 20); // ≈0.92–1.0 — fully lit by env
    const flakeRough  = Math.round(4 + Math.random() * 14);   // ≈0.02–0.07 — near mirror
    const flakeMetal  = Math.round(235 + Math.random() * 20); // ≈0.92–1.0 — near full metal
    ormCtx.fillStyle = `rgb(${flakeAO},${flakeRough},${flakeMetal})`;
    ormCtx.beginPath();
    ormCtx.arc(x, y, rad, 0, Math.PI * 2);
    ormCtx.fill();

    const jitter = 0.7 + Math.random() * 0.3; // slight per-flake brightness variance
    colorCtx.fillStyle = `rgb(${Math.round(r * jitter)},${Math.round(g * jitter)},${Math.round(b * jitter)})`;
    colorCtx.beginPath();
    colorCtx.arc(x, y, rad, 0, Math.PI * 2);
    colorCtx.fill();
  }

  const ormTex = new THREE.CanvasTexture(ormCanvas);
  ormTex.wrapS = ormTex.wrapT = THREE.RepeatWrapping;
  ormTex.repeat.set(16, 16);
  ormTex.needsUpdate = true;

  const colorTex = new THREE.CanvasTexture(colorCanvas);
  colorTex.wrapS = colorTex.wrapT = THREE.RepeatWrapping;
  colorTex.repeat.set(16, 16);
  colorTex.colorSpace = THREE.SRGBColorSpace;
  colorTex.needsUpdate = true;

  return { ormTex, colorTex };
}

// ── COLOR SWATCH ──────────────────────────────────────────────────────────────
function SectionLabel({ children }) {
  return <div style={{ fontSize:9, fontWeight:700, color:"#6b7280", letterSpacing:"0.1em", fontFamily:"'Barlow Condensed',sans-serif", marginBottom:10, marginTop:4 }}>{children}</div>;
}

function ColorSwatch({ color, onChange, label }) {
  const [hex, setHex] = React.useState(color.toUpperCase());
  const inputRef = React.useRef(null);
  React.useEffect(() => setHex(color.toUpperCase()), [color]);
  const onHexChange = (e) => {
    const v = e.target.value;
    setHex(v);
    if (/^#[0-9a-fA-F]{6}$/.test(v)) onChange(v);
  };
  return (
    <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8, position:"relative" }}>
      <div style={{ position:"relative", width:28, height:28, flexShrink:0 }}>
        <div style={{ width:28, height:28, borderRadius:6, background:color, border:"2px solid rgba(255,255,255,0.15)", cursor:"pointer" }} onClick={() => inputRef.current?.click()} />
        <input ref={inputRef} type="color" value={color} onChange={e => { onChange(e.target.value); setHex(e.target.value.toUpperCase()); }}
          style={{ position:"absolute", opacity:0, width:1, height:1, top:0, left:0, pointerEvents:"none" }} />
      </div>
      <span style={{ fontSize:11, color:"#9ca3af", flex:1 }}>{label}</span>
      <input type="text" value={hex} onChange={onHexChange} onBlur={() => setHex(color.toUpperCase())} maxLength={7} spellCheck={false}
        style={{ width:70, fontSize:11, fontFamily:"monospace", background:"rgba(255,255,255,0.06)", border:"1px solid rgba(255,255,255,0.15)", borderRadius:4, padding:"3px 6px", color:"#e2e8f0", textAlign:"center", outline:"none" }} />
    </div>
  );
}

// ── MAIN COMPONENT ────────────────────────────────────────────────────────────
export default function HelmetBuilder() {
  const router = useRouter();
  const { isSignedIn, isLoaded } = useUser();
  const { openSignIn } = useClerk();

  const mountRef    = useRef(null);
  const sceneRef    = useRef(null);
  const cameraRef   = useRef(null);
  const rendererRef = useRef(null);
  const controlsRef = useRef(null);
  const materialsRef = useRef({}); // materialName → THREE.Material[] (finish/env routing)
  const partsRef     = useRef({}); // exact GLB part/node name → THREE.Material[] (color routing)
  const frameRef    = useRef(null);

  const [activeTab, setActiveTab]     = useState('colors');
  const [colors, setColors]           = useState(() => Object.fromEntries(ZONES.map(z => [z.id, z.defaultColor])));
  const [finish, setFinish]           = useState('gloss');
  const [loaded, setLoaded]           = useState(false);
  const [showProductMenu, setShowProductMenu] = useState(false);
  const [showShadows, setShowShadows]         = useState(true);
  const [sparkleRotating, setSparkleRotating] = useState(true);
  const sparkleRotatingRef = useRef(sparkleRotating);
  useEffect(() => { sparkleRotatingRef.current = sparkleRotating; }, [sparkleRotating]);
  const [exporting, setExporting]             = useState(false);
  const [exported, setExported]               = useState(false);
  const [visorOn, setVisorOn]               = useState(true);
  const [glitter, setGlitter]               = useState(0.3);
  const [glitterColor, setGlitterColor]     = useState('#ffffff');
  const [facemaskFinish, setFacemaskFinish] = useState('gloss'); // gloss | matte
  const finishRef = useRef(finish);
  useEffect(() => { finishRef.current = finish; }, [finish]);
  const facemaskFinishRef = useRef(facemaskFinish);
  useEffect(() => { facemaskFinishRef.current = facemaskFinish; }, [facemaskFinish]);

  // ── AUTH + CREDITS (Clerk + Supabase) — mirrors /jersey ──
  const [credits, setCredits]             = useState(0);
  const [paidCredits, setPaidCredits]     = useState(0);
  const [isUnlimited, setIsUnlimited]     = useState(false);
  const [hasWatermark, setHasWatermark]   = useState(true);
  const [creditsLoaded, setCreditsLoaded] = useState(false);
  const [showUpgrade, setShowUpgrade]     = useState(false);
  const [selectedPlan, setSelectedPlan]   = useState(null);
  const [checkingOut, setCheckingOut]     = useState(false);

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) { setCredits(0); setCreditsLoaded(true); return; }
    fetch('/api/user/credits')
      .then(r => r.json())
      .then(data => {
        setCredits(data.totalCredits || 0);
        setPaidCredits(data.paidCredits || 0);
        setIsUnlimited(data.isUnlimited || false);
        setHasWatermark(data.hasWatermark !== false);
        setCreditsLoaded(true);
      })
      .catch(err => { console.error('Credits fetch error:', err); setCreditsLoaded(true); });
  }, [isLoaded, isSignedIn]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      if (params.get('upgrade') === 'true' && isSignedIn) {
        setShowUpgrade(true);
        window.history.replaceState({}, '', '/helmet');
      }
    }
  }, [isSignedIn]);

  // ── THREE.JS SETUP ──────────────────────────────────────────────────────────
  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;

    // Scene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#1f1c1e');
    sceneRef.current = scene;

    // Camera
    const camera = new THREE.PerspectiveCamera(45, el.clientWidth / el.clientHeight, 0.1, 100);
    camera.position.set(-3.2, 0.1, 0.0); // pure side profile, facemask facing right
    cameraRef.current = camera;

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(el.clientWidth, el.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.4;
    renderer.physicallyCorrectLights = true;

    // Build environment map manually using PMREMGenerator + a simple scene
    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    pmremGenerator.compileEquirectangularShader();
    // Create a gradient environment using a simple colored background
    const gradientCanvas = document.createElement('canvas');
    gradientCanvas.width = 64; gradientCanvas.height = 32;
    const gCtx = gradientCanvas.getContext('2d');
    const grad = gCtx.createLinearGradient(0, 0, 0, 32);
    grad.addColorStop(0, '#eef2f7');
    grad.addColorStop(0.4, '#8fa3bd');
    grad.addColorStop(1, '#232c3d');
    gCtx.fillStyle = grad;
    gCtx.fillRect(0, 0, 64, 32);
    const envTex = new THREE.CanvasTexture(gradientCanvas);
    envTex.mapping = THREE.EquirectangularReflectionMapping;
    const envRT = pmremGenerator.fromEquirectangular(envTex);
    // Store env texture for selective use on metallic materials only
    scene.userData.envTexture = envRT.texture;
    envTex.dispose();
    pmremGenerator.dispose();

    // Chrome reflection — a real photo reads as chrome far better than a flat gradient,
    // the same trick as reflecting a stadium/skyline photo onto chrome in Photoshop.
    // Drop the reflection image at public/chrome-reflection.jpg.
    const chromeLoader = new THREE.TextureLoader();
    chromeLoader.load(
      '/chrome-reflection.jpg',
      (tex) => {
        tex.mapping = THREE.EquirectangularReflectionMapping;
        tex.colorSpace = THREE.SRGBColorSpace;
        const chromePmrem = new THREE.PMREMGenerator(renderer);
        chromePmrem.compileEquirectangularShader();
        const chromeRT = chromePmrem.fromEquirectangular(tex);
        scene.userData.chromeEnvTexture = chromeRT.texture;
        tex.dispose();
        chromePmrem.dispose();
        // Refresh in case Chrome is already the active finish and materials already exist
        applyShellEnvMap(materialsRef.current, scene, finishRef.current);
        applyFacemaskEnvMap(materialsRef.current, scene, facemaskFinishRef.current);
      },
      undefined,
      () => console.warn('No /chrome-reflection.jpg found — Chrome will fall back to the gradient env map until you add one.')
    );

    el.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // Orbit controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.minDistance = 1.0;
    controls.maxDistance = 5.0;
    controls.target.set(0, 0.05, 0);
    controls.minDistance = 1.5;
    controls.maxDistance = 8.0;
    controlsRef.current = controls;

    // Lighting
    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambient);
    const key = new THREE.DirectionalLight(0xffffff, 2.0);
    key.position.set(3, 5, 3);
    key.castShadow = true;
    key.shadow.mapSize.width = 2048;
    key.shadow.mapSize.height = 2048;
    key.shadow.camera.near = 0.1;
    key.shadow.camera.far = 20;
    key.shadow.camera.left = -3;
    key.shadow.camera.right = 3;
    key.shadow.camera.top = 3;
    key.shadow.camera.bottom = -3;
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.8);
    fill.position.set(-3, 2, -2);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0xefff00, 0.3);
    rim.position.set(0, -2, -3);
    scene.add(rim);
    // Shadow-catching floor
    const floorGeo = new THREE.PlaneGeometry(10, 10);
    const floorMat = new THREE.ShadowMaterial({ opacity: 0.35 });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.85;
    floor.receiveShadow = true;
    scene.add(floor);
    scene.userData.floor = floor;

    // Optional back wall
    const wallGeo = new THREE.PlaneGeometry(10, 6);
    const wallMat = new THREE.ShadowMaterial({ opacity: 0.15 });
    const wall = new THREE.Mesh(wallGeo, wallMat);
    wall.position.set(0, 1.5, -2.5);
    wall.receiveShadow = true;
    scene.add(wall);
    scene.userData.wall = wall;

    // Sparkle point light — close to helmet for flake catchlights
    const sparkleLight = new THREE.PointLight(0xffffff, 8.0, 8);
    sparkleLight.position.set(1, 1, 1);
    scene.add(sparkleLight);

    // Load GLB
    const loader = new GLTFLoader();
    loader.load('/SpeedFlex.glb', (gltf) => {
      const model = gltf.scene;

      // Smooth normals + enable shadows
      model.traverse(child => {
        if (child.isMesh) {
          child.geometry.computeVertexNormals();
          child.castShadow = true;
          child.receiveShadow = true;
          // aoMap (used below to mask the car paint flake glints) requires a second UV
          // channel — most GLBs only ship one, so alias it if uv2 is missing.
          if (!child.geometry.attributes.uv2 && child.geometry.attributes.uv) {
            child.geometry.setAttribute('uv2', child.geometry.attributes.uv);
          }
        }
      });

      // Center and scale model
      const box = new THREE.Box3().setFromObject(model);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      const scale = 1.8 / maxDim;
      model.scale.setScalar(scale);
      model.position.sub(center.multiplyScalar(scale));

      // Replace materials with MeshPhysicalMaterial for full PBR control
      const finishDef = FINISHES.find(f => f.id === 'gloss');
      model.traverse(child => {
        if (!child.isMesh) return;
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach(mat => {
          if (!mat) return;
          const name = mat.name;
          const partName = child.name;
          // Color zones are keyed to exact exported GLB part/node names, not material names.
          // This lets parts with a shared source material remain independently addressable.
          const zone = ZONES.find(z => z.parts.includes(partName));
          const color = zone ? colors[zone.id] : '#808080';

          const isVisor = partName === 'Visor' || name === 'visor';
          const newMat = new THREE.MeshPhysicalMaterial({
            color: new THREE.Color(color),
            roughness: isVisor ? 0.08 : finishDef.roughness,
            metalness: isVisor ? 0.3 : finishDef.metalness,
            clearcoat: isVisor ? 1.0 : (finishDef.clearcoat || 0),
            clearcoatRoughness: isVisor ? 0.04 : (finishDef.clearcoatRoughness || 0),
            iridescence: finishDef.iridescence || 0,
            iridescenceIOR: finishDef.iridescenceIOR || 1.5,
            transparent: isVisor,
            opacity: isVisor ? 0.55 : 1.0,
            side: isVisor ? THREE.DoubleSide : THREE.FrontSide,
            // transmission (real refraction) was compounding with low opacity to look murky
            // rather than like a tinted, slightly reflective shield — dropped it in favor of
            // plain alpha blending + metalness/envMap for the reflective quality instead.
            transmission: 0,
            thickness: 0,
            envMap: isVisor ? (scene.userData.envTexture || null) : null,
            envMapIntensity: isVisor ? 0.7 : 0,
          });

          // Store original texture for toggle
          if (mat.map) { newMat.userData.originalMap = mat.map; newMat.map = null; }

          // Store material references as arrays because multiple GLB parts can intentionally
          // share one material name (for example Shell, Side Screws, and Top Screws).
          // Finish/env updates still route by material name, while color updates route by part name.
          if (!materialsRef.current[name]) materialsRef.current[name] = [];
          materialsRef.current[name].push(newMat);

          // Also index the cloned material by exact GLB part/node name for color controls.
          if (!partsRef.current[partName]) partsRef.current[partName] = [];
          partsRef.current[partName].push(newMat);

          // Replace
          if (Array.isArray(child.material)) {
            const idx = child.material.indexOf(mat);
            child.material[idx] = newMat;
          } else {
            child.material = newMat;
          }
        });
      });

      scene.add(model);
      // Now that all shell/facemask materials exist, route env maps per current finish
      // (scoped to car paint / chrome only — see applyShellEnvMap above).
      applyShellEnvMap(materialsRef.current, scene, finishRef.current);
      applyFacemaskEnvMap(materialsRef.current, scene, facemaskFinishRef.current);
      setLoaded(true);
    }, undefined, (err) => console.error('GLB load error:', err));

    // Animation loop
    let t = 0;
    const animate = () => {
      frameRef.current = requestAnimationFrame(animate);
      controls.update();
      // Slowly orbit sparkle light for dynamic catchlights — pauses in place when toggled off
      if (sparkleRotatingRef.current) {
        t += 0.01;
        sparkleLight.position.set(Math.sin(t) * 2, 1.5 + Math.sin(t * 0.7) * 0.5, Math.cos(t) * 2);
      }
      renderer.render(scene, camera);
    };
    animate();

    // Resize handler
    const onResize = () => {
      if (!el) return;
      camera.aspect = el.clientWidth / el.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(el.clientWidth, el.clientHeight);
    };
    window.addEventListener('resize', onResize);

    return () => {
      cancelAnimationFrame(frameRef.current);
      window.removeEventListener('resize', onResize);
      renderer.dispose();
      if (el.contains(renderer.domElement)) el.removeChild(renderer.domElement);
    };
  }, []);

  // ── UPDATE COLORS ────────────────────────────────────────────────────────────
  useEffect(() => {
    ZONES.forEach(zone => {
      zone.parts.forEach(partName => {
        const mats = partsRef.current[partName];
        if (mats) mats.forEach(mat => mat.color.set(colors[zone.id]));
      });
    });
  }, [colors]);

  // ── SHADOW SURFACE ON/OFF ────────────────────────────────────────────────────
  // Was previously just UI state with nothing reading it — floor/wall never actually
  // toggled. Both are ShadowMaterial planes (invisible except where a shadow lands on
  // them), so hiding them together is what actually makes "the shadow" disappear.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    if (scene.userData.floor) scene.userData.floor.visible = showShadows;
    if (scene.userData.wall)  scene.userData.wall.visible  = showShadows;
  }, [showShadows, loaded]);

  // ── VISOR ON/OFF ──────────────────────────────────────────────────────────
  useEffect(() => {
    // Toggle the exact Visor + Visor Clips GLB parts together.
    if (sceneRef.current) {
      sceneRef.current.traverse(child => {
        if (!child.isMesh) return;
        if (child.name === 'Visor' || child.name === 'Visor Clips') child.visible = visorOn;
      });
    }
  }, [visorOn]);

  // Clear any baked texture from visor (removes Oakley logo)
  useEffect(() => {
    (partsRef.current['Visor'] || []).forEach(mat => {
      if (mat.map) { mat.map = null; mat.needsUpdate = true; }
    });
  }, [loaded]);

  // ── UPDATE FACEMASK FINISH ─────────────────────────────────────────────────
  useEffect(() => {
    FACEMASK_MATERIAL_NAMES.forEach(matName => {
      const mats = materialsRef.current[matName];
      if (mats) mats.forEach(mat => {
        if (facemaskFinish === 'chrome') {
          mat.roughness = 0.0;
          mat.metalness = 1.0;
          mat.clearcoat = 0.0;
          mat.clearcoatRoughness = 0.0;
        } else {
          mat.roughness = facemaskFinish === 'matte' ? 0.9 : 0.1;
          mat.metalness = 0.1; // reset back down in case it was chrome (metalness=1) before
          mat.clearcoat = facemaskFinish === 'matte' ? 0.0 : 0.8;
        }
        mat.needsUpdate = true;
      });
    });
    if (sceneRef.current) applyFacemaskEnvMap(materialsRef.current, sceneRef.current, facemaskFinish);
  }, [facemaskFinish]);

  // ── UPDATE FINISH ────────────────────────────────────────────────────────────
  useEffect(() => {
    const finishDef = FINISHES.find(f => f.id === finish);
    if (!finishDef) return;
    // Only apply finish to shell materials
    Object.entries(materialsRef.current).forEach(([name, mats]) => {
      if (!SHELL_MATERIAL_NAMES.includes(name)) return; // only apply to shell
      mats.forEach(mat => {
        mat.roughness                  = finishDef.roughness;
        mat.metalness                  = finishDef.metalness;
        mat.clearcoat                  = finishDef.clearcoat || 0;
        mat.clearcoatRoughness         = finishDef.clearcoatRoughness || 0;
        mat.iridescence                = finishDef.iridescence || 0;
        mat.iridescenceIOR             = finishDef.iridescenceIOR || 1.5;
        if (finishDef.iridescenceThicknessRange)
          mat.iridescenceThicknessRange = finishDef.iridescenceThicknessRange;
        mat.needsUpdate                = true;
      });
    });
    // Route (or clear) the environment map for the newly selected finish
    if (sceneRef.current) applyShellEnvMap(materialsRef.current, sceneRef.current, finish);
  }, [finish]);

  // ── CAR PAINT GLITTER FLAKES ─────────────────────────────────────────────────
  // Builds the ORM (AO/roughness/metalness) + tinted emissive flake maps fresh whenever
  // the slider or sparkle color changes, or Car Paint is (re)selected; clears both for
  // every other finish so flakes — and the AO masking that keeps the base color
  // accurate — don't bleed into other finishes. One texture pair per NAME (not per
  // individual mesh) so meshes intentionally sharing a material name look identical,
  // the way one shared material should.
  useEffect(() => {
    if (!loaded) return;
    SHELL_MATERIAL_NAMES.forEach(name => {
      const mats = materialsRef.current[name];
      if (!mats) return;
      if (finish !== 'carpaint') {
        mats.forEach(mat => {
          if (mat.roughnessMap) { mat.roughnessMap.dispose(); }
          if (mat.emissiveMap) { mat.emissiveMap.dispose(); }
          mat.roughnessMap = null;
          mat.metalnessMap = null;
          mat.aoMap = null;
          mat.emissiveMap = null;
          mat.emissive.set(0x000000);
          mat.emissiveIntensity = 1;
          const finishDef = FINISHES.find(f => f.id === finish);
          if (finishDef) { mat.roughness = finishDef.roughness; mat.metalness = finishDef.metalness; }
          mat.needsUpdate = true;
        });
        return;
      }
      const { ormTex, colorTex } = createFlakeTextures(glitter, glitterColor);
      mats.forEach(mat => {
        if (mat.roughnessMap) mat.roughnessMap.dispose();
        if (mat.emissiveMap) mat.emissiveMap.dispose();
        mat.roughnessMap = ormTex;
        mat.metalnessMap = ormTex;
        mat.aoMap = ormTex;
        mat.aoMapIntensity = 1.0;
        // emissive uniform stays white so colorTex's own per-pixel RGB fully drives the
        // sparkle hue — black everywhere except exactly at the flake positions.
        mat.emissiveMap = colorTex;
        mat.emissive.set(0xffffff);
        mat.emissiveIntensity = 1.0;
        // Map fully drives per-pixel values now, so the base scalar is just a multiplier of 1
        mat.roughness = 1.0;
        mat.metalness = 1.0;
        mat.needsUpdate = true;
      });
    });
  }, [glitter, glitterColor, finish, loaded]);

  const setColor = useCallback((zoneId, val) => setColors(c => ({ ...c, [zoneId]: val })), []);

  const handleExport = useCallback(async () => {
    if (!rendererRef.current) return;
    if (!isSignedIn) { openSignIn({ afterSignInUrl: '/helmet?upgrade=true', afterSignUpUrl: '/helmet?upgrade=true' }); return; }
    if (!isUnlimited && credits <= 0) { setShowUpgrade(true); return; }
    setExporting(true);

    // Validate + deduct credit server-side — same endpoint /jersey uses (shared credit pool)
    const exportRes = await fetch('/api/user/export', { method: 'POST' });
    const exportData = await exportRes.json();
    if (!exportData.allowed) {
      setExporting(false);
      setShowUpgrade(true);
      return;
    }
    const useWatermark = exportData.hasWatermark;
    setCredits(isUnlimited ? 999 : (exportData.freeCredits || 0) + (exportData.paidCredits || 0));
    setPaidCredits(exportData.paidCredits || 0);
    setHasWatermark(exportData.hasWatermark);

    await new Promise(r => setTimeout(r, 100));
    rendererRef.current.render(sceneRef.current, cameraRef.current);
    const rawDataURL = rendererRef.current.domElement.toDataURL('image/png');

    // Tile the watermark onto the captured frame for free (unpaid) exports
    let finalDataURL = rawDataURL;
    if (useWatermark) {
      finalDataURL = await new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const off = document.createElement('canvas');
          off.width = img.width; off.height = img.height;
          const ctx = off.getContext('2d');
          ctx.drawImage(img, 0, 0);
          const wm = new Image();
          wm.onload = () => {
            ctx.save();
            ctx.globalAlpha = 0.02;
            const wmSize = Math.round(off.width * 0.16);
            const cols = Math.ceil(off.width / wmSize) + 1;
            const rows = Math.ceil(off.height / wmSize) + 1;
            for (let row = 0; row < rows; row++) {
              const xOffset = (row % 2 === 0) ? 0 : wmSize / 2;
              for (let col = 0; col < cols; col++) {
                ctx.drawImage(wm, col * wmSize - xOffset, row * wmSize, wmSize, wmSize);
              }
            }
            ctx.restore();
            resolve(off.toDataURL('image/png'));
          };
          wm.onerror = () => resolve(off.toDataURL('image/png'));
          wm.src = '/ProLine-PFP-New.jpg';
        };
        img.onerror = () => resolve(rawDataURL);
        img.src = rawDataURL;
      });
    }

    const a = document.createElement('a');
    a.href = finalDataURL;
    a.download = 'proline-helmet.png';
    a.click();
    setExporting(false);
    setExported(true);
    setTimeout(() => setExported(false), 2500);
  }, [isSignedIn, isUnlimited, credits, openSignIn]);

  const handleGetCredits = () => {
    if (!isSignedIn) { openSignIn({ afterSignInUrl: '/helmet?upgrade=true', afterSignUpUrl: '/helmet?upgrade=true' }); return; }
    setSelectedPlan(null);
    setShowUpgrade(true);
  };

  const TABS = ['colors', 'finish', 'decals'];
  const TAB_LABELS = { colors: 'Colors', finish: 'Finish', decals: 'Decals' };

  return (
    <div style={{ height: '100vh', maxHeight: '100dvh', background: '#1f1c1e', fontFamily: "'Barlow', sans-serif", color: '#e2e8f0', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      {/* TOP BAR */}
      <div style={{ background: '#161314', borderBottom: '1px solid rgba(255,255,255,0.07)', padding: '0 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 48, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button onClick={() => router.push('/')} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center' }}>
            <img src="/ProLine-PFP-New.jpg" alt="ProLine" style={{ width: 26, height: 26, borderRadius: 6, objectFit: 'cover' }} />
          </button>
          <div style={{ position: 'relative' }}>
            <button onClick={() => setShowProductMenu(m => !m)} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, padding: 0 }}>
              <span style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 900, fontSize: 16, letterSpacing: '0.06em', color: '#e2e8f0' }}>HELMET BUILDER</span>
              <span style={{ background: 'rgba(239,255,0,0.12)', color: '#efff00', fontSize: 9, fontWeight: 700, padding: '2px 7px', borderRadius: 4, letterSpacing: '0.08em', border: '1px solid rgba(239,255,0,0.25)', fontFamily: "'Barlow Condensed', sans-serif" }}>BETA</span>
              <span style={{ color: '#6b7280', fontSize: 10 }}>▾</span>
            </button>
            {showProductMenu && (
              <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 8, background: '#161314', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, overflow: 'hidden', zIndex: 100, minWidth: 180 }}>
                <button onClick={() => router.push('/jersey')} style={{ width: '100%', background: 'none', border: 'none', padding: '10px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                  <span style={{ fontSize: 14 }}>🏀</span>
                  <span style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, fontSize: 13, color: '#e2e8f0' }}>JERSEY BUILDER</span>
                </button>
                <button onClick={() => { setShowProductMenu(false); }} style={{ width: '100%', background: 'rgba(239,255,0,0.06)', border: 'none', padding: '10px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 14 }}>🏈</span>
                  <span style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, fontSize: 13, color: '#efff00' }}>HELMET BUILDER</span>
                  <span style={{ background: 'rgba(239,255,0,0.12)', color: '#efff00', fontSize: 8, fontWeight: 700, padding: '1px 5px', borderRadius: 3, border: '1px solid rgba(239,255,0,0.25)', fontFamily: "'Barlow Condensed', sans-serif" }}>BETA</span>
                </button>
              </div>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {isSignedIn && (
            <div style={{ display:'flex', alignItems:'center', gap:7, background:'rgba(255,255,255,0.05)', padding:'5px 11px', borderRadius:7, border:'1px solid rgba(255,255,255,0.08)' }}>
              <div style={{ width:7, height:7, borderRadius:'50%', background:credits>0?'#10b981':'#ef4444' }} />
              <span style={{ fontSize:11, color:'#9ca3af' }}>Credits:</span>
              <span style={{ fontSize:14, fontWeight:700, color:credits>0?'#f3f4f6':'#ef4444', fontFamily:"'Barlow Condensed',sans-serif" }}>{isUnlimited ? '∞' : credits}</span>
            </div>
          )}
          <button onClick={handleGetCredits} style={{ background:'linear-gradient(135deg,#efff00,#c8d900)', border:'none', borderRadius:6, padding:'6px 14px', fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800, fontSize:12, letterSpacing:'0.05em', color:'#000', cursor:'pointer' }}>{isSignedIn ? 'GET CREDITS' : 'GET STARTED'}</button>
          {isLoaded && (isSignedIn
            ? <UserButton afterSignOutUrl="/" appearance={{ elements: { avatarBox: { width: 28, height: 28 } } }} />
            : <button onClick={() => openSignIn({ afterSignInUrl:'/helmet?upgrade=true' })} style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 20, padding: '4px 12px', cursor: 'pointer', fontSize: 11, fontWeight: 700, color: '#e2e8f0', fontFamily: "'Barlow Condensed', sans-serif" }}>SIGN IN</button>
          )}
        </div>
      </div>

      {/* MAIN LAYOUT — same 3-column grid as /jersey: left tool panel · viewport · right summary panel */}
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'min(272px,22vw) 1fr min(252px,20vw)', overflow: 'hidden', minHeight: 0 }}>

        {/* LEFT PANEL */}
        <div style={{ background: '#161314', borderRight: '1px solid rgba(255,255,255,0.07)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

          {/* Tabs */}
          <div style={{ display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 }}>
            {TABS.map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)} style={{ flex: 1, padding: '9px 0', fontSize: 9, fontWeight: 700, fontFamily: "'Barlow Condensed', sans-serif", letterSpacing: '0.08em', background: 'none', border: 'none', borderBottom: activeTab === tab ? '2px solid #efff00' : '2px solid transparent', color: activeTab === tab ? '#efff00' : '#6b7280', cursor: 'pointer' }}>
                {TAB_LABELS[tab]}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div style={{ flex: 1, overflowY: 'auto', padding: 14, minHeight: 0 }}>

            {/* COLORS */}
            {activeTab === 'colors' && (
              <div>
                <SectionLabel>Part Colors</SectionLabel>
                {ZONES.map(zone => (
                  <ColorSwatch key={zone.id} color={colors[zone.id]} onChange={v => setColor(zone.id, v)} label={zone.label} />
                ))}

                <div style={{ height:1, background:'rgba(255,255,255,0.06)', margin:'14px 0' }} />
                <SectionLabel>Background</SectionLabel>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:14 }}>
                  <span style={{ fontSize:11, color:'#9ca3af' }}>Shadow Surface</span>
                  <button onClick={() => setShowShadows(s => !s)} style={{ background:showShadows?'rgba(239,255,0,0.15)':'rgba(255,255,255,0.06)', border:showShadows?'1px solid rgba(239,255,0,0.5)':'1px solid rgba(255,255,255,0.12)', borderRadius:20, padding:'3px 12px', cursor:'pointer', fontSize:9, fontWeight:700, fontFamily:"'Barlow Condensed',sans-serif", color:showShadows?'#efff00':'#6b7280', letterSpacing:'0.06em' }}>{showShadows?'ON':'OFF'}</button>
                </div>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:14 }}>
                  <span style={{ fontSize:11, color:'#9ca3af' }}>Rotating Light</span>
                  <button onClick={() => setSparkleRotating(s => !s)} title={sparkleRotating ? 'Pause rotating light' : 'Resume rotating light'} style={{ background:sparkleRotating?'rgba(239,255,0,0.15)':'rgba(255,255,255,0.06)', border:sparkleRotating?'1px solid rgba(239,255,0,0.5)':'1px solid rgba(255,255,255,0.12)', borderRadius:20, padding:'3px 12px', cursor:'pointer', fontSize:9, fontWeight:700, fontFamily:"'Barlow Condensed',sans-serif", color:sparkleRotating?'#efff00':'#6b7280', letterSpacing:'0.06em', display:'flex', alignItems:'center', gap:5 }}>
                    <span style={{ fontSize:8 }}>{sparkleRotating ? '⏸' : '▶'}</span>
                    {sparkleRotating ? 'STOP' : 'START'}
                  </button>
                </div>
                <div style={{ height:1, background:'rgba(255,255,255,0.06)', margin:'4px 0 14px' }} />
                <SectionLabel>Visor</SectionLabel>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
                  <span style={{ fontSize:11, color:'#9ca3af' }}>Visor + Clips</span>
                  <button onClick={() => setVisorOn(v => !v)} style={{ background:visorOn?'rgba(239,255,0,0.15)':'rgba(255,255,255,0.06)', border:visorOn?'1px solid rgba(239,255,0,0.5)':'1px solid rgba(255,255,255,0.12)', borderRadius:20, padding:'3px 12px', cursor:'pointer', fontSize:9, fontWeight:700, fontFamily:"'Barlow Condensed',sans-serif", color:visorOn?'#efff00':'#6b7280', letterSpacing:'0.06em' }}>{visorOn?'ON':'OFF'}</button>
                </div>
              </div>
            )}

            {/* FINISH */}
            {activeTab === 'finish' && (
              <div>
                <SectionLabel>Shell Finish</SectionLabel>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {FINISHES.map(f => (
                    <button key={f.id} onClick={() => setFinish(f.id)} style={{ background: finish === f.id ? 'rgba(239,255,0,0.1)' : 'rgba(255,255,255,0.04)', border: finish === f.id ? '1px solid rgba(239,255,0,0.4)' : '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: '10px 14px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 12, fontWeight: 700, fontFamily: "'Barlow Condensed', sans-serif", color: finish === f.id ? '#efff00' : '#9ca3af', letterSpacing: '0.04em' }}>{f.label.toUpperCase()}</span>
                      <div style={{ width: 24, height: 24, borderRadius: '50%', background: finish === f.id ? '#efff00' : 'rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        {finish === f.id && <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#000' }} />}
                      </div>
                    </button>
                  ))}
                </div>
                <div style={{ marginTop: 14, marginBottom: 14, fontSize: 10, color: '#4b5563', lineHeight: 1.6 }}>
                  Finish applies to the main shell only. All other parts retain their own properties.
                </div>
                {finish === 'carpaint' && (
                  <div>
                    <div style={{ height:1, background:'rgba(255,255,255,0.06)', marginBottom:14 }} />
                    <SectionLabel>Glitter Intensity</SectionLabel>
                    <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:10 }}>
                      <span style={{ fontSize:10, color:'#9ca3af', minWidth:48 }}>Amount</span>
                      <input type="range" min="0" max="100" value={Math.round(glitter*100)} onChange={e => setGlitter(parseInt(e.target.value)/100)} style={{ flex:1 }} />
                      <span style={{ fontSize:11, color:'#efff00', fontFamily:"'Barlow Condensed',sans-serif", width:34, textAlign:'right' }}>{Math.round(glitter*100)}%</span>
                    </div>
                    <ColorSwatch color={glitterColor} onChange={setGlitterColor} label="Sparkle Color" />
                  </div>
                )}
                <div style={{ height:1, background:'rgba(255,255,255,0.06)', margin:'14px 0' }} />
                <SectionLabel>Facemask Finish</SectionLabel>
                <div style={{ display:'flex', gap:6 }}>
                  {['gloss','matte','chrome'].map(f => (
                    <button key={f} onClick={() => setFacemaskFinish(f)} style={{ flex:1, background:facemaskFinish===f?'rgba(239,255,0,0.1)':'rgba(255,255,255,0.04)', border:facemaskFinish===f?'1px solid rgba(239,255,0,0.4)':'1px solid rgba(255,255,255,0.08)', borderRadius:6, padding:'8px 4px', cursor:'pointer', fontSize:10, fontWeight:700, fontFamily:"'Barlow Condensed',sans-serif", color:facemaskFinish===f?'#efff00':'#9ca3af' }}>{f.toUpperCase()}</button>
                  ))}
                </div>
              </div>
            )}

            {/* DECALS */}
            {activeTab === 'decals' && (
              <div>
                <SectionLabel>Decals</SectionLabel>
                <div style={{ background: 'rgba(239,255,0,0.05)', border: '1px dashed rgba(239,255,0,0.2)', borderRadius: 8, padding: 16, textAlign: 'center', color: '#6b7280', fontSize: 11, lineHeight: 1.6 }}>
                  🚧 Coming soon<br />
                  Click-to-place decals that wrap to the helmet surface using Three.js DecalGeometry.
                </div>
              </div>
            )}
          </div>


        </div>

        {/* 3D VIEWPORT */}
        <div style={{ position: 'relative', overflow: 'hidden', background: '#1f1c1e' }}>
          <div ref={mountRef} style={{ width: '100%', height: '100%' }} />

          {/* Loading overlay */}
          {!loaded && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#1f1c1e' }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 32, marginBottom: 12 }}>🏈</div>
                <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, fontSize: 14, color: '#6b7280', letterSpacing: '0.1em' }}>LOADING HELMET...</div>
              </div>
            </div>
          )}

          {/* Viewport hint — export now lives in the right panel, matching /jersey */}
          {loaded && (
            <div style={{ position:'absolute', bottom:16, left:'50%', transform:'translateX(-50%)', fontSize:10, color:'#374151', letterSpacing:'0.1em', fontFamily:"'Barlow Condensed',sans-serif", pointerEvents:'none', whiteSpace:'nowrap' }}>
              DRAG TO ROTATE · SCROLL TO ZOOM · RIGHT-CLICK TO PAN
            </div>
          )}

          {/* Back button */}
          <button onClick={() => router.push('/')} style={{ position: 'absolute', top: 16, left: 16, background: 'rgba(0,0,0,0.5)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontSize: 11, fontWeight: 700, color: '#9ca3af', fontFamily: "'Barlow Condensed', sans-serif", display: 'flex', alignItems: 'center', gap: 6 }}>
            ← ALL BUILDERS
          </button>
        </div>

        {/* RIGHT PANEL — mirrors /jersey: current colors → active finish → tips → credits meter → export */}
        <div style={{ background:'#161314', borderLeft:'1px solid rgba(255,255,255,0.07)', display:'flex', flexDirection:'column', overflow:'hidden' }}>
          <div style={{ padding:'12px 14px', borderBottom:'1px solid rgba(255,255,255,0.07)', flexShrink:0 }}>
            <SectionLabel>Current Colors</SectionLabel>
            <div style={{ display:'flex', gap:5, flexWrap:'wrap' }}>
              {ZONES.map(zone => (
                <div key={zone.id} style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:3 }}>
                  <div style={{ width:24, height:24, borderRadius:5, background:colors[zone.id], border:'1px solid rgba(255,255,255,0.12)' }} title={zone.label} />
                  <span style={{ fontSize:7, color:'#6b7280', fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:'0.03em', textTransform:'uppercase', maxWidth:30, textAlign:'center', lineHeight:1.1 }}>{zone.label.split(' ')[0]}</span>
                </div>
              ))}
            </div>
          </div>

          <div style={{ padding:'10px 14px', borderBottom:'1px solid rgba(255,255,255,0.07)', flexShrink:0 }}>
            <SectionLabel>Active Finish</SectionLabel>
            <div style={{ background:'rgba(239,255,0,0.07)', border:'1px solid rgba(239,255,0,0.2)', borderRadius:7, padding:'9px 12px', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
              <span style={{ fontSize:13, fontWeight:700, fontFamily:"'Barlow Condensed',sans-serif", color:'#efff00', letterSpacing:'0.05em' }}>{FINISHES.find(f => f.id === finish)?.label.toUpperCase()}</span>
              <button onClick={() => setActiveTab('finish')} style={{ background:'none', border:'1px solid rgba(239,255,0,0.25)', borderRadius:4, padding:'3px 8px', cursor:'pointer', fontSize:9, fontWeight:700, color:'#efff00', fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:'0.06em' }}>CHANGE</button>
            </div>
          </div>

          <div style={{ padding:'14px 16px', overflowY:'auto', flex:1, minHeight:0 }}>
            <SectionLabel>Tips</SectionLabel>
            {[
              { icon:'◈', text:'Click any swatch or type a hex code to change colors' },
              { icon:'◎', text:'Car Paint + Chrome are the only finishes with reflections — Gloss/Matte/Satin use true flat color' },
              { icon:'✦', text:'Glitter flakes only show up on the Car Paint finish' },
              { icon:'◉', text:'Drag to rotate the helmet and check the finish from multiple angles' },
              { icon:'★', text:'Exports include watermark — upgrade to remove it' },
            ].map((tip,i) => (
              <div key={i} style={{ display:'flex', gap:9, marginBottom:10, alignItems:'flex-start' }}>
                <span style={{ color:'#efff00', fontSize:12, lineHeight:1.5, flexShrink:0 }}>{tip.icon}</span>
                <span style={{ fontSize:11, color:'#4b5563', lineHeight:1.5 }}>{tip.text}</span>
              </div>
            ))}
          </div>

          <div style={{ padding:'12px 14px', borderTop:'1px solid rgba(255,255,255,0.07)', flexShrink:0 }}>
            <div style={{ background:'rgba(239,255,0,0.05)', border:'1px solid rgba(239,255,0,0.14)', borderRadius:9, padding:'10px 12px', marginBottom:10 }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:5 }}>
                <span style={{ fontSize:11, color:'#9ca3af' }}>Credits remaining</span>
                <span style={{ fontSize:20, fontWeight:900, color:credits>0?'#efff00':'#ef4444', fontFamily:"'Barlow Condensed',sans-serif" }}>{isUnlimited ? '∞' : credits}</span>
              </div>
              <div style={{ height:3, background:'rgba(255,255,255,0.06)', borderRadius:2 }}>
                <div style={{ height:'100%', width:isUnlimited ? '100%' : `${Math.min(100,(credits/CREDITS_INITIAL)*100)}%`, background:isUnlimited?'#10b981':'#efff00', borderRadius:2, transition:'width 0.4s ease' }} />
              </div>
              <div style={{ fontSize:9, color:'#6b7280', marginTop:4 }}>{isUnlimited ? 'Unlimited watermark-free exports' : 'FREE EXPORTS INCLUDE PROLINE WATERMARK'}</div>
            </div>
            <button onClick={handleExport} disabled={exporting || !loaded} style={{ width:'100%', background:credits>0?(exporting?'rgba(239,255,0,0.45)':'linear-gradient(135deg,#efff00,#c8d900)'):'rgba(239,68,68,0.12)', border:credits>0?'none':'1px solid rgba(239,68,68,0.3)', borderRadius:8, padding:'13px', fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:14, letterSpacing:'0.08em', color:credits>0?'#000':'#ef4444', cursor:'pointer', animation:exporting?'pulse 0.9s infinite':'none' }}>
              {exported ? '✓ DOWNLOADED!' : exporting ? 'EXPORTING...' : credits>0 ? '↓ EXPORT PNG' : 'NO CREDITS — UPGRADE'}
            </button>
            {credits<=1 && credits>0 && (
              <button onClick={handleGetCredits} style={{ width:'100%', marginTop:7, background:'none', border:'1px solid rgba(255,255,255,0.09)', borderRadius:8, padding:'9px', fontFamily:"'Barlow Condensed',sans-serif", fontWeight:700, fontSize:11, color:'#6b7280', cursor:'pointer', letterSpacing:'0.05em' }}>UPGRADE → REMOVE WATERMARK</button>
            )}
          </div>
        </div>
      </div>

      {/* UPGRADE MODAL — identical flow to /jersey (same Stripe products, same shared credit pool) */}
      {showUpgrade && (
        <div onClick={() => setShowUpgrade(false)} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.78)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000 }}>
          <div onClick={e => e.stopPropagation()} style={{ background:'#161314', borderRadius:16, border:'1px solid rgba(255,255,255,0.1)', padding:'30px', width:460, maxWidth:'90vw' }}>
            <div style={{ textAlign:'center', marginBottom:20 }}>
              <div style={{ fontSize:26, marginBottom:8 }}>⚡</div>
              <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:24, letterSpacing:'0.05em', marginBottom:6 }}>UPGRADE YOUR PLAN</div>
              <div style={{ fontSize:12, color:'#9ca3af', lineHeight:1.6 }}>Remove the ProLine watermark and get more exports.</div>
            </div>

            <button onClick={() => setSelectedPlan('NEXT_PUBLIC_STRIPE_PRICE_UNLIMITED')} style={{ width:'100%', background:selectedPlan==='NEXT_PUBLIC_STRIPE_PRICE_UNLIMITED'?'rgba(239,255,0,0.2)':'rgba(239,255,0,0.04)', border:selectedPlan==='NEXT_PUBLIC_STRIPE_PRICE_UNLIMITED'?'2px solid #efff00':'1px solid rgba(239,255,0,0.25)', borderRadius:10, padding:'14px 16px', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16, position:'relative' }}>
              <div style={{ position:'absolute', top:-10, left:16, background:'#efff00', color:'#000', fontSize:8, fontWeight:800, padding:'2px 8px', borderRadius:3, fontFamily:"'Barlow Condensed',sans-serif", whiteSpace:'nowrap' }}>MOST POPULAR</div>
              <div style={{ textAlign:'left' }}>
                <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:16, color:'#efff00', letterSpacing:'0.04em' }}>UNLIMITED MONTHLY</div>
                <div style={{ fontSize:10, color:'#9ca3af', marginTop:2 }}>Unlimited watermark-free exports · cancel anytime</div>
              </div>
              <div style={{ textAlign:'right', flexShrink:0, marginLeft:12 }}>
                <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:22, color:'#fff' }}>$4.99</div>
                <div style={{ fontSize:9, color:'#6b7280' }}>per month</div>
              </div>
            </button>

            <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:16 }}>
              <div style={{ flex:1, height:1, background:'rgba(255,255,255,0.07)' }} />
              <span style={{ fontSize:10, color:'#4b5563', fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:'0.08em' }}>OR BUY CREDITS</span>
              <div style={{ flex:1, height:1, background:'rgba(255,255,255,0.07)' }} />
            </div>

            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:9, marginBottom:10 }}>
              {[{credits:5,price:'$4.99',per:'$1.00 ea',priceKey:'NEXT_PUBLIC_STRIPE_PRICE_5_CREDITS'},{credits:15,price:'$9.99',per:'$0.67 ea',priceKey:'NEXT_PUBLIC_STRIPE_PRICE_15_CREDITS'},{credits:50,price:'$24.99',per:'$0.50 ea',priceKey:'NEXT_PUBLIC_STRIPE_PRICE_50_CREDITS'}].map(plan => (
                <button key={plan.credits} onClick={() => setSelectedPlan(plan.priceKey)} style={{ background:selectedPlan===plan.priceKey?'rgba(239,255,0,0.1)':'rgba(255,255,255,0.04)', border:selectedPlan===plan.priceKey?'1px solid rgba(239,255,0,0.5)':'1px solid rgba(255,255,255,0.08)', borderRadius:10, padding:'13px 6px', cursor:'pointer', display:'flex', flexDirection:'column', alignItems:'center', gap:3, position:'relative' }}>
                  <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:28, color:'#e2e8f0' }}>{plan.credits}</div>
                  <div style={{ fontSize:9, color:'#9ca3af' }}>credits</div>
                  <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800, fontSize:17, color:'#fff', marginTop:3 }}>{plan.price}</div>
                  <div style={{ fontSize:9, color:'#6b7280' }}>{plan.per}</div>
                </button>
              ))}
            </div>
            <div style={{ fontSize:10, color:'#10b981', textAlign:'center', marginBottom:16, display:'flex', alignItems:'center', justifyContent:'center', gap:5 }}>
              <span>✓</span> Purchased credits are always watermark-free · free credits include watermark
            </div>

            <button onClick={async () => {
              if (!selectedPlan || checkingOut) return;
              const PRICE_IDS = {
                NEXT_PUBLIC_STRIPE_PRICE_UNLIMITED:  process.env.NEXT_PUBLIC_STRIPE_PRICE_UNLIMITED,
                NEXT_PUBLIC_STRIPE_PRICE_5_CREDITS:  process.env.NEXT_PUBLIC_STRIPE_PRICE_5_CREDITS,
                NEXT_PUBLIC_STRIPE_PRICE_15_CREDITS: process.env.NEXT_PUBLIC_STRIPE_PRICE_15_CREDITS,
                NEXT_PUBLIC_STRIPE_PRICE_50_CREDITS: process.env.NEXT_PUBLIC_STRIPE_PRICE_50_CREDITS,
              };
              const priceId = PRICE_IDS[selectedPlan];
              if (!priceId) { console.error('No price ID found for', selectedPlan); return; }
              setCheckingOut(true);
              try {
                const r = await fetch('/api/stripe/checkout', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ priceId }) });
                const d = await r.json();
                if (d.url) window.location.href = d.url;
                else console.error('No URL in response:', d);
              } catch(err) {
                console.error('Checkout error:', err);
              } finally {
                setCheckingOut(false);
              }
            }} style={{ width:'100%', background:selectedPlan?'linear-gradient(135deg,#efff00,#c8d900)':'rgba(255,255,255,0.08)', border:'none', borderRadius:8, padding:'13px', fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:14, letterSpacing:'0.06em', color:selectedPlan?'#000':'#6b7280', cursor:selectedPlan?'pointer':'default', marginBottom:8 }}>{checkingOut ? 'LOADING...' : 'CONTINUE TO CHECKOUT →'}</button>
            <button onClick={() => setShowUpgrade(false)} style={{ width:'100%', background:'none', border:'none', fontSize:11, color:'#6b7280', cursor:'pointer', padding:'7px', fontFamily:"'Barlow Condensed',sans-serif" }}>Maybe later</button>
          </div>
        </div>
      )}
    </div>
  );
}
