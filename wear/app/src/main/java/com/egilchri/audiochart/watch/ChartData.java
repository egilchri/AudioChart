package com.egilchri.audiochart.watch;

import java.io.BufferedInputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.io.InputStream;

/**
 * One region's chart data, as packed by design/watch/build_watch_data.py.
 * Coordinates are int micro-degrees. Polygons keep a bounding box so most
 * are rejected without touching their points.
 */
final class ChartData {
    static final byte ROCK = 1, OBSTRUCTION = 2, WRECK = 3;

    /** A polygon set: rings[p] holds polygon p's rings, each {lon0, lat0, lon1, lat1, ...}. */
    static final class Polys {
        int[][][] rings;
        int[] minLon, minLat, maxLon, maxLat;
    }

    int minLon, minLat, maxLon, maxLat;          // chart coverage

    int[] hLon, hLat;
    byte[] hKind, hWatlev;
    String[] hName;

    Polys land, shoals;
    short[] shoalDepthDm;                        // least charted depth, decimetres (negative = dries)

    int[] pLon, pLat;
    String[] pName;

    static ChartData load(InputStream raw) throws IOException {
        DataInputStream in = new DataInputStream(new BufferedInputStream(raw, 1 << 16));
        byte[] magic = new byte[4];
        in.readFully(magic);
        if (magic[0] != 'A' || magic[1] != 'C' || magic[2] != 'W' || magic[3] != '1')
            throw new IOException("not a watch chart file");
        in.readInt();                            // version
        ChartData c = new ChartData();
        c.minLon = in.readInt(); c.minLat = in.readInt(); c.maxLon = in.readInt(); c.maxLat = in.readInt();

        int n = in.readInt();
        c.hLon = new int[n]; c.hLat = new int[n]; c.hKind = new byte[n]; c.hWatlev = new byte[n]; c.hName = new String[n];
        for (int i = 0; i < n; i++) {
            c.hLon[i] = in.readInt(); c.hLat[i] = in.readInt();
            c.hKind[i] = in.readByte(); c.hWatlev[i] = in.readByte();
            c.hName[i] = in.readUTF();
        }
        c.land = readPolys(in);
        c.shoals = readPolys(in);
        c.shoalDepthDm = new short[c.shoals.rings.length];
        for (int i = 0; i < c.shoalDepthDm.length; i++) c.shoalDepthDm[i] = in.readShort();

        n = in.readInt();
        c.pLon = new int[n]; c.pLat = new int[n]; c.pName = new String[n];
        for (int i = 0; i < n; i++) { c.pLon[i] = in.readInt(); c.pLat[i] = in.readInt(); c.pName[i] = in.readUTF(); }
        in.close();
        return c;
    }

    private static Polys readPolys(DataInputStream in) throws IOException {
        Polys p = new Polys();
        int n = in.readInt();
        p.rings = new int[n][][];
        p.minLon = new int[n]; p.minLat = new int[n]; p.maxLon = new int[n]; p.maxLat = new int[n];
        for (int i = 0; i < n; i++) {
            int nr = in.readInt();
            p.rings[i] = new int[nr][];
            int x0 = Integer.MAX_VALUE, y0 = Integer.MAX_VALUE, x1 = Integer.MIN_VALUE, y1 = Integer.MIN_VALUE;
            for (int r = 0; r < nr; r++) {
                int np = in.readInt();
                int[] pts = new int[np * 2];
                for (int k = 0; k < np; k++) {
                    int x = in.readInt(), y = in.readInt();
                    pts[2 * k] = x; pts[2 * k + 1] = y;
                    if (x < x0) x0 = x; if (x > x1) x1 = x;
                    if (y < y0) y0 = y; if (y > y1) y1 = y;
                }
                p.rings[i][r] = pts;
            }
            p.minLon[i] = x0; p.minLat[i] = y0; p.maxLon[i] = x1; p.maxLat[i] = y1;
        }
        return p;
    }

    boolean covers(double lat, double lon) {
        int x = (int) Math.round(lon * 1e6), y = (int) Math.round(lat * 1e6);
        return x >= minLon && x <= maxLon && y >= minLat && y <= maxLat;
    }
}
