/*
 * 端到端验证：viz-server 三段监听与三网隔离（local / lan / wan）完整契约。
 *
 * 验证重点：
 *   1. 跨段 key 隔离与 wrong_zone_key 诊断可见性
 *   2. 非 local 段 ACL 404 逐字节一致且不泄漏 console not built
 *   3. 允许面内方法语义（405 + Allow: GET, HEAD）
 *   4. WAN 段代理密钥校验（403）、红线脱敏探活与按 XFF 独立限流
 */
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

async function pickFreePort(start = 7600, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    const port = start + i;
    if (await isPortFree(port)) return port;
  }
  throw new Error(`从 ${start} 起连续 ${tries} 个端口都被占用，无法启动验证服务`);
}

(async () => {
  const pLocal = await pickFreePort(7600);
  const pLan = await pickFreePort(pLocal + 1);
  const pWan = await pickFreePort(pLan + 1);

  const localBase = `http://127.0.0.1:${pLocal}`;
  const lanBase = `http://127.0.0.1:${pLan}`;
  const wanBase = `http://127.0.0.1:${pWan}`;

  const LOCAL_KEY = "key_local_123456789";
  const LAN_KEY = "key_lan_123456789";
  const WAN_KEY = "key_wan_123456789";
  const PROXY_KEY = "secret_proxy_share_key";
  const PUBLIC_URL = "https://cs.example.com";

  const srv = spawn(
    process.execPath,
    [
      "tools/viz-server.cjs",
      "--zones", "local,lan,wan",
      "--local", `127.0.0.1:${pLocal}`,
      "--local-key", LOCAL_KEY,
      "--lan", `127.0.0.1:${pLan}`,
      "--lan-key", LAN_KEY,
      "--wan", `127.0.0.1:${pWan}`,
      "--wan-key", WAN_KEY,
      "--wan-proxy-key", PROXY_KEY,
      "--wan-public-url", PUBLIC_URL,
      "--wan-rate-limit", "1",
    ],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );

  let banner = "";
  srv.stdout.on("data", (d) => {
    banner += String(d);
  });
  srv.stderr.on("data", (d) => {
    banner += String(d);
  });

  const cleanup = () => {
    if (srv.exitCode === null) srv.kill();
  };
  process.on("exit", cleanup);

  try {
    // 探活就绪
    let ready = false;
    for (let i = 0; i < 60; i += 1) {
      if (srv.exitCode !== null) {
        throw new Error(`三段服务提前退出（退出码 ${srv.exitCode}）\n${banner}`);
      }
      try {
        const res = await fetch(`${localBase}/v1/health`);
        if (res.ok) {
          const body = await res.json();
          if (body.ok && body.zone === "local") {
            ready = true;
            break;
          }
        }
      } catch {}
      await sleep(100);
    }
    if (!ready) throw new Error(`等不到三段服务就绪\n${banner}`);
    console.log(`三段服务就绪: local=${localBase} lan=${lanBase} wan=${wanBase}`);

    /* 1. local 正常读取快照 */
    {
      const res = await fetch(`${localBase}/api/snapshot`, {
        headers: { "x-api-key": LOCAL_KEY },
      });
      assert.equal(res.status, 200, "local/api/snapshot 应返回 200");
      const snap = await res.json();
      assert.ok(snap.gateway?.zones?.length === 3, "快照中应包含 3 个 zone");
      console.log("  ok  1. local 段快照读取正常");
    }

    /* 2. local/api/turn-log（未配日志时为 404） */
    {
      const res = await fetch(`${localBase}/api/turn-log`, {
        headers: { "x-api-key": LOCAL_KEY },
      });
      assert.equal(res.status, 404, "未配 turn-log 时应返回 404");
      console.log("  ok  2. local/api/turn-log 返回 404");
    }

    /* 3. local/api/reset POST */
    {
      const res = await fetch(`${localBase}/api/reset`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": LOCAL_KEY,
        },
      });
      assert.equal(res.status, 200, "local/api/reset 应返回 200");
      console.log("  ok  3. local/api/reset 返回 200");
    }

    /* 4. 跨段 key 隔离与 wrong_zone_key 诊断 */
    {
      const res = await fetch(`${localBase}/api/snapshot`, {
        headers: { "x-api-key": LAN_KEY },
      });
      assert.equal(res.status, 401, "拿 LAN_KEY 请求 local 端应返回 401");

      const snapRes = await fetch(`${localBase}/api/snapshot`, {
        headers: { "x-api-key": LOCAL_KEY },
      });
      const snap = await snapRes.json();
      const last = snap.gateway?.rejects?.last;
      assert.equal(last?.reason, "wrong_zone_key", "诊断 reason 应为 wrong_zone_key");
      assert.equal(last?.zone, "local", "被拒请求所属 zone 应为 local");
      assert.ok(
        last?.detail?.includes("zone=local") && last?.detail?.includes("zone=lan"),
        `诊断 detail 应指出跨段情况: ${last?.detail}`,
      );
      console.log("  ok  4. 跨段 key 隔离与 wrong_zone_key 诊断有效");
    }

    /* 5. LAN 遥测与 key 隔离 */
    {
      const resOk = await fetch(`${lanBase}/api/snapshot`, {
        headers: { "x-api-key": LAN_KEY },
      });
      assert.equal(resOk.status, 200, "lan/api/snapshot 拿 LAN_KEY 应返回 200");

      const resFailLocal = await fetch(`${lanBase}/api/snapshot`, {
        headers: { "x-api-key": LOCAL_KEY },
      });
      assert.equal(resFailLocal.status, 401, "lan 端拿 LOCAL_KEY 应返回 401");

      const resFailWan = await fetch(`${lanBase}/api/snapshot`, {
        headers: { "x-api-key": WAN_KEY },
      });
      assert.equal(resFailWan.status, 401, "lan 端拿 WAN_KEY 应返回 401");
      console.log("  ok  5. LAN 段鉴权与三段 key 互斥有效");
    }

    /* 6. LAN 允许面内方法语义：POST /api/snapshot -> 405 + Allow: GET, HEAD */
    {
      const res = await fetch(`${lanBase}/api/snapshot`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": LAN_KEY,
        },
      });
      assert.equal(res.status, 405, "LAN POST /api/snapshot 应返回 405");
      assert.ok(
        res.headers.get("allow")?.includes("GET"),
        "Allow 头应声明允许的 GET/HEAD 方法",
      );
      console.log("  ok  6. LAN 段方法语义 405 维持不变");
    }

    /* 7. LAN 拦截敏感/破坏性接口与别名 */
    {
      const rReset = await fetch(`${lanBase}/api/reset`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": LAN_KEY },
      });
      assert.equal(rReset.status, 404, "LAN 段应屏蔽 /api/reset");

      const rTurnLog = await fetch(`${lanBase}/api/turn-log`, {
        headers: { "x-api-key": LAN_KEY },
      });
      assert.equal(rTurnLog.status, 404, "LAN 段应屏蔽 /api/turn-log");

      const rMetrics = await fetch(`${lanBase}/metrics`, {
        headers: { "x-api-key": LAN_KEY },
      });
      assert.equal(rMetrics.status, 404, "LAN 段应屏蔽 /metrics 别名");

      const rApiMetrics = await fetch(`${lanBase}/api/metrics`, {
        headers: { "x-api-key": LAN_KEY },
      });
      assert.equal(rApiMetrics.status, 200, "LAN 段应开放 /api/metrics");
      console.log("  ok  7. LAN 段敏感路由 ACL 拦截有效");
    }

    /* 8. LAN 静态文件屏蔽且不泄漏构建状态（404 逐字节一致） */
    {
      const rRoot = await fetch(`${lanBase}/`);
      assert.equal(rRoot.status, 404, "lan/ 应返回 404");
      const bodyRoot = await rRoot.text();
      assert.ok(!bodyRoot.includes("console not built"), "不得泄漏 console not built");
      assert.equal(bodyRoot, "not found", "404 响应应为 not found");

      const rSec = await fetch(`${lanBase}/../secret`);
      assert.equal(rSec.status, 404);
      const bodySec = await rSec.text();
      assert.equal(bodySec, bodyRoot, "不同 404 请求响应 body 必须逐字节一致");
      console.log("  ok  8. LAN 段 404 逐字节一致，不泄漏构建状态");
    }

    /* 9. WAN 代理密钥校验 (403) 与 /api 拦截 (404) */
    {
      const rNoProxy = await fetch(`${wanBase}/v1/health`);
      assert.equal(rNoProxy.status, 403, "WAN 无代理头应返回 403");

      const rWrongProxy = await fetch(`${wanBase}/v1/health`, {
        headers: { "x-cognistack-proxy-key": "wrong_key" },
      });
      assert.equal(rWrongProxy.status, 403, "WAN 错代理头应返回 403");

      const rApiSnap = await fetch(`${wanBase}/api/snapshot`, {
        headers: {
          "x-cognistack-proxy-key": PROXY_KEY,
          "x-api-key": WAN_KEY,
        },
      });
      assert.equal(rApiSnap.status, 404, "WAN 段应屏蔽 /api/snapshot");
      console.log("  ok  9. WAN 段代理密钥校验 (403) 与 /api 隔离 (404)");
    }

    /* 10. WAN 脱敏探活 */
    {
      const rHealth = await fetch(`${wanBase}/v1/health`, {
        headers: { "x-cognistack-proxy-key": PROXY_KEY },
      });
      assert.equal(rHealth.status, 200, "WAN 有代理头应返回 200");
      const healthBody = await rHealth.json();
      assert.equal(healthBody.ok, true);
      assert.equal(healthBody.zone, "wan");
      assert.equal(healthBody.version, undefined, "WAN 探活不得包含 version");
      assert.equal(healthBody.uptimeMs, undefined, "WAN 探活不得包含 uptimeMs");
      assert.equal(healthBody.prepareQueue, undefined, "WAN 探活不得包含 prepareQueue");
      console.log("  ok 10. WAN 段 /v1/health 脱敏探活有效");
    }

    /* 11. WAN 发现文档与 Prepare 调用 */
    {
      const rDisc = await fetch(`${wanBase}/v1`, {
        headers: { "x-cognistack-proxy-key": PROXY_KEY },
      });
      assert.equal(rDisc.status, 200);
      const discBody = await rDisc.json();
      assert.equal(discBody.zone, "wan");
      assert.equal(discBody.base, PUBLIC_URL, "WAN base 应为 public URL");
      assert.equal(discBody.endpoints.metrics, undefined, "WAN 发现不得提供 metrics");

      const preparePayload = JSON.stringify({
        host: { id: "test-client-wan" },
        dialogue: [{ id: "1", role: "user", content: "ping" }],
      });

      // 无 key 401
      const rNoKey = await fetch(`${wanBase}/v1/prepare`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cognistack-proxy-key": PROXY_KEY,
          "x-forwarded-for": "192.168.10.10",
        },
        body: preparePayload,
      });
      assert.equal(rNoKey.status, 401, "WAN 未带 API key 应返回 401");

      // 正确 key 200
      const rOk = await fetch(`${wanBase}/v1/prepare`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cognistack-proxy-key": PROXY_KEY,
          "authorization": `Bearer ${WAN_KEY}`,
          "x-forwarded-for": "192.168.10.11",
        },
        body: preparePayload,
      });
      assert.equal(rOk.status, 200, "WAN 带 key 调用 prepare 应返回 200");
      const out = await rOk.json();
      assert.ok(out.ok, "prepare 输出应为 ok");
      console.log("  ok 11. WAN 段 /v1 发现与 /v1/prepare 契约正常");
    }

    /* 12. WAN XFF 独立限流 */
    {
      const payload = JSON.stringify({
        host: { id: "test-xff" },
        dialogue: [{ id: "1", role: "user", content: "ping" }],
      });
      // 对 IP 10.0.0.1 发送：第 1 次应为 200，第 2 次为 429
      const r1 = await fetch(`${wanBase}/v1/prepare`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cognistack-proxy-key": PROXY_KEY,
          "authorization": `Bearer ${WAN_KEY}`,
          "x-forwarded-for": "10.0.0.1",
        },
        body: payload,
      });
      assert.equal(r1.status, 200);

      const r2 = await fetch(`${wanBase}/v1/prepare`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cognistack-proxy-key": PROXY_KEY,
          "authorization": `Bearer ${WAN_KEY}`,
          "x-forwarded-for": "10.0.0.1",
        },
        body: payload,
      });
      assert.equal(r2.status, 429, "同 IP 超频应被限流 429");

      // 换一个 XFF IP 10.0.0.2 发送：应为 200（独立分桶）
      const r3 = await fetch(`${wanBase}/v1/prepare`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cognistack-proxy-key": PROXY_KEY,
          "authorization": `Bearer ${WAN_KEY}`,
          "x-forwarded-for": "10.0.0.2",
        },
        body: payload,
      });
      assert.equal(r3.status, 200, "不同 XFF IP 应独立分桶，不应被 429");
      console.log("  ok 12. WAN 段基于 XFF 独立限流分桶有效");
    }

    /* 13. 控制台动态停用与启用网段 (POST /api/zones/stop & /api/zones/start) */
    {
      // 1. 停用 LAN 段
      const stopRes = await fetch(`${localBase}/api/zones/stop`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": LOCAL_KEY,
        },
        body: JSON.stringify({ zone: "lan" }),
      });
      assert.equal(stopRes.status, 200, "POST /api/zones/stop 应返回 200");
      const stopBody = await stopRes.json();
      assert.equal(stopBody.ok, true);

      // 验证此时 LAN 端口已被释放（连接被拒绝）
      let lanConnectedAfterStop = false;
      try {
        await fetch(`${lanBase}/v1/health`, { signal: AbortSignal.timeout(500) });
        lanConnectedAfterStop = true;
      } catch {
        lanConnectedAfterStop = false;
      }
      assert.equal(lanConnectedAfterStop, false, "停用后 LAN 端口应无法连接");

      // 查 local 快照中的状态
      const snap1 = await (await fetch(`${localBase}/api/snapshot`, {
        headers: { "x-api-key": LOCAL_KEY },
      })).json();
      const lanZone1 = snap1.gateway?.zones?.find((z) => z.zone === "lan");
      assert.equal(lanZone1?.status, "stopped", "快照中 LAN 状态应变为 stopped");

      // 2. 重新启动 LAN 段
      const startRes = await fetch(`${localBase}/api/zones/start`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": LOCAL_KEY,
        },
        body: JSON.stringify({
          zone: "lan",
          port: pLan,
          host: "127.0.0.1",
          apiKey: LAN_KEY,
        }),
      });
      assert.equal(startRes.status, 200, "POST /api/zones/start 应返回 200");
      const startBody = await startRes.json();
      assert.equal(startBody.ok, true);

      // 验证重新启动后 LAN 端口已恢复连接
      const rHealthAgain = await fetch(`${lanBase}/v1/health`);
      assert.equal(rHealthAgain.status, 200, "重新启动后 LAN 端口应恢复响应");

      // 查 local 快照状态
      const snap2 = await (await fetch(`${localBase}/api/snapshot`, {
        headers: { "x-api-key": LOCAL_KEY },
      })).json();
      const lanZone2 = snap2.gateway?.zones?.find((z) => z.zone === "lan");
      assert.equal(lanZone2?.status, "running", "快照中 LAN 状态应恢复为 running");

      console.log("  ok 13. 控制台动态停用与启用网段 API 有效");
    }

    /* 14. IP 黑名单封禁管控与接入客户端明细 (POST /api/gateway/block & /api/gateway/unblock) */
    {
      const testIp = "192.168.10.99";

      // 1. 下发封禁
      const blkRes = await fetch(`${localBase}/api/gateway/block`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": LOCAL_KEY,
        },
        body: JSON.stringify({ ip: testIp, reason: "自动化测试拦截" }),
      });
      assert.equal(blkRes.status, 200, "POST /api/gateway/block 应返回 200");
      const blkBody = await blkRes.json();
      assert.equal(blkBody.ok, true);

      // 2. 检查快照中黑名单包含该 IP
      const snapBlk = await (await fetch(`${localBase}/api/snapshot`, {
        headers: { "x-api-key": LOCAL_KEY },
      })).json();
      assert.equal(Boolean(snapBlk.gateway?.blockedIps?.[testIp]), true, "快照中应包含封禁 IP");
      assert.equal(snapBlk.gateway?.blockedIps?.[testIp]?.reason, "自动化测试拦截");

      // 3. 模拟被封禁客户端从 WAN (带 XFF) 访问，应被入口 403 拒绝
      const payload = JSON.stringify({
        mode: "generate",
        dialogue: [{ id: "t-block", role: "user", content: "hi" }],
      });
      const blockedReq = await fetch(`${wanBase}/v1/prepare`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cognistack-proxy-key": PROXY_KEY,
          "authorization": `Bearer ${WAN_KEY}`,
          "x-forwarded-for": testIp,
        },
        body: payload,
      });
      assert.equal(blockedReq.status, 403, "被封禁 IP 访问应返回 403");
      const blkErrBody = await blockedReq.json();
      assert.equal(blkErrBody.code, "ip_blocked");

      // 4. 解除封禁
      const unblkRes = await fetch(`${localBase}/api/gateway/unblock`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": LOCAL_KEY,
        },
        body: JSON.stringify({ ip: testIp }),
      });
      assert.equal(unblkRes.status, 200, "POST /api/gateway/unblock 应返回 200");
      const unblkBody = await unblkRes.json();
      assert.equal(unblkBody.ok, true);

      // 5. 解封后应恢复 200
      const okReq = await fetch(`${wanBase}/v1/prepare`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cognistack-proxy-key": PROXY_KEY,
          "authorization": `Bearer ${WAN_KEY}`,
          "x-forwarded-for": testIp,
        },
        body: payload,
      });
      assert.equal(okReq.status, 200, "解封后应恢复正常 200 响应");

      // 6. 清空客户端记录测试
      const clearRes = await fetch(`${localBase}/api/gateway/clear-clients`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": LOCAL_KEY,
        },
      });
      assert.equal(clearRes.status, 200, "POST /api/gateway/clear-clients 应返回 200");

      // 7. 拦截审计事件与清空拦截记录测试
      const snapEvents = await (await fetch(`${localBase}/api/snapshot`, {
        headers: { "x-api-key": LOCAL_KEY },
      })).json();
      assert.ok(Array.isArray(snapEvents.gateway?.rejects?.events), "快照中应包含 rejects.events[] 数组");
      assert.ok((snapEvents.gateway?.rejects?.events?.length ?? 0) > 0, "应记录到拦截事件流水");

      const clearRejRes = await fetch(`${localBase}/api/gateway/clear-rejects`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": LOCAL_KEY,
        },
      });
      assert.equal(clearRejRes.status, 200, "POST /api/gateway/clear-rejects 应返回 200");

      console.log("  ok 14. IP 黑名单封禁、403 强阻断、解除封禁与拦截审计事件流水有效");
    }

    /* 15. 接入端级封禁：只拦一个 host，同一 IP 上的其它接入端不受影响
     （走 local 段：WAN 段限流 1/s，同一 IP 上连打多发会被 429 掩盖真实结论） */
    {
      const sharedIp = "127.0.0.1";
      const blockedHost = "auto-test-blocked-client";
      const siblingHost = "auto-test-sibling-client";
      const mgmtHeaders = { "content-type": "application/json", "x-api-key": LOCAL_KEY };

      const prep = (hostId) =>
        fetch(`${localBase}/v1/prepare`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "authorization": `Bearer ${LOCAL_KEY}`,
            "x-api-key": LOCAL_KEY,
          },
          body: JSON.stringify({
            host: { id: hostId, name: hostId, kind: "client" },
            mode: "generate",
            dialogue: [{ id: "t-host-block", role: "user", content: "hi" }],
          }),
        });

      const snapshot = async () =>
        (await (await fetch(`${localBase}/api/snapshot`, { headers: { "x-api-key": LOCAL_KEY } })).json());

      // 1. 任意字符串不得被当成 IP 封禁目标（旧版会把「xoox AI」这种名字塞进 IP 黑名单，
      //    于是名单上有记录、实际却谁也拦不住）
      const badRes = await fetch(`${localBase}/api/gateway/block`, {
        method: "POST",
        headers: mgmtHeaders,
        body: JSON.stringify({ scope: "ip", ip: "xoox AI", reason: "非法目标" }),
      });
      assert.equal(badRes.status, 400, "非 IP 字符串必须被拒，不得写进 IP 黑名单");

      // 2. 按接入端封禁
      const hostBlockRes = await fetch(`${localBase}/api/gateway/block`, {
        method: "POST",
        headers: mgmtHeaders,
        body: JSON.stringify({ scope: "host", host: blockedHost, reason: "自动化测试：接入端封禁" }),
      });
      assert.equal(hostBlockRes.status, 200, "scope=host 的封禁应返回 200");
      assert.equal((await hostBlockRes.json()).scope, "host");

      // 3. 快照：只进 blockedHosts，不得污染 blockedIps（两套表相互独立）
      const snapHostBlock = await snapshot();
      assert.equal(
        snapHostBlock.gateway?.blockedHosts?.[blockedHost]?.reason,
        "自动化测试：接入端封禁",
        "快照 blockedHosts 应包含该接入端",
      );
      assert.equal(
        Boolean(snapHostBlock.gateway?.blockedIps?.[blockedHost]),
        false,
        "接入端封禁不得写进 IP 黑名单",
      );

      // 4. 被封接入端被拒，且原因可区分
      const blockedPrep = await prep(blockedHost);
      assert.equal(blockedPrep.status, 403, "被封接入端应返回 403");
      assert.equal((await blockedPrep.json()).code, "host_blocked");

      // 5. 核心语义：同一 IP 上的另一个接入端照常 200
      const siblingPrep = await prep(siblingHost);
      assert.equal(siblingPrep.status, 200, "同一 IP 上的其它接入端不得受影响");

      // 6. 解封接入端后恢复
      const hostUnblockRes = await fetch(`${localBase}/api/gateway/unblock`, {
        method: "POST",
        headers: mgmtHeaders,
        body: JSON.stringify({ host: blockedHost }),
      });
      assert.equal(hostUnblockRes.status, 200, "解封接入端应返回 200");
      assert.equal((await prep(blockedHost)).status, 200, "解封接入端后应恢复 200");

      // 7. 反过来：封 IP 覆盖该地址上全部接入端，且不往 blockedHosts 里写东西
      const ipBlockRes = await fetch(`${localBase}/api/gateway/block`, {
        method: "POST",
        headers: mgmtHeaders,
        body: JSON.stringify({ scope: "ip", ip: sharedIp, reason: "自动化测试：IP 封禁" }),
      });
      assert.equal(ipBlockRes.status, 200, "scope=ip 的封禁应返回 200");

      const snapIpBlock = await snapshot();
      assert.equal(Boolean(snapIpBlock.gateway?.blockedIps?.[sharedIp]), true, "快照 blockedIps 应包含该 IP");
      assert.equal(
        Boolean(snapIpBlock.gateway?.blockedHosts?.[siblingHost]),
        false,
        "IP 封禁不得顺带写进接入端黑名单",
      );

      const siblingUnderIp = await prep(siblingHost);
      assert.equal(siblingUnderIp.status, 403, "IP 被封后该地址上的接入端应一并被拒");
      assert.equal((await siblingUnderIp.json()).code, "ip_blocked");

      // 管控路由对 IP 黑名单豁免，所以解封命令自身不会被封死
      const ipUnblockRes = await fetch(`${localBase}/api/gateway/unblock`, {
        method: "POST",
        headers: mgmtHeaders,
        body: JSON.stringify({ ip: sharedIp }),
      });
      assert.equal(ipUnblockRes.status, 200, "封禁 127.0.0.1 后解封命令仍应可达（管控豁免）");
      assert.equal((await prep(siblingHost)).status, 200, "解封 IP 后应恢复 200");

      console.log("  ok 15. 接入端级封禁与 IP 级封禁作用域互相独立、互不误伤");
    }

    console.log("\nEXIT=0  三段监听与三网隔离全部通过\n");
    srv.kill();
    process.exit(0);
  } catch (err) {
    console.error(`\nFAIL: ${err.message}\n${banner}`);
    srv.kill();
    process.exit(1);
  }
})();
