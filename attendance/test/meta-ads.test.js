const test=require('node:test'),assert=require('node:assert/strict');
const {createService,range,origins,normalizeInsight}=require('../src/services/meta-ads-service');
const clock=()=>new Date('2026-11-03T15:00:00Z');
function fixture({company='mibro',failMeta=false,failAccountMetrics=false,rows=[],token='test-ad-token'}={}){
 const calls=[];
 const db={channelAccount:{findMany:async q=>{calls.push(['db',q]);return [{id:company,config:{graphVersion:'v26.0'},token}];}}};
 const svc=createService({db,clock,authorization:{assertMaster:u=>{if(u?.role!=='ADMIN')throw Object.assign(Error('forbidden'),{statusCode:403});}},companies:{resolveCompanyFilter:async(u,c)=>{if(c!==company)throw Object.assign(Error('company forbidden'),{statusCode:403});return [c];}},vault:{decryptSecrets:a=>({metaAdsAccessToken:a.token})},loadOrigins:async(c,r)=>{calls.push(['origins',c,r]);return rows;},fetchImpl:async(url,opts)=>{
  calls.push(['graph',String(url),opts.headers.Authorization]);
  if(String(url).includes('/me/adaccounts'))return {ok:true,json:async()=>({data:[{id:'act_12345',name:'Ads '+company,currency:'BRL',timezone_name:'America/Sao_Paulo'}]})};
  if(failMeta)throw Error('https://untrusted.example/?access_token='+token);
  if(url.searchParams.get('level')==='account'){
   if(failAccountMetrics)throw Error('Conta indisponível');
   return {ok:true,json:async()=>({data:[{spend:'20',clicks:'15',inline_link_clicks:'10',impressions:'200',reach:'125'}]})};
  }
  return {ok:true,json:async()=>({data:[{ad_id:'900001',ad_name:'Campanha <teste>',campaign_id:'700001',campaign_name:'Campanha',adset_id:'800001',adset_name:'Conjunto',spend:'12.50',clicks:'5',inline_link_clicks:'4',impressions:'100',reach:'80',actions:[{action_type:'onsite_conversion.messaging_conversation_started_7d',value:'2'}]}]})};
 }});return {svc,calls};
}
const admin={role:'ADMIN',id:'master'},query={company:'mibro',adAccountId:'act_12345'};
test('dates: Brasília boundary and inclusive end',()=>{const r=range({from:'2026-11-01',to:'2026-11-03'},clock());assert.equal(r.start.toISOString(),'2026-11-01T03:00:00.000Z');assert.equal(r.end.toISOString(),'2026-11-04T03:00:00.000Z');});
test('dates reject nonexistent, reversed, future, excessive range and malformed strings',()=>{for(const q of [{from:'2026-02-30'},{from:'2026-11-03',to:'2026-11-02'},{to:'2027-01-01'},{from:'2025-01-01'},{from:'2026-1-1'}])assert.throws(()=>range(q,clock()));});
test('one contact first referral per period; missing IDs remain unresolved',()=>{const r=origins([{contactId:'a',sourceId:'900001',sourceType:'ad'},{contactId:'a',sourceId:'900002',sourceType:'ad'},{contactId:'b',sourceId:'900001',sourceType:'post'}]);assert.equal(r.contacts.length,2);assert.equal(r.ads[0].contacts.length,1);assert.equal(r.ads[1].adId,'unresolved');});
test('missing conversations action is unavailable, never inferred from clicks',()=>{const r=normalizeInsight({clicks:'5',spend:'10',impressions:'100'},{id:'a',currency:'BRL'});assert.equal(r.metaConversations,null);assert.equal(r.cpc,2);assert.equal(r.ctr,5);});
test('link clicks distinguish zero from metrics omitted by Meta',()=>{const a={id:'a',currency:'BRL'};assert.equal(normalizeInsight({inline_link_clicks:'0'},a).linkClicks,0);assert.equal(normalizeInsight({clicks:'7'},a).linkClicks,null);});
test('master-only check happens before DB/provider',async()=>{const {svc,calls}=fixture();await assert.rejects(svc.getReport({role:'ATENDENTE'},query),{statusCode:403});assert.equal(calls.length,0);});
test('explicit single company required; ALL and foreign company never broaden query',async()=>{const {svc,calls}=fixture();for(const company of ['sincrofit','ALL','mibro,sincrofit',''])await assert.rejects(svc.getAccounts(admin,{company}));assert.equal(calls.length,0);});
test('ad account must be visible to the selected company',async()=>{const {svc}=fixture();await assert.rejects(svc.getReport(admin,{...query,adAccountId:'act_99999'}),{statusCode:403});});
test('report matches only confirmed ad IDs and preserves unmatched contacts',async()=>{const {svc}=fixture({rows:[{contactId:'a',sourceId:'900001',sourceType:'ad'},{contactId:'b',sourceId:'900002',sourceType:'ad'}]});const r=await svc.getReport(admin,query);assert.equal(r.rows[0].contacts.length,1);assert.equal(r.unmatched.length,1);assert.equal(r.totals.spend,12.5);assert.equal(r.totals.matchedContacts,1);assert.equal(r.rows[0].metaConversations,2);});
test('account reach is read from the account and kept separate from ad reach',async()=>{const {svc}=fixture();const r=await svc.getReport(admin,query);assert.equal(r.accountMetrics.reach,125);assert.equal(r.accountMetrics.linkClicks,10);assert.equal(r.rows[0].reach,80);assert.equal(r.rows[0].linkClicks,4);assert.equal(r.rows[0].adsetId,'800001');});
test('account summary failure does not suppress ads and contacts',async()=>{const {svc}=fixture({failAccountMetrics:true});const r=await svc.getReport(admin,query);assert.equal(r.accountMetrics,null);assert.equal(r.metaAvailable,true);assert.equal(r.rows[0].linkClicks,4);});
test('cache deduplicates each level; rechecks authorization and company every time',async()=>{const {svc,calls}=fixture();await Promise.all([svc.getReport(admin,query),svc.getReport(admin,query)]);const levels=calls.filter(c=>c[0]==='graph'&&c[1].includes('/insights')).map(c=>new URL(c[1]).searchParams.get('level'));assert.deepEqual(levels.sort(),['account','ad']);assert.equal(calls.filter(c=>c[0]==='origins').length,1);assert.equal(calls.filter(c=>c[0]==='db').length,2);await assert.rejects(svc.getReport({role:'SUPERVISOR'},query));});
test('provider failures retain local origins and never echo bearer or URL',async()=>{const {svc}=fixture({failMeta:true,rows:[{contactId:'a',sourceId:'900001',sourceType:'ad'}]});const r=await svc.getReport(admin,query);assert.equal(r.metaAvailable,false);assert.equal(r.unmatched[0].contacts.length,1);assert(!JSON.stringify(r).includes('test-ad-token'));assert(!JSON.stringify(r).includes('untrusted.example'));});
test('no token configured: no fallback to WhatsApp credentials',async()=>{const {svc,calls}=fixture({token:null});const r=await svc.getAccounts(admin,{company:'mibro'});assert.equal(r.configured,false);assert.equal(calls.filter(c=>c[0]==='graph').length,0);});
test('Sincrofit service never queries Mibro scope',async()=>{const {svc,calls}=fixture({company:'sincrofit'});const r=await svc.getReport(admin,{...query,company:'sincrofit'});assert.equal(r.companyId,'sincrofit');assert(calls.filter(c=>c[0]==='db').every(c=>c[1].where.companyId==='sincrofit'));});
