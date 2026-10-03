import * as THREE from 'three';

const key = name => name.toLowerCase().replace(/[^a-z0-9]/g, '');
export const AXIOM_WRAP_FORWARD_SHIFT = 0.10;

export function decalCarrierRoots(model) {
  const roots = [];
  model.traverse(object => { if (key(object.name) === 'decalsurface') roots.push(object); });
  if (!roots.length) model.traverse(object => { if (key(object.name) === 'shell') roots.push(object); });
  return roots;
}

function surfaceMeshes(roots) {
  const meshes = new Set();
  roots.forEach(root => root.traverse(object => {
    if (object.isMesh && object.geometry?.attributes?.position) meshes.add(object);
  }));
  return [...meshes];
}

function normalizedSurface(roots) {
  const meshes = surfaceMeshes(roots);
  const bounds = new THREE.Box3();
  const point = new THREE.Vector3();
  meshes.forEach(mesh => {
    mesh.updateWorldMatrix(true, false);
    const position = mesh.geometry.attributes.position;
    for (let i = 0; i < position.count; i++) {
      bounds.expandByPoint(point.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld));
    }
  });
  const size = bounds.getSize(new THREE.Vector3()).max(new THREE.Vector3(1e-6, 1e-6, 1e-6));
  return { meshes, normalize: point => point.sub(bounds.min).divide(size) };
}

// Retarget an authored atlas by corresponding shell position, rather than treating
// the unrelated Blender UV islands in two helmets as interchangeable. A small BVH
// keeps nearest-triangle queries practical on the subdivided Axiom carrier.
export function createWrapSurfaceSampler(roots) {
  const { meshes, normalize } = normalizedSurface(roots);
  const faces = [];
  meshes.forEach(mesh => {
    const geometry = mesh.geometry;
    const position = geometry.attributes.position;
    const uv = geometry.getAttribute('helmetAuthoredWrapUv') || geometry.attributes.uv;
    if (!uv) return;
    const points = Array.from({ length:position.count }, (_, i) =>
      normalize(new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld)));
    const count = geometry.index?.count ?? position.count;
    for (let i = 0; i < count; i += 3) {
      const indices = [0, 1, 2].map(k => geometry.index ? geometry.index.getX(i + k) : i + k);
      const triangle = new THREE.Triangle(...indices.map(index => points[index]));
      if (triangle.getArea() < 1e-12) continue;
      const box = new THREE.Box3().setFromPoints([triangle.a, triangle.b, triangle.c]);
      faces.push({ triangle, uv:indices.map(index => new THREE.Vector2().fromBufferAttribute(uv, index)),
        box, center:box.getCenter(new THREE.Vector3()) });
    }
  });
  if (!faces.length) throw new Error('Reference helmet has no authored wrap surface.');
  const build = indices => {
    const box = new THREE.Box3();
    indices.forEach(index => box.union(faces[index].box));
    if (indices.length <= 12) return { box, indices };
    const size = box.getSize(new THREE.Vector3());
    const axis = size.x >= size.y && size.x >= size.z ? 'x' : size.y >= size.z ? 'y' : 'z';
    indices.sort((a, b) => faces[a].center[axis] - faces[b].center[axis]);
    const middle = Math.floor(indices.length / 2);
    return { box, left:build(indices.slice(0, middle)), right:build(indices.slice(middle)) };
  };
  const tree = build(faces.map((_, index) => index));
  const closest = new THREE.Vector3(), bestPoint = new THREE.Vector3(), barycentric = new THREE.Vector3();
  const boxDistance = (box, point) => {
    const x = Math.max(box.min.x - point.x, 0, point.x - box.max.x);
    const y = Math.max(box.min.y - point.y, 0, point.y - box.max.y);
    const z = Math.max(box.min.z - point.z, 0, point.z - box.max.z);
    return x * x + y * y + z * z;
  };
  return {
    sample(point, result = new THREE.Vector2()) {
      let bestDistance = Infinity, bestFace = null;
      const visit = node => {
        if (boxDistance(node.box, point) > bestDistance + 1e-12) return;
        if (node.indices) {
          node.indices.forEach(index => {
            const face = faces[index];
            face.triangle.closestPointToPoint(point, closest);
            const distance = closest.distanceToSquared(point);
            if (distance < bestDistance) {
              bestDistance = distance; bestFace = face; bestPoint.copy(closest);
            }
          });
          return;
        }
        const leftFirst = boxDistance(node.left.box, point) <= boxDistance(node.right.box, point);
        visit(leftFirst ? node.left : node.right);
        visit(leftFirst ? node.right : node.left);
      };
      visit(tree);
      bestFace.triangle.getBarycoord(bestPoint, barycentric);
      result.set(0, 0);
      bestFace.uv.forEach((uv, index) => result.addScaledVector(uv, barycentric.getComponent(index)));
      return result;
    },
    triangleCount:faces.length,
  };
}

export function applyCompatibleWrapUV(roots, sampler, { forwardShift = 0 } = {}) {
  const { meshes, normalize } = normalizedSurface(roots);
  const point = new THREE.Vector3(), uv = new THREE.Vector2();
  const cache = new Map();
  meshes.forEach(mesh => {
    const geometry = mesh.geometry;
    // Keep the retargeted coordinates separate from the original atlas and from
    // panoramic UVs, so toggling wrap modes never overwrites either source.
    let transferred = geometry.getAttribute('helmetCompatibleWrapUv');
    if (!transferred || geometry.userData.helmetWrapForwardShift !== forwardShift) {
      const position = geometry.attributes.position;
      const values = new Float32Array(position.count * 2);
      for (let i = 0; i < position.count; i++) {
        normalize(point.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld));
        // Sampling slightly behind each target point carries the reference pattern
        // toward the front (+Z), along the shell rather than shifting UV islands.
        point.z = THREE.MathUtils.clamp(point.z - forwardShift, 0, 1);
        const id = point.toArray().map(value => Math.round(value * 1e6)).join(',');
        let cached = cache.get(id);
        if (!cached) { sampler.sample(point, uv); cached = uv.toArray(); cache.set(id, cached); }
        values[i * 2] = cached[0]; values[i * 2 + 1] = cached[1];
      }
      transferred = new THREE.BufferAttribute(values, 2);
      geometry.setAttribute('helmetCompatibleWrapUv', transferred);
      geometry.userData.helmetWrapForwardShift = forwardShift;
    }
    geometry.setAttribute('helmetWrapUv', transferred.clone());
    geometry.attributes.helmetWrapUv.needsUpdate = true;
  });
}
