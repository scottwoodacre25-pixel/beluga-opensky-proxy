// Beluga Fleet Tracker — OpenSky proxy (Railway version)
//
// Same job as the Cloudflare Worker version: holds your OpenSky
// client_id/client_secret as environment variables, exchanges them for a
// bearer token server-side, and forwards requests to OpenSky's REST API —
// so the browser app never sees your secret and never hits OpenSky's CORS
// restrictions. Routes and response shapes are identical to the Worker
// version, so the tracker app doesn't need to know which one it's talking to.
//
// Routes:
//   GET /states?icao24=...&icao24=...          live positions (states/all)
//   GET /history?icao24=...&begin=<unix>&end=<unix>
//                                               past flights per aircraft
//                                               (flights/aircraft), one call
//                                               per icao24, results merged
//   GET /                                       plain health check
//
// Setup on Railway:
//   1. Push these two files (server.js, package.json) to a GitHub repo —
//      you can do this straight from github.com's web UI with "Add file ->
//      Create new file", no local git needed.
//   2. Railway dashboard -> New Project -> Deploy from GitHub repo -> pick
//      that repo. Railway detects Node.js and runs it automatically.
//   3. In the service's Variables tab, add:
//        OPENSKY_CLIENT_ID     = scottw25-api-client
//        OPENSKY_CLIENT_SECRET = (your client secret)
//   4. In Settings -> Networking, click "Generate Domain" to get a public
//      URL (Railway doesn't expose one by default).
//   5. Visit <your-domain>/states?icao24=395d66 to test it.
//   6. Paste that domain into the tracker app's "OpenSky Proxy" box.

const http = require('http');
const { URL } = require('url');

const TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const STATES_URL = 'https://opensky-network.org/api/states/all';
const FLIGHTS_URL = 'https://opensky-network.org/api/flights/aircraft';
const PORT = process.env.PORT || 3000;

let cachedToken = null;
let cachedExpiry = 0;

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
}

function describeError(err) {
  const parts = [String((err && err.message) || err)];
  let cause = err && err.cause;
  let depth = 0;
  while (cause && depth < 4) {
    parts.push(String(cause.message || cause.code || cause));
    cause = cause.cause;
    depth++;
  }
  return parts.join(' <- ');
}

async function getToken() {
  if (cachedToken && Date.now() < cachedExpiry) return cachedToken;

  let res;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.OPENSKY_CLIENT_ID || '',
        client_secret: process.env.OPENSKY_CLIENT_SECRET || '',
      }),
    });
  } catch (err) {
    throw new Error(`token request network failure: ${describeError(err)}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`token request failed: HTTP ${res.status} ${text}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  cachedExpiry = Date.now() + (data.expires_in || 1800) * 1000 - 30000;
  return cachedToken;
}

async function handleStates(url, token, res) {
  const icaos = url.searchParams.getAll('icao24');
  const upstream = new URL(STATES_URL);
  icaos.forEach((icao) => upstream.searchParams.append('icao24', icao));

  const r = await fetch(upstream.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await r.text();
  res.writeHead(r.status, corsHeaders());
  res.end(body);
}

async function handleHistory(url, token, res) {
  const icaos = url.searchParams.getAll('icao24');
  const begin = url.searchParams.get('begin');
  const end = url.searchParams.get('end');
  if (!icaos.length || !begin || !end) {
    res.writeHead(400, corsHeaders());
    res.end(JSON.stringify({ error: 'need icao24 (one or more), begin, end (unix seconds)' }));
    return;
  }

  const results = [];
  const errors = [];
  for (const icao of icaos) {
    const upstream = new URL(FLIGHTS_URL);
    upstream.searchParams.set('icao24', icao);
    upstream.searchParams.set('begin', begin);
    upstream.searchParams.set('end', end);
    try {
      const r = await fetch(upstream.toString(), { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) {
        errors.push({ icao24: icao, status: r.status });
        continue;
      }
      const flights = await r.json();
      (flights || []).forEach((f) => results.push(f));
    } catch (e) {
      errors.push({ icao24: icao, error: String((e && e.message) || e) });
    }
  }
  results.sort((a, b) => (a.firstSeen || 0) - (b.firstSeen || 0));
  res.writeHead(200, corsHeaders());
  res.end(JSON.stringify({ flights: results, errors }));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Beluga OpenSky proxy is running. Try /states?icao24=395d66');
    return;
  }

  try {
    const token = await getToken();
    if (url.pathname === '/states') return await handleStates(url, token, res);
    if (url.pathname === '/history') return await handleHistory(url, token, res);

    res.writeHead(404, corsHeaders());
    res.end(JSON.stringify({ error: 'not found — use /states or /history' }));
  } catch (err) {
    res.writeHead(502, corsHeaders());
    res.end(JSON.stringify({ error: describeError(err) }));
  }
});

server.listen(PORT, () => {
  console.log(`Beluga OpenSky proxy listening on port ${PORT}`);
});
