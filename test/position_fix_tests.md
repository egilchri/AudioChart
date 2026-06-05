# Position Fix — Manual Test Suite

Tests for the voice-commanded two-bearing cross-bearing fix feature.
Each test: type `run T1` (or T2–T6) into the app — it sets the position and fires the command automatically.
Claude can evaluate results via screenshot — after submitting, say "check it".

Landmarks used: **RBL** = Rockland Breakwater Light · **TBIL** = Two Bush Island Light · **DITLS** = Deer Island Thorofare Light Station

All three are proper USCG lights; their markers will appear on the islands/breakwater (expected).
All fix results verified to land in water.

---

## T1 ✅ PASSED
**Position:** 44°05.5'N  69°00.5'W
```
fix Rockland Breakwater Light 299 Two Bush Island Light 215
```
| Field | Expected | Pass condition |
|-------|----------|----------------|
| Lat | 44°05.5'N | within 0.2' |
| Lon | 069°00.6'W | within 0.2' |
| Quality | Good fix | exact |
| Crossing | 84° | ±2° |

---

## T2
**Position:** 44°03.0'N  69°03.0'W
```
fix Grindstone Ledge Buoy 22 134 Monroe Island Lighted Bell Buoy 11 043
```
| Field | Expected | Pass condition |
|-------|----------|----------------|
| Lat | 44°03.0'N | within 0.2' |
| Lon | 069°03.0'W | within 0.2' |
| Quality | Good fix | exact |
| Crossing | 89° | ±2° |

---

## T3
**Position:** 44°03.0'N  68°59.0'W
```
fix Rockland Breakwater Light 324 Two Bush Island Light 232
```
| Field | Expected | Pass condition |
|-------|----------|----------------|
| Lat | 44°03.0'N | within 0.2' |
| Lon | 068°59.1'W | within 0.2' |
| Quality | Good fix | exact |
| Crossing | 88° | ±2° |

---

## T4
**Position:** 44°04.0'N  68°59.0'W
```
fix Rockland Breakwater Light 314 Two Bush Island Light 227
```
| Field | Expected | Pass condition |
|-------|----------|----------------|
| Lat | 44°04.0'N | within 0.2' |
| Lon | 068°59.1'W | within 0.2' |
| Quality | Good fix | exact |
| Crossing | 87° | ±2° |

---

## T5
**Position:** 44°05.5'N  69°01.0'W
```
fix Rockland Breakwater Light 301 Two Bush Island Light 213
```
| Field | Expected | Pass condition |
|-------|----------|----------------|
| Lat | 44°05.5'N | within 0.2' |
| Lon | 069°01.0'W | within 0.2' |
| Quality | Good fix | exact |
| Crossing | 88° | ±2° |

---

## T6
**Position:** 44°06.0'N  69°03.0'W
```
fix Rockland Breakwater Light 296 Two Bush Island Light 202
```
| Field | Expected | Pass condition |
|-------|----------|----------------|
| Lat | 44°06.0'N | within 0.2' |
| Lon | 069°03.0'W | within 0.2' |
| Quality | Good fix | exact |
| Crossing | 86° | ±2° |

---

## Deer Isle Region (T7–T11)

All positions LOS-verified against land.geojson. Fix results confirmed in water.

### T7 — South of Deer Isle, 86° crossing
**Position:** 44°02.0'N  68°40.0'W
```
fix Rock T Buoy 6 348 The Brandies Buoy 4 254
```
Expected: `44°02.0'N  068°40.0'W  ·  Good fix  94°`

### T8 — Southern approach (near Isle au Haut), 80° crossing
**Position:** 44°02.0'N  68°48.0'W
```
fix Bunker Ledge Buoy 8 246 Old Duke Ledges Buoy 6 146
```
Expected: `44°02.0'N  068°48.0'W  ·  Good fix  100°`

### T9 — Blue Hill Bay entrance, 65° crossing (real lighthouse)
**Position:** 44°14.0'N  68°30.0'W
```
fix Pond Island Passage Buoy 3 086 Blue Hill Bay Light 021
```
Expected: `44°14.0'N  068°30.0'W  ·  Good fix  65°`

### T10 — Stonington approach, 68° crossing
**Position:** 44°06.0'N  68°40.0'W
```
fix North Bay Ledge Buoy 2 135 Ram Island Ledge Buoy 2 247
```
Expected: `44°06.0'N  068°40.0'W  ·  Good fix  112°`

### T11 — East of Deer Isle, 73° crossing
**Position:** 44°12.0'N  68°32.0'W
```
fix Mahoney Island Ledge Buoy 2 054 Channel Rock Buoy 5 341
```
Expected: `44°12.0'N  068°32.0'W  ·  Good fix  73°`

---

## Notes

- All bearings are **magnetic**.
- Landmark markers appear on islands/breakwater — that is correct; lighthouses ARE on land.
- Fix result (red marker) must land in water — all positions verified in water against land.geojson with LOS confirmed clear.
- Crossing angle displayed is the raw formula arc (0–180°), not the physical acute angle. Values ≥60° = Good fix.
- `Blue Hill Bay Light` is a proper USCG light; all others are named buoys confirmed in navaid.geojson.
