// The pasted URL stays in the browser. The destination Relay owns authentication.
const openLink = `const form = document.querySelector('form');
const field = form.elements.link;
field.addEventListener('input', () => field.setCustomValidity(''));
form.addEventListener('submit', event => {
  event.preventDefault();
  const url = URL.parse(field.value);
  if (url && (url.protocol === 'https:' || url.protocol === 'http:')) {
    location.assign(url.href);
  } else {
    field.setCustomValidity(field.dataset.invalid);
    field.reportValidity();
  }
});`;

export function serveShareEntry(req, res) {
  const path = req.url.split('?', 1)[0];
  const page = path === '/' || path === '/index.html';
  if ((!page && path !== '/open-share.js') || (req.method !== 'GET' && req.method !== 'HEAD')) {
    res.writeHead(403, {'cache-control':'no-store'}).end();
    return;
  }
  const chinese = /^zh\b/i.test(req.headers['accept-language'] ?? '');
  const title = chinese ? '打开共享会话' : 'Open a shared session';
  const label = chinese ? 'Live Share 链接' : 'Live Share link';
  const help = chinese ? '粘贴会话所有者发给你的链接。' : 'Paste the link from the session owner.';
  const invalid = chinese ? '请输入 HTTP 或 HTTPS 链接。' : 'Enter an HTTP or HTTPS link.';
  const button = chinese ? '打开会话' : 'Open session';
  res.writeHead(200, {
    'content-type':page ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8',
    'cache-control':'no-store', 'referrer-policy':'no-referrer', 'x-content-type-options':'nosniff',
    'content-security-policy':"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  if (req.method === 'HEAD') { res.end(); return; }
  if (!page) { res.end(openLink); return; }
  res.end(`<!doctype html><html lang="${chinese ? 'zh-CN' : 'en'}"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · RSIversi</title>
<style>:root{color-scheme:light dark;font:100%/1.5 system-ui,sans-serif}body{margin:0}main{max-width:27rem;margin:clamp(3rem,18vh,11rem) auto;padding:1.5rem}h1{font-size:1.65rem;line-height:1.25}label,input,button{font:inherit}label{display:block;font-weight:600}input{box-sizing:border-box;width:100%;padding:.55rem .7rem;margin:.4rem 0 1rem}button{padding:.45rem .9rem;cursor:pointer}</style>
<main><h1>${title}</h1><p id="help">${help}</p>
<form><label for="link">${label}</label><input id="link" type="url" required autocomplete="off" aria-describedby="help" data-invalid="${invalid}">
<button type="submit">${button}</button></form></main><script type="module" src="/document/open-share.js"></script></html>`);
}
