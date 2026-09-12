import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { plugin_init } from '../plugins/qq-miniapp-openauth/index.mjs';

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function logoutHandler(logout) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'napcat-plugin-test-'));
  const configPath = path.join(directory, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ token: 'test-token' }));
  const routes = new Map();
  const ctx = {
    configPath,
    router: {
      getNoAuth(route, handler) { routes.set(`GET ${route}`, handler); },
      postNoAuth(route, handler) { routes.set(`POST ${route}`, handler); },
    },
    core: { context: { session: { getLoginService: () => ({ logout }) } } },
  };
  try {
    await plugin_init(ctx);
    return routes.get('POST /logout');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('logout response never exposes the native result', async () => {
  const handler = await logoutHandler(async () => ({ token: 'must-not-leak', session: 'private' }));
  const res = response();
  await handler({ headers: { authorization: 'Bearer test-token' } }, res);
  assert.deepEqual(res.body, { ok: true, loggedOut: true, method: 'logout' });
});

test('logout failure does not expose the native error message', async () => {
  const handler = await logoutHandler(async () => { throw new Error('private account path'); });
  const res = response();
  await handler({ headers: { authorization: 'Bearer test-token' } }, res);
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { ok: false, error: 'NapCat logout failed' });
});
