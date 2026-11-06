/**
 * "The user closed the panel" — a **confirmed** close for a composer pill's
 * popover body (UI-v7), shared by the team and goal pills.
 *
 * The host renders a popover's content inside `AnchoredSurface`, whose
 * `FloatingSurface` carries `key={placed ? "placed" : "measuring"}` (Paseo 0.15.0,
 * `packages/app/src/components/ui/menu/menu-overlay.tsx:350`; its comment at
 * :265 says "Remounting on placement starts the native animation"): the first
 * render measures the body off-screen, and once the position lands React
 * unmounts that key and mounts a fresh one. So **opening** a pill's panel
 * unmounts its content exactly once, a frame after mounting it. Treating an
 * unmount as "the user closed the panel" therefore made both pills record
 * "seen" and hide themselves the moment they were opened — on the desktop
 * (anchored popover); the phone's bottom sheet does not take that path.
 *
 * The gate confirms a close only when the unmount survives a short window
 * ({@link SEEN_CLOSE_CONFIRM_MS}); a mount inside that window cancels it. That is
 * immune to the host's open-time remount, to a re-render that swaps the body, to
 * a panel that is torn down and rebuilt, and to StrictMode's double invoke —
 * while a real close (the panel is gone and stays gone) still reports once.
 *
 * Closing and reopening the panel inside the window reports nothing: the user is
 * looking at the panel again, so the next close reports it.
 *
 * The gate has no "cancel" of its own: a close that arrives after the pill it
 * belonged to was replaced or removed is dropped by the caller, which compares
 * the registration (see `contributeTeamPill` / `contributeGoalPill`'s
 * `addAgent`). Nothing here knows about the host.
 *
 * @module dsh-paseo/client/seen-close-gate
 */

/**
 * How long an unmount must stay unmounted before it counts as the user closing
 * the panel.
 *
 * Long enough to swallow every host-driven remount of the popover body, short
 * enough that a real close still hides a completed pill before the next poll.
 * The host's own remount at open time is one measurement frame (~16ms); the
 * delay only has to outlast a mount/unmount/mount cycle, not an animation.
 */
export const SEEN_CLOSE_CONFIRM_MS = 250;

/** The timers and the sink the gate needs; injected so this module stays host-free. */
export interface SeenCloseGateHost<T> {
  /** Record that the panel showing `payload` was really closed. */
  onClosed: (payload: T | null) => void;
  setTimeout: (callback: () => void, delayMs: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  /** The confirmation window; defaults to {@link SEEN_CLOSE_CONFIRM_MS}. */
  delayMs?: number;
}

/** One popover body's close confirmation, see {@link createSeenCloseGate}. */
export interface SeenCloseGate<T> {
  /** The body mounted (again): any pending "closed" is cancelled. */
  mounted(): void;
  /** The body unmounted: report it closed unless it mounts again within the window. */
  unmounted(payload: T | null): void;
}

export function createSeenCloseGate<T>(host: SeenCloseGateHost<T>): SeenCloseGate<T> {
  const delayMs = host.delayMs ?? SEEN_CLOSE_CONFIRM_MS;
  let timer: unknown;
  /** How many times the body has mounted; a remount after an unmount bumps it. */
  let mounts = 0;

  const cancel = (): void => {
    if (timer === undefined) return;
    host.clearTimeout(timer);
    timer = undefined;
  };

  return {
    mounted() {
      mounts += 1;
      cancel();
    },
    unmounted(payload) {
      cancel();
      const mountedAt = mounts;
      timer = host.setTimeout(() => {
        timer = undefined;
        // A remount after this unmount means the host rebuilt the body, not that
        // the user closed it. `mounted` already cancelled the timer; this second
        // guard keeps the rule true even if a host calls `unmounted` twice.
        if (mounts !== mountedAt) return;
        host.onClosed(payload);
      }, delayMs);
    },
  };
}
