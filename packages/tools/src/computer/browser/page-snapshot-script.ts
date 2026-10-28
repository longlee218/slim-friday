/**
 * Function source evaluated as `(<script>)(gen)` in an isolated world (`Page.createIsolatedWorld`), so page JS
 * cannot tamper with it. It lists visible interactive elements, keeps them in a page-side Map keyed by the
 * generation (older generations are dropped) and returns a `RawSnapshot`. Password values are never read.
 */
export const PAGE_SNAPSHOT_SCRIPT = `(gen) => {
  const MAX = 80;
  const SELECTOR = 'a[href],button,input,select,textarea,summary,[contenteditable=""],[contenteditable="true"],'
    + '[role=button],[role=link],[role=checkbox],[role=menuitem],[role=tab]';
  const roleOf = (el) => {
    const r = el.getAttribute('role');
    if (r) return r;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea' || el.isContentEditable) return 'textbox';
    if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase();
      if (t === 'password') return 'password';
      if (['checkbox', 'radio'].includes(t)) return t;
      if (['button', 'submit', 'reset', 'image'].includes(t)) return 'button';
      return 'textbox';
    }
    return tag;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const nameOf = (el) => {
    const t = el.getAttribute('aria-label') || el.innerText || el.placeholder || el.title || el.alt
      || (el.type === 'password' ? '' : el.value) || '';
    return String(t).replace(/\\s+/g, ' ').trim().slice(0, 80);
  };
  const store = (globalThis.__fridayRefs = globalThis.__fridayRefs || new Map());
  for (const g of [...store.keys()]) if (g < gen) store.delete(g);
  const found = [];
  for (const el of document.querySelectorAll(SELECTOR)) {
    if (found.length >= MAX) break;
    if (visible(el)) found.push(el);
  }
  store.set(gen, found);
  const elements = found.map((el, i) => {
    const role = roleOf(el);
    const item = { i, role, name: nameOf(el) };
    if (el.type === 'password') {
      item.secret = true;
    } else if ('value' in el && el.value !== '' && !['checkbox', 'radio', 'button'].includes(role)) {
      item.value = String(el.value).slice(0, 200);
    }
    return item;
  });
  return {
    url: location.href,
    title: document.title,
    text: (document.body ? document.body.innerText : '').slice(0, 5000),
    elements,
  };
}`;
