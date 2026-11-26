#!/usr/bin/env bash
# MIDIキーボードがLinux側から見えているかを確認する。
# 使い方:
#   scripts/midi-check.sh            # 認識状態だけ確認
#   scripts/midi-check.sh --listen 10  # 加えて10秒間イベントを受信して表示する（その間に鍵盤を弾いてもらう）
set -u

listen_sec=0
if [ "${1:-}" = "--listen" ]; then
  listen_sec="${2:-10}"
fi

ok() { echo "[OK]   $*"; }
ng() { echo "[NG]   $*"; }
info() { echo "[INFO] $*"; }

# 1. USB MIDIインターフェイス（class 01 / subclass 03）がつながっているか
midi_usb=""
for intf in /sys/bus/usb/devices/*:*; do
  [ -r "$intf/bInterfaceClass" ] || continue
  if [ "$(cat "$intf/bInterfaceClass")" = "01" ] && [ "$(cat "$intf/bInterfaceSubClass")" = "03" ]; then
    dev="${intf%:*}"
    name="$(cat "$dev/manufacturer" 2>/dev/null) $(cat "$dev/product" 2>/dev/null)"
    midi_usb="$midi_usb\n  $(basename "$dev"): $name"
  fi
done
if [ -n "$midi_usb" ]; then
  ok "USB MIDIデバイスあり:$(echo -e "$midi_usb")"
else
  ng "USB MIDIデバイスが見つからない（未接続、ケーブルが充電専用、またはクラスコンプライアントでない機種）"
fi

# 2. ドライバ
if lsmod | grep -q '^snd_usb_audio'; then
  ok "snd_usb_audio ロード済み"
else
  ng "snd_usb_audio 未ロード（デバイスを挿すと通常は自動でロードされる。手動なら: sudo modprobe snd-usb-audio）"
fi

# 3. ALSA rawmidi ポート
ports="$(amidi -l 2>/dev/null | tail -n +2)"
if [ -n "$ports" ]; then
  ok "rawmidiポート:"; echo "$ports" | sed 's/^/  /'
else
  ng "amidi -l にポートが出ない"
fi

# 4. ALSA sequencer のクライアント（ブラウザのWeb MIDIはここを見る）
seq_clients="$(aconnect -i 2>/dev/null | grep '^client' | grep -v -E "'System'|'Midi Through'")"
if [ -n "$seq_clients" ]; then
  ok "sequencer入力クライアント:"; echo "$seq_clients" | sed 's/^/  /'
else
  ng "sequencerに入力クライアントがない"
fi

# 5. 権限
if [ -r /dev/snd/seq ] && [ -w /dev/snd/seq ]; then
  ok "/dev/snd/seq を読み書きできる"
else
  ng "/dev/snd/seq に権限がない（sudo usermod -aG audio \$USER のあと再ログイン）"
fi

# 6. 実際にイベントが来るか
if [ "$listen_sec" -gt 0 ]; then
  port="$(echo "$seq_clients" | head -1 | sed -E 's/^client ([0-9]+):.*/\1:0/')"
  if [ -z "$port" ]; then
    ng "受信するポートがないので listen をスキップ"
    exit 1
  fi
  info "${listen_sec}秒間 $port を受信する。鍵盤とペダルを触ってもらう"
  out="$(timeout "$listen_sec" aseqdump -p "$port" 2>&1)"
  echo "$out" | sed 's/^/  /' | head -40
  if echo "$out" | grep -q 'Note on'; then
    ok "Note on を受信できた"
  else
    ng "Note on が来なかった"
  fi
  if echo "$out" | grep -q 'controller 64'; then
    ok "サステインペダル(CC64)を受信できた"
  else
    info "CC64は来なかった（ペダルを踏んでいないか、未接続）"
  fi
fi
