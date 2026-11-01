import * as THREE from 'three';

const key = name => name.toLowerCase().replace(/[^a-z0-9]/g, '');
const bumperBit = 1;
const hardwareBit = 2;
const hardwareParts = ['Straps', 'Strap Clips - Lower', 'Strap Clips - Upper',
  'Facemask Clips', 'Facemask Clips Hardware', 'Axiom Hardware'];

// Write only visible foreground parts after the opaque shell has filled depth.
// Separate stencil bits let bumper logos remain on bumpers while shell artwork
// stays underneath both bumpers and straps, even where the filled carrier bridges
// a recess and would otherwise lie in front of the physical strap mesh.
export function applyShellDecalOcclusion(parts, materials, { maskBumpers = true } = {}) {
  const configurePart = (name, bit) => {
    const seen = new Set();
    (parts[key(name)] || []).forEach(root => root.traverse(mesh => {
      if (!mesh.isMesh) return;
      mesh.renderOrder = 26;
      (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach(material => {
        if (!material || seen.has(material)) return;
        seen.add(material);
        Object.assign(material, {
          depthTest:true, depthWrite:true, stencilWrite:true,
          // Replace the foreground classification on depth pass. A closer bumper
          // must clear an earlier strap bit, or its own wordmark could be erased by
          // hardware that is actually behind it.
          stencilWriteMask:bumperBit | hardwareBit, stencilFunc:THREE.AlwaysStencilFunc,
          stencilRef:bit, stencilFuncMask:bumperBit | hardwareBit,
          stencilFail:THREE.KeepStencilOp, stencilZFail:THREE.KeepStencilOp,
          stencilZPass:THREE.ReplaceStencilOp,
        });
        material.needsUpdate = true;
      });
    }));
  };
  configurePart('Bumpers', bumperBit);
  hardwareParts.forEach(name => configurePart(name, hardwareBit));
  materials.forEach(material => {
    if (!material) return;
    Object.assign(material, {
      stencilWrite:true, stencilWriteMask:0, stencilFunc:THREE.EqualStencilFunc,
      stencilRef:0, stencilFuncMask:hardwareBit | (maskBumpers ? bumperBit : 0),
      stencilFail:THREE.KeepStencilOp, stencilZFail:THREE.KeepStencilOp,
      stencilZPass:THREE.KeepStencilOp,
    });
    material.needsUpdate = true;
  });
}
