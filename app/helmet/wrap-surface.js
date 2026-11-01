import * as THREE from 'three';

const key = name => name.toLowerCase().replace(/[^a-z0-9]/g, '');
export const AXIOM_WRAP_FORWARD_SHIFT = 0.28;

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
  // Identify continuous UV islands. Adjacent faces may share the same physical
  // edge yet belong to distant atlas regions; interpolating between those UVs
  // paints unrelated black triangles and thin cracks around vents.
  const parents = faces.map((_, index) => index);
  const find = index => {
    while (parents[index] !== index) { parents[index] = parents[parents[index]]; index = parents[index]; }
    return index;
  };
  const edges = new Map();
  const vertexKey = (point, uv) => [...point.toArray(), ...uv.toArray()].map(value => Math.round(value * 1e6)).join(',');
  faces.forEach((face, index) => {
    const vertices = [face.triangle.a, face.triangle.b, face.triangle.c].map((point, k) => vertexKey(point, face.uv[k]));
    for (let k = 0; k < 3; k++) {
      const a = vertices[k], b = vertices[(k + 1) % 3], edge = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (edges.has(edge)) parents[find(index)] = find(edges.get(edge)); else edges.set(edge, index);
    }
  });
  const charts = new Map();
  faces.forEach((face, index) => {
    face.chart = find(index);
    if (!charts.has(face.chart)) charts.set(face.chart, []);
    charts.get(face.chart).push(index);
  });
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
  const chartTrees = new Map();
  const closest = new THREE.Vector3(), bestPoint = new THREE.Vector3(), barycentric = new THREE.Vector3();
  const ray = new THREE.Ray(), rayPoint = new THREE.Vector3();
  const rayCenter = new THREE.Vector3(0.5, 0.5, 0.5);
  const interpolate = (face, point, result) => {
    face.triangle.getBarycoord(point, barycentric);
    result.set(0, 0);
    face.uv.forEach((uv, index) => result.addScaledVector(uv, barycentric.getComponent(index)));
    return result;
  };
  const boxDistance = (box, point) => {
    const x = Math.max(box.min.x - point.x, 0, point.x - box.max.x);
    const y = Math.max(box.min.y - point.y, 0, point.y - box.max.y);
    const z = Math.max(box.min.z - point.z, 0, point.z - box.max.z);
    return x * x + y * y + z * z;
  };
  return {
    sample(point, result = new THREE.Vector2(), detail = null) {
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
      if (detail) detail.chart = bestFace.chart;
      return interpolate(bestFace, bestPoint, result);
    },
    sampleRadial(point, result = new THREE.Vector2(), detail = null) {
      ray.origin.copy(rayCenter);
      ray.direction.copy(point).sub(rayCenter).normalize();
      let bestDistance = -Infinity, bestFace = null;
      const visit = node => {
        if (!ray.intersectsBox(node.box)) return;
        if (node.indices) {
          node.indices.forEach(index => {
            const face = faces[index];
            if (!ray.intersectTriangle(face.triangle.a, face.triangle.b, face.triangle.c, false, rayPoint)) return;
            const distance = rayPoint.distanceToSquared(rayCenter);
            if (distance > bestDistance) {
              bestDistance = distance; bestFace = face; bestPoint.copy(rayPoint);
            }
          });
        } else { visit(node.left); visit(node.right); }
      };
      visit(tree);
      if (!bestFace) return this.sample(point, result, detail);
      if (detail) detail.chart = bestFace.chart;
      return interpolate(bestFace, bestPoint, result);
    },
    sampleChart(point, chart, result = new THREE.Vector2()) {
      // Keep a seam triangle inside one atlas island. Closest-point clipping to
      // that island's boundary avoids sampling the empty/unrelated atlas between
      // islands, without changing any correctly mapped surrounding vertices.
      this.sampleRadial(point, result);
      const referencePoint = bestPoint.clone();
      if (!chartTrees.has(chart)) chartTrees.set(chart, build(charts.get(chart).slice()));
      let bestDistance = Infinity, bestFace = null;
      const visit = node => {
        if (boxDistance(node.box, referencePoint) > bestDistance + 1e-12) return;
        if (node.indices) {
          node.indices.forEach(index => {
            const face = faces[index];
            face.triangle.closestPointToPoint(referencePoint, closest);
            const distance = closest.distanceToSquared(referencePoint);
            if (distance < bestDistance) {
              bestDistance = distance; bestFace = face; bestPoint.copy(closest);
            }
          });
        } else { visit(node.left); visit(node.right); }
      };
      visit(chartTrees.get(chart));
      return interpolate(bestFace, bestPoint, result);
    },
    triangleCount:faces.length,
    chartCount:charts.size,
  };
}

export function applyCompatibleWrapUV(roots, sampler, { forwardShift = 0 } = {}) {
  const { meshes, normalize } = normalizedSurface(roots);
  const point = new THREE.Vector3(), corner = new THREE.Vector3(), uv = new THREE.Vector2();
  const cache = new Map();
  // Convert the desired crown displacement to a rotation around the side axis.
  // Translating/clamping Z pushed samples inside the reference shell, where the
  // nearest triangle could jump across atlas islands and leave jagged stripes.
  const angle = Math.asin(THREE.MathUtils.clamp(forwardShift * 2, -0.98, 0.98));
  const cos = Math.cos(angle), sin = Math.sin(angle);
  meshes.forEach(mesh => {
    // Each triangle needs its own vertices where the reference atlas has a seam.
    // Positions, smooth normals and the original UV channel are retained verbatim.
    if (forwardShift && mesh.geometry.index) {
      const original = mesh.geometry;
      mesh.geometry = original.toNonIndexed();
      mesh.geometry.userData = { ...original.userData };
    }
    const geometry = mesh.geometry;
    // Keep the retargeted coordinates separate from the original atlas and from
    // panoramic UVs, so toggling wrap modes never overwrites either source.
    let transferred = geometry.getAttribute('helmetCompatibleWrapUv');
    if (!transferred || geometry.userData.helmetWrapForwardShift !== forwardShift) {
      const position = geometry.attributes.position;
      const values = new Float32Array(position.count * 2);
      const queries = new Float32Array(position.count * 3), vertexCharts = new Int32Array(position.count);
      const detail = { chart:-1 };
      for (let i = 0; i < position.count; i++) {
        normalize(point.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld));
        if (forwardShift) {
          const y = point.y - 0.5, z = point.z - 0.5;
          point.y = 0.5 + y * cos + z * sin;
          point.z = 0.5 + z * cos - y * sin;
        }
        const id = point.toArray().map(value => Math.round(value * 1e6)).join(',');
        let cached = cache.get(id);
        if (!cached) {
          // Project outward along the same shell direction, retaining front/back
          // correspondence even at strong shifts and on the crown's vent panels.
          detail.chart = -1;
          if (forwardShift) sampler.sampleRadial(point, uv, detail); else sampler.sample(point, uv, detail);
          cached = { uv:uv.toArray(), chart:detail.chart }; cache.set(id, cached);
        }
        values[i * 2] = cached.uv[0]; values[i * 2 + 1] = cached.uv[1];
        vertexCharts[i] = cached.chart;
        point.toArray(queries, i * 3);
      }
      let seamTriangles = 0;
      if (forwardShift && sampler.sampleChart) {
        for (let i = 0; i < position.count; i += 3) {
          if (vertexCharts[i] === vertexCharts[i + 1] && vertexCharts[i] === vertexCharts[i + 2]) continue;
          point.set(0, 0, 0);
          for (let k = 0; k < 3; k++) point.add(corner.fromArray(queries, (i + k) * 3));
          point.multiplyScalar(1 / 3);
          sampler.sampleRadial(point, uv, detail);
          const chart = detail.chart;
          for (let k = 0; k < 3; k++) {
            if (vertexCharts[i + k] === chart) continue;
            sampler.sampleChart(point.fromArray(queries, (i + k) * 3), chart, uv);
            values[(i + k) * 2] = uv.x; values[(i + k) * 2 + 1] = uv.y;
          }
          seamTriangles++;
        }
      }
      transferred = new THREE.BufferAttribute(values, 2);
      geometry.setAttribute('helmetCompatibleWrapUv', transferred);
      geometry.userData.helmetWrapForwardShift = forwardShift;
      geometry.userData.helmetWrapSeamTriangles = seamTriangles;
    }
    geometry.setAttribute('helmetWrapUv', transferred.clone());
    geometry.attributes.helmetWrapUv.needsUpdate = true;
  });
}
