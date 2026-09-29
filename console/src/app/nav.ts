import { Activity, Boxes, Cpu, Network, Server, Settings2, Terminal, Waves } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type NavItem = {
  to: string;
  label: string;
  desc: string;
  Icon: LucideIcon;
  end?: boolean;
  group: NavGroupId;
};

export type NavGroupId = "observe" | "tools";

export const NAV_GROUPS: { id: NavGroupId; label: string }[] = [
  { id: "observe", label: "观测" },
  { id: "tools", label: "工具" },
];

export const NAV: NavItem[] = [
  {
    to: "/",
    label: "总览",
    desc: "实时装配流水线、预算压力与接入主机",
    Icon: Activity,
    end: true,
    group: "observe",
  },
  {
    to: "/stream",
    label: "回合",
    desc: "逐回合明细：词元、耗时、缓存与告警",
    Icon: Waves,
    group: "observe",
  },
  {
    to: "/hosts",
    label: "主机",
    desc: "每个接入端的调用量、缓存命中与健康度",
    Icon: Server,
    group: "observe",
  },
  {
    to: "/topology",
    label: "拓扑",
    desc: "端口接线归属、生效提供方与被压制者",
    Icon: Boxes,
    group: "observe",
  },
  {
    to: "/gateway",
    label: "网关",
    desc: "三网隔离监听、端口启停与接入引导",
    Icon: Network,
    group: "tools",
  },
  {
    to: "/playground",
    label: "调试",
    desc: "直接调用 /v1/prepare,支持 A/B 覆盖对照",
    Icon: Terminal,
    group: "tools",
  },
  {
    to: "/cluster",
    label: "集群",
    desc: "多核算力、Worker 弹性伸缩与并发调度",
    Icon: Cpu,
    group: "tools",
  },
  {
    to: "/settings",
    label: "设置",
    desc: "主题、密度、鉴权与本机端点",
    Icon: Settings2,
    group: "tools",
  },
];

export function activeNav(pathname: string): NavItem {
  const hit = NAV.find((n) => (n.end ? pathname === "/" : pathname.startsWith(n.to)));
  return hit ?? NAV[0]!;
}

export function isActive(item: NavItem, pathname: string): boolean {
  return item.end ? pathname === "/" : pathname.startsWith(item.to);
}