'use strict';
// Manual (not part of `npm test`): checks the "Local area" column of Current
// conditions from this machine. Run it on the Pi:
//   node test/manual-wspr-live.js QF22
// It sends the same queries the server does to wspr.live and prints what
// comes back. No radio needed.
const bc = require('../src/server/band-conditions');

const grid = (process.argv[2] || process.env.WSPR_GRID || process.env.STATION_GRID || '').trim().toUpperCase();
if (!/^[A-R]{2}[0-9]{2}/.test(grid)) {
  console.error('Give a grid, e.g.: node test/manual-wspr-live.js QF22 (or set WSPR_GRID / STATION_GRID)');
  process.exit(2);
}
const squares = bc.squareAndNeighbours(grid);
console.log(`Grid ${grid}; local area: ${squares.join(' ')}`);

(async () => {
  let ok = false;
  for (const [name, sql, toBands] of [
    ['grouped query', bc.localQuery(squares), bc.localFromRows],
    ['plain query', bc.localRowsQuery(squares), bc.localFromSpotRows],
  ]) {
    const t0 = Date.now();
    try {
      const rows = await bc.wsprLiveQuery(sql);
      const bands = toBands(rows);
      console.log(`\n${name}: OK, ${rows.length} rows in ${Date.now() - t0} ms`);
      for (const b of Object.keys(bands)) {
        const d = [...bands[b].byTx.values()];
        const km = Math.round(bc.rangeOf(d));
        console.log(`  ${b.padEnd(5)} ${bc.tagForRange(km).padEnd(8)} ${String(km).padStart(6)} km  ${d.length} heard by ${bands[b].reporters.size} reporters`);
      }
      if (!Object.keys(bands).length) console.log('  (no spots on PiRO bands from reporters in these squares in the last hour)');
      ok = true;
    } catch (err) {
      console.log(`\n${name}: FAILED after ${Date.now() - t0} ms: ${err.message}`);
    }
  }
  process.exit(ok ? 0 : 1);
})();
