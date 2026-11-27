#!/usr/bin/env node
/** Regenerate the dependency-free Xcode project after adding Swift files. */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const objects = new Map();

function ident(name) {
  return createHash("sha1").update(name).digest("hex").slice(0, 24).toUpperCase();
}

function add(name, content) {
  const key = ident(name);
  objects.set(key, content);
  return key;
}

function array(items) {
  return `(${items.join(", ")})`;
}

function settings(values) {
  return `{${Object.entries(values)
    .map(([key, value]) => `${key} = "${value}";`)
    .join(" ")}}`;
}

function swiftFilesIn(dir) {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".swift"))
      .sort()
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

// One version for the app and every extension: App Store validation rejects extensions whose
// versions differ from the app's.
const MARKETING_VERSION = "1.0";
const CURRENT_PROJECT_VERSION = "33";
const LINK_DOMAIN = "agentui.wildflowersranch.com";
const EXTENSIONS = ["AgentInterfaceShare", "AgentInterfaceWidgets", "AgentInterfaceNotifications"];

const targets = [];
const products = [];
const groups = [];

for (const [name, kind] of [
  ...EXTENSIONS.map((extension) => [extension, "extension"]),
  ["AgentInterfaceWatchWidgets", "watchExtension"],
  ["AgentInterfaceWatch", "watchApp"],
  ["AgentInterface", "app"],
  ["AgentInterfaceTests", "unit"],
  ["AgentInterfaceUITests", "ui"],
]) {
  const files = [...swiftFilesIn(join(ROOT, name))];
  if (kind === "app" || kind === "extension") {
    files.push(...swiftFilesIn(join(ROOT, "Shared")));
  }
  // Widget and Live Activity models and views: the app writes and previews what the widgets show.
  if (name === "AgentInterface" || name === "AgentInterfaceWidgets") {
    files.push(...swiftFilesIn(join(ROOT, "Shared", "Widgets")));
  }
  // WatchConnectivity wire payload and shared snapshot models for iPhone + Watch companion + Watch Smart Stack.
  if (
    name === "AgentInterface" ||
    name === "AgentInterfaceWatch" ||
    name === "AgentInterfaceWatchWidgets"
  ) {
    files.push(...swiftFilesIn(join(ROOT, "Shared", "Watch")));
  }
  if (kind === "watchApp" || kind === "watchExtension") {
    files.push(
      join(ROOT, "Shared", "ShareInbox.swift"),
      join(ROOT, "Shared", "Widgets", "AssistantActivity.swift"),
      join(ROOT, "Shared", "Widgets", "WidgetSnapshot.swift"),
    );
  }
  // Notification prefetch: only the app and the notification service extension share the prefetch token and cache.
  if (name === "AgentInterface" || name === "AgentInterfaceNotifications") {
    files.push(...swiftFilesIn(join(ROOT, "Shared", "Notifications")));
  }
  // The independently owned contract suite is included before its first write.
  if (
    name === "AgentInterfaceTests" &&
    !files.some((p) => p.endsWith("/NativeContractTests.swift"))
  ) {
    files.push(join(ROOT, name, "NativeContractTests.swift"));
  }

  const references = [];
  const builds = [];
  for (const filePath of files) {
    const fileName = filePath.split("/").pop();
    const relPath =
      dirname(filePath) === join(ROOT, name)
        ? relative(join(ROOT, name), filePath)
        : `../${relative(ROOT, filePath)}`;
    const reference = add(
      `ref:${name}/${fileName}`,
      `{isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = "${relPath}"; sourceTree = "<group>";}`,
    );
    references.push(reference);
    builds.push(add(`build:${name}/${fileName}`, `{isa = PBXBuildFile; fileRef = ${reference};}`));
  }

  const isWatch = kind === "watchApp" || kind === "watchExtension";
  const hasAppResources = kind === "app" || kind === "extension" || isWatch;

  const resourceBuilds = [];
  if (hasAppResources) {
    for (const [filename, filetype] of [
      ["Info.plist", "text.plist.xml"],
      [`${name}.entitlements`, "text.plist.entitlements"],
      ["PrivacyInfo.xcprivacy", "text.plist.xml"],
    ]) {
      const reference = add(
        `ref:${name}/${filename}`,
        `{isa = PBXFileReference; lastKnownFileType = ${filetype}; path = "${filename}"; sourceTree = "<group>";}`,
      );
      references.push(reference);
      if (filename === "PrivacyInfo.xcprivacy") {
        resourceBuilds.push(
          add(`build:${name}/${filename}`, `{isa = PBXBuildFile; fileRef = ${reference};}`),
        );
      }
    }
  }

  if (kind === "app" || kind === "watchApp") {
    const assetKey = kind === "app" ? "Assets" : `${name}/Assets`;
    const assets = add(
      `ref:${assetKey}`,
      '{isa = PBXFileReference; lastKnownFileType = folder.assetcatalog; path = "Assets.xcassets"; sourceTree = "<group>";}',
    );
    references.push(assets);
    resourceBuilds.push(add(`build:${assetKey}`, `{isa = PBXBuildFile; fileRef = ${assets};}`));
  }

  groups.push(
    add(
      `group:${name}`,
      `{isa = PBXGroup; children = ${array(references)}; path = "${name}"; sourceTree = "<group>";}`,
    ),
  );

  const explicitFileType =
    kind === "app" || kind === "watchApp"
      ? "wrapper.application"
      : kind === "extension" || kind === "watchExtension"
        ? "wrapper.app-extension"
        : "wrapper.cfbundle";
  const ext =
    kind === "app" || kind === "watchApp"
      ? "app"
      : kind === "extension" || kind === "watchExtension"
        ? "appex"
        : "xctest";
  const product = add(
    `product:${name}`,
    `{isa = PBXFileReference; explicitFileType = ${explicitFileType}; path = "${name}.${ext}"; sourceTree = BUILT_PRODUCTS_DIR;}`,
  );
  products.push(product);

  const source = add(
    `sources:${name}`,
    `{isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = ${array(builds)}; runOnlyForDeploymentPostprocessing = 0;}`,
  );
  const resources = add(
    `resources:${name}`,
    `{isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = ${array(resourceBuilds)}; runOnlyForDeploymentPostprocessing = 0;}`,
  );
  const frameworks = add(
    `frameworks:${name}`,
    "{isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0;}",
  );

  const configs = [];
  for (const configuration of ["Debug", "Release"]) {
    const bundleIdentifier =
      kind === "app"
        ? "dev.agentinterface.ios"
        : kind === "watchApp"
          ? "dev.agentinterface.ios.watchkitapp"
          : kind === "watchExtension"
            ? "dev.agentinterface.ios.watchkitapp.widgets"
            : `dev.agentinterface.ios.${name}`;
    const values = {
      PRODUCT_NAME: "$(TARGET_NAME)",
      PRODUCT_BUNDLE_IDENTIFIER: bundleIdentifier,
      SDKROOT: isWatch ? "watchos" : "iphoneos",
      SUPPORTED_PLATFORMS: isWatch ? "watchos watchsimulator" : "iphoneos iphonesimulator",
      ...(isWatch
        ? { WATCHOS_DEPLOYMENT_TARGET: "10.0", TARGETED_DEVICE_FAMILY: "4" }
        : { IPHONEOS_DEPLOYMENT_TARGET: "17.0", TARGETED_DEVICE_FAMILY: "1,2" }),
      SWIFT_VERSION: "6.0",
      SWIFT_STRICT_CONCURRENCY: "complete",
      CODE_SIGN_STYLE: "Automatic",
      ENABLE_USER_SCRIPT_SANDBOXING: "YES",
      SWIFT_EMIT_LOC_STRINGS: "YES",
      MARKETING_VERSION,
      CURRENT_PROJECT_VERSION,
      LD_RUNPATH_SEARCH_PATHS: "$(inherited) @executable_path/Frameworks @loader_path/Frameworks",
      GENERATE_INFOPLIST_FILE: hasAppResources ? "NO" : "YES",
    };
    if (kind === "app") {
      Object.assign(values, {
        INFOPLIST_FILE: "AgentInterface/Info.plist",
        CODE_SIGN_ENTITLEMENTS: "AgentInterface/AgentInterface.entitlements",
        APNS_ENVIRONMENT: configuration === "Debug" ? "development" : "production",
        ASSETCATALOG_COMPILER_APPICON_NAME: "AppIcon",
        ENABLE_PREVIEWS: "YES",
        // The household server whose chat and Today links open the app. Another household builds with its own.
        WILDBOTS_LINK_DOMAIN: LINK_DOMAIN,
      });
    } else if (kind === "extension") {
      Object.assign(values, {
        INFOPLIST_FILE: `${name}/Info.plist`,
        CODE_SIGN_ENTITLEMENTS: `${name}/${name}.entitlements`,
        APPLICATION_EXTENSION_API_ONLY: "YES",
        SKIP_INSTALL: "YES",
      });
    } else if (kind === "watchApp") {
      Object.assign(values, {
        INFOPLIST_FILE: `${name}/Info.plist`,
        CODE_SIGN_ENTITLEMENTS: `${name}/${name}.entitlements`,
        ASSETCATALOG_COMPILER_APPICON_NAME: "AppIcon",
        SKIP_INSTALL: "YES",
      });
    } else if (kind === "watchExtension") {
      Object.assign(values, {
        INFOPLIST_FILE: `${name}/Info.plist`,
        CODE_SIGN_ENTITLEMENTS: `${name}/${name}.entitlements`,
        APPLICATION_EXTENSION_API_ONLY: "YES",
        SKIP_INSTALL: "YES",
      });
    } else if (kind === "unit") {
      Object.assign(values, {
        TEST_HOST:
          "$(BUILT_PRODUCTS_DIR)/AgentInterface.app/$(BUNDLE_EXECUTABLE_FOLDER_PATH)/AgentInterface",
        BUNDLE_LOADER: "$(TEST_HOST)",
      });
    } else {
      values.TEST_TARGET_NAME = "AgentInterface";
    }
    if (configuration === "Release" && (kind === "app" || kind === "extension")) {
      values.PROVISIONING_PROFILE_SPECIFIER = `$(WILDBOTS_PROFILE_${name})`;
    }
    if (configuration === "Debug") {
      Object.assign(values, {
        SWIFT_ACTIVE_COMPILATION_CONDITIONS: "DEBUG $(inherited)",
        SWIFT_OPTIMIZATION_LEVEL: "-Onone",
        ENABLE_TESTABILITY: "YES",
        ONLY_ACTIVE_ARCH: "YES",
      });
    }
    configs.push(
      add(
        `config:${name}:${configuration}`,
        `{isa = XCBuildConfiguration; buildSettings = ${settings(values)}; name = ${configuration};}`,
      ),
    );
  }

  const configList = add(
    `configs:${name}`,
    `{isa = XCConfigurationList; buildConfigurations = ${array(configs)}; defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;}`,
  );

  const dependencies = [];
  if (kind === "unit" || kind === "ui") {
    const proxy = add(
      `proxy:${name}`,
      `{isa = PBXContainerItemProxy; containerPortal = ${ident("project")}; proxyType = 1; remoteGlobalIDString = ${ident("target:AgentInterface")}; remoteInfo = AgentInterface;}`,
    );
    dependencies.push(
      add(
        `dependency:${name}`,
        `{isa = PBXTargetDependency; target = ${ident("target:AgentInterface")}; targetProxy = ${proxy};}`,
      ),
    );
  }

  const phases = [source, frameworks, resources];
  if (kind === "watchApp") {
    const watchWidgetsEmbed = add(
      "embed:AgentInterfaceWatchWidgets",
      `{isa = PBXBuildFile; fileRef = ${ident("product:AgentInterfaceWatchWidgets")}; settings = {ATTRIBUTES = (RemoveHeadersOnCopy);};}`,
    );
    const proxy = add(
      "proxy:AgentInterfaceWatchWidgets",
      `{isa = PBXContainerItemProxy; containerPortal = ${ident("project")}; proxyType = 1; remoteGlobalIDString = ${ident("target:AgentInterfaceWatchWidgets")}; remoteInfo = AgentInterfaceWatchWidgets;}`,
    );
    dependencies.push(
      add(
        "dependency:AgentInterfaceWatchWidgets",
        `{isa = PBXTargetDependency; target = ${ident("target:AgentInterfaceWatchWidgets")}; targetProxy = ${proxy};}`,
      ),
    );
    phases.push(
      add(
        "phase:WatchExtensions",
        `{isa = PBXCopyFilesBuildPhase; buildActionMask = 2147483647; dstPath = ""; dstSubfolderSpec = 13; files = (${watchWidgetsEmbed}); name = "Embed watch extensions"; runOnlyForDeploymentPostprocessing = 0;}`,
      ),
    );
  }
  if (kind === "app") {
    const embedded = [];
    for (const extension of EXTENSIONS) {
      // The share extension keeps its original identifiers so the project diff stays small.
      const key = extension === "AgentInterfaceShare" ? "Share" : extension;
      embedded.push(
        add(
          `embed:${key}`,
          `{isa = PBXBuildFile; fileRef = ${ident(`product:${extension}`)}; settings = {ATTRIBUTES = (RemoveHeadersOnCopy);};}`,
        ),
      );
      const proxy = add(
        `proxy:${key}`,
        `{isa = PBXContainerItemProxy; containerPortal = ${ident("project")}; proxyType = 1; remoteGlobalIDString = ${ident(`target:${extension}`)}; remoteInfo = ${extension};}`,
      );
      dependencies.push(
        add(
          `dependency:${key}`,
          `{isa = PBXTargetDependency; target = ${ident(`target:${extension}`)}; targetProxy = ${proxy};}`,
        ),
      );
    }
    phases.push(
      add(
        "phase:Share",
        `{isa = PBXCopyFilesBuildPhase; buildActionMask = 2147483647; dstPath = ""; dstSubfolderSpec = 13; files = ${array(embedded)}; name = "Embed app extensions"; runOnlyForDeploymentPostprocessing = 0;}`,
      ),
    );
    const watchEmbed = add(
      "embed:AgentInterfaceWatch",
      `{isa = PBXBuildFile; fileRef = ${ident("product:AgentInterfaceWatch")}; settings = {ATTRIBUTES = (RemoveHeadersOnCopy);};}`,
    );
    const watchProxy = add(
      "proxy:AgentInterfaceWatch",
      `{isa = PBXContainerItemProxy; containerPortal = ${ident("project")}; proxyType = 1; remoteGlobalIDString = ${ident("target:AgentInterfaceWatch")}; remoteInfo = AgentInterfaceWatch;}`,
    );
    dependencies.push(
      add(
        "dependency:AgentInterfaceWatch",
        `{isa = PBXTargetDependency; target = ${ident("target:AgentInterfaceWatch")}; targetProxy = ${watchProxy};}`,
      ),
    );
    phases.push(
      add(
        "phase:WatchContent",
        `{isa = PBXCopyFilesBuildPhase; buildActionMask = 2147483647; dstPath = "$(CONTENTS_FOLDER_PATH)/Watch"; dstSubfolderSpec = 16; files = (${watchEmbed}); name = "Embed Watch Content"; runOnlyForDeploymentPostprocessing = 0;}`,
      ),
    );
  }

  const productType = {
    extension: "app-extension",
    watchExtension: "app-extension",
    watchApp: "application",
    app: "application",
    unit: "bundle.unit-test",
    ui: "bundle.ui-testing",
  }[kind];

  targets.push(
    add(
      `target:${name}`,
      `{isa = PBXNativeTarget; buildConfigurationList = ${configList}; buildPhases = ${array(phases)}; buildRules = (); dependencies = ${array(dependencies)}; name = ${name}; productName = ${name}; productReference = ${product}; productType = "com.apple.product-type.${productType}";}`,
    ),
  );
}

const productsGroup = add(
  "group:Products",
  `{isa = PBXGroup; children = ${array(products)}; name = Products; sourceTree = "<group>";}`,
);
const mainGroup = add(
  "group:Main",
  `{isa = PBXGroup; children = ${array([...groups, productsGroup])}; sourceTree = "<group>";}`,
);
const projectConfigs = ["Debug", "Release"].map((configuration) =>
  add(
    `project-config:${configuration}`,
    `{isa = XCBuildConfiguration; buildSettings = {CLANG_ENABLE_MODULES = YES; CLANG_ENABLE_OBJC_ARC = YES; DEBUG_INFORMATION_FORMAT = "${configuration === "Debug" ? "dwarf" : "dwarf-with-dsym"}";}; name = ${configuration};}`,
  ),
);
const projectConfigList = add(
  "project-configs",
  `{isa = XCConfigurationList; buildConfigurations = ${array(projectConfigs)}; defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;}`,
);
const project = add(
  "project",
  `{isa = PBXProject; attributes = {BuildIndependentTargetsInParallel = YES; LastUpgradeCheck = 2700;}; buildConfigurationList = ${projectConfigList}; compatibilityVersion = "Xcode 14.0"; developmentRegion = en; hasScannedForEncodings = 0; knownRegions = (en, Base); mainGroup = ${mainGroup}; productRefGroup = ${productsGroup}; projectDirPath = ""; projectRoot = ""; targets = ${array(targets)};}`,
);

const projectPath = join(ROOT, "AgentInterface.xcodeproj");
mkdirSync(projectPath, { recursive: true });
writeFileSync(
  join(projectPath, "project.pbxproj"),
  "// !$*UTF8*$!\n{ archiveVersion = 1; classes = {}; objectVersion = 56; objects = {\n" +
    [...objects.entries()].map(([key, value]) => `${key} = ${value};`).join("\n") +
    `\n}; rootObject = ${project}; }\n`,
);

const schemeDir = join(projectPath, "xcshareddata", "xcschemes");
mkdirSync(schemeDir, { recursive: true });

function reference(name, suffix) {
  const ext =
    suffix ?? (name === "AgentInterface" || name === "AgentInterfaceWatch" ? "app" : "xctest");
  return `<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${ident(`target:${name}`)}" BuildableName="${name}.${ext}" BlueprintName="${name}" ReferencedContainer="container:AgentInterface.xcodeproj"/>`;
}

writeFileSync(
  join(schemeDir, "AgentInterface.xcscheme"),
  `<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="2700" version="1.7">
<BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">${reference("AgentInterface", "app")}</BuildActionEntry></BuildActionEntries></BuildAction>
<TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables><TestableReference skipped="NO" parallelizable="NO">${reference("AgentInterfaceTests", "xctest")}</TestableReference><TestableReference skipped="NO" parallelizable="NO">${reference("AgentInterfaceUITests", "xctest")}</TestableReference></Testables></TestAction>
<LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugServiceExtension="internal" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0">${reference("AgentInterface", "app")}</BuildableProductRunnable></LaunchAction>
<ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugServiceExtension="internal"><BuildableProductRunnable runnableDebuggingMode="0">${reference("AgentInterface", "app")}</BuildableProductRunnable></ProfileAction>
<AnalyzeAction buildConfiguration="Debug"/><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>
`,
);

writeFileSync(
  join(schemeDir, "AgentInterfaceWatch.xcscheme"),
  `<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="2700" version="1.7">
<BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">${reference("AgentInterfaceWatch", "app")}</BuildActionEntry></BuildActionEntries></BuildAction>
<TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables/></TestAction>
<LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugServiceExtension="internal" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0">${reference("AgentInterfaceWatch", "app")}</BuildableProductRunnable></LaunchAction>
<ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugServiceExtension="internal"><BuildableProductRunnable runnableDebuggingMode="0">${reference("AgentInterfaceWatch", "app")}</BuildableProductRunnable></ProfileAction>
<AnalyzeAction buildConfiguration="Debug"/><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>
`,
);
console.log(projectPath);
