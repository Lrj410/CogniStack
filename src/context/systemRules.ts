/**
 * Bundled baseline system rules.
 *
 * CogniStack owns *structure*, not *voice* or domain policy. The bundled
 * baseline is intentionally minimal so any host (chat, tools, ERP, bots, …)
 * can run without inheriting roleplay tone.
 *
 * Override per call with `AssembleOptions.systemRulesText` /
 * `ContextAssembleInput.systemRules`, or set `CogniStackOptions.systemRules`.
 * Roleplay hosts that need an adults-only line should inject it themselves.
 */
export const DEFAULT_SYSTEM_RULES = [
  "遵守适用法律与安全政策；拒绝违法、有害或越权请求。",
  "不确定时说明假设；不要编造未提供的事实。",
].join("\n");
