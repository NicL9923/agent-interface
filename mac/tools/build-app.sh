#!/bin/zsh
# Builds mac/build/WildBots.app: release build, bundle, hardened-runtime signature.
#
#   WILDBOTS_MAC_SIGN_IDENTITY="Developer ID Application: Name (TEAMID)" tools/build-app.sh
#
# Without an identity the app is signed ad hoc. macOS ties privacy permissions (Screen
# Recording, Files and Folders) to the signature, so an ad-hoc build loses them on every rebuild.
# The app is not App Sandboxed: it confines assistants' commands with sandbox-exec itself.
set -euo pipefail
cd "${0:A:h}/.."

version=${WILDBOTS_MAC_VERSION:-1.0}
build=${WILDBOTS_MAC_BUILD:-1}
identity=${WILDBOTS_MAC_SIGN_IDENTITY:-}

swift build -c release --product WildBotsMac
bin="$(swift build -c release --show-bin-path)/WildBotsMac"

app=build/WildBots.app
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin" "$app/Contents/MacOS/WildBots"

cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>dev.agentinterface.mac</string>
  <key>CFBundleName</key><string>WildBots</string>
  <key>CFBundleDisplayName</key><string>WildBots</string>
  <key>CFBundleExecutable</key><string>WildBots</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${build}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSScreenCaptureUsageDescription</key><string>Your assistants can take a screenshot of the main display when you allow it in WildBots.</string>
  <key>NSDesktopFolderUsageDescription</key><string>Your assistants can use folders on your Desktop that you share with them in WildBots.</string>
  <key>NSDocumentsFolderUsageDescription</key><string>Your assistants can use folders in Documents that you share with them in WildBots.</string>
  <key>NSDownloadsFolderUsageDescription</key><string>Your assistants can use folders in Downloads that you share with them in WildBots.</string>
  <key>NSRemovableVolumesUsageDescription</key><string>Your assistants can use folders on external drives that you share with them in WildBots.</string>
  <key>NSNetworkVolumesUsageDescription</key><string>Your assistants can use folders on network drives that you share with them in WildBots.</string>
</dict>
</plist>
PLIST
plutil -lint "$app/Contents/Info.plist" >/dev/null

if [[ -n $identity ]]; then
  codesign --force --options runtime --timestamp --sign "$identity" "$app"
  print "Signed with $identity."
else
  codesign --force --options runtime --sign - "$app"
  print -u2 "WARNING: signed ad hoc. Screen Recording and Files and Folders permissions will not persist across rebuilds;"
  print -u2 "         set WILDBOTS_MAC_SIGN_IDENTITY to a Developer ID Application identity for a build you keep."
fi
codesign --verify --strict --verbose=2 "$app"
print "Built $PWD/$app"
