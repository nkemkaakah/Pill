#!/usr/bin/env bash
# Mock fluidaudiocli for integration tests. Emits JSON in the exact shapes the
# real CLI writes (verified against FluidAudio source): TranscriptionJSONOutput
# and ProcessingResult. Which fixture it emits depends on the wav filename.
set -euo pipefail
cmd="${1:-}"; shift || true
audio="${1:-}"; shift || true
out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-json|--output) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[[ -n "$out" ]] || { echo "no output path" >&2; exit 1; }
echo "mock-sidecar: $cmd $(basename "$audio")" >&2

if [[ "$cmd" == "transcribe" ]]; then
  if [[ "$audio" == *".me."* ]]; then
    cat > "$out" << 'JSON'
{"audioFile":"me.wav","mode":"batch","modelVersion":"v3","text":"Sure I would keep a previous pointer and iterate once. It is O of n time.",
 "wordTimings":[
  {"word":"Sure","startTime":6.1,"endTime":6.3,"confidence":0.95},
  {"word":"I","startTime":6.35,"endTime":6.4,"confidence":0.95},
  {"word":"would","startTime":6.45,"endTime":6.6,"confidence":0.95},
  {"word":"keep","startTime":6.65,"endTime":6.85,"confidence":0.95},
  {"word":"a","startTime":6.9,"endTime":6.95,"confidence":0.9},
  {"word":"previous","startTime":7.0,"endTime":7.4,"confidence":0.95},
  {"word":"pointer","startTime":7.45,"endTime":7.8,"confidence":0.95},
  {"word":"It","startTime":14.2,"endTime":14.3,"confidence":0.9},
  {"word":"is","startTime":14.35,"endTime":14.45,"confidence":0.9},
  {"word":"O","startTime":14.5,"endTime":14.6,"confidence":0.9},
  {"word":"of","startTime":14.62,"endTime":14.7,"confidence":0.9},
  {"word":"n","startTime":14.72,"endTime":14.8,"confidence":0.9},
  {"word":"time","startTime":14.85,"endTime":15.1,"confidence":0.9}
 ],"timingsConfirmed":true}
JSON
  else
    cat > "$out" << 'JSON'
{"audioFile":"them.wav","mode":"batch","modelVersion":"v3","text":"Walk me through reversing a linked list. And the complexity? Nice answer.",
 "wordTimings":[
  {"word":"Walk","startTime":0.2,"endTime":0.4,"confidence":0.95},
  {"word":"me","startTime":0.45,"endTime":0.55,"confidence":0.95},
  {"word":"through","startTime":0.6,"endTime":0.9,"confidence":0.95},
  {"word":"reversing","startTime":0.95,"endTime":1.4,"confidence":0.95},
  {"word":"a","startTime":1.45,"endTime":1.5,"confidence":0.9},
  {"word":"linked","startTime":1.55,"endTime":1.85,"confidence":0.95},
  {"word":"list","startTime":1.9,"endTime":2.2,"confidence":0.95},
  {"word":"And","startTime":12.0,"endTime":12.15,"confidence":0.9},
  {"word":"the","startTime":12.2,"endTime":12.3,"confidence":0.9},
  {"word":"complexity","startTime":12.35,"endTime":12.9,"confidence":0.95},
  {"word":"Nice","startTime":16.5,"endTime":16.7,"confidence":0.9},
  {"word":"answer","startTime":16.75,"endTime":17.1,"confidence":0.9}
 ],"timingsConfirmed":true}
JSON
  fi
elif [[ "$cmd" == "process" ]]; then
  cat > "$out" << 'JSON'
{"audioFile":"them.wav","durationSeconds":18.0,"processingTimeSeconds":0.4,"realTimeFactor":45.0,"speakerCount":2,
 "segments":[
  {"speakerId":"1","embedding":[0.8,0.1,0.05],"startTimeSeconds":0.0,"endTimeSeconds":2.5,"qualityScore":0.9},
  {"speakerId":"1","embedding":[0.82,0.08,0.06],"startTimeSeconds":11.8,"endTimeSeconds":13.0,"qualityScore":0.85},
  {"speakerId":"2","embedding":[0.05,0.1,0.9],"startTimeSeconds":16.3,"endTimeSeconds":17.3,"qualityScore":0.8}
 ],"timestamp":"2026-09-08T12:00:00Z"}
JSON
else
  echo "unknown command $cmd" >&2; exit 64
fi
