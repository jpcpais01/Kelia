import {NodeIO} from '@gltf-transform/core';import {ALL_EXTENSIONS} from '@gltf-transform/extensions';import {MeshoptDecoder} from 'meshoptimizer';
await MeshoptDecoder.ready;
const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder});
const doc=await io.read(process.argv[2]);const r=doc.getRoot();
let animB=0,kf=0,ch=0;const seen=new Set();
for(const a of r.listAnimations())for(const c of a.listChannels()){ch++;const s=c.getSampler();for(const acc of [s.getInput(),s.getOutput()]){if(!seen.has(acc)){seen.add(acc);animB+=acc.getByteLength();}}kf+=s.getInput().getCount();}
let geoB=0;for(const m of r.listMeshes())for(const p of m.listPrimitives()){for(const a of p.listAttributes()){if(!seen.has(a)){seen.add(a);geoB+=a.getByteLength();}} const i=p.getIndices(); if(i&&!seen.has(i)){seen.add(i);geoB+=i.getByteLength();}}
let verts=0;for(const m of r.listMeshes())for(const p of m.listPrimitives())verts+=p.getAttribute('POSITION').getCount();
console.log({channels:ch,kf,animB,geoB,verts,tex:r.listTextures().map(t=>t.getName()+':'+t.getImage().byteLength)});
