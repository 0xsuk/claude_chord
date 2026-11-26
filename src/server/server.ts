// ローカルサーバー。静的ファイル配信 + SSE でブラウザへコードを送る。
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { type PlayPayload, type PlayRequest, type ProgressionRequest, parseBeats, resolvePlay, splitChordBeats } from "../core/request.ts";

const ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const PUBLIC = join(ROOT, "public");
export const PORT = Number(process.env.CLAUDE_CHORD_PORT ?? 5175);
const HOST = "127.0.0.1";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
  ".mp3": "audio/mpeg",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

interface ClientInfo {
  res: ServerResponse;
  audioReady: boolean;
  midiInputs: string[];
  midiEvents: number;
  lastSeen: number;
}

const clients = new Map<string, ClientInfo>();
let current: PlayPayload | null = null;
let nextId = 1;

// ---- 進行（コードごとに拍数を持ち、BPM に合わせて順に鳴らす） ----
// タイミングはサーバーが持つ。ブラウザのボタンやドラッグ、CLI はここへ命令を送るだけ
interface Progression {
  id: number;
  items: Omit<PlayPayload, "id">[];
  names: string[];
  lengths: number[]; // 各コードの拍数（1/4拍刻み）
  bpm: number;
  loop: boolean;
  index: number; // 今のコード
  playing: boolean;
  stepStartedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}
let prog: Progression | null = null;
let nextProgId = 1;

const BPM_MIN = 20;
const BPM_MAX = 300;
const secondsAt = (p: Progression, i: number) => (p.lengths[i] * 60) / p.bpm;

function stopProgression() {
  if (prog?.timer) clearTimeout(prog.timer);
  prog = null;
}

function progressionInfo() {
  if (!prog) return null;
  return {
    chords: prog.names,
    lengths: prog.lengths,
    now: prog.index,
    bpm: prog.bpm,
    each: secondsAt(prog, prog.index),
    loop: prog.loop,
    playing: prog.playing,
  };
}

function startProgression(req: ProgressionRequest): { ok: true; names: string[] } | { ok: false; error: string } {
  const raw = Array.isArray(req.chords) ? req.chords.map(String).filter((c) => c.trim()) : [];
  if (raw.length < 2) return { ok: false, error: "進行にはコードが2つ以上いる" };
  const defBeats = req.beats === undefined ? 4 : parseBeats(String(req.beats));
  if (defBeats === null) return { ok: false, error: `--beats が読めない: ${req.beats}（1/4拍刻み、0.25〜16）` };
  const items: Omit<PlayPayload, "id">[] = [];
  const lengths: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const { chord, beats } = splitChordBeats(raw[i]);
    const len = beats === undefined ? defBeats : parseBeats(beats);
    if (len === null) return { ok: false, error: `${i + 1}個目の "${raw[i]}": 拍数は1/4拍刻みで 0.25〜16（例 :3 :1/2 :0.75）` };
    const r = resolvePlay({ input: chord, voicing: req.voicing, arp: req.arp });
    if (!r.ok) return { ok: false, error: `${i + 1}個目の "${chord}": ${r.error}` };
    items.push(r.payload);
    lengths.push(len);
  }
  let bpm = Number(req.bpm);
  if (!Number.isFinite(bpm) || bpm <= 0) {
    // --each（秒）は既定の拍数1コードぶんの秒数として BPM に直す。どちらもなければ BPM 80
    bpm = req.each ? (defBeats * 60) / Number(req.each) : 80;
  }
  bpm = Math.min(BPM_MAX, Math.max(BPM_MIN, bpm));
  stopProgression();
  prog = {
    id: nextProgId++,
    items,
    names: items.map((it) => it.title),
    lengths,
    bpm,
    loop: !!req.loop,
    index: 0,
    playing: true,
    stepStartedAt: 0,
    timer: null,
  };
  playStep(true);
  return { ok: true, names: prog.names };
}

/** 今の index のコードを送る。sound=true なら鳴らす。再生中なら次のコードを予約する */
function playStep(sound: boolean) {
  const p = prog;
  if (!p) return;
  if (p.timer) clearTimeout(p.timer);
  p.timer = null;
  const each = secondsAt(p, p.index);
  current = {
    ...p.items[p.index],
    duration: each,
    id: nextId++,
    sequence: p.names,
    lengths: p.lengths,
    index: p.index,
    progId: p.id,
    each,
    loop: p.loop,
    playing: p.playing,
    bpm: p.bpm,
  };
  broadcast("chord", { ...current, replay: sound });
  p.stepStartedAt = Date.now();
  if (p.playing) scheduleNext(each * 1000);
}

function scheduleNext(ms: number) {
  const p = prog;
  if (!p) return;
  if (p.timer) clearTimeout(p.timer);
  p.timer = setTimeout(() => {
    if (prog !== p || !p.playing) return;
    const last = p.index === p.items.length - 1;
    if (last && !p.loop) {
      // 最後まで行ったら止まる。表示と四角はそのまま残す
      p.playing = false;
      playStep(false);
      return;
    }
    p.index = last ? 0 : p.index + 1;
    playStep(true);
  }, ms);
}

/** 今のコードの残り時間を、テンポや拍数の変更に合わせて計算し直す */
function rescheduleCurrent() {
  const p = prog;
  if (!p || !p.playing) return;
  const elapsed = Date.now() - p.stepStartedAt;
  scheduleNext(Math.max(0, secondsAt(p, p.index) * 1000 - elapsed));
}

type ProgControl =
  | { action: "pause" }
  | { action: "resume" }
  | { action: "toggle" }
  | { action: "jump"; index: number }
  | { action: "bpm"; bpm: number }
  | { action: "length"; index: number; beats: number | string };

function controlProgression(c: ProgControl): { ok: true } | { ok: false; error: string } {
  const p = prog;
  if (!p) return { ok: false, error: "進行を再生していない" };
  let action = c.action;
  if (action === "toggle") action = p.playing ? "pause" : "resume";
  const checkIndex = (v: unknown) => {
    const i = Math.floor(Number(v));
    return i >= 0 && i < p.items.length ? i : null;
  };
  if (action === "pause") {
    if (!p.playing) return { ok: true };
    p.playing = false;
    playStep(false); // 音を止め、表示を「停止中」に
  } else if (action === "resume") {
    if (p.playing) return { ok: true };
    // 最後で止まっていたら頭から
    if (!p.loop && p.index === p.items.length - 1) p.index = 0;
    p.playing = true;
    playStep(true);
  } else if (action === "jump") {
    const i = checkIndex((c as { index: number }).index);
    if (i === null) return { ok: false, error: `番号は 1〜${p.items.length}（このコード進行は${p.items.length}コード）` };
    p.index = i;
    // 停止中ならそのコードだけ鳴らす。再生中ならそこから進行を続ける
    playStep(true);
  } else if (action === "bpm") {
    const bpm = Number((c as { bpm: number }).bpm);
    if (!Number.isFinite(bpm)) return { ok: false, error: "bpm が数字でない" };
    p.bpm = Math.min(BPM_MAX, Math.max(BPM_MIN, Math.round(bpm)));
    rescheduleCurrent();
    broadcast("progstate", progressionInfo());
  } else if (action === "length") {
    const cc = c as { index: number; beats: number | string };
    const i = checkIndex(cc.index);
    if (i === null) return { ok: false, error: `番号は 1〜${p.items.length}` };
    const len = parseBeats(String(cc.beats));
    if (len === null) return { ok: false, error: "拍数は1/4拍刻みで 0.25〜16（例 3, 1/2, 0.75）" };
    p.lengths = p.lengths.map((x, k) => (k === i ? len : x));
    if (i === p.index) rescheduleCurrent();
    broadcast("progstate", progressionInfo());
  } else {
    return { ok: false, error: `不明な操作: ${action}` };
  }
  return { ok: true };
}

function send(c: ClientInfo, event: string, data: unknown) {
  c.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function broadcast(event: string, data: unknown) {
  for (const c of clients.values()) send(c, event, data);
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const ch of req) chunks.push(ch as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function status() {
  const list = [...clients.values()];
  return {
    ok: true,
    browsers: list.length,
    audioReady: list.filter((c) => c.audioReady).length,
    midiInputs: [...new Set(list.flatMap((c) => c.midiInputs))],
    midiEvents: list.reduce((a, c) => a + c.midiEvents, 0),
    current: current ? { title: current.title, notes: current.notes.map((n) => n.name) } : null,
    progression: progressionInfo(),
  };
}

async function serveStatic(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  let p = decodeURIComponent(url.pathname);
  if (p === "/") p = "/index.html";
  const file = normalize(join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) return json(res, 403, { error: "forbidden" });
  try {
    const st = await stat(file);
    if (!st.isFile()) throw new Error();
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "cache-control": p.startsWith("/samples/") ? "max-age=86400" : "no-cache",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    json(res, 404, { error: "not found" });
  }
}

export async function buildClient() {
  await build({
    entryPoints: [join(ROOT, "src/web/main.ts")],
    bundle: true,
    format: "esm",
    target: "es2022",
    outfile: join(PUBLIC, "app.js"),
    sourcemap: true,
    logLevel: "warning",
  });
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  try {
    if (req.method === "GET" && url.pathname === "/events") {
      const id = url.searchParams.get("id") ?? String(Math.random());
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      const info: ClientInfo = { res, audioReady: false, midiInputs: [], midiEvents: 0, lastSeen: Date.now() };
      clients.set(id, info);
      if (current) send(info, "chord", { ...current, replay: false });
      req.on("close", () => clients.delete(id));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/progression/control") {
      const r = controlProgression((await readJson(req)) as ProgControl);
      return json(res, r.ok ? 200 : 400, r.ok ? status() : r);
    }
    if (req.method === "POST" && url.pathname === "/api/progression") {
      const r = startProgression((await readJson(req)) as ProgressionRequest);
      if (!r.ok) return json(res, 400, r);
      return json(res, 200, { ...status(), started: r.names });
    }
    if (req.method === "POST" && url.pathname === "/api/play") {
      const body = (await readJson(req)) as PlayRequest;
      const r = resolvePlay(body);
      if (!r.ok) return json(res, 400, { ok: false, error: r.error });
      stopProgression();
      current = { ...r.payload, id: nextId++ };
      broadcast("chord", { ...current, replay: true });
      return json(res, 200, { ...status(), played: current });
    }
    if (req.method === "POST" && url.pathname === "/api/parse") {
      const r = resolvePlay((await readJson(req)) as PlayRequest);
      return json(res, r.ok ? 200 : 400, r.ok ? { ok: true, parsed: r.payload } : r);
    }
    if (req.method === "POST" && url.pathname === "/api/clear") {
      stopProgression();
      current = null;
      broadcast("clear", {});
      return json(res, 200, status());
    }
    if (req.method === "POST" && url.pathname === "/api/client-status") {
      const b = await readJson(req);
      const c = clients.get(String(b.id));
      if (c) {
        c.audioReady = !!b.audioReady;
        c.midiInputs = Array.isArray(b.midiInputs) ? b.midiInputs.map(String).slice(0, 16) : [];
        c.midiEvents = Number(b.midiEvents) || 0;
        c.lastSeen = Date.now();
      }
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/api/status") return json(res, 200, status());
    if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res);
    json(res, 405, { error: "method not allowed" });
  } catch (e) {
    json(res, 500, { ok: false, error: String((e as Error)?.message ?? e) });
  }
}

// SSE の接続維持
setInterval(() => {
  for (const c of clients.values()) c.res.write(": ping\n\n");
}, 15000).unref();

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildClient();
  createServer(handle).listen(PORT, HOST, () => {
    console.log(`claude_chord: http://localhost:${PORT}`);
  });
}
