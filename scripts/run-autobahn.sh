#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
run_id="${GITHUB_RUN_ID:-local}-$(date -u +%Y%m%d%H%M%S)-$$"
project="grpc-bridge-autobahn-${run_id}"
export AUTOBAHN_RUN_ID="$run_id"
compose=(docker compose --project-name "$project" --file "$root/test/autobahn/compose.yaml")
report_root="$root/test-results/autobahn"
run_dir="$report_root/$run_id"
mkdir -p "$run_dir"
python3 - "$root/test/autobahn/fuzzingclient.json" "$run_dir/fuzzingclient.json" "$run_id" <<'PY'
import json
import pathlib
import sys

source, target, run_id = map(pathlib.Path, sys.argv[1:])
config = json.loads(source.read_text(encoding="utf-8"))
config["outdir"] = f"/reports/{run_id.name}/report"
target.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
PY
cleanup() {
  "${compose[@]}" logs --no-color || true
  "${compose[@]}" down --remove-orphans || true
}
trap cleanup EXIT

"${compose[@]}" up --build --abort-on-container-exit --exit-code-from autobahn
python3 "$root/scripts/check-autobahn-report.py" "$run_dir/report" "$root/test/autobahn/expected-cases.json"
