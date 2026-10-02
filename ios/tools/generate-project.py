#!/usr/bin/env python3
"""Regenerate the dependency-free Xcode project after adding Swift files."""
from pathlib import Path
import hashlib

ROOT = Path(__file__).resolve().parents[1]
objects = {}


def ident(name):
    return hashlib.sha1(name.encode()).hexdigest()[:24].upper()


def add(name, content):
    key = ident(name)
    objects[key] = content
    return key


def array(items):
    return "(" + ", ".join(items) + ")"


def settings(values):
    return "{" + " ".join(f'{key} = "{value}";' for key, value in values.items()) + "}"


targets = []
products = []
groups = []
for name, kind in [("AgentInterfaceShare", "extension"), ("AgentInterface", "app"), ("AgentInterfaceTests", "unit"), ("AgentInterfaceUITests", "ui")]:
    files = sorted((ROOT / name).glob("*.swift"))
    if kind in ("app", "extension"):
        files += sorted((ROOT / "Shared").glob("*.swift"))
    # The independently owned contract suite is included before its first write.
    if name == "AgentInterfaceTests" and not any(p.name == "NativeContractTests.swift" for p in files):
        files.append(ROOT / name / "NativeContractTests.swift")
    references = []
    builds = []
    for path in files:
        reference = add(f"ref:{name}/{path.name}", f'{{isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = "{str(path.relative_to(ROOT / name)) if path.parent == ROOT / name else "../Shared/" + path.name}"; sourceTree = "<group>";}}')
        references.append(reference)
        builds.append(add(f"build:{name}/{path.name}", f"{{isa = PBXBuildFile; fileRef = {reference};}}"))
    resource_builds = []
    if kind in ("app", "extension"):
        for filename, filetype in [("Info.plist", "text.plist.xml"), (name + ".entitlements", "text.plist.entitlements"), ("PrivacyInfo.xcprivacy", "text.plist.xml")]:
            reference = add(f"ref:{name}/{filename}", f'{{isa = PBXFileReference; lastKnownFileType = {filetype}; path = "{filename}"; sourceTree = "<group>";}}')
            references.append(reference)
            if filename == "PrivacyInfo.xcprivacy":
                resource_builds.append(add(f"build:{name}/{filename}", f"{{isa = PBXBuildFile; fileRef = {reference};}}"))
    if kind == "app":
        assets = add("ref:Assets", '{isa = PBXFileReference; lastKnownFileType = folder.assetcatalog; path = "Assets.xcassets"; sourceTree = "<group>";}')
        references.append(assets)
        resource_builds.append(add("build:Assets", f"{{isa = PBXBuildFile; fileRef = {assets};}}"))
    groups.append(add(f"group:{name}", f'{{isa = PBXGroup; children = {array(references)}; path = "{name}"; sourceTree = "<group>";}}'))
    product = add(f"product:{name}", f'{{isa = PBXFileReference; explicitFileType = {"wrapper.application" if kind == "app" else "wrapper.app-extension" if kind == "extension" else "wrapper.cfbundle"}; path = "{name}.{"app" if kind == "app" else "appex" if kind == "extension" else "xctest"}"; sourceTree = BUILT_PRODUCTS_DIR;}}')
    products.append(product)
    source = add(f"sources:{name}", f"{{isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = {array(builds)}; runOnlyForDeploymentPostprocessing = 0;}}")
    resources = add(f"resources:{name}", f"{{isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = {array(resource_builds)}; runOnlyForDeploymentPostprocessing = 0;}}")
    frameworks = add(f"frameworks:{name}", "{isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0;}")
    configs = []
    for configuration in ["Debug", "Release"]:
        values = {
            "PRODUCT_NAME": "$(TARGET_NAME)", "PRODUCT_BUNDLE_IDENTIFIER": "dev.agentinterface.ios" + ("" if kind == "app" else "." + name),
            "SDKROOT": "iphoneos", "SUPPORTED_PLATFORMS": "iphoneos iphonesimulator", "IPHONEOS_DEPLOYMENT_TARGET": "17.0",
            "TARGETED_DEVICE_FAMILY": "1,2", "SWIFT_VERSION": "5.0", "CODE_SIGN_STYLE": "Automatic", "ENABLE_USER_SCRIPT_SANDBOXING": "YES",
            "SWIFT_EMIT_LOC_STRINGS": "YES", "LD_RUNPATH_SEARCH_PATHS": "$(inherited) @executable_path/Frameworks @loader_path/Frameworks", "GENERATE_INFOPLIST_FILE": "NO" if kind in ("app", "extension") else "YES",
        }
        if kind == "app":
            values.update({"INFOPLIST_FILE": "AgentInterface/Info.plist", "CODE_SIGN_ENTITLEMENTS": "AgentInterface/AgentInterface.entitlements", "APNS_ENVIRONMENT": "development" if configuration == "Debug" else "production", "ASSETCATALOG_COMPILER_APPICON_NAME": "AppIcon", "ENABLE_PREVIEWS": "YES"})
        elif kind == "extension":
            values.update({"INFOPLIST_FILE": name + "/Info.plist", "CODE_SIGN_ENTITLEMENTS": name + "/" + name + ".entitlements", "APPLICATION_EXTENSION_API_ONLY": "YES", "SKIP_INSTALL": "YES"})
        elif kind == "unit":
            values.update({"TEST_HOST": "$(BUILT_PRODUCTS_DIR)/AgentInterface.app/$(BUNDLE_EXECUTABLE_FOLDER_PATH)/AgentInterface", "BUNDLE_LOADER": "$(TEST_HOST)"})
        else:
            values.update({"TEST_TARGET_NAME": "AgentInterface"})
        if configuration == "Debug":
            values.update({"SWIFT_ACTIVE_COMPILATION_CONDITIONS": "DEBUG $(inherited)", "SWIFT_OPTIMIZATION_LEVEL": "-Onone", "ENABLE_TESTABILITY": "YES", "ONLY_ACTIVE_ARCH": "YES"})
        configs.append(add(f"config:{name}:{configuration}", f'{{isa = XCBuildConfiguration; buildSettings = {settings(values)}; name = {configuration};}}'))
    config_list = add(f"configs:{name}", f"{{isa = XCConfigurationList; buildConfigurations = {array(configs)}; defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;}}")
    dependencies = []
    if kind not in ("app", "extension"):
        proxy = add(f"proxy:{name}", f'{{isa = PBXContainerItemProxy; containerPortal = {ident("project")}; proxyType = 1; remoteGlobalIDString = {ident("target:AgentInterface")}; remoteInfo = AgentInterface;}}')
        dependencies.append(add(f"dependency:{name}", f'{{isa = PBXTargetDependency; target = {ident("target:AgentInterface")}; targetProxy = {proxy};}}'))
    phases = [source, frameworks, resources]
    if kind == "app":
        extension_product = ident("product:AgentInterfaceShare")
        embedded = add("embed:Share", f'{{isa = PBXBuildFile; fileRef = {extension_product}; settings = {{ATTRIBUTES = (RemoveHeadersOnCopy);}};}}')
        phases.append(add("phase:Share", f'{{isa = PBXCopyFilesBuildPhase; buildActionMask = 2147483647; dstPath = ""; dstSubfolderSpec = 13; files = ({embedded}); name = "Embed app extensions"; runOnlyForDeploymentPostprocessing = 0;}}'))
        proxy = add("proxy:Share", f'{{isa = PBXContainerItemProxy; containerPortal = {ident("project")}; proxyType = 1; remoteGlobalIDString = {ident("target:AgentInterfaceShare")}; remoteInfo = AgentInterfaceShare;}}')
        dependencies.append(add("dependency:Share", f'{{isa = PBXTargetDependency; target = {ident("target:AgentInterfaceShare")}; targetProxy = {proxy};}}'))
    product_type = {"extension": "app-extension", "app": "application", "unit": "bundle.unit-test", "ui": "bundle.ui-testing"}[kind]
    targets.append(add(f"target:{name}", f'{{isa = PBXNativeTarget; buildConfigurationList = {config_list}; buildPhases = {array(phases)}; buildRules = (); dependencies = {array(dependencies)}; name = {name}; productName = {name}; productReference = {product}; productType = "com.apple.product-type.{product_type}";}}'))

products_group = add("group:Products", f'{{isa = PBXGroup; children = {array(products)}; name = Products; sourceTree = "<group>";}}')
main = add("group:Main", f'{{isa = PBXGroup; children = {array(groups + [products_group])}; sourceTree = "<group>";}}')
configs = []
for configuration in ["Debug", "Release"]:
    configs.append(add(f"project-config:{configuration}", f'{{isa = XCBuildConfiguration; buildSettings = {{CLANG_ENABLE_MODULES = YES; CLANG_ENABLE_OBJC_ARC = YES; DEBUG_INFORMATION_FORMAT = "{ "dwarf" if configuration == "Debug" else "dwarf-with-dsym" }";}}; name = {configuration};}}'))
config_list = add("project-configs", f"{{isa = XCConfigurationList; buildConfigurations = {array(configs)}; defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;}}")
project = add("project", f'{{isa = PBXProject; attributes = {{BuildIndependentTargetsInParallel = YES; LastUpgradeCheck = 2700;}}; buildConfigurationList = {config_list}; compatibilityVersion = "Xcode 14.0"; developmentRegion = en; hasScannedForEncodings = 0; knownRegions = (en, Base); mainGroup = {main}; productRefGroup = {products_group}; projectDirPath = ""; projectRoot = ""; targets = {array(targets)};}}')
project_path = ROOT / "AgentInterface.xcodeproj"
project_path.mkdir(exist_ok=True)
(project_path / "project.pbxproj").write_text("// !$*UTF8*$!\n{ archiveVersion = 1; classes = {}; objectVersion = 56; objects = {\n" + "\n".join(f"{key} = {value};" for key, value in objects.items()) + f"\n}}; rootObject = {project}; }}\n")
scheme_dir = project_path / "xcshareddata/xcschemes"
scheme_dir.mkdir(parents=True, exist_ok=True)
def reference(name):
    return f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{ident("target:" + name)}" BuildableName="{name}.{"app" if name == "AgentInterface" else "xctest"}" BlueprintName="{name}" ReferencedContainer="container:AgentInterface.xcodeproj"/>'
(scheme_dir / "AgentInterface.xcscheme").write_text(f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="2700" version="1.7">
<BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">{reference("AgentInterface")}</BuildActionEntry></BuildActionEntries></BuildAction>
<TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables><TestableReference skipped="NO" parallelizable="NO">{reference("AgentInterfaceTests")}</TestableReference><TestableReference skipped="NO" parallelizable="NO">{reference("AgentInterfaceUITests")}</TestableReference></Testables></TestAction>
<LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugServiceExtension="internal" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0">{reference("AgentInterface")}</BuildableProductRunnable></LaunchAction>
<ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugServiceExtension="internal"><BuildableProductRunnable runnableDebuggingMode="0">{reference("AgentInterface")}</BuildableProductRunnable></ProfileAction>
<AnalyzeAction buildConfiguration="Debug"/><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>
''')
print(project_path)
