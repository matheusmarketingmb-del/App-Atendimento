const fail=()=>Object.assign(new Error('Página de mensagens inválida.'),{statusCode:400});
function decodeCursor(value){
  if(value===undefined||value===null||value==='')return null;
  if(typeof value!=='string'||value.length>1024)throw fail();
  try{const data=JSON.parse(Buffer.from(value,'base64url').toString());if(typeof data.id!=='string'||!data.id||data.id.length>200||!Number.isFinite(Date.parse(data.at)))throw fail();return {id:data.id,at:new Date(data.at),pinned:Boolean(data.pinned)};}catch{throw fail();}
}
function encodeCursor(row,pinned=false){return row?Buffer.from(JSON.stringify({id:row.id,at:(row.occurredAt||row.lastMessageAt||row.createdAt).toISOString(),pinned})).toString('base64url'):null;}
function historyOptions(query={}){
  if(query.sharedContent==='true')return {sharedOnly:true};
  if(query.historyPage!=='true')return {};
  return {limit:80,before:decodeCursor(query.historyBefore),from:decodeCursor(query.historyFrom),adOrigin:query.adOrigin==='true'};
}
function sharedWhere(options){return options.sharedOnly?{OR:[{type:{in:['image','video','document']},mediaStorageKey:{not:null}},{text:{contains:'http',mode:'insensitive'}},{text:{contains:'www.',mode:'insensitive'}}]}:{};}
function historyWhere(options){
  const cursor=options.before||options.from;if(!cursor)return {};
  return options.before?{OR:[{occurredAt:{lt:cursor.at}},{occurredAt:cursor.at,id:{lt:cursor.id}}]}:{OR:[{occurredAt:{gt:cursor.at}},{occurredAt:cursor.at,id:{gte:cursor.id}}]};
}
function listPage(rows,limit,cursor){
  const sorted=[...rows].sort((a,b)=>Number(Boolean(b.pins?.length))-Number(Boolean(a.pins?.length))||new Date(b.lastMessageAt||b.createdAt)-new Date(a.lastMessageAt||a.createdAt)||b.id.localeCompare(a.id));
  const total=sorted.length;
  const rest=cursor?sorted.filter(row=>{
    const pinned=Boolean(row.pins?.length),time=new Date(row.lastMessageAt||row.createdAt).getTime();
    if(pinned!==cursor.pinned)return cursor.pinned&&!pinned;
    return time<cursor.at.getTime()||(time===cursor.at.getTime()&&row.id.localeCompare(cursor.id)<0);
  }):sorted;
  const items=rest.slice(0,limit);return {items,total,nextCursor:rest.length>limit?encodeCursor(items.at(-1),Boolean(items.at(-1)?.pins?.length)):null};
}
module.exports={decodeCursor,encodeCursor,historyOptions,historyWhere,sharedWhere,listPage};
