/**
 * JSON-compatible value tree.
 *
 * Declared locally instead of importing `@getpaseo/protocol/agent-types`:
 * Paseo 0.11 and earlier resolve every type-only import while installing a
 * plugin, and that package is never installed into a plugin directory, so the
 * import alone made `paseo plugin add npm:paseo-dsh` fail. The type is
 * structural, so a local declaration is identical at compile time.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[];
