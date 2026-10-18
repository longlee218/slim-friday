/**
 * Documentation layout styles (appended to the base `CSS`): top bar, sticky sidebar with the outline, reading-width
 * content, heading permalinks, copy buttons, back-to-top, and the drawer on phones. Colors come from the base variables.
 */
export const DOC_CSS = `
html{scroll-behavior:smooth}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
:root{--bar:56px;--side:288px}
.topbar{position:sticky;top:0;z-index:20;height:var(--bar);display:flex;align-items:center;gap:12px;padding:0 16px;
background:var(--bg);border-bottom:1px solid var(--line)}
.topbar .name{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.badge{flex:none;font-size:12px;color:var(--mute);border:1px solid var(--line);border-radius:999px;padding:1px 10px}
#menu{display:none;flex:none;background:none;border:1px solid var(--line);border-radius:6px;color:var(--fg);font-size:18px;
width:36px;height:36px;cursor:pointer}
.layout{display:grid;grid-template-columns:var(--side) minmax(0,1fr);max-width:1240px;margin:0 auto}
.layout.solo{grid-template-columns:minmax(0,1fr)}
#side{position:sticky;top:var(--bar);align-self:start;height:calc(100vh - var(--bar));overflow-y:auto;padding:20px 12px 40px 16px;
border-right:1px solid var(--line);font-size:14px}
#side .label{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--mute);margin:0 0 8px 10px}
#side ul{list-style:none;margin:0;padding:0}
#side li{margin:0}
#side a{display:block;color:var(--mute);padding:5px 10px;border-left:2px solid transparent;border-radius:0 6px 6px 0;line-height:1.35}
#side a:hover{color:var(--fg);text-decoration:none;background:var(--code)}
#side a.on{color:var(--link);border-left-color:var(--link);background:var(--code);font-weight:600}
#side .l2 a{padding-left:24px}#side .l3 a{padding-left:38px;font-size:13px}
.layout main{max-width:820px;margin:0;padding:28px 32px 96px;min-width:0}
.layout main :is(h1,h2,h3,h4,h5,h6){scroll-margin-top:calc(var(--bar) + 16px);position:relative}
.anchor{margin-left:.4em;color:var(--mute);opacity:0;font-weight:400;text-decoration:none}
:is(h1,h2,h3,h4,h5,h6):hover .anchor,.anchor:focus{opacity:1}
.code-wrap{position:relative;margin:0 0 16px}.code-wrap pre{margin:0}
.copy{position:absolute;top:8px;right:8px;font-size:12px;font-family:inherit;line-height:1;background:var(--bg);color:var(--mute);border:1px solid var(--line);
border-radius:6px;padding:5px 9px;cursor:pointer;opacity:0;transition:opacity .15s}
.code-wrap:hover .copy,.copy:focus{opacity:1}.copy:hover{color:var(--fg)}
#top{position:fixed;right:20px;bottom:20px;z-index:20;width:42px;height:42px;border-radius:50%;border:1px solid var(--line);
background:var(--bg);color:var(--fg);font-size:18px;cursor:pointer;opacity:0;pointer-events:none;transition:opacity .2s}
#top.show{opacity:1;pointer-events:auto}
#veil{display:none}
@media(hover:none){.copy{opacity:1}.anchor{opacity:.6}}
@media(max-width:860px){
#menu{display:block}
.layout{grid-template-columns:minmax(0,1fr)}
#side{position:fixed;z-index:30;top:var(--bar);left:0;bottom:0;height:auto;width:min(320px,86vw);background:var(--bg);
transform:translateX(-100%);transition:transform .2s;border-right:1px solid var(--line)}
body.open #side{transform:none}
body.open #veil{display:block;position:fixed;inset:var(--bar) 0 0 0;z-index:25;background:rgba(0,0,0,.45)}
.layout main{padding:20px 16px 80px}
}
`;
