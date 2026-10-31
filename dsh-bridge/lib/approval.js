import { randomUUID } from 'node:crypto';

/** Same root waterfall/ownership rule as DSH ACP. ApprovalService alone writes
 * asked/decided, applies ask/never and normalizes outcomes. Never grant a session
 * policy here: allowed-once is the only positive decision DSH understands. */
export function registerApprovalAnswerer(ctx, server, transport, timeoutMs = 300_000) {
  return ctx.on('approval/request', async (request, next) => {
    const sessionId = request.agent?.session?.id;
    if (sessionId === undefined || !server.owns(String(sessionId))) return next();
    const requestId = randomUUID();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Error('Tool approval timed out')), timeoutMs);
    timer.unref?.();
    const signal = request.signal ? AbortSignal.any([request.signal, deadline.signal]) : deadline.signal;
    const cancel = () => transport.notify('paseo/permission-cancelled', {
      sessionId: String(sessionId), requestId, timedOut: deadline.signal.aborted,
    });
    signal.addEventListener('abort', cancel, { once: true });
    try {
      if (signal.aborted) return 'cancelled';
      const answer = await transport.request('paseo/permission', {
        sessionId: String(sessionId), requestId, toolName: request.toolName,
        ...(request.callId === undefined ? {} : { callId: String(request.callId) }),
        ...(request.reason === undefined ? {} : { reason: request.reason }),
      }, signal);
      if (!['allowed-once', 'rejected', 'cancelled', 'unavailable'].includes(answer?.outcome)) {
        throw new Error('malformed tool approval answer');
      }
      return answer.outcome;
    } catch (error) {
      if (request.signal?.aborted) return 'cancelled';
      process.stderr.write(`[bridge] tool approval ${requestId} failed: ${error instanceof Error ? error.message : String(error)}\n`);
      return 'unavailable';
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
    }
  });
}
