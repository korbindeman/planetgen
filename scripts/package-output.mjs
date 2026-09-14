/** Stream a package beside its destination and publish only after validation.
 * A failed build or interrupted process never truncates the last good package.
 * Abandoned temporary files can remain after a forced process termination.
 */
import { open, rename, unlink } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";

async function writeAll(handle, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
    if (!bytesWritten) throw new Error("package write made no progress");
    offset += bytesWritten;
  }
}

export async function createPackageOutput(destination) {
  const prefix = `${destination}.${randomUUID()}`;
  const blobPath = `${prefix}.blobs`, pendingPath = `${prefix}.pending`;
  let blobs = await open(blobPath, "wx"), pending = null;
  let length = 0, committed = false;
  const hash = createHash("sha256");
  const cleanup = async () => {
    if (blobs) { await blobs.close(); blobs = null; }
    if (pending) { await pending.close(); pending = null; }
    for (const path of [blobPath, pendingPath]) {
      try { await unlink(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  };
  return {
    async append(bytes) {
      if (!blobs || committed) throw new Error("package output is closed");
      const offset = length;
      await writeAll(blobs, bytes);
      hash.update(bytes); length += bytes.length;
      return offset;
    },
    digest() { return hash.copy().digest("hex"); },
    async commit(front, validate) {
      if (!blobs || committed) throw new Error("package output is closed");
      try {
        await blobs.close(); blobs = null;
        pending = await open(pendingPath, "wx");
        for (const bytes of front) await writeAll(pending, bytes);
        const source = await open(blobPath, "r");
        try {
          const chunk = Buffer.alloc(8 * 1024 * 1024);
          let copied = 0;
          while (copied < length) {
            const { bytesRead } = await source.read(chunk, 0, Math.min(chunk.length, length - copied), copied);
            if (!bytesRead) throw new Error("truncated package staging data");
            await writeAll(pending, chunk.subarray(0, bytesRead)); copied += bytesRead;
          }
        } finally { await source.close(); }
        await pending.sync();
        await pending.close(); pending = null;
        await validate(pendingPath);
        // Do not unlink the destination first, even on a sharing violation.
        await rename(pendingPath, destination);
        committed = true;
      } finally { await cleanup(); }
    },
    abort: cleanup,
  };
}
