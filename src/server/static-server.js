'use strict';

const fs = require('fs');
const path = require('path');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/**
 * Creates a plain http request handler that serves static files from
 * `rootDir`. Deliberately minimal — no ranges, no conditional requests,
 * no compression — this is an app shell served over a LAN, not a CDN.
 *
 * `/` serves `index.html`; any other path not found under rootDir gets a
 * 404 (no SPA history-fallback, since there's no client-side router yet).
 * Requests are confined to rootDir (basic path-traversal protection).
 */
function createStaticHandler(rootDir) {
  const root = path.resolve(rootDir);

  return function staticHandler(req, res) {
    let urlPath;
    try {
      // A malformed escape (e.g. "/%E0") throws URIError. Thrown here, in
      // the request handler, it would stop the whole server, possibly
      // while transmitting.
      urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad request');
      return;
    }
    if (urlPath.includes('\0')) {
      // fs throws on a NUL in a path rather than calling back with an error
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad request');
      return;
    }
    if (urlPath === '/') urlPath = '/index.html';

    const resolved = path.normalize(path.join(root, urlPath));
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    fs.readFile(resolved, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      const ext = path.extname(resolved).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
      res.end(data);
    });
  };
}

module.exports = { createStaticHandler };
