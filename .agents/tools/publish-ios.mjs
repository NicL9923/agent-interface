#!/usr/bin/env node
// Run on the Mac mini. Commands stop at Apple account boundaries without announcing a release.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { all, app, appleApi, appGroup, bundleId, configuration, distribute, identifiers, runPrivate, setupIdentifiers } from './apple-api.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const scratch = '/Volumes/DevSSD/scratch/wildbots-testflight';
const run = (command, args, input) => runPrivate(command, args, { cwd: repo, input, encoding: 'utf8' });
const plist = bytes => JSON.parse(run('python3', ['-c', 'import sys,plistlib,json,base64; print(json.dumps(plistlib.loads(sys.stdin.buffer.read()), default=lambda x: base64.b64encode(x).decode() if isinstance(x,bytes) else x.isoformat()))'], bytes));
const xml = value => run('python3', ['-c', 'import sys,json,plistlib; sys.stdout.buffer.write(plistlib.dumps(json.load(sys.stdin)))'], JSON.stringify(value));
const privateJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const fail = (condition, reason) => { if (!condition) throw new Error(reason); };
const keychains = () => run('security', ['list-keychains', '-d', 'user']).split('\n').map(line => line.trim()).filter(Boolean).map(line => JSON.parse(line));

function checkHost() {
  fail(process.platform === 'darwin', 'iOS releases run on the Mac mini');
  const disk = plist(execFileSync('diskutil', ['info', '-plist', '/Volumes/DevSSD']));
  fail(disk.MountPoint === '/Volumes/DevSSD' && disk.VolumeUUID === 'A6506932-2021-45AD-8C2E-91FCFD595A87', 'Expected DevSSD volume is not mounted');
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
}

function logged(command, args, log, env = process.env) {
  const fd = openSync(log, 'w', 0o600);
  try {
    const result = spawnSync(command, args, { cwd: repo, env, stdio: ['ignore', fd, fd] });
    fail(!result.error && result.status === 0, `${command} failed. Inspect the private log: ${log}`);
  } finally { closeSync(fd); }
}

async function profiles(api, config, destination) {
  const bundles = await all(api, '/bundleIds?limit=200');
  // Match the existing certificate by its public DER bytes, not by a possibly reused name.
  const pem = execFileSync('openssl', ['pkcs12', '-in', config.signingP12, '-passin', 'stdin', '-clcerts', '-nokeys'], { input: config.signingPassword });
  const der = execFileSync('openssl', ['x509', '-outform', 'DER'], { input: pem });
  const certificate = (await all(api, '/certificates?limit=200')).find(item => item.attributes.certificateContent === der.toString('base64'));
  fail(certificate && new Date(certificate.attributes.expirationDate) > new Date(), 'Existing distribution certificate is missing or expired');
  const installed = join(homedir(), 'Library/Developer/Xcode/UserData/Provisioning Profiles');
  mkdirSync(installed, { recursive: true });
  const result = {};
  for (const { name, identifier } of identifiers) {
    const bundle = bundles.find(item => item.attributes.identifier === identifier);
    fail(bundle, `Run setup first: ${identifier} is not registered`);
    const candidates = await all(api, '/profiles?filter[profileType]=IOS_APP_STORE&include=bundleId,certificates&limit=200');
    let selected = candidates.find(item => item.relationships.bundleId?.data?.id === bundle.id && item.attributes.profileState === 'ACTIVE' && new Date(item.attributes.expirationDate) > new Date() && item.relationships.certificates?.data?.some(cert => cert.id === certificate.id));
    if (!selected) selected = (await api('POST', '/profiles', { data: { type: 'profiles', attributes: { name: `WildBots ${name} ${Date.now()}`, profileType: 'IOS_APP_STORE' }, relationships: { bundleId: { data: { type: 'bundleIds', id: bundle.id } }, certificates: { data: [{ type: 'certificates', id: certificate.id }] } } } })).data;
    const file = join(destination, `${name}.mobileprovision`);
    writeFileSync(file, Buffer.from(selected.attributes.profileContent, 'base64'), { mode: 0o600 });
    const decoded = plist(execFileSync('security', ['cms', '-D', '-i', file]));
    const e = decoded.Entitlements;
    fail(e['application-identifier'] === `${config.teamId}.${identifier}` && e['get-task-allow'] === false && decoded.TeamIdentifier.includes(config.teamId), `Wrong distribution profile: ${identifier}`);
    fail(e['com.apple.security.application-groups']?.includes(appGroup), `Apple profile for ${identifier} lacks ${appGroup}. Link that group in the Developer portal, then regenerate the profile; do not bypass this check.`);
    fail(identifier !== bundleId || e['aps-environment'] === 'production', 'Main app profile lacks production APNs');
    writeFileSync(join(installed, `${decoded.UUID}.mobileprovision`), readFileSync(file), { mode: 0o600 });
    result[name] = decoded.Name;
  }
  return { names: result, identity: createHash('sha1').update(der).digest('hex').toUpperCase() };
}

function checkSignedBundles(root, config, version, build) {
  for (const { name, identifier } of identifiers) {
    const path = name === 'AgentInterface' ? root : join(root, 'PlugIns', `${name}.appex`);
    const info = plist(readFileSync(join(path, 'Info.plist')));
    fail(info.CFBundleIdentifier === identifier && info.CFBundleVersion === String(build) && info.CFBundleShortVersionString === version, `Mismatched bundle identity/version: ${name}`);
    run('codesign', ['--verify', '--strict', path]);
    const entitlements = plist(run('codesign', ['-d', '--entitlements', ':-', path]));
    fail(entitlements['application-identifier'] === `${config.teamId}.${identifier}` && entitlements['get-task-allow'] !== true && entitlements['com.apple.security.application-groups']?.includes(appGroup), `Invalid signed entitlements: ${name}`);
    const profile = plist(execFileSync('security', ['cms', '-D', '-i', join(path, 'embedded.mobileprovision')]));
    fail(profile.Entitlements['get-task-allow'] === false && profile.Entitlements['application-identifier'] === `${config.teamId}.${identifier}` && profile.Entitlements['com.apple.security.application-groups']?.includes(appGroup) && !profile.ProvisionedDevices && !profile.ProvisionsAllDevices && new Date(profile.ExpirationDate) > new Date(), `Not an unexpired App Store profile: ${name}`);
    if (name === 'AgentInterface') fail(entitlements['aps-environment'] === 'production' && profile.Entitlements['aps-environment'] === 'production' && info.ITSAppUsesNonExemptEncryption === false, 'Main app needs production APNs and its encryption declaration');
  }
}

async function archive(api, config, version, build) {
  fail(!run('git', ['status', '--porcelain']).trim(), 'Commit reviewed changes before archiving');
  const commit = run('git', ['rev-parse', 'HEAD']).trim();
  const selectedApp = await app(api);
  const uploads = await all(api, `/apps/${selectedApp.id}/buildUploads?filter[platform]=IOS&limit=200`);
  const builds = await all(api, `/builds?filter[app]=${selectedApp.id}&limit=200`);
  const numbers = [...uploads.map(item => item.attributes.cfBundleVersion), ...builds.map(item => item.attributes.version)].map(Number).filter(Number.isFinite);
  fail(build > Math.max(0, ...numbers), 'Build number must exceed every existing upload/build');
  const destination = join(scratch, `${version}-${build}`);
  fail(!existsSync(destination), 'This release directory exists. Inspect it; never overwrite or re-upload an uncertain build.');
  mkdirSync(destination, { mode: 0o700 });
  const signing = await profiles(api, config, destination);
  const keychain = join(destination, 'signing.keychain-db');
  // The short-lived keychain is protected by the enclosing 0700 directory and is deleted
  // below. No reusable certificate or account password goes into a process argument.
  const password = '';
  // macOS rejects OpenSSL's empty-password PKCS12. This disposable transport file
  // uses a fixed placeholder, not the reusable certificate password; the 0700
  // directory and 0600 file provide access control until import deletes it.
  const importPassword = 'temporary-import';
  const importFile = join(destination, 'distribution-import.p12');
  const certificateFile = join(destination, 'signing-certificate.pem');
  try {
    const clear = execFileSync('openssl', ['pkcs12', '-in', config.signingP12, '-passin', 'stdin', '-nodes'], { input: config.signingPassword });
    try {
      // Export reads certificate and private key separately. Reusing stdin for both
      // consumes it once and loses the certificate on OpenSSL 3.
      writeFileSync(certificateFile, execFileSync('openssl', ['x509', '-outform', 'PEM'], { input: clear }), { mode: 0o600 });
      const temporaryP12 = execFileSync('openssl', ['pkcs12', '-export', '-legacy', '-inkey', '/dev/stdin', '-in', certificateFile, '-passout', `pass:${importPassword}`], { input: clear });
      try { writeFileSync(importFile, temporaryP12, { mode: 0o600 }); }
      finally { temporaryP12.fill(0); }
    } finally { clear.fill(0); }
    run('security', ['create-keychain', '-p', password, keychain]);
    run('security', ['unlock-keychain', '-p', password, keychain]);
    run('security', ['set-keychain-settings', '-lut', '21600', keychain]);
    // create-keychain does not add it to the search list. Archive and export both need it.
    run('security', ['list-keychains', '-d', 'user', '-s', ...keychains(), keychain]);
    run('security', ['import', importFile, '-k', keychain, '-P', importPassword, '-T', '/usr/bin/codesign']);
    unlinkSync(importFile);
    run('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', password, keychain]);
    const archivePath = join(destination, 'WildBots.xcarchive');
    const settings = [`DEVELOPMENT_TEAM=${config.teamId}`, 'CODE_SIGN_STYLE=Manual', `CODE_SIGN_IDENTITY=${signing.identity}`, `OTHER_CODE_SIGN_FLAGS=--keychain ${keychain}`, `MARKETING_VERSION=${version}`, `CURRENT_PROJECT_VERSION=${build}`, ...identifiers.map(({ name }) => `WILDBOTS_PROFILE_${name}=${signing.names[name]}`)];
    console.log(`Archiving ${version} (${build}); log: ${destination}/archive.log`);
    logged('xcodebuild', ['-project', 'ios/AgentInterface.xcodeproj', '-scheme', 'AgentInterface', '-configuration', 'Release', '-destination', 'generic/platform=iOS', '-derivedDataPath', join(destination, 'DerivedData'), '-archivePath', archivePath, ...settings, 'archive'], join(destination, 'archive.log'));
    checkSignedBundles(join(archivePath, 'Products/Applications/AgentInterface.app'), config, version, build);
    const options = { method: 'app-store-connect', destination: 'export', signingStyle: 'manual', signingCertificate: signing.identity, teamID: config.teamId, manageAppVersionAndBuildNumber: false, provisioningProfiles: Object.fromEntries(identifiers.map(({ name, identifier }) => [identifier, signing.names[name]])) };
    const optionsPath = join(destination, 'ExportOptions.plist');
    writeFileSync(optionsPath, xml(options));
    logged('xcodebuild', ['-exportArchive', '-archivePath', archivePath, '-exportOptionsPlist', optionsPath, '-exportPath', join(destination, 'export')], join(destination, 'export.log'));
    const ipa = join(destination, 'export/AgentInterface.ipa');
    run('unzip', ['-q', ipa, '-d', join(destination, 'inspection')]);
    checkSignedBundles(join(destination, 'inspection/Payload/AgentInterface.app'), config, version, build);
    fail(!run('git', ['status', '--porcelain']).trim() && run('git', ['rev-parse', 'HEAD']).trim() === commit, 'Source changed during archive/export; do not upload this artifact');
    privateJson(join(destination, 'release.json'), { appId: selectedApp.id, version, build, commit, ipa, sha256: digest(ipa) });
    console.log(`Verified archive and IPA: ${destination}/release.json`);
  } finally {
    if (existsSync(certificateFile)) unlinkSync(certificateFile);
    if (existsSync(importFile)) unlinkSync(importFile);
    if (existsSync(keychain)) {
      // Read the current list so another release's additions survive our cleanup.
      run('security', ['list-keychains', '-d', 'user', '-s', ...keychains().filter(path => path !== keychain)]);
      run('security', ['delete-keychain', keychain]);
    }
  }
}

async function main() {
  const [command, version, number] = process.argv.slice(2);
  fail(['status', 'setup', 'prepare', 'archive', 'upload', 'distribute'].includes(command), 'Usage: node .agents/tools/publish-ios.mjs status|setup|prepare|archive VERSION BUILD|upload VERSION BUILD|distribute VERSION BUILD');
  checkHost();
  const config = configuration(), api = appleApi(config);
  if (command === 'setup') { await setupIdentifiers(api); return; }
  if (command === 'prepare') {
    const path = join(scratch, `profiles-${Date.now()}`);
    mkdirSync(path, { mode: 0o700 });
    await profiles(api, config, path);
    console.log('All three App Store profiles passed the App Group and production push checks.');
    return;
  }
  if (command === 'status') {
    const selectedApp = await app(api);
    console.log(JSON.stringify({ appId: selectedApp.id, builds: (await all(api, `/builds?filter[app]=${selectedApp.id}&include=buildBetaDetail&limit=200`)).map(item => ({ id: item.id, ...item.attributes, iconAssetToken: undefined })) }, null, 2));
    return;
  }
  fail(/^\d+\.\d+(?:\.\d+)?$/.test(version ?? '') && /^[1-9][0-9]{0,8}$/.test(number ?? ''), 'Supply VERSION and a positive whole-number BUILD of at most nine digits');
  const build = Number(number), destination = join(scratch, `${version}-${build}`);
  if (command === 'archive') { await archive(api, config, version, build); return; }
  const receiptPath = join(destination, 'release.json');
  const release = JSON.parse(readFileSync(receiptPath, 'utf8'));
  fail(release.build === build && release.version === version && release.appId === (await app(api)).id && release.sha256 === digest(release.ipa), 'Release identity or artifact hash changed');
  if (command === 'upload') {
    fail(!release.uploadAttemptedAt, 'Upload already attempted. Check Apple processing before considering a retry.');
    fail(config.keyFile.endsWith(`/AuthKey_${config.keyId}.p8`) && existsSync(config.keyFile), 'altool needs AuthKey_KEYID.p8 in the configured key directory');
    run('xcrun', ['--find', 'altool']);
    release.uploadAttemptedAt = new Date().toISOString();
    privateJson(receiptPath, release);
    // Xcode resolves AuthKey_KEYID.p8 in API_PRIVATE_KEYS_DIR, with no token on the command line.
    logged('xcrun', ['altool', '--upload-app', '-f', release.ipa, '-t', 'ios', '--apiKey', config.keyId, '--apiIssuer', config.issuerId], join(destination, 'upload.log'), { ...process.env, API_PRIVATE_KEYS_DIR: dirname(config.keyFile) });
    privateJson(receiptPath, { ...release, uploadedAt: new Date().toISOString() });
    console.log('Uploaded. Apple processing and group distribution are still pending. Run distribute with the same version and build.');
  } else {
    fail(release.uploadAttemptedAt, 'No upload recorded for this artifact');
    const distributed = await distribute(api, build, version, config.testerEmails);
    privateJson(join(destination, 'distributed.json'), { ...distributed, commit: release.commit, sha256: release.sha256 });
    console.log(JSON.stringify(distributed, null, 2));
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
