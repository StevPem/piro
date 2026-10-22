'use strict';

/**
 * Connection options for PiRO's outgoing HTTP requests (wspr.live,
 * wsprnet.org).
 *
 * Node tries each address of a host in turn ("happy eyeballs",
 * autoSelectFamily, on by default since Node 20) and gives each attempt
 * only 250 ms by default. Some Node versions apply that to the last
 * attempt too, so a server more than about 250 ms away fails at once with
 * ETIMEDOUT. From Australia, Europe is about 300 ms away (wspr.live is
 * there). So each attempt gets 5 s here: still quick to move from an IPv6
 * address that doesn't work to an IPv4 one.
 */
const ATTEMPT_TIMEOUT_MS = 5000;

const CONNECT_OPTIONS = { autoSelectFamily: true, autoSelectFamilyAttemptTimeout: ATTEMPT_TIMEOUT_MS };

/** The same for everything else in the process (the FreeDV Reporter connection, say). */
function applyDefaults(net = require('node:net')) {
  if (typeof net.setDefaultAutoSelectFamilyAttemptTimeout === 'function') net.setDefaultAutoSelectFamilyAttemptTimeout(ATTEMPT_TIMEOUT_MS);
}

module.exports = { CONNECT_OPTIONS, ATTEMPT_TIMEOUT_MS, applyDefaults };
