// 音名・音程まわりの基本処理。
// オクターブ表記は国際式（C4 = MIDI 60 = 中央C）。

export const LETTERS = ["C", "D", "E", "F", "G", "A", "B"] as const;
export const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];

/** 綴りを持った音名。letter は C=0 ... B=6、acc は -2..+2（bb..##） */
export interface Spelled {
  letter: number;
  acc: number;
}

export const mod = (n: number, m: number) => ((n % m) + m) % m;

export function pcOf(n: Spelled): number {
  return mod(LETTER_PC[n.letter] + n.acc, 12);
}

export function accString(acc: number): string {
  if (acc > 0) return "#".repeat(acc);
  if (acc < 0) return "b".repeat(-acc);
  return "";
}

export function nameOf(n: Spelled): string {
  return LETTERS[n.letter] + accString(n.acc);
}

const NOTE_RE = /^([A-Ga-g])(##|bb|x|#|b)?/;

/** 文字列の先頭から音名を読む。読めなければ null */
export function readNoteName(s: string): { note: Spelled; length: number } | null {
  const m = NOTE_RE.exec(s);
  if (!m) return null;
  const letter = LETTERS.indexOf(m[1].toUpperCase() as (typeof LETTERS)[number]);
  const a = m[2] ?? "";
  const acc = a === "##" || a === "x" ? 2 : a === "#" ? 1 : a === "bb" ? -2 : a === "b" ? -1 : 0;
  return { note: { letter, acc }, length: m[0].length };
}

/** 長音階を基準にした各度数の半音数 */
export const DEGREE_BASE: Record<number, number> = {
  1: 0, 2: 2, 3: 4, 4: 5, 5: 7, 6: 9, 7: 11, 9: 14, 11: 17, 13: 21,
};

/** root から degree 度・semis 半音上の音を、度数に合った文字で綴る */
export function spellInterval(root: Spelled, degree: number, semis: number): Spelled {
  const letter = mod(root.letter + degree - 1, 7);
  const target = mod(pcOf(root) + semis, 12);
  let acc = mod(target - LETTER_PC[letter], 12);
  if (acc > 6) acc -= 12;
  if (Math.abs(acc) > 2) {
    // 三重変化記号になる場合は綴りをあきらめて近い表記にする
    return simplestSpelling(target, acc < 0);
  }
  return { letter, acc };
}

const SHARP_NAMES: Spelled[] = [
  { letter: 0, acc: 0 }, { letter: 0, acc: 1 }, { letter: 1, acc: 0 }, { letter: 1, acc: 1 },
  { letter: 2, acc: 0 }, { letter: 3, acc: 0 }, { letter: 3, acc: 1 }, { letter: 4, acc: 0 },
  { letter: 4, acc: 1 }, { letter: 5, acc: 0 }, { letter: 5, acc: 1 }, { letter: 6, acc: 0 },
];
const FLAT_NAMES: Spelled[] = [
  { letter: 0, acc: 0 }, { letter: 1, acc: -1 }, { letter: 1, acc: 0 }, { letter: 2, acc: -1 },
  { letter: 2, acc: 0 }, { letter: 3, acc: 0 }, { letter: 4, acc: -1 }, { letter: 4, acc: 0 },
  { letter: 5, acc: -1 }, { letter: 5, acc: 0 }, { letter: 6, acc: -1 }, { letter: 6, acc: 0 },
];

export function simplestSpelling(pc: number, preferFlat: boolean): Spelled {
  return (preferFlat ? FLAT_NAMES : SHARP_NAMES)[mod(pc, 12)];
}

/** 綴りと MIDI 番号からオクターブ付きの音名を作る（Cb4 = 59、B#3 = 60） */
export function nameWithOctave(n: Spelled, midi: number): string {
  const base = LETTER_PC[n.letter] + n.acc;
  const octave = Math.round((midi - base) / 12) - 1;
  return nameOf(n) + octave;
}

/** オクターブ付き音名（C4, Bb3, F#5, Cb4）を MIDI 番号に。読めなければ null */
export function parseNoteWithOctave(s: string): { note: Spelled; midi: number | null } | null {
  const r = readNoteName(s);
  if (!r) return null;
  const rest = s.slice(r.length);
  if (rest === "") return { note: r.note, midi: null };
  if (!/^-?\d$/.test(rest)) return null;
  const octave = parseInt(rest, 10);
  const midi = (octave + 1) * 12 + LETTER_PC[r.note.letter] + r.note.acc;
  return { note: r.note, midi };
}

/** 度数ラベル（1, b3, #11, bb7 など） */
export function degreeLabel(degree: number, semis: number): string {
  const diff = semis - DEGREE_BASE[degree];
  return accString(diff) + degree;
}

const SOLFEGE = ["ド", "レ", "ミ", "ファ", "ソ", "ラ", "シ"];

/** 音名（"Ab", "F#4", "Bbb" など）をドレミ（固定ド）に。"ラ♭" "ファ♯" */
export function solfegeOf(name: string): string {
  const r = readNoteName(name);
  if (!r) return "";
  const acc = r.note.acc;
  const mark = acc > 0 ? "♯".repeat(acc) : acc < 0 ? "♭".repeat(-acc) : "";
  return SOLFEGE[r.note.letter] + mark;
}

export const MIDI_MIN = 21; // A0
export const MIDI_MAX = 108; // C8
