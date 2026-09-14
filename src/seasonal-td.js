/* The physical climate channels on the existing conformal bake lattice. */
'use strict';
const Planet=require('./planet');
const Tectonics=require('./tectonics');
function layersForBakeRect(planet,climate,tile,rect) {
    const {annual}=climate;
    const first=Planet.rasterizeBakeRect(planet.mesh,{...planet.map,r_temperature:annual.temperature,r_moisture:annual.precipitation},tile,rect,0);
    const second=Planet.rasterizeBakeRect(planet.mesh,{...planet.map,r_temperature:annual.temperature_std,r_moisture:annual.precipitation_cv},tile,rect,0);
    return {width:rect.width,height:rect.height,heightmap:Float32Array.from(first.elev,Tectonics.elevationToMeters),
        temperature:first.temp,precipitation:first.moist,temperature_std:second.temp,precipitation_cv:second.moist};
}
module.exports={layersForBakeRect};
