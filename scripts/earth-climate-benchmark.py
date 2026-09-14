"""Prepare measured Earth inputs and compare seasonal climate with GFDL/WorldClim.

The simulation receives only land fraction, surface elevation and Earth body
properties. Reference temperatures/rainfall never enter the simulation input.
All outputs stay under --out. No project, variant or campaign is opened.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path

os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("OMP_NUM_THREADS", "1")
import numpy as np
import rasterio
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parents[1]
FIELDS = ("temperature", "precipitation", "temperature_std", "precipitation_cv")
LABELS = ("Annual temperature (°C)", "Annual precipitation (mm / 360 days)", "Temperature seasonality (SD °C)", "Rainfall seasonality (CV %)")


def read_raster(path):
    with rasterio.open(path) as src:
        assert src.shape == (1080, 2160)
        assert np.allclose(tuple(src.transform)[:6], (1/6, 0, -180, 0, -1/6, 90))
        assert src.crs.to_epsg() == 4326
        return src.read(1, masked=True)


def pixel_areas(height, width):
    edges = np.linspace(np.pi/2, -np.pi/2, height+1)
    return np.broadcast_to((np.sin(edges[:-1])-np.sin(edges[1:]))[:, None] * (2*np.pi/width), (height, width))


def block_mean(a, weights, height=36, width=72):
    """Area means of aligned regular cells, keeping missing support explicit."""
    h, w = a.shape[-2:]
    assert h % height == 0 and w % width == 0
    weights = np.broadcast_to(weights, a.shape) * np.isfinite(a)
    shape = a.shape[:-2] + (height, h//height, width, w//width)
    total = (np.nan_to_num(a)*weights).reshape(shape).sum(axis=(-1, -3))
    support = weights.reshape(shape).sum(axis=(-1, -3))
    return np.divide(total, support, out=np.full_like(total, np.nan, dtype=float), where=support>0)


def summarize(t, p):
    return np.stack((t.mean(axis=0), p.sum(axis=0), t.std(axis=0, ddof=1), 100*p.std(axis=0, ddof=1)/(p.mean(axis=0)+1)))


def gcm_order(a):
    # Archive: south to north, 0..360. Evaluation: north to south, -180..180.
    return np.roll(a[..., ::-1, :], a.shape[-1]//2, axis=-1)


def prepare(out, worldclim):
    grid = json.loads((out / "grid.json").read_text())
    assert grid["schema"] == 1 and grid["n"] == grid["cells"]+1
    elev_zip = (out / "reference/wc2.1_10m_elev.zip").resolve()
    elevation = read_raster("zip://" + elev_zip.as_posix() + "!wc2.1_10m_elev.tif")
    land = ~np.ma.getmaskarray(elevation)
    height = np.maximum(elevation.filled(0).astype(float), 0)
    weights = pixel_areas(*land.shape)
    lat, lon = np.deg2rad(90-(np.arange(1080)+.5)/6), np.deg2rad(-180+(np.arange(2160)+.5)/6)
    xyz = np.stack(np.broadcast_arrays(np.cos(lat[:,None])*np.cos(lon), np.cos(lat[:,None])*np.sin(lon), np.sin(lat[:,None])),axis=-1)
    tree = cKDTree(np.array(grid["xyz"]).reshape(-1,3))
    # Ten-arc-minute area quadrature onto the nearest spherical solver cell.
    # This is a Voronoi approximation; do not claim exact dual-cell overlap.
    _, nearest = tree.query(xyz.reshape(-1,3), workers=1)
    mass = np.bincount(nearest, weights=weights.ravel(), minlength=grid["n"])
    land_mass = np.bincount(nearest, weights=(weights*land).ravel(), minlength=grid["n"])
    height_mass = np.bincount(nearest, weights=(weights*land*height).ravel(), minlength=grid["n"])
    assert np.all(mass>0)
    coarse_land = land_mass/mass
    coarse_height = np.divide(height_mass,land_mass,out=np.zeros_like(mass),where=land_mass>0)
    source = {"surface_elevation":"WorldClim 2.1 10-arc-minute elevation", "url":"https://geodata.ucdavis.edu/climate/worldclim/2_1/base/wc2.1_10m_elev.zip", "sha256":hashlib.sha256(elev_zip.read_bytes()).hexdigest(), "mask":"valid elevation pixels; includes ice sheets; inland water follows the source mask", "negative_land":"clamped to 0 m to fit current nonnegative land-height contract", "aggregation":"10-arc-minute spherical pixel areas assigned to nearest circulation cell; normalized by sampled cell area"}
    report = {"source":source,"cells":grid["n"],"land_fraction":float((weights*land).sum()/weights.sum()),"solver_land_fraction":float(np.dot(coarse_land,grid["area"])/sum(grid["area"])),"negative_land_fraction":float((weights*land*(elevation.filled(0)<0)).sum()/(weights*land).sum()),"land_elevation_mean_m":float((weights*land*height).sum()/(weights*land).sum())}
    body = {"radiusKm":6371,"gravityG":1,"rotationHours":24,"axialTiltDeg":23.44,"ageGyr":4.54}
    payload={"schema":1,"cells":grid["cells"],"body":body,"source":source,"land":coarse_land.tolist(),"height":coarse_height.tolist()}
    (out / "input.json").write_text(json.dumps(payload,separators=(",",":")))
    (out / "input-report.json").write_text(json.dumps(report,indent=2))
    np.savez_compressed(out / "remap.npz",nearest=nearest.reshape(land.shape),land=land,height=height,weights=weights,mass=mass)
    # This is a separate evaluation path: no climate reference is in input.json.
    observations=[]
    observation_sources=[]
    for bio in (1,12,4,15):
        path = worldclim / f"wc2.1_10m_bio_{bio}.tif"
        values = read_raster(path).filled(np.nan).astype(float)
        if bio == 4:
            values /= 100
        # BIO12 uses a civil-year total, converted to a 360-day equivalent.
        if bio == 12:
            values *= 360/365.2425
        observations.append(block_mean(values, weights*land))
        observation_sources.append({"path":path.as_posix(),"sha256":hashlib.sha256(path.read_bytes()).hexdigest()})
    # For observations BIO4/BIO15 are means of local seasonality, not seasonality
    # of the spatial mean. Compare them with the same operation on our output.
    np.savez_compressed(out / "observations.npz",annual=np.stack(observations))
    (out / "observation-provenance.json").write_text(json.dumps({"product":"WorldClim 2.1","period":[1970,2000],"url":"https://www.worldclim.org/data/worldclim21.html","sources":observation_sources,"precipitation_conversion":"BIO12 * 360/365.2425; BIO15 retained as published, different month lengths remain","seasonality":"spatial mean of each pixel's BIO4/BIO15; compare with spatial mean of model local SD/CV"},indent=2))
    print(json.dumps(report,indent=2),flush=True)


def metrics(model, reference, weights):
    good=np.isfinite(model)&np.isfinite(reference)&(weights>0)
    a,b,w=model[good],reference[good],np.broadcast_to(weights,model.shape)[good]
    if not len(w):
        return None
    w=w/w.sum()
    ma,mb=np.dot(w,a),np.dot(w,b)
    va,vb=np.dot(w,(a-ma)**2),np.dot(w,(b-mb)**2)
    return {"cells":int(len(w)),"model_mean":float(ma),"reference_mean":float(mb),"bias":float(ma-mb),"mae":float(np.dot(w,np.abs(a-b))),"rmse":float(np.sqrt(np.dot(w,(a-b)**2))),"spatial_correlation":float(np.dot(w,(a-ma)*(b-mb))/np.sqrt(va*vb)) if va*vb>0 else None}


def compare(out, names):
    os.environ.setdefault("MPLCONFIGDIR",str(out/"mpl-cache"))
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.colors import Normalize, LogNorm, TwoSlopeNorm
    plt.rcParams.update({"font.family":"DejaVu Sans","font.size":10,"axes.titlesize":11,"figure.facecolor":"#faf9f5","savefig.facecolor":"#faf9f5"})
    remap=np.load(out/"remap.npz")
    nearest,land,height,weights=(remap[k] for k in ("nearest","land","height","weights"))
    gcm=np.load(out/"reference/gfdl-climatology.npz")
    assert np.allclose(gcm["lat"],np.arange(-89.5,90,1)) and np.allclose(gcm["lon"],np.arange(.625,360,1.25))
    assert np.allclose(gcm["lat_bnds"],np.stack((np.arange(-90,90),np.arange(-89,91)),axis=-1))
    assert np.allclose(gcm["lon_bnds"],np.stack((np.arange(0,360,1.25),np.arange(1.25,361,1.25)),axis=-1))
    wg=pixel_areas(180,288)
    gt,gp=(block_mean(gcm_order(gcm[k]),wg) for k in ("tas","pr"))
    reference=summarize(gt,gp)
    fraction=block_mean(land.astype(float),weights)
    ice=block_mean(gcm_order(gcm["sftgif"]),wg)
    area=pixel_areas(36,72)
    core=fraction>=.95
    nonice=core&(ice<5)
    masks={"global":area,"land_core":area*core,"nonice_land_core":area*nonice,"ocean_core":area*(fraction<=.05)}
    observations=np.load(out/"observations.npz")["annual"]
    lon=np.arange(-177.5,180,5);lat=np.arange(87.5,-90,-5)
    lon2,lat2=np.meshgrid(lon,lat)
    provenance=json.loads((out/"reference/provenance.json").read_text())
    all_reports={"reference":{"model":"GFDL-ESM4","experiment":"historical","member":"r1i1p1f1","period":provenance["period"],"calendar":provenance["calendar"],"source":"https://www.gfdl.noaa.gov/cmip/","license":provenance["tas"]["attributes"].get("license")},"method":{"grid":"5 degree aligned area means; all-surface monthly fields","land_core":"WorldClim elevation land fraction >= 95%","nonice_land_core":"land core and GCM glacier area < 5%","rain_calendar":"each GCM monthly mean rate * 86400 * 30; annual equivalent 360 days","seasonality":"SD/CV computed after area-averaging monthly fields for GCM comparison; average local SD/CV for WorldClim comparison","observations":"WorldClim 2.1 1970-2000; no station uncertainty model; not a GCM"},"runs":{}}
    all_reports["input_sha256"]=hashlib.sha256((out/"input.json").read_bytes()).hexdigest()
    all_reports["comparison_code_sha256"]={name:hashlib.sha256((ROOT/"scripts"/name).read_bytes()).hexdigest() for name in ("earth-climate-reference.py","earth-climate-benchmark.py","benchmark-earth-climate.mjs")}
    norms=[Normalize(-40,35),LogNorm(50,5000),Normalize(0,22),Normalize(0,150)]
    cmaps=["coolwarm","YlGnBu","magma","YlOrBr"]
    limits=[15,1500,10,100]
    def map_ax(ax,data,index,difference=False):
        im=ax.imshow(data,extent=(-180,180,-90,90),origin="upper",cmap="RdBu_r" if difference else cmaps[index],norm=TwoSlopeNorm(0,-limits[index],limits[index]) if difference else norms[index],interpolation="nearest",aspect="auto")
        ax.contour(lon2,lat2,fraction,levels=[.5],colors="#343b3e",linewidths=.45)
        ax.set_xticks([-120,0,120]);ax.set_yticks([-60,0,60]);ax.tick_params(labelsize=7)
        return im
    for name in names:
        directory=out/name
        run=json.loads((directory/"run.json").read_text())
        assert run["ready"]
        assert run["sourceFingerprint"]==hashlib.sha256((out/"input.json").read_bytes()).hexdigest(),"Run belongs to another Earth input"
        monthly=json.loads((directory/"monthly.json").read_text())
        t,p=(np.array(monthly[k]).reshape(12,-1) for k in ("temperature","precipitation"))
        mt=np.stack([block_mean(a[nearest],weights) for a in t])
        mp=np.stack([block_mean(a[nearest],weights) for a in p])
        annual=summarize(mt,mp)
        local=summarize(t,p)
        obs_model=np.stack([block_mean(a[nearest],weights*land) for a in local])
        r={"seconds":run["seconds"],"years":run["diagnostics"]["years"],"options":run["options"],"gcm":{mask:{field:metrics(a,b,w) for field,a,b in zip(FIELDS,annual,reference)} for mask,w in masks.items()},"worldclim_nonice_land_core":{field:metrics(a,b,area*nonice) for field,a,b in zip(FIELDS,obs_model,observations)}}
        # Regional reports diagnose geography; they never enter solver forcing.
        regions={"Tropics":np.abs(lat2)<23.5,"Northern midlatitudes":(lat2>=30)&(lat2<60),"Southern midlatitudes":(lat2<=-30)&(lat2>-60),"Polar":np.abs(lat2)>=60,"Americas":(lon2>=-170)&(lon2<-30),"Africa / Europe":(lon2>=-20)&(lon2<50),"Asia / Oceania":(lon2>=50)&(lon2<=180)}
        r["regions"]={region:{field:metrics(a,b,area*core*mask) for field,a,b in zip(FIELDS,annual,reference)} for region,mask in regions.items()}
        r["monthly_land_core"]={field:metrics(a,b,np.broadcast_to(area*core,a.shape)) for field,a,b in (("temperature",mt,gt),("precipitation",mp,gp))}
        all_reports["runs"][name]=r
        np.savez_compressed(directory/"comparison.npz",annual=annual,reference=reference,monthly_temperature=mt,monthly_precipitation=mp,gcm_temperature=gt,gcm_precipitation=gp,land_fraction=fraction,observation_model=obs_model,observations=observations)
        fig,axes=plt.subplots(3,4,figsize=(17,8.8),layout="constrained")
        for col in range(4):
            for row,data in enumerate((annual,reference,annual-reference)):
                im=map_ax(axes[row,col],data[col],col,row==2)
                if row==0:axes[row,col].set_title(LABELS[col])
                if col==0:axes[row,col].set_ylabel(("Our seasonal model","GFDL-ESM4","Ours minus GCM")[row])
                if row in (1,2):fig.colorbar(im,ax=axes[row,col],shrink=.8,pad=.02)
        fig.suptitle(f"Real Earth · {name.replace('_',' ')} · GFDL-ESM4 {provenance['period'][0]}–{provenance['period'][1]}\n5° area means · elevation and land fraction only · 360-day rainfall",fontsize=14)
        fig.supxlabel("GFDL CMIP6 historical r1i1p1f1 v20190726 · derived GCM maps CC-BY-SA 4.0 · not a weather or multi-model validation",fontsize=9)
        fig.savefig(directory/"comparison.png",dpi=125);plt.close(fig)
        fig,axes=plt.subplots(2,3,figsize=(13,6.5),layout="constrained")
        for row,(ours,ref,index,title) in enumerate(((mt[[5,6,7]].mean(0)-mt[[11,0,1]].mean(0),gt[[5,6,7]].mean(0)-gt[[11,0,1]].mean(0),0,"JJA minus DJF temperature (°C)"),(mp[[5,6,7]].mean(0)-mp[[11,0,1]].mean(0),gp[[5,6,7]].mean(0)-gp[[11,0,1]].mean(0),1,"JJA minus DJF rainfall (mm / 30 days)"))):
            scale=40 if index==0 else 220
            for col,a in enumerate((ours,ref,ours-ref)):
                im=axes[row,col].imshow(a,extent=(-180,180,-90,90),origin="upper",cmap="RdBu_r" if index==0 else "BrBG",vmin=-scale,vmax=scale,aspect="auto")
                axes[row,col].contour(lon2,lat2,fraction,levels=[.5],colors="#343b3e",linewidths=.45)
                axes[row,col].set_title(("Our seasonal model","GFDL-ESM4","Difference")[col]);axes[row,col].set_xticks([-120,0,120]);axes[row,col].set_yticks([-60,0,60]);fig.colorbar(im,ax=axes[row,col],shrink=.7)
            axes[row,0].set_ylabel(title)
        fig.suptitle(f"Seasonal reversal · {name.replace('_',' ')} · GFDL {provenance['period'][0]}–{provenance['period'][1]}",fontsize=15)
        fig.savefig(directory/"seasons.png",dpi=125);plt.close(fig)
        fig,axes=plt.subplots(2,3,figsize=(13,7),layout="constrained")
        for col,(title,bounds) in enumerate((("North Africa",(-20,60,0,45)),("South / East Asia",(60,150,-10,50)),("Tropical South America",(-85,-30,-25,15)))):
            for row,a in enumerate((annual[1],reference[1])):
                im=axes[row,col].imshow(np.where(fraction>.5,a,np.nan),extent=(-180,180,-90,90),origin="upper",cmap=cmaps[1],norm=norms[1],aspect="auto")
                axes[row,col].contour(lon2,lat2,fraction,levels=[.5],colors="#343b3e",linewidths=.6)
                axes[row,col].set_xlim(bounds[:2]);axes[row,col].set_ylim(bounds[2:]);axes[row,col].set_title(f"{('Ours','GFDL')[row]} · {title}")
                fig.colorbar(im,ax=axes[row,col],shrink=.75)
        fig.suptitle(f"Regional rainfall · {name.replace('_',' ')} · mm / 360 days\n5° field crops · cells with >50% land shown · fixed color scale",fontsize=14)
        fig.savefig(directory/"regions.png",dpi=125);plt.close(fig)
        # Orthographic captures cover both hemispheres and the longitude seam.
        fig,axes=plt.subplots(2,4,figsize=(13,7),layout="constrained")
        v=np.linspace(-1,1,320);xx,yy=np.meshgrid(v,-v);rr=xx*xx+yy*yy;visible=rr<=1
        z=np.sqrt(np.maximum(0,1-rr));phi=np.arcsin(np.clip(yy,-1,1));delta=np.arctan2(xx,z)
        iy=np.minimum(35,((90-np.rad2deg(phi))/5).astype(int))
        for col,center in enumerate((-90,0,90,180)):
            longitude=(np.rad2deg(delta)+center+180)%360-180
            ix=np.minimum(71,((longitude+180)/5).astype(int))
            for row,a in enumerate((annual[1],reference[1])):
                picture=np.ma.masked_where(~visible,a[iy,ix])
                axes[row,col].imshow(picture,cmap=cmaps[1],norm=norms[1],extent=(-1,1,-1,1))
                mask=np.ma.masked_where(~visible,fraction[iy,ix]);axes[row,col].contour(xx,yy,mask,levels=[.5],colors="#343b3e",linewidths=.45)
                axes[row,col].set_axis_off();axes[row,col].set_title(f"{('Ours','GFDL')[row]} · {center}°")
        fig.suptitle(f"Annual rain on the globe · {name} · same 50–5000 mm color scale as comparison",fontsize=14)
        fig.savefig(directory/"globes.png",dpi=125);plt.close(fig)
        print(name, json.dumps({"seconds":r["seconds"],"gcm_land_temperature_mae_C":r["gcm"]["land_core"]["temperature"]["mae"],"gcm_land_rain_mae_mm":r["gcm"]["land_core"]["precipitation"]["mae"],"gcm_land_rain_correlation":r["gcm"]["land_core"]["precipitation"]["spatial_correlation"],"worldclim_temperature_mae_C":r["worldclim_nonice_land_core"]["temperature"]["mae"]}),flush=True)
    if len(names)>1:
        # A fixed scale across runs exposes tradeoffs hidden by a single score.
        first=np.load(out/names[0]/"comparison.npz")["annual"]
        last=np.load(out/names[-1]/"comparison.npz")["annual"]
        fig,axes=plt.subplots(3,4,figsize=(17,8),layout="constrained")
        for row,(name,data) in enumerate(((names[0],first),(names[-1],last),("GFDL-ESM4",reference))):
            for col in range(4):
                im=map_ax(axes[row,col],data[col],col)
                if row==0:axes[row,col].set_title(LABELS[col])
                if col==0:axes[row,col].set_ylabel(name.replace('_',' '))
                if row==2:fig.colorbar(im,ax=axes[row,col],shrink=.8,pad=.02)
        fig.suptitle("Real Earth climate · comparison of all four terrain inputs\nIdentical geography · 5° area means · fixed scales across runs",fontsize=14)
        fig.supxlabel("NOAA GFDL-ESM4 CMIP6 historical r1i1p1f1 · 1970–2000 · derived GCM maps CC-BY-SA 4.0",fontsize=9)
        fig.savefig(out/"before-after.png",dpi=125);plt.close(fig)
    (out/"report.json").write_text(json.dumps(all_reports,indent=2,allow_nan=False))
    lines=["# Real Earth climate benchmark", "", "The solver receives WorldClim surface elevation and its valid-land mask, aggregated to our spherical climate grid. It receives no reference temperatures, precipitation, or Earth wind fields.", "", "Reference: NOAA GFDL-ESM4 CMIP6 historical r1i1p1f1 monthly climatology; see report.json for the selected period. This is a published coupled GCM run, not a GCM we ran locally. Raw data: https://storage.googleapis.com/cmip6/CMIP6/CMIP/NOAA-GFDL/GFDL-ESM4/historical/r1i1p1f1/ (v20190726). GFDL data and derived reference maps retain CC-BY-SA 4.0 attribution; see reference/provenance.json for the full license.", "", "## Compared on the same representation", "", "Ten-arc-minute elevation pixels are area-aggregated to 10,001 spherical circulation cells. Negative land heights are clamped to zero to fit the existing contract. The input mask retains ice-covered land and below-sea-level basins. A 5° grid compares area means of monthly fields; seasonal SD/CV are computed after spatial averaging. Land scores use cells >=95% land. The ocean score uses <=5% land. Each GCM rainfall rate is converted to a 30-day equivalent total, matching the model's 360-day calendar.", "", "## Results", "", "| Run | Solve time | Land temperature MAE | Land rain MAE | Land rain pattern correlation |", "| --- | ---: | ---: | ---: | ---: |"]
    for name,r in all_reports["runs"].items():
        t=r["gcm"]["land_core"]["temperature"];p=r["gcm"]["land_core"]["precipitation"]
        lines.append(f"| {name} | {r['seconds']:.1f} s | {t['mae']:.2f} °C | {p['mae']:.0f} mm/360 days | {p['spatial_correlation']:.2f} |")
    lines += ["", "## All four terrain inputs", "", "Area-weighted MAE; lower is better. GCM uses core land (including ice); WorldClim uses non-glaciated core land. Correlation and bias are also retained in report.json.", "", "| Run / reference | Temperature, °C | Rain, mm/360 days | Temperature SD, °C | Rain CV, percentage points |", "| --- | ---: | ---: | ---: | ---: |"]
    for name,r in all_reports["runs"].items():
        for label,fields in (("GFDL",r["gcm"]["land_core"]),("WorldClim",r["worldclim_nonice_land_core"])):
            values=[fields[field]["mae"] for field in FIELDS]
            lines.append(f"| {name} / {label} | {values[0]:.2f} | {values[1]:.0f} | {values[2]:.2f} | {values[3]:.2f} |")
    lines += ["", "## Limits", "", "This tests an equilibrium approximation against a transient historical climatology, with different radiative/cloud physics, coastlines, orography, ocean dynamics and ice-sheet boundary conditions. The solver has no prescribed permanent ice mask; this benchmark exposes that limitation. GCM agreement is not a percent realism score or proof of accuracy on other planets. WorldClim 2.1 (1970–2000) is an independent observational cross-check over non-glaciated core land, not a second GCM. Its local BIO4/BIO15 are spatially averaged and compared to the same operation on model fields; published BIO15 retains Gregorian month-length effects. Its annual rainfall is converted by 360/365.2425. WorldClim polar estimates and sparse-station regions are uncertain.", "", "All metrics are area-weighted and no calibration has been applied to the reference. Inspect comparison.png, seasons.png and globes.png in each run folder. report.json records regional, seasonal, ocean and WorldClim comparisons; reference/provenance.json and downloads.json record source metadata and SHA-256 hashes. Production defaults and active campaign inputs are untouched by these benchmark scripts."]
    (out/"README.md").write_text("\n".join(lines)+"\n",encoding="utf-8")


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command",choices=("prepare","compare"))
    parser.add_argument("--out",type=Path,default=ROOT/"work/earth-climate")
    parser.add_argument("--worldclim",type=Path,default=ROOT.parent/"terrain-diffusion/data/global")
    parser.add_argument("--runs",nargs="+",default=["baseline"])
    args=parser.parse_args()
    if args.command=="prepare":prepare(args.out,args.worldclim)
    else:compare(args.out,args.runs)


if __name__=="__main__":
    main()
