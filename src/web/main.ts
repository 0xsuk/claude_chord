// ブラウザ側。SSE でコードを受けて鍵盤表示と再生、Web MIDI でコード推定。
import * as Tone from "tone";
import { detectChords, intervalName } from "../core/detect.ts";
import { parseChord } from "../core/chord.ts";
import { MIDI_MAX, MIDI_MIN, mod, nameOf, nameWithOctave, pcOf, simplestSpelling, solfegeOf, type Spelled } from "../core/notes.ts";
import type { PlayPayload } from "../core/request.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const clientId = Math.random().toString(36).slice(2);

// ---------- 鍵盤 ----------
const keyboard = $("keyboard");
const keyEls = new Map<number, HTMLDivElement>();
const BLACK = new Set([1, 3, 6, 8, 10]);

function buildKeyboard() {
  const whites = [];
  for (let m = MIDI_MIN; m <= MIDI_MAX; m++) if (!BLACK.has(mod(m, 12))) whites.push(m);
  const w = 100 / whites.length;
  let wi = 0;
  for (let m = MIDI_MIN; m <= MIDI_MAX; m++) {
    const el = document.createElement("div");
    const black = BLACK.has(mod(m, 12));
    el.className = `key ${black ? "black" : "white"}`;
    if (black) {
      el.style.left = `calc(${wi * w}% - ${w * 0.3}%)`;
      el.style.width = `${w * 0.6}%`;
    } else {
      el.style.left = `${wi * w}%`;
      el.style.width = `calc(${w}% + 1px)`;
      // 白鍵の下にドレミ、Cにはオクターブも
      const sol = solfegeOf(nameOf(simplestSpelling(mod(m, 12), false)));
      el.classList.add("c-label");
      if (mod(m, 12) === 0) {
        el.classList.add("is-c");
        el.dataset.c = `${sol}\nC${Math.floor(m / 12) - 1}`;
      } else {
        el.dataset.c = sol;
      }
      wi++;
    }
    const lbl = document.createElement("span");
    lbl.className = "lbl";
    el.appendChild(lbl);
    el.dataset.midi = String(m);
    keyboard.appendChild(el);
    keyEls.set(m, el);
  }
}

let claudeNotes = new Map<number, { name: string; label: string }>();
let midiHeld = new Set<number>();

function paintKeys() {
  for (const [m, el] of keyEls) {
    const c = claudeNotes.get(m);
    el.classList.toggle("claude", !!c);
    el.classList.toggle("midi", midiHeld.has(m));
    const lbl = el.querySelector(".lbl") as HTMLSpanElement;
    if (c) {
      const n = c.name.replace(/-?\d+$/, "");
      // 白鍵は下にドレミが常に出ているので、黒鍵だけドレミも書く
      const sol = el.classList.contains("black") ? `<br>${solfegeOf(n)}` : "";
      lbl.innerHTML = `${esc(pretty(n))}${sol}${c.label ? `<br>${esc(pretty(c.label))}` : ""}`;
    } else {
      lbl.innerHTML = "";
    }
  }
}

// ---------- 音 ----------
let sampler: Tone.Sampler | null = null;
let samplerLoaded = false;

async function sampleBase(): Promise<string> {
  try {
    const r = await fetch("/samples/A4.mp3", { method: "HEAD" });
    if (r.ok) return "/samples/";
  } catch {}
  return "https://tonejs.github.io/audio/salamander/";
}

async function initSampler() {
  const urls: Record<string, string> = { A0: "A0.mp3", C8: "C8.mp3" };
  for (let o = 1; o <= 7; o++) {
    urls[`C${o}`] = `C${o}.mp3`;
    urls[`D#${o}`] = `Ds${o}.mp3`;
    urls[`F#${o}`] = `Fs${o}.mp3`;
    urls[`A${o}`] = `A${o}.mp3`;
  }
  const baseUrl = await sampleBase();
  sampler = new Tone.Sampler({
    urls,
    baseUrl,
    release: 1.2,
    onload: () => {
      samplerLoaded = true;
      updateAudioUi();
    },
  }).toDestination();
}

function audioReady() {
  return Tone.getContext().state === "running" && samplerLoaded;
}

async function unlockAudio() {
  try {
    await Tone.start();
  } catch {}
  updateAudioUi();
}

function updateAudioUi() {
  const btn = $<HTMLButtonElement>("audio-btn");
  if (audioReady()) {
    btn.textContent = "音: ON";
    btn.classList.remove("need");
  } else if (!samplerLoaded) {
    btn.textContent = "音源を読み込み中…";
    btn.classList.add("need");
  } else {
    btn.textContent = "音を出す";
    btn.classList.add("need");
  }
  reportStatus();
}

const freq = (m: number) => Tone.Frequency(m, "midi").toNote();

function playChord(p: PlayPayload) {
  if (!sampler || !audioReady()) return;
  sampler.releaseAll();
  const now = Tone.now() + 0.02;
  p.notes.forEach((n, i) => {
    const t = now + (p.arp ? i * 0.14 : i * 0.006);
    const vel = n.hand === "L" ? 0.75 : 0.65;
    sampler!.triggerAttackRelease(freq(n.midi), p.duration - (p.arp ? i * 0.14 : 0), t, vel);
  });
}

// ---------- Claude 表示 ----------
let current: PlayPayload | null = null;

function renderClaude() {
  const has = !!current;
  $("claude-empty").hidden = has;
  $("claude-body").hidden = !has;
  claudeNotes = new Map();
  const progEl = $("claude-prog");
  const ctlEl = $("claude-prog-ctl");
  const replayBtn = $("replay-btn");
  const titleEl = $("claude-title");
  if (current) {
    const seq = current.sequence;
    if (seq && seq.length > 1) {
      // 進行: 並びは同じ進行のあいだ作り直さず、今のコードの色だけ変える
      progEl.hidden = false; // 幅を測るので先に表示してから描く
      renderProgBoxes();
      renderProgCtl();
      ctlEl.hidden = false;
      titleEl.hidden = true;
      replayBtn.hidden = true;
    } else {
      progEl.hidden = true;
      ctlEl.hidden = true;
      replayBtn.hidden = false;
      titleEl.hidden = false;
      titleEl.textContent = pretty(current.title);
    }
    $("claude-tones").innerHTML = current.source === "chord"
      ? current.tones.map((t) => `<li><span class="n">${esc(pretty(t.name))}</span><span class="s">${solfegeOf(t.name)}</span><span class="d">${esc(pretty(t.label))}</span></li>`).join("")
      : "";
    $("claude-voiced").textContent = current.notes.map((n) => `${pretty(n.name)}(${solfegeOf(n.name)})`).join("  ");
    $("claude-warn").innerHTML = current.warnings.map((w) => `<li>${esc(w)}</li>`).join("");
    for (const n of current.notes) claudeNotes.set(n.midi, { name: n.name, label: n.label === "bass" ? "" : n.label });
  }
  paintKeys();
}

// ---------- 進行の操作（タイミングはサーバーが持つので、命令を送るだけ） ----------
let bpmDragging = false;

function progControl(body: Record<string, unknown>) {
  return fetch("/api/progression/control", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});
}

function renderProgCtl() {
  if (!current?.sequence) return;
  const playing = current.playing !== false;
  $("prog-toggle").textContent = playing ? "■ 一時停止" : "▶ 再生";
  const bpm = Math.round(current.bpm ?? 80);
  const range = $<HTMLInputElement>("bpm-range");
  if (!bpmDragging) range.value = String(bpm);
  $("bpm-val").textContent = bpmDragging ? range.value : String(bpm);
  const lengths = current.lengths ?? current.sequence.map(() => 4);
  const total = lengths.reduce((a, b) => a + b, 0);
  $("prog-info").textContent =
    `${current.sequence.length}コード・全部で${fmtBeats(total)}拍・${current.loop ? "ループ" : "1回"}・${playing ? "再生中" : "停止中"}・右端をドラッグで長さを変える`;
}

/** 拍数を表示用に（0.5 → ½、1.75 → 1¾） */
function fmtBeats(b: number): string {
  const whole = Math.floor(b);
  const q = Math.round((b - whole) * 4);
  const frac = ["", "¼", "½", "¾"][q];
  return whole === 0 ? frac : `${whole}${frac}`;
}

/** 1拍あたりの横幅（px）。CSS の --beat-px から読む */
function beatPx(): number {
  const v = parseFloat(getComputedStyle($("claude-prog")).getPropertyValue("--beat-px"));
  return Number.isFinite(v) && v > 0 ? v : 56;
}

let renderedProgKey = "";

/** 進行の四角を描く。横幅は拍数に比例。並びと拍数が変わったときだけ作り直す */
function renderProgBoxes() {
  if (!current?.sequence) return;
  const progEl = $("claude-prog");
  const seq = current.sequence;
  const lengths = current.lengths ?? seq.map(() => 4);
  const key = `${current.progId}|${seq.join(",")}|${lengths.join(",")}`;
  if (key !== renderedProgKey && !lengthDrag) {
    const px = beatPx();
    progEl.innerHTML = seq
      .map(
        (n, i) =>
          `<li data-i="${i}" style="width:${lengths[i] * px}px" title="${esc(pretty(n))}（${fmtBeats(lengths[i])}拍）クリックでこのコードへ">` +
          `<span class="cn">${esc(pretty(n))}</span><span class="len">${fmtBeats(lengths[i])}拍</span>` +
          `<span class="grip" title="ドラッグで長さを変える"></span></li>`,
      )
      .join("");
    renderedProgKey = key;
    for (const li of progEl.children) fitChordName(li as HTMLElement);
  }
  [...progEl.children].forEach((li, i) => li.classList.toggle("now", i === current!.index));
}

/** 四角の幅に合わせてコード名の文字を小さくする。それでも入らなければ縦書き */
function fitChordName(li: HTMLElement) {
  if (li.clientWidth === 0) {
    // まだ表示されていない。表示されてから測り直す
    requestAnimationFrame(() => li.isConnected && li.clientWidth > 0 && fitChordName(li));
    return;
  }
  const cn = li.querySelector(".cn") as HTMLElement;
  cn.classList.remove("vert");
  // 細い四角は拍数の文字を隠してつまみを細くする（拍数はホバーのツールチップに出る）
  li.classList.toggle("narrow", li.clientWidth < 44);
  const avail = li.clientWidth - 8;
  let size = 40;
  cn.style.fontSize = `${size}px`;
  while (cn.scrollWidth > avail && size > 12) {
    size -= 2;
    cn.style.fontSize = `${size}px`;
  }
  if (cn.scrollWidth > avail) {
    cn.classList.add("vert");
    cn.style.fontSize = "";
  }
}

// 右端ドラッグで長さを変える
let lengthDrag: { li: HTMLElement; index: number; left: number; beats: number; moved: boolean } | null = null;
let suppressClick = false;

function initProgControls() {
  const progEl = $("claude-prog");
  progEl.addEventListener("pointerdown", (e) => {
    const grip = (e.target as HTMLElement).closest(".grip");
    if (!grip) return;
    e.preventDefault();
    e.stopPropagation();
    const li = grip.closest("li[data-i]") as HTMLElement;
    const index = Number(li.dataset.i);
    lengthDrag = { li, index, left: li.getBoundingClientRect().left, beats: current?.lengths?.[index] ?? 4, moved: false };
    li.classList.add("dragging");
    progEl.classList.add("resizing");
    (grip as HTMLElement).setPointerCapture(e.pointerId);
  });
  progEl.addEventListener("pointermove", (e) => {
    if (!lengthDrag) return;
    const px = beatPx();
    const raw = (e.clientX - lengthDrag.left) / px;
    const beats = Math.min(16, Math.max(0.25, Math.round(raw * 4) / 4));
    if (beats !== lengthDrag.beats) {
      lengthDrag.beats = beats;
      lengthDrag.moved = true;
      lengthDrag.li.style.width = `${beats * px}px`;
      (lengthDrag.li.querySelector(".len") as HTMLElement).textContent = `${fmtBeats(beats)}拍`;
      fitChordName(lengthDrag.li);
    }
  });
  const endDrag = () => {
    if (!lengthDrag) return;
    const d = lengthDrag;
    lengthDrag = null;
    d.li.classList.remove("dragging");
    progEl.classList.remove("resizing");
    suppressClick = true;
    setTimeout(() => (suppressClick = false), 0);
    if (d.moved) void progControl({ action: "length", index: d.index, beats: d.beats });
  };
  progEl.addEventListener("pointerup", endDrag);
  progEl.addEventListener("pointercancel", endDrag);
  progEl.addEventListener("click", (e) => {
    if (suppressClick || (e.target as HTMLElement).closest(".grip")) return;
    const li = (e.target as HTMLElement).closest("li[data-i]") as HTMLElement | null;
    if (!li) return;
    void unlockAudio();
    void progControl({ action: "jump", index: Number(li.dataset.i) });
  });
  $("prog-toggle").addEventListener("click", () => {
    void unlockAudio();
    void progControl({ action: "toggle" });
  });
  const range = $<HTMLInputElement>("bpm-range");
  let t: ReturnType<typeof setTimeout> | null = null;
  range.addEventListener("pointerdown", () => (bpmDragging = true));
  window.addEventListener("pointerup", () => {
    if (bpmDragging) {
      bpmDragging = false;
      renderProgCtl();
    }
  });
  range.addEventListener("input", () => {
    $("bpm-val").textContent = range.value;
    if (t) clearTimeout(t);
    t = setTimeout(() => void progControl({ action: "bpm", bpm: Number(range.value) }), 120);
  });
}

/** 表示用に b / # を ♭ / ♯ にする。コード名の語彙（dim, aug, sus, add, omit, M, m）に小文字 b は出てこないので安全 */
function pretty(s: string) {
  return s.replace(/b/g, "♭").replace(/#/g, "♯");
}

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** Claudeが鳴らした音を止めて表示を消す。サーバー側も消すので他のタブや ./chord status にも反映される */
function resetClaude() {
  sampler?.releaseAll();
  current = null;
  renderClaude();
  fetch("/api/clear", { method: "POST" }).catch(() => {});
}

// ---------- サーバー接続 ----------
function connect() {
  const es = new EventSource(`/events?id=${clientId}`);
  const st = $("st-server");
  es.onopen = () => {
    st.textContent = "サーバー: 接続";
    st.classList.remove("bad");
    reportStatus(true);
  };
  es.onerror = () => {
    st.textContent = "サーバー: 切断（再接続中）";
    st.classList.add("bad");
  };
  es.addEventListener("chord", (ev) => {
    const data = JSON.parse((ev as MessageEvent).data) as PlayPayload & { replay: boolean };
    current = data;
    renderClaude();
    if (data.replay) playChord(data);
    else if (data.sequence && data.playing === false) sampler?.releaseAll();
  });
  es.addEventListener("progstate", (ev) => {
    const info = JSON.parse((ev as MessageEvent).data);
    if (!current?.sequence || !info) return;
    current = { ...current, bpm: info.bpm, each: info.each, playing: info.playing, lengths: info.lengths };
    renderProgBoxes();
    renderProgCtl();
  });
  es.addEventListener("clear", () => {
    current = null;
    sampler?.releaseAll();
    renderClaude();
  });
}

let lastReport = "";
let midiEvents = 0;
let midiInputNames: string[] = [];
function reportStatus(force = false) {
  const body = JSON.stringify({ id: clientId, audioReady: audioReady(), midiInputs: midiInputNames, midiEvents });
  if (!force && body === lastReport) return;
  lastReport = body;
  fetch("/api/client-status", { method: "POST", headers: { "content-type": "application/json" }, body }).catch(() => {});
}

// ---------- MIDI ----------
const pressed = new Set<number>();
const sustained = new Set<number>();
let pedal = false;
let midiSound = false;
let renderQueued = false;

function heldNotes(): Set<number> {
  return new Set([...pressed, ...sustained]);
}

function queueMidiRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderMidi();
  });
}

function renderMidi() {
  midiHeld = heldNotes();
  const notes = [...midiHeld].sort((a, b) => a - b);
  const has = notes.length > 0;
  $("midi-empty").hidden = has;
  $("midi-body").hidden = !has;
  $("midi-pedal").hidden = !pedal;
  if (has) {
    const cands = detectChords(notes);
    $("midi-cands").innerHTML = cands
      .map((c, i) => {
        const size = i === 0 ? "" : `font-size:${Math.round(16 + 40 * c.prob)}px`;
        return `<li><div class="row"><span class="name" style="${size}">${esc(pretty(c.name))}</span><span class="pct">${Math.round(c.prob * 100)}%</span></div><div class="barline" style="width:${Math.max(2, c.prob * 100)}%"></div></li>`;
      })
      .join("");
    // いちばん確率の高いコードに合わせて綴る（Cm7 なら D# ではなく Eb）
    const spell = new Map<number, Spelled>();
    const top = cands[0] ? parseChord(cands[0].name) : null;
    if (top?.ok) {
      for (const t of top.chord.tones) spell.set(t.pc, t.note);
      if (top.chord.bass) spell.set(pcOf(top.chord.bass), top.chord.bass);
    }
    $("midi-held").textContent = notes
      .map((m) => {
        const sp = spell.get(mod(m, 12)) ?? simplestSpelling(mod(m, 12), true);
        const n = nameWithOctave(sp, m);
        return `${pretty(n)}(${solfegeOf(n)})`;
      })
      .join("  ");
    const iv = intervalName(notes);
    $("midi-interval-row").hidden = !iv;
    if (iv) $("midi-interval").textContent = iv;
  }
  paintKeys();
}

function noteOn(m: number, vel: number) {
  pressed.add(m);
  sustained.delete(m);
  if (midiSound && sampler && audioReady()) sampler.triggerAttack(freq(m), Tone.now(), Math.max(0.1, vel / 127));
  queueMidiRender();
}
function noteOff(m: number) {
  pressed.delete(m);
  if (pedal) sustained.add(m);
  else if (midiSound && sampler) sampler.triggerRelease(freq(m), Tone.now());
  queueMidiRender();
}
function setPedal(on: boolean) {
  pedal = on;
  if (!on) {
    if (midiSound && sampler) for (const m of sustained) if (!pressed.has(m)) sampler.triggerRelease(freq(m), Tone.now());
    sustained.clear();
  }
  queueMidiRender();
}

function onMidiMessage(e: MIDIMessageEvent) {
  const d = e.data;
  if (!d || d.length < 2) return;
  const type = d[0] & 0xf0;
  if (type === 0x90 || type === 0x80 || type === 0xb0) midiEvents++;
  if (type === 0x90 && d[2] > 0) noteOn(d[1], d[2]);
  else if (type === 0x80 || (type === 0x90 && d[2] === 0)) noteOff(d[1]);
  else if (type === 0xb0 && d[1] === 64) setPedal(d[2] >= 64);
  else if (type === 0xb0 && (d[1] === 123 || d[1] === 120)) {
    pressed.clear();
    sustained.clear();
    queueMidiRender();
  }
}

async function initMidi() {
  const st = $("st-midi");
  if (!("requestMIDIAccess" in navigator)) {
    st.textContent = "MIDI: このブラウザは非対応（Chrome / Edge を使う）";
    st.classList.add("bad");
    return;
  }
  try {
    const access = await navigator.requestMIDIAccess({ sysex: false });
    const bind = () => {
      const inputs = [...access.inputs.values()].filter((i) => !/Midi Through/i.test(i.name ?? ""));
      for (const i of access.inputs.values()) i.onmidimessage = onMidiMessage;
      midiInputNames = inputs.map((i) => i.name ?? "unknown");
      if (inputs.length) {
        st.textContent = `MIDI: ${midiInputNames.join(", ")}`;
        st.classList.remove("bad");
      } else {
        st.textContent = "MIDI: デバイスなし";
        st.classList.remove("bad");
      }
      reportStatus();
    };
    access.onstatechange = bind;
    bind();
  } catch (e) {
    st.textContent = "MIDI: 許可されなかった（アドレスバーのサイト設定で MIDI を許可）";
    st.classList.add("bad");
  }
}

// ---------- マウス / タッチで鍵盤を押す ----------
function initPointer() {
  const down = new Map<number, number>();
  keyboard.addEventListener("pointerdown", (e) => {
    const el = (e.target as HTMLElement).closest(".key") as HTMLElement | null;
    if (!el) return;
    const m = Number(el.dataset.midi);
    down.set(e.pointerId, m);
    pressed.add(m);
    queueMidiRender();
    void unlockAudio().then(() => {
      if (sampler && audioReady() && pressed.has(m)) sampler.triggerAttack(freq(m), Tone.now(), 0.6);
    });
  });
  const up = (e: PointerEvent) => {
    const m = down.get(e.pointerId);
    if (m === undefined) return;
    down.delete(e.pointerId);
    pressed.delete(m);
    sampler?.triggerRelease(freq(m), Tone.now());
    queueMidiRender();
  };
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}

// ---------- 起動 ----------
function init() {
  buildKeyboard();
  initPointer();
  initProgControls();
  const refit = () => {
    renderedProgKey = "";
    renderProgBoxes();
  };
  window.addEventListener("resize", refit);
  // Webフォントが読み込まれると文字幅が変わるので測り直す
  void document.fonts?.ready.then(refit);
  renderClaude();
  renderMidi();

  const ms = $<HTMLInputElement>("midi-sound");
  try {
    midiSound = localStorage.getItem("midiSound") === "1";
  } catch {}
  ms.checked = midiSound;
  ms.addEventListener("change", () => {
    midiSound = ms.checked;
    try {
      localStorage.setItem("midiSound", midiSound ? "1" : "0");
    } catch {}
  });

  $("audio-btn").addEventListener("click", unlockAudio);
  $("replay-btn").addEventListener("click", async () => {
    await unlockAudio();
    if (current) playChord(current);
  });
  $("reset-btn").addEventListener("click", resetClaude);
  window.addEventListener("keydown", async (e) => {
    if (e.code === "Escape" && current) {
      resetClaude();
      return;
    }
    if (e.code === "Space" && current?.sequence && !(e.target instanceof HTMLInputElement)) {
      e.preventDefault();
      void unlockAudio();
      void progControl({ action: "toggle" });
      return;
    }
    if (e.code === "Space" && current && !(e.target instanceof HTMLInputElement)) {
      e.preventDefault();
      await unlockAudio();
      playChord(current);
    }
  });
  // 最初の操作で音声を有効にする
  // 自動再生が許可されていれば（./chord open の専用ウィンドウ）最初から音が出る。
  // 許可されていない普通のタブでは、最初のクリックかキー操作で音が出るようになる
  void unlockAudio();
  window.addEventListener("pointerdown", unlockAudio, { once: true });
  window.addEventListener("keydown", unlockAudio, { once: true });
  Tone.getContext().on("statechange", updateAudioUi);

  void initSampler();
  updateAudioUi();
  connect();
  void initMidi();
  // テスト用: 生のMIDIバイト列を Web MIDI と同じ処理に流す
  (window as any).__feedMidi = (bytes: number[]) => onMidiMessage({ data: new Uint8Array(bytes) } as MIDIMessageEvent);
  setInterval(() => reportStatus(), 3000);
}

init();
