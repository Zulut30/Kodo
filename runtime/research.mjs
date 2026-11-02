import { createHash } from 'node:crypto';
import { requestJson, ProviderError, classifyProviderFailure } from './providers.mjs';
import { redact } from './process.mjs';

function contentExcerpt(value) {
  return String(value ?? '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 1800).trim();
}

function acceptableResult(url, source, query, title, excerpt) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return false;
  if (source === 'github') {
    const parts = parsed.pathname.split('/').filter(Boolean);
    return parsed.protocol === 'https:' && parsed.hostname === 'github.com' && parts.length >= 2 && !['search', 'topics', 'marketplace', 'sponsors', 'features', 'settings', 'login', 'signup', 'organizations', 'orgs', 'users', 'collections', 'trending', 'events', 'about'].includes(parts[0].toLowerCase());
  }
  if (source === 'hackernews') return parsed.protocol === 'https:' && parsed.hostname === 'news.ycombinator.com' && parsed.pathname === '/item' && /^\d+$/.test(parsed.searchParams.get('id') || '');
  if (source !== 'docs') return true;
  const documentationLocation = /^(?:docs?|developers?|learn|manual|reference|support)\./i.test(parsed.hostname) || /\.(?:readthedocs\.io|github\.io)$/i.test(parsed.hostname) || /\/(?:docs?|documentation|reference|api|manual|guide|guides)(?:\/|$)/i.test(parsed.pathname);
  const socialHosts = ['google.com', 'www.google.com', 'reddit.com', 'www.reddit.com', 'github.com', 'www.github.com', 'twitter.com', 'www.twitter.com', 'x.com', 'www.x.com'];
  if (parsed.protocol !== 'https:' || !documentationLocation || socialHosts.includes(parsed.hostname) || /(?:^|\/)explorer(?:\/|$)/i.test(parsed.pathname)) return false;
  const ignored = new Set(['official', 'documentation', 'implement', 'implementation', 'project', 'feature', 'application', 'library', 'libraries', 'using', 'with', 'from', 'that', 'this', 'support', 'file', 'files', 'code']);
  const keywords = query.toLowerCase().match(/[a-z][a-z0-9+#.-]{2,}/g)?.filter(word => !ignored.has(word)) || [];
  const evidence = `${parsed.hostname} ${parsed.pathname} ${title} ${excerpt}`.toLowerCase();
  return keywords.length > 0 && keywords.some(word => evidence.includes(word));
}

function walkResults(value, source, query, output = [], depth = 0) {
  if (!value || depth > 8 || output.length >= 8) return output;
  if (Array.isArray(value)) { for (const item of value) walkResults(item, source, query, output, depth + 1); return output; }
  if (typeof value !== 'object') return output;
  const data = value.data && !Array.isArray(value.data) ? { ...value, ...value.data } : value;
  const rawUrl = (source === 'reddit' ? data.permalink || data.url : data.url || data.permalink) || data.link || (data.id && (data.text || data.full_text) && source === 'x' ? `https://x.com/i/status/${data.id}` : null);
  if (rawUrl && (data.title || data.text || data.full_text || data.selftext || data.snippet || data.description)) {
    const url = rawUrl.startsWith('/') ? `https://www.reddit.com${rawUrl}` : rawUrl;
    try {
      const title = String(data.title || data.text || data.full_text).slice(0, 200);
      const excerpt = contentExcerpt(data.selftext || data.snippet || data.description || data.text || data.full_text || data.title);
      if (acceptableResult(url, source, query, title, excerpt)) output.push({ url, title, source, excerpt, license: null, compatibility: 'not checked', verification: 'discovery only; inspect primary documentation and reproduce before adoption' });
    } catch { /* An invalid returned URL is not a usable source. */ }
  }
  for (const [key, item] of Object.entries(value)) if (key !== 'data' || !rawUrl) walkResults(item, source, query, output, depth + 1);
  return output;
}

function parseSearchHtml(html, source, query) {
  const items = [];
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let url = match[1].replace(/&amp;/g, '&');
    if (url.startsWith('/url?')) url = new URL(url, 'https://www.google.com').searchParams.get('q') || '';
    try {
      const parsed = new URL(url);
      const title = contentExcerpt(match[2]);
      if (!title || !acceptableResult(parsed.href, source, query, title, title) || items.some(item => item.url === parsed.href)) continue;
      items.push({ url: parsed.href, title, source, excerpt: title, license: null, compatibility: 'not checked', verification: 'discovery only; inspect primary documentation and reproduce before adoption' });
      if (items.length === 8) break;
    } catch { /* Skip navigation and invalid links. */ }
  }
  return items;
}

export async function research({ task, reason = 'initial', budget = 40, cache = [], signal } = {}, { secrets = {}, fetchImpl = fetch } = {}) {
  if (typeof task !== 'string' || !task.trim()) throw new ProviderError('Для исследования нужна непустая задача', 'invalid_output');
  if (!Number.isInteger(budget) || budget < 0 || budget > 1000) throw new ProviderError('Некорректный бюджет исследования', 'invalid_output');
  const normalizedTask = task.replace(/\s+/g, ' ').trim().slice(0, 250);
  const cached = new Map(cache.map(item => [item.key, item]));
  const items = [], errors = [];
  let requests = 0;
  const jobs = [
    { source: 'reddit', key: 'REDDIT_API_KEY', url: () => `https://api.redditapis.com/api/reddit/search?q=${encodeURIComponent(normalizedTask)}&limit=8`, headers: () => ({ Authorization: `Bearer ${secrets.REDDIT_API_KEY}` }) },
    { source: 'x', key: 'GETX_API_KEY', url: () => `https://api.getxapi.com/twitter/tweet/advanced_search?q=${encodeURIComponent(normalizedTask)}&product=Top`, headers: () => ({ Authorization: `Bearer ${secrets.GETX_API_KEY}` }) },
    ...[['github', 'github.com'], ['hackernews', 'news.ycombinator.com'], ['docs', null]].map(([source, domain]) => ({ source, key: 'SCRAPEDO_TOKEN', html: true, url: () => {
      const query = `${domain ? `site:${domain}` : 'official documentation'} ${normalizedTask}`;
      // Google's HTML frequently defers its organic results. Use the vendor's
      // maintained structured SERP parser instead of treating that shell as data.
      return `https://api.scrape.do/plugin/google/search?token=${encodeURIComponent(secrets.SCRAPEDO_TOKEN)}&q=${encodeURIComponent(query)}`;
    }, headers: () => ({}) }))
  ];
  for (const job of jobs) {
    signal?.throwIfAborted();
    const key = createHash('sha256').update(JSON.stringify(['research-v2', job.source, normalizedTask])).digest('hex');
    const previous = cached.get(key);
    if (previous) { items.push(...previous.items); continue; }
    if (!secrets[job.key]) { errors.push({ source: job.source, code: 'auth', error: `Не настроен ${job.key}` }); continue; }
    if (requests >= budget) { errors.push({ source: job.source, code: 'budget', error: 'Предел исследовательских запросов достигнут' }); continue; }
    requests++;
    try {
      let found;
      if (job.html) {
        const response = await fetchImpl(job.url(), { method: 'GET', headers: job.headers(), signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60000)]) });
        const body = await response.text();
        if (!response.ok) throw new ProviderError(`Scrape.do HTTP ${response.status}`, response.status === 401 || response.status === 403 ? 'auth' : response.status === 429 ? 'quota' : 'unavailable');
        if (body.length > 4 * 1024 * 1024) throw new ProviderError('Страница исследования слишком большая', 'invalid_output');
        let parsed;
        try { parsed = JSON.parse(body); } catch { /* Raw HTML fallback remains useful for alternate Scrape.do responses. */ }
        if (parsed?.error || parsed?.success === false || parsed?.status === 'error') throw classifyProviderFailure(parsed.message || parsed.error || 'Источник вернул ошибку', { secrets });
        found = parsed ? walkResults(parsed, job.source, normalizedTask) : parseSearchHtml(body, job.source, normalizedTask);
      } else {
        const result = await requestJson(job.url(), { headers: job.headers(), signal, fetchImpl, secrets, retries: 0, timeoutMs: 60000 });
        if (result.error || result.success === false || result.status === 'error') throw classifyProviderFailure(result.message || result.error || 'Источник вернул ошибку', { secrets });
        found = walkResults(result, job.source, normalizedTask);
      }
      const unique = [...new Map(found.map(item => [item.url, item])).values()];
      const entry = { key, source: job.source, query: normalizedTask, reason, items: unique, fetchedAt: new Date().toISOString() };
      cached.set(key, entry); items.push(...unique);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      errors.push({ source: job.source, code: error.code || 'unavailable', error: redact(error.message, secrets) });
    }
  }
  return { items: [...new Map(items.map(item => [item.url, item])).values()], requests, errors, cache: [...cached.values()] };
}
