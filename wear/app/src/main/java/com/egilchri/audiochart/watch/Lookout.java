package com.egilchri.audiochart.watch;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * The hazard lookout: given each GPS fix, decides what to say. Plain Java,
 * no Android, so it runs in a JVM test too.
 *
 * Mirrors the web app's free-sail look-ahead (app.js _fsLookAhead): look
 * six minutes ahead along the course (at least a quarter mile), warn once
 * per charted rock/obstruction/wreck within 0.1 nm of that line, once for
 * land ahead, and once per drying shoal ahead. A second, urgent warning
 * fires when something is under ~120 yards and nearly dead ahead.
 */
final class Lookout {
    static final class Alert {
        final String text; final boolean urgent;
        Alert(String text, boolean urgent) { this.text = text; this.urgent = urgent; }
    }

    static final double MIN_SOG_KN = 1.0;     // below this the course is noise; no look-ahead
    static final double CORRIDOR_NM = 0.1;
    static final double URGENT_NM = 0.06;     // ~120 yards
    static final double MAX_LOOK_NM = 1.5;    // six minutes at 15 kn
    static final double FORGET_NM = MAX_LOOK_NM + 0.5;   // a hazard can be announced again once this far off,
    static final double PASSED_NM = 0.15;     // ...or once it is behind us and this far off (tacking back toward it)
    static final long SHOAL_GAP_MS = 60_000, SHOAL_URGENT_GAP_MS = 30_000;   // adjoining shoal outlines: one warning
    static final long SHOAL_FORGET_MS = 60_000;

    private final ChartData c;
    private final Set<Integer> hazSaid = new HashSet<>(), hazUrgentSaid = new HashSet<>();
    private final Map<Integer, Long> shoalSeen = new HashMap<>();   // shoal -> last time it was ahead/under us
    private final Set<Integer> shoalUrgentSaid = new HashSet<>();
    private boolean landSaid, landUrgentSaid;
    private long landSeenAt = -1_000_000;
    private long shoalSaidAt = -1_000_000, shoalUrgentAt = -1_000_000;

    // local flat frame around the current fix, nautical miles (x east, y north)
    private double lat0, lon0, kx;

    Lookout(ChartData c) { this.c = c; }

    boolean covers(double lat, double lon) { return c.covers(lat, lon); }

    private void frame(double lat, double lon) {
        lat0 = lat; lon0 = lon; kx = 60 * Math.cos(Math.toRadians(lat));
    }
    private double x(int lonMicro) { return (lonMicro / 1e6 - lon0) * kx; }
    private double y(int latMicro) { return (latMicro / 1e6 - lat0) * 60; }

    /** One GPS fix in; zero or more things to say out. cogDeg is true course over ground. */
    List<Alert> update(double lat, double lon, double cogDeg, double sogKn, long nowMs) {
        List<Alert> out = new ArrayList<>();
        frame(lat, lon);
        if (Double.isNaN(cogDeg) || sogKn < MIN_SOG_KN) { forgetHazards(Double.NaN); return out; }
        forgetHazards(cogDeg);

        double L = Math.min(MAX_LOOK_NM, Math.max(0.25, sogKn * 0.1));   // six minutes' sailing
        double h = Math.toRadians(cogDeg), sh = Math.sin(h), ch = Math.cos(h);
        double ex = L * sh, ey = L * ch;

        // ---- land ahead (skipped if the fix itself is ashore: alongside a dock, or a GPS glitch)
        if (insideIndex(c.land) < 0) {
            double[] hit = rayHit(c.land, ex, ey);
            if (hit == null) {
                // forget only after a minute clear: speed wobble makes the look-ahead edge flicker
                if (nowMs - landSeenAt > SHOAL_FORGET_MS) { landSaid = false; landUrgentSaid = false; }
            } else {
                landSeenAt = nowMs;
                double d = hit[0] * L;
                if (d < URGENT_NM && !landUrgentSaid) {
                    landUrgentSaid = landSaid = true;
                    out.add(new Alert("Land dead ahead, " + Words.distance(d) + "!", true));
                } else if (!landSaid) {
                    landSaid = true;
                    out.add(new Alert("Land ahead, " + Words.distance(d) + ".", false));
                }
            }
        }

        // ---- rocks, obstructions, wrecks within the corridor
        List<double[]> fresh = new ArrayList<>();             // {index, along, cross}
        double reach = L + CORRIDOR_NM;
        for (int i = 0; i < c.hLon.length; i++) {
            double hx = x(c.hLon[i]), hy = y(c.hLat[i]);
            if (Math.abs(hx) > reach || Math.abs(hy) > reach) continue;
            double along = hx * sh + hy * ch, cross = hx * ch - hy * sh;
            if (along < -0.01 || along > L || Math.abs(cross) > CORRIDOR_NM) continue;
            double d = Math.hypot(hx, hy);
            double rel = Words.relBearing(Math.toDegrees(Math.atan2(hx, hy)), cogDeg);
            if (d < URGENT_NM && Math.abs(rel) < 25 && !hazUrgentSaid.contains(i)) {
                hazUrgentSaid.add(i); hazSaid.add(i);
                out.add(new Alert(hazardName(i) + ", " + Words.side(rel) + ", " + Words.distance(d) + "!", true));
                continue;
            }
            if (!hazSaid.contains(i)) fresh.add(new double[]{i, along, rel, d});
        }
        if (!fresh.isEmpty()) {
            fresh.sort((a, b) -> Double.compare(a[1], b[1]));
            double[] f = fresh.get(0);
            for (double[] g : fresh) hazSaid.add((int) g[0]);
            int i = (int) f[0];
            String more = fresh.size() > 1 ? " " + (fresh.size() - 1) + " more beyond." : "";
            out.add(new Alert(hazardName(i) + ", " + Words.distance(f[3]) + ", " + Words.side(f[2]) + "." + more, false));
        }

        // ---- drying / very shallow shoals: under us, or crossed by the course line
        int under = insideIndex(c.shoals);
        if (under >= 0) {
            boolean known = shoalSeen.containsKey(under);
            shoalSeen.put(under, nowMs);
            if (!known && nowMs - shoalSaidAt > SHOAL_GAP_MS) {
                shoalSaidAt = nowMs;
                out.add(new Alert("Over a charted " + shoalWords(under) + ".", false));
            }
        } else {
            double[] hit = rayHit(c.shoals, ex, ey);
            if (hit != null) {
                int p = (int) hit[1];
                double d = hit[0] * L;
                boolean known = shoalSeen.containsKey(p);
                shoalSeen.put(p, nowMs);
                if (d < URGENT_NM && !shoalUrgentSaid.contains(p) && nowMs - shoalUrgentAt > SHOAL_URGENT_GAP_MS) {
                    shoalUrgentSaid.add(p);
                    shoalUrgentAt = shoalSaidAt = nowMs;
                    out.add(new Alert(cap(shoalWords(p)) + " dead ahead, " + Words.distance(d) + "!", true));
                } else if (!known && nowMs - shoalSaidAt > SHOAL_GAP_MS) {
                    shoalSaidAt = nowMs;
                    out.add(new Alert(cap(shoalWords(p)) + " ahead, " + Words.distance(d) + ".", false));
                }
            }
        }
        for (Iterator<Map.Entry<Integer, Long>> it = shoalSeen.entrySet().iterator(); it.hasNext(); ) {
            Map.Entry<Integer, Long> e = it.next();
            if (nowMs - e.getValue() > SHOAL_FORGET_MS) { it.remove(); shoalUrgentSaid.remove(e.getKey()); }
        }
        return out;
    }

    private void forgetHazards(double cogDeg) {
        double sh = Math.sin(Math.toRadians(cogDeg)), ch = Math.cos(Math.toRadians(cogDeg));
        for (Iterator<Integer> it = hazSaid.iterator(); it.hasNext(); ) {
            int i = it.next();
            double hx = x(c.hLon[i]), hy = y(c.hLat[i]), d = Math.hypot(hx, hy);
            boolean behind = !Double.isNaN(cogDeg) && hx * sh + hy * ch < -0.05 && d > PASSED_NM;
            if (d > FORGET_NM || behind) { it.remove(); hazUrgentSaid.remove(i); }
        }
    }

    /** "Where am I": nearest named place, nearest charted hazard. */
    String whereAmI(double lat, double lon) {
        frame(lat, lon);
        int best = -1; double bd = 1e9;
        for (int i = 0; i < c.pLon.length; i++) {
            double d = Math.hypot(x(c.pLon[i]), y(c.pLat[i]));
            if (d < bd) { bd = d; best = i; }
        }
        StringBuilder s = new StringBuilder();
        if (best >= 0) {
            if (bd < 0.05) s.append("At ").append(c.pName[best]).append(". ");
            else {
                double fromPlace = Math.toDegrees(Math.atan2(-x(c.pLon[best]), -y(c.pLat[best])));
                s.append(cap(Words.distance(bd))).append(' ').append(Words.compass(fromPlace))
                 .append(" of ").append(c.pName[best]).append(". ");
            }
        }
        int hz = -1; double hd = 1e9;
        for (int i = 0; i < c.hLon.length; i++) {
            double d = Math.hypot(x(c.hLon[i]), y(c.hLat[i]));
            if (d < hd) { hd = d; hz = i; }
        }
        if (hz >= 0 && hd < 1.0) {
            double brg = Math.toDegrees(Math.atan2(x(c.hLon[hz]), y(c.hLat[hz])));
            s.append("Nearest charted hazard: ").append(lower(hazardName(hz))).append(", ")
             .append(Words.distance(hd)).append(" to the ").append(Words.compass(brg)).append('.');
        } else s.append("No charted hazards within a mile.");
        return s.toString();
    }

    // ---------------------------------------------------------------- names

    String hazardName(int i) {
        String what;
        switch (c.hKind[i]) {
            case ChartData.ROCK:
                switch (c.hWatlev[i]) {
                    case 3: what = "Submerged rock"; break;
                    case 4: what = "Drying rock"; break;
                    case 5: what = "Rock awash"; break;
                    default: what = "Rock";
                }
                break;
            case ChartData.WRECK: what = "Wreck"; break;
            default: what = "Obstruction";
        }
        return c.hName[i].isEmpty() ? what : what + ", " + c.hName[i];
    }

    private String shoalWords(int p) {
        int dm = c.shoalDepthDm[p];
        if (dm <= 0) return "drying shoal";
        long ft = Math.round(dm / 10.0 * 3.28084);
        return "shoal, " + ft + (ft == 1 ? " foot" : " feet") + " at low water";
    }

    private static String lower(String s) { return s.isEmpty() ? s : Character.toLowerCase(s.charAt(0)) + s.substring(1); }

    private static String cap(String s) { return s.isEmpty() ? s : Character.toUpperCase(s.charAt(0)) + s.substring(1); }

    // ---------------------------------------------------------------- geometry

    /** Nearest crossing of the ray (0,0)->(ex,ey) with any polygon edge: {t in [0,1], polygon} or null. */
    private double[] rayHit(ChartData.Polys P, double ex, double ey) {
        // ray bounding box in micro-degrees, for the cheap reject
        double lonA = lon0, lonB = lon0 + ex / kx, latA = lat0, latB = lat0 + ey / 60;
        int bx0 = (int) (Math.min(lonA, lonB) * 1e6) - 1, bx1 = (int) (Math.max(lonA, lonB) * 1e6) + 1;
        int by0 = (int) (Math.min(latA, latB) * 1e6) - 1, by1 = (int) (Math.max(latA, latB) * 1e6) + 1;
        double bestT = 2; int bestP = -1;
        for (int p = 0; p < P.rings.length; p++) {
            if (P.maxLon[p] < bx0 || P.minLon[p] > bx1 || P.maxLat[p] < by0 || P.minLat[p] > by1) continue;
            for (int[] r : P.rings[p]) {
                int n = r.length / 2;
                double px = x(r[0]), py = y(r[1]);
                for (int k = 1; k < n; k++) {
                    double qx = x(r[2 * k]), qy = y(r[2 * k + 1]);
                    double t = segT(ex, ey, px, py, qx, qy);
                    if (t >= 0 && t < bestT) { bestT = t; bestP = p; }
                    px = qx; py = qy;
                }
            }
        }
        return bestP < 0 ? null : new double[]{bestT, bestP};
    }

    /** Where along O->E (0..1) the segment P->Q crosses it, or -1. */
    private static double segT(double ex, double ey, double px, double py, double qx, double qy) {
        double sx = qx - px, sy = qy - py;
        double den = ex * sy - ey * sx;
        if (Math.abs(den) < 1e-15) return -1;
        double t = (px * sy - py * sx) / den;     // along the ray
        double u = (px * ey - py * ex) / den;     // along the edge
        return (t >= 0 && t <= 1 && u >= 0 && u <= 1) ? t : -1;
    }

    /** The polygon the current fix (frame origin) lies in, or -1. Even-odd over all rings, so holes count. */
    private int insideIndex(ChartData.Polys P) {
        int X = (int) Math.round(lon0 * 1e6), Y = (int) Math.round(lat0 * 1e6);
        for (int p = 0; p < P.rings.length; p++) {
            if (X < P.minLon[p] || X > P.maxLon[p] || Y < P.minLat[p] || Y > P.maxLat[p]) continue;
            boolean in = false;
            for (int[] r : P.rings[p]) {
                int n = r.length / 2;
                for (int k = 0, j = n - 1; k < n; j = k++) {
                    long xi = r[2 * k], yi = r[2 * k + 1], xj = r[2 * j], yj = r[2 * j + 1];
                    if ((yi > Y) != (yj > Y) && X < (double) (xj - xi) * (Y - yi) / (yj - yi) + xi) in = !in;
                }
            }
            if (in) return p;
        }
        return -1;
    }
}
