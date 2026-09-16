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
3. Service `treasury`: variable `VETTAI_PROCESS=src/treasury/index.ts`. No public domain.
   Deploy it after the world is healthy, so the two do not race the first migration.
4. Variables. Both services read the same database and the same money limits, so the
   shared rows go on both. The key column says where each one belongs.

| Key | Service | Value on Railway |
|---|---|---|
| RAILWAY_DOCKERFILE_PATH | both | `packages/server/Dockerfile` |
| VETTAI_PROCESS | treasury | `src/treasury/index.ts`; leave it off the world service |
| PORT | world | `8788`, and generate the public domain on this port |
| DATABASE_URL | both | `${{Postgres.DATABASE_URL}}`, the reference to the Railway Postgres service |
| NIMIQ_RPC_URL | both | `https://rpc.nimiqwatch.com` for mainnet, `https://rpc.testnet.nimiqwatch.com` for testnet |
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
| TRUST_PROXY | world | Blank until the first deploy answers `GET /api/echo-ip`; then the proxy peer it shows, as a preset (`uniquelocal`, `loopback`) or a CIDR, so the world reads the real client IP from X-Forwarded-For. Never `true` |

5. Migrations run at boot of either process, so the first world deploy creates the schema.
6. Check: `curl https://<world domain>/health` returns ok.

## Fly.io

`fly launch` from the repository root with `--dockerfile packages/server/Dockerfile`, then
a second process group in `fly.toml`:

```toml
[processes]
  world = "npx tsx src/index.ts"
  treasury = "npx tsx src/treasury/index.ts"
```

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

Seven of the twelve checks run remotely and five are skipped, because they need something
only the host has:

| Check | Remote |
|---|---|
| 1 health, the network, the caller's real IP, the map version | runs |
| 2 sign-in, and `/api/me` agreeing | runs |
| 3 forged signature and replayed challenge refused | runs |
| 4 a scripted wallet plays until the hunt quest is done | runs, up to 300 seconds |
| 5 claim queued once, replay and another wallet refused | runs |
| 6 the deployed treasury pays on chain, read back through the public node | runs, waits up to 240 seconds |
| 7, 8, 9 daily cap, per-IP cap, pool | skipped: the caps are configured on the host and a local run turns them down to something one pass can cross |
| 10 the shop | skipped unless `--fund` is passed, because funding a fresh wallet needs the treasury key |
| 11 socket flood, long move vector, nonsense frames | runs, measured from the frames the server sends |
| 12 outbox idempotency | skipped: it is proven against the database, which only the host can read |

Check 1 is the one that catches a wrong `TRUST_PROXY`. If `/api/echo-ip` answers with a
10.x or 100.64.x address, the world is reading its own hosting edge rather than the player,
the per-IP cap is counting the whole internet as one household, and the check fails with
that address printed.

Check 6 needs a real reward to leave the deployed treasury, so run it against a testnet
deployment, or accept that a mainnet run spends the reward for real.

With `--fund` the shop check also runs: the treasury key in `packages/server/.env.treasury`
floats a fresh wallet, that wallet pays its own order, and the run waits for the deployed
watcher to settle it. It refuses to start if that key does not derive the address the
deployment takes payments at.
