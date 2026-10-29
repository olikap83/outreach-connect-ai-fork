// Open tracker for Main Street Outreach, a Cloudflare Worker (free plan).
//
// Every email the desk sends carries a 1x1 image whose address names that
// email: https://<worker>/o/<email id>.gif. When the reader's mail app loads
// the image, this records the time and the network it came from, then
// returns the image. The desk's sync job reads the records back with
// GET /opens?key=<SECRET>.
//
// Setup (Cloudflare dashboard, no command line):
//   1. Workers & Pages > Create > Worker. Name it, Deploy, then Edit code and
//      paste this file over the starter code. Deploy.
//   2. Storage & Databases > KV > Create a namespace called "opens".
//   3. The worker > Settings > Bindings > Add > KV namespace: variable name
//      OPENS, namespace "opens".
//   4. The worker > Settings > Variables and Secrets > Add, type Secret:
//      SECRET = any long random string. Deploy.

const GIF = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), c => c.charCodeAt(0));

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const hit = url.pathname.match(/^\/o\/([A-Za-z0-9._-]{4,120})\.gif$/);
    if (hit) {
      const id = hit[1];
      const at = new Date().toISOString();
      const cf = request.cf || {};
      const record = {
        id, at,
        network: cf.asOrganization || null,
        city: cf.city || null, region: cf.region || null, country: cf.country || null,
        agent: (request.headers.get('user-agent') || '').slice(0, 200),
      };
      // Keys sort by email id, then time; kept for a year.
      const key = `o:${id}:${at}:${Math.random().toString(36).slice(2, 8)}`;
      ctx.waitUntil(env.OPENS.put(key, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 365 }));
      return new Response(GIF, {
        headers: {
          'content-type': 'image/gif',
          'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
          'pragma': 'no-cache',
          'expires': '0',
        },
      });
    }
    if (url.pathname === '/opens') {
      if (!env.SECRET || url.searchParams.get('key') !== env.SECRET) return new Response('Not allowed', { status: 403 });
      const out = [];
      let cursor;
      do {
        const page = await env.OPENS.list({ prefix: 'o:', cursor, limit: 1000 });
        for (const k of page.keys) {
          const v = await env.OPENS.get(k.name);
          if (v) out.push(JSON.parse(v));
        }
        cursor = page.list_complete ? null : page.cursor;
      } while (cursor && out.length < 20000);
      return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } });
    }
    return new Response('Main Street Outreach open tracker', { status: 200 });
  },
};
