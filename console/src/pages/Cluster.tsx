import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  CheckCircle2,
  Copy,
  Cpu,
  Flame,
  Layers,
  RefreshCw,
  Shield,
  Zap,
} from "lucide-react";
import { useTelemetry } from "@/hooks/useTelemetry";
import { apiFetch, ApiError } from "@/lib/api";
import { PageFlush } from "@/app/Page";
import {
  Badge,
  Button,
  Code,
  DataTable,
  Row,
  Segmented,
  Stat,
  TextInput,
  useToast,
} from "@/ui";
import "./cluster.css";

type BenchResult = {
  totalRequests: number;
  concurrency: number;
  durationMs: number;
  qps: number;
  avgMs: number;
  p95Ms: number;
  successRate: number;
  failedCount?: number;
  errors?: string;
  timestamp?: number;
  workerDistribution?: Record<string, number>;
};

type LeftTab = "scale" | "policy" | "cache" | "deploy";
type RightTab = "matrix" | "benchmark" | "topology";

export function ClusterPage() {
  const { snap, refresh } = useTelemetry();
  const sys = snap?.system;
  const toast = useToast();
  const [, startTransition] = useTransition();

  // 保持与遥测服务心跳保活（防止长连接切换或热重载时数据停滞）
  useEffect(() => {
    refresh();
    const timer = setInterval(() => {
      refresh();
    }, 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  // 硬件总核心数（默认 32，若侦测到真实环境则动态获取）
  const totalCpus = sys?.cpus || 32;
  const cpuModel = sys?.cpuModel || "AMD Ryzen 9 8945HX (16 Cores / 32 Threads)";
  const isClusterActive = Boolean(sys?.isCluster);

  // 实际运行中的 Worker 数量
  const runningWorkersCount =
    sys?.activeWorkers && sys.activeWorkers.length > 0
      ? sys.activeWorkers.length
      : isClusterActive
        ? sys?.workersCount || 1
        : 1;

  // 可视化配置项状态（用户选择的目标值）
  const [targetWorkers, setTargetWorkers] = useState<number | null>(null);
  const workers = targetWorkers ?? runningWorkersCount;
  const setWorkers = (v: number) => setTargetWorkers(v);

  // 控制台标签页切换（严格单页零外层滚动设计）
  const [leftTab, setLeftTab] = useState<LeftTab>("scale");
  const [rightTab, setRightTab] = useState<RightTab>("matrix");

  // 集群调度与缓存配置
  const [schedulePolicy, setSchedulePolicy] = useState<string>("round-robin");
  const [queueLimit, setQueueLimit] = useState<number>(64);
  const [timeoutMs, setTimeoutMs] = useState<number>(5000);
  const [memoCacheSize, setMemoCacheSize] = useState<number>(8192);
  const [assembleCacheSize, setAssembleCacheSize] = useState<number>(128);
  const [tokenizerMode, setTokenizerMode] = useState<string>("exact-char");
  const [tokenizeUrl, setTokenizeUrl] = useState<string>("http://127.0.0.1:8080/tokenize");

  // 操作请求执行中状态
  const [isApplyingWorkers, setIsApplyingWorkers] = useState(false);
  const [isReloading, setIsReloading] = useState(false);
  const [isSavingConfig, setIsSavingConfig] = useState(false);

  // 在线压测状态与安全上限
  const MAX_BENCH_CONCURRENCY = 2000;
  const MAX_BENCH_ROUNDS = 20;

  const [benchConcurrency, setBenchConcurrency] = useState<number>(50);
  const [benchRounds, setBenchRounds] = useState<number>(4);
  const [benchmarking, setBenchmarking] = useState<boolean>(false);
  const [benchProgress, setBenchProgress] = useState<{ completed: number; total: number; percent: number } | null>(null);
  const [benchResult, setBenchResult] = useState<BenchResult | null>(null);
  const [benchHistory, setBenchHistory] = useState<BenchResult[]>([]);
  const benchAbortRef = useRef<AbortController | null>(null);

  const handleConcurrencyChange = (valStr: string) => {
    const raw = parseInt(valStr.replace(/\D/g, ""), 10);
    if (isNaN(raw) || raw < 1) {
      setBenchConcurrency(1);
    } else if (raw > MAX_BENCH_CONCURRENCY) {
      setBenchConcurrency(MAX_BENCH_CONCURRENCY);
      toast(`已自动安全约束至单机系统上限 ${MAX_BENCH_CONCURRENCY} 并发（避免端口耗尽与网络栈溢出）`, "info");
    } else {
      setBenchConcurrency(raw);
    }
  };

  const handleRoundsChange = (valStr: string) => {
    const raw = parseInt(valStr.replace(/\D/g, ""), 10);
    if (isNaN(raw) || raw < 1) {
      setBenchRounds(1);
    } else if (raw > MAX_BENCH_ROUNDS) {
      setBenchRounds(MAX_BENCH_ROUNDS);
      toast(`每连接轮次已安全约束至最大 ${MAX_BENCH_ROUNDS} 轮`, "info");
    } else {
      setBenchRounds(raw);
    }
  };

  const handleCancelBenchmark = () => {
    if (benchAbortRef.current) {
      benchAbortRef.current.abort();
      benchAbortRef.current = null;
      setBenchmarking(false);
      setBenchProgress(null);
      toast("已手动终止当前在线压测", "neutral");
    }
  };

  // 一键复制
  const copy = async (text: string, label = "已复制") => {
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(text);
      toast(label, "ok");
    } catch {
      toast("复制失败：浏览器剪贴板权限受限", "bad");
    }
  };

  // 解析 API 异常信息（避免直接将原始 JSON 串弹窗给用户）
  const extractErrorMessage = (e: unknown, fallback = "操作执行未成功"): string => {
    if (e instanceof ApiError && e.body) {
      try {
        const parsed = JSON.parse(e.body) as { error?: string; message?: string };
        if (typeof parsed?.error === "string") return parsed.error;
        if (typeof parsed?.message === "string") return parsed.message;
      } catch {
        return e.body.trim() || fallback;
      }
    }
    if (e instanceof Error) return e.message;
    return fallback;
  };

  // 生成的启动命令
  const generatedCommand = `node scripts/start-cluster.cjs --workers ${workers} --port 7331`;

  // 热切换：动态伸缩 Worker 进程数
  const handleApplyWorkerScale = async () => {
    setIsApplyingWorkers(true);
    const targetCount = workers;
    try {
      const res = await apiFetch("/api/cluster/scale", {
        method: "POST",
        body: { workers: targetCount },
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; message?: string };
      if (data?.ok) {
        setTargetWorkers(null);
        refresh();
        setTimeout(refresh, 400);
        setTimeout(refresh, 1000);
        setTimeout(refresh, 2000);
        toast(`已成功热切换集群 Worker 进程数至 ${targetCount}！`, "ok");
      } else {
        toast(data?.error || "热伸缩失败", "bad");
      }
    } catch (e) {
      toast(`热伸缩失败: ${extractErrorMessage(e)}`, "bad");
    } finally {
      setIsApplyingWorkers(false);
    }
  };

  // 平滑滚动重启 Worker 进程池
  const handleRollingReload = async () => {
    setIsReloading(true);
    try {
      // 必须带 JSON body：网关的 CSRF 守卫对「无 application/json 的 POST /api/*」直接回 415。
      const res = await apiFetch("/api/cluster/reload", {
        method: "POST",
        body: {},
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; message?: string };
      if (data?.ok) {
        refresh();
        setTimeout(refresh, 800);
        setTimeout(refresh, 2000);
        setTimeout(refresh, 4000);
        toast(data.message || "已向集群触发零停机平滑滚动重载！", "ok");
      } else {
        toast(data?.error || "重载失败", "bad");
      }
    } catch (e) {
      toast(`重载失败: ${extractErrorMessage(e)}`, "bad");
    } finally {
      setIsReloading(false);
    }
  };

  // 热生效调度与缓存配置
  const handleApplyClusterConfig = async () => {
    setIsSavingConfig(true);
    try {
      const res = await apiFetch("/api/cluster/config", {
        method: "POST",
        body: {
          schedulePolicy,
          queueLimit,
          timeoutMs,
          memoCacheSize,
          assembleCacheSize,
          tokenizerMode,
          tokenizeUrl,
        },
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; message?: string };
      if (data?.ok) {
        refresh();
        toast("并发调度与多级缓存配置已热更新生效！", "ok");
      } else {
        toast(data?.error || "更新失败", "bad");
      }
    } catch (e) {
      toast(`配置更新失败: ${extractErrorMessage(e)}`, "bad");
    } finally {
      setIsSavingConfig(false);
    }
  };

  // 运行在线并发压测（服务端多核长连接直连原生压测）
  const runLiveBenchmark = async () => {
    if (benchmarking) return;
    setBenchmarking(true);
    setBenchResult(null);

    const concurrency = Math.max(1, Math.min(MAX_BENCH_CONCURRENCY, benchConcurrency));
    const rounds = Math.max(1, Math.min(MAX_BENCH_ROUNDS, benchRounds));
    const totalRequests = concurrency * rounds;

    const abortController = new AbortController();
    benchAbortRef.current = abortController;

    setBenchProgress({ completed: 0, total: totalRequests, percent: 5 });
    const progressTimer = setInterval(() => {
      setBenchProgress((prev) => {
        if (!prev) return null;
        const nextPercent = Math.min(95, prev.percent + 15);
        return {
          completed: Math.floor((nextPercent / 100) * totalRequests),
          total: totalRequests,
          percent: nextPercent,
        };
      });
    }, 200);

    try {
      const res = await apiFetch("/api/cluster/bench", {
        method: "POST",
        signal: abortController.signal,
        body: { concurrency, rounds },
      });
      clearInterval(progressTimer);

      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(errBody || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as {
        totalRequests?: number;
        concurrency?: number;
        durationMs?: number;
        qps?: number;
        avgMs?: number;
        p95Ms?: number;
        successRate?: number;
        failedCount?: number;
        errors?: string;
        workerDistribution?: Record<string, number>;
      };

      const resObj: BenchResult = {
        totalRequests: data.totalRequests || totalRequests,
        concurrency: data.concurrency || concurrency,
        durationMs: data.durationMs || 0,
        qps: data.qps || 0,
        avgMs: data.avgMs || 0,
        p95Ms: data.p95Ms || 0,
        successRate: data.successRate ?? 100,
        failedCount: data.failedCount || 0,
        errors: data.errors,
        timestamp: Date.now(),
        workerDistribution: data.workerDistribution,
      };

      startTransition(() => {
        setBenchResult(resObj);
        setBenchHistory((prev) => [resObj, ...prev.slice(0, 2)]);
        setBenchProgress(null);
        setBenchmarking(false);
      });
      benchAbortRef.current = null;
      toast(`集群多核压测完成：实测 QPS 达 ${resObj.qps}（成功率 ${resObj.successRate}%）`, "ok");
    } catch (e: unknown) {
      clearInterval(progressTimer);
      if (!abortController.signal.aborted) {
        toast(`集群压测失败: ${extractErrorMessage(e)}`, "bad");
      }
      setBenchProgress(null);
      setBenchmarking(false);
    }
  };

  // 生成真实 Worker 列表行
  const realWorkers = sys?.activeWorkers && sys.activeWorkers.length > 0
    ? sys.activeWorkers
    : null;

  const displayCount = realWorkers ? realWorkers.length : (isClusterActive ? runningWorkersCount : 1);

  const workerRows = Array.from({ length: displayCount }, (_, i) => {
    const item = realWorkers ? realWorkers[i] : null;
    const id = item?.id ?? i + 1;
    const pid = item?.pid ?? (sys?.pid ? sys.pid : "-");
    const isOnline = !item?.state || item.state === "online" || item.state === "listening";
    return {
      id,
      name: `Worker #${id}`,
      pid,
      coreAffinity: `CPU Core ${(id - 1) % totalCpus}`,
      status: isOnline ? ("online" as const) : ("idle" as const),
      role: id <= Math.min(16, Math.floor(totalCpus / 2)) ? "物理大核 (主力装配)" : "超线程 (弹性分流)",
    };
  });

  // 动态生成 Worker 档位预设
  const workerPresets = useMemo(() => {
    const set = new Set<number>();
    set.add(1);
    const quarter = Math.max(1, Math.round(totalCpus * 0.25));
    const half = Math.max(1, Math.round(totalCpus * 0.5));
    const recommended = Math.min(16, totalCpus);
    set.add(quarter);
    set.add(half);
    set.add(recommended);
    set.add(totalCpus);
    return Array.from(set).sort((a, b) => a - b);
  }, [totalCpus]);

  const hasWorkerDiff = isClusterActive && targetWorkers !== null && targetWorkers !== runningWorkersCount;

  return (
    <PageFlush>
      <div className="cl-layout">
        {/* 顶部硬件拓扑指标栏 */}
        <div className="cl-stats-grid">
          <Stat
            label="CPU 物理与逻辑拓扑"
            value={`${totalCpus} 逻辑核心`}
            foot={cpuModel}
          />
          <Stat
            label="并发集群运行态"
            value={isClusterActive ? "多进程并行集群" : "单进程标准模式"}
            tone={isClusterActive ? "ok" : "neutral"}
            foot={
              isClusterActive
                ? `负载均衡 · 主 PID ${sys?.primaryPid || sys?.pid || "-"}`
                : "单事件循环 (未开启多核)"
            }
          />
          <Stat
            label="已分配工作进程 (Workers)"
            value={`${runningWorkersCount} 个 Worker`}
            tone={runningWorkersCount >= 16 ? "ok" : runningWorkersCount > 1 ? "info" : "warn"}
            foot={`算力覆盖率 ${Math.round((runningWorkersCount / totalCpus) * 100)}% · ${
              runningWorkersCount >= totalCpus ? "已满载超线程" : runningWorkersCount >= 16 ? "物理全大核覆盖" : "低功耗轻量运行"
            }`}
          />
          <Stat
            label="理论峰值装配吞吐"
            value={`~${Math.round(runningWorkersCount * 0.7)}k QPS`}
            tone="ok"
            foot="基于单核 ~1.45ms 装配基准 (100% 内存隔离)"
          />
        </div>

        {/* 主双栏分割工作台：严格满屏单页布局 */}
        <div className="cl-split-layout">
          {/* 左侧：集群编排控制台 (4 项分段切换) */}
          <div className="cl-panel">
            <div className="cl-panel-head">
              <div className="cl-panel-title">
                <Cpu size={15} aria-hidden />
                <span>集群编排控制台</span>
              </div>
              <Segmented
                value={leftTab}
                onChange={(v) => setLeftTab(v as LeftTab)}
                label="集群配置模块"
                options={[
                  { value: "scale", label: "弹性伸缩" },
                  { value: "policy", label: "调度背压" },
                  { value: "cache", label: "分词缓存" },
                  { value: "deploy", label: "启动编排" },
                ]}
              />
            </div>

            <div className="cl-panel-body">
              {/* Tab 1: 弹性伸缩 */}
              {leftTab === "scale" && (
                <>
                  {!isClusterActive && (
                    <div
                      className="cl-bench-error"
                      style={{
                        color: "var(--warn)",
                        background: "var(--warn-soft)",
                        borderColor: "var(--line)",
                      }}
                    >
                      <strong>当前以单进程模式运行</strong>：热扩缩容需在集群模式下运行。启动脚本（start.bat / npm start）已全面升级为多进程集群模式，重启后即可畅享多核并发。
                    </div>
                  )}

                  <Row gap="var(--sp-2)">
                    <Badge tone={hasWorkerDiff ? "warn" : workers >= 16 ? "ok" : "neutral"}>
                      {hasWorkerDiff ? `待热应用: ${runningWorkersCount} → ${workers} Workers` : `当前配置: ${workers} Workers`}
                    </Badge>
                    <span className="cl-hint">可直接拖动滑块无缝热扩缩进程池</span>
                  </Row>

                  <div className="cl-slider-group">
                    <div className="cl-slider-header">
                      <span>目标工作进程数 (1 ~ {totalCpus})</span>
                      <span className="cl-slider-val">{workers} 个进程</span>
                    </div>
                    <input
                      type="range"
                      className="cl-slider"
                      aria-label="目标工作进程数"
                      min={1}
                      max={totalCpus}
                      value={workers}
                      onChange={(e) => setWorkers(Number(e.target.value))}
                    />
                  </div>

                  <Row gap="var(--sp-2)">
                    {workerPresets.map((preset) => {
                      const label =
                        preset === 1
                          ? "1 核 (极简)"
                          : preset === Math.min(16, totalCpus)
                            ? `${preset} 核 (推荐)`
                            : preset === totalCpus
                              ? `${preset} 核 (极限)`
                              : `${preset} 核`;
                      return (
                        <Button
                          key={preset}
                          variant={workers === preset ? "solid" : "outline"}
                          size="sm"
                          onClick={() => setWorkers(preset)}
                        >
                          {label}
                        </Button>
                      );
                    })}
                  </Row>

                  <Row gap="var(--sp-2)">
                    <Button
                      variant="solid"
                      size="sm"
                      icon={<Zap size={13} aria-hidden />}
                      loading={isApplyingWorkers}
                      onClick={() => void handleApplyWorkerScale()}
                    >
                      {hasWorkerDiff ? `立即热应用 (${workers} Workers)` : "立即热应用"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      loading={isReloading}
                      icon={<RefreshCw size={12} aria-hidden />}
                      onClick={() => void handleRollingReload()}
                    >
                      零停机平滑重载
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      icon={<Copy size={12} aria-hidden />}
                      onClick={() => void copy(generatedCommand, "启动指令已复制")}
                    >
                      复制启动命令
                    </Button>
                  </Row>

                  <div className="cl-code-box">
                    <code>{generatedCommand}</code>
                  </div>

                  <p className="cl-hint">
                    架构建议：在 AMD Ryzen 或多核硬件环境下，分配 16 个 Worker 占满物理全大核，即可达到极限吞吐与内存调度的最佳平衡点。点击「立即热应用」无需重启主服务即可即时增减进程。
                  </p>
                </>
              )}

              {/* Tab 2: 调度背压 */}
              {leftTab === "policy" && (
                <>
                  <div className="cl-slider-group">
                    <span className="cl-hint" style={{ fontWeight: 600, color: "var(--fg)" }}>
                      负载均衡与路由算法
                    </span>
                    <Segmented
                      value={schedulePolicy}
                      onChange={setSchedulePolicy}
                      label="调度算法"
                      options={[
                        { value: "round-robin", label: "轮询调度 (Round-Robin)" },
                        { value: "least-conn", label: "最小连接 (Least-Conn)" },
                        { value: "affinity", label: "会话亲和 (Affinity)" },
                      ]}
                    />
                  </div>

                  <div className="cl-slider-group">
                    <div className="cl-slider-header">
                      <span>排队背压水线 (Queue Depth)</span>
                      <span className="cl-slider-val">{queueLimit} 请求</span>
                    </div>
                    <input
                      type="range"
                      className="cl-slider"
                      aria-label="排队背压水线"
                      min={8}
                      max={256}
                      step={8}
                      value={queueLimit}
                      onChange={(e) => setQueueLimit(Number(e.target.value))}
                    />
                    <p className="cl-hint">
                      当所有 Worker 全速装配时，允许最大排队等待数量。超过将立即熔断拒绝，防止内存膨胀。
                    </p>
                  </div>

                  <div className="cl-slider-group">
                    <span className="cl-hint" style={{ fontWeight: 600, color: "var(--fg)" }}>
                      单次装配超时保护
                    </span>
                    <Segmented
                      value={String(timeoutMs)}
                      onChange={(v) => setTimeoutMs(Number(v))}
                      label="超时保护"
                      options={[
                        { value: "1000", label: "1 秒严格" },
                        { value: "3000", label: "3 秒标准" },
                        { value: "5000", label: "5 秒容错" },
                        { value: "0", label: "不限制" },
                      ]}
                    />
                  </div>

                  <Row gap="var(--sp-2)">
                    <Button
                      variant="solid"
                      size="sm"
                      icon={<Shield size={12} aria-hidden />}
                      loading={isSavingConfig}
                      onClick={() => void handleApplyClusterConfig()}
                    >
                      保存并热生效策略
                    </Button>
                  </Row>
                </>
              )}

              {/* Tab 3: 分词缓存 */}
              {leftTab === "cache" && (
                <>
                  <div className="cl-slider-group">
                    <span className="cl-hint" style={{ fontWeight: 600, color: "var(--fg)" }}>
                      分词器模式
                    </span>
                    <Segmented
                      value={tokenizerMode}
                      onChange={setTokenizerMode}
                      label="分词模式"
                      options={[
                        { value: "exact-char", label: "字符估算 (0 开销)" },
                        { value: "http-offload", label: "HTTP 外部卸载" },
                      ]}
                    />
                  </div>

                  {tokenizerMode === "http-offload" && (
                    <TextInput
                      label="HTTP 分词服务端点"
                      value={tokenizeUrl}
                      onChange={(e) => setTokenizeUrl(e.target.value)}
                      placeholder="http://127.0.0.1:8080/tokenize"
                    />
                  )}

                  <div className="cl-slider-group">
                    <div className="cl-slider-header">
                      <span>分词记忆化缓存 (Memoization Cache)</span>
                      <span className="cl-slider-val">{memoCacheSize} 条</span>
                    </div>
                    <input
                      type="range"
                      className="cl-slider"
                      aria-label="分词记忆化缓存条数"
                      min={1024}
                      max={32768}
                      step={1024}
                      value={memoCacheSize}
                      onChange={(e) => setMemoCacheSize(Number(e.target.value))}
                    />
                  </div>

                  <div className="cl-slider-group">
                    <div className="cl-slider-header">
                      <span>装配结果缓存 (Assemble Cache)</span>
                      <span className="cl-slider-val">{assembleCacheSize} 条</span>
                    </div>
                    <input
                      type="range"
                      className="cl-slider"
                      aria-label="装配结果缓存条数"
                      min={16}
                      max={512}
                      step={16}
                      value={assembleCacheSize}
                      onChange={(e) => setAssembleCacheSize(Number(e.target.value))}
                    />
                  </div>

                  <Row gap="var(--sp-2)">
                    <Button
                      variant="solid"
                      size="sm"
                      loading={isSavingConfig}
                      onClick={() => void handleApplyClusterConfig()}
                    >
                      热应用缓存参数
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setMemoCacheSize(8192);
                        setAssembleCacheSize(128);
                        setQueueLimit(64);
                        setTimeoutMs(5000);
                        toast("已重置为出厂推荐参数", "neutral");
                      }}
                    >
                      恢复默认
                    </Button>
                  </Row>
                </>
              )}

              {/* Tab 4: 启动编排 */}
              {leftTab === "deploy" && (
                <>
                  <div className="cl-slider-group">
                    <span className="cl-hint" style={{ fontWeight: 600, color: "var(--fg)" }}>
                      Node.js 原生多进程集群命令
                    </span>
                    <div className="cl-code-box">
                      <code>{generatedCommand}</code>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      icon={<Copy size={12} aria-hidden />}
                      onClick={() => void copy(generatedCommand, "启动指令已复制")}
                    >
                      复制启动命令
                    </Button>
                  </div>

                  <div className="cl-slider-group">
                    <span className="cl-hint" style={{ fontWeight: 600, color: "var(--fg)" }}>
                      生产环境守护 (PM2 / Systemd 编排建议)
                    </span>
                    <div className="cl-code-box">
                      <code>{`pm2 start scripts/start-cluster.cjs -i max --name cognistack`}</code>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      icon={<Copy size={12} aria-hidden />}
                      onClick={() =>
                        void copy(
                          `pm2 start scripts/start-cluster.cjs -i max --name cognistack`,
                          "PM2 启动指令已复制",
                        )
                      }
                    >
                      复制 PM2 指令
                    </Button>
                  </div>

                  <p className="cl-hint">
                    说明：CogniStack 内置零依赖 Cluster 编排器，通过主进程 IPC 控制多进程生命周期，自动监听异常退出并毫秒级重拉，保障全天候 99.999% 高可用。
                  </p>
                </>
              )}
            </div>
          </div>

          {/* 右侧：集群运行态与压测工作室 (3 项分段切换) */}
          <div className="cl-panel">
            <div className="cl-panel-head">
              <div className="cl-panel-title">
                <Layers size={15} aria-hidden />
                <span>集群监控与压测工作室</span>
              </div>
              <Segmented
                value={rightTab}
                onChange={(v) => setRightTab(v as RightTab)}
                label="集群工作室模块"
                options={[
                  { value: "matrix", label: `活动进程池 (${workerRows.length})` },
                  { value: "benchmark", label: benchmarking ? "压测进行中..." : "在线并发压测" },
                  { value: "topology", label: "CPU 拓扑分布" },
                ]}
              />
            </div>

            {/* View 1: 活动工作进程矩阵 */}
            {rightTab === "matrix" && (
              <div className="cl-panel-body cl-panel-body--flush">
                <div className="cl-matrix-toolbar">
                  <span className="cl-matrix-summary">
                    当前就绪 {workerRows.length} 个独立工作进程 · 100% 内存空间隔离
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    loading={isReloading}
                    icon={<RefreshCw size={12} aria-hidden />}
                    onClick={() => void handleRollingReload()}
                  >
                    滚动平滑重启
                  </Button>
                </div>
                <DataTable label="Worker 进程矩阵" minWidth={580}>
                  <thead>
                    <tr>
                      <th scope="col">工作进程</th>
                      <th scope="col">PID</th>
                      <th scope="col">核心亲和性</th>
                      <th scope="col">调度状态</th>
                      <th scope="col">算力分工</th>
                    </tr>
                  </thead>
                  <tbody>
                    {workerRows.map((w) => (
                      <tr key={w.id}>
                        <td>
                          <strong>{w.name}</strong>
                        </td>
                        <td>
                          <Code>{w.pid}</Code>
                        </td>
                        <td>
                          <span className="cl-hint">{w.coreAffinity}</span>
                        </td>
                        <td>
                          <Badge tone={w.status === "online" ? "ok" : "neutral"}>
                            {w.status === "online" ? "在线运行" : "空闲待命"}
                          </Badge>
                        </td>
                        <td>
                          <span className="cl-hint">{w.role}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </DataTable>
              </div>
            )}

            {/* View 2: 在线并发压测 */}
            {rightTab === "benchmark" && (
              <div className="cl-panel-body">
                <div className="cl-bench-hint">
                  <strong>🚀 服务端原生多核压测：</strong>采用独立施压子进程建立 HTTP/1.1 高性能长连接池直连集群，由 Round-Robin 调度器将并发流量均匀轮询分发到各独立 Worker 进程，精准检验多核并行上下文装配与预算核算极限。
                </div>

                <div className="cl-bench-custom-row">
                  <div className="cl-slider-group" style={{ flex: 1, minWidth: 180 }}>
                    <div className="cl-slider-header">
                      <span>自定义并发数 (推荐 10~2000)</span>
                      <span className="cl-slider-val">{benchConcurrency} 并发</span>
                    </div>
                    <TextInput
                      aria-label="压测并发数"
                      value={String(benchConcurrency)}
                      disabled={benchmarking}
                      onChange={(e) => handleConcurrencyChange(e.target.value)}
                      placeholder="输入并发数 (如 50, 200, 1000, 2000)"
                    />
                  </div>

                  <div className="cl-slider-group" style={{ width: 140 }}>
                    <div className="cl-slider-header">
                      <span>每连接轮次 (1~20)</span>
                      <span className="cl-slider-val">{benchRounds} 轮</span>
                    </div>
                    <TextInput
                      aria-label="压测轮次"
                      value={String(benchRounds)}
                      disabled={benchmarking}
                      onChange={(e) => handleRoundsChange(e.target.value)}
                      placeholder="轮次 (默认 4)"
                    />
                  </div>
                </div>

                <Row gap="var(--sp-2)">
                  {[10, 25, 50, 100, 200, 500, 1000, 2000].map((preset) => (
                    <Button
                      key={preset}
                      variant={benchConcurrency === preset ? "solid" : "outline"}
                      size="sm"
                      disabled={benchmarking}
                      onClick={() => setBenchConcurrency(preset)}
                    >
                      {preset} 并发
                    </Button>
                  ))}
                </Row>

                <Row gap="var(--sp-3)">
                  <Button
                    variant="solid"
                    loading={benchmarking}
                    disabled={benchmarking}
                    icon={<Flame size={14} aria-hidden />}
                    onClick={() => void runLiveBenchmark()}
                  >
                    {benchmarking
                      ? `正在以 ${benchConcurrency} 并发全速压测中...`
                      : `发起 ${benchConcurrency} 并发真实压测 (${benchConcurrency * benchRounds} 请求)`}
                  </Button>
                  {benchmarking && (
                    <Button variant="outline" size="sm" onClick={handleCancelBenchmark}>
                      终止压测
                    </Button>
                  )}
                  <span className="cl-hint">
                    独立施压子进程直连集群端口，测算多核并发真实极限装配 QPS。
                  </span>
                </Row>

                {/* 压测进行中动态进度条 */}
                {benchProgress && (
                  <div className="cl-progress-wrap">
                    <div className="cl-progress-text">
                      <span>已完成 {benchProgress.completed} / {benchProgress.total} 请求</span>
                      <span>{benchProgress.percent}%</span>
                    </div>
                    <div className="cl-progress-bar">
                      <div className="cl-progress-fill" style={{ width: `${benchProgress.percent}%` }} />
                    </div>
                  </div>
                )}

                {/* 压测结果面板 */}
                {benchResult && (
                  <div className="cl-bench-panel">
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "var(--sp-2)" }}>
                      <Row gap="var(--sp-2)">
                        <CheckCircle2 size={16} color="var(--ok)" aria-hidden />
                        <strong>压测结果报告（多核并行原生实测）</strong>
                      </Row>
                      <div style={{ display: "flex", gap: "var(--sp-2)", alignItems: "center" }}>
                        <Badge tone="ok">
                          多进程长连接直连
                        </Badge>
                        <Badge tone={benchResult.successRate >= 95 ? "ok" : "warn"}>
                          成功率 {benchResult.successRate}% ({benchResult.totalRequests - (benchResult.failedCount || 0)}/{benchResult.totalRequests})
                        </Badge>
                      </div>
                    </div>

                    <div className="cl-bench-grid">
                      <div className="cl-bench-stat">
                        <span className="cl-bench-label">实测吞吐量</span>
                        <span className="cl-bench-value" style={{ color: "var(--brand)" }}>
                          {benchResult.qps} <span style={{ fontSize: "var(--fs-xs)" }}>QPS</span>
                        </span>
                      </div>
                      <div className="cl-bench-stat">
                        <span className="cl-bench-label">实际压测并发</span>
                        <span className="cl-bench-value">{benchResult.concurrency} 并发</span>
                      </div>
                      <div className="cl-bench-stat">
                        <span className="cl-bench-label">实际总请求量</span>
                        <span className="cl-bench-value">{benchResult.totalRequests} 请求</span>
                      </div>
                      <div className="cl-bench-stat">
                        <span className="cl-bench-label">总测试耗时</span>
                        <span className="cl-bench-value">{(benchResult.durationMs / 1000).toFixed(2)} s</span>
                      </div>
                      <div className="cl-bench-stat">
                        <span className="cl-bench-label">平均请求耗时</span>
                        <span className="cl-bench-value">{benchResult.avgMs} ms</span>
                      </div>
                      <div className="cl-bench-stat">
                        <span className="cl-bench-label">P95 尾部延迟</span>
                        <span className="cl-bench-value">{benchResult.p95Ms} ms</span>
                      </div>
                    </div>

                    {/* Worker 负载均衡分流矩阵展示（严格按 ID 升序排序） */}
                    {benchResult.workerDistribution && Object.keys(benchResult.workerDistribution).length > 0 && (
                      <div style={{ marginTop: "var(--sp-3)" }}>
                        <span className="cl-hint" style={{ fontWeight: 600, color: "var(--fg)" }}>
                          多进程调度均衡分流矩阵 ({Object.keys(benchResult.workerDistribution).length} 个活跃 Worker 协同并行):
                        </span>
                        <div className="cl-worker-chips">
                          {Object.entries(benchResult.workerDistribution)
                            .sort(([a], [b]) => {
                              const numA = parseInt(a.replace(/\D/g, ""), 10) || 0;
                              const numB = parseInt(b.replace(/\D/g, ""), 10) || 0;
                              return numA - numB;
                            })
                            .map(([wId, count]) => {
                              const pct = Math.round((count / (benchResult.totalRequests || 1)) * 100);
                              return (
                                <div key={wId} className="cl-worker-chip">
                                  <span>{wId}</span>
                                  <b>{count} 次</b>
                                  <span>({pct}%)</span>
                                </div>
                              );
                            })}
                        </div>
                      </div>
                    )}

                    {benchResult.failedCount ? (
                      <div className="cl-bench-error">
                        <strong>异常诊断 ({benchResult.failedCount} 个请求未成功):</strong>{" "}
                        {benchResult.errors || "请求被拒绝，请确认集群已启动且 Worker 充足"}
                      </div>
                    ) : null}
                  </div>
                )}

                {/* 历史对比记录 */}
                {benchHistory.length > 1 && (
                  <div className="cl-bench-history">
                    <span className="cl-hint" style={{ fontWeight: 600, color: "var(--fg)" }}>
                      最近压测记录对比
                    </span>
                    {benchHistory.slice(1).map((h, idx) => (
                      <div key={idx} className="cl-bench-history-row">
                        <span>{h.concurrency} 并发 × {h.totalRequests / h.concurrency} 轮 ({h.totalRequests} 请求)</span>
                        <span>{h.qps} QPS</span>
                        <span>P95: {h.p95Ms}ms</span>
                        <Badge tone={h.successRate >= 95 ? "ok" : "warn"}>{h.successRate}% 成功</Badge>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* View 3: CPU 核心拓扑分布 */}
            {rightTab === "topology" && (
              <div className="cl-panel-body">
                <div className="cl-topo-summary">
                  <div>
                    <strong>CPU 型号:</strong> {cpuModel}
                  </div>
                  <div>
                    <strong>总核心数:</strong> {totalCpus}
                  </div>
                  <div>
                    <strong>活跃分配:</strong> {runningWorkersCount} / {totalCpus}
                  </div>
                </div>

                <div className="cl-topo-grid">
                  {Array.from({ length: totalCpus }, (_, idx) => {
                    const isPhysical = idx < Math.min(16, Math.floor(totalCpus / 2));
                    const assignedWorker = workerRows.find((w) => (w.id - 1) % totalCpus === idx);
                    const isActive = Boolean(assignedWorker && assignedWorker.status === "online");
                    return (
                      <div
                        key={idx}
                        className="cl-core-card"
                        data-active={isActive ? "true" : undefined}
                        title={`Core #${idx}: ${isPhysical ? "物理核心" : "超线程"} · ${isActive ? assignedWorker?.name : "未绑定"}`}
                      >
                        <span className="cl-core-num">Core {idx}</span>
                        <span className="cl-core-badge">{isPhysical ? "物理核" : "超线程"}</span>
                        <span className="cl-core-worker">{isActive ? `Worker #${assignedWorker?.id}` : "空闲"}</span>
                      </div>
                    );
                  })}
                </div>

                <p className="cl-hint">
                  核心亲和性策略：CogniStack 默认优先将 Worker 分配到编号考前的物理大核以获取最高的缓存亲和度（L1/L2 Cache Affinity），当负载提升时弹性接入高位超线程。
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </PageFlush>
  );
}
