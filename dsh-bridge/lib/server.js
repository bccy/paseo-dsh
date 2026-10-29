/**
 * A Paseo-drivable DeepSeek Harness runtime over one JSON-RPC transport peer.
 *
 * The surface is the shipped SDK contract (`initialize`, `session/prompt`,
 * `shutdown` plus the `session.event` / `session.status` notifications) with
 * three additions on top:
 *
 * - `paseo/plan/get` and `paseo/plan/set` drive the mounted plan-mode service.
 * - `paseo/config/set` mutates the live per-agent model selection, which is how
 *   the thinking-effort control takes effect without restarting the runtime.
 * - `paseo/usage` reports the session's current context occupancy from DSH's
 *   own replay-aware token meter, which is what the composer's usage readout
 *   needs to show a context window.
 * - `paseo/question` is a *server -> client request*: the bridge sends it when
 *   the model calls the user-question tool and waits for the answer batch.
 *
 * @module dsh-paseo-bridge/server
 */
import { resolve } from 'node:path';
import { brandString } from '@deepseek-ai/dsh-brand';
import { BlockAssembler, createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { admitEncodedImages } from '@deepseek-ai/dsh-attachment';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { underArchivedSession } from './archived-lineage.js';
import { FileSnapshots, isTrackedTool, mutationPathOf, resolveMutationPath } from './file-snapshots.js';
import { isDelegatedSession, rootSessionFor as resolveRootSession, snapshotOwnerKey } from './snapshot-owners.js';
import { ChildAnchors } from './child-anchors.js';
import { cancelWithdrawnDelegations as cancelDelegatedWork } from './delegated-cancel.js';
import { isHumanUserMessage, planRewind, restoresFiles, revertScope, successText } from './revert.js';
import { visibleEvents } from './surface.js';
import { historyEvents, withImageHostPaths } from './image-host-path.js';
import { promptSource } from './paseo-system-envelope.js';

function encodedImage(block) {
  return block.type === 'image' && 'data' in block;
}

/**
 * Media type read from the raster's own magic bytes, or undefined when the
 * bytes are not one of the formats DSH admits.
 *
 * The prompt's declared `mimeType` is not trustworthy: Paseo derives it from
 * the upload's filename extension, so a JPEG saved as `foo.png` arrives as
 * `{mimeType: "image/png", data: <jpeg>}`. DSH verifies the declared type
 * against the decoded bytes and refuses a mismatch, which would reject a
 * perfectly readable picture. The bytes are the authoritative answer, and this
 * is a trusted translator rather than a caller asserting content, so read the
 * type from them.
 */
function sniffImageMediaType(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return 'image/gif';
  }
  if (
    bytes.length >= 12
    && bytes.toString('ascii', 0, 4) === 'RIFF'
    && bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return undefined;
}

async function durablePromptContent(ctx, blocks) {
  const images = blocks.filter(encodedImage);
  if (images.length === 0) return blocks;
  const attachments = ctx.get('attachments');
  if (attachments === undefined) throw new Error('image prompt requires an attachment store');
  const refs = await admitEncodedImages(
    attachments,
    images.map((image) => {
      const bytes = Buffer.from(typeof image.data === 'string' ? image.data : '', 'base64');
      // Prefer the bytes; keep the declared type only when they are unreadable,
      // so an unsupported format still fails loudly with DSH's own error.
      const mediaType = sniffImageMediaType(bytes) ?? image.mimeType;
      return { data: image.data, mediaType };
    }),
  );
  let next = 0;
  return blocks.map((block) =>
    encodedImage(block) ? { type: 'image', attachment: refs[next++] } : block,
  );
}

function effortOf(value) {
  if (value === undefined || value === null || value === '') return undefined;
  return ReasoningEffortId(value);
}

/** Await a promise, rejecting if it has not settled within `ms`. */
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out ${label}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** A `withTimeout` rejection, as opposed to a lookup that simply found nothing. */
function isTimeout(error) {
  return error instanceof Error && error.message.startsWith('timed out ');
}

/**
 * The loud answer for a stored log that exists but could not be read.
 *
 * `available: false` is the same contract `subagents()` uses next door. The
 * quiet `available: true, events: []` it replaced is indistinguishable from a
 * session that genuinely has no history, and the plugin renders both as a blank
 * timeline — so a replay that timed out on a large log looked to the user like
 * "my history is gone" with nothing anywhere saying otherwise.
 */
function unavailableHistory(error) {
  return {
    available: false,
    inheritedEventCount: 0,
    events: [],
    error: { message: error instanceof Error ? error.message : String(error) },
  };
}

/**
 * Services whose absence has already been reported, so a profile that does not
 * compose one says so once per process instead of once per read.
 *
 * The two readers that use this run on every session listing and on every
 * session open that replays subagents, and a profile without the web bundle
 * legitimately composes no `workspaceRegistry`. Repeating the same line on every
 * call turns stderr into noise, which is how a warning that matters gets ignored.
 *
 * A *failure* is a different fact: it can be intermittent, and it names a
 * different cause each time, so failures are still reported on every occurrence.
 */
const REPORTED_MISSING_SERVICES = new Set();

/**
 * Report an optional service this profile does not compose, once per process.
 *
 * @param {string} service - the ctx service name; also the latch key.
 * @param {string} line - the complete message, newline included.
 */
function reportMissingService(service, line) {
  if (REPORTED_MISSING_SERVICES.has(service)) return;
  REPORTED_MISSING_SERVICES.add(service);
  process.stderr.write(line);
}

/**
 * Bound on a child's held frames before it is opened without a label. A child's
 * `subagent/descriptor` normally arrives within its first turn; the cap only
 * guards an anomalous provider so its earliest output is never dropped.
 */
const CHILD_BUFFER_CAP = 500;

/**
 * Cap on the per-session tables that outlive `session/close` (`sessionCwd`,
 * `sessionRoutes`, `initializedSessions`).
 *
 * Those three are kept on close so a parked process can resume the same session
 * on its pinned route. "The ids are bounded, so the tables are bounded" does not
 * hold inside this bridge, though: the key is the DSH session id, and a
 * long-lived shared process is asked to open every Paseo conversation and every
 * imported DSH session it ever serves — an entry per distinct session, and
 * nothing here removes one. (A rewind adds no keys: it no longer reloads at all,
 * and on the reconnect paths that do re-`initialize` a session — a parked resume,
 * a Paseo refresh — the key is the same stable DSH session id, so re-initializing
 * refreshes a row rather than adding one.) The plugin bounds its own
 * provider→DSH id map with `MAX_DSH_ID_MAPPINGS` (500); this is the same bound
 * on the bridge side, least-recently-initialized first. Live and mid-creation
 * sessions are never evicted, so eviction only trims the parked tail (which the
 * plugin re-initializes on its next attach anyway).
 */
const MAX_SESSION_ROUTE_ENTRIES = 500;

/**
 * How long a session's next creation waits for the previous close's teardown.
 *
 * The teardown — `handle.dispose()` waiting for idle and closing the session log's
 * write handle — has no deadline of its own, and the CALLER of `session/close` has
 * a short one (10 s in `dsh-process.ts`), so a slow dispose regularly outlives the
 * receipt that reported it. A reopen that starts in that window fails with "already
 * owned by an active write handle" and shows up as a session whose first prompt
 * fails. Waiting here is the fix; this bound is what keeps a stuck dispose from
 * turning into a session that can never open at all.
 *
 * Sized from the measurement rather than guessed at: `closeSession` costs ~0.4 ms
 * of bridge bookkeeping plus however long the agent's own idle wait takes, so the
 * only real question is how long a legitimately busy agent takes to go idle. 30 s
 * is well past any interactive turn boundary and still finite.
 */
const TEARDOWN_WAIT_TIMEOUT_MS = 30_000;

/**
 * Minimum spacing between live assistant snapshots forwarded to Paseo.
 *
 * DSH publishes one transient frame per streamed chunk, so forwarding every
 * chunk would put a JSON-RPC frame on stdout per token. Paseo merges successive
 * snapshots of the same timeline item into one growing row, so a ~100ms cadence
 * already reads as continuous typing while keeping the pipe quiet.
 */
const ASSISTANT_STREAM_INTERVAL_MS = 100;

/**
 * The bridge's own transient event type for a growing assistant snapshot.
 *
 * DSH's durable `assistant/message` only exists once a step settles; the
 * per-chunk `agent/assistant-stream` frames are what let Paseo show text while
 * it is produced. This type rides the existing `session.event` envelope so the
 * plugin's session routing (root, child, held-child buffer) applies unchanged.
 * It is never appended to a session log and never seen by history replay.
 *
 * Payload: `{turn, step, attempt?, reasoning?, text?}`. `attempt` is DSH's
 * attempt identity for the step, forwarded so the plugin can keep a retried
 * attempt's text off the row the previous attempt already grew; it is omitted
 * when DSH names no attempt, and a plugin that predates it simply ignores the
 * field (the payload only ever gains keys).
 */
const ASSISTANT_DELTA_EVENT = 'paseo/assistant-delta';

export class PaseoHarnessServer {
  constructor(ctx, transport, options = {}) {
    this.ctx = ctx;
    this.transport = transport;
    this.options = options;

    this.cwd = process.cwd();
    // Deliberately unset: a hardcoded route would silently pick a provider for a
    // deployment that never configured one. `initialize` falls back to the
    // profile's own default instead, and fails loudly when there is none.
    this.provider = options.provider;
    this.model = options.model;
    this.reasoningEffort = effortOf(options.reasoningEffort);
    this.maxTokens = undefined;
    /**
     * sessionId -> the teardown its last `session/close` started, while it runs.
     *
     * The dispose closes the session log's write handle, so a reopen that starts
     * before it finishes cannot materialize the session. The receipt and the
     * teardown used to be the same await, which broke as soon as the caller had a
     * shorter timeout than the dispose: the caller reopened and lost its first
     * turn. See `#trackTeardown` / `#awaitTeardown`.
     */
    this.teardowns = new Map();

    /**
     * One process serves many Paseo sessions, so `cwd` and the route above are
     * only the PROCESS DEFAULT: what a session gets when nobody told the bridge
     * anything for it. Per-session values live in these two tables, written by
     * `initialize` when it carries a `sessionId` (see `routeFor`).
     *
     * They outlive `session/close` on purpose. A closed session's DSH agent can
     * be resumed in this same process (a parked process is taken back for the
     * same Paseo session), and a route table that was emptied while
     * `initializedSessions` still said "initialized" would make the resumed
     * session silently compose ANOTHER session's process defaults — exactly the
     * cross-talk this refactor removes. Clearing both or neither keeps the pair
     * consistent; `session/close` clears neither.
     *
     * "Kept forever" is not an option either: the process keeps one entry per
     * distinct DSH session id it has ever served, and nothing removes one. All
     * three tables are bounded by {@link MAX_SESSION_ROUTE_ENTRIES} and trimmed
     * together in `#trimSessionRouteTables`.
     */
    this.sessionCwd = new Map();
    /**
     * sessionId -> { provider, model, reasoningEffort: string | null, maxTokens }.
     *
     * `reasoningEffort: null` is an explicit "this session has no thinking
     * level" (written by `configSet`'s clear and by `initialize` when no effort
     * resolved), kept distinct from `undefined` so `routeFor` cannot resurrect
     * the process default behind the user's clear. The rest of the row is
     * complete: only `initialize` (or `configSet` merging into an existing row)
     * writes it.
     */
    this.sessionRoutes = new Map();

    /**
     * Plan-mode intent recorded before a session's agent exists. Paseo opens a
     * session purely to read its composer features and never prompts it, so plan
     * and route changes must be queueable instead of requiring a live agent.
     *
     * sessionId -> boolean, and the key is DELETED once the intent is applied.
     * A single boolean was the bug: nothing ever set it back to `false`, so one
     * queued "plan on" forced plan mode onto every session this process created
     * afterwards while the UI kept showing the real (build) state.
     */
    this.pendingPlanMode = new Map();

    /**
     * sessionId -> preset id chosen before its agent existed. A preset is a
     * creation-time choice (DSH locks it once the session's first turn starts),
     * so a pick made while the composer is still being configured is remembered
     * here and applied when the agent is created.
     */
    this.pendingPresets = new Map();

    /** sessionId -> { selection, dispose } for live per-agent model control. */
    this.controls = new Map();
    /** sessionId -> { handle } for agents this server owns. */
    this.sessions = new Map();
    this.sessionCreations = new Map();
    /**
     * DSH session ids with a rewind currently running. A second rewind would
     * compute its range from the same surface that the first is about to
     * replace, so it is refused instead of serialised — by the time it ran, the
     * conversation it named would no longer exist.
     */
    this.revertInflight = new Set();
    /**
     * Write-ahead file backups for the agent's editing tools, so a rewind can
     * undo exactly the files the agent changed (and nothing else). The hooks
     * that feed it are registered by the bridge entry point, which owns the
     * DSH `fs` service.
     */
    this.fileSnapshots = new FileSnapshots();
    /**
     * Pending file-snapshot key (`sessionId:callId`) -> the session id its
     * snapshot is journaled under.
     *
     * A subagent's edit is snapshotted under the ROOT session (the one a human
     * can rewind), not under the child that ran the tool, so `commit` and
     * `discard` cannot recompute the owner from `exec.agent.session`. Captured
     * here at `tools/execute` and consumed by `tools/post-execute`/`tools/result`.
     * The key carries the executing session because a call id is only unique
     * within its session (see `snapshot-owners.js`).
     */
    this.snapshotOwners = new Map();
    /**
     * Delegated session id -> the root human-message seq its current turn was
     * dispatched by (see `child-anchors.js`). Two consumers:
     *
     * - file snapshots made by a subagent anchor to the turn that dispatched it,
     *   not to whatever human message happens to be newest at edit time;
     * - a rewind interrupts exactly the children whose dispatch turn it withdraws,
     *   and leaves the others running.
     */
    this.childAnchors = new ChildAnchors();
    /**
     * Native child session id -> { parentId, mode?, label? }. Populated from
     * each child session's own durable header (`origin: 'subagent'`) the moment
     * it first emits, with the parent catalog as a fallback. A child that
     * appears here is reported to Paseo as a provider-owned subsession; the
     * bridge never creates, resumes, or prompts a child to learn this.
     */
    this.children = new Map();
    /**
     * sessionId -> live assistant assembly for the attempt in flight. Reset by
     * each attempt's `start`, so the bridge never merges two attempts into one
     * snapshot. (Paseo's timeline is append-only, so a retry that failed
     * mid-stream can still leave its already-sent prefix visible.)
     */
    this.assistantStreams = new Map();
    this.disposers = [];
    /**
     * Whether this process has served ANY `initialize`.
     *
     * DEAD FIELD: written by `initialize` and never read (`grep this.initialized`
     * finds only the assignment below and this initializer). It is kept so the
     * shape of the object does not change under any external probe; every real
     * decision uses {@link initializedSessions}, because a process-wide boolean
     * lets a session that never initialized of its own accord run on whichever
     * route some other session happened to pin.
     */
    this.initialized = false;
    /**
     * sessionId -> the route table's key was filled by an `initialize` that
     * named this session. A prompt from a session absent from this set would
     * silently inherit the process defaults — the P0 this refactor removes —
     * so it is refused instead. The Set is deliberately NOT emptied by
     * `session/close`: a closed session's agent can be resumed in this process,
     * and a resume that had to initialize again would be a protocol regression.
     */
    this.initializedSessions = new Set();
    /**
     * Ids this bridge has seen `session/close` for, and which nothing has
     * re-initialized since. The only eviction candidates for the three route
     * tables (see `#trimSessionRouteTables`).
     *
     * This exists because "not live and not mid-creation" was **not** a safe
     * eviction predicate: a session that has opened (so it initialized) but has
     * not prompted yet owns no agent, so neither table contains it, and it is the
     * oldest row exactly when the cap is hit. Dropping it there was permanent —
     * the plugin's `#initializedSessions` cache meant `initialize` was never
     * re-sent, and `prompt` refused the session forever. An entry is added here
     * by `closeSession` and removed by `initialize` (and by the trim that drops
     * its row), so the cap only ever recycles ids whose owner has walked away.
     */
    this.closedSessions = new Set();
    /**
     * MCP entries Paseo attached to each session, in DSH's own patch-entry
     * shape (`{ name, config }`), queued until the session's agent exists and
     * consumed by `setup`. The bridge mounts them mechanically — it never
     * hardcodes which plugins those are — so the plugin layer keeps owning the
     * translation (gateway vs. native client vs. refusal).
     */
    this.pendingMcpServers = new Map();
    this.shuttingDown = false;
    this.shutdownTask = undefined;
    /**
     * provider -> the adapter fiber this process loaded for it. One value meant
     * a second `initialize` for a DIFFERENT provider overwrote the first, losing
     * the only dispose handle for an adapter that stayed loaded for the life of
     * the process.
     */
    this.llmFibers = new Map();

    this.disposers.push(
      ctx.on('session/event', (session, event) => {
        // Register a child before forwarding its first event, so Paseo has the
        // parent edge by the time the event lands and never misattributes it.
        this.observeChildSession(session);
        this.observeDelegatedTurn(session, event);
        if (event.type === 'subagent/catalog') this.observeCatalogChild(session, event);
        const sessionId = String(session.id);
        // The durable settlement is appended only after every chunk, so publish
        // the live snapshot first. Otherwise the durable copy carries a tail
        // Paseo has not seen, lands after the text row, and splits the answer in
        // two (and the same for reasoning).
        if (event.type === 'assistant/message') this.flushAssistantStreamNow(sessionId);
        const child = this.children.get(sessionId);
        // A child's own events are held until its durable label is known (from
        // its `subagent/descriptor` or the parent catalog), so the single
        // `session.child-opened` Paseo attaches already carries the real title.
        if (child !== undefined && !child.opened) {
          this.holdChildFrame(sessionId, child, { kind: 'event', event });
        } else {
          // An image attachment carries only its reference; the host path Paseo's
          // renderer needs can be resolved here and nowhere else. See
          // `image-host-path.js`.
          this.transport.notify('session.event', { sessionId, event: withImageHostPaths(this.ctx, event) });
        }
      }),
    );
    this.disposers.push(
      ctx.on('agent/status', ({ agent, status }) => {
        this.observeChildSession(agent.session);
        const sessionId = String(agent.session.id);
        const child = this.children.get(sessionId);
        if (child !== undefined && !child.opened) {
          this.holdChildFrame(sessionId, child, { kind: 'status', status });
        } else {
          this.transport.notify('session.status', { sessionId, status });
        }
      }),
    );
    // Live text: DSH's durable session events only exist at step boundaries, so
    // without this transient channel Paseo stays empty for the whole model step
    // and then receives the entire answer at once.
    this.disposers.push(
      ctx.on(
        'agent/assistant-stream',
        ({ agent, frame }) => {
          this.acceptAssistantStream(agent, frame);
        },
        { global: true },
      ),
    );
  }

  /**
   * Record one native subagent child session from its own durable header.
   * `origin: 'subagent'` is written by every subagent provider and the header's
   * `parentSession` is the direct parent. The child is registered here but not
   * yet reported: {@link holdChildFrame} opens it once a durable label is known.
   * Idempotent.
   */
  observeChildSession(session) {
    const id = String(session.id);
    if (this.children.has(id)) return;
    const header = session.header;
    if (header === undefined || header.origin !== 'subagent') return;
    const parentId = header.parentSession === undefined ? undefined : String(header.parentSession);
    if (parentId === undefined || parentId === '') return;
    this.children.set(id, {
      parentId,
      opened: false,
      buffered: [],
      ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    });
  }

  /**
   * Fallback registration from the parent-owned `subagent/catalog` fact, which
   * also carries the child's creation label and lifecycle mode. Opens the child
   * immediately when its own session was never observed directly.
   */
  observeCatalogChild(session, event) {
    const data = event.data ?? {};
    const childId = data.childId === undefined ? undefined : String(data.childId);
    if (childId === undefined || childId === '') return;
    const parentId = String(session.id);
    let child = this.children.get(childId);
    if (child === undefined) {
      // The parent's own directory, not the process default: a child of the
      // session running in project B must not be reported with project A's cwd.
      child = { parentId, opened: false, buffered: [], cwd: this.sessionDirectoryFor(parentId) };
      this.children.set(childId, child);
    }
    if (child.label === undefined && data.label !== undefined) child.label = String(data.label);
    if (child.mode === undefined && data.mode !== undefined) child.mode = data.mode;
    if (!child.opened) this.openChild(childId, child);
  }

  /** Hold one child frame until the child is opened, bounded so output is never lost. */
  holdChildFrame(sessionId, child, frame) {
    // A `subagent/descriptor` is the child's own durable identity; its label is
    // the creation label, so opening here is the first chance at a real title.
    if (frame.kind === 'event' && frame.event.type === 'subagent/descriptor') {
      const data = frame.event.data ?? {};
      if (child.label === undefined && data.label !== undefined) child.label = String(data.label);
      if (child.mode === undefined && data.mode !== undefined) child.mode = data.mode;
    }
    child.buffered.push(frame);
    if (child.label !== undefined || child.buffered.length >= CHILD_BUFFER_CAP) {
      this.openChild(sessionId, child);
    }
  }

  /** Report a child to Paseo and flush every frame held for it, in order. */
  openChild(sessionId, child) {
    if (child.opened) return;
    child.opened = true;
    this.transport.notify('session.child-opened', {
      sessionId,
      parentSessionId: child.parentId,
      ...(child.mode === undefined ? {} : { mode: child.mode }),
      ...(child.label === undefined ? {} : { label: child.label }),
      ...(child.cwd === undefined ? {} : { cwd: child.cwd }),
    });
    const buffered = child.buffered;
    child.buffered = [];
    for (const frame of buffered) {
      if (frame.kind === 'event') {
        // Held frames skipped the live stamp above, so they get it here, on the
        // way out, exactly once.
        this.transport.notify('session.event', {
          sessionId,
          event: withImageHostPaths(this.ctx, frame.event),
        });
      } else this.transport.notify('session.status', { sessionId, status: frame.status });
    }
  }

  /** Whether this server owns the live agent behind a session id. */
  owns(sessionId) {
    return this.sessions.has(sessionId) || this.sessionCreations.has(sessionId);
  }

  /**
   * Fold one transient assistant frame into a throttled, growing snapshot.
   *
   * Only sessions this bridge drives are forwarded: a root it owns, or a child
   * it has already announced to Paseo (so a snapshot never arrives before the
   * `session.child-opened` that gives it a home). An internal agent — a title
   * or compaction helper — is not Paseo's to show.
   */
  acceptAssistantStream(agent, frame) {
    if (frame === null || typeof frame !== 'object') return;
    const sessionId = String(agent.session.id);
    if (!this.owns(sessionId) && this.children.get(sessionId)?.opened !== true) return;

    if (frame.type === 'start') {
      if (typeof frame.turn !== 'number' || typeof frame.step !== 'number') return;
      // One turn/step can be attempted more than once: DSH retries a failed
      // request inside the same step, and each attempt starts a fresh frame
      // series with its own `attemptId`. The assembler is reset here (correctly
      // — the plugin must not see attempt 1's text prepended to attempt 2's),
      // but the *item id* the plugin derives from turn/step alone cannot tell
      // the two apart, so a growing snapshot of attempt 2 would be appended to
      // attempt 1's row by Paseo's prefix rule and the answer would read as
      // gibberish. Passing the attempt through is what lets the plugin suffix
      // it; `frame.attemptId` is DSH's own identity for the attempt
      // (`LlmAttemptId`, unique within the agent's lifecycle).
      this.assistantStreams.set(sessionId, {
        assembler: new BlockAssembler(),
        turn: frame.turn,
        step: frame.step,
        ...(typeof frame.attemptId === 'string' ? { attempt: frame.attemptId } : {}),
        lastSentAt: 0,
        reasoning: '',
        text: '',
      });
      return;
    }

    const state = this.assistantStreams.get(sessionId);
    // A chunk before `start` carries no turn/step to attach it to; dropping it
    // is honest, and the durable `assistant/message` still carries the step.
    if (state === undefined) return;

    if (frame.type === 'chunk') {
      if (frame.chunk === undefined) return;
      state.assembler.push(frame.chunk);
      this.flushAssistantStream(sessionId, state, false);
      return;
    }
    if (frame.type === 'end') {
      // Force one last snapshot so the final tokens are not left behind by the
      // throttle; the durable message then contributes only the tail (usually
      // nothing, which Paseo drops rather than duplicating).
      this.flushAssistantStream(sessionId, state, true);
      this.assistantStreams.delete(sessionId);
    }
  }

  /**
   * Force the in-flight live snapshot out before its durable settlement.
   *
   * Called from the `session/event` handler when `assistant/message` is about to
   * be forwarded, so the durable copy contributes only an empty tail. Without
   * it a throttled final chunk would make the durable carry text (or reasoning)
   * Paseo had not seen, appended after the growing row, splitting the message.
   */
  flushAssistantStreamNow(sessionId) {
    const state = this.assistantStreams.get(sessionId);
    if (state !== undefined) this.flushAssistantStream(sessionId, state, true);
  }

  /** Publish the current snapshot when it grew and the cadence allows it. */
  flushAssistantStream(sessionId, state, force) {
    const now = Date.now();
    if (!force && now - state.lastSentAt < ASSISTANT_STREAM_INTERVAL_MS) return;

    let blocks;
    try {
      blocks = state.assembler.blocks();
    } catch {
      // An open block the assembler cannot render is not worth a frame; the
      // durable `assistant/message` is still complete.
      return;
    }
    const reasoning = blocks
      .filter((block) => block.type === 'reasoning')
      .map((block) => block.text)
      .join('\n');
    const text = blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    // Send only the half that changed. Paseo merges a snapshot into the previous
    // row only when they are adjacent and of the same type, so re-sending the
    // unchanged half would interleave reasoning and text rows and fragment the
    // answer; omitting it keeps each half's rows contiguous.
    const reasoningChanged = reasoning !== state.reasoning;
    const textChanged = text !== state.text;
    if (!reasoningChanged && !textChanged) return;
    state.lastSentAt = now;
    state.reasoning = reasoning;
    state.text = text;
    if (text === '' && reasoning === '') return;

    this.transport.notify('session.event', {
      sessionId,
      event: {
        type: ASSISTANT_DELTA_EVENT,
        data: {
          turn: state.turn,
          step: state.step,
          // Present only when DSH named the attempt. A bridge that cannot name
          // it must not invent one: the plugin treats an absent field as "the
          // first and only attempt" and keeps its old id, which is what an older
          // bridge means by sending this frame at all.
          ...(state.attempt === undefined ? {} : { attempt: state.attempt }),
          ...(reasoningChanged ? { reasoning } : {}),
          ...(textChanged ? { text } : {}),
        },
      },
    });
  }

  /**
   * The route the profile itself configured, used when neither the caller nor
   * the constructor named one. Undefined when no default-model service is
   * composed, which callers must treat as an error rather than guess around.
   */
  profileDefault() {
    try {
      const selection = this.ctx.get('agentDefaultModel')?.currentSelection?.();
      if (typeof selection?.provider === 'string' && typeof selection?.model === 'string') return selection;
    } catch {
      /* the deployment composes no default-model service */
    }
    return undefined;
  }

  /**
   * Keep {@link sessionCwd}, {@link sessionRoutes} and
   * {@link initializedSessions} bounded, and keep their key sets identical.
   *
   * Called with the id `initialize` just wrote. The three tables are re-inserted
   * first so eviction order is least-recently-initialized rather than
   * first-ever-seen: a session re-initialized after a rewind (same DSH id, new
   * provider session id) is exactly the one a parked process is about to resume,
   * and it must not be the entry dropped. Then the oldest keys beyond
   * {@link MAX_SESSION_ROUTE_ENTRIES} are removed from all three at once — a
   * surviving `initializedSessions` entry whose route was evicted would let a
   * prompt run on another session's process defaults, the cross-talk this
   * refactor removes.
   *
   * **Only sessions this bridge has seen close are evicted, and that ordering is
   * the whole point.** The old predicate was "not live and not mid-creation",
   * which looks equivalent and is not: a session that was opened (so it
   * initialized, in the documented order) but has not prompted yet is in neither
   * `sessions` nor `sessionCreations` — its agent does not exist — and it is
   * exactly the *oldest* row once a process has served a few hundred
   * conversations. Evicting it was unrecoverable rather than "re-initialized on
   * next use": the plugin caches "this session is initialized"
   * (`dsh-process.ts` `#initializedSessions`), so it never re-sends `initialize`,
   * `prompt` refused with "not initialized", and the session could not be
   * prompted again until it was closed and reopened. {@link closedSessions} is
   * the missing distinction: an id enters it in `closeSession`, leaves it when it
   * initializes again, and only its members are eligible.
   *
   * The cap still holds unconditionally. When there are not enough closed rows
   * to satisfy it (a client that opened more than the cap and closed none), the
   * overflow is taken from the remaining rows oldest-first — the bound matters
   * more than the preference — and every id dropped that way is named in the log,
   * because those are the ones the plugin must re-initialize to use.
   *
   * @param {string} keep - id of the session just initialized.
   */
  #trimSessionRouteTables(keep) {
    const route = this.sessionRoutes.get(keep);
    if (route !== undefined) {
      this.sessionRoutes.delete(keep);
      this.sessionRoutes.set(keep, route);
    }
    const keepCwd = this.sessionCwd.get(keep);
    if (keepCwd !== undefined) {
      this.sessionCwd.delete(keep);
      this.sessionCwd.set(keep, keepCwd);
    }
    if (this.initializedSessions.has(keep)) {
      this.initializedSessions.delete(keep);
      this.initializedSessions.add(keep);
    }
    // A session that just initialized is in use, so it is no longer a close
    // candidate: leaving it here would let its own close order make it evictable
    // while the caller that just initialized it is about to prompt.
    this.closedSessions.delete(keep);
    let excess = this.sessionRoutes.size - MAX_SESSION_ROUTE_ENTRIES;
    if (excess <= 0) return;

    /** Forget one row from all three tables. @param {string} key */
    const drop = (key) => {
      this.sessionRoutes.delete(key);
      this.sessionCwd.delete(key);
      this.initializedSessions.delete(key);
      this.closedSessions.delete(key);
    };

    let droppedClosed = 0;
    for (const key of [...this.closedSessions]) {
      if (droppedClosed >= excess) break;
      if (key === keep) continue;
      // Closed and untouched by a resume since: this is the parked tail the cap
      // exists for, and the plugin re-initializes it on its next attach.
      if (this.sessions.has(key) || this.sessionCreations.has(key)) continue;
      drop(key);
      droppedClosed += 1;
    }
    if (droppedClosed > 0) {
      process.stderr.write(
        `[bridge] dropped ${String(droppedClosed)} closed session route/cwd/initialized entr(y/ies) `
        + `(cap ${String(MAX_SESSION_ROUTE_ENTRIES)})\n`,
      );
    }

    excess = this.sessionRoutes.size - MAX_SESSION_ROUTE_ENTRIES;
    if (excess <= 0) return;
    // Hard bound, softer candidate set. Reaching here means more than the cap is
    // open-but-unclosed, which no well-behaved client does; the alternative
    // (growing without bound in a process that outlives every conversation) is
    // worse. Naming the ids is what makes the consequence — each one must
    // `initialize` again, which the plugin does on the next gate refusal —
    // diagnosable instead of looking like a session that mysteriously will not
    // prompt.
    const overflow = [];
    for (const key of [...this.sessionRoutes.keys()]) {
      if (overflow.length >= excess) break;
      if (key === keep) continue;
      if (this.sessions.has(key) || this.sessionCreations.has(key)) continue;
      overflow.push(key);
    }
    for (const key of overflow) drop(key);
    // Prune close markers whose row is already gone (an id closed twice, or
    // dropped by the pass above): without this the set would keep ids the three
    // tables no longer hold and drift away from them.
    for (const key of [...this.closedSessions]) {
      if (!this.sessionRoutes.has(key)) this.closedSessions.delete(key);
    }
    if (overflow.length > 0) {
      process.stderr.write(
        `[bridge] dropped ${String(overflow.length)} OPEN (unclosed) session route/cwd/initialized entr(y/ies) `
        + `to hold the ${String(MAX_SESSION_ROUTE_ENTRIES)} cap: ${overflow.join(", ")}\n`
        + '[bridge] those sessions must `initialize` again before they can prompt; '
        + 'the plugin re-initializes them when a prompt is refused\n',
      );
    }
  }

  /**
   * The route a session composes with: what `initialize` recorded for it, and
   * the process defaults only as a fallback for the fields it did not pin.
   *
   * A complete object is always returned so `createSession` never has to merge
   * two sources itself — the merge point is here, once.
   *
   * A pinned `reasoningEffort: null` is a DELIBERATE CLEAR (`configSet` with
   * `reasoningEffort: null`), not "nothing pinned": it must answer `undefined`,
   * because falling back to the process default would resurrect the thinking
   * level the user just removed. `undefined` in the row (only pre-marker rows
   * have it) keeps the old inheritance.
   *
   * @param {string | undefined} sessionId
   * @returns {{provider: string | undefined, model: string | undefined,
   *   reasoningEffort: string | undefined, maxTokens: number | undefined}}
   */
  routeFor(sessionId) {
    const pinned = sessionId === undefined ? undefined : this.sessionRoutes.get(sessionId);
    return {
      provider: pinned?.provider ?? this.provider,
      model: pinned?.model ?? this.model,
      reasoningEffort: pinned === undefined
        ? this.reasoningEffort
        : pinned.reasoningEffort === null
          ? undefined
          : pinned.reasoningEffort ?? this.reasoningEffort,
      maxTokens: pinned?.maxTokens ?? this.maxTokens,
    };
  }

  /**
   * Validate the route and record it — for one session when `params.sessionId`
   * is present, as this process's defaults when it is not.
   *
   * The two forms are the same validation; only the destination differs. A
   * session-scoped call resolves against that session's own previously pinned
   * route (falling back to the process defaults), so re-initializing a session
   * with just a `cwd` keeps its route instead of silently adopting whatever
   * another session last pinned process-wide.
   *
   * No idempotence conflict: several sessions each send their own `initialize`
   * with a different `sessionId`, which is how one process serves many Paseo
   * sessions at once.
   */
  async initialize(params) {
    if (params.cwd === undefined) throw new TypeError('initialize requires cwd');
    if (params.reasoningEffort !== undefined) effortOf(params.reasoningEffort);
    const cwd = resolve(params.cwd);
    const sessionId = params.sessionId === undefined || params.sessionId === null
      ? undefined
      : String(params.sessionId);
    const fallback = this.profileDefault();
    const pinned = sessionId === undefined ? undefined : this.sessionRoutes.get(sessionId);
    // The session's own route outranks the process defaults: they are the
    // values some OTHER session pinned, and inheriting them here is precisely
    // the cross-talk this refactor removes.
    const provider = params.provider ?? pinned?.provider ?? this.provider ?? fallback?.provider;
    const model = params.model ?? pinned?.model ?? this.model ?? fallback?.model;
    if (provider === undefined || model === undefined) {
      throw new Error('no provider/model was given and this profile configures no default model');
    }
    // `null` in the row means "this session explicitly cleared its thinking
    // level" (see `routeFor`); re-inheriting here would undo that clear on the
    // next reconnect, when the plugin re-sends `initialize` without an effort.
    let reasoningEffort;
    if (params.reasoningEffort !== undefined) {
      reasoningEffort = effortOf(params.reasoningEffort);
    } else if (pinned !== undefined && pinned.reasoningEffort === null) {
      reasoningEffort = undefined;
    } else {
      const inherited = pinned?.reasoningEffort ?? this.reasoningEffort;
      reasoningEffort = inherited
        ?? (fallback?.reasoningEffort === undefined ? undefined : effortOf(fallback.reasoningEffort));
    }

    if (!this.hasAdapterFor(provider)) {
      const adapter = this.options.adapters?.[provider];
      if (adapter === undefined) {
        throw new Error(
          `no adapter registered for provider "${provider}"; declare it in the profile's llm route `
          + 'or list it under the paseo-bridge `adapters` config',
        );
      }
      // Keyed by provider: two sessions on different providers each keep their
      // own fiber, and neither loses the other's dispose handle.
      if (!this.llmFibers.has(provider)) {
        const mod = await import(adapter);
        this.llmFibers.set(provider, await this.ctx.plugin(mod));
      }
    }

    const maxTokens = params.maxTokens ?? pinned?.maxTokens;
    await this.ctx.get('llm').resolveCallConfig({
      provider,
      model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
    });

    // Dead field, kept only for shape stability (see its declaration).
    this.initialized = true;
    if (sessionId === undefined) {
      this.cwd = cwd;
      this.provider = provider;
      this.model = model;
      this.reasoningEffort = reasoningEffort;
      this.maxTokens = params.maxTokens;
    } else {
      this.sessionCwd.set(sessionId, cwd);
      // `null` (not `undefined`) records "resolved to no thinking level", so a
      // later `configSet` clear and a merely-unpinned row stay distinguishable.
      this.sessionRoutes.set(sessionId, { provider, model, reasoningEffort: reasoningEffort ?? null, maxTokens });
      this.initializedSessions.add(sessionId);
      this.#trimSessionRouteTables(sessionId);
      // A reconnect can re-initialize a session whose agent is already live. The
      // route table is what `routeFor` answers with, so leaving the agent on its
      // old selection would make the bridge's own state disagree with the agent
      // it is describing — and `paseo/usage` prices against the selection.
      // Mutating the existing ref (rather than replacing it) keeps the listeners
      // `installModelSelection` installed pointing at the same object.
      const control = this.controls.get(sessionId);
      if (control !== undefined) {
        control.selection.current = {
          provider,
          model,
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        };
      }
    }
    return {
      serverInfo: { name: 'deepseek-harness-paseo-bridge', version: '0.1.0' },
      route: { provider, model, reasoningEffort: reasoningEffort ?? null },
    };
  }

  /**
   * Queue one identified prompt for a session, creating its agent on first use.
   *
   * The receipt carries `sourceKind` as an OPTIONAL addition to the SDK-shaped
   * `{ messageId }` reply: the producer kind the `user/message` event for this
   * prompt carries (`{ messageId, sourceKind? }`), so the plugin can report a
   * host-injected message as injected context instead of as a user bubble. It is
   * the same `source` object handed to `createUserMessage`, i.e. exactly
   * `event.data.source.kind` of the DSH event this call appends — today `'user'`
   * for anything the human authored and `'paseo'` for Paseo's own
   * `<paseo-system>` envelopes (see `paseo-system-envelope.js`); Paseo's
   * `kind="user-message"` wrapper quotes human text and stays `'user'`.
   *
   * A consumer that predates the field sees the old reply unchanged, and a
   * consumer reading it treats a missing `sourceKind` as `'user'` — there is no
   * other producer that could have sent the prompt without the bridge seeing it.
   */
  async prompt(params) {
    // Per session, not per process: a process-wide gate let a session that had
    // never initialized run on another session's route without saying so.
    const sessionId = String(params.sessionId);
    if (!this.initializedSessions.has(sessionId)) {
      // The `initialize`-required marker is a stable protocol token, not prose:
      // the route tables are bounded, so an id can legitimately lose its row (see
      // `#trimSessionRouteTables`) while the plugin's own cache still says
      // "initialized". The plugin keys its one-shot self-heal on this substring
      // (`dsh-process.ts` `#isNotInitializedError`), which is what lets a prompt
      // recover without the user closing and reopening the session. Keep the
      // token and the explanation on one line so both readers agree.
      throw new Error(
        `paseo bridge is not initialized for session ${sessionId}; `
        + 'send `initialize` with this sessionId before prompting',
      );
    }
    const rec = await this.getOrCreateSession(sessionId);
    this.assertLiveAgent(rec, params.sessionId);
    const content = await durablePromptContent(this.ctx, params.contentBlocks ?? []);
    this.assertLiveAgent(rec, params.sessionId);
    // The exact value `append('user/message', …)` will record as its
    // `source.kind` — computed once so the receipt cannot disagree with the log.
    const source = promptSource(content);
    const message = createUserMessage({ content, source });
    // A steer belongs inside the turn already running; a plain prompt starts the
    // next one. Without this distinction an interjection queues behind the very
    // turn it was meant to correct.
    if (params.delivery === 'steer') rec.handle.agent.steer(message);
    else rec.handle.agent.followup(message);
    return { messageId: String(message.id), sourceKind: String(source.kind) };
  }

  /**
   * Cancel the running turn while keeping the session and its history alive, so
   * the conversation can continue afterwards.
   */
  async cancel(params) {
    const rec = this.requireSession(params.sessionId);
    rec.handle.agent.cancel({ kind: 'user' });
    return { canceled: true };
  }

  /** Report the mounted plan state for one session, or the queued intent before it exists. */
  async planGet(params) {
    const planMode = this.ctx.get('planMode');
    if (planMode === undefined) return { available: false, active: false, pending: false };
    const rec = this.sessions.get(params.sessionId);
    if (rec === undefined) {
      // Per session: a single boolean answered "plan is on" for EVERY session
      // in the process as soon as one of them queued it.
      return {
        available: true,
        active: this.pendingPlanMode.get(params.sessionId) === true,
        pending: false,
      };
    }
    this.assertLiveAgent(rec, params.sessionId);
    const state = planMode.get(rec.handle.agent);
    return { available: true, active: state.active === true, pending: state.pending === true };
  }

  /** Select plan mode for one session, queueing the intent until its agent exists. */
  async planSet(params) {
    const planMode = this.ctx.get('planMode');
    if (planMode === undefined) throw new Error('plan mode is not mounted in this profile');
    const active = params.active === true;
    const rec = this.sessions.get(params.sessionId);
    if (rec === undefined) {
      this.pendingPlanMode.set(params.sessionId, active);
      return { available: true, active, pending: false, outcome: 'queued' };
    }
    this.assertLiveAgent(rec, params.sessionId);
    const outcome = planMode.set(rec.handle.agent, active);
    const state = planMode.get(rec.handle.agent);
    return {
      available: true,
      active: state.active === true,
      pending: state.pending === true,
      outcome,
    };
  }

  /**
   * Mutate the per-agent route, or queue the change for a session whose agent
   * does not exist yet.
   *
   * The queued form writes {@link sessionRoutes} for THAT session and never the
   * process defaults: before the split, switching a model on a session that had
   * not created its agent yet rewrote the defaults every later session would
   * inherit, so a pick made in one composer silently re-routed the next one.
   */
  async configSet(params) {
    if (typeof params.preset === 'string' && params.preset !== '') {
      await this.setPreset(params.sessionId, params.preset);
    }
    const rec = this.sessions.get(params.sessionId);
    if (rec === undefined) {
      // Merge into the route `initialize` pinned for THIS session. A session
      // that never initialized has no route of its own, and `routeFor` would
      // answer with the PROCESS defaults — which are allowed to be empty
      // (`this.provider` / `this.model` are unset until some route is pinned).
      // Writing that answer back as a "complete" row snapshotted values this
      // session never pinned, and the visible damage was the thinking level: an
      // explicit clear (the plugin sends `reasoningEffort: null`) was stored as
      // `undefined`, which `routeFor` then read as "not pinned" and answered
      // with the process default — the clear silently came back. The pinned row
      // is the only place a clear can survive as `null`, so refuse rather than
      // invent a row. `paseo/config/set` from the plugin always follows the
      // session's own `initialize`, so this only fires for a client that skipped
      // the documented order.
      const pinned = this.sessionRoutes.get(params.sessionId);
      if (pinned === undefined) {
        throw new Error(
          `paseo/config/set for session ${params.sessionId} arrived before initialize pinned its route; `
          + 'send initialize with this sessionId before changing its model',
        );
      }
      const next = {
        provider: typeof params.provider === 'string' ? params.provider : pinned.provider,
        model: typeof params.model === 'string' ? params.model : pinned.model,
        // An explicit clear must be stored as `null` (see `routeFor`); only an
        // absent field keeps the pinned value.
        reasoningEffort: params.reasoningEffort !== undefined
          ? effortOf(params.reasoningEffort) ?? null
          : pinned.reasoningEffort,
        maxTokens: pinned.maxTokens,
      };
      this.sessionRoutes.set(params.sessionId, next);
      return {
        provider: next.provider,
        model: next.model,
        reasoningEffort: next.reasoningEffort ?? null,
        preset: this.currentPreset(params.sessionId),
      };
    }
    this.assertLiveAgent(rec, params.sessionId);
    const selection = rec.control.selection;
    const next = { ...(selection.current ?? {}) };
    if (typeof params.provider === 'string') next.provider = params.provider;
    if (typeof params.model === 'string') next.model = params.model;
    if (params.reasoningEffort !== undefined) {
      const effort = effortOf(params.reasoningEffort);
      if (effort === undefined) delete next.reasoningEffort;
      else next.reasoningEffort = effort;
    }
    if (next.provider === undefined || next.model === undefined) {
      throw new Error('model selection requires both provider and model');
    }
    selection.current = next;
    // Mirror the selection into the pinned route. `routeFor` and a reconnect's
    // `initialize` answer from that row, so leaving it behind would undo a live
    // clear (and any other switch) the next time the session is re-initialized —
    // after a close, a parked resume, or a daemon restart. `maxTokens` is not
    // part of the live selection and is carried over unchanged.
    const pinned = this.sessionRoutes.get(params.sessionId);
    if (pinned !== undefined) {
      this.sessionRoutes.set(params.sessionId, {
        provider: next.provider,
        model: next.model,
        reasoningEffort: next.reasoningEffort ?? null,
        maxTokens: pinned.maxTokens,
      });
    }
    return {
      ...next,
      reasoningEffort: next.reasoningEffort ?? null,
      preset: this.currentPreset(params.sessionId),
    };
  }

  /** The preset a session runs (chosen, else the stored projection, else default). */
  currentPreset(sessionId) {
    const service = this.ctx.get('agentPresets');
    if (service === undefined) return null;
    // A preset chosen or applied in this process is authoritative: the session
    // projection folds the selection event asynchronously, so reading it right
    // after a switch would still show the previous value.
    const chosen = this.pendingPresets.get(sessionId);
    if (chosen !== undefined) return chosen;
    const rec = this.sessions.get(sessionId);
    if (rec !== undefined) {
      try {
        const stored = this.ctx.get('sessionProjections')?.stateOf(rec.handle.agent.session, 'agentPreset');
        if (stored !== undefined) return stored;
      } catch {
        /* projection unavailable; fall through to the default value */
      }
    }
    return service.defaultId ?? null;
  }

  /**
   * Resolve one preset id, dropping a queued choice that can never succeed.
   *
   * `agentPresets.resolve` throws for an unknown id (`agent-preset/not-found`)
   * and reports an unusable declaration through `broken`. A queued id is not
   * validated anywhere else, so a stale one — a preset removed or renamed
   * between the composer's catalog read and the session's creation — used to
   * make every later creation attempt throw the same error: the Paseo session
   * was unopenable for the rest of the process's life. Dropping the queue on the
   * two terminal failures turns that into one readable failure; the next attempt
   * then composes the stored header's preset (or the default) instead of failing
   * forever. A transient failure keeps the choice, because retrying may work.
   *
   * @param {string} sessionId
   * @param {string | undefined} id - requested preset, or undefined for the default.
   * @returns {Promise<string>} the resolved preset id.
   */
  async resolvePreset(sessionId, id) {
    const service = this.ctx.get('agentPresets');
    if (service === undefined) throw new Error('agent presets are not mounted in this profile');
    let resolved;
    try {
      resolved = await service.resolve(id);
    } catch (error) {
      // Only the terminal failure drops the queued choice: retrying an id the
      // registry does not declare can never succeed, while a transient failure
      // (a diagnostic that could not settle yet) must not throw the user's
      // selection away. The code is matched structurally, like DSH's own
      // `remoteErrorOf`, so a cross-bundle copy of the error still counts.
      if (error?.isDSHRemoteError === true && error.code === 'agent-preset/not-found') {
        this.pendingPresets.delete(sessionId);
      }
      throw error;
    }
    if (resolved.broken !== undefined) {
      this.pendingPresets.delete(sessionId);
      throw new Error(`agent preset "${resolved.id}" cannot be used: ${resolved.broken}`);
    }
    return resolved.id;
  }

  /**
   * The agent preset a stored Session was created with, read from its durable
   * header.
   *
   * A Session being resumed is not live yet — that is *why* creation failed with
   * "already exists" — and `sessions.get` answers only for live Sessions, so
   * reading the preset there always produced `undefined` and the resume silently
   * composed the default. The durable header is the same source the
   * `agentPreset` projection seeds itself from
   * (`init: (header) => header.agentPreset ?? null`, dsh-agent-preset-registry),
   * so mounting this id keeps the composition, the projection and the log
   * agreeing.
   *
   * @param {string} sessionId
   * @returns {Promise<string | undefined>}
   */
  async storedAgentPreset(sessionId) {
    const persistence = this.ctx.get('sessionPersistence');
    if (persistence === undefined) return undefined;
    try {
      const snapshot = await persistence.stat(sessionId);
      const preset = snapshot?.header?.agentPreset;
      return typeof preset === 'string' && preset !== '' ? preset : undefined;
    } catch (error) {
      // An unreadable header is not "no preset"; say so, then let the resume
      // compose the default rather than failing the whole open.
      process.stderr.write(
        `[bridge] could not read the stored agent preset for ${sessionId}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return undefined;
    }
  }

  /**
   * Choose a session's agent preset. Before the agent exists the choice is
   * queued (after it has been resolved, so a stale id fails here rather than at
   * every later session creation); once it does, DSH's `select` applies it — and
   * refuses once the session's first turn has started, which is the lock the
   * composer must honor.
   */
  async setPreset(sessionId, id) {
    const resolved = await this.resolvePreset(sessionId, id);
    const rec = this.sessions.get(sessionId);
    if (rec === undefined) {
      this.pendingPresets.set(sessionId, resolved);
      return;
    }
    this.assertLiveAgent(rec, sessionId);
    const service = this.ctx.get('agentPresets');
    if (service === undefined) throw new Error('agent presets are not mounted in this profile');
    const applied = await service.select(rec.handle.agent, resolved);
    const target = applied ?? resolved;
    this.pendingPresets.set(sessionId, target);
    // Durable record of the switch. `select` itself logs nothing ("nothing is
    // logged or announced" in the registry contract) and the `agentPreset`
    // projection only folds this log-only event — plus the creation header — so
    // without it a cold reopen would compose the creation preset again. The
    // shape and the placement mirror the official session controller's
    // `reuseSetup`: `session.append('agent-preset/selected', { agentPreset })`,
    // log-only (no `surfaceOp`) and legal outside a turn, which is where the
    // controller appends it (before publication).
    let projected;
    try {
      projected = this.ctx.get('sessionProjections')?.stateOf(rec.handle.agent.session, 'agentPreset');
    } catch {
      projected = undefined;
    }
    if (projected !== target) {
      rec.handle.agent.session.append('agent-preset/selected', { agentPreset: target });
    }
  }

  /** Report the configured agent presets and the one this session runs. */
  async presets(params) {
    const service = this.ctx.get('agentPresets');
    if (service === undefined) return { available: false, presets: [], current: null, default: null };
    const list = await service.list();
    return {
      available: true,
      default: service.defaultId ?? null,
      current: this.currentPreset(params.sessionId),
      presets: list.map((preset) => ({
        id: preset.id,
        ...(preset.name === undefined ? {} : { name: preset.name }),
        ...(preset.description === undefined ? {} : { description: preset.description }),
        ...(preset.broken === undefined ? {} : { broken: preset.broken }),
      })),
    };
  }

  /**
   * DSH's registry-global archive set, as strings. An unreadable registry
   * yields an empty set: callers then filter nothing, which is the honest
   * answer when the state cannot be read.
   *
   * "Honest" is not "silent". An empty set means every session is treated as
   * unarchived, so `paseo/subagents` re-announces archived children, the plugin
   * replays them, and the user sees a subagent they archived come back — with
   * nothing on stderr to explain it. The three ways to get here are different
   * facts and each says so; the *strategy* stays put, because the alternative
   * (treating everything as archived) would empty the session list, a worse
   * failure in the same place. "This profile composes no such service" is a
   * standing property, so it is reported once per process (see
   * {@link reportMissingService}); the two failure paths are events and are
   * reported every time.
   */
  #archivedSessionIds() {
    let registry;
    try {
      registry = this.ctx.get('workspaceRegistry');
    } catch (error) {
      process.stderr.write(
        `[bridge] looking up DSH's workspace registry failed; treating every session as unarchived `
        + `(archived subagents may be re-announced): ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return new Set();
    }
    if (registry === undefined) {
      reportMissingService(
        'workspaceRegistry',
        '[bridge] this DSH profile composes no workspace registry; treating every session as unarchived '
        + '(archived subagents may be re-announced)\n',
      );
      return new Set();
    }
    try {
      return new Set([...registry.archivedSessionIds].map(String));
    } catch (error) {
      process.stderr.write(
        `[bridge] reading DSH's archived-session set failed; treating every session as unarchived `
        + `(archived subagents may be re-announced): ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return new Set();
    }
  }

  /**
   * Durable headers for every Session this runtime can see, keyed by id.
   *
   * The archive-lineage rule walks `origin: 'subagent'` + `parentSession`
   * through headers, and a descendant's ancestors are usually NOT live (they
   * settled), so stored snapshots are what make the walk reach the root. Live
   * headers are layered on top because DSH's own gate reads the live object.
   *
   * Both sources are optional peers and a missing one only narrows the walk.
   * Missing and unreadable are still reported apart, for the same reason as
   * {@link #archivedSessionIds}: a narrower walk answers "not archived" for
   * sessions whose stored header it never saw, which is indistinguishable from
   * the truth unless someone says otherwise. The standing "not composed" facts
   * go through {@link reportMissingService} (once per process); a throwing
   * lookup or read is reported every time.
   */
  async #sessionHeaders() {
    const headers = new Map();
    let persistence;
    try {
      persistence = this.ctx.get('sessionPersistence');
    } catch (error) {
      process.stderr.write(
        `[bridge] looking up DSH's session persistence failed; the archived-session walk sees only live `
        + `sessions: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      persistence = undefined;
    }
    if (persistence === undefined) {
      reportMissingService(
        'sessionPersistence',
        '[bridge] this DSH profile composes no session persistence; the archived-session walk sees only '
        + 'live sessions (archived subagents may be re-announced)\n',
      );
    } else {
      try {
        for (const snapshot of await persistence.list()) {
          const header = snapshot?.header;
          if (header?.id !== undefined) headers.set(String(header.id), header);
        }
      } catch (error) {
        process.stderr.write(
          `[bridge] listing stored session headers failed; the archived-session walk keeps only what it `
          + `already has (archived subagents may be re-announced): ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
    let sessions;
    try {
      sessions = this.ctx.get('sessions');
    } catch (error) {
      process.stderr.write(
        `[bridge] looking up DSH's live session service failed; the archived-session walk keeps only stored `
        + `headers: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      sessions = undefined;
    }
    if (sessions !== undefined) {
      try {
        for (const session of sessions.list()) {
          const header = session?.header;
          if (header?.id !== undefined) headers.set(String(header.id), header);
        }
      } catch (error) {
        process.stderr.write(
          `[bridge] listing live session headers failed; the archived-session walk keeps only stored headers: `
          + `${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
    return headers;
  }

  /**
   * List the DSH sessions a user can import into Paseo. Reads the persistence
   * backend directly: the session-query corpus is not mounted for listing here
   * (`openAt: never`), and it hangs rather than answering. Titles are
   * best-effort; a missing title never hides an importable session.
   *
   * A failed read is `available: false` + `error`, never an empty list: "there
   * are no sessions to import" and "the store could not be read" look identical
   * in the import dialog, and only one of them is true (`history()` and
   * `subagents()` answer the same failure the same way).
   */
  async listSessions(params = {}) {
    const persistence = this.ctx.get('sessionPersistence');
    if (persistence === undefined) return { available: false, sessions: [] };
    let snapshots;
    try {
      snapshots = await persistence.list();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[bridge] listing stored sessions failed: ${message}\n`);
      return { available: false, sessions: [], error: { message } };
    }
    const query = typeof params.query === 'string' && params.query !== '' ? params.query.toLowerCase() : undefined;
    const cwdFilter = typeof params.cwd === 'string' && params.cwd !== '' ? params.cwd : undefined;
    const candidates = [];
    // DSH's archive state is authoritative and Paseo's session summary has no
    // field for it (`ProviderSessionSummary` is persistence/cwd/title/description/
    // updatedAt), so the only honest way to mirror it is to leave archived
    // sessions out — which is also DSH's own default view ("隐藏已归档").
    // The rule is DSH's lineage one, not exact membership: a subagent session
    // whose root is archived is hidden with it, exactly as the gate blocks it.
    const archived = this.#archivedSessionIds();
    const headers = new Map(
      snapshots
        .filter((snapshot) => snapshot?.header?.id !== undefined)
        .map((snapshot) => [String(snapshot.header.id), snapshot.header]),
    );
    for (const snapshot of snapshots) {
      const id = snapshot?.header?.id === undefined ? undefined : String(snapshot.header.id);
      if (id === undefined || id === '') continue;
      if (underArchivedSession(headers, archived, id)) continue;
      if (cwdFilter !== undefined && snapshot.header.cwd !== cwdFilter) continue;
      if (query !== undefined && !id.toLowerCase().includes(query)) continue;
      candidates.push(snapshot);
    }
    candidates.sort((a, b) => (b.header.createdAt ?? 0) - (a.header.createdAt ?? 0));
    const limit = typeof params.limit === 'number' && params.limit > 0 ? params.limit : 40;
    const picked = candidates.slice(0, limit);
    // A title and a first-message preview make sessions distinguishable; both
    // come from the log prefix, read concurrently so a long list stays quick.
    const summaries = await Promise.all(picked.map((snapshot) => this.#sessionSummary(persistence, snapshot)));
    return { available: true, sessions: summaries };
  }

  /** Read one session's log prefix for its title and first user message. */
  async #sessionSummary(persistence, snapshot) {
    const id = String(snapshot.header.id);
    const row = {
      sessionId: id,
      ...(snapshot.header.cwd === undefined ? {} : { cwd: snapshot.header.cwd }),
      ...(snapshot.header.createdAt === undefined
        ? {}
        : { updatedAt: new Date(snapshot.header.createdAt).toISOString() }),
    };
    let handle;
    try {
      handle = await withTimeout(persistence.open(id, 'read'), 10000, 'opening session summary');
      const result = await withTimeout(handle.read(0, 200), 10000, 'reading session summary');
      let title;
      let preview;
      for (const event of result.events ?? []) {
        if (event.type === 'session/title' && typeof event.data?.title === 'string' && event.data.title !== '') {
          title = event.data.title;
        }
        if (preview === undefined && event.type === 'user/message' && event.data?.source?.kind === 'user') {
          const text = (event.data.content ?? [])
            .filter((block) => block?.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
          if (text !== '') preview = text.slice(0, 120);
        }
      }
      if (typeof title === 'string' && title !== '') row.title = title;
      if (typeof preview === 'string' && preview !== '') row.preview = preview;
    } catch {
      /* A session that will not read is still listed, just without a summary. */
    } finally {
      try {
        await handle?.close();
      } catch {
        /* idempotent close */
      }
    }
    return row;
  }

  /**
   * Read one stored session's raw event log, for replay into a Paseo timeline.
   * Read-only, so it works while a live agent still owns the session.
   */
  async history(params) {
    const persistence = this.ctx.get('sessionPersistence');
    if (persistence === undefined) return { available: false, events: [], inheritedEventCount: 0 };
    let handle;
    try {
      // A session mid-write can stall a read; bound it so a stuck read never
      // stalls the session open that asked for the replay.
      handle = await withTimeout(persistence.open(params.sessionId, 'read'), 15000, 'opening session history');
    } catch (error) {
      // A session that was never materialized has no history, and an empty list
      // is the honest answer for it. A stalled open is a different fact.
      if (isTimeout(error)) return unavailableHistory(error);
      // A session that never materialized has no history; anything else is a real
      // read failure and must be visible (a silently empty replay is
      // indistinguishable from "the conversation is gone").
      if (error instanceof Error && error.name.includes("NotFound")) {
        return { available: true, events: [], inheritedEventCount: 0 };
      }
      // Failing to open a log that should exist is not "this session has no
      // history": returning an empty list here would replay as a blank
      // conversation with the real reason only in this process's stderr.
      process.stderr.write(`[bridge] history read failed for ${params.sessionId}: ${error instanceof Error ? error.message : String(error)}\n`);
      return unavailableHistory(error);
    }
    try {
      const result = await withTimeout(handle.read(), 15000, 'reading session history');
      // `inheritedEventCount` is the fork-inherited prefix length: a caller
      // replaying a child must start after it, or a forked child re-shows its
      // parent's conversation as its own.
      const inheritedEventCount =
        typeof handle.inheritedEventCount === 'number' && handle.inheritedEventCount > 0
          ? handle.inheritedEventCount
          : 0;
      return {
        available: true,
        inheritedEventCount,
        // The replay path Paseo rebuilds a reopened session from. Folded to the
        // visible surface first: a rewind appends a replace operation rather than
        // deleting events, so replaying the raw log would resurrect exactly what
        // the user just removed — which is what Paseo's post-rewind re-hydrate
        // showed. Images are stamped here too — the source file a tool read is
        // usually gone by reopen time, and only the attachment's host path still
        // resolves.
        events: historyEvents(this.ctx, visibleEvents(result.events ?? [])),
      };
    } catch (error) {
      // The open succeeded, so this log exists; failing to read it is never
      // "this session has no history".
      return unavailableHistory(error);
    } finally {
      try {
        await handle.close();
      } catch {
        /* handle close is idempotent; a failure here must not mask the read */
      }
    }
  }

  /**
   * List the subagent children reachable from one session, for rebuilding the
   * tree on replay. Reads DSH's own durable catalog through
   * `subagents.listDescendants`, which excludes fork-inherited facts and never
   * loads or resumes a child Agent.
   *
   * Failure is never disguised as an empty tree: a missing service returns
   * `available: false`; a failed read returns `available: false` with `error`;
   * and unreadable catalog branches (unknown modes, corrupt/unavailable child
   * logs) are returned in `diagnostics`.
   */
  /**
   * Archive or unarchive one DSH session in DSH's own registry.
   *
   * Archiving is a first-class DSH concept (`workspaceRegistry.archiveSession`
   * and `archivedSessionIds`), and Paseo maps its archive action onto a
   * provider's *native* archive rather than keeping a private flag — its own
   * opencode adapter does exactly that in `setNativeSessionArchived`. So this is
   * a translation, not a local mark.
   *
   * An active session must be stopped first, which is what `stopActivity` asks
   * the registry to do; without it the registry refuses with
   * `WorkspaceActiveSessionError`. A refusal is reported as `available: false`
   * with the message, never as success — an archive that quietly does nothing is
   * the bug this replaces.
   */
  async applyArchived(params = {}, archived) {
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
    const what = archived ? 'paseo/archive' : 'paseo/unarchive';
    if (sessionId === '') return { available: false, error: { message: `${what} requires a sessionId` } };
    const registry = this.ctx.get('workspaceRegistry');
    if (registry === undefined) {
      return { available: false, error: { message: 'this DSH runtime composes no workspace registry' } };
    }
    try {
      if (archived) await registry.archiveSession(sessionId, { stopActivity: true });
      else await registry.unarchiveSession(sessionId);
    } catch (error) {
      return { available: false, error: { message: error instanceof Error ? error.message : String(error) } };
    }
    return { available: true };
  }

  async subagents(params) {
    const subagents = this.ctx.get('subagents');
    if (subagents === undefined) return { available: false, subagents: [] };
    if (typeof params.sessionId !== 'string' || params.sessionId === '') {
      return { available: false, subagents: [], error: { message: 'subagents requires a sessionId' } };
    }
    // DSH's own archive state, so a replayed child that was archived is not
    // announced again: Paseo drops what the provider stops reporting, and
    // re-announcing it is exactly what resurrected an archived subagent.
    // The lineage rule matters here too — archiving a root archives its whole
    // subagent tree as far as DSH's gate is concerned, so the replay must skip
    // descendants whose own id was never added to the set.
    const archived = this.#archivedSessionIds();
    const headers = await this.#sessionHeaders();
    try {
      const rows = await subagents.listDescendants(params.sessionId);
      return {
        available: true,
        subagents: rows
          .filter((row) => row.kind === 'child')
          .map((row) => ({
            sessionId: String(row.id),
            parentSessionId: String(row.parentId),
            ...(row.mode === undefined ? {} : { mode: row.mode }),
            ...(row.label === undefined ? {} : { label: row.label }),
            ...(underArchivedSession(headers, archived, String(row.id)) ? { archived: true } : {}),
          })),
        diagnostics: rows
          .filter((row) => row.kind !== 'child')
          .map((row) => ({ sessionId: String(row.id), reason: row.reason })),
      };
    } catch (error) {
      return {
        available: false,
        subagents: [],
        error: { message: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  /**
   * The slash-commands the composer may offer for one session: the registered
   * human commands plus every user-invocable skill.
   *
   * Skills ship a `userInvocable` policy precisely so a human-facing catalog can
   * advertise them next to commands, and DSH injects a skill from a bare
   * `/name` token in user input. They are not registered commands, so the two
   * are tagged and handled differently when run.
   */
  async commands(params) {
    const rec = await this.getOrCreateSession(params.sessionId);
    this.assertLiveAgent(rec, params.sessionId);
    const agent = rec.handle.agent;
    const out = [];
    const seen = new Set();
    const commands = this.ctx.get('commands');
    if (commands !== undefined) {
      for (const command of commands.list(agent)) {
        if (seen.has(command.name)) continue;
        seen.add(command.name);
        out.push({
          name: command.name,
          description: command.description,
          ...(command.input?.hint === undefined ? {} : { argumentHint: command.input.hint }),
          kind: 'command',
        });
      }
    }
    const skills = this.ctx.get('skills');
    if (skills !== undefined) {
      let list;
      try {
        // The composer's `/` menu is per project: this session's own directory,
        // resolved the same way the tools resolve it. The process default is
        // only the last resort — using it unconditionally listed the skills of
        // whichever session initialized first in every other session's menu.
        list = await skills.list({ cwd: this.sessionDirectoryFor(params.sessionId, agent), scope: agent });
      } catch {
        // A skill source that fails discovery must not take commands down with it.
        list = [];
      }
      for (const skill of list) {
        if (skill.invocation?.userInvocable !== true) continue;
        if (seen.has(skill.name)) continue;
        seen.add(skill.name);
        out.push({ name: skill.name, description: skill.description, kind: 'skill' });
      }
    }
    return { commands: out };
  }

  /**
   * Run one registered command for a session. A skill is not handled here: the
   * plugin sends its `/name` line as ordinary user input, which is how DSH's own
   * `skill` tool injects it.
   */
  async runCommand(params) {
    const rec = this.requireSession(params.sessionId);
    const commands = this.ctx.get('commands');
    if (commands === undefined) throw new Error('command registry is not mounted in this profile');
    const line = typeof params.arguments === 'string' && params.arguments.trim() !== ''
      ? `/${params.name} ${params.arguments}`
      : `/${params.name}`;
    const execution = await commands.execute(rec.handle.agent, line, [], new AbortController().signal);
    if (execution === undefined) throw new Error(`unknown command "${params.name}"`);
    return {
      kind: execution.result.kind,
      ...(execution.result.text === undefined ? {} : { text: execution.result.text }),
    };
  }

  /**
   * Settle one agent before a rewind.
   *
   * A surface replacement freezes its range when it is appended. If a turn keeps
   * producing events afterwards, they append *after* the replacement node and
   * stay visible — the withdrawn content "comes back". DSH's own rewind plugin
   * settles the agent the same way: cancel the running turn, wait for idle, then
   * drop the work queued for the withdrawn turn.
   *
   * BOTH inbox lists are dropped, not just steering. A queued follow-up turn
   * (`nextTurn`) wakes the driver the moment the aborted turn reaches idle, so
   * `whenIdle()` would wait for that entire extra turn: a rewind could sit on the
   * 15s bound and then fail *after* already cancelling the user's turn. Those
   * messages are not on the surface yet, i.e. they are after the target by
   * construction, so withdrawing them matches the rewind's scope.
   */
  async settleAgentForRevert(agent) {
    if (agent.status !== 'idle') agent.cancel({ kind: 'user' }, { keepInbox: true });
    // Synchronous, and before the first await: cancellation converges
    // asynchronously, so removing the queued work here is the only way to be sure
    // the driver cannot claim it while we wait for idle.
    for (const pending of [...agent.inbox.nextStep, ...agent.inbox.nextTurn]) agent.inbox.remove(pending.id);
    if (agent.status !== 'idle') {
      await withTimeout(
        agent.whenIdle(),
        15000,
        'waiting for the agent to become idle before rewinding',
      );
    }
  }

  /**
   * The newest human user message seq on a session's visible surface.
   *
   * File snapshots are grouped by this anchor: rewinding to message T restores
   * every file the agent first touched after T. Injected user-role messages
   * (Paseo envelopes, compaction checkpoints) are not user turns and must not
   * become anchors themselves.
   *
   * @param {object} session
   * @returns {number | undefined}
   */
  latestHumanAnchor(session) {
    const nodes = session.surface.nodes;
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const seq = nodes[index];
      if (isHumanUserMessage(session.eventAt(seq))) return seq;
    }
    return undefined;
  }

  /**
   * Remember which root human message dispatched a delegated session's current
   * turn.
   *
   * Called for every session event; only a child's own `turn/start` matters. A
   * fresh delegation starts its turn inside the dispatching turn, and a resumed
   * continuable child starts it while the parent's new turn is running — in both
   * cases the root's newest human message at that moment is the instruction the
   * child is executing. See `child-anchors.js`.
   *
   * @param {object} session
   * @param {{type?: string}} event
   */
  observeDelegatedTurn(session, event) {
    if (event?.type !== 'turn/start') return;
    if (!isDelegatedSession(session)) return;
    try {
      const root = this.rootSessionFor(session);
      if (root === undefined) return;
      const anchorSeq = this.latestHumanAnchor(root);
      if (anchorSeq === undefined) return;
      // The owning root is part of the anchor, not an afterthought: with several
      // sessions in one process, `12` under root A and `12` under root B are
      // different human messages, and a rewind in A must not touch B's children.
      this.childAnchors.record(session.id, anchorSeq, root.id);
    } catch (error) {
      process.stderr.write(
        `[bridge] could not record a delegated turn anchor: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  /**
   * The journal anchor for one editing tool call.
   *
   * A delegated session anchors to the turn that dispatched its current run; a
   * root session (or a child whose turn start this process never saw) anchors to
   * the root's newest human message, which is the pre-existing behavior.
   *
   * @param {object} session - the session that ran the tool.
   * @param {object} root - the root session whose journal receives the snapshot.
   * @returns {number | undefined}
   */
  snapshotAnchorFor(session, root) {
    const recorded = this.childAnchors.anchorFor(session.id);
    if (recorded !== undefined) return recorded;
    return this.latestHumanAnchor(root);
  }

  /**
   * The session a rewind can address for this tool call: the root (non-subagent)
   * ancestor of the executing session.
   *
   * A native subagent edits files from its own session, whose log a parent
   * rewind cannot address; the human rewinds the root session. Recording the
   * edit under the root — anchored to the root's newest human message at
   * execution time — is what lets the parent's `both` rewind undo it.
   *
   * Fails open: when the chain cannot be resolved (a parent session is not
   * live, a header lacks `parentSession`, or the chain loops) the edit is not
   * tracked, exactly like the pre-existing subagent skip.
   *
   * @param {object} session
   * @returns {object | undefined}
   */
  rootSessionFor(session) {
    const sessions = this.ctx.get('sessions');
    return resolveRootSession(session, (id) => sessions?.get(id));
  }

  /**
   * The directory a tracked tool's relative path resolves against.
   *
   * `header.cwd` is a session's ORIGINAL project directory, not its current one:
   * `cd`-style changes and a subagent's `cwd` argument move the effective
   * working directory (the `workingDirectory` service owns it). A snapshot must
   * resolve exactly like the tool does, or it records the wrong path — and a
   * wrong path means a rewind could act on a file the tool never touched.
   *
   * DSH's own editing tools call `workingDirectory.ensure(agent, signal)`
   * (`dsh-tool-fs`), which validates the directory and, when it has disappeared,
   * commits the recovery back to the original project before the tool runs. The
   * synchronous `get()` skips both steps, so for a session whose current
   * directory was deleted it returns the vanished path while the tool writes into
   * the recovered one. Use the same call, with the same arguments, as the tool.
   *
   * Fail-open: when resolution fails, the caller skips the snapshot rather than
   * journaling a guessed path — a wrong path is the one thing a rewind must never
   * act on, and a missing restore is already reported through the receipt.
   *
   * @param {{agent?: object, signal?: AbortSignal}} exec - the tool dispatch execution.
   * @returns {Promise<string | undefined>}
   */
  async workingDirectoryFor(exec) {
    const session = exec?.agent?.session;
    const service = this.ctx.get('workingDirectory');
    try {
      const current = await service?.ensure?.(exec.agent, exec.signal);
      if (typeof current === 'string' && current !== '') return current;
    } catch (error) {
      process.stderr.write(
        `[bridge] file snapshot skipped: cannot resolve the working directory: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return undefined;
    }
    try {
      const current = service?.get?.(session);
      if (typeof current === 'string' && current !== '') return current;
    } catch {
      /* fall back to the session's original project directory */
    }
    // Fail open: no process-wide default here. In a one-process-many-sessions
    // runtime `this.cwd` is the directory of whichever session initialized
    // first, so falling back to it would resolve a tool's relative path inside
    // ANOTHER project — and a snapshot recorded under the wrong path lets a
    // rewind act on a file the tool never touched. A skipped snapshot is
    // already reported through the rewind receipt.
    return session?.header?.cwd;
  }

  /**
   * The directory a session's project-scoped catalogs (skills) resolve against.
   *
   * Prefers the authoritative `workingDirectory` projection — the same one the
   * tools use, so `cd`-style moves are honoured — then the session's own
   * recorded cwd, then the process default. Only used for read-only discovery:
   * anything that WRITES a path goes through {@link workingDirectoryFor}, which
   * fails open instead of guessing.
   *
   * @param {string} sessionId
   * @param {object} [agent]
   * @returns {string}
   */
  sessionDirectoryFor(sessionId, agent) {
    if (agent !== undefined) {
      try {
        const current = this.ctx.get('workingDirectory')?.get?.(agent.session);
        if (typeof current === 'string' && current !== '') return current;
      } catch {
        /* the profile composes no working-directory service */
      }
    }
    const pinned = this.sessionCwd.get(sessionId);
    if (pinned !== undefined) return pinned;
    const rec = this.sessions.get(sessionId);
    const headerCwd = rec?.handle?.agent?.session?.header?.cwd;
    if (typeof headerCwd === 'string' && headerCwd !== '') return headerCwd;
    return this.cwd;
  }

  /**
   * Snapshot one file before a tracked editing tool mutates it.
   *
   * Called from `tools/execute`; never throws, because a snapshot problem must
   * not stop the agent's turn (the rewind reports a missing snapshot instead).
   *
   * The snapshot is keyed under the ROOT session: a rewind restores files by
   * reading that session's journal, so an edit made by a delegated subagent is
   * recorded against the newest human message of the conversation the user
   * actually rewinds.
   *
   * @param {{name?: string, callId?: unknown, arguments?: unknown, agent?: {session?: object}}} exec
   */
  async captureFileBeforeTool(exec) {
    try {
      const session = exec?.agent?.session;
      if (session === undefined) return;
      if (!isTrackedTool(exec)) return;
      if (exec?.callId === undefined) return;
      const rawPath = mutationPathOf(exec);
      if (rawPath === undefined) return;
      const owner = this.rootSessionFor(session);
      if (owner === undefined) {
        process.stderr.write('[bridge] file snapshot skipped: no root session for a subagent edit\n');
        return;
      }
      const anchorSeq = this.snapshotAnchorFor(session, owner);
      if (anchorSeq === undefined) return;
      // Resolve exactly like the editing tool does: `workingDirectory.ensure`
      // (validation + recovery), not the recorded value and not the header.
      const cwd = await this.workingDirectoryFor(exec);
      if (cwd === undefined) return;
      const path = resolveMutationPath(cwd, rawPath);
      const callId = String(exec.callId);
      const result = await this.fileSnapshots.capture({
        // The journal/objects belong to the root; the pending entry belongs to
        // the session that ran the tool (a parent and a child share neither the
        // callId namespace nor the commit moment).
        sessionId: String(owner.id),
        pendingKey: snapshotOwnerKey(session, callId),
        anchorSeq,
        callId,
        path,
      });
      if (result.ok) this.snapshotOwners.set(snapshotOwnerKey(session, callId), String(owner.id));
      if (result.ok && result.skipped !== undefined) {
        process.stderr.write(`[bridge] file snapshot skipped for ${path}: ${result.skipped}\n`);
      } else if (!result.ok) {
        process.stderr.write(`[bridge] file snapshot failed for ${path}: ${result.error}\n`);
      }
    } catch (error) {
      process.stderr.write(`[bridge] file snapshot hook: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  /**
   * Commit a successful tool call's pending snapshot to the owning journal.
   *
   * @param {{callId?: unknown}} exec
   * @param {{isError?: boolean}} [result]
   */
  async commitFileTool(exec, result) {
    try {
      const session = exec?.agent?.session;
      if (session === undefined || exec?.callId === undefined) return;
      const callId = String(exec.callId);
      const key = snapshotOwnerKey(session, callId);
      const owner = this.snapshotOwners.get(key);
      if (owner === undefined) return;
      this.snapshotOwners.delete(key);
      await this.fileSnapshots.commit({
        sessionId: owner,
        callId,
        pendingKey: snapshotOwnerKey(session, callId),
      }, result);
    } catch (error) {
      process.stderr.write(`[bridge] file snapshot commit: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  /**
   * Drop a pending snapshot when a tool fails or is cancelled.
   *
   * @param {{callId?: unknown}} exec
   */
  dropFileTool(exec) {
    try {
      const session = exec?.agent?.session;
      if (session === undefined || exec?.callId === undefined) return;
      const callId = String(exec.callId);
      const key = snapshotOwnerKey(session, callId);
      const owner = this.snapshotOwners.get(key);
      this.snapshotOwners.delete(key);
      if (owner === undefined) return;
      this.fileSnapshots.discard({ sessionId: owner, callId, pendingKey: snapshotOwnerKey(session, callId) });
    } catch {
      /* dropping a pending snapshot cannot fail in a way worth reporting */
    }
  }

  /**
   * Interrupt every delegated agent whose current turn this rewind withdraws.
   *
   * A child's dispatch anchor is the root human message whose turn started it
   * (see `child-anchors.js`). `targetSeq` and everything after it is being
   * withdrawn, so a child anchored at or after `targetSeq` is working on
   * instructions the user just removed: interrupt it. Children anchored earlier
   * belong to a conversation that stays, and must keep running.
   *
   * Fail-open by design: no subagent service, an unknown anchor, or a refused
   * interrupt leaves the child alone. Interrupting the wrong child kills work the
   * user kept, which is worse than a child that keeps running.
   *
   * `SubagentRuntime.interrupt` is fire-and-return: the child may still perform a
   * little work before observing the cancel signal.
   *
   * The candidate set is scoped to the root being rewound. `child-anchors.js`
   * keys anchors by (root, seq), and this call passes that root so a rewind in
   * one session cannot interrupt a sibling session's children — with one process
   * serving many sessions, an unscoped scan withdrew every child in the process
   * whose dispatch seq merely fell in range. `delegated-cancel.js` takes an
   * `{ withdrawnSince(seq) }` view, which is how the root binding stays here,
   * where the root is known, instead of being threaded through the policy module.
   *
   * @param {object} agent - the root agent (an exact live ancestor authority).
   * @param {number} targetSeq
   * @returns {string[]} child session ids the bridge signalled.
   */
  cancelWithdrawnDelegations(agent, targetSeq) {
    const subagents = this.ctx.get('subagents');
    if (subagents === undefined) return [];
    const rootSessionId = agent?.session?.id === undefined ? undefined : String(agent.session.id);
    const scopedAnchors = {
      withdrawnSince: (seq) => this.childAnchors.withdrawnSince(seq, rootSessionId),
    };
    const result = cancelDelegatedWork(
      scopedAnchors,
      targetSeq,
      (childId) => {
        subagents.interrupt(childId, { kind: 'ancestor', agent });
      },
      (childId, error) => {
        process.stderr.write(
          `[bridge] could not interrupt withdrawn subagent ${childId}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      },
    );
    if (result.signalled.length > 0) {
      process.stderr.write(
        `[bridge] interrupted ${result.signalled.length} delegated agent(s) whose dispatch turn was withdrawn\n`,
      );
    }
    return result.signalled;
  }

  /**
   * Give interrupted delegated work a bounded moment to observe the cancel.
   *
   * `SubagentRuntime.interrupt` is fire-and-return, and the file restore runs
   * right after it. `waitForChildren` joins progressing descendants (it never
   * cancels anything); the three-second cap bounds the rewind's latency. A
   * timeout is reported because files restored after it could still be written
   * by a child that had not noticed the cancel.
   *
   * @param {object} agent - the root agent whose descendants were interrupted.
   */
  async settleDelegatedWork(agent) {
    const subagents = this.ctx.get('subagents');
    if (subagents === undefined || typeof subagents.waitForChildren !== 'function') return;
    try {
      await withTimeout(
        subagents.waitForChildren(agent),
        3000,
        'waiting for delegated work to observe the rewind interrupt',
      );
    } catch (error) {
      process.stderr.write(
        `[bridge] delegated work did not settle after the rewind interrupt: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  /**
   * The oldest seq a future rewind can target in this session, or Infinity.
   *
   * A rewind target is a visible, non-first human message: the first cannot be
   * withdrawn and later targets are larger. So a future target is never below the
   * second-oldest visible human message, and journal entries anchored below that
   * seq can never be selected again. Infinity means no visible message is
   * rewindable (only the first survives) — every existing entry is unreachable,
   * because future messages get larger seqs.
   *
   * @param {object} session
   * @returns {number}
   */
  minRewindableAnchor(session) {
    const humanSeqs = [];
    for (const seq of session.surface.nodes) {
      if (isHumanUserMessage(session.eventAt(seq))) humanSeqs.push(seq);
    }
    return humanSeqs.length >= 2 ? humanSeqs[1] : Number.POSITIVE_INFINITY;
  }

  /**
   * Rewind one session to just before the user message Paseo named.
   *
   * Paseo's rewind button is capability-gated, and the token it hands back is
   * the `revertToken` our own timeline row carried (`{ messageId }`). The rewind
   * itself is a surface replacement appended to DSH's own log — the same
   * mechanism compaction uses — so the withdrawn turns leave the model's view
   * without any trace of the rewind, and nothing is deleted: the log stays the
   * durable, auditable record.
   *
   * The replacement is a `user/message` whose `source.kind` is `paseo-rewind` and
   * whose content is the literal text `(empty message)` (the marker shape and its
   * two reasons are spelled out where it is built below; note that
   * `deriveEventMessage` DOES surface it to the model as one `(empty message)`
   * user turn — `harness/revert-shape-probe.mjs` asserts exactly that, and it is
   * the accepted cost of a durable marker, not a claim that it is invisible).
   */
  async revert(params) {
    const rec = this.requireSession(params.sessionId);
    const agent = rec.handle.agent;
    const session = agent.session;
    const scope = revertScope(params.scope);
    if (scope === undefined) {
      // Never widen an unknown scope into a full rewind: that is the most
      // destructive interpretation of a request we do not understand.
      throw new Error(`不支持的回退范围：${String(params.scope)}`);
    }
    const sessionKey = String(session.id);
    if (this.revertInflight.has(sessionKey)) {
      throw new Error('该会话已有撤回正在进行，请稍候再试');
    }
    this.revertInflight.add(sessionKey);
    try {
      // Plan once before cancelling anything: a request that cannot be honoured
      // (the first human message, a stale or injected row) must not interrupt a
      // running turn. The range may move while the agent settles, so plan again
      // after it is idle and use that.
      const preliminary = planRewind(session.surface.nodes, (seq) => session.eventAt(seq), params.token);
      if (!preliminary.ok) throw new Error(preliminary.reason);
      await this.settleAgentForRevert(agent);
      const resolved = planRewind(session.surface.nodes, (seq) => session.eventAt(seq), params.token);
      if (!resolved.ok) throw new Error(resolved.reason);
      // Plan the file restore before touching the log: an unreadable journal or
      // a target outside the session must fail while the conversation is still
      // untouched. An empty plan is not an error — the agent may not have edited
      // any file since that message.
      let filePlan;
      if (restoresFiles(scope)) {
        const planned = await this.fileSnapshots.planRestore(sessionKey, resolved.targetSeq);
        if (planned.skippedLines > 0) {
          process.stderr.write(`[bridge] ${planned.skippedLines} unreadable file-snapshot journal line(s) were ignored\n`);
        }
        filePlan = planned.actions;
      }
      // The one write: a positional surface replacement, validated by DSH before
      // it is appended. The range comes from the surface snapshot planRewind
      // read, so it cannot move between planning and appending.
      const shadowed = resolved.shadowed;
      // The marker is a `user/message` with a non-`user` source kind:
      //  - the durable v4 log only admits `system`/`developer`/`assistant`
      //    messages inside an open turn+step (a rewind runs while the agent is
      //    idle, so those can never be appended here), while `user/message` has
      //    no such constraint — the same reason dsh-rewind uses one;
      //  - a non-`user` source keeps it out of every human-message path: it is
      //    not a rewind anchor, Paseo's replay skips it, and the memory plugin
      //    ignores it.
      // `deriveEventMessage` does surface it to the model as one "(empty message)"
      // turn among the kept conversation, which is the cost of a durable marker.
      const marker = createUserMessage({
        content: [{ type: 'text', text: '(empty message)' }],
        source: { kind: 'paseo-rewind' },
      });
      session.append(
        'user/message',
        marker,
        {
          surfaceOp: { op: 'replace', startSeq: shadowed[0], endSeq: shadowed[shadowed.length - 1] },
          sourceEventSeqs: [...shadowed],
        },
      );
      // Make the replacement durable before answering. The daemon does not reload
      // the session any more: right after this reply it calls
      // `hydrateTimelineFromProvider({ force: true })`, which rebuilds the Paseo
      // timeline from the history it can read — `PluginProviderSession.streamHistory()`
      // / `paseo/history` → this log. A buffered append would let that rebuild read
      // a log that still contains the withdrawn turn, so the reply must not go out
      // before the append is on disk. A failure here must be loud: reporting
      // success would let the force-hydrate restore the withdrawn conversation
      // while the file layer has already been rolled back.
      //
      // `SessionStore.flush` resolves to whether at least ONE durability listener
      // participated, not merely "no error": `false` means nothing actually
      // persisted the append (a profile composing the session store without a
      // persistence backend). Treat that as the same failure — otherwise the
      // receipt claims durability the log does not have.
      const sessions = this.ctx.get('sessions');
      if (sessions === undefined) {
        throw new Error('撤回标记无法持久化：该 profile 没有会话存储；已停止文件回退');
      }
      let durable;
      try {
        durable = await sessions.flush(session);
      } catch (error) {
        throw new Error(`撤回标记无法持久化，已停止文件回退：${error instanceof Error ? error.message : String(error)}`);
      }
      if (durable !== true) {
        throw new Error('撤回标记未获得任何持久化参与者（该 profile 未组合会话持久化后端）；已停止文件回退');
      }
      let files;
      // Stop the delegated agents this rewind withdrew before restoring files:
      // a child still working on the withdrawn instruction would otherwise keep
      // writing behind the restore (and anchor those writes to an older message,
      // leaving them impossible to revert). `interrupt` is fire-and-return, so
      // give the children a bounded moment to observe it before touching files.
      this.cancelWithdrawnDelegations(agent, resolved.targetSeq);
      await this.settleDelegatedWork(agent);
      if (filePlan !== undefined && filePlan.length > 0) {
        files = await this.fileSnapshots.restore(sessionKey, filePlan);
        if (files.failed.length > 0) {
          // Do not prune/trim/GC after a partial failure: the failed paths' backup
          // objects and journal lines are the only retry material, and dropping
          // them would make a second rewind silently no-op.
          process.stderr.write(
            `[bridge] file restore failed for ${files.failed.map((entry) => entry.path).join(', ')}; `
            + `journal kept for retry, rescue copies in ${files.rescueDir}\n`,
          );
        } else {
          await this.fileSnapshots.prune(sessionKey, resolved.targetSeq).catch((error) => {
            process.stderr.write(`[bridge] pruning the file-snapshot journal failed: ${error instanceof Error ? error.message : String(error)}\n`);
          });
          await this.fileSnapshots.trim(sessionKey, this.minRewindableAnchor(session)).catch((error) => {
            process.stderr.write(`[bridge] trimming the file-snapshot journal failed: ${error instanceof Error ? error.message : String(error)}\n`);
          });
          // Pruning/trimming only rewrites the index; drop the content objects that
          // are no longer referenced so a long-lived session does not grow forever.
          await this.fileSnapshots.collectGarbage(sessionKey).catch((error) => {
            process.stderr.write(`[bridge] collecting unused file-snapshot objects failed: ${error instanceof Error ? error.message : String(error)}\n`);
          });
        }
      } else if (filePlan !== undefined) {
        files = { restored: [], deleted: [], skipped: [], failed: [], rescue: [], rescueDir: this.fileSnapshots.rescueDir(sessionKey) };
      }
      return {
        kind: 'success',
        text: successText(resolved.targetSeq),
        ...(files === undefined ? {} : { files }),
      };
    } finally {
      this.revertInflight.delete(sessionKey);
    }
  }

  /**
   * Report the session's permission preset and the switchable ones.
   *
   * Each preset travels as `{ value, name, description? }` rather than a bare
   * name, because the display label belongs to whoever configured the preset:
   * DSH's own `PresetSpec.name` defaults to the raw table key, and a deployment
   * that renames its presets (including into another language) must not be
   * silently shown the key instead. `value` stays the key the `/permission`
   * command accepts, so a renamed preset is still switchable.
   */
  async permission(params) {
    const service = this.ctx.get('permissionPresets');
    if (service === undefined) return { available: false, current: null, presets: [] };
    const rec = await this.getOrCreateSession(params.sessionId);
    this.assertLiveAgent(rec, params.sessionId);
    return {
      available: true,
      current: service.current(rec.handle.agent.session),
      presets: service.catalog().options.map((option) => ({
        value: option.value,
        name: option.name,
        ...(option.description === undefined ? {} : { description: option.description }),
      })),
    };
  }

  /**
   * Report the session's current context occupancy for the composer's usage
   * readout.
   *
   * The figure is DSH's own replay-aware token meter, never a sum of the log:
   * `contextPressure` pairs the newest provider-reported prompt pressure — plus
   * the surface's movement since that sample — with the newest known route
   * capacity, which is exactly what DSH's own context meter displays. Summing
   * the log's `tokenUsage` would instead report cumulative billing: it
   * overstates a compacted session and counts cache reads twice. Capacity is
   * resolved for the session's *current* route, so a model switch cannot leave
   * the previous model's window paired with the new model's pressure. Every
   * unknown field is omitted rather than defaulted, because a fabricated
   * occupancy is worse than none.
   *
   * ### Why this reads a session instead of just reading a number
   *
   * Measuring a resumed session needs its agent, and an agent otherwise only
   * exists after the first prompt. So a session this process has *initialized*
   * but not prompted gets one created here, and the reopened composer shows its
   * stored occupancy before the next turn, like `commands` and `permission`
   * already do. A session this process has never opened resumes from its
   * persistence handle instead of answering "unavailable": the occupancy is
   * stored, so it can be shown before the next turn.
   *
   * ### The one session this must NOT resurrect
   *
   * `usage` is not user-driven: `configure()`, a 75 ms merge timer and
   * `compaction/end` all refresh it, so a request can still be in flight when
   * the user closes the session. Landing after `session/close` had already
   * disposed the agent, `getOrCreateSession` would happily `resume` it — an
   * agent with no owner, re-taking the session log's write lease and keeping its
   * model-selection listeners for the life of the process. That is the resource
   * `closeSession` exists to release. So an id in {@link closedSessions} answers
   * `available: false` and creates nothing; the plugin clears its readout on that
   * answer, and a closed session has no composer to show one in.
   *
   * @param {{sessionId: string}} params
   */
  async usage(params) {
    const sessionId = String(params.sessionId);
    if (this.sessions.get(sessionId) === undefined && this.closedSessions.has(sessionId)) {
      return { available: false };
    }
    const rec = await this.getOrCreateSession(sessionId);
    this.assertLiveAgent(rec, params.sessionId);
    const session = rec.handle.agent.session;
    const loggedRoute = session.requestContext?.();
    const selection = this.controls.get(sessionId)?.selection?.current;
    const route = selection ?? loggedRoute;
    const sameRoute = route?.provider === loggedRoute?.provider && route?.model === loggedRoute?.model;
    const pressure = this.#contextPressure(session);
    // A prior model's pressure/limit must not be presented as a measurement of
    // the newly selected model. Reprice via DSH when the route changed.
    const usedTokens = sameRoute
      ? pressure?.projectedTokens ?? pressure?.pressureTokens ?? this.#measuredTokens(session)
      : this.#measuredTokens(session, route);
    const contextWindow = await this.#routeContextWindow(route);
    return {
      available: true,
      ...(Number.isSafeInteger(usedTokens) && usedTokens >= 0 ? { usedTokens } : {}),
      ...(Number.isSafeInteger(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
    };
  }

  /**
   * DSH's `contextPressure` projection — the newest pressure sample and route
   * capacity, read through the unit's client view so `projectedTokens` (which
   * folds the surface movement a compaction produces) is present.
   */
  #contextPressure(session) {
    try {
      return this.ctx.get('sessionProjections')?.snapshot(session, ['contextPressure'])?.values
        ?.contextPressure;
    } catch {
      return undefined;
    }
  }

  /** Current request pressure straight from the token meter, before any sample exists. */
  #measuredTokens(session, route) {
    try {
      const header = session.requestHeader?.();
      const requestHeader = route?.provider !== undefined && route?.model !== undefined
        ? {
          ...(header?.tools === undefined ? {} : { tools: header.tools }),
          config: {
            ...(header?.config ?? {}),
            provider: route.provider,
            model: route.model,
          },
        }
        : undefined;
      const measured = this.ctx.get('tokenMeter')?.measure(session, requestHeader);
      return typeof measured?.totalTokens === 'number' ? measured.totalTokens : undefined;
    } catch {
      return undefined;
    }
  }

  /** The live route's resolved context capacity, preferring the current selection. */
  async #routeContextWindow(route) {
    if (route?.provider === undefined || route?.model === undefined) return undefined;
    try {
      const info = await this.ctx.get('llm')?.resolveModelInfo(route.provider, route.model);
      const contextWindow = info?.context?.contextWindow;
      return typeof contextWindow === 'number' && contextWindow > 0 ? contextWindow : undefined;
    } catch {
      return undefined;
    }
  }

  /** Report the routes and models the runtime can serve, for the Paseo catalog. */
  async catalog() {
    const llm = this.ctx.get('llm');
    if (llm === undefined) {
      return { providers: [], models: [], planMode: this.ctx.get('planMode') !== undefined };
    }
    // DSH 0.2.1 materializes a provider's model catalog asynchronously after a
    // route resolves. The Paseo catalog probe deliberately skips `initialize`
    // (it must not pin a route), so warm the profile's default and then poll
    // briefly while the adapters finish registering their models.
    const warm = this.profileDefault();
    if (warm !== undefined) {
      try {
        await llm.resolveCallConfig({ provider: warm.provider, model: warm.model });
      } catch {
        /* best-effort: an unresolvable default may still leave other routes */
      }
    }

    const collect = async () => {
      const providers = llm.listProviders().map((entry) => ({ id: entry.id, name: entry.name }));
      const models = [];
      // A provider with no credential, or a model with no resolved capability
      // record, reports nothing; it must not take the whole catalog down.
      for (const provider of providers) {
        try {
          for (const model of await llm.listModels(provider.id)) {
            let reasoning;
            try {
              const info = await llm.resolveModelInfo(provider.id, model.id);
              if (info?.reasoning !== undefined) {
                reasoning = {
                  ...(info.reasoning.defaultEffort === undefined
                    ? {}
                    : { defaultEffort: String(info.reasoning.defaultEffort) }),
                  efforts: (info.reasoning.efforts ?? []).map((effort) => ({
                    id: String(effort.id),
                    name: effort.name,
                    ...(effort.description === undefined ? {} : { description: effort.description }),
                  })),
                };
              }
            } catch {
              /* model declares no reasoning control */
            }
            models.push({
              provider: model.provider,
              id: model.id,
              name: model.name,
              ...(model.description === undefined ? {} : { description: model.description }),
              ...(reasoning === undefined ? {} : { reasoning }),
            });
          }
        } catch {
          /* provider advertises no usable catalog yet */
        }
      }
      return { providers, models };
    };

    let { providers, models } = await collect();
    const deadline = Date.now() + 3000;
    while (models.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      ({ providers, models } = await collect());
    }

    // A catalog read happens before any session pins a route, so the profile's
    // configured default is the honest answer.
    let defaultProvider = this.provider;
    let defaultModel = this.model;
    let defaultReasoningEffort = this.reasoningEffort ?? null;
    const selection = this.profileDefault();
    if (selection !== undefined) {
      defaultProvider = selection.provider;
      defaultModel = selection.model;
      defaultReasoningEffort = selection.reasoningEffort ?? null;
    }
    return {
      providers,
      models,
      defaultProvider,
      defaultModel,
      defaultReasoningEffort,
      planMode: this.ctx.get('planMode') !== undefined,
    };
  }

  /** Dispose server-owned agents, the fallback adapter and subscriptions. */
  shutdown() {
    this.shutdownTask ??= this.performShutdown();
    return this.shutdownTask;
  }

  async performShutdown() {
    this.shuttingDown = true;
    await Promise.allSettled([...this.sessionCreations.values()]);
    this.sessionCreations.clear();
    const records = [...this.sessions.values()];
    this.sessions.clear();
    const failures = [];
    while (this.disposers.length > 0) {
      try {
        this.disposers.pop()?.();
      } catch (error) {
        failures.push(error);
      }
    }
    for (const rec of records) {
      try {
        rec.control?.dispose?.();
      } catch (error) {
        failures.push(error);
      }
    }
    this.controls.clear();
    // Every provider's adapter fiber, not just the last one: with a per-provider
    // map a process that initialized two routes has two loaded adapters, and
    // disposing only the newest leaked the other for the life of the process.
    const adapters = [...this.llmFibers.values()];
    this.llmFibers.clear();
    const teardown = await Promise.allSettled([
      ...records.map((rec) => Promise.resolve().then(() => rec.handle.dispose())),
      ...adapters.map((fiber) => Promise.resolve().then(() => fiber?.dispose())),
    ]);
    failures.push(
      ...teardown.filter((result) => result.status === 'rejected').map((result) => result.reason),
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'paseo bridge teardown failed');
    return {};
  }

  /** Dispatch one incoming JSON-RPC request to its typed handler. */
  async handleRequest(method, params) {
    switch (method) {
      case 'initialize':
        return this.initialize(params);
      case 'session/prompt':
        return this.prompt(params);
      case 'session/cancel':
        return this.cancel(params);
      case 'paseo/catalog':
        return this.catalog();
      case 'paseo/commands':
        return this.commands(params);
      case 'paseo/command/run':
        return this.runCommand(params);
      case 'paseo/revert':
        return this.revert(params);
      case 'paseo/permission':
        return this.permission(params);
      case 'paseo/permission/set':
        return this.setPermission(params);
      case 'paseo/usage':
        return this.usage(params);
      case 'paseo/presets':
        return this.presets(params);
      case 'paseo/sessions':
        return this.listSessions(params);
      case 'paseo/history':
        return this.history(params);
      case 'paseo/subagents':
        return this.subagents(params);
      case 'paseo/archive':
        return this.applyArchived(params, true);
      case 'paseo/unarchive':
        return this.applyArchived(params, false);
      case 'paseo/plan/get':
        return this.planGet(params);
      case 'paseo/plan/set':
        return this.planSet(params);
      case 'paseo/config/set':
        return this.configSet(params);
      case 'paseo/mcp/set':
        return this.setMcpServers(params);
      case 'session/close':
        return this.closeSession(params);
      case 'shutdown':
        return this.shutdown();
      default:
        throw new Error(`unknown paseo bridge method: ${method}`);
    }
  }

  /**
   * Queue the MCP entries Paseo attached to one session.
   *
   * The entries are DSH patch entries (`{ name, config }`): the plugin layer
   * keeps owning the translation (gateway vs. native client vs. refusing a
   * legacy transport) and this bridge only mounts what it is handed, at the
   * agent scope, when the session's agent is created. Queued rather than applied
   * because Paseo configures a session before it ever prompts it.
   *
   * The only window where the entries can be mounted is before the session's
   * agent exists (`setup`/`resumeSetup` read {@link pendingMcpServers}). A set
   * that arrives after that point cannot take effect: the plugin marks the frame
   * as sent (`#mcpSent`) and never re-sends, so answering `mounted: false` with a
   * stderr line meant "this session silently has no MCP tools for its whole
   * life". This throws instead, which the plugin surfaces as a failed session
   * preparation — loud, and retryable by reopening the session. The documented
   * order (`initialize` → `paseo/mcp/set` → prompt) never hits it.
   *
   * @param {{sessionId?: unknown, entries?: unknown}} params
   * @returns {{accepted: true, entries: number, mounted: true}}
   * @throws when the session's agent already exists (or is being created now).
   */
  async setMcpServers(params) {
    const sessionId = String(params.sessionId);
    const entries = params.entries;
    if (!Array.isArray(entries)) {
      throw new Error(`paseo/mcp/set for session ${sessionId} requires an "entries" array`);
    }
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`paseo/mcp/set for session ${sessionId} carries an entry that is not an object`);
      }
      if (typeof entry.name !== 'string' || entry.name === '') {
        throw new Error(`paseo/mcp/set for session ${sessionId} carries an entry without a plugin "name"`);
      }
    }
    // An empty list is meaningful (this session gets no MCP servers) and must
    // override a previously queued set, so it is stored like any other. It is
    // stored BEFORE the refusal below: the entries stay queued, so a later
    // resume/open of this session does mount them.
    this.pendingMcpServers.set(sessionId, entries.map((entry) => ({
      name: entry.name,
      config: entry.config ?? {},
    })));
    if (this.sessions.has(sessionId)) {
      throw new Error(
        `paseo/mcp/set for session ${sessionId} arrived after its agent was created; `
        + `its MCP servers cannot be mounted into a live agent scope. Close and reopen the session `
        + `to mount ${entries.length} entr(y/ies) (they are queued for the next resume).`,
      );
    }
    if (this.sessionCreations.has(sessionId)) {
      // The agent is being built right now. Whether `setup` has already run is
      // not observable from here, so "mounted" cannot be promised — and a false
      // promise is the silent degradation this method must not make.
      throw new Error(
        `paseo/mcp/set for session ${sessionId} raced its agent creation; `
        + `mounted state is unknowable. Close and reopen the session to mount `
        + `${entries.length} entr(y/ies) deterministically.`,
      );
    }
    return { accepted: true, entries: entries.length, mounted: true };
  }

  /**
   * Forget everything this bridge tracks for one Paseo session, and dispose the
   * agent it owns so the session can be opened again.
   *
   * One process serves many sessions, so every per-session table has to be
   * emptied when a session goes away — otherwise `owns()` stays true forever and
   * later `paseo/question` frames keep being routed to a session nobody is
   * listening to. Idempotent: an unknown id answers `{ closed: false }` instead
   * of throwing, because a close racing a process teardown is normal.
   *
   * The agent is disposed. This is NOT the plugin layer's park/shutdown decision
   * — it is what makes "close then reopen the same session id" possible at all.
   * The agent holds the session log's WRITE LEASE (`SessionWriteLease`, acquired
   * by `persistence.open(id, 'write')`), and only its teardown closes that
   * handle; keeping the agent alive across a close left the lease held, so the
   * next `agents.create(sessionId)` failed with "already owned by an active
   * write handle" — an error that does not match the "already exists" resume
   * path, so it surfaced to the user and the session could never be reopened.
   * In a long-lived shared process that is not a transient, it is permanent.
   *
   * Disposing here is safe for the parked-process reuse the plugin layer wants:
   * what a parked process keeps is the DSH runtime (services, adapters), not the
   * agent. Reopening resumes the same persisted session from its durable log,
   * which is exactly what a park/reopen already did before this refactor.
   *
   * The route tables (`sessionCwd` / `sessionRoutes`) and `initializedSessions`
   * are deliberately KEPT. A closed session's DSH agent can be resumed in this
   * same process (a parked process is taken back for the same Paseo session), and
   * a route table emptied while the session still counted as initialized would
   * make that resume silently compose another session's process defaults — the
   * very cross-talk this refactor removes. Clearing both or neither keeps the
   * pair consistent; the contract lists neither, so neither is cleared. They are
   * bounded (least-recently-initialized evicted) by `#trimSessionRouteTables`,
   * because a long-lived process accumulates one entry per distinct session.
   *
   * A close racing an in-flight creation gets a second clear after that creation
   * settles; see the race comment below.
   *
   * @param {{sessionId?: unknown}} params
   * @returns {{closed: boolean}}
   */
  async closeSession(params) {
    const sessionId = String(params.sessionId);
    // Every descendant, not just direct children: `children` records the DIRECT
    // parent, so a grandchild is only reachable by walking the chain. A leftover
    // descendant would keep its frames routing to a closed session.
    const descendants = [];
    const pending = [sessionId];
    const seen = new Set(pending);
    while (pending.length > 0) {
      const parent = pending.pop();
      for (const [childId, child] of this.children) {
        if (child.parentId !== parent || seen.has(childId)) continue;
        seen.add(childId);
        descendants.push(childId);
        pending.push(childId);
      }
    }
    const known = this.sessions.has(sessionId)
      || this.sessionCreations.has(sessionId)
      || this.controls.has(sessionId)
      || this.assistantStreams.has(sessionId)
      || this.pendingPresets.has(sessionId)
      || this.pendingPlanMode.has(sessionId)
      || this.pendingMcpServers.has(sessionId)
      || this.children.has(sessionId)
      || this.initializedSessions.has(sessionId)
      || this.sessionCwd.has(sessionId)
      || this.sessionRoutes.has(sessionId);
    if (!known) return { closed: false };

    // Capture the record before the tables are dropped, then dispose it AFTER
    // they are empty: `handle.dispose()` cancels the running turn, waits for
    // idle, unwinds the agent scope and closes the session's write handle, and
    // its teardown may emit events that must no longer find this session in the
    // bridge's tables (a closing session's late `turn/end` is not Paseo's to
    // see). The write handle is the point of the exercise — see the doc comment.
    const rec = this.sessions.get(sessionId);

    // Dispose the model-selection listeners of a live record before dropping the
    // only reference to their disposer: `installModelSelection` installed them on
    // the agent's scope, and `handle.dispose()` tears that scope down, so this is
    // belt-and-braces (and a no-op once the scope is gone) rather than the
    // mechanism.
    const control = this.controls.get(sessionId);
    try {
      control?.dispose?.();
    } catch (error) {
      process.stderr.write(
        `[bridge] disposing the model selection of closed session ${sessionId} failed: `
        + `${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    this.#forgetSessionState(sessionId);
    for (const childId of descendants) {
      this.#forgetSessionState(childId);
      // The anchor table is keyed by child, so a root's `delete` alone does not
      // reach children that were recorded under another parent in the chain.
      this.childAnchors.deleteChild(childId);
    }
    // Root-scoped anchors of this session, plus any unscoped ones a caller
    // recorded without naming a root (those can only belong to a single-session
    // process, and that process is closing this session).
    this.childAnchors.delete(sessionId);
    // This session's OWN anchor when it is itself somebody's child: that entry is
    // keyed by child id with the parent as root, so the root-scoped `delete`
    // above cannot reach it, and it would keep a closed session's dispatch seq
    // alive for a later rewind in the parent.
    this.childAnchors.deleteChild(sessionId);

    // This id's owner has walked away, so its route rows become recyclable — the
    // ONLY rows the cap is allowed to evict (see `#trimSessionRouteTables`). It is
    // recorded here, before the dispose below, so a close the caller abandons at
    // its own timeout still leaves the id recyclable: the tables are already
    // dropped at this point, and a later trim must be able to reclaim them.
    // Descendants go in too — their frames are no longer routed anywhere, and a
    // subagent that is never closed individually would otherwise pin its row for
    // the life of the process.
    this.closedSessions.add(sessionId);
    for (const childId of descendants) this.closedSessions.add(childId);

    // An in-flight creation is not in `sessions` yet, so the loop above could not
    // dispose it. Await it here (settling either way) and dispose whatever it
    // produced: a close racing a creation must not leave an unowned agent holding
    // the write lease — that is the same permanent failure, just rarer.
    const creating = this.sessionCreations.get(sessionId);
    if (creating !== undefined) {
      this.sessionCreations.delete(sessionId);
      const raced = await creating.then(
        (created) => created,
        () => undefined,
      );
      if (raced !== undefined) {
        try {
          raced.control?.dispose?.();
        } catch (error) {
          process.stderr.write(
            `[bridge] disposing the model selection of a session created concurrently with close `
            + `failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
        // `createSession` publishes its record (`controls`/`sessions`, and the
        // queued plan intent it consumes) only AFTER `agents.create`/`resume`
        // resolves — i.e. after the clears above ran. Without a second pass the
        // close leaves a record for the agent it is about to dispose: `owns()`
        // stays true forever (so `paseo/question` keeps targeting the closed
        // session), `assertLiveAgent` throws "disposed outside the server", and
        // the next open of the same id gets the dead record back from
        // `getOrCreateSession`, so the session can never be reopened in this
        // process. Identity-guarded because a `getOrCreateSession` that started
        // while we awaited the race may have published a record of its own, which
        // is NOT ours to drop.
        if (this.sessions.get(sessionId) === raced) this.#forgetSessionState(sessionId);
        // Same pending-teardown record as the ordinary close below: this dispose
        // also closes a session log's write handle, and the reopen that follows an
        // abandoned close must wait for it.
        await this.#trackTeardown(sessionId, async () => {
          try {
            await raced.handle?.dispose?.();
          } catch (error) {
            process.stderr.write(
              `[bridge] disposing a session created concurrently with close failed for ${sessionId}: `
              + `${error instanceof Error ? error.message : String(error)}\n`,
            );
          }
        });
      }
    }

    if (rec !== undefined) {
      // A close must not be defeated by a teardown that fails: the tables are
      // already cleared, and throwing here would turn a successful close into an
      // error the plugin reports to the user. Report it on stderr instead — a
      // lease that outlived its agent is exactly the thing worth seeing.
      //
      // The dispose is **re-published as a pending teardown** for its whole
      // duration, because the caller may give up waiting first (`DshProcess`
      // bounds `session/close` at 10 s) and reopen the session immediately. The
      // write handle this dispose closes is held until it finishes, and a
      // `agents.create`/`resume` that starts before then fails with "already
      // owned by an active write handle" — which surfaces as a session that
      // opened fine and whose FIRST prompt fails. Recording the promise is what
      // lets the next creation wait for it instead of racing it.
      await this.#trackTeardown(sessionId, async () => {
        try {
          await rec.handle?.dispose?.();
        } catch (error) {
          process.stderr.write(
            `[bridge] disposing the agent of closed session ${sessionId} failed; `
            + `the session may not be reopenable: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      });
    }
    return { closed: true };
  }

  /**
   * Run one agent teardown while it is visible to the next creation of the same
   * session id, and clear the record when it settles.
   *
   * The record outlives the `session/close` receipt on purpose: the caller can
   * abandon the request (its own timeout) while `dispose()` is still closing the
   * session log's write handle, and the reopen that follows must wait for that
   * rather than fail its first turn.
   *
   * @param {string} sessionId
   * @param {() => Promise<void>} teardown - never throws; it reports internally.
   */
  async #trackTeardown(sessionId, teardown) {
    const task = teardown();
    this.teardowns.set(sessionId, task);
    try {
      await task;
    } finally {
      // Only clear our own record: a newer close of the same id may already have
      // replaced it, and that one's waiters must not be released early.
      if (this.teardowns.get(sessionId) === task) this.teardowns.delete(sessionId);
    }
  }

  /**
   * Wait (bounded) for a previous close's teardown of this session id to finish.
   *
   * Called before the agent for that id is created or resumed. The bound matters
   * as much as the wait: a dispose that is stuck forever must not turn into a
   * session that can never open, so a timeout is reported and the creation is
   * attempted anyway — racing the lock is bad, hanging forever is worse.
   *
   * @param {string} sessionId
   */
  async #awaitTeardown(sessionId) {
    const pending = this.teardowns.get(sessionId);
    if (pending === undefined) return;
    let timer;
    const bounded = new Promise((resolve) => {
      timer = setTimeout(resolve, TEARDOWN_WAIT_TIMEOUT_MS);
      timer.unref?.();
    });
    await Promise.race([pending.catch(() => undefined), bounded]);
    clearTimeout(timer);
    if (this.teardowns.get(sessionId) === pending) {
      process.stderr.write(
        `[bridge] the previous close of session ${sessionId} is still disposing its agent after `
        + `${String(TEARDOWN_WAIT_TIMEOUT_MS)}ms; opening anyway — the first turn may fail `
        + 'with "already owned by an active write handle"\n',
      );
    }
  }

  /**
   * Drop every per-session entry this bridge keeps for one session id.
   *
   * The single list of "what a close must clear", used both by `closeSession`
   * (for the session and every descendant) and by its create/close race repair,
   * so the two cannot drift apart: a table added to the server but not here
   * survives a close and leaves `owns()` true forever. The three tables that are
   * deliberately kept across a close (`sessionCwd`, `sessionRoutes`,
   * `initializedSessions`) do NOT appear here — see `closeSession`'s doc.
   *
   * @param {string} sessionId
   */
  #forgetSessionState(sessionId) {
    this.sessions.delete(sessionId);
    this.controls.delete(sessionId);
    this.assistantStreams.delete(sessionId);
    this.pendingPresets.delete(sessionId);
    this.pendingPlanMode.delete(sessionId);
    this.pendingMcpServers.delete(sessionId);
    this.children.delete(sessionId);
    // A rewind in flight for this session will finish on its own; dropping the
    // marker only stops a later rewind from being refused on behalf of a session
    // that is already gone. (The `finally` in `revert` deletes it again, safely.)
    this.revertInflight.delete(sessionId);
    // Pending file snapshots are keyed `<executing session>:<callId>` (see
    // `captureFileBeforeTool`), so both the owner map and the snapshot's own
    // `pending` entry have to go. Clearing only `snapshotOwners` left `pending`
    // holding a mid-flight edit's file contents for the life of the process:
    // `pending` only shrinks in capture/commit/discard, never on close.
    const prefix = `${sessionId}:`;
    for (const key of [...this.snapshotOwners.keys()]) {
      if (key.startsWith(prefix)) this.snapshotOwners.delete(key);
    }
    for (const key of [...this.fileSnapshots.pending.keys()]) {
      if (!key.startsWith(prefix)) continue;
      // `pendingKey` is the whole identity here; the journal owner (which may be
      // this session's root) is not needed to drop the in-memory entry.
      this.fileSnapshots.discard({ sessionId, callId: key.slice(prefix.length), pendingKey: key });
    }
  }

  requireSession(sessionId) {
    const rec = this.sessions.get(sessionId);
    if (rec === undefined) throw new Error(`unknown or not-yet-created session: ${sessionId}`);
    this.assertLiveAgent(rec, sessionId);
    return rec;
  }

  assertLiveAgent(rec, sessionId) {
    if (this.ctx.agents.get(rec.handle.agent.id) !== rec.handle.agent) {
      throw new Error(`session agent was disposed outside the server: ${sessionId}`);
    }
  }

  async getOrCreateSession(sessionId) {
    if (this.shuttingDown) throw new Error('paseo bridge is shutting down');
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) return existing;
    const pending = this.sessionCreations.get(sessionId);
    if (pending !== undefined) return pending;
    // A close of this same id may still be disposing its agent — see
    // `#awaitTeardown`. This is the reopen path the plugin takes straight after an
    // abandoned close (a Paseo close or refresh, or an open that replaced a stale
    // session instance), so it is exactly where the write-handle race used to land.
    // A rewind no longer comes through here: it reloads nothing.
    await this.#awaitTeardown(sessionId);
    // Re-checked after the wait: a creation that started while we waited has
    // already been registered, and spawning a second one for the same id would
    // give the session two agents and two write handles.
    if (this.shuttingDown) throw new Error('paseo bridge is shutting down');
    const raced = this.sessions.get(sessionId);
    if (raced !== undefined) return raced;
    const started = this.sessionCreations.get(sessionId);
    if (started !== undefined) return started;
    const creation = this.createSession(sessionId);
    this.sessionCreations.set(sessionId, creation);
    creation.then(
      () => this.sessionCreations.delete(sessionId),
      () => this.sessionCreations.delete(sessionId),
    );
    return creation;
  }

  /**
   * Create (or resume) the DSH agent behind one session.
   *
   * Everything that used to be read off the process — cwd, route, maxTokens —
   * is read for THIS session, falling back to the process defaults only for
   * fields the session never pinned. See {@link routeFor}.
   *
   * @param {string} sessionId
   * @param {{cwd?: string, route?: object}} [options] - explicit overrides, used
   *   by callers that already resolved the values (`initialize` does not, it
   *   writes the tables; this is for tests and future entry points).
   */
  async createSession(sessionId, options = {}) {
    const route = options.route === undefined ? this.routeFor(sessionId) : { ...this.routeFor(sessionId), ...options.route };
    // Mirrors the ACP adapter: the durable option carries the initial route and
    // a scoped mutable selection ref installed during setup owns later switches.
    const initial = {
      provider: route.provider,
      model: route.model,
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
    };
    const control = { selection: { current: initial, assembled: undefined }, dispose: undefined };
    // Model-selection only. The delegation tools need no wrapper here: DSH
    // 0.2.1-rc.2 starts every delegation as an independently managed activation
    // (`startActivation` returns the child id immediately and the runtime
    // notifies the parent on completion), so there is no foreground mode whose
    // child could inherit the parent turn's abort signal. An earlier build
    // injected `run_in_background: true` for that reason; the parameter does not
    // exist on `subagent`/`subagent_fork` (it belongs to bash/workflow), the
    // extra key was ignored, and the re-registration only shadowed the standing
    // tool with an identical definition.
    const installSelection = (agentCtx) => {
      control.dispose = installModelSelection(agentCtx, control.selection);
    };

    // Paseo's MCP servers are mounted at the AGENT scope, not as a profile-wide
    // patch: each Paseo session carries its own server URL and token (the URL
    // names the caller agent id), so a process-wide mount would give every
    // session whichever identity was injected first. The entries arrive in DSH's
    // own patch-entry shape and are loaded mechanically — this bridge never
    // hardcodes which plugins they are, so the plugin layer keeps owning the
    // gateway-vs-native translation.
    const mountMcp = async (agentCtx) => {
      const entries = this.pendingMcpServers.get(sessionId);
      if (entries === undefined) return;
      for (const entry of entries) {
        if (entry === null || typeof entry !== 'object') continue;
        if (typeof entry.name !== 'string' || entry.name === '') {
          throw new Error(`paseo/mcp/set for session ${sessionId} carries an entry without a plugin name`);
        }
        // `entry.name` is a bare package name (`@deepseek-ai/dsh-mcp-client` for
        // a non-gateway stdio server). Resolving it with a plain dynamic import
        // was reported as MODULE_NOT_FOUND in a live profile while the bridge's
        // own static `@deepseek-ai/*` imports load fine, so the runtime evidently
        // has another resolution path for those — **unverified on a real
        // machine**. Do not "fix" this by hardcoding a path; a profile-relative
        // resolution has to be established first.
        await agentCtx.plugin(await import(entry.name), entry.config ?? {});
      }
    };

    // A session that runs under an agent preset mounts it during setup, exactly
    // like api-session-controller's composeAgent. Without a preset registry in
    // the profile this is skipped and the session composes at the host plane as
    // before, so preset support stays opt-in.
    const presets = this.ctx.get('agentPresets');
    let agentPreset;
    let setup = async (agentCtx, agent) => {
      installSelection(agentCtx);
      await mountMcp(agentCtx);
    };
    if (presets !== undefined) {
      // `resolvePreset` validates before the session exists, so a stale queued id
      // fails here (readably) instead of poisoning every later attempt.
      const resolvedId = await this.resolvePreset(sessionId, this.pendingPresets.get(sessionId));
      agentPreset = resolvedId;
      setup = async (agentCtx, agent) => {
        installSelection(agentCtx);
        await presets.mount(agentCtx, resolvedId);
        await mountMcp(agentCtx);
      };
    }

    const agentOptions = {
      ...initial,
      ...(route.maxTokens === undefined ? {} : { maxTokens: route.maxTokens }),
    };
    const cwd = options.cwd ?? this.sessionCwd.get(sessionId) ?? this.cwd;
    const meta = { cwd, ...(agentPreset === undefined ? {} : { agentPreset }) };
    let handle;
    try {
      handle = await this.ctx.agents.create({
        sessionId: brandString(sessionId),
        meta,
        agentOptions,
        setup,
      });
    } catch (error) {
      // DSH persists sessions, so opening an id it already knows is a conflict
      // rather than a failure. Paseo re-opens an agent with its existing session
      // id on refresh and reconnect, so resume the persisted session and keep
      // the conversation alive instead of failing the open.
      if (!/already exists/i.test(String(error?.message ?? error))) throw error;
      // A resumed session keeps the preset it was created with; re-mount the same
      // one so its projected composition stays consistent.
      //
      // At this point the session is NOT live — that is exactly why `create`
      // failed — and `sessions.get` answers only for live Sessions, so reading
      // the projection there always yielded `undefined` and the resume silently
      // composed the default preset against a log recorded under another one.
      // The durable header is the right source (the `agentPreset` projection
      // seeds itself from that same header). A preset Paseo explicitly sent for
      // this reopen (`setPreset` queues only ids that already resolved) wins over
      // the header, because it is the user's latest intent.
      //
      // A header naming a preset this deployment no longer declares is a special
      // case, and the one place this bridge deliberately DIVERGES from DSH:
      // upstream's session controller resolves the stored preset and lets the
      // failure abort the open (`dsh-api-session-controller` `composeAgent` ->
      // `presets.resolve`, which throws `agent-preset/not-found`). Here that
      // would make the session unopenable FOREVER — every retry reads the same
      // durable header — so the bridge composes the default instead, writes the
      // reason to stderr, and records the composition that actually ran (see the
      // append below) so `paseo/presets.current` cannot keep naming the preset
      // that is gone. Rationale: a readable conversation under a different preset
      // beats a conversation that can never be opened. This can happen after a
      // deployment renames a preset, or when a newer DSH renames the built-in
      // default that every existing session's header recorded.
      let resumeSetup = async (agentCtx, agent) => {
        installSelection(agentCtx);
        await mountMcp(agentCtx);
      };
      if (presets !== undefined) {
        const requested = this.pendingPresets.get(sessionId);
        let resolvedId;
        let fellBack = false;
        if (requested !== undefined) {
          resolvedId = await this.resolvePreset(sessionId, requested);
        } else {
          const stored = await this.storedAgentPreset(sessionId);
          try {
            resolvedId = await this.resolvePreset(sessionId, stored);
          } catch (error) {
            process.stderr.write(
              `[bridge] session ${sessionId} records agent preset ${String(stored)} which this profile cannot compose `
              + `(${error instanceof Error ? error.message : String(error)}); composing the default preset instead\n`,
            );
            resolvedId = await this.resolvePreset(sessionId, undefined);
            fellBack = true;
          }
        }
        resumeSetup = async (agentCtx, agent) => {
          installSelection(agentCtx);
          await presets.mount(agentCtx, resolvedId);
          await mountMcp(agentCtx);
          // Record the composition that actually ran, so `paseo/presets.current`
          // (which folds this event over the header) cannot keep naming the
          // preset the fallback replaced. Log-only, same shape as the official
          // controller's `reuseSetup`, and legal before publication.
          if (fellBack && agent !== undefined) {
            agent.session.append('agent-preset/selected', { agentPreset: resolvedId });
          }
        };
      }
      handle = await this.ctx.agents.resume({
        resumeSessionId: brandString(sessionId),
        agentOptions,
        setup: resumeSetup,
      });
    }
    const rec = { handle, control };
    this.controls.set(sessionId, control);
    this.sessions.set(sessionId, rec);
    // Consume the queued plan intent and DELETE the key. Leaving it in place (or
    // resetting a single process-wide boolean) is what forced plan mode onto
    // every later session in the process after one session asked for it.
    if (this.pendingPlanMode.has(sessionId)) {
      const wanted = this.pendingPlanMode.get(sessionId) === true;
      this.pendingPlanMode.delete(sessionId);
      const planMode = this.ctx.get('planMode');
      if (wanted && planMode !== undefined) planMode.set(handle.agent, true);
    }
    return rec;
  }

  hasAdapterFor(provider) {
    return this.ctx.get('llm')?.listProviders().some((entry) => entry.id === provider) ?? false;
  }
}
