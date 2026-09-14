import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { openPlanet, reconstruct, validatePlanet } from "./read-planet.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
function fixture(height=100, {samples=16,keys=Array.from({length:6},(_,i)=>[i,0,0,0]),meta={}}={}) {
  // Hand-encoded Zstandard raw frame, independent of the exporter compressor.
  const blob = Buffer.alloc(9+samples*2);
  Buffer.from([0x28,0xb5,0x2f,0xfd,0x20,samples*2]).copy(blob);
  blob.writeUIntLE((samples*2<<3)|1,6,3);
  for (let i=0;i<samples;i++) blob.writeInt16LE(height,9+2*i);
  const blobs = Buffer.concat(keys.map(()=>blob));
  const index = Buffer.alloc(24*keys.length);
  keys.forEach(([face,lod,x,y],i)=>{
    const o=i*24; index[o]=face;index[o+1]=lod;
    index.writeUInt32LE(x,o+4);index.writeUInt32LE(y,o+8);
    index.writeBigUInt64LE(BigInt(i*blob.length),o+12);index.writeUInt32LE(blob.length,o+20);
  });
  const manifest = {node_resolution:2,node_skirt:1,node_stride:4,dense_lod:0,leaf_lod:1,
    radius_m:1593000,max_error_m:12,...meta,content_identity:"sha256-manifest-index-blobs-v1",
    blobs_sha256:sha(blobs),index_sha256:sha(index)};
  manifest.content_key=createHash("sha256").update("planet-package-v1\0").update(JSON.stringify(manifest)).digest("hex");
  const json=Buffer.from(JSON.stringify(manifest)), header=Buffer.alloc(32);
  header.write("PLANETPK");header.writeUInt32LE(1,8);header.writeUInt32LE(json.length,12);
  header.writeUInt32LE(keys.length,16);header.writeUInt32LE(24,20);header.writeBigUInt64LE(BigInt(32+json.length+index.length),24);
  return Buffer.concat([header,json,index,blobs]);
}

const root=mkdtempSync(join(tmpdir(),"planet-reader-"));
try {
  const a=join(root,"a.planet"),b=join(root,"b.planet");
  writeFileSync(a,fixture(100));writeFileSync(b,fixture(200));
  assert.deepEqual(validatePlanet(a),{nodes:6,integrity:"verified SHA-256 manifest, index and blobs"});
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
  let bad=fixture();bad.writeUInt32LE(2,8);reject(bad,/version/);
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
  console.log("package reader: independent files, structural failures, exact decoding and content corruption checks pass");
} finally {rmSync(root,{recursive:true,force:true});}
