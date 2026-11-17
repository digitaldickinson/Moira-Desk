// Headline lookup for a pasted BBC News or Manchester Evening News link.
// Plain JavaScript so the function (Deno) and the tests (Node) share it.
//
// Only these sites are fetched. Each redirect is checked against the same
// list, only the top of the page is read, nothing on the page is run, and
// only the headline and site name come back.

export const SITES = {
  bbc: { name: 'BBC News', hosts: ['bbc.co.uk', 'www.bbc.co.uk', 'bbc.com', 'www.bbc.com'] },
  men: { name: 'Manchester Evening News', hosts: ['manchestereveningnews.co.uk', 'www.manchestereveningnews.co.uk'] },
};
const MAX_URL = 2000;
const MAX_BYTES = 300_000;   // both sites put their headline tags well inside this
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 6000;

// 'bbc' | 'men' for a fetchable link, otherwise null.
export function siteOf(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_URL) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  return Object.keys(SITES).find((k) => SITES[k].hosts.includes(host)) || null;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k in ENTITIES) return ENTITIES[k];
    const n = k.startsWith('#x') ? parseInt(k.slice(2), 16) : k.startsWith('#') ? parseInt(k.slice(1), 10) : NaN;
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
  });
}
const clean = (s) => decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

function metaContent(html, names) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const key = (tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1]?.toLowerCase();
    if (!key || !names.includes(key)) continue;
    const content = (tag.match(/\bcontent\s*=\s*"([^"]*)"/i) || tag.match(/\bcontent\s*=\s*'([^']*)'/i) || [])[1];
    if (content && clean(content)) return clean(content);
  }
  return '';
}

// { title, siteName } from the top of a page; title '' if none was found.
export function extractPreview(html, site) {
  const siteName = SITES[site]?.name || '';
  let title = metaContent(html, ['og:title', 'twitter:title']);
  if (!title) {
    title = clean((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
    // "<headline> - Manchester Evening News", "<headline> - BBC News"
    title = title.replace(/\s+[-|–]\s+(?:BBC(?: News| Sport)?|Manchester Evening News)$/i, '');
  }
  if (title.length > 220) title = title.slice(0, 220).replace(/\s+\S*$/, '') + '…';
  return { title, siteName };
}

async function readTop(res) {
  if (!res.body) return '';
  const reader = res.body.getReader(), decoder = new TextDecoder();
  let html = '', bytes = 0;
  try {
    while (bytes < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      html += decoder.decode(value, { stream: true });
      if (/<\/head>/i.test(html)) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return html;
}

export class PreviewError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Fetch the page and pull out its headline. fetchImpl is swappable for tests.
export async function fetchPreview(url, fetchImpl = fetch) {
  let site = siteOf(url);
  if (!site) throw new PreviewError(400, 'Only BBC News and Manchester Evening News links can be looked up.');
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res;
    try {
      res = await fetchImpl(current, {
        redirect: 'manual', signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MoiraDesk link preview)', Accept: 'text/html' },
      });
    } catch {
      throw new PreviewError(502, "Couldn't reach that page.");
    }
    if (res.status >= 300 && res.status < 400) {
      res.body?.cancel?.().catch?.(() => {});
      let next;
      try { next = new URL(res.headers.get('location') || '', current).href; } catch { next = ''; }
      site = siteOf(next);
      if (!site) throw new PreviewError(502, 'That link redirects somewhere else.');
      current = next;
      continue;
    }
    if (!res.ok) {
      res.body?.cancel?.().catch?.(() => {});
      throw new PreviewError(502, `That page answered ${res.status}.`);
    }
    if (!/text\/html|application\/xhtml/i.test(res.headers.get('content-type') || '')) {
      res.body?.cancel?.().catch?.(() => {});
      throw new PreviewError(502, "That link isn't a web page.");
    }
    return { ...extractPreview(await readTop(res), site), site };
  }
  throw new PreviewError(502, 'That link redirects too many times.');
}
