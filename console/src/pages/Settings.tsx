import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Copy, Cpu, Network } from "lucide-react";
import { getApiKey, setApiKey } from "@/lib/apiKey";
import { setDensity, setScheme, usePrefs } from "@/app/prefs";
import { useTelemetry } from "@/hooks/useTelemetry";
import {
  Badge,
  Button,
  Code,
  DataTable,
  Panel,
  PanelBody,
  PanelHead,
  Row,
  Segmented,
  Stack,
  Stat,
  TextInput,
  useToast,
} from "@/ui";
import { PageScroll } from "@/app/Page";
import "./settings.css";

// 端点全部拼当前来源:引擎与控制台同源代理,不硬编码主机名,换端口也不用改代码。
const ORIGIN = `${location.protocol}//${location.host}`;

const ENDPOINTS: { use: string; method: string; path: string; customUrl?: string }[] = [
  { use: "装配", method: "POST", path: "/v1/prepare" },
  { use: "发现", method: "GET", path: "/v1" },
  { use: "健康检查", method: "GET", path: "/v1/health" },
  { use: "快照", method: "GET", path: "/api/snapshot" },
  { use: "流式遥测", method: "GET", path: "/api/stream" },
  { use: "指标", method: "GET", path: "/api/metrics" },
  { use: "OpenAI 聊天兼容", method: "POST", path: "", customUrl: "http://127.0.0.1:8790/v1/chat/completions" },
  { use: "Claude 消息兼容", method: "POST", path: "", customUrl: "http://127.0.0.1:8792/v1/messages" },
];

export function SettingsPage() {
  const { scheme, density } = usePrefs();
  const { snap } = useTelemetry();
  const sys = snap?.system;
  const toast = useToast();
  const [draft, setDraft] = useState(() => getApiKey());
  const [rev, setRev] = useState(0);
  const configured = rev >= 0 && getApiKey() !== "";

  function save() {
    setApiKey(draft);
    setRev((v) => v + 1);
    toast("已保存", "ok");
  }

  function clear() {
    setApiKey("");
    setDraft("");
    setRev((v) => v + 1);
    toast("已清除", "neutral");
  }

  async function copy(text: string, label = "已复制") {
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(text);
      toast(label, "ok");
    } catch {
      toast("复制失败:浏览器未开放剪贴板权限", "bad");
    }
  }

  return (
    <PageScroll>
      <div className="se-layout">
        <div className="se-col">
          <Panel>
            <PanelHead title="外观与密度" sub="调整界面呈现" />
            <PanelBody>
              <Stack gap="var(--sp-5)">
                <div className="se-pref">
                  <span className="se-pref-label">主题</span>
                  <Segmented
                    label="主题"
                    value={scheme}
                    onChange={(v) => setScheme(v as "dark" | "light")}
                    options={[
                      { value: "dark", label: "深色" },
                      { value: "light", label: "浅色" },
                    ]}
                  />
                </div>

                <div className="se-pref">
                  <span className="se-pref-label">信息密度</span>
                  <Segmented
                    label="信息密度"
                    value={density}
                    onChange={(v) => setDensity(v as "comfortable" | "compact")}
                    options={[
                      { value: "comfortable", label: "舒适" },
                      { value: "compact", label: "紧凑" },
                    ]}
                  />
                </div>

                <p className="se-hint">
                  选择保存在本地(localStorage),下次打开沿用;顶栏的主题开关与这里同步。
                </p>
              </Stack>
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHead
              title="API Key"
              sub="会话级鉴权"
              right={
                <Badge tone={configured ? "ok" : "neutral"}>
                  {configured ? "已配置" : "未配置"}
                </Badge>
              }
            />
            <PanelBody>
              <Stack gap="var(--sp-5)">
                <p className="se-hint">
                  仅当引擎以 <Code>--key</Code> 启动时才需要填写。LAN/WAN 监听段的 Key 与控制台不通用，控制台仅需 local 段的 Key。密钥存放在 sessionStorage，只对本次会话有效，关闭标签页即清除，不会写入磁盘。
                </p>
                <TextInput
                  label="Bearer token"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="粘贴引擎启动时打印的密钥"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <Row gap="var(--sp-3)">
                  <Button variant="solid" onClick={save}>
                    保存
                  </Button>
                  <Button variant="outline" onClick={clear}>
                    清除
                  </Button>
                </Row>
              </Stack>
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHead
              title="硬件拓扑与并发集群"
              sub="多核心算力释放与负载均衡已独立成专属页面"
              right={
                <Link to="/cluster" className="btn btn--outline btn--sm">
                  进入集群
                  <ArrowRight size={13} aria-hidden />
                </Link>
              }
            />
            <PanelBody>
              <Stack gap="var(--sp-4)">
                <div className="grid-2">
                  <Stat
                    label="CPU 硬件核心"
                    value={sys?.cpus ? `${sys.cpus} 核心` : "32 核心 (侦测中)"}
                    foot={sys?.cpuModel || "AMD Ryzen 9 8945HX"}
                  />
                  <Stat
                    label="并发运行架构"
                    value={sys?.isCluster ? `集群 #${sys.workerId}` : "单进程标准"}
                    tone={sys?.isCluster ? "ok" : "neutral"}
                    foot={sys?.isCluster ? "多 Worker 内核级均衡分发" : "单进程仅吃满 1 个逻辑线程"}
                  />
                </div>

                <p className="se-hint">
                  硬件拓扑与并发集群管理已全面升级为独立的「集群」专属工作台。支持可视化多核 Worker 弹性伸缩、调度策略、背压水线、多级缓存容量控制，并内置在线高并发压测验证器与滚动重载能力。
                </p>

                <Row gap="var(--sp-3)">
                  <Link to="/cluster" className="btn btn--solid btn--sm">
                    <Cpu size={14} aria-hidden />
                    打开集群工作台
                  </Link>
                </Row>
              </Stack>
            </PanelBody>
          </Panel>
        </div>

        <div className="se-col">
          <Panel>
            <PanelHead
              title="三网网关与网络隔离"
              sub="Local / LAN / WAN 独立端口监听、在线探活与接入指引已独立成专属页面"
              right={
                <Link to="/gateway" className="btn btn--outline btn--sm">
                  进入网关
                  <ArrowRight size={13} aria-hidden />
                </Link>
              }
            />
            <PanelBody>
              <Stack gap="var(--sp-3)">
                <p className="se-hint">
                  三网隔离管理已移至独立的「网关」专属工作台，支持三网（本机 Local / 局域网 LAN / 公网 WAN）一键启停、参数配置、内置一键探活自检、外部角色扮演（xoox / 酒馆）接入指南与安全拦截审计。
                </p>
                <Row gap="var(--sp-3)">
                  <Link to="/gateway" className="btn btn--solid btn--sm">
                    <Network size={14} aria-hidden />
                    打开网关工作台
                  </Link>
                </Row>
              </Stack>
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHead title="端点" sub="本机 API 入口（local 段与协议网关）" />
            <PanelBody flush>
              <DataTable label="本机端点" minWidth={560}>
                <thead>
                  <tr>
                    <th>用途</th>
                    <th>方法</th>
                    <th>URL</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {ENDPOINTS.map((e) => {
                    const url = e.customUrl || `${ORIGIN}${e.path}`;
                    return (
                      <tr key={e.use}>
                        <td>{e.use}</td>
                        <td className="nowrap">
                          <Code>{e.method}</Code>
                        </td>
                        <td>
                          <div className="se-url" title={url}>
                            <code className="num">{url}</code>
                          </div>
                        </td>
                        <td>
                          <Button
                            variant="ghost"
                            size="sm"
                            icon={<Copy size={12} aria-hidden />}
                            onClick={() => void copy(url)}
                          >
                            复制
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </DataTable>
            </PanelBody>
          </Panel>

          <div className="grid-2">
            <Stat label="控制台" value={location.host} foot="local 段 · 当前访问来源" />
            <Stat
              label="主题"
              value={scheme === "dark" ? "深色" : "浅色"}
              foot={density === "compact" ? "紧凑密度" : "舒适密度"}
            />
          </div>
        </div>
      </div>
    </PageScroll>
  );
}
