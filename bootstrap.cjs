const fs = require('node:fs');

function patchContainerRestart(source) {
  // Replacing only the worker can kill live Electron services or hang QQ's
  // native initialization. Exit the full runtime so Docker starts a fresh one.
  const start = 'async function pAe(t, e) {';
  const end = '\nasync function Ng(t = !0, e, n) {';
  const replacement = `async function pAe() {
  if (gm) return;
  gm = !0;
  Zt.log("[NapCat] Restarting container runtime");
  setTimeout(() => process.exit(75), 250);
}`;
  if (source.includes(replacement)) return source;
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  if (source.split(start).length !== 2 || source.split(end).length !== 2 || last <= first
    || !source.slice(first, last).includes('Si.postMessage({ type: "restart-prepare" })')
    || !source.slice(first, last).includes('await lAe(r);')) {
    throw new Error('Unsupported NapCat restart implementation; review the pinned image before upgrading');
  }
  return source.slice(0, first) + replacement + source.slice(last);
}

module.exports = { patchContainerRestart };

if (process.versions.electron) {
  const { app } = require('electron');
  app.disableHardwareAcceleration();
  try {
    const runtimePath = '/app/napcat/napcat.mjs';
    const source = fs.readFileSync(runtimePath, 'utf8');
    const patched = patchContainerRestart(source);
    if (patched !== source) fs.writeFileSync(runtimePath, patched);
    console.info('[NapCat] Container restart compatibility patch ready');
    import('file:///app/napcat/napcat.mjs').catch(() => {
      console.error('[NapCat] Runtime failed to load');
      app.exit(1);
    });
  } catch (error) {
    console.error(`[NapCat] Startup failed: ${error.message}`);
    app.exit(1);
  }
}
