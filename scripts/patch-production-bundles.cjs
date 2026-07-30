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

function ensureServerRequire(modulePath, variableName) {
  const file = path.join(root, "server.cjs");
  const anchor = '"use strict";var __telesAgent=require("./teles-agent.cjs");';
  const statement = `var ${variableName}=require("${modulePath}");`;
  let content = fs.readFileSync(file, "utf8");
  const withoutDuplicates = content.split(statement).join("");
  if (!withoutDuplicates.includes(anchor)) {
    throw new Error(`server.cjs: missing require anchor for ${modulePath}`);
  }
  const patched = withoutDuplicates.replace(anchor, anchor + statement);
  if (patched !== content) {
    fs.writeFileSync(file, patched, "utf8");
    console.log(`Ensured require: ${modulePath}`);
  } else {
    console.log(`Already required: ${modulePath}`);
  }
}

function replaceSection(file, startMarker, endMarker, replacement) {
  const absolute = path.join(root, file);
  let content = fs.readFileSync(absolute, "utf8");
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker, start);
  if (start < 0 || end < 0) {
    if (content.includes(replacement)) {
      console.log(`Already patched section: ${file}`);
      return;
    }
    throw new Error(`${file}: payment section markers not found`);
  }
  content = content.slice(0, start) + replacement + content.slice(end);
  fs.writeFileSync(absolute, content, "utf8");
  console.log(`Patched section: ${file}`);
}

replaceExpected(
  "server.cjs",
  'process.env.APP_URL||"https://telesads.com"',
  'process.env.APP_URL||"https://egatusad.com"'
);

ensureServerRequire("./teles-invoice.cjs", "__telesInvoice");

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

replaceSection(
  "server.cjs",
  'Hi.post("/campaigns/:id/payment"',
  "var jI=Hi",
  'Hi.post("/campaigns/:id/payment",async(t,e)=>{let r=parseInt(t.params.id),[i]=await P.select().from(pe).where(K(pe.id,r));if(!i){e.status(404).json({error:"Campaign not found"});return}if(t.telegramUserId&&i.telegramId&&Number(t.telegramUserId)!==Number(i.telegramId)){e.status(403).json({error:"This campaign belongs to another user."});return}let n;try{n=await __telesInvoice.startOrCheckAutomaticPayment({campaign:i,telegramUserId:t.telegramUserId,method:t.body?.method})}catch(a){e.status(400).json({error:a.message});return}if(n.status!=="paid"){e.json(n);return}await P.update(pe).set({status:"active"}).where(K(pe.id,r));if(n.justConfirmed)tn(`\u2705 <b>Payment Confirmed Automatically!</b>\n\n\u{1F4E6} <b>${i.packageName}</b>\n\u{1F4E1} <b>Channel:</b> ${i.channelLink}\n\u{1F4B5} <b>Amount:</b> ${n.expectedAmount} USDT\n\nThe confirmed on-chain payment activated this campaign.`);e.json({...n,success:!0,message:"Payment confirmed automatically. Your campaign is now active."})});'
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

replaceSection(
  "public/assets/index-DTEWTEAe.js",
  "function gue()",
  "const bue=",
  'function gue(){const e=Fu(),[,t]=So(),n=parseInt(e.id||"0"),{data:r,isLoading:i}=m5(n),{mutateAsync:o,isPending:l}=SV(),[c,f]=k.useState("usdt_trc20"),[h,p]=k.useState(null),[y,g]=k.useState(!1),[x,S]=k.useState("");const j=async()=>{try{S("");const O=await o({id:n,data:{method:c}});p(O),O.status==="paid"&&(g(!0),ki())}catch(O){S(O?.message||"Payment verification is temporarily unavailable.")}};k.useEffect(()=>{if(!h||h.status==="paid")return;const O=setInterval(j,1e4);return()=>clearInterval(O)},[h?.status,c,n]);const w=()=>{navigator.clipboard.writeText(h?.paymentAddress||Na[c].address),ki()};return y?m.jsx("div",{className:"min-h-screen bg-mesh flex flex-col items-center justify-center p-8 text-center",children:m.jsxs(de.div,{initial:{scale:.8,opacity:0},animate:{scale:1,opacity:1},className:"space-y-4",children:[m.jsx("div",{className:"w-20 h-20 mx-auto rounded-full bg-success/20 flex items-center justify-center",children:m.jsx(ed,{className:"w-9 h-9 text-success"})}),m.jsx("h2",{className:"text-xl font-bold text-slate-800",children:"Payment Confirmed"}),m.jsx("p",{className:"text-sm text-slate-500 max-w-[300px]",children:"Your USDT transfer was confirmed on-chain and the campaign is now active."}),m.jsxs("div",{className:"glass-card rounded-2xl p-4 text-left space-y-2",children:[m.jsxs("div",{className:"flex justify-between text-xs gap-4",children:[m.jsx("span",{className:"text-slate-400",children:"Invoice"}),m.jsx("span",{className:"font-mono text-slate-800",children:h?.invoiceNumber})]}),m.jsxs("div",{className:"flex justify-between text-xs gap-4",children:[m.jsx("span",{className:"text-slate-400",children:"Transaction"}),m.jsx("span",{className:"font-mono text-slate-800 truncate max-w-[190px]",children:h?.paymentId})]})]}),m.jsx("button",{onClick:()=>t("/campaigns"),className:"w-full bg-gradient-to-r from-primary to-accent text-white font-semibold py-3.5 rounded-xl",children:"View Campaigns"})]})}):m.jsxs("div",{className:"min-h-screen flex flex-col pb-10",children:[m.jsxs("div",{className:"sticky top-0 glass-strong px-4 py-4 flex items-center z-10",children:[m.jsx(ze,{href:"/create",className:"p-2 -ml-2 rounded-full hover:bg-black/5",children:m.jsx(Yn,{className:"w-5 h-5 text-slate-600"})}),m.jsx("div",{className:"flex-1 text-center font-semibold text-sm text-slate-800",children:"Automatic USDT Payment"}),m.jsx("div",{className:"w-9"})]}),m.jsxs("div",{className:"p-4 space-y-5 flex-1",children:[m.jsxs(de.div,{initial:{opacity:0,y:10},animate:{opacity:1,y:0},className:"text-center space-y-2 py-4",children:[m.jsx("p",{className:"text-slate-400 text-sm",children:h?"Send this exact amount":"Campaign amount"}),m.jsxs("div",{className:"text-4xl font-bold font-mono text-primary",children:[h?Number(h.expectedAmount).toFixed(3):i?"...":Number(r?.price||0).toFixed(2)," USDT"]}),h&&m.jsx("p",{className:"text-xs text-amber-500",children:"The exact amount identifies your campaign automatically."})]}),m.jsxs(de.div,{initial:{opacity:0,y:10},animate:{opacity:1,y:0},className:"space-y-3",children:[m.jsx("label",{className:"text-sm font-medium text-slate-600",children:"Select Network"}),m.jsx("div",{className:"grid grid-cols-1 gap-2",children:["usdt_trc20","usdt_bep20"].map(O=>m.jsxs("button",{onClick:()=>{f(O),p(null),S("")},disabled:!!h,className:ye("p-3.5 rounded-2xl text-sm font-medium flex justify-between items-center transition-all",c===O?"glass-strong border-primary/30":"glass-card",h?"opacity-60":""),children:[m.jsxs("div",{className:"text-left",children:[m.jsx("span",{className:"font-semibold text-slate-800",children:Na[O].name}),m.jsx("span",{className:"block text-[10px] text-slate-400 mt-0.5",children:Na[O].network})]}),c===O&&m.jsx(ed,{className:"w-4 h-4 text-primary"})]},O))})]}),h&&m.jsxs(de.div,{initial:{opacity:0,y:8},animate:{opacity:1,y:0},className:"glass-card rounded-2xl p-4 space-y-4",children:[m.jsx("div",{className:"bg-amber-500/10 border border-amber-500/20 rounded-xl p-3 text-xs text-amber-500",children:"Send only USDT on the selected network. A different token, network, or amount cannot be matched automatically."}),m.jsxs("div",{className:"space-y-1",children:[m.jsx("span",{className:"text-xs text-slate-400",children:"Receiving address"}),m.jsxs("div",{className:"glass-input rounded-xl p-3 flex items-center gap-2",children:[m.jsx("span",{className:"font-mono text-xs text-slate-700 break-all flex-1",children:h.paymentAddress}),m.jsx("button",{onClick:w,className:"p-2 glass-btn rounded-lg",children:m.jsx(U1,{className:"w-4 h-4"})})]})]}),m.jsxs("div",{className:"flex justify-between text-xs",children:[m.jsx("span",{className:"text-slate-400",children:"Status"}),m.jsx("span",{className:"text-amber-500 font-semibold",children:h.verificationDelayed?"Network API delayed":"Watching blockchain"})]}),m.jsx("p",{className:"text-[11px] text-slate-400 text-center",children:"This page checks automatically every 10 seconds. Confirmation can take several minutes."})]}),x&&m.jsx("div",{className:"rounded-xl bg-red-50 border border-red-200 p-3 text-xs text-red-600",children:x}),m.jsx("button",{onClick:j,disabled:l||i,className:"w-full bg-gradient-to-r from-primary to-accent disabled:opacity-50 text-white font-semibold py-4 rounded-xl shadow-[0_4px_20px_rgba(59,91,255,0.3)]",children:l?"Checking blockchain...":h?"Check Now":"Start Automatic Verification"})]})]})}'
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
