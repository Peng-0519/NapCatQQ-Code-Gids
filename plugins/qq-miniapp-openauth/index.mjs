import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncFarmGids } from './farm-gid-sync.mjs';
import { getFriendOpenIds } from './qq-friend-relations.mjs';

function config(ctx) {
  try { return JSON.parse(fs.readFileSync(ctx.configPath, 'utf8')); } catch { return {}; }
}
function misc(ctx) { return ctx?.core?.context?.session?.getNodeMiscService?.(); }
function selfProfile(ctx) {
  const info = ctx?.core?.selfInfo || ctx?.core?.context?.selfInfo || ctx?.selfInfo || {};
  return {
    uin: String(info.uin || info.user_id || info.qq || '').trim(),
    nickname: String(info.nickname || info.nickName || info.nick || info.name || '').trim(),
  };
}
function loginService(ctx) {
  return ctx?.core?.context?.session?.getLoginService?.()
    || ctx?.core?.context?.wrapper?.NodeIKernelLoginService?.get?.()
    || ctx?.core?.wrapper?.NodeIKernelLoginService?.get?.();
}
function offlineArg(ctx, service) {
  const core = ctx?.core;
  const info = core?.selfInfo || {};
  const basic = core?.context?.basicInfoWrapper;
  const platform = process.platform === 'darwin' ? 4 : process.platform === 'linux' ? 5 : 3;
  const read = (fn, fallback = '') => {
    try { return fn() ?? fallback; } catch { return fallback; }
  };
  const accountPath = String(read(() => core.dataPath));
  const clientVer = String(read(() => basic?.getFullQQVersion?.()));
  const appid = String(read(() => basic?.QQVersionAppid));
  const platformName = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
  return {
    selfUin: String(info.uin || info.user_id || info.qq || ''),
    selfUid: String(info.uid || info.userUid || ''),
    desktopPathConfig: { account_path: accountPath },
    clientVer,
    a2: '', d2: '', d2Key: '', machineId: '', platform, platVer: platformName, appid,
    rdeliveryConfig: { appKey: '', systemId: 0, appId: '', logicEnvironment: '', platform, language: '', sdkVersion: '', userId: '', appVersion: '', osVersion: '', bundleId: '', serverUrl: '', fixedAfterHitKeys: [''] },
    defaultFileDownloadPath: path.join(accountPath, 'NapCat', 'temp'),
    deviceInfo: { guid: String(read(() => service?.getMachineGuid?.())), buildVer: clientVer, localId: 2052, devName: os.hostname(), devType: platformName, vendorName: '', osVer: platformName, vendorOsName: platformName, vendorType: 0, setMute: false },
    deviceConfig: '{"appearance":{"isSplitViewMode":true},"msg":{}}',
  };
}
function extractCode(value) {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  const direct = String(value.code || value.authorizationCode || value.authCode || '').trim();
  return direct || extractCode(value.result) || extractCode(value.data);
}
function codeFrom(operation, value) {
  const err = Number(value?.errCode ?? value?.errorCode ?? value?.result?.errCode ?? 0);
  if (err !== 0) return '';
  return extractCode(operation === 'loginWithAppId' ? value?.result : value);
}
function authorized(req, res, token) {
  if (token && req.headers.authorization === `Bearer ${token}`) return true;
  res.status(401).json({ ok: false, error: 'Unauthorized' });
  return false;
}

export async function plugin_init(ctx, { syncFriends = syncFarmGids, queryFriends = getFriendOpenIds } = {}) {
  const token = String(config(ctx).token || '');
  let syncing = false;
  ctx.router.getNoAuth('/status', async (req, res) => {
    if (!authorized(req, res, token)) return;
    const service = misc(ctx);
    res.json({ ok: true, ready: Boolean(service), ...selfProfile(ctx), methods: ['checkSessionForMiniApp', 'loginWithAppId', 'getOpenCodeWithAppId', 'getOpenAuth'].filter(name => typeof service?.[name] === 'function') });
  });
  ctx.router.postNoAuth('/miniapp', async (req, res) => {
    if (!authorized(req, res, token)) return;
    const appId = String(req.body?.appId || '');
    if (!/^\d{6,20}$/.test(appId)) return res.status(400).json({ ok: false, error: 'Invalid appId' });
    const service = misc(ctx);
    if (!service) return res.status(503).json({ ok: false, error: 'QQ NodeMiscService is not ready' });
    if (syncing) return res.status(409).json({ ok: false, error: 'NapCat 正在同步农场好友，请等待当前请求完成' });
    syncing = true;
    let stage = 'miniapp_auth';
    try {
      let auth;
      const attempts = [];
      for (const operation of ['checkSessionForMiniApp', 'loginWithAppId', 'getOpenCodeWithAppId', 'getOpenAuth']) {
        if (typeof service[operation] !== 'function') continue;
        try {
          const value = operation === 'getOpenAuth' ? await service[operation](true, appId) : await service[operation](appId);
          const code = codeFrom(operation, value);
          if (code) { auth = { operation, code, value }; break; }
          attempts.push({ operation, error: '未返回授权 Code' });
        } catch { attempts.push({ operation, error: '授权调用失败' }); }
      }
      if (!auth) return res.status(502).json({ ok: false, stage, error: 'QQNT OpenAuth methods returned no authorization code', attempts });
      stage = 'qq_friend_relations';
      const friendOpenIds = await queryFriends(ctx, appId);
      stage = 'farm_websocket';
      const farm = await syncFriends(auth.code, { clientVersion: req.body?.clientVersion, friendOpenIds });
      if (farm.error) throw new Error(farm.error);
      return res.json({ ok: true, operation: auth.operation, code: auth.code, ...selfProfile(ctx), friendOpenIds: farm.friendOpenIds, friendOpenIdCount: farm.friendOpenIds.length, friendGids: farm.gids, friendGidCount: farm.gids.length, gidSync: 'farm_websocket', gidSyncError: '' });
    } catch (error) {
      return res.status(502).json({ ok: false, stage, error: error.message });
    } finally { syncing = false; }
  });
  ctx.router.postNoAuth('/logout', async (req, res) => {
    if (!authorized(req, res, token)) return;
    const service = loginService(ctx);
    try {
      for (const method of ['offline', 'logout', 'logOut', 'signOut']) {
        if (typeof service?.[method] === 'function') {
          await service[method]();
          return res.json({ ok: true, loggedOut: true, method });
        }
      }
      const session = ctx?.core?.context?.session;
      for (const method of ['offLine', 'offLineSync']) {
        if (typeof session?.[method] === 'function') {
          await session[method](offlineArg(ctx, service));
          return res.json({ ok: true, loggedOut: true, method });
        }
      }
      res.status(503).json({ ok: false, error: 'NapCat logout method is unavailable' });
    } catch { res.status(500).json({ ok: false, error: 'NapCat logout failed' }); }
  });
}

export async function plugin_cleanup() {}
