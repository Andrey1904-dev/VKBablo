import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const valid = {
  VITE_BACKEND_MODE: 'supabase',
  VITE_SUPABASE_URL: 'https://rxzpgxejhfubenllfrpb.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'sb_publishable_wwi8T0SLJzEV8TV2JzrvUw_U2IuTf_n',
};

test('Pages cloud deployment fails closed for missing, foreign and server configuration', () => {
  const cases: [string, Record<string, string>, boolean][] = [
    ['valid test project', valid, true],
    ['missing config', {}, false],
    ['auto missing config', { VITE_BACKEND_MODE: 'auto' }, false],
    ['missing key', { ...valid, VITE_SUPABASE_ANON_KEY: '' }, false],
    ['foreign URL', { ...valid, VITE_SUPABASE_URL: 'https://other.supabase.co' }, false],
    ['foreign publishable key', { ...valid, VITE_SUPABASE_ANON_KEY: 'sb_publishable_other_project_key_1234567890' }, false],
    ['server key', { ...valid, VITE_SUPABASE_ANON_KEY: 'sb_secret_server_key' }, false],
    ['legacy JWT', { ...valid, VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiJ9.server.signature' }, false],
    ['local server', { ...valid, VITE_BACKEND_MODE: 'local' }, false],
    ['explicit demo', { VITE_BACKEND_MODE: 'demo' }, true],
  ];
  for (const [name, config, accepted] of cases) {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('VITE_')) delete env[key];
    const result = spawnSync(process.execPath, ['scripts/validate-pages-config.mjs'], { env: { ...env, ...config }, encoding: 'utf8' });
    assert.equal(result.status === 0, accepted, name);
    if (config.VITE_SUPABASE_ANON_KEY) assert.ok(!(result.stdout + result.stderr).includes(config.VITE_SUPABASE_ANON_KEY), `${name}: key must not be logged`);
  }
});
