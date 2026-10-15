// Public build inputs only. Never print key values in CI logs.
const mode = (process.env.VITE_BACKEND_MODE || 'supabase').trim();
if (!['supabase', 'demo', 'auto'].includes(mode)) throw Error('Pages supports supabase, demo or auto; local requires a Node server.');
const url = (process.env.VITE_SUPABASE_URL || '').trim();
const key = (process.env.VITE_SUPABASE_ANON_KEY || '').trim();
if (mode !== 'demo') {
  if (url !== 'https://rxzpgxejhfubenllfrpb.supabase.co') throw Error('Pages must use the approved test Supabase URL. Set repository VITE_SUPABASE_URL.');
  if (key !== 'sb_publishable_wwi8T0SLJzEV8TV2JzrvUw_U2IuTf_n') throw Error('Set repository VITE_SUPABASE_ANON_KEY to the test project public publishable key. Server keys are forbidden.');
}
console.log(`Pages configuration valid: ${mode}`);
