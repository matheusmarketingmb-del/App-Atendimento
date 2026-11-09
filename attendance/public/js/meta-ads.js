try{document.documentElement.dataset.theme=localStorage.getItem('mibro-theme')||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');}catch{}
/* Read-only page; no provider or credential is ever exposed to the browser. */
const $=s=>document.querySelector(s),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let report=null,generation=0,controller,searchTimer;
const numbers=new Intl.NumberFormat('pt-BR',{maximumFractionDigits:2});
const currencies=new Map();
const number=v=>numbers.format(v);
function money(value) {
 if(value==null)return '—';
 const currency=report?.account.currency||'BRL';
 if(!currencies.has(currency))currencies.set(currency,new Intl.NumberFormat('pt-BR',{style:'currency',currency}));
 return currencies.get(currency).format(value);
}
const count=v=>v==null?'—':number(v);
const percent=v=>v==null?'—':number(v)+'%';
const ratio=(value,base,scale=1)=>value!=null&&base>0?value/base*scale:null;
async function api(url,signal){const r=await fetch(url,{credentials:'same-origin',signal,cache:'no-store'});if(r.status===401){location.href='/login';throw Error('Sessão encerrada.');}const b=await r.json().catch(()=>({}));if(!r.ok)throw Error(b.error||'Consulta indisponível.');return b;}
function reset(){generation++;controller?.abort();controller=new AbortController();report=null;$('#results').hidden=true;$('#warnings').replaceChildren();$('#status').textContent='';return generation;}
function contactList(contacts){return `<details><summary>Contatos (${contacts.length})</summary>${contacts.map(c=>`<div class="ads-contact"><strong>${esc(c.name)}</strong><span>${esc(c.phone||'Sem número')}</span><time>${esc(new Date(c.receivedAt).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}))}</time>${c.phone?`<button type="button" data-copy="${esc(c.phone)}">Copiar número</button>`:''}</div>`).join('')}</details>`;}
function summarize(rows) {
 const sum=field=>rows.reduce((total,row)=>total+row[field],0);
 const optionalSum=field=>rows.length&&rows.every(row=>row[field]!=null)?sum(field):null;
 return {spend:sum('spend'),impressions:sum('impressions'),clicks:sum('clicks'),linkClicks:optionalSum('linkClicks'),metaConversations:optionalSum('metaConversations'),reach:rows.length===1?rows[0].reach:null};
}
function performance(metrics) {
 return {...metrics,
  frequency:ratio(metrics.impressions,metrics.reach), cpm:ratio(metrics.spend,metrics.impressions,1000),
  ctr:ratio(metrics.clicks,metrics.impressions,100), linkCtr:ratio(metrics.linkClicks,metrics.impressions,100),
  cpc:ratio(metrics.spend,metrics.clicks), linkCpc:metrics.linkClicks==null?null:ratio(metrics.spend,metrics.linkClicks),
  conversion:ratio(metrics.metaConversations,metrics.linkClicks,100),
  conversationCost:metrics.metaConversations==null?null:ratio(metrics.spend,metrics.metaConversations),
 };
}
function groupRows(rows,level) {
 if(level==='ad')return rows.map(row=>({name:row.adName,context:[row.campaignName,row.adsetName].filter(Boolean).join(' · '),rows:[row]}));
 const groups=new Map();
 for(const row of rows){
  const key=level==='campaign'?row.campaignId:JSON.stringify([row.campaignId,row.adsetId||row.adsetName]);
  if(!groups.has(key))groups.set(key,{name:level==='campaign'?row.campaignName:row.adsetName||'Conjunto não informado',context:level==='adset'?row.campaignName:'',rows:[]});
  groups.get(key).rows.push(row);
 }
 return [...groups.values()];
}
const metricFormat={spend:money,clicks:count,linkClicks:count,contacts:count,linkCtr:percent,conversion:percent,conversationCost:money};
function renderSummary(metrics, rowMetrics, contacts) {
 const available=report.metaAvailable;
 const m=performance(metrics);
 const meta=value=>available?value:'—';
 const sections=[
  ['Entrega',[['Investimento Meta',available?money(m.spend):'Indisponível'],['Impressões',meta(count(m.impressions))],['Alcance único',count(m.reach)],['Frequência média',count(m.frequency)],['CPM',money(m.cpm)]]],
  ['Cliques',[['Cliques totais',meta(count(m.clicks))],['CTR total',percent(m.ctr)],['CPC total',money(m.cpc)],['Cliques no link',count(m.linkClicks)],['CTR de link',percent(m.linkCtr)],['CPC de link',money(m.linkCpc)]]],
  ['Conversas',[['Conversas atribuídas (Meta)',count(m.metaConversations)],['Conversão em conversas (Meta)',percent(m.conversion)],['Custo por conversa (Meta)',money(m.conversationCost)],['Contatos vinculados no WhatsApp',count(contacts)],['Conversão local no WhatsApp',percent(ratio(contacts,rowMetrics.linkClicks,100))]]],
 ];
 $('#summary').innerHTML=sections.map(([title,cards])=>`<section class="ads-kpi-group"><h2>${title}</h2><div class="ads-cards">${cards.map(([label,value])=>`<article><small>${label}</small><strong>${esc(value)}</strong></article>`).join('')}</div></section>`).join('');
}
function render(){
 if(!report)return;
 const campaign=$('#campaign').value,q=$('#search').value.trim().toLocaleLowerCase('pt-BR'),metric=$('#metric').value;
 const rows=report.rows.filter(r=>(!campaign||r.campaignId===campaign)&&(!q||[r.adName,r.campaignName,r.adsetName].join(' ').toLocaleLowerCase('pt-BR').includes(q)));
 const rowMetrics=summarize(rows);
 const accountMetrics=!campaign&&!q&&report.metaAvailable?report.accountMetrics:null;
 const metrics=accountMetrics||rowMetrics;
 renderSummary(metrics,rowMetrics,rows.reduce((total,row)=>total+row.contacts.length,0));
 $('#reach-note').textContent=accountMetrics?'Alcance da conta deduplicado pela Meta.':'Alcance e frequência estão disponíveis para a conta inteira ou para um único anúncio.';
 const groups=groupRows(rows,$('#level').value).map(group=>{
  const contacts=group.rows.flatMap(row=>row.contacts);
  const measures=performance(summarize(group.rows));
  return {...group,contacts,measures,value:metric==='contacts'?contacts.length:measures[metric]};
 }).sort((a,b)=>(b.value??-1)-(a.value??-1));
 const chart=groups.filter(group=>group.value!=null).slice(0,20),max=Math.max(0,...chart.map(group=>group.value))||1;
 $('#chart').innerHTML=chart.length?chart.map(group=>`<div class="ads-bar"><span>${esc(group.name)}</span><div class="ads-track" aria-hidden="true"><div class="ads-fill" style="width:${group.value/max*100}%"></div></div><strong>${esc(metricFormat[metric](group.value))}</strong></div>`).join(''):'Sem dados para essa métrica e esses filtros.';
 $('#ads').innerHTML=groups.length?groups.map(({name,context,contacts,measures:m})=>`<article class="ads-ad"><h3>${esc(name)}</h3>${context?`<div class="ads-muted">${esc(context)}</div>`:''}<div class="ads-values">${[
  ['Investimento',money(m.spend)],['Impressões',count(m.impressions)],['CPM',money(m.cpm)],['Cliques totais',count(m.clicks)],['CTR total',percent(m.ctr)],['CPC total',money(m.cpc)],['Cliques no link',count(m.linkClicks)],['CTR de link',percent(m.linkCtr)],['CPC de link',money(m.linkCpc)],['Conversas (Meta)',count(m.metaConversations)],['Conversão (Meta)',percent(m.conversion)],['Custo por conversa',money(m.conversationCost)],['Conversão local no WhatsApp',percent(ratio(contacts.length,m.linkClicks,100))],
 ].map(([k,v])=>`<span><small>${k}</small><b>${esc(v)}</b></span>`).join('')}</div>${contactList(contacts)}</article>`).join(''):'Nenhum resultado encontrado com os filtros selecionados.';
 $('#unmatched-panel').hidden=!report.unmatched.length;
 $('#unmatched').innerHTML=report.unmatched.map(r=>`<article class="ads-ad"><h3>${esc(r.headline||'Origem sem identificação de campanha')}</h3><p class="ads-muted">${r.adId==='unresolved'?'Anúncio não confirmado':`ID do anúncio: ${esc(r.adId)}`}</p>${contactList(r.contacts)}</article>`).join('');
 $('#footnote').textContent=`${report.attribution} Conta Meta: ${report.account.name} (${report.account.timezone||'fuso não informado'}). Consultado em ${new Date(report.generatedAt).toLocaleString('pt-BR')}. Cache de até 5 minutos. Cliques e investimento não comprovam vendas. Sem referral não é possível identificar a campanha apenas pelo texto da mensagem.`;
}
async function accounts(){const g=reset();$('#account').disabled=true;$('#account').innerHTML='<option value="">Carregando…</option>';$('#load').disabled=true;try{const b=await api('/api/meta-ads/accounts?'+new URLSearchParams({company:$('#company').value}),controller.signal);if(g!==generation)return;$('#account').innerHTML=b.accounts.map(a=>`<option value="${esc(a.id)}">${esc(a.name)} · ${esc(a.currency)}</option>`).join('')||'<option value="">Nenhuma conta disponível</option>';$('#account').disabled=!b.accounts.length;$('#load').disabled=!b.accounts.length;$('#status').textContent=b.accounts.length?'Selecione o período e clique em Consultar.':b.configured?'O token não retornou contas de anúncios.':'Token de anúncios ainda não configurado nesta empresa.';}catch(e){if(g===generation&&e.name!=='AbortError'){$('#status').textContent=e.message;$('#account').innerHTML='<option value="">Indisponível</option>';}}}
$('#filters').addEventListener('submit',async e=>{e.preventDefault();const g=reset();$('#load').disabled=true;$('#status').textContent='Consultando resultados…';try{const b=await api('/api/meta-ads/report?'+new URLSearchParams({company:$('#company').value,adAccountId:$('#account').value,from:$('#from').value,to:$('#to').value}),controller.signal);if(g!==generation)return;report=b;const options=new Map(b.rows.map(r=>[r.campaignId,r.campaignName]));$('#campaign').innerHTML='<option value="">Todas as campanhas</option>'+[...options].map(([id,name])=>`<option value="${esc(id)}">${esc(name)}</option>`).join('');$('#search').value='';$('#warnings').innerHTML=b.warnings.map(w=>`<p class="ads-notice">${esc(w)}</p>`).join('');$('#results').hidden=false;$('#status').textContent=b.metaAvailable?'Resultados carregados.':'A Meta não retornou métricas; as origens locais disponíveis aparecem abaixo.';render();}catch(e){if(g===generation&&e.name!=='AbortError')$('#status').textContent=e.message;}finally{if(g===generation)$('#load').disabled=false;}});
$('#company').addEventListener('change',accounts);$('#account').addEventListener('change',()=>reset());['campaign','metric','level'].forEach(id=>$('#'+id).addEventListener('change',render));$('#search').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(render,120);});
document.addEventListener('click',async e=>{const b=e.target.closest('[data-copy]');if(!b)return;try{await navigator.clipboard.writeText(b.dataset.copy);b.textContent='Copiado';}catch{$('#status').textContent='Não foi possível copiar. Selecione o número manualmente.';}});
(async()=>{try{const status=await api('/api/auth/status');if(!status.user?.isMaster){$('#status').textContent='Acesso restrito a Master.';return;}const data=await api('/api/companies');const companies=data.companies||[];$('#company').innerHTML=companies.map(c=>`<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');const today=new Date(Date.now()-3*3600000),from=new Date(today.getTime()-29*86400000);$('#to').value=today.toISOString().slice(0,10);$('#from').value=from.toISOString().slice(0,10);$('#to').max=$('#to').value;$('#from').max=$('#to').value;if(companies.length)await accounts();}catch(e){$('#status').textContent=e.message;}})();
