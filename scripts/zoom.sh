#!/bin/bash
# Regional zoom compare: our equirect next to the real Earth.
#   scripts/zoom.sh <name> <lonWest> <lonEast> <latNorth> <latSouth>
# Both images are 2:1 equirects with lon 0 at the centre. Output goes to
# preview/zoom-<name>.png with ours on the left, Earth on the right.
set -euo pipefail
cd "$(dirname "$0")/.."

NAME=$1; LON0=$2; LON1=$3; LAT0=$4; LAT1=$5
MINE=preview/equirect.png
REF=reference/earth-equirect.jpg

crop() { # file width height out
  local F=$1 W=$2 H=$3 OUT=$4
  local X Y CW CH
  X=$(python3 -c "print(round(($LON0+180)/360*$W))")
  CW=$(python3 -c "print(round(($LON1-($LON0))/360*$W))")
  Y=$(python3 -c "print(round((90-($LAT0))/180*$H))")
  CH=$(python3 -c "print(round((($LAT0)-($LAT1))/180*$H))")
  magick "$F" -crop "${CW}x${CH}+${X}+${Y}" +repage -resize x520 "$OUT"
}

crop "$MINE" 2048 1024 /tmp/zoom-mine.png
crop "$REF" 8192 4096 /tmp/zoom-ref.png
magick /tmp/zoom-mine.png /tmp/zoom-ref.png -background white +append "preview/zoom-$NAME.png"
echo "preview/zoom-$NAME.png"
