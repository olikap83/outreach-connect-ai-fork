#!/usr/bin/env node
// Quick check that OpenStreetMap answers for a few places: prints how many
// businesses each returns and how long it took, or the error.
//   node scripts/osm-probe.js 'Atlanta, GA' 'Boston, MA'
const { sourceTownFromOsm } = require('../lib/outreach/sources');
(async () => {
  for (const place of process.argv.slice(2)) {
    const t = Date.now();
    try {
      const found = await sourceTownFromOsm(place);
      console.log(`${place}: ${found.length} businesses in ${Math.round((Date.now() - t) / 1000)}s; e.g. ${found.slice(0, 3).map(p => p.name).join(', ')}`);
    } catch (err) {
      console.log(`${place}: ERROR after ${Math.round((Date.now() - t) / 1000)}s: ${err.message}`);
    }
  }
})();
