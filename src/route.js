/*
 * Grain-independent drainage routing.
 *
 * Every land cell has a downhill receiver. Water reaches the world ocean
 * or a real closed basin. Shape uses a light cut of this for valley
 * texture and a drain tree. Carve and a later Terrain would call the
 * same code at their grain.
 *
 * The mesh is an adapter: count, neighbors(r, out), distKm(a, b). DualMesh
 * is the first adapter. A cubesphere adapter waits for Carve.
 */
'use strict';


const DEFAULTS = {
    floodEpsM: 0.25,
    floodNoiseM: 4,
    floodCarve: 0.18,
    floodCarveRadius: 0.22,
    lakeFillCapM: 100,
    moisturePower: 1,
    moistureFloor: 0.2,
    inciseCapM: 72,
    inciseScaleM: 36,
    inciseExp: 0.35,
    inciseRefKm2: 40000,
};


class MinHeap {
    constructor(keys) {
        this._key = keys;
        this._data = [];
    }
    get size() { return this._data.length; }
    push(cell) {
        const data = this._data;
        const key = this._key;
        data.push(cell);
        let i = data.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (key[data[i]] >= key[data[p]]) break;
            const t = data[i]; data[i] = data[p]; data[p] = t;
            i = p;
        }
    }
    pop() {
        const data = this._data;
        const key = this._key;
        const top = data[0];
        const last = data.pop();
        if (data.length === 0) return top;
        data[0] = last;
        let i = 0;
        const n = data.length;
        for (;;) {
            let s = i;
            const l = 2 * i + 1, r = l + 1;
            if (l < n && key[data[l]] < key[data[s]]) s = l;
            if (r < n && key[data[r]] < key[data[s]]) s = r;
            if (s === i) break;
            const t = data[i]; data[i] = data[s]; data[s] = t;
            i = s;
        }
        return top;
    }
}


function chordKm(r_xyz, a, b, radiusKm) {
    const dx = r_xyz[3 * a] - r_xyz[3 * b];
    const dy = r_xyz[3 * a + 1] - r_xyz[3 * b + 1];
    const dz = r_xyz[3 * a + 2] - r_xyz[3 * b + 2];
    const chord = Math.hypot(dx, dy, dz);
    if (chord < 1e-8) return 1e-3;
    const half = Math.min(1, 0.5 * chord);
    return 2 * radiusKm * Math.asin(half);
}


function cellAreaKm2(count, radiusKm) {
    return 4 * Math.PI * radiusKm * radiusKm / count;
}


function dualMesh(mesh, r_xyz, radiusKm) {
    return {
        count: mesh.numRegions,
        neighbors(r, out) { return mesh.r_circulate_r(out, r); },
        distKm(a, b) { return chordKm(r_xyz, a, b, radiusKm); },
        areaKm2: cellAreaKm2(mesh.numRegions, radiusKm),
    };
}


function cellNoise(r, amp) {
    let h = (Math.imul(r, 2654435761) >>> 0);
    h = Math.imul((h >>> 16) ^ h, 0x45d9f3b) >>> 0;
    h = ((h >>> 16) ^ h) >>> 0;
    return (h / 0xffffffff) * amp;
}


function markOcean(meters, n) {
    const ocean = new Uint8Array(n);
    for (let r = 0; r < n; r++) if (meters[r] < 0) ocean[r] = 1;
    return ocean;
}


/* Largest connected body of water is the world ocean. Closed basins stay
 * inland seas and are not treated as outlets. */
function worldOceanMask(graph, ocean) {
    const n = graph.count;
    const label = new Int32Array(n).fill(-1);
    const sizes = [];
    const neighbors = [];
    for (let r = 0; r < n; r++) {
        if (!ocean[r] || label[r] >= 0) continue;
        const id = sizes.length;
        let size = 0;
        const queue = [r];
        label[r] = id;
        for (let h = 0; h < queue.length; h++) {
            size++;
            graph.neighbors(queue[h], neighbors);
            for (let i = 0; i < neighbors.length; i++) {
                const nb = neighbors[i];
                if (ocean[nb] && label[nb] < 0) {
                    label[nb] = id;
                    queue.push(nb);
                }
            }
        }
        sizes.push(size);
    }
    let main = 0;
    for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[main]) main = i;
    const open = new Uint8Array(n);
    for (let r = 0; r < n; r++) if (ocean[r] && label[r] === main) open[r] = 1;
    return open;
}


function floodFromOcean(graph, meters, ocean, opts) {
    const n = graph.count;
    const open = worldOceanMask(graph, ocean);
    const neighbors = [];
    const eps = opts.floodEpsM;
    const noiseAmp = opts.floodNoiseM;

    const surface = new Float32Array(meters);
    const drainTo = new Int32Array(n).fill(-1);
    const visited = new Uint8Array(n);
    const key = new Float32Array(n);
    for (let r = 0; r < n; r++) key[r] = meters[r] + cellNoise(r, noiseAmp);

    const heap = new MinHeap(key);
    for (let r = 0; r < n; r++) {
        if (ocean[r]) { visited[r] = 1; continue; }
        graph.neighbors(r, neighbors);
        for (let i = 0; i < neighbors.length; i++) {
            if (open[neighbors[i]]) {
                visited[r] = 1;
                drainTo[r] = neighbors[i];
                heap.push(r);
                break;
            }
        }
    }

    while (heap.size > 0) {
        const r = heap.pop();
        const surfR = surface[r];
        graph.neighbors(r, neighbors);
        for (let i = 0; i < neighbors.length; i++) {
            const nb = neighbors[i];
            if (visited[nb]) continue;
            visited[nb] = 1;
            drainTo[nb] = r;
            if (meters[nb] < surfR + eps) {
                surface[nb] = surfR + eps;
                key[nb] = surface[nb] + cellNoise(nb, noiseAmp);
            }
            heap.push(nb);
        }
    }

    return {surface, drainTo, visited, open};
}


function depressionId(n, deficit, eps, graph) {
    const id = new Int32Array(n).fill(-1);
    const neighbors = [];
    let next = 0;
    for (let r = 0; r < n; r++) {
        if (deficit[r] <= eps || id[r] >= 0) continue;
        const cur = next++;
        const queue = [r];
        id[r] = cur;
        for (let h = 0; h < queue.length; h++) {
            graph.neighbors(queue[h], neighbors);
            for (let i = 0; i < neighbors.length; i++) {
                const nb = neighbors[i];
                if (deficit[nb] > eps && id[nb] < 0) {
                    id[nb] = cur;
                    queue.push(nb);
                }
            }
        }
    }
    return {id, count: next};
}


function routeDepressionToSink(graph, meters, cells, sink, drainTo) {
    const key = new Float32Array(graph.count);
    const inSet = new Uint8Array(graph.count);
    for (let i = 0; i < cells.length; i++) {
        const r = cells[i];
        inSet[r] = 1;
        key[r] = meters[r];
    }
    const visited = new Uint8Array(graph.count);
    const heap = new MinHeap(key);
    drainTo[sink] = -1;
    visited[sink] = 1;
    heap.push(sink);
    const neighbors = [];
    while (heap.size > 0) {
        const r = heap.pop();
        graph.neighbors(r, neighbors);
        for (let i = 0; i < neighbors.length; i++) {
            const nb = neighbors[i];
            if (!inSet[nb] || visited[nb]) continue;
            visited[nb] = 1;
            drainTo[nb] = r;
            heap.push(nb);
        }
    }
}


function applyLakesAndBreaches(graph, meters, ocean, flood, opts, protect) {
    const n = graph.count;
    const {surface, drainTo} = flood;
    const eps = opts.floodEpsM;
    const cap = opts.lakeFillCapM;
    const lake = new Uint8Array(n);
    const deficit = new Float32Array(n);
    for (let r = 0; r < n; r++) {
        if (ocean[r]) continue;
        deficit[r] = surface[r] - meters[r];
    }

    const {id, count} = depressionId(n, deficit, eps, graph);
    const maxDef = new Float32Array(count);
    const sink = new Int32Array(count).fill(-1);
    const sinkZ = new Float32Array(count);
    sinkZ.fill(Infinity);
    for (let r = 0; r < n; r++) {
        const d = id[r];
        if (d < 0) continue;
        if (deficit[r] > maxDef[d]) maxDef[d] = deficit[r];
        if (meters[r] < sinkZ[d]) {
            sinkZ[d] = meters[r];
            sink[d] = r;
        }
    }

    const members = [];
    for (let i = 0; i < count; i++) members[i] = [];
    for (let r = 0; r < n; r++) {
        const d = id[r];
        if (d >= 0) members[d].push(r);
    }

    for (let d = 0; d < count; d++) {
        if (maxDef[d] > cap && sink[d] >= 0) {
            for (let i = 0; i < members[d].length; i++) lake[members[d][i]] = 1;
            routeDepressionToSink(graph, meters, members[d], sink[d], drainTo);
        }
    }

    if (opts.editHeight === false) {
        return {drainTo, lake};
    }

    const path = [];
    const carveStrength = opts.floodCarve;
    for (let r = 0; r < n; r++) {
        if (ocean[r] || lake[r]) continue;
        const def = deficit[r];
        if (def <= eps) continue;

        path.length = 0;
        let peakIdx = -1, peakElev = -Infinity;
        let cur = r;
        let hops = 0;
        while (cur >= 0 && !ocean[cur] && !lake[cur] && hops < n) {
            path.push(cur);
            if (meters[cur] > peakElev) {
                peakElev = meters[cur];
                peakIdx = path.length - 1;
            }
            cur = drainTo[cur];
            hops++;
        }
        if (peakIdx < 0 || path.length === 0) continue;

        const carveAmount = def * carveStrength;
        const radius = Math.max(3, Math.ceil(path.length * opts.floodCarveRadius));
        const startIdx = Math.max(0, peakIdx - radius);
        const endIdx = Math.min(path.length - 1, peakIdx + radius);
        let kernelSum = 0;
        for (let k = startIdx; k <= endIdx; k++) {
            kernelSum += 1 - Math.abs(k - peakIdx) / (radius + 1);
        }
        if (kernelSum > 0) {
            for (let k = startIdx; k <= endIdx; k++) {
                if (protect && protect[path[k]] > 0.4) continue;
                if (lake[path[k]]) continue;
                const weight = (1 - Math.abs(k - peakIdx) / (radius + 1)) / kernelSum;
                meters[path[k]] -= carveAmount * weight;
                if (meters[path[k]] < 0) meters[path[k]] = 0;
            }
        }
        meters[r] += def * (1 - carveStrength);
    }

    const order = [];
    for (let r = 0; r < n; r++) if (!ocean[r] && !lake[r]) order.push(r);
    order.sort((a, b) => surface[a] - surface[b]);
    for (let i = 0; i < order.length; i++) {
        const r = order[i];
        const target = drainTo[r];
        if (target < 0) continue;
        const targetElev = ocean[target] || lake[target] ? Math.max(0, meters[target]) : meters[target];
        if (meters[r] <= targetElev) meters[r] = targetElev + eps;
    }

    return {drainTo, lake};
}


function moistureYield(moisture, r, opts) {
    if (!moisture) return 1;
    const m = moisture[r];
    if (!(m > 0)) return opts.moistureFloor;
    const p = opts.moisturePower;
    const wet = p === 1 ? m : Math.pow(Math.max(0, m), p);
    return opts.moistureFloor + (1 - opts.moistureFloor) * Math.min(1, wet);
}


function accumulate(graph, ocean, drainTo, lake, moisture, opts) {
    const n = graph.count;
    const areaKm2 = graph.areaKm2 || 1;
    const discharge = new Float32Array(n);
    const order = [];
    for (let r = 0; r < n; r++) {
        if (ocean[r]) continue;
        discharge[r] = areaKm2 * moistureYield(moisture, r, opts);
        order.push(r);
    }
    /* Upstream first: cells whose receiver is downstream. A single pass
     * from high to low is wrong after lakes rewire the tree, so walk the
     * tree lengths and add in reverse hop order. */
    const depth = new Int32Array(n);
    for (let i = 0; i < order.length; i++) {
        const r = order[i];
        let d = 0, cur = r, hops = 0;
        while (cur >= 0 && !ocean[cur] && hops < n) {
            const next = drainTo[cur];
            if (next < 0 || ocean[next] || lake[next] && next !== cur) break;
            if (next === cur) break;
            d++;
            cur = next;
            hops++;
        }
        depth[r] = d;
    }
    order.sort((a, b) => depth[b] - depth[a]);
    for (let i = 0; i < order.length; i++) {
        const r = order[i];
        const t = drainTo[r];
        if (t < 0 || ocean[t]) continue;
        discharge[t] += discharge[r];
    }
    return discharge;
}


function route(graph, meters, moisture, opts) {
    const o = Object.assign({}, DEFAULTS, opts);
    const n = graph.count;
    const ocean = o.ocean || markOcean(meters, n);
    const flood = floodFromOcean(graph, meters, ocean, o);
    const {drainTo, lake} = applyLakesAndBreaches(graph, meters, ocean, flood, o, o.protect);
    const discharge = accumulate(graph, ocean, drainTo, lake, moisture, o);
    return {drainTo, discharge, ocean, lake};
}


function incise(graph, meters, routing, opts) {
    const o = Object.assign({}, DEFAULTS, opts);
    const {drainTo, discharge, ocean, lake} = routing;
    const n = graph.count;
    const ref = Math.max(1, o.inciseRefKm2);
    const gain = o.streamK != null ? o.streamK / 0.0012 : 1;
    for (let r = 0; r < n; r++) {
        if (ocean[r] || lake[r]) continue;
        const t = drainTo[r];
        if (t < 0) continue;
        const q = discharge[r];
        if (!(q > 0)) continue;
        let target = o.inciseScaleM * gain * Math.pow(q / ref, o.inciseExp);
        if (o.protect && o.protect[r] > 0.4) {
            target *= o.iceSheetFluvial != null ? o.iceSheetFluvial : 0.04;
        }
        if (target > o.inciseCapM) target = o.inciseCapM;
        if (target < 1) continue;
        const recv = ocean[t] || lake[t] ? Math.max(0, meters[t]) : meters[t];
        const drop = meters[r] - recv;
        if (drop >= target) continue;
        let cut = target - Math.max(0, drop);
        if (cut > o.inciseCapM) cut = o.inciseCapM;
        meters[r] -= cut;
        if (meters[r] < 0) meters[r] = 0;
        if (meters[r] <= recv) meters[r] = recv + o.floodEpsM;
    }
    return meters;
}


function pruneTrunks(routing, minDischarge) {
    const {drainTo, discharge, ocean, lake} = routing;
    const n = drainTo.length;
    const trunk = new Uint8Array(n);
    const floor = minDischarge > 0 ? minDischarge : 0;
    for (let r = 0; r < n; r++) {
        if (ocean[r] || lake[r]) continue;
        if (discharge[r] >= floor) trunk[r] = 1;
    }
    return trunk;
}


module.exports = {
    DEFAULTS,
    MinHeap,
    dualMesh,
    chordKm,
    cellAreaKm2,
    markOcean,
    worldOceanMask,
    route,
    incise,
    pruneTrunks,
};
