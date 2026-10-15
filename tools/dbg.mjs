import {NodeIO} from '@gltf-transform/core';import {ALL_EXTENSIONS} from '@gltf-transform/extensions';import {MeshoptDecoder} from 'meshoptimizer';
await MeshoptDecoder.ready;
const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder});
const doc=await io.read(process.argv[2]);const r=doc.getRoot();
const c={};for(const a of r.listAccessors()){const ps=a.listParents().map(p=>p.propertyType).filter(t=>t!=='Root');const k=ps.join(',')||'none';c[k]=(c[k]||0)+1;}
console.log(c);
let tgt=0;for(const m of r.listMeshes())for(const p of m.listPrimitives())tgt+=p.listTargets().length;console.log('morph targets',tgt);
