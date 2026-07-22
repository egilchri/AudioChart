/**
 * Voice command parser — pure regex, no LLM.
 * Maps transcribed speech → {intent, params} objects.
 */

// Phonetic aliases for place names that voice recognition commonly garbles
const PLACE_ALIASES = {
  'carve our': 'carver',
  'carvers': 'carvers harbor',
  'final haven': 'vinalhaven',
  'vinyl haven': 'vinalhaven',
  'vinyl haven island': 'vinalhaven',
  'fox island': 'fox islands thorofare',
  'fox islands': 'fox islands thorofare',
  'thorofare': 'fox islands thorofare',
  'thorough fare': 'fox islands thorofare',
  // Light-specific aliases (must come before the broad 'rockland' alias below)
  // NOTE: keep these specific — broad aliases cascade badly with 'thorofare' above.
  'rockland breakwater':         'rockland breakwater light',
  "owl's head":                  'owls head',
  'owl head':                    'owls head',
  'owls head light':             'owls head',
  'rockland': 'rockland harbor',
  'north haven': 'north haven island',
  'muscle ridge': 'muscle ridge channel',
};

/** Normalize a place name for matching: lowercase, strip articles, apply aliases. */
export function normalizePlaceName(raw) {
  let s = raw.toLowerCase()
    .replace(/\b(the|a|an)\b/g, '')
    .replace(/harbour/g, 'harbor')
    .replace(/\s+/g, ' ')
    .trim();
  for (const [alias, replacement] of Object.entries(PLACE_ALIASES)) {
    if (s.includes(replacement)) continue;  // already contains the target — skip
    if (s.includes(alias)) s = s.replace(alias, replacement);
  }
  return s.trim();
}

/**
 * Extract {from, to} places from a "from X to Y" / "between X and Y" /
 * "from X" / "to Y" phrase, for the Routes/Tracks search boxes — a plain
 * text-field version of the from/to idiom used by HAZARDS_ON_COURSE above,
 * without that intent's hazard-specific trigger words.
 * `directional: false` (only for "between...and") means either order counts.
 */
export function parseFromToQuery(text) {
  let m;
  if (m = text.match(/\bfrom\s+(.+?)\s+to\s+(.+)$/i))     return { from: m[1].trim(), to: m[2].trim(), directional: true };
  if (m = text.match(/\bbetween\s+(.+?)\s+and\s+(.+)$/i)) return { from: m[1].trim(), to: m[2].trim(), directional: false };
  if (m = text.match(/\bfrom\s+(.+)$/i))                  return { from: m[1].trim(), to: null, directional: true };
  if (m = text.match(/\bto\s+(.+)$/i))                    return { from: null, to: m[1].trim(), directional: true };
  return { from: null, to: null, directional: true };
}

/**
 * Try to parse a string as a lat/lon coordinate.
 * Handles:
 *   44° 04.8674' N 068° 57.2965' W   (degrees-minutes with symbols)
 *   44 04.8674 N 068 57.2965 W        (degrees-minutes without symbols)
 *   44.0811, -68.9549                  (decimal degrees)
 *   44.0811 -68.9549                   (decimal degrees, space-separated)
 * Returns {lat, lon} or null.
 */
export function parseCoordinate(text) {
  const t = text.trim();

  // Degrees-minutes: D° M' N/S D° M' E/W  (symbols optional)
  const dm = t.match(
    /(\d{1,3})\s*[°\s]\s*(\d{1,2}(?:\.\d+)?)\s*['\s]*([NS])\s+(\d{1,3})\s*[°\s]\s*(\d{1,2}(?:\.\d+)?)\s*['\s]*([EW])/i
  );
  if (dm) {
    let lat = parseInt(dm[1]) + parseFloat(dm[2]) / 60;
    let lon = parseInt(dm[4]) + parseFloat(dm[5]) / 60;
    if (dm[3].toUpperCase() === 'S') lat = -lat;
    if (dm[6].toUpperCase() === 'W') lon = -lon;
    if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) return { lat, lon };
  }

  // Decimal degrees: 44.0811, -68.9549  or  44.0811 -68.9549
  const dd = t.match(/^(-?\d{1,3}\.\d+)\s*[,\s]\s*(-?\d{1,3}\.\d+)$/);
  if (dd) {
    const lat = parseFloat(dd[1]), lon = parseFloat(dd[2]);
    if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) return { lat, lon };
  }

  return null;
}

/** Parse "number unit" distance patterns → nautical miles */
function parseRadius(text) {
  const nm = text.match(/(\d+(?:\.\d+)?)\s*(?:nm|nautical\s*miles?)/i);
  if (nm) return parseFloat(nm[1]);
  if (/quarter\s*mile|1\s*\/\s*4\s*mile/i.test(text)) return 0.25;
  if (/half\s*mile|1\s*\/\s*2\s*mile/i.test(text)) return 0.5;
  if (/one\s*mile/i.test(text)) return 1.0;
  if (/two\s*miles?/i.test(text)) return 2.0;
  const mi = text.match(/(\d+(?:\.\d+)?)\s*mi(?:les?)?/i);
  if (mi) return parseFloat(mi[1]);
  return 0.25; // default
}

function navaidFilter(word) {
  const w = word.toLowerCase();
  if (/buoy|marker|nun|can/.test(w)) return 'buoy';
  if (/light/.test(w)) return 'light';
  if (/beacon/.test(w)) return 'beacon';
  return null;
}

/** Return an array of navaid label strings from a phrase like "buoys and lights". */
function navaidFilters(text) {
  const t = text.toLowerCase();
  const types = [];
  if (/buoy|marker|nun|can/.test(t)) types.push('buoy');
  if (/light/.test(t)) types.push('light');
  if (/beacon/.test(t)) types.push('beacon');
  return types.length ? types : null;
}

const PATTERNS = [
  // LIST OBJECTS
  {
    re: /\b(list\s+objects?|what\s+objects?|what\s+can\s+you\s+(find|tell|do)|what\s+types?|object\s+types?)\b/i,
    intent: 'LIST_OBJECTS',
    params: {},
  },

  // LIST WAYPOINTS
  {
    re: /\b(list|show|what\s+are|where\s+are)\s+(my\s+)?waypoints?\b/i,
    intent: 'LIST_WAYPOINTS',
    params: {},
  },
  {
    re: /\bmy\s+waypoints?\b/i,
    intent: 'LIST_WAYPOINTS',
    params: {},
  },

  // DELETE WAYPOINT
  {
    re: /\b(delete|remove|clear)\s+waypoint\s+(\S+)/i,
    intent: 'DELETE_WAYPOINT',
    extract: (m) => ({ waypointName: m[2].toLowerCase() }),
  },
  {
    re: /\b(delete|remove)\s+(wp\d+)\b/i,
    intent: 'DELETE_WAYPOINT',
    extract: (m) => ({ waypointName: m[2].toLowerCase() }),
  },

  // WHERE AM I / POSITION
  {
    re: /\b(where am i|what'?s?\s+my\s+(position|location|coordinates?)|what\s+is\s+my\s+(position|location)|my\s+position)\b/i,
    intent: 'WHERE_AM_I',
    params: {},
  },

  // NEAREST HAZARD
  {
    re: /\b(nearest|closest)\s+hazard\b/i,
    intent: 'NEAREST_HAZARD',
    params: {},
  },
  {
    re: /\b(any|are\s+there)\s+hazards?\s*(nearby|around|close|here)\b/i,
    intent: 'NEAREST_HAZARD',
    params: {},
  },

  // HAZARDS IN RADIUS (must come before BEARING_TO_PLACE)
  {
    re: /hazards?.{0,30}(quarter|1\s*\/\s*4)\s*mile/i,
    intent: 'HAZARDS_IN_RADIUS',
    params: { radiusNm: 0.25 },
  },
  {
    re: /hazards?.{0,30}half\s*mile/i,
    intent: 'HAZARDS_IN_RADIUS',
    params: { radiusNm: 0.5 },
  },
  {
    re: /hazards?.{0,50}within\s+(.{1,30})/i,
    intent: 'HAZARDS_IN_RADIUS',
    extract: (m) => ({ radiusNm: parseRadius(m[1]) }),
  },
  {
    re: /\b(give\s+me|report|what\s+are|list)\b.{0,30}(bearing|hazard).{0,30}hazard/i,
    intent: 'HAZARDS_IN_RADIUS',
    params: { radiusNm: 0.25 },
  },

  // NEAREST NAVAID
  {
    re: /\b(nearest|closest)\s+(buoy|beacon|light|marker|nun|can)\b/i,
    intent: 'NEAREST_NAVAID',
    params: {},
  },

  // NAVAIDS IN RADIUS
  {
    re: /(buoys?|lights?|beacons?|markers?|navaids?|navigation\s+aids?|nuns?|cans?).{0,30}(quarter|1\s*\/\s*4)\s*mile/i,
    intent: 'NAVAIDS_IN_RADIUS',
    extract: (m) => ({ radiusNm: 0.25, filter: navaidFilter(m[1]) }),
  },
  {
    re: /(buoys?|lights?|beacons?|markers?|navaids?|navigation\s+aids?|nuns?|cans?).{0,30}half\s*mile/i,
    intent: 'NAVAIDS_IN_RADIUS',
    extract: (m) => ({ radiusNm: 0.5, filter: navaidFilter(m[1]) }),
  },
  {
    re: /(buoys?|lights?|beacons?|markers?|navaids?|navigation\s+aids?|nuns?|cans?).{0,50}with(?:in)?\s+(.{1,30})/i,
    intent: 'NAVAIDS_IN_RADIUS',
    extract: (m) => ({ radiusNm: parseRadius(m[2]), filter: navaidFilter(m[1]) }),
  },
  {
    re: /(buoys?|lights?|beacons?|markers?|navaids?|navigation\s+aids?|nuns?|cans?).{0,20}(nearby|around|close|here)/i,
    intent: 'NAVAIDS_IN_RADIUS',
    extract: (m) => ({ radiusNm: 0.5, filter: navaidFilter(m[1]) }),
  },

  // NAVAIDS ON BEARING — with explicit tolerance (e.g. "buoys and lights bearing at 90 +- 10")
  {
    re: /(buoys?\s+(?:and\s+)?lights?|lights?\s+(?:and\s+)?buoys?|buoys?|lights?|beacons?|navaids?).{0,30}(?:bearing\s+(?:at\s+)?|at\s+bearing\s+)(\d{1,3})(?:\s*°?(?:\s*degrees?)?)?.{0,10}(?:\+[-–]?|plus\s+or\s+minus|within)\s*(\d{1,3})/i,
    intent: 'NAVAIDS_ON_BEARING',
    extract: (m) => ({ filters: navaidFilters(m[1]), bearing: parseInt(m[2]), tolerance: parseInt(m[3]) }),
  },
  // NAVAIDS ON BEARING — bearing only, default ±10° tolerance
  {
    re: /(buoys?\s+(?:and\s+)?lights?|lights?\s+(?:and\s+)?buoys?|buoys?|lights?|beacons?|navaids?).{0,30}(?:bearing\s+(?:at\s+)?|at\s+bearing\s+)(\d{1,3})(?:\s*°?(?:\s*degrees?)?)/i,
    intent: 'NAVAIDS_ON_BEARING',
    extract: (m) => ({ filters: navaidFilters(m[1]), bearing: parseInt(m[2]), tolerance: 10 }),
  },

  // OFFLINE READINESS CHECK
  {
    re: /\b(offline\s+status|cache\s+status|data\s+(cached|ready|status)|pre.?cached|ready\s+for\s+(offline|cruising?|sea)|all\s+.*data.*cached|is\s+.*data\s+(cached|ready))\b/i,
    intent: 'OFFLINE_STATUS',
    params: {},
  },

  // NEAREST RESTRICTION
  {
    re: /\b(land\s+data|land\s+polygons?|los\s+data|line.of.sight\s+data)\b/i,
    intent: 'LAND_DATA',
    params: {},
  },
  {
    re: /\b(nearest|closest|any)\s+(restrict|no.anchor|no.wake|sanctuary|refuge|reserve|prohibited|entry\s+prohibited)/i,
    intent: 'NEAREST_RESTRICTION',
    params: {},
  },
  {
    re: /\b(restrict|prohibited|no.anchor|no.wake|sanctuary|reserve).{0,20}(near|nearby|around|here|close)\b/i,
    intent: 'NEAREST_RESTRICTION',
    params: {},
  },

  // DEPTH HERE
  {
    re: /\b(what.?s\s+the\s+depth|depth\s+here|how\s+deep|water\s+depth|depth\s+at|sounding|depth\s+check)\b/i,
    intent: 'DEPTH_HERE',
    params: {},
  },

  // HAZARDS ON COURSE FROM X TO Y  (must come before BEARING_TO_PLACE)
  // Note: place names are NOT normalized here — aliases can cascade on full names.
  // The lookup functions handle matching directly.
  {
    re: /\b(hazard|danger|obstacle|what.{0,15}(way|course|route|between)).{0,50}\bfrom\s+(.{3,60}?)\s+to\s+(.{3,60})$/i,
    intent: 'HAZARDS_ON_COURSE',
    extract: (m) => ({ fromPlace: m[3].trim(), toPlace: m[4].trim() }),
  },
  {
    re: /\b(hazard|danger|obstacle|between).{0,40}\bbetween\s+(.{3,60}?)\s+and\s+(.{3,60})$/i,
    intent: 'HAZARDS_ON_COURSE',
    extract: (m) => ({ fromPlace: m[2].trim(), toPlace: m[3].trim() }),
  },

  // HAZARDS ALONG NAMED OPENCPN ROUTE (must come before BEARING_TO_PLACE)
  {
    re: /\bhazards?\s+along\s+(?:the\s+)?(.{3,60})$/i,
    intent: 'HAZARDS_ALONG_ROUTE',
    extract: (m) => ({ routeName: m[1].trim() }),
  },
  {
    re: /\bhazards?\s+on\s+(?:the\s+)?(.{3,60}\broute\b.{0,10})$/i,
    intent: 'HAZARDS_ALONG_ROUTE',
    extract: (m) => ({ routeName: m[1].trim() }),
  },

  // RUN TEST — developer shorthand: "run T1" … "run T6"
  {
    re: /^run\s+t(\d+)$/i,
    intent: 'RUN_TEST',
    extract: (m) => ({ testNum: parseInt(m[1], 10) }),
  },

  // POSITION FIX — two-bearing cross-bearing fix (must come before BEARING_TO_PLACE)
  // "fix Deer Island Thorofare Light Station 096 Blue Hill Bay Light 083"
  // "position fix Rockland Breakwater 285 Owls Head 315"
  // "cross bearing Two Bush Island Light 065 Deer Island 096"
  {
    re: /\b(?:position\s+)?(?:fix|cross[- ]?bearing)\s+(.+?)\s+(\d{1,3})\s+(.+?)\s+(\d{1,3})\s*$/i,
    intent: 'POSITION_FIX',
    extract: (m) => ({
      landmark1: m[1].trim(),
      bearing1:  parseInt(m[2], 10),
      landmark2: m[3].trim(),
      bearing2:  parseInt(m[4], 10),
    }),
  },

  // QUERY FOCUS — bare repeat command, must be the WHOLE transcript
  {
    re: /^(?:range\s+and\s+bearing|bearing\s+and\s+range|bearing|range|distance|how\s+far|status|check)\s*[?.!]?\s*$/i,
    intent: 'QUERY_FOCUS',
    params: {},
  },

  // SET FOCUS
  {
    re: /\b(?:focus\s+on|set\s+focus\s+(?:to|on)|watch)\s+(.{3,60})$/i,
    intent: 'SET_FOCUS',
    extract: (m) => ({ placeName: m[1].trim() }),
  },

  // CLEAR FOCUS
  {
    re: /\b(?:clear|cancel|remove)\s+focus\b/i,
    intent: 'CLEAR_FOCUS',
    params: {},
  },

  // RANGE AND BEARING TO GPS COORDINATE (checked before named place)
  {
    re: /\b(range\s+and\s+bearing|bearing\s+and\s+range|bearing|distance|how\s+far|range)\b.{0,20}(to|of)\s+(.{3,80})$/i,
    intent: 'BEARING_TO_COORD',
    extract: (m) => {
      const coord = parseCoordinate(m[3].trim());
      return coord ? { lat: coord.lat, lon: coord.lon } : null;
    },
  },

  // RANGE AND BEARING TO NAMED PLACE
  {
    re: /\b(range\s+and\s+bearing|bearing\s+and\s+range|bearing|distance|how\s+far|range)\b.{0,20}(to|of)\s+(.{3,60})$/i,
    intent: 'BEARING_TO_PLACE',
    extract: (m) => ({ placeName: m[3].trim() }),
  },
];

/**
 * Parse a voice transcript into an intent object.
 * Returns {intent, params} or {intent: 'UNKNOWN', transcript}.
 */
export function parseCommand(transcript) {
  const t = transcript.trim();
  for (const pattern of PATTERNS) {
    const m = t.match(pattern.re);
    if (m) {
      const params = pattern.extract ? pattern.extract(m) : { ...pattern.params };
      // extract() returns null when a coordinate parse fails — skip this pattern
      if (params === null) continue;
      if (params.placeName) {
        params.placeName = normalizePlaceName(params.placeName);
      }
      return { intent: pattern.intent, params };
    }
  }
  return { intent: 'UNKNOWN', params: { transcript: t } };
}
