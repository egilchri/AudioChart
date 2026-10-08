# Lookout view samples

- `lookout_view_sample.html`: chart-data only (land heights guessed from island size).
  https://claude.ai/artifact/N1hoquQg929mt9snYDSm7C
- `lookout_view_usgs.html`: land from USGS 3DEP 1 arc-second elevation.
  https://claude.ai/artifact/EgA8PW2CoQJHfaQAsTXFSE

Rebuild: `extract_lookout_data.py` writes data.json (chart data clipped around Route 434's
first 17 points). The elevation clip was made with GDAL straight from USGS's cloud-optimized tiles:

    B=https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/1/TIFF/current
    gdalbuildvrt bay.vrt /vsicurl/$B/n45w070/USGS_1_n45w070.tif /vsicurl/$B/n45w069/USGS_1_n45w069.tif
    gdal_translate -projwin -69.16 44.28 -68.62 43.98 bay.vrt clip.tif
    gdal_translate -of ENVI -ot Float32 clip.tif dem.bin

then encoded as uint8 (sqrt(h) × 12.4, 0 = water), gzipped and base64'd into the page
(0.4 MB for 1944×1080 cells). `build_usgs_page.py` turns the template into the USGS page.
