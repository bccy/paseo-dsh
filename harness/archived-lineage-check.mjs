/**
 * Offline check for the bridge's archive-lineage rule.
 *
 * DSH's session controller decides whether a step may run with
 * `underArchivedSession` (`dsh-api-session-controller`): a Session is under
 * archive when its own id is in `archivedSessionIds`, OR when any ancestor
 * along its `origin: 'subagent'` + `parentSession` lineage is. The bridge ports
 * that rule into `dsh-bridge/lib/archived-lineage.js`, and the port must stay
 * exact — otherwise `paseo/subagents` reports a child of an archived root as
 * unarchived (so the replay re-announces it) and the import list keeps offering
 * sessions DSH's own gate refuses to run.
 *
 * This is a pure-module check: no DSH profile, no daemon, no model. The rest of
 * the bridge imports profile-only packages, which is exactly why the rule lives
 * in its own dependency-free module.
 *
 * Usage: node harness/archived-lineage-check.mjs
 */
import { underArchivedSession } from '../dsh-bridge/lib/archived-lineage.js';

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  — ${detail}`}`);
};

/** One durable header, with the fields the rule reads. */
const header = (id, parentSession, origin) => ({
  id,
  ...(parentSession === undefined ? {} : { parentSession }),
  ...(origin === undefined ? {} : { origin }),
});

const headers = new Map([
  ['root', header('root')],
  ['child', header('child', 'root', 'subagent')],
  ['grandchild', header('grandchild', 'child', 'subagent')],
  // A fork shares the lineage field but carries no subagent origin: it is an
  // independent conversation and must never inherit the source's archive.
  ['fork', header('fork', 'root')],
  // A cycle must terminate rather than hang the replay.
  ['loop-a', header('loop-a', 'loop-b', 'subagent')],
  ['loop-b', header('loop-b', 'loop-a', 'subagent')],
]);

check('an archived session is under archive', underArchivedSession(headers, ['root'], 'root') === true);
check(
  'a child of an archived root is under archive',
  underArchivedSession(headers, ['root'], 'child') === true,
);
check(
  'a grandchild of an archived root is under archive',
  underArchivedSession(headers, ['root'], 'grandchild') === true,
);
check(
  'a grandchild of an archived middle session is under archive',
  underArchivedSession(headers, ['child'], 'grandchild') === true,
);
check(
  'an archived child is under archive',
  underArchivedSession(headers, ['child'], 'child') === true,
);
check(
  'an unrelated archive id leaves the session runnable',
  underArchivedSession(headers, ['other'], 'grandchild') === false,
);
check(
  'a fork of an archived session does NOT inherit the archive',
  underArchivedSession(headers, ['root'], 'fork') === false,
);
check(
  'a lineage cycle terminates as not archived',
  underArchivedSession(headers, ['other'], 'loop-a') === false,
);
check(
  'an unknown header is not archived unless its own id is listed',
  underArchivedSession(headers, ['root'], 'missing') === false &&
    underArchivedSession(headers, ['missing'], 'missing') === true,
);
check(
  'a Set and a plain array are both accepted',
  underArchivedSession(headers, new Set(['root']), 'child') === true &&
    underArchivedSession(headers, ['root'], 'child') === true,
);
check(
  'an empty archive set leaves every session runnable',
  underArchivedSession(headers, new Set(), 'grandchild') === false &&
    underArchivedSession(headers, [], 'root') === false,
);
check(
  'an empty or absent session id is never archived',
  underArchivedSession(headers, ['root'], '') === false &&
    underArchivedSession(headers, ['root'], undefined) === false,
);

const failed = results.filter((result) => !result.pass).length;
console.log(`\n  ${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
