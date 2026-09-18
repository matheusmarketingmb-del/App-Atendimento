"use strict";
const axios=require("axios"),URL=String(process.env.LOCAL_KNOWLEDGE_BASE_URL||"").replace(/\/+$/,""),IDS=new Set(String(process.env.LOCAL_KNOWLEDGE_BOT_IDS||"").split(",").map(x=>x.trim()).filter(Boolean));
const handles=id=>Boolean(id&&IDS.has(id));
async function search(query,f){if(!URL)return[];const r=await axios.post(URL+"/search",{query,domains:f.domains,category:f.category,product:f.product,tags:f.tags,limit:f.limit,minScore:f.minScore},{timeout:5000}),out=Array.isArray(r.data&&r.data.results)?r.data.results:[];Object.defineProperty(out,"conflict",{value:false,enumerable:false});return out;}
module.exports={handles,search};
