// The time where the bay is (v1041, requested: "fix the clock to use the region's time zone"): Bird's-eye's clock,
// its sun, its timetables and the times on its cards are the bay's own, not this device's (San Francisco at 5 pm
// read 20:11 on a computer in Maine). bay3d.js sets the zone from regions3d.js; until then, and on pages that
// don't (the chart, the helm view), it's the device's own, as before.
let TZ;
export const setRegionTZ = tz => { TZ = tz || undefined; };
// the bay's calendar and clock at instant t: { y, mo, d, h, mi, s }
export function zoned(t = Date.now()) {
  const P = {};
  for (const p of new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(t))) P[p.type] = Number(p.value);
  return { y: P.year, mo: P.month, d: P.day, h: P.hour % 24, mi: P.minute, s: P.second };
}
// minutes since the bay's midnight
export const minOfDay = (t = Date.now()) => { const z = zoned(t); return z.h * 60 + z.mi + z.s / 60; };
// the instant of minute m of the bay's day today (the day's offset from UTC as it is now; off by the hour only on the
// two nights a year the clocks change)
export const bayMs = m => { const t = Date.now(); return t - minOfDay(t) * 60e3 + m * 60e3; };
// a Date whose own (device) calendar day is the bay's today, for code that reads getFullYear/getMonth/getDate
export const bayDay = (t = Date.now()) => { const z = zoned(t); return new Date(z.y, z.mo - 1, z.d, 12); };
// h:mm as the bay's clocks show it, and the same with the weekday
export const bayTime = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: TZ });
export const bayDayTime = t => new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: TZ });
