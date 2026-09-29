/**
 * Single source of truth for the engine version.
 *
 * Why a separate module: the value was duplicated — `COGNISTACK_VERSION` in
 * `fusion/CogniStackEngine.ts` and a hardcoded `version: "1.1.0"` inside
 * `telemetry.snapshot()`. The dashboard could therefore report a version that no
 * longer matched the engine that produced the data, which is exactly the kind of
 * quiet inconsistency that makes people distrust a dashboard.
 *
 * It also lets telemetry read the version without importing the engine (which
 * imports telemetry — a real cycle, not just a type-level one).
 */
export const COGNISTACK_VERSION = "1.3.0" as const;
