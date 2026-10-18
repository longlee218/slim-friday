import { createHash } from "node:crypto";

/**
 * The ONE script of a markdown page. Static text: no artifact content is ever interpolated into it, and the page's CSP
 * allows exactly this text by its sha256 (`DOC_SCRIPT_CSP_SOURCE`). It only touches the DOM the layout already holds:
 * drawer toggle (phones), sidebar scrollspy, copy buttons on code blocks, back-to-top button.
 */
export const DOC_SCRIPT = `(()=>{
const d=document,b=d.body,side=d.getElementById("side");
const shut=()=>b.classList.remove("open");
// Drawer (phones): the menu button toggles it, the veil and any sidebar link close it.
d.getElementById("menu")?.addEventListener("click",()=>b.classList.toggle("open"));
d.getElementById("veil")?.addEventListener("click",shut);
const links=new Map();
d.querySelectorAll("#side a").forEach((a)=>{links.set(a.getAttribute("href").slice(1),a);a.addEventListener("click",shut)});
// Scrollspy: the last heading above the top edge is the current section; its link is highlighted and kept in view.
const heads=[...d.querySelectorAll("main h1[id],main h2[id],main h3[id]")];
let cur=null;
const spy=()=>{
let id=heads.length?heads[0].id:null;
for(const h of heads){if(h.getBoundingClientRect().top<=90)id=h.id;else break}
if(id===cur)return;
links.get(cur)?.classList.remove("on");
const a=links.get(id);
if(a&&side){a.classList.add("on");const r=a.getBoundingClientRect(),s=side.getBoundingClientRect();
if(r.top<s.top+40||r.bottom>s.bottom-40)side.scrollTop+=r.top-s.top-side.clientHeight/2}
cur=id};
// Copy buttons: every code block gets a wrapper and a button.
d.querySelectorAll("main pre").forEach((pre)=>{
const w=d.createElement("div");w.className="code-wrap";pre.replaceWith(w);w.append(pre);
const btn=d.createElement("button");btn.type="button";btn.className="copy";btn.textContent="Copy";
btn.addEventListener("click",()=>{
navigator.clipboard.writeText(pre.innerText).then(()=>{btn.textContent="Copied";setTimeout(()=>{btn.textContent="Copy"},1500)}).catch(()=>{})});
w.append(btn)});
// Back to top: shown after the first screens.
const top=d.getElementById("top");
top?.addEventListener("click",()=>window.scrollTo({top:0,behavior:"smooth"}));
const onScroll=()=>{spy();top?.classList.toggle("show",window.scrollY>600)};
addEventListener("scroll",onScroll,{passive:true});onScroll();
})();`;

/** CSP `script-src` source that allows exactly `DOC_SCRIPT` and nothing else. */
export const DOC_SCRIPT_CSP_SOURCE = `'sha256-${createHash("sha256").update(DOC_SCRIPT).digest("base64")}'`;
