import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pluginDir = path.dirname(fileURLToPath(import.meta.url));
const coreRoot = fs.existsSync(path.join(pluginDir, 'runtime/utils/tsdk-runtime.js'))
  ? path.join(pluginDir, 'runtime') : path.resolve(pluginDir, '../../../core/src');
const { createGatewayToken } = require(path.join(coreRoot, 'utils/gateway-token.js'));
const { CONFIG } = require(path.join(coreRoot, 'config/config.js'));
const USER_SERVICE = 'gamepb.userpb.UserService';
const FRIEND_SERVICE = 'gamepb.friendpb.FriendService';
let protocolPromise;

function dependency(name) {
  try { return require(name); }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    return createRequire(path.join(coreRoot, 'utils/proto.js'))(name);
  }
}

export function loadFarmProtocol() {
  if (!protocolPromise) {
    const protobuf = dependency('protobufjs');
    protocolPromise = new protobuf.Root().load(
      ['game.proto', 'userpb.proto', 'friendpb.proto'].map(name => path.join(coreRoot, 'proto', name)),
      { keepCase: true },
    ).then(root => ({
      GateMessage: root.lookupType('gatepb.Message'),
      LoginRequest: root.lookupType('gamepb.userpb.LoginRequest'),
      LoginReply: root.lookupType('gamepb.userpb.LoginReply'),
      SyncAllRequest: root.lookupType('gamepb.friendpb.SyncAllRequest'),
      FriendReply: root.lookupType('gamepb.friendpb.SyncAllReply'),
    })).catch(error => { protocolPromise = null; throw error; });
  }
  return protocolPromise;
}

function loginBody(types, version) {
  return types.LoginRequest.encode(types.LoginRequest.create({
    device_info: { client_version: version, sys_software: 'Windows', network: 'wifi', memory: 7672 },
    scene_id: '1234567', report_data: { minigame_channel: 'other-qq', minigame_platid: 2 },
  })).finish();
}

async function exchange(socket, runtime, types, version, openIds, timeoutMs) {
  return new Promise(resolve => {
    let settled = false;
    let stage = 'Login';
    let clientSeq = 0;
    let serverSeq = 0;
    let ownGid = 0;
    let ownOpenId = '';
    let syncIds = openIds;
    let expected;
    const finish = (error = '', gids = [], friendOpenIds = openIds) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ gids, friendOpenIds, error });
    };
    const timer = setTimeout(() => finish(`农场 ${stage} 回包超时`), timeoutMs);
    function send(service, method, body, token = createGatewayToken()) {
      clientSeq += 1;
      stage = method;
      expected = { service, method, seq: clientSeq };
      socket.send(types.GateMessage.encode(types.GateMessage.create({
        meta: { service_name: service, method_name: method, message_type: 1, client_seq: clientSeq, server_seq: serverSeq },
        body: body.length ? runtime.encrypt(body) : body,
        auth_token: token,
      })).finish());
    }
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => {
      try { send(USER_SERVICE, 'Login', loginBody(types, version)); }
      catch { finish('农场登录请求编码或发送失败'); }
    };
    socket.onmessage = async event => {
      if (settled) return;
      try {
        let raw = event.data;
        if (raw && typeof raw.arrayBuffer === 'function') raw = await raw.arrayBuffer();
        if (settled) return;
        const envelope = types.GateMessage.decode(Buffer.from(raw));
        const meta = envelope.meta;
        if (!meta) return;
        const receivedSeq = Number(meta.server_seq);
        if (Number.isSafeInteger(receivedSeq) && receivedSeq > serverSeq) serverSeq = receivedSeq;
        if (meta.message_type !== 2 || !expected || Number(meta.client_seq) !== expected.seq
            || meta.service_name !== expected.service || meta.method_name !== expected.method) return;
        if (Number(meta.error_code)) {
          // Never echo arbitrary server messages that may contain credentials.
          return finish(`农场 ${stage} 返回错误 ${Number(meta.error_code)}${Number(meta.error_code) === 1000020 ? ': 请求参数错误' : ''}`);
        }
        if (stage === 'Login') {
          const login = types.LoginReply.decode(envelope.body || Buffer.alloc(0));
          ownGid = Number(login.basic?.gid);
          ownOpenId = String(login.basic?.open_id || '').toUpperCase();
          if (!Number.isSafeInteger(ownGid) || ownGid <= 0 || !ownOpenId) return finish('农场登录回包缺少有效用户身份');
          runtime.bindUser(ownOpenId);
          // The official client removes the current account before SyncAll,
          // and still sends SyncAll when its verified friend list is empty.
          syncIds = openIds.filter(id => id !== ownOpenId);
          const body = types.SyncAllRequest.encode({ open_ids: syncIds }).finish();
          send(FRIEND_SERVICE, 'SyncAll', body, runtime.getEncryptedInitInfo() || createGatewayToken());
          return;
        }
        const reply = types.FriendReply.decode(envelope.body || Buffer.alloc(0));
        const friends = reply.game_friends || [];
        const gids = [...new Set(friends.map(friend => Number(friend.gid)))];
        if (gids.some(gid => !Number.isSafeInteger(gid) || gid <= 0)) return finish('农场好友回包包含无效 GID');
        const friendOpenIds = [...new Set([...openIds, ...friends.map(friend => String(friend.open_id || '').toUpperCase())])]
          .filter(openId => /^[0-9A-F]{32}$/.test(openId) && openId !== ownOpenId);
        finish('', gids.filter(gid => gid !== ownGid && gid !== 10001), friendOpenIds);
      } catch { finish(`农场 ${stage} 协议解析或发送失败`); }
    };
    socket.onerror = () => finish(`农场 ${stage} WebSocket 连接失败`);
    socket.onclose = () => finish(`农场 ${stage} 完成前 WebSocket 已关闭`);
  });
}

export async function syncFarmGids(code, { clientVersion = CONFIG.clientVersion, friendOpenIds, timeoutMs = 25000 } = {}, dependencies = {}) {
  if (!Array.isArray(friendOpenIds)) throw new Error('缺少已验证的 QQ 好友关系，不能查询全量农场 GID');
  const openIds = [...new Set(friendOpenIds.map(value => String(value).trim().toUpperCase()))];
  if (openIds.some(value => !/^[0-9A-F]{32}$/.test(value))) throw new Error('QQ 好友关系包含无效 OpenID');
  const version = String(clientVersion || CONFIG.clientVersion);
  if (!/^\d+(?:\.\d+){2,4}_\d{8}$/.test(version)) throw new Error('农场 clientVersion 格式错误（不能使用 QQ 客户端版本）');
  const types = await loadFarmProtocol();
  const WebSocketImpl = dependencies.WebSocket || globalThis.WebSocket || dependency('ws');
  const Runtime = dependencies.Runtime || require(path.join(coreRoot, 'utils/tsdk-runtime.js')).TsdkRuntime;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-napcat-'));
  let runtime;
  let socket;
  try {
    runtime = new Runtime({
      accountId: 'napcat-login', appId: '1112386029', gameId: CONFIG.tsdkGameId, appKey: CONFIG.tsdkAppKey, dataDir,
      deviceInfo: { deviceModel: 'Windows', deviceBrand: 'Microsoft', deviceId: 'NapCat', platform: 'Windows', system: 'Windows' },
    });
    await runtime.init();
    const url = new URL(CONFIG.serverUrl);
    url.search = new URLSearchParams({ os: 'Windows', ver: version, code, platform: 'qq' }).toString();
    socket = new WebSocketImpl(url.toString());
    return await exchange(socket, runtime, types, version, openIds, timeoutMs);
  } finally {
    try { socket?.close(); }
    finally {
      try { runtime?.destroy(); }
      finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
    }
  }
}
