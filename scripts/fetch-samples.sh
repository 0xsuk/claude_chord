#!/usr/bin/env bash
# ピアノ音源（Salamander Grand Piano、Tone.js配布版）を public/samples に落とす。
# 落とさなくても動く（そのときはネットから直接読む）。オフラインで使いたいときに実行する。
set -eu
cd "$(dirname "$0")/.."
mkdir -p public/samples
base="https://tonejs.github.io/audio/salamander"
names="A0"
for o in 1 2 3 4 5 6 7; do names="$names C$o Ds$o Fs$o A$o"; done
names="$names C8"
for n in $names; do
  f="public/samples/$n.mp3"
  [ -s "$f" ] && continue
  curl -fsSL "$base/$n.mp3" -o "$f"
done
echo "done: $(ls public/samples | wc -l) files"
