/**
 * Durable turn log for the viz server.
 *
 * Why this exists
 * ---------------
 * Telemetry lives in a ring buffer in memory. That is the right default — it is
 * bounded and cheap — but it means the turn that went wrong is gone as soon as
 * the process restarts, and there is no way to answer "what did last Tuesday
 * look like". A dashboard that can only show *now* cannot be used for forensics.
 *
 * What is stored: the `TurnRecord` as-is — counts, budget, timings, warnings,
 * stages, ports, host identity and host-supplied `meta`. NOT prompt text, NOT
 * dialogue.
 *
 * **例外，必须知道**：如果宿主开启了 `captureInputs`（见 `src/telemetry.ts`），
 * `TurnRecord.inputSnapshot` 里会带上**原始输入，含对白正文**，本日志就会把它一起写盘。
 * 那是宿主显式打开的行为（默认关闭），但意味着这个文件从此属于隐私数据：
 * 要配保留期与访问控制。日志模块本身不做判断，也不会替宿主脱敏。
 *
 * Rotation is by size: `turn-log.jsonl` → `.1` → `.2` … oldest dropped. Reading
 * is tail-bounded, so a multi-GB log never gets slurped into memory.
 */
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_KEEP = 3;
/** Refuse to parse more than this much per read — tail reads are the point. */
const MAX_READ_BYTES = 16 * 1024 * 1024;

function createTurnLog(opts) {
  const file = path.resolve(String(opts.file));
  const maxBytes = Math.max(64 * 1024, Number(opts.maxBytes) || DEFAULT_MAX_BYTES);
  const keep = Math.max(1, Math.min(20, Number(opts.keep) || DEFAULT_KEEP));

  let bytes = 0;
  let written = 0;
  let dropped = 0;
  let rotations = 0;

  try {
    bytes = fs.statSync(file).size;
  } catch {
    bytes = 0;
  }

  function rotatedName(i) {
    return `${file}.${i}`;
  }

  /** Shift `.1`→`.2` … and move the live file to `.1`. */
  function rotate() {
    for (let i = keep - 1; i >= 1; i -= 1) {
      const from = i === 1 ? file : rotatedName(i - 1);
      const to = rotatedName(i);
      try {
        if (fs.existsSync(to)) {
          try { fs.unlinkSync(to); } catch {}
        }
        if (fs.existsSync(from)) fs.renameSync(from, to);
      } catch {
        // A failed rotation must not take the server down; keep appending.
      }
    }
    rotations += 1;
    bytes = 0;
  }

  function append(turn) {
    let line;
    try {
      line = `${JSON.stringify(turn)}\n`;
    } catch {
      // Circular / non-serializable record — count it rather than crash a turn.
      dropped += 1;
      return false;
    }
    const size = Buffer.byteLength(line);
    if (bytes + size > maxBytes) rotate();
    try {
      fs.appendFileSync(file, line);
      bytes += size;
      written += 1;
      return true;
    } catch {
      dropped += 1;
      return false;
    }
  }

  /** Read the last `len` bytes of a file as UTF-8 text, dropping a partial head line. */
  function readTail(target, len) {
    let fd;
    try {
      fd = fs.openSync(target, "r");
    } catch {
      return { text: "", partialHead: false };
    }
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - len);
      const buf = Buffer.allocUnsafe(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const raw = buf.toString("utf8");
      if (start === 0) return { text: raw, partialHead: false };
      const nl = raw.indexOf("\n");
      return nl < 0
        ? { text: "", partialHead: true }
        : { text: raw.slice(nl + 1), partialHead: true };
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * Newest-first read across the live file and its rotations.
   *
   * `limit` bounds the returned turns; scanning is additionally bounded by
   * MAX_READ_BYTES per file so a huge log cannot blow up the server.
   */
  function read(query) {
    const limit = Math.max(1, Math.min(5000, Number(query?.limit) || 200));
    const hostId = query?.hostId ? String(query.hostId) : null;
    const from = Number.isFinite(Number(query?.from)) ? Number(query.from) : null;
    const to = Number.isFinite(Number(query?.to)) ? Number(query.to) : null;
    const out = [];
    let malformed = 0;
    let scanned = 0;

    for (let i = 0; i <= keep; i += 1) {
      const target = i === 0 ? file : rotatedName(i);
      if (!fs.existsSync(target)) continue;
      const { text } = readTail(target, MAX_READ_BYTES);
      if (!text) continue;
      const lines = text.split("\n");
      for (let k = lines.length - 1; k >= 0; k -= 1) {
        const line = lines[k];
        if (!line || !line.trim()) continue;
        scanned += 1;
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          malformed += 1;
          continue;
        }
        if (!rec || typeof rec !== "object") {
          malformed += 1;
          continue;
        }
        if (hostId && rec.hostId !== hostId) continue;
        if (from !== null && !(Number(rec.at) >= from)) continue;
        if (to !== null && !(Number(rec.at) <= to)) continue;
        out.push(rec);
        if (out.length >= limit) {
          return { turns: out, scanned, malformed, truncated: true };
        }
      }
    }
    return { turns: out, scanned, malformed, truncated: false };
  }

  function stats() {
    let size = 0;
    const files = [];
    for (let i = 0; i <= keep; i += 1) {
      const target = i === 0 ? file : rotatedName(i);
      try {
        const st = fs.statSync(target);
        files.push({ file: target, bytes: st.size });
        size += st.size;
      } catch {
        /* not present */
      }
    }
    return { file, bytes: size, rotations, written, dropped, files };
  }

  function clear() {
    for (let i = 0; i <= keep; i += 1) {
      const target = i === 0 ? file : rotatedName(i);
      try {
        if (fs.existsSync(target)) fs.unlinkSync(target);
      } catch {
        /* ignore */
      }
    }
    bytes = 0;
    written = 0;
    dropped = 0;
    rotations = 0;
  }

  return { file, append, read, stats, clear, maxBytes, keep };
}

module.exports = { createTurnLog };
