// Run with: node test/band-conditions.test.js
'use strict';

const { EventEmitter } = require('events');
const bc = require('../src/server/band-conditions');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok - ${msg}`);
  else {
    console.error(`FAIL - ${msg}`);
    failures++;
  }
}

(async () => {
  {
    const mel = bc.gridToLatLon('QF22');
    const km = bc.distanceKm(mel, bc.gridToLatLon('FN42'));
    check(Math.abs(mel.lat + 37.5) < 0.01 && Math.abs(mel.lon - 145) < 0.01, 'QF22 is centred on 37.5 S 145 E');
    check(km > 16000 && km < 17500, `QF22 to FN42 (Melbourne to Boston) is about 16,700 km (${Math.round(km)})`);
    const six = bc.gridToLatLon('QF22lb');
    check(Math.abs(six.lon - (144 + 11 * (5 / 60) + 2.5 / 60)) < 1e-9 && bc.gridToLatLon('XX99') === null, '6-character grids are placed in their subsquare; bad grids give null');
  }
  {
    check(bc.squareAndNeighbours('QF22').join() === 'QF13,QF23,QF33,QF12,QF22,QF32,QF11,QF21,QF31', 'the 3x3 squares around QF22');
    check(bc.squareAndNeighbours('qf22lb').length === 9, 'from a 6-character grid too');
    const corner = bc.squareAndNeighbours('AA00');
    check(corner.length === 6 && corner.includes('RA90') && corner.includes('AA01'), `longitude wraps; no squares past the pole: ${corner.join(' ')}`);
  }
  {
    check(bc.bandForHz(14097100) === '20m' && bc.bandForHz(7040100) === '40m' && bc.bandForHz(1838100) === '160m' && bc.bandForHz(50294000) === '6m' && bc.bandForHz(5287200) === null, 'frequencies are put on their band (60 m is not one of PiRO\'s)');
    check(['Great', 'Good', 'Average', 'Bad', 'Dismal'].join() === [12000, 5000, 4999, 1000, 999].map(bc.tagForRange).join(), 'range tags: Great >= 10,000 km, Good >= 5,000, Average >= 2,500, Bad >= 1,000, else Dismal');
    check(bc.rangeOf([100, 200, 300, 400, 20000]) === 400 && bc.rangeOf([3000]) === 3000, 'the range is the 80th percentile, so one far spot does not decide it');
    const q = bc.localQuery(['QF22', 'QF23']);
    check(/INTERVAL 60 MINUTE/.test(q) && /IN \('QF22','QF23'\)/.test(q) && /FORMAT JSONCompact$/.test(q) && /GROUP BY f, tx_sign/.test(q), 'the wspr.live query: last hour, the squares, per frequency and transmitter');
  }
  {
    let t = Date.UTC(2026, 9, 22, 6, 0);
    const queries = [];
    let rows = [
      [1409, 'K1ABC', 16500, ['VK3TR', 'VK3XYZ']],
      [1409, 'JA1XYZ', 8200, ['VK3TR']],
      [1409, 'ZL2AA', 2600, ['VK3ABC']],
      [704, 'VK2AA', 700, ['VK3TR']],
      [704, 'VK4BB', 1600, ['VK3TR']],
      [526, 'XX1X', 9999, ['VK3TR']], // 60 m: not a PiRO band
    ];
    let fail = null;
    const query = async (sql) => {
      queries.push(sql);
      if (fail) throw new Error(fail);
      return rows;
    };
    const cs = new EventEmitter();
    const conditions = new bc.BandConditions({ controlServer: cs, grid: 'QF22LB', query, now: () => t });
    conditions.start();
    // heard here: 20 m twice (K1ABC far, ZL nearer), 40 m listened to but nothing heard
    cs.emit('wspr-slot-decoded', {
      slotStartMs: t - 30 * 60000,
      dialHz: 14095600,
      decodes: [
        { callsign: 'K1ABC', grid: 'FN42', message: 'K1ABC FN42 37' },
        { callsign: 'ZL2AA', grid: 'RE78', message: 'ZL2AA RE78 30' },
        { callsign: 'PJ4/K1ABC', grid: '', message: 'PJ4/K1ABC 37' }, // no grid: no distance
      ],
    });
    cs.emit('wspr-slot-decoded', { slotStartMs: t - 20 * 60000, dialHz: 7038600, decodes: [] });
    cs.emit('wspr-slot-decoded', { slotStartMs: t - 200 * 60000, dialHz: 3568600, decodes: [{ callsign: 'VK2AA', grid: 'QF56' }] }); // too old
    const r = await conditions.report();
    const band = (b) => r.bands.find((x) => x.band === b);
    check(r.bands.map((b) => b.band).join() === '160m,80m,40m,30m,20m,17m,15m,12m,10m,6m', 'one row per band, 160 m to 6 m');
    check(band('20m').myQth.tag === 'Great' && band('20m').myQth.stations === 2 && band('20m').myQth.rangeKm > 16000, `My QTH 20 m: ${band('20m').myQth.tag}, ${band('20m').myQth.rangeKm} km, ${band('20m').myQth.stations} stations`);
    check(band('40m').myQth.tag === 'Dismal' && band('40m').myQth.rangeKm === 0, 'My QTH 40 m: listened, heard nothing: Dismal');
    check(band('80m').myQth.tag === 'N/A' && band('15m').myQth.tag === 'N/A', 'My QTH: bands not listened to in the last 90 minutes are N/A');
    check(band('20m').local.tag === 'Great' && band('20m').local.rangeKm === 16500 && band('20m').local.stations === 3 && band('20m').local.reporters === 3, `Local area 20 m: ${band('20m').local.tag} (${band('20m').local.rangeKm} km, 3 heard by 3 reporters)`);
    check(band('40m').local.tag === 'Bad' && band('40m').local.rangeKm === 1600, `Local area 40 m: ${band('40m').local.tag}`);
    check(band('10m').local.tag === 'N/A' && !r.localError && r.localUpdatedMs === t, 'Local area: no spots is N/A');
    check(queries.length === 1 && /'QF22'/.test(queries[0]) && /'QF33'/.test(queries[0]) && r.squares.length === 9, 'wspr.live is asked about the 9 squares around QF22');
    t += 5 * 60000;
    await conditions.report();
    check(queries.length === 1, 'within 10 minutes the local area is not asked again');
    t += 6 * 60000;
    fail = 'wspr.live did not answer';
    const r2 = await conditions.report();
    check(queries.length === 2 && r2.localError === 'wspr.live did not answer' && r2.bands.find((x) => x.band === '20m').local.tag === 'Great' && r2.localUpdatedMs === t - 11 * 60000, 'when wspr.live fails, the last answer is shown, with its time and the error');
    const two = await Promise.all([conditions.report(), conditions.report()]);
    check(queries.length === 3 && two.length === 2, 'a failed fetch is tried again next time, once for requests that arrive together');
    conditions.stop();
    check(cs.listenerCount('wspr-slot-decoded') === 0, 'stop() removes its listener');
  }
  {
    const conditions = new bc.BandConditions({ controlServer: new EventEmitter(), grid: '', query: async () => { throw new Error('should not be asked'); } });
    const r = await conditions.report();
    check(r.bands.every((b) => b.myQth.tag === 'N/A' && b.local.tag === 'N/A') && /No grid set/.test(r.localError) && /No grid set/.test(r.myError), 'with no grid set: all N/A, and the window says why');
  }
  {
    const rows = bc.localFromRows([[1409, 'A1A', 100, ['R1']], [1409, 'A1A', 900, ['R2']]]);
    check(rows['20m'].byTx.get('A1A') === 900 && rows['20m'].reporters.size === 2, 'a station heard by several reporters counts once, at its farthest');
  }

  if (failures) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\nall band conditions tests passed');
})();
