import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
// Packaged NapCat carries these dependencies; core tests use the workspace copy.
const protobuf = require(require.resolve('protobufjs', { paths: [
  fileURLToPath(new URL('.', import.meta.url)),
  fileURLToPath(new URL('../../../core/', import.meta.url)),
] }));
const FRIEND_COMMAND = 'miniapp.trpc.minigame.transfer.transfer.HTTPTransfer';
const FRIEND_URL = 'http://fakeapi.qq.com/get_friend_storage';
const AUTHORIZE_URL = 'http://fakeapi.qq.com/auth_user_info_and_friendship';

// Official QQ miniapp path: httpToSsoRequest -> HTTPTransfer.  This is the
// friend-storage API used by QqPlatformUtil; getRelationUinToOpenID requires a
// separate appidtoken and cannot be used for the farm friend list.
const root = protobuf.parse(`
  syntax = "proto3";
  message QWebRequest { bytes busiBuff = 4; }
  message QWebReply { int64 retCode = 2; bytes errMsg = 3; bytes busiBuff = 4; }
  message HttpRequest {
    string appid = 1; string method = 2; string url = 3;
    string header = 4; bytes body = 5;
  }
  message HttpReply { int32 status_code = 1; string header = 2; bytes body = 3; }
`, { keepCase: true }).root;
const QWebRequest = root.lookupType('QWebRequest');
const QWebReply = root.lookupType('QWebReply');
const HttpRequest = root.lookupType('HttpRequest');
const HttpReply = root.lookupType('HttpReply');

function decodeResponse(raw) {
  let envelope;
  try { envelope = QWebReply.decode(raw); } catch { throw new Error('QQ 好友接口 QWeb 回包解析失败'); }
  if (Number(envelope.retCode)) {
    const needsAuthorization = Number(envelope.retCode) === 72622 && /not authed/.test(Buffer.from(envelope.errMsg).toString());
    const error = new Error(`QQ 好友接口 QWeb 返回错误 ${envelope.retCode}${needsAuthorization ? ': 小程序好友资料未授权' : ''}`);
    error.needsAuthorization = needsAuthorization;
    throw error;
  }
  if (!envelope.busiBuff.length) throw new Error('QQ 好友接口 QWeb 回包缺少业务数据');
  let response;
  try { response = HttpReply.decode(envelope.busiBuff); } catch { throw new Error('QQ 好友接口 HTTPTransfer 回包解析失败'); }
  if (response.status_code !== 200) throw new Error(`QQ 好友接口返回 HTTP ${response.status_code}`);
  let payload;
  try { payload = JSON.parse(Buffer.from(response.body).toString('utf8')); } catch { throw new Error('QQ 好友接口返回无效 JSON'); }
  for (const key of ['ret', 'ret_code', 'code']) {
    if (payload?.[key] !== undefined && Number(payload[key]) !== 0) {
      const code = Number(payload[key]);
      throw new Error(`QQ 好友接口返回业务错误 ${Number.isFinite(code) ? code : '未知'}`);
    }
  }
  return payload;
}

function decodeFriends(raw) {
  const payload = decodeResponse(raw);
  if (!Array.isArray(payload?.data)) throw new Error('QQ 好友接口未返回完整好友列表');
  const openIds = payload.data.map(friend => String(friend?.openid || '').trim().toUpperCase());
  if (openIds.some(id => !/^[0-9A-F]{32}$/.test(id))) throw new Error('QQ 好友列表包含无效 OpenID');
  return [...new Set(openIds)];
}

async function request(operation, appId, url, params, deadline) {
  const timeoutMs = deadline - Date.now();
  if (timeoutMs <= 0) throw new Error('QQ 好友接口请求超时');
  const body = Buffer.from(JSON.stringify({ appid: String(appId), ...params }));
  const header = JSON.stringify({ 'content-type': 'application/json' });
  const business = HttpRequest.encode({ appid: String(appId), method: 'POST', url, header, body }).finish();
  const request = QWebRequest.encode({ busiBuff: business }).finish();
  let timer;
  let response;
  try {
    response = await Promise.race([
      Promise.resolve().then(() => operation.sendPacket({ cmd: FRIEND_COMMAND, data: Buffer.from(request) }, true))
        .catch(() => { throw new Error('QQ 好友接口 SSO 请求失败'); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('QQ 好友接口请求超时')), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
  if (!Buffer.isBuffer(response) && !(response instanceof Uint8Array)) throw new Error('QQ 好友接口 SSO 未返回数据');
  return response;
}

export async function getFriendOpenIds(ctx, appId, timeoutMs = 30000) {
  if (!/^\d{6,20}$/.test(String(appId))) throw new Error('QQ 小程序 appId 无效');
  const operation = ctx?.core?.apis?.PacketApi?.pkt?.operation;
  if (typeof operation?.sendPacket !== 'function') throw new Error('NapCat SSO 发包通道不可用');
  const deadline = Date.now() + timeoutMs;
  const query = async () => decodeFriends(await request(operation, appId, FRIEND_URL, { keyList: ['uid', 'lvl'] }, deadline));
  try { return await query(); }
  catch (error) {
    if (!error.needsAuthorization) throw error;
    // Official WelcomeUI -> QqPlatformUtil.directQQAuthorize, within the
    // user-requested miniapp login. A denied authorization is never bypassed.
    decodeResponse(await request(operation, appId, AUTHORIZE_URL, {}, deadline));
    return await query();
  }
}

export { decodeFriends };
