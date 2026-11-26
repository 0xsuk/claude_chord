// コード名の表記を一つの規則にそろえる。
// 入力がどう書かれていても（maj7, △7, M7 ...）、構成音から組み立て直して同じ表記にする。
// Claude側の表示も MIDI側の推定結果も、すべてこの関数を通す。
//
// 規則（日本のコード譜で一般的な書き方）
//   メジャー7th: M7, M9, M13     マイナー: m, m7, m9 ...   マイナーメジャー7th: mM7
//   ハーフディミニッシュ: m7(b5)  ディミニッシュ: dim, dim7  オーギュメント: aug, aug7, augM7
//   サス: sus4, sus2, 7sus4      シックス: 6, m6, 6(9), m6(9)
//   7th なしのテンション: add9, add11 ...（変化テンションは (b9) のようにカッコ）
//   7th ありのテンション: 自然な 9/11/13 は数字に吸収（9, 11, 13）、残りはカッコ: 7(b9,13)
//   省略: (omit3) (omit5)        オンコード: /E
import { nameOf, type Spelled } from "./notes.ts";

interface Labeled {
  label: string;
}

export function formatChordName(root: Spelled, tones: Labeled[], bass: Spelled | null): string {
  return nameOf(root) + chordSuffix(tones) + (bass ? "/" + nameOf(bass) : "");
}

export function chordSuffix(tones: Labeled[]): string {
  const L = new Set(tones.map((t) => t.label));
  const has = (l: string) => L.has(l);

  // パワーコード
  if (L.size === 2 && has("1") && has("5")) return "5";

  const third = has("3") ? "M" : has("b3") ? "m" : null;
  const sus4 = has("4");
  const sus2 = has("2");
  const fifth = has("5") ? "P" : has("b5") ? "d" : has("#5") ? "A" : null;
  const seventh = has("7") ? "M" : has("b7") ? "m" : has("bb7") ? "d" : null;
  const six = has("6");

  let quality = "";
  let fifthShown = false; // 5度の変化を quality で表したか
  let usedSeventh = false;

  // ---- 基本の性格 ----
  if (third === "m" && fifth === "d" && seventh === "d") {
    quality = "dim7";
    fifthShown = true;
    usedSeventh = true;
  } else if (third === "m" && fifth === "d" && seventh === null && !six) {
    quality = "dim";
    fifthShown = true;
  } else if (third === "m" && fifth === "d" && seventh === "M") {
    quality = "dimM7";
    fifthShown = true;
    usedSeventh = true;
  } else if (third === "M" && fifth === "A" && (seventh === null || seventh === "m" || seventh === "M") && !six) {
    quality = "aug";
    fifthShown = true;
  } else if (third === "m") {
    quality = "m";
  }

  // ---- 7th と自然テンションの吸収（9 → 11 → 13） ----
  const absorbed = new Set<string>();
  let num = "";
  if (seventh && !usedSeventh) {
    let n = 7;
    if (has("9")) {
      n = 9;
      absorbed.add("9");
      if (has("11")) {
        n = 11;
        absorbed.add("11");
      }
      if (has("13")) {
        n = 13;
        absorbed.add("13");
      }
    }
    num = (seventh === "M" ? "M" : "") + n;
    usedSeventh = true;
  }

  // m7(b5) はハーフディミニッシュとして b5 をカッコに出す
  let suffix = quality;
  if (quality === "m" && seventh === "M") suffix = "mM" + num.slice(1);
  else suffix += num;

  // シックス
  if (six && !usedSeventh) suffix += "6"; // 6(9) の 9 は下のカッコ処理で付く

  // サス（3度がないとき）
  let susText = "";
  if (!third) {
    if (sus4) susText = "sus4";
    else if (sus2) susText = "sus2";
  }

  // ---- カッコに入るもの ----
  const paren: string[] = [];
  const adds: string[] = [];
  if (!fifthShown) {
    if (fifth === "d") paren.push("b5");
    if (fifth === "A") paren.push("#5");
  }
  if (!third && sus4 && sus2) adds.push("add2");
  if (third && sus2) adds.push("add2");
  if (third && sus4) adds.push("add4");

  const tensionOrder = ["b9", "9", "#9", "11", "#11", "b13", "13"];
  for (const t of tensionOrder) {
    if (!has(t) || absorbed.has(t)) continue;
    const natural = !t.startsWith("b") && !t.startsWith("#");
    if (!usedSeventh && natural && !six) adds.push("add" + t);
    else paren.push(t);
  }

  // 省略。ドミナント11th（3度なしが慣例）と sus は omit3 を書かない
  const dom11 = seventh === "m" && absorbed.has("11") && !third;
  if (!third && !susText && !dom11) paren.push("omit3");
  if (!fifth) paren.push("omit5");

  // 7th なしの add は「add9」のように直接つなぐ。他にカッコがあれば中に入れる
  let out = suffix + susText;
  if (adds.length && paren.length === 0 && adds.length === 1) {
    out += adds[0];
  } else {
    paren.unshift(...adds);
  }
  if (paren.length) out += `(${paren.join(",")})`;
  return out;
}
