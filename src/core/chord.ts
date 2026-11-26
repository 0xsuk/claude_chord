// コード名のパーサ。コード名 → 構成音（度数・綴り）を返す。
import {
  type Spelled, degreeLabel, nameOf, pcOf, readNoteName, spellInterval,
} from "./notes.ts";
import { formatChordName } from "./name.ts";

export interface Tone {
  degree: number; // 1,2,3,4,5,6,7,9,11,13
  semis: number; // ルートからの半音数
  label: string; // "1" "b3" "#11" など
  note: Spelled;
  name: string; // 綴られた音名（Eb, F# など）
  pc: number;
}

export interface Chord {
  input: string;
  symbol: string; // 正規化後の入力表記
  name: string; // 統一表記（formatChordName）。表示にはこちらを使う
  root: Spelled;
  rootName: string;
  bass: Spelled | null; // オンコードの分母（ルートと同じなら null）
  bassName: string | null;
  tones: Tone[]; // 度数順
  notes: string[]; // 補足（「慣例により3度を省略」など）
}

export type ParseResult = { ok: true; chord: Chord } | { ok: false; error: string };

type Third = "M" | "m" | "sus2" | "sus4" | "sus24";
type Fifth = "P" | "d" | "A";
type Seventh = null | "m" | "M" | "d";

interface Iv { degree: number; semis: number }

/** 表記ゆれを正規化する。全角、♯♭、△、ø、°、on表記など */
export function normalizeInput(raw: string): string {
  let s = raw.normalize("NFKC").trim();
  s = s
    .replace(/[♯]/g, "#")
    .replace(/[♭]/g, "b")
    .replace(/[𝄪]/g, "##")
    .replace(/[𝄫]/g, "bb")
    .replace(/[△Δ∆]/g, "^")
    .replace(/[Ø∅]/g, "ø")
    .replace(/[°º˚]/g, "o")
    .replace(/[−–—]/g, "-")
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/[、，]/g, ",");
  // 「C on E」「ConE」→「C/E」
  s = s.replace(/\s*on\s*(?=[A-G](?:##|bb|#|b)?\s*$)/, "/");
  s = s.replace(/\s+/g, "");
  return s;
}

const ALT_DEGREES = new Set([5, 6, 9, 11, 13]);

export function parseChord(raw: string): ParseResult {
  const s = normalizeInput(raw);
  if (!s) return { ok: false, error: "空の入力" };

  const r = readNoteName(s);
  if (!r || !/[A-G]/.test(s[0])) {
    return { ok: false, error: `ルート音が読めない: "${s}"（A〜Gの大文字で始める）` };
  }
  const root = r.note;
  let body = s.slice(r.length);

  // オンコード（分母）。6/9 の /9 とは区別する
  let bass: Spelled | null = null;
  const slash = /\/([A-Ga-g](?:##|bb|x|#|b)?)$/.exec(body);
  if (slash) {
    const b = readNoteName(slash[1]);
    if (!b || b.length !== slash[1].length) return { ok: false, error: `分母の音が読めない: "${slash[1]}"` };
    bass = b.note;
    body = body.slice(0, slash.index);
  }

  let third: Third = "M";
  let fifth: Fifth = "P";
  let seventh: Seventh = null;
  let ext = 0; // 7, 9, 11, 13
  let six = false;
  let power = false;
  let majMarker = false;
  let caretAlone = false;
  const adds: Iv[] = [];
  const alts: Iv[] = [];
  const omits = new Set<number>();
  const notes: string[] = [];

  let i = 0;
  let consumed = 0; // 品質部分で何トークン読んだか
  let inParen = 0;
  const err = (msg: string): ParseResult => ({
    ok: false,
    error: `${msg}: "${s}" の ${r.length + i + 1} 文字目付近（"${body.slice(i)}"）`,
  });

  const take = (re: RegExp): RegExpExecArray | null => {
    re.lastIndex = 0;
    const m = re.exec(body.slice(i));
    if (m && m.index === 0) {
      i += m[0].length;
      return m;
    }
    return null;
  };

  const setExt = (n: number) => {
    ext = Math.max(ext, n);
    if (seventh === null) seventh = majMarker ? "M" : "m";
  };

  while (i < body.length) {
    const atStart = consumed === 0;
    let m: RegExpExecArray | null;

    if (take(/^[(),]/)) {
      const c = body[i - 1];
      if (c === "(") inParen++;
      if (c === ")") inParen--;
      continue;
    }

    // maj 系（maj, Maj, MAJ, ma, M, ^, j）
    if ((m = take(/^(maj|Maj|MAJ|ma|M|\^|j)(?=\d|$|[(),]|add|sus|#|b|\+|-|alt|omit|no)/))) {
      majMarker = true;
      const num = take(/^(13|11|9|7)/);
      if (num) {
        ext = Math.max(ext, parseInt(num[0], 10));
        seventh = "M";
      } else if (m[1] === "^") {
        caretAlone = true;
      } else if (consumed > 0 && seventh === null) {
        // mM, m(maj) のように maj が単独で付いたら maj7
        seventh = "M";
        ext = Math.max(ext, 7);
      }
      consumed++;
      continue;
    }

    // マイナー（m, min, mi, 先頭の -）
    if (atStart && take(/^(min|mi|m(?!aj))/)) {
      third = "m";
      consumed++;
      continue;
    }
    // 先頭の - はマイナー（C-7）。ただし C-5 は b5
    if (atStart && take(/^-(?!5)/)) {
      third = "m";
      consumed++;
      continue;
    }

    // ハーフディミニッシュ
    if ((m = take(/^(ø|h)/))) {
      third = "m";
      fifth = "d";
      seventh = "m";
      ext = Math.max(ext, 7);
      const num = take(/^(13|11|9|7)/);
      if (num) ext = Math.max(ext, parseInt(num[0], 10));
      consumed++;
      continue;
    }

    // ディミニッシュ
    if (atStart && (m = take(/^(dim|o(?!mit))/))) {
      third = "m";
      fifth = "d";
      if (take(/^7/)) {
        seventh = "d";
        ext = 7;
      }
      consumed++;
      continue;
    }

    // オーギュメント
    if ((atStart && take(/^(aug|\+(?![0-9]))/)) || take(/^\+$/)) {
      fifth = "A";
      consumed++;
      continue;
    }
    if (atStart && take(/^\+(?=7|9|11|13)/)) {
      // C+7 = aug7
      fifth = "A";
      consumed++;
      continue;
    }

    // sus
    if (take(/^sus/)) {
      const n = take(/^(24|42|2|4)/);
      third = !n || n[0] === "4" ? "sus4" : n[0] === "2" ? "sus2" : "sus24";
      consumed++;
      continue;
    }

    // add
    if ((m = take(/^add(##|bb|#|b|\+|-)?(13|11|9|6|4|2)/))) {
      const deg = parseInt(m[2], 10);
      adds.push(alterIv(deg, m[1] ?? ""));
      consumed++;
      continue;
    }

    // omit / no
    if ((m = take(/^(omit|no)(1|3|5)(st|rd|th)?/))) {
      omits.add(parseInt(m[2], 10));
      consumed++;
      continue;
    }

    // alt
    if (take(/^alt/)) {
      setExt(7);
      seventh = "m";
      alts.push({ degree: 9, semis: 13 }, { degree: 9, semis: 15 }, { degree: 13, semis: 20 });
      omits.add(5);
      notes.push("alt は 7(b9,#9,b13) として扱い、5度を省略");
      consumed++;
      continue;
    }

    // 変化テンション（b9, #11, -5, +5 など）
    if ((m = take(/^(##|bb|#|b|\+|-)(13|11|9|6|5)/))) {
      const deg = parseInt(m[2], 10);
      if (!ALT_DEGREES.has(deg)) return err("変化記号のつけられない度数");
      const iv = alterIv(deg, m[1]);
      if (deg === 5) {
        fifth = iv.semis === 6 ? "d" : iv.semis === 8 ? "A" : "P";
      } else {
        alts.push(iv);
      }
      consumed++;
      continue;
    }

    // 数字
    if ((m = take(/^(6\/9|69|13|11|9|7|6|5|4|2)/))) {
      const t = m[0];
      if (t === "6/9" || t === "69") {
        six = true;
        adds.push({ degree: 9, semis: 14 });
      } else if (t === "6") {
        if (inParen || ext) adds.push({ degree: 13, semis: 21 });
        else six = true;
      } else if (t === "5") {
        if (atStart) power = true;
        else return err("5 の位置がおかしい（b5 / #5 のつもりなら記号をつける）");
      } else if (t === "2") {
        adds.push({ degree: 2, semis: 2 });
      } else if (t === "4") {
        if (inParen || ext) adds.push({ degree: 11, semis: 17 });
        else third = "sus4";
      } else {
        const n = parseInt(t, 10);
        if (inParen || (ext && n > 7)) {
          // C7(9,13) や C79 のようなテンションの追加
          adds.push({ degree: n, semis: n === 7 ? 10 : n === 9 ? 14 : n === 11 ? 17 : 21 });
        } else {
          setExt(n);
        }
      }
      consumed++;
      continue;
    }

    return err("読めない表記");
  }
  if (inParen !== 0) return { ok: false, error: `括弧が閉じていない: "${s}"` };

  if (caretAlone && seventh === null) {
    seventh = "M";
    ext = Math.max(ext, 7);
  }

  // ---- 構成音を組み立てる ----
  const ivs = new Map<string, Iv>();
  const put = (iv: Iv) => ivs.set(`${iv.degree}:${iv.semis}`, iv);
  const removeDegree = (deg: number) => {
    for (const k of [...ivs.keys()]) if (ivs.get(k)!.degree === deg) ivs.delete(k);
  };

  put({ degree: 1, semis: 0 });
  if (power) {
    put({ degree: 5, semis: 7 });
  } else {
    if (third === "M") put({ degree: 3, semis: 4 });
    if (third === "m") put({ degree: 3, semis: 3 });
    if (third === "sus2" || third === "sus24") put({ degree: 2, semis: 2 });
    if (third === "sus4" || third === "sus24") put({ degree: 4, semis: 5 });
    put({ degree: 5, semis: fifth === "P" ? 7 : fifth === "d" ? 6 : 8 });
    if (six) put({ degree: 6, semis: 9 });
    if (seventh) put({ degree: 7, semis: seventh === "m" ? 10 : seventh === "M" ? 11 : 9 });
    if (ext >= 9) put({ degree: 9, semis: 14 });
    if (ext >= 11) {
      const minorLike = third === "m";
      if (ext === 11 || minorLike) put({ degree: 11, semis: 17 });
      if (ext === 11 && third === "M" && seventh === "m") {
        removeDegree(3);
        notes.push("ドミナント11thは慣例により3度を省略（11度とぶつかるため）");
      }
      if (ext === 13 && !minorLike) notes.push("13thコードは慣例により11度を省略");
    }
    if (ext >= 13) put({ degree: 13, semis: 21 });
  }

  // 変化テンションは同じ度数のナチュラルを置き換える
  for (const a of alts) {
    for (const k of [...ivs.keys()]) {
      const iv = ivs.get(k)!;
      if (iv.degree === a.degree && iv.semis !== a.semis && !alts.some((x) => x.semis === iv.semis && x.degree === iv.degree)) {
        ivs.delete(k);
      }
    }
    put(a);
  }
  // #11 があるときに b5 と重複させない、b13 と #5 も同様（綴りは書かれた方を優先）
  for (const a of adds) put(a);

  for (const o of omits) removeDegree(o);
  if (omits.has(3) && third !== "M" && third !== "m") {
    // sus の omit3 は意味がないが、エラーにはしない
  }

  const tones: Tone[] = [...ivs.values()]
    .sort((a, b) => a.semis - b.semis || a.degree - b.degree)
    .map((iv) => {
      const note = spellInterval(root, iv.degree, iv.semis);
      return {
        degree: iv.degree,
        semis: iv.semis,
        label: degreeLabel(iv.degree, iv.semis),
        note,
        name: nameOf(note),
        pc: pcOf(note),
      };
    });

  // 同じピッチクラスが重複したら後のものを捨てる（例: C7#5b13 のような書き方）
  const seen = new Set<number>();
  const uniq = tones.filter((t) => (seen.has(t.pc) ? false : (seen.add(t.pc), true)));

  const bassSame = bass && pcOf(bass) === pcOf(root) && bass.letter === root.letter;
  const bassFinal = bassSame ? null : bass;
  return {
    ok: true,
    chord: {
      input: raw,
      symbol: s.replace(/\^/g, "△"),
      root,
      rootName: nameOf(root),
      name: formatChordName(root, uniq, bassFinal),
      bass: bassFinal,
      bassName: bassSame || !bass ? null : nameOf(bass),
      tones: uniq,
      notes,
    },
  };
}

function alterIv(degree: number, sign: string): Iv {
  const base: Record<number, number> = { 2: 2, 4: 5, 5: 7, 6: 9, 9: 14, 11: 17, 13: 21 };
  const d = sign === "#" || sign === "+" ? 1 : sign === "##" ? 2 : sign === "b" || sign === "-" ? -1 : sign === "bb" ? -2 : 0;
  return { degree, semis: base[degree] + d };
}
