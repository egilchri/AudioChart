# Fox Islands Thorofare 3D (desktop WebGL sample)

Live: https://claude.ai/artifact/R6Ar3gqPFnJmRWkpqThs9J

three.js 0.160 (jsDelivr) scene: USGS 3DEP elevation (10 m near the Thorofare, 30 m beyond),
NAIP aerial photos draped on it, ~127k instanced spruce placed where the photo shows forest
within 1.5 km of the route, three's Water (reflectance tuned to 2%) and Sky, chart buoys/lights
from AudioChart data (scene.json). ~28 ms/frame on an M3 at 1.5× pixel ratio.

The data files are not committed (≈12 MB, regenerable):

    B=https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation
    gdal_translate -projwin -68.975 44.165 -68.765 44.075 /vsicurl/$B/13/TIFF/current/n45w069/USGS_13_n45w069.tif near.tif
    # far: the 30 m clip from ../README.md (lookout_view_usgs)
    # both → Float32 ENVI → int16 decimetres (water ≤0.4 m → -3 m), gzip, base64 → dem_near.b64.txt / dem_far.b64.txt
    S="https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage?bboxSR=4326&imageSR=4326&format=jpg&compressionQuality=82&f=image"
    # near_0..3.jpg: 2×2 tiles of bbox -68.975,44.075,-68.765,44.165 at size=4000,2400 (row-major, north row first)
    # far.jpg: bbox -69.16,43.98,-68.62,44.28 at size=4000,3086
