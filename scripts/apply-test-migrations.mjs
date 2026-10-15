#!/usr/bin/env node
/** Exact-project installer for the authorized disposable VKBablo project.
 * Historical SQL helpers need deferred validation until all tables exist.
 * Each original source and its history entry are committed in one transaction.
 * Default is plan-only. No token/password is accepted as a command argument.
 */
import {readFileSync,readdirSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawnSync} from 'node:child_process';
const ref='rxzpgxejhfubenllfrpb';
if(readFileSync('supabase/.temp/project-ref','utf8').trim()!==ref)throw Error('Wrong linked project; refusing changes');
function cli(args){const r=spawnSync('supabase',[...args,'--agent','yes','--output-format','json'],{encoding:'utf8'});if(r.status!==0)throw Error(r.stderr||r.stdout);return JSON.parse(r.stdout);}
// migration list initializes the history schema; its human table output is ignored.
const historyInit=spawnSync('supabase',['migration','list','--linked'],{encoding:'utf8'});
if(historyInit.status!==0)throw Error('Cannot read migration history');
const history=cli(['db','query','--linked','--project-ref',ref,'select version from supabase_migrations.schema_migrations order by version;']);
const applied=new Set(history.rows.map(x=>x.version));
const files=readdirSync('supabase/migrations').filter(x=>x.endsWith('.sql')).sort();
if([...applied].some(v=>!files.some(f=>f.startsWith(v+'_'))))throw Error('Unknown remote migration; inspect first');
const pending=files.filter(f=>!applied.has(f.split('_')[0]));
console.log('Target:',ref,'Pending:',pending);
if(!process.argv.includes('--apply')){console.log('Plan only; use --apply for this disposable project');process.exit(0);}
const state=cli(['db','query','--linked','--project-ref',ref,"select (select count(*) from pg_tables where schemaname='public') as tables,(select count(*) from auth.users) as users;"]).rows[0];
if(applied.size===0&&(Number(state.tables)!==0||Number(state.users)!==0))throw Error('Unexpected pre-existing data; refusing installation');
const dir=mkdtempSync(join(tmpdir(),'vkbablo-migrations-'));
try{for(const file of pending){
 const source=readFileSync('supabase/migrations/'+file,'utf8');
 // Strip only explicit top-level transaction lines, keeping the recorded original bytes.
 const body=source.replace(/^\s*(?:begin|commit);\s*$/gmi,'');
 const version=file.split('_')[0],name=file.slice(version.length+1,-4);
 const quote=s=>"'"+s.replaceAll("'","''")+"'";
 const sql="begin; set local check_function_bodies=off; set local search_path=public,app,extensions;\n"+body+`\ninsert into supabase_migrations.schema_migrations(version,name,statements) values (${quote(version)},${quote(name)},array[${quote(source)}]); commit; select ${quote(file)} as applied;`;
 const path=join(dir,'migration.sql');writeFileSync(path,sql,{mode:0o600});
 cli(['db','query','--linked','--project-ref',ref,'--file',path]);console.log('Applied:',file);
}}finally{rmSync(dir,{recursive:true,force:true});}
console.log('Run db lint and all SQL fixtures next; installation is not runtime proof.');
