import * as THREE from 'three';
import { visibleHelmetBounds } from './viewport-controls.js';

export const DEFAULT_SIDE_LOGO_PLACEMENT = Object.freeze({ yNorm: 0.65, zNorm: 0.03, scale: 1, rotation: -Math.PI / 6 });
export const DEFAULT_STRIPE_WIDTH = 2.5;
const AXIOM_REAR_DECAL_PLACEMENTS = Object.freeze({
  flag: Object.freeze({ scale:5, rotation:20, across:-62, vertical:-10 }),
  warning: Object.freeze({ scale:5, rotation:-20, across:58, vertical:-10 }),
});
const SPEEDFLEX_REAR_DECAL_PLACEMENTS = Object.freeze({
  flag: Object.freeze({ scale:5, rotation:0, across:-62, vertical:-38 }),
  warning: Object.freeze({ scale:5, rotation:0, across:58, vertical:-38 }),
});

export function rearDecalDefaults(family) {
  return family === 'axiom' ? AXIOM_REAR_DECAL_PLACEMENTS : SPEEDFLEX_REAR_DECAL_PLACEMENTS;
}

export function rearBumperDefaultVertical(family) {
  return family === 'axiom' ? 0 : -60;
}

export function textureFootprint(artworkWidth, pack) {
  const artworkHeight = artworkWidth / pack.aspect;
  return {
    width: artworkWidth / pack.contentWidthFraction,
    height: artworkHeight / pack.contentHeightFraction,
  };
}

export function rearStickerBaseHeight(family) {
  return family === 'axiom' ? 0.59 : 0.34;
}

export function bumperSurfaceBounds(model, meshes, slot) {
  model.updateWorldMatrix(true, true);
  const named = meshes.filter(mesh => partKey(mesh.name) === `${slot}bumper`);
  const sources = named.length ? named : meshes;
  const inverse = model.matrixWorld.clone().invert();
  const point = new THREE.Vector3();
  const all = new THREE.Box3();
  sources.forEach(mesh => {
    const transform = new THREE.Matrix4().multiplyMatrices(inverse, mesh.matrixWorld);
    const positions = mesh.geometry.attributes.position;
    for (let i = 0; i < positions.count; i++) {
      all.expandByPoint(point.fromBufferAttribute(positions, i).applyMatrix4(transform));
    }
  });
  const bounds = new THREE.Box3();
  const middleZ = all.getCenter(new THREE.Vector3()).z;
  sources.forEach(mesh => {
    const transform = new THREE.Matrix4().multiplyMatrices(inverse, mesh.matrixWorld);
    const positions = mesh.geometry.attributes.position;
    for (let i = 0; i < positions.count; i++) {
      point.fromBufferAttribute(positions, i).applyMatrix4(transform);
      if (named.length || (slot === 'front' ? point.z >= middleZ : point.z <= middleZ)) bounds.expandByPoint(point);
    }
  });
  if (bounds.isEmpty()) return null;
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const worldSize = model.getWorldScale(new THREE.Vector3()).multiply(size);
  return { meshes:sources, minX:bounds.min.x, maxX:bounds.max.x, minY:bounds.min.y, maxY:bounds.max.y,
    minZ:bounds.min.z, maxZ:bounds.max.z, centerX:center.x, centerY:center.y, centerZ:center.z,
    width:size.x, height:size.y, depth:size.z, worldSize };
}

export function shadowFloorIsVisible(camera, floor) {
  if (!camera || !floor) return false;
  camera.updateMatrixWorld(true);
  // Orbiting beneath the ground or rolling upside down would turn its projection
  // into a ceiling. Keep the studio plane fixed and omit that ground-only shadow.
  const screenUp = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
  return camera.position.y > floor.position.y + 0.01 && screenUp.y >= -0.02;
}

const partKey = name => name.toLowerCase().replace(/[^a-z0-9]/g, '');

// The exported Axiom hardware includes the rear bumper. Split that connected
// piece in memory so both bumpers share one UI color and stencil/finish routing.
// This leaves the binary asset and the authored vertex normals untouched.
export function separateAxiomRearBumper(model) {
  if (model.userData.rearBumperSeparated) return null;
  let hardware;
  let bumpers;
  let shell;
  model.traverse(object => {
    if (partKey(object.name) === 'axiomhardware' && object.isMesh) hardware = object;
    if (partKey(object.name) === 'bumpers') bumpers = object;
    if (partKey(object.name) === 'shell') shell = object;
  });
  if (!hardware?.geometry.index || !bumpers || !shell || Array.isArray(hardware.material)) return null;
  model.updateWorldMatrix(true, true);
  const geometry = hardware.geometry;
  const positions = geometry.attributes.position;
  const indices = geometry.index;
  const parents = Int32Array.from({ length: positions.count }, (_, index) => index);
  const root = index => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]];
      index = parents[index];
    }
    return index;
  };
  const join = (a, b) => { parents[root(a)] = root(b); };
  // Join coincident vertices across UV seams and split-normal boundaries.
  const welded = new Map();
  for (let i = 0; i < positions.count; i++) {
    const key = [positions.getX(i), positions.getY(i), positions.getZ(i)]
      .map(value => Math.round(value * 100000)).join(',');
    if (welded.has(key)) join(i, welded.get(key));
    else welded.set(key, i);
  }
  for (let i = 0; i < indices.count; i += 3) {
    join(indices.getX(i), indices.getX(i + 1));
    join(indices.getX(i), indices.getX(i + 2));
  }
  const components = new Map();
  const point = new THREE.Vector3();
  const modelInverse = model.matrixWorld.clone().invert();
  const localToModel = new THREE.Matrix4().multiplyMatrices(modelInverse, hardware.matrixWorld);
  for (let i = 0; i < indices.count; i += 3) {
    const id = root(indices.getX(i));
    if (!components.has(id)) components.set(id, new THREE.Box3());
    const bounds = components.get(id);
    for (let corner = 0; corner < 3; corner++) {
      point.fromBufferAttribute(positions, indices.getX(i + corner)).applyMatrix4(localToModel);
      bounds.expandByPoint(point);
    }
  }
  const shellBounds = new THREE.Box3();
  shell.traverse(object => {
    if (!object.isMesh) return;
    const transform = new THREE.Matrix4().multiplyMatrices(modelInverse, object.matrixWorld);
    const attribute = object.geometry.attributes.position;
    for (let i = 0; i < attribute.count; i++) {
      shellBounds.expandByPoint(point.fromBufferAttribute(attribute, i).applyMatrix4(transform));
    }
  });
  const shellSize = shellBounds.getSize(new THREE.Vector3());
  const shellCenter = shellBounds.getCenter(new THREE.Vector3());
  const candidates = [...components].filter(([, bounds]) => {
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    // The rear bumper is the wide, shallow, centered bar at the shell's back.
    // Small rear fasteners and the side clips remain in Axiom Hardware.
    return size.x > shellSize.x * 0.5
      && size.x > Math.max(size.y, size.z) * 2
      && size.y < shellSize.y * 0.25
      && Math.abs(center.x - shellCenter.x) < shellSize.x * 0.05
      && center.z < shellCenter.z - shellSize.z * 0.25;
  });
  if (candidates.length !== 1) return null;
  const rearId = candidates[0][0];
  const rearIndices = [];
  const hardwareIndices = [];
  for (let i = 0; i < indices.count; i += 3) {
    const target = root(indices.getX(i)) === rearId ? rearIndices : hardwareIndices;
    target.push(indices.getX(i), indices.getX(i + 1), indices.getX(i + 2));
  }
  const subsetGeometry = sourceIndices => {
    const compact = new THREE.BufferGeometry();
    const oldVertices = [];
    const remap = new Map();
    const newIndices = sourceIndices.map(index => {
      if (!remap.has(index)) {
        remap.set(index, oldVertices.length);
        oldVertices.push(index);
      }
      return remap.get(index);
    });
    Object.entries(geometry.attributes).forEach(([name, attribute]) => {
      const values = new attribute.array.constructor(oldVertices.length * attribute.itemSize);
      for (let i = 0; i < oldVertices.length; i++) {
        for (let component = 0; component < attribute.itemSize; component++) {
          // Copy raw values so integer/normalized attributes retain their encoding.
          const sourceOffset = attribute.isInterleavedBufferAttribute
            ? oldVertices[i] * attribute.data.stride + attribute.offset + component
            : oldVertices[i] * attribute.itemSize + component;
          values[i * attribute.itemSize + component] = attribute.array[sourceOffset];
        }
      }
      compact.setAttribute(name, new THREE.BufferAttribute(values, attribute.itemSize, attribute.normalized));
    });
    compact.setIndex(newIndices);
    compact.computeBoundingBox();
    compact.computeBoundingSphere();
    return compact;
  };
  const rear = new THREE.Mesh(subsetGeometry(rearIndices), hardware.material.clone());
  rear.name = 'Rear_Bumper';
  rear.material.name = 'axiom_rear_bumper';
  rear.position.copy(hardware.position);
  rear.quaternion.copy(hardware.quaternion);
  rear.scale.copy(hardware.scale);
  hardware.parent.add(rear);
  bumpers.attach(rear);
  hardware.geometry = subsetGeometry(hardwareIndices);
  geometry.dispose();
  model.userData.rearBumperSeparated = true;
  model.updateWorldMatrix(true, true);
  return rear;
}

export function positionShadowFloor(floor, model) {
  const bounds = visibleHelmetBounds(model);
  if (bounds.isEmpty()) return;
  const center = bounds.getCenter(new THREE.Vector3());
  floor.position.set(center.x, bounds.min.y - 0.03, center.z);
  floor.rotation.set(-Math.PI / 2, 0, 0);
  floor.updateMatrixWorld(true);
}
