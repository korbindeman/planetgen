#!/usr/bin/env python3
"""Rebuild earth-plates-data.json from Bird 2003 PB2002 polygons.

  curl -fsSL -o /tmp/PB2002_plates.json \\
    https://raw.githubusercontent.com/fraxen/tectonicplates/master/GeoJSON/PB2002_plates.json
  python3 scripts/build-earth-plates.py /tmp/PB2002_plates.json
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

MERGE = {
    'PA': 'Pacific', 'CL': 'Pacific', 'EA': 'Pacific', 'JZ': 'Pacific',
    'NA': 'North America',
    'SA': 'South America', 'ND': 'South America', 'AP': 'South America',
    'EU': 'Eurasia', 'AM': 'Eurasia', 'YA': 'Eurasia', 'ON': 'Eurasia',
    'SU': 'Eurasia', 'BU': 'Eurasia', 'AT': 'Eurasia', 'AS': 'Eurasia',
    'OK': 'Eurasia', 'MS': 'Eurasia',
    'AF': 'Africa',
    'AN': 'Antarctica', 'SL': 'Antarctica',
    'AU': 'Australia', 'WL': 'Australia', 'SS': 'Australia', 'NB': 'Australia',
    'SB': 'Australia', 'MN': 'Australia', 'NH': 'Australia', 'CR': 'Australia',
    'BR': 'Australia', 'FT': 'Australia', 'NI': 'Australia', 'TO': 'Australia',
    'KE': 'Australia', 'MO': 'Australia', 'BH': 'Australia', 'TI': 'Australia',
    'BS': 'Australia',
    'NZ': 'Nazca', 'GP': 'Nazca',
    'IN': 'India',
    'CA': 'Caribbean', 'PM': 'Caribbean',
    'CO': 'Cocos', 'RI': 'Cocos',
    'PS': 'Philippine Sea', 'MA': 'Philippine Sea',
    'SC': 'Scotia', 'SW': 'Scotia',
    'AR': 'Arabia',
    'JF': 'Juan de Fuca',
    'SO': 'Somalia',
}

POLES = {
    'Pacific': (114.70, -63.58, 0.651),
    'North America': (-80.64, -4.85, 0.209),
    'South America': (-112.83, -22.62, 0.109),
    'Eurasia': (-106.50, 48.85, 0.223),
    'Africa': (-68.44, 47.68, 0.292),
    'Antarctica': (-118.11, 65.42, 0.250),
    'Australia': (37.94, 33.86, 0.632),
    'Nazca': (-101.06, 46.23, 0.696),
    'India': (-3.29, 50.37, 0.544),
    'Caribbean': (-92.62, 35.20, 0.286),
    'Cocos': (-124.31, 26.93, 1.198),
    'Philippine Sea': (-31.36, -46.02, 0.910),
    'Scotia': (-106.15, 22.52, 0.146),
    'Arabia': (-8.49, 48.88, 0.559),
    'Juan de Fuca': (60.04, -38.31, 0.951),
    'Somalia': (-84.52, 49.95, 0.339),
}

ORDER = [
    'Pacific', 'North America', 'South America', 'Eurasia', 'Africa',
    'Antarctica', 'Australia', 'Nazca', 'India', 'Caribbean', 'Cocos',
    'Philippine Sea', 'Scotia', 'Arabia', 'Juan de Fuca', 'Somalia',
]


def rings_of(geom):
    if geom['type'] == 'Polygon':
        return geom['coordinates']
    if geom['type'] == 'MultiPolygon':
        out = []
        for poly in geom['coordinates']:
            out.extend(poly)
        return out
    raise ValueError(geom['type'])


def clean_ring(ring):
    pts = []
    for lon, lat in ring:
        lon = round(float(lon), 3)
        lat = round(float(lat), 3)
        if pts and pts[-1][0] == lon and pts[-1][1] == lat:
            continue
        pts.append([lon, lat])
    if pts and pts[0] != pts[-1]:
        pts.append(pts[0][:])
    return pts if len(pts) >= 4 else None


def main():
    src = Path(sys.argv[1] if len(sys.argv) > 1 else '/tmp/PB2002_plates.json')
    data = json.loads(src.read_text())
    plates = {name: [] for name in ORDER}
    for feat in data['features']:
        code = feat['properties']['Code']
        if code not in MERGE:
            raise SystemExit(f'unmapped Bird plate {code}')
        for ring in rings_of(feat['geometry']):
            cleaned = clean_ring(ring)
            if cleaned:
                plates[MERGE[code]].append(cleaned)
    out_plates = []
    for name in ORDER:
        lon, lat, omega = POLES[name]
        out_plates.append({
            'name': name,
            'poleLon': lon,
            'poleLat': lat,
            'omegaDeg': omega,
            'rings': plates[name],
        })
    payload = {
        'source': 'Bird 2003 PB2002 outlines (fraxen/tectonicplates GeoJSON), merged to the 16-plate USGS-style map. Poles are NNR-MORVEL56 (Argus, Gordon, DeMets 2011).',
        'plates': out_plates,
    }
    dest = ROOT / 'src' / 'earth-plates-data.json'
    dest.write_text(json.dumps(payload, separators=(',', ':')))
    print(f'wrote {dest} ({dest.stat().st_size} bytes)')


if __name__ == '__main__':
    main()
