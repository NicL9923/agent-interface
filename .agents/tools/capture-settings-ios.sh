#!/bin/bash
# Capture already-built Debug settings and discovery pages using the installed simulator runtime.
set -euo pipefail
if [[ $# -lt 4 ]]; then
  echo 'Usage: capture-settings-ios.sh APP_PATH SIMULATOR_UUID OUTPUT_DIR TAB [TAB...]' >&2
  exit 2
fi
if [[ "${WILDBOTS_SETTINGS_CAPTURE_LOCKED:-}" != 1 ]]; then
  exec "$HOME/.agents/tools/mac-heavy-lock.sh" env WILDBOTS_SETTINGS_CAPTURE_LOCKED=1 bash "$0" "$@"
fi
app=$1
simulator=$2
output=$3
shift 3
simctl=/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/Resources/bin/simctl
bundle=$(/usr/bin/plutil -extract CFBundleIdentifier raw "$app/Info.plist")
mkdir -p "$output"
"$simctl" shutdown all >/dev/null 2>&1 || true
capture_tmp="$HOME/Library/Developer/CoreSimulator/Devices/$simulator/data/tmp/wildbots-settings-$$.png"
trap 'rm -f "$capture_tmp"; "$simctl" shutdown "$simulator" >/dev/null 2>&1 || true' EXIT
"$simctl" boot "$simulator"
"$simctl" bootstatus "$simulator" -b
"$simctl" ui "$simulator" appearance light
"$simctl" install "$simulator" "$app"
for tab in "$@"; do
  settings_tab=$tab
  discovery_tab=""
  group_capture=0
  preferences_capture=0
  computer_capture=0
  capture_delay=${NATIVE_CAPTURE_DELAY:-5}
  case "$tab" in
    Preferences) settings_tab=""; preferences_capture=1 ;;
    Computer) settings_tab=""; computer_capture=1; capture_delay=${NATIVE_CAPTURE_DELAY:-10} ;;
    Groups) settings_tab=""; group_capture=1; capture_delay=${NATIVE_CAPTURE_DELAY:-12} ;;
    Search) settings_tab=""; discovery_tab=search ;;
    History) settings_tab=""; discovery_tab=history ;;
    Saved) settings_tab=""; discovery_tab=saved ;;
    Automations) settings_tab=""; discovery_tab=automations ;;
    Details|Avatar|Connections|Tools|Skills|Routines|Work|Learning|Memory|Logins) ;;
    *) echo "Unknown capture page: $tab" >&2; exit 2 ;;
  esac
  SIMCTL_CHILD_AGENT_INTERFACE_UI_FIXTURE=1 \
  SIMCTL_CHILD_AGENT_INTERFACE_UI_AUTOMATION=1 \
  SIMCTL_CHILD_AGENT_INTERFACE_UI_GROUP="$group_capture" \
  SIMCTL_CHILD_AGENT_INTERFACE_UI_CAPTURE_GROUP="$group_capture" \
  SIMCTL_CHILD_AGENT_INTERFACE_UI_CAPTURE_PREFERENCES="$preferences_capture" \
  SIMCTL_CHILD_AGENT_INTERFACE_UI_CAPTURE_COMPUTER="$computer_capture" \
  SIMCTL_CHILD_AGENT_INTERFACE_UI_CAPTURE_SETTINGS_TAB="$settings_tab" \
  SIMCTL_CHILD_AGENT_INTERFACE_UI_CAPTURE_DISCOVERY_TAB="$discovery_tab" \
    "$simctl" launch --terminate-running-process "$simulator" "$bundle"
  sleep "$capture_delay"
  # CoreSimulator cannot write directly to the external volume. Use its own
  # runtime temp directory, then copy this small screenshot to DevSSD.
  "$simctl" io "$simulator" screenshot --type=png "$capture_tmp"
  cp "$capture_tmp" "$output/native-$tab.png"
  rm -f "$capture_tmp"
  "$simctl" terminate "$simulator" "$bundle"
done
