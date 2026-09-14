import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createPackageOutput } from "./package-output.mjs";

const root = await mkdtemp(join(tmpdir(), "planet-output-"));
try {
  const path = join(root, "test.planet");
  await writeFile(path, "previous valid package");
  const aborted = await createPackageOutput(path);
  await aborted.append(Buffer.from("incomplete"));
  assert.equal(await readFile(path, "utf8"), "previous valid package");
  await aborted.abort();
  const rejected = await createPackageOutput(path);
  await rejected.append(Buffer.from("bad payload"));
  await assert.rejects(rejected.commit([Buffer.from("header")], () => { throw new Error("rejected payload"); }), /rejected payload/);
  assert.equal(await readFile(path, "utf8"), "previous valid package");
  const accepted = await createPackageOutput(path);
  // Cross multiple copy chunks and preserve exact append offsets.
  const payload = Buffer.alloc(17 * 1024 * 1024 + 7, 0xa3);
  assert.equal(await accepted.append(payload), 0);
  assert.equal(await accepted.append(Buffer.from("tail")), payload.length);
  assert.equal(accepted.digest(), createHash("sha256").update(payload).update("tail").digest("hex"));
  let verified = false;
  await accepted.commit([Buffer.from("head")], async candidate => {
    assert.equal(await readFile(path, "utf8"), "previous valid package");
    assert.deepEqual(await readFile(candidate), Buffer.concat([Buffer.from("head"), payload, Buffer.from("tail")]));
    verified = true;
  });
  assert.equal(verified, true);
  assert.equal((await readFile(path)).length, payload.length + 8);
  assert.deepEqual(await readdir(root), ["test.planet"]);
  await assert.rejects(accepted.append(Buffer.from("late")), /closed/);
  console.log("package publication: old destination survives abort/rejection; streamed output is verified before replacement");
} finally { await rm(root, {recursive:true, force:true}); }
