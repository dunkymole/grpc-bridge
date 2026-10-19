param(
    [int]$DurationSeconds = 7200,
    [int]$Repetitions = 2,
    [string]$NodeExecutable = "node",
    [string]$ProjectName = "grpc-bridge-clean-soak"
)
$ErrorActionPreference = "Stop"
if ($DurationSeconds -lt 3600 -or $Repetitions -lt 2) { throw "Use at least two hours-long repetitions for this evidence workflow" }
if ($ProjectName -notmatch '^grpc-bridge-clean-[a-z0-9-]+$') { throw "Use a dedicated grpc-bridge-clean-* Compose project" }
if ([int](& $NodeExecutable -p 'process.versions.node.split(".")[0]') -lt 24) { throw "Node 24 or newer is required" }
if (git status --porcelain) { throw "Source checkout must be clean" }
$revision = git rev-parse HEAD
$runStamp = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssfff")
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class BridgeSoakPower {
    [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);
}
'@
if ([BridgeSoakPower]::SetThreadExecutionState(2147483649) -eq 0) { throw "Could not request temporary system-awake state" }
try {
    $env:BENCH_REQUIRE_CLEAN = "1"
    $env:COMPOSE_PROJECT_NAME = $ProjectName
    $env:BENCH_DURATION_SECONDS = "$DurationSeconds"
    $reports = @()
    for ($iteration = 1; $iteration -le $Repetitions; $iteration++) {
        if ((git rev-parse HEAD) -ne $revision -or (git status --porcelain)) { throw "Source changed during the repeat workflow" }
        docker compose -f compose.yaml -f compose.benchmark.yaml up --build -d --wait --force-recreate
        if ($LASTEXITCODE -ne 0) { throw "Compose failed" }
        Push-Location web
        try {
            $env:BENCH_OUTPUT = "test-results/load/clean-$($revision.Substring(0,12))-$runStamp-$iteration.json"
            $reports += $env:BENCH_OUTPUT
            & $NodeExecutable node_modules/tsx/dist/cli.mjs scripts/load-benchmark.ts soak
            if ($LASTEXITCODE -ne 0) { throw "Soak repetition $iteration failed; evidence retained" }
        } finally { Pop-Location }
    }
    Push-Location web
    try {
        & $NodeExecutable node_modules/tsx/dist/cli.mjs scripts/analyze-soak.ts @reports
        if ($LASTEXITCODE -ne 0) { throw "Analysis failed" }
    } finally { Pop-Location }
} finally {
    [void][BridgeSoakPower]::SetThreadExecutionState(2147483648)
}
