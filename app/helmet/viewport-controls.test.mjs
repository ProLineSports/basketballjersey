import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {DRACOLoader} from 'three/addons/loaders/DRACOLoader.js';
import {TrackballControls} from 'three/addons/controls/TrackballControls.js';
import {HELMET_VIEWS, normalizeHelmetOrientation, visibleHelmetBounds, setHelmetView, recenterHelmet, rollHelmetView, levelHelmetView, squareViewportSize} from './viewport-controls.js';
import {DEFAULT_SIDE_LOGO_PLACEMENT, DEFAULT_REAR_DECAL_PLACEMENTS, separateAxiomRearBumper, positionShadowFloor, textureFootprint, rearStickerBaseHeight, bumperSurfaceBounds, shadowFloorIsVisible} from './model-adjustments.js';
import {DecalGeometry} from 'three/addons/geometries/DecalGeometry.js';
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
// Rear bumper must move to the bumper hierarchy without changing the geometry.
const hardware=find('Axiom Hardware');
const sourceGeometry=hardware.geometry;
const sourceTriangleCount=sourceGeometry.index.count/3;
const sourceVertices=new Set();
for(let i=0;i<sourceGeometry.attributes.position.count;i++){
  sourceVertices.add(Object.values(sourceGeometry.attributes).flatMap(a=>Array.from({length:a.itemSize},(_,c)=>a.getComponent(i,c))).join(','));
}
const hardwareTransform=hardware.matrixWorld.clone();
const rearBumper=separateAxiomRearBumper(model);
assert.ok(rearBumper,'rear bumper separated');
assert.equal(rearBumper.parent,find('Bumpers'));
assert.equal(rearBumper.geometry.index.count/3,5984,'only the rear bumper component');
assert.equal(hardware.geometry.index.count/3+rearBumper.geometry.index.count/3,sourceTriangleCount,'all triangles retained exactly once');
assert.ok(rearBumper.matrixWorld.elements.every((v,i)=>Math.abs(v-hardwareTransform.elements[i])<1e-9),'authored transform preserved');
for(const geometry of [rearBumper.geometry,hardware.geometry]){
  for(let i=0;i<geometry.attributes.position.count;i++){
    const values=Object.values(geometry.attributes).flatMap(a=>Array.from({length:a.itemSize},(_,c)=>a.getComponent(i,c))).join(',');
    assert.ok(sourceVertices.has(values),'position, normal and UV attributes unchanged');
  }
}
assert.notEqual(rearBumper.material,hardware.material,'independent bumper color');
const hardwareColor=hardware.material.color.clone();
find('Bumpers').traverse(o=>{if(o.isMesh)o.material.color.set('#a233dd')});
assert.equal(rearBumper.material.color.getHexString(),'a233dd');
assert.equal(bumper.material.color.getHexString(),'a233dd');
assert.ok(hardware.material.color.equals(hardwareColor),'hardware keeps its own color');
assert.equal(separateAxiomRearBumper(model),null,'separation is idempotent');
const carrier=find('Decal Surface');carrier.userData.decalSurfaceRoot=true;carrier.visible=false;find('Facemask B').visible=false;
const box=new THREE.Box3().setFromObject(model);const center=box.getCenter(new THREE.Vector3());const size=box.getSize(new THREE.Vector3());const scale=1.8/Math.max(size.x,size.y,size.z);model.scale.setScalar(scale);model.position.sub(center.multiplyScalar(scale));model.updateMatrixWorld(true);
const surfaces=[];carrier.traverse(o=>{if(o.isMesh){o.material.side=THREE.DoubleSide;surfaces.push(o)}});
const shellCenter=new THREE.Box3().setFromObject(carrier).getCenter(new THREE.Vector3());
for(const sign of [-1,1]){const ray=new THREE.Raycaster(new THREE.Vector3(sign*3,shellCenter.y,shellCenter.z),new THREE.Vector3(-sign,0,0));const hit=ray.intersectObjects(surfaces,false)[0];assert.ok(hit,'side decal raycast');assert.equal(Math.sign(hit.point.x-shellCenter.x),sign);}
const backHit=new THREE.Raycaster(new THREE.Vector3(shellCenter.x,shellCenter.y,-3),new THREE.Vector3(0,0,1)).intersectObjects(surfaces,false)[0];assert.ok(backHit);assert.ok(backHit.point.z<shellCenter.z);
// Default side logos move forward to the marked shell panel on both sides.
const carrierBox=new THREE.Box3().setFromObject(carrier);
const carrierSize=carrierBox.getSize(new THREE.Vector3());
const defaultLogoHits=[];
for(const sign of [-1,1]){
  const origin=new THREE.Vector3(sign*3,carrierBox.min.y+carrierSize.y*DEFAULT_SIDE_LOGO_PLACEMENT.yNorm,shellCenter.z+carrierSize.z*DEFAULT_SIDE_LOGO_PLACEMENT.zNorm);
  const hit=new THREE.Raycaster(origin,new THREE.Vector3(-sign,0,0)).intersectObjects(surfaces,false)[0];
  assert.ok(hit,'default logo hits side panel');defaultLogoHits.push(hit.point);
  const oldHit=new THREE.Raycaster(new THREE.Vector3(sign*3,carrierBox.min.y+carrierSize.y*.64,shellCenter.z-carrierSize.z*.18),new THREE.Vector3(-sign,0,0)).intersectObjects(surfaces,false)[0];
  assert.ok(hit.point.z-oldHit.point.z>.3,'logo moves forward to the X');
}
assert.ok(Math.abs(defaultLogoHits[0].y-defaultLogoHits[1].y)<1e-8);
assert.ok(Math.abs(defaultLogoHits[0].z-defaultLogoHits[1].z)<1e-8);
// The formerly invisible flag/warning targets were below Axiom's open rear shell.
for(const {across,vertical,rotation} of [...Object.values(DEFAULT_REAR_DECAL_PLACEMENTS),{across:0,vertical:20,rotation:0}]){
  const origin=new THREE.Vector3(shellCenter.x-across/100*carrierSize.x*.34,carrierBox.min.y+carrierSize.y*(rearStickerBaseHeight('axiom')+vertical/100*.24),-3);
  const hit=new THREE.Raycaster(origin,new THREE.Vector3(0,0,1)).intersectObjects(surfaces,false)[0];
  assert.ok(hit,'rear sticker target intersects the carrier');
  const normal=hit.face.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld));
  assert.ok(normal.z<-.8,'rear-facing film');
  const helper=new THREE.Object3D();helper.position.copy(hit.point);helper.lookAt(hit.point.clone().add(normal));helper.rotateZ(THREE.MathUtils.degToRad(rotation));
  const geometry=new DecalGeometry(hit.object,hit.point,new THREE.Euler().setFromQuaternion(helper.quaternion),new THREE.Vector3(.2,.1,.35));
  assert.ok(geometry.attributes.position.count>100,'rear artwork has renderable triangles');geometry.dispose();
}
// Fit each bumper separately: the rear is wider than the front, both centers hit.
for(const slot of ['front','rear']){
  const bounds=bumperSurfaceBounds(model,[bumper,rearBumper],slot);
  assert.equal(bounds.meshes.length,1,'only this bumper receives artwork');
  const sign=slot==='front'?1:-1;
  const origin=model.localToWorld(new THREE.Vector3(bounds.centerX,bounds.centerY,sign*1));
  const hit=new THREE.Raycaster(origin,new THREE.Vector3(0,0,-sign)).intersectObjects(bounds.meshes,false)[0];
  assert.ok(hit,slot+' centered artwork raycast');
  assert.ok(bounds.worldSize.x>(slot==='front'?.4:.7),'use scaled world size');
  if(slot==='rear'){
    const normal=hit.face.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld));
    const helper=new THREE.Object3D();helper.position.copy(hit.point);helper.lookAt(hit.point.clone().add(normal));
    const geometry=new DecalGeometry(hit.object,hit.point,new THREE.Euler().setFromQuaternion(helper.quaternion),new THREE.Vector3(.6,.15,.2));
    assert.ok(geometry.attributes.position.count>100,'rear bumper wordmark has renderable triangles');geometry.dispose();
  }
}
// Padding and wide texture canvases cannot stretch the source artwork.
for(const aspect of [.5,1,1.9,4,8,12])for(const [w,h] of [[1024,1024],[1024,512],[4096,2048],[6144,1536]]){
  const fit=Math.min((w-240)/aspect,h-240);
  const pack={aspect,contentWidthFraction:fit*aspect/w,contentHeightFraction:fit/h};
  const footprint=textureFootprint(.35,pack);
  assert.ok(Math.abs(footprint.width/footprint.height-w/h)<1e-10,'projected canvas preserves its aspect');
  assert.ok(Math.abs(footprint.width*pack.contentWidthFraction/(footprint.height*pack.contentHeightFraction)-aspect)<1e-10,'visible artwork preserves its native aspect');
}
const studio=new THREE.Scene();studio.add(model);
const floor=new THREE.Mesh(new THREE.PlaneGeometry(10,10),new THREE.ShadowMaterial());studio.add(floor);positionShadowFloor(floor,model);
assert.ok(Math.abs(floor.position.y-visibleHelmetBounds(model).min.y+.03)<1e-9,'floor just below the helmet');
const floorMatrix=floor.matrixWorld.clone();
const camera=new THREE.PerspectiveCamera(35,1,0.01,100);camera.position.set(0,0,3);const controls=new TrackballControls(camera);controls.staticMoving=true;
function projectedCenter(){camera.updateMatrixWorld(true);let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;const p=new THREE.Vector3();const walk=o=>{if(!o.visible||o.userData.decalSurfaceRoot)return;if(o.isMesh){const a=o.geometry.attributes.position;for(let i=0;i<a.count;i++){p.fromBufferAttribute(a,i).applyMatrix4(o.matrixWorld).project(camera);minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y);}}o.children.forEach(walk)};walk(model);return [(minX+maxX)/2,(minY+maxY)/2]}
for(const id of Object.keys(HELMET_VIEWS)){setHelmetView(camera,controls,model,id);assert.ok(projectedCenter().every(v=>Math.abs(v)<1e-7),id+' centered');const offset=camera.position.clone().sub(controls.target).normalize();assert.ok(offset.dot(new THREE.Vector3(...HELMET_VIEWS[id].offset).normalize())>0.999999,id+' direction');}
camera.position.set(1.8,2.1,-2.3);controls.target.set(.3,-.2,.15);camera.up.set(.2,1,.3).normalize();camera.lookAt(controls.target);controls.update();rollHelmetView(camera,controls,.4);const up=camera.up.clone(),offset=camera.position.clone().sub(controls.target),distance=offset.length();recenterHelmet(camera,controls,model);assert.ok(projectedCenter().every(v=>Math.abs(v)<1e-7));assert.ok(Math.abs(camera.position.distanceTo(controls.target)-distance)<1e-9);assert.ok(camera.up.distanceTo(up)<1e-9);assert.ok(camera.position.clone().sub(controls.target).distanceTo(offset)<1e-9);
rollHelmetView(camera,controls,-.4);levelHelmetView(camera,controls);assert.ok(camera.up.dot(camera.position.clone().sub(controls.target).normalize())<1e-9);
for(const sign of [-1,1]){controls.target.set(0,0,0);camera.position.set(0,sign*3,0);levelHelmetView(camera,controls);assert.ok(camera.up.toArray().every(Number.isFinite));assert.ok(Math.abs(camera.up.length()-1)<1e-9);}
assert.equal(squareViewportSize(1366,720),720);assert.equal(squareViewportSize(1280,800),680);assert.equal(squareViewportSize(1920,1032),1032);assert.ok(!visibleHelmetBounds(model).isEmpty());
assert.ok(floor.matrixWorld.equals(floorMatrix),'floor stays fixed through presets, pan, roll and centering');
assert.equal(floor.parent,studio,'floor is independent of the helmet');
camera.position.set(0,0,3);controls.target.set(0,0,0);camera.up.set(0,1,0);camera.lookAt(controls.target);controls.update();
assert.equal(shadowFloorIsVisible(camera,floor),true,'upright ground shadow');
const screenRightPoint=new THREE.Vector3(.3,0,0);rollHelmetView(camera,controls,Math.PI/12);
assert.ok(screenRightPoint.clone().project(camera).y>0,'left-arrow positive roll moves the helmet counterclockwise');
rollHelmetView(camera,controls,-Math.PI/12);
rollHelmetView(camera,controls,Math.PI);
assert.equal(shadowFloorIsVisible(camera,floor),false,'no ceiling shadow when rolled upside down');
camera.position.set(0,floor.position.y-.5,3);camera.up.set(0,1,0);camera.lookAt(controls.target);camera.updateMatrixWorld(true);
assert.equal(shadowFloorIsVisible(camera,floor),false,'no ground shadow while viewing from underneath');
const legacy=new THREE.Group();legacy.add(new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial()));const original=legacy.children[0];normalizeHelmetOrientation(legacy,'speedflex');assert.equal(legacy.children[0],original);
// The shared projection changes must also land on both SpeedFlex bumpers.
const speedflexBytes=fs.readFileSync('public/SpeedFlex-draco.glb');
// Geometry checks need no browser image decoder or embedded textures.
const speedflexLoader=new GLTFLoader().setDRACOLoader(draco).register(()=>({name:'HeadlessGeometry',loadMaterial:()=>Promise.resolve(new THREE.MeshStandardMaterial())}));
const speedflex=(await speedflexLoader.parseAsync(speedflexBytes.buffer.slice(speedflexBytes.byteOffset,speedflexBytes.byteOffset+speedflexBytes.byteLength),'')).scene;
const speedflexBox=new THREE.Box3().setFromObject(speedflex),speedflexSize=speedflexBox.getSize(new THREE.Vector3()),speedflexCenter=speedflexBox.getCenter(new THREE.Vector3());
const speedflexScale=1.8/Math.max(speedflexSize.x,speedflexSize.y,speedflexSize.z);speedflex.scale.setScalar(speedflexScale);speedflex.position.sub(speedflexCenter.multiplyScalar(speedflexScale));speedflex.updateMatrixWorld(true);
const speedflexBumpers=[];speedflex.traverse(o=>{if(key(o.name)==='bumpers')o.traverse(child=>{if(child.isMesh)speedflexBumpers.push(child)})});
assert.ok(speedflexBumpers.length);
for(const slot of ['front','rear']){
  const bounds=bumperSurfaceBounds(speedflex,speedflexBumpers,slot),sign=slot==='front'?1:-1;
  const origin=speedflex.localToWorld(new THREE.Vector3(bounds.centerX,bounds.centerY,sign*(Math.max(Math.abs(bounds.minZ),Math.abs(bounds.maxZ))+1)));
  assert.ok(new THREE.Raycaster(origin,new THREE.Vector3(0,0,-sign)).intersectObjects(bounds.meshes,false).length,'SpeedFlex '+slot+' bumper center');
}
console.log('PASS: actual Axiom orientation, side/rear decal raycasts, all six preset directions, exact perspective centering, preserved angle/zoom/roll, level at both poles, square viewport sizing, unchanged SpeedFlex orientation; rear bumper geometry/normals/colors; forward default logos; fixed shadow floor; visible rear sticker/bumper geometry; native artwork proportions; roll arrow direction; no ceiling shadow.');
