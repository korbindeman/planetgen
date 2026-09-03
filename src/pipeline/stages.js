/*
 * Named stages. Each one reads the frozen config and writes fields on
 * the Planet. The functions they wrap stay where they are.
 */
'use strict';

const Tectonics = require('../tectonics');
const EarthFixture = require('../earth-fixture');
const Climate = require('../climate');
const Detail = require('../detail');
const Planet = require('../planet');
const {modelOptions} = require('./config');
const {surface} = require('./document');


function tectonics(planet, cache) {
    const {config} = planet;
    const {seed, n, jitter} = config;
    const built = Planet.ensureSimMesh({seed, n, jitter}, cache);
    const mesh = built.mesh;
    const map = Planet.emptySimMap(mesh, built.r_xyz, built.t_xyz);
    const useDetail = config.detailPass && config.options.detail.n > mesh.numRegions;
    const tectOpts = modelOptions(config, 'tectonics', {
        deferCrests: useDetail,
        polarStraits: config.options.tectonics.polarStraits !== false,
    });
    const log = !config.quiet;

    if (EarthFixture.isEarthSeed(seed)) {
        EarthFixture.buildEarthMap(mesh, map, Object.assign({
            seed,
            deferCrests: useDetail,
            polarStraits: tectOpts.polarStraits,
        }, tectOpts, config.options.fixture));
        map.plate_is_ocean = Planet.oceanicPlates(mesh, map);
    } else {
        const plateOpts = Object.assign({plates: tectOpts.plates}, tectOpts);
        if (config.simulateTectonics) {
            /* the still first, so the plates are fitted to it */
            plateOpts.birthCrust = Tectonics.planCrust(mesh, map.r_xyz, seed, tectOpts);
        }
        Object.assign(map, Tectonics.generatePlates(mesh, seed, plateOpts));
        if (config.simulateTectonics) {
            Tectonics.simulateTectonics(mesh, map, seed, Object.assign({
                steps: tectOpts.steps,
                deferCrests: useDetail,
                polarStraits: tectOpts.polarStraits,
            }, tectOpts));
            map.plate_is_ocean = Planet.oceanicPlates(mesh, map);
        } else {
            Planet.runBlend1843(mesh, map, seed, tectOpts, log, {
                mergeOcean: config.mergeOceanPlates,
            });
        }
    }

    map.plate_centroid = Planet.plateCentroids(mesh, map.r_xyz, map.plates, map.r_plate);
    if (config.connectOceans) Planet.connectWorldOcean(mesh, map.r_elevation);
    planet.sim = {mesh, map};
}


/* Climate is a driver over a mesh. Default: the sim mesh, then detail
 * samples it. `climateOn: 'surface'` re-runs on the visible mesh after
 * detail has moved the coasts. */
function climate(planet, mesh, map) {
    Climate.assignClimate(
        mesh, map,
        EarthFixture.numericSeed(planet.config.seed),
        modelOptions(planet.config, 'climate'));
}


function detail(planet, cache) {
    const {config, sim} = planet;
    const detailN = config.options.detail.n;
    if (!config.detailPass || detailN <= sim.mesh.numRegions) return;

    const built = Planet.ensureDetailMesh(detailN, config.jitter, cache);
    const map = Detail.applyDetailPass(
        sim.mesh, sim.map, built.mesh, built.r_xyz,
        EarthFixture.numericSeed(config.shapeSeed || config.seed),
        modelOptions(config, 'detail', modelOptions(config, 'tectonics', {
            polarStraits: false,
        })));
    map.t_xyz = built.t_xyz;
    map.t_elevation = new Float32Array(built.mesh.numTriangles);
    map.t_moisture = new Float32Array(built.mesh.numTriangles);
    map.t_temperature = new Float32Array(built.mesh.numTriangles);
    planet.detail = {mesh: built.mesh, map};
}


function erosion(planet) {
    if (!planet.detail || !planet.config.erosion) return;
    Detail.applyErosionPass(
        planet.detail.mesh,
        planet.detail.map.r_xyz,
        planet.detail.map,
        EarthFixture.numericSeed(planet.config.shapeSeed || planet.config.seed),
        modelOptions(planet.config, 'detail', modelOptions(planet.config, 'tectonics')));
}


/* Polar straits and land-fraction solve on whatever elevation is current.
 * Tectonics already ran both on the sim mesh so climate sees a shoreline;
 * this pass is what makes landFraction a property of the visible planet. */
function seaLevel(planet) {
    const vis = surface(planet);
    if (!vis) return;
    const opts = modelOptions(planet.config, 'tectonics');
    const {mesh, map} = vis;
    Tectonics.polarStraits(mesh, map.r_xyz, map.r_elevation, opts, map.r_meters);
    if (opts.landFraction == null || !map.r_meters) return;
    const n = mesh.numRegions;
    const grain = new Float32Array(n);
    for (let r = 0; r < n; r++) {
        grain[r] = map.r_elevation[r] - Tectonics.metersToElevation(map.r_meters[r]);
    }
    Tectonics.solveSeaLevel(mesh, map.r_elevation, map.r_meters, grain, opts);
}


function geometry(planet) {
    const vis = surface(planet);
    if (planet.config.connectOceans && planet.detail) {
        Planet.connectWorldOcean(vis.mesh, vis.map.r_elevation);
    }
    Planet.assignTriangleValues(vis.mesh, vis.map);
    planet.geometry = Planet.buildQuadGeometry(vis.mesh, vis.map, !planet.config.quiet);
}


function applyLayoutFields(planet, fields, cache) {
    if (!planet || !fields || !fields.r_elevation || !fields.plates) return false;
    const {seed, n, jitter} = planet.config;
    const built = Planet.ensureSimMesh({seed, n, jitter}, cache);
    if (built.mesh.numRegions !== fields.r_elevation.length) return false;
    if (!fields.r_plate || fields.r_plate.length !== built.mesh.numRegions) return false;
    const map = Planet.emptySimMap(built.mesh, built.r_xyz, built.t_xyz);
    const skip = {
        n: true, cells: true, jitter: true, seed: true, schema: true,
        plates: true, plate_is_ocean: true, hotspots: true,
        extra_ocean_seeds: true, nextPlateId: true, elapsedMyr: true,
        targetPlateCount: true,
    };
    for (const key of Object.keys(fields)) {
        if (skip[key] || fields[key] == null) continue;
        map[key] = fields[key];
    }
    map.plates = fields.plates;
    map.plate_is_ocean = new Set(fields.plate_is_ocean || []);
    map.hotspots = fields.hotspots || [];
    map.extra_ocean_seeds = fields.extra_ocean_seeds || [];
    map.nextPlateId = fields.nextPlateId;
    map.elapsedMyr = fields.elapsedMyr;
    map.targetPlateCount = fields.targetPlateCount;
    map.plate_centroid = Planet.plateCentroids(built.mesh, map.r_xyz, map.plates, map.r_plate);
    const plate_vec = [];
    for (let p = 0; p < map.plates.length; p++) {
        plate_vec[p] = Tectonics.plateVelocity(
            [], map.plates[p].pole, map.plates[p].omega, map.plate_centroid[p]);
    }
    map.plate_vec = plate_vec;
    planet.sim = {mesh: built.mesh, map};
    return true;
}


function applyShapeFields(planet, fields, cache) {
    if (!planet || !planet.sim || !fields || !fields.r_elevation) return false;
    const meshN = fields.n || fields.cells || fields.r_elevation.length;
    const built = Planet.ensureDetailMesh(meshN, planet.config.jitter, cache);
    if (built.mesh.numRegions !== fields.r_elevation.length) return false;
    const simMap = planet.sim.map;
    const map = {
        plates: simMap.plates,
        plate_is_ocean: simMap.plate_is_ocean,
        plate_centroid: simMap.plate_centroid,
        plate_vec: simMap.plate_vec,
        extra_ocean_seeds: simMap.extra_ocean_seeds,
        hotspots: simMap.hotspots,
        nextPlateId: simMap.nextPlateId,
        elapsedMyr: simMap.elapsedMyr,
        targetPlateCount: simMap.targetPlateCount,
        r_xyz: built.r_xyz,
        t_xyz: built.t_xyz,
        t_elevation: new Float32Array(built.mesh.numTriangles),
        t_moisture: new Float32Array(built.mesh.numTriangles),
        t_temperature: new Float32Array(built.mesh.numTriangles),
    };
    const skip = {n: true, cells: true, schema: true};
    for (const key of Object.keys(fields)) {
        if (skip[key] || fields[key] == null) continue;
        map[key] = fields[key];
    }
    planet.detail = {mesh: built.mesh, map};
    geometry(planet);
    return true;
}


module.exports = {
    tectonics,
    climate,
    detail,
    erosion,
    seaLevel,
    geometry,
    applyLayoutFields,
    applyShapeFields,
};
