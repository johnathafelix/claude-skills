import json
import os
import pathlib
import stat
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

PLUGIN = pathlib.Path(__file__).resolve().parents[1] / 'plugins/claude-skills'
SCRIPTS = PLUGIN / 'skills/prod-monitor/scripts'
sys.path.insert(0, str(SCRIPTS))

import common  # noqa: E402
import gcp  # noqa: E402
import loop  # noqa: E402
import pipeline  # noqa: E402
import session  # noqa: E402


def entry(stamp, severity, message, service='api', namespace='payments'):
    return {
        'timestamp': stamp,
        'severity': severity,
        'textPayload': message,
        'resource': {'type': 'k8s_container', 'labels': {'namespace_name': namespace, 'container_name': service, 'pod_name': f'{service}-7d9f8c6b5-ab12c'}},
    }


ENTRIES = [
    entry('2026-10-20T10:00:01Z', 'ERROR', 'nil pointer dereference in handler order=123'),
    entry('2026-10-20T10:00:05Z', 'ERROR', 'nil pointer dereference in handler order=456'),
    entry('2026-10-20T10:01:00Z', 'WARNING', 'retrying upstream call attempt 2', service='worker'),
    {
        'timestamp': '2026-10-20T10:02:00Z',
        'severity': 'ERROR',
        'jsonPayload': {'message': 'timeout calling 10.0.0.1:8080 req 7f3a9c2b1d4e'},
        'resource': {'type': 'k8s_container', 'labels': {'namespace_name': 'payments', 'pod_name': 'checkout-5c8d9f7b6-xk2lq'}},
    },
]


def base_env(root):
    repos = root / 'repos'
    repos.mkdir(exist_ok=True)

    return {
        'PROD_MONITOR_GCP_PROJECT': 'prod-project',
        'PROD_MONITOR_NAMESPACES': 'payments, orders',
        'PROD_MONITOR_REPOS_DIR': str(repos),
        'PROD_MONITOR_LINEAR_TEAM': 'ENG',
        'PROD_MONITOR_LINEAR_PROJECT': 'Reliability',
        'PROD_MONITOR_LINEAR_LABELS': 'prod-monitor,bug',
        'PROD_MONITOR_WORKDIR': str(root / 'work'),
    }


class Config(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.env = base_env(self.root)

    def test_defaults_and_lists(self):
        config = common.load_config(self.env)
        self.assertEqual(config['namespaces'], ['payments', 'orders'])
        self.assertEqual(config['linear_labels'], ['prod-monitor', 'bug'])
        self.assertEqual(config['interval'], 3600)
        self.assertEqual(config['log_limit'], 5000)
        self.assertEqual(config['max_parallel'], 4)
        self.assertFalse(config['open_prs'])
        self.assertEqual((config['triage_model'], config['triage_effort']), ('opus', 'medium'))
        self.assertEqual((config['findings_model'], config['findings_effort']), ('opus', 'high'))
        self.assertEqual((config['challenge_model'], config['challenge_effort']), ('opus', 'high'))
        self.assertEqual(config['linear_model'], 'sonnet')

    def test_interval_forms(self):
        self.assertEqual(common.parse_interval('30m'), 1800)
        self.assertEqual(common.parse_interval('2h'), 7200)
        for bad in ('', '1d', 'hourly', '0m', '5'):
            with self.assertRaises(common.Stop):
                common.parse_interval(bad)

    def test_missing_values_stop(self):
        for name in ('PROD_MONITOR_GCP_PROJECT', 'PROD_MONITOR_NAMESPACES', 'PROD_MONITOR_LINEAR_LABELS', 'PROD_MONITOR_WORKDIR'):
            env = {**self.env, name: ' '}
            with self.assertRaises(common.Stop, msg=name):
                common.load_config(env)

        with self.assertRaises(common.Stop):
            common.load_config({**self.env, 'PROD_MONITOR_REPOS_DIR': str(self.root / 'nope')})

        with self.assertRaises(common.Stop):
            common.load_config({**self.env, 'PROD_MONITOR_FINDINGS_EFFORT': 'extreme'})

        with self.assertRaises(common.Stop):
            common.load_config({**self.env, 'PROD_MONITOR_MIN_SEVERITY': 'LOUD'})


class Windows(unittest.TestCase):
    def test_window_without_cursor_is_one_interval(self):
        now = 1_000_000.0
        self.assertEqual(common.window_for(None, now, 3600), (now - 3600, now))

    def test_window_continues_from_cursor(self):
        now = 1_000_000.0
        self.assertEqual(common.window_for(now - 5000, now, 3600), (now - 5000, now))

    def test_gap_over_a_day_is_not_caught_up(self):
        now = 1_000_000.0
        self.assertEqual(common.window_for(now - 3 * 86400, now, 3600), (now - 3600, now))
        self.assertEqual(common.window_for(now + 10, now, 3600), (now - 3600, now))

    def test_due(self):
        self.assertTrue(common.is_due(None, 100, 60))
        self.assertFalse(common.is_due(100, 150, 60))
        self.assertTrue(common.is_due(100, 160, 60))

    def test_iso_round_trip(self):
        self.assertEqual(common.from_iso(common.iso(1_700_000_000)), 1_700_000_000)


class Runs(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.work = pathlib.Path(self.temp.name)

    def test_run_id_format_and_parse(self):
        now = time.mktime((2026, 10, 20, 14, 5, 0, 0, 0, -1))
        self.assertEqual(common.run_id_for(now), '20-10-2026-14-05')
        self.assertEqual(common.day_for(now), '20-10-2026')
        self.assertEqual(common.run_started('20-10-2026-14-05'), now)
        self.assertIsNone(common.run_started('tickets'))
        self.assertIsNone(common.run_started('99-99-2026-14-05'))

    def test_incomplete_runs_oldest_first_and_skips_finished(self):
        for name in ('20-10-2026-14-00', '19-10-2026-23-00', '20-10-2026-13-00', '20-10-2026-12-00', 'logs', 'tickets'):
            (self.work / name).mkdir(parents=True)

        common.mark_done(self.work / '20-10-2026-13-00', 'run')
        common.mark_failed(self.work / '20-10-2026-12-00', 'triage: boom')
        self.assertEqual([p.name for p in common.incomplete_runs(self.work)], ['19-10-2026-23-00', '20-10-2026-14-00'])
        self.assertEqual(common.incomplete_runs(self.work / 'missing'), [])

    def test_markers_and_attempts(self):
        run = self.work / '20-10-2026-14-00'
        self.assertFalse(common.is_done(run, 'fetch'))
        common.mark_done(run, 'fetch')
        self.assertTrue(common.is_done(run, 'fetch'))
        self.assertEqual(common.attempts(run, 'triage'), 0)
        self.assertEqual(common.bump_attempts(run, 'triage'), 1)
        self.assertEqual(common.bump_attempts(run, 'triage'), 2)

    def test_daily_log_appends(self):
        now = time.mktime((2026, 10, 20, 14, 5, 0, 0, 0, -1))
        common.log(self.work, '20-10-2026-14-00', 'first', now)
        common.log(self.work, '', 'second', now + 60)
        text = (self.work / 'logs' / '20-10-2026.txt').read_text().splitlines()
        self.assertEqual(len(text), 2)
        self.assertTrue(text[0].endswith('[20-10-2026-14-00] first'))
        self.assertTrue(text[1].endswith(' second'))

    def test_render_prompt_replaces_every_placeholder(self):
        text = common.render_prompt('linear', tool='t', team='ENG', project='P', labels='["a"]', priority=2, title='T', description='D')
        self.assertIn('team: ENG', text)
        self.assertNotIn('{{', text)
        with self.assertRaises(KeyError):
            common.render_prompt('linear', tool='t')


class Digest(unittest.TestCase):
    def test_filter(self):
        query = gcp.build_filter(['payments', 'orders'], '2026-10-20T09:00:00Z', '2026-10-20T10:00:00Z', 'WARNING', 'NOT textPayload:"health"')
        self.assertIn('timestamp>="2026-10-20T09:00:00Z" AND timestamp<"2026-10-20T10:00:00Z"', query)
        self.assertIn('severity>=WARNING', query)
        self.assertIn('resource.labels.namespace_name=("payments" OR "orders")', query)
        self.assertTrue(query.endswith('AND (NOT textPayload:"health")'))

    def test_message_and_service_extraction(self):
        self.assertEqual(gcp.message_of(ENTRIES[3]), 'timeout calling 10.0.0.1:8080 req 7f3a9c2b1d4e')
        self.assertEqual(gcp.service_of(ENTRIES[3]), 'checkout')
        self.assertEqual(gcp.service_of(ENTRIES[0]), 'api')
        self.assertEqual(gcp.message_of({'jsonPayload': {'error': {'message': 'nested'}}}), 'nested')
        self.assertEqual(gcp.message_of({}), '(no message)')

    def test_normalize_strips_ids(self):
        self.assertEqual(gcp.normalize('order 123 failed for 3f2504e0-4f89-11d3-9a0c-0305e82c3301 at 7f3a9c2b1d4e'), 'order # failed for <uuid> at <hex>')

    def test_digest_groups_by_signature_and_orders_by_severity_then_count(self):
        summary = gcp.digest(ENTRIES)
        self.assertEqual(summary['total'], 4)
        self.assertEqual([g['id'] for g in summary['groups']], ['g1', 'g2', 'g3'])
        first = summary['groups'][0]
        self.assertEqual((first['service'], first['count'], first['entries']), ('api', 2, [0, 1]))
        self.assertEqual(first['first_seen'], '2026-10-20T10:00:01Z')
        self.assertEqual(first['last_seen'], '2026-10-20T10:00:05Z')
        self.assertEqual(summary['groups'][2]['severity'], 'WARNING')
        self.assertEqual(summary['by_severity'], {'ERROR': 3, 'WARNING': 1})
        text = gcp.render_digest({'start': 'a', 'end': 'b'}, summary, truncated=True)
        self.assertIn('truncated', text)
        self.assertIn('### g1', text)


class FakeTools(unittest.TestCase):
    """read_logs and session.run through fake gcloud/claude executables on PATH."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.env = base_env(self.root)
        self.config = common.load_config(self.env)
        self.path_patch = patch.dict(os.environ, {'PATH': f"{self.bin}{os.pathsep}{os.environ['PATH']}"})
        self.path_patch.start()
        self.addCleanup(self.path_patch.stop)

    def script(self, name, body):
        path = self.bin / name
        path.write_text('#!/bin/sh\n' + body)
        path.chmod(path.stat().st_mode | stat.S_IXUSR)

    def test_read_logs_sorts_entries_and_passes_filter(self):
        (self.root / 'entries.json').write_text(json.dumps(list(reversed(ENTRIES))))
        self.script('gcloud', f'printf "%s\\n" "$@" > "{self.root}/argv"\ncat "{self.root}/entries.json"\n')
        entries, error = gcp.read_logs(self.config, '2026-10-20T09:00:00Z', '2026-10-20T10:00:00Z')
        self.assertEqual(error, '')
        self.assertEqual([e['timestamp'] for e in entries], sorted(e['timestamp'] for e in ENTRIES))
        argv = (self.root / 'argv').read_text().splitlines()
        self.assertEqual(argv[:3], ['logging', 'read', gcp.build_filter(['payments', 'orders'], '2026-10-20T09:00:00Z', '2026-10-20T10:00:00Z')])
        self.assertIn('--project=prod-project', argv)
        self.assertIn('--limit=5000', argv)

    def test_read_logs_reports_failures(self):
        self.script('gcloud', 'echo "ERROR: (gcloud.logging.read) You do not currently have an active account selected." >&2\nexit 1\n')
        entries, error = gcp.read_logs(self.config, 'a', 'b')
        self.assertEqual(entries, [])
        self.assertIn('active account', error)

    def test_session_run_parses_structured_output_and_sets_guard_env(self):
        self.script('claude', f'printf "%s\\n" "$@" > "{self.root}/claude-argv"\nprintf "guard=$PROD_MONITOR_GUARD writable=$PROD_MONITOR_WRITABLE\\n" > "{self.root}/claude-env"\n'
                    'echo \'{"type":"system"}\'\n'
                    'echo \'{"type":"result","result":"done","structured_output":{"status":"ok","identifier":"ENG-1","url":"https://linear.app/x"},"usage":{"input_tokens":10,"output_tokens":5},"modelUsage":{"sonnet":{"inputTokens":10,"outputTokens":5}}}\'\n')
        reply = session.run(self.config, model='sonnet', effort='', prompt='hello', cwd=self.root, schema={'type': 'object'}, event_log=self.root / 'sessions' / 's.log', tools=('ToolSearch',), allowed_tools=('ToolSearch', 'x'), writable=(self.root / 'out',), plugin=False)
        self.assertEqual(reply['status'], 'ok')
        self.assertEqual(reply['structured']['identifier'], 'ENG-1')
        self.assertEqual(reply['usage']['session_tokens'], 15)
        argv = (self.root / 'claude-argv').read_text().splitlines()
        self.assertEqual(argv[-1], 'hello')
        self.assertIn('--json-schema', argv)
        self.assertNotIn('--no-session-persistence', argv)
        self.assertIn('--disable-slash-commands', argv)
        self.assertNotIn('--plugin-dir', argv)
        self.assertEqual(argv[argv.index('--tools') + 1], 'ToolSearch')
        self.assertEqual(argv[argv.index('--allowedTools') + 1], 'ToolSearch,x')
        self.assertEqual((self.root / 'claude-env').read_text().strip(), f'guard=1 writable={self.root / "out"}')
        self.assertIn('"type":"result"', (self.root / 'sessions' / 's.log').read_text())

    def test_session_run_with_plugin_loads_it_and_keeps_hooks(self):
        self.script('claude', f'printf "%s\\n" "$@" > "{self.root}/claude-argv"\necho \'{{"type":"result","result":"x","structured_output":{{"a":1}}}}\'\n')
        reply = session.run(self.config, model='opus', effort='high', prompt='p', cwd=self.root, schema={}, event_log=self.root / 's.log', add_dirs=(self.root,), slash_commands=True)
        self.assertEqual(reply['status'], 'ok')
        argv = (self.root / 'claude-argv').read_text().splitlines()
        self.assertEqual(argv[argv.index('--plugin-dir') + 1], str(common.PLUGIN))
        self.assertEqual(argv[argv.index('--effort') + 1], 'high')
        self.assertEqual(argv[argv.index('--add-dir') + 1], str(self.root))
        self.assertIn('"disableAllHooks": false', argv[argv.index('--settings') + 1])
        self.assertNotIn('--disable-slash-commands', argv)

    def test_session_run_without_structured_reply_is_an_error(self):
        self.script('claude', 'echo \'{"type":"result","result":"I could not"}\'\n')
        reply = session.run(self.config, model='opus', effort='', prompt='p', cwd=self.root, schema={}, event_log=self.root / 's.log')
        self.assertEqual(reply['status'], 'error')
        self.assertIn('no structured reply', reply['detail'])

        self.script('claude', 'exit 7\n')
        reply = session.run(self.config, model='opus', effort='', prompt='p', cwd=self.root, schema={}, event_log=self.root / 's.log')
        self.assertIn('exit 7', reply['detail'])


class Issues(unittest.TestCase):
    def setUp(self):
        self.summary = gcp.digest(ENTRIES)

    def test_normalize_issues_dedupes_ids_and_fills_from_groups(self):
        structured = {'issues': [
            {'id': 'Nil Deref', 'title': 'nil deref in order handler', 'service': '', 'severity': 'error', 'fingerprint': 'api:nil-deref:handler', 'digest_groups': ['g1', 'nope'], 'summary': 's', 'actionable': True},
            {'id': 'nil-deref', 'title': 'another', 'service': 'worker', 'severity': 'WARN', 'fingerprint': '', 'digest_groups': ['g3'], 'summary': 's', 'actionable': False, 'known_ticket': 'ENG-9'},
            {'title': ''},
            'junk',
        ]}
        issues = pipeline.normalize_issues(structured, self.summary)
        self.assertEqual([i['id'] for i in issues], ['nil-deref', 'nil-deref-2'])
        self.assertEqual((issues[0]['service'], issues[0]['namespace'], issues[0]['count'], issues[0]['digest_groups']), ('api', 'payments', 2, ['g1']))
        self.assertEqual((issues[1]['severity'], issues[1]['fingerprint'], issues[1]['actionable'], issues[1]['known_ticket']), ('warning', 'worker:another', False, 'ENG-9'))

    def test_plan_skips_known_and_recently_skipped(self):
        now = 1_000_000.0
        known = {
            'api:a': {'status': 'ticketed', 'ticket': 'ENG-1'},
            'api:b': {'status': 'skipped:rejected', 'at': common.iso(now - 3600)},
            'api:c': {'status': 'skipped:rejected', 'at': common.iso(now - 90000)},
        }
        issues = [
            {'id': 'a', 'fingerprint': 'api:a', 'known_ticket': '', 'actionable': True},
            {'id': 'b', 'fingerprint': 'api:b', 'known_ticket': '', 'actionable': True},
            {'id': 'c', 'fingerprint': 'api:c', 'known_ticket': '', 'actionable': True},
            {'id': 'd', 'fingerprint': 'api:d', 'known_ticket': 'ENG-1', 'actionable': True},
            {'id': 'e', 'fingerprint': 'api:e', 'known_ticket': '', 'actionable': False},
            {'id': 'f', 'fingerprint': 'api:f', 'known_ticket': '', 'actionable': True},
        ]
        plan = pipeline.plan_issues(issues, known, now, 86400)
        self.assertEqual({k: v['action'] for k, v in plan.items()}, {'a': 'known', 'b': 'known', 'c': 'investigate', 'd': 'known', 'e': 'ignore', 'f': 'investigate'})
        self.assertEqual(plan['d']['ticket'], 'ENG-1')


class FakeSessions:
    """Stands in for session.run: answers by stage, recorded per call; optional failures."""

    def __init__(self, run_dir, fail=()):
        self.run_dir = run_dir
        self.fail = set(fail)
        self.calls = []
        self.linear_status = 'ok'

    def __call__(self, config, *, event_log, prompt, writable=(), **kwargs):
        name = event_log.stem
        self.calls.append((name, kwargs.get('model'), kwargs.get('effort'), prompt))
        stage = name.split('-')[0]
        if name in self.fail:
            self.fail.discard(name)

            return {'status': 'error', 'detail': 'boom', 'structured': None, 'result': '', 'usage': {}}

        usage = {'turn_tokens': 1, 'session_tokens': 2}
        if stage == 'triage':
            (self.run_dir / 'triage' / 'triage.md').write_text('# Triage\n\nwritten by model\n')
            structured = {'issues': [
                {'id': 'api-nil-deref', 'title': 'nil deref in order handler', 'service': 'api', 'namespace': 'payments', 'severity': 'error', 'fingerprint': 'api:nil-deref:handler', 'digest_groups': ['g1'], 'summary': 'crashes', 'actionable': True, 'known_ticket': ''},
                {'id': 'checkout-timeout', 'title': 'checkout timeouts', 'service': 'checkout', 'namespace': 'payments', 'severity': 'error', 'fingerprint': 'checkout:timeout:upstream', 'digest_groups': ['g2'], 'summary': 'slow', 'actionable': True, 'known_ticket': ''},
                {'id': 'worker-retry', 'title': 'worker retries', 'service': 'worker', 'namespace': 'payments', 'severity': 'warning', 'fingerprint': 'worker:retry', 'digest_groups': ['g3'], 'summary': 'noise', 'actionable': False, 'known_ticket': ''},
            ], 'notes': 'ok'}
        elif stage == 'finding':
            issue = name[len('finding-'):]
            if issue == 'api-nil-deref':
                (self.run_dir / 'findings' / f'{issue}.md').write_text('# Finding\n\nroot cause here\n')
            structured = {'status': 'found', 'confidence': 'high', 'summary': f'{issue} summary', 'root_cause': 'missing nil check', 'proposed_fix': 'add check', 'repos': ['api'], 'files': ['api/handler.go:42']}
        elif stage == 'challenge':
            issue = name[len('challenge-'):]
            verdict = 'confirmed' if issue == 'api-nil-deref' else 'rejected'
            structured = {'verdict': verdict, 'confidence': 'high', 'summary': f'{verdict} because', 'corrected_root_cause': '', 'corrected_fix': 'add check and test' if verdict == 'confirmed' else ''}
        elif stage == 'linear':
            structured = {'status': self.linear_status, 'detail': '', 'identifier': 'ENG-123', 'url': 'https://linear.app/eng/issue/ENG-123'}
        elif stage == 'pr':
            structured = {'status': 'ok', 'detail': '', 'url': 'https://github.com/o/api/pull/9', 'branch': 'fix/api-nil-deref'}
        else:
            raise AssertionError(name)

        return {'status': 'ok', 'detail': '', 'structured': structured, 'result': '', 'usage': usage}


class Pipeline(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.env = base_env(self.root)
        (self.root / 'repos' / 'api').mkdir()
        self.config = common.load_config(self.env)
        self.work = self.config['workdir']
        self.now = time.mktime((2026, 10, 20, 14, 0, 0, 0, 0, -1))
        self.read_logs = patch.object(gcp, 'read_logs', return_value=(list(ENTRIES), ''))
        self.read_logs.start()
        self.addCleanup(self.read_logs.stop)

    def start(self, fail=()):
        path = pipeline.create_run(self.config, self.now)
        fake = FakeSessions(path, fail)
        patcher = patch.object(pipeline.session, 'run', fake)
        patcher.start()
        self.addCleanup(patcher.stop)

        return path, fake

    def test_full_run_creates_artifacts_tickets_and_memory(self):
        path, fake = self.start()
        self.assertEqual(path.name, '20-10-2026-14-00')
        window = common.read_json(path / 'gcp-logs' / 'window.json')
        self.assertEqual(window, {'start': common.iso(self.now - 3600), 'end': common.iso(self.now)})

        run = pipeline.process(self.config, path)

        self.assertTrue(common.is_done(path, 'run'))
        self.assertEqual(common.read_cursor(self.work), self.now)
        self.assertTrue((path / 'gcp-logs' / 'logs.json').exists())
        self.assertIn('### g1', (path / 'gcp-logs' / 'digest.md').read_text())
        self.assertEqual((path / 'triage' / 'triage.md').read_text(), '# Triage\n\nwritten by model\n')
        issues = common.read_json(path / 'triage' / 'issues.json')['issues']
        self.assertEqual([i['id'] for i in issues], ['api-nil-deref', 'checkout-timeout', 'worker-retry'])
        self.assertEqual(issues[0]['count'], 2)
        sample = common.read_json(path / 'triage' / 'issues' / 'api-nil-deref.json')
        self.assertEqual(len(sample['sample_entries']), 2)
        self.assertEqual(common.read_json(path / 'triage' / 'plan.json')['worker-retry'], {'action': 'ignore'})

        # The model wrote one finding file; the other is generated from the structured reply.
        self.assertEqual((path / 'findings' / 'api-nil-deref.md').read_text(), '# Finding\n\nroot cause here\n')
        self.assertIn('generated from its structured reply', (path / 'findings' / 'checkout-timeout.md').read_text())
        self.assertEqual(common.read_json(path / 'findings' / 'checkout-timeout.json')['status'], 'found')
        self.assertIn('## Verdict', (path / 'challenged-findings' / 'api-nil-deref.md').read_text())
        self.assertEqual(common.read_json(path / 'challenged-findings' / 'checkout-timeout.json')['verdict'], 'rejected')

        self.assertEqual(common.read_json(path / 'tickets' / 'api-nil-deref.json')['identifier'], 'ENG-123')
        self.assertEqual(common.read_json(path / 'tickets' / 'checkout-timeout.json'), {'status': 'skipped', 'reason': 'rejected'})
        self.assertFalse((path / 'prs').exists())

        known = common.read_json(self.work / 'known-issues.json')
        self.assertEqual(known['api:nil-deref:handler']['status'], 'ticketed')
        self.assertEqual(known['api:nil-deref:handler']['ticket'], 'ENG-123')
        self.assertEqual(known['checkout:timeout:upstream']['status'], 'skipped:rejected')
        self.assertNotIn('worker:retry', known)

        report = self.work / 'tickets' / '20-10-2026' / '20-10-2026-14-00.md'
        text = report.read_text()
        self.assertIn('- ENG-123 — nil deref in order handler (payments/api, error) — https://linear.app/eng/issue/ENG-123', text)
        self.assertIn('- checkout-timeout — checkout timeouts — rejected', text)
        self.assertIn('- worker retries (1 occurrences)', text)
        self.assertEqual((path / 'report.md').read_text(), text)

        log = (self.work / 'logs' / '20-10-2026.txt').read_text()
        self.assertIn('fetch: 4 entries in 3 groups', log)
        self.assertIn('triage: 3 issues (2 errors, 1 warnings); 2 to investigate, 0 known, 1 not actionable', log)
        self.assertIn('ticket api-nil-deref: ENG-123', log)
        self.assertIn('run complete', log)
        self.assertEqual(len(run.alerts), 1)
        self.assertIn('created 1 ticket(s)', run.alerts[0])

        names = [c[0] for c in fake.calls]
        self.assertEqual(names.count('triage'), 1)
        self.assertEqual(sorted(n for n in names if n.startswith('finding-')), ['finding-api-nil-deref', 'finding-checkout-timeout'])
        self.assertEqual(sorted(n for n in names if n.startswith('challenge-')), ['challenge-api-nil-deref', 'challenge-checkout-timeout'])
        self.assertEqual([c for c in fake.calls if c[0] == 'linear-api-nil-deref'][0][1], 'sonnet')
        self.assertEqual([c for c in fake.calls if c[0] == 'finding-api-nil-deref'][0][1:3], ('opus', 'high'))
        self.assertEqual([c for c in fake.calls if c[0] == 'triage'][0][1:3], ('opus', 'medium'))
        linear_prompt = [c for c in fake.calls if c[0] == 'linear-api-nil-deref'][0][3]
        self.assertIn('labels: ["prod-monitor", "bug"]', linear_prompt)
        self.assertIn('title: [api] nil deref in order handler', linear_prompt)
        self.assertIn('priority: 2', linear_prompt)
        self.assertIn('add check and test', linear_prompt)
        self.assertIn('nil pointer dereference in handler order=123', linear_prompt)

        # Running again does nothing: every stage is done.
        again = pipeline.process(self.config, path)
        self.assertEqual(again.notes, [])
        self.assertEqual(len(fake.calls), 6)

    def test_second_run_skips_known_issues_and_counts_recurrences(self):
        path, fake = self.start()
        pipeline.process(self.config, path)
        later = pipeline.create_run(self.config, self.now + 3600)
        self.assertEqual(common.read_json(later / 'gcp-logs' / 'window.json')['start'], common.iso(self.now))
        fake.run_dir = later
        run = pipeline.process(self.config, later)
        plan = common.read_json(later / 'triage' / 'plan.json')
        self.assertEqual(plan['api-nil-deref'], {'action': 'known', 'ticket': 'ENG-123', 'status': 'ticketed'})
        self.assertEqual(plan['checkout-timeout']['action'], 'known')
        self.assertEqual([c[0] for c in fake.calls if c[0] != 'triage' and 'later' not in c[0]][-1:], ['linear-api-nil-deref'])
        self.assertEqual(sum(1 for c in fake.calls if c[0] == 'triage'), 2)
        known = common.read_json(self.work / 'known-issues.json')
        self.assertEqual(known['api:nil-deref:handler']['recurrences'], 1)
        self.assertEqual(run.alerts, [])
        self.assertIn('- ENG-123 — nil deref in order handler (2 occurrences)', (later / 'report.md').read_text())

    def test_failed_session_is_retried_next_tick_and_resumes_where_it_stopped(self):
        path, fake = self.start(fail=('challenge-api-nil-deref',))
        run = pipeline.process(self.config, path)
        self.assertTrue(common.is_done(path, 'findings'))
        self.assertFalse(common.is_done(path, 'challenge'))
        self.assertFalse((path / 'challenged-findings' / 'api-nil-deref.json').exists())
        self.assertTrue((path / 'challenged-findings' / 'checkout-timeout.json').exists())
        self.assertEqual(common.attempts(path, 'challenge-api-nil-deref'), 1)
        self.assertEqual(run.alerts, [])
        self.assertIn('challenge api-nil-deref failed (attempt 1): boom; retrying next tick', run.notes)

        pipeline.process(self.config, path)
        self.assertTrue(common.is_done(path, 'run'))
        self.assertEqual(sum(1 for c in fake.calls if c[0] == 'challenge-api-nil-deref'), 2)
        self.assertEqual(sum(1 for c in fake.calls if c[0] == 'challenge-checkout-timeout'), 1)
        self.assertEqual(sum(1 for c in fake.calls if c[0].startswith('finding-')), 2)

    def test_item_gives_up_after_max_attempts_and_run_continues(self):
        path, fake = self.start(fail=('finding-checkout-timeout',) * 1)
        fake.fail = {'finding-checkout-timeout'}
        original = fake.__call__

        def always_fail(config, *, event_log, **kwargs):
            if event_log.stem == 'finding-checkout-timeout':
                fake.calls.append((event_log.stem, kwargs.get('model'), kwargs.get('effort'), kwargs.get('prompt')))

                return {'status': 'error', 'detail': 'boom', 'structured': None, 'result': '', 'usage': {}}

            return original(config, event_log=event_log, **kwargs)

        with patch.object(pipeline.session, 'run', always_fail):
            runs = [pipeline.process(self.config, path) for _ in range(common.MAX_ATTEMPTS)]

        self.assertTrue(common.is_done(path, 'run'))
        self.assertEqual(common.read_json(path / 'findings' / 'checkout-timeout.json')['status'], 'failed')
        self.assertEqual(common.read_json(path / 'challenged-findings' / 'checkout-timeout.json')['verdict'], 'skipped')
        self.assertEqual(common.read_json(path / 'tickets' / 'checkout-timeout.json')['reason'], 'failed')
        alerts = [a for r in runs for a in r.alerts]
        self.assertTrue(any('gave up after 3 attempts' in a for a in alerts))
        self.assertEqual(common.read_json(self.work / 'known-issues.json')['checkout:timeout:upstream']['status'], 'skipped:failed')

    def test_fetch_failures_retry_then_stop(self):
        self.read_logs.stop()
        with patch.object(gcp, 'read_logs', return_value=([], 'gcloud logging read failed: not logged in')):
            path = pipeline.create_run(self.config, self.now)
            for _ in range(common.MAX_ATTEMPTS - 1):
                run = pipeline.process(self.config, path)
                self.assertFalse(common.is_done(path, 'fetch'))

            self.assertIn('fetch failed (attempt 2): gcloud logging read failed: not logged in; retrying next tick', run.notes)
            with self.assertRaises(common.Stop):
                pipeline.process(self.config, path)

        self.read_logs.start()
        self.assertIsNone(common.read_cursor(self.work))
        self.assertEqual(common.incomplete_runs(self.work), [path])

    def test_empty_window_completes_without_sessions(self):
        self.read_logs.stop()
        with patch.object(gcp, 'read_logs', return_value=([], '')):
            path, fake = self.start()
            run = pipeline.process(self.config, path)

        self.read_logs.start()
        self.assertTrue(common.is_done(path, 'run'))
        self.assertEqual(fake.calls, [])
        self.assertIn('No log entries', (path / 'triage' / 'triage.md').read_text())
        self.assertIn('- none', (path / 'report.md').read_text())
        self.assertEqual(run.alerts, [])

    def test_linear_unavailable_stops_the_loop(self):
        path, fake = self.start()
        fake.linear_status = 'unavailable'
        with self.assertRaises(common.Stop):
            pipeline.process(self.config, path)

        self.assertTrue(common.is_done(path, 'challenge'))
        self.assertFalse((path / 'tickets' / 'api-nil-deref.json').exists())

    def test_non_stage_failure_marks_run_failed(self):
        path, fake = self.start()
        (path / 'gcp-logs' / 'window.json').unlink()
        for _ in range(common.MAX_ATTEMPTS):
            try:
                run = pipeline.process(self.config, path)
            except common.Stop:
                break

        self.assertTrue((path / 'state' / 'failed').exists() or common.incomplete_runs(self.work) == [path])

    def test_open_prs_stage_runs_for_confirmed_tickets(self):
        config = common.load_config({**self.env, 'PROD_MONITOR_OPEN_PRS': '1'})
        path = pipeline.create_run(config, self.now)
        fake = FakeSessions(path)
        with patch.object(pipeline.session, 'run', fake):
            pipeline.process(config, path)

        self.assertEqual(common.read_json(path / 'prs' / 'api-nil-deref.json')['url'], 'https://github.com/o/api/pull/9')
        self.assertEqual(common.read_json(path / 'prs' / 'checkout-timeout.json')['status'], 'skipped')
        call = [c for c in fake.calls if c[0] == 'pr-api-nil-deref'][0]
        self.assertEqual(call[1:3], ('opus', 'medium'))
        self.assertIn(str(self.work / 'worktrees' / 'api-api-nil-deref'), call[3])
        self.assertIn('PR https://github.com/o/api/pull/9', (path / 'report.md').read_text())


class Loop(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.config = common.load_config(base_env(self.root))
        self.work = self.config['workdir']
        self.work.mkdir()

    def test_tick_resumes_before_starting_and_respects_interval(self):
        now = time.mktime((2026, 10, 20, 14, 0, 0, 0, 0, -1))
        processed = []

        def fake_process(config, path):
            processed.append(path.name)
            common.mark_done(path, 'run')

            return pipeline.Run(config, path)

        stale = self.work / '20-10-2026-12-00'
        stale.mkdir()
        with patch.object(pipeline, 'process', fake_process):
            loop.tick(self.config, now)
            self.assertEqual(processed, ['20-10-2026-12-00', '20-10-2026-14-00'])
            common.write_cursor(self.work, now)
            loop.tick(self.config, now + 600)
            self.assertEqual(len(processed), 2)
            loop.tick(self.config, now + 3600)
            self.assertEqual(processed[-1], '20-10-2026-15-00')

    def test_tick_does_not_start_a_run_while_one_is_incomplete(self):
        now = time.mktime((2026, 10, 20, 14, 0, 0, 0, 0, -1))
        (self.work / '20-10-2026-13-00').mkdir()
        with patch.object(pipeline, 'process', lambda config, path: pipeline.Run(config, path)):
            runs = loop.tick(self.config, now)

        self.assertEqual([r.id for r in runs], ['20-10-2026-13-00'])
        self.assertFalse((self.work / '20-10-2026-14-00').exists())


if __name__ == '__main__':
    unittest.main()
