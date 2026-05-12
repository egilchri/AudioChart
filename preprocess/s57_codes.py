"""S-57 object class and attribute constants for nautical chart parsing."""

# Hazard object class names (fiona exposes these as layer names)
HAZARD_LAYERS = ['UWTROC', 'OBSTRN', 'WRECKS', 'CBLOHD']

# Depth area — included only when shallow
DEPTH_LAYER = 'DEPARE'
SHALLOW_DEPTH_THRESHOLD_M = 5.4864  # 18 feet

# Named place layers
NAMED_PLACE_LAYERS = ['SEAARE', 'LNDRGN', 'HRBARE', 'ACHARE', 'FAIRWY', 'LNDARE', 'BUAARE']

# Navigation aid layers
NAVAID_LAYERS = ['BOYLAT', 'BOYSAW', 'BCNLAT', 'LIGHTS']

# Restricted area layer
RESTRICTION_LAYERS = ['RESARE']

# CATREA (category of restricted area) → human label
CATREA_LABEL = {
    1: 'anchor prohibited', 2: 'fishing prohibited', 4: 'entry prohibited',
    5: 'entry restricted', 6: 'no-wake zone', 7: 'TSS',
    9: 'nature reserve', 12: 'swimming prohibited',
    14: 'research area', 24: 'marine sanctuary',
    26: 'historic wreck', 27: 'speed restricted',
}

# LITCHR (light character) → abbreviation
LITCHR_ABBR = {
    1: 'F', 2: 'Fl', 3: 'LFl', 4: 'Q', 5: 'VQ', 6: 'UQ',
    7: 'Iso', 8: 'Oc', 9: 'IQ', 10: 'IVQ', 11: 'IUQ',
    12: 'Mo', 20: 'Al.Fl', 28: 'Q+LFl', 29: 'VQ+LFl',
}

# COLOUR codes → abbreviation used in light characteristics
LIGHT_COLOUR_ABBR = {
    1: 'W', 2: 'Bu', 3: 'R', 4: 'G', 5: 'Bu', 6: 'Y', 11: 'Or',
}

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
    'CBLOHD': 'overhead cable',
    'RESARE': 'restricted area',
}

# COLOUR attribute values → color name
COLOUR_LABEL = {
    1: 'white', 2: 'black', 3: 'red', 4: 'green', 5: 'blue',
    6: 'yellow', 7: 'grey', 8: 'brown', 9: 'amber', 10: 'violet',
    11: 'orange', 12: 'magenta', 13: 'pink',
}
