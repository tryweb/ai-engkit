// guard-harness.mjs — asserts the applied AI-EngKit update guards on a patched
// @openchamber/web package. No network, no install, no spawn.
//
// Usage: bun guard-harness.mjs <package-dir>
//
// Covers tasks.md 1.1-1.3:
//   1.1 web update-install route refuses (409) before the original handler and
//       the original detached-spawn handler stays unreachable.
//   1.2 executeUpdate (the `openchamber update` CLI seam) returns a failed result
//       with a nonzero exit code and prints a managed explanation, no spawn.
//   1.3 the managed OpenCode upgrade route refuses (409) before the original.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const pkgDir = process.argv[2];
if (!pkgDir) {
  console.error('usage: bun guard-harness.mjs <package-dir>');
  process.exit(2);
}

let pass = 0;
let fail = 0;
const ok = (label) => { pass += 1; console.log(`  PASS ${label}`); };
const bad = (label, detail = '') => { fail += 1; console.log(`  FAIL ${label}${detail ? ` (${detail})` : ''}`); };
const assert = (cond, label, detail = '') => (cond ? ok(label) : bad(label, detail));

const load = (rel) => pathToFileURL(path.join(pkgDir, rel)).href;

// Minimal Express-shaped recorder: handlers are matched in registration order.
function makeApp() {
  const routes = [];
  return {
    routes,
    post(p, h) { routes.push({ method: 'post', path: p, handler: h }); },
    get(p, h) { routes.push({ method: 'get', path: p, handler: h }); },
    use() {},
    all() {},
    delete() {},
    put() {},
  };
}

function makeRes() {
  return {
    statusCode: undefined,
    body: undefined,
    finished: false,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; this.finished = true; return this; },
    send(body) { this.body = body; this.finished = true; return this; },
    end() { this.finished = true; return this; },
    setHeader(k, v) { this.headers[k] = v; return this; },
    getHeader(k) { return this.headers[k]; },
    type() { return this; },
  };
}

// Invoke a route's handlers in registration order and stop once a handler ends
// the response, exactly as Express does for a matched path.
async function invokeRoute(app, routePath, method = 'post', request = {}) {
  const handlers = app.routes
    .filter((route) => route.method === method && route.path === routePath)
    .map((route) => route.handler);
  const invoked = [];
  const res = makeRes();
  for (let i = 0; i < handlers.length && !res.finished; i += 1) {
    invoked.push(i);
    // eslint-disable-next-line no-await-in-loop
    await handlers[i]({ headers: {}, body: {}, query: {}, ...request }, res);
  }
  return { handlers, invoked, res };
}

// ---- 1.1 web update-install (dynamic) -------------------------------------
{
  const mod = await import(load('server/lib/opencode/openchamber-routes.js'));
  const app = makeApp();
  mod.registerOpenChamberRoutes(app, {
    fs: { existsSync: () => false, promises: {} },
    path,
    process: { env: {} },
    server: { address: () => ({ port: 3000 }) },
    __dirname: pkgDir,
    openchamberDataDir: pkgDir,
    modelsDevApiUrl: '',
    modelsMetadataCacheTtl: 0,
    readSettingsFromDiskMigrated: async () => ({}),
    fetchFreeZenModels: async () => [],
    getCachedZenModels: () => [],
    desktopUpdater: null,
  });

  // Update discovery stays enabled while installation is blocked. Mock both
  // upstream checks at the fetch boundary so this remains network-independent.
  const originalFetch = globalThis.fetch;
  const originalUpdateUrl = process.env.OPENCHAMBER_UPDATE_API_URL;
  process.env.OPENCHAMBER_UPDATE_API_URL = 'https://api.openchamber.dev/v1/update/check';
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/v1/update/check')) {
      return {
        ok: true,
        json: async () => ({ latestVersion: '1.25.0', updateAvailable: true }),
      };
    }
    if (url.includes('registry.npmjs.org/@openchamber/web')) {
      return { ok: true, json: async () => ({ 'dist-tags': { latest: '1.25.0' } }) };
    }
    throw new Error(`unexpected update-check request: ${url}`);
  };
  try {
    const updateCheck = await invokeRoute(
      app,
      '/api/openchamber/update-check',
      'get',
      { query: { appType: 'web', currentVersion: '1.24.2', reportUsage: 'false' } },
    );
    assert(
      updateCheck.res.body && updateCheck.res.body.available === true,
      '1.5 update-check still reports a newer version',
      JSON.stringify(updateCheck.res.body),
    );
    assert(
      updateCheck.res.body && updateCheck.res.body.version === '1.25.0',
      '1.5 update-check preserves the offered version',
      JSON.stringify(updateCheck.res.body),
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUpdateUrl === undefined) {
      delete process.env.OPENCHAMBER_UPDATE_API_URL;
    } else {
      process.env.OPENCHAMBER_UPDATE_API_URL = originalUpdateUrl;
    }
  }

  const { handlers, invoked, res } = await invokeRoute(app, '/api/openchamber/update-install');
  assert(handlers.length >= 2, '1.1 original update-install handler still registered', `count=${handlers.length}`);
  assert(res.statusCode === 409, '1.1 update-install refuses with HTTP 409', `status=${res.statusCode}`);
  assert(
    res.body && typeof res.body.error === 'string' && /image-managed/i.test(res.body.error),
    '1.1 refusal body carries an image-managed error',
    JSON.stringify(res.body),
  );
  assert(res.body && res.body.success === false, '1.1 refusal is not a success acknowledgement');
  assert(
    invoked.length === 1 && invoked[0] === 0,
    '1.1 only the guard ran; original detached-spawn handler unreachable',
    `invoked=[${invoked}]`,
  );
}

// ---- 1.2 CLI executeUpdate seam (dynamic + static no-spawn) ---------------
{
  const mod = await import(load('server/lib/package-manager.js'));
  const result = mod.executeUpdate('bun', { silent: true });
  assert(
    result && result.success === false && result.exitCode === 1,
    '1.2 executeUpdate returns {success:false, exitCode:1}',
    JSON.stringify(result),
  );
  const src = readFileSync(path.join(pkgDir, 'server/lib/package-manager.js'), 'utf8');
  const start = src.indexOf('export function executeUpdate(');
  const body = start === -1 ? '' : src.slice(start, src.indexOf('\n}\n', start));
  assert(start !== -1, '1.2 executeUpdate present');
  assert(!body.includes('spawnSync('), '1.2 refused executeUpdate does not spawn');
}

// ---- 1.3 managed OpenCode upgrade route (static ordering) -----------------
{
  const src = readFileSync(path.join(pkgDir, 'server/lib/opencode/routes.js'), 'utf8');
  const guard = src.indexOf('// AI-ENGKIT-UPDATE-GUARD: begin');
  const original = src.indexOf("app.post('/api/opencode/upgrade', async");
  assert(guard !== -1, '1.3 upgrade guard marker present');
  assert(original !== -1, '1.3 original upgrade handler present');
  assert(guard !== -1 && original !== -1 && guard < original,
    '1.3 guard registered before original upgrade handler',
    `guard=${guard} original=${original}`);
  const guardBlock = src.slice(guard, original);
  assert(guardBlock.includes('res.status(409).json('), '1.3 upgrade guard returns HTTP 409 JSON');
  assert(guardBlock.includes('success: false'), '1.3 upgrade refusal is not a success');
  // The forward to /global/upgrade must only exist in the now-unreachable handler.
  const forward = src.indexOf("buildOpenCodeUrl('/global/upgrade'");
  assert(forward > original, '1.3 /global/upgrade forward is after the guard (unreachable)',
    `forward=${forward} original=${original}`);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
