#!/usr/bin/env python3
"""Reproduce archived audit findings in a private copy; never launch real DSH.

Exit 0 means the historical defects were reproduced, NOT that the product is fixed.
Requires the repository's existing node_modules and DSH 0.2.1-rc.5 modules.
No installation, daemon request, profile load, model call or host patch is performed.
"""
import argparse
import io
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tarfile
import tempfile

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
CASES = {
    'bridge': 'bridge-extra-repro.mjs',
    'harness': 'harness-extra-repro.mjs',
    'doctor': 'probe-doctor-extra.mjs',
    'thinking': 'probe-thinking-settle.cjs',
    'tool-errors': 'probe-failed-tool-render.cjs',
    'probe-auth': 'probe-capability-auth.mjs',
    'patch-tail': 'probe-patch-tail.cjs',
    'server-config': 'server-config.cjs',
    'server-lifecycle': 'server-lifecycle.cjs',
    'server-open': 'server-race-wire.cjs',
}
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--case', choices=['all', *CASES], default='all')
parser.add_argument('--ref', default='9298c28', help='Historical source to inspect, default audit baseline')
args = parser.parse_args()

dependencies = REPO / 'paseo-plugin/node_modules'
if not (dependencies / 'typescript/bin/tsc').exists():
    raise SystemExit('Existing paseo-plugin/node_modules is required; this runner does not install packages.')
dsh = Path(os.environ.get('DSH_INSTALL_DIR', str(Path.home() / '.npm-global/lib/node_modules/@deepseek-ai/dsh')))
if not (dsh / 'package.json').exists():
    raise SystemExit('Set DSH_INSTALL_DIR to the existing DSH 0.2.1-rc.5 installation.')
version = json.loads((dsh / 'package.json').read_text())['version']
if version != '0.2.1-rc.5':
    raise SystemExit(f'Archived evidence requires DSH 0.2.1-rc.5 modules; found {version}. No files changed.')
plugin_version = json.loads((dependencies / '@getpaseo/plugin/package.json').read_text())['version']
if plugin_version != '0.14.0':
    raise SystemExit(f'Archived evidence requires @getpaseo/plugin 0.14.0; found {plugin_version}.')

root = Path(tempfile.mkdtemp(prefix='paseo-audit-20261031-'))
checkout = root / 'checkout'
checkout.mkdir()
archive = subprocess.check_output(['git', 'archive', args.ref], cwd=REPO)
with tarfile.open(fileobj=io.BytesIO(archive)) as source:
    source.extractall(checkout, filter='data')
(checkout / 'paseo-plugin/node_modules').symlink_to(dependencies, target_is_directory=True)

# Remove ambient test/runtime controls; never redirect the user's HOME.
env = {k: v for k, v in os.environ.items()
       if not k.startswith(('DSH_', 'PASEO_')) and k != 'NODE_OPTIONS'}
env['DSH_INSTALL_DIR'] = str(dsh)
env['DSH_PACKAGES_DIR'] = str(dsh / 'node_modules/@deepseek-ai')
env['PASEO_AUDIT_REPO'] = str(checkout)
env['PASEO_AUDIT_BUILD'] = str(checkout / 'paseo-plugin/.dbg-audit-repro')
env['PASEO_AUDIT_SCRATCH'] = str(root)
for key, folder in [('DSH_HOME', 'dsh'), ('PASEO_HOME', 'paseo'), ('TMPDIR', 'tmp')]:
    target = root / folder
    target.mkdir(mode=0o700)
    env[key] = str(target)

def command(argv, cwd, log_name, timeout=120):
    with (root / log_name).open('w') as log:
        process = subprocess.Popen(argv, cwd=cwd, env=env, stdout=log,
                                   stderr=subprocess.STDOUT, start_new_session=True)
        try:
            return process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            return 124

print(f'Evidence directory: {root}', flush=True)
for name, argv, cwd in [
    ('dsh-contract', ['node', 'harness/dsh-api-contract-check.mjs'], checkout),
    ('assets', ['node', 'harness/bridge-assets-check.mjs'], checkout),
    ('typecheck', ['node', 'node_modules/typescript/bin/tsc', '--noEmit'], checkout / 'paseo-plugin'),
    ('compile', ['node', '-e', "require('./harness/plugin-build.cjs').resolvePluginBuild(undefined,'.dbg-audit-repro')"], checkout),
]:
    code = command(argv, cwd, name + '.log')
    if code:
        raise SystemExit(f'Prerequisite {name} failed ({code}); see {root / (name + ".log")}')

probes = root / 'probes'
shutil.copytree(HERE, probes, ignore=shutil.ignore_patterns('__pycache__'))
delta = json.loads((HERE / 'delayed-fixture.json').read_text())
fake = (checkout / 'harness/fake-dsh-bridge.mjs').read_text()
if fake.count(delta['anchor']) != 1:
    raise SystemExit('Fake bridge anchor changed; the archived race fixture needs review.')
(probes / 'fake-delayed.mjs').write_text(fake.replace(delta['anchor'], delta['anchor'] + delta['insert'], 1))
(probes / 'fake-delayed.mjs').chmod(0o700)

results = []

def confirms_counterexample(name, log_path):
    # Some original exploratory probes printed observations instead of asserting.
    # Keep their observations intact, but make the archived runner check them.
    records = []
    for line in log_path.read_text().splitlines():
        if line.startswith('{'):
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                pass  # Other probes also print indented diagnostic objects.
    if name == 'doctor':
        labels = {'positive-control', 'quoted-empty-route', 'route-from-later-block',
                  'quoted-empty-credential', 'comment-only-credential',
                  'credential-after-refs-block', 'disabled-route'}
        return ({r.get('label') for r in records} == labels
                and all(r.get('exitCode') == 0 and r.get('allPassed') is True for r in records))
    if name == 'thinking':
        return [r.get('shimmerActive') for r in records] == [True, True, True, True, False]
    if name == 'tool-errors':
        by_name = {r.get('name'): r for r in records}
        return (set(by_name) == {'write', 'edit', 'bash'}
                and by_name['write']['errorSurvives'] is False
                and by_name['edit']['errorSurvives'] is False
                and by_name['bash']['errorSurvives'] is True)
    if name == 'probe-auth':
        by_status = {r.get('status'): r for r in records}
        return (set(by_status) == {401, 402, 403, 429}
                and all(by_status[s]['exitCode'] == 0
                        and by_status[s]['advisesDisableReasoning']
                        and by_status[s]['developerRejected'] for s in [401, 402, 403])
                and by_status[429]['exitCode'] == 1 and by_status[429]['unknownReasoning'])
    if name == 'patch-tail':
        return (len(records) == 1 and records[0]['unrelatedTailPresentBefore'] is True
                and records[0]['unrelatedTailPresentAfter'] is False
                and records[0]['changedSourceParses'] is True)
    return True  # Remaining probes contain their own strict assertions.

for name, file in CASES.items():
    if args.case != 'all' and args.case != name:
        continue
    for key, prefix in [('DSH_HOME', 'case-dsh-'), ('PASEO_HOME', 'case-paseo-'), ('TMPDIR', 'case-tmp-')]:
        target = root / (prefix + name)
        target.mkdir(mode=0o700)
        env[key] = str(target)
    code = command(['node', str(probes / file)], checkout, name + '.log', timeout=60)
    if code == 0 and not confirms_counterexample(name, root / (name + '.log')):
        code = 1
        print(f'{name}: observations do not confirm the archived counterexample', flush=True)
    results.append({'case': name, 'exit_code': code, 'log': name + '.log'})
    print(f'{name}: exit {code}', flush=True)
(root / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
print('Exit 0 confirms historical counterexamples, not fixed behavior.', flush=True)
raise SystemExit(1 if any(row['exit_code'] for row in results) else 0)
