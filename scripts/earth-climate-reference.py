"""Fetch a small, reproducible published GCM reference; never start a GCM/TD worker.

Requires numpy, numcodecs, cftime (see docs/ref/climate-benchmark.md).
Only two 50-year time chunks per variable are needed from this Zarr-v2 store.
This intentionally supports only the pinned store layout, not arbitrary Zarr.
"""
import argparse
import hashlib
import json
import math
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "work/earth-climate/python"))
import numpy as np
import cftime
from numcodecs import get_codec

BASE = "https://storage.googleapis.com/cmip6/CMIP6/CMIP/NOAA-GFDL/GFDL-ESM4/historical/r1i1p1f1"
VERSION = "gr1/v20190726"
ELEV_URL = "https://geodata.ucdavis.edu/climate/worldclim/2_1/base/wc2.1_10m_elev.zip"


def fetch(url, path, manifest):
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        print("Download", url, flush=True)
        partial = path.with_name(path.name + ".part")
        for attempt in range(3):
            try:
                with urllib.request.urlopen(url, timeout=120) as src, partial.open("wb") as dst:
                    while data := src.read(1024 * 1024):
                        dst.write(data)
                partial.replace(path)
                break
            except Exception:
                if attempt == 2:
                    raise
                time.sleep(2)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    previous = manifest.get(url)
    if previous and previous["sha256"] != digest:
        raise ValueError(f"Cached reference checksum changed: {path}")
    manifest[url] = {"path": path.as_posix(), "bytes": path.stat().st_size, "sha256": digest}
    return path.read_bytes()


class Store:
    def __init__(self, variable, directory, manifest):
        table = "Amon" if variable in ("tas", "pr") else "fx"
        self.url = f"{BASE}/{table}/{variable}/{VERSION}"
        self.directory = directory / variable
        self.manifest = manifest
        self.meta = json.loads(self.get(".zmetadata"))["metadata"]

    def get(self, key):
        return fetch(self.url + "/" + key, self.directory / key, self.manifest)

    def chunk(self, name, indices):
        spec = self.meta[name + "/.zarray"]
        assert spec["zarr_format"] == 2 and spec["order"] == "C" and not spec["filters"]
        raw = self.get(name + "/" + ".".join(map(str, indices)))
        if spec["compressor"]:
            raw = get_codec(spec["compressor"]).decode(raw)
        out = np.frombuffer(raw, dtype=spec["dtype"])
        # Zarr stores padded edge chunks in this archive; tolerate trimmed edges.
        edge = tuple(min(c, n-i*c) for c, n, i in zip(spec["chunks"], spec["shape"], indices))
        shape = spec["chunks"] if out.size == math.prod(spec["chunks"]) else edge
        if out.size != math.prod(shape):
            raise ValueError(f"Truncated {name} chunk {indices}")
        out = out.reshape(shape)[tuple(slice(0, n) for n in edge)].astype(np.float64)
        fill = spec.get("fill_value")
        if isinstance(fill, (int, float)):
            out[out == fill] = np.nan
        attrs = self.meta[name + "/.zattrs"]
        return out * attrs.get("scale_factor", 1) + attrs.get("add_offset", 0)

    def small(self, name):
        spec = self.meta[name + "/.zarray"]
        assert spec["chunks"] == spec["shape"], (name, spec)
        return self.chunk(name, [0] * len(spec["shape"]))

    def climatology(self, name, first, last):
        spec = self.meta[name + "/.zarray"]
        assert spec["shape"][1:] == spec["chunks"][1:] == [180, 288]
        attrs = self.meta["time/.zattrs"]
        dates = cftime.num2date(self.small("time"), attrs["units"], attrs["calendar"])
        selected = np.array([first <= d.year <= last for d in dates])
        months = np.array([d.month for d in dates])
        years = np.array([d.year for d in dates])
        expected = {(y, m) for y in range(first, last + 1) for m in range(1, 13)}
        actual = [(d.year, d.month) for d in dates[selected]]
        assert len(actual) == len(expected) and set(actual) == expected, "Missing or repeated month"
        total = np.zeros((12, 180, 288))
        count = np.zeros(12, dtype=int)
        width = spec["chunks"][0]
        for k in sorted(set(np.where(selected)[0] // width)):
            chunk = self.chunk(name, [int(k), 0, 0])
            for local in range(chunk.shape[0]):
                i = k * width + local
                if selected[i]:
                    assert np.isfinite(chunk[local]).all(), f"Missing {name} at {years[i]}-{months[i]}"
                    total[months[i]-1] += chunk[local]
                    count[months[i]-1] += 1
        assert np.all(count == last-first+1)
        return total / count[:, None, None], attrs["calendar"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=ROOT / "work/earth-climate/reference")
    parser.add_argument("--first", type=int, default=1970)
    parser.add_argument("--last", type=int, default=2000)
    args = parser.parse_args()
    if not 1850 <= args.first <= args.last <= 2014:
        parser.error("Reference period must lie within 1850–2014")
    manifest_path = args.out / "downloads.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    outputs, provenance = {}, {}
    try:
        for variable in ("tas", "pr", "orog", "sftgif"):
            store = Store(variable, args.out, manifest)
            if variable in ("tas", "pr"):
                values, calendar = store.climatology(variable, args.first, args.last)
            else:
                values = store.small(variable)
            units = store.meta[variable + "/.zattrs"]["units"]
            assert units == {"tas": "K", "pr": "kg m-2 s-1", "orog": "m", "sftgif": "%"}[variable]
            # Compare equal 30-day months to the solver's 360-day calendar.
            outputs[variable] = values - 273.15 if variable == "tas" else values * 86400 * 30 if variable == "pr" else values
            lat, lon = store.small("lat"), store.small("lon")
            if "lat" in outputs:
                assert np.array_equal(lat, outputs["lat"]) and np.array_equal(lon, outputs["lon"])
            outputs.update(lat=lat, lon=lon, lat_bnds=store.small("lat_bnds"), lon_bnds=store.small("lon_bnds"))
            provenance[variable] = {"url": store.url, "attributes": store.meta[".zattrs"], "variable": store.meta[variable+"/.zattrs"]}
            print(variable, "range", float(np.nanmin(outputs[variable])), float(np.nanmax(outputs[variable])), flush=True)
        fetch(ELEV_URL, args.out / "wc2.1_10m_elev.zip", manifest)
        np.savez_compressed(args.out / "gfdl-climatology.npz", **outputs)
        provenance.update(period=[args.first, args.last], calendar=calendar, output_units={"tas":"degC", "pr":"mm per 30-day equivalent month"}, precipitation_conversion="rate * 86400 * 30; annual total is a 360-day equivalent", experiment="historical", member="r1i1p1f1", model="GFDL-ESM4", version=VERSION)
        (args.out / "provenance.json").write_text(json.dumps(provenance, indent=2))
    finally:
        manifest_path.write_text(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
