/**
 * The small amount of "never take the app down with us" this page needs.
 *
 * Kept separate from `dsh-plugins-page.tsx` because the rules are about the
 * host boundary, not about plugins: a client contribution is evaluated inside
 * Paseo's app process, so a throw on the way to the host — during
 * registration, or while the host draws something we handed it — can abort a
 * release build of the whole app over one page. Only the pieces this page uses
 * are here; there is no reason to grow a general framework for one screen.
 *
 * Provenance: upstream `client/guard.tsx` (0.2.22–0.2.24), trimmed to
 * `report` / `guardCleanup` / the render boundary / the fatal-error filter.
 *
 * @module dsh-paseo/client/dsh-plugins-guard
 */
import { Component, type ReactNode } from "react";
import { Text, View } from "react-native";

/** Never let a diagnostic path throw the app over. */
export function report(label: string, error: unknown): void {
  try {
    console.error(`[dsh-paseo] ${label}`, error);
  } catch {
    // A host without a working console still has to keep running.
  }
}

/**
 * Register one contribution. A host that refuses it loses that entry only; the
 * rest of the plugin and the app keep running. The returned cleanup is safe to
 * call twice.
 */
export function guardCleanup(label: string, run: () => () => void): () => void {
  try {
    const cleanup = run();
    return () => {
      try {
        cleanup();
      } catch (error) {
        report(`${label} cleanup`, error);
      }
    };
  } catch (error) {
    report(label, error);
    return () => {};
  }
}

/**
 * Catches render failures inside the page.
 *
 * The screen registration already sits inside the host's own boundary, but the
 * failure mode it protects against is the whole app: an uncaught render error
 * goes through React Native's fatal handler in a release build, and the page is
 * the newest, least exercised component this plugin hands the host. Redrawing
 * the fallback costs one component and keeps the rest of the app usable.
 */
export class PluginsBoundary extends Component<
  { fallback: ReactNode | ((error: Error | null) => ReactNode); children: ReactNode },
  { failed: boolean; error: Error | null }
> {
  state: { failed: boolean; error: Error | null } = { failed: false, error: null };

  static getDerivedStateFromError(error: Error): { failed: boolean; error: Error | null } {
    return { failed: true, error };
  }

  componentDidCatch(error: Error): void {
    report("dsh plugins screen", error);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return typeof this.props.fallback === "function"
      ? this.props.fallback(this.state.error)
      : this.props.fallback;
  }
}

/** Format an error into a short diagnostic snippet for the fallback card. */
export function formatBoundaryError(error: Error | null): string | undefined {
  if (!error) return undefined;
  const header = error.name && error.message
    ? `${error.name}: ${error.message}`
    : error.message || error.name || String(error);
  const stackLines = typeof error.stack === "string"
    ? error.stack
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line !== header)
      .slice(0, 4)
    : [];
  return stackLines.length > 0 ? `${header}\n${stackLines.join("\n")}` : header;
}

/** The fallback card drawn when a plugin screen throws during render. */
export function PluginsFailedCard({
  message,
  color,
  background,
  detail,
  detailColor,
}: {
  message: string;
  color: string;
  background: string;
  detail?: string;
  detailColor?: string;
}) {
  return (
    <View style={{ flex: 1, padding: 24, gap: 12, backgroundColor: background }}>
      <Text style={{ color, fontSize: 13, lineHeight: 19 }}>{message}</Text>
      {detail ? (
        <Text
          selectable
          style={{
            color: detailColor ?? color,
            fontSize: 11,
            lineHeight: 16,
            opacity: 0.85,
          }}
        >
          {detail}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * What a host-side failure may name to be recognised as ours.
 *
 * Only errors whose message or stack names these modules are swallowed; every
 * other fatal error still reaches the host's previous handler unchanged. Kept
 * deliberately short: a broad pattern would hide crashes that have nothing to
 * do with this page.
 */
const PLUGIN_MARKERS = /(dsh-paseo|paseo-dsh|dsh-plugins)/i;

function isPluginError(error: unknown): boolean {
  try {
    const text = error instanceof Error
      ? `${error.message}\n${error.stack ?? ""}`
      : String(error);
    return PLUGIN_MARKERS.test(text);
  } catch {
    return false;
  }
}

/**
 * Last line of defence for errors the host raises while drawing a contribution
 * (a sidebar row, a screen title) — those arrive as fatal JS errors and no
 * boundary of ours can catch them.
 *
 * Installed only when the host exposes RN's `ErrorUtils`, and installed once
 * per app process: two installs would stack handlers. A host that does not
 * expose it loses the filter, not the app.
 */
export function installFatalGuard(): void {
  const errorUtils = (globalThis as {
    ErrorUtils?: {
      getGlobalHandler?: () => (error: unknown, isFatal?: boolean) => void;
      setGlobalHandler?: (handler: (error: unknown, isFatal?: boolean) => void) => void;
    };
  }).ErrorUtils;
  if (errorUtils === undefined) return;
  if (typeof errorUtils.getGlobalHandler !== "function"
    || typeof errorUtils.setGlobalHandler !== "function") {
    return;
  }
  const marker = "__dshPaseoPluginsFatalGuard";
  if ((globalThis as Record<string, unknown>)[marker] === true) return;
  (globalThis as Record<string, unknown>)[marker] = true;
  const previous = errorUtils.getGlobalHandler();
  errorUtils.setGlobalHandler((error, isFatal) => {
    if (isFatal === true && isPluginError(error)) {
      report("fatal error swallowed", error);
      return;
    }
    previous(error, isFatal);
  });
}