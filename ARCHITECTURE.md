# Vettai architecture

Vettai is a third-person city game that runs inside Nimiq Pay. The server is the authority
for play. The Nimiq chain is the ledger for money. This file is the contract between the
world server, the treasury, and the client. Diagrams are added when the code lands.

## Processes

Two processes from one Docker image, one Postgres database.

- `world` (`src/index.ts`): HTTP API and WebSocket. Runs the rooms, the 20 Hz tick, the
  quest engine, the ladder, and the claim API. Never holds a private key.
- `treasury` (`src/treasury/index.ts`): delivers queued claims as NIM payments, watches
  the treasury address for shop payments, reads stakes for the landlord quest, pays the
  weekly ladder. The only process with `TREASURY_PRIVATE_KEY`.

The world runs as exactly one replica. Rooms and socket tickets live in that process's
memory, so a second replica would hand a player a ticket the machine that took the upgrade
has never heard of, and would split one room across two worlds.

The host picks which process runs by setting `VETTAI_PROCESS=src/treasury/index.ts`.
Unset, the image runs `world`. Locally the treasury reads its key from
`packages/server/.env.treasury` on top of `.env`; the world refuses to boot if it sees
`TREASURY_PRIVATE_KEY` at all. On Railway each service has its own variables.

## Environment

| Key | Used by | Meaning |
|---|---|---|
| PORT | world | HTTP and WebSocket port, default 8788 |
| DATABASE_URL | both | Postgres URL; unset means PGlite under `.data/vettai` (local and tests) |
| NIMIQ_RPC_URL | both | `https://rpc.nimiqwatch.com` mainnet, `https://rpc.testnet.nimiqwatch.com` testnet |
| NIMIQ_RPC_FALLBACK_URL | both | Optional second node on the same network, tried only after the first has failed to answer twice in a row |
| TREASURY_PORT | treasury | Port for the treasury's own `/health`, default 8789. Never given a public domain |
| LADDER_FLOOR_WEEK | treasury | Optional ISO week (`2026-W38`) the ladder catch-up starts from; unset means the week of the oldest claim |
| NIMIQ_NETWORK | both | `MainAlbatross` or `TestAlbatross`, must match the URL |
| TREASURY_ADDRESS | both | The address that pays players and receives shop payments |
| TREASURY_PRIVATE_KEY | treasury | 64 hex, never set on `world` |
| POOL_TOTAL_NIM | both | Hard stop: sum of queued, sending, sent, paid and failed claims never exceeds this. The treasury refuses to start when the wallet holds less than the unpaid part of it |
| DAILY_CAP_NIM | both | Per wallet per UTC day, across every reward kind |
| IP_WALLETS_PER_DAY | world | Distinct wallets that may claim from one IP per UTC day, default 2 |
| ALLOWED_ORIGINS | world | Comma list for CORS; blank means same-origin only through the web rewrite |
| MAP_SEED | world | Deterministic map seed, default `vettai-1` |
| LANDLORD_MIN_NIM | both | Stake that completes the landlord quest, default 10 |
| LANDLORD_ENABLED | both | `true` to generate landlord quests; default `false` until Ram decides |
| IP_SALT | world | Salt for hashing client IPs; a fixed dev string when unset |
| TRUST_PROXY | world | Blank locally. Otherwise a comma list of the peers allowed to speak for a caller, meaning the machine that opens the socket to us: named presets (`loopback`, `linklocal`, `uniquelocal`) or CIDRs. `true` is never used: it would let any direct caller forge the client IP. On Railway the peer is private, so `100.64.0.0/10`. Verify after deploy with `GET /api/echo-ip` |
| TRUST_PROXY_EDGE_HOPS | world | How many hops past that peer are still the platform's own edge, default 0, `1` on Railway. The edge appends the true client to `X-Forwarded-For` and sits one hop beyond the private peer, so with 0 every request resolves to the edge and the per-IP caps count the whole internet as one household. Anything past the edge is the client and is never trusted, so junk a caller prepends to the header is ignored |
| PUBLIC_WS_URL | world | The `wss://<world domain>/ws` address handed to the browser with its ticket. Blank means same origin. Needed whenever the web app fronts the API with a rewrite, since rewrites do not carry WebSocket upgrades |
| VETTAI_PROCESS | both | Entry script; `src/treasury/index.ts` makes the image run the treasury, unset runs the world |
| REWARD_HUNT, REWARD_COURIER, REWARD_LANDMARKS, REWARD_LANDMARKS_REPEAT, REWARD_LANDLORD | both | Quest rewards in NIM; defaults in the "Quests" table below |
| LADDER_PRIZES_NIM | both | Comma list of weekly prizes for first, second, third; default `2,1,0.5` |

All of it is validated with zod at boot in `src/config.ts`. A missing key fails loudly.

## Database (Drizzle, Postgres, PGlite for tests)

- `players`: address (primary), public_key, created_at, last_seen_at, last_ip_hash,
  gear (jsonb: `{ blaster: 'mk1' | 'mk2', skin: string, sprint: boolean }`), landlord_since.
- `sessions`: token_hash (primary), address, created_at, expires_at (30 days).
- `challenges`: nonce (primary), kind (`login` | `claim` | `shop`), subject (claim id or
  order id or null), expires_at, used_at. Single use, 10 minutes.
- `quests`: id (uuid, primary), address, day (UTC date), kind (`hunt` | `courier` |
  `landmarks` | `landlord` | `streak`), target (int), progress (int), state (`open` |
  `done` | `claimed`), reward_luna, detail (jsonb: courier `{ from, to, pickedUpAt }`,
  landmarks `{ visited: number[] }`), created_at, done_at. Unique (address, day, kind).
- `claims`: id (uuid, primary), address, quest_id (nullable for ladder prizes), kind,
  amount_luna, state (`queued` | `sending` | `sent` | `paid` | `failed` | `held`),
  memo, tx_hash (unique, nullable), block_number, ip_hash, created_at, sent_at,
  paid_at, error, attempts (int, retries so far), held_until (when a held claim is next
  re-evaluated). A quest may have at most one claim: unique (quest_id) where not null.
- `shop_orders`: id (uuid, primary), address, item, price_luna, memo (unique), state
  (`pending` | `paid` | `expired`), tx_hash (unique, nullable), block_number, created_at,
  paid_at, announced_at (when the live player received the gear event).
- `received_payments`: every incoming transaction the watcher inspected: tx_hash
  (primary), sender, recipient, value_luna, memo, block_number, block_time, order_id,
  outcome (`paid` | `short` | `expired` | `unknown_memo` | `sender_mismatch` |
  `already_paid`), seen_at. Money that arrived is never only a log line.
- `ladder_periods`: period (text primary, `2026-W41`), paid_at, claim ids (jsonb).
- `stats_daily`: day (primary), players, kills, paid_luna. Updated by the world.
- `watch_cursor`: address (primary), last_block_number, updated_at. Treasury watcher
  progress; the watcher pages by block number, and a transaction is matched at most
  once because the memo's order is unique and the tx hash is unique.

Money amounts are integers in luna (1 NIM = 100,000 luna). Never floats.

## Identity

Login is Vango's flow: `POST /api/auth/challenge` returns `vettai-login:<nonce>:<exp>`;
the client signs it with `window.nimiq.sign`; `POST /api/auth/verify` rebuilds the Nimiq
signed-message hash, verifies Ed25519 with the public key, derives the address from the
public key, consumes the nonce, and returns a session token `vt1.<random>` stored hashed.
The client never states its own address.

## Map

`src/world/map.ts` generates the city from `MAP_SEED` with a seeded PRNG. Same JSON on the
server and the client, served at `GET /api/world/map` with `version`.

- 12 by 12 lots of 16 m with 8 m streets: a 288 m square, origin at the centre, y up.
- Each lot is empty, a park, or a building `{ lot, type: 0..19, height, aabb }`.
- Fixed places: `office` (quest board), `shop`, four `landmarks`, eight `courier`
  points, and `patrol` waypoint loops for drones along streets at 6 m height. The spawn is
  2 m in front of the office door, facing it, so the board is in reach on the first frame.
- Everything the client needs to draw the block and the server needs to collide is in
  this JSON. Nothing else is hardcoded on either side.

## World simulation (`src/world/sim.ts`, pure functions, no I/O)

Tick: 50 ms. Units: metres, seconds, radians.

- Player: `{ id, x, z, yaw, vx, vz, shield: 0..3, downedUntil, lastFireAt, gear }`.
  Move intent `{ dx, dz }` is a unit vector or zero. Speed 6 m/s (mk1), 7 with the sprint
  gear. Integrate, then slide along building AABBs (axis-separated resolution), then
  clamp to the map bounds. A player can never end a tick inside a building.
- Drone: `{ id, x, y, z, yaw, hp: 3, state: 'patrol' | 'engage' | 'dead', waypoint,
  target, targetUntil, nextFireAt }`. Patrol 3 m/s along its loop. Engage when a player is
  within 25 m, or when a player shoots it from anywhere inside 60 m: circle the player at
  12 m radius and fire a bolt every 2 s. A drone that has been shot holds that target for
  6 s and answers within its 2 s fire interval. Max 12 alive per room, one respawn every
  15 s, loops handed out in turn so the centre of the city is always patrolled. A room opens
  with two, on the centre loop, and fills up on the same 15 s clock: a full dozen at birth
  would let a player leave and rejoin for a fresh batch whenever the sky went quiet. No
  patrol waypoint comes within 14 m of the board, so no loop flies into the safe zone.
- Bolt: `{ id, x, y, z, vx, vy, vz, ownerDrone, bornAt }`. Speed 18 m/s, straight line
  toward where the target will be after the bolt's flight time (current velocity, one
  step of lead), dies after 3 s or on impact. Impact is a
  sphere-capsule test against each player (capsule radius 0.5, height 1.8). A hit costs
  one shield. Shield regenerates one bar every 8 s without a hit.
- Safe zone: a 10 m circle around `office`. Drones do not engage, target or fire at a
  player inside it, an engaged drone drops a target who walks in, and a bolt that crosses
  the edge dies. The circle cuts both ways: a shot fired from inside it is refused, because
  anybody allowed to shoot out would be taking drones apart from the one place in the city
  that cannot answer. It is a place to read the board from and come back at, never a place
  to fight from.
- Downed at shield 0: 3 s, then respawn at the office with full shield, inside the safe
  zone. Quest progress is kept.
- Fire intent `{ yaw, pitch }`: at most 4 per second (mk1) or 6 (mk2). Hitscan from the
  player's server position at eye height along the aim direction, range 60 m, with aim
  assist: the nearest live drone within a 12 degree cone counts as hit (a phone thumb
  cannot hold a narrower one). Hit costs one hp.
  The player with the most damage on a drone gets the kill.
- Every function takes state in and returns new state plus a list of events:
  `hit`, `kill`, `downed`, `respawn`, `pickup`, `deliver`, `landmark`, `spawn`.
- Property tests: no player inside a building after any input sequence, speed never
  above the cap, fire rate never above the cap, drone count never above 12, a dead drone
  never deals damage, kill credit goes to the top damage dealer.

## Rooms and the socket (`src/world/rooms.ts`, `src/routes/ws.ts`)

- Rooms hold up to 24 players. A joining player goes to the least full open room. A
  room with nobody in it stops ticking after 30 s.
- `GET /api/world/ticket` (session required) returns a one-minute ticket. The socket is
  `GET /ws?ticket=...`. `permessage-deflate` is off (iOS WebViews drop compressed
  sockets).
- Client to server, JSON, `v: 1` on every message:
  - `{ t: 'move', seq, dx, dz, yaw }` at most 30 per second; extra ones are dropped. Clients
    send 15 a second, so timer jitter never reaches the budget.
  - `{ t: 'fire', seq, yaw, pitch }`.
  - `{ t: 'interact', target: 'office' | 'shop' | 'pickup' | 'deliver' | 'landmark:<n>' }`
    requires the player within 2.5 m of that place. One target is taken at most twice a
    second per connection, and the room drops an interact its copy of that player's quests
    says cannot change anything (quest not open, wrong courier point, landmark already
    counted) rather than turning it into a row lock in the database.
  - `{ t: 'ping', ts }`.
- Every player is named on the wire by a `handle`: eight hex characters drawn fresh for
  each connection to a room. Wallet addresses never ride out to the room. The only address
  on the socket is the caller's own, in the welcome.
- Server to client:
  - `{ t: 'welcome', you: { handle, address }, youSeq, room, tick, mapVersion, players,
    drones, quests }` on join. `you.handle` is what this client is called in `players` and
    in every event; `you.address` is the caller's own wallet and appears nowhere else.
    `youSeq` is 0, the move number the server has applied for this connection, so a
    reconnecting client resets its counter without searching the players list.
  - `{ t: 'state', tick, players: [changed only], drones: [all live], bolts: [all] }`
    every tick, players only when moved, a full players list every 40 ticks. Each player
    entry carries `seq`, the highest `move` sequence number the server has applied for
    that player (0 before any), so the client can rewind to the server's position and
    replay only the inputs the server has not seen yet.
  - sim events (`hit`, `kill`, `downed`, `respawn`, `spawn`, `pickup`, `deliver`,
    `landmark`) ride on the `state` frame as `events: [{ kind, ... }]`, with `player` as a
    handle.
  - `{ t: 'event', kind, ... }` only for the per-player and roster kinds: `quest`
    (progress or done, sent to that player only), `gear` (a shop order was paid, that
    player only), `join`, `leave`. `join` and `leave` name a handle.
  - `{ t: 'event', kind: 'assist', drone }` to the player who fired the finishing shot on a
    drone the kill was credited to somebody else for, that player only.
  - `{ t: 'event', kind: 'courier-reset', reason: 'cold' | 'day' }` when a parcel in hand is
    dropped: `cold` is the two minute window running out, `day` is the UTC day turning.
  - `{ t: 'event', kind: 'quests-rolled' }` once to a player whose quest set was rebuilt for
    a new UTC day while they were still connected; the new set follows as `quest` events.
  - `{ t: 'pong', ts, serverTs }`, `{ t: 'error', code }`.
- Per-connection rate limits by message type, counted server side, never trusted from
  the client. A connection sending malformed JSON three times is closed.
- Every connection carries an id. A late `close` from a replaced socket only removes the
  connection with its own id, never the one that replaced it.
- A player who drops keeps what they had for 90 s: still down if they were down, the same
  spent shield, the same spent fire budget. Dropping the socket is not a way to heal.
- The server pings every socket every 15 s and terminates one that has missed two pings. A
  socket whose send buffer passes 64 KB is closed with 1013, and a connection that has sent
  no move, shot or interact for ten minutes is closed with 1000 `idle`.
- Tick events are recorded in order: one promise chain in the world process, one
  transaction per batch. When the chain is more than 20 deep the interacts of a tick are
  dropped with a log line, and its kills are held and ride out with the next batch that
  fits: a kill is the one event a player earned by playing.
- The state frame is serialised once per room per tick and the tick's events ride on
  it as an `events` array, not as separate frames.

## Quests (`src/domain/quests.ts`)

Generated per player per UTC day on first request. Rewards are read from
`src/domain/rewards.ts`, integers in luna, overridable by env.

| Kind | Target | Done when | Reward |
|---|---|---|---|
| hunt | 5 kills | the sim reports the fifth kill credited to the player today | REWARD_HUNT (default 0.5 NIM) |
| courier | 1 delivery | pickup then deliver within 120 s, both by `interact` in range | REWARD_COURIER (0.3 NIM) |
| landmarks | 4 | `interact` at each of the four landmarks | REWARD_LANDMARKS (0.2 NIM), first day only, then 0.05 |
| landlord | 1 | the treasury saw a stake of at least LANDLORD_MIN_NIM on the wallet at its daily read | REWARD_LANDLORD (0.2 NIM); only if Ram enables it |
| streak | daily | one claim per UTC day, NimJump's curve: min(0.2 + 0.5 x (day minus 1), 10), capped by DAILY_CAP | as computed |

A quest at `done` becomes a claim only through the claim endpoint below. The weekly
ladder ranks kills per wallet, Monday 00:00 UTC to Sunday 23:59:59 UTC; the treasury pays
the top three from LADDER_PRIZES_NIM (default `2,1,0.5`) once per period.

## Claims (`src/domain/claims.ts`, the only path to a payout)

1. `POST /api/quests/:id/claim/challenge` (session): quest must be `done` and owned by
   the caller. Returns `vettai-claim:<questId>:<nonce>:<exp>`.
2. Client signs it. `POST /api/quests/:id/claim` with `{ publicKey, signature }`.
3. Server verifies the signature, derives the address, checks it equals the session's,
   consumes the nonce, then inside one transaction: quest to `claimed`, insert the claim
   (a refusal at any of those three steps, or on a quest that is not done, is a 403 with
   `{ error, code }` where code is `bad_signature`, `other_wallet`, `nonce` or
   `not_claimable`; 401 means the session itself is missing or no longer good, and nothing
   else, so a phone never signs its player out over a stale message)
   as `queued` with memo `vettai:<questId first 8>` (under 64 bytes), unless a cap fails:
   - daily cap: paid plus queued plus sent for this wallet today, plus this amount,
     over DAILY_CAP_NIM: claim inserted as `held` with `error: 'daily cap'`.
   - IP cap: more than IP_WALLETS_PER_DAY distinct wallets from this IP hash today:
     `held`, `error: 'ip cap'`.
   - pool: total queued, sent and paid ever, plus this amount, over POOL_TOTAL_NIM:
     `held`, `error: 'pool'`.
   A hold is a delay, never a forfeiture: `held_until` is the next UTC midnight for the
   daily and IP caps, and null for the pool on the first hold and on every later one, so a
   pool hold is measured again on the very next pass. The treasury re-runs the cap check on
   held claims every minute (`releaseHeld`) and flips the ones that now pass to `queued`,
   which is also how a ladder prize held on Monday is paid later. The player sees
   "held until tomorrow" or "pool exhausted".
   The three cap checks run under two advisory transaction locks, the wallet's then a
   constant for the pool, so two claims arriving at once cannot both read the old sum.
   The quest update and the claim insert are one transaction. A streak reward is
   clamped at creation to what the daily cap still allows.
4. The treasury delivers `queued` claims (below). `GET /api/claims` lists the caller's
   claims with state, tx hash and block number.

## Treasury (`src/treasury/*`)

- `outbox.ts`: every 2 s, read the wallet balance from the chain, and send nothing while it
  is below queued plus sending plus the next payout ("wallet below committed", said once a
  minute). Otherwise take up to 5 `queued` claims oldest first, mark each `sending` (save
  first), then send one at a time with 1.5 s between sends and no wait for inclusion between
  them. A failure before the transaction is signed costs no `attempt`: the claim goes back to
  `queued` with `next_attempt_at` two minutes out, doubling to thirty. Delivery is idempotent
  by claim id; a process restart never sends a claim twice because the state row is the lock.
  `attempts` is an integer column, never parsed from the error text.
- `sender.ts`: builds a basic transaction with the memo, signs with the treasury key
  (@nimiq/core), stores the hash and the height it was built at, pushes over RPC.
  `settleInFlight` polls `getTransactionByHash` on later passes, records the block, and only
  marks `paid` once 60 blocks (one Albatross batch) sit on top of it. A lookup error is
  "still pending", never a resend. A hash the node does not know is rebuilt only when all
  four hold: it has held the hash for three hours, the head is past its validity window
  (7200 blocks) plus a batch, the node's mempool does not hold it, and the treasury's own
  outgoing history since that height carries no payment with the claim's memo. If that
  history does carry it, the claim is closed against the transaction that really happened.
  After three rebuilds it is `failed`, which still counts against the pool because the money
  is still owed; `npm run treasury:requeue` is how a person queues it again or cancels it.
- `health.ts`: a listener on TREASURY_PORT with one route, `GET /health`, reporting the
  network, the address, the balance, what is committed, when each loop last ran, how long the
  oldest payout has waited, and whether the node is answering.
- `watcher.ts` (Vango's watcher): scans the treasury address for incoming transactions up to
  60 blocks behind the head, matches `vettai:shop:<orderId first 8>` memos against orders,
  checks sender equals the order's address and value at or above the price, marks `paid` with
  the hash and block, and only then expires the orders nobody paid. Orders expire 30 minutes
  after creation, judged against the block time of the payment, not the moment the watcher
  looked, so a payment mined in time is honoured however late it is read. Every inspected
  transaction is written to `received_payments` with its outcome.
- `stakes.ts`: once per UTC day (and once at boot) reads the stake of every player with
  an open landlord quest for that day and marks that day's quest done when at or above
  LANDLORD_MIN_NIM. Only the current day's quest can complete.
- `ladder.ts`: every 10 minutes, pays every closed week since LADDER_FLOOR_WEEK that has no
  `ladder_periods` row, oldest first, each inside a transaction that inserts the row first.
  There is no Monday gate, so an outage over a Monday costs nobody their prize.
- `refuse.ts`: the treasury refuses to start if TREASURY_PRIVATE_KEY does not derive
  TREASURY_ADDRESS. A node that is down, or on the wrong network, is not a refusal but a
  wait: it retries from 5 s up to 2 minutes, forever, with the health page up throughout.

## Shop (`src/domain/shop.ts`)

Items: `blaster-mk2` (faster fire), `sprint` (7 m/s), skins. `POST /api/shop/orders`
creates a `pending` order with memo `vettai:shop:<id first 8>` and returns
`{ orderId, to: TREASURY_ADDRESS, luna, memo }`. A wallet that already has a live order for
that item gets the same order and the same memo back, held by a partial unique index on
(address, item) where the state is `pending`, so tapping buy twice can never be paid twice. The client pays with
`sendBasicTransactionWithData`. `GET /api/shop/orders/:id` reports the state. The world
sweeps `paid` orders with no `announced_at` every 5 s, applies the gear to the live room
state, pushes a `gear` event to the player's socket, and only then stamps
`announced_at`; a player who is offline gets the gear at the next join from the player
row.

## Public reads (no session)

- `GET /api/stats`: players today, players all time, kills today, NIM paid all time,
  claims paid count, and `history`: the last seven UTC days from `stats_daily` (players,
  kills, paid luna as a string). The landing page reads this and nothing else.
- `GET /api/ladder/week`: top 10 this week by kills with addresses shortened.
- `GET /health`: `{ ok, network, rooms, online, dailyCapNim }`; the client reads the cap to
  show what is still payable today.
- `GET /api/world/constants`: `{ walkSpeed, sprintSpeed, interactRange, patrolY, boltRadius,
  hitscanRange, aimConeDegrees, officeSafeRadius, maxDrones }`, read off the simulation's own
  constants. The client asserts its copy against these at boot instead of drifting quietly.
- `GET /api/echo-ip`: `{ ip, chain, peer }`, for checking TRUST_PROXY and
  TRUST_PROXY_EDGE_HOPS against a real deployment by eye.

## Trust rules

- The client is never asked for a score, a position, or an address. It sends intents.
- The only process that can move NIM holds the key; the world cannot even reach it.
- Every payout has a memo with the quest id, so the chain is a public audit log.
- Caps bound the loss from a scripted client; they do not prevent one. The threat model
  says so in plain words.

## Diagrams

### System overview

Where each piece runs, and which of them can move money.

```mermaid
flowchart LR
  subgraph phone["Player's phone"]
    pay["Nimiq Pay"]
    app["Vettai mini app"]
  end

  subgraph vercel["Vercel"]
    web["Next.js app, three.js city"]
  end

  subgraph host["One Docker image, two processes"]
    world["world: HTTP, WebSocket, rooms, 20 Hz tick, quests, claims"]
    treasury["treasury: outbox, watcher, stakes, ladder. Holds the key"]
  end

  db[("Postgres: players, quests, claims, shop orders, cursor")]
  chain[("Nimiq Albatross chain")]

  pay -->|opens, signs messages and payments| app
  app --> web
  web -->|REST and WebSocket| world
  world --> db
  treasury --> db
  treasury -->|pushTransaction, signed payouts| chain
  treasury -->|getTransactionsByAddress, watches for shop payments| chain
  app -->|sendBasicTransactionWithData, pays for gear| chain
  world -.->|never holds a key, cannot reach the chain to spend| chain
```

### One payout, end to end

The path a kill takes to become NIM in a player's wallet. Nothing in it trusts a number the
phone sent.

```mermaid
sequenceDiagram
  autonumber
  participant P as Phone (Nimiq Pay)
  participant W as World server
  participant D as Postgres
  participant T as Treasury
  participant C as Nimiq chain

  P->>W: POST /api/auth/challenge
  W->>D: write nonce
  W-->>P: vettai-login:nonce:expiry
  P->>P: window.nimiq.sign(message)
  P->>W: POST /api/auth/verify (message, public key, signature)
  W->>W: verify Ed25519, derive the address from the key
  W-->>P: session token

  P->>W: GET /api/world/ticket, then GET /ws?ticket=...
  W->>D: create today's quests
  W-->>P: welcome (map version, players, drones, quests)

  loop every 50 ms
    P->>W: move and fire intents
    W->>W: simulate, decide what actually happened
    W-->>P: state (players, drones, bolts)
  end

  W->>D: fifth kill, hunt quest done
  W-->>P: event quest, hunt 5/5 done

  P->>W: POST /api/quests/:id/claim/challenge
  W-->>P: vettai-claim:questId:nonce:expiry
  P->>P: sign it in Nimiq Pay
  P->>W: POST /api/quests/:id/claim (message, public key, signature)
  W->>W: verify, spend the nonce, measure the three caps
  W->>D: insert claim queued, memo vettai:<quest id>
  W-->>P: queued

  T->>D: take the oldest queued claim, mark it sending
  T->>T: build and sign the transaction, save the hash first
  T->>C: pushTransaction
  T->>C: getTransactionByHash until it is in a block
  T->>D: claim paid, block number
  P->>W: GET /api/claims
  W-->>P: paid, hash, block number for the HUD
```

### Module dependency graph

`packages/server/src`, drawn folder by folder. The arrows only ever point downward: the play
simulation knows nothing about the database, the domain knows nothing about HTTP, and the
treasury is the only thing that reaches the signer.

```mermaid
flowchart TD
  cli["cli/: prove, bot, seed"]
  index["index.ts: the world process"]
  tindex["treasury/index.ts: the treasury process"]
  app["app.ts: Fastify, CORS, rate limits, one error shape"]
  routes["routes/: auth, quests, shop, world, ws, ladder, stats, context"]
  rooms["world/rooms.ts: rooms, sockets, per connection budgets"]
  sim["world/sim.ts: the rules of play"]
  pure["world/: geometry, map, prng, tickets, types. No input or output"]
  domain["domain/: auth, challenges, claims, quests, shop, ladder, stats, rewards"]
  treasury["treasury/: outbox, sender, watcher, stakes, refuse"]
  rpc["nimiq/rpc.ts: JSON-RPC to the node"]
  verify["nimiq/verify.ts: the Nimiq signed message"]
  db["db/: client, schema, migrate"]
  lib["lib/: luna, address, tokens"]
  cfg["config.ts: zod over .env"]

  cli --> app
  cli --> rooms
  cli --> treasury
  index --> app
  index --> rooms
  tindex --> treasury
  tindex --> domain
  app --> routes
  routes --> domain
  routes --> rooms
  routes --> verify
  routes --> lib
  rooms --> sim
  rooms --> domain
  sim --> pure
  domain --> db
  domain --> verify
  domain --> lib
  domain --> cfg
  treasury --> domain
  treasury --> rpc
  treasury --> db
  rpc --> cfg
  rpc --> lib
  db --> cfg
  cfg --> lib
```
