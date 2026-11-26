// Claude が叩くCLI。サーバーが起動していなければ裏で起動する。
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBeats, resolvePlay, splitChordBeats, type PlayPayload, type PlayRequest, type ProgressionRequest } from "../core/request.ts";

/** 拍数を表示用に（0.5 → 1/2、1.75 → 1 3/4） */
function fmtBeats(b: number): string {
  const whole = Math.floor(b);
  const q = Math.round((b - whole) * 4);
  const frac = q === 0 ? "" : q === 2 ? "1/2" : `${q}/4`;
  return whole === 0 ? frac : frac ? `${whole} ${frac}` : String(whole);
}
import { VOICINGS, type VoicingKind } from "../core/voicing.ts";

const ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const PORT = Number(process.env.CLAUDE_CHORD_PORT ?? 5175);
const BASE = `http://127.0.0.1:${PORT}`;
const RUN = join(ROOT, ".run");
const PID_FILE = join(RUN, "server.pid");
const LOG_FILE = join(RUN, "server.log");

const HELP = `使い方:
  ./chord "<コード名 or 音名リスト>" [オプション]   鍵盤に表示して鳴らす
  ./chord prog "<コード1>[:拍数]" "<コード2>[:拍数]" ... [--bpm 数] [--loop]
                                                   進行を同じ間隔で順に鳴らす（全部並べて表示し、今のコードに色）
  ./chord --dry "<...>"                            解釈結果だけ表示（鳴らさない）
  ./chord status                                   ブラウザ接続・音声・MIDIデバイスの状態
  ./chord pause / resume                           進行を一時停止 / 再開
  ./chord jump <n>                                 進行の n 番目へ（停止中ならそのコードだけ鳴らす）
  ./chord bpm <n>                                  進行のテンポを変える
  ./chord len <n> <拍数>                           進行の n 番目の長さを変える（1/4拍刻み）
  ./chord clear                                    表示を消す（進行も止まる）
  ./chord open                                     ブラウザで開く
  ./chord serve                                    サーバーを前面で起動
  ./chord stop                                     裏で動いているサーバーを止める

オプション:
  --voicing <${VOICINGS.join("|")}>   既定は close（左手ベース + 右手）
  --inv <n>        転回形（1 = 第1転回形）。片手で積む
  --arp            下から順に分散して鳴らす
  --dur <秒>       鳴らす長さ（既定 3）
  --json           結果を JSON で出す
  --bpm <数>       prog のテンポ（既定 80）
  --beats <数>     prog で拍数を書いていないコードの拍数（既定 4）
  --each <秒>      prog で1コードあたりの秒数（--bpm の代わりに使える）
  --loop           prog をループする（./chord clear か次の ./chord で止まる）

例:
  ./chord "Cmaj7"
  ./chord "Dm7" --inv 1
  ./chord "G7(b9,13)" --voicing drop2
  ./chord "Am7/G"
  ./chord "F3 A3 C4 E4"
  ./chord prog "AbM7" "G7" "Cm7" "Eb7" --loop
  ./chord prog "CM7:3" "Bm7:2" "Bbm7:1" "Am7:3" "GM7:3" --bpm 118 --loop`;

function parseArgs(argv: string[]) {
  const req: PlayRequest = { input: "" };
  const flags = { json: false, dry: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${a} に値がない`);
      return v;
    };
    if (a === "--voicing" || a === "-v") req.voicing = next() as VoicingKind;
    else if (a === "--inv" || a === "--inversion") req.inversion = parseInt(next(), 10);
    else if (a === "--arp") req.arp = true;
    else if (a === "--dur" || a === "--duration") req.duration = parseFloat(next());
    else if (a === "--json") flags.json = true;
    else if (a === "--dry") flags.dry = true;
    else if (a === "-h" || a === "--help") {
      console.log(HELP);
      process.exit(0);
    } else rest.push(a);
  }
  req.input = rest.join(" ");
  if (req.voicing && !VOICINGS.includes(req.voicing)) fail(`--voicing は ${VOICINGS.join(", ")} のどれか`);
  if (req.inversion !== undefined && !Number.isInteger(req.inversion)) fail("--inv は整数");
  return { req, flags };
}

function fail(msg: string): never {
  console.error(`ERROR ${msg}`);
  process.exit(1);
}

async function api(path: string, body?: unknown): Promise<any> {
  const res = await fetch(BASE + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
}

async function alive(): Promise<boolean> {
  try {
    const r = await fetch(BASE + "/api/status", { signal: AbortSignal.timeout(800) });
    return r.ok;
  } catch {
    return false;
  }
}

async function ensureServer(): Promise<boolean> {
  if (await alive()) return false;
  mkdirSync(RUN, { recursive: true });
  const out = openSync(LOG_FILE, "a");
  const tsx = join(ROOT, "node_modules/.bin/tsx");
  const child = spawn(tsx, [join(ROOT, "src/server/server.ts")], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", out, out],
    env: process.env,
  });
  child.unref();
  closeSync(out);
  writeFileSync(PID_FILE, String(child.pid));
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await alive()) return true;
  }
  fail(`サーバーが起動しない。ログ: ${LOG_FILE}`);
}

function describe(p: Omit<PlayPayload, "id">) {
  const lines: string[] = [];
  lines.push(`${p.title}`);
  if (p.source === "chord") lines.push(`構成音: ${p.tones.map((t) => `${t.name}(${t.label})`).join(" ")}`);
  lines.push(
    `鳴らす音: ${p.notes.map((n) => `${n.name}${n.label ? `(${n.label}${n.hand === "L" ? ",左手" : ""})` : ""}`).join(" ")}`,
  );
  for (const w of p.warnings) lines.push(`注意: ${w}`);
  return lines.join("\n");
}

function describeStatus(s: any): string[] {
  const lines: string[] = [];
  if (!s.browsers) {
    lines.push(`ブラウザ: 未接続 → ./chord open で開く（http://localhost:${PORT}）`);
  } else {
    lines.push(`ブラウザ: ${s.browsers}（音声有効 ${s.audioReady}）`);
    if (!s.audioReady) lines.push("音声: まだ有効になっていない。ブラウザで「音を出す」を押してもらう");
  }
  return lines;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd) {
    console.log(HELP);
    return;
  }

  if (cmd === "serve") {
    const child = spawn(join(ROOT, "node_modules/.bin/tsx"), [join(ROOT, "src/server/server.ts")], {
      cwd: ROOT,
      stdio: "inherit",
    });
    child.on("exit", (c) => process.exit(c ?? 0));
    return;
  }

  if (cmd === "stop") {
    if (!existsSync(PID_FILE)) return console.log("裏で起動したサーバーはない");
    const pid = parseInt(readFileSync(PID_FILE, "utf8"), 10);
    try {
      process.kill(-pid);
    } catch {
      try {
        process.kill(pid);
      } catch {}
    }
    unlinkSync(PID_FILE);
    return console.log("停止した");
  }

  if (cmd === "open") {
    const started = await ensureServer();
    if (started) console.log(`サーバーを起動した（ログ: ${LOG_FILE}）`);
    // 専用の Chrome ウィンドウを、自動再生を許可するオプション付きで開く。
    // 普通のタブだとブラウザの決まりで、最初にクリックするまで音が出ないため。
    const url = `http://localhost:${PORT}`;
    const chrome = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].find((b) => {
      try {
        return spawnSync("which", [b]).status === 0;
      } catch {
        return false;
      }
    });
    if (chrome) {
      spawn(
        chrome,
        [
          `--app=${url}`,
          "--autoplay-policy=no-user-gesture-required",
          `--user-data-dir=${join(RUN, "chrome-profile")}`, // 専用プロファイル（今開いている Chrome とは別に起動させるため）
          "--no-first-run",
          "--no-default-browser-check",
        ],
        { detached: true, stdio: "ignore" },
      ).unref();
      return console.log(`開いた: ${url}（専用ウィンドウ。最初から音が出る。MIDIの許可は初回だけ聞かれる）`);
    }
    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    return console.log(`開いた: ${url}（Chrome が見つからないので普通のブラウザ。最初に一度クリックが要る）`);
  }

  if (cmd === "status") {
    if (!(await alive())) return console.log("サーバー: 停止中（./chord open で起動して開く）");
    const s = await api("/api/status");
    if (argv.includes("--json")) return console.log(JSON.stringify(s, null, 2));
    console.log(`サーバー: 起動中 http://localhost:${PORT}`);
    for (const l of describeStatus(s)) console.log(l);
    console.log(`MIDI入力（ブラウザから見えるもの）: ${s.midiInputs.length ? s.midiInputs.join(", ") : "なし"}`);
    console.log(`MIDI受信イベント数: ${s.midiEvents}`);
    console.log(`表示中: ${s.current ? `${s.current.title}  ${s.current.notes.join(" ")}` : "なし"}`);
    if (s.progression) {
      const pg = s.progression;
      console.log(
        `進行: ${pg.chords.map((c: string, i: number) => `${i === pg.now ? "[" : ""}${c}(${fmtBeats(pg.lengths[i])}拍)${i === pg.now ? "]" : ""}`).join(" → ")}  ${pg.playing ? "再生中" : "停止中"}  BPM ${Math.round(pg.bpm)}${pg.loop ? "  ループ" : ""}`,
      );
    }
    return;
  }

  if (cmd === "clear") {
    if (!(await alive())) return console.log("サーバー停止中なので何もしない");
    await api("/api/clear", {});
    return console.log("消した");
  }

  if (cmd === "pause" || cmd === "resume" || cmd === "jump" || cmd === "bpm" || cmd === "len") {
    if (!(await alive())) fail("サーバーが止まっている");
    let body: Record<string, unknown> = { action: cmd };
    if (cmd === "jump") {
      const n = parseInt(argv[1] ?? "", 10);
      if (!(n >= 1)) fail("jump には 1 から数えた番号を渡す（例: ./chord jump 3）");
      body = { action: "jump", index: n - 1 };
    }
    if (cmd === "bpm") {
      const n = parseFloat(argv[1] ?? "");
      if (!(n > 0)) fail("bpm には数を渡す（例: ./chord bpm 100）");
      body = { action: "bpm", bpm: n };
    }
    if (cmd === "len") {
      const n = parseInt(argv[1] ?? "", 10);
      if (!(n >= 1) || argv[2] === undefined) fail("len には 番号 と 拍数 を渡す（例: ./chord len 3 1/2）");
      if (parseBeats(argv[2]) === null) fail("拍数は1/4拍刻みで 0.25〜16（例 3, 1/2, 0.75）");
      body = { action: "length", index: n - 1, beats: argv[2] };
    }
    const r = await api("/api/progression/control", body);
    if (!r.ok) fail(r.error);
    const pg = r.progression;
    console.log(
      `OK ${pg.playing ? "再生中" : "停止中"}  BPM ${pg.bpm}  ${pg.chords.map((c: string, i: number) => `${i === pg.now ? "[" : ""}${c}(${fmtBeats(pg.lengths[i])}拍)${i === pg.now ? "]" : ""}`).join(" → ")}`,
    );
    return;
  }

  if (cmd === "prog") {
    const chords: string[] = [];
    const body: ProgressionRequest = { chords };
    let asJson = false;
    const a = argv.slice(1);
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      if (x === "--each") body.each = parseFloat(a[++i]);
      else if (x === "--bpm") body.bpm = parseFloat(a[++i]);
      else if (x === "--beats") body.beats = a[++i];
      else if (x === "--loop") body.loop = true;
      else if (x === "--arp") body.arp = true;
      else if (x === "--voicing" || x === "-v") body.voicing = a[++i] as VoicingKind;
      else if (x === "--json") asJson = true;
      else chords.push(x);
    }
    if (chords.length < 2) fail('進行にはコードを2つ以上渡す（例: ./chord prog "Dm7" "G7" "CM7"）');
    // 手元で先に全部解釈して、エラーを早く返す
    const lines: string[] = [];
    for (let i = 0; i < chords.length; i++) {
      const { chord, beats } = splitChordBeats(chords[i]);
      if (beats !== undefined && parseBeats(beats) === null) fail(`${i + 1}個目の "${chords[i]}": 拍数は1/4拍刻みで 0.25〜16（例 :3 :1/2 :0.75）`);
      const r = resolvePlay({ input: chord, voicing: body.voicing });
      if (!r.ok) fail(`${i + 1}個目の "${chord}": ${r.error}`);
      lines.push(describe(r.payload).split("\n").slice(0, 2).join("  |  "));
    }
    const started = await ensureServer();
    const r = await api("/api/progression", body);
    if (!r.ok) fail(r.error);
    if (asJson) return console.log(JSON.stringify(r, null, 2));
    const pg = r.progression;
    console.log(
      `OK 進行 ${r.started.map((n: string, i: number) => `${n}(${fmtBeats(pg.lengths[i])}拍)`).join(" → ")}（BPM ${Math.round(pg.bpm)}、${body.loop ? "ループ" : "1回"}）`,
    );
    console.log("  操作: ./chord pause | resume | jump <番号> | bpm <数> | len <番号> <拍数>   全部止めるなら ./chord clear");
    for (const l of lines) console.log("  " + l);
    if (started) console.log(`（サーバーを起動した。ログ: ${LOG_FILE}）`);
    for (const l of describeStatus(r)) console.log(l);
    return;
  }

  const { req, flags } = parseArgs(argv);
  if (!req.input) fail("コード名か音名を渡す");

  if (flags.dry) {
    const r = resolvePlay(req);
    if (!r.ok) fail(r.error);
    return console.log(flags.json ? JSON.stringify(r.payload, null, 2) : describe(r.payload));
  }

  // まず手元で解釈してエラーを早く返す
  const local = resolvePlay(req);
  if (!local.ok) fail(local.error);

  const started = await ensureServer();
  const r = await api("/api/play", req);
  if (!r.ok) fail(r.error);
  if (flags.json) return console.log(JSON.stringify(r, null, 2));
  console.log(`OK ${describe(r.played)}`);
  if (started) console.log(`（サーバーを起動した。ログ: ${LOG_FILE}）`);
  for (const l of describeStatus(r)) console.log(l);
}

// 出力を head などに渡して途中で閉じられても落ちないようにする
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(0);
});

main().catch((e) => fail(String(e?.message ?? e)));
