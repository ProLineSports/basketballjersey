import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { getSquareExportPlan, resizeSquareExportRenderer } from './export-viewport.js';

const source = fs.readFileSync(process.env.HELMET_EXPORT_SOURCE || 'app/helmet/page.jsx', 'utf8');
const prefix = 'const handleExport = useCallback(';
const start = source.indexOf(prefix) + prefix.length;
const handlerSource = source.slice(start, source.indexOf('\n  }, [', start) + '\n  }'.length);
const legacyStart = source.indexOf('function getSafeExportPlan(');
const legacyPlan = legacyStart < 0 ? undefined : vm.runInNewContext(
  '(' + source.slice(legacyStart, source.indexOf('function getBaseModelStats(', legacyStart)) + ')'
);

function makeRenderer({ dpr = 2, css = [760, 428], limit = 16384, viewportLimit = [16384, 16384], allocation = 16384, failResize = false, contextLost = false } = {}) {
  const gl = {
    MAX_TEXTURE_SIZE: 'texture', MAX_RENDERBUFFER_SIZE: 'renderbuffer', MAX_VIEWPORT_DIMS: 'viewport',
    getParameter: key => key === 'viewport' ? viewportLimit : limit,
    isContextLost: () => contextLost,
  };
  const renderer = {
    domElement: { clientWidth: css[0], clientHeight: css[1], style: { width: '512px', height: '512px' } },
    ratio: dpr, size: new THREE.Vector2(512, 512), viewport: new THREE.Vector4(),
    clearColor: new THREE.Color('#123456'), clearAlpha: 0.6, captures: [],
    getContext: () => gl,
    getPixelRatio() { return this.ratio; },
    getSize(target) { return target.copy(this.size); },
    getClearColor(target) { return target.copy(this.clearColor); },
    getClearAlpha() { return this.clearAlpha; },
    setClearColor(color, alpha) { this.clearColor.set(color); this.clearAlpha = alpha; },
    setPixelRatio(ratio) { this.ratio = ratio; this.setSize(this.size.x, this.size.y, false); },
    setViewport(x, y, width, height) { this.viewport.set(x, y, width, height).multiplyScalar(this.ratio); },
    setSize(width, height, updateStyle) {
      assert.equal(updateStyle, false, 'export never changes the displayed canvas dimensions');
      this.size.set(width, height);
      this.domElement.width = Math.floor(width * this.ratio);
      this.domElement.height = Math.floor(height * this.ratio);
      gl.drawingBufferWidth = Math.min(this.domElement.width, allocation);
      gl.drawingBufferHeight = Math.min(this.domElement.height, allocation);
      this.setViewport(0, 0, width, height);
      if (failResize && width > 512) throw new Error('Allocation failed after resize');
    },
    render(scene, camera) {
      assert.equal(this.viewport.z, gl.drawingBufferWidth, 'full horizontal frame fits the allocated buffer');
      assert.equal(this.viewport.w, gl.drawingBufferHeight, 'full vertical frame fits the allocated buffer');
      this.captures.push({ projection: camera.projectionMatrix.clone(), background: scene.background?.getHexString(),
        clearAlpha: this.clearAlpha, helperVisible: scene.children[0].visible });
    },
  };
  renderer.setSize(512, 512, false);
  return renderer;
}

async function exportCase(options = {}) {
  const renderer = makeRenderer(options);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#173245');
  const helper = new THREE.Object3D(); helper.userData.editableDecalSelection = true;
  scene.add(helper);
  const camera = new THREE.PerspectiveCamera(45, 1, .1, 100);
  camera.position.set(-3.2, .4, .8);
  camera.up.set(.3, 1, .2).normalize();
  camera.lookAt(new THREE.Vector3(.17, -.12, .06));
  camera.zoom = 1.37;
  camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
  const original = {
    position: camera.position.clone(), quaternion: camera.quaternion.clone(), up: camera.up.clone(), zoom: camera.zoom,
    projection: camera.projectionMatrix.clone(), background: scene.background, ratio: renderer.ratio,
    size: renderer.size.clone(), clearColor: renderer.clearColor.clone(), alpha: renderer.clearAlpha,
  };
  // World points on all four viewport corners must project to the same locations
  // after capture, including in a panned, zoomed and rolled custom view.
  const corners = [[-.99, -.99], [-.99, .99], [.99, -.99], [.99, .99]].map(([x, y]) =>
    new THREE.Vector3(x, y, .5).unproject(camera)
  );
  const state = {}, copies = [], downloads = [], creditRequests = [];
  const finalCanvas = {
    getContext: () => ({ clearRect() {}, drawImage(canvas, ...args) {
      copies.push({ width: finalCanvas.width, height: finalCanvas.height, args, sourceWidth: canvas.width, sourceHeight: canvas.height });
    } }),
    toDataURL() {
      if (options.failEncode) throw new Error('PNG encoding failed');
      return 'data:image/png,test';
    },
  };
  const setters = Object.fromEntries(['Exporting', 'ExportNotice', 'ExportError', 'ShowUpgrade', 'Credits', 'PaidCredits',
    'IsUnlimited', 'IsSubscriptionUnlimited', 'IsLifetimeAllAccess', 'HasWatermark', 'Exported'].map(name =>
    ['set' + name, value => { state[name] = value; }]
  ));
  const context = {
    THREE, getSquareExportPlan, resizeSquareExportRenderer, getSafeExportPlan: legacyPlan,
    rendererRef: { current: renderer }, sceneRef: { current: scene }, cameraRef: { current: camera },
    debugStaticRef: { current: {} }, isSignedIn: true, isUnlimited: true, credits: 999,
    transparentBg: options.transparent ?? false, viewportBgColor: '#665544', debugMode: false,
    exportResolution: options.resolution ?? 2048, exportSupersample: options.supersample ?? 2,
    openBuilderAuth() { throw new Error('Unexpected auth prompt'); }, ...setters,
    performance, console: { error() {} }, setTimeout() {}, trackMetaCustomEvent() {},
    document: { createElement(type) {
      if (type === 'canvas') return finalCanvas;
      assert.equal(type, 'a');
      const anchor = { click() { downloads.push({ filename: anchor.download, url: anchor.href }); } };
      return anchor;
    } },
    async fetch(url) {
      assert.ok(copies.length, 'credit authorization happens after a complete capture');
      assert.ok(camera.projectionMatrix.equals(original.projection), 'live projection restored before authorization');
      creditRequests.push(url);
      return { ok: true, json: async () => ({ allowed: options.allowed ?? true, isUnlimited: true, hasWatermark: false }) };
    },
  };
  await vm.runInNewContext('(' + handlerSource + ')', context)();

  assert.ok(camera.position.equals(original.position)); assert.ok(camera.quaternion.equals(original.quaternion));
  assert.ok(camera.up.equals(original.up)); assert.equal(camera.zoom, original.zoom);
  assert.ok(camera.projectionMatrix.equals(original.projection), 'projection restored');
  assert.equal(scene.background, original.background); assert.ok(renderer.clearColor.equals(original.clearColor));
  assert.equal(renderer.clearAlpha, original.alpha); assert.equal(renderer.ratio, original.ratio);
  assert.ok(renderer.size.equals(original.size), 'live size restored even after failure');
  assert.equal(helper.visible, true, 'editing helper restored'); assert.equal(state.Exporting, false);
  assert.deepEqual(renderer.domElement.style, { width: '512px', height: '512px' });

  if (options.expectFailure) {
    assert.ok(state.ExportError, 'failure explains why the image could not be captured');
    assert.equal(creditRequests.length, 0, 'failed captures cannot consume credits');
    assert.equal(downloads.length, 0);
    return;
  }
  assert.equal(state.ExportError, '', 'capture succeeds');
  const edge = options.resolution ?? 2048;
  assert.equal(finalCanvas.width, edge); assert.equal(finalCanvas.height, edge, 'PNG contains the full square');
  assert.deepEqual(copies[0].args, [0, 0, edge, edge], 'entire source image is downsampled');
  assert.equal(copies[0].sourceWidth, copies[0].sourceHeight);
  const capture = renderer.captures[0];
  assert.ok(capture.projection.equals(original.projection), 'export keeps exact live square camera framing');
  assert.equal(capture.helperVisible, false, 'selection controls excluded');
  assert.equal(capture.clearAlpha, options.transparent ? 0 : 1);
  assert.equal(capture.background, options.transparent ? undefined : '665544');
  for (const corner of corners) {
    const saved = corner.clone().project(camera);
    const captured = corner.clone().applyMatrix4(camera.matrixWorldInverse).applyMatrix4(capture.projection);
    assert.ok(saved.distanceTo(captured) < 1e-12, 'all four viewport corners survive export');
  }
  assert.deepEqual(creditRequests, ['/api/user/export']);
  if (options.allowed === false) {
    assert.equal(downloads.length, 0); assert.equal(state.ShowUpgrade, true);
  } else {
    assert.equal(downloads[0].filename, `proline-helmet-${edge}x${edge}.png`);
  }
  if (options.expectSupersample) assert.equal(context.debugStaticRef.current.exportActualSupersample, options.expectSupersample);
}

let cases = 0;
for (const resolution of [1500, 2048, 3000, 4096]) {
  for (const supersample of [1, 2, 3]) {
    for (const dpr of [1, 1.5, 2, 3]) {
      await exportCase({ resolution, supersample, dpr, css: cases % 2 ? [400, 700] : [760, 428], transparent: cases % 2 === 0 });
      cases++;
    }
  }
}
await exportCase({ viewportLimit: [4096, 2048], expectSupersample: 1 });
await exportCase({ supersample: 3, allocation: 4096, expectSupersample: 2 });
await exportCase({ supersample: 3, allocation: 2048, expectSupersample: 1 });
await exportCase({ allocation: 1536, expectFailure: true });
await exportCase({ resolution: 4096, limit: 2048, expectFailure: true });
await exportCase({ failResize: true, expectFailure: true });
await exportCase({ contextLost: true, expectFailure: true });
await exportCase({ failEncode: true, expectFailure: true });
await exportCase({ allowed: false });
console.log(`PASS: ${cases} size/supersampling/DPR/background combinations retain all four square viewport corners; GPU allocation fallback, live restoration and credit safety pass.`);
