import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { openPlanet, reconstruct, centimetres, nodeHeights, validatePlanet } from "./read-planet.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const FRACTION = {encoding:"int8-centimetres-v1",band_m:64,sea_level_m:0};
// Hand-encoded Zstandard raw frame, independent of the exporter compressor.
function frame(values, cm=null) {
  const size = values.length*2 + (cm ? cm.length : 0);
  const blob = Buffer.alloc(9+size);
  Buffer.from([0x28,0xb5,0x2f,0xfd,0x20,size]).copy(blob);
  blob.writeUIntLE((size<<3)|1,6,3);
  values.forEach((v,i)=>blob.writeInt16LE(v,9+2*i));
  if (cm) cm.forEach((c,i)=>blob.writeInt8(c,9+2*values.length+i));
  return blob;
}
function fixture(height=100, {samples=16,keys=Array.from({length:6},(_,i)=>[i,0,0,0]),meta={},version=1,cm=null,payloads=null}={}) {
  const blobList = payloads ?? keys.map(()=>frame(Array(samples).fill(height),cm));
  const blobs = Buffer.concat(blobList);
  const index = Buffer.alloc(24*keys.length);
  let offset = 0;
  keys.forEach(([face,lod,x,y],i)=>{
    const o=i*24; index[o]=face;index[o+1]=lod;
    index.writeUInt32LE(x,o+4);index.writeUInt32LE(y,o+8);
    index.writeBigUInt64LE(BigInt(offset),o+12);index.writeUInt32LE(blobList[i].length,o+20);
    offset += blobList[i].length;
  });
  const manifest = {node_resolution:2,node_skirt:1,node_stride:4,dense_lod:0,leaf_lod:1,
    radius_m:1593000,max_error_m:12,...(version===2?{height_fraction:FRACTION}:{}),...meta,
    content_identity:"sha256-manifest-index-blobs-v1",blobs_sha256:sha(blobs),index_sha256:sha(index)};
  manifest.content_key=createHash("sha256").update("planet-package-v1\0").update(JSON.stringify(manifest)).digest("hex");
  const json=Buffer.from(JSON.stringify(manifest)), header=Buffer.alloc(32);
  header.write("PLANETPK");header.writeUInt32LE(version,8);header.writeUInt32LE(json.length,12);
  header.writeUInt32LE(keys.length,16);header.writeUInt32LE(24,20);header.writeBigUInt64LE(BigInt(32+json.length+index.length),24);
  return Buffer.concat([header,json,index,blobs]);
}

const root=mkdtempSync(join(tmpdir(),"planet-reader-"));
try {
  const a=join(root,"a.planet"),b=join(root,"b.planet");
  writeFileSync(a,fixture(100));writeFileSync(b,fixture(200));
  assert.deepEqual(validatePlanet(a),{nodes:6,fractional:0,integrity:"verified SHA-256 manifest, index and blobs"});
  const pa=openPlanet(a),pb=openPlanet(b);
  try {
    assert.equal(reconstruct(pa,0,0,0,0)[0],100);
    assert.equal(reconstruct(pb,0,0,0,0)[0],200,"open packages must not share decoded nodes by address");
    assert.equal(reconstruct(pa,0,0,0,0)[0],100);
  } finally {pa.close();pb.close();}
  assert.throws(()=>reconstruct(pa,0,0,0,0),/closed/);
  const reject=(bytes,reason,validate=false)=>{
    writeFileSync(a,bytes);
    assert.throws(()=>validate?validatePlanet(a):openPlanet(a),reason);
  };
  let bad=fixture();bad.writeUInt32LE(3,8);reject(bad,/version/);
  bad=fixture();bad.writeUInt32LE(0xffffffff,12);reject(bad,/outside/);
  bad=fixture();bad.writeUInt32LE(1,20);reject(bad,/outside/);
  bad=fixture();bad.writeBigUInt64LE(0xffffffffffffffffn,24);reject(bad,/outside/);
  reject(fixture(100,{meta:{node_stride:3}}),/layout/);
  reject(fixture(100,{meta:{leaf_lod:31}}),/levels/);
  reject(fixture(100,{keys:[[0,0,0,0],[0,0,0,0]]}),/duplicate/);
  reject(fixture(100,{keys:[[0,0,0,0],[0,2,0,0]],meta:{leaf_lod:2}}),/parent/);
  reject(fixture(100,{keys:[[0,0,0,0]]}),/dense/);
  reject(fixture(100,{keys:[[0,128,0,0]]}),/residual/);
  bad=fixture();let at=32+bad.readUInt32LE(12);bad.writeBigUInt64LE(0n,at+24+12);reject(bad,/overlapping/);
  bad=fixture();reject(bad.subarray(0,bad.length-1),/outside/);
  reject(fixture(100,{samples:15}),/payload/,true);
  // Payload still decodes to the right length; only the content check detects it.
  bad=fixture();bad.writeInt16LE(101,bad.length-2);reject(bad,/blob checksum/,true);
  bad=fixture();at=32+bad.readUInt32LE(12);bad.writeUInt16LE(1,at+2);reject(bad,/index checksum/,true);

  // Format 2: centimetres follow the int16 values in the same frame. The
  // metre channel alone predicts children; each node carries its own
  // centimetres, residual or not.
  const cm = Int8Array.from({length:16},(_,i)=>i%2?-99:37);
  writeFileSync(a,fixture(0,{version:2,cm}));
  assert.deepEqual(validatePlanet(a),{nodes:6,fractional:6,integrity:"verified SHA-256 manifest, index and blobs"});
  let p=openPlanet(a);
  try {
    assert.equal(p.version,2);
    assert.equal(reconstruct(p,3,0,0,0)[0],0);
    assert.deepEqual([...centimetres(p,3,0,0,0)],[...cm]);
    assert.deepEqual([...nodeHeights(p,3,0,0,0)].slice(0,2),[0.37,-0.99]);
  } finally {p.close();}
  const parentValues=Array(16).fill(10), childResidual=Array(16).fill(-9);
  const childCm=Int8Array.from({length:16},()=>-60);
  const keys=[[0,0,0,0],[0,128|1,0,0],[1,0,0,0],[2,0,0,0],[3,0,0,0],[4,0,0,0],[5,0,0,0]];
  const payloads=keys.map(([,lod])=>lod&128?frame(childResidual,childCm):frame(parentValues));
  writeFileSync(a,fixture(0,{version:2,keys,payloads,meta:{absolute_lod:0}}));
  assert.deepEqual(validatePlanet(a),{nodes:7,fractional:1,integrity:"verified SHA-256 manifest, index and blobs"});
  p=openPlanet(a);
  try {
    assert.equal(centimetres(p,0,0,0,0),null,"a node without centimetres decodes to its metres");
    assert.deepEqual([...nodeHeights(p,0,0,0,0)],Array(16).fill(10));
    assert.deepEqual([...reconstruct(p,0,1,0,0)],Array(16).fill(1),"residuals predict from the metre channel");
    assert.deepEqual([...nodeHeights(p,0,1,0,0)],Array(16).fill(0.4));
  } finally {p.close();}
  writeFileSync(a,fixture(0,{version:2}));
  assert.equal(validatePlanet(a).fractional,0);
  reject(fixture(0,{cm}),/payload is 48 bytes, expected 32$/,true);
  reject(fixture(0,{version:2,cm,samples:15}),/expected 32 or 48/,true);
  reject(fixture(0,{version:2,meta:{height_fraction:undefined}}),/height fraction/);
  reject(fixture(0,{version:2,meta:{height_fraction:{...FRACTION,encoding:"int8-decimetres"}}}),/height fraction/);
  reject(fixture(0,{meta:{height_fraction:FRACTION}}),/height fraction/);
  reject(fixture(0,{version:2,cm:Int8Array.from({length:16},()=>100)}),/outside -99..99/,true);
  console.log("package reader: independent files, structural failures, exact decoding, format 2 centimetres and content corruption checks pass");
} finally {rmSync(root,{recursive:true,force:true});}
