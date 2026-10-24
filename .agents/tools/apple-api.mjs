// Private Apple credentials live outside Git. No third-party JWT or HTTP dependency.
import { readFileSync } from 'node:fs';
import { createPrivateKey, sign } from 'node:crypto';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

export const bundleId = 'dev.agentinterface.ios';
export const appGroup = 'group.dev.agentinterface.shared';
export const targets = ['AgentInterface', 'AgentInterfaceShare', 'AgentInterfaceWidgets', 'AgentInterfaceNotifications'];
export const identifiers = targets.map((name, i) => ({ name, identifier: bundleId + (i ? `.${name}` : '') }));
export const configPath = `${homedir()}/.config/wildbots/apple/config.json`;
export function configuration() {
  try { return JSON.parse(readFileSync(configPath, 'utf8')); }
  catch { throw new Error(`Cannot read valid private Apple configuration at ${configPath}`); }
}

export function runPrivate(command, args, options = {}) {
  try { return execFileSync(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch (error) {
    // execFileSync's default message echoes argv, including security's keychain passwords.
    throw new Error(`${command} failed (exit ${error.status ?? 'unknown'}). Command arguments and output are withheld because they may contain signing credentials.`);
  }
}

export function appleApi(config, transport = fetch) {
  return async (method, route, body) => {
    // Routes and pagination stay on Apple's API; never forward the bearer token to a URL.
    if (!route.startsWith('/') || route.startsWith('//') || route.includes('://')) throw new Error('Invalid Apple API route');
    const now = Math.floor(Date.now() / 1000);
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'ES256', kid: config.keyId, typ: 'JWT' })}.${encode({ aud: 'appstoreconnect-v1', iss: config.issuerId, iat: now, exp: now + 600 })}`;
    const signature = sign('sha256', Buffer.from(unsigned), { key: createPrivateKey(readFileSync(config.keyFile)), dsaEncoding: 'ieee-p1363' }).toString('base64url');
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await transport(`https://api.appstoreconnect.apple.com/v1${route}`, {
          method, redirect: 'error', signal: AbortSignal.timeout(30_000),
          headers: { Authorization: `Bearer ${unsigned}.${signature}`, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch {
        // A mutation may have completed before the connection failed. Never repeat it here.
        if (method === 'GET' && attempt < 2) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        }
        throw new Error(`${method} ${route}: connection failed or timed out. Read Apple's current state before retrying a mutation.`);
      }
      if (method === 'GET' && attempt < 2 && [500, 502, 503, 504].includes(response.status)) {
        await response.text();
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      }
      const text = await response.text();
      let result;
      try { result = text ? JSON.parse(text) : {}; }
      catch { throw new Error(`${method} ${route}: HTTP ${response.status} with a non-JSON response`); }
      if (!response.ok) throw new Error(`${method} ${route}: HTTP ${response.status}: ${JSON.stringify(result.errors ?? result)}`);
      return result;
    }
  };
}

export async function all(api, route) {
  const data = [];
  for (let page = 0; route && page < 20; page++) {
    const result = await api('GET', route);
    data.push(...result.data);
    if (!result.links?.next) return data;
    const next = new URL(result.links.next);
    if (next.origin !== 'https://api.appstoreconnect.apple.com' || !next.pathname.startsWith('/v1/')) throw new Error('Unexpected Apple pagination URL');
    route = next.pathname.slice(3) + next.search;
  }
  throw new Error('Apple pagination exceeded its bound');
}

export async function app(api) {
  const apps = await all(api, '/apps?limit=100');
  const match = apps.find(item => item.attributes.bundleId === bundleId);
  if (!match) throw new Error(`Create WildBots in App Store Connect using bundle ID ${bundleId}, primary language English (US), SKU wildbots-ios, iOS, and Limited Access. Apple requires its website for this first app record.`);
  return match;
}

export async function setupIdentifiers(api) {
  const bundles = await all(api, '/bundleIds?limit=200');
  for (const { name, identifier } of identifiers) {
    let registered = bundles.find(item => item.attributes.identifier === identifier);
    if (!registered) registered = (await api('POST', '/bundleIds', { data: { type: 'bundleIds', attributes: { identifier, name: `WildBots ${name}`, platform: 'IOS' } } })).data;
    const capabilities = await all(api, `/bundleIds/${registered.id}/bundleIdCapabilities`);
    for (const capabilityType of ['APP_GROUPS', ...(identifier === bundleId ? ['PUSH_NOTIFICATIONS'] : [])]) {
      if (!capabilities.some(item => item.attributes.capabilityType === capabilityType)) {
        await api('POST', '/bundleIdCapabilities', { data: { type: 'bundleIdCapabilities', attributes: { capabilityType }, relationships: { bundleId: { data: { type: 'bundleIds', id: registered.id } } } } });
      }
    }
    console.log(`Registered ${identifier}`);
  }
}

export function requireReadyBuild(build, expectedVersion, expectedBuild, appId) {
  if (build.attributes.version !== String(expectedBuild) || build.attributes.processingState !== 'VALID' || build.attributes.expired) throw new Error('The exact uploaded build is not valid and unexpired');
  const linkedApp = build.relationships.app?.data?.id;
  if (linkedApp !== appId) throw new Error('Build belongs to a different app');
  if (build.marketingVersion !== expectedVersion) throw new Error('Build belongs to a different marketing version');
}

export async function distribute(api, buildNumber, version, expectedTesters) {
  if (!Array.isArray(expectedTesters) || expectedTesters.length !== 2 || new Set(expectedTesters.map(email => email.toLowerCase())).size !== 2) throw new Error('Configure the two household testerEmails in the private Apple configuration');
  const selectedApp = await app(api);
  const result = await api('GET', `/builds?filter[app]=${selectedApp.id}&filter[version]=${buildNumber}&include=app,preReleaseVersion,buildBetaDetail&limit=200`);
  const builds = result.data.map(build => ({ ...build, marketingVersion: result.included?.find(item => item.type === 'preReleaseVersions' && item.id === build.relationships.preReleaseVersion?.data?.id)?.attributes.version }));
  const selected = builds.find(build => build.marketingVersion === version);
  if (!selected) throw new Error('The exact build has not finished processing. Re-run status/distribute after Apple processing completes; do not upload it twice.');
  requireReadyBuild(selected, version, buildNumber, selectedApp.id);
  const groups = await all(api, `/apps/${selectedApp.id}/betaGroups?limit=200`);
  let group = groups.find(item => item.attributes.name === 'Household' && item.attributes.isInternalGroup);
  if (!group) group = (await api('POST', '/betaGroups', { data: { type: 'betaGroups', attributes: { name: 'Household', isInternalGroup: true, hasAccessToAllBuilds: false }, relationships: { app: { data: { type: 'apps', id: selectedApp.id } } } } })).data;
  if (group.attributes.hasAccessToAllBuilds !== false) throw new Error('Household must use explicit build distribution, without automatic access to all uploads');
  const testers = await all(api, `/betaTesters?filter[betaGroups]=${group.id}&limit=200`);
  const actual = testers.map(tester => tester.attributes.email.toLowerCase()).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expectedTesters.map(email => email.toLowerCase()).sort())) throw new Error('The internal group must contain exactly the two configured household testers before distribution');
  const before = (await api('GET', `/builds/${selected.id}/buildBetaDetail`)).data.attributes;
  if (!['READY_FOR_BETA_TESTING', 'IN_BETA_TESTING'].includes(before.internalBuildState)) throw new Error(`Build is not ready for internal distribution: ${before.internalBuildState}`);
  const existing = await all(api, `/betaGroups/${group.id}/builds?limit=200`);
  if (!existing.some(item => item.id === selected.id)) await api('POST', `/betaGroups/${group.id}/relationships/builds`, { data: [{ type: 'builds', id: selected.id }] });
  const membership = await all(api, `/betaGroups/${group.id}/builds?limit=200`);
  if (!membership.some(item => item.id === selected.id)) throw new Error('Apple did not confirm the build in the internal group');
  const detail = (await api('GET', `/builds/${selected.id}/buildBetaDetail`)).data.attributes;
  if (detail.internalBuildState !== 'IN_BETA_TESTING') throw new Error(`Build is attached but not yet installable: ${detail.internalBuildState}. Re-run distribute later.`);
  // This is only an announcement proposal. Changing the host is a separate guarded release.
  return { appId: selectedApp.id, buildId: selected.id, build: buildNumber, version, groupId: group.id, testerCount: testers.length, expirationDate: selected.attributes.expirationDate, confirmedAt: new Date().toISOString(), announcement: { IOS_APP_LATEST_BUILD: String(buildNumber), IOS_APP_UPDATE_URL: `https://testflight.apple.com/v1/app/${selectedApp.id}` } };
}
