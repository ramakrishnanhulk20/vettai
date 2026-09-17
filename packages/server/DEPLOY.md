# Deploying the Vettai server

Two always-on processes share one image: the world and the treasury. Both read the same
Postgres database. Only the treasury holds a private key. Railway is the click-only path;
Fly.io works the same way with `fly.toml`.

## Railway (recommended, no CLI)

1. New project with a Postgres database, then two services from the GitHub repo, both
   with the variable `RAILWAY_DOCKERFILE_PATH=packages/server/Dockerfile` so the build
   uses that file with the repository root as context.
2. Service `world`: do not add a `VETTAI_PROCESS` variable at all, so the image runs the
   world. Expose port 8788 and generate a public domain. That domain is what the web app
   and Nimiq Pay talk to. The world refuses to start if `VETTAI_PROCESS` points at the
   treasury, so an extra variable here is a failed deploy, not a silent mistake.
3. Service `treasury`: variable `VETTAI_PROCESS=src/treasury/index.ts`. No public domain,
   ever: it answers its own health page on `TREASURY_PORT` (8789 by default) inside the
   private network, and that page is the only thing it serves. Deploy it after the world is
   healthy, so the two do not race the first migration.
4. Variables. Both services read the same database and the same money limits, so the
   shared rows go on both. The key column says where each one belongs.

| Key | Service | Value on Railway |
|---|---|---|
| RAILWAY_DOCKERFILE_PATH | both | `packages/server/Dockerfile` |
| VETTAI_PROCESS | treasury | `src/treasury/index.ts`; leave it off the world service |
| PORT | world | `8788`, and generate the public domain on this port |
| DATABASE_URL | both | `${{Postgres.DATABASE_URL}}`, the reference to the Railway Postgres service |
| NIMIQ_RPC_URL | both | `https://rpc.nimiqwatch.com` for mainnet, `https://rpc.testnet.nimiqwatch.com` for testnet |
| NIMIQ_RPC_FALLBACK_URL | both | Optional. A second node on the same network, tried only when the first one has failed to answer twice in a row |
| TREASURY_PORT | treasury | Optional, `8789` by default. Where the treasury answers `/health`. Never generate a domain for it |
| LADDER_FLOOR_WEEK | treasury | Optional, an ISO week like `2026-W38`. The first week the ladder will ever pay. Left off, the treasury starts at the week of the oldest claim |
| NIMIQ_NETWORK | both | `MainAlbatross` or `TestAlbatross`, matching the URL above |
| TREASURY_ADDRESS | both | The address that pays players and receives shop payments |
| TREASURY_PRIVATE_KEY | treasury | 64 hex characters. Never set this on the world service |
| POOL_TOTAL_NIM | both | The whole prize pool, for example `100`. Queued plus sent plus paid never goes past it |
| DAILY_CAP_NIM | both | What one wallet can take in a UTC day, for example `5` |
| IP_WALLETS_PER_DAY | world | `2` |
| ALLOWED_ORIGINS | world | Leave blank: the web app reaches the world through its own server-side rewrite, so no browser origin calls it directly |
| MAP_SEED | world | `vettai-1`. Changing it builds a different city |
| LANDLORD_MIN_NIM | both | `10` |
| LANDLORD_ENABLED | both | `false` until Ram turns the landlord quest on |
| IP_SALT | world | A long random string, fresh per deployment. It only ever hashes IPs |
| TRUST_PROXY | world | On Railway, `100.64.0.0/10`: the peer that opens the socket to the container sits in that range. Anywhere else, the peer `GET /api/echo-ip` shows, as a preset (`uniquelocal`, `loopback`) or a CIDR. Never `true` |
| TRUST_PROXY_EDGE_HOPS | world | On Railway, `1`: the address that appends the real caller sits one hop further out than the peer. `0` anywhere the edge is the peer itself |
| PUBLIC_WS_URL | world | The `wss://<world domain>/ws` address handed to the browser with its ticket. Blank means same origin. Needed whenever the web app fronts the API with a rewrite, since rewrites do not carry WebSocket upgrades |

5. The world runs exactly one replica. Scaling it to two would split the rooms across
   processes, so two players in one city would never see each other, and the per-IP cap would
   count each replica's own view.
6. Migrations run at boot of either process, so the first world deploy creates the schema.
7. Check: `curl https://<world domain>/health` returns ok.
8. Backups, one click and worth doing on the first day: open the Postgres service, the
   **Backups** tab, and turn on the daily backup. Everything a player earned lives in that
   database and nowhere else.

## Watching the treasury

The treasury has no domain, so this is how you see it. Both processes carry a Docker
`HEALTHCHECK` that calls their own `/health`, so the host restarts either one when it stops
answering. From a shell on the treasury service (`railway ssh`, then inside the container):

```sh
curl -s http://127.0.0.1:8789/health
```

| Field | What it tells you |
|---|---|
| `ok` | True only when the node is answering and the wallet covers what has been promised |
| `network` / `address` | Which chain and which wallet this process is paying from |
| `balanceNim` | What the wallet held when the last pass read it, off the chain |
| `committedNim` | Queued plus sending: what is owed and has not reached the chain yet |
| `lastOutboxPassAt` | When a payout pass last finished. More than a minute old means the loop is stuck |
| `lastWatcherPassAt` | When the shop watcher last finished |
| `oldestQueuedAgeSeconds` | How long the oldest payout has been waiting. Minutes are normal, hours are not |
| `nodeOk` | False when the last pass could not reach the Nimiq node at all |

A treasury that cannot reach its node does not exit. It keeps the health page up, says why
it cannot start yet, and tries again with a growing wait, so the host shows a process that
is up and unhealthy rather than a crash loop with no explanation.

## Two commands for when a payout goes wrong

A payout only reaches `failed` after the treasury built it three times and the node took
none of them. It still counts against the pool, because it is still owed. These move it:

```sh
npm run treasury:requeue -- --claim <claim id>            # put it back in the queue
npm run treasury:requeue -- --claim <claim id> --cancel    # write it off, freeing the pool
```

Both print the claim first: the wallet, the amount, the state, the attempts and the last
error. Only a `failed` claim is moved by hand; anything else is refused.

The money history can be copied off the host at any time:

```sh
npm run treasury:export -- --out vettai-money.json
```

It writes `claims`, `shop_orders` and `received_payments` as JSON, and nothing else. Run it
through `railway ssh` on either service, or locally with `DATABASE_URL` pointing at the same
database. Railway's own daily backup covers the database; this is the copy that leaves the
platform.

## Fly.io

`fly launch` from the repository root with `--dockerfile packages/server/Dockerfile`, then
a second process group in `fly.toml`:

```toml
[processes]
  world = "node --import tsx src/start.ts"
  treasury = "node --import tsx src/start.ts"
```

The treasury process group also needs `VETTAI_PROCESS=src/treasury/index.ts`, which is what
`src/start.ts` reads to decide which of the two it is starting.

Same variables via `fly secrets set`. Only the `world` process needs a public service on
8788, and `TREASURY_PRIVATE_KEY` goes on the `treasury` process only.

## Running the image by hand

From the repository root, with the root as build context:

```sh
docker build -f packages/server/Dockerfile -t vettai-server .
docker run --rm -p 8788:8788 \
  -e POOL_TOTAL_NIM=100 -e DAILY_CAP_NIM=5 \
  -e NIMIQ_RPC_URL=https://rpc.testnet.nimiqwatch.com -e NIMIQ_NETWORK=TestAlbatross \
  -e TREASURY_ADDRESS=NQ.. vettai-server
```

With no `DATABASE_URL` the world falls back to PGlite inside the container, which is fine
for a smoke test and disappears when the container stops. It logs `vettai world ready`.

## What follows the network

One deployment serves one network. `NIMIQ_RPC_URL` and `NIMIQ_NETWORK` must agree, and the
treasury address must hold real balance on that network. Point a testnet treasury key at a
mainnet node and the sender refuses by construction, which is the behaviour we want.

## Proving a deployment

The same prove-it command that runs the world in one process can run against a deployment
instead. Nothing runs locally and no key is needed: it signs in over the network, plays the
deployed world through its real socket, claims a reward, waits for the deployed treasury to
pay it, and reads that payment back off the chain the deployment says it is on.

```sh
cd packages/server
npm run prove -- --url https://<world domain>
```

`VETTAI_PROVE_URL` does the same thing if you would rather set it once. The run prints one
line per check and writes the whole thing to `docs/proofs/prove-remote-<date>-<time>.txt`,
with the origin in the header. It exits 1 only when a check fails.

Seven of the twelve checks always run remotely, an eighth runs when you name the daily cap,
and the rest are skipped because they need something only the host has:

| Check | Remote |
|---|---|
| 1 health, the network, the caller's real IP, the map version | runs |
| 2 sign-in, and `/api/me` agreeing | runs |
| 3 forged signature and replayed challenge refused | runs |
| 4 a scripted wallet plays until the hunt quest is done | runs, up to 300 seconds |
| 5 claim queued once, replay and another wallet refused | runs |
| 6 the deployed treasury pays on chain, read back through the public node | runs, waits up to 240 seconds |
| 7 the deployment runs the daily cap Ram set | runs with `--expect-daily-cap 5`, otherwise skipped with the number the deployment reports |
| 8, 9 per-IP cap, pool | skipped: these caps are configured on the host and a local run turns them down to something one pass can cross |
| 10 the shop | skipped unless `--fund` is passed, because funding a fresh wallet needs the treasury key |
| 11 socket flood, long move vector, nonsense frames | runs, measured from the frames the server sends |
| 12 outbox idempotency | skipped: it is proven against the database, which only the host can read |

Check 1 is the one that catches a wrong `TRUST_PROXY`, and it does it by comparison rather
than by guesswork: it asks `https://api.ipify.org` what this machine's own address is and
holds `/api/echo-ip` to the same answer. A hosting edge is not always a private address, so
"does it look private" is only printed as a label next to the two addresses. If they differ,
the world is naming a machine on its own side, the per-IP cap is counting the whole internet
as one household, and the check fails with both addresses printed.

Check 7 reads `dailyCapNim` off `/health` and holds it to what you pass:

```sh
npm run prove -- --url https://<world domain> --expect-daily-cap 5
```

A cap that quietly went up is the same loss as a cap that is not there, and this is the one
thing about the host's configuration a run from outside can hold it to.

Check 6 needs a real reward to leave the deployed treasury, so run it against a testnet
deployment, or accept that a mainnet run spends the reward for real.

With `--fund` the shop check also runs: the treasury key in `packages/server/.env.treasury`
floats a fresh wallet, that wallet pays its own order, and the run waits for the deployed
watcher to settle it. It refuses to start if that key does not derive the address the
deployment takes payments at.

## Getting the money back

Ram funds the treasury from his phone, so the key lives on the server side only and there
is no wallet app to open when the NIM has to come back out. One command does it:

```sh
cd packages/server
npm run treasury:sweep -- --to NQ63 NLNX 4H6R M3R4 XB92 8Y1X 5GTS JUGC 5QFJ
```

It reads the key from `packages/server/.env.treasury`, the same file the treasury process
reads, and never prints it. It follows `NIMIQ_RPC_URL` and `NIMIQ_NETWORK` from `.env`, so
it empties whichever wallet that environment points at.

Run it once without `--yes` first. That prints the plan (network, from, to, balance, what
is being sent, what is left) and sends nothing. npm reports the dry run as a failed script
because the command exits 1 whenever it did not send: forgetting `--yes` inside a script
must never read as a sweep that happened. Add `--yes` to the same line to send it.

| Option | What it does |
|---|---|
| `--to` | The address the money goes to. The spaced form pastes in fine, quotes or not |
| `--amount` | An amount of NIM, for example `0.1`. Left out, it sends the whole balance |
| `--memo` | Text carried with the payment, up to 64 bytes. Default `vettai treasury sweep` |
| `--yes` | Actually send it. Without this nothing is signed |

`TREASURY_ENV_FILE` points the command at another env file, so the mainnet wallet is swept
without its key ever being copied next to the testnet one:

```sh
TREASURY_ENV_FILE=.env.mainnet.treasury NIMIQ_NETWORK=MainAlbatross \
  NIMIQ_RPC_URL=https://rpc.nimiqwatch.com \
  npm run treasury:sweep -- --to NQ.. --yes
```

A bare filename is read against `packages/server`. The `TREASURY_ADDRESS` beside the key in
that file is the one the key is checked against, so a mainnet key is never measured against
the testnet address in `.env`.

It refuses, and sends nothing, when: the address is not a real Nimiq address, the amount is
more than the wallet holds or is not more than nothing, the recipient is the treasury
itself, the wallet is empty, the key does not derive the address its env file names, the
node is on a different network from `NIMIQ_NETWORK`, or an option is written that the
command does not know. That last one matters: a typed `--ammount 0.1` is refused rather
than ignored, because ignoring it would send the whole balance.

After a send it waits up to two minutes for a block and prints the hash and the block
number. If no block carries it in time it prints the hash and stops: look that hash up
before running anything again, since the payment may still land.

One proven run, on the testnet on 17 September 2026:

```
network   TestAlbatross
from      NQ92 YGUB VUV9 LX6H 36G0 33C1 081V TMDD 9152
to        NQ63 NLNX 4H6R M3R4 XB92 8Y1X 5GTS JUGC 5QFJ
balance   16.78 NIM
sending   0.1 NIM (leaving 16.68 NIM)
memo      vettai sweep test

hash      63d8f4222d637592aa2727624cdcb73da2d2876ac4aea4d87163d238840c77df
block     11659524
sent      0.1 NIM to NQ63 NLNX 4H6R M3R4 XB92 8Y1X 5GTS JUGC 5QFJ
```
