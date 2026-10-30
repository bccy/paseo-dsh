/**
 * The provider id both halves must agree on.
 *
 * In `shared/` because the client half has to recognise *this provider's* agents
 * while the server half registers under the same string, and a second hand-written
 * copy would drift silently — the pill would stop appearing for every agent, which
 * looks like "no background jobs" rather than like a broken id.
 *
 * A wire value, never localized.
 *
 * @module dsh-paseo/shared/provider
 */
export const PROVIDER_ID = "deepseek-harness-native";
