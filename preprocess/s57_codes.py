"""S-57 object class and attribute constants for nautical chart parsing."""

# Hazard object class names (fiona exposes these as layer names)
HAZARD_LAYERS = ['UWTROC', 'OBSTRN', 'WRECKS']

# Depth area — included only when shallow
DEPTH_LAYER = 'DEPARE'
SHALLOW_DEPTH_THRESHOLD_M = 5.4864  # 18 feet

# Named place layers
NAMED_PLACE_LAYERS = ['SEAARE', 'LNDRGN', 'HRBARE', 'ACHARE', 'FAIRWY', 'LNDARE', 'BUAARE']

# Navigation aid layers
NAVAID_LAYERS = ['BOYLAT', 'BOYSAW', 'BCNLAT', 'LIGHTS']

# WATLEV values that indicate a submerged/hazardous feature
# 1=part of seabed, 2=covers/uncovers, 4=always underwater, 7=submerged at MHWS
HAZARDOUS_WATLEV = {1, 2, 4, 7}

# Human-readable descriptions for object types
OBJTYPE_LABEL = {
    'UWTROC': 'underwater rock',
    'OBSTRN': 'obstruction',
    'WRECKS': 'wreck',
    'DEPARE': 'shallow area',
    'SEAARE': 'sea area',
    'LNDRGN': 'coastal feature',
    'HRBARE': 'harbor',
    'ACHARE': 'anchorage',
    'FAIRWY': 'channel',
    'LNDARE': 'island',
    'BUAARE': 'town',
    'BOYLAT': 'buoy',
    'BOYSAW': 'buoy',
    'BCNLAT': 'beacon',
    'LIGHTS': 'light',
}

# COLOUR attribute values → color name
COLOUR_LABEL = {
    1: 'white', 2: 'black', 3: 'red', 4: 'green', 5: 'blue',
    6: 'yellow', 7: 'grey', 8: 'brown', 9: 'amber', 10: 'violet',
    11: 'orange', 12: 'magenta', 13: 'pink',
}
