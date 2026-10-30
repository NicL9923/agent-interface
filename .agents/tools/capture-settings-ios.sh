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
  content_size=large
  appearance=light
  survival_capture=""
  discovery_tab=""
  group_capture=0
  preferences_capture=0
  computer_capture=0
  trigger_secret_capture=0
  upgrade_capture=0
  connection_capture=0
  notifications_capture=0
  notifications_blocked=0
  apple_date_capture=0
  apple_capture=0
  capture_delay=${NATIVE_CAPTURE_DELAY:-5}
  case "$tab" in
    ComposerAX3) settings_tab=""; survival_capture=composer; content_size=accessibility-extra-large ;;
    ComposerDark) settings_tab=""; survival_capture=composer; appearance=dark ;;
    ComposerFocused) settings_tab=""; survival_capture=composer-focused ;;
    ComposerMultiline) settings_tab=""; survival_capture=composer-multiline ;;
    Composer) settings_tab=""; survival_capture=composer ;;
    Empty) settings_tab=""; survival_capture=empty ;;
    ShareOffline) settings_tab=""; survival_capture=share-offline ;;
    ShareDiscard) settings_tab=""; survival_capture=share-discard ;;
    ShareDraft) settings_tab=""; survival_capture=share ;;
    Widget) settings_tab=""; survival_capture=widget ;;
    WidgetStale) settings_tab=""; survival_capture=widget-stale ;;
    WidgetEmpty) settings_tab=""; survival_capture=widget-empty ;;
    Preferences) settings_tab=""; preferences_capture=1 ;;
    Notifications) settings_tab=""; notifications_capture=1 ;;
    NotificationsBlocked) settings_tab=""; notifications_capture=1; notifications_blocked=1 ;;
    AppleDate) settings_tab=""; apple_capture=1; apple_date_capture=1 ;;
    Apple) settings_tab=""; apple_capture=1 ;;
    Updates) settings_tab=""; upgrade_capture=1; capture_delay=${NATIVE_CAPTURE_DELAY:-8} ;;
    Connection) settings_tab=""; connection_capture=1; capture_delay=${NATIVE_CAPTURE_DELAY:-8} ;;
    TriggerSecret) settings_tab="Work"; trigger_secret_capture=1; capture_delay=${NATIVE_CAPTURE_DELAY:-10} ;;
    Computer) settings_tab=""; computer_capture=1; capture_delay=${NATIVE_CAPTURE_DELAY:-10} ;;
    Groups) settings_tab=""; group_capture=1; capture_delay=${NATIVE_CAPTURE_DELAY:-12} ;;
    Search) settings_tab=""; discovery_tab=search ;;
    History) settings_tab=""; discovery_tab=history ;;
    Saved) settings_tab=""; discovery_tab=saved ;;
    Automations) settings_tab=""; discovery_tab=automations ;;
    Details|Avatar|Connections|Tools|Skills|Routines|Work|Learning|Memory|Logins) ;;
    *) echo "Unknown capture page: $tab" >&2; exit 2 ;;
  esac
  "$simctl" ui "$simulator" content_size "$content_size"
  "$simctl" ui "$simulator" appearance "$appearance"
  SIMCTL_CHILD_AGENT_INTERFACE_UI_CAPTURE_SURVIVAL="$survival_capture" \
  SIMCTL_CHILD_AGENT_INTERFACE_UI_FIXTURE=1 \
  SIMCTL_CHILD_AGENT_INTERFACE_UI_AUTOMATION=1 \
  SIMCTL_CHILD_AGENT_INTERFACE_UI_GROUP="$group_capture" \
  SIMCTL_CHILD_AGENT_INTERFACE_UI_CAPTURE_GROUP="$group_capture" \
  SIMCTL_CHILD_AGENT_INTERFACE_UI_CAPTURE_PREFERENCES="$preferences_capture" \
  SIMCTL_CHILD_AGENT_INTERFACE_UI_CAPTURE_COMPUTER="$computer_capture" \
  SIMCTL_CHILD_AGENT_INTERFACE_UI_CAPTURE_TRIGGER_SECRET="$trigger_secret_capture" \
  SIMCTL_CHILD_AGENT_INTERFACE_UI_CAPTURE_UPGRADE="$upgrade_capture" \
  SIMCTL_CHILD_AGENT_INTERFACE_UI_UPGRADE_FAILED="$upgrade_capture" \
  SIMCTL_CHILD_AGENT_INTERFACE_UI_CAPTURE_CONNECTION="$connection_capture" \
  SIMCTL_CHILD_AGENT_INTERFACE_UI_CAPTURE_NOTIFICATIONS="$notifications_capture" \
  SIMCTL_CHILD_AGENT_INTERFACE_UI_PUSH="$notifications_capture" \
  SIMCTL_CHILD_AGENT_INTERFACE_UI_PUSH_BLOCKED="$notifications_blocked" \
  SIMCTL_CHILD_AGENT_INTERFACE_UI_CAPTURE_APPLE_DATE="$apple_date_capture" \
  SIMCTL_CHILD_AGENT_INTERFACE_UI_CAPTURE_APPLE="$apple_capture" \
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
"$simctl" ui "$simulator" content_size large
"$simctl" ui "$simulator" appearance light
