// Wire-level tests for the local LAN transport (`putSigned` in src/local-api.ts),
// driven through the two public entry points that use it: LocalKumoClient and
// discoverDeviceIps.
//
// These run against a real `http.createServer`, not a mock, because the thing
// worth pinning is what actually goes out on the socket. The transport used to be
// node-fetch and nothing in the suite touched it: local-api.test.ts covers the
// pure token/mapping functions and local-integration.test.ts substitutes a fake
// client for the whole class, so the request line, the framing headers, the retry
// and the one-socket-per-exchange discipline were all unasserted. Swapping the
// transport with that hole open would have been a blind change — and local control
// is vendor-blocked right now (see AGENTS.md), so there is no hardware to catch it.
//
// `creds.ip` carries `127.0.0.1:<port>` throughout. The transport builds
// `http://${ip}/api?m=${token}` and lets the URL parser split host from port, so an
// ephemeral port needs no test seam in src/ — the same string a real deployment
// fills with a bare IPv4.

import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  LocalKumoClient,
  computeLocalToken,
  discoverDeviceIps,
  buildLocalCommandBody,
  STATUS_READ_BODY,
} from '../dist/local-api.js';
import { makeLog } from './helpers';

const SERIAL = 'TESTSERIAL001';
const CS = '0123456789abcdef0123';
const PW = Buffer.from('local-secret').toString('base64');

/** What the fake adapter saw on one exchange. */
interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
  /** Client-side port: two exchanges sharing one means the socket was reused. */
  remotePort: number | undefined;
}

interface Adapter {
  ip: string;
  seen: Seen[];
  close(): Promise<void>;
}

type Reply = (seen: Seen, res: http.ServerResponse) => void;

/** A JSON reply with the given status; the adapter answers 200 to everything real. */
const json = (payload: unknown, status = 200): Reply => (_seen, res) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
};

/** Start a fake adapter on an ephemeral port. `reply` of null never answers. */
async function startAdapter(reply: Reply | null): Promise<Adapter> {
  const seen: Seen[] = [];
  const sockets = new Set<import('node:net').Socket>();
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => {
      const record: Seen = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body,
        remotePort: req.socket.remotePort,
      };
      seen.push(record);
      if (reply) {
        reply(record, res);
      }
      // reply === null: hold the request open so the client's socket timeout is
      // the only thing that can end it.
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    ip: `127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close(() => resolve());
      }),
  };
}

function makeClient(ip: string, timeoutMs = 2000): LocalKumoClient {
  const client = new LocalKumoClient(makeLog() as never, timeoutMs);
  client.setCreds(SERIAL, { ip, password: PW, cryptoSerial: CS });
  return client;
}

/**
 * Reject if `p` outlasts `ms`, for the two tests that assert the transport times
 * out on its own.
 *
 * A runner-level `{ timeout }` is not enough on those. A transport that has lost
 * its timeout does not fail them, it hangs on them — and node:test marking the
 * test failed does not close the socket still sitting in the event loop, so the
 * whole run then hangs at exit instead of reporting. Verified by deleting the
 * option: the file sat for 60s and had to be killed. Rejecting here runs the
 * test's `finally`, which destroys the server side and lets the client settle.
 */
function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`${what} never settled — the transport lost its timeout`)), ms).unref();
    }),
  ]);
}

// ---- what goes out on the wire --------------------------------------------

test('a command is a signed PUT whose token covers the exact body sent', async () => {
  const adapter = await startAdapter(json({ r: { indoorUnit: { status: {} } } }));
  try {
    const body = buildLocalCommandBody({ spCool: 23 });
    const ok = await makeClient(adapter.ip).sendCommand(SERIAL, { spCool: 23 });

    assert.strictEqual(ok, true);
    assert.strictEqual(adapter.seen.length, 1, 'one exchange, no retry on success');
    const [req] = adapter.seen;
    assert.strictEqual(req.method, 'PUT');
    assert.strictEqual(
      req.url,
      `/api?m=${computeLocalToken(PW, CS, body)}`,
      'the token in the query string is the one computed over this body',
    );
    assert.strictEqual(req.body, body.toString('utf8'), 'the body arrives byte-for-byte');
  } finally {
    await adapter.close();
  }
});

test('the request carries the framing headers the adapter is spoken to with', async () => {
  const adapter = await startAdapter(json({ r: { indoorUnit: { status: { roomTemp: 22 } } } }));
  try {
    await makeClient(adapter.ip).request(SERIAL, STATUS_READ_BODY);

    const { headers } = adapter.seen[0];
    assert.strictEqual(headers['content-type'], 'application/json');
    assert.strictEqual(headers['accept'], 'application/json, text/plain, */*');
    // Length-framed, as node-fetch framed it, and not `Transfer-Encoding: chunked`.
    // Node derives the length from the single `req.end(body)`; this pins the wire
    // outcome rather than the header literal, so it holds however that is achieved.
    assert.strictEqual(headers['content-length'], String(STATUS_READ_BODY.length));
    assert.strictEqual(headers['transfer-encoding'], undefined, 'never chunked');
    // node-fetch advertised gzip and inflated the reply for us; nothing here can,
    // so the transport has to ask for none.
    assert.strictEqual(headers['accept-encoding'], 'identity');
  } finally {
    await adapter.close();
  }
});

test('every exchange gets its own socket — no connection is left parked on the adapter', async () => {
  // The load-bearing half of LOCAL_AGENT. undici's fetch ignores an `agent`, so
  // this is what a careless swap to global fetch would have silently broken: these
  // adapters have a tiny connection table and treat a pooled socket as an occupied
  // slot, which is why both reference implementations drop the connection after
  // every exchange.
  const adapter = await startAdapter(json({ r: { indoorUnit: { status: { roomTemp: 22 } } } }));
  try {
    const client = makeClient(adapter.ip);
    await client.request(SERIAL, STATUS_READ_BODY);
    await client.request(SERIAL, STATUS_READ_BODY);

    assert.strictEqual(adapter.seen.length, 2);
    const ports = new Set(adapter.seen.map((s) => s.remotePort));
    assert.strictEqual(ports.size, 2, 'a reused socket would show the same client port twice');
  } finally {
    await adapter.close();
  }
});

// ---- the { result, error } contract, over a real socket -------------------

test('an `r` payload comes back as the result with error "none"', async () => {
  const adapter = await startAdapter(json({ r: { indoorUnit: { status: { roomTemp: 21.5 } } } }));
  try {
    const out = await makeClient(adapter.ip).requestDetailed(SERIAL, STATUS_READ_BODY);
    assert.deepStrictEqual(out, {
      result: { indoorUnit: { status: { roomTemp: 21.5 } } },
      error: 'none',
    });
  } finally {
    await adapter.close();
  }
});

test('the HTTP status is not consulted — an `r` body under a 500 still succeeds', async () => {
  // Deliberate, and unchanged from the node-fetch version, which never read
  // `res.ok`: the adapter reports its own failures in the body, and a status-based
  // rejection would throw away a payload it did send.
  const adapter = await startAdapter(json({ r: { indoorUnit: { status: {} } } }, 500));
  try {
    const out = await makeClient(adapter.ip).requestDetailed(SERIAL, STATUS_READ_BODY);
    assert.strictEqual(out.error, 'none');
    assert.deepStrictEqual(out.result, { indoorUnit: { status: {} } });
  } finally {
    await adapter.close();
  }
});

test('device_authentication_error classifies as auth and is not retried', async () => {
  const adapter = await startAdapter(json({ _api_error: 'device_authentication_error' }));
  try {
    const out = await makeClient(adapter.ip).requestDetailed(SERIAL, STATUS_READ_BODY);
    assert.deepStrictEqual(out, { result: null, error: 'auth' });
    assert.strictEqual(adapter.seen.length, 1, 'a rejection says the same thing twice');
  } finally {
    await adapter.close();
  }
});

test('__no_memory classifies as busy, which discovery must not read as a stranger', async () => {
  const adapter = await startAdapter(json({ _api_error: '__no_memory' }));
  try {
    const out = await makeClient(adapter.ip).requestDetailed(SERIAL, STATUS_READ_BODY);
    assert.deepStrictEqual(out, { result: null, error: 'busy' });
  } finally {
    await adapter.close();
  }
});

test('a non-JSON reply is malformed, not a transport failure', async () => {
  const adapter = await startAdapter((_seen, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html>not this device</html>');
  });
  try {
    const out = await makeClient(adapter.ip).requestDetailed(SERIAL, STATUS_READ_BODY);
    assert.deepStrictEqual(out, { result: null, error: 'malformed' });
    assert.strictEqual(adapter.seen.length, 1, 'malformed is not retried either');
  } finally {
    await adapter.close();
  }
});

test('JSON that is neither `r` nor `_api_error` is malformed', async () => {
  const adapter = await startAdapter(json({ something: 'else' }));
  try {
    const out = await makeClient(adapter.ip).requestDetailed(SERIAL, STATUS_READ_BODY);
    assert.deepStrictEqual(out, { result: null, error: 'malformed' });
  } finally {
    await adapter.close();
  }
});

// ---- the timeout, which is now the socket's own -----------------------------

test('an adapter that accepts and never answers times out as transport, after one retry', async () => {
  // This is what `putSigned`'s `timeout` option replaced the Promise.race with.
  // The old race was a wall-clock cap because node-fetch v3 has no timeout option;
  // the socket timeout is armed before connect, so it covers this case and a dead
  // IP alike. 150ms so the retry costs 300ms, not 12s.
  const adapter = await startAdapter(null);
  try {
    const started = Date.now();
    const out = await withDeadline(
      makeClient(adapter.ip, 150).requestDetailed(SERIAL, STATUS_READ_BODY),
      4000,
      'requestDetailed against a silent adapter',
    );
    const elapsed = Date.now() - started;

    assert.deepStrictEqual(out, { result: null, error: 'transport' });
    assert.strictEqual(adapter.seen.length, 2, 'a transport failure is retried exactly once');
    assert.ok(elapsed >= 300, `both attempts waited out the timeout (took ${elapsed}ms)`);
    assert.ok(elapsed < 3000, `and neither hung past it (took ${elapsed}ms)`);
  } finally {
    await adapter.close();
  }
});

test('nothing listening on the port is a transport failure too', async () => {
  // Bind and immediately close, so the port is real, free and refusing.
  const adapter = await startAdapter(json({ r: {} }));
  const { ip } = adapter;
  await adapter.close();

  const out = await withDeadline(
    makeClient(ip, 1000).requestDetailed(SERIAL, STATUS_READ_BODY),
    4000,
    'requestDetailed against a closed port',
  );
  assert.deepStrictEqual(out, { result: null, error: 'transport' });
});

test('a request with no credentials never reaches the wire', async () => {
  const client = new LocalKumoClient(makeLog() as never, 1000);
  const out = await client.requestDetailed('UNKNOWN', STATUS_READ_BODY);
  assert.deepStrictEqual(out, { result: null, error: 'no-creds' });
});

// ---- getStatus over the real transport -------------------------------------

test('getStatus maps a live reply, and skips the sensor lookup on an unset source', async () => {
  const adapter = await startAdapter(
    json({
      r: {
        indoorUnit: {
          status: {
            mode: 'heat', roomTemp: 20.5, spHeat: 21, spCool: 24,
            fanSpeed: 'quiet', vaneDir: 'horizontal', tempSource: 'unset',
            filterDirty: true, defrost: false, standby: false,
          },
        },
      },
    }),
  );
  try {
    const status = await makeClient(adapter.ip).getStatus(SERIAL);
    assert.ok(status);
    assert.strictEqual(status.operationMode, 'heat');
    assert.strictEqual(status.power, 1);
    assert.strictEqual(status.roomTemp, 20.5);
    assert.strictEqual(status.airDirection, 'horizontal', 'vaneDir -> airDirection');
    assert.strictEqual(status.filterDirty, true);
    assert.strictEqual(status.connected, true);
    assert.strictEqual(adapter.seen.length, 1, 'tempSource "unset" buys no sensor request');
  } finally {
    await adapter.close();
  }
});

test('getStatus returns null when the reply carries no roomTemp', async () => {
  const adapter = await startAdapter(json({ r: { indoorUnit: { status: { mode: 'off' } } } }));
  try {
    assert.strictEqual(await makeClient(adapter.ip).getStatus(SERIAL), null);
  } finally {
    await adapter.close();
  }
});

// ---- discovery over the real transport --------------------------------------

test('discovery matches a serial to the adapter that authenticates its token', async () => {
  const mine = await startAdapter(json({ r: { indoorUnit: { status: { roomTemp: 22 } } } }));
  const stranger = await startAdapter(json({ _api_error: 'device_authentication_error' }));
  try {
    const found = await discoverDeviceIps(
      makeLog() as never,
      [stranger.ip, mine.ip],
      new Map([[SERIAL, { password: PW, cryptoSerial: CS }]]),
      { concurrency: 1, timeoutMs: 1000 },
    );

    assert.deepStrictEqual([...found], [[SERIAL, mine.ip]]);
    assert.strictEqual(stranger.seen.length, 1, 'the stranger was probed and ruled out');
    assert.strictEqual(
      stranger.seen[0].headers['accept'],
      '*/*',
      'the discovery probe keeps its own Accept',
    );
  } finally {
    await mine.close();
    await stranger.close();
  }
});

test('a busy adapter is left eligible rather than written off as a stranger', async () => {
  // The reason classifyApiError distinguishes busy from auth at all: a unit that
  // was out of memory during the sweep must not be stranded on cloud control.
  const busy = await startAdapter(json({ _api_error: 'serializer_error' }));
  try {
    const found = await discoverDeviceIps(
      makeLog() as never,
      [busy.ip],
      new Map([[SERIAL, { password: PW, cryptoSerial: CS }]]),
      { concurrency: 1, timeoutMs: 1000 },
    );
    assert.strictEqual(found.size, 0, 'not claimed');
  } finally {
    await busy.close();
  }
});

// ---- gaps found by mutation testing the first version of this file ----------
//
// Four mutations survived the original 16 cases. Each is pinned below, and each
// was re-checked by reapplying the mutation and confirming the new test fails.

test('the timeout is a per-call deadline, not a per-socket one', async () => {
  // LOCAL_AGENT is maxSockets: 1 per origin, and Node arms `timeout` when the agent
  // ASSIGNS a socket — so a queued request waits with no timer at all. The socket
  // timeout alone therefore made the cap per-socket: measured 2026-08-02 against a
  // silent server, 8 requests to one origin at a 500ms cap took 4022ms rather than
  // 503ms. `signal: AbortSignal.timeout(...)`, armed at call time, is what restores
  // the wall-clock bound the deleted Promise.race used to give.
  //
  // Distinct origins never queued and are not the risk; the reachable case is a
  // rediscovery sweep probing an IP the poller is already talking to.
  const silent = await startAdapter(null);
  try {
    const started = Date.now();
    await withDeadline(
      discoverDeviceIps(
        makeLog() as never,
        [silent.ip, silent.ip, silent.ip, silent.ip],
        new Map([[SERIAL, { password: PW, cryptoSerial: CS }]]),
        { concurrency: 4, timeoutMs: 400 },
      ),
      4000,
      'four queued probes',
    );
    const elapsed = Date.now() - started;
    assert.ok(
      elapsed < 1200,
      `four probes to one origin took ${elapsed}ms; a per-call deadline bounds them near 400ms, `
      + 'a per-socket one serialises them to ~1600ms',
    );
  } finally {
    await silent.close();
  }
});

test('a reply split across several writes is reassembled, not truncated', async () => {
  // Every other fake reply here is a single res.end(), so `text = chunk` and
  // `text += chunk` are indistinguishable and the accumulation was unpinned. A
  // truncation regression degrades to 'malformed', which attempt() does not retry.
  const payload = JSON.stringify({ r: { indoorUnit: { status: { roomTemp: 21.5 } } } });
  const split = Math.floor(payload.length / 2);
  const adapter = await startAdapter((_seen, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write(payload.slice(0, split));
    setTimeout(() => res.end(payload.slice(split)), 40);
  });
  try {
    const status = await makeClient(adapter.ip).getStatus(SERIAL);
    assert.ok(status, 'a chunked reply still parses');
    assert.strictEqual(status.roomTemp, 21.5);
  } finally {
    await adapter.close();
  }
});

test('an adapter that dies mid-reply settles as transport instead of hanging', async () => {
  // res.on('error') is the only thing that settles this promise. Without it the
  // request never resolves, and because requestDetailed runs inside withLock every
  // later local read and write for that serial queues behind it forever.
  const adapter = await startAdapter((_seen, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '40' });
    res.write('{"r":{"indoorUnit"');
    setTimeout(() => res.socket?.destroy(), 20);
  });
  try {
    const status = await withDeadline(
      makeClient(adapter.ip, 1000).getStatus(SERIAL),
      6000,
      'a mid-reply socket death',
    );
    assert.strictEqual(status, null, 'reported as a failure rather than left pending');
  } finally {
    await adapter.close();
  }
});

test('one adapter is never given two connections at once', async () => {
  // maxSockets: 1 is the half of LOCAL_AGENT the original tests missed — they pinned
  // keepAlive: false (two exchanges, two ports) but not the concurrency cap. The
  // comment on LOCAL_AGENT says the adapter has a single connection slot, and
  // withLock only serialises within one client instance, so the cap is what holds
  // when a discovery probe overlaps a poll of the same unit.
  let live = 0;
  let peak = 0;
  const sockets = new Set<import('node:net').Socket>();
  const server = http.createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ r: { indoorUnit: { status: { roomTemp: 20 } } } }));
    }, 60);
  });
  server.on('connection', (socket) => {
    live++;
    peak = Math.max(peak, live);
    sockets.add(socket);
    socket.on('close', () => {
      live--;
      sockets.delete(socket);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const ip = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    // Two independent clients: withLock cannot serialise across instances, so only
    // the agent's socket cap can.
    await Promise.all([
      makeClient(ip).getStatus(SERIAL),
      makeClient(ip).getStatus(SERIAL),
    ]);
    assert.strictEqual(peak, 1, `peak concurrent connections to one adapter was ${peak}`);
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
