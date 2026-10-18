"""Location classifier built on locations.json (country/city taxonomy + visa routes).

classify("Berlin, Germany | Remote - US") -> {"cls": "europe", "countries": ["Germany"], "visa_route": "EU Blue Card ..."}

Classes, best first: india, singapore, uae, europe, other_ok, remote_global, regional, us_optional,
placeholder, other_region, excluded, unclassified. Rules (see locations.json "special_rules"):
- the string is split into segments (| ; newline " / ") and each is classified; the best class wins
- an explicit US signal (US/USA, state code, state name, a US city) suppresses city-level matches in that segment
- ISO codes only count at the end of a segment (", GBR"); 2-letter codes only from a safe whitelist
- ambiguous names (Paris, Dublin, Cambridge, ...) count only with no US signal
- 'Remote' alone is remote_global; 'Remote - US' is us_optional, never remote_global
"""
import json
import re
import unicodedata
from pathlib import Path

_L = json.loads((Path(__file__).parent / "locations.json").read_text())


def _fold(s):
    return unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()


AMBIGUOUS = {"paris", "valencia", "birmingham", "cambridge", "manchester", "dublin", "vienna", "athens", "naples", "rome", "milan",
             "london", "melbourne", "perth", "oxford", "bristol", "belfast", "glasgow", "newcastle", "vancouver", "portland",
             "columbus", "santiago", "victoria"}
NEVER_FREE = {"york", "salem", "kota", "derby", "warwick", "georgia", "america", "nice", "bath", "reading", "split", "kl", "blr", "bgc",
              "sa", "au", "nl", "sg", "hk", "nz", "roc", "us", "gb", "est", "it", "be", "at", "is", "in", "de", "no", "or"}
ISO2_TRAILING = set("gb nl fr ie ch se dk pl pt es sg ae jp kr hk tw nz au br mx".split())
REGION = {  # region words -> class
    "europe": ["emea", "europe", "european", "eu", "eea", "dach", "nordics", "benelux", "scandinavia", "cee", "eastern europe"],
    "uae": ["middle east", "mena", "gcc", "gulf"],
    "regional": ["apac", "apj", "asia pacific", "asia", "south asia", "southeast asia"],
    "other_region": ["north america", "namer", "americas", "latam", "latin america", "amer"],
}
EXTRA_COUNTRY = {"holland": "Netherlands", "czechia": "Czech Republic", "czech": "Czech Republic", "uk": "United Kingdom", "u.k.": "United Kingdom"}
EXCLUDED_TOKENS = ["russia", "belarus", "ukraine", "iran", "iraq", "syria", "afghanistan", "yemen", "libya", "sudan", "somalia", "north korea",
                   "myanmar", "venezuela", "cuba", "lebanon", "cambodia", "laos", "nigeria", "pakistan", "bangladesh", "egypt", "ethiopia",
                   "kenya", "ghana", "israel", "tel aviv", "turkey", "turkiye", "istanbul", "china", "beijing", "shanghai", "shenzhen",
                   "moscow", "kyiv", "tehran", "karachi", "lahore", "islamabad", "dhaka", "cairo", "lagos", "nairobi"]
US_STATES = ("alabama alaska arizona arkansas california colorado connecticut delaware florida hawaii idaho illinois iowa kansas kentucky "
             "louisiana maine maryland massachusetts michigan minnesota mississippi missouri montana nebraska nevada new hampshire new jersey "
             "new mexico new york north carolina north dakota ohio oklahoma oregon pennsylvania rhode island south carolina south dakota "
             "tennessee texas utah vermont virginia washington west virginia wisconsin wyoming").split()
US_STATE_CODES = ("AL AK AZ AR CA CO CT DC FL GA HI ID IL IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD "
                  "TN TX UT VT VA WA WV WI WY").split()
INDIANA = re.compile(r"indianapolis|fort wayne|west lafayette|bloomington|evansville|carmel|south bend", re.I)


def _rx(tokens):
    toks = sorted({re.escape(t) for t in tokens if t}, key=len, reverse=True)
    return re.compile(r"(?<![a-z0-9])(" + "|".join(toks) + r")(?![a-z0-9])") if toks else None


# ---- token tables built once from locations.json
_TRACK_OF = {"india": "india", "singapore": "singapore", "uae": "uae", "europe": "europe", "other_ok": "other_ok"}
_country_of, _meta, _country_tok, _city_tok = {}, {}, {t: set() for t in _TRACK_OF}, {t: set() for t in _TRACK_OF}
_iso3, _iso2 = {}, {}
for _name, _c in _L["countries"].items():
    _tr = _c.get("track")
    if _tr not in _TRACK_OF:
        continue
    _meta[_name] = _c
    for _a in [_name] + _c.get("aliases", []):
        _country_tok[_tr].add(_fold(_a))
        _country_of[_fold(_a)] = _name
    for _city in _c.get("cities", []):
        _city_tok[_tr].add(_fold(_city))
        _country_of.setdefault(_fold(_city), _name)
    if _c.get("iso3"):
        _iso3[_c["iso3"].lower()] = (_tr, _name)
    if _c.get("iso2") and _c["iso2"].lower() in ISO2_TRAILING:
        _iso2[_c["iso2"].lower()] = (_tr, _name)
for _w, _n in EXTRA_COUNTRY.items():
    if _n in _meta:
        _country_tok[_meta[_n]["track"]].add(_w)
        _country_of[_w] = _n
_region_words = {w for ws in REGION.values() for w in ws}
for _tr, _tokens in _L["tracks"].items():  # extra locality tokens (suburbs, states...) that aren't in countries
    if _tr in _TRACK_OF:
        for _t in _tokens:
            _f = _fold(_t)
            if _f not in _country_tok[_tr] and _f not in _iso3 and _f not in NEVER_FREE and _f not in _region_words and len(_f) > 2:
                _city_tok[_tr].add(_f)
for _tr in _TRACK_OF:
    _city_tok[_tr] -= _country_tok[_tr]
    _city_tok[_tr] -= {t for t in _city_tok[_tr] if t in _iso3 or t in NEVER_FREE or t in _region_words}
    for _t in list(_city_tok[_tr]):  # ISO-3 codes the agent listed as tokens must not match as free words
        if len(_t) == 3 and _t in _iso3:
            _city_tok[_tr].discard(_t)
    _country_tok[_tr] -= {t for t in _country_tok[_tr] if t in NEVER_FREE or t in _iso3}
COUNTRY_RX = {t: _rx(s) for t, s in _country_tok.items()}
CITY_RX = {t: _rx(s) for t, s in _city_tok.items()}
REGION_RX = {c: _rx(ws) for c, ws in REGION.items()}
EXC_RX = _rx(EXCLUDED_TOKENS)
US_CITY_RX = _rx({_fold(t) for t in _L["tracks"].get("us_optional", [])} - AMBIGUOUS - NEVER_FREE)
US_NAME_RX = _rx([s for s in US_STATES if s not in ("washington", "virginia", "georgia")] + ["bay area", "washington dc", "washington d.c.", "silicon valley"])
US_SIG = re.compile(r"\bU\.S\.|\bUSA\b|\bUS\b|United States")
US_CODE = re.compile(r"(?:[,\-–(]\s*|\s)(?:%s)\b(?!\w)" % "|".join(US_STATE_CODES))
REMOTE_US = re.compile(r"remote\W+(?:us|usa|u\.s\.?|united states)\b|\b(?:us|usa) only\b", re.I)
REMOTE_RX = re.compile(r"(?<![a-z])(remote|worldwide|anywhere|global|distributed|work from home|wfh)(?![a-z])")
PLACEHOLDER = re.compile(r"\bhybrid\b|in-office|\bon-?site\b|multiple locations|\b\d+ locations\b|\bvarious\b")
PRIORITY = ["india", "singapore", "uae", "europe", "other_ok", "remote_global", "regional", "us_optional", "placeholder", "other_region", "excluded"]
TARGETS = {"india", "singapore", "uae", "europe", "other_ok"}


US_DC = re.compile(r"washington,?\s*d\.?c\b", re.I)


def _us_signal(seg, low):
    return bool(US_DC.search(seg) or INDIANA.search(seg) or US_SIG.search(seg) or REMOTE_US.search(seg) or US_NAME_RX.search(low) or US_CITY_RX.search(low) or US_CODE.search(seg))


def classify(location):
    raw = location or ""
    if not raw.strip():
        return {"cls": "placeholder", "countries": [], "visa_route": ""}
    found, countries = set(), []

    def add(cls, tok=None, country=None):
        found.add(cls)
        c = country or (_country_of.get(tok) if tok else None)
        if c and c not in countries and _meta.get(c, {}).get("track") == cls:
            countries.append(c)

    for seg in (s for s in re.split(r"\||;|\n| / ", raw) if s.strip()):
        low = _fold(seg)
        us = _us_signal(seg, low)
        hit, other_region = False, False
        for cls, rx in COUNTRY_RX.items():
            if rx:
                for m in rx.finditer(low):
                    add(cls, m.group(1)); hit = True
        for cls, rx in REGION_RX.items():
            if rx and rx.search(low):
                found.add(cls); hit = hit or cls in TARGETS; other_region = other_region or cls == "other_region"
        if not us:
            for cls, rx in CITY_RX.items():
                if rx:
                    for m in rx.finditer(low):
                        add(cls, m.group(1)); hit = True
            m = re.search(r"[,\-–|/]\s*([a-z]{2,3})\s*$", low)  # trailing ISO code
            if m:
                code = m.group(1)
                tr = _iso3.get(code) or (_iso2.get(code) if len(code) == 2 else None)
                if tr:
                    add(tr[0], country=tr[1]); hit = True
            if re.search(r",\s*IN\s*$", seg) and not INDIANA.search(seg):
                add("india", country="India"); hit = True
        if EXC_RX and EXC_RX.search(low):
            found.add("excluded")
        if us and not hit:
            found.add("us_optional")
        if PLACEHOLDER.search(low):
            found.add("placeholder")
        if not us and not hit and not other_region and REMOTE_RX.search(low):
            found.add("remote_global")
    if "excluded" in found and not (found & TARGETS):
        found -= {"remote_global", "regional"}
    best = next((c for c in PRIORITY if c in found), "unclassified")
    if best == "remote_global" and "us_optional" in found and len(found - {"remote_global", "us_optional", "placeholder"}) == 0 and REMOTE_US.search(raw):
        best = "us_optional"
    c0 = next((c for c in countries if _meta[c]["track"] == best), None)
    return {"cls": best, "countries": countries, "visa_route": _meta[c0]["visa_route"] if c0 else ""}
