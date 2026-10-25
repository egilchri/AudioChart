# Live AIS relay

Bird's-eye's 📡 Live button (v986) shows the vessels in Penobscot Bay right now, from their AIS broadcasts.
The vessels come from two feeds: [AISStream](https://aisstream.io), and since v1011
[Open Waters AIS](https://openwaters.io/ais), which adds [AISHub](https://www.aishub.net)'s volunteer receivers.
On 2026-10-25 that added a few vessels in each bay that AISStream didn't hear, such as a boat off Isle au Haut and
three in Casco Bay. Neither feed accepts connections from a web page, because the key would be visible there. So
this small relay holds the keys, keeps one connection to each feed for both bays, and answers `GET /vessels` with
the vessels it has heard, as JSON. When both feeds hear a vessel, the newest report wins: AISHub's reports reach
Open Waters a minute or so late.

```json
{ "t": 1792782066063, "listening": 340, "feeds": ["aisstream", "openwaters"],
  "vessels": [ { "mmsi": "366000001", "name": "NORDIC FREEDOM", "lat": 43.86, "lon": -68.92, "sog": 11, "cog": 347.2,
                 "hdg": 347, "status": 0, "type": 80, "L": 183, "B": 32, "dest": "SEARSPORT", "age": 4 } ] }
```

- `core.mjs`: the vessel table, shared by both versions of the relay.
- `worker.mjs` and `wrangler.toml`: the relay as a Cloudflare Worker. One Durable Object holds the connections to
  the feeds. The first request opens them, and they close after five minutes with nobody asking. AISStream allows
  three connections per key, Open Waters two per personal token. A feed without a key is skipped. Names, types and sizes are stored, because AIS sends them only every six minutes.
- `dev.mjs`: the relay on this computer, for development. `--fake` makes up a few vessels in AIS's own message
  format, so it needs no key.

The app finds the relay at `RELAY_DEFAULT` in `www/js/ais.js`. You can point it elsewhere with
`?ais=<url>` on bay3d.html or with localStorage `audiochart-ais-relay`.

## Deploying (once)

1. Get an AISStream key: sign in at aisstream.io and create one under API Keys.
2. Get a free Cloudflare account, then from this folder:
   ```
   npx wrangler login
   npx wrangler secret put AISSTREAM_KEY      # paste the key; it never goes in the repo
   npx wrangler secret put OPENWATERS_KEY     # an Open Waters personal token (below)
   npx wrangler deploy
   ```
   When a release changes the relay's code, bump `RELAY_V` in `worker.mjs` before deploying. A running Durable
   Object keeps its old code while its feed connections are open, so the new version gets a fresh object.
   `/vessels?bbox=w,s,e,n` answers with only the vessels in that box (v1019).
   An Open Waters personal token is free and never expires. It is minted with an Ed25519 key, `openwaters-key.pem`
   in this folder, which is git-ignored (the recipe is in the `POST /v1/keys` entry of
   https://ais.openwaters.io/openapi.json). Its terms: free for personal use, with each source credited.
   Open Waters asks to be emailed about anything bigger. The app shows the credit in the Live button's tooltip
   (`AIS_CREDIT`, www/js/ais.js).
3. Check it at `https://audiochart-ais.<your-subdomain>.workers.dev/vessels`. The first request opens the feed;
   ask again a minute later. If the subdomain isn't `egilchri`, set `RELAY_DEFAULT` in `www/js/ais.js`.

## Developing

```
node relay/ais/dev.mjs --fake                    # made-up vessels at http://localhost:8790/vessels
AISSTREAM_KEY=... OPENWATERS_KEY=... node relay/ais/dev.mjs   # the real feeds (either or both)
```
Then open `bay3d.html?ais=http://localhost:8790` from a local server.
