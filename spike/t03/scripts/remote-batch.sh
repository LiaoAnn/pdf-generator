#!/usr/bin/env bash
# The approved remote batch (T03 ASK, answer A). Usage: scripts/remote-batch.sh <base-url>
# Token from out/token. Renders: 3 (/run) + 44 (/bench) + <=3 (/reuse) = <=50.
# Browser launches: 1 (/launch) + 3 (3-browser bench) + 2 (/reuse) = 6.
set -euo pipefail
U="$1"
T="$(cat out/token)"
get() { # name path
  local t0=$(date +%s)
  curl -sS -m 900 -o "out/remote-$1.json" -w "$1 http=%{http_code} ${2%%\?*} " "$U$2&token=$T"
  echo "$(( $(date +%s) - t0 ))s"
}
get limits-before '/limits?'
get launch '/launch?keep_alive=600000'
S=$(node -pe 'JSON.parse(require("fs").readFileSync("out/remote-launch.json")).sessionId')
get run-fixed "/run?doc=/doc-fixed&session=$S"
get run-orig "/run?doc=/doc&session=$S"
get run-badfont "/run?doc=/doc-fixed&session=$S&css=$(node -pe 'encodeURIComponent(`@font-face{font-family:"Broken TC";src:url(/fonts/missing.otf) format("opentype")} html,.serif,.kai{font-family:"Broken TC"}`)')"
get bench-seq-intercept "/bench?n=10&session=$S"
get bench-seq-url "/bench?n=10&src=url&session=$S"
get bench-tabs3-url "/bench?tabs=3&n=4&src=url&session=$S"
get close "/close?session=$S"
sleep 20
get bench-browsers3-url '/bench?browsers=3&n=4&src=url'
sleep 20
get reuse-5s '/reuse?wait=5000'
sleep 20
get reuse-75s '/reuse?wait=75000&first=0'
get limits-after '/limits?'
