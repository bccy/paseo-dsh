/** The controller is optional in base+bridge profiles. Reuse its underlying
 * sessionQuery/sessionProjections APIs there, following DSH 0.2.1 controller's
 * non-activating read and migration distinction. No agent create/resume. */
export async function readSessionProjections(ctx, sessionId, signal) {
  const controller = ctx.get('sessionController');
  if (typeof controller?.projections === 'function') {
    return controller.projections({ sessionId }, signal);
  }
  const live = () => {
    const session = ctx.get('sessions')?.get(sessionId);
    if (!session) return undefined;
    const registry = ctx.get('sessionProjections');
    if (!registry) throw new Error('sessionProjections is not mounted in this profile');
    return { kind: 'sequenced', ...registry.snapshot(session) };
  };
  signal.throwIfAborted();
  const current = live();
  if (current) return current;
  const persistence = ctx.get('sessionPersistence');
  if (!persistence) throw new Error('sessionPersistence is not mounted in this profile');
  const stored = await persistence.stat(sessionId, { signal });
  signal.throwIfAborted();
  const attached = live();
  if (attached) return attached;
  if (!stored) return null;
  if (stored.formatStatus === 'migration-required') {
    return { kind: 'migration-required', values: { ...ctx.get('sessionProjectionCache')?.cachedSnapshot(stored.header)?.values } };
  }
  const query = ctx.get('sessionQuery');
  if (!query) throw new Error('sessionQuery is not mounted in this profile');
  let observation;
  try {
    observation = await query.observeSession(sessionId, { signal });
    signal.throwIfAborted();
    if (!observation.projections) throw new Error('Session projections are unavailable');
    return { kind: 'sequenced', asOfSeq: observation.projections.asOfSeq, values: observation.projections.values };
  } catch (error) {
    if (error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return live() ?? null;
    throw error;
  } finally {
    observation?.[Symbol.dispose]();
  }
}
