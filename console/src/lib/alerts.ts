import type { TurnRecord } from "./types";

export type LocalAlert = {
  id: string;
  tone: "warn" | "bad";
  title: string;
  detail: string;
};

const CONSECUTIVE_DEGRADED = 3;
const WINDOW = 8;

/**
 * 从最近回合里推导出「值得抬头看一眼」的三类信号。
 * 只看实时回合（replayed 的历史记录不算,否则一导入日志就满屏告警）。
 */
export function computeAlerts(turnsNewestFirst: TurnRecord[]): LocalAlert[] {
  const live = turnsNewestFirst.filter((t) => !t.replayed);
  if (live.length < 2) return [];
  const alerts: LocalAlert[] = [];

  let streak = 0;
  for (const t of live) {
    if (t.degraded) streak += 1;
    else break;
  }
  if (streak >= CONSECUTIVE_DEGRADED) {
    alerts.push({
      id: "degraded-streak",
      tone: "bad",
      title: `连续 ${streak} 轮降级`,
      detail: "装配或压缩在走失败兜底。到「回合」页看具体告警与步骤。",
    });
  }

  const recentDrop = live.slice(0, 5).find((t) => t.emergencyDropped > 0);
  if (recentDrop) {
    alerts.push({
      id: "emergency-drop",
      tone: "bad",
      title: `紧急裁剪：丢弃 ${recentDrop.emergencyDropped} 条`,
      detail: `宿主 ${recentDrop.hostName ?? recentDrop.hostId} 的提示词装不下当前预算。`,
    });
  }

  const fills = [...live.slice(0, WINDOW)]
    .reverse()
    .map((t) => t.fill ?? 0)
    .filter((f) => f > 0);

  if (fills.length >= 4) {
    let rising = true;
    for (let i = 1; i < fills.length; i += 1) {
      if (fills[i]! < fills[i - 1]!) {
        rising = false;
        break;
      }
    }
    const last = fills[fills.length - 1]!;
    if (rising && last >= 0.85) {
      alerts.push({
        id: "fill-rising",
        tone: "warn",
        title: `填充率爬升至 ${Math.round(last * 100)}%`,
        detail: "近期填充率单调上升且逼近软顶,下一轮可能触发裁剪。",
      });
    }
  }

  return alerts;
}