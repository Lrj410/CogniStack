/**
 * CogniStack 接入协议 — 外部系统如何把能力接到引擎上。
 *
 * 为什么需要协议
 * -------------
 * 引擎只保留基础服务（拼装 / 预算 / 软顶 / 水位线 / 结构化记忆 / 向量检索）。
 * 世界书、角色卡校验、预设、正则这些**领域逻辑**一概不在引擎里 —— 它们是外部
 * 系统的能力。协议定义了一个系统如何声明"我能提供什么"，引擎据此自动接线。
 *
 * 自动处理的三条规则
 * -----------------
 * 1. `connect(manifest)` 时，manifest.provides 里声明的端口立即生效；
 * 2. 多个系统提供同一个端口时，`priority` 小者优先，同级先到者先得；
 * 3. `close()` 断开后端口自动回退到下一个提供方，没有提供方就回退到引擎缺省。
 *
 * 引擎在任何接线变化后重建装配器，调用方无需手动刷新。
 */
import type { AssembleCollaborators } from "./ports";

/** 引擎认识的端口名。 */
export type PortName = keyof AssembleCollaborators;

export const PORT_NAMES: PortName[] = [
  "card",
  "macros",
  "lore",
  "state",
  "preset",
  "regex",
  "vector",
  "tools",
  "mcp",
];

/** Modern Agent primary ports: tools, knowledge/mcp, retrieval. */
export const MODERN_PORT_NAMES: PortName[] = ["tools", "mcp", "lore", "vector"];

/** Context & compatibility ports: profiles, templates, scripts. */
export const CONTEXT_PORT_NAMES: PortName[] = ["card", "macros", "state", "preset", "regex"];

/** 一个外部系统接入时提交的清单。 */
export type ConnectManifest = {
  /** 稳定 id —— 重复 connect 同一 id 会刷新而不是新建。 */
  id: string;
  name: string;
  /** service / client / worker / cli …（面板按此着色） */
  kind?: string | undefined;
  version?: string | undefined;
  /** 该系统向引擎提供的端口实现。提供哪个接哪个，其余用缺省。 */
  provides?: Partial<AssembleCollaborators> | undefined;
  /** 该系统依赖哪些端口（信息性，面板用它画依赖）。 */
  requires?: PortName[] | undefined;
  /**
   * 端口优先级：多系统争抢同一端口时数值小者优先。缺省 100。
   * 构造函数里直接注入的 collaborators 优先级最高（视为显式覆写）。
   */
  priority?: number | undefined;
  /** 附加信息，面板原样展示。 */
  meta?: Record<string, string | number | boolean> | undefined;
};

/** 端口 → 提供方 的归属记录。 */
export type PortBinding = {
  port: PortName;
  /** 提供方连接 id；null = 引擎缺省。 */
  providerId: string | null;
  providerName: string | null;
};

/**
 * One port's full competition state.
 *
 * `table()` answers "who won". That is not enough to debug a wiring problem:
 * multi-provider contention is an *intended* usage (priority ordering, FIFO at
 * equal priority, fallback on `close()`), so the interesting failure is "my
 * provider connected but is not in effect". Without the shadowed list, the only
 * symptom is a feature that quietly does nothing.
 */
export type PortDiagnostic = {
  port: PortName;
  /** True when a registered connection (not the built-in default) provides it. */
  bound: boolean;
  /** Who is live. `providerId: null` = built-in default or nothing. */
  winner: {
    providerId: string | null;
    providerName: string | null;
    /** null for a built-in default (it has no registration). */
    priority: number | null;
    builtin: boolean;
  };
  /** Providers that lost the port, ordered by the same rule as `resolve()`. */
  shadowed: { providerId: string; providerName: string; priority: number }[];
};

type Registration<T> = {
  connId: string;
  name: string;
  priority: number;
  seq: number;
  impls: Partial<T>;
};

/**
 * 端口注册表：按 (priority, seq) 解析出每个端口的胜者。
 *
 * 独立成类而不是散在引擎里，是因为"多提供方竞争 + 断开回退"值得单测 ——
 * 这正是协议最容易写错的部分。
 */
export class PortRegistry<T extends object> {
  private readonly regs = new Map<string, Registration<T>[]>();
  private seq = 0;

  /** 登记一个提供方的一组端口实现。同 connId 重复调用 = 刷新。 */
  register(connId: string, name: string, impls: Partial<T>, priority = 100): void {
    if (!Number.isFinite(priority) || priority < 0) {
      throw new Error(`priority must be a non-negative finite number (got ${priority})`);
    }
    const pri = Math.floor(priority);
    // Preserve arrival seq on refresh so equal-priority FIFO ("先到者先得") holds.
    let arrivalSeq: number;
    const existing = this.regs.get(connId);
    if (existing?.length) {
      arrivalSeq = Math.min(...existing.map((r) => r.seq));
    } else {
      arrivalSeq = this.seq++;
    }
    this.unregister(connId);
    const list: Registration<T>[] = [];
    for (const [key, impl] of Object.entries(impls) as [keyof T & string, T[keyof T]][]) {
      if (impl == null) continue;
      list.push({
        connId,
        name,
        priority: pri,
        seq: arrivalSeq,
        impls: { [key]: impl } as Partial<T>,
      });
    }
    if (list.length) this.regs.set(connId, list);
  }

  unregister(connId: string): void {
    this.regs.delete(connId);
  }

  has(connId: string): boolean {
    return this.regs.has(connId);
  }

  /** 当前生效的合并结果：每个端口取优先级最高（同级取先注册）的实现。 */
  resolve(): Partial<T> {
    const flat: Registration<T>[] = [];
    for (const list of this.regs.values()) flat.push(...list);
    flat.sort((a, z) => a.priority - z.priority || a.seq - z.seq);

    const out: Partial<T> = {};
    for (const reg of flat) {
      for (const key of Object.keys(reg.impls) as (keyof T & string)[]) {
        if (out[key] === undefined) {
          (out as Record<string, unknown>)[key] = reg.impls[key];
        }
      }
    }
    return out;
  }

  /** 端口归属表（含缺省占位），面板拓扑直接消费。 */
  table(defaultProviderNames: Partial<Record<keyof T & string, string>> = {}): PortBinding[] {
    const owners = new Map<string, Registration<T>>();
    const flat: Registration<T>[] = [];
    for (const list of this.regs.values()) flat.push(...list);
    flat.sort((a, z) => a.priority - z.priority || a.seq - z.seq);
    for (const reg of flat) {
      for (const key of Object.keys(reg.impls) as (keyof T & string)[]) {
        if (!owners.has(key)) owners.set(key, reg);
      }
    }

    const keys = new Set<string>([
      ...(PORT_NAMES as string[]),
      ...Object.keys(defaultProviderNames),
      ...flat.flatMap((r) => Object.keys(r.impls)),
    ]);

    const defaults = defaultProviderNames as Record<string, string | undefined>;
    return [...keys].sort().map((port) => {
      const owner = owners.get(port);
      if (owner) {
        return { port: port as PortName, providerId: owner.connId, providerName: owner.name };
      }
      return {
        port: port as PortName,
        providerId: null,
        providerName: defaults[port] ?? null,
      };
    });
  }

  /**
   * 每个端口的完整竞争状态：谁在生效、谁被压制。
   *
   * 与 `table()` 的区别：`table()` 只回答"谁赢了"。多方争抢是设计内的用法
   * （priority 抢占、同级先到先得、close() 回退），所以真正难查的是
   * "我的提供方接上了却没生效"——没有 shadowed 列表，症状只有一个功能静默地不做事。
   */
  diagnostics(defaultProviderNames: Partial<Record<keyof T & string, string>> = {}): PortDiagnostic[] {
    const flat: Registration<T>[] = [];
    for (const list of this.regs.values()) flat.push(...list);
    flat.sort((a, z) => a.priority - z.priority || a.seq - z.seq);

    const providers = new Map<string, Registration<T>[]>();
    for (const reg of flat) {
      for (const key of Object.keys(reg.impls)) {
        const list = providers.get(key);
        if (list) list.push(reg);
        else providers.set(key, [reg]);
      }
    }

    const keys = new Set<string>([
      ...(PORT_NAMES as string[]),
      ...Object.keys(defaultProviderNames),
      ...providers.keys(),
    ]);
    const defaults = defaultProviderNames as Record<string, string | undefined>;

    return [...keys].sort().map((port) => {
      const list = providers.get(port) ?? [];
      const head = list[0];
      if (head) {
        return {
          port: port as PortName,
          bound: true,
          winner: {
            providerId: head.connId,
            providerName: head.name,
            priority: head.priority,
            builtin: false,
          },
          shadowed: list.slice(1).map((r) => ({
            providerId: r.connId,
            providerName: r.name,
            priority: r.priority,
          })),
        };
      }
      const builtinName = defaults[port] ?? null;
      return {
        port: port as PortName,
        bound: false,
        winner: {
          providerId: null,
          providerName: builtinName,
          priority: null,
          // "未接入" is an absence, not a built-in implementation.
          builtin: builtinName !== null && builtinName !== "未接入",
        },
        shadowed: [],
      };
    });
  }

  /** 哪个连接提供了该端口（按与 resolve() 相同的优先级规则）；null = 缺省或未接。 */
  providerOf(port: keyof T & string): string | null {    const flat: Registration<T>[] = [];
    for (const list of this.regs.values()) flat.push(...list);
    flat.sort((a, z) => a.priority - z.priority || a.seq - z.seq);
    for (const reg of flat) {
      if (reg.impls[port] != null) return reg.connId;
    }
    return null;
  }

  clear(): void {
    this.regs.clear();
  }
}
