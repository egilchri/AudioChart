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
fix Rockland Breakwater Light 355 Deer Island Thorofare Light Station 086
```
| Field | Expected | Pass condition |
|-------|----------|----------------|
| Lat | 44°02.9'N | within 0.2' |
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

## Notes

- All bearings are **magnetic**.
- Landmark markers appear on islands/breakwater — that is correct; lighthouses ARE on land.
- Fix result (red marker) must land in water — all six positions verified in water against land.geojson.
- Crossing angle is the acute angle between position lines. 60°–90° = Good; 30°–60° = Fair.
- `Deer Island Thorofare Light Station` must be typed in full; speech recognition may truncate it.
