'use strict';

// Offline demo: PiRO's NORMAL startup against a localhost synthetic radio.
// No physical radio, ALSA device, network discovery or RF transmission.
const { spawn } = require('node:child_process');
const path = require('node:path');
const { IcomPeer } = require('./fixtures/icom-lan-peer');

function serverEnvironment(peer) {
  const o = peer.config();
  return { ...process.env, CIV_CONNECTION: 'lan', ICOM_LAN_HOST: o.host,
    ICOM_LAN_USERNAME: o.username, ICOM_LAN_PASSWORD: o.password,
    ICOM_LAN_CONTROL_PORT: String(o.controlPort), ICOM_LAN_CIV_PORT: String(o.civPort),
    ICOM_LAN_AUDIO_PORT: String(o.audioPort), AUDIO_RX_DEVICE: '', AUDIO_TX_DEVICE: '',
    AUDIO_SAMPLE_RATE: '48000', AUDIO_CHANNELS: '1', WS_PORT: '0',
    CIV_SCOPE_ENABLED: '1', STATION_CALLSIGN: '', STATION_GRID: '',
    FREEDV_REPORTER_ENABLED: '0', WSPR_UNATTENDED: '0', WSPR_UPLOAD: '0',
    RADIO_IDLE_SETTINGS_PATH: '', // Fixtures never read/write the operator's saved preference.
    SCREEN_TITLE: 'PiRO offline LAN demo' };
}

async function main() {
  const peer = await new IcomPeer().start();
  const child = spawn(process.execPath, [path.join(__dirname, '../src/server/index.js')], {
    env: serverEnvironment(peer), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let shown = false;
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text);
    const match = text.match(/listening on http:\/\/0\.0\.0\.0:(\d+)/);
    if (match && !shown) {
      shown = true;
      console.log(`\nOffline demo: http://127.0.0.1:${match[1]} — synthetic radio; no RF. Ctrl-C stops it.\n`);
    }
  });
  child.stderr.pipe(process.stderr);
  let sample = 0;
  const timer = setInterval(() => {
    if (!peer.associations.audio || !peer.associations.civ) return;
    const pcm = Buffer.alloc(1920);
    for (let n = 0; n < 960; n++) pcm.writeInt16LE(Math.round(Math.sin(sample++ * 2 * Math.PI * 600 / 48000) * 1200), n * 2);
    peer.rxAudio(pcm.subarray(0, 1364));
    peer.rxAudio(pcm.subarray(1364));
  }, 20);
  const scopeTimer = setInterval(() => {
    if (!peer.associations.civ) return;
    const points = Buffer.from(Array.from({ length: 475 }, (_, i) => Math.round(20 + 100 * Math.exp(-(((i - 237) / 14) ** 2)))));
    peer.replyCiv(Buffer.concat([Buffer.from('270000010100', 'hex'), peer.frequency,
      Buffer.from('005002000000', 'hex'), points]));
  }, 200);
  const stop = () => child.kill('SIGTERM');
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  child.once('exit', async (code) => {
    clearInterval(timer);
    clearInterval(scopeTimer);
    await peer.close();
    process.exitCode = code || 0;
  });
}

if (require.main === module) main().catch((err) => { console.error(err.message); process.exitCode = 1; });
module.exports = { serverEnvironment };
