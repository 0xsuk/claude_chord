// 構成音を鍵盤上の具体的な音（MIDI番号）に配置する。
import type { Chord, Tone } from "./chord.ts";
import { MIDI_MAX, MIDI_MIN, mod, nameWithOctave, pcOf, type Spelled } from "./notes.ts";

export const VOICINGS = ["close", "drop2", "drop3", "shell", "spread", "onehand"] as const;
export type VoicingKind = (typeof VOICINGS)[number];

export interface Voiced {
  midi: number;
  name: string; // オクターブ付き（Eb4 など）
  label: string; // 度数（b3, 9, bass など）
  hand: "L" | "R";
}

export interface VoiceOptions {
  voicing?: VoicingKind;
  inversion?: number; // 0 = 基本形, 1 = 第1転回形 ...
}

export type VoiceResult = { ok: true; notes: Voiced[]; warnings: string[] } | { ok: false; error: string };

const byDegree = (a: Tone, b: Tone) => a.degree - b.degree || a.semis - b.semis;

/** pc の音のうち minMidi 以上で最も低いもの */
function above(pc: number, minMidi: number): number {
  return minMidi + mod(pc - minMidi, 12);
}

/** 下から順に積む。前の音より必ず上に置く */
function stack(pcs: number[], first: number): number[] {
  const out: number[] = [];
  let prev = first - 1;
  for (const pc of pcs) {
    const m = above(pc, prev + 1);
    out.push(m);
    prev = m;
  }
  return out;
}

/** 積んだ和音の重心が center に近くなる位置を選ぶ */
function stackCentered(pcs: number[], center: number, floor: number): number[] {
  let best: number[] = [];
  let bestScore = Infinity;
  for (let start = floor; start < floor + 24; start++) {
    if (mod(start, 12) !== pcs[0]) continue;
    const s = stack(pcs, start);
    const avg = s.reduce((a, b) => a + b, 0) / s.length;
    const score = Math.abs(avg - center);
    if (score < bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best;
}

/** オクターブ内に詰める（クローズド） */
function compact(midis: number[]): number[] {
  const low = Math.min(...midis);
  return midis.map((m) => low + mod(m - low, 12)).sort((a, b) => a - b);
}

export function voiceChord(chord: Chord, opts: VoiceOptions = {}): VoiceResult {
  const kind: VoicingKind = opts.voicing ?? (opts.inversion ? "onehand" : "close");
  if (!VOICINGS.includes(kind)) return { ok: false, error: `不明なボイシング: ${kind}（${VOICINGS.join(", ")}）` };
  const warnings: string[] = [];
  const tones = [...chord.tones].sort(byDegree);
  const tonePcMap = new Map(tones.map((t) => [t.pc, t] as const));

  const bassSpelled: Spelled = chord.bass ?? chord.root;
  const bassPc = pcOf(bassSpelled);
  const bassTone = tonePcMap.get(bassPc);
  const mk = (midi: number, t: Tone | null, hand: "L" | "R", spelled?: Spelled): Voiced => ({
    midi,
    name: nameWithOctave(t ? t.note : spelled!, midi),
    label: t ? t.label : "bass",
    hand,
  });

  let out: Voiced[] = [];

  if (opts.inversion !== undefined && opts.inversion !== 0) {
    if (chord.bass) return { ok: false, error: "オンコードと転回形の指定は同時に使えない（どちらかにする）" };
    if (kind !== "onehand") warnings.push(`転回形の指定があるので ${kind} ではなく onehand で配置した`);
  }

  if (kind === "onehand" || (opts.inversion ?? 0) !== 0) {
    const core = tones.filter((t) => t.degree <= 7);
    const tens = tones.filter((t) => t.degree > 7);
    const inv = opts.inversion ?? 0;
    if (inv < 0 || inv >= core.length) {
      return { ok: false, error: `転回形は 0〜${core.length - 1} の範囲（このコードは構成音が${core.length}つ）` };
    }
    const order = [...core.slice(inv), ...core.slice(0, inv), ...tens];
    const midis = stackCentered(order.map((t) => t.pc), 64, 48);
    out = midis.map((m, i) => mk(m, order[i], "R"));
    if (chord.bass && !bassTone) {
      out.unshift(mk(above(bassPc, Math.min(...midis) - 12), null, "L", bassSpelled));
    } else if (chord.bass && bassTone) {
      // オンコードを片手で：分母を一番下に
      const rest = tones.filter((t) => t.pc !== bassPc);
      const order2 = [bassTone, ...rest];
      const m2 = stackCentered(order2.map((t) => t.pc), 64, 48);
      out = m2.map((m, i) => mk(m, order2[i], "R"));
    }
    return finish(out, warnings);
  }

  // 以下は左手ベース + 右手
  const bassMidi = above(bassPc, 40); // E2〜D#3
  out.push(mk(bassMidi, bassTone ?? null, "L", bassSpelled));
  const floor = bassMidi + 5;

  let rh: Tone[] = tones.length >= 4 ? tones.filter((t) => t.pc !== bassPc) : [...tones];
  if (rh.length === 0) rh = [...tones];

  if (kind === "close") {
    const midis = stackCentered(rh.map((t) => t.pc), 66, Math.max(floor, 52));
    midis.forEach((m, i) => out.push(mk(m, rh[i], "R")));
  } else if (kind === "drop2" || kind === "drop3") {
    const n = kind === "drop2" ? 2 : 3;
    if (rh.length < n + 1) {
      warnings.push(`${kind} は右手が${n + 1}音以上のときに意味がある。close で配置した`);
      const midis = stackCentered(rh.map((t) => t.pc), 66, Math.max(floor, 52));
      midis.forEach((m, i) => out.push(mk(m, rh[i], "R")));
    } else {
      let midis = compact(stackCentered(rh.map((t) => t.pc), 68, 55));
      midis[midis.length - n] -= 12;
      midis.sort((a, b) => a - b);
      while (midis[0] <= bassMidi) midis = midis.map((m) => m + 12);
      for (const m of midis) out.push(mk(m, tonePcMap.get(mod(m, 12))!, "R"));
    }
  } else if (kind === "shell") {
    const third = tones.find((t) => t.degree === 3) ?? tones.find((t) => t.degree === 4 || t.degree === 2);
    const sev = tones.find((t) => t.degree === 7) ?? tones.find((t) => t.degree === 6) ?? tones.find((t) => t.degree === 5);
    const sel = [third, sev].filter((t): t is Tone => !!t && t.pc !== bassPc);
    if (sel.length === 0) return { ok: false, error: "シェルボイシングにできる3度・7度がない" };
    const midis = stackCentered(sel.map((t) => t.pc), 60, Math.max(floor, 50));
    midis.forEach((m, i) => out.push(mk(m, sel[i], "R")));
    const dropped = tones.filter((t) => !sel.includes(t) && t.pc !== bassPc).map((t) => t.label);
    if (dropped.length) warnings.push(`shell なので ${dropped.join(", ")} は省いた`);
  } else if (kind === "spread") {
    const fifth = tones.find((t) => t.degree === 5);
    let rest = rh;
    if (fifth && fifth.pc !== bassPc) {
      out.push(mk(above(fifth.pc, bassMidi + 1), fifth, "L"));
      rest = rh.filter((t) => t !== fifth);
    }
    if (rest.length) {
      const midis = stackCentered(rest.map((t) => t.pc), 68, Math.max(floor + 7, 55));
      midis.forEach((m, i) => out.push(mk(m, rest[i], "R")));
    }
  }

  return finish(out, warnings);
}

function finish(out: Voiced[], warnings: string[]): VoiceResult {
  out.sort((a, b) => a.midi - b.midi);
  let shift = 0;
  const lo = out[0].midi;
  const hi = out[out.length - 1].midi;
  if (lo < MIDI_MIN) shift = Math.ceil((MIDI_MIN - lo) / 12) * 12;
  if (hi + shift > MIDI_MAX) shift = -Math.ceil((hi - MIDI_MAX) / 12) * 12;
  if (shift) {
    out = out.map((v) => {
      const name = v.name.replace(/-?\d+$/, (o) => String(parseInt(o, 10) + shift / 12));
      return { ...v, midi: v.midi + shift, name };
    });
  }
  return { ok: true, notes: out, warnings };
}
