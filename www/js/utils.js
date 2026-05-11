/**
 * Formatting utilities for nautical navigation output.
 * All bearing/distance outputs are optimized for TTS clarity.
 */

/**
 * Magnetic variation for the current area, in degrees.
 * Positive = East, Negative = West.
 * Penobscot Bay, ME: approximately -15° (15°W) as of 2025.
 * True bearing + variation = magnetic bearing (for westerly variation, magnetic > true).
 */
export let magneticVariation = -15;

export function setMagneticVariation(deg) {
  magneticVariation = deg;
}

/**
 * Convert a true bearing to magnetic bearing using the current variation.
 * West variation is negative, so: magnetic = true - variation
 * e.g. true 090°, variation -15° → magnetic 105°
 */
export function trueTomagnetic(trueBearing) {
  return ((trueBearing - magneticVariation) % 360 + 360) % 360;
}

/** Spell bearing digits individually for clear TTS: 127 → "one two seven magnetic" */
export function bearingToWords(deg) {
  const d = Math.round(((deg % 360) + 360) % 360);
  const s = String(d).padStart(3, '0');
  const digits = { '0': 'zero', '1': 'one', '2': 'two', '3': 'three', '4': 'four',
                   '5': 'five', '6': 'six', '7': 'seven', '8': 'eight', '9': 'nine' };
  return s.split('').map(c => digits[c]).join(' ') + ' degrees magnetic';
}

/** Bearing to 16-point compass abbreviation */
export function bearingToCardinal(deg) {
  const d = ((deg % 360) + 360) % 360;
  const pts = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return pts[Math.round(d / 22.5) % 16];
}

/**
 * Format distance for TTS.
 * < 0.1 nm → yards; < 1 nm → tenths; ≥ 1 nm → one decimal
 */
export function formatDistance(nm) {
  if (nm < 0.01) return 'very close';
  if (nm < 0.1) {
    const yards = Math.round(nm * 2025 / 50) * 50;
    return `about ${yards} yards`;
  }
  if (nm < 1.0) return `${nm.toFixed(1)} nautical miles`;
  return `${nm.toFixed(1)} nautical miles`;
}

/** Format decimal degrees as degrees-minutes: 44.1234 → "44 degrees 07.4 minutes North" */
export function formatDM(decimal, isLat) {
  const abs = Math.abs(decimal);
  const deg = Math.floor(abs);
  const min = ((abs - deg) * 60).toFixed(1);
  const dir = isLat ? (decimal >= 0 ? 'North' : 'South') : (decimal >= 0 ? 'East' : 'West');
  return `${deg} degrees ${min.padStart(4, '0')} minutes ${dir}`;
}

/** Format position for display (compact): 44°07.4'N 068°52.1'W */
export function formatPositionDisplay(lat, lon) {
  const latAbs = Math.abs(lat);
  const lonAbs = Math.abs(lon);
  const latDeg = Math.floor(latAbs);
  const latMin = ((latAbs - latDeg) * 60).toFixed(1);
  const lonDeg = Math.floor(lonAbs);
  const lonMin = ((lonAbs - lonDeg) * 60).toFixed(1);
  const latDir = lat >= 0 ? 'N' : 'S';
  const lonDir = lon >= 0 ? 'E' : 'W';
  return `${latDeg}°${latMin.padStart(4,'0')}'${latDir}  ${String(lonDeg).padStart(3,'0')}°${lonMin.padStart(4,'0')}'${lonDir}`;
}

/** Round bearing to nearest 5 degrees (reduces TTS verbosity for approximate bearings) */
export function roundBearing(deg) {
  return Math.round(((deg % 360) + 360) % 360 / 5) * 5 % 360;
}
