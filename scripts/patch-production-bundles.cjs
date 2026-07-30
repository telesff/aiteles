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

function upsertBlock(file, startMarker, endMarker, body) {
  const absolute = path.join(root, file);
  let content = fs.readFileSync(absolute, "utf8");
  const block = `${startMarker}${body}${endMarker}`;
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker, start);

  if (start >= 0 && end >= 0) {
    content = content.slice(0, start) + block + content.slice(end + endMarker.length);
  } else {
    content = `${content.trimEnd()}\n${block}\n`;
  }
  content = content.replace(/\r\n/g, "\n");
  fs.writeFileSync(absolute, content, "utf8");
  console.log(`Upserted block: ${file}`);
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

replaceExpected(
  "server.cjs",
  'try{let s=new URLSearchParams(i).get("user");if(s){let u=JSON.parse(s);if(u?.id){t.telegramUserId=u.id,t.telegramUsername=u.username||u.first_name||"User",t.isAdmin=u.id===md,r();return}}}catch{}}let n=t.headers["x-telegram-user-id"];if(n){let a=parseInt(n,10);isNaN(a)||(t.telegramUserId=a,t.isAdmin=a===md)}r()',
  "}r()"
);

replaceExpected(
  "server.cjs",
  'Hi.get("/campaigns",async(t,e)=>{let r=await P.select().from(pe).orderBy(Je(pe.createdAt));e.json({campaigns:r.map(i=>({...i,createdAt:i.createdAt.toISOString(),completedAt:i.completedAt?.toISOString()}))})})',
  'Hi.get("/campaigns",async(t,e)=>{let r=t.telegramUserId;if(!r){e.status(401).json({error:"Telegram authentication required."});return}let i=await P.select().from(pe).where(K(pe.telegramId,r)).orderBy(Je(pe.createdAt));e.json({campaigns:i.map(n=>({...n,createdAt:n.createdAt.toISOString(),completedAt:n.completedAt?.toISOString()}))})})'
);

replaceExpected(
  "server.cjs",
  'Hi.get("/campaigns/:id",async(t,e)=>{let r=parseInt(t.params.id),[i]=await P.select().from(pe).where(K(pe.id,r));if(!i){e.status(404).json({error:"Campaign not found"});return}e.json({...i,createdAt:i.createdAt.toISOString(),completedAt:i.completedAt?.toISOString()})})',
  'Hi.get("/campaigns/:id",async(t,e)=>{let r=t.telegramUserId;if(!r){e.status(401).json({error:"Telegram authentication required."});return}let i=parseInt(t.params.id),[n]=await P.select().from(pe).where(K(pe.id,i));if(!n||Number(n.telegramId)!==Number(r)){e.status(404).json({error:"Campaign not found"});return}e.json({...n,createdAt:n.createdAt.toISOString(),completedAt:n.completedAt?.toISOString()})})'
);

replaceExpected(
  "server.cjs",
  'Hi.post("/campaigns",async(t,e)=>{let{packageId:r,channelLink:i,audience:n}=t.body,a=t.telegramUserId||null,[o]=',
  'Hi.post("/campaigns",async(t,e)=>{let{packageId:r,channelLink:i,audience:n}=t.body,a=t.telegramUserId;if(!a){e.status(401).json({error:"Telegram authentication required."});return}let[o]='
);

replaceSection(
  "server.cjs",
  'Hi.post("/campaigns/:id/payment"',
  "var jI=Hi",
  'Hi.post("/campaigns/:id/payment",async(t,e)=>{let r=parseInt(t.params.id),[i]=await P.select().from(pe).where(K(pe.id,r));if(!i){e.status(404).json({error:"Campaign not found"});return}if(t.telegramUserId&&i.telegramId&&Number(t.telegramUserId)!==Number(i.telegramId)){e.status(403).json({error:"This campaign belongs to another user."});return}let n;try{n=await __telesInvoice.startOrCheckAutomaticPayment({campaign:i,telegramUserId:t.telegramUserId,method:t.body?.method})}catch(a){e.status(400).json({error:a.message});return}if(n.status!=="paid"){e.json(n);return}await P.update(pe).set({status:"active"}).where(K(pe.id,r));if(n.justConfirmed)tn(`\u2705 <b>Payment Confirmed Automatically!</b>\n\n\u{1F4E6} <b>${i.packageName}</b>\n\u{1F4E1} <b>Channel:</b> ${i.channelLink}\n\u{1F4B5} <b>Amount:</b> ${n.expectedAmount} USDT\n\nThe confirmed on-chain payment activated this campaign.`);e.json({...n,success:!0,message:"Payment confirmed automatically. Your campaign is now active."})});'
);

replaceExpected(
  "server.cjs",
  'if(!i){e.status(404).json({error:"Campaign not found"});return}if(t.telegramUserId&&i.telegramId&&Number(t.telegramUserId)!==Number(i.telegramId)){e.status(403).json({error:"This campaign belongs to another user."});return}',
  'if(!i){e.status(404).json({error:"Campaign not found"});return}if(!t.telegramUserId){e.status(401).json({error:"Telegram authentication required."});return}if(!i.telegramId||Number(t.telegramUserId)!==Number(i.telegramId)){e.status(403).json({error:"This campaign belongs to another user."});return}'
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

const paymentComponent = String.raw`function gue(){
  const e=Fu(),[,t]=So(),n=parseInt(e.id||"0"),{data:r,isLoading:i}=m5(n),{mutateAsync:o,isPending:l}=SV(),
    [c,f]=k.useState("usdt_trc20"),[h,p]=k.useState(null),[y,g]=k.useState(!1),
    [x,S]=k.useState(""),[b,C]=k.useState(!1);
  const j=async()=>{
    try{
      S("");
      const O=await o({id:n,data:{method:c}});
      p(O);
      O.status==="paid"&&(g(!0),ki());
    }catch(O){
      S(O?.message||"Payment verification is temporarily unavailable.");
    }
  };
  k.useEffect(()=>{
    if(!h||h.status==="paid")return;
    const O=setInterval(j,1e4);
    return()=>clearInterval(O);
  },[h?.status,c,n]);
  const w=async()=>{
    const O=h?.paymentAddress||Na[c].address;
    try{
      if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(O);
      else throw new Error("Clipboard unavailable");
    }catch{
      const A=document.createElement("textarea");
      A.value=O;
      A.style.position="fixed";
      A.style.opacity="0";
      document.body.appendChild(A);
      A.select();
      document.execCommand("copy");
      A.remove();
    }
    C(!0);
    setTimeout(()=>C(!1),1600);
    ki();
  };
  return y?m.jsx("div",{className:"payment-page payment-success",children:m.jsxs(de.div,{initial:{scale:.8,opacity:0},animate:{scale:1,opacity:1},className:"payment-success-content",children:[
    m.jsx("div",{className:"payment-success-icon",children:m.jsx(ed,{className:"w-9 h-9"})}),
    m.jsx("h2",{className:"text-xl font-bold text-slate-800",children:"Payment Confirmed"}),
    m.jsx("p",{className:"text-sm text-slate-500",children:"Your USDT transfer was confirmed on-chain and the campaign is now active."}),
    m.jsxs("div",{className:"payment-receipt",children:[
      m.jsxs("div",{className:"payment-receipt-row",children:[m.jsx("span",{children:"Invoice"}),m.jsx("strong",{children:h?.invoiceNumber})]}),
      m.jsxs("div",{className:"payment-receipt-row",children:[m.jsx("span",{children:"Transaction"}),m.jsx("strong",{className:"payment-transaction",children:h?.paymentId})]})
    ]}),
    m.jsx("button",{onClick:()=>t("/campaigns"),className:"payment-primary-button",children:"View Campaigns"})
  ]})}):m.jsxs("div",{className:"payment-page",children:[
    m.jsxs("div",{className:"payment-header",children:[
      m.jsx(ze,{href:"/create",className:"payment-back-button",children:m.jsx(Yn,{className:"w-5 h-5"})}),
      m.jsx("div",{className:"payment-header-title",children:"Automatic USDT Payment"}),
      m.jsx("div",{className:"payment-header-spacer"})
    ]}),
    m.jsxs("main",{className:"payment-content",children:[
      m.jsxs(de.div,{initial:{opacity:0,y:10},animate:{opacity:1,y:0},className:"payment-amount-block",children:[
        m.jsx("p",{className:"payment-eyebrow",children:h?"Send this exact amount":"Campaign amount"}),
        m.jsxs("div",{className:"payment-amount",children:[h?Number(h.expectedAmount).toFixed(3):i?"...":Number(r?.price||0).toFixed(2)," USDT"]}),
        h&&m.jsx("p",{className:"payment-amount-note",children:"The exact amount identifies your campaign automatically."})
      ]}),
      m.jsxs(de.div,{initial:{opacity:0,y:10},animate:{opacity:1,y:0},className:"payment-network-section",children:[
        m.jsx("label",{className:"payment-section-label",children:"Select network"}),
        m.jsx("div",{className:"payment-network-grid",children:["usdt_trc20","usdt_bep20"].map(O=>m.jsxs("button",{
          onClick:()=>{f(O),p(null),S("")},
          disabled:!!h,
          className:ye("payment-network-button",c===O?"is-selected":"",h?"is-locked":""),
          children:[
            m.jsxs("span",{className:"payment-network-copy",children:[
              m.jsx("strong",{children:Na[O].name}),
              m.jsx("small",{children:Na[O].network})
            ]}),
            c===O&&m.jsx(ed,{className:"w-4 h-4"})
          ]
        },O))})
      ]}),
      h&&m.jsxs(de.div,{initial:{opacity:0,y:8},animate:{opacity:1,y:0},className:"payment-panel",children:[
        m.jsx("div",{className:"payment-notice",children:"Send only USDT on the selected network. A different token, network, or amount cannot be matched automatically."}),
        m.jsxs("div",{className:"payment-address-group",children:[
          m.jsx("span",{className:"payment-field-label",children:"Receiving address"}),
          m.jsxs("div",{className:"payment-address-row",children:[
            m.jsx("span",{className:"payment-address",children:h.paymentAddress}),
            m.jsxs("button",{onClick:w,type:"button",className:"payment-copy-button",title:"Copy receiving address","aria-label":"Copy receiving address",children:[
              m.jsx(U1,{className:"w-4 h-4"}),
              m.jsx("span",{children:b?"Copied":"Copy"})
            ]})
          ]})
        ]}),
        m.jsxs("div",{className:"payment-status-row",children:[
          m.jsx("span",{className:"payment-field-label",children:"Status"}),
          m.jsx("span",{className:ye("payment-status-value",h.verificationDelayed?"is-delayed":""),children:h.verificationDelayed?"Network API delayed":"Watching blockchain"})
        ]}),
        m.jsx("p",{className:"payment-polling-note",children:h.verificationDelayed?"The network provider is responding slowly. Automatic checks will continue every 10 seconds.":"Automatic checks run every 10 seconds. Confirmation can take several minutes."})
      ]}),
      x&&m.jsx("div",{className:"payment-error",children:x}),
      m.jsx("button",{onClick:j,disabled:l||i,className:"payment-primary-button",children:l?"Checking blockchain...":h?"Check Now":"Start Automatic Verification"})
    ]})
  ]});
}`;

replaceSection(
  "public/assets/index-DTEWTEAe.js",
  "function gue()",
  "const bue=",
  paymentComponent
);

upsertBlock(
  "public/assets/index-6wOoSUvw.css",
  "/* teles-payment-ui:start */",
  "/* teles-payment-ui:end */",
  `
.payment-page{min-height:100vh;background:linear-gradient(180deg,#f7faff 0,#edf6ff 48%,#f7faff 100%);color:#172033;overflow-x:hidden}
.payment-header{position:sticky;top:0;z-index:10;display:grid;grid-template-columns:40px minmax(0,1fr) 40px;align-items:center;min-height:64px;padding:10px 16px;background:#fffffff2;border-bottom:1px solid #dce9f8;backdrop-filter:blur(18px)}
.payment-header-title{text-align:center;font-size:14px;font-weight:700;color:#1f3554;overflow-wrap:anywhere}
.payment-header-spacer{width:40px;height:40px}
.payment-back-button{display:flex;width:40px;height:40px;align-items:center;justify-content:center;color:#3157d5;border-radius:8px}
.payment-back-button:hover{background:#e8f2ff}
.payment-content{width:100%;max-width:430px;margin:0 auto;padding:20px 16px 40px}
.payment-amount-block{text-align:center;padding:16px 0 22px}
.payment-eyebrow,.payment-field-label{font-size:12px;font-weight:600;color:#667085}
.payment-amount{margin-top:8px;font-family:"JetBrains Mono",monospace;font-size:30px;line-height:1.2;font-weight:700;color:#3157d5;overflow-wrap:anywhere}
.payment-amount-note{max-width:320px;margin:8px auto 0;font-size:12px;line-height:1.5;color:#52677f}
.payment-network-section{margin-bottom:16px}
.payment-section-label{display:block;margin-bottom:8px;font-size:13px;font-weight:700;color:#344054}
.payment-network-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.payment-network-button{display:flex;min-width:0;min-height:66px;align-items:center;justify-content:space-between;gap:8px;padding:12px;background:#fff;border:1px solid #dce5f0;border-radius:8px;color:#344054;text-align:left;box-shadow:0 3px 12px #1f4f7a0d}
.payment-network-button.is-selected{background:#eef6ff;border-color:#5b8def;color:#244f9e;box-shadow:0 0 0 2px #3157d51a}
.payment-network-button.is-locked{cursor:default;opacity:.72}
.payment-network-copy{display:block;min-width:0}
.payment-network-copy strong,.payment-network-copy small{display:block;overflow-wrap:anywhere}
.payment-network-copy strong{font-size:13px}
.payment-network-copy small{margin-top:3px;font-size:10px;color:#74859a}
.payment-panel{min-width:0;margin-bottom:16px;padding:14px;background:#fff;border:1px solid #dce5f0;border-radius:8px;box-shadow:0 8px 24px #1f4f7a12}
.payment-notice{padding:11px 12px;background:#eef6ff;border-left:3px solid #4d86e8;border-radius:6px;font-size:12px;line-height:1.55;color:#315779;overflow-wrap:anywhere}
.payment-address-group{min-width:0;margin-top:14px}
.payment-address-row{display:flex;min-width:0;align-items:stretch;gap:8px;margin-top:6px}
.payment-address{display:flex;min-width:0;flex:1;align-items:center;padding:10px 11px;background:#f7faff;border:1px solid #dce5f0;border-radius:8px;font-family:"JetBrains Mono",monospace;font-size:11px;line-height:1.45;color:#273b55;overflow-wrap:anywhere;word-break:break-all}
.payment-copy-button{display:inline-flex;width:82px;min-width:82px;min-height:44px;align-items:center;justify-content:center;gap:6px;padding:8px 10px;background:#3157d5;border:1px solid #3157d5;border-radius:8px;color:#fff;font-size:12px;font-weight:700}
.payment-copy-button:active{background:#2449bd;transform:scale(.98)}
.payment-status-row{display:flex;min-width:0;align-items:flex-start;justify-content:space-between;gap:12px;margin-top:14px;padding-top:13px;border-top:1px solid #e6edf5}
.payment-status-value{min-width:0;text-align:right;font-size:12px;font-weight:700;color:#3157d5;overflow-wrap:anywhere}
.payment-status-value.is-delayed{color:#b05f00}
.payment-polling-note{margin-top:8px;font-size:11px;line-height:1.5;color:#74859a;overflow-wrap:anywhere}
.payment-error{margin-bottom:12px;padding:11px 12px;background:#fff1f1;border:1px solid #ffcaca;border-radius:8px;font-size:12px;line-height:1.5;color:#b42318;overflow-wrap:anywhere}
.payment-primary-button{display:flex;width:100%;min-height:48px;align-items:center;justify-content:center;padding:12px 16px;background:#3157d5;border:1px solid #3157d5;border-radius:8px;color:#fff;font-size:14px;font-weight:700;box-shadow:0 5px 16px #3157d533}
.payment-primary-button:disabled{cursor:not-allowed;opacity:.55}
.payment-success{display:flex;align-items:center;justify-content:center;padding:24px 16px;text-align:center}
.payment-success-content{width:100%;max-width:360px}
.payment-success-icon{display:flex;width:72px;height:72px;margin:0 auto 16px;align-items:center;justify-content:center;background:#e9f8ef;border-radius:50%;color:#1f9d55}
.payment-success-content>p{max-width:310px;margin:8px auto 18px}
.payment-receipt{min-width:0;margin-bottom:16px;padding:12px 14px;background:#fff;border:1px solid #dce5f0;border-radius:8px;text-align:left}
.payment-receipt-row{display:flex;min-width:0;justify-content:space-between;gap:12px;padding:7px 0;font-size:12px;color:#667085}
.payment-receipt-row strong{min-width:0;color:#273b55;text-align:right;overflow-wrap:anywhere}
.payment-transaction{word-break:break-all}
@media(max-width:360px){.payment-network-grid{grid-template-columns:1fr}.payment-address-row{flex-direction:column}.payment-copy-button{width:100%;min-width:0}.payment-status-row{flex-direction:column;gap:4px}.payment-status-value{text-align:left}}
`
);

for (const file of [
  "server.cjs",
  "public/assets/index-DTEWTEAe.js",
]) {
  const absolute = path.join(root, file);
  const content = fs.readFileSync(absolute, "utf8");
  const normalized = content
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n/g, "\r\n");
  if (normalized !== content) fs.writeFileSync(absolute, normalized, "utf8");
}

console.log("Production bundles are up to date.");
