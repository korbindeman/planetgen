/* Finish climate: a seasonal energy/moisture balance, not a weather GCM.
 * Physical fields and stores use Celsius, metres, seconds, W/m^2 and kg/m^2
 * (one kg/m^2 of water is one mm). Mean circulation is parameterized; heat
 * mixing, water transport and surface stores are solved on a closed sphere.
 * No imports from the preview climate, no mutations to saved Shape fields.
 */
'use strict';
const Grid=require('./climate-grid');
const DAY=86400,YEAR_DAYS=360,MONTH_DAYS=30,Lv=2.5e6,Lf=3.34e5;
const VERSION='seasonal-1';
const DEFAULTS=Object.freeze({climateCells:10000,climateMaxYears:30,climateMinYears:6,
    climateStepDays:2,climateToleranceC:0.12,climateSolarFlux:1361,
    climateHeatTransport:0.55,climateOceanDepthM:30,climateSoilCapacityMm:150,
    climateLapseRate:6.0,climateMonsoonStrength:1,climateLatentCoupling:0.15});
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
function insolation(latitude,declination,flux=1361) {
    const s=Math.sin(latitude)*Math.sin(declination),c=Math.cos(latitude)*Math.cos(declination);
    const hour=c<1e-12?(s>0?Math.PI:0):Math.acos(clamp(-s/c,-1,1));
    return Math.max(0,flux/Math.PI*(hour*s+c*Math.sin(hour)));
}
function saturationColumn(tempC,heightM=0,gravityG=1) {
    const t=clamp(tempC,-90,65),vaporPa=611.2*Math.exp(17.67*t/(t+243.5));
    const pressure=101325*Math.exp(-heightM/(8500/gravityG));
    return 2200/gravityG*0.622*vaporPa/Math.max(20000,pressure-vaporPa);
}
function moistHeatFactor(tempC) {
    // Effective eddy heat transport grows with atmospheric moisture capacity.
    // Linearize cp*T + Lv*q at 80% RH, retaining the configured transport
    // scale near 15 C. This is an MSE-inspired diffusivity, not a second water
    // source. Dry cold air carries less latent heat than warm maritime air.
    const t=clamp(tempC,-60,40),vaporPa=611.2*Math.exp(17.67*t/(t+243.5));
    const vaporSlope=vaporPa*17.67*243.5/(t+243.5)**2;
    const humiditySlope=0.622*101325*vaporSlope/(101325-vaporPa)**2;
    return (1+2500*0.8*humiditySlope)/2.4;
}
function summarize(temperature,precipitation,n) {
    const mean=new Float32Array(n),std=new Float32Array(n),rain=new Float32Array(n),cv=new Float32Array(n);
    for(let r=0;r<n;r++) {
        let t=0,p=0;for(let m=0;m<12;m++){t+=temperature[m*n+r];p+=precipitation[m*n+r];}
        t/=12;let tv=0,pv=0;
        for(let m=0;m<12;m++){tv+=(temperature[m*n+r]-t)**2;pv+=(precipitation[m*n+r]-p/12)**2;}
        mean[r]=t;std[r]=Math.sqrt(tv/11);rain[r]=p;
        // WorldClim/dismo BIO15 uses the SD and mean of (monthly rain + 1 mm).
        cv[r]=100*Math.sqrt(pv/11)/(p/12+1);
    }
    return {temperature:mean,temperature_std:std,precipitation:rain,precipitation_cv:cv};
}
function circulation(grid,theta,declination,body,options) {
    const {n,xyz,lat,edges}=grid,anomaly=new Float64Array(n),bins=36;
    const sum=new Float64Array(bins),area=new Float64Array(bins);
    for(let r=0;r<n;r++) {const b=Math.min(bins-1,Math.floor((xyz[3*r+2]+1)/2*bins));sum[b]+=theta[r]*grid.area[r];area[b]+=grid.area[r];}
    for(let r=0;r<n;r++) {const b=Math.min(bins-1,Math.floor((xyz[3*r+2]+1)/2*bins));anomaly[r]=theta[r]-sum[b]/area[b];}
    // Broad thermal lows, not a low over every 23 km hill. Smooth only the
    // anomaly; zonal heating already sets the background circulation.
    for(let pass=0;pass<5;pass++) {const next=anomaly.slice();for(let r=0;r<n;r++){let a=anomaly[r],count=1;for(const e of grid.adjacent[r]){const q=edges[e].a===r?edges[e].b:edges[e].a;a+=anomaly[q];count++;}next[r]=a/count;}anomaly.set(next);}
    const wind=new Float64Array(n*3),speed=new Float64Array(n),lift=new Float64Array(n),flux=new Float64Array(edges.length);
    const rotation=body.rotationHours||24,scale=clamp(Math.sqrt(rotation/24),0.6,1.8);
    for(let r=0;r<n;r++) {
        const x=xyz[r*3],y=xyz[r*3+1],z=xyz[r*3+2],cos=Math.hypot(x,y);
        const ex=cos>1e-9?-y/cos:0,ey=cos>1e-9?x/cos:1;
        const nx=-z*ey,ny=z*ex,nz=cos;
        const effective=(lat[r]-declination*0.18)/scale,deg=Math.abs(effective)*180/Math.PI;
        const westerly=0.5*(Math.tanh((deg-30)/5)-Math.tanh((deg-60)/6));
        let u=-5+12*westerly,v=Math.tanh(effective/(12*Math.PI/180))*(-1.2+2.4*westerly);
        let gx=0,gy=0;
        for(const edgeId of grid.adjacent[r]) {
            const edge=edges[edgeId],other=edge.a===r?edge.b:edge.a,sign=edge.a===r?1:-1;
            const gradient=(anomaly[other]-anomaly[r])/edge.distance*sign;
            gx+=gradient*(edge.dx*ex+edge.dy*ey);gy+=gradient*(edge.dx*nx+edge.dy*ny+edge.dz*nz);
        }
        const norm=2/grid.adjacent[r].length;gx*=norm;gy*=norm;
        const f=2*(2*Math.PI/(rotation*3600))*z,drag=1/(0.7*DAY),factor=80*options.climateMonsoonStrength;
        let du=factor*(drag*gx+f*gy)/(drag*drag+f*f),dv=factor*(drag*gy-f*gx)/(drag*drag+f*f);
        const mag=Math.hypot(du,dv);if(mag>6){du*=6/mag;dv*=6/mag;}u+=du;v+=dv;
        wind[r*3]=ex*u+nx*v;wind[r*3+1]=ey*u+ny*v;wind[r*3+2]=nz*v;speed[r]=Math.hypot(u,v);
    }
    for(let e=0;e<edges.length;e++) {
        const q=edges[e],{a,b}=q;
        const u=((wind[a*3]+wind[b*3])*q.dx+(wind[a*3+1]+wind[b*3+1])*q.dy+(wind[a*3+2]+wind[b*3+2])*q.dz)/2;
        flux[e]=u*q.width;
        const dh=grid.height[b]*grid.land[b]-grid.height[a]*grid.land[a];
        const rise=Math.max(0,u*dh/q.distance);
        lift[a]+=rise/grid.adjacent[a].length;lift[b]+=rise/grid.adjacent[b].length;
    }
    return {wind,speed,lift,flux};
}
function solveEnergy(grid,theta,capacity,forcing,dt,coefficient) {
    const old=theta.slice(),{area,offsets,neighbours,conductances,edgeIds,edges,n}=grid,conductance=coefficient*(grid.radiusKm*1000)**2;
    // One coefficient per shared edge makes heat leaving a cell exactly the
    // heat entering its neighbour. Freeze it over this implicit timestep.
    const mixing=Float64Array.from(edges,e=>moistHeatFactor((old[e.a]+old[e.b])/2));
    const diagonal=new Float64Array(n),rhs=new Float64Array(n);
    for(let r=0;r<n;r++) {let out=0;for(let e=offsets[r];e<offsets[r+1];e++)out+=conductance*conductances[e]*mixing[edgeIds[e]];
        diagonal[r]=capacity[r]*area[r]/dt+2.1*area[r]+out;
        rhs[r]=(capacity[r]*old[r]/dt+forcing[r]-203)*area[r];}
    let change=Infinity;
    for(let iter=0;iter<100;iter++) {
        change=0;
        for(let k=0;k<n;k++) {const r=iter%2?n-1-k:k;let b=rhs[r];
            for(let e=offsets[r];e<offsets[r+1];e++)b+=conductance*conductances[e]*mixing[edgeIds[e]]*theta[neighbours[e]];
            const next=b/diagonal[r];change=Math.max(change,Math.abs(next-theta[r]));theta[r]=next;}
        if(change<0.0001)break;
    }
    return change;
}
function run(terrain,body={},input={},onYear=()=>{}) {
    const opts={...DEFAULTS,...input},grid=terrain.grid||Grid.makeGrid(opts.climateCells,body.radiusKm||6371);
    Object.assign(grid,{land:Float64Array.from(terrain.land),height:Float64Array.from(terrain.height)});
    const {n,area,land,height,lat}=grid;
    if(land.length!==n||height.length!==n)throw new Error('Climate terrain has the wrong cell count');
    if(!(opts.climateStepDays>0&&MONTH_DAYS/opts.climateStepDays%1===0))throw new Error('Climate timestep must divide a 30-day month');
    const theta=new Float64Array(n),dryTheta=new Float64Array(n),water=new Float64Array(n),cloud=new Float64Array(n),soil=new Float64Array(n),snow=new Float64Array(n),ice=new Float64Array(n);
    const capacity=new Float64Array(n),forcing=new Float64Array(n),dryForcing=new Float64Array(n),latent=new Float64Array(n),evaporativeCooling=new Float64Array(n);
    const gravity=body.gravityG||1,tilt=(body.axialTiltDeg??23.44)*Math.PI/180,lapse=opts.climateLapseRate/1000;
    const totalArea=area.reduce((a,b)=>a+b,0),dt=opts.climateStepDays*DAY;
    for(let r=0;r<n;r++) {
        theta[r]=28-48*Math.sin(lat[r])**2;
        dryTheta[r]=theta[r];
        const t=theta[r]-lapse*height[r]*land[r];water[r]=0.65*saturationColumn(t,height[r]*land[r],gravity);
        soil[r]=opts.climateSoilCapacityMm*0.5*land[r];
        capacity[r]=1.5e7*land[r]+4.18e6*opts.climateOceanDepthM*(1-land[r]);
    }
    let previous=null,stable=0,converged=false,final,history=[];
    for(let year=1;year<=opts.climateMaxYears;year++) {
        const temperature=new Float32Array(n*12),precipitation=new Float32Array(n*12),evaporation=new Float32Array(n*12),runoff=new Float32Array(n*12);
        const snowCover=new Float32Array(n*12),seaIce=new Float32Array(n*12),winds=new Float32Array(n*12*3);
        let waterStart=0,waterEnd=0,oceanSource=0,oceanSink=0,iceSink=0,maxTransportCorrection=0,maxEnergyResidual=0;
        for(let r=0;r<n;r++)waterStart+=(water[r]+cloud[r]+soil[r]+snow[r])*area[r];
        for(let month=0;month<12;month++) {
            const declination=Math.asin(Math.sin(tilt)*Math.sin(2*Math.PI*((month+0.5)/12-0.218)));
            // Diagnose thermal lows from land/sea heating and evaporative
            // cooling. Omitting evaporation creates spurious tropical land
            // highs from albedo alone. Exclude condensation heating aloft: it
            // would attract still more rain without a solved momentum equation.
            const flow=circulation(grid,dryTheta,declination,body,opts);winds.set(flow.wind,month*n*3);
            const transport=Grid.makeTransport(grid,flow.flux,dt,2e6);
            const sun=Float64Array.from(lat,v=>insolation(v,declination,opts.climateSolarFlux));
            for(let step=0;step<MONTH_DAYS/opts.climateStepDays;step++) {
                for(let r=0;r<n;r++) {
                    const actual=theta[r]-lapse*height[r]*land[r];
                    const wet=land[r]>0?clamp(soil[r]/(opts.climateSoilCapacityMm*land[r]),0,1):1;
                    const snowFrac=1-Math.exp(-snow[r]/Math.max(1,25*land[r]));
                    const albedo=land[r]*(0.28+0.06*(1-wet)+0.17*snowFrac)+(1-land[r])*(0.26+0.28*ice[r]);
                    // Only a fraction of column latent heating couples to this
                    // effective surface layer. Free-tropospheric convection and
                    // its heat export are unresolved, not deposited at ground.
                    dryForcing[r]=sun[r]*(1-albedo);
                    forcing[r]=dryForcing[r]+opts.climateLatentCoupling*latent[r];
                    dryForcing[r]+=opts.climateLatentCoupling*evaporativeCooling[r];
                    // Enhanced effective heat capacity through freezing supplies
                    // a simple sea-ice phase-change lag without a deep ocean.
                    capacity[r]=1.5e7*land[r]+(4.18e6*opts.climateOceanDepthM+5e7*Math.exp(-(((actual+1.8)/2)**2)))*(1-land[r]);
                }
                maxEnergyResidual=Math.max(maxEnergyResidual,solveEnergy(grid,theta,capacity,forcing,dt,opts.climateHeatTransport));
                solveEnergy(grid,dryTheta,capacity,dryForcing,dt,opts.climateHeatTransport);
                for(let r=0;r<n;r++) {
                    const t=theta[r]-lapse*height[r]*land[r],qs=saturationColumn(t,height[r]*land[r],gravity);
                    const wet=land[r]>0?clamp(soil[r]/Math.max(1,opts.climateSoilCapacityMm*land[r]),0,1):0;
                    const demand=0.0012*Math.max(2,flow.speed[r])*1.2*Math.max(0,qs-water[r])/(2200/gravity)*dt;
                    const availableEnergy=Math.max(0,sun[r]*0.65-30)*dt/Lv;
                    const potential=Math.min(demand,availableEnergy);
                    const ocean=potential*(1-land[r])*(1-0.95*ice[r]);
                    const ground=Math.min(soil[r],potential*land[r]*wet*0.8);
                    const evap=ocean+ground;water[r]+=evap;soil[r]-=ground;oceanSource+=ocean*area[r];
                    evaporation[month*n+r]+=evap;latent[r]=-evap*Lv/dt;
                    evaporativeCooling[r]=-evap*Lv/dt;
                }
                for(const field of [water,cloud]) {
                    const check=Grid.transport(grid,field,flow.flux,dt,100,1e-7,2e6,transport);
                    maxTransportCorrection=Math.max(maxTransportCorrection,check.relativeCorrection);
                }
                for(let r=0;r<n;r++) {
                    const k=month*n+r,t=theta[r]-lapse*height[r]*land[r],qs=saturationColumn(t,height[r]*land[r],gravity),rh=water[r]/Math.max(0.01,qs);
                    const latitude=Math.abs((lat[r]-declination*0.55)/Math.sqrt((body.rotationHours||24)/24))*180/Math.PI;
                    const itcz=Math.exp(-((latitude/11)**2)),storm=Math.exp(-(((latitude-52)/15)**2));
                    const rising=0.055+0.5*itcz+0.23*storm+flow.lift[r]*DAY/1800;
                    const fraction=1-Math.exp(-rising*opts.climateStepDays);
                    // A monthly mean column contains unresolved moist eddies.
                    // A hard mean-RH threshold extinguishes their rainfall and
                    // soil recycling across entire temperate continents.
                    const condensate=Math.min(water[r],Math.max(0,water[r]-qs)+Math.min(water[r],qs)*clamp(rh*rh,0,1)*fraction);
                    water[r]-=condensate;cloud[r]+=condensate;latent[r]+=condensate*Lv/dt;
                    const rain=cloud[r]*(1-Math.exp(-opts.climateStepDays/0.4));cloud[r]-=rain;precipitation[k]+=rain;
                    oceanSink+=rain*(1-land[r])*area[r];
                    const snowShare=clamp((1-t)/2,0,1),snowfall=rain*land[r]*snowShare;
                    snow[r]+=snowfall;soil[r]+=rain*land[r]-snowfall;
                    const melt=Math.min(snow[r],Math.max(0,t)*3*opts.climateStepDays*land[r]);
                    snow[r]-=melt;soil[r]+=melt;latent[r]-=melt*Lf/dt;
                    const excess=Math.max(0,soil[r]-opts.climateSoilCapacityMm*land[r]);
                    soil[r]-=excess;runoff[k]+=excess;oceanSink+=excess*area[r];
                    // Persistent accumulation moves into an unresolved ice sheet.
                    // It is a recorded water sink, never silently clipped away.
                    const accumulation=Math.max(0,snow[r]-1000*land[r]);snow[r]-=accumulation;iceSink+=accumulation*area[r];
                    ice[r]+=(clamp((-1.8-t)/3,0,1)-ice[r])*(1-Math.exp(-opts.climateStepDays/20));
                    temperature[k]+=t*opts.climateStepDays/MONTH_DAYS;
                    snowCover[k]+=clamp(snow[r]/Math.max(1,25*land[r]),0,1)*opts.climateStepDays/MONTH_DAYS;
                    seaIce[k]+=ice[r]*opts.climateStepDays/MONTH_DAYS;
                    if(!Number.isFinite(t)||t<-100||t>80||!Number.isFinite(water[r])||water[r]<-1e-10)throw new Error(`Climate diverged in year ${year}, month ${month}, step ${step}, cell ${r}: T=${t}, water=${water[r]}, cloud=${cloud[r]}, latent=${latent[r]}`);
                }
            }
        }
        for(let r=0;r<n;r++)waterEnd+=(water[r]+cloud[r]+soil[r]+snow[r])*area[r];
        let temperatureDelta=Infinity,rainDelta=Infinity,rainAbsoluteDelta=Infinity;
        if(previous) {
            let td=0,pd=0,psum=0;
            for(let m=0;m<12;m++)for(let r=0;r<n;r++){const k=m*n+r;td+=(temperature[k]-previous.temperature[k])**2*area[r];pd+=Math.abs(precipitation[k]-previous.precipitation[k])*area[r];psum+=precipitation[k]*area[r];}
            temperatureDelta=Math.sqrt(td/(12*totalArea));rainDelta=pd/Math.max(1,psum);rainAbsoluteDelta=pd/totalArea;
        }
        const budgetMm=(waterEnd-waterStart-oceanSource+oceanSink+iceSink)/totalArea;
        const diagnostics={year,temperatureDeltaC:temperatureDelta,rainRelativeDelta:rainDelta,rainAbsoluteDeltaMm:rainAbsoluteDelta,waterBudgetMm:budgetMm,
            oceanEvaporationMm:oceanSource/totalArea,drainageAndOceanRainMm:oceanSink/totalArea,iceAccumulationMm:iceSink/totalArea,maxTransportCorrection,maxEnergyResidual};
        history.push(diagnostics);onYear(diagnostics);
        if(year>=opts.climateMinYears&&temperatureDelta<opts.climateToleranceC&&(rainDelta<0.015||rainAbsoluteDelta<0.1))stable++;else stable=0;
        final={temperature,precipitation,evaporation,runoff,snowCover,seaIce,winds};previous=final;
        if(stable>=2){converged=true;break;}
    }
    return {version:VERSION,options:opts,body:{...body},grid,monthly:final,annual:summarize(final.temperature,final.precipitation,n),diagnostics:{converged,years:history.length,history}};
}
module.exports={VERSION,DEFAULTS,DAY,YEAR_DAYS,MONTH_DAYS,insolation,saturationColumn,moistHeatFactor,summarize,circulation,solveEnergy,run};
