/**
 * The only styles of the viewer (inline, no external CSS, font or script). GitHub-like typography, light and dark
 * through `prefers-color-scheme`, highlight.js token colors (github / github-dark palettes) for server-side highlighting.
 */
export const CSS = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1f2328;--mute:#656d76;--line:#d0d7de;--code:#f6f8fa;--link:#0969da;
--kw:#cf222e;--str:#0a3069;--num:#0550ae;--cmt:#6e7781;--fn:#8250df;--attr:#116329;--add:#116329;--del:#82071e}
@media(prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--mute:#8d96a0;--line:#30363d;--code:#161b22;--link:#4493f8;
--kw:#ff7b72;--str:#a5d6ff;--num:#79c0ff;--cmt:#8b949e;--fn:#d2a8ff;--attr:#7ee787;--add:#7ee787;--del:#ffa198}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif;
-webkit-text-size-adjust:100%;overflow-wrap:break-word}
main{max-width:860px;margin:0 auto;padding:16px 16px 64px}
h1,h2,h3,h4,h5,h6{line-height:1.25;margin:1.6em 0 .6em;font-weight:600}
h1{font-size:2em;padding-bottom:.3em;border-bottom:1px solid var(--line)}
h2{font-size:1.5em;padding-bottom:.3em;border-bottom:1px solid var(--line)}h3{font-size:1.25em}h4{font-size:1em}
h5,h6{font-size:.9em;color:var(--mute)}
main>:first-child{margin-top:0}
p,ul,ol,blockquote,pre,.table-wrap{margin:0 0 16px}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
ul,ol{padding-left:2em}li+li{margin-top:.25em}li>p{margin:0 0 8px}
li.task{list-style:none;margin-left:-1.4em}li.task input{margin:0 .5em .2em 0;vertical-align:middle}
code,pre{font:85% ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
code{background:var(--code);border-radius:6px;padding:.2em .4em}
pre{background:var(--code);border-radius:6px;padding:16px;overflow:auto;line-height:1.45;word-break:normal}
pre code{background:none;padding:0;font-size:100%}
blockquote{padding:0 1em;border-left:.25em solid var(--line);color:var(--mute)}blockquote>:last-child{margin-bottom:0}
hr{height:.25em;padding:0;margin:24px 0;background:var(--line);border:0}
.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{border-collapse:collapse;width:max-content;min-width:100%}
th,td{border:1px solid var(--line);padding:6px 13px;text-align:left;vertical-align:top}th{font-weight:600}
tr:nth-child(2n) td{background:var(--code)}
img{max-width:100%}del{color:var(--mute)}
.hljs-keyword,.hljs-selector-tag,.hljs-literal,.hljs-doctag,.hljs-meta .hljs-keyword{color:var(--kw)}
.hljs-string,.hljs-regexp,.hljs-meta .hljs-string{color:var(--str)}
.hljs-number,.hljs-symbol,.hljs-bullet,.hljs-variable,.hljs-template-variable{color:var(--num)}
.hljs-comment,.hljs-quote,.hljs-meta{color:var(--cmt)}
.hljs-title,.hljs-section,.hljs-title.function_,.hljs-title.class_{color:var(--fn)}
.hljs-attr,.hljs-attribute,.hljs-name,.hljs-tag,.hljs-built_in,.hljs-type{color:var(--attr)}
.hljs-addition{color:var(--add)}.hljs-deletion{color:var(--del)}
.hljs-emphasis{font-style:italic}.hljs-strong{font-weight:600}
.bar{color:var(--mute);font-size:14px}
iframe{border:0;width:100%;height:calc(100vh - 40px)}
`;
