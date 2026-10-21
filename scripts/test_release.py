"""Release failure/recovery tests; no network, credentials or public writes."""
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('release', Path(__file__).with_name('release.py'))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
COMMIT, TREE, COMPILER = 'a' * 40, 'b' * 40, 'c' * 40
V, RUN, ARTIFACT = '0.3.0', 123, 456


def ci():
    info = {'id': RUN, 'repository': {'full_name': r.REPO}, 'head_sha': COMMIT,
            'head_branch': 'main', 'event': 'push', 'path': r.WORKFLOW,
            'status': 'completed', 'conclusion': 'success', 'run_attempt': 2}
    jobs = [{'name': n, 'conclusion': 'success', 'head_sha': COMMIT, 'run_attempt': 2} for n in r.JOBS]
    artifact = {'id': ARTIFACT, 'expired': False, 'size_in_bytes': 100,
                'name': f'bridge-validation-{RUN}-2', 'digest': 'sha256:' + 'd' * 64,
                'workflow_run': {'id': RUN, 'head_sha': COMMIT}}
    return info, jobs, artifact


def evidence():
    audit = {'artifact': 'dunkymole-grpc-bridge-0.3.0-abc.tgz', 'name': r.PACKAGE,
             'version': V, 'integrity': 'sha512-tested', 'source': {'tree': TREE},
             'packageLockSha256': r.sha(b'lock'), 'toolchain': {},
             'ci': {'repository': r.REPO, 'runId': str(RUN), 'event': 'push', 'ref': 'refs/heads/main'}}
    files = {name: b'{}' for name in r.REPORTS}
    files['package-audit.json'] = json.dumps(audit).encode()
    files[audit['artifact']] = b'tarball'
    return files


def archive(files):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w') as z:
        for name, content in files.items():
            z.writestr('web/test-results/package/' + name, content)
    return stream.getvalue()


class ReleaseTests(unittest.TestCase):
    def test_versions_and_counted_install_example(self):
        for v in ['01.2.0', '0.2', '1.0.0-rc.1', '../1.0.0', '1.0.2147483648']:
            with self.assertRaises(ValueError):
                r.version(v)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'web').mkdir()
            package = {'name': r.PACKAGE, 'version': V}
            (root / 'web/package.json').write_text(json.dumps(package))
            lock = {**package, 'packages': {'': package.copy()}}
            (root / 'web/package-lock.json').write_text(json.dumps(lock))
            (root / 'web/README.md').write_text(f'/path/to/dunkymole-grpc-bridge-{V}.tgz')
            self.assertEqual(r.check_versions(root), V)
            lock['packages']['']['version'] = '0.2.0'
            (root / 'web/package-lock.json').write_text(json.dumps(lock))
            with self.assertRaisesRegex(ValueError, 'version drift'):
                r.check_versions(root)

    def test_bump_dry_run_scoped_updates_and_history(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'web').mkdir()
            for name in ('package.json', 'package-lock.json', 'README.md'):
                (root / 'web' / name).write_bytes((r.ROOT / 'web' / name).read_bytes())
            (root / 'CHANGELOG.md').write_text('# Changes\n\n## Unreleased\n\n## 0.2.0\n\nHistorical entry.\n')
            before = {p: p.read_bytes() for p in (root / 'web').iterdir()}
            original = r.check_versions
            with patch.object(r, 'ROOT', root), patch.object(r, 'absent') as absent, patch.object(r, 'run') as run:
                run.side_effect = [COMMIT, '', COMMIT, '']
                # Explicit root avoids the function's definition-time default.
                with patch.object(r, 'check_versions', side_effect=lambda: original(root)):
                    r.bump(V, COMMIT, 'Changes', True)
                    self.assertEqual(before, {p: p.read_bytes() for p in before})
                    r.bump(V, COMMIT, 'Changes')
                self.assertEqual(absent.call_count, 2)
            self.assertEqual(original(root), V)
            readme = (root / 'web/README.md').read_text()
            self.assertIn('package version `0.2.0`', readme)  # historical breaking boundary
            self.assertIn('grpc-bridge-0.3.0.tgz', readme)
            self.assertIn('## 0.2.0\n\nHistorical entry.', (root / 'CHANGELOG.md').read_text())

    def test_dirty_wrong_source_and_conflicts_stop_before_edits(self):
        for outputs in [[TREE], [COMMIT, ' M web/package.json']]:
            with patch.object(r, 'run', side_effect=outputs), patch.object(r, 'absent') as absent:
                with self.assertRaises(ValueError):
                    r.bump(V, COMMIT, 'Changes')
                absent.assert_not_called()
        for tag, release, registry in [(TREE, None, None), (None, {}, None), (None, None, {})]:
            with patch.object(r, 'tag_target', return_value=tag), patch.object(r, 'find_release', return_value=release), \
                    patch.object(r, 'registry', return_value=registry):
                with self.assertRaises(ValueError):
                    r.absent(V)

    def test_candidate_requires_same_successful_main_run_attempt_and_both_jobs(self):
        r.validate_ci(*ci(), V, COMMIT, RUN, ARTIFACT)
        changes = [lambda i, j, a: i.update(head_sha=TREE),
                   lambda i, j, a: i.update(head_branch='feature'),
                   lambda i, j, a: i.update(event='pull_request'),
                   lambda i, j, a: i.update(path='other.yml'),
                   lambda i, j, a: i.update(conclusion='failure'),
                   lambda i, j, a: j.pop(),
                   lambda i, j, a: j[0].update(conclusion='failure'),
                   lambda i, j, a: j[0].update(run_attempt=1),
                   lambda i, j, a: a.update(id=999),
                   lambda i, j, a: a.update(expired=True),
                   lambda i, j, a: a.update(name=f'bridge-validation-{RUN}-1'),
                   lambda i, j, a: a.update(digest=None),
                   lambda i, j, a: a['workflow_run'].update(id=999)]
        for change in changes:
            args = ci()
            change(*args)
            with self.assertRaises(ValueError):
                r.validate_ci(*args, V, COMMIT, RUN, ARTIFACT)

    def test_zip_inventory_missing_extra_paths_links_and_duplicates(self):
        for change in [lambda f: f.pop('consumer-node.json'),
                       lambda f: f.update({'extra.txt': b'extra'}),
                       lambda f: f.update({'../escape': b'escape'})]:
            files = evidence()
            change(files)
            with tempfile.TemporaryDirectory() as temp:
                with self.assertRaises((ValueError, KeyError)):
                    r.extract_candidate(archive(files), Path(temp))
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, 'w') as z:
            entry = zipfile.ZipInfo('web/test-results/package/package-audit.json')
            entry.external_attr = 0o120777 << 16
            z.writestr(entry, b'{}')
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaisesRegex(ValueError, 'links'):
                r.extract_candidate(stream.getvalue(), Path(temp))

    def test_prepare_binds_source_lock_digest_and_preflight(self):
        def execute(modify=None):
            info, jobs, artifact = ci()
            data = archive(evidence())
            artifact['digest'] = 'sha256:' + r.sha(data)
            if modify:
                modify(artifact)
            def api(path, **kwargs):
                return {'tree': {'sha': TREE}} if path.startswith('git/commits') else data
            def source(commit, name):
                return {r.WORKFLOW: f'PROTO_CONTRACT_REVIEWED_REF: {COMPILER}'.encode(),
                        'web/package.json': json.dumps({'version': V, 'dependencies': {'@connectrpc/connect': '2.2.0'},
                                                        'engines': {'node': '>=24'}}).encode(),
                        'web/package-lock.json': b'lock'}[name]
            with tempfile.TemporaryDirectory() as temp, patch.object(r, 'ci_candidate', return_value=(info, artifact)), \
                    patch.object(r, 'api', side_effect=api), patch.object(r, 'source_file', side_effect=source), \
                    patch.object(r, 'preflight') as preflight:
                out = Path(temp) / 'candidate'
                candidate = r.prepare(V, COMMIT, RUN, ARTIFACT, out)
                preflight.assert_called_once()
                self.assertEqual(candidate['workflowAttempt'], 2)
                r.verify_bundle(out, V, COMMIT, RUN, ARTIFACT)
                (out / 'consumer-node.json').write_bytes(b'tampered')
                with self.assertRaisesRegex(ValueError, 'checksum'):
                    r.verify_bundle(out, V, COMMIT, RUN, ARTIFACT)
        execute()
        with self.assertRaisesRegex(ValueError, 'digest'):
            execute(lambda a: a.update(digest='sha256:' + '0' * 64))

    def test_release_resume_never_overwrites_conflicting_assets_or_tags(self):
        files = {'package.tgz': b'bytes'}
        release = {'draft': True, 'body': 'notes', 'prerelease': False,
                   'assets': [{'id': 1, 'name': 'package.tgz', 'size': 5, 'state': 'uploaded'}]}
        with patch.object(r, 'tag_target', return_value=COMMIT), patch.object(r, 'api', side_effect=[release, b'bytes']):
            self.assertEqual(r.release_state(V, COMMIT, 'notes', files, 'latest')[1], release)
        with patch.object(r, 'tag_target', return_value=COMMIT), patch.object(r, 'api', side_effect=[release, b'other']):
            with self.assertRaisesRegex(ValueError, 'never overwrite'):
                r.release_state(V, COMMIT, 'notes', files, 'latest')
        with patch.object(r, 'tag_target', return_value=TREE):
            with self.assertRaisesRegex(ValueError, 'never move'):
                r.release_state(V, COMMIT, 'notes', files, 'latest')

    def test_draft_discovery_checks_all_pages_after_by_tag_404(self):
        draft = {'id': 1234, 'tag_name': f'v{V}', 'draft': True}
        pages = [[{'tag_name': 'v0.1.0'}], [draft]]
        with patch.object(r, 'api', return_value=None), patch.object(r, 'run', return_value=json.dumps(pages)) as run:
            self.assertEqual(r.find_release(V), draft)
            self.assertIn('--paginate', run.call_args.args)
            self.assertIn('--slurp', run.call_args.args)
        with patch.object(r, 'api', return_value=None), patch.object(r, 'run', return_value=json.dumps([[]])):
            self.assertIsNone(r.find_release(V))
        with patch.object(r, 'api', return_value=None), patch.object(r, 'run', return_value=json.dumps([[draft], [draft]])):
            with self.assertRaisesRegex(ValueError, 'multiple releases'):
                r.find_release(V)
        with patch.object(r, 'api', return_value=draft), patch.object(r, 'run') as run:
            self.assertEqual(r.find_release(V), draft)
            run.assert_not_called()
    def test_registry_conflicts_and_backwards_tag_fail(self):
        with patch.object(r, 'registry', return_value={'name': r.PACKAGE, 'version': V, 'dist': {'integrity': 'wrong'}}):
            with self.assertRaisesRegex(ValueError, 'conflicts'):
                r.check_registry(V, {'integrity': 'expected'})
        with patch.object(r, 'registry', return_value={'dist-tags': {'latest': '0.4.0'}}):
            with self.assertRaisesRegex(ValueError, 'backwards'):
                r.tag_policy(V, 'latest')

    def test_publish_dry_run_never_checks_credentials_or_writes(self):
        def prepared(v, commit, run, artifact, out):
            out.mkdir()
            for name, content in evidence().items():
                (out / name).write_bytes(content)
            (out / 'RELEASE_NOTES.md').write_text('notes')
            return {'version': v}
        with patch.object(r, 'prepare', side_effect=prepared), patch.object(r, 'release_state', return_value=(None, None)), \
                patch.object(r, 'check_registry', return_value=None), patch.object(r, 'tag_policy', return_value=None), \
                patch.object(r, 'npm') as npm, patch.object(r, 'api') as api:
            result = r.publish(V, COMMIT, RUN, ARTIFACT, 'latest', True)
            self.assertEqual(result['publicWrites'], [])
            npm.assert_not_called()
            api.assert_not_called()

    def test_resume_skips_already_published_npm_and_uploaded_assets(self):
        def prepared(v, commit, run, artifact, out):
            out.mkdir()
            (out / 'package-audit.json').write_text(json.dumps({'artifact': 'package.tgz', 'integrity': 'expected'}))
            (out / 'package.tgz').write_bytes(b'approved')
            (out / 'RELEASE_NOTES.md').write_text('notes')
            return {}
        release = {'draft': True, 'assets': [{'name': n} for n in ['package-audit.json', 'package.tgz', 'RELEASE_NOTES.md']]}
        with patch.object(r, 'prepare', side_effect=prepared), patch.object(r, 'release_state', return_value=(COMMIT, release)), \
                patch.object(r, 'check_registry', return_value={}), patch.object(r, 'tag_policy', return_value=V), \
                patch.object(r, 'npm', side_effect=['dunkymole', '{}']) as npm, patch.object(r, 'wait_registry'), \
                patch.object(r, 'verify', return_value={'status': 'PASS', 'releaseUrl': 'https://example.test/release'}), patch.object(r, 'clean_source'), \
                patch.object(r, 'run') as run, patch.object(r, 'api') as api, tempfile.TemporaryDirectory() as temp:
            r.publish(V, COMMIT, RUN, ARTIFACT, 'latest', out=Path(temp) / 'verified')
            self.assertEqual(npm.call_count, 2)  # identity/access reads only
            api.assert_not_called()
            self.assertEqual(run.call_count, 1)
            self.assertIn('--draft=false', run.call_args.args)

    def test_new_publication_uses_retained_bytes_and_no_build_hooks(self):
        retained = {}
        def prepared(v, commit, run, artifact, out):
            out.mkdir()
            for name, content in evidence().items():
                (out / name).write_bytes(content)
            (out / 'RELEASE_NOTES.md').write_text('notes')
            retained.update(r.files_at(out))
            return {}
        def npm(*args, **kwargs):
            if args[0] == 'whoami':
                return 'dunkymole'
            if args[0] == 'access':
                return '{}'
            self.assertEqual(args[0], 'publish')
            self.assertEqual(Path(args[1]).read_bytes(), b'tarball')
            self.assertIn('--ignore-scripts', args)
            self.assertIn('--access=public', args)
        def state(*args):
            count = state.count
            state.count += 1
            if count == 0:
                return None, None
            assets = [] if count == 1 else [{'name': n} for n in retained]
            return COMMIT, {'draft': True, 'assets': assets}
        state.count = 0
        with patch.object(r, 'prepare', side_effect=prepared), patch.object(r, 'release_state', side_effect=state), \
                patch.object(r, 'check_registry', return_value=None), patch.object(r, 'tag_policy', return_value=None), \
                patch.object(r, 'npm', side_effect=npm) as publisher, patch.object(r, 'wait_registry'), \
                patch.object(r, 'verify', return_value={'status': 'PASS', 'releaseUrl': 'https://example.test'}), \
                patch.object(r, 'clean_source'), patch.object(r, 'run') as run, patch.object(r, 'api') as api, \
                tempfile.TemporaryDirectory() as temp:
            r.publish(V, COMMIT, RUN, ARTIFACT, 'latest', out=Path(temp) / 'verification')
            self.assertEqual(publisher.call_count, 3)
            api.assert_called_once_with('git/refs', method='POST', fields={'ref': f'refs/tags/v{V}', 'sha': COMMIT})
            uploads = [c.args for c in run.call_args_list if c.args[:3] == ('gh', 'release', 'upload')]
            self.assertEqual(len(uploads), len(retained))

    def test_access_failure_precedes_any_public_write(self):
        def prepared(v, commit, run, artifact, out):
            out.mkdir()
            (out / 'package-audit.json').write_text('{}')
            (out / 'RELEASE_NOTES.md').write_text('notes')
            return {}
        with patch.object(r, 'prepare', side_effect=prepared), patch.object(r, 'release_state', return_value=(None, None)), \
                patch.object(r, 'check_registry', return_value=None), patch.object(r, 'tag_policy', return_value=None), \
                patch.object(r, 'npm', side_effect=['other-user', '{}']) as npm, patch.object(r, 'clean_source'), \
                patch.object(r, 'api') as api, patch.object(r, 'run') as run, tempfile.TemporaryDirectory() as temp:
            with self.assertRaisesRegex(ValueError, 'permission'):
                r.publish(V, COMMIT, RUN, ARTIFACT, 'latest', out=Path(temp) / 'verification')
            self.assertEqual(npm.call_count, 2)
            api.assert_not_called()
            run.assert_not_called()

    def test_postflight_failure_keeps_original_evidence_and_no_success_report(self):
        files = evidence()
        files['RELEASE_NOTES.md'] = b'notes'
        body = f'<!-- grpc-bridge-candidate:{RUN}:{ARTIFACT}:{COMMIT}:latest -->\nnotes'
        assets = [{'id': i, 'name': n, 'size': len(b), 'state': 'uploaded'} for i, (n, b) in enumerate(files.items())]
        release = {'draft': False, 'prerelease': False, 'body': body, 'assets': assets}
        def api(path, **kwargs):
            if path == 'releases/latest':
                return {'tag_name': f'v{V}'}
            if path.startswith('releases/tags/'):
                return release
            return files[assets[int(path.split('/')[-1])]['name']]
        def failed_consumer(*args, **kwargs):
            self.assertEqual(kwargs['env']['PACKAGE_INSTALL_SOURCE'], 'registry')
            directory = Path(kwargs['env']['PACKAGE_EVIDENCE_DIR'])
            (directory / 'consumer-node.json').write_text('partial registry result')
            raise RuntimeError('browser failed')
        candidate = {'compilerRevision': COMPILER}
        audit = json.loads(files['package-audit.json'])
        with patch.object(r, 'clean_source'), patch.object(r, 'tag_target', return_value=COMMIT), \
                patch.object(r, 'api', side_effect=api), patch.object(r, 'wait_registry'), \
                patch.object(r, 'verify_bundle', return_value=(candidate, audit)), patch.object(r, 'run', side_effect=failed_consumer), \
                tempfile.TemporaryDirectory() as temp:
            out = Path(temp) / 'verified'
            with self.assertRaisesRegex(RuntimeError, 'browser failed'):
                r.verify(V, COMMIT, RUN, ARTIFACT, 'latest', out)
            self.assertFalse((out / 'VERIFICATION.json').exists())
            self.assertEqual((out / 'registry/package-audit.json').read_bytes(), files['package-audit.json'])
            self.assertEqual((out / 'candidate/consumer-node.json').read_bytes(), files['consumer-node.json'])

    def test_registry_propagation_bounded_and_mismatch_not_retried(self):
        with patch.object(r, 'check_registry', return_value=None), patch.object(r, 'registry', return_value=None), \
                patch.object(r.time, 'sleep') as sleep:
            with self.assertRaisesRegex(ValueError, 'propagate'):
                r.wait_registry(V, {}, 'latest')
            self.assertEqual(sleep.call_count, 19)
        with patch.object(r, 'check_registry', side_effect=ValueError('conflicting bytes')), patch.object(r.time, 'sleep') as sleep:
            with self.assertRaisesRegex(ValueError, 'conflicting bytes'):
                r.wait_registry(V, {}, 'latest')
            sleep.assert_not_called()


if __name__ == '__main__':
    unittest.main()
