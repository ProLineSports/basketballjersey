import * as THREE from 'three';

export const HELMET_VIEWS = {
  sideA: { label: 'SIDE A', offset: [-3.2, 0.05, 0] },
  sideB: { label: 'SIDE B', offset: [3.2, 0.05, 0] },
  front: { label: 'FRONT', offset: [0, 0.03, 3.15] },
  back: { label: 'BACK', offset: [0, 0.65, -3.1] },
  top: { label: 'TOP', offset: [0, 3.15, 0.42] },
  hero: { label: 'HERO', offset: [-2.9, 0.42, 1.15] },
};

// The builder's wrap, stripe, logo raycasts and view presets all use +Z as
// front, +/-X as the sides and +Y as up. Axiom is authored facing +X.
// Put its correction BELOW the stable model root: rotating the model root
// alone would be cancelled by the world-to-model matrices used for decals.
export function normalizeHelmetOrientation(model, family) {
  if (family !== 'axiom' || model.userData.builderOrientationNormalized) return;
  const orientation = new THREE.Group();
  orientation.name = 'BuilderOrientation';
  orientation.rotation.y = -Math.PI / 2;
  orientation.add(...model.children.slice());
  model.add(orientation);
  model.userData.builderOrientationNormalized = true;
  model.updateWorldMatrix(true, true);
}

export function visibleHelmetBounds(model) {
  const bounds = new THREE.Box3();
  if (!model) return bounds;
  model.updateWorldMatrix(true, true);
  const visit = object => {
    if (!object.visible || object.userData.decalSurfaceRoot || object.userData.decalSurfaceMesh) return;
    if (object.isMesh && object.geometry && object.material) {
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      if (materials.some(material => material.visible && material.opacity > 0)) {
        // Exact vertices, rather than rotated local boxes, keep a tilted helmet
        // centered and exclude the hidden alternate mask / filled decal carrier.
        const positions = object.geometry.attributes.position;
        const point = new THREE.Vector3();
        if (positions) {
          for (let i = 0; i < positions.count; i++) {
            point.fromBufferAttribute(positions, i).applyMatrix4(object.matrixWorld);
            bounds.expandByPoint(point);
          }
        }
      }
    }
    object.children.forEach(visit);
  };
  visit(model);
  return bounds;
}

export function helmetCenter(model) {
  const bounds = visibleHelmetBounds(model);
  return bounds.isEmpty() ? new THREE.Vector3() : bounds.getCenter(new THREE.Vector3());
}

export function setHelmetView(camera, controls, model, presetId) {
  const preset = HELMET_VIEWS[presetId] || HELMET_VIEWS.sideA;
  controls.target.copy(helmetCenter(model));
  camera.position.copy(controls.target).add(new THREE.Vector3(...preset.offset));
  camera.up.set(0, 1, 0);
  camera.lookAt(controls.target);
  controls.update();
  camera.updateMatrixWorld(true);
  recenterHelmet(camera, controls, model);
}

// Project the visible helmet's bounds into the CURRENT camera frame. Center
// those bounds on the optical axis, retaining distance, viewing angle and roll.
// World-axis bounds alone drift off-center at oblique/custom viewpoints.
export function recenterHelmet(camera, controls, model) {
  if (!model) return;
  model.updateWorldMatrix(true, true);
  camera.updateMatrixWorld(true);
  const samples = [];
  const point = new THREE.Vector3();
  const visit = object => {
    if (!object.visible || object.userData.decalSurfaceRoot || object.userData.decalSurfaceMesh) return;
    if (object.isMesh && object.geometry && object.material) {
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      if (materials.some(material => material.visible && material.opacity > 0)) {
        const positions = object.geometry.attributes.position;
        for (let i = 0; positions && i < positions.count; i++) {
          point.fromBufferAttribute(positions, i).applyMatrix4(object.matrixWorld).applyMatrix4(camera.matrixWorldInverse);
          // Perspective coordinates at unit depth: the screen silhouette center.
          if (point.z < -camera.near) samples.push([point.x, point.y, -point.z]);
        }
      }
    }
    object.children.forEach(visit);
  };
  visit(model);
  if (!samples.length) return;
  // Solve the translation whose projected min/max are equal and opposite.
  // Each vertex has its own depth; a bounds-center approximation is not exact
  // under perspective and leaves a visible offset in close custom views.
  const solveShift = axis => {
    let low = Infinity;
    let high = -Infinity;
    samples.forEach(sample => {
      low = Math.min(low, sample[axis]);
      high = Math.max(high, sample[axis]);
    });
    for (let iteration = 0; iteration < 32; iteration++) {
      const shift = (low + high) / 2;
      let min = Infinity;
      let max = -Infinity;
      samples.forEach(sample => {
        const projected = (sample[axis] - shift) / sample[2];
        min = Math.min(min, projected);
        max = Math.max(max, projected);
      });
      if (min + max > 0) low = shift;
      else high = shift;
    }
    return (low + high) / 2;
  };
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
  const shift = right.multiplyScalar(solveShift(0)).add(up.multiplyScalar(solveShift(1)));
  camera.position.add(shift);
  controls.target.add(shift);
  controls.update();
  camera.updateMatrixWorld(true);
}

export function rollHelmetView(camera, controls, radians) {
  const viewAxis = controls.target.clone().sub(camera.position).normalize();
  camera.up.applyAxisAngle(viewAxis, radians).normalize();
  camera.lookAt(controls.target);
  controls.update();
  camera.updateMatrixWorld(true);
}

export function levelHelmetView(camera, controls) {
  const viewAxis = controls.target.clone().sub(camera.position).normalize();
  const up = new THREE.Vector3(0, 1, 0).addScaledVector(viewAxis, -viewAxis.y);
  // At a pole, use the canonical front direction instead of a zero up vector.
  if (up.lengthSq() < 0.000001) up.set(0, 0, viewAxis.y > 0 ? 1 : -1);
  camera.up.copy(up.normalize());
  camera.lookAt(controls.target);
  controls.update();
  camera.updateMatrixWorld(true);
}

export function squareViewportSize(width, height) {
  return Math.max(1, Math.floor(Math.min(height, Math.max(1, width - 600))));
}
