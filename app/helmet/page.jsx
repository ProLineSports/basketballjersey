'use client';
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useUser, useClerk, UserButton } from '@clerk/nextjs';
import { useRouter } from 'next/navigation';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DecalGeometry } from 'three/addons/geometries/DecalGeometry.js';

// ── MATERIAL ZONES ────────────────────────────────────────────────────────────
const ZONES = [
  { id: 'shell',      label: 'Main Shell',    materials: ['Helmet Main Shell', 'High-Gloss Red Plastic', 'Car paint'], defaultColor: '#1a3a6b' },
  { id: 'facemask',   label: 'Facemask',      materials: ['facemask'],                                                  defaultColor: '#c8102e' },
  { id: 'bumpers',    label: 'Bumpers',        materials: ['Bumpers'],                                                  defaultColor: '#ffffff' },
  { id: 'chinguard',  label: 'Chin Guard',     materials: ['chin guard inner', 'chin guard outer'],                    defaultColor: '#eaeaea' },
  { id: 'straps',     label: 'Straps',         materials: ['straps'],                                                   defaultColor: '#eaeaea' },
  { id: 'sideelems',  label: 'Strap Clips',    materials: ['side elements'],                                            defaultColor: '#212121' },
  { id: 'screws',     label: 'Screws',         materials: ['screws metal parts'],                                       defaultColor: '#888888' },
  { id: 'metal',      label: 'Hardware',       materials: ['shiny metal'],                                              defaultColor: '#aaaaaa' },
  { id: 'visorframe', label: 'Visor Clips',    materials: ['visor support thing'],                                      defaultColor: '#212121' },
  { id: 'fmclips',    label: 'Facemask Clips', materials: ['Transparent Plastic'],                                      defaultColor: '#212121' },
  { id: 'innerliner', label: 'Inner Liner',    materials: ['wire_087224198'],                                           defaultColor: '#212121' },
];

const FINISHES = [
  { id: 'gloss',    label: 'Gloss',     roughness: 0.05, metalness: 0.1,  clearcoat: 1.0, clearcoatRoughness: 0.05, iridescence: 0.0 },
  { id: 'matte',    label: 'Matte',     roughness: 0.9,  metalness: 0.0,  clearcoat: 0.0, clearcoatRoughness: 0.0,  iridescence: 0.0 },
  { id: 'satin',    label: 'Satin',     roughness: 0.4,  metalness: 0.05, clearcoat: 0.3, clearcoatRoughness: 0.2,  iridescence: 0.0 },
  { id: 'carpaint', label: 'Car Paint', roughness: 0.15, metalness: 0.2,  clearcoat: 1.0, clearcoatRoughness: 0.02, iridescence: 1.0, iridescenceIOR: 1.8, iridescenceThicknessRange: [100, 400] },
  { id: 'chrome',   label: 'Chrome',    roughness: 0.0,  metalness: 1.0,  clearcoat: 0.0, clearcoatRoughness: 0.0,  iridescence: 0.0 },
];

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
  const materialsRef = useRef({}); // materialName → THREE.Material
  const frameRef    = useRef(null);

  const [activeTab, setActiveTab]     = useState('colors');
  const [colors, setColors]           = useState(() => Object.fromEntries(ZONES.map(z => [z.id, z.defaultColor])));
  const [finish, setFinish]           = useState('gloss');
  const [loaded, setLoaded]           = useState(false);
  const [showProductMenu, setShowProductMenu] = useState(false);
  const [showShadows, setShowShadows]         = useState(true);
  const [exporting, setExporting]             = useState(false);
  const [exported, setExported]               = useState(false);
  const [visorOn, setVisorOn]               = useState(true);
  const [glitter, setGlitter]               = useState(0.3);
  const [facemaskFinish, setFacemaskFinish] = useState('gloss'); // gloss | matte

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
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.4, '#aaccff');
    grad.addColorStop(1, '#334466');
    gCtx.fillStyle = grad;
    gCtx.fillRect(0, 0, 64, 32);
    const envTex = new THREE.CanvasTexture(gradientCanvas);
    envTex.mapping = THREE.EquirectangularReflectionMapping;
    const envRT = pmremGenerator.fromEquirectangular(envTex);
    // Store env texture for selective use on metallic materials only
    scene.userData.envTexture = envRT.texture;
    envTex.dispose();
    pmremGenerator.dispose();
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
          // Find zone this material belongs to
          const zone = ZONES.find(z => z.materials.includes(name));
          const color = zone ? colors[zone.id] : '#808080';

          const isVisor = name === 'visor';
          const newMat = new THREE.MeshPhysicalMaterial({
            color: new THREE.Color(isVisor ? '#000000' : color),
            roughness: isVisor ? 0.05 : finishDef.roughness,
            metalness: isVisor ? 0.0 : finishDef.metalness,
            clearcoat: isVisor ? 1.0 : (finishDef.clearcoat || 0),
            clearcoatRoughness: isVisor ? 0.0 : (finishDef.clearcoatRoughness || 0),
            iridescence: finishDef.iridescence || 0,
            iridescenceIOR: finishDef.iridescenceIOR || 1.5,
            transparent: isVisor,
            opacity: isVisor ? 0.25 : 1.0,
            side: isVisor ? THREE.DoubleSide : THREE.FrontSide,
            transmission: isVisor ? 0.9 : 0,
            thickness: isVisor ? 0.5 : 0,
          });

          // Apply env map only to shell/metallic materials
          const shellMaterialNames = ['Helmet Main Shell','High-Gloss Red Plastic','Car paint','shiny metal','screws metal parts'];
          if (shellMaterialNames.includes(name) && scene.userData.envTexture) {
            newMat.envMap = scene.userData.envTexture;
            newMat.envMapIntensity = 1.2;
          }
          // Store original texture for toggle
          if (mat.map) { newMat.userData.originalMap = mat.map; newMat.map = null; }

          // Store reference
          materialsRef.current[name] = newMat;

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
      setLoaded(true);
    }, undefined, (err) => console.error('GLB load error:', err));

    // Animation loop
    let t = 0;
    const animate = () => {
      frameRef.current = requestAnimationFrame(animate);
      controls.update();
      t += 0.01;
      // Slowly orbit sparkle light for dynamic catchlights
      sparkleLight.position.set(Math.sin(t) * 2, 1.5 + Math.sin(t * 0.7) * 0.5, Math.cos(t) * 2);
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
      zone.materials.forEach(matName => {
        const mat = materialsRef.current[matName];
        if (mat) mat.color.set(colors[zone.id]);
      });
    });
  }, [colors]);

  // ── VISOR ON/OFF ──────────────────────────────────────────────────────────
  useEffect(() => {
    // Toggle visor glass + visor clips together, preserve clip color
    if (sceneRef.current) {
      sceneRef.current.traverse(child => {
        if (!child.isMesh) return;
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        if (mats.some(m => m && (
          m === materialsRef.current['visor'] ||
          m === materialsRef.current['visor support thing']
        ))) {
          child.visible = visorOn;
        }
      });
    }
  }, [visorOn]);

  // Clear any baked texture from visor (removes Oakley logo)
  useEffect(() => {
    const mat = materialsRef.current['visor'];
    if (mat && mat.map) { mat.map = null; mat.needsUpdate = true; }
  }, [loaded]);

  // ── UPDATE FACEMASK FINISH ─────────────────────────────────────────────────
  useEffect(() => {
    ['facemask', 'visor support thing'].forEach(matName => {
      const mat = materialsRef.current[matName];
      if (mat) {
        mat.roughness = facemaskFinish === 'matte' ? 0.9 : 0.1;
        mat.clearcoat = facemaskFinish === 'matte' ? 0.0 : 0.8;
        mat.needsUpdate = true;
      }
    });
  }, [facemaskFinish]);

  // ── UPDATE FINISH ────────────────────────────────────────────────────────────
  useEffect(() => {
    const finishDef = FINISHES.find(f => f.id === finish);
    if (!finishDef) return;
    // Only apply finish to shell materials
    const shellMats = ['Helmet Main Shell', 'High-Gloss Red Plastic', 'Car paint'];
    Object.entries(materialsRef.current).forEach(([name, mat]) => {
      if (!shellMats.includes(name)) return; // only apply to shell
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
  }, [finish]);

  const setColor = useCallback((zoneId, val) => setColors(c => ({ ...c, [zoneId]: val })), []);

  const handleExport = useCallback(() => {
    if (!rendererRef.current) return;
    setExporting(true);
    setTimeout(() => {
      rendererRef.current.render(sceneRef.current, cameraRef.current);
      const dataURL = rendererRef.current.domElement.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = dataURL;
      a.download = 'proline-helmet.png';
      a.click();
      setExporting(false);
      setExported(true);
      setTimeout(() => setExported(false), 2500);
    }, 100);
  }, []);

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
          {isLoaded && (isSignedIn
            ? <UserButton afterSignOutUrl="/" appearance={{ elements: { avatarBox: { width: 28, height: 28 } } }} />
            : <button onClick={() => openSignIn()} style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 20, padding: '4px 12px', cursor: 'pointer', fontSize: 11, fontWeight: 700, color: '#e2e8f0', fontFamily: "'Barlow Condensed', sans-serif" }}>SIGN IN</button>
          )}
        </div>
      </div>

      {/* MAIN LAYOUT */}
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '240px 1fr', overflow: 'hidden', minHeight: 0 }}>

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
                <SectionLabel>Zone Colors</SectionLabel>
                {ZONES.map(zone => (
                  <ColorSwatch key={zone.id} color={colors[zone.id]} onChange={v => setColor(zone.id, v)} label={zone.label} />
                ))}

                <div style={{ height:1, background:'rgba(255,255,255,0.06)', margin:'14px 0' }} />
                <SectionLabel>Background</SectionLabel>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:14 }}>
                  <span style={{ fontSize:11, color:'#9ca3af' }}>Shadow Surface</span>
                  <button onClick={() => setShowShadows(s => !s)} style={{ background:showShadows?'rgba(239,255,0,0.15)':'rgba(255,255,255,0.06)', border:showShadows?'1px solid rgba(239,255,0,0.5)':'1px solid rgba(255,255,255,0.12)', borderRadius:20, padding:'3px 12px', cursor:'pointer', fontSize:9, fontWeight:700, fontFamily:"'Barlow Condensed',sans-serif", color:showShadows?'#efff00':'#6b7280', letterSpacing:'0.06em' }}>{showShadows?'ON':'OFF'}</button>
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
                  </div>
                )}
                <div style={{ height:1, background:'rgba(255,255,255,0.06)', margin:'14px 0' }} />
                <SectionLabel>Facemask Finish</SectionLabel>
                <div style={{ display:'flex', gap:6 }}>
                  {['gloss','matte'].map(f => (
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

          {/* Viewport hint + export */}
          {loaded && (
            <>
              <div style={{ position:'absolute', bottom:16, left:'50%', transform:'translateX(-50%)', fontSize:10, color:'#374151', letterSpacing:'0.1em', fontFamily:"'Barlow Condensed',sans-serif", pointerEvents:'none', whiteSpace:'nowrap' }}>
                DRAG TO ROTATE · SCROLL TO ZOOM · RIGHT-CLICK TO PAN
              </div>
              <button onClick={handleExport} disabled={exporting} style={{ position:'absolute', bottom:12, right:16, background:exported?'rgba(16,185,129,0.9)':'linear-gradient(135deg,#efff00,#c8d900)', border:'none', borderRadius:8, padding:'10px 20px', fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:13, letterSpacing:'0.06em', color:'#000', cursor:'pointer', display:'flex', alignItems:'center', gap:8 }}>
                {exported ? '✓ EXPORTED' : exporting ? 'EXPORTING...' : '↓ EXPORT PNG'}
              </button>
            </>
          )}

          {/* Back button */}
          <button onClick={() => router.push('/')} style={{ position: 'absolute', top: 16, left: 16, background: 'rgba(0,0,0,0.5)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontSize: 11, fontWeight: 700, color: '#9ca3af', fontFamily: "'Barlow Condensed', sans-serif", display: 'flex', alignItems: 'center', gap: 6 }}>
            ← ALL BUILDERS
          </button>


        </div>
      </div>
    </div>
  );
}
