# Vettai threat model

Vettai pays real NIM to people who play a game. That single sentence is the whole security
problem: every attacker below wants the payout without doing the play, and the server is the
only thing standing between them and the treasury.

The rule the whole design follows is that the client is never asked for a fact. It sends
intents. The server decides what happened, writes it down, and signs the payment. A player
never sends a score, a position, a kill, or even their own wallet address.

Every claim in this file is exercised by `npm run prove`, which runs the attacks below
against the live Nimiq testnet and prints each refusal with the reason the server gave. The
output of each run is saved under `docs/proofs/`.

## Who is attacking, and what they want

| Attacker | What they want | What it would cost us |
|---|---|---|
| A scripted client | Play the game faster and longer than a person can, and take the daily quests every day | The pool drains into one wallet |
| A multi-account farmer | Run fifty wallets from one machine and claim fifty daily quests | The pool drains into one person's fifty wallets |
| A session thief | Use somebody else's session to claim their quests | One player's rewards, and their trust |
| A replayer | Send the same signed message twice and get paid twice | Double payouts, unbounded |
| A shop payer who cheats | Get the gear for less than the price, or pay from a wallet that does not own the order | Free gear, and a player who paid getting nothing |
| An operator mistake | Not an attacker: a crash, a restart, or a node that times out mid-send | The same payout sent twice, which is how the game this borrows from lost money |

## Entry points, and what stops each attack

### 1. Login (`POST /api/auth/challenge`, `POST /api/auth/verify`)

Files: `src/routes/auth.ts`, `src/domain/auth.ts`, `src/domain/challenges.ts`,
`src/nimiq/verify.ts`, `src/lib/tokens.ts`.

- **Claiming to be another wallet.** The request never carries an address. `login` in
  `src/domain/auth.ts` calls `verifySignedMessage`, which rebuilds the exact bytes a Nimiq
  wallet signs, verifies Ed25519 against the public key sent, and derives the address from
  that key. A caller who names a wallet they do not hold gets a signature that does not
  verify. Proven by check 3 of the prove run: a signature made with one key against another
  key's login is answered `401 "signature does not match message"`.
- **Replaying a login somebody else's phone made.** Every challenge carries a nonce written
  to the `challenges` table before the client sees it. `consumeChallenge` spends it with a
  conditional `UPDATE ... WHERE used_at IS NULL AND expires_at > now`, so the database, not
  a check in application code, decides who got there first. Check 3 replays a login that
  already worked and gets `401 "nonce used"`.
- **Burning somebody else's challenge.** The signature is verified before the nonce is
  spent, so a wrong signature cannot consume a nonce a real player is about to use.
- **Grinding signatures.** `src/app.ts` limits the two auth routes to 10 calls a minute per
  source address, tighter than the 120 everything else gets, because a signature check is
  the expensive thing an attacker would hammer.
- **Stealing the session table.** Tokens are `vt1.` plus 32 random bytes and only the sha256
  is stored (`src/lib/tokens.ts`). A dumped table cannot be replayed as a login. The prefix
  also means a session value can never be mistaken for a row id, which is the account
  takeover shape we were determined not to ship.

### 2. The play socket (`GET /api/world/ticket`, `GET /ws`)

Files: `src/world/tickets.ts`, `src/routes/ws.ts`, `src/world/rooms.ts`, `src/world/sim.ts`.

- **Session tokens in proxy logs.** A browser cannot put a header on a WebSocket handshake,
  so the token would otherwise travel in the query string. Instead a signed-in caller gets a
  one-minute, one-shot ticket (`issueTicket`), and `redeemTicket` deletes the entry before it
  answers, so two upgrades racing on one ticket cannot both be let in.
- **Driving somebody else's player.** The wallet comes off the ticket in the `preHandler`,
  before the upgrade, and is fixed for the life of the connection. Nothing a client sends
  afterwards can change whose player it is moving.
- **Knocking a player out of the game by reconnecting as them.** Every connection gets an id
  from `join` in `src/world/rooms.ts`, and `leave(address, connectionId)` only removes the
  connection whose id matches. A late `close` from a socket that has already been replaced,
  which is what a flaky phone network produces, cannot drop the live one.
- **Flooding the server.** `allowed` in `src/world/rooms.ts` counts messages per kind per
  connection in a sliding second: 20 moves, 8 fires, 5 interacts, 2 pings. The count is kept
  server side and is never read from the client. Check 11 sends 30 moves in one second and 10
  are dropped.
- **Teleporting or sprinting.** A move is a direction, not a position. `applyMove` normalises
  whatever vector arrives, so `dx: 50` becomes a unit step; check 11 proves it. The
  simulation integrates at a fixed 6 m/s (7 with the sprint gear) and slides the body along
  building footprints, and `MAX_STEP_SECONDS` caps a long tick so nobody crosses a wall in
  one jump.
- **Machine-gun fire.** `applyFire` keeps a sliding one second window of accepted shots and
  refuses anything past four (six with the mk2), so no second anywhere on the clock can hold
  more. The socket's own budget of 8 sits above it on purpose: the budget stops a client
  spending the server's time asking, and the simulation decides what actually fired. Check 11
  sends 20 fire frames and four are accepted.
- **Claiming an interact from across the map.** `interact` measures the distance from the
  server's own copy of the player's position to the place, and refuses past 2.5 m. The client
  names a place, never a position.
- **Garbage and oversized frames.** Every frame is parsed by a zod discriminated union.
  Three unreadable frames close the connection with 1008 (`MALFORMED_LIMIT`), and the socket
  is registered with an 8 KB payload ceiling. Check 11 proves the close code.
- **Inventing kills.** There is no message a client can send that reports a kill. Kills come
  out of `applyFire` and `damageDrone`, and credit goes to the top damage dealer, computed in
  the simulation.
- **Getting a quest counted twice, or out of order.** `recordWorldEvents` in
  `src/world/rooms.ts` puts every tick's events through one promise chain, so the second
  batch waits for the first. Ticks are 50 ms apart and a database write is not, so without
  the chain the fifth kill of a hunt could be written before the fourth and the quest would
  finish on the wrong event. A database that falls far behind is a lost cause rather than a
  queue worth growing: once `MAX_PENDING_BATCHES` (20) batches are waiting, the next tick of
  events is dropped with a line in the log. Losing progress is the cheaper failure, and it
  never pays anybody twice.

### 3. Claiming a payout (`POST /api/quests/:id/claim/challenge`, `POST /api/quests/:id/claim`)

Files: `src/routes/quests.ts`, `src/domain/claims.ts`, `src/domain/challenges.ts`,
`src/routes/context.ts`, `src/config.ts`.

This is the only door to money, so it has several locks in a row.

- **Claiming a quest that is not yours.** The quest is read with `WHERE id = ? AND address =
  session address`. Somebody else's quest answers 404, not "not yours", because the second
  would confirm which quest ids are real. Check 5 has a second wallet try wallet A's finished
  hunt and get 404.
- **Claiming a quest that is not finished.** The route refuses anything not in state `done`,
  and refuses a second time anything already `claimed`.
- **Signing with another wallet.** The signature is verified, the address is derived from the
  public key, and it is compared with the session's address. A mismatch is 401.
- **Replaying a signed claim.** The nonce is spent by `consumeChallenge`, and the quest moves
  to `claimed`. Check 5 sends the identical signed body twice and the second is 409.
- **Spending a challenge on a quest worth nothing.** A quest whose reward is zero is refused
  with 400 before `consumeChallenge` runs, so the player's challenge stays usable and no zero
  row reaches the claims table.
- **A quest marked claimed with no payout behind it.** The claim insert and the quest going
  to `claimed` happen in one database transaction in `src/routes/quests.ts`. Either a player
  has a payout and a spent quest, or neither.
- **Racing two claims through one quest.** The real lock is the partial unique index on
  `claims.quest_id`. Two requests can both read "this quest is done", and only one row can
  exist; the loser is told about the claim that already exists rather than getting a second
  one. `test/claims.race.test.ts` fires twenty concurrent claims at one quest and proves
  exactly one row is written.
- **Racing two different claims past a cap.** Measuring and writing in one transaction is not
  enough on its own: two claims for the same wallet can both read the old total before either
  of them writes. `lockForClaim` in `src/domain/claims.ts` therefore takes two Postgres
  advisory transaction locks before any total is read, always in the same order: a constant
  key for the pool first, then a key derived from the wallet address. `payLadder` in
  `src/domain/ladder.ts` takes the pool lock as the first statement of its own transaction,
  ahead of the wallet locks its three prizes take, so a week being paid and a player claiming
  a quest can never wait on each other in a circle. The locks belong to the transaction and
  go when it commits or rolls back.
- **Farming past the budget.** `holdReason` measures three caps under those locks, in this
  order: the wallet's own committed total today against `DAILY_CAP_NIM`, then distinct
  wallets that have claimed from this IP hash today against `IP_WALLETS_PER_DAY`, then
  everything ever committed against `POOL_TOTAL_NIM`. A claim that fails a cap is still
  written down, as `held` with the reason, so the money is visible and not quietly lost.
  Checks 7, 8 and 9 cross all three caps in one run, with the caps turned down so the run can
  reach them.
- **A held wallet counting against its neighbours.** `walletsFromIpToday` counts only wallets
  with a claim in `queued`, `sending`, `sent` or `paid`. A wallet that was itself held has
  taken nothing, so it no longer pushes the next wallet from the same address over the per-IP
  cap.
- **A cap quietly eating a real player's reward.** A hold is a delay, not a forfeiture.
  `queueClaimIn` stamps `held_until` with the next UTC midnight for the daily and the IP cap,
  and leaves it null for the pool, because pool room comes back the moment a committed claim
  fails rather than at a time anybody can name. The treasury calls `releaseHeld` every 60
  seconds and once at boot (`src/treasury/index.ts`). It re-runs the same cap check under the
  same two locks, flips the claims that now pass to `queued`, and moves the rest on to the
  next midnight. A released claim is re-dated to the moment it was released, because the
  daily cap counts a wallet by the day its claims entered the queue. A ladder prize held on
  Monday is paid this way instead of being lost.
- **Naming your own IP to get a fresh per-IP count.** The per-IP cap is only as good as the
  address the server believes. `TRUST_PROXY` is a list of trusted peers, not a hop count, and
  never `true`: `trustedProxies` in `src/config.ts` accepts addresses, CIDRs or the named
  ranges `loopback`, `linklocal` and `uniquelocal`, and blank trusts nobody. Blank behind a
  proxy is the safe failure and still a real one: every player then looks like the edge, so
  one address holds them all and from the third wallet of the day onwards everyone is held
  for "ip cap". `true` is the dangerous failure, because a caller who reaches the container
  directly could put any address in `X-Forwarded-For` and mint a fresh count for every
  wallet. `GET /api/echo-ip` in `src/app.ts` reports the address the server decided on, so
  the setting is checked against a real request after every deploy.
- **Learning who else plays.** The IP is never stored. `ipHash` in `src/routes/context.ts`
  keeps sha256 of `IP_SALT` plus the IP, because the IPv4 space is small enough to walk
  through in seconds without a salt.

### 4. The shop (`POST /api/shop/orders`, `GET /api/shop/orders/:id`)

Files: `src/domain/shop.ts`, `src/treasury/watcher.ts`.

- **Underpaying.** `markPaid` refuses when the value on chain is below the order's price.
  The price is the server's, from `items` in `src/domain/shop.ts`, not a number the phone
  sent.
- **Paying for somebody else's order, or having somebody else pay yours.** `markPaid`
  compares the sender on chain with the address that opened the order, through
  `comparableAddress` so a space or a lowercase letter never decides it. Check 10 pays
  0.01 NIM from the wrong wallet against a 1 NIM order and the order stays pending.
- **Reading another wallet's order.** `GET /api/shop/orders/:id` answers 404 for an order
  belonging to somebody else.
- **Paying one order twice, or the watcher seeing a payment twice.** The order's memo is
  unique, the transaction hash is unique, and the grant is a conditional
  `UPDATE ... WHERE state = 'pending'` inside a transaction with the gear write. A replayed
  pass is a no-op rather than a second grant.
- **A payment with no order behind it.** Anything into the treasury without the
  `vettai:shop:` prefix is refused and written down. The cursor moves past it, because it
  will never become an order.
- **A slow node turning a paid order into an expired one.** Expiry is judged against the
  block the payment was mined in, not the moment the watcher got round to reading it.
  `markPaid` takes `blockTime` from the transaction and only falls back to the clock when the
  node gave no time. The node reports that time in milliseconds, measured against a real
  testnet payout rather than assumed. A payment that reached the chain inside the half hour
  is honoured even if the treasury was restarting while it landed.
- **A refused payment disappearing.** Every incoming transaction the watcher inspects is
  written to `received_payments` with its outcome: `paid`, `short`, `expired`,
  `unknown_memo`, `sender_mismatch` or `already_paid`, together with the sender, the value,
  the block, the block time and the order it named. The transaction hash is the primary key
  and the insert ignores a conflict, so reading the same block twice keeps the first
  decision. Money that arrived is money that arrived, and a refusal is something Ram can
  settle by hand because the row is still there.

### 5. The treasury outbox (`deliverOnce`, `createSender`)

Files: `src/treasury/outbox.ts`, `src/treasury/sender.ts`, `src/treasury/refuse.ts`.

This is where an operator mistake costs the most, so the order of writes is the design.

- **A crash or restart paying twice.** A claim is moved to `sending` before any network call,
  so a second process or a restart cannot pick it up again. The transaction hash is written
  while the row is still `sending`, before the broadcast (`onSigned`). Every failure
  therefore leaves either "no hash, nothing was sent" or "a hash, go and look it up".
- **A timeout being answered with a resend.** `lookup` in `src/treasury/sender.ts` keeps
  three answers apart: in a block, still pending, and unknown. A lookup that throws is always
  "still pending", never "unknown", because a node that is busy or offline knows nothing
  about whether the payment exists. That exact mistake is what paid a player twice in the
  game this borrows from. Check 12 marks a claim `sending` with a hash that is not on any
  chain, runs a real delivery pass against testnet, and shows the claim left alone while the
  treasury balance falls by exactly the payouts that were confirmed.
- **A broadcast the node refused, after the hash was written down.** Such a row would
  otherwise sit in `sending` forever and the player would never be paid. `settleInFlight`
  asks the node one final time once the row has held its hash with no block for 15 minutes
  (`REJECTED_MS`). Only an answer of unknown after that wait counts as never accepted: a
  Nimiq transaction is valid for a couple of minutes after the height it was built at, so a
  node that has still never heard of the hash by then never will. The claim goes back to
  `queued` with the dead hash cleared and `attempts` incremented, and is rebuilt as a new
  transaction with a fresh validity height. After three attempts it is `failed` and left for
  a person. The count is the `attempts` integer column, never text parsed out of an error
  message.
- **A row that was picked up but never signed.** A `sending` row with no hash and older than
  ten minutes is retried once and then marked `failed` for Ram to look at, never retried in a
  loop.
- **The wrong key, or the wrong chain.** `assertTreasuryConfig` refuses to start the treasury
  unless the private key derives `TREASURY_ADDRESS` and the node reports the network in
  `NIMIQ_NETWORK`. A node on mainnet while the config says testnet turns a demo into real
  money leaving a real wallet, so it fails at boot instead of at the moment somebody is owed
  a payout. Check 1 runs the same function.
- **The world process holding a key.** `worldBootRefusal` in `src/config.ts`, called by
  `src/index.ts` before anything is served, refuses to start the world if
  `TREASURY_PRIVATE_KEY` is set in its environment at all. The key lives in its own file,
  `packages/server/.env.treasury`, which only the treasury process loads. The world can serve
  every read and write in the game and still cannot move a single luna.

### 6. The weekly ladder (`payLadder`)

File: `src/domain/ladder.ts`. The period row is inserted first, inside the transaction, so a
second caller, a restart, or a drifting clock is refused by the primary key rather than by a
check it could race past. The pool advisory lock is the very first statement of that
transaction, ahead of the wallet locks the three prizes take, which keeps the lock order the
same as every single claim's. A week with nobody in it still writes its row so it is never
looked at again. The public endpoint that reads the ladder cannot trigger a payment.

### 7. The landlord quest (`completeLandlordQuests`)

File: `src/treasury/stakes.ts`. This quest is finished by reading the chain, never by
anything a client says: the treasury asks the node for the wallet's active stake and compares
it with `LANDLORD_MIN_NIM`. Both the select and the update are filtered to the current UTC
day, so one stake read finishes one day's quest. Without that filter a single read would have
closed every open landlord quest a wallet had left behind and paid several days of reward for
one day of staking. `shouldReadStakes` gates the job on the UTC day rather than on a 24 hour
timer, so a restart cannot make a day run twice or skip it.

### 8. Configuration

`src/config.ts` validates every key with zod at boot and refuses to run on a bad one. The
treasury is refused without its key, and the world is refused with it. Nothing reads an
environment variable anywhere else.

## What we did not fix

Every one of these is a real hole. They are written down because a threat model that only
lists wins is marketing.

- **The caps bound the loss from a scripted client, they do not prevent one.** `npm run bot`
  is a scripted client we wrote ourselves: it signs in, joins the real socket, kills drones
  with computed aim, dodges bolts and walks the courier route. It is better at the game than
  a person. Nothing in the server can tell it apart from a phone, because it sends exactly
  what a phone sends. What the caps do is make the win small and bounded: one wallet cannot
  take more than `DAILY_CAP_NIM` a day whatever it does, and the whole game cannot pay more
  than `POOL_TOTAL_NIM` ever.
- **A scripted client can still farm inside the caps.** There is no seed to cherry-pick,
  because the server runs the simulation and the client never reports an outcome, so the
  attack where a player replays a favourable random seed does not apply here. What is left is
  patience: a bot that plays every day takes the daily cap every day, and as far as the
  server can tell it earned it.
- **The per-IP cap is dodged by a VPN.** The cap counts distinct wallets per IP hash per day.
  A farmer with a VPN, a phone on mobile data, or a handful of cloud machines gets a fresh
  count for each address. Check 9 of the prove run does exactly this on purpose, from two
  loopback addresses, to get past the IP cap and reach the pool cap. It is an honest speed
  bump against a casual farmer and nothing more.
- **A claim that fails after the nonce is spent costs the player a round trip.** The nonce is
  consumed before the claim transaction runs, because that ordering is what stops a replay.
  If the database then fails, the challenge is gone: the player has to ask for a new one and
  sign again. The quest is untouched and no money is lost, but the failure lands on them
  rather than on us.
- **The advisory locks are proven by the statements they issue, not by a real race.** The
  tests assert that both locks are taken, in the right order, inside the claim's own
  transaction, and that a run of claims never overruns a cap. PGlite, which the tests run on,
  executes one statement at a time, so nothing here proves the behaviour on a real Postgres
  with many connections holding the locks against each other, which is the case the locks
  exist for.
- **Drone scarcity is per room, so a farmer with many wallets in one room competes with
  itself.** A room holds at most six live drones and up to 24 players. That is an accident
  that helps us rather than a defence: it slows a farmer down, and it would slow twenty real
  players down the same way. It also means a farmer who spreads across rooms is not slowed at
  all.
- **The map is public, so routes can be optimised.** `GET /api/world/map` serves the whole
  city to anybody, with no session, because the client has to draw it. Every landmark,
  courier point and patrol loop is therefore known in advance and a bot can walk the shortest
  route between them. We chose this over hiding the map, which would not have worked anyway.
- **The treasury key is a single hot key on the host.** One process holds
  `TREASURY_PRIVATE_KEY` in memory and signs with it. Whoever gets that host gets the wallet.
  There is no hardware signer, no multisig, and no spending limit enforced anywhere but in
  our own code, which is why the wallet is funded with what the game needs and no more.
- **Nothing here is audited by anyone else.** This is a self-audit, written by the people who
  wrote the code, with a command anybody can run to check the parts that can be checked.
