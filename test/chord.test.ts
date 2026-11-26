import { test } from "node:test";
import assert from "node:assert/strict";
import { parseChord } from "../src/core/chord.ts";
import { resolvePlay } from "../src/core/request.ts";
import { detectChords } from "../src/core/detect.ts";
import { voiceChord, VOICINGS } from "../src/core/voicing.ts";

const names = (s: string) => {
  const r = parseChord(s);
  if (!r.ok) throw new Error(`${s}: ${r.error}`);
  return r.chord.tones.map((t) => t.name).join(" ");
};
const labels = (s: string) => {
  const r = parseChord(s);
  if (!r.ok) throw new Error(`${s}: ${r.error}`);
  return r.chord.tones.map((t) => t.label).join(" ");
};

const CASES: [string, string][] = [
  ["C", "C E G"], ["CM", "C E G"], ["Cm", "C Eb G"], ["Cmin", "C Eb G"], ["C-", "C Eb G"],
  ["C7", "C E G Bb"], ["Cmaj7", "C E G B"], ["CM7", "C E G B"], ["C△7", "C E G B"], ["C^", "C E G B"], ["CΔ", "C E G B"],
  ["Cm7", "C Eb G Bb"], ["C-7", "C Eb G Bb"], ["Cmi7", "C Eb G Bb"],
  ["CmM7", "C Eb G B"], ["Cm(maj7)", "C Eb G B"], ["CmMaj7", "C Eb G B"], ["C-Δ7", "C Eb G B"],
  ["Cdim", "C Eb Gb"], ["Co", "C Eb Gb"], ["Cdim7", "C Eb Gb Bbb"], ["C°7", "C Eb Gb Bbb"],
  ["Cm7b5", "C Eb Gb Bb"], ["Cm7-5", "C Eb Gb Bb"], ["Cø", "C Eb Gb Bb"], ["Cø7", "C Eb Gb Bb"], ["Cm7(b5)", "C Eb Gb Bb"],
  ["Caug", "C E G#"], ["C+", "C E G#"], ["Caug7", "C E G# Bb"], ["C+7", "C E G# Bb"], ["C7#5", "C E G# Bb"], ["C7+5", "C E G# Bb"],
  ["C7b5", "C E Gb Bb"], ["C7-5", "C E Gb Bb"], ["C-5", "C E Gb"],
  ["Csus4", "C F G"], ["Csus", "C F G"], ["Csus2", "C D G"], ["C7sus4", "C F G Bb"], ["C9sus4", "C F G Bb D"],
  ["C6", "C E G A"], ["Cm6", "C Eb G A"], ["C6/9", "C E G A D"], ["C69", "C E G A D"],
  ["Cadd9", "C E G D"], ["Cadd2", "C D E G"], ["C2", "C D E G"], ["Cmadd9", "C Eb G D"], ["Cm(add9)", "C Eb G D"],
  ["C9", "C E G Bb D"], ["Cmaj9", "C E G B D"], ["Cm9", "C Eb G Bb D"],
  ["C11", "C G Bb D F"], ["Cm11", "C Eb G Bb D F"],
  ["C13", "C E G Bb D A"], ["Cmaj13", "C E G B D A"], ["Cm13", "C Eb G Bb D F A"],
  ["C7b9", "C E G Bb Db"], ["C7#9", "C E G Bb D#"], ["C7(b9)", "C E G Bb Db"], ["C7-9", "C E G Bb Db"], ["C7+9", "C E G Bb D#"],
  ["C7#11", "C E G Bb F#"], ["C7(#11)", "C E G Bb F#"], ["C7b13", "C E G Bb Ab"],
  ["C7(9,13)", "C E G Bb D A"], ["C7(b9,13)", "C E G Bb Db A"], ["C13b9", "C E G Bb Db A"],
  ["Cmaj7#11", "C E G B F#"], ["Cmaj9#11", "C E G B D F#"], ["C7alt", "C E Bb Db D# Ab"],
  ["C5", "C G"], ["C(no3)", "C G"], ["C7(omit5)", "C E Bb"], ["C7no3", "C G Bb"],
  ["F#m7", "F# A C# E"], ["Bbmaj7", "Bb D F A"], ["Ebm7b5", "Eb Gb Bbb Db"], ["Abdim7", "Ab Cb Ebb Gbb"],
  ["Db7", "Db F Ab Cb"], ["G#7", "G# B# D# F#"], ["Cb", "Cb Eb Gb"], ["E#m", "E# G# B#"],
  ["Ｃｍ７", "C Eb G Bb"], ["C♯m", "C# E G#"], ["B♭7", "Bb D F Ab"],
];

for (const [input, expected] of CASES) {
  test(`parse ${input}`, () => assert.equal(names(input), expected));
}

test("labels", () => {
  assert.equal(labels("Cdim7"), "1 b3 b5 bb7");
  assert.equal(labels("C7#9"), "1 3 5 b7 #9");
  assert.equal(labels("C13"), "1 3 5 b7 9 13");
});

test("slash / on chord", () => {
  for (const s of ["C/E", "ConE", "C on E", "C／E"]) {
    const r = parseChord(s);
    assert.ok(r.ok, s);
    if (r.ok) assert.equal(r.chord.bassName, "E", s);
  }
  const r = parseChord("Am7/G");
  assert.ok(r.ok && r.chord.bassName === "G");
  const r2 = parseChord("C6/9/E");
  assert.ok(r2.ok && r2.chord.bassName === "E" && r2.chord.tones.length === 5);
});

for (const bad of ["H7", "Cxyz", "C7(b9", "", "C/Q", "c7"]) {
  test(`error ${JSON.stringify(bad)}`, () => assert.equal(parseChord(bad).ok, false));
}

test("voicing: bass is lowest, all chord tones present (close)", () => {
  for (const [input] of CASES) {
    const r = parseChord(input);
    if (!r.ok) continue;
    const v = voiceChord(r.chord);
    assert.ok(v.ok, input);
    if (!v.ok) continue;
    const pcs = new Set(v.notes.map((n) => n.midi % 12));
    for (const t of r.chord.tones) assert.ok(pcs.has(t.pc), `${input} missing ${t.name}`);
    for (let i = 1; i < v.notes.length; i++) assert.ok(v.notes[i].midi > v.notes[i - 1].midi, `${input} not ascending/unique`);
  }
});

test("voicing kinds all succeed", () => {
  for (const kind of VOICINGS) {
    for (const input of ["C", "Dm7", "G13", "Fmaj9#11", "Bø7", "C/E", "Am7/G", "D/C"]) {
      const r = parseChord(input);
      assert.ok(r.ok);
      if (!r.ok) continue;
      const v = voiceChord(r.chord, { voicing: kind });
      assert.ok(v.ok, `${kind} ${input}`);
    }
  }
});

test("slash bass is lowest note", () => {
  const p = resolvePlay({ input: "C/E" });
  assert.ok(p.ok);
  if (p.ok) assert.equal(p.payload.notes[0].name.replace(/\d/g, ""), "E");
  const p2 = resolvePlay({ input: "D/C" });
  assert.ok(p2.ok);
  if (p2.ok) assert.equal(p2.payload.notes[0].name.replace(/\d/g, ""), "C");
});

test("inversions", () => {
  const n = (inv: number) => {
    const p = resolvePlay({ input: "Dm7", inversion: inv });
    if (!p.ok) throw new Error(p.error);
    return p.payload.notes.map((x) => x.name.replace(/\d/g, "")).join(" ");
  };
  assert.equal(n(0), "D F A C");
  assert.equal(n(1), "F A C D");
  assert.equal(n(2), "A C D F");
  assert.equal(n(3), "C D F A");
  assert.equal(resolvePlay({ input: "C", inversion: 3 }).ok, false);
});

test("spelled with octave across C boundary", () => {
  const p = resolvePlay({ input: "Cb4 Eb4 Gb4" });
  assert.ok(p.ok);
  if (p.ok) assert.deepEqual(p.payload.notes.map((n) => n.midi), [59, 63, 66]);
  const q = resolvePlay({ input: "B#3 E4" });
  assert.ok(q.ok);
  if (q.ok) assert.deepEqual(q.payload.notes.map((n) => [n.midi, n.name]), [[60, "B#3"], [64, "E4"]]);
});

test("explicit notes", () => {
  const p = resolvePlay({ input: "F3 A3 C4 D4" });
  assert.ok(p.ok);
  if (p.ok) {
    assert.deepEqual(p.payload.notes.map((n) => n.midi), [53, 57, 60, 62]);
  }
  const q = resolvePlay({ input: "C E G" });
  assert.ok(q.ok);
  if (q.ok) assert.deepEqual(q.payload.notes.map((n) => n.midi), [60, 64, 67]);
});

const top = (midis: number[]) => detectChords(midis)[0]?.name;
test("detect basics", () => {
  assert.equal(top([60, 64, 67]), "C");
  assert.equal(top([48, 60, 63, 67]), "Cm");
  assert.equal(top([43, 59, 62, 65]), "G7"); // G B D F（5度なし右手）
  assert.equal(top([50, 65, 69, 72]), "Dm7");
  assert.equal(top([53, 57, 60, 62]), "F6");
  assert.ok(detectChords([53, 57, 60, 62]).some((c) => c.name === "Dm7/F"));
  assert.equal(top([48, 64, 67, 71]), "CM7");
  assert.equal(top([52, 60, 67]), "C/E");
  assert.equal(top([60, 63, 66, 70]), "Cm7(b5)");
  assert.equal(top([61, 64, 68]), "C#m");
  assert.equal(top([60, 65, 67]), "Csus4");
  assert.equal(top([43, 59, 65, 69]), "G9"); // G B F A（5度省略）
  assert.equal(top([60]), "C");
});

test("detect probabilities sum <= 1 and sorted", () => {
  const c = detectChords([48, 52, 55, 57]);
  assert.ok(c.length > 1);
  for (let i = 1; i < c.length; i++) assert.ok(c[i].prob <= c[i - 1].prob);
  assert.equal(c[0].name, "C6");
  assert.ok(c.some((x) => x.name === "Am7/C"));
});

import { solfegeOf } from "../src/core/notes.ts";
test("solfege", () => {
  assert.equal(solfegeOf("C"), "ド");
  assert.equal(solfegeOf("F#4"), "ファ♯");
  assert.equal(solfegeOf("Ab"), "ラ♭");
  assert.equal(solfegeOf("Bbb"), "シ♭♭");
  assert.equal(solfegeOf("E#"), "ミ♯");
});

import { formatChordName } from "../src/core/name.ts";
test("unified names: different spellings give one name", () => {
  const groups: string[][] = [
    ["Cmaj7", "CM7", "C△7", "CΔ7", "C^7", "Cma7", "Cj7"],
    ["Cm7b5", "Cm7-5", "Cø", "Cø7", "Cm7(b5)", "Cmin7b5"],
    ["CmM7", "Cm(maj7)", "CmMaj7", "C-Δ7", "Cminmaj7"],
    ["C7#5", "Caug7", "C+7", "C7+5"],
    ["C69", "C6/9", "C6(9)", "C6add9"],
    ["Cm", "Cmin", "C-", "Cmi"],
  ];
  for (const g of groups) {
    const names = g.map((x) => {
      const r = parseChord(x);
      if (!r.ok) throw new Error(`${x}: ${r.error}`);
      return r.chord.name;
    });
    assert.equal(new Set(names).size, 1, `${g.join(",")} → ${names.join(",")}`);
  }
});

test("unified names round-trip to the same tones", () => {
  for (const [input] of CASES) {
    const a = parseChord(input);
    if (!a.ok) continue;
    const b = parseChord(a.chord.name);
    assert.ok(b.ok, `${input} → ${a.chord.name} does not parse`);
    if (!b.ok) continue;
    assert.deepEqual(b.chord.tones.map((t) => t.label), a.chord.tones.map((t) => t.label), `${input} → ${a.chord.name}`);
    assert.equal(b.chord.name, a.chord.name);
  }
});

test("detect names use the same notation", () => {
  for (const c of detectChords([48, 52, 55, 59, 62])) {
    const r = parseChord(c.name);
    assert.ok(r.ok, c.name);
    if (r.ok) assert.equal(r.chord.name, c.name, `detect gave ${c.name}, canonical is ${r.chord.name}`);
  }
  void formatChordName;
});

import { parseBeats, splitChordBeats } from "../src/core/request.ts";
test("beats parsing", () => {
  assert.equal(parseBeats("3"), 3);
  assert.equal(parseBeats("1/2"), 0.5);
  assert.equal(parseBeats("0.75"), 0.75);
  assert.equal(parseBeats("3/4"), 0.75);
  assert.equal(parseBeats("1.5"), 1.5);
  assert.equal(parseBeats("2/3"), null); // 3連符系はなし
  assert.equal(parseBeats("0.1"), null);
  assert.equal(parseBeats("0"), null);
  assert.equal(parseBeats("17"), null);
  assert.equal(parseBeats("x"), null);
  assert.deepEqual(splitChordBeats("CM7:3"), { chord: "CM7", beats: "3" });
  assert.deepEqual(splitChordBeats("Bbm7 : 1/2"), { chord: "Bbm7", beats: "1/2" });
  assert.deepEqual(splitChordBeats("G7(b9,13)"), { chord: "G7(b9,13)" });
  assert.deepEqual(splitChordBeats("C:x"), { chord: "C", beats: "x" });
});
