# Drawing ships as they look

Requested (2026-10-24): "depict ships in a way approximating how they look … we need a strategy going forward,
emphasizing efficiency but also verisimilitude".

## The strategy: three layers, cheapest first

1. **A model per kind of ship** (`www/js/ships3d.js`), shaped from her AIS data: length, beam, and draught. Draught
   sets her freeboard, so a tanker lies deep when loaded and high in ballast. One model covers every ship of that
   kind, and each kind is built once from photos of typical examples. Done: product tanker, harbour tug, pilot boat
   (v1001). Next, in order of how often they're seen here:
   - container ship
   - bulk carrier (with deck cranes)
   - car carrier
   - LPG carrier
   - fishing trawler
   - research or survey vessel

   The generic `merchantModel` (vessels.js) stays as the fallback.
2. **Liveries by operator** (`www/data/ships.json` `liveries`). One entry, matched by a name pattern, dresses a whole
   fleet: "^IVER " covers every Iver Ships tanker, and "MCALLISTER" every McAllister tug. A livery holds:
   - hull, boot-top and deck colours
   - superstructure colour
   - funnel colours, with its top and band
   - a hull mark (Vroon's V)
   - the colour her name is painted in

   This is where verisimilitude is cheapest: a few minutes from one good photo per operator.
3. **Particulars per ship** (`ships` in the same file), only for ships that call here or are worth getting exactly
   right. Each entry holds her MMSI and IMO number, length, beam, depth and design draught, from the owner's spec
   sheet. This lets her be drawn right before her AIS static data arrives, which takes minutes. It can also name a
   livery outright.

A ship in none of the lists still gets her kind's model, in colours picked from her name from a palette of real
liveries. So nothing looks generic, and nothing claims an identity we haven't checked.

## Working rules

- Verify particulars against a published source (an owner's spec sheet, a builder's or class register), not
  search summaries, and record the source in the entry's `src`.
- Colours come from photos of the ship herself or a sister ship in the same livery. Mark guesses as guesses.
  For example, the Iver funnel is assumed white with a black top: the reference photo doesn't show it.
- Keep each model cheap: a lofted hull (`loftHull`), a few deckhouses (`deckhouse`), simple boxes and cylinders for
  deck gear, textures drawn on canvases. No downloaded meshes or images, so it works offline.
- Check each new model in `design/pending/ferry_preview/index.html?m=tanker:IVER%20PROSPERITY:184,...&v=q|s|a`.
  Then check it in Bird's-eye with a stubbed AIS feed, from Side, Stern and Bow, before shipping.

## Which ships call here (the queue for layers 2 and 3)

Watch the relay's feed for big ships (AIS types 70–89, or longer than 60 m) in Casco and Penobscot Bays. Add an
operator's livery the first time one of its ships turns up. Expected regulars:
- **Portland:** product tankers to the South Portland terminals; Eimskip container ships at the International
  Marine Terminal; cruise ships in season; McAllister tugs; the pilot boats.
- **Penobscot Bay:** tankers and bulk carriers to Searsport (Mack Point).

## Sources used so far

- **Iver Prosperity:** Vroon vessel particulars (17 Sep 2022): 184.32 m long, 27.40 m beam, 17.20 m deep, 11.32 m
  summer draught, built 2007 by Hyundai Mipo. Livery from vroon.nl's photo of her fleet-mate Iver Beauty: red hull
  and deck, white V forward, white house.
- **McAllister tugs:** Wikimedia Commons, *Capt. Brian A. McAllister*: black hull, gold sheer stripe, maroon house
  with white trim, red stacks with black tops.
- **Spring Point (Portland pilots):** a 2009 photo and its caption (Gladding-Hearn, 2004, Hunt design, 52.5 × 17 ft,
  4.8 ft draught): black hull, grey cabin, "PILOT" in red.
