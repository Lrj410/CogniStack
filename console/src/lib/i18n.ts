/** 界面文案与枚举映射（协议字段仍英文，展示层转中文） */

export const MODE_LABEL: Record<string, string> = {
  generate: "生成",
  status: "状态",
};

export function modeLabel(mode: string): string {
  return MODE_LABEL[mode] ?? mode;
}

/**
 * 流水线阶段。
 *
 * 颜色走 `--stage-N` 令牌（同一个强调色的明度梯级），不写死 hex：
 *   - 固定 hex 会让配色在两套主题下失控（旧版这里用的是 slate/sky/teal 那一套，
 *     与暖色外壳互斥，整屏像贴了七张彩色便利贴）
 *   - 令牌由 CSS 按当前主题用 color-mix 算出来，改强调色只改一处
 * 装配（assemble）是核心阶段，拿满强调色；其余阶段退到同一个色相的暗部。
 */
export const STAGE_META: { key: string; label: string; color: string }[] = [
  { key: "budget", label: "预算", color: "var(--stage-1)" },
  { key: "memoryWindow", label: "记忆", color: "var(--stage-2)" },
  { key: "lore", label: "知识", color: "var(--stage-3)" },
  { key: "fragments", label: "预设", color: "var(--stage-4)" },
  { key: "assemble", label: "装配", color: "var(--stage-5)" },
  { key: "account", label: "核算", color: "var(--stage-6)" },
  { key: "trim", label: "裁剪", color: "var(--stage-7)" },
];

export const AGE_LABEL = { live: "在线", idle: "空闲", off: "离线" } as const;

export const STATUS_LABEL: Record<string, string> = {
  live: "已连接",
  paused: "已暂停",
  down: "未连接",
  boot: "连接中",
  reconnecting: "重连中",
};

export const ZONE_LABEL: Record<string, string> = {
  local: "本机",
  lan: "局域网",
  wan: "公网",
};

export function zoneLabel(zone?: string | null): string {
  if (!zone) return "未知";
  return ZONE_LABEL[zone] ?? zone;
}

/**
 * 网关拒绝原因 → 人话。键是 `tools/viz-server.cjs` 里的常量，
 * 未知键原样显示（宁可露出原始码，也不要编一个说不清的名字）。
 */
export const REJECT_REASON_LABEL: Record<string, string> = {
  bad_request: "请求不合法（输入契约不满足）",
  unauthorized: "鉴权失败（API Key）",
  rate_limited: "触发限流",
  too_large: "请求体过大",
  queue_full: "装配队列已满",
  unsupported_media_type: "缺少 application/json 头",
  sse_full: "遥测流连接数已满",
  zone_denied: "该段不提供此接口",
  proxy_untrusted: "代理密钥缺失或错误",
  wrong_zone_key: "密钥属于另一段",
  ip_blocked: "来源 IP 在封禁名单中",
  host_blocked: "接入端在封禁名单中",
};

export function rejectReasonLabel(reason: string): string {
  return REJECT_REASON_LABEL[reason] ?? reason;
}

export function warnLabel(w: string): string {
  const map: [RegExp, string][] = [
    [/^soft-trim-defaulted:\s*/i, "软顶默认："],
    [/^lore-no-hit/i, "知识条目未命中"],
    [/^world-book-no-hit/i, "知识条目未命中"],
    [/^degraded:\s*/i, "降级："],
    [/context-reserve\((\d+)\)/i, "上下文预留($1)"],
    [/^dialogue-system-role-dropped/i, "dialogue 中的 system 角色已丢弃（仅保留 user/assistant）"],
    // 记忆审计（需要 engine 选项 auditMemory: true）
    [/^memory-lost-protected:【([^】]+)】[:：]?(.*)$/i, "记忆丢失（受保护栏目 $1）：$2"],
    [/^memory-lost-column:【([^】]+)】[:：]?(.*)$/i, "记忆丢失（$1）：$2"],
    [/^memory-sacrifice-order-violated/i, "记忆牺牲顺序异常：受保护栏目先被丢，可牺牲栏目却完整"],
    [/^memory-unknown-column[:：]?(.*)$/i, "未知记忆栏目（格式漂移）：$1"],
    // 预算压力：更具体的规则必须排在通配规则之前，否则永远不会命中
    [/^pressure-drop-lore[:：]all/i, "压力剥离全部知识条目"],
    [/^pressure-drop-lore[:：](.*)$/i, "压力剥离知识条目：$1"],
    [/^pressure-drop-vector/i, "压力剥离语义召回"],
    [/^prompt-budget-trimmed[:：](.*)$/i, "提示词按预算裁剪：$1"],
    [/^hard-fit-violated[:：](.*)$/i, "超出硬顶：$1"],
    // 记忆文档格式
    [/^memory-block/i, "记忆块相关告警"],
  ];
  let out = w;
  for (const [re, rep] of map) out = out.replace(re, rep);
  return out;
}
