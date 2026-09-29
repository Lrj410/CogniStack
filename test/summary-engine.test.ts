import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SummaryEngine } from "../src/memory/SummaryEngine";
import { MEMORY_COLUMN_TITLES } from "../src/types";
import type { DialogueMessage } from "../src/types";

const summary = new SummaryEngine();

const structuredBody =
  "【硬事实】阿铁住在用户机器里\n【时间线】第一天：搭上了话\n【关系与称呼】互称老板\n【未决】要不要外挂整个工程\n【近期情节】两人在机房对着日志聊了很久";

describe("SummaryEngine — buildUserPrompt", () => {
  it("replace 默认：整份替换提示 + 可省略 STATE_PATCH + 世界状态段", () => {
    const prompt = summary.buildUserPrompt({
      priorJoined: "旧摘要",
      transcript: "用户: hi",
      worldStateText: "地点=机房",
    });
    assert.ok(prompt.includes("已有长期记忆摘要（将被整份替换）："));
    assert.ok(prompt.includes("旧摘要"));
    assert.ok(prompt.includes("当前世界状态（硬事实锚点，必须保留且不得矛盾）："));
    assert.ok(prompt.includes("地点=机房"));
    assert.ok(prompt.includes("**整份替换**"));
    assert.ok(prompt.includes("正文后可附 STATE_PATCH"));
    assert.ok(prompt.includes("只输出栏目正文（+ 可选 STATE_PATCH），不要解释。"));
    assert.ok(prompt.includes("栏目顺序固定："));
  });

  it("requireStatePatch=true 时改为硬性要求且 outro 强制附块", () => {
    const prompt = summary.buildUserPrompt({
      priorJoined: "",
      transcript: "t",
      requireStatePatch: true,
    });
    assert.ok(prompt.includes("硬性要求：正文后必须附 STATE_PATCH 机器块"));
    assert.ok(prompt.includes("只输出栏目正文 + STATE_PATCH，不要解释。"));
    // 空 prior / 空世界状态回退成「（无）」
    assert.ok(prompt.includes("（无）"));
  });

  it("fuse 模式给出融合去重说明", () => {
    const prompt = summary.buildUserPrompt({ priorJoined: "p", transcript: "t", mode: "fuse" });
    assert.ok(prompt.includes("融合去重为**一份**完整文档（整份替换）"));
  });

  it("episode 模式改用 episodic 指令与增量 STATE_PATCH", () => {
    const prompt = summary.buildUserPrompt({
      priorJoined: "p",
      transcript: "t",
      mode: "episode",
    });
    assert.ok(prompt.includes("已有长期记忆（只读参考，勿整份抄写）："));
    assert.ok(prompt.includes("请输出一份短 episodic 记忆块"));
    assert.ok(prompt.includes("正文后可附 STATE_PATCH（仅本批导致的状态变更）；无法提取则省略该块。"));

    const strict = summary.buildUserPrompt({
      priorJoined: "p",
      transcript: "t",
      mode: "episode",
      requireStatePatch: true,
    });
    assert.ok(strict.includes("硬性要求：正文后必须附 STATE_PATCH（仅本批导致的状态变更"));
  });

  it("maxCharsHint 正数写出「约 N 字以内」，非法值回退精炼", () => {
    const withHint = summary.buildUserPrompt({
      priorJoined: "p",
      transcript: "t",
      maxCharsHint: 200.9,
    });
    assert.ok(withHint.includes("约 200 字以内"));

    for (const bad of [0, -3, Number.NaN]) {
      const p = summary.buildUserPrompt({ priorJoined: "p", transcript: "t", maxCharsHint: bad });
      assert.ok(p.includes("篇幅：尽量精炼"), `hint=${bad}`);
    }
  });
});

describe("SummaryEngine — parseStructuredCompress", () => {
  it("剥离 STATE_PATCH 并回传原始 JSON", () => {
    const raw = `${structuredBody}\n<<<STATE_PATCH>>>\n{"entries":[{"key":"地点","value":"机房"},{"key":"时间","value":"深夜"}]}\n<<<END>>>`;
    const r = summary.parseStructuredCompress(raw);
    assert.ok(!r.summaryText.includes("STATE_PATCH"), r.summaryText);
    assert.ok(r.summaryText.includes("阿铁住在用户机器里"));
    assert.deepEqual(r.statePatchRaw, {
      entries: [
        { key: "地点", value: "机房" },
        { key: "时间", value: "深夜" },
      ],
    });
    assert.equal(r.statePatchParseFailed, undefined);
  });

  it("增量快照（单条 entries）同样被解析", () => {
    const raw = `【硬事实】地点是机房\n<<<STATE_PATCH>>>\n{"entries":[{"key":"地点","value":"机房"}]}\n<<<END>>>`;
    const r = summary.parseStructuredCompress(raw);
    assert.deepEqual(r.statePatchRaw, { entries: [{ key: "地点", value: "机房" }] });
  });

  it("空串返回空摘要、无补丁、不抛异常", () => {
    const r = summary.parseStructuredCompress("");
    assert.equal(r.summaryText, "");
    assert.equal(r.statePatchRaw, null);
    assert.equal(r.statePatchParseFailed, undefined);
  });

  it("只有块标记时摘要为空、补丁为块内 JSON", () => {
    const r = summary.parseStructuredCompress("<<<STATE_PATCH>>>\n{}\n<<<END>>>");
    assert.equal(r.summaryText, "");
    assert.deepEqual(r.statePatchRaw, {});
  });

  it("块内 JSON 非法：标记被剥离、statePatchRaw=null、parseFailed=true", () => {
    const r = summary.parseStructuredCompress(`【硬事实】甲\n<<<STATE_PATCH>>>\n{not json}\n<<<END>>>`);
    assert.ok(!r.summaryText.includes("STATE_PATCH"));
    assert.ok(r.summaryText.includes("甲"));
    assert.equal(r.statePatchRaw, null);
    assert.equal(r.statePatchParseFailed, true);
  });

  it("缺失 <<<END>>> 的截断输出：从标记起到结尾被剥离并标记失败", () => {
    const r = summary.parseStructuredCompress(`【硬事实】甲\n<<<STATE_PATCH>>>\n{"entries":[]}`);
    assert.ok(!r.summaryText.includes("STATE_PATCH"));
    assert.ok(r.summaryText.includes("甲"));
    assert.equal(r.statePatchRaw, null);
    assert.equal(r.statePatchParseFailed, true);
  });

  it("小写标记同样识别（大小写不敏感）", () => {
    const r = summary.parseStructuredCompress(`【硬事实】甲\n<<<state_patch>>>\n{"entries":[]}\n<<<end>>>`);
    assert.deepEqual(r.statePatchRaw, { entries: [] });
    assert.ok(r.summaryText.includes("甲"));
  });

  it("嵌套 / 畸形标记不抛异常", () => {
    const r = summary.parseStructuredCompress(
      "<<<STATE_PATCH>>>a<<<STATE_PATCH>>>b<<<END>>>",
    );
    assert.equal(typeof r.summaryText, "string");
    assert.equal(r.statePatchParseFailed, true);
  });

  it("超长正文不抛异常且保留结构", () => {
    const r = summary.parseStructuredCompress(`【硬事实】${"甲".repeat(20_000)}`);
    assert.ok(r.summaryText.includes("甲".repeat(50)));
    for (const title of MEMORY_COLUMN_TITLES) assert.ok(r.summaryText.includes(title), title);
  });
});

describe("SummaryEngine — makeReplaceBlock / episode 语义", () => {
  it("默认 kind=full、importance=80，且保留全部栏目", () => {
    const block = summary.makeReplaceBlock({
      text: structuredBody,
      throughMessageId: "m6",
      pairCount: 3,
    });
    assert.equal(block.kind, "full");
    assert.equal(block.importance, 80);
    assert.equal(block.throughMessageId, "m6");
    assert.equal(block.pairCount, 3);
    for (const title of MEMORY_COLUMN_TITLES) assert.ok(block.text.includes(title), title);
    assert.ok(block.text.includes("阿铁住在用户机器里"));
  });

  it("kind=episode 默认 importance=40；显式 importance 被夹在 0–100", () => {
    assert.equal(
      summary.makeReplaceBlock({ text: "x", throughMessageId: "m", pairCount: 1, kind: "episode" })
        .importance,
      40,
    );
    assert.equal(
      summary.makeReplaceBlock({ text: "x", throughMessageId: "m", pairCount: 1, kind: "episode", importance: 150 })
        .importance,
      100,
    );
    assert.equal(
      summary.makeReplaceBlock({ text: "x", throughMessageId: "m", pairCount: 1, importance: -5 })
        .importance,
      0,
    );
    assert.equal(
      summary.makeReplaceBlock({ text: "x", throughMessageId: "m", pairCount: 1, importance: 42.9 })
        .importance,
      42,
    );
  });

  it("非结构化文本按原样 trim，不强行套栏目", () => {
    const block = summary.makeReplaceBlock({
      text: "  零散记忆文本  ",
      throughMessageId: "m",
      pairCount: 1,
    });
    assert.equal(block.text, "零散记忆文本");
  });

  it("makeIncrementalBlock 兼容旧调用，等价于 episode 块", () => {
    const block = summary.makeIncrementalBlock({ text: "x", throughMessageId: "m", pairCount: 2 });
    assert.equal(block.kind, "episode");
    assert.equal(block.importance, 40);
  });
});

describe("SummaryEngine — parseFusedBlocks（deprecated）", () => {
  it("按 --- 切块，最后一块携带 pairCount", () => {
    const blocks = summary.parseFusedBlocks({
      text: "甲\n---\n乙\n---\n丙",
      throughMessageId: "m9",
      maxBlocks: 3,
      pairCount: 5,
    });
    assert.equal(blocks.length, 3);
    assert.deepEqual(blocks.map((b) => b.text), ["甲", "乙", "丙"]);
    assert.deepEqual(blocks.map((b) => b.kind), ["full", "full", "full"]);
    assert.deepEqual(blocks.map((b) => b.importance), [80, 80, 80]);
    assert.deepEqual(blocks.map((b) => b.pairCount), [undefined, undefined, 5]);
    assert.equal(new Set(blocks.map((b) => b.id)).size, 3);
  });

  it("超过 maxBlocks 时把尾部合并成一块", () => {
    const blocks = summary.parseFusedBlocks({
      text: "甲\n---\n乙\n---\n丙",
      throughMessageId: "m9",
      maxBlocks: 2,
      pairCount: 4,
    });
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0]!.text, "甲");
    assert.ok(blocks[1]!.text.includes("乙"));
    assert.ok(blocks[1]!.text.includes("丙"));
    assert.equal(blocks[1]!.pairCount, 4);
  });

  it("maxBlocks<=0 时压成单块", () => {
    const blocks = summary.parseFusedBlocks({
      text: "甲\n---\n乙",
      throughMessageId: "m",
      maxBlocks: 0,
      pairCount: 2,
    });
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]!.pairCount, 2);
  });

  it("空 / 空白文本返回空数组", () => {
    assert.deepEqual(summary.parseFusedBlocks({ text: "", throughMessageId: "m", maxBlocks: 3, pairCount: 0 }), []);
    assert.deepEqual(
      summary.parseFusedBlocks({ text: "   ", throughMessageId: "m", maxBlocks: 3, pairCount: 0 }),
      [],
    );
  });

  it("无分隔符时视为单块", () => {
    const blocks = summary.parseFusedBlocks({ text: "整段文本", throughMessageId: "m", maxBlocks: 3, pairCount: 1 });
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]!.pairCount, 1);
  });
});

describe("SummaryEngine — extractiveBlock", () => {
  const items: DialogueMessage[] = [
    { id: "m1", role: "user", content: "你好   世界" },
    { id: "m2", role: "assistant", content: "回复" },
  ];

  it("产出固定骨架 + 应急标题，role 前缀为 用户 / 角色，空白归一", () => {
    const out = summary.extractiveBlock(items);
    for (const title of MEMORY_COLUMN_TITLES) assert.ok(out.includes(title), title);
    assert.ok(out.includes("【应急抽取摘要】"));
    assert.ok(out.includes("用户: 你好 世界"));
    assert.ok(out.includes("角色: 回复"));
  });

  it("clipChars 下限 40：超长内容被裁剪", () => {
    const out = summary.extractiveBlock([{ role: "user", content: "字".repeat(100) }], 1);
    assert.ok(out.includes("字".repeat(40)));
    assert.ok(!out.includes("字".repeat(41)));
  });

  it("maxTotalChars 下限 400：超量对白写入省略计数", () => {
    const many: DialogueMessage[] = Array.from({ length: 30 }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `第${i}条` + "字".repeat(37),
    }));
    const out = summary.extractiveBlock(many, 40, 1);
    assert.ok(out.includes("另有"));
    assert.ok(out.includes("条对白因长度上限未收录"));
  });

  it("空列表仍返回骨架", () => {
    const out = summary.extractiveBlock([]);
    assert.ok(out.includes("【应急抽取摘要】"));
    assert.ok(!out.includes("另有"));
  });
});

describe("SummaryEngine — 薄封装", () => {
  it("formatTranscript 使用中文角色前缀", () => {
    assert.equal(
      summary.formatTranscript([
        { role: "user", content: "u" },
        { role: "assistant", content: "a" },
      ]),
      "用户: u\n\n助手: a",
    );
  });

  it("looksStructured / splitMemoryColumns / extractSalientSlices 委派共享实现", () => {
    assert.equal(summary.looksStructured(structuredBody), true);
    assert.equal(summary.looksStructured("无栏目正文"), false);
    assert.ok(summary.splitMemoryColumns(structuredBody).length >= 5);
    const salient = summary.extractSalientSlices(structuredBody);
    assert.ok(salient.some((s) => s.label === "【硬事实】"));
    assert.ok(salient.some((s) => s.label === "【未决】"));
  });

  it("newBlockId 稳定前缀且唯一", () => {
    const ids = new Set(Array.from({ length: 20 }, () => summary.newBlockId()));
    assert.equal(ids.size, 20);
    for (const id of ids) assert.ok(id.startsWith("b-"), id);
  });
});
