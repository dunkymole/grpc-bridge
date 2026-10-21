"""Release operations. Only publish without --dry-run writes GitHub or npm."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
from urllib.error import HTTPError
from urllib.request import urlopen
import zipfile

ROOT = Path(__file__).resolve().parents[1]
REPO = 'dunkymole/grpc-bridge'
PACKAGE = '@dunkymole/grpc-bridge'
REGISTRY = 'https://registry.npmjs.org'
WORKFLOW = '.github/workflows/ci.yml'
JOBS = {'test', 'Test this bridge revision with reviewed Proto Contract'}
REPORTS = {'package-audit.json', 'consumer-node.json', 'consumer-browsers.json', 'release-preflight.json'}
LIMIT = 64 << 20


def require(condition, message):
    if not condition:
        raise ValueError(message)


def version(value):
    require(re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', value),
            'version must be canonical MAJOR.MINOR.PATCH (as in proto-contract)')
    require(all(int(n) <= 2147483647 for n in value.split('.')), 'version component too large')
    return value


def sha(data):
    return hashlib.sha256(data).hexdigest()


def run(*args, cwd=ROOT, binary=False, env=None, stream=False):
    # Resolve npm.cmd explicitly on Windows without using a shell-built command.
    command = [str(a) for a in args]
    command[0] = shutil.which(command[0]) or command[0]
    result = subprocess.run(command, cwd=cwd, env=env, capture_output=not stream)
    if result.returncode:
        detail = '' if stream else result.stderr.decode(errors='replace')[-2000:]
        raise RuntimeError(f'{args[0]} failed: {detail}')
    if not stream:
        return result.stdout if binary else result.stdout.decode('utf-8').strip()


def api(path, optional=False, binary=False, method='GET', fields=None):
    args = ['gh', 'api', f'repos/{REPO}/{path}', '--method', method]
    if binary and path.startswith('releases/assets/'):
        args += ['-H', 'Accept: application/octet-stream']
    for key, value in (fields or {}).items():
        args += ['-f', f'{key}={value}']
    try:
        result = run(*args, binary=binary)
    except RuntimeError as error:
        if optional and method == 'GET' and '(HTTP 404)' in str(error):
            return None
        raise
    return result if binary else json.loads(result)


def source_file(commit, name):
    return run('gh', 'api', f'repos/{REPO}/contents/{name}?ref={commit}',
               '-H', 'Accept: application/vnd.github.raw+json', binary=True)


def registry(suffix='', optional=False):
    try:
        with urlopen(f'{REGISTRY}/@dunkymole%2fgrpc-bridge{suffix}', timeout=30) as response:
            data = response.read(LIMIT + 1)
            require(len(data) <= LIMIT, 'registry response too large')
            return json.loads(data)
    except HTTPError as error:
        if optional and error.code == 404:
            return None
        raise


def check_versions(root=ROOT):
    package = json.loads((root / 'web/package.json').read_text(encoding='utf-8'))
    lock = json.loads((root / 'web/package-lock.json').read_text(encoding='utf-8'))
    v = version(package['version'])
    require(package['name'] == lock['name'] == lock['packages']['']['name'] == PACKAGE, 'package name drift')
    require(lock['version'] == lock['packages']['']['version'] == v, 'package-lock version drift')
    examples = re.findall(r'/path/to/dunkymole-grpc-bridge-([\d.]+)\.tgz',
                          (root / 'web/README.md').read_text(encoding='utf-8'))
    require(examples == [v], 'current installation example version drift')
    return v


def tag_target(v):
    ref = api(f'git/ref/tags/v{v}', optional=True)
    if ref is None:
        return None
    obj = ref['object']
    for _ in range(5):
        if obj['type'] == 'commit':
            return obj['sha']
        require(obj['type'] == 'tag', 'tag does not target a commit')
        obj = api(f'git/tags/{obj["sha"]}')['object']
    raise ValueError('excessively nested tag')


def absent(v):
    require(tag_target(v) is None, 'version tag already exists')
    require(find_release(v) is None, 'release already exists')
    require(registry(f'/{v}', optional=True) is None, 'npm version already exists')


def clean_source(commit):
    require(re.fullmatch('[0-9a-f]{40}', commit), 'provide the full expected source commit')
    require(run('git', 'rev-parse', 'HEAD') == commit, 'wrong source commit')
    require(not run('git', 'status', '--porcelain'), 'source checkout is dirty')


def bump(v, commit, summary, dry_run=False):
    version(v)
    current = check_versions()
    clean_source(commit)
    require(tuple(map(int, v.split('.'))) > tuple(map(int, current.split('.'))), 'version must increase')
    require(summary.strip() and '\n' not in summary and '\r' not in summary, 'provide a one-line summary')
    absent(v)
    edits = {}
    for name in ('web/package.json', 'web/package-lock.json'):
        path = ROOT / name
        data = json.loads(path.read_text(encoding='utf-8'))
        data['version'] = v
        if 'packages' in data:
            data['packages']['']['version'] = v
        edits[path] = json.dumps(data, indent=2) + '\n'
    path = ROOT / 'web/README.md'
    edits[path] = path.read_text(encoding='utf-8').replace(f'/path/to/dunkymole-grpc-bridge-{current}.tgz',
                                          f'/path/to/dunkymole-grpc-bridge-{v}.tgz')
    path = ROOT / 'CHANGELOG.md'
    text = path.read_text(encoding='utf-8')
    require(f'\n## {v}\n' not in text, 'changelog entry already exists')
    require(text.count('## Unreleased\n') == 1, 'missing or duplicate Unreleased heading')
    edits[path] = text.replace('## Unreleased\n', f'## Unreleased\n\n## {v}\n\n- {summary.strip()}\n', 1)
    if not dry_run:
        for path, text in edits.items():
            path.write_text(text, encoding='utf-8', newline='\n')
        check_versions()
    return {'dryRun': dry_run, 'from': current, 'version': v,
            'files': [p.relative_to(ROOT).as_posix() for p in edits], 'publicWrites': []}


def validate_ci(info, jobs, artifact, v, commit, run_id, artifact_id):
    version(v)
    require(re.fullmatch('[0-9a-f]{40}', commit), 'provide the full expected source commit')
    require(info['id'] == run_id and info['repository']['full_name'] == REPO, 'wrong run/repository')
    require(info['head_sha'] == commit and info['head_branch'] == 'main' and info['event'] == 'push',
            'candidate must be from the selected main push commit')
    require(info['path'] == WORKFLOW and info['status'] == 'completed' and info['conclusion'] == 'success',
            'candidate CI has not completed successfully')
    require(len(jobs) == len(JOBS) and {j['name'] for j in jobs} == JOBS, 'missing/extra CI jobs')
    require(all(j['conclusion'] == 'success' and j['head_sha'] == commit and
                j['run_attempt'] == info['run_attempt'] for j in jobs), 'failed/stale CI jobs')
    require(artifact['id'] == artifact_id and not artifact['expired'] and artifact['size_in_bytes'] <= LIMIT,
            'wrong, expired or oversized artifact')
    require(artifact['name'] == f'bridge-validation-{run_id}-{info["run_attempt"]}', 'wrong artifact attempt/name')
    require(artifact['workflow_run']['id'] == run_id and artifact['workflow_run']['head_sha'] == commit,
            'artifact belongs to another run/commit')
    require(re.fullmatch(r'sha256:[0-9a-f]{64}', artifact.get('digest') or ''), 'artifact digest missing')


def ci_candidate(v, commit, run_id, artifact_id):
    info = api(f'actions/runs/{run_id}')
    jobs = api(f'actions/runs/{run_id}/attempts/{info["run_attempt"]}/jobs?per_page=100')
    require(jobs['total_count'] == len(jobs['jobs']), 'paginated CI jobs are unsupported')
    artifact = api(f'actions/artifacts/{artifact_id}')
    validate_ci(info, jobs['jobs'], artifact, v, commit, run_id, artifact_id)
    return info, artifact


def preflight(directory, commit, compiler):
    env = {**os.environ, 'PACKAGE_INSTALL_SOURCE': 'local'}
    run('node', 'web/scripts/release-preflight.mjs', '--revision', commit,
        '--compiler-revision', compiler, '--directory', directory, '--read-only', env=env)


def extract_candidate(data, destination):
    # Inspect every ZIP entry, extract only the package evidence; no extractall.
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        require(len({p.filename for p in entries}) == len(entries), 'duplicate artifact entries')
        require(sum(p.file_size for p in entries) <= LIMIT, 'expanded artifact too large')
        package = {}
        for entry in entries:
            name = entry.filename
            require(not name.startswith('/') and '\\' not in name and '..' not in name.split('/'), 'unsafe artifact path')
            if name.startswith('web/test-results/package/') and not entry.is_dir():
                leaf = name.removeprefix('web/test-results/package/')
                require('/' not in leaf and re.fullmatch(r'[\w.-]+', leaf), 'nested/unsafe package evidence')
                require((entry.external_attr >> 16) & 0o170000 in (0, 0o100000), 'artifact links are forbidden')
                package[leaf] = archive.read(entry)
        audit = json.loads(package['package-audit.json'])
        require(re.fullmatch(r'dunkymole-grpc-bridge-[\w.-]+\.tgz', audit['artifact']), 'unsafe tarball name')
        require(set(package) == REPORTS | {audit['artifact']}, 'missing/extra candidate files')
        for name, content in package.items():
            (destination / name).write_bytes(content)
        return audit


def notes(v, commit, run_id, artifact_id, package):
    dependencies = ', '.join(f'{name} {bound}' for name, bound in sorted(package['dependencies'].items()))
    return f'''# gRPC Bridge v{v}

Install: `npm install {PACKAGE}@{v}` (Node {package['engines']['node']}, ESM).
Dependencies: {dependencies}; generated contracts required.
Package/API contract/tunnel versions are independent. Wire: `grpc-tunnel.v1`.
Retry/recovery semantics are unchanged; see the source-tagged compatibility guide.

Source: {commit}
Validation: https://github.com/{REPO}/actions/runs/{run_id}
Artifact: {artifact_id}
Compatibility: https://github.com/{REPO}/blob/{commit}/docs/RELEASING.md
Changes: https://github.com/{REPO}/blob/{commit}/CHANGELOG.md
Verify downloads: `sha256sum --check SHA256SUMS` or the documented `verify` command.
The bridge remains source/Compose distributed; no binary/container registry release.
Checksums identify the prepared bytes, not an independent signature or a
cross-machine reproducible-build guarantee.
'''


def prepare(v, commit, run_id, artifact_id, out):
    require(not out.exists(), 'output already exists; choose a fresh directory')
    info, artifact = ci_candidate(v, commit, run_id, artifact_id)
    data = api(f'actions/artifacts/{artifact_id}/zip', binary=True)
    require(len(data) <= LIMIT and artifact['digest'] == 'sha256:' + sha(data), 'artifact ZIP digest mismatch')
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=out.parent) as temp:
        stage = Path(temp) / 'candidate'
        stage.mkdir()
        audit = extract_candidate(data, stage)
        require(audit['version'] == v and audit['name'] == PACKAGE, 'candidate version/name mismatch')
        require(audit['ci']['repository'] == REPO and str(audit['ci']['runId']) == str(run_id) and
                audit['ci']['event'] == 'push' and audit['ci']['ref'] == 'refs/heads/main', 'audit CI identity mismatch')
        require(audit['source']['tree'] == api(f'git/commits/{commit}')['tree']['sha'], 'source tree mismatch')
        workflow = source_file(commit, WORKFLOW).decode()
        compiler = re.search(r'PROTO_CONTRACT_REVIEWED_REF:\s*([a-f0-9]{40})', workflow)[1]
        package = json.loads(source_file(commit, 'web/package.json'))
        require(package['version'] == v, 'source version mismatch')
        require(audit['packageLockSha256'] == sha(source_file(commit, 'web/package-lock.json')), 'source dependency lock mismatch')
        preflight(stage, commit, compiler)
        candidate = {'format': 1, 'repository': REPO, 'version': v, 'sourceRevision': commit,
                     'sourceTree': audit['source']['tree'], 'compilerRevision': compiler,
                     'workflowRunId': run_id, 'workflowAttempt': info['run_attempt'], 'artifactId': artifact_id,
                     'artifactDigest': artifact['digest'], 'toolchain': audit['toolchain']}
        (stage / 'candidate.json').write_text(json.dumps(candidate, indent=2) + '\n', encoding='utf-8', newline='\n')
        (stage / 'RELEASE_NOTES.md').write_text(notes(v, commit, run_id, artifact_id, package), encoding='utf-8', newline='\n')
        sums = ''.join(f'{sha(p.read_bytes())}  {p.name}\n' for p in sorted(stage.iterdir()))
        (stage / 'SHA256SUMS').write_text(sums, encoding='utf-8', newline='\n')
        require(not out.exists(), 'output appeared during preparation; choose a fresh directory')
        stage.rename(out)
    return candidate


def files_at(directory):
    files = {}
    for p in directory.iterdir():
        require(p.is_file() and not p.is_symlink(), 'candidate has directories/links')
        files[p.name] = p.read_bytes()
    return files


def find_release(v):
    release = api(f'releases/tags/v{v}', optional=True)
    if release is not None:
        return release
    # GitHub's by-tag endpoint omits unpublished drafts. Enumerate authenticated
    # releases, including all pages, before deciding that creation is necessary.
    pages = json.loads(run('gh', 'api', f'repos/{REPO}/releases?per_page=100', '--paginate', '--slurp'))
    matches = [release for page in pages for release in page if release['tag_name'] == f'v{v}']
    require(len(matches) <= 1, 'multiple releases have the selected tag; inspect before resuming')
    return matches[0] if matches else None


def verify_bundle(directory, v, commit, run_id, artifact_id):
    files = files_at(directory)
    audit = json.loads(files['package-audit.json'])
    candidate = json.loads(files['candidate.json'])
    require(set(files) == REPORTS | {audit['artifact'], 'candidate.json', 'RELEASE_NOTES.md', 'SHA256SUMS'},
            'release inventory differs')
    sums = {}
    for line in files['SHA256SUMS'].decode().splitlines():
        require(re.fullmatch(r'[0-9a-f]{64}  [\w.-]+', line), 'invalid checksum entry')
        digest, name = line.split('  ')
        require(name not in sums, 'duplicate checksum entry')
        sums[name] = digest
    require(set(sums) == set(files) - {'SHA256SUMS'}, 'checksum inventory differs')
    require(all(sha(files[name]) == digest for name, digest in sums.items()), 'release checksum mismatch')
    require(candidate['format'] == 1 and candidate['repository'] == REPO and candidate['version'] == v and
            candidate['sourceRevision'] == commit and candidate['workflowRunId'] == run_id and
            candidate['artifactId'] == artifact_id, 'candidate identity differs')
    require(audit['version'] == v and audit['name'] == PACKAGE, 'package identity differs')
    require(candidate['sourceTree'] == audit['source']['tree'] == api(f'git/commits/{commit}')['tree']['sha'],
            'published source tree differs')
    workflow = source_file(commit, WORKFLOW).decode()
    compiler = re.search(r'PROTO_CONTRACT_REVIEWED_REF:\s*([a-f0-9]{40})', workflow)[1]
    require(candidate['compilerRevision'] == compiler, 'published compiler revision differs')
    require(audit['packageLockSha256'] == sha(source_file(commit, 'web/package-lock.json')), 'published lock differs')
    require(json.loads(source_file(commit, 'web/package.json'))['version'] == v, 'published source version differs')
    preflight(directory, commit, compiler)
    return candidate, audit


def release_state(v, commit, body, files, dist_tag):
    target = tag_target(v)
    require(target is None or target == commit, 'existing tag references another commit; never move it')
    release = find_release(v)
    if release is not None:
        require(target == commit and release['body'] == body and release['prerelease'] == (dist_tag != 'latest'),
                'existing release belongs to another candidate/policy')
        assets = release['assets']
        require(len({a['name'] for a in assets}) == len(assets), 'duplicate release assets')
        for asset in assets:
            require(asset['name'] in files and asset['state'] == 'uploaded' and
                    asset['size'] == len(files[asset['name']]), 'conflicting/incomplete release asset')
            content = api(f'releases/assets/{asset["id"]}', binary=True)
            require(content == files[asset['name']], 'uploaded bytes differ; never overwrite')
        if not release['draft']:
            require({a['name'] for a in assets} == set(files), 'public release inventory differs')
    return target, release


def check_registry(v, audit):
    published = registry(f'/{v}', optional=True)
    if published is not None:
        require(published['name'] == PACKAGE and published['version'] == v and
                published['dist']['integrity'] == audit['integrity'], 'npm version conflicts with candidate')
    return published


def tag_policy(v, dist_tag):
    require(dist_tag in ('latest', 'next'), 'select explicit --dist-tag latest or next')
    package = registry(optional=True)
    current = (package or {}).get('dist-tags', {}).get(dist_tag)
    if current and current != v:
        require(tuple(map(int, version(current).split('.'))) < tuple(map(int, v.split('.'))),
                'refusing to move npm dist-tag backwards')
    if dist_tag == 'latest':
        latest = api('releases/latest', optional=True)
        if latest and latest['tag_name'] != f'v{v}':
            require(tuple(map(int, version(latest['tag_name'].removeprefix('v')).split('.'))) < tuple(map(int, v.split('.'))),
                    'refusing to move GitHub latest backwards')
    return current


def npm(*args, stream=False):
    return run('npm', *args, f'--registry={REGISTRY}', cwd=Path(tempfile.gettempdir()), stream=stream)


def publish(v, commit, run_id, artifact_id, dist_tag, dry_run=False, out=None):
    require(dist_tag in ('latest', 'next'), 'select explicit --dist-tag latest or next')
    if not dry_run:
        require(out is not None and not out.exists(), 'provide --out with a fresh verification directory')
        clean_source(commit)
    with tempfile.TemporaryDirectory() as temp:
        directory = Path(temp) / 'candidate'
        candidate = prepare(v, commit, run_id, artifact_id, directory)
        files = files_at(directory)
        audit = json.loads(files['package-audit.json'])
        body = f'<!-- grpc-bridge-candidate:{run_id}:{artifact_id}:{commit}:{dist_tag} -->\n' + files['RELEASE_NOTES.md'].decode()
        target, release = release_state(v, commit, body, files, dist_tag)
        published = check_registry(v, audit)
        current = tag_policy(v, dist_tag)
        if dry_run:
            return {**candidate, 'dryRun': True, 'distTag': dist_tag, 'publicWrites': [],
                    'next': 'After approval: verify npm access, upload exact tarball, resume GitHub draft, verify registry consumer.'}
        identity = npm('whoami').strip()
        permissions = json.loads(npm('access', 'list', 'packages', identity, '--json'))
        require(identity == 'dunkymole' or permissions.get(PACKAGE) == 'read-write', 'npm scope/package write permission unverified')
        # All candidate/conflict/access checks precede the first public write.
        if published is None:
            npm('publish', str(directory / audit['artifact']), '--ignore-scripts', '--access=public',
                f'--tag={dist_tag}', stream=True)
        elif current != v:
            # Resume only the selected version after policy checks, never blindly retag.
            npm('dist-tag', 'add', f'{PACKAGE}@{v}', dist_tag, stream=True)
        wait_registry(v, audit, dist_tag)
        if target is None:
            api('git/refs', method='POST', fields={'ref': f'refs/tags/v{v}', 'sha': commit})
        if release is None:
            note = Path(temp) / 'notes.md'
            note.write_text(body, encoding='utf-8', newline='\n')
            run('gh', 'release', 'create', f'v{v}', '--repo', REPO, '--verify-tag', '--draft', '--latest=false',
                f'--prerelease={str(dist_tag != "latest").lower()}', '--title', f'gRPC Bridge v{v}', '--notes-file', note)
        _, release = release_state(v, commit, body, files, dist_tag)
        uploaded = {a['name'] for a in release['assets']}
        for name in sorted(set(files) - uploaded):
            run('gh', 'release', 'upload', f'v{v}', directory / name, '--repo', REPO)
        _, release = release_state(v, commit, body, files, dist_tag)
        require({a['name'] for a in release['assets']} == set(files), 'incomplete draft inventory')
        tag_policy(v, dist_tag)
        if release['draft']:
            run('gh', 'release', 'edit', f'v{v}', '--repo', REPO, '--draft=false',
                f'--latest={str(dist_tag == "latest").lower()}')
        report = verify(v, commit, run_id, artifact_id, dist_tag, out)
        return {'operation': 'publish', 'verificationReport': str(out / 'VERIFICATION.json'),
                'status': report['status'], 'releaseUrl': report['releaseUrl']}


def wait_registry(v, audit, dist_tag):
    for attempt in range(20):
        published = check_registry(v, audit)
        package = registry(optional=True)
        if published and (package or {}).get('dist-tags', {}).get(dist_tag) == v:
            return
        if attempt < 19:
            time.sleep(15)
    raise ValueError('npm version/dist-tag did not propagate; preserve candidate and retry verification')


def verify(v, commit, run_id, artifact_id, dist_tag, out):
    version(v)
    require(re.fullmatch('[0-9a-f]{40}', commit), 'provide the full expected source commit')
    require(dist_tag in ('latest', 'next'), 'select explicit --dist-tag latest or next')
    require(not out.exists(), 'verification output already exists')
    clean_source(commit)  # The bridge/consumer Dockerfiles must be from the selected source.
    with tempfile.TemporaryDirectory() as temp:
        directory = Path(temp)
        require(tag_target(v) == commit, 'published tag source differs')
        release = api(f'releases/tags/v{v}')
        require(not release['draft'] and release['prerelease'] == (dist_tag != 'latest'), 'release state differs')
        assets = release['assets']
        require(len({a['name'] for a in assets}) == len(assets) and
                sum(a['size'] for a in assets) <= LIMIT, 'duplicate/oversized published assets')
        for asset in assets:
            require(re.fullmatch(r'[\w.-]+', asset['name']) and asset['state'] == 'uploaded', 'unsafe/incomplete asset')
            data = api(f'releases/assets/{asset["id"]}', binary=True)
            require(len(data) == asset['size'], 'downloaded asset size differs')
            (directory / asset['name']).write_bytes(data)
        candidate, audit = verify_bundle(directory, v, commit, run_id, artifact_id)
        files = files_at(directory)
        body = f'<!-- grpc-bridge-candidate:{run_id}:{artifact_id}:{commit}:{dist_tag} -->\n' + files['RELEASE_NOTES.md'].decode()
        require(release['body'] == body, 'release candidate marker/notes differ')
        if dist_tag == 'latest':
            require(api('releases/latest')['tag_name'] == f'v{v}', 'GitHub latest differs')
        wait_registry(v, audit, dist_tag)
        out.mkdir(parents=True)
        # Original evidence remains untouched; registry reports use a separate directory.
        original = out / 'candidate'
        original.mkdir()
        evidence = out / 'registry'
        evidence.mkdir()
        for name, content in files.items():
            (original / name).write_bytes(content)
            if name in REPORTS or name == audit['artifact']:
                (evidence / name).write_bytes(content)
        env = {**os.environ, 'PACKAGE_INSTALL_SOURCE': 'registry', 'PACKAGE_EVIDENCE_DIR': str(evidence.resolve())}
        run('node', 'web/scripts/test-package-consumer.mjs', env=env, stream=True)
        run('node', 'web/scripts/release-preflight.mjs', '--revision', commit, '--compiler-revision', candidate['compilerRevision'],
            '--directory', evidence, env=env)
        report = {**candidate, 'status': 'PASS', 'distTag': dist_tag, 'releaseUrl': release['html_url'],
                  'registryConsumer': 'Node, Chromium, Firefox, WebKit', 'publicWrites': []}
        (out / 'VERIFICATION.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8', newline='\n')
        return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('check')
    p = sub.add_parser('bump')
    p.add_argument('--version', required=True)
    p.add_argument('--commit', required=True)
    p.add_argument('--summary', required=True)
    p.add_argument('--dry-run', action='store_true')
    for name in ('prepare', 'publish', 'verify'):
        p = sub.add_parser(name)
        p.add_argument('--version', required=True)
        p.add_argument('--commit', required=True)
        p.add_argument('--run-id', required=True, type=int)
        p.add_argument('--artifact-id', required=True, type=int)
        if name in ('prepare', 'verify'):
            p.add_argument('--out', required=True, type=Path)
        if name in ('publish', 'verify'):
            p.add_argument('--dist-tag', required=True, choices=['latest', 'next'])
        if name == 'publish':
            p.add_argument('--dry-run', action='store_true')
            p.add_argument('--out', type=Path, help='fresh verification output; required for real publication')
    args = parser.parse_args()
    if args.command == 'check':
        result = {'version': check_versions(), 'consistent': True}
    elif args.command == 'bump':
        result = bump(args.version, args.commit, args.summary, args.dry_run)
    else:
        common = (args.version, args.commit, args.run_id, args.artifact_id)
        if args.command == 'prepare':
            result = prepare(*common, args.out)
        elif args.command == 'publish':
            result = publish(*common, args.dist_tag, args.dry_run, args.out)
        else:
            result = verify(*common, args.dist_tag, args.out)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, RuntimeError, KeyError, OSError, TypeError, IndexError) as error:
        raise SystemExit(f'release: {error}')
