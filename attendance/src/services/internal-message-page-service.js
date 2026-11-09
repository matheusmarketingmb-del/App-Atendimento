// Keyset pagination: stable ordering even when several messages share a time.
// Membership and workspace checks are performed by internal-chat-service first.
const include={senderUser:{select:{id:true,name:true,email:true}},reactions:{select:{userId:true,emoji:true,user:{select:{name:true}}}}};
const ascending=[{createdAt:'asc'},{id:'asc'}],descending=[{createdAt:'desc'},{id:'desc'}];
function boundary(anchor,direction){const op=direction==='before'?'lt':'gt';return {OR:[{createdAt:{[op]:anchor.createdAt}},{createdAt:anchor.createdAt,id:{[op]:anchor.id}}]};}
async function listPage(db,chatId,{before,after,around,limit=60}={}){
 const size=Number(limit);
 if(!Number.isInteger(size)||size<1||size>100||[before,after,around].filter(Boolean).length>1)throw Object.assign(new Error('Paginação inválida.'),{statusCode:400});
 const cursor=before||after||around;
 let anchor;
 if(cursor){
  if(typeof cursor!=='string'||cursor.length>200)throw Object.assign(new Error('Cursor inválido.'),{statusCode:400});
  anchor=await db.internalMessage.findFirst({where:{id:cursor,chatId},select:{id:true,createdAt:true}});
  if(!anchor)throw Object.assign(new Error('Mensagem não encontrada neste chat.'),{statusCode:404});
 }
 const find=(where,orderBy,take)=>db.internalMessage.findMany({where:{chatId,...where},orderBy,take,include});
 if(around){
  const half=Math.max(1,Math.floor(size/2));
  const [older,newer,center]=await Promise.all([find(boundary(anchor,'before'),descending,half+1),find(boundary(anchor,'after'),ascending,half+1),find({id:anchor.id},ascending,1)]);
  return {messages:[...older.slice(0,half).reverse(),...center,...newer.slice(0,half)],hasOlder:older.length>half,hasNewer:newer.length>half};
 }
 const found=await find(anchor?boundary(anchor,after?'after':'before'):{},after?ascending:descending,size+1);
 const more=found.length>size,messages=found.slice(0,size);
 if(!after)messages.reverse();
 return {messages,hasOlder:after?null:more,hasNewer:after?more:false};
}
module.exports={listPage,boundary};
