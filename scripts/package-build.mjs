/** Assemble a planet package from finalized Float32 terrain.
 *
 * `build-package.mjs` resolves the project, variant and campaign; this module
 * turns the terrain's extended tiles into nodes, decides presence, encodes
 * each node and publishes the file. It is separate so a synthetic campaign can
 * exercise the whole writer against the independent reader.
 *
 * Presence and residual prediction are decided on what a reader decodes:
 * each node's metre channel predicts its children's metre channel exactly
 * (closed loop), and pruning compares the decoded retained ancestor with the
 * unquantized source of every descendant.
 */
import { createHash } from "node:crypto";
import { zstdCompressSync } from "node:zlib";
import { canPruneSubtree } from "./package-pruning.mjs";
import { createPackageOutput } from "./package-output.mjs";
import { validatePlanet } from "./read-planet.mjs";
import { reduceNodes, fillLevelSkirts } from "./package-terrain.mjs";
import {
  FORMAT_VERSION, HEIGHT_FRACTION, SEA_LEVEL_M, quantizeNode, decodeNode, nodePayload,
} from "./package-encoding.mjs";

const MAGIC = "PLANETPK";
/* A bake tile is this many nodes on a side. It is what makes the node grid a
 * power of two while the node itself need not be. */
export const NODES_PER_TILE = 8;
const NODATA = -32768;
const RECORD = 24;

/* Content identity covers metadata, the index and the actual encoded heights. */
function contentKey(manifest) {
  return createHash("sha256").update("planet-package-v1\0")
    .update(JSON.stringify(manifest)).digest("hex");
}

function maxAbsDiff(a, b) {
  let worst = 0;
  for (let k = 0; k < a.length; k++) {
    const d = Math.abs(a[k] - b[k]);
    if (d > worst) worst = d;
  }
  return worst;
}

/**
 * Write `outPath` and return its node statistics.
 *
 * `terrain` supplies `extendedTile(face, i, j, lod)` as `createPackageTerrain`
 * does. `identity` holds the manifest's body, variant, seed, radius_m,
 * tile_cells and sketch_fingerprint.
 */
export async function buildPackage({
  terrain, outPath, level, nodeRes, leafLod, denseLod, absoluteLod, errorM, fractionBandM,
  identity, progress = () => {},
}) {
  const side = nodeRes + 2;

  /* A leaf is a window on the extended tile, offset by one so the skirt lands
   * on the border the tile already carries. */
  function leafFrom(ext, span, sx, sy) {
    const out = new Float32Array(side * side);
    for (let y = 0; y < side; y++) {
      const src = (sy * nodeRes + y) * span + sx * nodeRes;
      out.set(ext.subarray(src, src + side), y * side);
    }
    return out;
  }

  /* Bilinear upsample of the parent's matching quadrant, over its stored
   * array including the skirt: what a reader predicts before rounding. */
  function upsample(parent, quadX, quadY) {
    const out = new Float64Array(side * side);
    const half = nodeRes / 2;
    const p = (x, y) => {
      const cx = Math.min(nodeRes + 1, Math.max(0, x + 1));
      const cy = Math.min(nodeRes + 1, Math.max(0, y + 1));
      return parent[cy * side + cx];
    };
    for (let y = -1; y <= nodeRes; y++) {
      for (let x = -1; x <= nodeRes; x++) {
        const fx = quadX * half + (x + 0.5) / 2 - 0.5;
        const fy = quadY * half + (y + 0.5) / 2 - 0.5;
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        const tx = fx - x0, ty = fy - y0;
        out[(y + 1) * side + (x + 1)] = p(x0, y0) * (1 - tx) * (1 - ty) + p(x0 + 1, y0) * tx * (1 - ty)
          + p(x0, y0 + 1) * (1 - tx) * ty + p(x0 + 1, y0 + 1) * tx * ty;
      }
    }
    return out;
  }

  /* The metre-channel prediction a reader reconstructs residuals against. */
  function predictFromParent(parentMetres, quadX, quadY) {
    return Int16Array.from(upsample(parentMetres, quadX, quadY), Math.round);
  }

  /* Encode one node. `parent` is the reader's reconstruction of its parent,
   * `{metres, heights}`; the predictor error is what the decoded child adds
   * to the decoded parent's continuous surface. */
  function encode(data, parent, quadX, quadY, residual) {
    const {metres, centimetres} = quantizeNode(data, fractionBandM);
    const heights = decodeNode(metres, centimetres);
    let values = metres, error = 0;
    if (parent) {
      error = Math.ceil(maxAbsDiff(heights, upsample(parent.heights, quadX, quadY)));
      if (residual) {
        const predicted = predictFromParent(parent.metres, quadX, quadY);
        values = new Int16Array(metres.length);
        for (let k = 0; k < metres.length; k++) values[k] = metres[k] - predicted[k];
      }
    }
    return {node: {metres, heights}, payload: nodePayload(values, centimetres), error, fractional: !!centimetres};
  }

  const output = await createPackageOutput(outPath);
  try {
    let blobOffset = 0, fractional = 0;
    const index = [];

    async function emit(face, lod, x, y, encoded, residual) {
      const bytes = zstdCompressSync(encoded.payload);
      await output.append(bytes);
      index.push({
        face, lod, x, y,
        offset: blobOffset,
        length: bytes.length,
        predictor_error_m: encoded.error,
        residual,
      });
      blobOffset += bytes.length;
      if (encoded.fractional) fractional++;
    }

    /*
     * One bake tile at a time: build its 8x8 leaves, reduce to the tile root,
     * and decide presence on the way down. Everything coarser than a tile root
     * is assembled afterwards from the roots, which is small.
     */
    const roots = new Map(), rootNodes = new Map();
    let emitted = 0, pruned = 0, sketchOnly = 0;
    const n = 1 << level;

    for (let face = 0; face < 6; face++) {
      for (let ti = 0; ti < n; ti++) {
        for (let tj = 0; tj < n; tj++) {
          const baseX = ti * NODES_PER_TILE;
          const baseY = (n - 1 - tj) * NODES_PER_TILE;
          /* lod -> Map(key -> Float32 source) for this tile's subtree */
          const levels = new Map();
          let covered = false;
          for (let lod = leafLod; lod >= level; lod--) {
            const {ext, span, covered: baked} = await terrain.extendedTile(face, ti, tj, lod);
            covered = baked;
            const count = 1 << (lod - level), nodes = new Map();
            for (let dy = 0; dy < count; dy++) {
              for (let dx = 0; dx < count; dx++) {
                nodes.set(`${dx},${dy}`, leafFrom(ext, span, dx, dy));
              }
            }
            levels.set(lod, nodes);
          }
          if (!covered) sketchOnly++;
          const root = levels.get(level).get("0,0");
          roots.set(`${face}/${ti}/${tj}`, root);
          /* The coarse pass emits this root; quantization is deterministic, so
           * its children predict from the same decoded node. */
          const rootNode = encode(root, null, 0, 0, false).node;
          rootNodes.set(`${face}/${ti}/${tj}`, rootNode);

          /* A missing node removes its complete subtree. Certify the decoded
           * retained ancestor against every descendant's continuous source
           * surface, and keep mixed land/water regions regardless of the
           * vertical tolerance. */
          const prunedHere = new Set();
          const recon = new Map([[`${level}/0/0`, rootNode]]);
          for (let lod = level + 1; lod <= leafLod; lod++) {
            const span = 1 << (lod - level);
            const scale = 1 << (lod - level);
            for (let dy = 0; dy < span; dy++) {
              for (let dx = 0; dx < span; dx++) {
                const parentKey = `${lod - 1}/${dx >> 1}/${dy >> 1}`;
                if (prunedHere.has(parentKey)) {
                  prunedHere.add(`${lod}/${dx}/${dy}`);
                  pruned++;
                  continue;
                }
                const data = levels.get(lod).get(`${dx},${dy}`);
                const parent = recon.get(parentKey);
                const err = maxAbsDiff(data, upsample(parent.heights, dx & 1, dy & 1));
                if (lod > denseLod && err <= errorM && canPruneSubtree({
                  parent: parent.heights, resolution: nodeRes,
                  parentLod: lod - 1, parentX: dx >> 1, parentY: dy >> 1,
                  lod, x: dx, y: dy, leafLod, levels, maxErrorM: errorM, seaLevel: SEA_LEVEL_M,
                })) {
                  prunedHere.add(`${lod}/${dx}/${dy}`);
                  pruned++;
                  continue;
                }
                const residual = lod > absoluteLod;
                const encoded = encode(data, parent, dx & 1, dy & 1, residual);
                recon.set(`${lod}/${dx}/${dy}`, encoded.node);
                await emit(face, lod, baseX * scale / NODES_PER_TILE + dx,
                  baseY * scale / NODES_PER_TILE + dy, encoded, residual);
                emitted++;
              }
            }
          }
        }
        progress(`\r  face ${face} column ${ti + 1}/${n}: ${emitted} nodes, ${pruned} pruned   `);
      }
    }

    /* Coarser than a tile root: reduce the roots themselves. Small enough to hold. */
    const coarse = new Map();
    const coarseRecon = new Map();
    for (const [key, data] of roots) {
      const [face, ti, tj] = key.split("/").map(Number);
      coarse.set(`${face}/${level}/${ti}/${(1 << level) - 1 - tj}`, data);
    }
    for (let lod = level - 1; lod >= 0; lod--) {
      const span = 1 << lod;
      for (let face = 0; face < 6; face++) {
        for (let y = 0; y < span; y++) {
          for (let x = 0; x < span; x++) {
            coarse.set(`${face}/${lod}/${x}/${y}`, reduceNodes([
              coarse.get(`${face}/${lod + 1}/${x * 2}/${y * 2}`),
              coarse.get(`${face}/${lod + 1}/${x * 2 + 1}/${y * 2}`),
              coarse.get(`${face}/${lod + 1}/${x * 2}/${y * 2 + 1}`),
              coarse.get(`${face}/${lod + 1}/${x * 2 + 1}/${y * 2 + 1}`),
            ], nodeRes));
          }
        }
      }
      fillLevelSkirts(coarse, lod, nodeRes);
    }
    for (let lod = 0; lod <= level; lod++) {
      const span = 1 << lod;
      for (let face = 0; face < 6; face++) {
        for (let y = 0; y < span; y++) {
          for (let x = 0; x < span; x++) {
            const data = coarse.get(`${face}/${lod}/${x}/${y}`);
            if (!data) continue;
            /* The coarse base is usually all absolute (lod <= absoluteLod), but
             * with --absolute-lod below the bake level it stores residuals here
             * too — predicted from the reconstructed parent, same closed loop as
             * the tile subtrees, so the chain stays exact. */
            const residual = lod > 0 && lod > absoluteLod;
            const parent = lod > 0 ? coarseRecon.get(`${face}/${lod - 1}/${x >> 1}/${y >> 1}`) : null;
            const encoded = encode(data, parent, x & 1, y & 1, residual);
            if (lod === level) {
              const rootNode = rootNodes.get(`${face}/${x}/${(1 << level) - 1 - y}`);
              if (maxAbsDiff(rootNode.metres, encoded.node.metres) !== 0)
                throw new Error("tile root encoding differs between its subtree and the coarse base");
            }
            coarseRecon.set(`${face}/${lod}/${x}/${y}`, encoded.node);
            await emit(face, lod, x, y, encoded, residual);
            emitted++;
          }
        }
      }
    }

    const blobBytes = blobOffset;
    const manifest = {
      format: "planetgen.planet",
      version: FORMAT_VERSION,
      body: identity.body,
      variant: identity.variant,
      seed: identity.seed,
      radius_m: identity.radius_m,
      frame: "planetgen equal-angle cubesphere; see src/cubesphere.js",
      bake_level: level,
      tile_cells: identity.tile_cells,
      node_resolution: nodeRes,
      node_skirt: 1,
      node_stride: side,
      leaf_lod: leafLod,
      dense_lod: denseLod,
      absolute_lod: absoluteLod,
      max_error_m: errorM,
      pruning: {method: "bilinear-subtree-v2", sea_level_m: SEA_LEVEL_M, preserve_mixed_water: true},
      height_fraction: {encoding: HEIGHT_FRACTION, band_m: fractionBandM, sea_level_m: SEA_LEVEL_M},
      sketch_fingerprint: identity.sketch_fingerprint,
      terrain: {
        seam_mode: terrain.settings?.seamMode ?? "legacy",
        blend_km: terrain.settings?.blendKm ?? null,
        mask_key: terrain.fine?.maskKey ?? null,
        skirt_mode: "same-mip-spherical-neighbours-v1",
      },
      payload: "int16 little-endian metres, row-major, north first, then optional int8 centimetres"
        + " in the same zstd frame; absolute at lod <= absolute_lod, a residual against the"
        + " parent's bilinear metre channel above it; height = (100 * metres + centimetres) / 100",
      residual_flag: "high bit of the lod byte in an index record",
      nodata: NODATA,
      node_count: index.length,
      pruned_count: pruned,
      content_identity: "sha256-manifest-index-blobs-v1",
      blobs_sha256: output.digest(),
    };

    /* Header, manifest and index are small; stream the staged blobs after them. */
    const indexBuf = Buffer.alloc(index.length * RECORD);
    index.sort((a, b) => a.face - b.face || a.lod - b.lod || a.y - b.y || a.x - b.x);
    index.forEach((node, k) => {
      const o = k * RECORD;
      indexBuf.writeUInt8(node.face, o);
      indexBuf.writeUInt8(node.lod | (node.residual ? 0x80 : 0), o + 1);
      indexBuf.writeUInt16LE(node.predictor_error_m > 65535 ? 65535 : node.predictor_error_m, o + 2);
      indexBuf.writeUInt32LE(node.x, o + 4);
      indexBuf.writeUInt32LE(node.y, o + 8);
      indexBuf.writeBigUInt64LE(BigInt(node.offset), o + 12);
      indexBuf.writeUInt32LE(node.length, o + 20);
    });
    manifest.index_sha256 = createHash("sha256").update(indexBuf).digest("hex");
    manifest.content_key = contentKey(manifest);
    const manifestBuf = Buffer.from(JSON.stringify(manifest), "utf8");
    const header = Buffer.alloc(32);
    header.write(MAGIC, 0, "ascii");
    header.writeUInt32LE(FORMAT_VERSION, 8);
    header.writeUInt32LE(manifestBuf.length, 12);
    header.writeUInt32LE(index.length, 16);
    header.writeUInt32LE(RECORD, 20);
    header.writeBigUInt64LE(BigInt(header.length + manifestBuf.length + indexBuf.length), 24);
    await output.commit([header, manifestBuf, indexBuf], validatePlanet);
    return {nodes: index.length, pruned, sketchOnly, fractional, blobBytes};
  } catch (error) {
    await output.abort();
    throw error;
  }
}
