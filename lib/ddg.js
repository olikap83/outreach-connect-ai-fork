// Shared DuckDuckGo HTML-results fetcher used by both the daily discovery
// cron (api/search.js) and the on-demand per-contact lookup (api/lookup.js).
// No API key, no account, no billing card.

const cheerio = require('cheerio');

const DDG_ENDPOINT = 'https://html.duckduckgo.com/html/';

// A UA that plainly announces itself as a bot ("Connect.AI-Alumni-Tracker")
// gets stonewalled by DuckDuckGo's anti-bot page far more often than a
// standard browser UA does. This isn't spoofing to evade something we
// shouldn't access — it's a public results page anyone's browser can
// load; a bot-labeled UA was just triggering the same wall a scraper
// announcing itself would.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const BLOCK_MARKERS = ['anomaly-modal', 'unusual traffic', 'detected an unusual amount'];

async function ddgSearch(query) {
  const resp = await fetch(DDG_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': BROWSER_UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    body: new URLSearchParams({ q: query }).toString(),
    signal: AbortSignal.timeout(12000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const html = await resp.text();
  const $ = cheerio.load(html);

  const items = [];
  $('.result').each((_, el) => {
    const $el = $(el);
    const title = $el.find('.result__a').first().text().trim();
    const snippet = $el.find('.result__snippet').first().text().trim();
    const link = $el.find('.result__a').first().attr('href') || '';
    if (title) items.push({ title, snippet, link });
  });

  if (items.length === 0) {
    const lower = html.toLowerCase();
    const blocked = BLOCK_MARKERS.some(m => lower.includes(m));
    const err = new Error(blocked
      ? 'DuckDuckGo returned its anti-bot page instead of results (rate-limited or blocked this server\'s IP).'
      : `No results parsed from a ${html.length}-byte response (page shape may have changed, or genuinely no results).`);
    err.diagnostic = true;
    err.htmlLength = html.length;
    err.blocked = blocked;
    throw err;
  }

  return items;
}

module.exports = { ddgSearch };
