// Claude からの「弾いて」リクエストを、鳴らす音のリストに変換する。
import { parseChord } from "./chord.ts";
import { detectChords } from "./detect.ts";
import { MIDI_MAX, MIDI_MIN, nameWithOctave, parseNoteWithOctave } from "./notes.ts";
import { type VoiceOptions, type Voiced, voiceChord } from "./voicing.ts";

export interface PlayRequest extends VoiceOptions {
  input: string;
  arp?: boolean;
  duration?: number; // 秒
}

export interface PlayPayload {
  id: number;
  input: string;
  title: string; // 画面に大きく出す名前
  source: "chord" | "notes";
  tones: { label: string; name: string }[]; // 構成音（度数順）
  notes: Voiced[]; // 鳴らす音
  arp: boolean;
  duration: number;
  warnings: string[];
  /** 進行を再生中のとき：並び全体、今の位置、進行のID、1コードの秒数、ループするか */
  sequence?: string[];
  index?: number;
  progId?: number;
  each?: number;
  loop?: boolean;
  playing?: boolean;
  bpm?: number;
  lengths?: number[]; // 進行の各コードの拍数
}

export interface ProgressionRequest {
  chords: string[];
  bpm?: number; // 既定 80
  beats?: number | string; // 拍数を書いていないコードの拍数（既定 4）
  each?: number; // 1コードあたりの秒数（bpm がないときに使う）
  loop?: boolean;
  voicing?: PlayRequest["voicing"];
  arp?: boolean;
}

/** 拍数の表記（"3" "0.5" "1/2" "1.75" "3/4"）を読む。1/4拍刻みで 0.25〜16。3連符のような値は null */
export function parseBeats(text: string): number | null {
  const t = text.normalize("NFKC").trim();
  let v: number;
  const frac = /^(\d+)\/(\d+)$/.exec(t);
  if (frac) v = Number(frac[1]) / Number(frac[2]);
  else if (/^\d+(\.\d+)?$/.test(t)) v = Number(t);
  else return null;
  if (!Number.isFinite(v) || v < 0.25 || v > 16) return null;
  if (Math.abs(v * 4 - Math.round(v * 4)) > 1e-9) return null;
  return Math.round(v * 4) / 4;
}

/** "CM7:3" → { chord: "CM7", beats: "3" }。コロンがなければ beats は undefined */
export function splitChordBeats(entry: string): { chord: string; beats?: string } {
  const t = entry.trim();
  const k = t.search(/[:：]/);
  // コード名にコロンは出てこないので、コロンがあればその後ろを拍数として読む（読めなければ parseBeats が null を返す）
  return k < 0 ? { chord: t } : { chord: t.slice(0, k).trim(), beats: t.slice(k + 1).trim() };
}

export type ResolveResult = { ok: true; payload: Omit<PlayPayload, "id"> } | { ok: false; error: string };

const NOTE_TOKEN = /^[A-Ga-g](##|bb|x|#|b|♯|♭)?(-?\d)?$/;

export function isNoteList(input: string): boolean {
  const toks = input.normalize("NFKC").trim().split(/[\s,]+/).filter(Boolean);
  return toks.length >= 2 && toks.every((t) => NOTE_TOKEN.test(t));
}

export function resolvePlay(req: PlayRequest): ResolveResult {
  const input = (req.input ?? "").trim();
  if (!input) return { ok: false, error: "入力が空" };
  const duration = clamp(req.duration ?? 3, 0.2, 20);
  const arp = !!req.arp;

  if (isNoteList(input)) {
    const toks = input.normalize("NFKC").replace(/♯/g, "#").replace(/♭/g, "b").trim().split(/[\s,]+/).filter(Boolean);
    const notes: Voiced[] = [];
    let prev = 59; // オクターブ省略時は C4 付近から上に積む
    for (const t of toks) {
      const p = parseNoteWithOctave(t);
      if (!p) return { ok: false, error: `音名が読めない: "${t}"` };
      let midi = p.midi;
      if (midi === null) {
        const pc = ((p.note.acc + [0, 2, 4, 5, 7, 9, 11][p.note.letter]) % 12 + 12) % 12;
        midi = prev + 1 + ((pc - (prev + 1)) % 12 + 12) % 12;
      }
      if (midi < MIDI_MIN || midi > MIDI_MAX) return { ok: false, error: `鍵盤の範囲外（A0〜C8）: "${t}"` };
      prev = midi;
      notes.push({ midi, name: nameWithOctave(p.note, midi), label: "", hand: "R" });
    }
    notes.sort((a, b) => a.midi - b.midi);
    const guess = detectChords(notes.map((n) => n.midi), 3);
    const warnings = guess.length
      ? [`推定コード: ${guess.map((g) => `${g.name} ${Math.round(g.prob * 100)}%`).join(", ")}`]
      : [];
    return {
      ok: true,
      payload: {
        input,
        title: guess[0]?.name ?? notes.map((n) => n.name).join(" "),
        source: "notes",
        tones: notes.map((n) => ({ label: "", name: n.name })),
        notes,
        arp,
        duration,
        warnings,
      },
    };
  }

  const r = parseChord(input);
  if (!r.ok) return r;
  const v = voiceChord(r.chord, { voicing: req.voicing, inversion: req.inversion });
  if (!v.ok) return v;
  const c = r.chord;
  let title = c.name;
  if (req.inversion) title += `（第${req.inversion}転回形）`;
  return {
    ok: true,
    payload: {
      input,
      title,
      source: "chord",
      tones: c.tones.map((t) => ({ label: t.label, name: t.name })),
      notes: v.notes,
      arp,
      duration,
      warnings: [...c.notes, ...v.warnings],
    },
  };
}

function clamp(x: number, lo: number, hi: number) {
  return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : lo;
}
