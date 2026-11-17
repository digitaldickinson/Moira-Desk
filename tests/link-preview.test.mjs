// link-preview function: which links are fetched, redirect checks, and what
// comes back from a page. Uses fake responses; set MOIRA_LIVE_PREVIEW=1 to
// also fetch the real example pages.
import assert from 'node:assert/strict';
import { siteOf, extractPreview, fetchPreview, decodeEntities } from '../supabase/functions/link-preview/preview.js';

const MEN = 'https://www.manchestereveningnews.co.uk/news/greater-manchester-news/m56-traffic-live-drivers-face-34922134';
const BBC = 'https://www.bbc.co.uk/news/articles/c8752wyv155xo';

assert.equal(siteOf(MEN), 'men');
assert.equal(siteOf(BBC), 'bbc');
assert.equal(siteOf('http://bbc.co.uk/news/x'), 'bbc');
assert.equal(siteOf('https://www.bbc.com/news/x'), 'bbc');
for (const bad of ['https://bbc.co.uk.evil.example/x', 'https://evilbbc.co.uk/x', 'https://news.bbc.co.uk/x', 'https://user:pw@www.bbc.co.uk/x',
  'https://www.bbc.co.uk:8443/x', 'ftp://www.bbc.co.uk/x', 'javascript:alert(1)', 'https://explore.pa.media/x', '', null, 'https://www.bbc.co.uk/' + 'a'.repeat(2000)]) {
  assert.equal(siteOf(bad), null, String(bad).slice(0, 60));
}
console.log('PASS: only BBC News and MEN links are looked up');

assert.deepEqual(extractPreview('<head><title>X</title><meta data-rh="true" property="og:title" content="Hundreds of properties hit by power cuts after cable &amp; pylon incident"/></head>', 'bbc'),
  { title: 'Hundreds of properties hit by power cuts after cable & pylon incident', description: '', publishedAt: '', modifiedAt: '', siteName: 'BBC News' });
// MEN: meta tags. BBC: structured data in the head. Junk dates are dropped.
assert.deepEqual(extractPreview('<meta property="og:description" content="Two lanes are shut off"/><meta property="article:published_time" content="2026-11-17T09:22:24.000Z"/><meta property="article:modified_time" content="2026-11-17T10:00:00Z"/>', 'men'),
  { title: '', description: 'Two lanes are shut off', publishedAt: '2026-11-17T09:22:24.000Z', modifiedAt: '2026-11-17T10:00:00.000Z', siteName: 'Manchester Evening News' });
const ld = extractPreview('<script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2026-11-17T08:46:54.678Z","dateModified":"2026-11-17T09:01:00.000Z"}</script><meta name="description" content="Customers remain without power.">', 'bbc');
assert.deepEqual([ld.description, ld.publishedAt, ld.modifiedAt], ['Customers remain without power.', '2026-11-17T08:46:54.678Z', '2026-11-17T09:01:00.000Z']);
assert.deepEqual([extractPreview('<meta property="article:published_time" content="yesterday">', 'men').publishedAt, extractPreview('"datePublished":"1066-10-14T00:00:00Z"', 'bbc').publishedAt], ['', '']);
assert.equal(extractPreview(`<meta content='Council&#x27;s &quot;levy&quot; plan' name="twitter:title">`, 'men').title, 'Council\'s "levy" plan');
assert.equal(extractPreview('<title>M56 traffic LIVE as drivers face long queues - Manchester Evening News</title>', 'men').title, 'M56 traffic LIVE as drivers face long queues');
// Escaped markup stays as text: the desk only ever puts it in an input's value.
assert.equal(extractPreview('<meta property="og:title" content="&lt;b&gt;Plain&lt;/b&gt;"><title>T</title>', 'bbc').title, '<b>Plain</b>');
assert.equal(extractPreview('<html><body>nothing</body></html>', 'bbc').title, '');
const long = extractPreview(`<meta property="og:title" content="${'word '.repeat(80)}">`, 'bbc').title;
assert.ok(long.length <= 221 && long.endsWith('word…'));
assert.equal(decodeEntities('&#8220;Hi&#8221; &bogus; &#0;'), '“Hi” &bogus; &#0;');
console.log('PASS: headline read from og:title, twitter:title or <title>, decoded, tags stripped, capped');

const page = (html, extra = {}) => new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...extra });
const redirect = (to) => new Response(null, { status: 301, headers: { location: to } });
function fakeFetch(routes) {
  const seen = [];
  const f = async (url, opts) => { seen.push(url); assert.equal(opts.redirect, 'manual'); const r = routes[url]; if (!r) throw new Error('unexpected ' + url); return r(); };
  f.seen = seen;
  return f;
}

let f = fakeFetch({ [MEN]: () => page('<head><meta property="og:title" content="M56 traffic LIVE"></head><body>' + 'x'.repeat(1000) + '</body>') });
assert.deepEqual(await fetchPreview(MEN, f), { title: 'M56 traffic LIVE', description: '', publishedAt: '', modifiedAt: '', siteName: 'Manchester Evening News', site: 'men' });

f = fakeFetch({ 'http://bbc.co.uk/news/a': () => redirect('https://bbc.co.uk/news/a'), 'https://bbc.co.uk/news/a': () => redirect('/news/b'),
  'https://bbc.co.uk/news/b': () => page('<meta property="og:title" content="Power cuts">') });
assert.equal((await fetchPreview('http://bbc.co.uk/news/a', f)).title, 'Power cuts');
assert.deepEqual(f.seen, ['http://bbc.co.uk/news/a', 'https://bbc.co.uk/news/a', 'https://bbc.co.uk/news/b'], 'relative redirects followed');

f = fakeFetch({ [BBC]: () => redirect('http://169.254.169.254/latest/meta-data') });
await assert.rejects(fetchPreview(BBC, f), (e) => e.status === 502 && /redirects somewhere else/.test(e.message));
assert.deepEqual(f.seen, [BBC], 'never follows a redirect off the list');

let n = 0;
await assert.rejects(fetchPreview(BBC, async () => redirect(`${BBC}?n=${++n}`)), /too many times/);
assert.equal(n, 4, 'three redirects followed, then it gives up');

await assert.rejects(fetchPreview('https://example.org/x', fakeFetch({})), (e) => e.status === 400);
await assert.rejects(fetchPreview(BBC, fakeFetch({ [BBC]: () => new Response('no', { status: 404 }) })), /answered 404/);
await assert.rejects(fetchPreview(BBC, fakeFetch({ [BBC]: () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }) })), /isn't a web page/);
let tries = 0;
await assert.rejects(fetchPreview(BBC, async () => { tries++; throw new TypeError('network'); }), /Couldn't reach/);
assert.equal(tries, 2, 'one retry after a network error');
tries = 0;
assert.equal((await fetchPreview(BBC, async () => (++tries === 1 ? Promise.reject(new TypeError('reset')) : page('<meta property="og:title" content="Second try">')))).title, 'Second try');

// Stops reading at </head>: a page that never ends still returns.
let pulls = 0;
const endless = new ReadableStream({ pull(c) { pulls++; c.enqueue(new TextEncoder().encode(pulls === 1 ? '<head><meta property="og:title" content="Top"></head>' : 'x'.repeat(10000))); } });
assert.equal((await fetchPreview(BBC, async () => new Response(endless, { headers: { 'content-type': 'text/html' } }))).title, 'Top');
assert.ok(pulls <= 2, 'stopped after the head');
let big = 0;
const noHead = new ReadableStream({ pull(c) { big++; c.enqueue(new TextEncoder().encode('x'.repeat(50000))); } });
assert.equal((await fetchPreview(BBC, async () => new Response(noHead, { headers: { 'content-type': 'text/html' } }))).title, '');
assert.ok(big <= 7, 'read is capped');
console.log('PASS: redirects re-checked and capped, errors reported, only the top of the page read');

if (process.env.MOIRA_LIVE_PREVIEW) {
  for (const url of [MEN, BBC]) {
    const r = await fetchPreview(url);
    assert.ok(r.title.length > 10, url);
    assert.ok(r.publishedAt && r.description, url);
    console.log(`LIVE: ${r.site} ${r.title} | ${r.publishedAt} / ${r.modifiedAt} | ${r.description}`);
  }
}
