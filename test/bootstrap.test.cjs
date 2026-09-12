const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { patchContainerRestart } = require('../bootstrap.cjs');

const runtime = `async function pAe(t, e) {
  Si.postMessage({ type: "restart-prepare" });
  await lAe(r);
}
async function Ng(t = !0, e, n) { return 'unchanged'; }`;

test('container restart exits once after allowing the HTTP response to flush', async () => {
  const pending = [];
  const exits = [];
  const context = vm.createContext({ gm: false, Zt: { log() {} },
    process: { exit: code => exits.push(code) },
    setTimeout: (callback, delay) => pending.push({ callback, delay }),
  });
  vm.runInContext(patchContainerRestart(runtime), context);
  await vm.runInContext('pAe()', context);
  await vm.runInContext('pAe()', context);
  assert.equal(pending.length, 1, 'Concurrent restart requests must coalesce');
  assert.deepEqual(exits, [], 'Do not exit before the HTTP response is sent');
  assert.equal(pending[0].delay, 250);
  pending[0].callback();
  assert.deepEqual(exits, [75]);
  assert.equal(await vm.runInContext('Ng()', context), 'unchanged');
});

test('patch is idempotent and refuses an unsupported bundle', () => {
  const patched = patchContainerRestart(runtime);
  assert.equal(patchContainerRestart(patched), patched);
  assert.throws(() => patchContainerRestart('new runtime'), /Unsupported NapCat/);
  assert.throws(() => patchContainerRestart(runtime + runtime), /Unsupported NapCat/);
  assert.throws(() => patchContainerRestart(runtime.replace('await lAe(r);', 'changed();')), /Unsupported NapCat/);
});
