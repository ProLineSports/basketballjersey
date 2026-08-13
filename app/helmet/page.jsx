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
  { id: 'shell',             label: 'Shell',                    parts: ['Shell', 'Side Screws', 'Top Screws'], defaultColor: '#2B2B2B' },
  { id: 'bumpers',           label: 'Bumpers',                  parts: ['Bumpers'],                           defaultColor: '#212121' },
  { id: 'facemask',          label: 'Facemask',                 parts: ['Facemask'],                          defaultColor: '#EFFF00' },
  { id: 'facemaskclips',     label: 'Facemask Clips',           parts: ['Facemask Clips'],                    defaultColor: '#212121' },
  { id: 'facemaskhardware',  label: 'Facemask Clips Hardware',  parts: ['Facemask Clips Hardware'],           defaultColor: '#151515' },
  { id: 'innerpads',         label: 'Inner Pads',                parts: ['Inner Pads'],                        defaultColor: '#212121' },
  { id: 'visor',             label: 'Visor',                     parts: ['Visor'],                             defaultColor: '#000000' },
  { id: 'visorclips',        label: 'Visor Clips',               parts: ['Visor Clips'],                       defaultColor: '#EFFF00' },
  { id: 'chinguardinner',    label: 'Chin Guard - Inner',        parts: ['Chin Guard - Inner'],                defaultColor: '#353535' },
  { id: 'chinguardouter',    label: 'Chin Guard - Outer',        parts: ['Chin Guard - Outer'],                defaultColor: '#EFFF00' },
  { id: 'metalparts',        label: 'Metal Parts',               parts: ['Metal Parts'],                       defaultColor: '#212121' },
  { id: 'strapclipslower',   label: 'Strap Clips - Lower',       parts: ['Strap Clips - Lower'],               defaultColor: '#EFFF00' },
  { id: 'strapclipsupper',   label: 'Strap Clips - Upper',       parts: ['Strap Clips - Upper'],               defaultColor: '#EFFF00' },
  { id: 'straps',            label: 'Straps',                    parts: ['Straps'],                            defaultColor: '#EFFF00' },
];

// Three.js sanitizes glTF node names when it loads them (for example, spaces can
// become underscores). Compare part names through a stable key so the UI can keep
// using the clean Blender/GLB names above while still matching the runtime objects.
const partKey = (name = '') => name.toLowerCase().replace(/[^a-z0-9]/g, '');
// Build part references from the loaded scene hierarchy AFTER materials have been
// replaced. This is intentionally hierarchy-based instead of assuming the named GLB
// node itself is always a THREE.Mesh. GLTFLoader may represent a named part as a Group
// with one or more Mesh descendants, so indexing only child.isMesh names can miss parts.
function indexLoadedParts(model, partsMap, objectsMap) {
  const sceneObjects = [];
  model.traverse(obj => sceneObjects.push(obj));

  for (const zone of ZONES) {
    for (const partName of zone.parts) {
      const key = partKey(partName);
      const roots = sceneObjects.filter(obj => partKey(obj.name) === key);
      const materials = [];

      roots.forEach(root => {
        root.traverse(obj => {
          if (!obj.isMesh || !obj.material) return;
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          mats.forEach(mat => {
            if (mat && !materials.includes(mat)) materials.push(mat);
          });
        });
      });

      objectsMap[key] = roots;
      partsMap[key] = materials;

      if (roots.length === 0) {
        console.warn(`[HelmetBuilder] Could not find GLB part: ${partName}`);
      }
    }
  }
}


// Generate a clean panoramic UV set for the Shell instead of using the Blender UV
// islands. The horizontal axis wraps continuously around the helmet with ONE seam at
// the center back; the middle of the texture is the front of the helmet. This makes a
// full-wrap image flow across the shell instead of breaking at every original UV island.
function applyPanoramicShellWrapUV(model, roots) {
  if (!model || !roots?.length) return null;

  // A Set prevents double-processing if a named root and one of its descendants both
  // happen to be returned for the same part.
  const meshes = [];
  const seen = new Set();
  roots.forEach(root => {
    root.traverse(obj => {
      if (!obj.isMesh || !obj.geometry?.attributes?.position || seen.has(obj)) return;
      seen.add(obj);
      meshes.push(obj);
    });
  });
  if (!meshes.length) return null;

  // Cylindrical/equirectangular UVs need a deliberate split at the rear seam. Convert
  // only the Shell to non-indexed geometry so vertices on triangles that cross u=0/1
  // can carry independent UV values without changing the visible smooth normals.
  meshes.forEach(mesh => {
    if (mesh.geometry.userData?.panoramicWrapPrepared) return;
    if (mesh.geometry.index) {
      const original = mesh.geometry;
      const expanded = original.toNonIndexed();
      expanded.userData = { ...original.userData, panoramicWrapPrepared: true };
      mesh.geometry = expanded;
    } else {
      mesh.geometry.userData = { ...mesh.geometry.userData, panoramicWrapPrepared: true };
    }
  });

  model.updateMatrixWorld(true);
  const modelInverse = new THREE.Matrix4().copy(model.matrixWorld).invert();
  const p = new THREE.Vector3();
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;

  // Calculate one common shell-space bounding box so every Shell mesh uses the exact
  // same projection center and orientation.
  meshes.forEach(mesh => {
    mesh.updateWorldMatrix(true, false);
    const localToModel = new THREE.Matrix4().multiplyMatrices(modelInverse, mesh.matrixWorld);
    const pos = mesh.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).applyMatrix4(localToModel);
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
  });

  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const width = Math.max(0.000001, maxX - minX);
  const height = Math.max(0.000001, maxY - minY);
  const depth = Math.max(0.000001, maxZ - minZ);
  const tau = Math.PI * 2;

  // The stripe length follows the helmet's sagittal arc rather than scaling geometry.
  // Estimate a Y/Z ellipse center and normalize its polar angle using center-strip
  // vertices. 0 = front edge, 1 = deepest rear edge.
  const stripePivotY = minY + height * 0.48;
  let stripeRawMin = Infinity;
  let stripeRawMax = -Infinity;
  const centerBand = width * 0.08;

  meshes.forEach(mesh => {
    mesh.updateWorldMatrix(true, false);
    const localToModel = new THREE.Matrix4().multiplyMatrices(modelInverse, mesh.matrixWorld);
    const pos = mesh.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).applyMatrix4(localToModel);
      if (Math.abs(p.x - centerX) > centerBand) continue;
      const theta = Math.atan2((p.z - centerZ) / depth, (p.y - stripePivotY) / height);
      const raw = 0.5 - theta / Math.PI;
      stripeRawMin = Math.min(stripeRawMin, raw);
      stripeRawMax = Math.max(stripeRawMax, raw);
    }
  });

  if (!Number.isFinite(stripeRawMin) || !Number.isFinite(stripeRawMax) || stripeRawMax - stripeRawMin < 0.000001) {
    stripeRawMin = 0;
    stripeRawMax = 1;
  }

  meshes.forEach(mesh => {
    mesh.updateWorldMatrix(true, false);
    const localToModel = new THREE.Matrix4().multiplyMatrices(modelInverse, mesh.matrixWorld);
    const pos = mesh.geometry.attributes.position;
    const uvValues = new Float32Array(pos.count * 2);
    const modelPositionValues = new Float32Array(pos.count * 3);
    const stripePathValues = new Float32Array(pos.count);

    // Non-indexed geometry means every three consecutive vertices form one triangle.
    // If a triangle crosses the back seam, lift its low-U vertices above 1.0. Repeat
    // wrapping then samples the same pixels while interpolation stays local to the seam.
    for (let i = 0; i < pos.count; i += 3) {
      const u = [0, 0, 0];
      const v = [0, 0, 0];
      const path = [0, 0, 0];
      const modelPos = [null, null, null];

      for (let k = 0; k < 3 && i + k < pos.count; k++) {
        p.fromBufferAttribute(pos, i + k).applyMatrix4(localToModel);
        modelPos[k] = p.clone();

        // +Z is the front of this helmet model. Front therefore lands at u=0.5 and
        // the single texture seam lands at the center rear (u=0/1).
        const angle = Math.atan2(p.x - centerX, p.z - centerZ);
        u[k] = 0.5 + angle / tau;

        // Canvas previews read top-to-bottom, so put the crown at v=0 and the lower
        // shell at v=1. This makes the editor orientation immediately understandable.
        v[k] = (maxY - p.y) / height;

        // Continuous front -> crown -> back coordinate used only by helmet-stripe decals.
        const theta = Math.atan2((p.z - centerZ) / depth, (p.y - stripePivotY) / height);
        const raw = 0.5 - theta / Math.PI;
        path[k] = THREE.MathUtils.clamp(
          (raw - stripeRawMin) / Math.max(0.000001, stripeRawMax - stripeRawMin),
          0,
          1
        );
      }

      const maxU = Math.max(...u);
      const minU = Math.min(...u);
      if (maxU - minU > 0.5) {
        for (let k = 0; k < 3; k++) if (u[k] < 0.5) u[k] += 1;
      }

      for (let k = 0; k < 3 && i + k < pos.count; k++) {
        const vi = i + k;
        uvValues[vi * 2] = u[k];
        uvValues[vi * 2 + 1] = THREE.MathUtils.clamp(v[k], 0, 1);
        stripePathValues[vi] = path[k];

        const mp = modelPos[k];
        modelPositionValues[vi * 3] = mp.x;
        modelPositionValues[vi * 3 + 1] = mp.y;
        modelPositionValues[vi * 3 + 2] = mp.z;
      }
    }

    mesh.geometry.setAttribute('uv', new THREE.BufferAttribute(uvValues, 2));
    // Car-paint AO/roughness/metalness uses uv2 in this page. Keep it aligned with
    // the generated wrap projection so the finish remains continuous too.
    mesh.geometry.setAttribute('uv2', new THREE.BufferAttribute(uvValues.slice(), 2));

    // These attributes let stripe decals be rendered directly on the Shell surface.
    // That guarantees no floating geometry and makes stripes layer above a full wrap.
    mesh.geometry.setAttribute('helmetModelPosition', new THREE.BufferAttribute(modelPositionValues, 3));
    mesh.geometry.setAttribute('helmetStripePath', new THREE.BufferAttribute(stripePathValues, 1));
    mesh.geometry.setAttribute('helmetWrapUv', new THREE.BufferAttribute(uvValues.slice(), 2));

    mesh.geometry.attributes.uv.needsUpdate = true;
    mesh.geometry.attributes.uv2.needsUpdate = true;
    mesh.geometry.attributes.helmetModelPosition.needsUpdate = true;
    mesh.geometry.attributes.helmetStripePath.needsUpdate = true;
    mesh.geometry.attributes.helmetWrapUv.needsUpdate = true;
  });

  return {
    centerX,
    centerZ,
    maxY,
    height,
    depth,
    stripePivotY,
    stripeRawMin,
    stripeRawMax,
  };
}

function applyStripeProjectionAttributes(model, roots, projection, xCompression = 1) {
  if (!model || !roots?.length || !projection) return;

  const { centerX, centerZ, height, depth, stripePivotY, stripeRawMin, stripeRawMax } = projection;
  const p = new THREE.Vector3();
  const modelInverse = new THREE.Matrix4().copy(model.matrixWorld).invert();
  const seen = new Set();

  roots.forEach(root => {
    root.traverse(obj => {
      if (!obj.isMesh || !obj.geometry?.attributes?.position || seen.has(obj)) return;
      seen.add(obj);
      obj.updateWorldMatrix(true, false);
      const localToModel = new THREE.Matrix4().multiplyMatrices(modelInverse, obj.matrixWorld);
      const pos = obj.geometry.attributes.position;
      const modelPositionValues = new Float32Array(pos.count * 3);
      const stripePathValues = new Float32Array(pos.count);

      for (let i = 0; i < pos.count; i++) {
        p.fromBufferAttribute(pos, i).applyMatrix4(localToModel);
        // Optional X compression expands stripe coverage on small crown hardware without
        // changing the stripe width on the Shell itself. Top screws use this to prevent a
        // hairline of the screw edge from peeking out beside the decal.
        modelPositionValues[i * 3] = centerX + (p.x - centerX) * xCompression;
        modelPositionValues[i * 3 + 1] = p.y;
        modelPositionValues[i * 3 + 2] = p.z;

        const theta = Math.atan2((p.z - centerZ) / depth, (p.y - stripePivotY) / height);
        const raw = 0.5 - theta / Math.PI;
        stripePathValues[i] = THREE.MathUtils.clamp(
          (raw - stripeRawMin) / Math.max(0.000001, stripeRawMax - stripeRawMin),
          0,
          1
        );
      }

      obj.geometry.setAttribute('helmetModelPosition', new THREE.BufferAttribute(modelPositionValues, 3));
      obj.geometry.setAttribute('helmetStripePath', new THREE.BufferAttribute(stripePathValues, 1));
      obj.geometry.attributes.helmetModelPosition.needsUpdate = true;
      obj.geometry.attributes.helmetStripePath.needsUpdate = true;
    });
  });
}


// ── STANDARD 3-STRIPE SURFACE DECAL ─────────────────────────────────────────
// The first geometry-based version could visibly float away from the curved shell and
// scaling Z changed its apparent depth instead of giving intuitive length control.
// This version is blended in the Shell's physical-material shader AFTER the wrap/map
// is sampled. Result: it is exactly on the helmet surface, always above a wrap, naturally
// below separate bumper geometry, and its rear endpoint can move forward without
// deforming the stripe thickness.
function installDecalOverlayShader(material, decalUniforms) {
  if (!material || material.userData?.helmetDecalOverlayInstalled) return;
  material.userData.helmetDecalOverlayInstalled = true;

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uHelmetStripesEnabled = decalUniforms.enabled;
    shader.uniforms.uHelmetStripeBaseEnabled = decalUniforms.baseEnabled;
    shader.uniforms.uHelmetStripeWidthScale = decalUniforms.widthScale;
    shader.uniforms.uHelmetStripeLength = decalUniforms.length;
    shader.uniforms.uHelmetStripeCenterX = decalUniforms.centerX;
    shader.uniforms.uHelmetStripeLeftColor = decalUniforms.leftColor;
    shader.uniforms.uHelmetStripeCenterColor = decalUniforms.centerColor;
    shader.uniforms.uHelmetStripeRightColor = decalUniforms.rightColor;
    shader.uniforms.uHelmetStripeDesignEnabled = decalUniforms.designEnabled;
    shader.uniforms.uHelmetStripeDesignMap = decalUniforms.designMap;
    shader.uniforms.uHelmetWrapEnabled = decalUniforms.wrapEnabled;
    shader.uniforms.uHelmetWrapMap = decalUniforms.wrapMap;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec3 helmetModelPosition;
attribute float helmetStripePath;
attribute vec2 helmetWrapUv;
varying vec3 vHelmetModelPosition;
varying float vHelmetStripePath;
varying vec2 vHelmetWrapUv;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vHelmetModelPosition = helmetModelPosition;
vHelmetStripePath = helmetStripePath;
vHelmetWrapUv = helmetWrapUv;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vHelmetModelPosition;
varying float vHelmetStripePath;
varying vec2 vHelmetWrapUv;
uniform float uHelmetStripesEnabled;
uniform float uHelmetStripeBaseEnabled;
uniform float uHelmetStripeWidthScale;
uniform float uHelmetStripeLength;
uniform float uHelmetStripeCenterX;
uniform vec3 uHelmetStripeLeftColor;
uniform vec3 uHelmetStripeCenterColor;
uniform vec3 uHelmetStripeRightColor;
uniform float uHelmetStripeDesignEnabled;
uniform sampler2D uHelmetStripeDesignMap;
uniform float uHelmetWrapEnabled;
uniform sampler2D uHelmetWrapMap;`
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>

vec4 helmetDecal = vec4(0.0);

// Full wrap is the lowest decal layer. Its generated canvas is opaque because it
// already includes the user's shell color behind transparent uploaded pixels.
if (uHelmetWrapEnabled > 0.5) {
  helmetDecal = texture2D(uHelmetWrapMap, vHelmetWrapUv);
}

if (uHelmetStripesEnabled > 0.5) {
  float stripeW = 0.020 * uHelmetStripeWidthScale;
  float stripeX = vHelmetModelPosition.x - uHelmetStripeCenterX;
  float totalHalfWidth = stripeW * 1.5;
  float edgeAA = max(fwidth(stripeX) * 1.5, 0.00030);
  float widthMask = 1.0 - smoothstep(totalHalfWidth - edgeAA, totalHalfWidth + edgeAA, abs(stripeX));

  float pathAA = max(fwidth(vHelmetStripePath) * 1.5, 0.0020);
  float lengthMask = 1.0 - smoothstep(
    uHelmetStripeLength - pathAA,
    uHelmetStripeLength + pathAA,
    vHelmetStripePath
  );
  float stripeMask = widthMask * lengthMask;

  vec3 stripeColor = uHelmetStripeCenterColor;
  if (stripeX < -0.5 * stripeW) stripeColor = uHelmetStripeLeftColor;
  else if (stripeX > 0.5 * stripeW) stripeColor = uHelmetStripeRightColor;

  // Preset stripes sit above the wrap.
  if (uHelmetStripeBaseEnabled > 0.5) {
    helmetDecal.rgb = mix(helmetDecal.rgb, stripeColor, stripeMask);
    helmetDecal.a = max(helmetDecal.a, stripeMask);
  }

  // Uploaded stripe artwork is the top stripe layer. Transparent PNG areas reveal
  // the preset stripe or wrap below it; fully opaque pixels completely cover them.
  if (uHelmetStripeDesignEnabled > 0.5) {
    float localU = (stripeX + totalHalfWidth) / max(totalHalfWidth * 2.0, 0.0001);
    float localV = 1.0 - (vHelmetStripePath / max(uHelmetStripeLength, 0.0001));
    if (localU >= 0.0 && localU <= 1.0 && localV >= 0.0 && localV <= 1.0) {
      vec4 designSample = texture2D(uHelmetStripeDesignMap, vec2(localU, localV));
      float designMask = stripeMask * designSample.a;
      helmetDecal.rgb = mix(helmetDecal.rgb, designSample.rgb, designMask);
      helmetDecal.a = max(helmetDecal.a, designMask);
    }
  }
}

// There is no decal at this fragment, so do not render the overlay at all. This is
// what prevents the Shell's Car Paint/glitter material from leaking into opaque decals:
// the decal is now a separate physical surface/material in front of the Shell.
if (helmetDecal.a <= 0.001) discard;

diffuseColor.rgb = helmetDecal.rgb;
diffuseColor.a *= helmetDecal.a;`
      );
  };

  material.customProgramCacheKey = () => 'helmet-decal-overlay-v1';
  material.needsUpdate = true;
}

function createShellDecalOverlays(roots, decalUniforms) {
  const overlays = [];
  const materials = [];
  const sources = [];
  const seen = new Set();

  roots.forEach(root => {
    root.traverse(obj => {
      if (!obj.isMesh || !obj.geometry?.attributes?.helmetModelPosition || seen.has(obj)) return;
      seen.add(obj);
      sources.push(obj);
    });
  });

  sources.forEach(source => {
    const material = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: 0.08,
      metalness: 0.0,
      clearcoat: 1.0,
      clearcoatRoughness: 0.04,
      transparent: true,
      opacity: 1.0,
      alphaTest: 0.001,
      side: THREE.FrontSide,
      depthTest: true,
      depthWrite: true,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    installDecalOverlayShader(material, decalUniforms);

    const overlay = new THREE.Mesh(source.geometry, material);
    overlay.name = `${source.name || 'Shell'}_DecalOverlay`;
    overlay.position.copy(source.position);
    overlay.quaternion.copy(source.quaternion);
    overlay.scale.copy(source.scale);
    overlay.renderOrder = (source.renderOrder || 0) + 1;
    overlay.castShadow = false;
    overlay.receiveShadow = false;
    source.parent?.add(overlay);

    overlays.push(overlay);
    materials.push(material);
  });

  return { overlays, materials };
}


function findFirstProjectableMesh(roots) {
  for (const root of roots || []) {
    let found = null;
    root.traverse(obj => {
      if (!found && obj.isMesh && obj.geometry?.attributes?.position) found = obj;
    });
    if (found) return found;
  }
  return null;
}

function computeRootsBoundsInModelSpace(model, roots) {
  if (!model || !roots?.length) return null;
  const p = new THREE.Vector3();
  const modelInverse = new THREE.Matrix4().copy(model.matrixWorld).invert();
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  const seen = new Set();

  roots.forEach(root => {
    root.traverse(obj => {
      if (!obj.isMesh || !obj.geometry?.attributes?.position || seen.has(obj)) return;
      seen.add(obj);
      obj.updateWorldMatrix(true, false);
      const localToModel = new THREE.Matrix4().multiplyMatrices(modelInverse, obj.matrixWorld);
      const pos = obj.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        p.fromBufferAttribute(pos, i).applyMatrix4(localToModel);
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
        minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
      }
    });
  });

  if (!Number.isFinite(minX)) return null;
  return {
    minX, maxX, minY, maxY, minZ, maxZ,
    width: Math.max(0.000001, maxX - minX),
    height: Math.max(0.000001, maxY - minY),
    depth: Math.max(0.000001, maxZ - minZ),
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
    centerZ: (minZ + maxZ) / 2,
  };
}


function collectMeshDescendants(roots) {
  const meshes = [];
  const seen = new Set();
  (roots || []).forEach(root => {
    root.traverse(obj => {
      if (!obj.isMesh || !obj.geometry?.attributes?.position || seen.has(obj)) return;
      seen.add(obj);
      meshes.push(obj);
    });
  });
  return meshes;
}

function getWorldBoundsForRoots(roots) {
  const box = new THREE.Box3();
  let hasAny = false;
  (roots || []).forEach(root => {
    root.updateWorldMatrix(true, true);
    const rootBox = new THREE.Box3().setFromObject(root, true);
    if (!rootBox.isEmpty()) {
      box.union(rootBox);
      hasAny = true;
    }
  });
  if (!hasAny || box.isEmpty()) return null;
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  return { box, size, center };
}

function offsetGeometryAlongNormals(geometry, amount) {
  if (!geometry || !amount) return geometry;
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  const pos = geometry.attributes.position;
  const normal = geometry.attributes.normal;
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(
      i,
      pos.getX(i) + normal.getX(i) * amount,
      pos.getY(i) + normal.getY(i) * amount,
      pos.getZ(i) + normal.getZ(i) * amount,
    );
  }
  pos.needsUpdate = true;
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function createSelectionBoxTexture() {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  ctx.strokeStyle = '#efff00';
  ctx.lineWidth = 6;
  ctx.setLineDash([14, 9]);
  ctx.strokeRect(14, 14, size - 28, size - 28);
  ctx.setLineDash([]);
  const handle = 20;
  [[14,14],[size-14,14],[14,size-14],[size-14,size-14]].forEach(([x,y]) => {
    ctx.fillStyle = '#111111';
    ctx.strokeStyle = '#efff00';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.rect(x - handle/2, y - handle/2, handle, handle);
    ctx.fill();
    ctx.stroke();
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

function createSideLogoTexturePack(image, options = {}) {
  if (!image) return null;
  const {
    mirror = false,
    rotate180 = false,
    strokeEnabled = false,
    strokeColor = '#ffffff',
    strokeThickness = 8,
    strokeOpacity = 1,
  } = options;

  const size = 1024;
  const baseCanvas = document.createElement('canvas');
  baseCanvas.width = size;
  baseCanvas.height = size;
  const baseCtx = baseCanvas.getContext('2d');
  if (!baseCtx) return null;

  // Keep the base logo footprint fixed so increasing the stroke does not make
  // the logo itself shrink. We reserve a generous constant margin instead.
  const pad = 120;
  const fitW = size - pad * 2;
  const fitH = size - pad * 2;
  const scale = Math.min(fitW / image.naturalWidth, fitH / image.naturalHeight);
  const drawW = image.naturalWidth * scale;
  const drawH = image.naturalHeight * scale;

  baseCtx.clearRect(0, 0, size, size);
  baseCtx.save();
  baseCtx.translate(size / 2, size / 2);
  if (rotate180) baseCtx.rotate(Math.PI);
  baseCtx.scale(mirror ? -1 : 1, 1);
  baseCtx.drawImage(image, -drawW / 2, -drawH / 2, drawW, drawH);
  baseCtx.restore();

  const makeExpandedAlphaCanvas = (radiusPx, colorHex, opacityValue, cutCenter = false) => {
    const out = document.createElement('canvas');
    out.width = size;
    out.height = size;
    const ctx = out.getContext('2d');
    if (!ctx) return out;
    const radius = Math.max(0, radiusPx);
    const steps = Math.max(12, Math.ceil(radius * 12));
    for (let i = 0; i < steps; i++) {
      const angle = (i / steps) * Math.PI * 2;
      const dx = Math.cos(angle) * radius;
      const dy = Math.sin(angle) * radius;
      ctx.drawImage(baseCanvas, dx, dy);
    }
    ctx.globalCompositeOperation = 'source-in';
    ctx.globalAlpha = opacityValue;
    ctx.fillStyle = colorHex;
    ctx.fillRect(0, 0, size, size);
    ctx.globalAlpha = 1;
    if (cutCenter) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.drawImage(baseCanvas, 0, 0);
    }
    ctx.globalCompositeOperation = 'source-over';
    return out;
  };

  const finalCanvas = document.createElement('canvas');
  finalCanvas.width = size;
  finalCanvas.height = size;
  const finalCtx = finalCanvas.getContext('2d');
  if (!finalCtx) return null;
  if (strokeEnabled && strokeThickness > 0 && strokeOpacity > 0) {
    const strokeCanvas = makeExpandedAlphaCanvas(strokeThickness, strokeColor, strokeOpacity, true);
    finalCtx.drawImage(strokeCanvas, 0, 0);
  }
  finalCtx.drawImage(baseCanvas, 0, 0);

  const rimCanvas = makeExpandedAlphaCanvas(
    Math.max(2, strokeEnabled ? strokeThickness * 0.65 : 4),
    '#000000',
    strokeEnabled ? 0.16 : 0.12,
    true
  );

  const mainTexture = new THREE.CanvasTexture(finalCanvas);
  mainTexture.colorSpace = THREE.SRGBColorSpace;
  mainTexture.wrapS = mainTexture.wrapT = THREE.ClampToEdgeWrapping;
  mainTexture.needsUpdate = true;

  const rimTexture = new THREE.CanvasTexture(rimCanvas);
  rimTexture.colorSpace = THREE.SRGBColorSpace;
  rimTexture.wrapS = rimTexture.wrapT = THREE.ClampToEdgeWrapping;
  rimTexture.needsUpdate = true;

  return {
    aspect: image.naturalWidth / Math.max(1, image.naturalHeight),
    mainTexture,
    rimTexture,
  };
}

const DEFAULT_SIDE_LOGO_PLACEMENT = Object.freeze({ yNorm: 0.64, zNorm: -0.18, scale: 1, rotation: 0 });
const cloneDefaultSideLogoPlacement = () => ({ ...DEFAULT_SIDE_LOGO_PLACEMENT });

const FINISHES = [
  { id: 'gloss',    label: 'Gloss',     roughness: 0.05, metalness: 0.1,  clearcoat: 1.0, clearcoatRoughness: 0.05, iridescence: 0.0 },
  { id: 'matte',    label: 'Matte',     roughness: 0.9,  metalness: 0.0,  clearcoat: 0.0, clearcoatRoughness: 0.0,  iridescence: 0.0 },
  { id: 'satin',    label: 'Satin',     roughness: 0.4,  metalness: 0.05, clearcoat: 0.3, clearcoatRoughness: 0.2,  iridescence: 0.0 },
  // iridescence dialed way down from 1.0 — full-strength iridescence produced a rainbow oil-slick
  // look that read as "broken" rather than sparkly metallic paint. 0.35 gives a subtle pearlescent shift.
  { id: 'carpaint', label: 'Car Paint', roughness: 0.15, metalness: 0.2,  clearcoat: 1.0, clearcoatRoughness: 0.02, iridescence: 0.35, iridescenceIOR: 1.8, iridescenceThicknessRange: [100, 300] },
  { id: 'chrome',   label: 'Chrome',    roughness: 0.0,  metalness: 1.0,  clearcoat: 0.0, clearcoatRoughness: 0.0,  iridescence: 0.0 },
];

const DECAL_FINISHES = [
  { id: 'gloss',  label: 'Gloss',  roughness: 0.08, metalness: 0.0, clearcoat: 1.0, clearcoatRoughness: 0.04 },
  { id: 'satin',  label: 'Satin',  roughness: 0.38, metalness: 0.0, clearcoat: 0.25, clearcoatRoughness: 0.20 },
  { id: 'matte',  label: 'Matte',  roughness: 0.88, metalness: 0.0, clearcoat: 0.0, clearcoatRoughness: 0.0 },
  { id: 'chrome', label: 'Chrome', roughness: 0.02, metalness: 1.0, clearcoat: 0.0, clearcoatRoughness: 0.0 },
];

function applyDecalFinishToMaterials(materials, scene, finishId) {
  const def = DECAL_FINISHES.find(f => f.id === finishId) || DECAL_FINISHES[0];
  materials.forEach(mat => {
    mat.roughness = def.roughness;
    mat.metalness = def.metalness;
    mat.clearcoat = def.clearcoat;
    mat.clearcoatRoughness = def.clearcoatRoughness;
    mat.iridescence = 0;
    mat.emissive?.set(0x000000);
    mat.emissiveMap = null;
    mat.roughnessMap = null;
    mat.metalnessMap = null;
    mat.aoMap = null;
    mat.envMap = finishId === 'chrome'
      ? (scene?.userData?.chromeEnvTexture || scene?.userData?.envTexture || null)
      : null;
    mat.envMapIntensity = finishId === 'chrome' ? 1.6 : 0;
    mat.needsUpdate = true;
  });
}


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
  const modelRef    = useRef(null);
  const cameraRef   = useRef(null);
  const rendererRef = useRef(null);
  const controlsRef = useRef(null);
  const materialsRef = useRef({}); // materialName → THREE.Material[] (finish/env routing)
  const partsRef     = useRef({}); // normalized GLB part key → THREE.Material[] (color routing)
  const partObjectsRef = useRef({}); // normalized GLB part key → THREE.Object3D[] (visibility routing)
  const frameRef    = useRef(null);

  // Full-wrap design layer. The uploaded image is composited over the current shell
  // color onto a 2:1 panoramic canvas. At load time the Shell receives a generated
  // continuous wrap projection with the front in the center and one seam at the rear,
  // so artwork flows over the rounded helmet instead of following fragmented UV islands.
  const wrapImageRef     = useRef(null);
  const wrapCanvasRef    = useRef(null);
  const wrapTextureRef   = useRef(null);
  const wrapObjectUrlRef = useRef(null);

  // Uploaded custom artwork for the stripe zone. This is rendered into a tall canvas
  // and sampled inside the stripe area so it stays contained by the current stripe width/length.
  const stripeDesignImageRef     = useRef(null);
  const stripeDesignCanvasRef    = useRef(null);
  const stripeDesignTextureRef   = useRef(null);
  const stripeDesignObjectUrlRef = useRef(null);
  const decalOverlayMeshesRef    = useRef([]);
  const decalOverlayMaterialsRef = useRef([]);
  const sideLogoMeshesRef        = useRef([]);
  const sideLogoMaterialsRef     = useRef([]);
  const sideLogoTexturesRef      = useRef([]);
  const sideLogoSharedImageRef   = useRef(null);
  const sideLogoLeftImageRef     = useRef(null);
  const sideLogoRightImageRef    = useRef(null);
  const sideLogoSharedObjectUrlRef = useRef(null);
  const sideLogoLeftObjectUrlRef   = useRef(null);
  const sideLogoRightObjectUrlRef  = useRef(null);
  const sideLogoPlacementRef = useRef({
    // Default main-logo target: centered in the classic side-logo zone.
    left:  cloneDefaultSideLogoPlacement(),
    right: cloneDefaultSideLogoPlacement(),
  });
  const selectedSideLogoRef = useRef(null);
  const sideLogoWorldFrameRef = useRef({ left:null, right:null });
  const sideLogoInteractionRef = useRef({
    dragging:false,
    pointerId:null,
    side:null,
    action:null,
    startScale:1,
    startRotation:0,
    startDistance:1,
    startAngle:0,
    centerClient:null,
  });

  // Shared shader-uniform objects for Shell stripe decals. The renderer keeps references
  // to these objects across material recompiles (wrap on/off, finish changes, etc.).
  const stripeUniformsRef = useRef({
    enabled:         { value: 0 },
    baseEnabled:     { value: 0 },
    widthScale:      { value: 1 },
    length:          { value: 1 },
    centerX:         { value: 0 },
    leftColor:       { value: new THREE.Color('#efff00') },
    centerColor:     { value: new THREE.Color('#eaeaea') },
    rightColor:      { value: new THREE.Color('#efff00') },
    designEnabled:   { value: 0 },
    designMap:       { value: null },
    wrapEnabled:     { value: 0 },
    wrapMap:         { value: null },
  });

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

  const [wrapEnabled, setWrapEnabled]       = useState(false);
  const [wrapPreviewUrl, setWrapPreviewUrl] = useState(null);
  const [wrapFileName, setWrapFileName]     = useState('');
  const [wrapError, setWrapError]           = useState('');
  const [wrapScale, setWrapScale]           = useState(1);
  const [wrapRotation, setWrapRotation]     = useState(0);
  const [wrapOffsetX, setWrapOffsetX]       = useState(0);
  const [wrapOffsetY, setWrapOffsetY]       = useState(0);
  const [wrapOpacity, setWrapOpacity]       = useState(1);
  const [wrapRevision, setWrapRevision]     = useState(0);

  const [helmetStripesEnabled, setHelmetStripesEnabled] = useState(false);
  const [helmetStripeWidth, setHelmetStripeWidth]       = useState(2);
  const [helmetStripeLength, setHelmetStripeLength]     = useState(1);
  const [helmetStripeLeftColor, setHelmetStripeLeftColor]     = useState('#efff00');
  const [helmetStripeCenterColor, setHelmetStripeCenterColor] = useState('#eaeaea');
  const [helmetStripeRightColor, setHelmetStripeRightColor]   = useState('#efff00');
  const [helmetStripeDesignEnabled, setHelmetStripeDesignEnabled] = useState(false);
  const [helmetStripeDesignPreviewUrl, setHelmetStripeDesignPreviewUrl] = useState(null);
  const [helmetStripeDesignFileName, setHelmetStripeDesignFileName] = useState('');
  const [helmetStripeDesignError, setHelmetStripeDesignError] = useState('');
  const [helmetStripeDesignScale, setHelmetStripeDesignScale] = useState(1);
  const [helmetStripeDesignRotation, setHelmetStripeDesignRotation] = useState(0);
  const [helmetStripeDesignOffsetX, setHelmetStripeDesignOffsetX] = useState(0);
  const [helmetStripeDesignOffsetY, setHelmetStripeDesignOffsetY] = useState(0);
  const [helmetStripeDesignOpacity, setHelmetStripeDesignOpacity] = useState(1);
  const [helmetStripeDesignRevision, setHelmetStripeDesignRevision] = useState(0);
  const [activeViewPreset, setActiveViewPreset] = useState('sideA');
  const [decalFinish, setDecalFinish] = useState('gloss');

  const [sideLogoIndependent, setSideLogoIndependent] = useState(false);
  const [sideLogoError, setSideLogoError] = useState('');
  const [sideLogoSharedPreviewUrl, setSideLogoSharedPreviewUrl] = useState(null);
  const [sideLogoSharedFileName, setSideLogoSharedFileName] = useState('');
  const [sideLogoLeftPreviewUrl, setSideLogoLeftPreviewUrl] = useState(null);
  const [sideLogoLeftFileName, setSideLogoLeftFileName] = useState('');
  const [sideLogoRightPreviewUrl, setSideLogoRightPreviewUrl] = useState(null);
  const [sideLogoRightFileName, setSideLogoRightFileName] = useState('');
  const [sideLogoLeftVisible, setSideLogoLeftVisible] = useState(true);
  const [sideLogoRightVisible, setSideLogoRightVisible] = useState(true);
  const [sideLogoLeftMirror, setSideLogoLeftMirror] = useState(false);
  const [sideLogoRightMirror, setSideLogoRightMirror] = useState(true);
  const [sideLogoLeftRotate180, setSideLogoLeftRotate180] = useState(false);
  const [sideLogoRightRotate180, setSideLogoRightRotate180] = useState(false);
  const [sideLogoScale, setSideLogoScale] = useState(1);
  const [sideLogoFrontBack, setSideLogoFrontBack] = useState(0);
  const [sideLogoUpDown, setSideLogoUpDown] = useState(0);
  const [sideLogoStrokeEnabled, setSideLogoStrokeEnabled] = useState(false);
  const [sideLogoStrokeColor, setSideLogoStrokeColor] = useState('#ffffff');
  const [sideLogoStrokeThickness, setSideLogoStrokeThickness] = useState(8);
  const [sideLogoStrokeOpacity, setSideLogoStrokeOpacity] = useState(0.2);
  const [sideLogoRevision, setSideLogoRevision] = useState(0);
  const [selectedSideLogo, setSelectedSideLogo] = useState(null); // left | right | null
  const [sideLogoLocked, setSideLogoLocked] = useState(false);

  const finishRef = useRef(finish);
  useEffect(() => { finishRef.current = finish; }, [finish]);
  const facemaskFinishRef = useRef(facemaskFinish);
  useEffect(() => { facemaskFinishRef.current = facemaskFinish; }, [facemaskFinish]);
  const decalFinishRef = useRef(decalFinish);
  useEffect(() => { decalFinishRef.current = decalFinish; }, [decalFinish]);

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

  // ── FULL WRAP UPLOAD + CONTROLS ─────────────────────────────────────────────
  const resetWrapTransform = useCallback(() => {
    setWrapScale(1);
    setWrapRotation(0);
    setWrapOffsetX(0);
    setWrapOffsetY(0);
    setWrapOpacity(1);
  }, []);

  const removeWrap = useCallback(() => {
    if (wrapObjectUrlRef.current) {
      URL.revokeObjectURL(wrapObjectUrlRef.current);
      wrapObjectUrlRef.current = null;
    }
    wrapImageRef.current = null;
    setWrapPreviewUrl(null);
    setWrapFileName('');
    setWrapError('');
    setWrapEnabled(false);
    resetWrapTransform();
    setWrapRevision(r => r + 1);
  }, [resetWrapTransform]);

  const handleWrapUpload = useCallback((event) => {
    const file = event.target.files?.[0];
    // Allow the same file to be chosen again after removal or validation failure.
    event.target.value = '';
    if (!file) return;

    if (!['image/png', 'image/jpeg'].includes(file.type)) {
      setWrapError('Please upload a PNG or JPEG image.');
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      if (img.naturalWidth < 1080 || img.naturalHeight < 1080) {
        URL.revokeObjectURL(objectUrl);
        setWrapError(`Image is ${img.naturalWidth}×${img.naturalHeight}px. Please use at least 1080×1080px.`);
        return;
      }

      if (wrapObjectUrlRef.current) URL.revokeObjectURL(wrapObjectUrlRef.current);
      wrapObjectUrlRef.current = objectUrl;
      wrapImageRef.current = img;
      setWrapPreviewUrl(objectUrl);
      setWrapFileName(file.name);
      setWrapError('');
      setWrapEnabled(true);
      resetWrapTransform();
      setWrapRevision(r => r + 1);
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      setWrapError('That image could not be read. Please try another PNG or JPEG.');
    };
    img.src = objectUrl;
  }, [resetWrapTransform]);

  // Revoke browser object URLs and dispose the generated texture when leaving the page.
  useEffect(() => () => {
    if (wrapObjectUrlRef.current) URL.revokeObjectURL(wrapObjectUrlRef.current);
    if (wrapTextureRef.current) wrapTextureRef.current.dispose();
  }, []);

  // ── STRIPE DESIGN UPLOAD + CONTROLS ────────────────────────────────────────
  const resetStripeDesignTransform = useCallback(() => {
    setHelmetStripeDesignScale(1);
    setHelmetStripeDesignRotation(0);
    setHelmetStripeDesignOffsetX(0);
    setHelmetStripeDesignOffsetY(0);
    setHelmetStripeDesignOpacity(1);
  }, []);

  const removeStripeDesign = useCallback(() => {
    if (stripeDesignObjectUrlRef.current) {
      URL.revokeObjectURL(stripeDesignObjectUrlRef.current);
      stripeDesignObjectUrlRef.current = null;
    }
    stripeDesignImageRef.current = null;
    setHelmetStripeDesignPreviewUrl(null);
    setHelmetStripeDesignFileName('');
    setHelmetStripeDesignError('');
    setHelmetStripeDesignEnabled(false);
    resetStripeDesignTransform();
    setHelmetStripeDesignRevision(r => r + 1);
  }, [resetStripeDesignTransform]);

  const handleStripeDesignUpload = useCallback((event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    if (!['image/png', 'image/jpeg'].includes(file.type)) {
      setHelmetStripeDesignError('Please upload a PNG or JPEG image.');
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      if (stripeDesignObjectUrlRef.current) URL.revokeObjectURL(stripeDesignObjectUrlRef.current);
      stripeDesignObjectUrlRef.current = objectUrl;
      stripeDesignImageRef.current = img;
      setHelmetStripeDesignPreviewUrl(objectUrl);
      setHelmetStripeDesignFileName(file.name);
      setHelmetStripeDesignError('');
      setHelmetStripeDesignEnabled(true);
      resetStripeDesignTransform();
      setHelmetStripeDesignRevision(r => r + 1);
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      setHelmetStripeDesignError('That image could not be read. Please try another PNG or JPEG.');
    };
    img.src = objectUrl;
  }, [resetStripeDesignTransform]);

  useEffect(() => () => {
    if (stripeDesignObjectUrlRef.current) URL.revokeObjectURL(stripeDesignObjectUrlRef.current);
    if (stripeDesignTextureRef.current) stripeDesignTextureRef.current.dispose();
  }, []);

  const assignSideLogoFile = useCallback((slot, file) => {
    if (!file) return;
    if (!['image/png', 'image/jpeg'].includes(file.type)) {
      setSideLogoError('Please upload a PNG or JPEG for the side logo decal.');
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const slotMap = {
        shared: { ref: sideLogoSharedImageRef, urlRef: sideLogoSharedObjectUrlRef, setPreview: setSideLogoSharedPreviewUrl, setName: setSideLogoSharedFileName },
        left: { ref: sideLogoLeftImageRef, urlRef: sideLogoLeftObjectUrlRef, setPreview: setSideLogoLeftPreviewUrl, setName: setSideLogoLeftFileName },
        right: { ref: sideLogoRightImageRef, urlRef: sideLogoRightObjectUrlRef, setPreview: setSideLogoRightPreviewUrl, setName: setSideLogoRightFileName },
      };
      const target = slotMap[slot];
      if (!target) return;
      if (target.urlRef.current) URL.revokeObjectURL(target.urlRef.current);
      target.urlRef.current = objectUrl;
      target.ref.current = img;
      target.setPreview(objectUrl);
      target.setName(file.name);
      if (slot === 'shared') {
        sideLogoPlacementRef.current.left = cloneDefaultSideLogoPlacement();
        sideLogoPlacementRef.current.right = cloneDefaultSideLogoPlacement();
      } else if (sideLogoPlacementRef.current[slot]) {
        sideLogoPlacementRef.current[slot] = cloneDefaultSideLogoPlacement();
      }
      setSideLogoError('');
      setSideLogoRevision(v => v + 1);
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      setSideLogoError('That side logo file could not be read. Please try another PNG or JPEG.');
    };
    img.src = objectUrl;
  }, []);

  const handleSharedSideLogoUpload = useCallback((event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) assignSideLogoFile('shared', file);
  }, [assignSideLogoFile]);

  const handleLeftSideLogoUpload = useCallback((event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) assignSideLogoFile('left', file);
  }, [assignSideLogoFile]);

  const handleRightSideLogoUpload = useCallback((event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) assignSideLogoFile('right', file);
  }, [assignSideLogoFile]);

  const removeSideLogoUpload = useCallback((slot) => {
    const slotMap = {
      shared: { ref: sideLogoSharedImageRef, urlRef: sideLogoSharedObjectUrlRef, setPreview: setSideLogoSharedPreviewUrl, setName: setSideLogoSharedFileName },
      left: { ref: sideLogoLeftImageRef, urlRef: sideLogoLeftObjectUrlRef, setPreview: setSideLogoLeftPreviewUrl, setName: setSideLogoLeftFileName },
      right: { ref: sideLogoRightImageRef, urlRef: sideLogoRightObjectUrlRef, setPreview: setSideLogoRightPreviewUrl, setName: setSideLogoRightFileName },
    };
    const target = slotMap[slot];
    if (!target) return;
    if (target.urlRef.current) {
      URL.revokeObjectURL(target.urlRef.current);
      target.urlRef.current = null;
    }
    target.ref.current = null;
    target.setPreview(null);
    target.setName('');
    setSideLogoRevision(v => v + 1);
  }, []);

  useEffect(() => () => {
    [sideLogoSharedObjectUrlRef, sideLogoLeftObjectUrlRef, sideLogoRightObjectUrlRef].forEach(ref => {
      if (ref.current) URL.revokeObjectURL(ref.current);
    });
  }, []);

  useEffect(() => {
    if (sideLogoIndependent) return;
    const sourceSide = selectedSideLogoRef.current === 'right' ? 'right' : 'left';
    const sourcePlacement = sideLogoPlacementRef.current[sourceSide] || cloneDefaultSideLogoPlacement();
    sideLogoPlacementRef.current.left = { ...sourcePlacement };
    sideLogoPlacementRef.current.right = { ...sourcePlacement };
    setSideLogoRevision(v => v + 1);
  }, [sideLogoIndependent]);

  const applyViewPreset = useCallback((presetId) => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) return;

    const target = new THREE.Vector3(0, 0.05, 0);
    const presets = {
      sideA: { position: [-3.2, 0.1, 0.0], up: [0, 1, 0] },
      sideB: { position: [3.2, 0.1, 0.0], up: [0, 1, 0] },
      front: { position: [0.0, 0.08, 3.15], up: [0, 1, 0] },
      back:  { position: [0.0, 0.08, -3.15], up: [0, 1, 0] },
      top:   { position: [0.0, 3.25, 0.001], up: [0, 0, 1] },
      hero:  { position: [-1.95, 1.18, 2.15], up: [0, 1, 0] },
    };

    const preset = presets[presetId] || presets.sideA;
    camera.up.set(...preset.up);
    camera.position.set(...preset.position);
    controls.target.copy(target);
    camera.lookAt(target);
    controls.update();
    setActiveViewPreset(presetId);
  }, []);

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

    // Chrome reflection — use the stadium photo for realistic shapes/highlights, but
    // desaturate it before PMREM generation so colored seats/signage (especially red)
    // cannot tint a user's chrome finish. The source JPG itself does not need editing.
    const chromeLoader = new THREE.TextureLoader();
    chromeLoader.load(
      '/chrome-reflection.jpg',
      (tex) => {
        const image = tex.image;
        const chromeCanvas = document.createElement('canvas');
        chromeCanvas.width = image?.naturalWidth || image?.width || 1;
        chromeCanvas.height = image?.naturalHeight || image?.height || 1;
        const chromeCtx = chromeCanvas.getContext('2d', { willReadFrequently: true });
        chromeCtx.drawImage(image, 0, 0, chromeCanvas.width, chromeCanvas.height);

        // Convert every pixel to luminance while preserving the photo's contrast.
        const pixels = chromeCtx.getImageData(0, 0, chromeCanvas.width, chromeCanvas.height);
        const data = pixels.data;
        for (let i = 0; i < data.length; i += 4) {
          const gray = Math.round(data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722);
          data[i] = gray;
          data[i + 1] = gray;
          data[i + 2] = gray;
        }
        chromeCtx.putImageData(pixels, 0, 0);

        const neutralChromeTex = new THREE.CanvasTexture(chromeCanvas);
        neutralChromeTex.mapping = THREE.EquirectangularReflectionMapping;
        neutralChromeTex.colorSpace = THREE.SRGBColorSpace;

        const chromePmrem = new THREE.PMREMGenerator(renderer);
        chromePmrem.compileEquirectangularShader();
        const chromeRT = chromePmrem.fromEquirectangular(neutralChromeTex);
        scene.userData.chromeEnvTexture = chromeRT.texture;
        neutralChromeTex.dispose();
        tex.dispose();
        chromePmrem.dispose();

        // Refresh in case Chrome is already the active finish and materials already exist
        applyShellEnvMap(materialsRef.current, scene, finishRef.current);
        applyFacemaskEnvMap(materialsRef.current, scene, facemaskFinishRef.current);
        applyDecalFinishToMaterials([
          ...decalOverlayMaterialsRef.current,
          ...sideLogoMaterialsRef.current.filter(mat => mat.userData?.sideLogoMainMaterial),
        ], scene, decalFinishRef.current);
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
      modelRef.current = model;

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
          // Use the source material color only as a temporary value. Exact UI zone colors
          // are applied after the entire loaded hierarchy is indexed by GLB part name below.
          const color = mat.color ? `#${mat.color.getHexString()}` : '#808080';

          const isVisor = name === 'visor';
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

          // Part/color references are indexed in one pass after this traversal. Doing
          // that from the final hierarchy catches both named Mesh nodes and named Group nodes.

          // Replace
          if (Array.isArray(child.material)) {
            const idx = child.material.indexOf(mat);
            child.material[idx] = newMat;
          } else {
            child.material = newMat;
          }
        });
      });

      // Rebuild part references from the FINAL loaded hierarchy. This is the key routing
      // step for every color control, including parts whose Blender object name differs
      // from its material name (clips, pads, chin guards, metal parts, etc.).
      partsRef.current = {};
      partObjectsRef.current = {};
      indexLoadedParts(model, partsRef.current, partObjectsRef.current);
      // Ignore the source Shell UV islands for full wraps. Generate one panoramic
      // projection instead: FRONT at texture center, one seam at center BACK. The same
      // pass also creates model-space/path attributes used by surface-hugging stripe decals.
      const shellProjection = applyPanoramicShellWrapUV(
        model,
        partObjectsRef.current[partKey('Shell')] || []
      );

      // Build a second, coincident Shell surface used only for decal layers. Because
      // this overlay has its own material, Shell glitter/Car Paint can never bleed through
      // an opaque wrap or stripe. Polygon offset keeps it visually flush without floating.
      stripeUniformsRef.current.centerX.value = shellProjection?.centerX || 0;
      const decalOverlays = createShellDecalOverlays(
        partObjectsRef.current[partKey('Shell')] || [],
        stripeUniformsRef.current
      );
      decalOverlayMeshesRef.current = decalOverlays.overlays;
      decalOverlayMaterialsRef.current = decalOverlays.materials;
      applyDecalFinishToMaterials(decalOverlayMaterialsRef.current, scene, decalFinishRef.current);

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
      decalOverlayMeshesRef.current.forEach(mesh => mesh.parent?.remove(mesh));
      decalOverlayMaterialsRef.current.forEach(mat => mat.dispose());
      decalOverlayMeshesRef.current = [];
      decalOverlayMaterialsRef.current = [];
      sideLogoMeshesRef.current.forEach(mesh => mesh.parent?.remove(mesh));
      sideLogoMaterialsRef.current.forEach(mat => mat.dispose());
      sideLogoTexturesRef.current.forEach(tex => tex.dispose?.());
      sideLogoMeshesRef.current = [];
      sideLogoMaterialsRef.current = [];
      sideLogoTexturesRef.current = [];
      modelRef.current = null;
      renderer.dispose();
      if (el.contains(renderer.domElement)) el.removeChild(renderer.domElement);
    };
  }, []);

  // ── UPDATE COLORS ────────────────────────────────────────────────────────────
  useEffect(() => {
    ZONES.forEach(zone => {
      zone.parts.forEach(partName => {
        const mats = partsRef.current[partKey(partName)];
        if (mats) mats.forEach(mat => {
          // Decals now render on their own overlay material, so the base Shell always
          // retains its actual selected color/finish underneath.
          mat.color.set(colors[zone.id]);
          mat.needsUpdate = true;
        });
      });
    });
  }, [colors, loaded]);

  // ── FULL WRAP TEXTURE ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!loaded) return;
    const uniforms = stripeUniformsRef.current;

    if (!wrapEnabled || !wrapImageRef.current) {
      uniforms.wrapEnabled.value = 0;
      uniforms.wrapMap.value = wrapTextureRef.current || null;
      return;
    }

    const img = wrapImageRef.current;
    let canvas = wrapCanvasRef.current;
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.width = 2048;
      canvas.height = 1024;
      wrapCanvasRef.current = canvas;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = colors.shell;
    ctx.fillRect(0, 0, w, h);

    const coverScale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
    const drawScale = coverScale * wrapScale;
    const drawW = img.naturalWidth * drawScale;
    const drawH = img.naturalHeight * drawScale;
    const baseX = w / 2 + (wrapOffsetX / 100) * w;
    const baseY = h / 2 + (wrapOffsetY / 100) * h;

    [-w, 0, w].forEach(loopX => {
      ctx.save();
      ctx.translate(baseX + loopX, baseY);
      ctx.rotate((wrapRotation * Math.PI) / 180);
      ctx.globalAlpha = wrapOpacity;
      ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
      ctx.restore();
    });

    let texture = wrapTextureRef.current;
    if (!texture) {
      texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.flipY = false;
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      wrapTextureRef.current = texture;
    }
    texture.needsUpdate = true;
    uniforms.wrapMap.value = texture;
    uniforms.wrapEnabled.value = 1;
  }, [loaded, colors.shell, wrapEnabled, wrapRevision, wrapScale, wrapRotation, wrapOffsetX, wrapOffsetY, wrapOpacity]);


  // ── STRIPE DESIGN TEXTURE ───────────────────────────────────────────────────
  useEffect(() => {
    const uniforms = stripeUniformsRef.current;

    if (!helmetStripeDesignEnabled || !stripeDesignImageRef.current) {
      uniforms.designEnabled.value = 0;
      uniforms.designMap.value = stripeDesignTextureRef.current || null;
      return;
    }

    const img = stripeDesignImageRef.current;
    let canvas = stripeDesignCanvasRef.current;
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.width = 1024;
      canvas.height = 3072;
      stripeDesignCanvasRef.current = canvas;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Fit inside the available stripe zone by default so the full uploaded design is visible.
    const containScale = Math.min(w / img.naturalWidth, h / img.naturalHeight);
    const drawScale = containScale * helmetStripeDesignScale;
    const drawW = img.naturalWidth * drawScale;
    const drawH = img.naturalHeight * drawScale;
    const baseX = w / 2 + (helmetStripeDesignOffsetX / 100) * w;
    const baseY = h / 2 + (helmetStripeDesignOffsetY / 100) * h;

    ctx.save();
    ctx.translate(baseX, baseY);
    ctx.rotate((helmetStripeDesignRotation * Math.PI) / 180);
    ctx.globalAlpha = helmetStripeDesignOpacity;
    ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
    ctx.restore();

    let texture = stripeDesignTextureRef.current;
    if (!texture) {
      texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      stripeDesignTextureRef.current = texture;
    }
    texture.needsUpdate = true;

    uniforms.designMap.value = texture;
    uniforms.designEnabled.value = 1;
  }, [loaded, helmetStripeDesignEnabled, helmetStripeDesignRevision, helmetStripeDesignScale, helmetStripeDesignRotation, helmetStripeDesignOffsetX, helmetStripeDesignOffsetY, helmetStripeDesignOpacity]);

  // ── STANDARD 3-STRIPE DECAL ─────────────────────────────────────────────────
  useEffect(() => {
    const uniforms = stripeUniformsRef.current;
    const hasDesign = !!stripeDesignImageRef.current;
    uniforms.enabled.value = (helmetStripesEnabled || (helmetStripeDesignEnabled && hasDesign)) ? 1 : 0;
    uniforms.baseEnabled.value = helmetStripesEnabled ? 1 : 0;
    uniforms.widthScale.value = helmetStripeWidth;
    uniforms.length.value = helmetStripeLength;
    uniforms.leftColor.value.set(helmetStripeLeftColor);
    uniforms.centerColor.value.set(helmetStripeCenterColor);
    uniforms.rightColor.value.set(helmetStripeRightColor);
    uniforms.designEnabled.value = helmetStripeDesignEnabled && hasDesign ? 1 : 0;
  }, [loaded, helmetStripesEnabled, helmetStripeWidth, helmetStripeLength, helmetStripeLeftColor, helmetStripeCenterColor, helmetStripeRightColor, helmetStripeDesignEnabled, helmetStripeDesignRevision]);

  // ── MAIN SIDE LOGO DECALS ───────────────────────────────────────────────
  // DecalGeometry expects projector/intersection positions in world space. Side-logo
  // meshes therefore live directly in the scene rather than as children of the GLB;
  // parenting world-space decal vertices to the model was what sent the first logo
  // flying away from the helmet.
  useEffect(() => {
    const scene = sceneRef.current;
    const renderer = rendererRef.current;
    const camera = cameraRef.current;
    const model = modelRef.current;
    if (!loaded || !scene || !renderer || !camera || !model) return;

    const shellRoots = partObjectsRef.current[partKey('Shell')] || [];
    const shellMeshes = collectMeshDescendants(shellRoots);
    const boundsWorld = getWorldBoundsForRoots(shellRoots);
    const boundsModel = computeRootsBoundsInModelSpace(model, shellRoots);
    if (!shellMeshes.length || !boundsWorld || !boundsModel) return;

    const cleanupMeshes = () => {
      sideLogoMeshesRef.current.forEach(mesh => mesh.parent?.remove(mesh));
      sideLogoMeshesRef.current.forEach(mesh => mesh.geometry?.dispose?.());
      sideLogoMeshesRef.current = [];
      sideLogoMaterialsRef.current.forEach(mat => mat.dispose?.());
      sideLogoMaterialsRef.current = [];
      sideLogoTexturesRef.current.forEach(tex => tex.dispose?.());
      sideLogoTexturesRef.current = [];
      sideLogoWorldFrameRef.current = { left:null, right:null };
    };

    const resolveImageForSide = (side) => {
      if (sideLogoIndependent) return side === 'left' ? sideLogoLeftImageRef.current : sideLogoRightImageRef.current;
      return sideLogoSharedImageRef.current;
    };

    const getSideHit = (side, placement) => {
      // Build a target in model space, then convert it to world space. Raycasting from
      // outside the shell guarantees the decal actually lands on that side surface.
      const localTarget = new THREE.Vector3(
        side === 'left' ? boundsModel.minX : boundsModel.maxX,
        boundsModel.minY + boundsModel.height * THREE.MathUtils.clamp(
          placement.yNorm + (sideLogoUpDown / 100) * 0.22,
          0.20,
          0.88,
        ),
        boundsModel.centerZ + boundsModel.depth * THREE.MathUtils.clamp(
          placement.zNorm + (sideLogoFrontBack / 100) * 0.26,
          -0.38,
          0.42,
        ),
      );
      const targetWorld = localTarget.clone();
      model.localToWorld(targetWorld);

      const sideVectorLocal = new THREE.Vector3(side === 'left' ? -1 : 1, 0, 0);
      const sideVectorWorld = sideVectorLocal.clone().transformDirection(model.matrixWorld).normalize();
      const rayOrigin = targetWorld.clone().addScaledVector(sideVectorWorld, boundsWorld.size.length() * 0.8);
      const rayDirection = sideVectorWorld.clone().multiplyScalar(-1);
      const raycaster = new THREE.Raycaster(rayOrigin, rayDirection, 0, boundsWorld.size.length() * 2.0);
      const hits = raycaster.intersectObjects(shellMeshes, false);
      if (!hits.length) return null;
      return hits[0];
    };

    const makeSide = (side) => {
      const show = side === 'left' ? sideLogoLeftVisible : sideLogoRightVisible;
      const image = resolveImageForSide(side);
      if (!show || !image) return;

      const placement = sideLogoPlacementRef.current[side];
      const hit = getSideHit(side, placement);
      if (!hit) return;

      const pack = createSideLogoTexturePack(image, {
        mirror: side === 'left' ? sideLogoLeftMirror : sideLogoRightMirror,
        rotate180: side === 'left' ? sideLogoLeftRotate180 : sideLogoRightRotate180,
        strokeEnabled: sideLogoStrokeEnabled,
        strokeColor: sideLogoStrokeColor,
        strokeThickness: sideLogoStrokeThickness,
        strokeOpacity: sideLogoStrokeOpacity,
      });
      if (!pack) return;

      const combinedScale = sideLogoScale * placement.scale;
      // Large, user-friendly starting size.
      const baseHeight = boundsModel.height * 1.00 * combinedScale;
      const baseWidth = baseHeight * THREE.MathUtils.clamp(pack.aspect, 0.55, 2.6);

      const normalMatrix = new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld);
      const worldNormal = hit.face?.normal?.clone().applyMatrix3(normalMatrix).normalize()
        || new THREE.Vector3(side === 'left' ? -1 : 1, 0, 0).transformDirection(model.matrixWorld).normalize();

      const anchorPosition = hit.point.clone();
      const helper = new THREE.Object3D();
      helper.position.copy(anchorPosition);
      helper.lookAt(anchorPosition.clone().add(worldNormal));
      helper.rotateZ(placement.rotation);

      // Use tangent planes instead of DecalGeometry so the logo can bridge across
      // helmet cutouts/vents and never gets clipped by a projection mask.
      const physicalDepth = Math.max(boundsModel.width * 0.0024, 0.0014);
      const shadowPosition = anchorPosition.clone().addScaledVector(worldNormal, physicalDepth * 0.45);
      const mainPosition = anchorPosition.clone().addScaledVector(worldNormal, physicalDepth * 1.25);
      const selectionPosition = anchorPosition.clone().addScaledVector(worldNormal, physicalDepth * 2.0);

      const shadowGeo = new THREE.PlaneGeometry(baseWidth * 1.035, baseHeight * 1.035, 1, 1);
      const mainGeo = new THREE.PlaneGeometry(baseWidth, baseHeight, 1, 1);

      const shadowMat = new THREE.MeshPhysicalMaterial({
        color: 0x000000,
        map: pack.rimTexture,
        transparent: true,
        alphaTest: 0.01,
        opacity: 0.42,
        side: THREE.DoubleSide,
        depthWrite: false,
        depthTest: true,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
        roughness: 0.95,
        metalness: 0.0,
      });

      const mainMat = new THREE.MeshPhysicalMaterial({
        color: 0xffffff,
        map: pack.mainTexture,
        transparent: true,
        alphaTest: 0.01,
        opacity: 1,
        side: THREE.DoubleSide,
        depthWrite: false,
        depthTest: true,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      mainMat.userData.sideLogoMainMaterial = true;
      applyDecalFinishToMaterials([mainMat], scene, decalFinishRef.current);

      const shadowMesh = new THREE.Mesh(shadowGeo, shadowMat);
      shadowMesh.name = `SideLogo_${side}_Shadow`;
      shadowMesh.userData.sideLogoSide = side;
      shadowMesh.userData.sideLogoShadow = true;
      shadowMesh.renderOrder = 39;
      shadowMesh.castShadow = true;
      shadowMesh.position.copy(shadowPosition);
      shadowMesh.quaternion.copy(helper.quaternion);
      scene.add(shadowMesh);

      const mainMesh = new THREE.Mesh(mainGeo, mainMat);
      mainMesh.name = `SideLogo_${side}`;
      mainMesh.userData.sideLogoSide = side;
      mainMesh.userData.sideLogoMain = true;
      mainMesh.renderOrder = 40;
      mainMesh.castShadow = true;
      mainMesh.position.copy(mainPosition);
      mainMesh.quaternion.copy(helper.quaternion);
      scene.add(mainMesh);

      sideLogoMeshesRef.current.push(shadowMesh, mainMesh);
      sideLogoMaterialsRef.current.push(shadowMat, mainMat);
      sideLogoTexturesRef.current.push(pack.rimTexture, pack.mainTexture);

      const frameQuat = helper.quaternion.clone();
      const frameRight = new THREE.Vector3(1, 0, 0).applyQuaternion(frameQuat).normalize();
      const frameUp = new THREE.Vector3(0, 1, 0).applyQuaternion(frameQuat).normalize();
      const frameHalfW = baseWidth * 0.50;
      const frameHalfH = baseHeight * 0.50;
      const frameCenter = mainPosition.clone();
      sideLogoWorldFrameRef.current[side] = {
        center: frameCenter,
        corners: [
          frameCenter.clone().addScaledVector(frameRight, -frameHalfW).addScaledVector(frameUp,  frameHalfH),
          frameCenter.clone().addScaledVector(frameRight,  frameHalfW).addScaledVector(frameUp,  frameHalfH),
          frameCenter.clone().addScaledVector(frameRight, -frameHalfW).addScaledVector(frameUp, -frameHalfH),
          frameCenter.clone().addScaledVector(frameRight,  frameHalfW).addScaledVector(frameUp, -frameHalfH),
        ],
      };

      if (selectedSideLogoRef.current === side) {
        const selectionTex = createSelectionBoxTexture();
        const selectionGeo = new THREE.PlaneGeometry(baseWidth * 1.12, baseHeight * 1.12, 1, 1);
        const selectionMat = new THREE.MeshBasicMaterial({
          map: selectionTex,
          transparent: true,
          alphaTest: 0.02,
          depthTest: true,
          depthWrite: false,
          toneMapped: false,
          side: THREE.DoubleSide,
          polygonOffset: true,
          polygonOffsetFactor: -3,
          polygonOffsetUnits: -3,
        });
        const selectionMesh = new THREE.Mesh(selectionGeo, selectionMat);
        selectionMesh.name = `SideLogo_${side}_Selection`;
        selectionMesh.userData.sideLogoSide = side;
        selectionMesh.userData.sideLogoSelection = true;
        selectionMesh.renderOrder = 50;
        selectionMesh.position.copy(selectionPosition);
        selectionMesh.quaternion.copy(helper.quaternion);
        scene.add(selectionMesh);
        sideLogoMeshesRef.current.push(selectionMesh);
        sideLogoMaterialsRef.current.push(selectionMat);
        sideLogoTexturesRef.current.push(selectionTex);
      }
    };

    const rebuild = () => {
      cleanupMeshes();
      makeSide('left');
      makeSide('right');
    };

    rebuild();

    const canvas = renderer.domElement;
    const pointer = new THREE.Vector2();
    const raycaster = new THREE.Raycaster();
    const ROTATE_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='28' viewBox='0 0 28 28'%3E%3Cpath d='M21.8 8.3A9.2 9.2 0 1 0 23 17' fill='none' stroke='%23efff00' stroke-width='2.2' stroke-linecap='round'/%3E%3Cpath d='M18.5 4.2 22.4 8l-5.2 1.4' fill='none' stroke='%23efff00' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") 14 14, grab`;

    const updatePointer = (event) => {
      const rect = canvas.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
    };

    const worldToClient = (worldPoint) => {
      const rect = canvas.getBoundingClientRect();
      const ndc = worldPoint.clone().project(camera);
      return {
        x: rect.left + (ndc.x + 1) * 0.5 * rect.width,
        y: rect.top + (1 - ndc.y) * 0.5 * rect.height,
      };
    };

    const getSelectedFrameClient = () => {
      const side = selectedSideLogoRef.current;
      const frame = side ? sideLogoWorldFrameRef.current[side] : null;
      if (!side || !frame) return null;
      return {
        side,
        center: worldToClient(frame.center),
        corners: frame.corners.map(worldToClient),
      };
    };

    const getCornerInteraction = (event) => {
      const frame = getSelectedFrameClient();
      if (!frame) return null;
      let nearest = null;
      frame.corners.forEach((corner, index) => {
        const distance = Math.hypot(event.clientX - corner.x, event.clientY - corner.y);
        if (!nearest || distance < nearest.distance) nearest = { index, distance };
      });
      if (!nearest) return null;
      if (nearest.distance <= 11) return { action:'scale', frame, cornerIndex:nearest.index };
      if (nearest.distance <= 30) return { action:'rotate', frame, cornerIndex:nearest.index };
      return null;
    };

    const scaleCursorForCorner = (cornerIndex) => (
      cornerIndex === 0 || cornerIndex === 3 ? 'nwse-resize' : 'nesw-resize'
    );

    const findClickedLogo = (event) => {
      updatePointer(event);
      const selectable = sideLogoMeshesRef.current.filter(m => m.userData.sideLogoMain);
      const hits = raycaster.intersectObjects(selectable, false);
      return hits[0]?.object?.userData?.sideLogoSide || null;
    };

    const projectPointerToShell = (event, side) => {
      updatePointer(event);
      const hits = raycaster.intersectObjects(shellMeshes, false);
      if (!hits.length) return null;
      const modelInverse = new THREE.Matrix4().copy(model.matrixWorld).invert();
      const candidates = hits.filter(hit => {
        const local = hit.point.clone().applyMatrix4(modelInverse);
        return side === 'left' ? local.x <= boundsModel.centerX : local.x >= boundsModel.centerX;
      });
      return candidates[0] || null;
    };

    const startInteraction = (event, side, action, frame = null) => {
      const placement = sideLogoPlacementRef.current[side];
      const centerClient = frame?.center || getSelectedFrameClient()?.center || { x:event.clientX, y:event.clientY };
      const dx = event.clientX - centerClient.x;
      const dy = event.clientY - centerClient.y;
      sideLogoInteractionRef.current = {
        dragging:true,
        pointerId:event.pointerId,
        side,
        action,
        startScale:placement.scale,
        startRotation:placement.rotation,
        startDistance:Math.max(8, Math.hypot(dx, dy)),
        startAngle:Math.atan2(dy, dx),
        centerClient,
      };
      try { canvas.setPointerCapture?.(event.pointerId); } catch (_) {}
      if (controlsRef.current) controlsRef.current.enabled = false;
    };

    const selectLogo = (side) => {
      selectedSideLogoRef.current = side;
      setSelectedSideLogo(side);
      rebuild();
    };

    const deselectLogo = () => {
      selectedSideLogoRef.current = null;
      setSelectedSideLogo(null);
      rebuild();
      canvas.style.cursor = '';
    };

    const onPointerDown = (event) => {
      if (event.button !== 0) return;
      const cornerInteraction = !sideLogoLocked ? getCornerInteraction(event) : null;
      if (cornerInteraction) {
        event.preventDefault();
        event.stopPropagation();
        startInteraction(event, cornerInteraction.frame.side, cornerInteraction.action, cornerInteraction.frame);
        return;
      }

      const clickedSide = findClickedLogo(event);
      if (!clickedSide) {
        if (selectedSideLogoRef.current) deselectLogo();
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      if (selectedSideLogoRef.current !== clickedSide) selectLogo(clickedSide);
      if (!sideLogoLocked) startInteraction(event, clickedSide, 'move');
    };

    const onPointerMove = (event) => {
      const interaction = sideLogoInteractionRef.current;
      if (!interaction.dragging) {
        if (!sideLogoLocked) {
          const cornerInteraction = getCornerInteraction(event);
          if (cornerInteraction?.action === 'scale') {
            canvas.style.cursor = scaleCursorForCorner(cornerInteraction.cornerIndex);
            return;
          }
          if (cornerInteraction?.action === 'rotate') {
            canvas.style.cursor = ROTATE_CURSOR;
            return;
          }
        }
        const hoverSide = findClickedLogo(event);
        if (!hoverSide) {
          canvas.style.cursor = '';
        } else if (hoverSide === selectedSideLogoRef.current) {
          canvas.style.cursor = sideLogoLocked ? 'pointer' : 'move';
        } else {
          canvas.style.cursor = 'pointer';
        }
        return;
      }

      const side = interaction.side;
      if (!side) return;
      event.preventDefault();
      event.stopPropagation();
      const placement = sideLogoPlacementRef.current[side];

      if (interaction.action === 'move') {
        const hit = projectPointerToShell(event, side);
        if (!hit) return;
        const local = hit.point.clone();
        model.worldToLocal(local);
        placement.yNorm = THREE.MathUtils.clamp(
          (local.y - boundsModel.minY) / boundsModel.height - (sideLogoUpDown / 100) * 0.22,
          0.18,
          0.90,
        );
        placement.zNorm = THREE.MathUtils.clamp(
          (local.z - boundsModel.centerZ) / boundsModel.depth - (sideLogoFrontBack / 100) * 0.26,
          -0.45,
          0.45,
        );
        canvas.style.cursor = 'move';
      } else if (interaction.action === 'scale') {
        const dx = event.clientX - interaction.centerClient.x;
        const dy = event.clientY - interaction.centerClient.y;
        const currentDistance = Math.max(8, Math.hypot(dx, dy));
        placement.scale = THREE.MathUtils.clamp(
          interaction.startScale * (currentDistance / interaction.startDistance),
          0.15,
          4.0,
        );
      } else if (interaction.action === 'rotate') {
        const dx = event.clientX - interaction.centerClient.x;
        const dy = event.clientY - interaction.centerClient.y;
        const currentAngle = Math.atan2(dy, dx);
        let delta = currentAngle - interaction.startAngle;
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        placement.rotation = interaction.startRotation - delta;
        canvas.style.cursor = ROTATE_CURSOR;
      }

      if (!sideLogoIndependent) {
        const otherSide = side === 'left' ? 'right' : 'left';
        sideLogoPlacementRef.current[otherSide] = { ...placement };
      }

      rebuild();
    };

    const endInteraction = (event) => {
      if (!sideLogoInteractionRef.current.dragging) return;
      sideLogoInteractionRef.current.dragging = false;
      sideLogoInteractionRef.current.action = null;
      sideLogoInteractionRef.current.side = null;
      try { canvas.releasePointerCapture?.(event.pointerId); } catch (_) {}
      if (controlsRef.current) controlsRef.current.enabled = true;
      setSideLogoRevision(v => v + 1);
    };

    canvas.addEventListener('pointerdown', onPointerDown, true);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', endInteraction);
    canvas.addEventListener('pointercancel', endInteraction);

    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown, true);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', endInteraction);
      canvas.removeEventListener('pointercancel', endInteraction);
      canvas.style.cursor = '';
      if (controlsRef.current) controlsRef.current.enabled = true;
      cleanupMeshes();
    };
  }, [
    loaded,
    sideLogoIndependent,
    sideLogoLeftVisible,
    sideLogoRightVisible,
    sideLogoLeftMirror,
    sideLogoRightMirror,
    sideLogoLeftRotate180,
    sideLogoRightRotate180,
    sideLogoScale,
    sideLogoFrontBack,
    sideLogoUpDown,
    sideLogoStrokeEnabled,
    sideLogoStrokeColor,
    sideLogoStrokeThickness,
    sideLogoStrokeOpacity,
    sideLogoRevision,
    sideLogoLocked,
  ]);

  // ── DECAL FINISH ────────────────────────────────────────────────────────────
  useEffect(() => {
    applyDecalFinishToMaterials([
      ...decalOverlayMaterialsRef.current,
      ...sideLogoMaterialsRef.current.filter(mat => mat.userData?.sideLogoMainMaterial),
    ], sceneRef.current, decalFinish);
  }, [loaded, decalFinish]);

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
    // Toggle the exact GLB part roots. If either part is represented as a Group,
    // hiding the root also hides all of its mesh descendants.
    ['Visor', 'Visor Clips'].forEach(partName => {
      const roots = partObjectsRef.current[partKey(partName)] || [];
      roots.forEach(root => { root.visible = visorOn; });
    });
  }, [visorOn, loaded]);

  // Clear any baked texture from visor (removes Oakley logo)
  useEffect(() => {
    (partsRef.current[partKey('Visor')] || []).forEach(mat => {
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
                    <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:10 }}>
                      <span style={{ fontSize:10, color:'#9ca3af', minWidth:48 }}>Amount</span>
                      <input type="range" min="0" max="100" value={Math.round(glitter*100)} onChange={e => setGlitter(parseInt(e.target.value)/100)} style={{ flex:1, minWidth:0 }} />
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
                <SectionLabel>Decal Finish</SectionLabel>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6, marginBottom:8 }}>
                  {DECAL_FINISHES.map(f => (
                    <button
                      key={f.id}
                      onClick={() => setDecalFinish(f.id)}
                      style={{
                        background: decalFinish===f.id ? 'rgba(239,255,0,0.10)' : 'rgba(255,255,255,0.04)',
                        border: decalFinish===f.id ? '1px solid rgba(239,255,0,0.40)' : '1px solid rgba(255,255,255,0.08)',
                        borderRadius:6,
                        padding:'8px 6px',
                        cursor:'pointer',
                        fontSize:9,
                        fontWeight:800,
                        fontFamily:"'Barlow Condensed',sans-serif",
                        color:decalFinish===f.id ? '#efff00' : '#9ca3af',
                        letterSpacing:'0.06em'
                      }}
                    >
                      {f.label.toUpperCase()}
                    </button>
                  ))}
                </div>
                <div style={{ fontSize:8, color:'#4b5563', lineHeight:1.45, marginBottom:14 }}>
                  Applies to full wraps, preset stripes and uploaded stripe designs. Decals use their own finish and never inherit Shell glitter or Car Paint effects.
                </div>

                <SectionLabel>Full Wrap</SectionLabel>
                <div style={{ fontSize:10, color:'#6b7280', lineHeight:1.55, marginBottom:10 }}>
                  Upload a PNG or JPEG of at least 1080×1080px. For best results use a wide image (around 2:1). The center maps to the front of the helmet and the left/right edges meet at the back.
                </div>

                <input id="helmet-wrap-upload" type="file" accept="image/png,image/jpeg" onChange={handleWrapUpload} style={{ display:'none' }} />
                <label htmlFor="helmet-wrap-upload" style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:7, width:'100%', boxSizing:'border-box', background:'rgba(239,255,0,0.08)', border:'1px dashed rgba(239,255,0,0.35)', borderRadius:7, padding:'10px 12px', cursor:'pointer', fontSize:10, fontWeight:800, fontFamily:"'Barlow Condensed',sans-serif", color:'#efff00', letterSpacing:'0.06em' }}>
                  <span style={{ fontSize:14 }}>＋</span>{wrapPreviewUrl ? 'REPLACE WRAP IMAGE' : 'UPLOAD WRAP IMAGE'}
                </label>

                {wrapError && (
                  <div style={{ marginTop:8, fontSize:10, color:'#ef4444', lineHeight:1.4 }}>{wrapError}</div>
                )}

                {wrapPreviewUrl && (
                  <div style={{ marginTop:12 }}>
                    <div style={{ display:'flex', justifyContent:'space-between', gap:8, alignItems:'center', marginBottom:7 }}>
                      <div style={{ minWidth:0 }}>
                        <div style={{ fontSize:10, color:'#9ca3af', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }} title={wrapFileName}>{wrapFileName}</div>
                        <div style={{ fontSize:8, color:'#4b5563', marginTop:2 }}>HELMET WRAP VIEW</div>
                      </div>
                      <div style={{ display:'flex', gap:5, flexShrink:0 }}>
                        <button onClick={() => setWrapEnabled(v => !v)} style={{ background:wrapEnabled?'rgba(239,255,0,0.1)':'rgba(255,255,255,0.04)', border:wrapEnabled?'1px solid rgba(239,255,0,0.35)':'1px solid rgba(255,255,255,0.1)', borderRadius:5, padding:'4px 7px', cursor:'pointer', color:wrapEnabled?'#efff00':'#6b7280', fontSize:8, fontWeight:700, fontFamily:"'Barlow Condensed',sans-serif" }}>{wrapEnabled?'ON':'OFF'}</button>
                        <button onClick={removeWrap} style={{ background:'rgba(239,68,68,0.08)', border:'1px solid rgba(239,68,68,0.25)', borderRadius:5, padding:'4px 7px', cursor:'pointer', color:'#ef4444', fontSize:8, fontWeight:700, fontFamily:"'Barlow Condensed',sans-serif" }}>REMOVE</button>
                      </div>
                    </div>

                    {/* User-facing panoramic placement guide. The canvas is intentionally
                        simple: center = front, both outer edges = the single back seam. */}
                    <div style={{ position:'relative', width:'100%', aspectRatio:'2 / 1', overflow:'hidden', borderRadius:8, border:'1px solid rgba(255,255,255,0.12)', background:colors.shell }}>
                      {[-100,0,100].map(loop => (
                        <img
                          key={loop}
                          src={wrapPreviewUrl}
                          alt={loop === 0 ? 'Uploaded helmet wrap preview' : ''}
                          aria-hidden={loop !== 0}
                          style={{ position:'absolute', width:'100%', height:'100%', objectFit:'cover', left:`calc(50% + ${wrapOffsetX + loop}%)`, top:`calc(50% + ${wrapOffsetY}%)`, transform:`translate(-50%,-50%) rotate(${wrapRotation}deg) scale(${wrapScale})`, transformOrigin:'center', opacity:wrapEnabled?wrapOpacity:0.2, filter:wrapEnabled?'none':'grayscale(1)', pointerEvents:'none', userSelect:'none' }}
                        />
                      ))}

                      {/* Quarter marks show the route around the shell without exposing UV jargon. */}
                      <div style={{ position:'absolute', top:0, bottom:0, left:'25%', borderLeft:'1px dashed rgba(255,255,255,0.20)', pointerEvents:'none' }} />
                      <div style={{ position:'absolute', top:0, bottom:0, left:'50%', borderLeft:'2px solid rgba(239,255,0,0.75)', pointerEvents:'none' }} />
                      <div style={{ position:'absolute', top:0, bottom:0, left:'75%', borderLeft:'1px dashed rgba(255,255,255,0.20)', pointerEvents:'none' }} />
                      <div style={{ position:'absolute', left:0, right:0, top:'50%', borderTop:'1px dashed rgba(255,255,255,0.16)', pointerEvents:'none' }} />

                      <div style={{ position:'absolute', top:5, left:'50%', transform:'translateX(-50%)', background:'rgba(0,0,0,0.72)', border:'1px solid rgba(239,255,0,0.45)', borderRadius:4, padding:'2px 6px', color:'#efff00', fontSize:8, fontWeight:900, fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:'0.07em', pointerEvents:'none', whiteSpace:'nowrap' }}>FRONT OF HELMET</div>
                      <div style={{ position:'absolute', top:5, left:5, background:'rgba(0,0,0,0.66)', borderRadius:4, padding:'2px 5px', color:'#d1d5db', fontSize:7, fontWeight:800, fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:'0.05em', pointerEvents:'none' }}>BACK SEAM</div>
                      <div style={{ position:'absolute', top:5, right:5, background:'rgba(0,0,0,0.66)', borderRadius:4, padding:'2px 5px', color:'#d1d5db', fontSize:7, fontWeight:800, fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:'0.05em', pointerEvents:'none' }}>BACK SEAM</div>
                      <div style={{ position:'absolute', top:'50%', left:5, transform:'translateY(-50%)', background:'rgba(0,0,0,0.52)', borderRadius:4, padding:'2px 5px', color:'#d1d5db', fontSize:7, fontFamily:"'Barlow Condensed',sans-serif", pointerEvents:'none' }}>← wraps around shell</div>
                      <div style={{ position:'absolute', top:'50%', right:5, transform:'translateY(-50%)', background:'rgba(0,0,0,0.52)', borderRadius:4, padding:'2px 5px', color:'#d1d5db', fontSize:7, fontFamily:"'Barlow Condensed',sans-serif", pointerEvents:'none' }}>wraps around shell →</div>
                      <div style={{ position:'absolute', left:'50%', bottom:5, transform:'translateX(-50%)', background:'rgba(0,0,0,0.62)', borderRadius:4, padding:'2px 5px', color:'#d1d5db', fontSize:7, fontFamily:"'Barlow Condensed',sans-serif", pointerEvents:'none', whiteSpace:'nowrap' }}>TOP = CROWN · BOTTOM = LOWER SHELL</div>
                    </div>

                    <div style={{ marginTop:7, fontSize:8, color:'#4b5563', lineHeight:1.45 }}>
                      Tip: artwork whose left and right edges match will be completely seamless at the back. Use “Around Helmet” to choose where the design sits around the shell.
                    </div>

                    <div style={{ marginTop:11 }}>
                      <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:8 }}>
                        <span style={{ width:56, flexShrink:0, fontSize:9, color:'#9ca3af' }}>Scale</span>
                        <input type="range" min="25" max="300" value={Math.round(wrapScale*100)} onChange={e => setWrapScale(parseInt(e.target.value)/100)} style={{ flex:1, minWidth:0 }} />
                      </div>
                      <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:8 }}>
                        <span style={{ width:56, flexShrink:0, fontSize:9, color:'#9ca3af' }}>Rotate</span>
                        <input type="range" min="-180" max="180" value={wrapRotation} onChange={e => setWrapRotation(parseInt(e.target.value))} style={{ flex:1, minWidth:0 }} />
                      </div>
                      <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:8 }}>
                        <span style={{ width:56, flexShrink:0, fontSize:9, color:'#9ca3af' }}>Around Helmet</span>
                        <input type="range" min="-50" max="50" value={wrapOffsetX} onChange={e => setWrapOffsetX(parseInt(e.target.value))} style={{ flex:1, minWidth:0 }} />
                      </div>
                      <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:8 }}>
                        <span style={{ width:56, flexShrink:0, fontSize:9, color:'#9ca3af' }}>Up / Down</span>
                        <input type="range" min="-50" max="50" value={wrapOffsetY} onChange={e => setWrapOffsetY(parseInt(e.target.value))} style={{ flex:1, minWidth:0 }} />
                      </div>
                      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:10 }}>
                        <span style={{ width:56, flexShrink:0, fontSize:9, color:'#9ca3af' }}>Opacity</span>
                        <input type="range" min="0" max="100" value={Math.round(wrapOpacity*100)} onChange={e => setWrapOpacity(parseInt(e.target.value)/100)} style={{ flex:1, minWidth:0 }} />
                      </div>
                      <button onClick={resetWrapTransform} style={{ width:'100%', background:'rgba(255,255,255,0.05)', border:'1px solid rgba(255,255,255,0.1)', borderRadius:6, padding:'7px 8px', cursor:'pointer', color:'#9ca3af', fontSize:9, fontWeight:700, fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:'0.05em' }}>RESET POSITION</button>
                    </div>
                  </div>
                )}

                <div style={{ height:1, background:'rgba(255,255,255,0.06)', margin:'16px 0 14px' }} />
                <SectionLabel>Helmet Stripes</SectionLabel>
                <div style={{ background:'rgba(255,255,255,0.035)', border:'1px solid rgba(255,255,255,0.09)', borderRadius:8, padding:10 }}>
                  <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:10 }}>
                    <div>
                      <div style={{ fontSize:11, fontWeight:800, color:'#d1d5db', fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:'0.04em' }}>STANDARD 3 STRIPE</div>
                      <div style={{ fontSize:8, color:'#4b5563', marginTop:2 }}>Front → crown → back</div>
                    </div>
                    <button onClick={() => setHelmetStripesEnabled(v => !v)} style={{ background:helmetStripesEnabled?'rgba(239,255,0,0.12)':'rgba(255,255,255,0.04)', border:helmetStripesEnabled?'1px solid rgba(239,255,0,0.45)':'1px solid rgba(255,255,255,0.12)', borderRadius:20, padding:'4px 10px', cursor:'pointer', fontSize:8, fontWeight:800, fontFamily:"'Barlow Condensed',sans-serif", color:helmetStripesEnabled?'#efff00':'#6b7280', letterSpacing:'0.06em' }}>{helmetStripesEnabled?'ON':'OFF'}</button>
                  </div>

                  <div style={{ display:'flex', justifyContent:'center', gap:0, height:24, margin:'10px 0 8px', padding:'5px 0', background:'rgba(0,0,0,0.18)', borderRadius:5 }} aria-label="Three helmet stripes preview">
                    <div style={{ width:10, height:'100%', background:helmetStripeLeftColor, borderRadius:'2px 0 0 2px' }} />
                    <div style={{ width:10, height:'100%', background:helmetStripeCenterColor }} />
                    <div style={{ width:10, height:'100%', background:helmetStripeRightColor, borderRadius:'0 2px 2px 0' }} />
                  </div>

                  <div style={{ fontSize:9, color:'#6b7280', lineHeight:1.5 }}>
                    This preset uses three equal-width stripes with no gaps. Stripes use a dedicated decal surface above any full wrap and beneath the bumpers, so Shell glitter and Car Paint effects cannot show through. Crown screw hardware remains visible.
                  </div>

                  <div style={{ display:'flex', alignItems:'center', gap:8, marginTop:10 }}>
                    <span style={{ width:56, flexShrink:0, fontSize:9, color:'#9ca3af' }}>Width</span>
                    <input type="range" min="70" max="200" value={Math.round(helmetStripeWidth*100)} onChange={e => setHelmetStripeWidth(parseInt(e.target.value)/100)} style={{ flex:1, minWidth:0 }} />
                  </div>
                  <div style={{ display:'flex', alignItems:'center', gap:8, marginTop:8 }}>
                    <span style={{ width:56, flexShrink:0, fontSize:9, color:'#9ca3af' }}>Length</span>
                    <input type="range" min="40" max="100" value={Math.round(helmetStripeLength*100)} onChange={e => setHelmetStripeLength(parseInt(e.target.value)/100)} style={{ flex:1, minWidth:0 }} />
                  </div>

                  <div style={{ height:1, background:'rgba(255,255,255,0.06)', margin:'12px 0 10px' }} />
                  <SectionLabel>Stripe Colors</SectionLabel>
                  <ColorSwatch color={helmetStripeLeftColor} onChange={setHelmetStripeLeftColor} label="Left Stripe" />
                  <ColorSwatch color={helmetStripeCenterColor} onChange={setHelmetStripeCenterColor} label="Center Stripe" />
                  <ColorSwatch color={helmetStripeRightColor} onChange={setHelmetStripeRightColor} label="Right Stripe" />

                  <div style={{ height:1, background:'rgba(255,255,255,0.06)', margin:'12px 0 10px' }} />
                  <SectionLabel>Custom Stripe Design</SectionLabel>
                  <div style={{ fontSize:9, color:'#6b7280', lineHeight:1.5, marginBottom:10 }}>
                    Upload a PNG or JPEG to place artwork inside the stripe zone. For a full-width full-length design, ideal artwork is around 1200×3600px or larger, but narrower or shorter artwork is perfectly fine too.
                  </div>
                  <div style={{ fontSize:8, color:'#4b5563', lineHeight:1.45, marginBottom:10 }}>
                    The current Width and Length sliders define the available stripe area on the helmet. Your uploaded design fits inside that live area and can be used with or without the preset stripe colors underneath.
                  </div>

                  <input id="helmet-stripe-design-upload" type="file" accept="image/png,image/jpeg" onChange={handleStripeDesignUpload} style={{ display:'none' }} />
                  <label htmlFor="helmet-stripe-design-upload" style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:7, width:'100%', boxSizing:'border-box', background:'rgba(239,255,0,0.08)', border:'1px dashed rgba(239,255,0,0.35)', borderRadius:7, padding:'10px 12px', cursor:'pointer', fontSize:10, fontWeight:800, fontFamily:"'Barlow Condensed',sans-serif", color:'#efff00', letterSpacing:'0.06em' }}>
                    <span style={{ fontSize:14 }}>＋</span>{helmetStripeDesignPreviewUrl ? 'REPLACE STRIPE DESIGN' : 'UPLOAD STRIPE DESIGN'}
                  </label>

                  {helmetStripeDesignError && (
                    <div style={{ marginTop:8, fontSize:10, color:'#ef4444', lineHeight:1.4 }}>{helmetStripeDesignError}</div>
                  )}

                  {helmetStripeDesignPreviewUrl && (
                    <div style={{ marginTop:12 }}>
                      <div style={{ display:'flex', justifyContent:'space-between', gap:8, alignItems:'center', marginBottom:7 }}>
                        <div style={{ minWidth:0 }}>
                          <div style={{ fontSize:10, color:'#9ca3af', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }} title={helmetStripeDesignFileName}>{helmetStripeDesignFileName}</div>
                          <div style={{ fontSize:8, color:'#4b5563', marginTop:2 }}>STRIPE DESIGN VIEW</div>
                        </div>
                        <div style={{ display:'flex', gap:5, flexShrink:0 }}>
                          <button onClick={() => setHelmetStripeDesignEnabled(v => !v)} style={{ background:helmetStripeDesignEnabled?'rgba(239,255,0,0.1)':'rgba(255,255,255,0.04)', border:helmetStripeDesignEnabled?'1px solid rgba(239,255,0,0.35)':'1px solid rgba(255,255,255,0.1)', borderRadius:5, padding:'4px 7px', cursor:'pointer', color:helmetStripeDesignEnabled?'#efff00':'#6b7280', fontSize:8, fontWeight:700, fontFamily:"'Barlow Condensed',sans-serif" }}>{helmetStripeDesignEnabled?'ON':'OFF'}</button>
                          <button onClick={removeStripeDesign} style={{ background:'rgba(239,68,68,0.08)', border:'1px solid rgba(239,68,68,0.25)', borderRadius:5, padding:'4px 7px', cursor:'pointer', color:'#ef4444', fontSize:8, fontWeight:700, fontFamily:"'Barlow Condensed',sans-serif" }}>REMOVE</button>
                        </div>
                      </div>

                      <div style={{
                        position:'relative',
                        width:'100%',
                        aspectRatio:'1 / 2.8',
                        overflow:'hidden',
                        borderRadius:8,
                        border:'1px solid rgba(255,255,255,0.12)',
                        backgroundColor:'#c8cdd4',
                        backgroundImage:'linear-gradient(45deg, rgba(255,255,255,0.95) 25%, transparent 25%, transparent 75%, rgba(255,255,255,0.95) 75%, rgba(255,255,255,0.95)), linear-gradient(45deg, rgba(255,255,255,0.95) 25%, transparent 25%, transparent 75%, rgba(255,255,255,0.95) 75%, rgba(255,255,255,0.95))',
                        backgroundSize:'18px 18px',
                        backgroundPosition:'0 0, 9px 9px'
                      }}>
                        <img
                          src={helmetStripeDesignPreviewUrl}
                          alt="Uploaded stripe design preview"
                          style={{ position:'absolute', width:'100%', height:'100%', objectFit:'contain', left:`calc(50% + ${helmetStripeDesignOffsetX}%)`, top:`calc(50% + ${helmetStripeDesignOffsetY}%)`, transform:`translate(-50%,-50%) rotate(${helmetStripeDesignRotation}deg) scale(${helmetStripeDesignScale})`, transformOrigin:'center', opacity:helmetStripeDesignEnabled?helmetStripeDesignOpacity:0.25, filter:helmetStripeDesignEnabled?'none':'grayscale(1)', pointerEvents:'none', userSelect:'none' }}
                        />
                        <div style={{ position:'absolute', top:5, left:'50%', transform:'translateX(-50%)', background:'rgba(0,0,0,0.68)', border:'1px solid rgba(239,255,0,0.4)', borderRadius:4, padding:'2px 6px', color:'#efff00', fontSize:8, fontWeight:900, fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:'0.07em', pointerEvents:'none', whiteSpace:'nowrap' }}>FRONT</div>
                        <div style={{ position:'absolute', left:'50%', bottom:5, transform:'translateX(-50%)', background:'rgba(0,0,0,0.68)', borderRadius:4, padding:'2px 6px', color:'#d1d5db', fontSize:8, fontWeight:800, fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:'0.05em', pointerEvents:'none', whiteSpace:'nowrap' }}>BACK</div>
                      </div>

                      <div style={{ marginTop:11 }}>
                        <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8 }}>
                          <span style={{ width:60, flexShrink:0, fontSize:9, color:'#9ca3af' }}>Scale</span>
                          <input type="range" min="25" max="300" value={Math.round(helmetStripeDesignScale*100)} onChange={e => setHelmetStripeDesignScale(parseInt(e.target.value)/100)} style={{ flex:1, minWidth:0 }} />
                        </div>
                        <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8 }}>
                          <span style={{ width:60, flexShrink:0, fontSize:9, color:'#9ca3af' }}>Rotate</span>
                          <input type="range" min="-180" max="180" value={helmetStripeDesignRotation} onChange={e => setHelmetStripeDesignRotation(parseInt(e.target.value))} style={{ flex:1, minWidth:0 }} />
                        </div>
                        <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8 }}>
                          <span style={{ width:60, flexShrink:0, fontSize:9, color:'#9ca3af' }}>Across</span>
                          <input type="range" min="-50" max="50" value={helmetStripeDesignOffsetX} onChange={e => setHelmetStripeDesignOffsetX(parseInt(e.target.value))} style={{ flex:1, minWidth:0 }} />
                        </div>
                        <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8 }}>
                          <span style={{ width:60, flexShrink:0, fontSize:9, color:'#9ca3af' }}>F / B</span>
                          <input type="range" min="-50" max="50" value={helmetStripeDesignOffsetY} onChange={e => setHelmetStripeDesignOffsetY(parseInt(e.target.value))} style={{ flex:1, minWidth:0 }} />
                        </div>
                        <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:10 }}>
                          <span style={{ width:60, flexShrink:0, fontSize:9, color:'#9ca3af' }}>Opacity</span>
                          <input type="range" min="0" max="100" value={Math.round(helmetStripeDesignOpacity*100)} onChange={e => setHelmetStripeDesignOpacity(parseInt(e.target.value)/100)} style={{ flex:1, minWidth:0 }} />
                        </div>
                        <button onClick={resetStripeDesignTransform} style={{ width:'100%', background:'rgba(255,255,255,0.05)', border:'1px solid rgba(255,255,255,0.1)', borderRadius:6, padding:'7px 8px', cursor:'pointer', color:'#9ca3af', fontSize:9, fontWeight:700, fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:'0.05em' }}>RESET POSITION</button>
                      </div>
                    </div>
                  )}

                  <div style={{ marginTop:8, fontSize:8, color:'#4b5563', lineHeight:1.4 }}>
                    100% reaches the full rear extent below the bumper. Reducing Length moves only the rear ends forward toward the crown while keeping the front aligned.
                  </div>
                </div>
                <div style={{ height:1, background:'rgba(255,255,255,0.06)', margin:'16px 0 14px' }} />
                <SectionLabel>Main Side Logos</SectionLabel>
                <div style={{ background:'rgba(255,255,255,0.02)', border:'1px solid rgba(255,255,255,0.04)', borderRadius:10, padding:12 }}>
                  <div style={{ fontSize:10, color:'#6b7280', lineHeight:1.5, marginBottom:8 }}>
                    Upload the main side logo decal. It automatically lands on both helmet sides, with the right side mirrored. You can hide either side, rotate either side 180°, or switch to fully independent left/right logo uploads.
                  </div>
                  <div style={{ fontSize:9, color:'#9ca3af', lineHeight:1.45, marginBottom:10, padding:'7px 8px', background:'rgba(239,255,0,0.04)', border:'1px solid rgba(239,255,0,0.12)', borderRadius:6 }}>
                    In the viewport: click a logo to select it, drag the logo to move it, drag a corner handle to scale, or hover just outside a corner until the rotate cursor appears and drag to rotate.
                  </div>
                  <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:8, marginBottom:10 }}>
                    <div style={{ fontSize:10, color:'#9ca3af' }}>Independent left / right logos</div>
                    <button onClick={() => setSideLogoIndependent(v => !v)} style={{ background:sideLogoIndependent?'rgba(239,255,0,0.10)':'rgba(255,255,255,0.04)', border:sideLogoIndependent?'1px solid rgba(239,255,0,0.35)':'1px solid rgba(255,255,255,0.10)', borderRadius:6, padding:'5px 9px', cursor:'pointer', color:sideLogoIndependent?'#efff00':'#9ca3af', fontSize:9, fontWeight:800, fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:'0.06em' }}>{sideLogoIndependent?'ON':'OFF'}</button>
                  </div>

                  <input id="side-logo-shared-upload" type="file" accept="image/png,image/jpeg" onChange={handleSharedSideLogoUpload} style={{ display:'none' }} />
                  <input id="side-logo-left-upload" type="file" accept="image/png,image/jpeg" onChange={handleLeftSideLogoUpload} style={{ display:'none' }} />
                  <input id="side-logo-right-upload" type="file" accept="image/png,image/jpeg" onChange={handleRightSideLogoUpload} style={{ display:'none' }} />

                  {!sideLogoIndependent ? (
                    <div style={{ marginBottom:12 }}>
                      <label htmlFor="side-logo-shared-upload" style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:7, width:'100%', boxSizing:'border-box', background:'rgba(239,255,0,0.08)', border:'1px dashed rgba(239,255,0,0.35)', borderRadius:7, padding:'10px 12px', cursor:'pointer', fontSize:10, fontWeight:800, fontFamily:"'Barlow Condensed',sans-serif", color:'#efff00', letterSpacing:'0.06em' }}>
                        <span style={{ fontSize:14 }}>＋</span>{sideLogoSharedPreviewUrl ? 'REPLACE SIDE LOGO' : 'UPLOAD SIDE LOGO'}
                      </label>
                      {sideLogoSharedPreviewUrl && (
                        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:8, marginTop:8 }}>
                          <div style={{ fontSize:9, color:'#9ca3af', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }} title={sideLogoSharedFileName}>{sideLogoSharedFileName}</div>
                          <button onClick={() => removeSideLogoUpload('shared')} style={{ background:'rgba(239,68,68,0.08)', border:'1px solid rgba(239,68,68,0.25)', borderRadius:5, padding:'4px 7px', cursor:'pointer', color:'#ef4444', fontSize:8, fontWeight:700, fontFamily:"'Barlow Condensed',sans-serif" }}>REMOVE</button>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:12 }}>
                      <div>
                        <label htmlFor="side-logo-left-upload" style={{ display:'flex', alignItems:'center', justifyContent:'center', width:'100%', boxSizing:'border-box', background:'rgba(239,255,0,0.08)', border:'1px dashed rgba(239,255,0,0.35)', borderRadius:7, padding:'9px 10px', cursor:'pointer', fontSize:9, fontWeight:800, fontFamily:"'Barlow Condensed',sans-serif", color:'#efff00', letterSpacing:'0.06em' }}>UPLOAD LEFT</label>
                        {sideLogoLeftPreviewUrl && (
                          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:6, marginTop:8 }}>
                            <div style={{ fontSize:8, color:'#9ca3af', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }} title={sideLogoLeftFileName}>{sideLogoLeftFileName}</div>
                            <button onClick={() => removeSideLogoUpload('left')} style={{ background:'rgba(239,68,68,0.08)', border:'1px solid rgba(239,68,68,0.25)', borderRadius:5, padding:'3px 6px', cursor:'pointer', color:'#ef4444', fontSize:8, fontWeight:700, fontFamily:"'Barlow Condensed',sans-serif" }}>✕</button>
                          </div>
                        )}
                      </div>
                      <div>
                        <label htmlFor="side-logo-right-upload" style={{ display:'flex', alignItems:'center', justifyContent:'center', width:'100%', boxSizing:'border-box', background:'rgba(239,255,0,0.08)', border:'1px dashed rgba(239,255,0,0.35)', borderRadius:7, padding:'9px 10px', cursor:'pointer', fontSize:9, fontWeight:800, fontFamily:"'Barlow Condensed',sans-serif", color:'#efff00', letterSpacing:'0.06em' }}>UPLOAD RIGHT</label>
                        {sideLogoRightPreviewUrl && (
                          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:6, marginTop:8 }}>
                            <div style={{ fontSize:8, color:'#9ca3af', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }} title={sideLogoRightFileName}>{sideLogoRightFileName}</div>
                            <button onClick={() => removeSideLogoUpload('right')} style={{ background:'rgba(239,68,68,0.08)', border:'1px solid rgba(239,68,68,0.25)', borderRadius:5, padding:'3px 6px', cursor:'pointer', color:'#ef4444', fontSize:8, fontWeight:700, fontFamily:"'Barlow Condensed',sans-serif" }}>✕</button>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {sideLogoError && <div style={{ marginBottom:10, fontSize:10, color:'#ef4444', lineHeight:1.4 }}>{sideLogoError}</div>}

                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:12 }}>
                    {[
                      { side:'left', title:'LEFT SIDE', preview: sideLogoIndependent ? sideLogoLeftPreviewUrl : sideLogoSharedPreviewUrl, visible: sideLogoLeftVisible, setVisible: setSideLogoLeftVisible, mirrored: sideLogoLeftMirror, setMirrored: setSideLogoLeftMirror, rotated: sideLogoLeftRotate180, setRotated: setSideLogoLeftRotate180 },
                      { side:'right', title:'RIGHT SIDE', preview: sideLogoIndependent ? sideLogoRightPreviewUrl : sideLogoSharedPreviewUrl, visible: sideLogoRightVisible, setVisible: setSideLogoRightVisible, mirrored: sideLogoRightMirror, setMirrored: setSideLogoRightMirror, rotated: sideLogoRightRotate180, setRotated: setSideLogoRightRotate180 },
                    ].map(card => (
                      <div key={card.side} style={{ background:'rgba(255,255,255,0.02)', border:'1px solid rgba(255,255,255,0.05)', borderRadius:8, padding:8 }}>
                        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:7 }}>
                          <div style={{ fontSize:9, color:'#9ca3af', letterSpacing:'0.06em' }}>{card.title}</div>
                          <button onClick={() => card.setVisible(v => !v)} style={{ background:card.visible?'rgba(239,255,0,0.10)':'rgba(255,255,255,0.04)', border:card.visible?'1px solid rgba(239,255,0,0.35)':'1px solid rgba(255,255,255,0.10)', borderRadius:5, padding:'4px 6px', cursor:'pointer', color:card.visible?'#efff00':'#9ca3af', fontSize:8, fontWeight:800, fontFamily:"'Barlow Condensed',sans-serif" }}>{card.visible?'SHOWING':'HIDDEN'}</button>
                        </div>
                        <div style={{ position:'relative', width:'100%', aspectRatio:'1 / 1', overflow:'hidden', borderRadius:6, border:'1px solid rgba(255,255,255,0.08)', backgroundColor:'#c8cdd4', backgroundImage:'linear-gradient(45deg, rgba(255,255,255,0.95) 25%, transparent 25%, transparent 75%, rgba(255,255,255,0.95) 75%, rgba(255,255,255,0.95)), linear-gradient(45deg, rgba(255,255,255,0.95) 25%, transparent 25%, transparent 75%, rgba(255,255,255,0.95) 75%, rgba(255,255,255,0.95))', backgroundSize:'16px 16px', backgroundPosition:'0 0, 8px 8px', marginBottom:8 }}>
                          {card.preview ? <img src={card.preview} alt={`${card.title} preview`} style={{ position:'absolute', inset:0, width:'100%', height:'100%', objectFit:'contain', transform:`${card.mirrored ? 'scaleX(-1)' : ''}${card.rotated ? ' rotate(180deg)' : ''}`.trim() || 'none', opacity:card.visible ? 1 : 0.35 }} /> : <div style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center', color:'#6b7280', fontSize:9 }}>NO LOGO</div>}
                        </div>
                        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
                          <button onClick={() => card.setMirrored(v => !v)} style={{ background:card.mirrored?'rgba(239,255,0,0.10)':'rgba(255,255,255,0.04)', border:card.mirrored?'1px solid rgba(239,255,0,0.35)':'1px solid rgba(255,255,255,0.10)', borderRadius:5, padding:'5px 6px', cursor:'pointer', color:card.mirrored?'#efff00':'#9ca3af', fontSize:8, fontWeight:800, fontFamily:"'Barlow Condensed',sans-serif" }}>MIRROR</button>
                          <button onClick={() => card.setRotated(v => !v)} style={{ background:card.rotated?'rgba(239,255,0,0.10)':'rgba(255,255,255,0.04)', border:card.rotated?'1px solid rgba(239,255,0,0.35)':'1px solid rgba(255,255,255,0.10)', borderRadius:5, padding:'5px 6px', cursor:'pointer', color:card.rotated?'#efff00':'#9ca3af', fontSize:8, fontWeight:800, fontFamily:"'Barlow Condensed',sans-serif" }}>ROTATE 180°</button>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:10 }}>
                    <button onClick={() => { sideLogoPlacementRef.current.left = cloneDefaultSideLogoPlacement(); sideLogoPlacementRef.current.right = cloneDefaultSideLogoPlacement(); setSelectedSideLogo(null); selectedSideLogoRef.current = null; setSideLogoRevision(v => v + 1); }} style={{ width:'100%', background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.10)', borderRadius:6, padding:'7px 8px', cursor:'pointer', color:'#9ca3af', fontSize:9, fontWeight:800, fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:'0.05em' }}>RESET POSITIONS</button>
                    <button onClick={() => setSideLogoLocked(v => !v)} style={{ width:'100%', background:sideLogoLocked?'rgba(239,255,0,0.10)':'rgba(255,255,255,0.04)', border:sideLogoLocked?'1px solid rgba(239,255,0,0.35)':'1px solid rgba(255,255,255,0.10)', borderRadius:6, padding:'7px 8px', cursor:'pointer', color:sideLogoLocked?'#efff00':'#9ca3af', fontSize:9, fontWeight:800, fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:'0.05em' }}>{sideLogoLocked ? 'LOCKED' : 'UNLOCKED'}</button>
                  </div>

                  <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8 }}>
                    <span style={{ width:56, flexShrink:0, fontSize:9, color:'#9ca3af' }}>Size</span>
                    <input type="range" min="40" max="180" value={Math.round(sideLogoScale*100)} onChange={e => setSideLogoScale(parseInt(e.target.value)/100)} style={{ flex:1, minWidth:0 }} />
                  </div>
                  <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8 }}>
                    <span style={{ width:56, flexShrink:0, fontSize:9, color:'#9ca3af' }}>F / B</span>
                    <input type="range" min="-50" max="50" value={sideLogoFrontBack} onChange={e => setSideLogoFrontBack(parseInt(e.target.value))} style={{ flex:1, minWidth:0 }} />
                  </div>
                  <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:12 }}>
                    <span style={{ width:56, flexShrink:0, fontSize:9, color:'#9ca3af' }}>Up / Down</span>
                    <input type="range" min="-50" max="50" value={sideLogoUpDown} onChange={e => setSideLogoUpDown(parseInt(e.target.value))} style={{ flex:1, minWidth:0 }} />
                  </div>

                  <div style={{ height:1, background:'rgba(255,255,255,0.06)', margin:'10px 0 10px' }} />
                  <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:8, marginBottom:10 }}>
                    <div>
                      <SectionLabel>Logo Stroke</SectionLabel>
                      <div style={{ fontSize:9, color:'#6b7280', lineHeight:1.4, marginTop:-4 }}>Outside-aligned stroke for thicker decal builds.</div>
                    </div>
                    <button onClick={() => setSideLogoStrokeEnabled(v => !v)} style={{ background:sideLogoStrokeEnabled?'rgba(239,255,0,0.10)':'rgba(255,255,255,0.04)', border:sideLogoStrokeEnabled?'1px solid rgba(239,255,0,0.35)':'1px solid rgba(255,255,255,0.10)', borderRadius:6, padding:'5px 9px', cursor:'pointer', color:sideLogoStrokeEnabled?'#efff00':'#9ca3af', fontSize:9, fontWeight:800, fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:'0.06em' }}>{sideLogoStrokeEnabled?'ON':'OFF'}</button>
                  </div>
                  {sideLogoStrokeEnabled && (
                    <>
                      <ColorSwatch color={sideLogoStrokeColor} onChange={setSideLogoStrokeColor} label="Stroke Color" />
                      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8 }}>
                        <span style={{ width:56, flexShrink:0, fontSize:9, color:'#9ca3af' }}>Thickness</span>
                        <input type="range" min="0" max="30" value={sideLogoStrokeThickness} onChange={e => setSideLogoStrokeThickness(parseInt(e.target.value))} style={{ flex:1, minWidth:0 }} />
                      </div>
                      <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                        <span style={{ width:56, flexShrink:0, fontSize:9, color:'#9ca3af' }}>Opacity</span>
                        <input type="range" min="0" max="100" value={Math.round(sideLogoStrokeOpacity*100)} onChange={e => setSideLogoStrokeOpacity(parseInt(e.target.value)/100)} style={{ flex:1, minWidth:0 }} />
                      </div>
                    </>
                  )}
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

          {/* Preset view buttons */}
          {loaded && (
            <div style={{ position:'absolute', top:16, right:16, width:180, background:'rgba(0,0,0,0.45)', border:'1px solid rgba(255,255,255,0.08)', borderRadius:10, padding:'10px 10px 9px', backdropFilter:'blur(6px)' }}>
              <div style={{ fontSize:9, color:'#6b7280', letterSpacing:'0.12em', fontFamily:"'Barlow Condensed',sans-serif", marginBottom:8 }}>PRESET VIEWS</div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
                {[
                  { id:'sideA', label:'SIDE A' },
                  { id:'sideB', label:'SIDE B' },
                  { id:'front', label:'FRONT' },
                  { id:'back', label:'BACK' },
                  { id:'top', label:'TOP' },
                  { id:'hero', label:'HERO' },
                ].map(view => (
                  <button
                    key={view.id}
                    onClick={() => applyViewPreset(view.id)}
                    style={{
                      background: activeViewPreset === view.id ? 'rgba(239,255,0,0.12)' : 'rgba(255,255,255,0.04)',
                      border: activeViewPreset === view.id ? '1px solid rgba(239,255,0,0.45)' : '1px solid rgba(255,255,255,0.10)',
                      borderRadius: 7,
                      padding: '7px 6px',
                      cursor: 'pointer',
                      color: activeViewPreset === view.id ? '#efff00' : '#9ca3af',
                      fontSize: 9,
                      fontWeight: 700,
                      fontFamily: "'Barlow Condensed', sans-serif",
                      letterSpacing: '0.06em'
                    }}
                  >
                    {view.label}
                  </button>
                ))}
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
