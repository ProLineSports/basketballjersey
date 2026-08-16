'use client';
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useUser, useClerk, UserButton } from '@clerk/nextjs';
import ManagePlanPage, { PlanIcon } from '../../components/ManagePlanPage';
import { useRouter } from 'next/navigation';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DecalGeometry } from 'three/addons/geometries/DecalGeometry.js';

const HELMET_MODEL_URL = '/SpeedFlex-draco.glb';
const DRACO_DECODER_PATH = '/draco/';
const REAR_FLAG_URL = '/Flag-United-States-of-America.webp';
const REAR_WARNING_URL = '/Warning-Label-White.png';

// ── PART / COLOR ZONES ───────────────────────────────────────────────────────
// `parts` uses the exact mesh/node names exported in SpeedFlex.glb.
// Shell, Side Screws, and Top Screws intentionally share one color control.
const ZONES = [
  { id: 'shell',             label: 'Shell',                    parts: ['Shell', 'Side Screws', 'Top Screws'], defaultColor: '#2B2B2B' },
  { id: 'bumpers',           label: 'Bumpers',                  parts: ['Bumpers'],                           defaultColor: '#FCFCFC' },
  { id: 'facemask',          label: 'Facemask',                 parts: ['Facemask'],                          defaultColor: '#EFFF00' },
  { id: 'facemaskclips',     label: 'Facemask Clips',           parts: ['Facemask Clips'],                    defaultColor: '#212121' },
  { id: 'facemaskhardware',  label: 'Facemask Clips Hardware',  parts: ['Facemask Clips Hardware'],           defaultColor: '#151515' },
  { id: 'innerpads',         label: 'Inner Pads',                parts: ['Inner Pads'],                        defaultColor: '#EAEAEA' },
  { id: 'visor',             label: 'Visor',                     parts: ['Visor'],                             defaultColor: '#000000' },
  { id: 'visorclips',        label: 'Visor Clips',               parts: ['Visor Clips'],                       defaultColor: '#EFFF00' },
  { id: 'chinguardinner',    label: 'Chin Guard - Inner',        parts: ['Chin Guard - Inner'],                defaultColor: '#FCFCFC' },
  { id: 'chinguardouter',    label: 'Chin Guard - Outer',        parts: ['Chin Guard - Outer'],                defaultColor: '#FCFCFC' },
  { id: 'metalparts',        label: 'Metal Parts',               parts: ['Metal Parts'],                       defaultColor: '#212121' },
  { id: 'strapclipslower',   label: 'Strap Clips - Lower',       parts: ['Strap Clips - Lower'],               defaultColor: '#212121' },
  { id: 'strapclipsupper',   label: 'Strap Clips - Upper',       parts: ['Strap Clips - Upper'],               defaultColor: '#212121' },
  { id: 'straps',            label: 'Straps',                    parts: ['Straps'],                            defaultColor: '#FCFCFC' },
];

// Three.js sanitizes glTF node names when it loads them (for example, spaces can
// become underscores). Compare part names through a stable key so the UI can keep
// using the clean Blender/GLB names above while still matching the runtime objects.
const partKey = (name = '') => name.toLowerCase().replace(/[^a-z0-9]/g, '');

const formatDebugMs = (value) => Number.isFinite(value) ? `${Math.round(value)} ms` : '—';

const formatDebugBytes = (value) => {
  if (!Number.isFinite(value) || value <= 0) return '—';
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${Math.round(value)} B`;
};

const formatDebugCount = (value) =>
  Number.isFinite(value) ? Math.round(value).toLocaleString() : '—';


function getSafeExportPlan(renderer, finalWidth, finalHeight, requestedSupersample) {
  const gl = renderer?.getContext?.();
  const maxTextureSize = gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : 4096;
  const maxRenderbufferSize = gl ? gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) : 4096;

  // Browsers/GPUs may report limits above what is sensible for a single temporary
  // export buffer. Capping the internal edge at 8192 avoids 12K+ buffers while still
  // allowing true 2x supersampling for a 4096px export on capable hardware.
  const safeDimension = Math.max(
    1,
    Math.min(
      Number(maxTextureSize) || 4096,
      Number(maxRenderbufferSize) || 4096,
      8192
    )
  );

  const finalMaxDimension = Math.max(finalWidth, finalHeight);
  const supported = finalMaxDimension <= safeDimension;
  const maxSupersample = supported
    ? Math.max(1, Math.floor(safeDimension / Math.max(1, finalMaxDimension)))
    : 0;

  const actualSupersample = supported
    ? Math.max(1, Math.min(requestedSupersample, maxSupersample))
    : 0;

  return {
    supported,
    maxTextureSize,
    maxRenderbufferSize,
    safeDimension,
    requestedSupersample,
    actualSupersample,
    renderWidth: actualSupersample ? Math.max(1, Math.round(finalWidth * actualSupersample)) : 0,
    renderHeight: actualSupersample ? Math.max(1, Math.round(finalHeight * actualSupersample)) : 0,
  };
}

function getBaseModelStats(model) {
  if (!model) return { meshes:0, triangles:0, vertices:0 };

  const seenGeometries = new Set();
  let meshes = 0;
  let triangles = 0;
  let vertices = 0;

  model.traverse(obj => {
    if (!obj.isMesh || !obj.geometry) return;
    meshes += 1;

    const geo = obj.geometry;
    if (seenGeometries.has(geo)) return;
    seenGeometries.add(geo);

    const pos = geo.attributes?.position;
    if (pos) vertices += pos.count;

    triangles += geo.index
      ? Math.floor(geo.index.count / 3)
      : pos
        ? Math.floor(pos.count / 3)
        : 0;
  });

  return { meshes, triangles, vertices };
}

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
    const wrapUvValues = new Float32Array(pos.count * 2);
    const finishUvValues = new Float32Array(pos.count * 2);
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
        wrapUvValues[vi * 2] = u[k];
        wrapUvValues[vi * 2 + 1] = THREE.MathUtils.clamp(v[k], 0, 1);
        stripePathValues[vi] = path[k];

        const mp = modelPos[k];
        modelPositionValues[vi * 3] = mp.x;
        modelPositionValues[vi * 3 + 1] = mp.y;
        modelPositionValues[vi * 3 + 2] = mp.z;

        // Finish projection for Shell glitter/metallic effects:
        // use a common shell-space planar X/Z mapping rather than the cylindrical wrap UV.
        // The flake/noise textures are isotropic, so this avoids the crown pinch/emanation
        // artifact while remaining visually continuous across the shell.
        finishUvValues[vi * 2] = THREE.MathUtils.clamp((mp.x - minX) / width, 0, 1);
        finishUvValues[vi * 2 + 1] = THREE.MathUtils.clamp((mp.z - minZ) / depth, 0, 1);
      }
    }

    // Keep wrap/decal UVs in a dedicated attribute and reserve uv / uv2 for the shell
    // finish projection. This makes Car Paint / Satin textures continuous and removes
    // the visible crown singularity from cylindrical mapping.
    mesh.geometry.setAttribute('uv', new THREE.BufferAttribute(finishUvValues, 2));
    mesh.geometry.setAttribute('uv2', new THREE.BufferAttribute(finishUvValues.slice(), 2));

    // These attributes let stripe decals be rendered directly on the Shell surface.
    // That guarantees no floating geometry and makes stripes layer above a full wrap.
    mesh.geometry.setAttribute('helmetModelPosition', new THREE.BufferAttribute(modelPositionValues, 3));
    mesh.geometry.setAttribute('helmetStripePath', new THREE.BufferAttribute(stripePathValues, 1));
    mesh.geometry.setAttribute('helmetWrapUv', new THREE.BufferAttribute(wrapUvValues.slice(), 2));

    mesh.geometry.attributes.uv.needsUpdate = true;
    mesh.geometry.attributes.uv2.needsUpdate = true;
    mesh.geometry.attributes.helmetModelPosition.needsUpdate = true;
    mesh.geometry.attributes.helmetStripePath.needsUpdate = true;
    mesh.geometry.attributes.helmetWrapUv.needsUpdate = true;
  });

  return {
    minX,
    maxX,
    minZ,
    maxZ,
    width,
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

  const { minX, width, minZ, centerX, centerZ, height, depth, stripePivotY, stripeRawMin, stripeRawMax } = projection;
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
      const finishUvValues = new Float32Array(pos.count * 2);

      for (let i = 0; i < pos.count; i++) {
        p.fromBufferAttribute(pos, i).applyMatrix4(localToModel);
        // Optional X compression expands stripe coverage on small crown hardware without
        // changing the stripe width on the Shell itself. Top screws use this to prevent a
        // hairline of the screw edge from peeking out beside the decal.
        const projectedX = centerX + (p.x - centerX) * xCompression;
        modelPositionValues[i * 3] = projectedX;
        modelPositionValues[i * 3 + 1] = p.y;
        modelPositionValues[i * 3 + 2] = p.z;

        finishUvValues[i * 2] = THREE.MathUtils.clamp((projectedX - minX) / Math.max(width, 0.000001), 0, 1);
        finishUvValues[i * 2 + 1] = THREE.MathUtils.clamp((p.z - minZ) / Math.max(depth, 0.000001), 0, 1);

        const theta = Math.atan2((p.z - centerZ) / depth, (p.y - stripePivotY) / height);
        const raw = 0.5 - theta / Math.PI;
        stripePathValues[i] = THREE.MathUtils.clamp(
          (raw - stripeRawMin) / Math.max(0.000001, stripeRawMax - stripeRawMin),
          0,
          1
        );
      }

      obj.geometry.setAttribute('uv', new THREE.BufferAttribute(finishUvValues, 2));
      obj.geometry.setAttribute('uv2', new THREE.BufferAttribute(finishUvValues.slice(), 2));
      obj.geometry.setAttribute('helmetModelPosition', new THREE.BufferAttribute(modelPositionValues, 3));
      obj.geometry.setAttribute('helmetStripePath', new THREE.BufferAttribute(stripePathValues, 1));
      obj.geometry.attributes.uv.needsUpdate = true;
      obj.geometry.attributes.uv2.needsUpdate = true;
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
    shader.uniforms.uHelmetStripePreset = decalUniforms.preset;
    shader.uniforms.uHelmetStripeLeftColor = decalUniforms.leftColor;
    shader.uniforms.uHelmetStripeCenterColor = decalUniforms.centerColor;
    shader.uniforms.uHelmetStripeRightColor = decalUniforms.rightColor;
    shader.uniforms.uHelmetStripePipingColor = decalUniforms.pipingColor;
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
uniform float uHelmetStripePreset;
uniform vec3 uHelmetStripeLeftColor;
uniform vec3 uHelmetStripeCenterColor;
uniform vec3 uHelmetStripeRightColor;
uniform vec3 uHelmetStripePipingColor;
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
  float absStripeX = abs(stripeX);

  // Single stripe uses one stripe-width. All multi-stripe presets occupy the same
  // total 3-stripe envelope so the Width control behaves consistently between presets.
  float totalHalfWidth = (uHelmetStripePreset < 0.5) ? stripeW * 0.5 : stripeW * 1.5;

  float edgeAA = max(fwidth(stripeX) * 1.75, 0.00028);
  float widthMask = 1.0 - smoothstep(
    totalHalfWidth - edgeAA,
    totalHalfWidth + edgeAA,
    absStripeX
  );

  float normalizedX = absStripeX / max(totalHalfWidth, 0.000001);
  float normalizedAA = edgeAA / max(totalHalfWidth, 0.000001);
  vec3 stripeColor = uHelmetStripeCenterColor;

  if (uHelmetStripePreset < 0.5) {
    // Single stripe — exact SVG default/color zone.
    stripeColor = uHelmetStripeCenterColor;

  } else if (uHelmetStripePreset < 1.5) {
    // 3 equal stripes: 400 / 400 / 400 on a 1200-unit SVG.
    const float CENTER_EDGE = 0.3333333333;
    float outerMix = smoothstep(
      CENTER_EDGE - normalizedAA,
      CENTER_EDGE + normalizedAA,
      normalizedX
    );
    stripeColor = mix(uHelmetStripeCenterColor, uHelmetStripeLeftColor, outerMix);

  } else if (uHelmetStripePreset < 2.5) {
    // Thick-center SVG:
    // visible center = 577.455, visible outer stripes = 311.2725 each.
    const float CENTER_EDGE = 0.4812125;
    float outerMix = smoothstep(
      CENTER_EDGE - normalizedAA,
      CENTER_EDGE + normalizedAA,
      normalizedX
    );
    stripeColor = mix(uHelmetStripeCenterColor, uHelmetStripeLeftColor, outerMix);

  } else {
    // 5-stripe SVG after layer overlap:
    // outer 311.273 | piping 88.727 | center 400 | piping 88.727 | outer 311.273
    const float CENTER_EDGE = 0.3333333333;
    const float PIPE_OUTER_EDGE = 0.4812125;

    float toPipe = smoothstep(
      CENTER_EDGE - normalizedAA,
      CENTER_EDGE + normalizedAA,
      normalizedX
    );
    float toOuter = smoothstep(
      PIPE_OUTER_EDGE - normalizedAA,
      PIPE_OUTER_EDGE + normalizedAA,
      normalizedX
    );

    stripeColor = mix(uHelmetStripeCenterColor, uHelmetStripePipingColor, toPipe);
    stripeColor = mix(stripeColor, uHelmetStripeLeftColor, toOuter);
  }

  float pathAA = max(fwidth(vHelmetStripePath) * 1.5, 0.0020);
  float lengthMask = 1.0 - smoothstep(
    uHelmetStripeLength - pathAA,
    uHelmetStripeLength + pathAA,
    vHelmetStripePath
  );
  float stripeMask = widthMask * lengthMask;

  if (uHelmetStripeBaseEnabled > 0.5) {
    helmetDecal.rgb = mix(helmetDecal.rgb, stripeColor, stripeMask);
    helmetDecal.a = max(helmetDecal.a, stripeMask);
  }

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
    // The shell-wrap overlay is expensive even when its shader discards every pixel.
    // Keep it out of the render list until a wrap is actually enabled.
    overlay.visible = false;
    source.parent?.add(overlay);

    overlays.push(overlay);
    materials.push(material);
  });

  return { overlays, materials };
}



function createWorldSpaceDecalOverlays(scene, roots, decalUniforms, options = {}) {
  const { normalLift = 0, renderOrder = 20, namePrefix = 'CarrierStripe', subdivisionLevels = 0 } = options;
  const overlays = [];
  const materials = [];
  const seen = new Set();

  (roots || []).forEach(root => {
    root.traverse(source => {
      if (!source.isMesh || !source.geometry?.attributes?.helmetModelPosition || seen.has(source)) return;
      seen.add(source);
      source.updateWorldMatrix(true, false);

      let geometry = source.geometry.clone();
      if (subdivisionLevels > 0) geometry = subdivideGeometryWithAttributes(geometry, subdivisionLevels);
      if (normalLift) offsetGeometryAlongNormals(geometry, normalLift);
      const material = new THREE.MeshPhysicalMaterial({
        color: 0xffffff,
        roughness: 0.08,
        metalness: 0.0,
        clearcoat: 1.0,
        clearcoatRoughness: 0.04,
        transparent: true,
        opacity: 1.0,
        alphaTest: 0.001,
        side: THREE.DoubleSide,
        depthTest: true,
        // Restore the stripe decal so it reads clearly above the shell again.
        // The bumpers still win visually because the stripe lives on the shell carrier
        // while the real bumper geometry remains physically in front.
        depthWrite: true,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      });
        installDecalOverlayShader(material, decalUniforms);

      const overlay = new THREE.Mesh(geometry, material);
      overlay.name = `${namePrefix}_${source.name || 'Surface'}`;
      source.matrixWorld.decompose(overlay.position, overlay.quaternion, overlay.scale);
      overlay.renderOrder = renderOrder;
      overlay.castShadow = false;
      overlay.receiveShadow = false;
      // Stripe carrier geometry can be relatively dense after subdivision. Do not
      // submit it to WebGL at all until a built-in or uploaded stripe is active.
      overlay.visible = false;
      scene.add(overlay);
      overlays.push(overlay);
      materials.push(material);
    });
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


function subdivideGeometryWithAttributes(geometry, iterations = 1) {
  if (!geometry || iterations <= 0) return geometry;
  let working = geometry.index ? geometry.toNonIndexed() : geometry.clone();

  for (let iter = 0; iter < iterations; iter++) {
    const attrNames = Object.keys(working.attributes);
    const attrMeta = attrNames.map(name => {
      const attr = working.getAttribute(name);
      return { name, itemSize: attr.itemSize };
    });

    const out = new THREE.BufferGeometry();
    const buffers = {};
    attrMeta.forEach(meta => { buffers[meta.name] = []; });

    const pushVertex = (storage, values) => {
      for (let i = 0; i < values.length; i++) storage.push(values[i]);
    };

    const readVertex = (attr, index) => {
      const outVals = [];
      for (let k = 0; k < attr.itemSize; k++) outVals.push(attr.array[index * attr.itemSize + k]);
      return outVals;
    };

    const midpoint = (a, b, name) => {
      const m = a.map((v, i) => (v + b[i]) * 0.5);
      if (name === 'normal' && m.length >= 3) {
        const len = Math.hypot(m[0], m[1], m[2]) || 1;
        m[0] /= len; m[1] /= len; m[2] /= len;
      }
      return m;
    };

    const triPatterns = [
      [0, 3, 5], // a, ab, ca
      [3, 1, 4], // ab, b, bc
      [5, 4, 2], // ca, bc, c
      [3, 4, 5], // ab, bc, ca
    ];

    const position = working.getAttribute('position');
    const triCount = Math.floor(position.count / 3);

    for (let tri = 0; tri < triCount; tri++) {
      const ia = tri * 3;
      const ib = ia + 1;
      const ic = ia + 2;

      attrMeta.forEach(({ name }) => {
        const attr = working.getAttribute(name);
        const a = readVertex(attr, ia);
        const b = readVertex(attr, ib);
        const c = readVertex(attr, ic);
        const ab = midpoint(a, b, name);
        const bc = midpoint(b, c, name);
        const ca = midpoint(c, a, name);
        const verts = [a, b, c, ab, bc, ca];

        triPatterns.forEach(pattern => {
          pattern.forEach(idx => pushVertex(buffers[name], verts[idx]));
        });
      });
    }

    attrMeta.forEach(({ name, itemSize }) => {
      out.setAttribute(name, new THREE.Float32BufferAttribute(buffers[name], itemSize));
    });

    out.computeBoundingBox();
    out.computeBoundingSphere();
    // IMPORTANT: do not recompute normals here. The subdivision routine already
    // interpolates and normalizes the source normals. Recomputing normals on this
    // non-indexed geometry produces one face normal per tiny triangle, which is what
    // caused the visible grid/triangulation pattern across the stripe carrier.
    working.dispose?.();
    working = out;
  }

  return working;
}

function createSelectionBoxTexture() {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  ctx.strokeStyle = '#efff00';
  ctx.lineWidth = 2.5;
  ctx.setLineDash([9, 7]);
  ctx.strokeRect(12, 12, size - 24, size - 24);
  ctx.setLineDash([]);
  const handle = 14;
  [[12,12],[size-12,12],[12,size-12],[size-12,size-12]].forEach(([x,y]) => {
    ctx.fillStyle = '#111111';
    ctx.strokeStyle = '#efff00';
    ctx.lineWidth = 2.5;
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
    textureSize = 1024,
    textureWidth = null,
    textureHeight = null,
    arcCompensation = 0,
  } = options;

  const size = Math.max(512, textureSize | 0);
  const canvasWidth = Math.max(512, (textureWidth ?? size) | 0);
  const canvasHeight = Math.max(256, (textureHeight ?? size) | 0);
  const baseCanvas = document.createElement('canvas');
  baseCanvas.width = canvasWidth;
  baseCanvas.height = canvasHeight;
  const baseCtx = baseCanvas.getContext('2d');
  if (!baseCtx) return null;

  // Keep the base logo footprint fixed so increasing the stroke does not make
  // the logo itself shrink. We reserve a generous constant margin instead.
  const pad = 120;
  const fitW = canvasWidth - pad * 2;
  const fitH = canvasHeight - pad * 2;
  const scale = Math.min(fitW / image.naturalWidth, fitH / image.naturalHeight);
  const drawW = image.naturalWidth * scale;
  const drawH = image.naturalHeight * scale;

  baseCtx.clearRect(0, 0, canvasWidth, canvasHeight);
  baseCtx.save();
  baseCtx.translate(canvasWidth / 2, canvasHeight / 2);
  if (rotate180) baseCtx.rotate(Math.PI);
  baseCtx.scale(mirror ? -1 : 1, 1);
  baseCtx.drawImage(image, -drawW / 2, -drawH / 2, drawW, drawH);
  baseCtx.restore();

  const makeExpandedAlphaCanvas = (radiusPx, colorHex, opacityValue, cutCenter = false) => {
    const out = document.createElement('canvas');
    out.width = canvasWidth;
    out.height = canvasHeight;
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
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);
    ctx.globalAlpha = 1;
    if (cutCenter) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.drawImage(baseCanvas, 0, 0);
    }
    ctx.globalCompositeOperation = 'source-over';
    return out;
  };

  const finalCanvas = document.createElement('canvas');
  finalCanvas.width = canvasWidth;
  finalCanvas.height = canvasHeight;
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

  const warpedFinalCanvas = warpCanvasArc(finalCanvas, arcCompensation);
  const warpedRimCanvas = warpCanvasArc(rimCanvas, arcCompensation);

  const mainTexture = new THREE.CanvasTexture(warpedFinalCanvas);
  mainTexture.colorSpace = THREE.SRGBColorSpace;
  mainTexture.wrapS = mainTexture.wrapT = THREE.ClampToEdgeWrapping;
  mainTexture.minFilter = THREE.LinearMipmapLinearFilter;
  mainTexture.magFilter = THREE.LinearFilter;
  mainTexture.generateMipmaps = true;
  mainTexture.anisotropy = 16;
  mainTexture.needsUpdate = true;

  const rimTexture = new THREE.CanvasTexture(warpedRimCanvas);
  rimTexture.colorSpace = THREE.SRGBColorSpace;
  rimTexture.wrapS = rimTexture.wrapT = THREE.ClampToEdgeWrapping;
  rimTexture.minFilter = THREE.LinearMipmapLinearFilter;
  rimTexture.magFilter = THREE.LinearFilter;
  rimTexture.generateMipmaps = true;
  rimTexture.anisotropy = 16;
  rimTexture.needsUpdate = true;

  return {
    aspect: image.naturalWidth / Math.max(1, image.naturalHeight),
    mainTexture,
    rimTexture,
  };
}


function warpCanvasArc(sourceCanvas, arcAmountPx = 0) {
  if (!sourceCanvas || Math.abs(arcAmountPx) < 0.001) return sourceCanvas;
  const out = document.createElement('canvas');
  out.width = sourceCanvas.width;
  out.height = sourceCanvas.height;
  const ctx = out.getContext('2d');
  if (!ctx) return sourceCanvas;
  const w = sourceCanvas.width;
  const h = sourceCanvas.height;
  for (let x = 0; x < w; x++) {
    const t = w <= 1 ? 0 : (x / (w - 1)) * 2 - 1;
    const yOffset = arcAmountPx * (1.0 - t * t);
    ctx.drawImage(sourceCanvas, x, 0, 1, h, x, yOffset, 1, h);
  }
  return out;
}


function installSideLogoSurfaceProjection(material, uniforms, cacheKey) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSideLogoCenter = uniforms.center;
    shader.uniforms.uSideLogoRight = uniforms.right;
    shader.uniforms.uSideLogoUp = uniforms.up;
    shader.uniforms.uSideLogoWidth = uniforms.width;
    shader.uniforms.uSideLogoHeight = uniforms.height;
    shader.uniforms.uSideLogoNormal = uniforms.normal;
    shader.uniforms.uSideLogoDepth = uniforms.depth;
    shader.uniforms.uSideLogoLift = uniforms.lift;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uSideLogoLift;
varying vec3 vSideLogoWorldPosition;
varying vec3 vSideLogoWorldNormal;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
transformed += normalize(normal) * uSideLogoLift;
vSideLogoWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;
vSideLogoWorldNormal = normalize(mat3(modelMatrix) * normal);`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 uSideLogoCenter;
uniform vec3 uSideLogoRight;
uniform vec3 uSideLogoUp;
uniform float uSideLogoWidth;
uniform float uSideLogoHeight;
uniform vec3 uSideLogoNormal;
uniform float uSideLogoDepth;
varying vec3 vSideLogoWorldPosition;
varying vec3 vSideLogoWorldNormal;`
      )
      .replace(
        '#include <map_fragment>',
        `
vec3 sideLogoDelta = vSideLogoWorldPosition - uSideLogoCenter;
float sideLogoU = dot(sideLogoDelta, uSideLogoRight) / max(uSideLogoWidth, 0.000001) + 0.5;
float sideLogoV = dot(sideLogoDelta, uSideLogoUp) / max(uSideLogoHeight, 0.000001) + 0.5;
float sideLogoDepth = abs(dot(sideLogoDelta, normalize(uSideLogoNormal)));
float sideLogoFacing = dot(normalize(vSideLogoWorldNormal), normalize(uSideLogoNormal));
vec4 sideLogoSample = vec4(0.0);
// Width/height define the artwork rectangle. Depth + facing only prevent the same
// planar coordinates from landing on a second fold of the carrier shell; they do not
// add a visible circular/elliptical mask to the logo itself.
if (
  sideLogoU >= 0.0 && sideLogoU <= 1.0 &&
  sideLogoV >= 0.0 && sideLogoV <= 1.0 &&
  sideLogoDepth <= uSideLogoDepth &&
  sideLogoFacing > 0.05
) {
  sideLogoSample = texture2D(map, vec2(sideLogoU, sideLogoV));
}
diffuseColor.rgb *= sideLogoSample.rgb;
diffuseColor.a *= sideLogoSample.a;
`
      );
  };
  material.customProgramCacheKey = () => cacheKey;
  material.needsUpdate = true;
}

function createCarrierSurfaceLogoMeshes(scene, sourceMeshes, material, side, layerName, renderOrder) {
  const meshes = [];
  sourceMeshes.forEach((source, index) => {
    const geometry = source.geometry.clone();
    const overlay = new THREE.Mesh(geometry, material);
    overlay.name = `SideLogo_${side}_${layerName}_${index}`;
    overlay.userData.sideLogoSide = side;
    overlay.userData.sideLogoArtwork = true;
    overlay.renderOrder = renderOrder;
    overlay.castShadow = false;
    overlay.receiveShadow = false;
    source.updateWorldMatrix(true, false);
    source.matrixWorld.decompose(overlay.position, overlay.quaternion, overlay.scale);
    scene.add(overlay);
    meshes.push(overlay);
  });
  return meshes;
}

const DEFAULT_SIDE_LOGO_PLACEMENT = Object.freeze({ yNorm: 0.64, zNorm: -0.18, scale: 1, rotation: 0 });
const cloneDefaultSideLogoPlacement = () => ({ ...DEFAULT_SIDE_LOGO_PLACEMENT });

const FINISHES = [
  { id: 'gloss',      label: 'Gloss',         roughness: 0.05, metalness: 0.1,  clearcoat: 1.0,  clearcoatRoughness: 0.05, iridescence: 0.0 },
  { id: 'matte',      label: 'Matte',         roughness: 0.9,  metalness: 0.0,  clearcoat: 0.0,  clearcoatRoughness: 0.0,  iridescence: 0.0 },
  { id: 'satin',      label: 'Satin',         roughness: 0.4,  metalness: 0.05, clearcoat: 0.3,  clearcoatRoughness: 0.2,  iridescence: 0.0 },
  { id: 'carbonfiber',label: 'Carbon Fiber',  roughness: 0.34, metalness: 0.18, clearcoat: 0.92, clearcoatRoughness: 0.08, iridescence: 0.0 },
  // iridescence dialed way down from 1.0 — full-strength iridescence produced a rainbow oil-slick
  // look that read as "broken" rather than sparkly metallic paint. 0.35 gives a subtle pearlescent shift.
  { id: 'carpaint',   label: 'Car Paint',     roughness: 0.15, metalness: 0.2,  clearcoat: 1.0,  clearcoatRoughness: 0.02, iridescence: 0.35, iridescenceIOR: 1.8, iridescenceThicknessRange: [100, 300] },
  { id: 'chrome',     label: 'Chrome',        roughness: 0.0,  metalness: 1.0,  clearcoat: 0.0,  clearcoatRoughness: 0.0,  iridescence: 0.0 },
];

const DECAL_FINISHES = [
  { id: 'gloss',  label: 'Gloss',  roughness: 0.08, metalness: 0.0, clearcoat: 1.0, clearcoatRoughness: 0.04 },
  { id: 'satin',  label: 'Satin',  roughness: 0.38, metalness: 0.0, clearcoat: 0.25, clearcoatRoughness: 0.20 },
  { id: 'matte',  label: 'Matte',  roughness: 0.88, metalness: 0.0, clearcoat: 0.0, clearcoatRoughness: 0.0 },
  { id: 'chrome', label: 'Chrome', roughness: 0.02, metalness: 1.0, clearcoat: 0.0, clearcoatRoughness: 0.0 },
];

const STRIPE_PRESET_OPTIONS = [
  { id: 'single', label: 'Single Stripe' },
  { id: 'threeEqual', label: '3 Stripe — Equal' },
  { id: 'threeThickCenter', label: '3 Stripe — Thick Center' },
  { id: 'fivePiped', label: '5 Stripe — Center + Piping' },
];

const HDRI_PRESETS = [
  { id: 'neutral', label: 'Neutral Studio', url: null },
  { id: 'studio01', label: 'Studio 01', url: '/hdri/studio_small_01_2k.exr' },
  { id: 'studio08', label: 'Studio 08', url: '/hdri/studio_small_08_2k.exr' },
  { id: 'probeSoft', label: 'Light Probe — Soft', url: '/hdri/DTLP6-LightProbe03-Soft-2k.exr' },
  { id: 'probeDirect', label: 'Light Probe — Direct', url: '/hdri/DTLP6-LightProbe03-Direct-2k.exr' },
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
    // Non-chrome decals use scene.environment for realistic IBL; Chrome keeps its
    // dedicated reflection map and stronger response.
    mat.envMapIntensity = finishId === 'chrome' ? 1.6 : 1.0;
    mat.needsUpdate = true;
  });
}


const CREDITS_INITIAL = 3;

// Materials that make up the shell — the only materials the Finish selector (and its
// environment map / glitter map) is allowed to touch. Hardware (screws, shiny metal)
// intentionally does NOT get an env map anymore — that was the other source of the
// "everything looks washed out" complaint.
const SHELL_MATERIAL_NAMES = ['__ShellContinuousSurface'];
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
  const intensity = useChrome ? 1.6 : useCarPaint ? 0.85 : 1.0;
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

// ── PREMIUM PART MATERIAL CALIBRATION ────────────────────────────────────────
// Shell, Side/Top Screws, Facemask, decals, and bumper logos keep their existing
// user-selectable finish systems. The remaining physical parts get distinct PBR
// personalities so rubber, metal, foam, straps, molded plastic, and visor no longer
// read like the same generic glossy material.
const PREMIUM_PART_MATERIAL_PRESETS = [
  {
    parts: ['Bumpers'],
    props: { roughness:0.48, metalness:0.0, clearcoat:0.18, clearcoatRoughness:0.38, envMapIntensity:0.72, specularIntensity:0.42 }
  },
  {
    parts: ['Facemask Clips'],
    props: { roughness:0.34, metalness:0.02, clearcoat:0.36, clearcoatRoughness:0.20, envMapIntensity:0.88, specularIntensity:0.50 }
  },
  {
    parts: ['Facemask Clips Hardware'],
    props: { roughness:0.22, metalness:0.88, clearcoat:0.08, clearcoatRoughness:0.08, envMapIntensity:1.18, specularIntensity:1.0 }
  },
  {
    parts: ['Inner Pads'],
    props: { roughness:0.92, metalness:0.0, clearcoat:0.0, clearcoatRoughness:0.0, envMapIntensity:0.24, specularIntensity:0.22, sheen:0.18, sheenRoughness:0.94 }
  },
  {
    parts: ['Visor'],
    props: { roughness:0.10, metalness:0.02, clearcoat:1.0, clearcoatRoughness:0.045, envMapIntensity:1.15, specularIntensity:0.85, ior:1.48, transmission:0.06, thickness:0.018, opacity:0.56 }
  },
  {
    parts: ['Visor Clips'],
    props: { roughness:0.30, metalness:0.04, clearcoat:0.42, clearcoatRoughness:0.16, envMapIntensity:0.94, specularIntensity:0.55 }
  },
  {
    parts: ['Chin Guard - Inner'],
    props: { roughness:0.88, metalness:0.0, clearcoat:0.0, clearcoatRoughness:0.0, envMapIntensity:0.28, specularIntensity:0.24 }
  },
  {
    parts: ['Chin Guard - Outer'],
    props: { roughness:0.35, metalness:0.01, clearcoat:0.46, clearcoatRoughness:0.18, envMapIntensity:0.90, specularIntensity:0.52 }
  },
  {
    parts: ['Metal Parts'],
    props: { roughness:0.20, metalness:0.92, clearcoat:0.06, clearcoatRoughness:0.06, envMapIntensity:1.24, specularIntensity:1.0 }
  },
  {
    parts: ['Strap Clips - Lower', 'Strap Clips - Upper'],
    props: { roughness:0.38, metalness:0.03, clearcoat:0.28, clearcoatRoughness:0.22, envMapIntensity:0.82, specularIntensity:0.46 }
  },
  {
    parts: ['Straps'],
    props: { roughness:0.70, metalness:0.0, clearcoat:0.06, clearcoatRoughness:0.45, envMapIntensity:0.46, specularIntensity:0.30, sheen:0.12, sheenRoughness:0.88 }
  },
];

function applyPremiumPartMaterialCalibration(partsMap) {
  PREMIUM_PART_MATERIAL_PRESETS.forEach(({ parts, props }) => {
    parts.forEach(partName => {
      const mats = partsMap[partKey(partName)] || [];
      mats.forEach(mat => {
        // Let scene.environment drive IBL consistently. Dedicated Chrome/Car Paint
        // materials still route their own env maps through their finish systems.
        mat.envMap = null;

        Object.entries(props).forEach(([key, value]) => {
          if (key in mat) mat[key] = value;
        });

        if (partKey(partName) === partKey('Visor')) {
          mat.transparent = true;
          mat.side = THREE.DoubleSide;
        }

        mat.needsUpdate = true;
      });
    });
  });
}

function applyStripeBumperStencilMask(partsMap, stripeMaterials) {
  // The optimized GLB can change the exact proximity between the baked Decal Surface
  // and the real bumper mesh by tiny amounts. Relying only on physical depth therefore
  // risks the raised stripe carrier poking through the bumper again.
  //
  // Use the actual visible Bumpers as a stencil mask instead: wherever a bumper fragment
  // is visible, the stripe shader is forbidden from drawing. This keeps the masking tied
  // to the production bumper geometry and remains correct from every camera angle.
  const bumperMaterials = partsMap[partKey('Bumpers')] || [];

  bumperMaterials.forEach(mat => {
    mat.stencilWrite = true;
    mat.stencilWriteMask = 0xff;
    mat.stencilFunc = THREE.AlwaysStencilFunc;
    mat.stencilRef = 1;
    mat.stencilFuncMask = 0xff;
    mat.stencilFail = THREE.KeepStencilOp;
    mat.stencilZFail = THREE.KeepStencilOp;
    mat.stencilZPass = THREE.ReplaceStencilOp;
    mat.needsUpdate = true;
  });

  stripeMaterials.forEach(mat => {
    if (!mat) return;
    // Enable stencil testing, but never modify the stencil buffer from the stripe pass.
    mat.stencilWrite = true;
    mat.stencilWriteMask = 0x00;
    mat.stencilFunc = THREE.NotEqualStencilFunc;
    mat.stencilRef = 1;
    mat.stencilFuncMask = 0xff;
    mat.stencilFail = THREE.KeepStencilOp;
    mat.stencilZFail = THREE.KeepStencilOp;
    mat.stencilZPass = THREE.KeepStencilOp;
    mat.needsUpdate = true;
  });
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
// `intensity` (0–1, Glitter slider) controls flake density; `flakeSize` (0–1)
// controls the average speck size; `colorHex` is the chosen Sparkle Color.
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return { r: 255, g: 255, b: 255 };
  const int = parseInt(m[1], 16);
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

function createFlakeTextures(intensity, flakeSize, colorHex) {
  // A much larger, asymmetrically repeated field avoids the obvious 16×16 tiled grid
  // that appeared at medium/high glitter density.
  const size = 1024;
  const ormCanvas = document.createElement('canvas');
  ormCanvas.width = size; ormCanvas.height = size;
  const ormCtx = ormCanvas.getContext('2d');
  const baseAO     = 35;
  const baseRough  = 178;
  const baseMetal  = 25;
  ormCtx.fillStyle = `rgb(${baseAO},${baseRough},${baseMetal})`;
  ormCtx.fillRect(0, 0, size, size);

  const colorCanvas = document.createElement('canvas');
  colorCanvas.width = size; colorCanvas.height = size;
  const colorCtx = colorCanvas.getContext('2d');
  colorCtx.fillStyle = 'rgb(0,0,0)';
  colorCtx.fillRect(0, 0, size, size);

  const { r, g, b } = hexToRgb(colorHex);
  // Keep the current look near the default mid setting, but allow much smaller
  // Raiders-style fine metallic flecks when the user drags the new Size slider down.
  const sizeBias = THREE.MathUtils.clamp(flakeSize ?? 0.55, 0, 1);
  const minMajor = 0.25 + sizeBias * 1.00;
  const maxMajor = 1.10 + sizeBias * 3.70;
  const flakeCount = Math.round(intensity * 5200);
  for (let i = 0; i < flakeCount; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const major = minMajor + Math.random() * (maxMajor - minMajor);
    const minor = major * (0.28 + Math.random() * 0.62);
    const angle = Math.random() * Math.PI;

    const flakeAO     = Math.round(225 + Math.random() * 30);
    const flakeRough  = Math.round(3 + Math.random() * 22);
    const flakeMetal  = Math.round(225 + Math.random() * 30);
    ormCtx.save();
    ormCtx.translate(x, y);
    ormCtx.rotate(angle);
    ormCtx.fillStyle = `rgb(${flakeAO},${flakeRough},${flakeMetal})`;
    ormCtx.beginPath();
    ormCtx.ellipse(0, 0, major, minor, 0, 0, Math.PI * 2);
    ormCtx.fill();
    ormCtx.restore();

    const jitter = 0.55 + Math.random() * 0.45;
    colorCtx.save();
    colorCtx.translate(x, y);
    colorCtx.rotate(angle);
    colorCtx.fillStyle = `rgb(${Math.round(r * jitter)},${Math.round(g * jitter)},${Math.round(b * jitter)})`;
    colorCtx.beginPath();
    colorCtx.ellipse(0, 0, major, minor, 0, 0, Math.PI * 2);
    colorCtx.fill();
    colorCtx.restore();
  }

  // Non-square repeat counts + a rotated texture break up aligned repetition bands.
  const repeatX = 4.15;
  const repeatY = 3.55;
  const rotation = 0.37;

  const ormTex = new THREE.CanvasTexture(ormCanvas);
  ormTex.wrapS = ormTex.wrapT = THREE.RepeatWrapping;
  ormTex.repeat.set(repeatX, repeatY);
  ormTex.center.set(0.5, 0.5);
  ormTex.rotation = rotation;
  ormTex.anisotropy = 8;
  ormTex.needsUpdate = true;

  const colorTex = new THREE.CanvasTexture(colorCanvas);
  colorTex.wrapS = colorTex.wrapT = THREE.RepeatWrapping;
  colorTex.repeat.set(repeatX, repeatY);
  colorTex.center.set(0.5, 0.5);
  colorTex.rotation = rotation;
  colorTex.anisotropy = 8;
  colorTex.colorSpace = THREE.SRGBColorSpace;
  colorTex.needsUpdate = true;

  return { ormTex, colorTex };
}


function createSatinMicroTexture() {
  // Fine high-frequency grain for metallic/satin paint. A larger random field plus
  // asymmetric repeat/rotation makes it read as paint texture rather than a tiled image.
  const size = 768;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(size, size);
  const data = image.data;

  for (let i = 0; i < data.length; i += 4) {
    // Keep values fairly bright so the map modulates metalness subtly rather than
    // creating obvious black/white noise.
    const fine = 178 + Math.random() * 72;
    const occasional = Math.random() < 0.035 ? 18 + Math.random() * 35 : 0;
    const value = Math.min(255, fine + occasional);
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
    data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(7.35, 6.10);
  tex.center.set(0.5, 0.5);
  tex.rotation = 0.23;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}


function createCarbonFiberWeaveTexture() {
  // A subtle 2x2 twill weave encoded as a linear texture that can be sampled through
  // the shell's triplanar finish projection. The green channel modulates roughness,
  // the blue channel modulates metalness, letting the weave appear in reflections
  // while preserving the user's chosen shell color.
  const size = 512;
  const cell = 24;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(size, size);
  const data = image.data;

  const fract = (v) => v - Math.floor(v);
  const smooth = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = Math.floor(x / cell);
      const cy = Math.floor(y / cell);
      const u = fract(x / cell);
      const v = fract(y / cell);

      // Alternate the diagonal direction per checker cell to mimic woven twill.
      const parity = (cx + cy) & 1;
      const diag = parity === 0 ? (u + v) * 0.5 : (u + (1 - v)) * 0.5;
      const ridge = 1.0 - smooth(0.18, 0.50, Math.abs(diag - 0.50));

      // Add a subtle fiber-strand modulation along the ribbon direction so it doesn't
      // read as a flat checkerboard.
      const strand = parity === 0 ? fract((u - v + 1) * 5.0) : fract((u + v) * 5.0);
      const strandPulse = 0.72 + 0.28 * Math.sin(strand * Math.PI * 2.0);

      const weave = Math.min(1, ridge * strandPulse);

      // Base channels:
      // G = roughness multiplier, B = metalness multiplier
      const roughVal = Math.round(132 + weave * 78); // 132..210
      const metalVal = Math.round(118 + weave * 112); // 118..230

      const idx = (y * size + x) * 4;
      data[idx + 0] = 255;
      data[idx + 1] = roughVal;
      data[idx + 2] = metalVal;
      data[idx + 3] = 255;
    }
  }

  ctx.putImageData(image, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(20.0, 20.0);
  tex.center.set(0.5, 0.5);
  tex.rotation = Math.PI * 0.25;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}


function installShellFinishTriplanar(material) {
  if (!material || material.userData?.shellFinishTriplanarInstalled) return;
  material.userData.shellFinishTriplanarInstalled = true;

  const projectionScaleUniform = { value: 1.1 };
  material.userData.shellFinishProjectionScaleUniform = projectionScaleUniform;

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uShellFinishProjectionScale = projectionScaleUniform;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vShellFinishWorldPosition;
varying vec3 vShellFinishWorldNormal;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vShellFinishWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;
vShellFinishWorldNormal = normalize(mat3(modelMatrix) * normal);`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vShellFinishWorldPosition;
varying vec3 vShellFinishWorldNormal;
uniform float uShellFinishProjectionScale;

vec4 sampleShellFinishTriplanar(sampler2D tex, vec3 wp, vec3 wn, float scale) {
  vec3 n = abs(normalize(wn));
  n = pow(n, vec3(4.0));
  n /= max(n.x + n.y + n.z, 0.0001);

  vec2 uvX = wp.zy * scale;
  vec2 uvY = wp.xz * scale;
  vec2 uvZ = wp.xy * scale;

  vec4 sampleX = texture2D(tex, uvX);
  vec4 sampleY = texture2D(tex, uvY);
  vec4 sampleZ = texture2D(tex, uvZ);
  return sampleX * n.x + sampleY * n.y + sampleZ * n.z;
}`
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `float roughnessFactor = roughness;
#ifdef USE_ROUGHNESSMAP
  vec4 texelRoughness = sampleShellFinishTriplanar(roughnessMap, vShellFinishWorldPosition, vShellFinishWorldNormal, uShellFinishProjectionScale);
  roughnessFactor *= texelRoughness.g;
#endif`
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `float metalnessFactor = metalness;
#ifdef USE_METALNESSMAP
  vec4 texelMetalness = sampleShellFinishTriplanar(metalnessMap, vShellFinishWorldPosition, vShellFinishWorldNormal, uShellFinishProjectionScale);
  metalnessFactor *= texelMetalness.b;
#endif`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#ifdef USE_EMISSIVEMAP
  vec4 emissiveColor = sampleShellFinishTriplanar(emissiveMap, vShellFinishWorldPosition, vShellFinishWorldNormal, uShellFinishProjectionScale);
  totalEmissiveRadiance *= emissiveColor.rgb;
#endif`
      );
  };

  material.customProgramCacheKey = () => 'helmet-shell-finish-triplanar-v1';
  material.needsUpdate = true;
}

// ── COLOR SWATCH ──────────────────────────────────────────────────────────────
function SectionLabel({ children }) {
  return <div style={{ fontSize:9, fontWeight:700, color:"#6b7280", letterSpacing:"0.1em", fontFamily:"'Barlow Condensed',sans-serif", marginBottom:10, marginTop:4 }}>{children}</div>;
}

function CollapsibleSection({ title, children, defaultOpen = false }) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <div style={{ borderBottom:'1px solid rgba(255,255,255,0.06)', paddingBottom:8, marginBottom:8 }}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        style={{
          width:'100%', display:'flex', alignItems:'center', justifyContent:'space-between',
          background:'none', border:'none', padding:'7px 0 8px', cursor:'pointer',
          color:open?'#d1d5db':'#9ca3af', fontSize:10, fontWeight:800,
          fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:'0.09em', textAlign:'left'
        }}
      >
        <span>{title}</span>
        <span style={{ color:'#efff00', fontSize:15, fontWeight:500, lineHeight:1 }}>{open ? '−' : '+'}</span>
      </button>
      {open && <div style={{ paddingBottom:6 }}>{children}</div>}
    </div>
  );
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
  const decalSurfaceObjectsRef = useRef([]); // hidden Decal Surface carrier mesh(es)
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
  const stripeCarrierOverlayMeshesRef = useRef([]);
  const stripeCarrierOverlayMaterialsRef = useRef([]);
  const bumperLogoMeshesRef      = useRef([]);
  const bumperLogoMaterialsRef   = useRef([]);
  const bumperLogoTexturesRef    = useRef([]);
  const bumperLogoPackCacheRef   = useRef({ front:null, rear:null });
  const bumperSliderTimersRef    = useRef({});
  const bumperSliderPendingRef   = useRef({});
  const bumperLogoFrontImageRef  = useRef(null);
  const bumperLogoRearImageRef   = useRef(null);
  const bumperLogoFrontObjectUrlRef = useRef(null);
  const bumperLogoRearObjectUrlRef  = useRef(null);
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
  const sideLogoUndoStackRef = useRef([]);
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
    startPlacements:null,
    changed:false,
  });

  const rearStickerMeshesRef = useRef([]);
  const rearStickerMaterialsRef = useRef([]);
  const rearStickerPackCacheRef = useRef({ flag:null, warning:null, custom:null });
  const rearStickerMainMaterialsRef = useRef({ flag:null, warning:null, custom:null });
  const rearFlagImageRef = useRef(null);
  const rearWarningImageRef = useRef(null);
  const rearCustomImageRef = useRef(null);
  const rearCustomObjectUrlRef = useRef(null);

  // Direct-manipulation state shared by rear stickers + bumper logos.
  // Placements live in refs while dragging so React state does not interrupt pointer capture.
  const editableDecalPlacementRef = useRef({
    'rear-flag':    { scale:2.70, rotation:0, across:-62, vertical:-38 },
    'rear-warning': { scale:2.70, rotation:0, across: 58, vertical:-38 },
    'rear-custom':  { scale:5.40, rotation:0, across:  0, vertical:20 },
    'bumper-front': { scale:6.6,  rotation:0, across:  0, vertical:0 },
    'bumper-rear':  { scale:5.35, rotation:0, across:  0, vertical:-30 },
  });
  const editableDecalWorldFrameRef = useRef({});
  const selectedEditableDecalRef = useRef(null);
  const editableDecalLockRef = useRef({
    'rear-flag':false,
    'rear-warning':false,
    'rear-custom':false,
    'bumper-front':false,
    'bumper-rear':false,
  });
  const editableDecalUndoStacksRef = useRef({
    'rear-flag':[],
    'rear-warning':[],
    'rear-custom':[],
    'bumper-front':[],
    'bumper-rear':[],
  });
  const editableDecalInteractionRef = useRef({
    dragging:false,
    pointerId:null,
    id:null,
    action:null,
    startPlacement:null,
    startDistance:1,
    startAngle:0,
    centerClient:null,
    changed:false,
  });

  // Shared shader-uniform objects for Shell stripe decals. The renderer keeps references
  // to these objects across material recompiles (wrap on/off, finish changes, etc.).
  // Stripe-only uniforms. These render on the baked Decal Surface so the stripe
  // bridges crown hardware/cutouts while still following the true shell curvature.
  const stripeUniformsRef = useRef({
    enabled:         { value: 0 },
    baseEnabled:     { value: 0 },
    widthScale:      { value: 1 },
    length:          { value: 1 },
    centerX:         { value: 0 },
    preset:          { value: 1 },
    leftColor:       { value: new THREE.Color('#efff00') },
    centerColor:     { value: new THREE.Color('#fcfcfc') },
    rightColor:      { value: new THREE.Color('#efff00') },
    pipingColor:     { value: new THREE.Color('#151515') },
    designEnabled:   { value: 0 },
    designMap:       { value: null },
    wrapEnabled:     { value: 0 },
    wrapMap:         { value: null },
  });

  // Wrap-only overlay for the real Shell. Keeping this separate prevents the stripe
  // from being drawn twice now that stripes have their own carrier-surface layer.
  const shellWrapUniformsRef = useRef({
    enabled:         { value: 0 },
    baseEnabled:     { value: 0 },
    widthScale:      { value: 1 },
    length:          { value: 1 },
    centerX:         { value: 0 },
    preset:          { value: 1 },
    leftColor:       { value: new THREE.Color('#ffffff') },
    centerColor:     { value: new THREE.Color('#ffffff') },
    rightColor:      { value: new THREE.Color('#ffffff') },
    pipingColor:     { value: new THREE.Color('#ffffff') },
    designEnabled:   { value: 0 },
    designMap:       { value: null },
    wrapEnabled:     { value: 0 },
    wrapMap:         { value: null },
  });

  const [activeTab, setActiveTab]     = useState('colors');
  const [colors, setColors]           = useState(() => Object.fromEntries(ZONES.map(z => [z.id, z.defaultColor])));
  const [finish, setFinish]           = useState('gloss');
  const [loaded, setLoaded]           = useState(false);
  const [debugMode, setDebugMode]     = useState(false);
  const [debugStats, setDebugStats]   = useState({
    fps:0,
    drawCalls:0,
    visibleTriangles:0,
    geometries:0,
    textures:0,
    programs:0,
    cssSize:'—',
    bufferSize:'—',
    dpr:1,
    modelMeshes:0,
    modelTriangles:0,
    modelVertices:0,
    glbBytesLoaded:0,
    glbBytesTotal:0,
    glbDownloadMs:null,
    glbParseMs:null,
    builderSetupMs:null,
    interactiveMs:null,
    firstRenderMs:null,
    hdriDownloadMs:null,
    hdriDecodeMs:null,
    hdriPmremMs:null,
    hdriReadyMs:null,
    hdriBytesLoaded:0,
    hdriBytesTotal:0,
    hdriCacheHit:false,
    hdriName:'—',
    exportRequestedResolution:0,
    exportRequestedSupersample:0,
    exportActualSupersample:0,
    exportFinalSize:'—',
    exportRenderSize:'—',
    exportMaxTextureSize:0,
    exportMaxRenderbufferSize:0,
    exportSafeDimension:0,
    exportRenderMs:null,
    exportDownsampleMs:null,
    exportEncodeMs:null,
    exportTotalMs:null,
    exportWasReduced:false,
  });
  const debugTimingRef = useRef({
    componentStart: typeof performance !== 'undefined' ? performance.now() : 0,
    glbStart:null,
    glbDownloadDone:null,
    glbOnLoad:null,
    modelSetupDone:null,
    firstRenderAt:null,
    hdriStart:null,
    hdriDownloadDone:null,
  });
  const debugFrameRef = useRef({
    frames:0,
    lastSampleAt: typeof performance !== 'undefined' ? performance.now() : 0,
  });
  const debugStaticRef = useRef({
    modelMeshes:0,
    modelTriangles:0,
    modelVertices:0,
    glbBytesLoaded:0,
    glbBytesTotal:0,
    glbDownloadMs:null,
    glbParseMs:null,
    builderSetupMs:null,
    interactiveMs:null,
    firstRenderMs:null,
    hdriDownloadMs:null,
    hdriDecodeMs:null,
    hdriPmremMs:null,
    hdriReadyMs:null,
    hdriBytesLoaded:0,
    hdriBytesTotal:0,
    hdriCacheHit:false,
    hdriName:'—',
    exportRequestedResolution:0,
    exportRequestedSupersample:0,
    exportActualSupersample:0,
    exportFinalSize:'—',
    exportRenderSize:'—',
    exportMaxTextureSize:0,
    exportMaxRenderbufferSize:0,
    exportSafeDimension:0,
    exportRenderMs:null,
    exportDownsampleMs:null,
    exportEncodeMs:null,
    exportTotalMs:null,
    exportWasReduced:false,
  });
  const [showProductMenu, setShowProductMenu] = useState(false);
  const [showTipsModal, setShowTipsModal]     = useState(false);
  const [showShadows, setShowShadows]         = useState(true);
  const [shadowOpacity, setShadowOpacity]     = useState(0.35);
  const [shadowSoftness, setShadowSoftness]   = useState(0.45);
  const [sparkleRotating, setSparkleRotating] = useState(true);
  const sparkleRotatingRef = useRef(sparkleRotating);
  useEffect(() => { sparkleRotatingRef.current = sparkleRotating; }, [sparkleRotating]);
  const [exporting, setExporting]             = useState(false);
  const [exported, setExported]               = useState(false);
  const [exportNotice, setExportNotice]       = useState('');
  const [exportError, setExportError]         = useState('');
  const [exportResolution, setExportResolution] = useState(2048);
  const [exportSupersample, setExportSupersample] = useState(2);

  useEffect(() => {
    // With the production 8192px internal-edge ceiling, 3x can be honored at
    // 1500px and 2048px, but not at 3000px or 4096px. Keep the UI truthful
    // instead of letting users select "3x Ultra" only to silently receive 2x.
    if (exportResolution > 2048 && exportSupersample > 2) {
      setExportSupersample(2);
      setExportNotice('');
    }
  }, [exportResolution, exportSupersample]);
  const [viewportBgColor, setViewportBgColor] = useState('#1f1c1e');
  const [rimLightColor, setRimLightColor]     = useState('#ffffff');
  const [hdriPreset, setHdriPreset]           = useState('studio01');
  const [hdriIntensity, setHdriIntensity]     = useState(0.75);
  const [sceneExposure, setSceneExposure]     = useState(1.4);
  const [studioLightStrength, setStudioLightStrength] = useState(1.0);
  const [hdriLoading, setHdriLoading]         = useState(false);
  const [hdriError, setHdriError]             = useState('');
  const hdriCacheRef                          = useRef(new Map());
  const hdriLoadTokenRef                      = useRef(0);
  const [transparentBg, setTransparentBg]     = useState(false);
  const [visorOn, setVisorOn]               = useState(true);
  const [glitter, setGlitter]               = useState(0.3);
  const [glitterSize, setGlitterSize]       = useState(0.55);
  const [glitterColor, setGlitterColor]     = useState('#ffffff');
  const [satinMetallic, setSatinMetallic]   = useState(0.62);
  const [satinTexture, setSatinTexture]     = useState(0.45);
  const [carbonFiberSize, setCarbonFiberSize] = useState(1.0);
  const satinMicroTextureRef                = useRef(null);
  const carbonWeaveTextureRef               = useRef(null);
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
  const [helmetStripePreset, setHelmetStripePreset]     = useState('threeEqual');
  const [helmetStripeWidth, setHelmetStripeWidth]       = useState(2);
  const [helmetStripeLength, setHelmetStripeLength]     = useState(1);
  const [helmetStripeSingleColor, setHelmetStripeSingleColor] = useState('#efff00');
  const [helmetStripeOuterColor, setHelmetStripeOuterColor]   = useState('#efff00');
  const [helmetStripeCenterColor, setHelmetStripeCenterColor] = useState('#fcfcfc');
  const [helmetStripePipingColor, setHelmetStripePipingColor] = useState('#151515');
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
  const [sideLogoUndoCount, setSideLogoUndoCount] = useState(0);

  const [rearFlagEnabled, setRearFlagEnabled] = useState(false);
  const [rearFlagScale, setRearFlagScale] = useState(2.70);
  const [rearFlagRotation, setRearFlagRotation] = useState(0);
  const [rearFlagAcross, setRearFlagAcross] = useState(-62);
  const [rearFlagVertical, setRearFlagVertical] = useState(-38);

  const [rearWarningEnabled, setRearWarningEnabled] = useState(false);
  const [rearWarningColor, setRearWarningColor] = useState('#FFFFFF');
  const [rearWarningScale, setRearWarningScale] = useState(2.70);
  const [rearWarningRotation, setRearWarningRotation] = useState(0);
  const [rearWarningAcross, setRearWarningAcross] = useState(58);
  const [rearWarningVertical, setRearWarningVertical] = useState(-38);

  const [rearCustomEnabled, setRearCustomEnabled] = useState(false);
  const [rearCustomPreviewUrl, setRearCustomPreviewUrl] = useState(null);
  const [rearCustomFileName, setRearCustomFileName] = useState('');
  const [rearCustomScale, setRearCustomScale] = useState(5.40);
  const [rearCustomRotation, setRearCustomRotation] = useState(0);
  const [rearCustomAcross, setRearCustomAcross] = useState(0);
  const [rearCustomVertical, setRearCustomVertical] = useState(20);
  const [rearStickerError, setRearStickerError] = useState('');
  const [rearStickerRevision, setRearStickerRevision] = useState(0);

  const [selectedEditableDecal, setSelectedEditableDecal] = useState(null);
  const [rearFlagLocked, setRearFlagLocked] = useState(false);
  const [rearWarningLocked, setRearWarningLocked] = useState(false);
  const [rearCustomLocked, setRearCustomLocked] = useState(false);
  const [bumperLogoFrontLocked, setBumperLogoFrontLocked] = useState(false);
  const [bumperLogoRearLocked, setBumperLogoRearLocked] = useState(false);
  const [editableDecalUndoCounts, setEditableDecalUndoCounts] = useState({
    'rear-flag':0,
    'rear-warning':0,
    'rear-custom':0,
    'bumper-front':0,
    'bumper-rear':0,
  });
  const [editableDecalRevision, setEditableDecalRevision] = useState(0);

  const [bumperLogoError, setBumperLogoError] = useState('');
  const [bumperLogoFrontPreviewUrl, setBumperLogoFrontPreviewUrl] = useState(null);
  const [bumperLogoRearPreviewUrl, setBumperLogoRearPreviewUrl] = useState(null);
  const [bumperLogoFrontFileName, setBumperLogoFrontFileName] = useState('');
  const [bumperLogoRearFileName, setBumperLogoRearFileName] = useState('');
  const [bumperLogoFrontScale, setBumperLogoFrontScale] = useState(6.6);
  const [bumperLogoRearScale, setBumperLogoRearScale] = useState(5.35);
  const [bumperLogoFrontRotation, setBumperLogoFrontRotation] = useState(0);
  const [bumperLogoRearRotation, setBumperLogoRearRotation] = useState(0);
  const [bumperLogoFrontAcross, setBumperLogoFrontAcross] = useState(0);
  const [bumperLogoRearAcross, setBumperLogoRearAcross] = useState(0);
  const [bumperLogoFrontVertical, setBumperLogoFrontVertical] = useState(0);
  const [bumperLogoRearVertical, setBumperLogoRearVertical] = useState(-30);
  const [bumperLogoRearCurve, setBumperLogoRearCurve] = useState(-135);
  const [bumperLogoRevision, setBumperLogoRevision] = useState(0);

  const finishRef = useRef(finish);
  useEffect(() => { finishRef.current = finish; }, [finish]);
  const facemaskFinishRef = useRef(facemaskFinish);
  useEffect(() => { facemaskFinishRef.current = facemaskFinish; }, [facemaskFinish]);
  const decalFinishRef = useRef(decalFinish);
  useEffect(() => { decalFinishRef.current = decalFinish; }, [decalFinish]);
  const [bumperLogoFinish, setBumperLogoFinish] = useState('gloss');
  const bumperLogoFinishRef = useRef(bumperLogoFinish);
  useEffect(() => { bumperLogoFinishRef.current = bumperLogoFinish; }, [bumperLogoFinish]);

  useEffect(() => { editableDecalPlacementRef.current['rear-flag'] = { scale:rearFlagScale, rotation:rearFlagRotation, across:rearFlagAcross, vertical:rearFlagVertical }; }, [rearFlagScale, rearFlagRotation, rearFlagAcross, rearFlagVertical]);
  useEffect(() => { editableDecalPlacementRef.current['rear-warning'] = { scale:rearWarningScale, rotation:rearWarningRotation, across:rearWarningAcross, vertical:rearWarningVertical }; }, [rearWarningScale, rearWarningRotation, rearWarningAcross, rearWarningVertical]);
  useEffect(() => { editableDecalPlacementRef.current['rear-custom'] = { scale:rearCustomScale, rotation:rearCustomRotation, across:rearCustomAcross, vertical:rearCustomVertical }; }, [rearCustomScale, rearCustomRotation, rearCustomAcross, rearCustomVertical]);
  useEffect(() => { editableDecalPlacementRef.current['bumper-front'] = { scale:bumperLogoFrontScale, rotation:bumperLogoFrontRotation, across:bumperLogoFrontAcross, vertical:bumperLogoFrontVertical }; }, [bumperLogoFrontScale, bumperLogoFrontRotation, bumperLogoFrontAcross, bumperLogoFrontVertical]);
  useEffect(() => { editableDecalPlacementRef.current['bumper-rear'] = { scale:bumperLogoRearScale, rotation:bumperLogoRearRotation, across:bumperLogoRearAcross, vertical:bumperLogoRearVertical }; }, [bumperLogoRearScale, bumperLogoRearRotation, bumperLogoRearAcross, bumperLogoRearVertical]);

  useEffect(() => {
    editableDecalLockRef.current = {
      'rear-flag':rearFlagLocked,
      'rear-warning':rearWarningLocked,
      'rear-custom':rearCustomLocked,
      'bumper-front':bumperLogoFrontLocked,
      'bumper-rear':bumperLogoRearLocked,
    };
  }, [rearFlagLocked, rearWarningLocked, rearCustomLocked, bumperLogoFrontLocked, bumperLogoRearLocked]);

  const commitEditableDecalPlacement = useCallback((id, placement) => {
    if (!placement) return;
    const p = { ...placement };
    if (id === 'rear-flag') {
      setRearFlagScale(p.scale); setRearFlagRotation(p.rotation); setRearFlagAcross(p.across); setRearFlagVertical(p.vertical);
      setRearStickerRevision(v => v + 1);
    } else if (id === 'rear-warning') {
      setRearWarningScale(p.scale); setRearWarningRotation(p.rotation); setRearWarningAcross(p.across); setRearWarningVertical(p.vertical);
      setRearStickerRevision(v => v + 1);
    } else if (id === 'rear-custom') {
      setRearCustomScale(p.scale); setRearCustomRotation(p.rotation); setRearCustomAcross(p.across); setRearCustomVertical(p.vertical);
      setRearStickerRevision(v => v + 1);
    } else if (id === 'bumper-front') {
      setBumperLogoFrontScale(p.scale); setBumperLogoFrontRotation(p.rotation); setBumperLogoFrontAcross(p.across); setBumperLogoFrontVertical(p.vertical);
      setBumperLogoRevision(v => v + 1);
    } else if (id === 'bumper-rear') {
      setBumperLogoRearScale(p.scale); setBumperLogoRearRotation(p.rotation); setBumperLogoRearAcross(p.across); setBumperLogoRearVertical(p.vertical);
      setBumperLogoRevision(v => v + 1);
    }
    editableDecalPlacementRef.current[id] = p;
    setEditableDecalRevision(v => v + 1);
  }, []);

  const pushEditableDecalUndo = useCallback((id, placement) => {
    if (!id || !placement) return;
    const stack = editableDecalUndoStacksRef.current[id];
    if (!stack) return;
    stack.push({ ...placement });
    if (stack.length > 20) stack.shift();
    setEditableDecalUndoCounts(prev => ({ ...prev, [id]:stack.length }));
  }, []);

  const undoEditableDecalMove = useCallback((id) => {
    const stack = editableDecalUndoStacksRef.current[id];
    const previous = stack?.pop?.();
    if (!previous) return;
    editableDecalPlacementRef.current[id] = { ...previous };
    commitEditableDecalPlacement(id, previous);
    setEditableDecalUndoCounts(prev => ({ ...prev, [id]:stack.length }));
  }, [commitEditableDecalPlacement]);

  const clearEditableDecalUndo = useCallback((id) => {
    const stack = editableDecalUndoStacksRef.current[id];
    if (stack) stack.length = 0;
    setEditableDecalUndoCounts(prev => ({ ...prev, [id]:0 }));
  }, []);

  // ── AUTH + CREDITS (Clerk + Supabase) — mirrors /jersey ──
  const [credits, setCredits]             = useState(0);
  const [paidCredits, setPaidCredits]     = useState(0);
  const [isUnlimited, setIsUnlimited]     = useState(false);
  const [hasWatermark, setHasWatermark]   = useState(true);
  const [creditsLoaded, setCreditsLoaded] = useState(false);
  const [showUpgrade, setShowUpgrade]     = useState(false);
  const [selectedPlan, setSelectedPlan]   = useState(null);
  const [checkingOut, setCheckingOut]     = useState(false);

  const applyCreditState = useCallback((data) => {
    if (!data) return;
    setCredits(data.totalCredits || 0);
    setPaidCredits(data.paidCredits || 0);
    setIsUnlimited(data.isUnlimited || false);
    setHasWatermark(data.hasWatermark !== false);
  }, []);

  const refreshCredits = useCallback(async () => {
    const response = await fetch('/api/user/credits', { cache:'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error || 'Could not load credits');
    applyCreditState(data);
    return data;
  }, [applyCreditState]);

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      setCredits(0);
      setPaidCredits(0);
      setIsUnlimited(false);
      setHasWatermark(true);
      setCreditsLoaded(true);
      return;
    }

    let cancelled = false;
    refreshCredits()
      .catch(err => console.error('Credits fetch error:', err))
      .finally(() => { if (!cancelled) setCreditsLoaded(true); });

    return () => { cancelled = true; };
  }, [isLoaded, isSignedIn, refreshCredits]);

  useEffect(() => {
    if (typeof window === 'undefined' || !isSignedIn) return;

    const refreshOnFocus = () => {
      refreshCredits().catch(err => console.error('Credit refresh on focus:', err));
    };
    const refreshOnVisibility = () => {
      if (document.visibilityState === 'visible') refreshOnFocus();
    };

    window.addEventListener('focus', refreshOnFocus);
    document.addEventListener('visibilitychange', refreshOnVisibility);
    return () => {
      window.removeEventListener('focus', refreshOnFocus);
      document.removeEventListener('visibilitychange', refreshOnVisibility);
    };
  }, [isSignedIn, refreshCredits]);

  useEffect(() => {
    if (typeof window === 'undefined' || !isSignedIn) return;

    const url = new URL(window.location.href);
    const checkoutState = url.searchParams.get('checkout');
    const legacySuccess = url.searchParams.get('success') === 'true';
    const legacyCanceled = url.searchParams.get('canceled') === 'true';

    if (url.searchParams.get('upgrade') === 'true') {
      setShowUpgrade(true);
      url.searchParams.delete('upgrade');
    }

    if (checkoutState === 'canceled' || legacyCanceled) {
      url.searchParams.delete('checkout');
      url.searchParams.delete('canceled');
      url.searchParams.delete('session_id');
      window.history.replaceState({}, '', `${url.pathname}${url.search}`);
      return;
    }

    if (checkoutState !== 'success' && !legacySuccess) {
      if (url.href !== window.location.href) {
        window.history.replaceState({}, '', `${url.pathname}${url.search}`);
      }
      return;
    }

    // Stripe redirects back immediately; the verified webhook can finish a moment
    // later. Refresh several times so paid credits / Unlimited appears without a
    // manual reload even when the webhook and browser return race each other.
    let cancelled = false;
    let attempts = 0;
    let timer = null;

    const poll = async () => {
      if (cancelled) return;
      attempts += 1;
      try { await refreshCredits(); } catch (err) { console.error('Post-checkout credit refresh:', err); }
      if (!cancelled && attempts < 10) timer = window.setTimeout(poll, 600);
    };

    poll();

    url.searchParams.delete('checkout');
    url.searchParams.delete('success');
    url.searchParams.delete('session_id');
    window.history.replaceState({}, '', `${url.pathname}${url.search}`);

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [isSignedIn, refreshCredits]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Read the debug flag from the full browser URL rather than relying on the
    // first value of window.location.search during hydration. Some production
    // routing/auth layers can update the URL around the time this client
    // component mounts.
    const syncDebugFromLocation = () => {
      try {
        const url = new URL(window.location.href);
        if (url.searchParams.get('debug') === '1') {
          setDebugMode(true);
          window.sessionStorage.setItem('helmetBuilderDebug', '1');
          return true;
        }
      } catch {}

      if (window.sessionStorage.getItem('helmetBuilderDebug') === '1') {
        setDebugMode(true);
        return true;
      }

      return false;
    };

    syncDebugFromLocation();

    // Re-check after hydration/navigation settles. Once enabled, debug mode is
    // intentionally latched for the current tab via sessionStorage.
    const retryTimers = [
      window.setTimeout(syncDebugFromLocation, 0),
      window.setTimeout(syncDebugFromLocation, 250),
      window.setTimeout(syncDebugFromLocation, 1000),
    ];

    const onKeyDown = (event) => {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        setDebugMode(current => {
          const next = !current;
          if (next) window.sessionStorage.setItem('helmetBuilderDebug', '1');
          else window.sessionStorage.removeItem('helmetBuilderDebug');
          return next;
        });
      }
    };

    window.addEventListener('pageshow', syncDebugFromLocation);
    window.addEventListener('popstate', syncDebugFromLocation);
    window.addEventListener('keydown', onKeyDown);

    return () => {
      retryTimers.forEach(window.clearTimeout);
      window.removeEventListener('pageshow', syncDebugFromLocation);
      window.removeEventListener('popstate', syncDebugFromLocation);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  useEffect(() => {
    if (!debugMode) return;

    debugFrameRef.current.frames = 0;
    debugFrameRef.current.lastSampleAt = performance.now();

    const sample = () => {
      const renderer = rendererRef.current;
      if (!renderer) return;

      const now = performance.now();
      const deltaMs = Math.max(1, now - debugFrameRef.current.lastSampleAt);
      const fps = debugFrameRef.current.frames * 1000 / deltaMs;
      debugFrameRef.current.frames = 0;
      debugFrameRef.current.lastSampleAt = now;

      const canvas = renderer.domElement;
      const size = renderer.getSize(new THREE.Vector2());
      const info = renderer.info;

      setDebugStats({
        fps,
        drawCalls: info.render.calls || 0,
        visibleTriangles: info.render.triangles || 0,
        geometries: info.memory.geometries || 0,
        textures: info.memory.textures || 0,
        programs: Array.isArray(info.programs) ? info.programs.length : 0,
        cssSize: `${Math.round(size.x)}×${Math.round(size.y)}`,
        bufferSize: `${canvas.width}×${canvas.height}`,
        dpr: renderer.getPixelRatio(),
        ...debugStaticRef.current,
      });
    };

    sample();
    const interval = window.setInterval(sample, 750);
    return () => window.clearInterval(interval);
  }, [debugMode, loaded, hdriPreset]);

  const copyDebugReport = useCallback(async () => {
    const s = debugStats;
    const report = [
      'ProLine Helmet Builder Debug Report',
      `URL: ${typeof window !== 'undefined' ? window.location.href : ''}`,
      `User agent: ${typeof navigator !== 'undefined' ? navigator.userAgent : ''}`,
      '',
      `FPS: ${Number(s.fps || 0).toFixed(1)}`,
      `Draw calls: ${s.drawCalls}`,
      `Visible triangles: ${s.visibleTriangles}`,
      `Renderer geometries: ${s.geometries}`,
      `Renderer textures: ${s.textures}`,
      `Shader programs: ${s.programs}`,
      `CSS viewport: ${s.cssSize}`,
      `Render buffer: ${s.bufferSize}`,
      `DPR: ${s.dpr}`,
      '',
      `Base GLB meshes: ${s.modelMeshes}`,
      `Base GLB triangles: ${s.modelTriangles}`,
      `Base GLB vertices: ${s.modelVertices}`,
      `GLB transfer: ${formatDebugBytes(s.glbBytesTotal || s.glbBytesLoaded)}`,
      `GLB download: ${formatDebugMs(s.glbDownloadMs)}`,
      `GLB parse: ${formatDebugMs(s.glbParseMs)}`,
      `Builder setup: ${formatDebugMs(s.builderSetupMs)}`,
      `Interactive: ${formatDebugMs(s.interactiveMs)}`,
      `First rendered helmet: ${formatDebugMs(s.firstRenderMs)}`,
      '',
      `HDRI: ${s.hdriName}${s.hdriCacheHit ? ' (cached)' : ''}`,
      `HDRI transfer: ${formatDebugBytes(s.hdriBytesTotal || s.hdriBytesLoaded)}`,
      `HDRI download: ${formatDebugMs(s.hdriDownloadMs)}`,
      `HDRI decode: ${formatDebugMs(s.hdriDecodeMs)}`,
      `HDRI PMREM: ${formatDebugMs(s.hdriPmremMs)}`,
      `HDRI ready: ${formatDebugMs(s.hdriReadyMs)}`,
      '',
      'Last Export',
      `Requested: ${s.exportRequestedResolution || '—'} px @ ${s.exportRequestedSupersample || '—'}×`,
      `Actual supersample: ${s.exportActualSupersample || '—'}×${s.exportWasReduced ? ' (auto-reduced)' : ''}`,
      `Final PNG: ${s.exportFinalSize}`,
      `Internal render: ${s.exportRenderSize}`,
      `GPU MAX_TEXTURE_SIZE: ${formatDebugCount(s.exportMaxTextureSize)}`,
      `GPU MAX_RENDERBUFFER_SIZE: ${formatDebugCount(s.exportMaxRenderbufferSize)}`,
      `Safe internal edge: ${formatDebugCount(s.exportSafeDimension)}`,
      `Render: ${formatDebugMs(s.exportRenderMs)}`,
      `Downsample: ${formatDebugMs(s.exportDownsampleMs)}`,
      `PNG encode: ${formatDebugMs(s.exportEncodeMs)}`,
      `Capture total: ${formatDebugMs(s.exportTotalMs)}`,
    ].join('\n');

    try {
      await navigator.clipboard.writeText(report);
    } catch {
      console.log(report);
    }
  }, [debugStats]);

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

  const clearSideLogoUndoHistory = useCallback(() => {
    sideLogoUndoStackRef.current = [];
    setSideLogoUndoCount(0);
  }, []);

  const undoSideLogoMove = useCallback(() => {
    const previous = sideLogoUndoStackRef.current.pop();
    if (!previous) return;

    sideLogoPlacementRef.current.left = { ...previous.left };
    sideLogoPlacementRef.current.right = { ...previous.right };
    setSideLogoUndoCount(sideLogoUndoStackRef.current.length);
    setSideLogoRevision(v => v + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadPreset = (url, ref) => {
      const img = new Image();
      img.onload = () => {
        if (cancelled) return;
        ref.current = img;
        setRearStickerRevision(v => v + 1);
      };
      img.onerror = () => {
        if (!cancelled) {
          console.warn(`[HelmetBuilder] Rear sticker preset failed to load: ${url}`);
        }
      };
      img.src = url;
    };

    loadPreset(REAR_FLAG_URL, rearFlagImageRef);
    loadPreset(REAR_WARNING_URL, rearWarningImageRef);

    return () => { cancelled = true; };
  }, []);

  const handleRearCustomStickerUpload = useCallback((event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    const allowed = ['image/png', 'image/jpeg', 'image/webp'];
    if (!allowed.includes(file.type)) {
      setRearStickerError('Please upload a PNG, JPEG, or WebP rear sticker.');
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      if (rearCustomObjectUrlRef.current) {
        URL.revokeObjectURL(rearCustomObjectUrlRef.current);
      }

      rearCustomObjectUrlRef.current = objectUrl;
      rearCustomImageRef.current = img;
      setRearCustomPreviewUrl(objectUrl);
      setRearCustomFileName(file.name);
      setRearCustomEnabled(true);
      clearEditableDecalUndo('rear-custom');
      setRearStickerError('');
      setRearStickerRevision(v => v + 1);
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      setRearStickerError('That rear sticker could not be read. Please try another PNG, JPEG, or WebP.');
    };

    img.src = objectUrl;
  }, [clearEditableDecalUndo]);

  const removeRearCustomSticker = useCallback(() => {
    if (rearCustomObjectUrlRef.current) {
      URL.revokeObjectURL(rearCustomObjectUrlRef.current);
      rearCustomObjectUrlRef.current = null;
    }
    rearCustomImageRef.current = null;
    setRearCustomPreviewUrl(null);
    setRearCustomFileName('');
    setRearCustomEnabled(false);
    clearEditableDecalUndo('rear-custom');
    if (selectedEditableDecalRef.current === 'rear-custom') { selectedEditableDecalRef.current=null; setSelectedEditableDecal(null); }
    setRearStickerError('');
    setRearStickerRevision(v => v + 1);
  }, [clearEditableDecalUndo]);

  useEffect(() => () => {
    if (rearCustomObjectUrlRef.current) {
      URL.revokeObjectURL(rearCustomObjectUrlRef.current);
    }
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
      clearSideLogoUndoHistory();
      setSideLogoError('');
      setSideLogoRevision(v => v + 1);
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      setSideLogoError('That side logo file could not be read. Please try another PNG or JPEG.');
    };
    img.src = objectUrl;
  }, [clearSideLogoUndoHistory]);

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
    clearSideLogoUndoHistory();
    setSideLogoRevision(v => v + 1);
  }, [clearSideLogoUndoHistory]);

  useEffect(() => () => {
    [sideLogoSharedObjectUrlRef, sideLogoLeftObjectUrlRef, sideLogoRightObjectUrlRef].forEach(ref => {
      if (ref.current) URL.revokeObjectURL(ref.current);
    });
  }, []);

  const assignBumperLogoFile = useCallback((slot, file) => {
    if (!file) return;
    if (!['image/png', 'image/jpeg'].includes(file.type)) {
      setBumperLogoError('Please upload a PNG or JPEG for bumper logos.');
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const target = slot === 'front'
        ? { ref: bumperLogoFrontImageRef, urlRef: bumperLogoFrontObjectUrlRef, setPreview: setBumperLogoFrontPreviewUrl, setName: setBumperLogoFrontFileName }
        : { ref: bumperLogoRearImageRef, urlRef: bumperLogoRearObjectUrlRef, setPreview: setBumperLogoRearPreviewUrl, setName: setBumperLogoRearFileName };
      if (target.urlRef.current) URL.revokeObjectURL(target.urlRef.current);
      target.urlRef.current = objectUrl;
      target.ref.current = img;
      target.setPreview(objectUrl);
      target.setName(file.name);
      clearEditableDecalUndo(`bumper-${slot}`);
      setBumperLogoError('');
      setBumperLogoRevision(v => v + 1);
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      setBumperLogoError('That bumper logo could not be read. Please try another PNG or JPEG.');
    };
    img.src = objectUrl;
  }, [clearEditableDecalUndo]);

  const handleFrontBumperLogoUpload = useCallback((event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) assignBumperLogoFile('front', file);
  }, [assignBumperLogoFile]);

  const handleRearBumperLogoUpload = useCallback((event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) assignBumperLogoFile('rear', file);
  }, [assignBumperLogoFile]);

  const removeBumperLogo = useCallback((slot) => {
    const target = slot === 'front'
      ? { ref: bumperLogoFrontImageRef, urlRef: bumperLogoFrontObjectUrlRef, setPreview: setBumperLogoFrontPreviewUrl, setName: setBumperLogoFrontFileName }
      : { ref: bumperLogoRearImageRef, urlRef: bumperLogoRearObjectUrlRef, setPreview: setBumperLogoRearPreviewUrl, setName: setBumperLogoRearFileName };
    if (target.urlRef.current) {
      URL.revokeObjectURL(target.urlRef.current);
      target.urlRef.current = null;
    }
    target.ref.current = null;
    target.setPreview(null);
    target.setName('');
    clearEditableDecalUndo(`bumper-${slot}`);
    if (selectedEditableDecalRef.current === `bumper-${slot}`) { selectedEditableDecalRef.current=null; setSelectedEditableDecal(null); }
    setBumperLogoRevision(v => v + 1);
  }, [clearEditableDecalUndo]);

  useEffect(() => () => {
    [bumperLogoFrontObjectUrlRef, bumperLogoRearObjectUrlRef].forEach(ref => {
      if (ref.current) URL.revokeObjectURL(ref.current);
    });
    Object.values(bumperSliderTimersRef.current).forEach(timer => clearTimeout(timer));
  }, []);

  // DecalGeometry is significantly more expensive than the other controls. Keep the
  // browser's native range thumb fully smooth, but throttle geometry regeneration to
  // roughly 12 fps while dragging. The final value is always committed.
  const queueBumperSliderUpdate = useCallback((key, setter, value) => {
    bumperSliderPendingRef.current[key] = { setter, value };
    if (bumperSliderTimersRef.current[key]) return;

    const flush = () => {
      const pending = bumperSliderPendingRef.current[key];
      if (pending) {
        pending.setter(pending.value);
        delete bumperSliderPendingRef.current[key];
      }
      bumperSliderTimersRef.current[key] = null;
      if (bumperSliderPendingRef.current[key]) {
        bumperSliderTimersRef.current[key] = setTimeout(flush, 80);
      }
    };
    bumperSliderTimersRef.current[key] = setTimeout(flush, 0);
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

      // Keep the top view near-overhead rather than perfectly pole-on. OrbitControls
      // becomes unintuitive at the exact pole because azimuth loses meaning there.
      // A small forward offset preserves a clear "top" preset while letting the user
      // drag naturally into a custom angle afterwards.
      top:   { position: [0.0, 3.2, 0.42], up: [0, 1, 0] },

      // Side-forward hero angle: keep the premium 3/4 presentation but reveal more
      // of the helmet's side profile, closer to a traditional equipment beauty shot.
      hero:  { position: [-2.18, 0.92, 1.88], up: [0, 1, 0] },
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
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true, stencil: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(el.clientWidth, el.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = sceneExposure;
    renderer.physicallyCorrectLights = true;
    renderer.setClearColor(0x000000, 0);

    // Required by WebGLRenderer before RectAreaLight can be used.
    RectAreaLightUniformsLib.init();

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
    scene.userData.neutralEnvTexture = envRT.texture;
    scene.userData.neutralEnvRenderTarget = envRT;
    scene.environment = envRT.texture;
    scene.environmentIntensity = hdriIntensity;
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
          ...stripeCarrierOverlayMaterialsRef.current,
          ...sideLogoMaterialsRef.current.filter(mat => mat.userData?.sideLogoMainMaterial),
        ], scene, decalFinishRef.current);
        applyDecalFinishToMaterials([
          ...bumperLogoMaterialsRef.current.filter(mat => mat.userData?.bumperLogoMainMaterial),
        ], scene, bumperLogoFinishRef.current);
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

    // ── PREMIUM STUDIO LIGHTING RIG ───────────────────────────────────────────
    // HDRI supplies the overall image-based lighting/reflections. These large area
    // lights act like real photography softboxes, creating broad controlled highlights
    // across the shell instead of small point-like hotspots.
    const lightTarget = new THREE.Vector3(0, 0.08, 0);

    // Keep ambient low — the HDRI is now responsible for most global fill.
    const ambient = new THREE.AmbientLight(0xffffff, 0.14);
    scene.add(ambient);
    scene.userData.ambientLight = ambient;

    // Large front/key softbox.
    const keySoftbox = new THREE.RectAreaLight(0xffffff, 5.5, 4.2, 2.4);
    keySoftbox.position.set(3.15, 2.75, 3.35);
    keySoftbox.lookAt(lightTarget);
    scene.add(keySoftbox);
    scene.userData.keySoftbox = keySoftbox;

    // Opposite-side fill softbox, larger/softer and intentionally dimmer.
    const fillSoftbox = new THREE.RectAreaLight(0xffffff, 2.7, 3.2, 3.8);
    fillSoftbox.position.set(-3.05, 1.55, 1.65);
    fillSoftbox.lookAt(lightTarget);
    scene.add(fillSoftbox);
    scene.userData.fillSoftbox = fillSoftbox;

    // RectAreaLight does not cast shadows, so use a low-intensity neutral directional
    // light only to generate the contact/floor shadow. Existing shadow controls and
    // high-resolution export shadow maps continue to target this light via keyLight.
    const shadowLight = new THREE.DirectionalLight(0xffffff, 0.55);
    shadowLight.position.set(3.2, 5.0, 3.0);
    shadowLight.target.position.copy(lightTarget);
    scene.add(shadowLight.target);
    shadowLight.castShadow = true;
    shadowLight.shadow.mapSize.width = 2048;
    shadowLight.shadow.mapSize.height = 2048;
    shadowLight.shadow.camera.near = 0.1;
    shadowLight.shadow.camera.far = 20;
    shadowLight.shadow.camera.left = -3;
    shadowLight.shadow.camera.right = 3;
    shadowLight.shadow.camera.top = 3;
    shadowLight.shadow.camera.bottom = -3;
    shadowLight.shadow.radius = 0.5 + shadowSoftness * 11.5;
    scene.add(shadowLight);
    scene.userData.keyLight = shadowLight;
    scene.userData.shadowLight = shadowLight;

    // User-adjustable accent/rim light remains separate from the neutral studio rig.
    const rim = new THREE.DirectionalLight(0xffffff, 0.24);
    rim.position.set(0, -2, -3);
    scene.add(rim);
    scene.userData.rimLight = rim;
    // Shadow-catching floor
    const floorGeo = new THREE.PlaneGeometry(10, 10);
    const floorMat = new THREE.ShadowMaterial({ opacity: shadowOpacity });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.85;
    floor.receiveShadow = true;
    scene.add(floor);
    scene.userData.floor = floor;
    scene.userData.floorShadowMaterial = floorMat;

    // Optional back wall
    const wallGeo = new THREE.PlaneGeometry(10, 6);
    const wallMat = new THREE.ShadowMaterial({ opacity: shadowOpacity * 0.43 });
    const wall = new THREE.Mesh(wallGeo, wallMat);
    wall.position.set(0, 1.5, -2.5);
    wall.receiveShadow = true;
    scene.add(wall);
    scene.userData.wall = wall;
    scene.userData.wallShadowMaterial = wallMat;

    // Sparkle point light — close to helmet for flake catchlights
    const sparkleLight = new THREE.PointLight(0xffffff, 8.0, 8);
    sparkleLight.position.set(1, 1, 1);
    scene.add(sparkleLight);

    // Load GLB. The compressed production candidate uses
    // KHR_draco_mesh_compression, so GLTFLoader needs one DRACOLoader instance.
    // Decoder assets are intentionally self-hosted from /public/draco/ so the
    // builder has no runtime dependency on Google or another third-party CDN.
    const dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath(DRACO_DECODER_PATH);

    const loader = new GLTFLoader();
    loader.setDRACOLoader(dracoLoader);

    const glbLoadStartedAt = performance.now();
    debugTimingRef.current.glbStart = glbLoadStartedAt;
    debugTimingRef.current.glbDownloadDone = null;
    debugTimingRef.current.glbOnLoad = null;

    loader.load(HELMET_MODEL_URL, (gltf) => {
      const glbOnLoadAt = performance.now();
      debugTimingRef.current.glbOnLoad = glbOnLoadAt;

      const downloadDoneAt = debugTimingRef.current.glbDownloadDone || glbOnLoadAt;
      debugStaticRef.current.glbDownloadMs = Math.max(0, downloadDoneAt - glbLoadStartedAt);
      debugStaticRef.current.glbParseMs = Math.max(0, glbOnLoadAt - downloadDoneAt);

      // GLTFLoader's final progress event is not guaranteed to give us a clean
      // download-vs-parse boundary. On the production builder the GLB is same-origin,
      // so Resource Timing gives a more accurate responseEnd timestamp.
      try {
        const glbUrl = new URL(HELMET_MODEL_URL, window.location.href).href;
        const resourceEntries = performance.getEntriesByName(glbUrl);
        const resourceEntry = resourceEntries[resourceEntries.length - 1];
        if (resourceEntry) {
          const measuredDownload = Math.max(0, resourceEntry.responseEnd - glbLoadStartedAt);
          const measuredParse = Math.max(0, glbOnLoadAt - resourceEntry.responseEnd);
          if (Number.isFinite(measuredDownload)) debugStaticRef.current.glbDownloadMs = measuredDownload;
          if (Number.isFinite(measuredParse)) debugStaticRef.current.glbParseMs = measuredParse;

          if (resourceEntry.decodedBodySize > 0) {
            debugStaticRef.current.glbBytesTotal = resourceEntry.decodedBodySize;
          }
        }
      } catch {}

      const model = gltf.scene;
      const baseStats = getBaseModelStats(model);
      debugStaticRef.current.modelMeshes = baseStats.meshes;
      debugStaticRef.current.modelTriangles = baseStats.triangles;
      debugStaticRef.current.modelVertices = baseStats.vertices;
      modelRef.current = model;
      decalSurfaceObjectsRef.current = [];

      // Preserve the authored GLB normals exactly as exported from Blender.
      // Khronos glTF Viewer already proves the model's shading is smooth, so blindly
      // recomputing vertex normals here can destroy Blender's split/custom normals and
      // introduce the faceting that only appears in our builder.
      model.traverse(child => {
        if (child.isMesh) {
          if (!child.geometry.attributes.normal) {
            child.geometry.computeVertexNormals();
          } else {
            child.geometry.normalizeNormals();
          }

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

      // Replace materials with MeshPhysicalMaterial for full PBR control.
      // Geometry normals are intentionally left authored/imported from the GLB.
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

      // Collect the hidden carrier shell used only for decal-related rendering and
      // interaction. This duplicates the shell curvature but fills the cutouts so decals
      // can hug the helmet while bridging across vents / holes cleanly.
      decalSurfaceObjectsRef.current = [];
      const decalSurfaceKey = partKey('Decal Surface');
      model.traverse(child => {
        // GLTFLoader sanitizes Blender node names (for example "Decal Surface" can
        // become "Decal_Surface"). Always compare through partKey instead of relying
        // on the literal exported name.
        if (partKey(child.name) === decalSurfaceKey) {
          decalSurfaceObjectsRef.current.push(child);
          child.userData.decalSurfaceRoot = true;
        }
      });
      if (!decalSurfaceObjectsRef.current.length) {
        console.warn('[HelmetBuilder] Decal Surface carrier was not found. Main logos will fall back to the visible Shell.');
      }
      decalSurfaceObjectsRef.current.forEach(root => {
        // Hidden carrier only: never draw it, never write depth, never cast/receive shadows.
        // It exists strictly for raycasting + shader-based logo projection.
        root.visible = false;
        root.renderOrder = -9999;
        root.traverse(obj => {
          if (!obj.isMesh) return;
          obj.userData.decalSurfaceMesh = true;
          obj.castShadow = false;
          obj.receiveShadow = false;
          obj.visible = false;
          obj.frustumCulled = false;
          obj.renderOrder = -9999;
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          mats.forEach(mat => {
            if (!mat) return;
            mat.visible = false;
            mat.transparent = true;
            mat.opacity = 0;
            mat.colorWrite = false;
            mat.depthWrite = false;
            mat.depthTest = false;
            mat.toneMapped = false;
            mat.needsUpdate = true;
          });
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
      const shellRoots = partObjectsRef.current[partKey('Shell')] || [];
      const shellProjection = applyPanoramicShellWrapUV(
        model,
        shellRoots
      );

      // Side Screws + Top Screws are visually part of the painted shell. Give them the
      // same continuous projection coordinates as the Shell so Car Paint flakes don't
      // restart/repeat differently on each hardware mesh.
      const sideScrewRoots = partObjectsRef.current[partKey('Side Screws')] || [];
      const topScrewRoots = partObjectsRef.current[partKey('Top Screws')] || [];
      applyStripeProjectionAttributes(model, sideScrewRoots, shellProjection, 1);
      applyStripeProjectionAttributes(model, topScrewRoots, shellProjection, 1);

      const continuousShellMaterials = [];
      const continuousShellMaterialSet = new Set();
      [shellRoots, sideScrewRoots, topScrewRoots].forEach(roots => {
        collectMeshDescendants(roots).forEach(mesh => {
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          mats.forEach(mat => {
            if (!mat || continuousShellMaterialSet.has(mat)) return;
            continuousShellMaterialSet.add(mat);
            continuousShellMaterials.push(mat);
          });
        });
      });
      materialsRef.current.__ShellContinuousSurface = continuousShellMaterials;
      continuousShellMaterials.forEach(mat => installShellFinishTriplanar(mat));

      // The full wrap remains on the real Shell. Stripes use a visible overlay cloned
      // from the hidden baked Decal Surface. The Decal Surface itself is the stripe mask:
      // it should include the smooth helmet shell but EXCLUDE any area physically covered
      // by front/rear bumpers. That makes bumper occlusion exact with no render-order hacks.
      shellWrapUniformsRef.current.centerX.value = shellProjection?.centerX || 0;
      const decalOverlays = createShellDecalOverlays(
        shellRoots,
        shellWrapUniformsRef.current
      );
      decalOverlayMeshesRef.current = decalOverlays.overlays;
      decalOverlayMaterialsRef.current = decalOverlays.materials;

      if (decalSurfaceObjectsRef.current.length) {
        const carrierProjection = applyPanoramicShellWrapUV(model, decalSurfaceObjectsRef.current);
        stripeUniformsRef.current.centerX.value = carrierProjection?.centerX ?? shellProjection?.centerX ?? 0;
        const stripeCarrier = createWorldSpaceDecalOverlays(
          scene,
          decalSurfaceObjectsRef.current,
          stripeUniformsRef.current,
          { normalLift: 0.00042, renderOrder: 28, namePrefix: 'HelmetStripeCarrier', subdivisionLevels: 1 }
        );
        stripeCarrierOverlayMeshesRef.current = stripeCarrier.overlays;
        stripeCarrierOverlayMaterialsRef.current = stripeCarrier.materials;
      } else {
        // Fallback for an older GLB: put stripes back on the visible shell overlay.
        stripeUniformsRef.current.centerX.value = shellProjection?.centerX || 0;
        const stripeFallback = createWorldSpaceDecalOverlays(
          scene,
          shellRoots,
          stripeUniformsRef.current,
          { normalLift: 0.00042, renderOrder: 28, namePrefix: 'HelmetStripeFallback', subdivisionLevels: 1 }
        );
        stripeCarrierOverlayMeshesRef.current = stripeFallback.overlays;
        stripeCarrierOverlayMaterialsRef.current = stripeFallback.materials;
      }

      applyDecalFinishToMaterials([
        ...decalOverlayMaterialsRef.current,
        ...stripeCarrierOverlayMaterialsRef.current,
      ], scene, decalFinishRef.current);

      // Hard-mask stripe artwork with the real front/rear bumper geometry. This is more
      // robust than relying on the Decal Surface cutout alone and survives mesh
      // optimization/subdivision changes in future GLBs.
      applyStripeBumperStencilMask(
        partsRef.current,
        stripeCarrierOverlayMaterialsRef.current
      );

      scene.add(model);
      // Now that all shell/facemask materials exist, route env maps per current finish
      // (scoped to car paint / chrome only — see applyShellEnvMap above).
      applyShellEnvMap(materialsRef.current, scene, finishRef.current);
      applyFacemaskEnvMap(materialsRef.current, scene, facemaskFinishRef.current);

      const modelSetupDoneAt = performance.now();
      debugTimingRef.current.modelSetupDone = modelSetupDoneAt;
      debugStaticRef.current.builderSetupMs = Math.max(0, modelSetupDoneAt - glbOnLoadAt);
      debugStaticRef.current.interactiveMs = Math.max(
        0,
        modelSetupDoneAt - debugTimingRef.current.componentStart
      );

      setLoaded(true);
    }, (progress) => {
      debugStaticRef.current.glbBytesLoaded = progress.loaded || 0;
      debugStaticRef.current.glbBytesTotal = progress.total || 0;

      if (
        !debugTimingRef.current.glbDownloadDone &&
        progress.total > 0 &&
        progress.loaded >= progress.total
      ) {
        debugTimingRef.current.glbDownloadDone = performance.now();
      }
    }, (err) => console.error('GLB load error:', err));

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
      debugFrameRef.current.frames += 1;

      if (
        debugTimingRef.current.modelSetupDone &&
        !debugTimingRef.current.firstRenderAt
      ) {
        const firstRenderAt = performance.now();
        debugTimingRef.current.firstRenderAt = firstRenderAt;
        debugStaticRef.current.firstRenderMs = Math.max(
          0,
          firstRenderAt - debugTimingRef.current.componentStart
        );
      }
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
      stripeCarrierOverlayMeshesRef.current.forEach(mesh => { mesh.parent?.remove(mesh); mesh.geometry?.dispose?.(); });
      stripeCarrierOverlayMaterialsRef.current.forEach(mat => mat.dispose?.());
      stripeCarrierOverlayMeshesRef.current = [];
      stripeCarrierOverlayMaterialsRef.current = [];
      bumperLogoMeshesRef.current.forEach(mesh => { mesh.parent?.remove(mesh); mesh.geometry?.dispose?.(); });
      bumperLogoMaterialsRef.current.forEach(mat => mat.dispose?.());
      bumperLogoMeshesRef.current = [];
      bumperLogoMaterialsRef.current = [];
      decalSurfaceObjectsRef.current = [];
      sideLogoMeshesRef.current.forEach(mesh => mesh.parent?.remove(mesh));
      sideLogoMaterialsRef.current.forEach(mat => mat.dispose());
      sideLogoTexturesRef.current.forEach(tex => tex.dispose?.());
      sideLogoMeshesRef.current = [];
      sideLogoMaterialsRef.current = [];
      sideLogoTexturesRef.current = [];
      modelRef.current = null;
      dracoLoader.dispose();
      renderer.dispose();
      if (el.contains(renderer.domElement)) el.removeChild(renderer.domElement);
    };
  }, []);

  // ── VIEWPORT / EXPORT BACKGROUND ────────────────────────────────────────────
  // Keep the actual Three.js scene background synchronized with the UI. The previous
  // version only changed the surrounding DOM container, so the WebGL canvas and PNG
  // capture continued using the original dark scene background.
  useEffect(() => {
    const scene = sceneRef.current;
    const renderer = rendererRef.current;
    if (!scene || !renderer) return;

    if (transparentBg) {
      scene.background = null;
      renderer.setClearColor(0x000000, 0);
    } else {
      scene.background = new THREE.Color(viewportBgColor);
      renderer.setClearColor(new THREE.Color(viewportBgColor), 1);
    }
  }, [transparentBg, viewportBgColor, loaded]);

  useEffect(() => {
    const rim = sceneRef.current?.userData?.rimLight;
    if (rim) rim.color.set(rimLightColor);
  }, [rimLightColor, loaded]);


  // ── HDRI ENVIRONMENT / IBL ─────────────────────────────────────────────────
  // EXRs load only when selected, then their PMREM render targets are cached so
  // switching back to a previously used studio is instant. The visible scene
  // background remains completely independent of the HDRI.
  useEffect(() => {
    const scene = sceneRef.current;
    const renderer = rendererRef.current;
    if (!scene || !renderer || !loaded) return;

    const preset = HDRI_PRESETS.find(p => p.id === hdriPreset) || HDRI_PRESETS[0];
    const token = ++hdriLoadTokenRef.current;

    const applyEnvironment = (texture) => {
      if (token !== hdriLoadTokenRef.current) return;
      scene.userData.envTexture = texture || scene.userData.neutralEnvTexture || null;
      scene.environment = scene.userData.envTexture;
      scene.environmentIntensity = hdriIntensity;

      // Re-route any finishes that explicitly use the environment texture.
      applyShellEnvMap(materialsRef.current, scene, finishRef.current);
      applyFacemaskEnvMap(materialsRef.current, scene, facemaskFinishRef.current);

      applyDecalFinishToMaterials([
        ...decalOverlayMaterialsRef.current,
        ...stripeCarrierOverlayMaterialsRef.current,
        ...sideLogoMaterialsRef.current.filter(mat => mat.userData?.sideLogoMainMaterial),
      ], scene, decalFinishRef.current);

      applyDecalFinishToMaterials([
        ...bumperLogoMaterialsRef.current.filter(mat => mat.userData?.bumperLogoMainMaterial),
      ], scene, bumperLogoFinishRef.current);

      setHdriLoading(false);
      setHdriError('');
    };

    if (!preset.url) {
      debugStaticRef.current.hdriName = preset.label;
      debugStaticRef.current.hdriCacheHit = true;
      debugStaticRef.current.hdriBytesLoaded = 0;
      debugStaticRef.current.hdriBytesTotal = 0;
      debugStaticRef.current.hdriDownloadMs = 0;
      debugStaticRef.current.hdriDecodeMs = 0;
      debugStaticRef.current.hdriPmremMs = 0;
      debugStaticRef.current.hdriReadyMs = 0;
      applyEnvironment(scene.userData.neutralEnvTexture || null);
      return;
    }

    const cached = hdriCacheRef.current.get(preset.id);
    if (cached?.texture) {
      debugStaticRef.current.hdriName = preset.label;
      debugStaticRef.current.hdriCacheHit = true;
      debugStaticRef.current.hdriBytesLoaded = 0;
      debugStaticRef.current.hdriBytesTotal = 0;
      debugStaticRef.current.hdriDownloadMs = 0;
      debugStaticRef.current.hdriDecodeMs = 0;
      debugStaticRef.current.hdriPmremMs = 0;
      debugStaticRef.current.hdriReadyMs = 0;
      applyEnvironment(cached.texture);
      return;
    }

    setHdriLoading(true);
    setHdriError('');

    const hdriStartedAt = performance.now();
    debugTimingRef.current.hdriStart = hdriStartedAt;
    debugTimingRef.current.hdriDownloadDone = null;
    debugStaticRef.current.hdriName = preset.label;
    debugStaticRef.current.hdriCacheHit = false;
    debugStaticRef.current.hdriBytesLoaded = 0;
    debugStaticRef.current.hdriBytesTotal = 0;

    const loader = new EXRLoader();
    loader.load(
      preset.url,
      (texture) => {
        if (token !== hdriLoadTokenRef.current) {
          texture.dispose?.();
          return;
        }

        const decodedAt = performance.now();
        const hdriDownloadDoneAt = debugTimingRef.current.hdriDownloadDone || decodedAt;
        debugStaticRef.current.hdriDownloadMs = Math.max(0, hdriDownloadDoneAt - hdriStartedAt);
        debugStaticRef.current.hdriDecodeMs = Math.max(0, decodedAt - hdriDownloadDoneAt);

        texture.mapping = THREE.EquirectangularReflectionMapping;

        const pmremStartedAt = performance.now();
        const pmrem = new THREE.PMREMGenerator(renderer);
        pmrem.compileEquirectangularShader();
        const rt = pmrem.fromEquirectangular(texture);
        const pmremDoneAt = performance.now();
        pmrem.dispose();
        texture.dispose();

        debugStaticRef.current.hdriPmremMs = Math.max(0, pmremDoneAt - pmremStartedAt);
        debugStaticRef.current.hdriReadyMs = Math.max(0, pmremDoneAt - hdriStartedAt);

        hdriCacheRef.current.set(preset.id, {
          renderTarget: rt,
          texture: rt.texture,
        });

        applyEnvironment(rt.texture);
      },
      (progress) => {
        debugStaticRef.current.hdriBytesLoaded = progress.loaded || 0;
        debugStaticRef.current.hdriBytesTotal = progress.total || 0;

        if (
          !debugTimingRef.current.hdriDownloadDone &&
          progress.total > 0 &&
          progress.loaded >= progress.total
        ) {
          debugTimingRef.current.hdriDownloadDone = performance.now();
        }
      },
      (error) => {
        console.warn(`Could not load HDRI: ${preset.url}`, error);
        if (token !== hdriLoadTokenRef.current) return;
        setHdriLoading(false);
        setHdriError('HDRI file not found — using Neutral Studio.');
        applyEnvironment(scene.userData.neutralEnvTexture || null);
      }
    );
  }, [loaded, hdriPreset]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    scene.environmentIntensity = hdriIntensity;

    // Materials with their own envMap use their own material intensity, so refresh
    // those mappings too when the global environment strength changes.
    applyShellEnvMap(materialsRef.current, scene, finishRef.current);
    applyFacemaskEnvMap(materialsRef.current, scene, facemaskFinishRef.current);
  }, [hdriIntensity, loaded]);

  useEffect(() => {
    if (rendererRef.current) rendererRef.current.toneMappingExposure = sceneExposure;
  }, [sceneExposure, loaded]);


  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    const strength = THREE.MathUtils.clamp(studioLightStrength, 0, 2);
    if (scene.userData.keySoftbox)  scene.userData.keySoftbox.intensity = 5.5 * strength;
    if (scene.userData.fillSoftbox) scene.userData.fillSoftbox.intensity = 2.7 * strength;
    if (scene.userData.shadowLight) scene.userData.shadowLight.intensity = 0.55 * strength;

    // Preserve a small neutral baseline even with studio lights turned down, while
    // allowing the HDRI to remain the dominant fill source.
    if (scene.userData.ambientLight) {
      scene.userData.ambientLight.intensity = 0.08 + 0.06 * strength;
    }
  }, [studioLightStrength, loaded]);

  useEffect(() => () => {
    hdriCacheRef.current.forEach(entry => entry?.renderTarget?.dispose?.());
    hdriCacheRef.current.clear();
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
    const uniforms = shellWrapUniformsRef.current;
    const wrapActive = !!(wrapEnabled && wrapImageRef.current);

    decalOverlayMeshesRef.current.forEach(mesh => {
      mesh.visible = wrapActive;
    });

    if (!wrapActive) {
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

    // Custom stripe artwork was previously rasterized to only 1024×3072, which became
    // visibly stair-stepped during close-up views. Use the highest practical 1:3 canvas
    // supported by the current GPU, up to 2048×6144.
    const maxTextureSize = rendererRef.current?.capabilities?.maxTextureSize || 4096;
    const targetHeight = Math.min(6144, maxTextureSize);
    const targetWidth = Math.min(2048, Math.max(1024, Math.floor(targetHeight / 3)));

    if (!canvas) {
      canvas = document.createElement('canvas');
      stripeDesignCanvasRef.current = canvas;
    }
    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

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
      texture.magFilter = THREE.LinearFilter;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.generateMipmaps = true;
      texture.anisotropy = Math.min(
        16,
        rendererRef.current?.capabilities?.getMaxAnisotropy?.() || 8
      );
      stripeDesignTextureRef.current = texture;
    }
    texture.needsUpdate = true;

    uniforms.designMap.value = texture;
    uniforms.designEnabled.value = 1;
  }, [loaded, helmetStripeDesignEnabled, helmetStripeDesignRevision, helmetStripeDesignScale, helmetStripeDesignRotation, helmetStripeDesignOffsetX, helmetStripeDesignOffsetY, helmetStripeDesignOpacity]);

  // ── PRESET STRIPE DECAL ─────────────────────────────────────────────────────
  useEffect(() => {
    const uniforms = stripeUniformsRef.current;
    const hasDesign = !!stripeDesignImageRef.current;
    const stripeActive = helmetStripesEnabled || (helmetStripeDesignEnabled && hasDesign);

    stripeCarrierOverlayMeshesRef.current.forEach(mesh => {
      mesh.visible = stripeActive;
    });

    uniforms.enabled.value = stripeActive ? 1 : 0;
    uniforms.baseEnabled.value = helmetStripesEnabled ? 1 : 0;
    uniforms.widthScale.value = helmetStripeWidth;
    uniforms.length.value = helmetStripeLength;
    uniforms.preset.value = (
      helmetStripePreset === 'single' ? 0 :
      helmetStripePreset === 'threeEqual' ? 1 :
      helmetStripePreset === 'threeThickCenter' ? 2 : 3
    );
    uniforms.leftColor.value.set(helmetStripeOuterColor);
    uniforms.centerColor.value.set(helmetStripePreset === 'single' ? helmetStripeSingleColor : helmetStripeCenterColor);
    uniforms.rightColor.value.set(helmetStripeOuterColor);
    uniforms.pipingColor.value.set(helmetStripePipingColor);
    uniforms.designEnabled.value = helmetStripeDesignEnabled && hasDesign ? 1 : 0;
  }, [loaded, helmetStripesEnabled, helmetStripePreset, helmetStripeWidth, helmetStripeLength, helmetStripeSingleColor, helmetStripeOuterColor, helmetStripeCenterColor, helmetStripePipingColor, helmetStripeDesignEnabled, helmetStripeDesignRevision]);

  // Hide crown screws while any stripe layer is active. The filled Decal Surface
  // supplies the visible curved stripe across that area, so the screw hardware cannot
  // poke through the vinyl graphic.
  useEffect(() => {
    const hasDesign = !!stripeDesignImageRef.current;
    const stripeActive = helmetStripesEnabled || (helmetStripeDesignEnabled && hasDesign);
    const roots = partObjectsRef.current[partKey('Top Screws')] || [];
    roots.forEach(root => { root.visible = !stripeActive; });
  }, [loaded, helmetStripesEnabled, helmetStripeDesignEnabled, helmetStripeDesignRevision]);

  // ── MAIN SIDE LOGO DECALS ───────────────────────────────────────────────
  // Main logos use the hidden baked `Decal Surface` as a true clipping carrier:
  // the full carrier curvature is duplicated for rendering, but a shader makes every
  // pixel transparent except the uploaded logo/stroke. There is no projector-volume
  // clipping, so artwork can span vents/holes with no circular/box mask.
  useEffect(() => {
    const scene = sceneRef.current;
    const renderer = rendererRef.current;
    const camera = cameraRef.current;
    const model = modelRef.current;
    if (!loaded || !scene || !renderer || !camera || !model) return;

    const decalRoots = decalSurfaceObjectsRef.current.length
      ? decalSurfaceObjectsRef.current
      : (partObjectsRef.current[partKey('Shell')] || []); // fallback only if carrier is genuinely missing
    const shellMeshes = collectMeshDescendants(decalRoots);
    const boundsWorld = getWorldBoundsForRoots(decalRoots);
    const boundsModel = computeRootsBoundsInModelSpace(model, decalRoots);
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

    const getHitWorldNormal = (hit, side) => {
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld);
      return hit.face?.normal?.clone().applyMatrix3(normalMatrix).normalize()
        || new THREE.Vector3(side === 'left' ? -1 : 1, 0, 0).transformDirection(model.matrixWorld).normalize();
    };

    const mirrorWorldPointAcrossHelmet = (worldPoint) => {
      const local = worldPoint.clone();
      model.worldToLocal(local);
      local.x = boundsModel.centerX * 2 - local.x;
      return model.localToWorld(local);
    };

    const mirrorWorldDirectionAcrossHelmet = (worldDirection) => {
      const inverseWorld = new THREE.Matrix4().copy(model.matrixWorld).invert();
      const local = worldDirection.clone().transformDirection(inverseWorld);
      local.x *= -1;
      return local.transformDirection(model.matrixWorld).normalize();
    };

    const makeFrameQuaternion = (right, up, normal) => {
      const basis = new THREE.Matrix4().makeBasis(right, up, normal);
      return new THREE.Quaternion().setFromRotationMatrix(basis);
    };

    const getSideFrame = (side) => {
      if (sideLogoIndependent) {
        const placement = sideLogoPlacementRef.current[side];
        const hit = getSideHit(side, placement);
        if (!hit) return null;
        const logoCenter = hit.point.clone();
        const worldNormal = getHitWorldNormal(hit, side);
        const helper = new THREE.Object3D();
        helper.position.copy(logoCenter);
        helper.lookAt(logoCenter.clone().add(worldNormal));
        helper.rotateZ(placement.rotation);
        const frameQuat = helper.quaternion.clone();
        const frameRight = new THREE.Vector3(1, 0, 0).applyQuaternion(frameQuat).normalize();
        const frameUp = new THREE.Vector3(0, 1, 0).applyQuaternion(frameQuat).normalize();
        return { logoCenter, worldNormal, frameRight, frameUp, frameQuat };
      }

      // Linked logos use one mathematically mirrored transform. We derive the canonical
      // frame from the model-space LEFT carrier side, then reflect the actual center and
      // tangent frame across the helmet's X=center plane. This guarantees identical
      // height/front-back/scale/rotation on both sides instead of relying on two slightly
      // different raycast intersections.
      const placement = sideLogoPlacementRef.current.left;
      const masterHit = getSideHit('left', placement);
      if (!masterHit) return null;
      const masterCenter = masterHit.point.clone();
      const masterNormal = getHitWorldNormal(masterHit, 'left');
      const masterHelper = new THREE.Object3D();
      masterHelper.position.copy(masterCenter);
      masterHelper.lookAt(masterCenter.clone().add(masterNormal));
      masterHelper.rotateZ(placement.rotation);
      const masterQuat = masterHelper.quaternion.clone();
      const masterRight = new THREE.Vector3(1, 0, 0).applyQuaternion(masterQuat).normalize();
      const masterUp = new THREE.Vector3(0, 1, 0).applyQuaternion(masterQuat).normalize();

      if (side === 'left') {
        return { logoCenter:masterCenter, worldNormal:masterNormal, frameRight:masterRight, frameUp:masterUp, frameQuat:masterQuat };
      }

      const logoCenter = mirrorWorldPointAcrossHelmet(masterCenter);
      const worldNormal = mirrorWorldDirectionAcrossHelmet(masterNormal);
      const frameUp = mirrorWorldDirectionAcrossHelmet(masterUp);
      // Reflection reverses handedness. Rebuild a proper right-handed tangent basis so
      // PlaneGeometry/selection UI remain stable while the uploaded image's MIRROR toggle
      // controls whether the artwork itself is flipped.
      const frameRight = frameUp.clone().cross(worldNormal).normalize();
      const frameQuat = makeFrameQuaternion(frameRight, frameUp, worldNormal);
      return { logoCenter, worldNormal, frameRight, frameUp, frameQuat };
    };

    const makeSide = (side) => {
      const show = side === 'left' ? sideLogoLeftVisible : sideLogoRightVisible;
      const image = resolveImageForSide(side);
      if (!show || !image) return;

      const placement = sideLogoPlacementRef.current[side];
      const frame = getSideFrame(side);
      if (!frame) return;

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
      const baseHeight = boundsModel.height * 1.00 * combinedScale;
      const baseWidth = baseHeight * THREE.MathUtils.clamp(pack.aspect, 0.55, 2.6);

      const { logoCenter, worldNormal, frameRight, frameUp, frameQuat } = frame;

      // The artwork is sampled on the *entire* baked carrier surface. Only transparent
      // pixels outside the image disappear; there is no geometric decal mask at all.
      const physicalDepth = Math.max(boundsModel.width * 0.00055, 0.00024);
      const projectionDepth = Math.max(baseHeight * 0.32, boundsModel.width * 0.10);
      const shadowUniforms = {
        center: { value: logoCenter },
        right: { value: frameRight },
        up: { value: frameUp },
        normal: { value: worldNormal },
        width: { value: baseWidth * 1.018 },
        height: { value: baseHeight * 1.018 },
        depth: { value: projectionDepth },
        lift: { value: physicalDepth * 0.20 },
      };
      const mainUniforms = {
        center: { value: logoCenter },
        right: { value: frameRight },
        up: { value: frameUp },
        normal: { value: worldNormal },
        width: { value: baseWidth },
        height: { value: baseHeight },
        depth: { value: projectionDepth },
        lift: { value: physicalDepth * 0.55 },
      };

      const shadowMat = new THREE.MeshPhysicalMaterial({
        color: 0x000000,
        map: pack.rimTexture,
        transparent: true,
        alphaTest: 0.01,
        opacity: 0.36,
        side: THREE.DoubleSide,
        depthWrite: false,
        depthTest: true,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
        roughness: 0.95,
        metalness: 0.0,
      });
      installSideLogoSurfaceProjection(shadowMat, shadowUniforms, `side-logo-shadow-v2-${side}`);

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
      installSideLogoSurfaceProjection(mainMat, mainUniforms, `side-logo-main-v2-${side}`);
      applyDecalFinishToMaterials([mainMat], scene, decalFinishRef.current);

      const shadowMeshes = createCarrierSurfaceLogoMeshes(scene, shellMeshes, shadowMat, side, 'Shadow', 39);
      const artworkMeshes = createCarrierSurfaceLogoMeshes(scene, shellMeshes, mainMat, side, 'Artwork', 40);
      sideLogoMeshesRef.current.push(...shadowMeshes, ...artworkMeshes);
      sideLogoMaterialsRef.current.push(shadowMat, mainMat);
      sideLogoTexturesRef.current.push(pack.rimTexture, pack.mainTexture);

      // Use a simple invisible tangent-plane hit target so clicking/dragging is limited
      // to the logo's footprint rather than the entire carrier shell.
      const hitProxyGeo = new THREE.PlaneGeometry(baseWidth, baseHeight, 1, 1);
      const hitProxyMat = new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        colorWrite: false,
        depthWrite: false,
        depthTest: false,
        side: THREE.DoubleSide,
      });
      const hitProxy = new THREE.Mesh(hitProxyGeo, hitProxyMat);
      hitProxy.name = `SideLogo_${side}_HitProxy`;
      hitProxy.userData.sideLogoSide = side;
      hitProxy.userData.sideLogoMain = true;
      hitProxy.position.copy(logoCenter.clone().addScaledVector(worldNormal, physicalDepth * 1.1));
      hitProxy.quaternion.copy(frameQuat);
      hitProxy.renderOrder = 90;
      scene.add(hitProxy);
      sideLogoMeshesRef.current.push(hitProxy);
      sideLogoMaterialsRef.current.push(hitProxyMat);

      const frameHalfW = baseWidth * 0.50;
      const frameHalfH = baseHeight * 0.50;
      const frameCenter = logoCenter.clone().addScaledVector(worldNormal, physicalDepth * 1.4);
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
        const selectionGeo = new THREE.PlaneGeometry(baseWidth * 1.10, baseHeight * 1.10, 1, 1);
        const selectionMat = new THREE.MeshBasicMaterial({
          map: selectionTex,
          transparent: true,
          alphaTest: 0.02,
          depthTest: false,
          depthWrite: false,
          toneMapped: false,
          side: THREE.DoubleSide,
        });
        const selectionMesh = new THREE.Mesh(selectionGeo, selectionMat);
        selectionMesh.name = `SideLogo_${side}_Selection`;
        selectionMesh.userData.sideLogoSide = side;
        selectionMesh.userData.sideLogoSelection = true;
        selectionMesh.renderOrder = 100;
        selectionMesh.position.copy(frameCenter);
        selectionMesh.quaternion.copy(frameQuat);
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
        startPlacements:{
          left:{ ...sideLogoPlacementRef.current.left },
          right:{ ...sideLogoPlacementRef.current.right },
        },
        changed:false,
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

      if (selectedSideLogoRef.current !== clickedSide) selectLogo(clickedSide);
      // Locked logos stay selectable but behave like part of the helmet for orbiting.
      if (sideLogoLocked) return;
      event.preventDefault();
      event.stopPropagation();
      startInteraction(event, clickedSide, 'move');
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

      sideLogoInteractionRef.current.changed = true;

      if (!sideLogoIndependent) {
        const otherSide = side === 'left' ? 'right' : 'left';
        sideLogoPlacementRef.current[otherSide] = { ...placement };
      }

      rebuild();
    };

    const endInteraction = (event) => {
      const interaction = sideLogoInteractionRef.current;
      if (!interaction.dragging) return;

      if (interaction.changed && interaction.startPlacements) {
        sideLogoUndoStackRef.current.push({
          left:{ ...interaction.startPlacements.left },
          right:{ ...interaction.startPlacements.right },
        });
        if (sideLogoUndoStackRef.current.length > 20) {
          sideLogoUndoStackRef.current.shift();
        }
        setSideLogoUndoCount(sideLogoUndoStackRef.current.length);
      }

      interaction.dragging = false;
      interaction.action = null;
      interaction.side = null;
      interaction.startPlacements = null;
      interaction.changed = false;

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

  // ── REAR SHELL STICKERS ────────────────────────────────────────────────────
  useEffect(() => {
    const scene = sceneRef.current;
    const model = modelRef.current;
    if (!loaded || !scene || !model) return;

    // Rear stickers use the same filled baked Decal Surface as side logos/stripes.
    // That carrier bridges vents/cutouts so artwork behaves like one continuous vinyl
    // sticker instead of being clipped by the visible shell topology.
    let shellRoots = decalSurfaceObjectsRef.current.length
      ? decalSurfaceObjectsRef.current
      : (partObjectsRef.current[partKey('Shell')] || []);

    if (!shellRoots.length) {
      const shellKey = partKey('Shell');
      model.traverse(obj => {
        if (partKey(obj.name) === shellKey) shellRoots.push(obj);
      });
    }

    const shellMeshes = collectMeshDescendants(shellRoots);
    const boundsWorld = getWorldBoundsForRoots(shellRoots);
    const boundsModel = computeRootsBoundsInModelSpace(model, shellRoots);
    if (!shellMeshes.length || !boundsWorld || !boundsModel) return;

    const cleanup = () => {
      rearStickerMeshesRef.current.forEach(mesh => { mesh.parent?.remove(mesh); mesh.geometry?.dispose?.(); });
      rearStickerMaterialsRef.current.forEach(mat => { mat.userData?.ownedTexture?.dispose?.(); mat.dispose?.(); });
      ['rear-flag','rear-warning','rear-custom'].forEach(id => { delete editableDecalWorldFrameRef.current[id]; });
      rearStickerMeshesRef.current = [];
      rearStickerMaterialsRef.current = [];
      rearStickerMainMaterialsRef.current = { flag:null, warning:null, custom:null };
    };
    cleanup();

    const getRearHit = (across, vertical) => {
      const localTarget = new THREE.Vector3(
        // Rear view is mirrored relative to model-local X, so invert this mapping
        // to make the Across slider follow the user's screen direction.
        boundsModel.centerX - (across / 100) * boundsModel.width * 0.34,
        boundsModel.minY + boundsModel.height * (0.34 + (vertical / 100) * 0.24),
        boundsModel.minZ,
      );

      const targetWorld = model.localToWorld(localTarget.clone());
      const rearOutward = new THREE.Vector3(0, 0, -1).transformDirection(model.matrixWorld).normalize();
      const rayOrigin = targetWorld.clone().addScaledVector(rearOutward, boundsWorld.size.length() * 0.65);
      const raycaster = new THREE.Raycaster(
        rayOrigin,
        rearOutward.clone().multiplyScalar(-1),
        0,
        boundsWorld.size.length() * 1.6,
      );

      const hits = raycaster.intersectObjects(shellMeshes, false);
      if (!hits.length) return null;

      const modelInverse = new THREE.Matrix4().copy(model.matrixWorld).invert();
      return hits.find(hit => {
        const local = hit.point.clone().applyMatrix4(modelInverse);
        return local.z <= boundsModel.centerZ;
      }) || null;
    };

    const getPack = (slot, image) => {
      if (!image) return null;
      const key = image.src || `${image.width}x${image.height}`;
      let cache = rearStickerPackCacheRef.current[slot];

      if (!cache || cache.key !== key) {
        cache?.pack?.mainTexture?.dispose?.();
        cache?.pack?.rimTexture?.dispose?.();

        const pack = createSideLogoTexturePack(image, {
          strokeEnabled:false,
          textureWidth:Math.min(3072, rendererRef.current?.capabilities?.maxTextureSize || 3072),
          textureHeight:Math.min(1536, rendererRef.current?.capabilities?.maxTextureSize || 1536),
        });
        cache = { key, pack };
        rearStickerPackCacheRef.current[slot] = cache;
      }

      return cache?.pack || null;
    };

    const makeSticker = ({
      slot,
      enabled,
      image,
      scale,
      rotation,
      across,
      vertical,
      color='#ffffff',
    }) => {
      if (!enabled || !image) return;

      const hit = getRearHit(across, vertical);
      if (!hit) return;

      const pack = getPack(slot, image);
      if (!pack) return;

      const baseHeight = boundsModel.width * 0.072 * scale;
      const widthCompensation = slot === 'custom' ? 1.50 : 1.0;
      const baseWidth = baseHeight * THREE.MathUtils.clamp(pack.aspect, 0.45, 3.5) * widthCompensation;

      const normalMatrix = new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld);
      const fallback = new THREE.Vector3(0, 0, -1).transformDirection(model.matrixWorld).normalize();
      const worldNormal = hit.face?.normal?.clone().applyMatrix3(normalMatrix).normalize() || fallback;
      const projectorPosition = hit.point.clone().addScaledVector(worldNormal, 0.00045);

      const helper = new THREE.Object3D();
      helper.position.copy(projectorPosition);
      helper.lookAt(projectorPosition.clone().add(worldNormal));
      helper.rotateZ(rotation * Math.PI / 180);
      const orientation = new THREE.Euler().setFromQuaternion(helper.quaternion, 'XYZ');

      const lift = Math.max(boundsModel.width * 0.00072, 0.00024);
      const projectionDepth = Math.max(boundsModel.depth * 0.18, baseHeight * 0.9, 0.05);

      const frameQuat = helper.quaternion.clone();
      const frameRight = new THREE.Vector3(1, 0, 0).applyQuaternion(frameQuat).normalize();
      const frameUp = new THREE.Vector3(0, 1, 0).applyQuaternion(frameQuat).normalize();

      const shadowUniforms = {
        center:{ value:projectorPosition },
        right:{ value:frameRight },
        up:{ value:frameUp },
        normal:{ value:worldNormal },
        width:{ value:baseWidth * 1.018 },
        height:{ value:baseHeight * 1.018 },
        depth:{ value:projectionDepth },
        lift:{ value:lift * 0.22 },
      };
      const mainUniforms = {
        center:{ value:projectorPosition },
        right:{ value:frameRight },
        up:{ value:frameUp },
        normal:{ value:worldNormal },
        width:{ value:baseWidth },
        height:{ value:baseHeight },
        depth:{ value:projectionDepth },
        lift:{ value:lift * 0.78 },
      };

      const shadowMat = new THREE.MeshPhysicalMaterial({
        color:0x000000,
        map:pack.rimTexture,
        transparent:true,
        alphaTest:0.01,
        opacity:0.22,
        // FrontSide prevents a rear sticker from ever showing through the opposite
        // side of the helmet when we intentionally render it above shell hardware.
        side:THREE.FrontSide,
        depthWrite:false,
        depthTest:false,
        roughness:0.95,
        metalness:0,
        polygonOffset:true,
        polygonOffsetFactor:-1,
        polygonOffsetUnits:-1,
      });
      installSideLogoSurfaceProjection(
        shadowMat,
        shadowUniforms,
        `rear-sticker-${slot}-shadow-surface-v1`
      );

      const mainMat = new THREE.MeshPhysicalMaterial({
        color:new THREE.Color(color),
        map:pack.mainTexture,
        transparent:true,
        alphaTest:0.01,
        opacity:1,
        side:THREE.FrontSide,
        // Rear stickers are a top vinyl layer. Drawing after the shell hardware lets
        // them cover screws exactly where the artwork overlaps, while FrontSide culling
        // prevents the carrier from bleeding through the far side of the helmet.
        depthWrite:false,
        depthTest:false,
        polygonOffset:true,
        polygonOffsetFactor:-2,
        polygonOffsetUnits:-2,
      });
      mainMat.userData.rearStickerMainMaterial = true;
      mainMat.userData.rearStickerSlot = slot;
      rearStickerMainMaterialsRef.current[slot] = mainMat;
      installSideLogoSurfaceProjection(
        mainMat,
        mainUniforms,
        `rear-sticker-${slot}-main-surface-v1`
      );
      applyDecalFinishToMaterials([mainMat], scene, decalFinishRef.current);

      const shadowMeshes = createCarrierSurfaceLogoMeshes(
        scene,
        shellMeshes,
        shadowMat,
        `rear-${slot}`,
        'Shadow',
        44
      );
      const mainMeshes = createCarrierSurfaceLogoMeshes(
        scene,
        shellMeshes,
        mainMat,
        `rear-${slot}`,
        'Artwork',
        45
      );

      shadowMeshes.forEach(mesh => {
        mesh.userData.rearStickerSlot = slot;
      });
      mainMeshes.forEach(mesh => {
        mesh.userData.rearStickerSlot = slot;
      });

      const editableId = `rear-${slot}`;
      const frameCenter = projectorPosition.clone().addScaledVector(worldNormal, lift * 2.0);
      const halfW = baseWidth * 0.50;
      const halfH = baseHeight * 0.50;

      editableDecalWorldFrameRef.current[editableId] = {
        id:editableId, surface:'rear-shell', center:frameCenter,
        corners:[
          frameCenter.clone().addScaledVector(frameRight, -halfW).addScaledVector(frameUp,  halfH),
          frameCenter.clone().addScaledVector(frameRight,  halfW).addScaledVector(frameUp,  halfH),
          frameCenter.clone().addScaledVector(frameRight, -halfW).addScaledVector(frameUp, -halfH),
          frameCenter.clone().addScaledVector(frameRight,  halfW).addScaledVector(frameUp, -halfH),
        ],
      };

      const hitProxyGeo = new THREE.PlaneGeometry(baseWidth, baseHeight, 1, 1);
      const hitProxyMat = new THREE.MeshBasicMaterial({ transparent:true, opacity:0, colorWrite:false, depthWrite:false, depthTest:false, side:THREE.DoubleSide });
      const hitProxy = new THREE.Mesh(hitProxyGeo, hitProxyMat);
      hitProxy.name = `RearSticker_${slot}_HitProxy`;
      hitProxy.userData.editableDecalId = editableId;
      hitProxy.userData.editableDecalMain = true;
      hitProxy.position.copy(frameCenter);
      hitProxy.quaternion.copy(frameQuat);
      hitProxy.renderOrder = 96;
      scene.add(hitProxy);

      rearStickerMeshesRef.current.push(...shadowMeshes, ...mainMeshes, hitProxy);
      rearStickerMaterialsRef.current.push(shadowMat, mainMat, hitProxyMat);

      if (selectedEditableDecalRef.current === editableId) {
        const selectionTex = createSelectionBoxTexture();
        const selectionGeo = new THREE.PlaneGeometry(baseWidth * 1.10, baseHeight * 1.10, 1, 1);
        const selectionMat = new THREE.MeshBasicMaterial({ map:selectionTex, transparent:true, alphaTest:0.02, depthTest:false, depthWrite:false, toneMapped:false, side:THREE.DoubleSide });
        selectionMat.userData.ownedTexture = selectionTex;
        const selectionMesh = new THREE.Mesh(selectionGeo, selectionMat);
        selectionMesh.name = `RearSticker_${slot}_Selection`;
        selectionMesh.userData.editableDecalId = editableId;
        selectionMesh.userData.editableDecalSelection = true;
        selectionMesh.position.copy(frameCenter);
        selectionMesh.quaternion.copy(frameQuat);
        selectionMesh.renderOrder = 110;
        scene.add(selectionMesh);
        rearStickerMeshesRef.current.push(selectionMesh);
        rearStickerMaterialsRef.current.push(selectionMat);
      }
    };

    const flagPlacement = editableDecalPlacementRef.current['rear-flag'];
    const warningPlacement = editableDecalPlacementRef.current['rear-warning'];
    const customPlacement = editableDecalPlacementRef.current['rear-custom'];

    makeSticker({ slot:'flag', enabled:rearFlagEnabled, image:rearFlagImageRef.current, ...flagPlacement });
    makeSticker({ slot:'warning', enabled:rearWarningEnabled, image:rearWarningImageRef.current, ...warningPlacement, color:rearWarningColor });
    makeSticker({ slot:'custom', enabled:rearCustomEnabled, image:rearCustomImageRef.current, ...customPlacement });

    return cleanup;
  }, [
    loaded,
    rearStickerRevision,
    rearFlagEnabled,
    rearFlagScale,
    rearFlagRotation,
    rearFlagAcross,
    rearFlagVertical,
    rearWarningEnabled,
    rearWarningScale,
    rearWarningRotation,
    rearWarningAcross,
    rearWarningVertical,
    rearCustomEnabled,
    rearCustomScale,
    rearCustomRotation,
    rearCustomAcross,
    rearCustomVertical,
    selectedEditableDecal,
    editableDecalRevision,
  ]);

  useEffect(() => {
    const warningMat = rearStickerMainMaterialsRef.current.warning;
    if (!warningMat) return;
    warningMat.color.set(rearWarningColor);
    warningMat.needsUpdate = true;
  }, [rearWarningColor, rearStickerRevision, loaded]);

  useEffect(() => () => {
    Object.values(rearStickerPackCacheRef.current).forEach(cache => {
      cache?.pack?.mainTexture?.dispose?.();
      cache?.pack?.rimTexture?.dispose?.();
    });
    rearStickerPackCacheRef.current = { flag:null, warning:null, custom:null };
  }, []);

  // ── FRONT / REAR BUMPER LOGOS ─────────────────────────────────────────────
  useEffect(() => {
    const scene = sceneRef.current;
    const model = modelRef.current;
    if (!loaded || !scene || !model) return;

    // Bumper logos live on the actual visible Bumpers mesh, never on `Decal Surface`.
    // The Decal Surface can therefore exclude the bumper regions without affecting these.
    let bumperRoots = partObjectsRef.current[partKey('Bumpers')] || [];
    if (!bumperRoots.length) {
      const bumperKey = partKey('Bumpers');
      bumperRoots = [];
      model.traverse(obj => {
        if (partKey(obj.name) === bumperKey) bumperRoots.push(obj);
      });
    }
    const bumperMeshes = collectMeshDescendants(bumperRoots);
    const boundsWorld = getWorldBoundsForRoots(bumperRoots);
    const boundsModel = computeRootsBoundsInModelSpace(model, bumperRoots);
    if (!bumperMeshes.length || !boundsWorld || !boundsModel) {
      console.warn('[HelmetBuilder] Visible Bumpers mesh not found; bumper logos cannot be placed.');
      return;
    }

    const cleanup = () => {
      bumperLogoMeshesRef.current.forEach(mesh => { mesh.parent?.remove(mesh); mesh.geometry?.dispose?.(); });
      bumperLogoMaterialsRef.current.forEach(mat => { mat.userData?.ownedTexture?.dispose?.(); mat.dispose?.(); });
      delete editableDecalWorldFrameRef.current['bumper-front'];
      delete editableDecalWorldFrameRef.current['bumper-rear'];
      bumperLogoMeshesRef.current = [];
      bumperLogoMaterialsRef.current = [];
    };
    cleanup();

    const getBumperHit = (slot, across, vertical) => {
      const isFront = slot === 'front';
      const localTarget = new THREE.Vector3(
        boundsModel.centerX + (across / 100) * boundsModel.width * 0.30,
        isFront
          ? boundsModel.maxY - boundsModel.height * (0.10 - (vertical / 100) * 0.12)
          : boundsModel.minY + boundsModel.height * (0.10 + (vertical / 100) * 0.12),
        isFront ? boundsModel.maxZ : boundsModel.minZ,
      );
      const targetWorld = model.localToWorld(localTarget.clone());
      const outwardLocal = new THREE.Vector3(0, 0, isFront ? 1 : -1);
      const outwardWorld = outwardLocal.clone().transformDirection(model.matrixWorld).normalize();
      const rayOrigin = targetWorld.clone().addScaledVector(outwardWorld, boundsWorld.size.length() * 0.6);
      const raycaster = new THREE.Raycaster(
        rayOrigin,
        outwardWorld.clone().multiplyScalar(-1),
        0,
        boundsWorld.size.length() * 1.5
      );
      const hits = raycaster.intersectObjects(bumperMeshes, false);
      if (!hits.length) return null;
      const modelInverse = new THREE.Matrix4().copy(model.matrixWorld).invert();
      return hits.find(hit => {
        const local = hit.point.clone().applyMatrix4(modelInverse);
        return isFront ? local.z >= boundsModel.centerZ : local.z <= boundsModel.centerZ;
      }) || null;
    };

    const makeBumperLogo = (slot) => {
      const isFront = slot === 'front';
      const image = isFront ? bumperLogoFrontImageRef.current : bumperLogoRearImageRef.current;
      if (!image) return;
      const editableId = `bumper-${slot}`;
      const placement = editableDecalPlacementRef.current[editableId] || {
        scale:isFront ? bumperLogoFrontScale : bumperLogoRearScale,
        rotation:isFront ? bumperLogoFrontRotation : bumperLogoRearRotation,
        across:isFront ? bumperLogoFrontAcross : bumperLogoRearAcross,
        vertical:isFront ? bumperLogoFrontVertical : bumperLogoRearVertical,
      };
      const scaleValue = placement.scale;
      const rotationValue = placement.rotation;
      const acrossValue = placement.across;
      const verticalValue = placement.vertical;
      const hit = getBumperHit(slot, acrossValue, verticalValue);
      if (!hit) return;

      const cacheSlot = isFront ? 'front' : 'rear';
      const cacheKey = `${image.src}|${isFront ? 0 : bumperLogoRearCurve}`;
      let cache = bumperLogoPackCacheRef.current[cacheSlot];
      if (!cache || cache.key !== cacheKey) {
        cache?.pack?.mainTexture?.dispose?.();
        cache?.pack?.rimTexture?.dispose?.();
        const nextPack = createSideLogoTexturePack(image, {
          strokeEnabled:false,
          // A wide canvas gives wordmarks far more useful horizontal pixels than a
          // giant square texture and is cheaper to regenerate.
          textureWidth: Math.min(isFront ? 4096 : 6144, rendererRef.current?.capabilities?.maxTextureSize || 4096),
          textureHeight: Math.min(isFront ? 2048 : 1536, rendererRef.current?.capabilities?.maxTextureSize || 4096),
          arcCompensation: isFront ? 0 : bumperLogoRearCurve,
        });
        cache = { key:cacheKey, pack:nextPack };
        bumperLogoPackCacheRef.current[cacheSlot] = cache;
      }
      const pack = cache?.pack;
      if (!pack) return;

      let baseHeight = boundsModel.width * (isFront ? 0.068 : 0.080) * scaleValue;
      let baseWidth = baseHeight * THREE.MathUtils.clamp(pack.aspect, 0.55, 5.0);
      // Intentionally no max-width clamp. The physical bumper geometry is the mask,
      // so scaling can continue smoothly until the user visually fills/crops the bumper.

      // Front bumper uses the carrier-surface projection because it tracks that part's
      // geometry cleanly, but the cylindrical wrap visually compresses artwork width in
      // the common frontal/hero views. Counter that with a view-calibrated horizontal
      // expansion while preserving the uploaded artwork's native aspect relationship.
      if (isFront) {
        const center = hit.point.clone();
        const frontNormal = new THREE.Vector3(0, 0, 1).transformDirection(model.matrixWorld).normalize();
        const modelUp = new THREE.Vector3(0, 1, 0).transformDirection(model.matrixWorld).normalize();
        let right = new THREE.Vector3().crossVectors(modelUp, frontNormal).normalize();
        if (right.lengthSq() < 0.000001) right = new THREE.Vector3(1, 0, 0).transformDirection(model.matrixWorld).normalize();
        let up = new THREE.Vector3().crossVectors(frontNormal, right).normalize();

        const rot = rotationValue * Math.PI / 180;
        if (Math.abs(rot) > 0.000001) {
          right.applyAxisAngle(frontNormal, rot);
          up.applyAxisAngle(frontNormal, rot);
        }

        // Keep the logo's vertical size true and only compensate horizontally for the
        // visual narrowing introduced by the bumper's curvature.
        const frontAspectCompensation = 1.30;
        const projectedWidth = baseWidth * frontAspectCompensation;
        const projectedHeight = baseHeight;
        const projectionDepth = Math.max(boundsModel.depth * 0.072, projectedHeight * 0.40);
        const lift = Math.max(boundsModel.width * 0.00045, 0.00018);

        const shadowUniforms = {
          center:{ value:center }, right:{ value:right }, up:{ value:up }, normal:{ value:frontNormal },
          width:{ value:projectedWidth * 1.018 }, height:{ value:projectedHeight * 1.018 },
          depth:{ value:projectionDepth }, lift:{ value:lift * 0.20 },
        };
        const mainUniforms = {
          center:{ value:center }, right:{ value:right }, up:{ value:up }, normal:{ value:frontNormal },
          width:{ value:projectedWidth }, height:{ value:projectedHeight },
          depth:{ value:projectionDepth }, lift:{ value:lift * 0.55 },
        };

        const shadowMat = new THREE.MeshPhysicalMaterial({
          color:0x000000, map:pack.rimTexture, transparent:true, alphaTest:0.01, opacity:0.28,
          side:THREE.DoubleSide, depthWrite:false, depthTest:true, roughness:0.95, metalness:0,
          polygonOffset:true, polygonOffsetFactor:-1, polygonOffsetUnits:-1,
        });
          installSideLogoSurfaceProjection(shadowMat, shadowUniforms, 'bumper-logo-front-shadow-surface-v2');

        const mainMat = new THREE.MeshPhysicalMaterial({
          color:0xffffff, map:pack.mainTexture, transparent:true, alphaTest:0.01, opacity:1,
          side:THREE.DoubleSide, depthWrite:false, depthTest:true,
          polygonOffset:true, polygonOffsetFactor:-2, polygonOffsetUnits:-2,
        });
        mainMat.userData.bumperLogoMainMaterial = true;
          installSideLogoSurfaceProjection(mainMat, mainUniforms, 'bumper-logo-front-main-surface-v2');
        applyDecalFinishToMaterials([mainMat], scene, bumperLogoFinishRef.current);

        const shadowMeshes = createCarrierSurfaceLogoMeshes(scene, bumperMeshes, shadowMat, 'bumper-front', 'Shadow', 34);
        const mainMeshes = createCarrierSurfaceLogoMeshes(scene, bumperMeshes, mainMat, 'bumper-front', 'Artwork', 35);
        const frameQuat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, frontNormal));
        const frameCenter = center.clone().addScaledVector(frontNormal, lift * 1.6);
        const halfW = projectedWidth * 0.50, halfH = projectedHeight * 0.50;
        editableDecalWorldFrameRef.current[editableId] = {
          id:editableId, surface:'bumper-front', center:frameCenter,
          corners:[
            frameCenter.clone().addScaledVector(right, -halfW).addScaledVector(up,  halfH),
            frameCenter.clone().addScaledVector(right,  halfW).addScaledVector(up,  halfH),
            frameCenter.clone().addScaledVector(right, -halfW).addScaledVector(up, -halfH),
            frameCenter.clone().addScaledVector(right,  halfW).addScaledVector(up, -halfH),
          ],
        };
        const hitProxyGeo = new THREE.PlaneGeometry(projectedWidth, projectedHeight, 1, 1);
        const hitProxyMat = new THREE.MeshBasicMaterial({ transparent:true, opacity:0, colorWrite:false, depthWrite:false, depthTest:false, side:THREE.DoubleSide });
        const hitProxy = new THREE.Mesh(hitProxyGeo, hitProxyMat);
        hitProxy.name = 'BumperLogo_front_HitProxy';
        hitProxy.userData.editableDecalId = editableId;
        hitProxy.userData.editableDecalMain = true;
        hitProxy.position.copy(frameCenter); hitProxy.quaternion.copy(frameQuat); hitProxy.renderOrder = 96; scene.add(hitProxy);
        bumperLogoMeshesRef.current.push(...shadowMeshes, ...mainMeshes, hitProxy);
        bumperLogoMaterialsRef.current.push(shadowMat, mainMat, hitProxyMat);
        if (selectedEditableDecalRef.current === editableId) {
          const selectionTex = createSelectionBoxTexture();
          const selectionGeo = new THREE.PlaneGeometry(projectedWidth * 1.10, projectedHeight * 1.10, 1, 1);
          const selectionMat = new THREE.MeshBasicMaterial({ map:selectionTex, transparent:true, alphaTest:0.02, depthTest:false, depthWrite:false, toneMapped:false, side:THREE.DoubleSide });
          selectionMat.userData.ownedTexture = selectionTex;
          const selectionMesh = new THREE.Mesh(selectionGeo, selectionMat);
          selectionMesh.name = 'BumperLogo_front_Selection'; selectionMesh.userData.editableDecalId = editableId; selectionMesh.userData.editableDecalSelection = true;
          selectionMesh.position.copy(frameCenter); selectionMesh.quaternion.copy(frameQuat); selectionMesh.renderOrder = 110; scene.add(selectionMesh);
          bumperLogoMeshesRef.current.push(selectionMesh); bumperLogoMaterialsRef.current.push(selectionMat);
        }
        return;
      }

      const normalMatrix = new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld);
      const fallback = new THREE.Vector3(0, 0, -1).transformDirection(model.matrixWorld).normalize();
      const worldNormal = hit.face?.normal?.clone().applyMatrix3(normalMatrix).normalize() || fallback;
      const projectorPosition = hit.point.clone().addScaledVector(worldNormal, 0.00045);
      const helper = new THREE.Object3D();
      helper.position.copy(projectorPosition);
      helper.lookAt(projectorPosition.clone().add(worldNormal));
      helper.rotateZ(rotationValue * Math.PI / 180);
      const orientation = new THREE.Euler().setFromQuaternion(helper.quaternion, 'XYZ');
      const projectorDepth = Math.max(boundsModel.depth * 0.20, baseHeight * 0.90, 0.06);

      const shadowGeo = new DecalGeometry(
        hit.object,
        projectorPosition,
        orientation,
        new THREE.Vector3(baseWidth * 1.018, baseHeight * 1.018, projectorDepth),
      );
      const mainGeo = new DecalGeometry(
        hit.object,
        projectorPosition,
        orientation,
        new THREE.Vector3(baseWidth, baseHeight, projectorDepth),
      );
      const lift = Math.max(boundsModel.width * 0.00085, 0.00030);
      offsetGeometryAlongNormals(shadowGeo, lift * 0.25);
      offsetGeometryAlongNormals(mainGeo, lift * 0.85);

      const shadowMat = new THREE.MeshPhysicalMaterial({
        color:0x000000, map:pack.rimTexture, transparent:true, alphaTest:0.01, opacity:0.28,
        side:THREE.DoubleSide, depthWrite:false, depthTest:true, roughness:0.95, metalness:0,
        polygonOffset:true, polygonOffsetFactor:-1, polygonOffsetUnits:-1,
      });

      const mainMat = new THREE.MeshPhysicalMaterial({
        color:0xffffff, map:pack.mainTexture, transparent:true, alphaTest:0.01, opacity:1,
        side:THREE.DoubleSide, depthWrite:false, depthTest:true,
        polygonOffset:true, polygonOffsetFactor:-2, polygonOffsetUnits:-2,
      });
      mainMat.userData.bumperLogoMainMaterial = true;
      applyDecalFinishToMaterials([mainMat], scene, bumperLogoFinishRef.current);

      const shadowMesh = new THREE.Mesh(shadowGeo, shadowMat);
      shadowMesh.name = `BumperLogo_${slot}_Shadow`;
      shadowMesh.renderOrder = 34;
      shadowMesh.castShadow = false;
      shadowMesh.receiveShadow = false;
      scene.add(shadowMesh);

      const mainMesh = new THREE.Mesh(mainGeo, mainMat);
      mainMesh.name = `BumperLogo_${slot}_Artwork`;
      mainMesh.renderOrder = 35;
      mainMesh.castShadow = false;
      mainMesh.receiveShadow = false;
      scene.add(mainMesh);

      const frameQuat = helper.quaternion.clone();
      const frameRight = new THREE.Vector3(1, 0, 0).applyQuaternion(frameQuat).normalize();
      const frameUp = new THREE.Vector3(0, 1, 0).applyQuaternion(frameQuat).normalize();
      const frameCenter = projectorPosition.clone().addScaledVector(worldNormal, lift * 1.8);
      const halfW = baseWidth * 0.50, halfH = baseHeight * 0.50;
      editableDecalWorldFrameRef.current[editableId] = {
        id:editableId, surface:'bumper-rear', center:frameCenter,
        corners:[
          frameCenter.clone().addScaledVector(frameRight, -halfW).addScaledVector(frameUp,  halfH),
          frameCenter.clone().addScaledVector(frameRight,  halfW).addScaledVector(frameUp,  halfH),
          frameCenter.clone().addScaledVector(frameRight, -halfW).addScaledVector(frameUp, -halfH),
          frameCenter.clone().addScaledVector(frameRight,  halfW).addScaledVector(frameUp, -halfH),
        ],
      };
      const hitProxyGeo = new THREE.PlaneGeometry(baseWidth, baseHeight, 1, 1);
      const hitProxyMat = new THREE.MeshBasicMaterial({ transparent:true, opacity:0, colorWrite:false, depthWrite:false, depthTest:false, side:THREE.DoubleSide });
      const hitProxy = new THREE.Mesh(hitProxyGeo, hitProxyMat);
      hitProxy.name = 'BumperLogo_rear_HitProxy'; hitProxy.userData.editableDecalId = editableId; hitProxy.userData.editableDecalMain = true;
      hitProxy.position.copy(frameCenter); hitProxy.quaternion.copy(frameQuat); hitProxy.renderOrder = 96; scene.add(hitProxy);
      bumperLogoMeshesRef.current.push(shadowMesh, mainMesh, hitProxy);
      bumperLogoMaterialsRef.current.push(shadowMat, mainMat, hitProxyMat);
      if (selectedEditableDecalRef.current === editableId) {
        const selectionTex = createSelectionBoxTexture();
        const selectionGeo = new THREE.PlaneGeometry(baseWidth * 1.10, baseHeight * 1.10, 1, 1);
        const selectionMat = new THREE.MeshBasicMaterial({ map:selectionTex, transparent:true, alphaTest:0.02, depthTest:false, depthWrite:false, toneMapped:false, side:THREE.DoubleSide });
        selectionMat.userData.ownedTexture = selectionTex;
        const selectionMesh = new THREE.Mesh(selectionGeo, selectionMat);
        selectionMesh.name = 'BumperLogo_rear_Selection'; selectionMesh.userData.editableDecalId = editableId; selectionMesh.userData.editableDecalSelection = true;
        selectionMesh.position.copy(frameCenter); selectionMesh.quaternion.copy(frameQuat); selectionMesh.renderOrder = 110; scene.add(selectionMesh);
        bumperLogoMeshesRef.current.push(selectionMesh); bumperLogoMaterialsRef.current.push(selectionMat);
      }
    };

    makeBumperLogo('front');
    makeBumperLogo('rear');
    return cleanup;
  }, [
    loaded,
    bumperLogoRevision,
    bumperLogoFrontScale,
    bumperLogoRearScale,
    bumperLogoFrontRotation,
    bumperLogoRearRotation,
    bumperLogoFrontAcross,
    bumperLogoRearAcross,
    bumperLogoFrontVertical,
    bumperLogoRearVertical,
    bumperLogoRearCurve,
    selectedEditableDecal,
    editableDecalRevision,
  ]);

  useEffect(() => () => {
    Object.values(bumperLogoPackCacheRef.current).forEach(cache => {
      cache?.pack?.mainTexture?.dispose?.();
      cache?.pack?.rimTexture?.dispose?.();
    });
    bumperLogoPackCacheRef.current = { front:null, rear:null };
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const renderer = rendererRef.current, camera = cameraRef.current, model = modelRef.current;
    if (!renderer || !camera || !model) return;
    const canvas = renderer.domElement;

    let shellRoots = decalSurfaceObjectsRef.current.length
      ? decalSurfaceObjectsRef.current
      : (partObjectsRef.current[partKey('Shell')] || []);
    let bumperRoots = partObjectsRef.current[partKey('Bumpers')] || [];
    if (!shellRoots.length || !bumperRoots.length) {
      model.traverse(obj => {
        const key = partKey(obj.name);
        if (key === partKey('Shell') && !shellRoots.includes(obj)) shellRoots.push(obj);
        if (key === partKey('Bumpers') && !bumperRoots.includes(obj)) bumperRoots.push(obj);
      });
    }
    const shellMeshes = collectMeshDescendants(shellRoots);
    const bumperMeshes = collectMeshDescendants(bumperRoots);
    const shellBounds = computeRootsBoundsInModelSpace(model, shellRoots);
    const bumperBounds = computeRootsBoundsInModelSpace(model, bumperRoots);
    if (!shellBounds || !bumperBounds) return;

    const pointer = new THREE.Vector2();
    const raycaster = new THREE.Raycaster();
    const ROTATE_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='28' viewBox='0 0 28 28'%3E%3Cpath d='M21.8 8.3A9.2 9.2 0 1 0 23 17' fill='none' stroke='%23efff00' stroke-width='2.2' stroke-linecap='round'/%3E%3Cpath d='M18.5 4.2 22.4 8l-5.2 1.4' fill='none' stroke='%23efff00' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") 14 14, grab`;
    const updatePointer = event => {
      const rect = canvas.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
    };
    const worldToClient = worldPoint => {
      const rect = canvas.getBoundingClientRect(), ndc = worldPoint.clone().project(camera);
      return { x:rect.left + (ndc.x + 1) * 0.5 * rect.width, y:rect.top + (1 - ndc.y) * 0.5 * rect.height };
    };
    const getSelectedFrameClient = () => {
      const id = selectedEditableDecalRef.current, frame = id ? editableDecalWorldFrameRef.current[id] : null;
      if (!id || !frame) return null;
      return { id, center:worldToClient(frame.center), corners:frame.corners.map(worldToClient) };
    };
    const getCornerInteraction = event => {
      const frame = getSelectedFrameClient();
      if (!frame || editableDecalLockRef.current[frame.id]) return null;
      let nearest = null;
      frame.corners.forEach((corner,index) => {
        const distance = Math.hypot(event.clientX-corner.x, event.clientY-corner.y);
        if (!nearest || distance < nearest.distance) nearest = { index, distance };
      });
      if (!nearest) return null;
      if (nearest.distance <= 11) return { action:'scale', frame, cornerIndex:nearest.index };
      if (nearest.distance <= 30) return { action:'rotate', frame, cornerIndex:nearest.index };
      return null;
    };
    const findClickedEditable = event => {
      updatePointer(event);
      const selectable = [...rearStickerMeshesRef.current, ...bumperLogoMeshesRef.current].filter(mesh => mesh.userData?.editableDecalMain);
      return raycaster.intersectObjects(selectable,false)[0]?.object?.userData?.editableDecalId || null;
    };
    const projectPointerToSurface = (event,id) => {
      updatePointer(event);
      const isRearSticker = id.startsWith('rear-');
      const sourceMeshes = isRearSticker ? shellMeshes : bumperMeshes;
      const bounds = isRearSticker ? shellBounds : bumperBounds;
      const hits = raycaster.intersectObjects(sourceMeshes,false);
      if (!hits.length) return null;
      const inv = new THREE.Matrix4().copy(model.matrixWorld).invert();
      return hits.find(hit => {
        const local = hit.point.clone().applyMatrix4(inv);
        if (isRearSticker || id === 'bumper-rear') return local.z <= bounds.centerZ;
        if (id === 'bumper-front') return local.z >= bounds.centerZ;
        return true;
      }) || null;
    };
    const triggerRebuild = id => {
      if (id.startsWith('rear-')) setRearStickerRevision(v=>v+1); else setBumperLogoRevision(v=>v+1);
      setEditableDecalRevision(v=>v+1);
    };
    const selectEditable = id => { selectedEditableDecalRef.current=id; setSelectedEditableDecal(id); triggerRebuild(id); };
    const deselectEditable = () => {
      const previous=selectedEditableDecalRef.current; selectedEditableDecalRef.current=null; setSelectedEditableDecal(null);
      if (previous) triggerRebuild(previous); canvas.style.cursor='';
    };
    const startInteraction = (event,id,action,frame=null) => {
      const placement=editableDecalPlacementRef.current[id]; if (!placement) return;
      const centerClient=frame?.center || getSelectedFrameClient()?.center || {x:event.clientX,y:event.clientY};
      const dx=event.clientX-centerClient.x, dy=event.clientY-centerClient.y;
      editableDecalInteractionRef.current={ dragging:true, pointerId:event.pointerId, id, action, startPlacement:{...placement}, startDistance:Math.max(8,Math.hypot(dx,dy)), startAngle:Math.atan2(dy,dx), centerClient, changed:false };
      try { canvas.setPointerCapture?.(event.pointerId); } catch {}
      if (controlsRef.current) controlsRef.current.enabled=false;
    };
    const onPointerDown = event => {
      if (event.button!==0) return;
      const corner=getCornerInteraction(event);
      if (corner) { event.preventDefault(); event.stopPropagation(); startInteraction(event,corner.frame.id,corner.action,corner.frame); return; }
      const clickedId=findClickedEditable(event);
      if (!clickedId) { if (selectedEditableDecalRef.current) deselectEditable(); return; }
      if (selectedEditableDecalRef.current!==clickedId) selectEditable(clickedId);
      if (editableDecalLockRef.current[clickedId]) return;
      event.preventDefault(); event.stopPropagation(); startInteraction(event,clickedId,'move');
    };
    const onPointerMove = event => {
      const interaction=editableDecalInteractionRef.current;
      if (!interaction.dragging) {
        const corner=getCornerInteraction(event);
        if (corner?.action==='scale') { canvas.style.cursor=(corner.cornerIndex===0||corner.cornerIndex===3)?'nwse-resize':'nesw-resize'; return; }
        if (corner?.action==='rotate') { canvas.style.cursor=ROTATE_CURSOR; return; }
        const hoverId=findClickedEditable(event);
        if (!hoverId) canvas.style.cursor=''; else if (editableDecalLockRef.current[hoverId]) canvas.style.cursor='grab'; else if (hoverId===selectedEditableDecalRef.current) canvas.style.cursor='move'; else canvas.style.cursor='pointer';
        return;
      }
      const id=interaction.id, placement=editableDecalPlacementRef.current[id]; if (!id||!placement) return;
      event.preventDefault(); event.stopPropagation();
      if (interaction.action==='move') {
        const hit=projectPointerToSurface(event,id); if (!hit) return;
        const local=hit.point.clone(); model.worldToLocal(local);
        if (id.startsWith('rear-')) {
          placement.across=THREE.MathUtils.clamp(-((local.x-shellBounds.centerX)/(shellBounds.width*0.34))*100,-80,80);
          placement.vertical=THREE.MathUtils.clamp(((((local.y-shellBounds.minY)/shellBounds.height)-0.34)/0.24)*100,-80,80);
        } else {
          placement.across=THREE.MathUtils.clamp(((local.x-bumperBounds.centerX)/(bumperBounds.width*0.30))*100,-80,80);
          const baseY=id==='bumper-front'?bumperBounds.maxY-bumperBounds.height*0.10:bumperBounds.minY+bumperBounds.height*0.10;
          placement.vertical=THREE.MathUtils.clamp(((local.y-baseY)/(bumperBounds.height*0.12))*100,-80,80);
        }
        canvas.style.cursor='move';
      } else if (interaction.action==='scale') {
        const dx=event.clientX-interaction.centerClient.x, dy=event.clientY-interaction.centerClient.y;
        const d=Math.max(8,Math.hypot(dx,dy)), min=id.startsWith('bumper-')?1:0.4, max=id.startsWith('bumper-')?24:8.0;
        placement.scale=THREE.MathUtils.clamp(interaction.startPlacement.scale*(d/interaction.startDistance),min,max);
      } else if (interaction.action==='rotate') {
        const dx=event.clientX-interaction.centerClient.x, dy=event.clientY-interaction.centerClient.y;
        const current=Math.atan2(dy,dx); let delta=current-interaction.startAngle;
        while (delta>Math.PI) delta-=Math.PI*2; while (delta<-Math.PI) delta+=Math.PI*2;
        placement.rotation=THREE.MathUtils.clamp(interaction.startPlacement.rotation-THREE.MathUtils.radToDeg(delta),-180,180);
        canvas.style.cursor=ROTATE_CURSOR;
      }
      interaction.changed=true; triggerRebuild(id);
    };
    const endInteraction = event => {
      const interaction=editableDecalInteractionRef.current; if (!interaction.dragging) return;
      if (interaction.changed&&interaction.id&&interaction.startPlacement) { pushEditableDecalUndo(interaction.id,interaction.startPlacement); commitEditableDecalPlacement(interaction.id,editableDecalPlacementRef.current[interaction.id]); }
      interaction.dragging=false; interaction.pointerId=null; interaction.id=null; interaction.action=null; interaction.startPlacement=null; interaction.changed=false;
      try { canvas.releasePointerCapture?.(event.pointerId); } catch {}
      if (controlsRef.current) controlsRef.current.enabled=true;
    };
    canvas.addEventListener('pointerdown',onPointerDown,true); canvas.addEventListener('pointermove',onPointerMove); canvas.addEventListener('pointerup',endInteraction); canvas.addEventListener('pointercancel',endInteraction);
    return()=>{ canvas.removeEventListener('pointerdown',onPointerDown,true); canvas.removeEventListener('pointermove',onPointerMove); canvas.removeEventListener('pointerup',endInteraction); canvas.removeEventListener('pointercancel',endInteraction); if (controlsRef.current) controlsRef.current.enabled=true; };
  }, [loaded, commitEditableDecalPlacement, pushEditableDecalUndo]);

  // ── MAIN DECAL FINISH — wraps + stripes + side logos ─────────────────────────
  useEffect(() => {
    applyDecalFinishToMaterials([
      ...decalOverlayMaterialsRef.current,
      ...stripeCarrierOverlayMaterialsRef.current,
      ...sideLogoMaterialsRef.current.filter(mat => mat.userData?.sideLogoMainMaterial),
      ...rearStickerMaterialsRef.current.filter(mat => mat.userData?.rearStickerMainMaterial),
    ], sceneRef.current, decalFinish);

    applyStripeBumperStencilMask(
      partsRef.current,
      stripeCarrierOverlayMaterialsRef.current
    );
  }, [loaded, decalFinish]);

  // ── BUMPER LOGO FINISH ─────────────────────────────────────────────────────
  useEffect(() => {
    applyDecalFinishToMaterials([
      ...bumperLogoMaterialsRef.current.filter(mat => mat.userData?.bumperLogoMainMaterial),
    ], sceneRef.current, bumperLogoFinish);
  }, [loaded, bumperLogoFinish]);

  // ── SHADOW CONTROLS ─────────────────────────────────────────────────────────
  // Opacity controls the receiving ShadowMaterial surfaces. Softness changes the
  // DirectionalLight shadow-kernel radius, giving a harder contact shadow at the low
  // end and a broader, more photographic blur at the high end.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    if (scene.userData.floor) scene.userData.floor.visible = showShadows;
    if (scene.userData.wall)  scene.userData.wall.visible  = showShadows;

    if (scene.userData.floorShadowMaterial) {
      scene.userData.floorShadowMaterial.opacity = shadowOpacity;
      scene.userData.floorShadowMaterial.needsUpdate = true;
    }
    if (scene.userData.wallShadowMaterial) {
      // Keep the back-wall shadow lighter than the floor while preserving the
      // user's overall opacity choice.
      scene.userData.wallShadowMaterial.opacity = shadowOpacity * 0.43;
      scene.userData.wallShadowMaterial.needsUpdate = true;
    }

    if (scene.userData.keyLight?.shadow) {
      scene.userData.keyLight.shadow.radius = 0.5 + shadowSoftness * 11.5;
      scene.userData.keyLight.shadow.needsUpdate = true;
    }
  }, [showShadows, shadowOpacity, shadowSoftness, loaded]);

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


  // ── PREMIUM MATERIAL CALIBRATION ────────────────────────────────────────────
  useEffect(() => {
    if (!loaded) return;
    applyPremiumPartMaterialCalibration(partsRef.current);
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

  // ── SHELL SURFACE TEXTURES — CAR PAINT + METALLIC SATIN ──────────────────────
  // Car Paint uses discrete reflective flakes. Satin uses dense microscopic grain:
  // much closer to the fine metallic appearance in the reference than simply making
  // the glitter flakes larger or brighter.
  useEffect(() => {
    if (!loaded) return;

    if (!satinMicroTextureRef.current) {
      satinMicroTextureRef.current = createSatinMicroTexture();
    }
    if (!carbonWeaveTextureRef.current) {
      carbonWeaveTextureRef.current = createCarbonFiberWeaveTexture();
    }
    const satinMicroTex = satinMicroTextureRef.current;
    const carbonWeaveTex = carbonWeaveTextureRef.current;

    SHELL_MATERIAL_NAMES.forEach(name => {
      const mats = materialsRef.current[name];
      if (!mats) return;

      // Carbon Fiber size is controlled by triplanar sampling frequency.
      // Moving the slider right makes the visible weave larger; moving it left
      // creates a tighter/denser weave.
      mats.forEach(mat => {
        const scaleUniform = mat.userData?.shellFinishProjectionScaleUniform;
        if (scaleUniform) {
          scaleUniform.value = finish === 'carbonfiber'
            ? 1.1 / THREE.MathUtils.clamp(carbonFiberSize, 0.4, 2.5)
            : 1.1;
        }
      });

      if (finish === 'carpaint') {
        const { ormTex, colorTex } = createFlakeTextures(glitter, glitterSize, glitterColor);
        mats.forEach(mat => {
          if (mat.roughnessMap && mat.roughnessMap !== satinMicroTex) mat.roughnessMap.dispose?.();
          if (mat.emissiveMap) mat.emissiveMap.dispose?.();

          mat.bumpMap = null;
          mat.bumpScale = 0;
          mat.roughnessMap = ormTex;
          mat.metalnessMap = ormTex;
          mat.aoMap = null;
          mat.aoMapIntensity = 1.0;
          mat.emissiveMap = colorTex;
          mat.emissive.set(0xffffff);
          mat.emissiveIntensity = 1.0;
          mat.roughness = 1.0;
          mat.metalness = 1.0;
          mat.needsUpdate = true;
        });
        return;
      }

      if (finish === 'satin') {
        mats.forEach(mat => {
          if (mat.roughnessMap && mat.roughnessMap !== satinMicroTex) mat.roughnessMap.dispose?.();
          if (mat.emissiveMap) mat.emissiveMap.dispose?.();

          mat.emissiveMap = null;
          mat.emissive.set(0x000000);
          mat.emissiveIntensity = 1;
          mat.aoMap = null;

          // Texture adds microscopic breakup to highlights; Metallic controls how
          // strongly the silver/metallic character comes through.
          mat.bumpMap = null;
          mat.bumpScale = 0;
          mat.metalnessMap = satinTexture > 0.005 ? satinMicroTex : null;
          mat.roughnessMap = satinTexture > 0.005 ? satinMicroTex : null;
          mat.metalness = 0.08 + satinMetallic * 0.82;
          mat.roughness = 0.34 + satinTexture * 0.14;
          mat.clearcoat = 0.18;
          mat.clearcoatRoughness = 0.24;

          // Metallic satin needs a softer environment response than Car Paint/Chrome.
          mat.envMap = sceneRef.current?.userData?.envTexture || null;
          mat.envMapIntensity = 0.12 + satinMetallic * 0.62;
          mat.needsUpdate = true;
        });
        return;
      }

      if (finish === 'carbonfiber') {
        mats.forEach(mat => {
          if (mat.roughnessMap && mat.roughnessMap !== carbonWeaveTex) mat.roughnessMap.dispose?.();
          if (mat.emissiveMap) mat.emissiveMap.dispose?.();

          mat.emissiveMap = null;
          mat.emissive.set(0x000000);
          mat.emissiveIntensity = 1;
          mat.aoMap = null;

          // Carbon Fiber uses a subtle twill weave in the roughness/metalness response
          // so the pattern lives in reflections and clearcoat rather than overriding the
          // chosen shell color with a baked diffuse image.
          mat.bumpMap = null;
          mat.bumpScale = 0;
          mat.roughnessMap = carbonWeaveTex;
          mat.metalnessMap = carbonWeaveTex;
          mat.metalness = 0.34;
          mat.roughness = 0.54;
          mat.clearcoat = 0.96;
          mat.clearcoatRoughness = 0.06;
          mat.envMap = sceneRef.current?.userData?.envTexture || null;
          mat.envMapIntensity = 0.92;
          mat.needsUpdate = true;
        });
        return;
      }

      // Plain Gloss / Matte / Chrome: clear all procedural surface maps.
      mats.forEach(mat => {
        if (mat.roughnessMap && mat.roughnessMap !== satinMicroTex) mat.roughnessMap.dispose?.();
        if (mat.emissiveMap) mat.emissiveMap.dispose?.();
        mat.roughnessMap = null;
        mat.metalnessMap = null;
        mat.aoMap = null;
        mat.bumpMap = null;
        mat.bumpScale = 0;
        mat.emissiveMap = null;
        mat.emissive.set(0x000000);
        mat.emissiveIntensity = 1;

        const finishDef = FINISHES.find(f => f.id === finish);
        if (finishDef) {
          mat.roughness = finishDef.roughness;
          mat.metalness = finishDef.metalness;
        }
        mat.needsUpdate = true;
      });
    });
  }, [glitter, glitterSize, glitterColor, satinMetallic, satinTexture, carbonFiberSize, finish, loaded]);

  useEffect(() => () => {
    satinMicroTextureRef.current?.dispose?.();
    satinMicroTextureRef.current = null;
    carbonWeaveTextureRef.current?.dispose?.();
    carbonWeaveTextureRef.current = null;
  }, []);

  const setColor = useCallback((zoneId, val) => setColors(c => ({ ...c, [zoneId]: val })), []);

  const handleExport = useCallback(async () => {
    if (!rendererRef.current) return;
    if (!isSignedIn) {
      openSignIn({ afterSignInUrl: '/helmet?upgrade=true', afterSignUpUrl: '/helmet?upgrade=true' });
      return;
    }
    if (!isUnlimited && credits <= 0) {
      setShowUpgrade(true);
      return;
    }

    setExporting(true);
    setExportNotice('');
    setExportError('');

    let liveRenderer = null;
    let scene = null;
    let camera = null;
    let previousBackground = null;
    let previousClearColor = null;
    let previousClearAlpha = 1;
    let previousPixelRatio = 1;
    let previousRendererSize = null;
    let previousCameraAspect = null;
    let keyLight = null;
    let prevShadowW = null;
    let prevShadowH = null;
    let rendererStateChanged = false;

    try {
      liveRenderer = rendererRef.current;
      scene = sceneRef.current;
      camera = cameraRef.current;
      if (!liveRenderer || !scene || !camera) throw new Error('Renderer not ready');

      const liveCanvas = liveRenderer.domElement;
      const liveWidth = liveCanvas.clientWidth || liveCanvas.width || 1;
      const liveHeight = liveCanvas.clientHeight || liveCanvas.height || 1;
      const aspect = liveWidth / Math.max(liveHeight, 1);

      // Final PNG size follows the current viewport aspect ratio.
      let finalWidth = exportResolution;
      let finalHeight = exportResolution;
      if (aspect >= 1) {
        finalWidth = exportResolution;
        finalHeight = Math.max(1, Math.round(exportResolution / aspect));
      } else {
        finalHeight = exportResolution;
        finalWidth = Math.max(1, Math.round(exportResolution * aspect));
      }

      // Preflight the GPU BEFORE spending an export credit. This prevents a user from
      // requesting a 12K+ supersampled buffer that their hardware/browser cannot safely
      // allocate. We choose the highest safe supersample automatically.
      const exportPlan = getSafeExportPlan(
        liveRenderer,
        finalWidth,
        finalHeight,
        exportSupersample
      );

      if (!exportPlan.supported) {
        throw new Error(
          `This device cannot render a ${finalWidth}×${finalHeight} export. Try a smaller final size.`
        );
      }

      const {
        actualSupersample,
        renderWidth,
        renderHeight,
        maxTextureSize,
        maxRenderbufferSize,
        safeDimension,
      } = exportPlan;

      const wasReduced = actualSupersample < exportSupersample;
      if (wasReduced) {
        setExportNotice(
          `${exportSupersample}× supersampling was automatically reduced to ${actualSupersample}× for a safe ${renderWidth}×${renderHeight} render on this device. Final PNG remains ${finalWidth}×${finalHeight}.`
        );
      }

      Object.assign(debugStaticRef.current, {
        exportRequestedResolution: exportResolution,
        exportRequestedSupersample: exportSupersample,
        exportActualSupersample: actualSupersample,
        exportFinalSize: `${finalWidth}×${finalHeight}`,
        exportRenderSize: `${renderWidth}×${renderHeight}`,
        exportMaxTextureSize: maxTextureSize,
        exportMaxRenderbufferSize: maxRenderbufferSize,
        exportSafeDimension: safeDimension,
        exportRenderMs: null,
        exportDownsampleMs: null,
        exportEncodeMs: null,
        exportTotalMs: null,
        exportWasReduced: wasReduced,
      });

      // Build and encode the clean image first. A credit is consumed only AFTER
      // the browser has proven it can successfully render/encode the export.
      const captureStartedAt = performance.now();

      previousBackground = scene.background;
      previousClearColor = liveRenderer.getClearColor(new THREE.Color()).clone();
      previousClearAlpha = liveRenderer.getClearAlpha();
      previousPixelRatio = liveRenderer.getPixelRatio();
      previousRendererSize = liveRenderer.getSize(new THREE.Vector2());
      previousCameraAspect = camera.aspect;

      if (transparentBg) {
        scene.background = null;
        liveRenderer.setClearColor(0x000000, 0);
      } else {
        scene.background = new THREE.Color(viewportBgColor);
        liveRenderer.setClearColor(new THREE.Color(viewportBgColor), 1);
      }

      // Render through the SAME WebGLRenderer as the live viewport so PMREM/environment
      // resources remain identical. updateStyle=false prevents a visible layout jump.
      liveRenderer.setPixelRatio(1);
      liveRenderer.setSize(renderWidth, renderHeight, false);
      rendererStateChanged = true;

      camera.aspect = renderWidth / Math.max(renderHeight, 1);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);

      // Sharpen export shadows without permanently changing the live scene.
      keyLight = scene.userData.keyLight;
      if (keyLight?.shadow?.mapSize) {
        prevShadowW = keyLight.shadow.mapSize.width;
        prevShadowH = keyLight.shadow.mapSize.height;
        const targetShadowSize = renderWidth >= 5000 || renderHeight >= 5000 ? 4096 : 2048;
        keyLight.shadow.mapSize.width = targetShadowSize;
        keyLight.shadow.mapSize.height = targetShadowSize;
        if (keyLight.shadow.map) {
          keyLight.shadow.map.dispose?.();
          keyLight.shadow.map = null;
        }
        keyLight.shadow.needsUpdate = true;
      }

      const renderStartedAt = performance.now();
      liveRenderer.render(scene, camera);

      // WebGL rendering is asynchronous. During hidden debug runs only, wait for
      // the GPU to finish so the reported render time is meaningful. Normal
      // customer exports remain fully asynchronous and do not incur this stall.
      if (debugMode) {
        try {
          liveRenderer.getContext()?.finish?.();
        } catch {}
      }

      const renderFinishedAt = performance.now();

      const finalCanvas = document.createElement('canvas');
      finalCanvas.width = finalWidth;
      finalCanvas.height = finalHeight;
      const finalCtx = finalCanvas.getContext('2d', { alpha: true });
      if (!finalCtx) throw new Error('Could not create export canvas');

      finalCtx.imageSmoothingEnabled = true;
      finalCtx.imageSmoothingQuality = 'high';
      finalCtx.clearRect(0, 0, finalWidth, finalHeight);

      const downsampleStartedAt = performance.now();
      finalCtx.drawImage(liveRenderer.domElement, 0, 0, finalWidth, finalHeight);
      const downsampleFinishedAt = performance.now();

      const encodeStartedAt = performance.now();
      const rawDataURL = finalCanvas.toDataURL('image/png');
      const encodeFinishedAt = performance.now();

      Object.assign(debugStaticRef.current, {
        exportRenderMs: renderFinishedAt - renderStartedAt,
        exportDownsampleMs: downsampleFinishedAt - downsampleStartedAt,
        exportEncodeMs: encodeFinishedAt - encodeStartedAt,
        exportTotalMs: encodeFinishedAt - captureStartedAt,
      });

      // Restore immediately after the capture. A finally block below repeats this
      // defensively if anything throws before we reach this point.
      scene.background = previousBackground;
      liveRenderer.setClearColor(previousClearColor, previousClearAlpha);

      if (keyLight?.shadow?.mapSize && prevShadowW && prevShadowH) {
        keyLight.shadow.mapSize.width = prevShadowW;
        keyLight.shadow.mapSize.height = prevShadowH;
        if (keyLight.shadow.map) {
          keyLight.shadow.map.dispose?.();
          keyLight.shadow.map = null;
        }
        keyLight.shadow.needsUpdate = true;
      }

      liveRenderer.setPixelRatio(previousPixelRatio);
      liveRenderer.setSize(previousRendererSize.x, previousRendererSize.y, false);
      camera.aspect = previousCameraAspect;
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);
      liveRenderer.render(scene, camera);
      rendererStateChanged = false;

      // Atomic server authorization happens only after the clean PNG exists.
      // Concurrent tabs cannot spend the same last credit because Postgres locks
      // and updates the user's balance in one transaction.
      const exportRes = await fetch('/api/user/export', { method:'POST' });
      const exportData = await exportRes.json();
      if (!exportRes.ok && exportRes.status !== 402 && exportRes.status !== 404) {
        throw new Error(exportData?.error || 'Could not authorize export');
      }
      if (!exportData.allowed) {
        setShowUpgrade(true);
        return;
      }

      const useWatermark = exportData.hasWatermark;
      setCredits(exportData.isUnlimited ? 999 : (exportData.freeCredits || 0) + (exportData.paidCredits || 0));
      setPaidCredits(exportData.paidCredits || 0);
      setIsUnlimited(exportData.isUnlimited || false);
      setHasWatermark(exportData.hasWatermark);

      // Tile the watermark onto free exports. If the image watermark asset ever
      // fails to load, fall back to text instead of accidentally releasing a clean
      // free-credit PNG.
      let finalDataURL = rawDataURL;
      if (useWatermark) {
        const drawTextWatermark = () => {
          finalCtx.save();
          finalCtx.globalAlpha = 0.025;
          finalCtx.fillStyle = '#ffffff';
          finalCtx.font = `bold ${Math.max(24, Math.round(finalWidth * 0.026))}px sans-serif`;
          finalCtx.textAlign = 'center';
          finalCtx.translate(finalWidth / 2, finalHeight / 2);
          finalCtx.rotate(-Math.PI / 6);
          const stepX = Math.max(220, Math.round(finalWidth * 0.28));
          const stepY = Math.max(150, Math.round(finalHeight * 0.22));
          for (let y = -finalHeight * 1.5; y <= finalHeight * 1.5; y += stepY) {
            for (let x = -finalWidth * 1.5; x <= finalWidth * 1.5; x += stepX) {
              finalCtx.fillText('PROLINEMOCKUPS.COM', x, y);
            }
          }
          finalCtx.restore();
        };

        try {
          const wm = await new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = reject;
            image.src = '/ProLine-PFP-New.jpg';
          });

          finalCtx.save();
          finalCtx.globalAlpha = 0.02;
          const wmSize = Math.round(finalWidth * 0.16);
          const cols = Math.ceil(finalWidth / wmSize) + 1;
          const rows = Math.ceil(finalHeight / wmSize) + 1;
          for (let row = 0; row < rows; row++) {
            const xOffset = row % 2 === 0 ? 0 : wmSize / 2;
            for (let col = 0; col < cols; col++) {
              finalCtx.drawImage(wm, col * wmSize - xOffset, row * wmSize, wmSize, wmSize);
            }
          }
          finalCtx.restore();
        } catch {
          drawTextWatermark();
        }

        finalDataURL = finalCanvas.toDataURL('image/png');
      }

      const a = document.createElement('a');
      a.href = finalDataURL;
      a.download = `proline-helmet-${finalWidth}x${finalHeight}.png`;
      a.click();

      setExported(true);
      setTimeout(() => setExported(false), 2500);
    } catch (err) {
      console.error('Helmet export failed', err);
      setExportError(
        err?.message || 'Export failed. Try a smaller final size or lower supersampling.'
      );
    } finally {
      // Never leave the live renderer stuck at a giant export resolution after an
      // exception, canvas failure, or browser/GPU allocation error.
      if (
        rendererStateChanged &&
        liveRenderer &&
        scene &&
        camera &&
        previousRendererSize &&
        previousClearColor
      ) {
        try {
          scene.background = previousBackground;
          liveRenderer.setClearColor(previousClearColor, previousClearAlpha);

          if (keyLight?.shadow?.mapSize && prevShadowW && prevShadowH) {
            keyLight.shadow.mapSize.width = prevShadowW;
            keyLight.shadow.mapSize.height = prevShadowH;
            if (keyLight.shadow.map) {
              keyLight.shadow.map.dispose?.();
              keyLight.shadow.map = null;
            }
            keyLight.shadow.needsUpdate = true;
          }

          liveRenderer.setPixelRatio(previousPixelRatio);
          liveRenderer.setSize(previousRendererSize.x, previousRendererSize.y, false);
          camera.aspect = previousCameraAspect;
          camera.updateProjectionMatrix();
          camera.updateMatrixWorld(true);
          liveRenderer.render(scene, camera);
        } catch (restoreErr) {
          console.error('Helmet renderer restore failed', restoreErr);
        }
      }

      setExporting(false);
    }
  }, [
    isSignedIn,
    isUnlimited,
    credits,
    openSignIn,
    transparentBg,
    viewportBgColor,
    exportResolution,
    exportSupersample,
    debugMode
  ]);

  const handleGetCredits = async () => {
    if (!isSignedIn) {
      openSignIn({ afterSignInUrl: '/helmet?upgrade=true', afterSignUpUrl: '/helmet?upgrade=true' });
      return;
    }
    setSelectedPlan(null);
    try { await refreshCredits(); }
    catch (err) { console.error('Credits refresh before upgrade modal:', err); }
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
          <button onClick={handleGetCredits} style={{ background:'linear-gradient(135deg,#efff00,#c8d900)', border:'none', borderRadius:6, padding:'6px 14px', fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800, fontSize:12, letterSpacing:'0.05em', color:'#000', cursor:'pointer' }}>{isSignedIn ? (isUnlimited ? 'UNLIMITED ACTIVE' : 'GET CREDITS') : 'GET STARTED'}</button>
          {isLoaded && (isSignedIn
            ? <UserButton
                afterSignOutUrl="/"
                appearance={{ elements: { avatarBox: { width: 28, height: 28 } } }}
                userProfileProps={{
                  appearance: {
                    variables: {
                      colorBackground: '#1f1c1e',
                      colorForeground: '#f3f4f6',
                      colorMutedForeground: '#a7adb7',
                      colorPrimary: '#efff00',
                      colorPrimaryForeground: '#000000',
                      colorNeutral: '#a3a3a3',
                      colorBorder: 'rgba(255,255,255,0.13)',
                      colorInput: '#161314',
                      colorInputForeground: '#f3f4f6',
                      colorRing: '#efff00',
                      fontFamily: "'Barlow Condensed', Arial, sans-serif",
                    },
                    elements: {
                      cardBox: {
                        background: '#1f1c1e',
                        color: '#f3f4f6',
                      },
                      card: {
                        background: '#1f1c1e',
                        color: '#f3f4f6',
                      },
                      footer: {
                        background: '#1f1c1e',
                        color: '#a7adb7',
                      },
                      footerItem: {
                        color: '#a7adb7',
                        opacity: 1,
                      },
                    },
                  },
                }}
              >
                <UserButton.UserProfilePage label="Manage Plan" url="plan" labelIcon={<PlanIcon />}>
                  <ManagePlanPage
                    isUnlimited={isUnlimited}
                    credits={credits}
                    paidCredits={paidCredits}
                    refreshCredits={refreshCredits}
                    returnPath="/helmet"
                  />
                </UserButton.UserProfilePage>
              </UserButton>
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
                <CollapsibleSection title="PART COLORS">
                {ZONES.map(zone => (
                  <ColorSwatch key={zone.id} color={colors[zone.id]} onChange={v => setColor(zone.id, v)} label={zone.label} />
                ))}

                </CollapsibleSection>
                <CollapsibleSection title="BACKGROUND">
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10 }}>
                  <span style={{ fontSize:11, color:'#9ca3af' }}>Shadow Surface</span>
                  <button onClick={() => setShowShadows(s => !s)} style={{ background:showShadows?'rgba(239,255,0,0.15)':'rgba(255,255,255,0.06)', border:showShadows?'1px solid rgba(239,255,0,0.5)':'1px solid rgba(255,255,255,0.12)', borderRadius:20, padding:'3px 12px', cursor:'pointer', fontSize:9, fontWeight:700, fontFamily:"'Barlow Condensed',sans-serif", color:showShadows?'#efff00':'#6b7280', letterSpacing:'0.06em' }}>{showShadows?'ON':'OFF'}</button>
                </div>
                {showShadows && (
                  <div style={{ marginBottom:14 }}>
                    <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:9 }}>
                      <span style={{ width:52, flexShrink:0, fontSize:9, color:'#9ca3af' }}>Opacity</span>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        value={Math.round(shadowOpacity * 100)}
                        onChange={e => setShadowOpacity(parseInt(e.target.value) / 100)}
                        style={{ flex:1, minWidth:0 }}
                      />
                    </div>
                    <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                      <span style={{ width:52, flexShrink:0, fontSize:9, color:'#9ca3af' }}>Softness</span>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        value={Math.round(shadowSoftness * 100)}
                        onChange={e => setShadowSoftness(parseInt(e.target.value) / 100)}
                        style={{ flex:1, minWidth:0 }}
                      />
                    </div>
                  </div>
                )}
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:14 }}>
                  <span style={{ fontSize:11, color:'#9ca3af' }}>Rotating Light</span>
                  <button onClick={() => setSparkleRotating(s => !s)} title={sparkleRotating ? 'Pause rotating light' : 'Resume rotating light'} style={{ background:sparkleRotating?'rgba(239,255,0,0.15)':'rgba(255,255,255,0.06)', border:sparkleRotating?'1px solid rgba(239,255,0,0.5)':'1px solid rgba(255,255,255,0.12)', borderRadius:20, padding:'3px 12px', cursor:'pointer', fontSize:9, fontWeight:700, fontFamily:"'Barlow Condensed',sans-serif", color:sparkleRotating?'#efff00':'#6b7280', letterSpacing:'0.06em', display:'flex', alignItems:'center', gap:5 }}>
                    <span style={{ fontSize:8 }}>{sparkleRotating ? '⏸' : '▶'}</span>
                    {sparkleRotating ? 'STOP' : 'START'}
                  </button>
                </div>
                </CollapsibleSection>
                <CollapsibleSection title="VISOR">
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
                  <span style={{ fontSize:11, color:'#9ca3af' }}>Visor + Clips</span>
                  <button onClick={() => setVisorOn(v => !v)} style={{ background:visorOn?'rgba(239,255,0,0.15)':'rgba(255,255,255,0.06)', border:visorOn?'1px solid rgba(239,255,0,0.5)':'1px solid rgba(255,255,255,0.12)', borderRadius:20, padding:'3px 12px', cursor:'pointer', fontSize:9, fontWeight:700, fontFamily:"'Barlow Condensed',sans-serif", color:visorOn?'#efff00':'#6b7280', letterSpacing:'0.06em' }}>{visorOn?'ON':'OFF'}</button>
                </div>
                </CollapsibleSection>
              </div>
            )}

            {/* FINISH */}
            {activeTab === 'finish' && (
              <div>
                <CollapsibleSection title="SHELL FINISH">
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
                  Finish applies to the Shell plus Side Screws and Top Screws as one continuous painted surface. Other parts retain their own finish controls.
                </div>
                {finish === 'carpaint' && (
                  <div>
                    <div style={{ height:1, background:'rgba(255,255,255,0.06)', marginBottom:14 }} />
                    <SectionLabel>Glitter Controls</SectionLabel>
                    <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:10 }}>
                      <span style={{ fontSize:10, color:'#9ca3af', minWidth:48 }}>Amount</span>
                      <input type="range" min="0" max="300" value={Math.round(glitter*100)} onChange={e => setGlitter(parseInt(e.target.value)/100)} style={{ flex:1, minWidth:0 }} />
                    </div>
                    <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:10 }}>
                      <span style={{ fontSize:10, color:'#9ca3af', minWidth:48 }}>Size</span>
                      <input type="range" min="0" max="100" value={Math.round(glitterSize*100)} onChange={e => setGlitterSize(parseInt(e.target.value)/100)} style={{ flex:1, minWidth:0 }} />
                    </div>
                    <ColorSwatch color={glitterColor} onChange={setGlitterColor} label="Sparkle Color" />
                  </div>
                )}
                {finish === 'satin' && (
                  <div>
                    <div style={{ height:1, background:'rgba(255,255,255,0.06)', marginBottom:14 }} />
                    <SectionLabel>Metallic Satin Controls</SectionLabel>
                    <div style={{ fontSize:9, color:'#6b7280', lineHeight:1.45, marginBottom:10 }}>
                      Use fine Texture with higher Metallic for a dense micro-flake paint look rather than visible glitter specks.
                    </div>
                    <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:10 }}>
                      <span style={{ fontSize:10, color:'#9ca3af', minWidth:48 }}>Metallic</span>
                      <input type="range" min="0" max="100" value={Math.round(satinMetallic*100)} onChange={e => setSatinMetallic(parseInt(e.target.value)/100)} style={{ flex:1, minWidth:0 }} />
                    </div>
                    <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:4 }}>
                      <span style={{ fontSize:10, color:'#9ca3af', minWidth:48 }}>Texture</span>
                      <input type="range" min="0" max="100" value={Math.round(satinTexture*100)} onChange={e => setSatinTexture(parseInt(e.target.value)/100)} style={{ flex:1, minWidth:0 }} />
                    </div>
                  </div>
                )}
                {finish === 'carbonfiber' && (
                  <div>
                    <div style={{ height:1, background:'rgba(255,255,255,0.06)', marginBottom:14 }} />
                    <SectionLabel>Carbon Fiber Controls</SectionLabel>
                    <div style={{ fontSize:9, color:'#6b7280', lineHeight:1.45, marginBottom:10 }}>
                      Applies a subtle twill-weave reflection pattern while preserving your shell color. Smaller weave sizes create a tighter, denser carbon pattern.
                    </div>
                    <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:4 }}>
                      <span style={{ fontSize:10, color:'#9ca3af', minWidth:58 }}>Weave Size</span>
                      <input
                        type="range"
                        min="40"
                        max="250"
                        value={Math.round(carbonFiberSize * 100)}
                        onChange={e => setCarbonFiberSize(parseInt(e.target.value) / 100)}
                        style={{ flex:1, minWidth:0 }}
                      />
                    </div>
                  </div>
                )}
                </CollapsibleSection>
                <CollapsibleSection title="FACEMASK FINISH">
                <div style={{ display:'flex', gap:6 }}>
                  {['gloss','matte','chrome'].map(f => (
                    <button key={f} onClick={() => setFacemaskFinish(f)} style={{ flex:1, background:facemaskFinish===f?'rgba(239,255,0,0.1)':'rgba(255,255,255,0.04)', border:facemaskFinish===f?'1px solid rgba(239,255,0,0.4)':'1px solid rgba(255,255,255,0.08)', borderRadius:6, padding:'8px 4px', cursor:'pointer', fontSize:10, fontWeight:700, fontFamily:"'Barlow Condensed',sans-serif", color:facemaskFinish===f?'#efff00':'#9ca3af' }}>{f.toUpperCase()}</button>
                  ))}
                </div>
                </CollapsibleSection>
              </div>
            )}

            {/* DECALS */}
            {activeTab === 'decals' && (
              <div>
                <CollapsibleSection title="DECAL FINISH">
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
                  Applies to full wraps, helmet stripes, side logos, and bumper logos. Decals use their own finish and never inherit Shell glitter or Car Paint effects.
                </div>
                </CollapsibleSection>

                <CollapsibleSection title="FULL WRAP">
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
                </CollapsibleSection>

                <CollapsibleSection title="HELMET STRIPES">
                <div style={{ background:'rgba(255,255,255,0.035)', border:'1px solid rgba(255,255,255,0.09)', borderRadius:8, padding:10 }}>
                  <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:10 }}>
                    <div>
                      <div style={{ fontSize:11, fontWeight:800, color:'#d1d5db', fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:'0.04em' }}>PRESET STRIPE PATTERN</div>
                      <div style={{ fontSize:8, color:'#4b5563', marginTop:2 }}>Front → crown → back</div>
                    </div>
                    <button onClick={() => setHelmetStripesEnabled(v => !v)} style={{ background:helmetStripesEnabled?'rgba(239,255,0,0.12)':'rgba(255,255,255,0.04)', border:helmetStripesEnabled?'1px solid rgba(239,255,0,0.45)':'1px solid rgba(255,255,255,0.12)', borderRadius:20, padding:'4px 10px', cursor:'pointer', fontSize:8, fontWeight:800, fontFamily:"'Barlow Condensed',sans-serif", color:helmetStripesEnabled?'#efff00':'#6b7280', letterSpacing:'0.06em' }}>{helmetStripesEnabled?'ON':'OFF'}</button>
                  </div>

                  <div style={{ marginTop:10 }}>
                    <div style={{ fontSize:9, color:'#9ca3af', marginBottom:6 }}>Pattern</div>
                    <select value={helmetStripePreset} onChange={e => setHelmetStripePreset(e.target.value)} style={{ width:'100%', background:'rgba(0,0,0,0.22)', border:'1px solid rgba(255,255,255,0.12)', borderRadius:6, padding:'8px 10px', color:'#e5e7eb', fontSize:10, fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:'0.04em' }}>
                      {STRIPE_PRESET_OPTIONS.map(option => (
                        <option key={option.id} value={option.id}>{option.label}</option>
                      ))}
                    </select>
                  </div>

                  <div style={{ display:'flex', justifyContent:'center', alignItems:'center', gap:0, height:24, margin:'10px 0 8px', padding:'5px 0', background:'rgba(0,0,0,0.18)', borderRadius:5 }} aria-label="Helmet stripe preset preview">
                    {helmetStripePreset === 'single' && (
                      <div style={{ width:14, height:'100%', background:helmetStripeSingleColor, borderRadius:2 }} />
                    )}
                    {helmetStripePreset === 'threeEqual' && (
                      <>
                        <div style={{ width:10, height:'100%', background:helmetStripeOuterColor, borderRadius:'2px 0 0 2px' }} />
                        <div style={{ width:10, height:'100%', background:helmetStripeCenterColor }} />
                        <div style={{ width:10, height:'100%', background:helmetStripeOuterColor, borderRadius:'0 2px 2px 0' }} />
                      </>
                    )}
                    {helmetStripePreset === 'threeThickCenter' && (
                      <>
                        <div style={{ width:11, height:'100%', background:helmetStripeOuterColor, borderRadius:'2px 0 0 2px' }} />
                        <div style={{ width:20, height:'100%', background:helmetStripeCenterColor }} />
                        <div style={{ width:11, height:'100%', background:helmetStripeOuterColor, borderRadius:'0 2px 2px 0' }} />
                      </>
                    )}
                    {helmetStripePreset === 'fivePiped' && (
                      <>
                        <div style={{ width:12, height:'100%', background:helmetStripeOuterColor, borderRadius:'2px 0 0 2px' }} />
                        <div style={{ width:4, height:'100%', background:helmetStripePipingColor }} />
                        <div style={{ width:15, height:'100%', background:helmetStripeCenterColor }} />
                        <div style={{ width:4, height:'100%', background:helmetStripePipingColor }} />
                        <div style={{ width:12, height:'100%', background:helmetStripeOuterColor, borderRadius:'0 2px 2px 0' }} />
                      </>
                    )}
                  </div>

                  <div style={{ fontSize:9, color:'#6b7280', lineHeight:1.5 }}>
                    Choose a preset stripe layout and adjust its width, length, and colors. The supplied SVG defines the exact preset proportions and default colors, while the helmet renders those shapes procedurally in the shader for resolution-independent edges and no SVG loading overhead. Stripes remain above any full wrap and beneath the bumpers. Preset patterns are generated procedurally in the shader, while uploaded stripe artwork is rendered to a high-resolution GPU-aware texture for cleaner close-up edges.
                  </div>

                  <div style={{ display:'flex', alignItems:'center', gap:8, marginTop:10 }}>
                    <span style={{ width:56, flexShrink:0, fontSize:9, color:'#9ca3af' }}>Width</span>
                    <input type="range" min="70" max="220" value={Math.round(helmetStripeWidth*100)} onChange={e => setHelmetStripeWidth(parseInt(e.target.value)/100)} style={{ flex:1, minWidth:0 }} />
                  </div>
                  <div style={{ display:'flex', alignItems:'center', gap:8, marginTop:8 }}>
                    <span style={{ width:56, flexShrink:0, fontSize:9, color:'#9ca3af' }}>Length</span>
                    <input type="range" min="40" max="100" value={Math.round(helmetStripeLength*100)} onChange={e => setHelmetStripeLength(parseInt(e.target.value)/100)} style={{ flex:1, minWidth:0 }} />
                  </div>

                  <div style={{ height:1, background:'rgba(255,255,255,0.06)', margin:'12px 0 10px' }} />
                  <SectionLabel>Stripe Colors</SectionLabel>
                  {helmetStripePreset === 'single' ? (
                    <ColorSwatch color={helmetStripeSingleColor} onChange={setHelmetStripeSingleColor} label="Stripe" />
                  ) : (
                    <>
                      <ColorSwatch color={helmetStripeOuterColor} onChange={setHelmetStripeOuterColor} label="Outer Stripes" />
                      <ColorSwatch color={helmetStripeCenterColor} onChange={setHelmetStripeCenterColor} label="Inner Stripe" />
                      {helmetStripePreset === 'fivePiped' && (
                        <ColorSwatch color={helmetStripePipingColor} onChange={setHelmetStripePipingColor} label="Piping" />
                      )}
                    </>
                  )}

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
                </CollapsibleSection>

                <CollapsibleSection title="MAIN SIDE LOGOS">
                <div style={{ background:'rgba(255,255,255,0.02)', border:'1px solid rgba(255,255,255,0.04)', borderRadius:10, padding:12 }}>
                  <div style={{ fontSize:10, color:'#6b7280', lineHeight:1.5, marginBottom:8 }}>
                    Upload the main side logo decal. It automatically lands on both helmet sides, with the right side mirrored. You can hide either side, rotate either side 180°, or switch to fully independent left/right logo uploads.
                  </div>
                  <div style={{ fontSize:9, color:'#9ca3af', lineHeight:1.45, marginBottom:10, padding:'7px 8px', background:'rgba(239,255,0,0.04)', border:'1px solid rgba(239,255,0,0.12)', borderRadius:6 }}>
                    In the viewport: click a logo to select it, drag the logo to move it, drag a corner handle to scale, or hover just outside a corner until the rotate cursor appears and drag to rotate.
                  </div>
                  <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:8, marginBottom:10 }}>
                    <div style={{ fontSize:10, color:'#9ca3af' }}>Independent left / right logos</div>
                    <button onClick={() => { clearSideLogoUndoHistory(); setSideLogoIndependent(v => !v); }} style={{ background:sideLogoIndependent?'rgba(239,255,0,0.10)':'rgba(255,255,255,0.04)', border:sideLogoIndependent?'1px solid rgba(239,255,0,0.35)':'1px solid rgba(255,255,255,0.10)', borderRadius:6, padding:'5px 9px', cursor:'pointer', color:sideLogoIndependent?'#efff00':'#9ca3af', fontSize:9, fontWeight:800, fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:'0.06em' }}>{sideLogoIndependent?'ON':'OFF'}</button>
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
                        <label htmlFor="side-logo-left-upload" style={{ display:'flex', alignItems:'center', justifyContent:'center', width:'100%', boxSizing:'border-box', background:'rgba(239,255,0,0.08)', border:'1px dashed rgba(239,255,0,0.35)', borderRadius:7, padding:'9px 10px', cursor:'pointer', fontSize:9, fontWeight:800, fontFamily:"'Barlow Condensed',sans-serif", color:'#efff00', letterSpacing:'0.06em' }}>UPLOAD RIGHT</label>
                        {sideLogoLeftPreviewUrl && (
                          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:6, marginTop:8 }}>
                            <div style={{ fontSize:8, color:'#9ca3af', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }} title={sideLogoLeftFileName}>{sideLogoLeftFileName}</div>
                            <button onClick={() => removeSideLogoUpload('left')} style={{ background:'rgba(239,68,68,0.08)', border:'1px solid rgba(239,68,68,0.25)', borderRadius:5, padding:'3px 6px', cursor:'pointer', color:'#ef4444', fontSize:8, fontWeight:700, fontFamily:"'Barlow Condensed',sans-serif" }}>✕</button>
                          </div>
                        )}
                      </div>
                      <div>
                        <label htmlFor="side-logo-right-upload" style={{ display:'flex', alignItems:'center', justifyContent:'center', width:'100%', boxSizing:'border-box', background:'rgba(239,255,0,0.08)', border:'1px dashed rgba(239,255,0,0.35)', borderRadius:7, padding:'9px 10px', cursor:'pointer', fontSize:9, fontWeight:800, fontFamily:"'Barlow Condensed',sans-serif", color:'#efff00', letterSpacing:'0.06em' }}>UPLOAD LEFT</label>
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
                      { side:'left', title:'RIGHT SIDE', preview: sideLogoIndependent ? sideLogoLeftPreviewUrl : sideLogoSharedPreviewUrl, visible: sideLogoLeftVisible, setVisible: setSideLogoLeftVisible, mirrored: sideLogoLeftMirror, setMirrored: setSideLogoLeftMirror, rotated: sideLogoLeftRotate180, setRotated: setSideLogoLeftRotate180 },
                      { side:'right', title:'LEFT SIDE', preview: sideLogoIndependent ? sideLogoRightPreviewUrl : sideLogoSharedPreviewUrl, visible: sideLogoRightVisible, setVisible: setSideLogoRightVisible, mirrored: sideLogoRightMirror, setMirrored: setSideLogoRightMirror, rotated: sideLogoRightRotate180, setRotated: setSideLogoRightRotate180 },
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

                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:8 }}>
                    <button
                      onClick={undoSideLogoMove}
                      disabled={sideLogoUndoCount === 0}
                      style={{
                        width:'100%',
                        background:sideLogoUndoCount > 0 ? 'rgba(239,255,0,0.08)' : 'rgba(255,255,255,0.025)',
                        border:sideLogoUndoCount > 0 ? '1px solid rgba(239,255,0,0.24)' : '1px solid rgba(255,255,255,0.06)',
                        borderRadius:6,
                        padding:'7px 8px',
                        cursor:sideLogoUndoCount > 0 ? 'pointer' : 'default',
                        color:sideLogoUndoCount > 0 ? '#efff00' : '#4b5563',
                        fontSize:9,
                        fontWeight:800,
                        fontFamily:"'Barlow Condensed',sans-serif",
                        letterSpacing:'0.05em'
                      }}
                    >
                      ↶ UNDO MOVE
                    </button>
                    <button onClick={() => setSideLogoLocked(v => !v)} style={{ width:'100%', background:sideLogoLocked?'rgba(239,255,0,0.10)':'rgba(255,255,255,0.04)', border:sideLogoLocked?'1px solid rgba(239,255,0,0.35)':'1px solid rgba(255,255,255,0.10)', borderRadius:6, padding:'7px 8px', cursor:'pointer', color:sideLogoLocked?'#efff00':'#9ca3af', fontSize:9, fontWeight:800, fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:'0.05em' }}>{sideLogoLocked ? 'LOCKED' : 'UNLOCKED'}</button>
                  </div>
                  <button
                    onClick={() => {
                      clearSideLogoUndoHistory();
                      sideLogoPlacementRef.current.left = cloneDefaultSideLogoPlacement();
                      sideLogoPlacementRef.current.right = cloneDefaultSideLogoPlacement();
                      setSelectedSideLogo(null);
                      selectedSideLogoRef.current = null;
                      setSideLogoRevision(v => v + 1);
                    }}
                    style={{ width:'100%', marginBottom:10, background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.10)', borderRadius:6, padding:'7px 8px', cursor:'pointer', color:'#9ca3af', fontSize:9, fontWeight:800, fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:'0.05em' }}
                  >
                    RESET POSITIONS
                  </button>

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
                </CollapsibleSection>

                <CollapsibleSection title="REAR STICKERS">
                  <div style={{ fontSize:10, color:'#6b7280', lineHeight:1.5, marginBottom:10 }}>
                    Add common rear-shell stickers or upload your own. Click a sticker on the helmet to select it, drag to move, use the corner handles to scale/rotate, then lock it when placed. Sliders remain available for precise adjustments.
                  </div>

                  {rearStickerError && (
                    <div style={{ marginBottom:10, fontSize:10, color:'#ef4444', lineHeight:1.4 }}>{rearStickerError}</div>
                  )}

                  <div style={{ background:'rgba(255,255,255,0.02)', border:'1px solid rgba(255,255,255,0.05)', borderRadius:8, padding:9, marginBottom:9 }}>
                    <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:8, marginBottom:8 }}>
                      <div style={{ fontSize:9, fontWeight:800, color:'#9ca3af', letterSpacing:'0.07em' }}>US FLAG</div>
                      <button onClick={() => setRearFlagEnabled(v => !v)} style={{ background:rearFlagEnabled?'rgba(239,255,0,0.10)':'rgba(255,255,255,0.04)', border:rearFlagEnabled?'1px solid rgba(239,255,0,0.35)':'1px solid rgba(255,255,255,0.10)', borderRadius:5, padding:'4px 7px', cursor:'pointer', color:rearFlagEnabled?'#efff00':'#9ca3af', fontSize:8, fontWeight:800, fontFamily:"'Barlow Condensed',sans-serif" }}>{rearFlagEnabled?'ON':'OFF'}</button>
                    </div>
                    <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6, marginBottom:8 }}>
                      <button onClick={() => undoEditableDecalMove('rear-flag')} disabled={!editableDecalUndoCounts['rear-flag']} style={{ background:editableDecalUndoCounts['rear-flag']?'rgba(239,255,0,0.08)':'rgba(255,255,255,0.025)', border:editableDecalUndoCounts['rear-flag']?'1px solid rgba(239,255,0,0.24)':'1px solid rgba(255,255,255,0.06)', borderRadius:5, padding:'5px 6px', cursor:editableDecalUndoCounts['rear-flag']?'pointer':'default', color:editableDecalUndoCounts['rear-flag']?'#efff00':'#4b5563', fontSize:8, fontWeight:800 }}>↶ UNDO MOVE</button>
                      <button onClick={() => setRearFlagLocked(v => !v)} style={{ background:rearFlagLocked?'rgba(239,255,0,0.10)':'rgba(255,255,255,0.04)', border:rearFlagLocked?'1px solid rgba(239,255,0,0.35)':'1px solid rgba(255,255,255,0.10)', borderRadius:5, padding:'5px 6px', cursor:'pointer', color:rearFlagLocked?'#efff00':'#9ca3af', fontSize:8, fontWeight:800 }}>{rearFlagLocked?'LOCKED':'UNLOCKED'}</button>
                    </div>
                    <div style={{ width:'100%', aspectRatio:'3 / 1', display:'flex', alignItems:'center', justifyContent:'center', overflow:'hidden', borderRadius:6, border:'1px solid rgba(255,255,255,0.08)', background:'#c8cdd4', marginBottom:8 }}>
                      <img src={REAR_FLAG_URL} alt="US flag rear sticker" style={{ width:'100%', height:'100%', objectFit:'contain', opacity:rearFlagEnabled?1:0.4 }} />
                    </div>
                    {[
                      ['Size', rearFlagScale, setRearFlagScale, 40, 500, v => v / 100, v => Math.round(v * 100)],
                      ['Rotate', rearFlagRotation, setRearFlagRotation, -180, 180, v => v, v => v],
                      ['Across', rearFlagAcross, setRearFlagAcross, -80, 80, v => v, v => v],
                      ['Up / Down', rearFlagVertical, setRearFlagVertical, -80, 80, v => v, v => v],
                    ].map(([label,value,setter,min,max,fromSlider,toSlider]) => (
                      <div key={`flag-${label}`} style={{ display:'flex', alignItems:'center', gap:8, marginBottom:7 }}>
                        <span style={{ width:54, flexShrink:0, fontSize:9, color:'#9ca3af' }}>{label}</span>
                        <input type="range" min={min} max={max} value={toSlider(value)} onChange={e => setter(fromSlider(parseInt(e.target.value)))} style={{ flex:1, minWidth:0 }} />
                      </div>
                    ))}
                  </div>

                  <div style={{ background:'rgba(255,255,255,0.02)', border:'1px solid rgba(255,255,255,0.05)', borderRadius:8, padding:9, marginBottom:9 }}>
                    <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:8, marginBottom:8 }}>
                      <div style={{ fontSize:9, fontWeight:800, color:'#9ca3af', letterSpacing:'0.07em' }}>WARNING LABEL</div>
                      <button onClick={() => setRearWarningEnabled(v => !v)} style={{ background:rearWarningEnabled?'rgba(239,255,0,0.10)':'rgba(255,255,255,0.04)', border:rearWarningEnabled?'1px solid rgba(239,255,0,0.35)':'1px solid rgba(255,255,255,0.10)', borderRadius:5, padding:'4px 7px', cursor:'pointer', color:rearWarningEnabled?'#efff00':'#9ca3af', fontSize:8, fontWeight:800, fontFamily:"'Barlow Condensed',sans-serif" }}>{rearWarningEnabled?'ON':'OFF'}</button>
                    </div>
                    <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6, marginBottom:8 }}>
                      <button onClick={() => undoEditableDecalMove('rear-warning')} disabled={!editableDecalUndoCounts['rear-warning']} style={{ background:editableDecalUndoCounts['rear-warning']?'rgba(239,255,0,0.08)':'rgba(255,255,255,0.025)', border:editableDecalUndoCounts['rear-warning']?'1px solid rgba(239,255,0,0.24)':'1px solid rgba(255,255,255,0.06)', borderRadius:5, padding:'5px 6px', cursor:editableDecalUndoCounts['rear-warning']?'pointer':'default', color:editableDecalUndoCounts['rear-warning']?'#efff00':'#4b5563', fontSize:8, fontWeight:800 }}>↶ UNDO MOVE</button>
                      <button onClick={() => setRearWarningLocked(v => !v)} style={{ background:rearWarningLocked?'rgba(239,255,0,0.10)':'rgba(255,255,255,0.04)', border:rearWarningLocked?'1px solid rgba(239,255,0,0.35)':'1px solid rgba(255,255,255,0.10)', borderRadius:5, padding:'5px 6px', cursor:'pointer', color:rearWarningLocked?'#efff00':'#9ca3af', fontSize:8, fontWeight:800 }}>{rearWarningLocked?'LOCKED':'UNLOCKED'}</button>
                    </div>
                    <div style={{ width:'100%', aspectRatio:'3 / 1', position:'relative', overflow:'hidden', borderRadius:6, border:'1px solid rgba(255,255,255,0.08)', background:'#c8cdd4', marginBottom:8 }}>
                      <div style={{
                        position:'absolute',
                        inset:'12%',
                        background:rearWarningColor,
                        WebkitMaskImage:`url(${REAR_WARNING_URL})`,
                        WebkitMaskRepeat:'no-repeat',
                        WebkitMaskPosition:'center',
                        WebkitMaskSize:'contain',
                        maskImage:`url(${REAR_WARNING_URL})`,
                        maskRepeat:'no-repeat',
                        maskPosition:'center',
                        maskSize:'contain',
                        opacity:rearWarningEnabled?1:0.4
                      }} />
                    </div>
                    <ColorSwatch color={rearWarningColor} onChange={setRearWarningColor} label="Label Color" />
                    {[
                      ['Size', rearWarningScale, setRearWarningScale, 40, 500, v => v / 100, v => Math.round(v * 100)],
                      ['Rotate', rearWarningRotation, setRearWarningRotation, -180, 180, v => v, v => v],
                      ['Across', rearWarningAcross, setRearWarningAcross, -80, 80, v => v, v => v],
                      ['Up / Down', rearWarningVertical, setRearWarningVertical, -80, 80, v => v, v => v],
                    ].map(([label,value,setter,min,max,fromSlider,toSlider]) => (
                      <div key={`warning-${label}`} style={{ display:'flex', alignItems:'center', gap:8, marginBottom:7 }}>
                        <span style={{ width:54, flexShrink:0, fontSize:9, color:'#9ca3af' }}>{label}</span>
                        <input type="range" min={min} max={max} value={toSlider(value)} onChange={e => setter(fromSlider(parseInt(e.target.value)))} style={{ flex:1, minWidth:0 }} />
                      </div>
                    ))}
                  </div>

                  <div style={{ background:'rgba(255,255,255,0.02)', border:'1px solid rgba(255,255,255,0.05)', borderRadius:8, padding:9 }}>
                    <div style={{ fontSize:9, fontWeight:800, color:'#9ca3af', letterSpacing:'0.07em', marginBottom:8 }}>CUSTOM REAR STICKER</div>
                    <input id="rear-custom-sticker-upload" type="file" accept="image/png,image/jpeg,image/webp" onChange={handleRearCustomStickerUpload} style={{ display:'none' }} />
                    <label htmlFor="rear-custom-sticker-upload" style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:6, width:'100%', boxSizing:'border-box', background:'rgba(239,255,0,0.07)', border:'1px dashed rgba(239,255,0,0.30)', borderRadius:6, padding:'8px 9px', cursor:'pointer', color:'#efff00', fontSize:9, fontWeight:800, fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:'0.05em' }}>
                      <span>＋</span>{rearCustomPreviewUrl ? 'REPLACE STICKER' : 'UPLOAD STICKER'}
                    </label>

                    {rearCustomPreviewUrl && (
                      <>
                        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:7, marginTop:7, marginBottom:8 }}>
                          <div style={{ fontSize:8, color:'#9ca3af', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }} title={rearCustomFileName}>{rearCustomFileName}</div>
                          <div style={{ display:'flex', alignItems:'center', gap:5 }}>
                            <button onClick={() => setRearCustomEnabled(v => !v)} style={{ background:rearCustomEnabled?'rgba(239,255,0,0.10)':'rgba(255,255,255,0.04)', border:rearCustomEnabled?'1px solid rgba(239,255,0,0.35)':'1px solid rgba(255,255,255,0.10)', borderRadius:5, padding:'3px 6px', cursor:'pointer', color:rearCustomEnabled?'#efff00':'#9ca3af', fontSize:8, fontWeight:800 }}>{rearCustomEnabled?'ON':'OFF'}</button>
                            <button onClick={removeRearCustomSticker} style={{ background:'rgba(239,68,68,0.08)', border:'1px solid rgba(239,68,68,0.25)', borderRadius:5, padding:'3px 6px', cursor:'pointer', color:'#ef4444', fontSize:8, fontWeight:700 }}>REMOVE</button>
                          </div>
                        </div>
                        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6, marginBottom:8 }}>
                          <button onClick={() => undoEditableDecalMove('rear-custom')} disabled={!editableDecalUndoCounts['rear-custom']} style={{ background:editableDecalUndoCounts['rear-custom']?'rgba(239,255,0,0.08)':'rgba(255,255,255,0.025)', border:editableDecalUndoCounts['rear-custom']?'1px solid rgba(239,255,0,0.24)':'1px solid rgba(255,255,255,0.06)', borderRadius:5, padding:'5px 6px', cursor:editableDecalUndoCounts['rear-custom']?'pointer':'default', color:editableDecalUndoCounts['rear-custom']?'#efff00':'#4b5563', fontSize:8, fontWeight:800 }}>↶ UNDO MOVE</button>
                          <button onClick={() => setRearCustomLocked(v => !v)} style={{ background:rearCustomLocked?'rgba(239,255,0,0.10)':'rgba(255,255,255,0.04)', border:rearCustomLocked?'1px solid rgba(239,255,0,0.35)':'1px solid rgba(255,255,255,0.10)', borderRadius:5, padding:'5px 6px', cursor:'pointer', color:rearCustomLocked?'#efff00':'#9ca3af', fontSize:8, fontWeight:800 }}>{rearCustomLocked?'LOCKED':'UNLOCKED'}</button>
                        </div>
                        <div style={{ width:'100%', aspectRatio:'3 / 1', display:'flex', alignItems:'center', justifyContent:'center', overflow:'hidden', borderRadius:6, border:'1px solid rgba(255,255,255,0.08)', backgroundColor:'#c8cdd4', backgroundImage:'linear-gradient(45deg, rgba(255,255,255,0.95) 25%, transparent 25%, transparent 75%, rgba(255,255,255,0.95) 75%, rgba(255,255,255,0.95)), linear-gradient(45deg, rgba(255,255,255,0.95) 25%, transparent 25%, transparent 75%, rgba(255,255,255,0.95) 75%, rgba(255,255,255,0.95))', backgroundSize:'14px 14px', backgroundPosition:'0 0, 7px 7px', marginBottom:8 }}>
                          <img src={rearCustomPreviewUrl} alt="Custom rear sticker preview" style={{ width:'100%', height:'100%', objectFit:'contain', opacity:rearCustomEnabled?1:0.4 }} />
                        </div>
                        {[
                          ['Size', rearCustomScale, setRearCustomScale, 40, 800, v => v / 100, v => Math.round(v * 100)],
                          ['Rotate', rearCustomRotation, setRearCustomRotation, -180, 180, v => v, v => v],
                          ['Across', rearCustomAcross, setRearCustomAcross, -80, 80, v => v, v => v],
                          ['Up / Down', rearCustomVertical, setRearCustomVertical, -80, 80, v => v, v => v],
                        ].map(([label,value,setter,min,max,fromSlider,toSlider]) => (
                          <div key={`custom-${label}`} style={{ display:'flex', alignItems:'center', gap:8, marginBottom:7 }}>
                            <span style={{ width:54, flexShrink:0, fontSize:9, color:'#9ca3af' }}>{label}</span>
                            <input type="range" min={min} max={max} value={toSlider(value)} onChange={e => setter(fromSlider(parseInt(e.target.value)))} style={{ flex:1, minWidth:0 }} />
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                </CollapsibleSection>

                <CollapsibleSection title="BUMPER LOGOS">
                  <div style={{ fontSize:10, color:'#6b7280', lineHeight:1.5, marginBottom:10 }}>
                    Add independent logos to the front and rear bumpers. Click a logo on the helmet to select it, drag to move, and use the corner handles to scale/rotate. Lock it when placed; Undo Move restores the previous direct-manipulation position. Sliders remain available for precision. Rear wordmarks retain the Curve correction for curved bumper geometry.
                  </div>
                  {bumperLogoError && <div style={{ marginBottom:10, fontSize:10, color:'#ef4444', lineHeight:1.4 }}>{bumperLogoError}</div>}
                  <SectionLabel>Bumper Logo Finish</SectionLabel>
                  <div style={{ display:'grid', gridTemplateColumns:'repeat(4, minmax(0,1fr))', gap:6, marginBottom:10 }}>
                    {DECAL_FINISHES.map(f => (
                      <button
                        key={`bumper-finish-${f.id}`}
                        onClick={() => setBumperLogoFinish(f.id)}
                        style={{
                          background: bumperLogoFinish===f.id ? 'rgba(239,255,0,0.10)' : 'rgba(255,255,255,0.04)',
                          border: bumperLogoFinish===f.id ? '1px solid rgba(239,255,0,0.35)' : '1px solid rgba(255,255,255,0.10)',
                          borderRadius: 6,
                          padding:'7px 4px',
                          cursor:'pointer',
                          color: bumperLogoFinish===f.id ? '#efff00' : '#9ca3af',
                          fontSize:9,
                          fontWeight:800,
                          fontFamily:"'Barlow Condensed',sans-serif",
                          letterSpacing:'0.06em'
                        }}
                      >{f.label}</button>
                    ))}
                  </div>
                  <input id="front-bumper-logo-upload" type="file" accept="image/png,image/jpeg" onChange={handleFrontBumperLogoUpload} style={{ display:'none' }} />
                  <input id="rear-bumper-logo-upload" type="file" accept="image/png,image/jpeg" onChange={handleRearBumperLogoUpload} style={{ display:'none' }} />

                  {[
                    {
                      slot:'front', title:'FRONT BUMPER', inputId:'front-bumper-logo-upload', preview:bumperLogoFrontPreviewUrl, fileName:bumperLogoFrontFileName,
                      scale:bumperLogoFrontScale, setScale:setBumperLogoFrontScale, rotation:bumperLogoFrontRotation, setRotation:setBumperLogoFrontRotation,
                      across:bumperLogoFrontAcross, setAcross:setBumperLogoFrontAcross, vertical:bumperLogoFrontVertical, setVertical:setBumperLogoFrontVertical,
                      locked:bumperLogoFrontLocked, setLocked:setBumperLogoFrontLocked, undoCount:editableDecalUndoCounts['bumper-front'],
                    },
                    {
                      slot:'rear', title:'REAR BUMPER', inputId:'rear-bumper-logo-upload', preview:bumperLogoRearPreviewUrl, fileName:bumperLogoRearFileName,
                      scale:bumperLogoRearScale, setScale:setBumperLogoRearScale, rotation:bumperLogoRearRotation, setRotation:setBumperLogoRearRotation,
                      across:bumperLogoRearAcross, setAcross:setBumperLogoRearAcross, vertical:bumperLogoRearVertical, setVertical:setBumperLogoRearVertical,
                      locked:bumperLogoRearLocked, setLocked:setBumperLogoRearLocked, undoCount:editableDecalUndoCounts['bumper-rear'],
                    },
                  ].map(item => (
                    <div key={item.slot} style={{ background:'rgba(255,255,255,0.02)', border:'1px solid rgba(255,255,255,0.05)', borderRadius:8, padding:9, marginBottom:9 }}>
                      <div style={{ fontSize:9, fontWeight:800, color:'#9ca3af', letterSpacing:'0.07em', marginBottom:7 }}>{item.title}</div>
                      <label htmlFor={item.inputId} style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:6, width:'100%', boxSizing:'border-box', background:'rgba(239,255,0,0.07)', border:'1px dashed rgba(239,255,0,0.30)', borderRadius:6, padding:'8px 9px', cursor:'pointer', color:'#efff00', fontSize:9, fontWeight:800, fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:'0.05em' }}>
                        <span>＋</span>{item.preview ? 'REPLACE LOGO' : 'UPLOAD LOGO'}
                      </label>
                      {item.preview && (
                        <>
                          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:7, marginTop:7, marginBottom:8 }}>
                            <div style={{ fontSize:8, color:'#9ca3af', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }} title={item.fileName}>{item.fileName}</div>
                            <button onClick={() => removeBumperLogo(item.slot)} style={{ background:'rgba(239,68,68,0.08)', border:'1px solid rgba(239,68,68,0.25)', borderRadius:5, padding:'3px 6px', cursor:'pointer', color:'#ef4444', fontSize:8, fontWeight:700 }}>REMOVE</button>
                          </div>
                          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6, marginBottom:8 }}>
                            <button onClick={() => undoEditableDecalMove(`bumper-${item.slot}`)} disabled={!item.undoCount} style={{ background:item.undoCount?'rgba(239,255,0,0.08)':'rgba(255,255,255,0.025)', border:item.undoCount?'1px solid rgba(239,255,0,0.24)':'1px solid rgba(255,255,255,0.06)', borderRadius:5, padding:'5px 6px', cursor:item.undoCount?'pointer':'default', color:item.undoCount?'#efff00':'#4b5563', fontSize:8, fontWeight:800 }}>↶ UNDO MOVE</button>
                            <button onClick={() => item.setLocked(v => !v)} style={{ background:item.locked?'rgba(239,255,0,0.10)':'rgba(255,255,255,0.04)', border:item.locked?'1px solid rgba(239,255,0,0.35)':'1px solid rgba(255,255,255,0.10)', borderRadius:5, padding:'5px 6px', cursor:'pointer', color:item.locked?'#efff00':'#9ca3af', fontSize:8, fontWeight:800 }}>{item.locked?'LOCKED':'UNLOCKED'}</button>
                          </div>
                          <div style={{ position:'relative', width:'100%', aspectRatio:'3 / 1', overflow:'hidden', borderRadius:6, border:'1px solid rgba(255,255,255,0.08)', backgroundColor:'#c8cdd4', backgroundImage:'linear-gradient(45deg, rgba(255,255,255,0.95) 25%, transparent 25%, transparent 75%, rgba(255,255,255,0.95) 75%, rgba(255,255,255,0.95)), linear-gradient(45deg, rgba(255,255,255,0.95) 25%, transparent 25%, transparent 75%, rgba(255,255,255,0.95) 75%, rgba(255,255,255,0.95))', backgroundSize:'14px 14px', backgroundPosition:'0 0, 7px 7px', marginBottom:8 }}>
                            <img src={item.preview} alt={`${item.title} logo preview`} style={{ width:'100%', height:'100%', objectFit:'contain' }} />
                          </div>
                          <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:7 }}>
                            <span style={{ width:50, flexShrink:0, fontSize:9, color:'#9ca3af' }}>Size</span>
                            <input type="range" min="100" max="2400" defaultValue={Math.round(item.scale*100)} onInput={e => queueBumperSliderUpdate(`${item.slot}-scale`, item.setScale, parseInt(e.currentTarget.value)/100)} onPointerUp={e => item.setScale(parseInt(e.currentTarget.value)/100)} style={{ flex:1, minWidth:0 }} />
                          </div>
                          <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:7 }}>
                            <span style={{ width:50, flexShrink:0, fontSize:9, color:'#9ca3af' }}>Rotate</span>
                            <input type="range" min="-180" max="180" defaultValue={item.rotation} onInput={e => queueBumperSliderUpdate(`${item.slot}-rotation`, item.setRotation, parseInt(e.currentTarget.value))} onPointerUp={e => item.setRotation(parseInt(e.currentTarget.value))} style={{ flex:1, minWidth:0 }} />
                          </div>
                          <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:7 }}>
                            <span style={{ width:50, flexShrink:0, fontSize:9, color:'#9ca3af' }}>Across</span>
                            <input type="range" min="-80" max="80" defaultValue={item.across} onInput={e => queueBumperSliderUpdate(`${item.slot}-across`, item.setAcross, parseInt(e.currentTarget.value))} onPointerUp={e => item.setAcross(parseInt(e.currentTarget.value))} style={{ flex:1, minWidth:0 }} />
                          </div>
                          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                            <span style={{ width:50, flexShrink:0, fontSize:9, color:'#9ca3af' }}>Up / Down</span>
                            <input type="range" min="-80" max="80" defaultValue={item.vertical} onInput={e => queueBumperSliderUpdate(`${item.slot}-vertical`, item.setVertical, parseInt(e.currentTarget.value))} onPointerUp={e => item.setVertical(parseInt(e.currentTarget.value))} style={{ flex:1, minWidth:0 }} />
                          </div>
                          {item.slot === 'rear' && (
                            <div style={{ display:'flex', alignItems:'center', gap:8, marginTop:7 }}>
                              <span style={{ width:50, flexShrink:0, fontSize:9, color:'#9ca3af' }}>Curve</span>
                              <input type="range" min="-260" max="120" defaultValue={bumperLogoRearCurve} onInput={e => queueBumperSliderUpdate('rear-curve', setBumperLogoRearCurve, parseInt(e.currentTarget.value))} onPointerUp={e => setBumperLogoRearCurve(parseInt(e.currentTarget.value))} style={{ flex:1, minWidth:0 }} />
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  ))}
                </CollapsibleSection>
              </div>
            )}
          </div>


        </div>

        {/* 3D VIEWPORT */}
        <div style={{ position: 'relative', overflow: 'hidden', background: transparentBg ? 'transparent' : viewportBgColor, backgroundImage: transparentBg ? 'linear-gradient(45deg, rgba(255,255,255,0.06) 25%, transparent 25%, transparent 75%, rgba(255,255,255,0.06) 75%, rgba(255,255,255,0.06)), linear-gradient(45deg, rgba(255,255,255,0.06) 25%, transparent 25%, transparent 75%, rgba(255,255,255,0.06) 75%, rgba(255,255,255,0.06))' : 'none', backgroundSize: transparentBg ? '24px 24px' : 'auto', backgroundPosition: transparentBg ? '0 0, 12px 12px' : '0 0' }}>
          <div ref={mountRef} style={{ width: '100%', height: '100%' }} />

          {/* Loading overlay */}
          {!loaded && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: transparentBg ? 'rgba(22,19,20,0.82)' : viewportBgColor }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 32, marginBottom: 12 }}>🏈</div>
                <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, fontSize: 14, color: '#6b7280', letterSpacing: '0.1em' }}>LOADING HELMET...</div>
              </div>
            </div>
          )}

          {debugMode && (
            <div style={{
              position:'absolute',
              top:16,
              left:16,
              zIndex:25,
              width:285,
              maxWidth:'calc(100% - 32px)',
              background:'rgba(8,8,9,0.92)',
              border:'1px solid rgba(239,255,0,0.28)',
              borderRadius:10,
              padding:'10px 11px',
              boxShadow:'0 12px 30px rgba(0,0,0,0.28)',
              backdropFilter:'blur(8px)',
              fontFamily:"'Barlow Condensed',sans-serif",
              pointerEvents:'auto'
            }}>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:8, marginBottom:8 }}>
                <div>
                  <div style={{ fontSize:9, color:'#efff00', fontWeight:900, letterSpacing:'0.12em' }}>DEBUG MODE · v83 · AUTH HARDENED</div>
                  <div style={{ fontSize:8, color:'#6b7280', marginTop:2 }}>Live renderer + asset timing · Ctrl+Shift+D toggles</div>
                </div>
                <button
                  onClick={copyDebugReport}
                  style={{ background:'rgba(239,255,0,0.08)', border:'1px solid rgba(239,255,0,0.25)', borderRadius:5, padding:'5px 7px', color:'#efff00', cursor:'pointer', fontSize:8, fontWeight:800, fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:'0.06em' }}
                >
                  COPY REPORT
                </button>
              </div>

              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'4px 12px', fontSize:9, lineHeight:1.35 }}>
                <span style={{ color:'#6b7280' }}>FPS</span><span style={{ color:debugStats.fps >= 50 ? '#10b981' : debugStats.fps >= 30 ? '#efff00' : '#ef4444', textAlign:'right' }}>{Number(debugStats.fps || 0).toFixed(1)}</span>
                <span style={{ color:'#6b7280' }}>Draw Calls</span><span style={{ color:'#d1d5db', textAlign:'right' }}>{formatDebugCount(debugStats.drawCalls)}</span>
                <span style={{ color:'#6b7280' }}>Visible Tris</span><span style={{ color:'#d1d5db', textAlign:'right' }}>{formatDebugCount(debugStats.visibleTriangles)}</span>
                <span style={{ color:'#6b7280' }}>GPU Textures</span><span style={{ color:'#d1d5db', textAlign:'right' }}>{formatDebugCount(debugStats.textures)}</span>
                <span style={{ color:'#6b7280' }}>Geometries</span><span style={{ color:'#d1d5db', textAlign:'right' }}>{formatDebugCount(debugStats.geometries)}</span>
                <span style={{ color:'#6b7280' }}>Programs</span><span style={{ color:'#d1d5db', textAlign:'right' }}>{formatDebugCount(debugStats.programs)}</span>
                <span style={{ color:'#6b7280' }}>Viewport</span><span style={{ color:'#d1d5db', textAlign:'right' }}>{debugStats.cssSize}</span>
                <span style={{ color:'#6b7280' }}>Buffer / DPR</span><span style={{ color:'#d1d5db', textAlign:'right' }}>{debugStats.bufferSize} / {Number(debugStats.dpr || 1).toFixed(2)}</span>
              </div>

              <div style={{ height:1, background:'rgba(255,255,255,0.07)', margin:'8px 0' }} />

              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'4px 12px', fontSize:9, lineHeight:1.35 }}>
                <span style={{ color:'#6b7280' }}>GLB Triangles</span><span style={{ color:'#d1d5db', textAlign:'right' }}>{formatDebugCount(debugStats.modelTriangles)}</span>
                <span style={{ color:'#6b7280' }}>GLB Transfer</span><span style={{ color:'#d1d5db', textAlign:'right' }}>{formatDebugBytes(debugStats.glbBytesTotal || debugStats.glbBytesLoaded)}</span>
                <span style={{ color:'#6b7280' }}>Download</span><span style={{ color:'#d1d5db', textAlign:'right' }}>{formatDebugMs(debugStats.glbDownloadMs)}</span>
                <span style={{ color:'#6b7280' }}>Parse</span><span style={{ color:'#d1d5db', textAlign:'right' }}>{formatDebugMs(debugStats.glbParseMs)}</span>
                <span style={{ color:'#6b7280' }}>Builder Setup</span><span style={{ color:'#d1d5db', textAlign:'right' }}>{formatDebugMs(debugStats.builderSetupMs)}</span>
                <span style={{ color:'#6b7280' }}>Interactive</span><span style={{ color:'#d1d5db', textAlign:'right' }}>{formatDebugMs(debugStats.interactiveMs)}</span>
                <span style={{ color:'#6b7280' }}>First Render</span><span style={{ color:'#d1d5db', textAlign:'right' }}>{formatDebugMs(debugStats.firstRenderMs)}</span>
              </div>

              <div style={{ height:1, background:'rgba(255,255,255,0.07)', margin:'8px 0' }} />

              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'4px 12px', fontSize:9, lineHeight:1.35 }}>
                <span style={{ color:'#6b7280' }}>HDRI</span><span style={{ color:'#d1d5db', textAlign:'right', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }} title={debugStats.hdriName}>{debugStats.hdriName}{debugStats.hdriCacheHit ? ' ⚡' : ''}</span>
                <span style={{ color:'#6b7280' }}>HDRI Transfer</span><span style={{ color:'#d1d5db', textAlign:'right' }}>{formatDebugBytes(debugStats.hdriBytesTotal || debugStats.hdriBytesLoaded)}</span>
                <span style={{ color:'#6b7280' }}>HDRI Download</span><span style={{ color:'#d1d5db', textAlign:'right' }}>{formatDebugMs(debugStats.hdriDownloadMs)}</span>
                <span style={{ color:'#6b7280' }}>EXR Decode</span><span style={{ color:'#d1d5db', textAlign:'right' }}>{formatDebugMs(debugStats.hdriDecodeMs)}</span>
                <span style={{ color:'#6b7280' }}>PMREM</span><span style={{ color:'#d1d5db', textAlign:'right' }}>{formatDebugMs(debugStats.hdriPmremMs)}</span>
                <span style={{ color:'#6b7280' }}>HDRI Ready</span><span style={{ color:'#d1d5db', textAlign:'right' }}>{formatDebugMs(debugStats.hdriReadyMs)}</span>
              </div>

              <div style={{ height:1, background:'rgba(255,255,255,0.07)', margin:'8px 0' }} />

              <div style={{ fontSize:8, color:'#efff00', fontWeight:900, letterSpacing:'0.1em', marginBottom:5 }}>LAST EXPORT</div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'4px 12px', fontSize:9, lineHeight:1.35 }}>
                <span style={{ color:'#6b7280' }}>Requested</span><span style={{ color:'#d1d5db', textAlign:'right' }}>{debugStats.exportRequestedResolution ? `${debugStats.exportRequestedResolution}px @ ${debugStats.exportRequestedSupersample}×` : '—'}</span>
                <span style={{ color:'#6b7280' }}>Actual</span><span style={{ color:debugStats.exportWasReduced ? '#efff00' : '#d1d5db', textAlign:'right' }}>{debugStats.exportActualSupersample ? `${debugStats.exportActualSupersample}×${debugStats.exportWasReduced ? ' AUTO' : ''}` : '—'}</span>
                <span style={{ color:'#6b7280' }}>Final PNG</span><span style={{ color:'#d1d5db', textAlign:'right' }}>{debugStats.exportFinalSize}</span>
                <span style={{ color:'#6b7280' }}>Render Buffer</span><span style={{ color:'#d1d5db', textAlign:'right' }}>{debugStats.exportRenderSize}</span>
                <span style={{ color:'#6b7280' }}>GPU Max Texture</span><span style={{ color:'#d1d5db', textAlign:'right' }}>{formatDebugCount(debugStats.exportMaxTextureSize)}</span>
                <span style={{ color:'#6b7280' }}>GPU Max RBO</span><span style={{ color:'#d1d5db', textAlign:'right' }}>{formatDebugCount(debugStats.exportMaxRenderbufferSize)}</span>
                <span style={{ color:'#6b7280' }}>Render</span><span style={{ color:'#d1d5db', textAlign:'right' }}>{formatDebugMs(debugStats.exportRenderMs)}</span>
                <span style={{ color:'#6b7280' }}>Downsample</span><span style={{ color:'#d1d5db', textAlign:'right' }}>{formatDebugMs(debugStats.exportDownsampleMs)}</span>
                <span style={{ color:'#6b7280' }}>PNG Encode</span><span style={{ color:'#d1d5db', textAlign:'right' }}>{formatDebugMs(debugStats.exportEncodeMs)}</span>
                <span style={{ color:'#6b7280' }}>Capture Total</span><span style={{ color:'#d1d5db', textAlign:'right' }}>{formatDebugMs(debugStats.exportTotalMs)}</span>
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

        {/* RIGHT PANEL — compact summary + collapsible settings + always-visible export */}
        <div style={{ background:'#161314', borderLeft:'1px solid rgba(255,255,255,0.07)', display:'flex', flexDirection:'column', overflow:'hidden', minHeight:0 }}>
          <div style={{ padding:'10px 14px', borderBottom:'1px solid rgba(255,255,255,0.07)', flexShrink:0 }}>
            <div style={{ display:'flex', alignItems:'center', gap:8 }}>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:8, color:'#6b7280', letterSpacing:'0.10em', fontFamily:"'Barlow Condensed',sans-serif", marginBottom:3 }}>ACTIVE FINISH</div>
                <div style={{ fontSize:13, fontWeight:800, fontFamily:"'Barlow Condensed',sans-serif", color:'#efff00', letterSpacing:'0.05em' }}>
                  {FINISHES.find(f => f.id === finish)?.label.toUpperCase()}
                </div>
              </div>
              <button onClick={() => setActiveTab('finish')} style={{ background:'rgba(239,255,0,0.06)', border:'1px solid rgba(239,255,0,0.25)', borderRadius:5, padding:'5px 9px', cursor:'pointer', fontSize:9, fontWeight:700, color:'#efff00', fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:'0.06em' }}>CHANGE</button>
              <button
                onClick={() => setShowTipsModal(true)}
                title="Builder Tips"
                style={{ height:28, flexShrink:0, display:'flex', alignItems:'center', justifyContent:'center', background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.10)', borderRadius:6, padding:'0 9px', cursor:'pointer', color:'#efff00', fontSize:9, fontWeight:800, fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:'0.08em', lineHeight:1 }}
              >
                TIPS
              </button>
            </div>
          </div>

          <div style={{ padding:'5px 14px 10px', overflowY:'auto', flex:1, minHeight:0 }}>
            <CollapsibleSection title="CURRENT COLORS" defaultOpen={false}>
              <div style={{ display:'flex', gap:5, flexWrap:'wrap', paddingBottom:3 }}>
                {ZONES.map(zone => (
                  <div key={zone.id} style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:3 }}>
                    <div style={{ width:24, height:24, borderRadius:5, background:colors[zone.id], border:'1px solid rgba(255,255,255,0.12)' }} title={zone.label} />
                    <span style={{ fontSize:7, color:'#6b7280', fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:'0.03em', textTransform:'uppercase', maxWidth:30, textAlign:'center', lineHeight:1.1 }}>{zone.label.split(' ')[0]}</span>
                  </div>
                ))}
              </div>
            </CollapsibleSection>

            <CollapsibleSection title="BACKGROUND" defaultOpen={false}>
              <div style={{ background:'rgba(255,255,255,0.03)', border:'1px solid rgba(255,255,255,0.08)', borderRadius:9, padding:'10px 12px' }}>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:10, marginBottom:10 }}>
                  <div>
                    <div style={{ fontSize:11, color:'#9ca3af', marginBottom:2 }}>Background Color</div>
                    <div style={{ fontSize:9, color:'#6b7280', lineHeight:1.4 }}>Turn off for a transparent-background PNG export.</div>
                  </div>
                  <button onClick={() => setTransparentBg(v => !v)} style={{ background:!transparentBg?'rgba(239,255,0,0.12)':'rgba(255,255,255,0.06)', border:!transparentBg?'1px solid rgba(239,255,0,0.40)':'1px solid rgba(255,255,255,0.12)', borderRadius:20, padding:'6px 12px', cursor:'pointer', fontSize:10, fontWeight:800, color:!transparentBg?'#efff00':'#9ca3af', fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:'0.08em' }}>{transparentBg ? 'OFF' : 'ON'}</button>
                </div>
                <div style={{ opacity: transparentBg ? 0.45 : 1, pointerEvents: transparentBg ? 'none' : 'auto' }}>
                  <ColorSwatch color={viewportBgColor} onChange={setViewportBgColor} label="Color" />
                </div>
              </div>
            </CollapsibleSection>

            <CollapsibleSection title="STUDIO LIGHTING" defaultOpen={false}>
              <div style={{ background:'rgba(255,255,255,0.03)', border:'1px solid rgba(255,255,255,0.08)', borderRadius:9, padding:'10px 12px' }}>
                <div style={{ fontSize:9, color:'#6b7280', lineHeight:1.4, marginBottom:8 }}>
                  Optimized HDRIs provide the reflections/fill while virtual softboxes create broad product-photography highlights.
                </div>

                <div style={{ marginBottom:10 }}>
                  <div style={{ fontSize:9, color:'#9ca3af', marginBottom:5 }}>Environment</div>
                  <select
                    value={hdriPreset}
                    disabled={hdriLoading}
                    onChange={e => setHdriPreset(e.target.value)}
                    style={{ width:'100%', background:'rgba(0,0,0,0.22)', border:'1px solid rgba(255,255,255,0.12)', borderRadius:6, padding:'8px 10px', color:'#e5e7eb', fontSize:10, fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:'0.04em', opacity:hdriLoading?0.55:1, cursor:hdriLoading?'wait':'pointer' }}
                  >
                    {HDRI_PRESETS.map(preset => (
                      <option key={preset.id} value={preset.id}>{preset.label}</option>
                    ))}
                  </select>
                </div>

                {hdriLoading && <div style={{ fontSize:9, color:'#efff00', marginBottom:8 }}>Loading HDRI…</div>}
                {hdriError && <div style={{ fontSize:9, color:'#ef4444', lineHeight:1.35, marginBottom:8 }}>{hdriError}</div>}

                <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:9 }}>
                  <span style={{ width:58, flexShrink:0, fontSize:9, color:'#9ca3af' }}>Intensity</span>
                  <input type="range" min="0" max="200" value={Math.round(hdriIntensity * 100)} onChange={e => setHdriIntensity(parseInt(e.target.value) / 100)} style={{ flex:1, minWidth:0 }} />
                </div>

                <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:9 }}>
                  <span style={{ width:58, flexShrink:0, fontSize:9, color:'#9ca3af' }}>Exposure</span>
                  <input type="range" min="70" max="210" value={Math.round(sceneExposure * 100)} onChange={e => setSceneExposure(parseInt(e.target.value) / 100)} style={{ flex:1, minWidth:0 }} />
                </div>

                <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:12 }}>
                  <span style={{ width:58, flexShrink:0, fontSize:9, color:'#9ca3af' }}>Softboxes</span>
                  <input type="range" min="0" max="200" value={Math.round(studioLightStrength * 100)} onChange={e => setStudioLightStrength(parseInt(e.target.value) / 100)} style={{ flex:1, minWidth:0 }} />
                </div>

                <div style={{ height:1, background:'rgba(255,255,255,0.06)', marginBottom:10 }} />
                <ColorSwatch color={rimLightColor} onChange={setRimLightColor} label="Accent Light" />
              </div>
            </CollapsibleSection>

            <CollapsibleSection title="EXPORT QUALITY" defaultOpen={false}>
              <div style={{ background:'rgba(255,255,255,0.03)', border:'1px solid rgba(255,255,255,0.08)', borderRadius:9, padding:'10px 12px' }}>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:8 }}>
                  <div>
                    <div style={{ fontSize:10, color:'#9ca3af', marginBottom:5 }}>Final Size</div>
                    <select
                      value={String(exportResolution)}
                      onChange={e => setExportResolution(parseInt(e.target.value))}
                      style={{ width:'100%', background:'rgba(0,0,0,0.22)', border:'1px solid rgba(255,255,255,0.12)', borderRadius:6, padding:'8px 10px', color:'#e5e7eb', fontSize:10, fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:'0.04em' }}
                    >
                      <option value="1500">1500 px</option>
                      <option value="2048">2048 px</option>
                      <option value="3000">3000 px</option>
                      <option value="4096">4096 px</option>
                    </select>
                  </div>
                  <div>
                    <div style={{ fontSize:10, color:'#9ca3af', marginBottom:5 }}>Supersample</div>
                    <select
                      value={String(exportSupersample)}
                      onChange={e => setExportSupersample(parseInt(e.target.value))}
                      style={{ width:'100%', background:'rgba(0,0,0,0.22)', border:'1px solid rgba(255,255,255,0.12)', borderRadius:6, padding:'8px 10px', color:'#e5e7eb', fontSize:10, fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:'0.04em' }}
                    >
                      <option value="1">1× Standard</option>
                      <option value="2">2× High</option>
                      <option value="3" disabled={exportResolution > 2048}>
                        3× Ultra{exportResolution > 2048 ? ' (≤2048 px)' : ''}
                      </option>
                    </select>
                  </div>
                </div>
                <div style={{ fontSize:9, color:'#6b7280', lineHeight:1.45 }}>
                  High-resolution supersampled exports use the same lighting/material pipeline as the live viewport. 3× Ultra is available through 2048 px; 3000 px and 4096 px top out at 2× High to keep temporary GPU buffers within the production-safe 8192 px ceiling.
                </div>
                {exportNotice && (
                  <div style={{ marginTop:8, padding:'7px 8px', borderRadius:6, background:'rgba(239,255,0,0.06)', border:'1px solid rgba(239,255,0,0.18)', color:'#cdd900', fontSize:9, lineHeight:1.4 }}>
                    {exportNotice}
                  </div>
                )}
                {exportError && (
                  <div style={{ marginTop:8, padding:'7px 8px', borderRadius:6, background:'rgba(239,68,68,0.07)', border:'1px solid rgba(239,68,68,0.22)', color:'#f87171', fontSize:9, lineHeight:1.4 }}>
                    {exportError}
                  </div>
                )}
              </div>
            </CollapsibleSection>
          </div>

          {/* Export actions remain pinned and visible regardless of the settings-panel height. */}
          <div style={{ padding:'9px 12px 11px', borderTop:'1px solid rgba(255,255,255,0.08)', flexShrink:0, background:'#161314', boxShadow:'0 -8px 18px rgba(0,0,0,0.18)' }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:7, gap:8 }}>
              <div>
                <div style={{ fontSize:8, color:'#6b7280', letterSpacing:'0.08em', fontFamily:"'Barlow Condensed',sans-serif" }}>EXPORT CREDITS</div>
                <div style={{ fontSize:9, color:'#4b5563', marginTop:2 }}>{isUnlimited ? 'Unlimited watermark-free exports' : 'Free exports include watermark'}</div>
              </div>
              <div style={{ fontSize:20, fontWeight:900, color:credits>0?'#efff00':'#ef4444', fontFamily:"'Barlow Condensed',sans-serif" }}>{isUnlimited ? '∞' : credits}</div>
            </div>

            <button onClick={handleExport} disabled={exporting || !loaded} style={{ width:'100%', background:credits>0?(exporting?'rgba(239,255,0,0.45)':'linear-gradient(135deg,#efff00,#c8d900)'):'rgba(239,68,68,0.12)', border:credits>0?'none':'1px solid rgba(239,68,68,0.3)', borderRadius:8, padding:'12px', fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:14, letterSpacing:'0.08em', color:credits>0?'#000':'#ef4444', cursor:'pointer', animation:exporting?'pulse 0.9s infinite':'none' }}>
              {exported ? '✓ DOWNLOADED!' : exporting ? 'EXPORTING...' : credits>0 ? '↓ EXPORT PNG' : 'NO CREDITS — UPGRADE'}
            </button>

            {credits<=1 && credits>0 && (
              <button onClick={handleGetCredits} style={{ width:'100%', marginTop:6, background:'none', border:'1px solid rgba(255,255,255,0.09)', borderRadius:8, padding:'8px', fontFamily:"'Barlow Condensed',sans-serif", fontWeight:700, fontSize:11, color:'#6b7280', cursor:'pointer', letterSpacing:'0.05em' }}>UPGRADE → REMOVE WATERMARK</button>
            )}
          </div>
        </div>
      </div>

      {/* TIPS MODAL */}
      {showTipsModal && (
        <div onClick={() => setShowTipsModal(false)} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.76)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1001, padding:18 }}>
          <div onClick={e => e.stopPropagation()} style={{ width:460, maxWidth:'92vw', maxHeight:'82vh', overflowY:'auto', background:'#161314', border:'1px solid rgba(255,255,255,0.10)', borderRadius:14, padding:'20px 22px', boxShadow:'0 24px 70px rgba(0,0,0,0.50)' }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:12, marginBottom:14 }}>
              <div>
                <div style={{ fontSize:9, color:'#6b7280', letterSpacing:'0.12em', fontFamily:"'Barlow Condensed',sans-serif", marginBottom:3 }}>HELMET BUILDER</div>
                <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:21, letterSpacing:'0.05em' }}>TIPS</div>
              </div>
              <button onClick={() => setShowTipsModal(false)} style={{ width:30, height:30, background:'rgba(255,255,255,0.05)', border:'1px solid rgba(255,255,255,0.10)', borderRadius:7, cursor:'pointer', color:'#9ca3af', fontSize:18 }}>×</button>
            </div>

            {[
              { icon:'◈', text:'Click any swatch or type a hex code to change colors.' },
              { icon:'◎', text:'Shell finishes control the painted shell, Side Screws, and Top Screws as one continuous surface.' },
              { icon:'✦', text:'Car Paint uses discrete glitter; Satin adds dense metallic micro-texture; Carbon Fiber adds a subtle twill weave in the shell reflections.' },
              { icon:'◉', text:'Studio Lighting combines HDRI reflections with large virtual softboxes. Use Exposure and Intensity sparingly for the most photographic result.' },
              { icon:'◇', text:'Rubber, metal, padding, molded plastic, straps, visor, and other physical components now use independently calibrated PBR material properties for more realistic contrast.' },
              { icon:'★', text:'For final graphics, use 2048–4096 px with 2× supersampling. Higher settings improve edge quality but take longer to render.' },
            ].map((tip,i) => (
              <div key={i} style={{ display:'flex', gap:11, padding:'10px 0', borderTop:i===0?'none':'1px solid rgba(255,255,255,0.05)', alignItems:'flex-start' }}>
                <span style={{ color:'#efff00', fontSize:13, lineHeight:1.5, flexShrink:0 }}>{tip.icon}</span>
                <span style={{ fontSize:12, color:'#9ca3af', lineHeight:1.55 }}>{tip.text}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* UPGRADE MODAL — identical flow to /jersey (same Stripe products, same shared credit pool) */}
      {showUpgrade && (
        <div onClick={() => setShowUpgrade(false)} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.78)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000 }}>
          <div onClick={e => e.stopPropagation()} style={{ background:'#161314', borderRadius:16, border:'1px solid rgba(255,255,255,0.1)', padding:'30px', width:460, maxWidth:'90vw' }}>
            {isUnlimited ? (
              <>
                <div style={{ textAlign:'center', marginBottom:20 }}>
                  <div style={{ fontSize:30, marginBottom:8 }}>✓</div>
                  <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:24, letterSpacing:'0.05em', marginBottom:6, color:'#efff00' }}>YOU ALREADY HAVE UNLIMITED CREDITS</div>
                  <div style={{ fontSize:12, color:'#9ca3af', lineHeight:1.7 }}>Your Unlimited Monthly plan is active, so all exports are watermark-free and no credits are consumed.</div>
                </div>
                <div style={{ background:'rgba(16,185,129,0.08)', border:'1px solid rgba(16,185,129,0.24)', borderRadius:10, padding:'12px 14px', marginBottom:16, fontSize:10, color:'#a7f3d0', lineHeight:1.55, textAlign:'center' }}>
                  Purchase options will automatically return if the subscription ends or Stripe marks it unpaid or canceled.
                </div>
                <button onClick={() => setShowUpgrade(false)} style={{ width:'100%', background:'linear-gradient(135deg,#efff00,#c8d900)', border:'none', borderRadius:8, padding:'13px', fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:14, letterSpacing:'0.06em', color:'#000', cursor:'pointer' }}>CLOSE</button>
              </>
            ) : (
              <>
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
                const r = await fetch('/api/stripe/checkout', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ priceId, returnPath:'/helmet' }) });
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
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
