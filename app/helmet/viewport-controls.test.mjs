import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {DRACOLoader} from 'three/addons/loaders/DRACOLoader.js';
import {TrackballControls} from 'three/addons/controls/TrackballControls.js';
import {HELMET_VIEWS, normalizeHelmetOrientation, visibleHelmetBounds, setHelmetView, recenterHelmet, rollHelmetView, levelHelmetView, squareViewportSize} from './viewport-controls.js';
const dracoSource=fs.readFileSync('node_modules/three/examples/jsm/loaders/DRACOLoader.js','utf8');
const decoderSource=fs.readFileSync('node_modules/three/examples/jsm/libs/draco/gltf/draco_decoder.js','utf8');
const callbacks=new Map();let taskId=0;
const context=vm.createContext({Float32Array,Int8Array,Int16Array,Int32Array,Uint8Array,Uint16Array,Uint32Array,console, setTimeout, clearTimeout, TextDecoder, performance, self:{Float32Array,Int8Array,Int16Array,Int32Array,Uint8Array,Uint16Array,Uint32Array,postMessage(message){const c=callbacks.get(message.id);callbacks.delete(message.id);message.type==='error'?c.reject(new Error(message.error)):c.resolve(message.geometry);}}});
vm.runInContext(decoderSource+'\n'+dracoSource.slice(dracoSource.indexOf('function DRACOWorker()'),dracoSource.lastIndexOf('export {'))+'\nDRACOWorker();',context);
context.onmessage({data:{type:'init',decoderConfig:{}}});
const geometryFactory=new DRACOLoader();
const draco={preload(){},decodeDracoFile(buffer,callback,attributeIDs,attributeTypes){const id=++taskId;return new Promise((resolve,reject)=>{callbacks.set(id,{resolve,reject});context.onmessage({data:{type:'decode',id,buffer,taskConfig:{attributeIDs,attributeTypes,useUniqueIDs:true}}});}).then(g=>callback(geometryFactory._createGeometry(g)));}};
const bytes=fs.readFileSync('public/Riddell-Axiom-ProLine-FINAL-v2.glb');
const model=(await new GLTFLoader().setDRACOLoader(draco).parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'')).scene;
const key=n=>n.toLowerCase().replace(/[^a-z0-9]/g,'');
const find=n=>{let result;model.traverse(o=>{if(key(o.name)===key(n))result=o});assert.ok(result,n);return result};
const bumper=find('Front Bumper');const before=new THREE.Box3().setFromObject(bumper).getCenter(new THREE.Vector3());assert.ok(before.x>0.1);
normalizeHelmetOrientation(model,'axiom');const after=new THREE.Box3().setFromObject(bumper).getCenter(new THREE.Vector3());assert.ok(after.z>0.1);assert.ok(Math.abs(after.x)<0.001);assert.equal(model.rotation.y,0);const children=model.children.length;normalizeHelmetOrientation(model,'axiom');assert.equal(model.children.length,children);
const carrier=find('Decal Surface');carrier.userData.decalSurfaceRoot=true;carrier.visible=false;find('Facemask B').visible=false;
const box=new THREE.Box3().setFromObject(model);const center=box.getCenter(new THREE.Vector3());const size=box.getSize(new THREE.Vector3());const scale=1.8/Math.max(size.x,size.y,size.z);model.scale.setScalar(scale);model.position.sub(center.multiplyScalar(scale));model.updateMatrixWorld(true);
const surfaces=[];carrier.traverse(o=>{if(o.isMesh){o.material.side=THREE.DoubleSide;surfaces.push(o)}});
const shellCenter=new THREE.Box3().setFromObject(carrier).getCenter(new THREE.Vector3());
for(const sign of [-1,1]){const ray=new THREE.Raycaster(new THREE.Vector3(sign*3,shellCenter.y,shellCenter.z),new THREE.Vector3(-sign,0,0));const hit=ray.intersectObjects(surfaces,false)[0];assert.ok(hit,'side decal raycast');assert.equal(Math.sign(hit.point.x-shellCenter.x),sign);}
const backHit=new THREE.Raycaster(new THREE.Vector3(shellCenter.x,shellCenter.y,-3),new THREE.Vector3(0,0,1)).intersectObjects(surfaces,false)[0];assert.ok(backHit);assert.ok(backHit.point.z<shellCenter.z);
const camera=new THREE.PerspectiveCamera(35,1,0.01,100);camera.position.set(0,0,3);const controls=new TrackballControls(camera);controls.staticMoving=true;
function projectedCenter(){camera.updateMatrixWorld(true);let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;const p=new THREE.Vector3();const walk=o=>{if(!o.visible||o.userData.decalSurfaceRoot)return;if(o.isMesh){const a=o.geometry.attributes.position;for(let i=0;i<a.count;i++){p.fromBufferAttribute(a,i).applyMatrix4(o.matrixWorld).project(camera);minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y);}}o.children.forEach(walk)};walk(model);return [(minX+maxX)/2,(minY+maxY)/2]}
for(const id of Object.keys(HELMET_VIEWS)){setHelmetView(camera,controls,model,id);assert.ok(projectedCenter().every(v=>Math.abs(v)<1e-7),id+' centered');const offset=camera.position.clone().sub(controls.target).normalize();assert.ok(offset.dot(new THREE.Vector3(...HELMET_VIEWS[id].offset).normalize())>0.999999,id+' direction');}
camera.position.set(1.8,2.1,-2.3);controls.target.set(.3,-.2,.15);camera.up.set(.2,1,.3).normalize();camera.lookAt(controls.target);controls.update();rollHelmetView(camera,controls,.4);const up=camera.up.clone(),offset=camera.position.clone().sub(controls.target),distance=offset.length();recenterHelmet(camera,controls,model);assert.ok(projectedCenter().every(v=>Math.abs(v)<1e-7));assert.ok(Math.abs(camera.position.distanceTo(controls.target)-distance)<1e-9);assert.ok(camera.up.distanceTo(up)<1e-9);assert.ok(camera.position.clone().sub(controls.target).distanceTo(offset)<1e-9);
rollHelmetView(camera,controls,-.4);levelHelmetView(camera,controls);assert.ok(camera.up.dot(camera.position.clone().sub(controls.target).normalize())<1e-9);
for(const sign of [-1,1]){controls.target.set(0,0,0);camera.position.set(0,sign*3,0);levelHelmetView(camera,controls);assert.ok(camera.up.toArray().every(Number.isFinite));assert.ok(Math.abs(camera.up.length()-1)<1e-9);}
assert.equal(squareViewportSize(1366,720),720);assert.equal(squareViewportSize(1280,800),680);assert.equal(squareViewportSize(1920,1032),1032);assert.ok(!visibleHelmetBounds(model).isEmpty());
const legacy=new THREE.Group();legacy.add(new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial()));const original=legacy.children[0];normalizeHelmetOrientation(legacy,'speedflex');assert.equal(legacy.children[0],original);
console.log('PASS: actual Axiom orientation, side/rear decal raycasts, all six preset directions, exact perspective centering, preserved angle/zoom/roll, level at both poles, square viewport sizing, unchanged SpeedFlex orientation.');
