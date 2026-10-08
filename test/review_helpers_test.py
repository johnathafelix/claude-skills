import importlib.util
import fcntl
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

PLUGIN = pathlib.Path(__file__).resolve().parents[1] / 'plugins/claude-skills'
REQUESTS = PLUGIN / 'skills/review-requests/scripts'
sys.path.insert(0, str(REQUESTS))


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


state = module('review_state', PLUGIN / 'skills/review-pr/scripts/review-state.py')
coverage = module('review_coverage', PLUGIN / 'skills/review-pr/scripts/coverage.py')
loop = module('review_loop', REQUESTS / 'loop.py')
relay = module('review_slack', REQUESTS / 'slack.py')
runner = module('review_runner', REQUESTS / 'run-review.py')


class Repository(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        self.git('init', '-q')
        self.git('config', 'user.email', 'review@example.invalid')
        self.git('config', 'user.name', 'Review Test')
        (self.repo / 'a.py').write_text('x = 0\n')
        self.base = self.commit()
        (self.repo / 'a.py').write_text('x = 1\ny = 2\n')
        self.head = self.commit()
        self.url = 'https://github.com/example/repo/pull/1'
        self.cache = self.root / 'cache'

    def git(self, *args):
        return subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', str(self.repo), *args], check=True, capture_output=True, text=True, timeout=10).stdout.strip()

    def commit(self):
        self.git('add', '.')
        self.git('commit', '-qm', 'test')
        return self.git('rev-parse', 'HEAD')

    def prepare(self, **kwargs):
        return state.prepare(self.repo, self.base, self.git('rev-parse', 'HEAD'), self.url, self.cache, **kwargs)

    def remember(self, findings=None):
        context = self.prepare()
        result = state.save(context, {'complete': True, 'findings': findings or []})
        self.assertTrue(result['saved'])
        return context

    def test_incremental_scope_keeps_prior_claims_and_translates_lines(self):
        finding = {'file': 'a.py', 'line': 2, 'severity': 'issue', 'verified': True, 'description': 'bad y', 'suggestedFix': 'guard y'}
        self.remember([finding])
        (self.repo / 'a.py').write_text('# moved\nx = 1\ny = 2\n')
        (self.repo / 'b.py').write_text('print(x)\n')
        self.commit()
        context = self.prepare()
        self.assertTrue(context['incremental'])
        self.assertEqual(context['deltaFiles'], ['a.py', 'b.py'])
        self.assertEqual(context['priorFindings'][0]['line'], 3)
        self.assertNotIn('needsRelocation', context['priorFindings'][0])

    def test_modified_prior_anchor_requires_relocation(self):
        self.remember([{'file': 'a.py', 'line': 2, 'verified': True}])
        (self.repo / 'a.py').write_text('x = 1\ny = 3\n')
        self.commit()
        self.assertTrue(self.prepare()['priorFindings'][0]['needsRelocation'])

    def test_unchanged_prior_file_remains_in_scope(self):
        self.remember([{'file': 'a.py', 'line': 2, 'verified': True}])
        (self.repo / 'b.py').write_text('b = 2\n')
        self.commit()
        context = self.prepare()
        self.assertEqual(context['deltaFiles'], ['b.py'])
        self.assertEqual(context['reviewFiles'], ['a.py', 'b.py'])

    def test_changed_base_and_policy_disable_incremental_reuse(self):
        self.remember()
        self.assertFalse(self.prepare(profile='thorough')['incremental'])
        self.assertFalse(state.prepare(self.repo, self.head, self.head, self.url, self.cache)['incremental'])
        self.assertFalse(self.prepare(full=True)['incremental'])

    def test_full_scope_and_profile_changes_keep_prior_claims_for_challenge(self):
        finding = {'file': 'a.py', 'line': 2, 'verified': True, 'description': 'old claim', 'priorIds': ['old:one', 'old:two']}
        self.remember([finding])
        for options in ({'full': True}, {'profile': 'thorough'}):
            context = self.prepare(**options)
            self.assertFalse(context['incremental'])
            self.assertEqual(len(context['priorFindings']), 1)
            self.assertEqual(context['expectedPriorIds'], ['old:one', 'old:two'])
            self.assertFalse(state.save(context, {'complete': True, 'findings': []})['saved'])
            ids = context['expectedPriorIds']
            self.assertTrue(state.save(context, {'complete': True, 'findings': [], 'priorClaims': {'expected': ids, 'challenged': ids, 'missing': []}})['saved'])
            self.remember([finding])

    def test_lockfile_and_config_changes_force_full_scope(self):
        self.remember()
        (self.repo / 'package-lock.json').write_text('{}')
        self.commit()
        context = self.prepare()
        self.assertFalse(context['incremental'])
        self.assertEqual(context['reviewFiles'], context['files'])

    def test_rewritten_history_falls_back_to_full(self):
        self.remember()
        self.git('reset', '--hard', self.base)
        (self.repo / 'b.py').write_text('b = 3\n')
        self.commit()
        self.assertFalse(self.prepare()['incremental'])

    def test_renames_and_deletions_are_not_lost(self):
        self.remember([{'file': 'a.py', 'line': 2, 'verified': True}])
        (self.repo / 'a.py').rename(self.repo / 'renamed.py')
        self.commit()
        context = self.prepare()
        self.assertEqual(context['deltaFiles'], ['a.py', 'renamed.py'])
        self.assertTrue(context['priorFindings'][0]['needsRelocation'])

    def test_incomplete_report_preserves_complete_cache(self):
        context = self.remember()
        before = pathlib.Path(context['cachePath']).read_text()
        for gap in ('unchallenged', 'rejectedFindings'):
            result = state.save(context, {'complete': True, 'findings': [], gap: [{'file': 'a.py'}]})
            self.assertFalse(result['saved'])
            self.assertEqual(pathlib.Path(context['cachePath']).read_text(), before)
        with self.assertRaises(ValueError):
            state.save(context, {'complete': True, 'findings': [{'file': 'a.py', 'verified': False}]})

    def test_wrong_checked_out_head_is_rejected(self):
        with self.assertRaises(ValueError):
            state.prepare(self.repo, self.base, self.base, self.url, self.cache)

    def test_malformed_cache_falls_back_to_full_scope(self):
        context = self.remember()
        path = pathlib.Path(context['cachePath'])
        cached = json.loads(path.read_text())
        cached['findings'] = [{'file': 'a.py', 'line': 'unknown', 'verified': True}]
        path.write_text(json.dumps(cached))
        self.assertFalse(self.prepare()['incremental'])
        cached['findings'] = []
        cached['url'] = 'https://github.com/example/repo/pull/2'
        path.write_text(json.dumps(cached))
        self.assertFalse(self.prepare()['incremental'])

    def test_dirty_worktree_and_competing_reviews_cannot_replace_cache(self):
        context = self.remember()
        (self.repo / 'a.py').write_text('not the pinned head\n')
        with self.assertRaises(ValueError):
            self.prepare()
        with self.assertRaises(ValueError):
            state.save(context, {'complete': True, 'findings': []})
        self.git('checkout', '--', 'a.py')
        (self.repo / 'b.py').write_text('b = 3\n')
        self.commit()
        newer = self.prepare()
        self.assertTrue(state.save(newer, {'complete': True, 'findings': []})['saved'])
        self.git('checkout', '--detach', self.head)
        self.assertFalse(state.save(context, {'complete': True, 'findings': []})['saved'])

    def test_coverage_reuse_invalidates_on_untracked_sources_and_env_files(self):
        out = self.root / 'out'
        report = out / 'coverage.json'
        command = [sys.executable, '-c', 'import pathlib,sys;pathlib.Path(sys.argv[1]).write_text("{}")', str(report)]
        with patch.object(coverage, 'runtime', return_value={'versions': {}}):
            first = coverage.coverage(self.repo, self.repo, out, report, command, self.cache)
            second = coverage.coverage(self.repo, self.repo, out, report, command, self.cache)
            self.assertFalse(first['reused'])
            self.assertTrue(second['reused'])
            (self.repo / 'new_test.py').write_text('assert x == 1\n')
            self.assertFalse(coverage.coverage(self.repo, self.repo, out, report, command, self.cache)['reused'])
            (self.repo / '.env.test').write_text('MODE=test\n')
            self.assertFalse(coverage.coverage(self.repo, self.repo, out, report, command, self.cache)['reused'])

    def test_failed_coverage_never_reuses_a_leftover_report(self):
        out = self.root / 'out'
        out.mkdir()
        report = out / 'coverage.json'
        report.write_text('{}')
        with patch.object(coverage, 'runtime', return_value={'versions': {}}):
            result = coverage.coverage(self.repo, self.repo, out, report, [sys.executable, '-c', 'raise SystemExit(1)'], self.cache)
        self.assertEqual(result['status'], 'unverified')
        self.assertFalse(report.exists())

    def test_unknown_inputs_and_symlinks_disable_coverage_reuse(self):
        out = self.root / 'out'
        report = out / 'coverage.json'
        command = [sys.executable, '-c', 'import pathlib,sys;pathlib.Path(sys.argv[1]).write_text("{}")', str(report)]
        with patch.object(coverage, 'runtime', return_value={'versions': {}}):
            coverage.coverage(self.repo, self.repo, out, report, command, self.cache)
            result = coverage.coverage(self.repo, self.repo, out, report, command, self.cache, use_cache=False)
            self.assertFalse(result['reused'])
            (self.repo / 'linked.py').symlink_to(self.repo / 'a.py')
            for _ in range(2):
                self.assertFalse(coverage.coverage(self.repo, self.repo, out, report, command, self.cache)['reused'])

    def test_dependency_cache_is_copied_and_lifecycle_hooks_disable_reuse(self):
        (self.repo / 'package.json').write_text('{}')
        (self.repo / 'package-lock.json').write_text('{}')
        self.commit()
        out = self.root / 'out'
        out.mkdir()
        def install(*args):
            mods = self.repo / 'node_modules'
            mods.mkdir()
            (mods / 'dependency.txt').write_text('original')
            return {'status': 'ok'}
        with patch.object(coverage, 'run', side_effect=install) as run:
            first = coverage.dependencies(self.repo, self.cache, out, 10, coverage.tracked(self.repo), {'versions': {}})
            import shutil
            shutil.rmtree(self.repo / 'node_modules')
            second = coverage.dependencies(self.repo, self.cache, out, 10, coverage.tracked(self.repo), {'versions': {}})
            self.assertEqual(run.call_count, 1)
            self.assertTrue(second['reused'])
            (self.repo / 'node_modules/dependency.txt').write_text('mutated')
            self.assertEqual((self.cache / 'dependencies' / first['key'] / 'node_modules/dependency.txt').read_text(), 'original')
            shutil.rmtree(self.repo / 'node_modules')
            (self.repo / 'package.json').write_text('{"scripts":{"prepare":"compile-source"}}')
            self.assertFalse(coverage.dependencies(self.repo, self.cache, out, 10, coverage.tracked(self.repo), {'versions': {}})['cacheable'])

    def test_cached_json_coverage_paths_rebase_into_new_worktree(self):
        source = self.root / 'cached-report'
        source.write_text(json.dumps({'/old/worktree/a.py': {'path': '/old/worktree/a.py', 's': {'1': 2}}}))
        dest = self.root / 'report.json'
        coverage.restore_report(source, dest, '/old/worktree', self.repo)
        content = json.loads(dest.read_text())
        self.assertEqual(content[str(self.repo / 'a.py')]['path'], str(self.repo / 'a.py'))

    def test_timeout_stops_command_and_returns_gap(self):
        result = coverage.run([sys.executable, '-c', 'import time;time.sleep(10)'], self.repo, self.root / 'command.log', 0.05)
        self.assertEqual(result['status'], 'timeout')

    def test_passing_report_missing_changed_sources_is_not_cached(self):
        out = self.root / 'out'
        report = out / 'coverage.json'
        (self.repo / 'b.py').write_text('y = 1\n')
        command = [sys.executable, '-c', 'import pathlib,sys,json;pathlib.Path(sys.argv[1]).write_text(json.dumps({sys.argv[2]: {"s":{"0":1}}}))', str(report), str(self.repo / 'a.py')]
        with patch.object(coverage, 'runtime', return_value={'versions': {}}):
            result = coverage.coverage(self.repo, self.repo, out, report, command, self.cache, expected_sources=['a.py', 'b.py'])
        self.assertEqual(result['status'], 'unverified')
        self.assertEqual(result['stage'], 'scope')
        self.assertEqual(result['missingSources'], [str((self.repo / 'b.py').resolve())])
        self.assertFalse((self.cache / 'coverage').exists())

    def test_scoped_json_lcov_and_go_reports_match_expected_paths(self):
        expected = [self.repo / 'a.py']
        report = self.root / 'coverage.json'
        report.write_text(json.dumps({str(expected[0]): {'s': {'0': 0}}}))
        self.assertEqual(coverage.report_scope(report, expected, self.repo, self.repo), [])
        report = self.root / 'lcov.info'
        report.write_text('SF:a.py\nDA:1,0\nend_of_record\n')
        self.assertEqual(coverage.report_scope(report, expected, self.repo, self.repo), [])
        (self.repo / 'go.mod').write_text('module example.org/service\n')
        report = self.root / 'coverage.out'
        report.write_text('mode: atomic\nexample.org/service/a.py:1.1,2.1 1 0\n')
        self.assertEqual(coverage.report_scope(report, expected, self.repo, self.repo), [])


    def test_duplicate_coverage_command_preserves_the_active_status(self):
        out = self.root / 'out'
        out.mkdir()
        active = {'status': 'running', 'stage': 'coverage'}
        (out / 'result.json').write_text(json.dumps(active))
        with (out / '.coverage.lock').open('w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = subprocess.run([sys.executable, str(PLUGIN / 'skills/review-pr/scripts/coverage.py'),
                '--repo', str(self.repo), '--cwd', str(self.repo), '--out', str(out),
                '--report', str(out / 'coverage.json'), '--', sys.executable, '-c', 'raise AssertionError("duplicate ran")'],
                check=True, capture_output=True, text=True, timeout=5)
        self.assertEqual(json.loads(result.stdout)['status'], 'unverified')
        self.assertIn('already running', result.stdout)
        self.assertEqual(json.loads((out / 'result.json').read_text()), active)


class Watch(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = pathlib.Path(self.temp.name)
        change = patch.object(loop, 'STATE', self.state)
        change.start()
        self.addCleanup(change.stop)
        self.config = {'channel': 'C_TEST', 'me': 'U_ME', 'interval': 5, 'max_idle_interval': 30, 'repos_dir': self.state}
        (self.state / 'since').write_text('100.000000')

    def message(self, *numbers):
        return {'ts': '200.000001', 'user': 'U_AUTHOR', 'pr_urls': [f'https://github.com/example/repo/pull/{n}' for n in numbers]}

    def test_full_queue_advances_cursor_and_persists_requests_across_restart(self):
        for n in (1, 2):
            (self.state / f'{n}.tmp').touch()
        reply = {'status': 'ok', 'messages': [self.message(1, 2, 3)], 'me': '', 'usage': {}}
        with patch.object(loop.slack, 'read', return_value=reply) as read, patch.object(loop.Pass, 'watch_prs', return_value=[]):
            loop.Pass(self.config).run()
            self.assertEqual(len(list(self.state.glob('*.queued'))), 3)
            self.assertNotEqual((self.state / 'since').read_text(), '100.000000')
            loop.Pass(self.config).run(read_channel=False, watch=False)
            self.assertEqual(read.call_count, 1)

    def test_multi_pr_acknowledgement_survives_queue_draining(self):
        current = loop.Pass(self.config)
        current.discover([self.message(1, 2)], 'U_ME')
        calls = []
        def start(ts, url, flag, ack, label):
            calls.append(ack)
            (self.state / f'{ts}.url').write_text(url)
            (self.state / f'{ts}.queued').unlink()
            return True
        with patch.object(current, 'start', side_effect=start):
            current.start_queued(1)
        other = loop.Pass(self.config)
        with patch.object(other, 'start', side_effect=start):
            other.start_queued(1)
        self.assertEqual(calls, ['reviewing...', None])

    def test_failed_read_does_not_advance_cursor(self):
        with patch.object(loop.slack, 'read', return_value={'status': 'error', 'detail': 'missing page', 'usage': {}}):
            loop.Pass(self.config).run(read_channel=True, watch=False)
        self.assertEqual((self.state / 'since').read_text(), '100.000000')

    def test_completions_post_without_waiting_for_channel_read(self):
        key = '200.000001'
        (self.state / f'{key}.url').write_text('https://github.com/example/repo/pull/1')
        (self.state / f'{key}.out').write_text(json.dumps({'result': 'Done\nREVIEW_RESULT: approved'}))
        def post(channel, posts, cwd):
            return {'status': 'ok', 'sent': [{'id': p['id']} for p in posts], 'usage': {}}
        with patch.object(loop.slack, 'read') as read, patch.object(loop.slack, 'post', side_effect=post) as sent:
            loop.Pass(self.config).run(read_channel=False, watch=False)
            self.assertEqual(read.call_count, 0)
            self.assertEqual(sent.call_count, 1)
        self.assertFalse((self.state / f'{key}.out').exists())
        self.assertEqual((self.state / f'{key}.reviews').read_text().strip(), '1')

    def test_completed_reply_precedes_a_due_channel_read(self):
        key = '200.000001'
        (self.state / f'{key}.url').write_text('https://github.com/example/repo/pull/1')
        (self.state / f'{key}.out').write_text(json.dumps({'result': 'REVIEW_RESULT: approved'}))
        order = []
        def post(channel, posts, cwd):
            order.append('post')
            return {'status': 'ok', 'sent': [{'id': p['id']} for p in posts], 'usage': {}}
        def read(*args):
            order.append('read')
            return {'status': 'ok', 'messages': [], 'usage': {}}
        with patch.object(loop.slack, 'read', side_effect=read), patch.object(loop.slack, 'post', side_effect=post):
            loop.Pass(self.config).run(read_channel=True, watch=False)
        self.assertEqual(order, ['post', 'read'])

    def test_connector_retry_counts_both_attempts(self):
        replies = [{'status': 'unavailable', 'usage': {'input_tokens': 3}}, {'status': 'ok', 'usage': {'input_tokens': 5}}]
        current = loop.Pass(self.config)
        with patch.object(loop.time, 'sleep'):
            current.slack(lambda *args: replies.pop(0))
        self.assertEqual(current.tokens, 8)

    def test_idle_backoff_is_capped_and_activity_resets_it(self):
        schedule = loop.Schedule(self.config)
        current = loop.Pass(self.config)
        current.slack_read = True
        for now, expected in [(0, 600), (600, 1200), (1800, 1800), (3600, 1800)]:
            schedule.advance(now, current, True, False)
            self.assertEqual(schedule.delay, expected)
        current.slack_read = False
        schedule.advance(3601, current, False, True)
        self.assertEqual(schedule.delay, 300)
        self.assertLessEqual(schedule.read_at, 3901)

    def test_post_failure_is_bounded_and_other_posts_can_complete(self):
        loop.queue_reply('200.000001', 'done')
        with patch.object(loop.slack, 'post', return_value={'status': 'error', 'detail': 'not confirmed', 'sent': [], 'usage': {}}):
            current = loop.Pass(self.config)
            current.post_outbox()
            current.post_outbox()
        self.assertEqual(len(list((self.state / 'outbox/failed').glob('*.json'))), 1)
        self.assertEqual(len(list((self.state / 'outbox').glob('*.json'))), 0)

    def test_large_outbox_is_drained_in_bounded_connector_batches(self):
        for n in range(loop.MAX_POST_BATCH + 2):
            loop.queue_reply(str(n), 'done')
        def post(channel, posts, cwd):
            self.assertLessEqual(len(posts), loop.MAX_POST_BATCH)
            return {'status': 'ok', 'sent': [{'id': p['id']} for p in posts], 'usage': {}}
        with patch.object(loop.slack, 'post', side_effect=post) as sent:
            current = loop.Pass(self.config)
            current.post_outbox()
            self.assertEqual(len(list((self.state / 'outbox').glob('*.json'))), 2)
            current.post_outbox()
            self.assertEqual(sent.call_count, 2)


class Connector(unittest.TestCase):
    def events(self, cursor=None, requested_cursor=None):
        args = {'channel_id': 'C_TEST', 'oldest': '100.0'}
        if requested_cursor:
            args['cursor'] = requested_cursor
        page = {'messages': '=== Message from Teammate (UAUTHOR) at now ===\nMessage TS: 200.000001\nhttps://github.com/example/repo/pull/1\n', 'pagination_info': f'cursor: `{cursor}`' if cursor else ''}
        return [{'message': {'content': [{'type': 'tool_use', 'id': 'call-' + str(requested_cursor), 'name': relay.READ, 'input': args}]}}, {'message': {'content': [{'type': 'tool_result', 'tool_use_id': 'call-' + str(requested_cursor), 'content': json.dumps(page)}]}}]

    def test_missing_pagination_page_is_an_error(self):
        with self.assertRaises(relay.IncompleteRead):
            relay.read_messages(self.events(cursor='next'), 'C_TEST', '100.0')
        result = relay.read_messages(self.events(cursor='next') + self.events(requested_cursor='next'), 'C_TEST', '100.0')
        self.assertEqual(len(result), 1)

    def test_unfurled_links_are_not_new_requests(self):
        text = '=== Message from Teammate (UAUTHOR) at now ===\nMessage TS: 200.000001\nhttps://github.com/example/repo/pull/1\nApp notification from Bot\nhttps://github.com/example/repo/pull/2'
        self.assertEqual(list(relay.parse_messages(text))[0]['pr_urls'], ['https://github.com/example/repo/pull/1'])

    def test_read_relay_cannot_post_and_keeps_connector_access(self):
        result = types.SimpleNamespace(stdout=json.dumps({'type': 'result', 'structured_output': {'status': 'ok'}, 'usage': {}}), stderr='')
        with patch.object(relay.subprocess, 'run', return_value=result) as run:
            relay.run(relay.READ, relay.READ_SCHEMA, 'read', '/tmp')
        argv = run.call_args.args[0]
        allowed = argv[argv.index('--allowedTools') + 1]
        self.assertIn(relay.READ, allowed)
        self.assertNotIn(relay.SEND, allowed)
        self.assertNotIn('--strict-mcp-config', argv)
        self.assertEqual(argv[argv.index('--model') + 1], 'haiku')
        self.assertEqual(run.call_args.kwargs['env']['CLAUDE_CODE_DISABLE_AUTO_MEMORY'], '1')

    def test_coordinator_loads_current_plugin_and_accepts_review_options(self):
        with patch.dict(os.environ, {'REVIEW_PR_COORDINATOR_MODEL': 'sonnet'}):
            argv = runner.command(['https://github.com/example/repo/pull/1', 'standard', 'medium', 'approve', 'full'])
        self.assertEqual(argv[argv.index('--model') + 1], 'sonnet')
        self.assertEqual(argv[argv.index('--plugin-dir') + 1], str(PLUGIN))
        with self.assertRaises(ValueError):
            runner.command(['https://github.com/example/repo/pull/1', 'fast', 'thorough'])

    def test_missing_structured_reply_still_reports_connector_usage(self):
        result = types.SimpleNamespace(stdout=json.dumps({'type': 'result', 'result': 'incomplete', 'usage': {'input_tokens': 7}}), stderr='')
        with patch.object(relay.subprocess, 'run', return_value=result):
            reply = relay.run(relay.READ, relay.READ_SCHEMA, 'read', '/tmp')
        self.assertEqual(reply['status'], 'error')
        self.assertEqual(reply['usage']['input_tokens'], 7)

    def test_completion_marker_must_be_a_valid_final_line(self):
        self.assertFalse(runner.finished('Waiting for REVIEW_RESULT: approved'))
        self.assertFalse(runner.finished('REVIEW_RESULT: approved\nStill working'))
        self.assertFalse(runner.finished('REVIEW_RESULT: nonsense'))
        self.assertTrue(runner.finished('Done\nREVIEW_RESULT: approved\n'))


if __name__ == '__main__':
    unittest.main()
