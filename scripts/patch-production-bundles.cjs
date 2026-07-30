"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

function replaceExpected(file, before, after, expectedCount = 1) {
  const absolute = path.join(root, file);
  let content = fs.readFileSync(absolute, "utf8");
  const count = content.split(before).length - 1;

  if (count === 0 && content.includes(after)) {
    console.log(`Already patched: ${file}`);
    return;
  }
  if (count !== expectedCount) {
    throw new Error(
      `${file}: expected ${expectedCount} occurrence(s), found ${count}: ${before.slice(0, 100)}`
    );
  }

  content = content.split(before).join(after);
  fs.writeFileSync(absolute, content, "utf8");
  console.log(`Patched: ${file}`);
}

replaceExpected(
  "server.cjs",
  'process.env.APP_URL||"https://telesads.com"',
  'process.env.APP_URL||"https://egatusad.com"'
);

replaceExpected(
  "server.cjs",
  'description:"Visit telesads.com"',
  'description:"Visit egatusad.com"',
  2
);

replaceExpected(
  "server.cjs",
  "if(await __telesAgent.handleUpdate({text:i,chatId:n,userId:a,update:r,adminId:Qo,db:P,users:be,campaigns:pe,packages:Fe}))",
  'if(!(i==="/start"||i.startsWith("/start "))&&await __telesAgent.handleUpdate({text:i,chatId:n,userId:a,update:r,adminId:Qo,db:P,users:be,campaigns:pe,packages:Fe}))'
);

replaceExpected(
  "server.cjs",
  'let u=(o.members||"").match(/(\\d+)k/g),c=2e3;u&&u.length>=2?c=parseInt(u[u.length-1])*1e3:u&&u.length===1&&(c=parseInt(u[0])*1e3);let[l]=',
  'let c=__telesAgent.parseMemberTarget(o.members);if(!c){e.status(400).json({error:"This package needs a valid member target before it can be ordered."});return}let[l]='
);

replaceExpected(
  "server.cjs",
  'Ku.post("/agent/chat",(t,e)=>__telesAgent.apiChat(t,e,{db:P,packages:Fe}))',
  'Ku.post("/agent/chat",(t,e)=>__telesAgent.apiChat(t,e,{db:P,packages:Fe,campaigns:pe}))'
);

replaceExpected(
  "server.cjs",
  'let r=t.body,i=r?.message?.text?.trim()||"",n=r?.message?.chat?.id,a=r?.message?.from?.id;if(!n)',
  'let r=t.body,i=r?.message?.text?.trim()||"",n=r?.message?.chat?.id||r?.callback_query?.message?.chat?.id,a=r?.message?.from?.id||r?.callback_query?.from?.id;if(!n)'
);

replaceExpected(
  "server.cjs",
  'body:JSON.stringify({url:r,allowed_updates:["message"]})',
  'body:JSON.stringify({url:r,allowed_updates:["message","callback_query"]})'
);

replaceExpected(
  "server.cjs",
  '{command:"ask",description:"Ask Teles Agent a quick question"},{command:"status"',
  '{command:"ask",description:"Ask Teles Agent a quick question"},{command:"copy",description:"Analyze a public channel"},{command:"health",description:"Check campaign health"},{command:"human",description:"Request human support"},{command:"status"'
);

replaceExpected(
  "server.cjs",
  '{command:"start",description:"Welcome & open the platform"},{command:"status",description:"Check your campaign status"},{command:"packages"',
  '{command:"start",description:"Welcome & open the platform"},{command:"agent",description:"Chat with Teles Agent AI"},{command:"copy",description:"Analyze a public channel"},{command:"health",description:"Check campaign health"},{command:"human",description:"Request human support"},{command:"status",description:"Check your campaign status"},{command:"packages"'
);

replaceExpected(
  "server.cjs",
  'Te.post("/admin/packages",async(t,e)=>{let{name:r,description:i,members:n,features:a,price:o,originalPrice:s,popular:u}=t.body,[c]=await P.insert',
  'Te.post("/admin/packages",async(t,e)=>{let{name:r,description:i,members:n,features:a,price:o,originalPrice:s,popular:u}=t.body;if(!__telesAgent.parseMemberTarget(n)){e.status(400).json({error:"A valid member target is required."});return}let[c]=await P.insert'
);

replaceExpected(
  "server.cjs",
  'Te.patch("/admin/packages/:id",async(t,e)=>{let r=parseInt(t.params.id),{name:i,description:n,members:a,features:o,price:s,originalPrice:u,popular:c,active:l}=t.body,p={};',
  'Te.patch("/admin/packages/:id",async(t,e)=>{let r=parseInt(t.params.id),{name:i,description:n,members:a,features:o,price:s,originalPrice:u,popular:c,active:l}=t.body;if(a!==void 0&&!__telesAgent.parseMemberTarget(a)){e.status(400).json({error:"A valid member target is required."});return}let p={};'
);

replaceExpected(
  "public/assets/index-DTEWTEAe.js",
  "Members range (e.g. 1k–2k Members)",
  "Member target (e.g. 5000 or 3k–5k)"
);

replaceExpected(
  "public/assets/index-DTEWTEAe.js",
  'value:"telesads.com",href:"https://telesads.com"',
  'value:"egatusad.com",href:"https://egatusad.com"'
);

for (const file of ["server.cjs", "public/assets/index-DTEWTEAe.js"]) {
  const absolute = path.join(root, file);
  const content = fs.readFileSync(absolute, "utf8");
  const normalized = content
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n/g, "\r\n");
  if (normalized !== content) fs.writeFileSync(absolute, normalized, "utf8");
}

console.log("Production bundles are up to date.");
