/**
 * The one contract both halves of the goal pill share.
 *
 * Like `shared/jobs.ts`, this lives in `shared/` because it is the only
 * directory Paseo's compiler lets both sides import, and defining the contract
 * twice would let the halves drift — the mismatch would then surface as a Zod
 * error at runtime instead of a type error here.
 *
 * **What the goal is.** DSH's own `dsh-goal` service owns it: a durable
 * same-session objective with a phase (`active`/`paused`/`blocked`/`complete`)
 * and a round budget. Paseo 0.14 has no native goal at all — no protocol field,
 * no capability bit, no event — so the plugin must not declare one. It reads the
 * live goal through the bridge's `paseo/goal` method (added beside `paseo/jobs`)
 * and draws it in its own composer pill.
 *
 * **Two fields are not the same kind of thing.** `phase` is durable (it lives in
 * the session log and survives a restart), while `activation` is process-local:
 * a reopened session always starts `disarmed` even when the goal is still
 * `active`, and only `/goal resume` re-arms it. Presenting `active + disarmed`
 * as "running" is the silent degradation this contract exists to prevent, so
 * both travel together and the pill's copy distinguishes them.
 *
 * @module dsh-paseo/shared/goal
 */
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * The durable phases a goal can be in.
 *
 * Written out rather than derived from DSH's type: the client bundle cannot
 * import DSH, and a phase DSH adds later must fail the Zod parse on the wire
 * instead of silently counting as "no goal" — the same rule `JOB_STATUSES`
 * follows.
 */
export const GOAL_PHASES = ["active", "paused", "blocked", "complete"] as const;

/** One durable goal phase. */
export type GoalPhase = (typeof GOAL_PHASES)[number];

/**
 * Whether the live process may automatically continue an active goal.
 *
 * Process-local in DSH (`dsh-goal`'s `GoalView.activation`): never persisted, so
 * every session start disarms it. `active + disarmed` is a real, common state —
 * the goal is not finished, it is just not running on its own — and the pill
 * must say so rather than calling it "active".
 */
export const GOAL_ACTIVATIONS = ["armed", "disarmed"] as const;

/** One goal activation state. */
export type GoalActivation = (typeof GOAL_ACTIVATIONS)[number];

/**
 * The machine-readable codes a `goal.current` error may carry.
 *
 * Follows the jobs contract's split: two of these are **terminal** — retrying
 * cannot change the answer until the user acts — and two are transient and keep
 * the poller's backoff.
 *
 * - `bridge_too_old`: the profile's bridge predates `paseo/goal`. The user's
 *   next step is to reload the plugin so the embedded bridge is rewritten.
 * - `goal_unavailable`: the runtime composes no goal service at all (a profile
 *   without `dsh-goal`). Nothing to show, ever, until the profile changes.
 * - `session_missing`: the agent's DSH session is not open (yet, or anymore).
 *   Transient: the next poll after the session opens answers.
 * - `rpc_failed`: the read itself failed (timeout, transport, a torn channel).
 */
export const GOAL_ERROR_CODES = [
  "bridge_too_old",
  "goal_unavailable",
  "session_missing",
  "rpc_failed",
] as const;

/** One machine-readable `goal.current` error code. */
export type GoalErrorCode = (typeof GOAL_ERROR_CODES)[number];

/**
 * The subset of error codes that retrying cannot fix.
 *
 * Typed as the literal tuple for the same reason `TERMINAL_JOB_ERROR_CODES` is:
 * the client imports this list to stop polling, so a code that is not a real
 * code is a type error rather than a member that can never match.
 */
export const TERMINAL_GOAL_ERROR_CODES = [
  "bridge_too_old",
  "goal_unavailable",
] as const satisfies readonly GoalErrorCode[];

/**
 * Whether an error code means "retrying cannot help".
 *
 * The only supported way for the client to ask, so the terminal set cannot be
 * spelled a second time and drift.
 */
export function isTerminalGoalErrorCode(code: string | undefined): boolean {
  return code !== undefined && (TERMINAL_GOAL_ERROR_CODES as readonly string[]).includes(code);
}

/** Why a goal is blocked: a machine code and a human sentence. */
export const goalBlockedReasonSchema = z.object({
  /** Stable lower-kebab-case classification chosen by DSH's blocking policy. */
  code: z.string(),
  /** Non-empty explanation, shown verbatim. */
  message: z.string(),
});

export type GoalBlockedReason = z.infer<typeof goalBlockedReasonSchema>;

/**
 * One goal as the pill draws it.
 *
 * Deliberately **not** DSH's whole `GoalView`: `createdAt`/`updatedAt` are
 * never rendered and stay behind. `id` and `revision` are carried for one
 * reason only (UI-v7): a completed goal is shown until the user has seen it,
 * and "seen" is remembered per `id:revision` — the objective text cannot be the
 * key, because the same sentence can be completed twice (clear, then create it
 * again). The client never sends them back; control actions still go through
 * `/goal`, which needs no compare-and-set token.
 *
 * `.strip()` is the Zod default: Paseo parses both sides, so an undeclared key
 * would be dropped on the client — the silent-loss shape this repo keeps
 * finding.
 */
export const goalStateSchema = z.object({
  /**
   * DSH's goal identity. Required, like `activation`: a server that does not
   * send it is an old server, and a missing key must not read as "never seen".
   */
  id: z.string(),
  /** DSH's revision of that goal; every durable mutation increments it. */
  revision: z.number(),
  /** The human-requested objective, full text. */
  objective: z.string(),
  /** Durable lifecycle phase. */
  phase: z.enum(GOAL_PHASES),
  /** Whether this live process may auto-continue it. */
  activation: z.enum(GOAL_ACTIVATIONS),
  /** Highest admitted round number. */
  roundsStarted: z.number(),
  /** Total admitted-round cap. */
  maxGoalRounds: z.number(),
  /** Present exactly while `phase` is `blocked`. */
  blockedReason: goalBlockedReasonSchema.optional(),
  /**
   * The task DSH's todo list currently marks `in_progress`, if any.
   *
   * A separate read from the goal itself: DSH's `todos` session projection is
   * the only real "what is happening this round" data (the goal has a round
   * budget, not a completion percentage). It is optional because the projection
   * can be absent (a profile without `dsh-tool-todo`), `null` (nothing written
   * this round — DSH resets it every turn), or unreadable; in all of those cases
   * the popover simply does not draw the "now" line. The value is the item's own
   * `content`, verbatim, never a summary this plugin invents.
   */
  currentTask: z.string().optional(),
});

export type GoalState = z.infer<typeof goalStateSchema>;

/**
 * The control actions the popover can trigger.
 *
 * These are the four DSH's `/goal` command understands (`dsh-command-goal`'s
 * `parseGoalCommand`): `pause`, `resume`, `clear` are whole words, and `edit`
 * takes a replacement objective. Creating a goal is deliberately absent — the
 * pill is not shown when no goal exists, and creation belongs to `/goal <text>`
 * typed into the composer.
 */
export const GOAL_ACTIONS = ["pause", "resume", "clear", "edit"] as const;

/** One control action. */
export type GoalAction = (typeof GOAL_ACTIONS)[number];

/** The input of one control action, as the popover sends it. */
export interface GoalControlInput {
  agentId: string;
  action: GoalAction;
  /** Required by `edit`, ignored by the other three. */
  objective?: string;
}

/**
 * Build the argument string one action passes to DSH's `/goal` command.
 *
 * **The grammar is DSH's, not invented here** (`dsh-command-goal`'s
 * `parseGoalCommand`): the input is trimmed; `pause`/`resume`/`clear` are whole
 * words (case-insensitive); `edit` must be followed by whitespace and a
 * non-empty objective; anything else is a new objective. So `edit` with an
 * empty objective is not "edit to empty" — it is a syntax error on DSH's side,
 * which is why this returns a refusal instead of an argument string. The client
 * also refuses to submit one; this is the server-side half of that rule, where
 * a hand-written RPC call cannot skip it.
 *
 * A refusal is a value rather than a throw: the caller turns it into
 * `{ok: false, error}` for the popover to show, and a thrown error would be a
 * failed RPC instead of the user's own sentence.
 */
export function goalCommandArguments(
  action: GoalAction,
  objective?: string,
): { ok: true; args: string } | { ok: false; error: string } {
  if (action !== "edit") return { ok: true, args: action };
  const replacement = (objective ?? "").trim();
  if (replacement === "") {
    return { ok: false, error: "Goal editing requires a replacement objective." };
  }
  return { ok: true, args: `edit ${replacement}` };
}

/**
 * Read one agent's current goal.
 *
 * Keyed by Paseo's **agent** id, not the provider session id — a plugin reload
 * mints a new session id for the same agent, and the server half never guesses
 * one.
 *
 * **The wire shape is the `jobs.list` shape.** `goal.current` answers
 * `{available, goal, error?: {message, code?}}` — a nested error object with an
 * optional machine code — exactly like `shared/jobs.ts`'s
 * `{available, jobs, error?: {message, code?}}`. DESIGN §1.2 spells the same
 * fields with a top-level `error: string` plus a top-level `code`; the nested
 * form is what shipped because DESIGN *also* requires the failure grading to
 * follow jobs, and jobs' grading carries its code inside the error object. Both
 * halves import this one schema, so the shape cannot drift between them; the
 * difference is a wording deviation from the design, not a behaviour one, and
 * the Lead ruled the implementation authoritative (verification report B-3).
 *
 * The `available` contract, stated once (mirrors `jobs.list`):
 *
 * - **`true` with `goal: null`** means "we looked and this agent has no goal" —
 *   including an agent whose DSH session has not been opened yet, which is an
 *   accurate empty answer rather than a failed read. A cleared goal is `null`
 *   too, not an error.
 * - **`false`** means "we could not read it", and always carries a message plus
 *   (when the server half knows one) a code. The two are never collapsed: a
 *   broken read presented as "no goal" is exactly the silent degradation the
 *   goal pill exists to fix.
 *
 * When `available` is false, `error.code` tells the client whether another poll
 * can help. It is optional so an older server half keeps working: a missing code
 * is treated as transient, never as terminal.
 */
export const goalCurrent = defineRpc({
  name: "goal.current",
  input: z.object({ agentId: z.string().min(1) }),
  output: z.object({
    available: z.boolean(),
    goal: goalStateSchema.nullable(),
    error: z
      .object({
        message: z.string(),
        code: z.enum(GOAL_ERROR_CODES).optional(),
      })
      .optional(),
  }),
});

/**
 * Run one control action against the agent's current goal.
 *
 * The server half turns it into a `/goal <action>` command through the existing
 * command path (bridge `paseo/command/run`), which DSH accepts whether or not a
 * turn is running. The result is DSH's own answer, verbatim:
 *
 * - `ok: true` with the command's output text;
 * - `ok: false` with DSH's failure sentence (for example "The goal command is
 *   not valid for the current state") — **never** a success for a rejected
 *   command. That is the "failures must be loud" rule: a paused-at-round-limit
 *   goal refuses `resume`, and reporting it as done would leave the user
 *   believing it is running.
 */
export const goalControl = defineRpc({
  name: "goal.control",
  input: z.object({
    agentId: z.string().min(1),
    action: z.enum(GOAL_ACTIONS),
    /** Required by `edit`; the server refuses an empty replacement. */
    objective: z.string().optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    /** The command's own output text on success. */
    message: z.string().optional(),
    /** DSH's failure sentence on refusal. */
    error: z.string().optional(),
  }),
});
