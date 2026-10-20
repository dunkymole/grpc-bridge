# Package release runbook

Use `scripts/release.py`: **check/bump → prepare → publish → verify**, matching
[proto-contract's stages](https://github.com/dunkymole/proto-contract/blob/main/docs/RELEASING.md).
Preparation and `publish --dry-run` make no public writes. Only an explicitly
authorized `publish` without `--dry-run` uploads packages, creates tags or publishes
GitHub Releases. Green CI and a merged version PR are not publication approval.
Issue #2 stays open until approved npm publication and registry verification pass.

## Prerequisites and distribution policy

- Python 3.11+, Git, GitHub CLI authenticated with `gh auth login`, Node 24+, modern
  npm and `tar`. Windows: PowerShell 7 and a real Python interpreter (`py -3` can
  replace `python`), not the Windows Store alias.
- Preparation downloads existing CI evidence with GitHub read access. Docker with
  Linux containers and Compose supporting additional build contexts and `!reset`
  is needed for local consumer tests and post-publication verification. Full CI
  uses its pinned Go, Python, Node, browser and protobuf toolchains.
- Only publication needs repository contents write access and npm login with
  package/scope write permission. Use local browser-based npm login/2FA. Never put
  tokens or OTPs in chat, arguments, tracked files or reports. The command changes
  no account security settings, trusted-publisher configuration or branch rules.

`web/package.json` is canonical. `check` verifies both lockfile version entries
and the current tarball install example. `bump` updates only those locations and
adds a changelog entry. Historical versions and compatibility claims remain intact.
Numeric `MAJOR.MINOR.PATCH` follows proto-contract's current policy; prerelease
SemVer suffixes are not supported by this command.

New product releases use `v<package-version>` at the exact tested bridge commit.
Explicit `--dist-tag latest` means stable npm/GitHub latest; `--dist-tag next` means
preview npm dist-tag and GitHub prerelease without replacing GitHub latest.
Backward movement is refused. Preview-to-stable promotion is a separate owner
decision; this tool refuses to change an existing release's candidate/policy.
Changed bytes always require a new version.

GitHub assets are the audited npm tarball, its four audit/consumer/preflight reports,
`candidate.json`, `RELEASE_NOTES.md` and `SHA256SUMS`. Automatic source archives are
separate. The Go bridge remains source/Compose distributed; no binary/platform
matrix or container registry is added. A public Git tag may expose the existing
Go module independently of a GitHub draft. The old v0.1.0 prototype and benchmark
prereleases are historical artifacts, not npm package versions. Package, API
contract and tunnel-profile versions are independent; roadmap milestones are plans.

## 1. Prepare and review a version PR

Run from the repository root. These PowerShell examples use the same Python
commands as Linux. Start with clean, current main and select a version and summary:

```powershell
python scripts/release.py check
git fetch origin
git checkout -b codex/release-version origin/main
$base = git rev-parse HEAD
python scripts/release.py bump --version 0.3.0 --commit $base --summary 'Describe the release changes' --dry-run
python scripts/release.py bump --version 0.3.0 --commit $base --summary 'Describe the release changes'
git diff --check
git diff
```

The bump checks clean source, expected commit, increasing version and existing
GitHub tags/releases and public npm versions before editing. A public npm 404 is
not ownership/availability proof; authenticated access is checked at publication.
Review the changelog/diff, commit the named files, push a branch and open a PR.
Merge through existing checks/review policy. Any packaged edit needs new validation.

## 2. Prepare the tested candidate (no publication)

After merge choose the successful **main push** CI run for that exact commit.
`gh run list --repo dunkymole/grpc-bridge --branch main` lists runs. Inspect its
artifact ID with the read-only lookup below, then prepare and dry-run promotion:

```powershell
$version = '0.2.0' # Current unpublished candidate; select deliberately.
$commit = 'FULL_40_CHARACTER_MAIN_COMMIT'
$run = 'MAIN_PUSH_RUN_ID'
gh api "repos/dunkymole/grpc-bridge/actions/runs/$run/artifacts"
$artifact = 'BRIDGE_VALIDATION_ARTIFACT_ID'
python scripts/release.py prepare --version $version --commit $commit --run-id $run --artifact-id $artifact --out artifacts/release-candidate
python scripts/release.py publish --version $version --commit $commit --run-id $run --artifact-id $artifact --dist-tag latest --dry-run
```

The command checks repository/workflow/commit/run/attempt and explicitly requires
both `test` and `Test this bridge revision with reviewed Proto Contract` to pass.
It does not infer success from merging or artifact existence: CI uploads reports
on failure too. It checks the artifact ZIP digest and complete package evidence,
then reuses the existing preflight to verify tarball bytes, clean source snapshots,
source tree, dependency-lock hash, compiler SHA, toolchains and complete installed
Node/three-browser results. The selected source's compiler pin is authoritative.

It copies tested bytes and generates candidate metadata, reviewable notes and
checksums. No rebuild/repack or second workflow is needed. Inspect the notes,
changelog, compatibility boundaries and hashes. Choose a fresh output directory.
The original `bridge-validation-<run>-<attempt>` is downloadable from Actions;
the prepared directory can also be shared for review. If CI evidence expires
before promotion, rerun validation and approve the new run/artifact.

Existing local checks under `web/` remain: `npm ci`, `npm run build`, `npm test`,
`npm run package:verify`, `npm run package:consumer`, and
`npm run package:preflight -- --revision <full-sha>`. Set `PACKAGE_REQUIRE_CLEAN=1`
for release packing (PowerShell: `$env:PACKAGE_REQUIRE_CLEAN = '1'`). Local packs
and PR artifacts alone are not promotable; select a successful main-push candidate.
See [the consumer guide](../packaging/README.md).

## 3. Publish only after explicit owner approval

Present the exact version, source, run/artifact IDs, SHA-256/npm integrity and
proposed dist-tag for approval. A dry run does not check npm credentials or
authorize publication. Sign in locally with modern npm; confirm identity and
scope/package access. Only after approval run the same command without dry-run:

```powershell
# STOP: only after approval of this exact candidate and public dist-tag.
python scripts/release.py publish --version $version --commit $commit --run-id $run --artifact-id $artifact --dist-tag latest --out artifacts/release-verification
```

The command re-downloads/revalidates the candidate, checks GitHub/npm conflicts
and tag policy, verifies npm identity/write access and publishes only the retained
`.tgz`, with lifecycle scripts disabled and explicit public access/registry.
**npm becomes public first.** It then creates/verifies the exact Git tag, resumes
a matching GitHub draft, uploads only absent assets, verifies all uploaded bytes,
publishes the Release and runs verification. No tag moves or asset overwrites.
An npm upload is public even if a subsequent GitHub step fails.
Real publication and verification require a clean checkout of the selected source,
so the bridge and consumer build definitions also match that commit. Verification
reports are retained under the chosen `--out`, not temporary publication staging.

## 4. Verify publication and recover

Verification makes no public writes and reads published assets independently of
Actions retention. Preserve its final report:

```powershell
python scripts/release.py verify --version $version --commit $commit --run-id $run --artifact-id $artifact --dist-tag latest --out artifacts/release-verification
```

It downloads fresh GitHub assets, checks inventory/SHA256SUMS, expected source/tag/
candidate identity, compiler/lock, release status/latest and npm version/dist-tag/
integrity. Missing registry state gets four attempts, ten seconds apart; conflicting
bytes fail immediately. The existing clean consumer installs from the actual
registry, regenerates a contract and tests Node/Chromium/Firefox/WebKit RPC shapes,
deadlines and cancellation. Original candidate reports remain intact; registry
reports use a separate directory (`candidate/` and `registry/` under `--out`).
`VERIFICATION.json` appears only after success;
link/attach it to the release when reporting completion.

- **Interrupted publication:** rerun publish with the same approved inputs. Matching
  npm bytes/assets are reused. The selected npm dist-tag can be restored only after
  backward-movement checks. Conflicting bytes/commits/candidate/policy stop the tool.
- **Failed draft upload:** inspect and, if appropriate, manually remove only that
  failed unpublished asset, then resume. No automatic clobber/delete is performed.
- **Verification failure:** preserve candidate/completed steps/failure output; retry
  verify into a fresh directory after resolving propagation or environment issues.
- **Bad public release:** correct bytes under a new reviewed version. Dist-tag
  correction/deprecation requires explicit owner direction; no automatic rollback,
  unpublish, tag movement or checksum bypass is provided.

Failure tests: `python -m unittest discover -s scripts -p 'test_*.py'`. CI runs
these plus `release.py check`. Preparation/dry-runs/tests need no npm credentials.

## Tested support and compatibility

| Component | Tested boundary |
| --- | --- |
| Package | ESM-only `.`, `/raw`, `/codegen`; declarations, resolvable maps/sources and MIT/third-party notices; no CommonJS or CDN/IIFE distribution |
| Node | Engine floor >=24; installed consumer uses Node 24/Linux; other versions/operating systems need their own validation |
| Browser | Playwright 1.63.0/Linux: Chromium 153.0.8010.12, Firefox 155.0, WebKit 26.6; not every Chrome/Safari product or older engine |
| Platform | ES2022 browser bundler; native WebSocket, Web Streams, TextEncoder/TextDecoder, AbortController |
| Dependencies | Exact Protobuf-ES 2.15.0 and Connect 2.2.0; wider bounds require deliberate tests |
| Generation | Protoc 31.1, Protobuf-ES generator 2.15.0, TypeScript 5.9.3; proto/lock/descriptors from the same input |
| Reviewed compiler/adapters | Proto Contract `6d028e3632e7b027f380cbc6b0449dfe4ca4b6c1`, shared with reciprocal CI; each candidate records the actual source pin |
| Wire | `grpc-tunnel.v1`: HTTP/2 prior-knowledge bytes in binary WebSocket; no gRPC-Web or session resumption |

Version 0.2.0 intentionally requires generated contracts on the default entry;
see [migration](../web/README.md#migration-from-01x),
[runtime graph](../web/contracts/runtime-graph-v1.md) and [wire design](DESIGN.md).
Contract metadata does not authenticate a tunnel or enforce server policy by
itself. The installed-artifact fixture's ordinary Python backend does not enforce
contracts; reciprocal native/actual-package CI remains the strict-server gate.

Recovery does not replay RPCs. Explicit REFUSED_STREAM/GOAWAY exclusion permits
one transparent retry before commitment; unknown post-dispatch socket loss does
not. Configured retries require application replay-safe semantics and remain
bounded by commitment/deadline/cancellation/buffer rules. Read the full
[retry contract](../web/RETRIES.md). No blind replay or exactly-once guarantee is added.

Candidate reports record actual archive and installed-entry sizes, toolchains and
bundle profile: browser ESM/ES2022, dependencies included, all public exports
preserved, minification, gzip level 9. Fixture costs are separate. These are
observations, not budgets or proof of cross-machine byte reproducibility. Git
snapshots/hashes are build evidence, not signed SLSA attestations.
