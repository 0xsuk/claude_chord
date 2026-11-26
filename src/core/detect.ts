// 押さえている音からコード名の候補を確率つきで推定する。
import { parseChord, type Tone } from "./chord.ts";
import { formatChordName } from "./name.ts";
import { mod, nameOf, simplestSpelling, spellInterval, type Spelled } from "./notes.ts";

export interface Candidate {
  name: string;
  prob: number; // 0..1
  cost: number;
}

interface Template {
  suffix: string;
  tones: Tone[]; // ルート C での構成音
  rarity: number;
  minorish: boolean;
}

// 候補にするコードの型と、珍しさ（大きいほど出にくい）
const TEMPLATE_DEFS: [string, number][] = [
  ["", 0], ["m", 0], ["5", 0.6],
  ["7", 0.05], ["maj7", 0.05], ["m7", 0.05], ["m7b5", 0.15], ["dim", 0.25], ["dim7", 0.2], ["aug", 0.3],
  ["6", 0.2], ["m6", 0.25], ["sus4", 0.2], ["sus2", 0.3], ["7sus4", 0.3], ["9sus4", 0.55],
  ["add9", 0.25], ["madd9", 0.3], ["69", 0.4], ["m69", 0.5], ["add11", 0.7], ["madd11", 0.7],
  ["9", 0.2], ["maj9", 0.25], ["m9", 0.25], ["11", 0.55], ["m11", 0.4], ["13", 0.4], ["maj13", 0.5], ["m13", 0.5],
  ["7b9", 0.4], ["7#9", 0.4], ["7#11", 0.5], ["7b13", 0.55], ["7#5", 0.5], ["7b5", 0.6],
  ["7b9b13", 0.7], ["7#9b13", 0.7], ["7#9#5", 0.75], ["13b9", 0.7], ["13#11", 0.7], ["9#11", 0.6],
  ["mM7", 0.5], ["mM9", 0.7], ["maj7#11", 0.5], ["maj9#11", 0.6], ["maj7#5", 0.6], ["m7#5", 0.8], ["aug7", 0.6],
  ["dimM7", 0.9], ["7sus2", 0.7], ["m11b5", 0.8],
];

let templates: Template[] | null = null;
function getTemplates(): Template[] {
  if (templates) return templates;
  templates = TEMPLATE_DEFS.map(([suffix, rarity]) => {
    const r = parseChord("C" + suffix);
    if (!r.ok) throw new Error(`template ${suffix}: ${r.error}`);
    return { suffix, tones: r.chord.tones, rarity, minorish: r.chord.tones.some((t) => t.label === "b3") };
  });
  return templates;
}

// マイナー系はシャープ（C#m, F#m, G#m）、メジャー系はフラット寄り（Db, Ab）
const MAJOR_ROOTS = [0, -1, 0, -1, 0, 0, 1, 0, -1, 0, -1, 0];
const MINOR_ROOTS = [0, 1, 0, -1, 0, 0, 1, 0, 1, 0, -1, 0];

function rootSpelling(pc: number, minorish: boolean): Spelled {
  const pref = (minorish ? MINOR_ROOTS : MAJOR_ROOTS)[pc];
  return simplestSpelling(pc, pref < 0);
}

/** 押さえている MIDI ノート番号からコード候補を出す */
export function detectChords(midis: number[], maxResults = 6): Candidate[] {
  const uniq = [...new Set(midis)].sort((a, b) => a - b);
  if (uniq.length === 0) return [];
  const pcs = new Set(uniq.map((m) => mod(m, 12)));
  const bassPc = mod(uniq[0], 12);

  if (pcs.size === 1) {
    return [{ name: nameOf(simplestSpelling(bassPc, false)), prob: 1, cost: 0 }];
  }

  const results: Candidate[] = [];
  for (let root = 0; root < 12; root++) {
    for (const t of getTemplates()) {
      const chordPcs = new Map<number, Tone>();
      for (const tone of t.tones) chordPcs.set(mod(root + tone.semis, 12), tone);

      const bassInChord = chordPcs.has(bassPc);
      const heard = new Set(pcs);
      if (!bassInChord) heard.delete(bassPc);

      let cost = 0;
      let matched = 0;
      for (const [pc, tone] of chordPcs) {
        if (heard.has(pc)) {
          matched++;
          continue;
        }
        if (tone.degree === 1) cost += 1.3;
        else if (tone.label === "5") cost += 0.45;
        else cost += 2.0;
      }
      for (const pc of heard) if (!chordPcs.has(pc)) cost += 2.3;
      if (matched < 2) continue;
      if (!heard.has(root) && heard.size < 3) continue;

      let bassSp: Spelled | null = null;
      const rootSp = rootSpelling(root, t.minorish);
      if (bassPc !== root) {
        if (bassInChord) {
          const bt = chordPcs.get(bassPc)!;
          cost += bt.degree > 7 ? 0.6 : 0.35;
          bassSp = spellInterval(rootSp, bt.degree, bt.semis);
        } else {
          cost += 0.9;
          bassSp = simplestSpelling(bassPc, MAJOR_ROOTS[bassPc] < 0);
        }
      }
      cost += 0.1 * chordPcs.size + t.rarity;

      const name = formatChordName(rootSp, t.tones, bassSp);
      results.push({ name, prob: 0, cost });
    }
  }

  // 同名は安い方だけ残す
  const best = new Map<string, Candidate>();
  for (const c of results) {
    const prev = best.get(c.name);
    if (!prev || c.cost < prev.cost) best.set(c.name, c);
  }
  const list = [...best.values()].sort((a, b) => a.cost - b.cost);
  const tau = 0.45;
  const min = list[0]?.cost ?? 0;
  const weights = list.map((c) => Math.exp(-(c.cost - min) / tau));
  const total = weights.reduce((a, b) => a + b, 0);
  list.forEach((c, i) => (c.prob = weights[i] / total));
  return list.filter((c) => c.prob >= 0.02).slice(0, maxResults);
}

const INTERVAL_NAMES = [
  "完全1度", "短2度", "長2度", "短3度", "長3度", "完全4度", "増4度/減5度", "完全5度", "短6度", "長6度", "短7度", "長7度",
];

/** 2音のときの音程名 */
export function intervalName(midis: number[]): string | null {
  const u = [...new Set(midis)].sort((a, b) => a - b);
  if (u.length !== 2) return null;
  const d = u[1] - u[0];
  const base = INTERVAL_NAMES[d % 12];
  return d >= 12 ? `${base}（+${Math.floor(d / 12)}オクターブ）` : base;
}
