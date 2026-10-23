# Live AIS relay

Bird's-eye's 📡 Live button (v986) shows the vessels in Penobscot Bay right now, from their AIS broadcasts.
The vessels come from [AISStream](https://aisstream.io). AISStream doesn't accept connections from a web page,
because the account key would be visible there. So this small relay holds the key, keeps one connection to
AISStream for the bay, and answers `GET /vessels` with the vessels it has heard, as JSON:

```json
{ "t": 1792782066063, "listening": 340,
  "vessels": [ { "mmsi": "366000001", "name": "NORDIC FREEDOM", "lat": 43.86, "lon": -68.92, "sog": 11, "cog": 347.2,
                 "hdg": 347, "status": 0, "type": 80, "L": 183, "B": 32, "dest": "SEARSPORT", "age": 4 } ] }
```

- `core.mjs`: the vessel table, shared by both versions of the relay.
- `worker.mjs` and `wrangler.toml`: the relay as a Cloudflare Worker. One Durable Object holds the connection to
  AISStream. The first request opens it, and it closes after five minutes with nobody asking. AISStream allows
  three connections per key. Names, types and sizes are stored, because AIS sends them only every six minutes.
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
   npx wrangler deploy
   ```
3. Check it at `https://audiochart-ais.<your-subdomain>.workers.dev/vessels`. The first request opens the feed;
   ask again a minute later. If the subdomain isn't `egilchri`, set `RELAY_DEFAULT` in `www/js/ais.js`.

## Developing

```
node relay/ais/dev.mjs --fake                    # made-up vessels at http://localhost:8790/vessels
AISSTREAM_KEY=... node relay/ais/dev.mjs         # the real feed
```
Then open `bay3d.html?ais=http://localhost:8790` from a local server.
