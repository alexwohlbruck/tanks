#!/usr/bin/env bash
# Extract the Wii Play disc and unpack every archive the Tanks! port uses.
# usage: tools/extract_rom.sh [rom.rvz] [workdir]
# Requires nodtool (https://github.com/encounter/nod) on PATH.
set -euo pipefail
ROM="${1:-rom/Wii Play (USA).rvz}"
WORK="${2:-build/rom}"
HERE="$(cd "$(dirname "$0")" && pwd)"
if [ ! -d "$WORK/ext/files" ]; then
  nodtool extract -q "$ROM" "$WORK/ext"
fi
F="$WORK/ext/files"
X="$WORK/x"
for a in Common/RPTnkScene/common US/RPTnkScene/local Common/RPCommon/common US/RPCommon/local \
         Common/RPPartyCommon/common US/RPPartyCommon/local Common/PartyStatic/common US/PartyStatic/local; do
  [ -d "$X/$a" ] || python3 "$HERE/u8.py" "$F/$a.carc" "$X/$a"
done
# nested .arc archives
find "$X" -name '*.arc' | while read -r arc; do
  out="${arc%.arc}"
  [ -d "$out" ] || python3 "$HERE/u8.py" "$arc" "$out"
done
echo "extracted to $X"
