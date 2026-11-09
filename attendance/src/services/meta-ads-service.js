// Read-only marketing report. Never runs in the webhook or message-send path.
const crypto = require('node:crypto');
const { Prisma } = require('@prisma/client');
const fail = (message, statusCode=400) => Object.assign(new Error(message), {statusCode});
const validId = value => /^\d{5,40}$/.test(String(value || ''));
const numeric = value => Number.isFinite(Number(value)) && Number(value)>=0 ? Number(value) : 0;
const optionalNumber = value => value == null || value === '' || !Number.isFinite(Number(value)) || Number(value) < 0 ? null : Number(value);
const METRIC_FIELDS = 'spend,impressions,clicks,inline_link_clicks,reach,actions';
const day = value => {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw fail('Data inválida.');
  const date=new Date(value+'T00:00:00.000Z');
  if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==value) throw fail('Data inválida.');
  return date;
};
function range(query={}, now=new Date()) {
  const today=new Date(now.getTime()-3*3600000).toISOString().slice(0,10);
  const end=day(query.to||today);const start=query.from?day(query.from):new Date(end.getTime()-29*86400000);
  if(start>end||end-start>92*86400000||start<day('2000-01-01')||end>day(today)) throw fail('Escolha até 93 dias, sem datas futuras.');
  return {from:start.toISOString().slice(0,10),to:end.toISOString().slice(0,10),start:new Date(start.getTime()+3*3600000),end:new Date(end.getTime()+27*3600000)};
}
function origins(rows) {
  const contacts=new Map(), ads=new Map();
  // Rows are oldest-first; one contact is attributed only to its first referral
  // inside this period/company. A missing referral is never called organic.
  for(const row of rows) {
    if(contacts.has(row.contactId)) continue;
    const sourceId=String(row.sourceId||'');
    const key=row.sourceType==='ad'&&validId(sourceId)?sourceId:'unresolved';
    const contact={id:row.contactId,name:row.name||'Contato',phone:row.phone||null,conversationId:row.conversationId,receivedAt:row.occurredAt,sourceId:key==='unresolved'?null:key};
    contacts.set(row.contactId,contact);
    if(!ads.has(key)) ads.set(key,{adId:key,headline:String(row.headline||'').slice(0,200),contacts:[]});
    ads.get(key).contacts.push(contact);
  }
  return {contacts:[...contacts.values()],ads:[...ads.values()]};
}
function insightMetrics(row) {
  const actions=Array.isArray(row.actions)?row.actions:[];
  const conversations=actions.find(x=>x.action_type==='onsite_conversion.messaging_conversation_started_7d');
  return {
    spend: numeric(row.spend), clicks: numeric(row.clicks), impressions: numeric(row.impressions),
    linkClicks: optionalNumber(row.inline_link_clicks), reach: optionalNumber(row.reach),
    metaConversations: optionalNumber(conversations?.value),
  };
}
function normalizeInsight(row,account) {
  const metrics = insightMetrics(row);
  const { spend, clicks, impressions } = metrics;
  return {adAccountId:account.id,currency:account.currency,timezone:account.timezone_name||null,adId:String(row.ad_id),adName:String(row.ad_name||row.ad_id),campaignId:String(row.campaign_id||''),campaignName:String(row.campaign_name||'Sem campanha informada'),adsetId:String(row.adset_id||''),adsetName:String(row.adset_name||''),...metrics,ctr:impressions?clicks/impressions*100:0,cpc:clicks?spend/clicks:null};
}
function createService(options={}) {
  const db=options.db||require('../database/prisma');
  const auth=options.authorization||require('./authorization-service');
  const companies=options.companies||require('./company-service');
  const vault=options.vault||require('./channels/integration-secret-service');
  const fetchImpl=options.fetchImpl||global.fetch;
  const clock=options.clock||(()=>new Date());
  const cache=new Map(),pending=new Map();
  async function scope(viewer,query) {
    auth.assertMaster(viewer);
    if(!query.company||String(query.company).includes(',')) throw fail('Selecione uma empresa.');
    const ids=await companies.resolveCompanyFilter(viewer,query.company);
    if(ids.length!==1) throw fail('Selecione apenas uma empresa.');
    const accounts=await db.channelAccount.findMany({where:{companyId:ids[0],channel:'META'},orderBy:{id:'asc'}});
    const sources=[];const seen=new Set();
    for(const a of accounts){
      const token=vault.decryptSecrets(a).metaAdsAccessToken;
      if(!token)continue;
      const digest=crypto.createHash('sha256').update(token).digest('hex');
      if(seen.has(digest))continue;seen.add(digest);
      const version=String(a.config?.graphVersion||process.env.GRAPH_VERSION||'');
      if(!/^v\d+\.\d+$/.test(version)) throw fail('Versão Graph API não configurada.',503);
      sources.push({token,version,digest});
    }
    return {companyId:ids[0],sources,signature:sources.map(x=>x.digest+':'+x.version).join('|')};
  }
  async function graph(source,endpoint,params={},timeoutMs=12000) {
    const url=new URL('https://graph.facebook.com/'+source.version+'/'+endpoint);
    for(const[k,v]of Object.entries(params))url.searchParams.set(k,String(v));
    let response;
    try{response=await fetchImpl(url,{headers:{Authorization:'Bearer '+source.token},signal:AbortSignal.timeout(timeoutMs)});}catch{throw fail('A Meta demorou a responder. Tente novamente.',502);}
    const json=await response.json().catch(()=>({}));
    if(!response.ok||json.error)throw fail('Consulta Meta indisponível (código '+(Number(json.error?.code)||response.status)+'). Confira o acesso de anúncios.',502);
    return json;
  }
  async function pages(source,endpoint,params,maxPages=10) {
    const data=[];let after;
    for(let i=0;i<maxPages;i++){
      const json=await graph(source,endpoint,{...params,limit:100,...(after?{after}:{})});
      if(!Array.isArray(json.data))throw fail('Resposta inesperada da Meta.',502);
      data.push(...json.data);
      if(!json.paging?.next)return {data,truncated:false};
      after=json.paging?.cursors?.after;
      if(typeof after!=='string'||after.length>2048)throw fail('Paginação Meta inválida.',502);
    }
    return {data,truncated:true};
  }
  async function memo(key,loader) {
    const hit=cache.get(key);if(hit&&hit.until>Date.now())return hit.value;
    if(pending.has(key))return pending.get(key);
    const job=Promise.resolve().then(loader).then(value=>{
      const bytes=Buffer.byteLength(JSON.stringify(value));
      if(bytes<=512*1024){
        for(const[k,v]of cache)if(v.until<=Date.now())cache.delete(k);
        while(cache.size>=12)cache.delete(cache.keys().next().value);
        cache.set(key,{value,until:Date.now()+300000});
      }
      return value;
    }).finally(()=>pending.delete(key));
    pending.set(key,job);return job;
  }
  async function adAccounts(scoped) {
    return memo('accounts:'+scoped.companyId+':'+scoped.signature,async()=>{
      const all=[];const seen=new Set();
      for(let i=0;i<scoped.sources.length;i++){
        const result=await pages(scoped.sources[i],'me/adaccounts',{fields:'id,name,currency,timezone_name,account_status'},2);
        if(result.truncated)throw fail('Muitas contas de anúncios. Restrinja o acesso do token à empresa desejada.',422);
        for(const a of result.data)if(/^act_\d{5,40}$/.test(a.id)&&!seen.has(a.id)){seen.add(a.id);all.push({...a,sourceIndex:i});}
      }
      return all;
    });
  }
  async function loadOrigins(companyId,r) {
    if(options.loadOrigins)return options.loadOrigins(companyId,r);
    return db.$transaction(async tx=>{
      await tx.$executeRaw`SET LOCAL statement_timeout = '3000ms'`;
      return tx.$queryRaw(Prisma.sql`
        SELECT m."occurredAt",c."contactId",c.id AS "conversationId",
          COALESCE(t."customName",t.name) AS name,t.phone,
          m."rawPayload"->'referral'->>'source_id' AS "sourceId",
          m."rawPayload"->'referral'->>'source_type' AS "sourceType",
          m."rawPayload"->'referral'->>'headline' AS headline
        FROM "Conversation" c JOIN "Message" m ON m."conversationId"=c.id
        JOIN "Contact" t ON t.id=c."contactId" AND t."companyId"=c."companyId"
        WHERE c."companyId"=${companyId} AND m.channel='META' AND m.direction='RECEBIDA'
          AND m."privateCategoryId" IS NULL AND m."occurredAt">=${r.start} AND m."occurredAt"<${r.end}
          AND jsonb_typeof(m."rawPayload"->'referral')='object'
        ORDER BY m."occurredAt",m.id LIMIT 5001
      `);
    },{timeout:5000});
  }
  async function getAccounts(viewer,query={}) {
    const scoped=await scope(viewer,query);const accounts=await adAccounts(scoped);
    return {companyId:scoped.companyId,configured:scoped.sources.length>0,accounts:accounts.map(({id,name,currency,timezone_name})=>({id,name,currency,timezone:timezone_name}))};
  }
  async function getReport(viewer,query={}) {
    const scoped=await scope(viewer,query);const r=range(query,clock());
    if(!/^act_\d{5,40}$/.test(String(query.adAccountId||'')))throw fail('Selecione uma conta de anúncios.');
    const available=await adAccounts(scoped);const account=available.find(x=>x.id===query.adAccountId);
    if(!account)throw fail('Conta de anúncios não disponível nesta empresa.',403);
    return memo('report:'+scoped.companyId+':'+scoped.signature+':'+account.id+':'+r.from+':'+r.to,async()=>{
      const warnings=[];
      const source = scoped.sources[account.sourceIndex];
      const endpoint = account.id + '/insights';
      const timeRange = JSON.stringify({ since: r.from, until: r.to });
      const [local, remote, accountReport] = await Promise.allSettled([
        loadOrigins(scoped.companyId, r),
        pages(source, endpoint, { level: 'ad', fields: 'ad_id,ad_name,campaign_id,campaign_name,adset_id,adset_name,' + METRIC_FIELDS, time_range: timeRange }),
        graph(source, endpoint, { level: 'account', fields: METRIC_FIELDS, time_range: timeRange }, 4000),
      ]);
      if(local.status==='rejected')throw fail('Não foi possível consultar as origens locais. Tente um período menor.',503);
      const raw=local.value;const origin=origins(raw.slice(0,5000));
      if(raw.length>5000)warnings.push('Origens locais limitadas aos primeiros 5.000 eventos do período. Reduza o intervalo.');
      if(remote.status==='rejected')warnings.push(remote.reason?.statusCode?remote.reason.message:'Não foi possível atualizar os resultados da Meta.');
      if(remote.status==='fulfilled'&&remote.value.truncated)warnings.push('Resultados Meta parciais: limite de 1.000 anúncios. Reduza o período.');
      const rows=remote.status==='fulfilled'?remote.value.data.map(x=>normalizeInsight(x,account)):[];
      const accountRows = accountReport.status === 'fulfilled' ? accountReport.value.data : null;
      const accountMetrics = Array.isArray(accountRows) && accountRows.length === 1 ? insightMetrics(accountRows[0]) : null;
      // Missing IDs can refer to paused/no-delivery ads or a different ad account.
      // Keep them separate; never guess a campaign or include them in its totals.
      const byAd=new Map(origin.ads.map(x=>[x.adId,x]));
      for(const row of rows){row.contacts=byAd.get(row.adId)?.contacts||[];byAd.delete(row.adId);}
      const unmatched=[...byAd.values()];
      const totals=rows.reduce((a,row)=>({spend:a.spend+row.spend,impressions:a.impressions+row.impressions,clicks:a.clicks+row.clicks,matchedContacts:a.matchedContacts+row.contacts.length}),{spend:0,impressions:0,clicks:0,matchedContacts:0});
      return {companyId:scoped.companyId,account:{id:account.id,name:account.name,currency:account.currency,timezone:account.timezone_name},period:{from:r.from,to:r.to},generatedAt:clock().toISOString(),rows,unmatched,totals,accountMetrics,identifiedContacts:origin.contacts.length,warnings,metaAvailable:remote.status==='fulfilled',attribution:'Primeiro anúncio identificado no período por contato e empresa. Sem referral, origem desconhecida. Datas Meta no fuso da conta; entradas locais em America/Sao_Paulo.'};
    });
  }
  return {getAccounts,getReport};
}
let instance;
module.exports={createService,range,origins,normalizeInsight,getAccounts:(...a)=>(instance||=createService()).getAccounts(...a),getReport:(...a)=>(instance||=createService()).getReport(...a)};
