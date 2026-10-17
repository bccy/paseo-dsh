/**
 * `archive_subagents` — finish native subagent child sessions in DSH's own
 * registry instead of leaving them to replay forever.
 *
 * Why this exists: Paseo projects a DSH child session (`origin: "subagent"`)
 * into its timeline as a read-only subsession, and its archive action only ever
 * reaches `archiveNativeSession(handle)` for top-level agents — there is no
 * provider route for a subsession. A click on the subsession's archive therefore
 * stays a Paseo-local mark and the next replay resurrects the child. DSH itself
 * has no such limit: `workspaceRegistry.archiveSession(id)` accepts any known
 * session, persists the id in the home-level archive set, and the
 * `archived-session-gate` then rejects that session's steps (its own, or by
 * lineage when an ancestor is archived). This tool exposes that write to the
 * model, so an archive can be requested from inside a Paseo conversation.
 *
 * Failure policy: an unknown runtime or an unknown session throws. A single
 * session's archive failure is reported per id (`failed`) and never silently
 * becomes a success, because "it says archived but replays again" is exactly the
 * bug this replaces.
 *
 * @module dsh-paseo-bridge/subagent-archive
 */
import { defineTool } from '@deepseek-ai/dsh-tools';

/** Keys shown in the model-facing listing before the rest are counted only. */
const LIST_LIMIT = 24;

/** Describe an id list for the text rendering: bounded, with a remainder count. */
function formatIds(ids) {
  if (ids.length === 0) return 'none';
  const shown = ids.slice(0, LIST_LIMIT).join(', ');
  return ids.length > LIST_LIMIT ? `${shown}, … (+${ids.length - LIST_LIMIT} more)` : shown;
}

/**
 * Register the archive tool on a plugin context that can reach the workspace
 * registry and the subagent catalog.
 *
 * The services are resolved lazily inside `execute`, not injected, so mounting
 * the gateway in a profile that composes neither (a non-Paseo runtime) still
 * loads and fails only when the tool is actually called, with a named error.
 *
 * @param ctx - The gateway plugin's context.
 */
export function registerSubagentArchiveTool(ctx) {
  ctx.tools.register(defineTool({
    name: 'archive_subagents',
    description: 'Archive finished native subagent child sessions in DSH\'s own registry, so Paseo stops '
      + 'replaying them after a restart. Paseo\'s own archive button cannot do this: a subsession has no '
      + 'provider archive route, so its click is only a local mark. scope="session" walks the children of '
      + 'this session; scope="all" walks every stored subagent session. dryRun defaults to true and only '
      + 'reports, so call it once to preview and again with dryRun=false to write.',
    parameters: {
      scope: {
        type: 'string',
        enum: ['session', 'all'],
        default: 'session',
        description: 'Which subagent sessions to consider: this session\'s children, or every stored subagent session.',
      },
      dryRun: {
        type: 'boolean',
        default: true,
        description: 'When true (default) nothing is written; the report lists what would be archived.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scope: { type: 'string', required: true },
          dryRun: { type: 'boolean', required: true },
          total: { type: 'number', required: true, description: 'Candidate subagent sessions found.' },
          archived: {
            type: 'array',
            required: true,
            description: 'Ids archived now (or, on a dry run, the ids that would be archived).',
            items: { type: 'string' },
          },
          alreadyArchived: { type: 'array', required: true, items: { type: 'string' } },
          running: {
            type: 'array',
            required: true,
            description: 'Live children skipped because their turn is still running.',
            items: { type: 'string' },
          },
          failed: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string', required: true },
                error: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `${value.scope === 'all' ? 'all stored subagent sessions' : 'children of this session'}: `
            + `${value.total} candidate(s)`,
          value.dryRun
            ? `[dry run] would archive ${value.archived.length}: ${formatIds(value.archived)}`
            : `archived ${value.archived.length}: ${formatIds(value.archived)}`,
          `already archived ${value.alreadyArchived.length}: ${formatIds(value.alreadyArchived)}`,
          `running (skipped) ${value.running.length}: ${formatIds(value.running)}`,
          value.failed.length === 0
            ? 'failed: none'
            : `failed ${value.failed.length}: ${value.failed.map((entry) => `${entry.sessionId} (${entry.error})`).join(', ')}`,
        ].join('\n'),
      }],
    },
    async execute(args, exec) {
      const scope = args.scope === 'all' ? 'all' : 'session';
      const dryRun = args.dryRun !== false;
      const registry = ctx.get('workspaceRegistry');
      if (registry === undefined) {
        throw new Error('archive_subagents: this DSH runtime composes no workspace registry');
      }
      const archivedIds = new Set([...registry.archivedSessionIds].map(String));

      /** @type {Array<{ id: string }>} */
      let candidates;
      if (scope === 'all') {
        const headers = await registry.listStoredHeaders();
        candidates = headers
          .filter((header) => header.origin === 'subagent' && header.parentSession !== undefined)
          .map((header) => ({ id: String(header.id) }));
      } else {
        const subagents = ctx.get('subagents');
        if (subagents === undefined) {
          throw new Error('archive_subagents: this DSH runtime composes no subagent service');
        }
        const sessionId = String(exec.agent.session.header.id);
        const listing = await subagents.listDescendants(sessionId);
        candidates = listing
          .filter((row) => row.kind === 'child')
          .map((row) => ({ id: String(row.id) }));
      }

      // Deduplicate before bucketing: `listDescendants` can reach the same child
      // through more than one parent path, and the archive set is a flat list.
      const seen = new Set();
      const pending = [];
      const alreadyArchived = [];
      for (const candidate of candidates) {
        if (seen.has(candidate.id)) continue;
        seen.add(candidate.id);
        (archivedIds.has(candidate.id) ? alreadyArchived : pending).push(candidate.id);
      }

      // Skip turning children: `stopActivity` would interrupt their in-flight
      // turn, and archiving something the user is still watching is not what
      // "archive finished subagents" means.
      const agents = ctx.get('agents');
      const running = [];
      const targets = [];
      for (const id of pending) {
        const live = agents?.get?.(id);
        const isRunning = live !== undefined && live.session?.getSnapshot?.().running === true;
        (isRunning ? running : targets).push(id);
      }

      const archived = [];
      const failed = [];
      if (dryRun) {
        archived.push(...targets);
      } else {
        for (const id of targets) {
          try {
            await registry.archiveSession(id, { stopActivity: true });
            archived.push(id);
          } catch (error) {
            failed.push({ sessionId: id, error: error instanceof Error ? error.message : String(error) });
          }
        }
      }

      return {
        scope,
        dryRun,
        total: candidates.length,
        archived,
        alreadyArchived,
        running,
        failed,
      };
    },
  }));
}
