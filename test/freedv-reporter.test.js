// Run with: node test/freedv-reporter.test.js
'use strict';

const { EventEmitter } = require('events');
const { FreeDvReporterBridge } = require('../src/server/freedv-reporter');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`ok - ${msg}`);
  else {
    console.error(`FAIL - ${msg}`);
    failures++;
  }
}

class StubControlServer extends EventEmitter {
  constructor(state = {}) {
    super();
    // A real ControlServer's own cached state (see ws-server.js) — only
    // `frequency` is relevant to this bridge, which reads it once at
    // construction time to seed its own `_freqHz` (see freedv-reporter.js's
    // constructor doc comment on why: `listen()` primes `state.frequency`
    // from the radio before this bridge is even constructed, but doesn't
    // itself emit a 'frequency' event for that priming).
    this.state = { frequency: null, ...state };
  }
}

/**
 * A fake Socket.IO client Socket good enough for FreeDVReporterBridge's own
 * orchestration tests — there's no real qso.freedv.org connection possible
 * from this environment (see src/server/freedv-reporter.js's own doc
 * comment), so this is entirely about the bridge's own connect/disconnect
 * and event-emission logic, not the real service's behavior.
 */
class FakeSocket extends EventEmitter {
  constructor(url, opts) {
    super();
    this.url = url;
    this.opts = opts;
    this.emitted = [];
    this.disconnected = false;
  }
  emit(event, ...args) {
    // EventEmitter#emit is also how tests trigger 'connect'/'disconnect'
    // on this fake, so only record genuine outbound Socket.IO events (a
    // string event name plus a data payload) — not internal listener
    // dispatch, which passes no extra args for a bare notification.
    if (args.length > 0) this.emitted.push({ event, data: args[0] });
    return super.emit(event, ...args);
  }
  disconnect() {
    this.disconnected = true;
  }
}

function makeSocketFactory() {
  const created = [];
  const factory = (url, opts) => {
    const socket = new FakeSocket(url, opts);
    created.push(socket);
    return socket;
  };
  factory.created = created;
  return factory;
}

/**
 * Both the "FreeDV spot" checkbox AND the FreeDV chip itself have to be on
 * for this bridge to ever connect (see its own doc comment) — most tests
 * below only care about behavior *after* that's true, so this helper gets
 * there in one call rather than repeating both emits everywhere.
 */
function armWithSpotEnabled(controlServer) {
  controlServer.emit('freedv-spot-enabled', true);
  controlServer.emit('freedv-active', true);
}

async function run() {
  // --- constructor validation ---
  {
    let threw = false;
    try {
      // eslint-disable-next-line no-new
      new FreeDvReporterBridge({});
    } catch {
      threw = true;
    }
    check(threw, 'constructor throws without opts.controlServer');
  }

  // --- "FreeDV spot" defaults to off: arming FreeDV alone never connects ---
  {
    const controlServer = new StubControlServer();
    const socketFactory = makeSocketFactory();
    const bridge = new FreeDvReporterBridge({ controlServer, callsign: 'N0CALL', gridSquare: 'DM79', socketFactory });
    controlServer.emit('freedv-active', true); // no 'freedv-spot-enabled' emitted at all
    check(socketFactory.created.length === 0, '"FreeDV spot" defaults to off, so arming FreeDV alone (even with callsign+grid configured) never connects');
    bridge.stop();
  }

  // --- no callsign/grid: arming FreeDV (even with spot enabled) never connects at all ---
  {
    const controlServer = new StubControlServer();
    const socketFactory = makeSocketFactory();
    const bridge = new FreeDvReporterBridge({ controlServer, socketFactory });
    armWithSpotEnabled(controlServer);
    check(socketFactory.created.length === 0, 'no connection is made without both callsign and grid square configured, even with spotting enabled');
    bridge.stop();
  }
  {
    const controlServer = new StubControlServer();
    const socketFactory = makeSocketFactory();
    const bridge = new FreeDvReporterBridge({ controlServer, callsign: 'N0CALL', socketFactory });
    armWithSpotEnabled(controlServer);
    check(socketFactory.created.length === 0, 'callsign alone (no grid square) is still not enough to connect');
    bridge.stop();
  }

  // --- callsign+grid configured, spot enabled, FreeDV armed: connects with the right auth payload ---
  {
    const controlServer = new StubControlServer();
    const socketFactory = makeSocketFactory();
    const bridge = new FreeDvReporterBridge({
      controlServer,
      callsign: 'N0CALL',
      gridSquare: 'DM79ab12', // only the first 6 chars should be sent
      version: 'test/1.0',
      socketFactory,
    });
    armWithSpotEnabled(controlServer);

    check(socketFactory.created.length === 1, 'arming FreeDV with callsign+grid configured and spotting enabled connects exactly once');
    const socket = socketFactory.created[0];
    check(socket.opts.auth.role === 'report_wo', "connects with role 'report_wo' (reports but doesn't need the station list)");
    check(socket.opts.auth.callsign === 'N0CALL', 'auth payload carries the configured callsign');
    check(socket.opts.auth.grid_square === 'DM79ab', 'grid square is truncated to the first 6 characters');
    check(socket.opts.auth.version === 'test/1.0', 'auth payload carries the configured version string');
    check(socket.opts.path === '/socket.io/', "connects on the standard Socket.IO path '/socket.io/'");
    bridge.stop();
  }

  // --- enabling "FreeDV spot" while already armed connects immediately, without needing to re-arm ---
  {
    const controlServer = new StubControlServer();
    const socketFactory = makeSocketFactory();
    const bridge = new FreeDvReporterBridge({ controlServer, callsign: 'N0CALL', gridSquare: 'DM79', socketFactory });
    controlServer.emit('freedv-active', true); // armed first, spotting still off
    check(socketFactory.created.length === 0, 'armed but spotting still off: no connection yet');

    controlServer.emit('freedv-spot-enabled', true);

    check(socketFactory.created.length === 1, 'checking "FreeDV spot" while already armed connects right away');
    bridge.stop();
  }

  // --- unchecking "FreeDV spot" mid-session disconnects immediately, even without disarming ---
  {
    const controlServer = new StubControlServer();
    const socketFactory = makeSocketFactory();
    const bridge = new FreeDvReporterBridge({ controlServer, callsign: 'N0CALL', gridSquare: 'DM79', socketFactory });
    armWithSpotEnabled(controlServer);
    const socket = socketFactory.created[0];
    socket.emit('connect');

    controlServer.emit('freedv-spot-enabled', false);

    check(socket.disconnected, 'unchecking "FreeDV spot" disconnects immediately, without needing FreeDV to be disarmed too');
    bridge.stop();
  }

  // --- on connect, sends an initial freq_change (if known) and tx_report ---
  {
    const controlServer = new StubControlServer();
    const socketFactory = makeSocketFactory();
    const bridge = new FreeDvReporterBridge({ controlServer, callsign: 'N0CALL', gridSquare: 'DM79', socketFactory });
    controlServer.emit('frequency', 7177000); // known before FreeDV is even armed
    armWithSpotEnabled(controlServer);
    const socket = socketFactory.created[0];

    socket.emit('connect');

    const freqEvents = socket.emitted.filter((e) => e.event === 'freq_change');
    const txEvents = socket.emitted.filter((e) => e.event === 'tx_report');
    check(freqEvents.length === 1 && freqEvents[0].data.freq === 7177000, 'sends an initial freq_change with the already-known frequency on connect');
    check(
      txEvents.length === 1 && txEvents[0].data.mode === 'RADEV1' && txEvents[0].data.transmitting === false,
      'sends an initial tx_report on connect (default variant "RADE"/default radeVersion "v1" -> reported as "RADEV1", not transmitting)'
    );
    bridge.stop();
  }

  // --- no frequency known yet: connect sends no freq_change ---
  {
    const controlServer = new StubControlServer();
    const socketFactory = makeSocketFactory();
    const bridge = new FreeDvReporterBridge({ controlServer, callsign: 'N0CALL', gridSquare: 'DM79', socketFactory });
    armWithSpotEnabled(controlServer);
    const socket = socketFactory.created[0];
    socket.emit('connect');
    check(socket.emitted.filter((e) => e.event === 'freq_change').length === 0, "doesn't send freq_change on connect when no frequency is known yet");
    bridge.stop();
  }

  // --- frequency already known in controlServer.state at construction time is used, not left null ---
  {
    // Simulates ws-server.js's listen() having already primed state.frequency
    // from the radio before this bridge was even constructed (the normal
    // production order — see src/server/index.js).
    const controlServer = new StubControlServer({ frequency: 21074000 });
    const socketFactory = makeSocketFactory();
    const bridge = new FreeDvReporterBridge({ controlServer, callsign: 'N0CALL', gridSquare: 'DM79', socketFactory });
    armWithSpotEnabled(controlServer);
    const socket = socketFactory.created[0];

    socket.emit('connect');

    const freqEvents = socket.emitted.filter((e) => e.event === 'freq_change');
    check(
      freqEvents.length === 1 && freqEvents[0].data.freq === 21074000,
      "a frequency already known in controlServer.state at construction time (e.g. from listen()'s startup priming) is sent on connect, without needing a 'frequency' event first"
    );
    bridge.stop();
  }

  // --- a frequency change while connected is forwarded immediately ---
  {
    const controlServer = new StubControlServer();
    const socketFactory = makeSocketFactory();
    const bridge = new FreeDvReporterBridge({ controlServer, callsign: 'N0CALL', gridSquare: 'DM79', socketFactory });
    armWithSpotEnabled(controlServer);
    const socket = socketFactory.created[0];
    socket.emit('connect');

    controlServer.emit('frequency', 14236000);

    const freqEvents = socket.emitted.filter((e) => e.event === 'freq_change');
    check(freqEvents.length === 1 && freqEvents[0].data.freq === 14236000, 'a frequency change while connected is sent as freq_change');
    bridge.stop();
  }

  // --- a frequency change while NOT yet connected is not sent, but is remembered for the next connect ---
  {
    const controlServer = new StubControlServer();
    const socketFactory = makeSocketFactory();
    const bridge = new FreeDvReporterBridge({ controlServer, callsign: 'N0CALL', gridSquare: 'DM79', socketFactory });
    armWithSpotEnabled(controlServer);
    const socket = socketFactory.created[0];

    controlServer.emit('frequency', 3625000); // arrives before 'connect' fires

    check(socket.emitted.filter((e) => e.event === 'freq_change').length === 0, 'nothing is sent before the socket actually connects');
    socket.emit('connect');
    check(
      socket.emitted.filter((e) => e.event === 'freq_change').some((e) => e.data.freq === 3625000),
      'the frequency seen before connecting is still sent once connected'
    );
    bridge.stop();
  }

  // --- PTT changes while connected send a fresh tx_report ---
  {
    const controlServer = new StubControlServer();
    const socketFactory = makeSocketFactory();
    const bridge = new FreeDvReporterBridge({ controlServer, callsign: 'N0CALL', gridSquare: 'DM79', socketFactory });
    armWithSpotEnabled(controlServer);
    const socket = socketFactory.created[0];
    socket.emit('connect');

    controlServer.emit('ptt', true);

    const txEvents = socket.emitted.filter((e) => e.event === 'tx_report');
    check(txEvents.some((e) => e.data.transmitting === true), 'PTT engaging sends a tx_report with transmitting: true');
    bridge.stop();
  }

  // --- variant changes while connected send a fresh tx_report with the new mode ---
  // (RADE is reported with its waveform version suffixed, e.g. 'RADEV1' —
  // see the dedicated radeVersion tests further below for that in detail;
  // this one just confirms a variant change at all triggers a fresh report.)
  {
    const controlServer = new StubControlServer();
    const socketFactory = makeSocketFactory();
    const bridge = new FreeDvReporterBridge({ controlServer, callsign: 'N0CALL', gridSquare: 'DM79', socketFactory });
    armWithSpotEnabled(controlServer);
    const socket = socketFactory.created[0];
    socket.emit('connect');

    controlServer.emit('freedv-variant', 'RADE');

    const txEvents = socket.emitted.filter((e) => e.event === 'tx_report');
    check(txEvents.some((e) => e.data.mode === 'RADEV1'), 'switching variant sends a fresh tx_report naming the new mode');
    bridge.stop();
  }

  // --- RADE is reported as 'RADEV1'/'RADEV2' (per this server's own radeVersion), not bare 'RADE' ---
  {
    const controlServer = new StubControlServer();
    const socketFactory = makeSocketFactory();
    const bridge = new FreeDvReporterBridge({
      controlServer,
      callsign: 'N0CALL',
      gridSquare: 'DM79',
      radeVersion: 'v2',
      socketFactory,
    });
    armWithSpotEnabled(controlServer);
    const socket = socketFactory.created[0];
    socket.emit('connect');

    controlServer.emit('freedv-variant', 'RADE');

    const txEvents = socket.emitted.filter((e) => e.event === 'tx_report');
    check(txEvents.some((e) => e.data.mode === 'RADEV2'), "radeVersion: 'v2' reports the RADE variant as 'RADEV2'");
    bridge.stop();
  }

  // --- radeVersion defaults to 'v1' (mirroring index.js's own RADE_VERSION default) when omitted ---
  {
    const controlServer = new StubControlServer();
    const socketFactory = makeSocketFactory();
    const bridge = new FreeDvReporterBridge({ controlServer, callsign: 'N0CALL', gridSquare: 'DM79', socketFactory });
    armWithSpotEnabled(controlServer);
    const socket = socketFactory.created[0];
    socket.emit('connect');

    controlServer.emit('freedv-variant', 'RADE');

    const txEvents = socket.emitted.filter((e) => e.event === 'tx_report');
    check(txEvents.some((e) => e.data.mode === 'RADEV1'), "radeVersion defaults to 'v1' when not configured");
    bridge.stop();
  }

  // --- '700E' is reported as-is, with no version suffix (it has no version split) — still supported internally even though the client UI can no longer select it ---
  {
    const controlServer = new StubControlServer();
    const socketFactory = makeSocketFactory();
    const bridge = new FreeDvReporterBridge({
      controlServer,
      callsign: 'N0CALL',
      gridSquare: 'DM79',
      radeVersion: 'v2',
      socketFactory,
    });
    controlServer.emit('freedv-variant', '700E'); // the bridge's own default is now 'RADE', not '700E' — see its constructor doc comment
    armWithSpotEnabled(controlServer);
    const socket = socketFactory.created[0];
    socket.emit('connect');

    const txEvents = socket.emitted.filter((e) => e.event === 'tx_report');
    check(txEvents.some((e) => e.data.mode === '700E'), "'700E' is reported as-is regardless of radeVersion");
    bridge.stop();
  }

  // --- 'freedv-message' sends a message_update while connected ---
  {
    const controlServer = new StubControlServer();
    const socketFactory = makeSocketFactory();
    const bridge = new FreeDvReporterBridge({ controlServer, callsign: 'N0CALL', gridSquare: 'DM79', socketFactory });
    armWithSpotEnabled(controlServer);
    const socket = socketFactory.created[0];
    socket.emit('connect');

    controlServer.emit('freedv-message', 'Looking for contacts');

    const messageEvents = socket.emitted.filter((e) => e.event === 'message_update');
    check(
      messageEvents.some((e) => e.data.message === 'Looking for contacts'),
      "a 'freedv-message' event while connected sends message_update with the new message"
    );
    bridge.stop();
  }

  // --- the current message (even '') is (re-)sent on every connect, so a re-arm/reconnect restores or clears it ---
  {
    const controlServer = new StubControlServer();
    const socketFactory = makeSocketFactory();
    const bridge = new FreeDvReporterBridge({ controlServer, callsign: 'N0CALL', gridSquare: 'DM79', socketFactory });
    armWithSpotEnabled(controlServer);
    const socket = socketFactory.created[0];

    socket.emit('connect');

    const messageEvents = socket.emitted.filter((e) => e.event === 'message_update');
    check(
      messageEvents.length === 1 && messageEvents[0].data.message === '',
      "connect sends an initial message_update with '' when no message has been set yet"
    );
    bridge.stop();
  }

  // --- a message already known in controlServer.state at construction time is used, mirroring frequency's own seeding ---
  {
    const controlServer = new StubControlServer({ freeDvMessage: 'QRP today' });
    const socketFactory = makeSocketFactory();
    const bridge = new FreeDvReporterBridge({ controlServer, callsign: 'N0CALL', gridSquare: 'DM79', socketFactory });
    armWithSpotEnabled(controlServer);
    const socket = socketFactory.created[0];

    socket.emit('connect');

    const messageEvents = socket.emitted.filter((e) => e.event === 'message_update');
    check(
      messageEvents.some((e) => e.data.message === 'QRP today'),
      "a message already known in controlServer.state at construction time is sent on connect, without needing a 'freedv-message' event first"
    );
    bridge.stop();
  }

  // --- message_update while NOT connected is silently dropped, same as tx_report/freq_change ---
  {
    const controlServer = new StubControlServer();
    const socketFactory = makeSocketFactory();
    const bridge = new FreeDvReporterBridge({ controlServer, callsign: 'N0CALL', gridSquare: 'DM79', socketFactory });

    controlServer.emit('freedv-message', 'Looking for contacts');

    check(socketFactory.created.length === 0, 'a message update while FreeDV was never armed makes no connection and is silently dropped');
    bridge.stop();
  }

  // --- PTT/variant changes while NOT armed (not connected) are silently ignored ---
  {
    const controlServer = new StubControlServer();
    const socketFactory = makeSocketFactory();
    const bridge = new FreeDvReporterBridge({ controlServer, callsign: 'N0CALL', gridSquare: 'DM79', socketFactory });

    controlServer.emit('ptt', true);
    controlServer.emit('freedv-variant', 'RADE');
    controlServer.emit('frequency', 7177000);
    controlServer.emit('freedv-message', 'Looking for contacts');

    check(
      socketFactory.created.length === 0,
      'no connection is made just from PTT/variant/frequency/message activity while FreeDV was never armed'
    );
    bridge.stop();
  }

  // --- disarming FreeDV disconnects ---
  {
    const controlServer = new StubControlServer();
    const socketFactory = makeSocketFactory();
    const bridge = new FreeDvReporterBridge({ controlServer, callsign: 'N0CALL', gridSquare: 'DM79', socketFactory });
    armWithSpotEnabled(controlServer);
    const socket = socketFactory.created[0];
    socket.emit('connect');

    controlServer.emit('freedv-active', false);

    check(socket.disconnected, 'disarming FreeDV disconnects the socket');
    bridge.stop();
  }

  // --- re-arming after disarming reconnects fresh (spot-enabled state persists across re-arms) ---
  {
    const controlServer = new StubControlServer();
    const socketFactory = makeSocketFactory();
    const bridge = new FreeDvReporterBridge({ controlServer, callsign: 'N0CALL', gridSquare: 'DM79', socketFactory });
    controlServer.emit('freedv-spot-enabled', true);
    controlServer.emit('freedv-active', true);
    controlServer.emit('freedv-active', false);
    controlServer.emit('freedv-active', true);

    check(socketFactory.created.length === 2, 're-arming after disarming makes a brand new connection, without needing to re-check the box');
    bridge.stop();
  }

  // --- stop() disconnects and stops listening ---
  {
    const controlServer = new StubControlServer();
    const socketFactory = makeSocketFactory();
    const bridge = new FreeDvReporterBridge({ controlServer, callsign: 'N0CALL', gridSquare: 'DM79', socketFactory });
    armWithSpotEnabled(controlServer);
    const socket = socketFactory.created[0];

    bridge.stop();

    check(socket.disconnected, 'stop() disconnects any active connection');
    check(controlServer.listenerCount('freedv-active') === 0, "stop() removes this bridge's 'freedv-active' listener");
    check(controlServer.listenerCount('freedv-variant') === 0, "stop() removes this bridge's 'freedv-variant' listener");
    check(controlServer.listenerCount('ptt') === 0, "stop() removes this bridge's 'ptt' listener");
    check(controlServer.listenerCount('frequency') === 0, "stop() removes this bridge's 'frequency' listener");
    check(controlServer.listenerCount('freedv-spot-enabled') === 0, "stop() removes this bridge's 'freedv-spot-enabled' listener");
    check(controlServer.listenerCount('freedv-message') === 0, "stop() removes this bridge's 'freedv-message' listener");

    armWithSpotEnabled(controlServer);
    check(socketFactory.created.length === 1, 'events after stop() are ignored (no new connection)');
  }

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

run();
