#!/usr/bin/env python3
"""Job Hunter core: collect -> filter -> score -> store -> notify.

    python3 hunter.py              # one poll, send Telegram alerts for new matches
    python3 hunter.py --dry-run    # poll and print, but don't save or send
    python3 hunter.py --force      # ignore per-source minimum fetch intervals

Data lives in ./data (jobs.json, status.json, tracker.json). First fetch of each
source is a silent "baseline" so you only get pinged for jobs that appear after.
Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, optional ADZUNA_APP_ID / ADZUNA_APP_KEY.
"""
import csv, email, email.utils, hashlib, html, http.client, imaplib, json, os, re, subprocess, sys, threading, time, urllib.parse, urllib.request
from html.parser import HTMLParser

import locations
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

CFG, RULES = {}, None  # set at the start of run(); collectors read them
ROOT = Path(__file__).parent
DATA = ROOT / "data"
LOCK = threading.Lock()
UA = "Mozilla/5.0 (personal job-search script)"


def load_dotenv():
    """Read KEY=VALUE lines from .env (git-ignored) without overriding real environment variables."""
    p = ROOT / ".env"
    if p.exists():
        for line in p.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                if v.strip():
                    os.environ.setdefault(k.strip(), v.strip().strip("\"'"))


load_dotenv()


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def load(path, default):
    try:
        return json.loads(Path(path).read_text())
    except Exception:
        return default


def save(path, obj):
    tmp = Path(str(path) + ".tmp")
    tmp.write_text(json.dumps(obj, indent=1))
    tmp.replace(path)


def fetch(url, body=None, tries=3, raw=False, headers=()):
    """GET (or POST a JSON string body) and decode JSON. Prefers curl (robust with big/proxied responses), falls back to urllib."""
    last = None
    for i in range(tries):
        try:
            cmd = ["curl", "-sSf", "--compressed", "-m", "60", "-A", UA, url] + [x for h in headers for x in ("-H", h)] + \
                  (["-H", "Content-Type: application/json", "--data", body] if body else [])
            out = subprocess.run(cmd, capture_output=True, check=True, timeout=75).stdout
            return out.decode("utf-8", "replace") if raw else json.loads(out)
        except FileNotFoundError:
            try:
                req = urllib.request.Request(url, data=body.encode() if body else None,
                                             headers={"User-Agent": UA, **({"Content-Type": "application/json"} if body else {})})
                with urllib.request.urlopen(req, timeout=40) as r:
                    return json.loads(r.read())
            except (http.client.IncompleteRead, OSError, ValueError) as e:
                last = e
        except subprocess.CalledProcessError as e:
            last = RuntimeError((e.stderr or b"").decode().strip()[:150] or f"curl exit {e.returncode}")
        except (ValueError, subprocess.TimeoutExpired) as e:
            last = e
        time.sleep(2 * (i + 1))
    raise RuntimeError(f"{type(last).__name__}: {last}")


def strip_html(s):
    s = html.unescape(s or "")
    s = re.sub(r"<(br|/p|/li|/div)[^>]*>", "\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    return re.sub(r"[ \t]+", " ", html.unescape(s)).strip()


def parse_dt(v):
    """Best-effort parse of the many date formats the sources use -> aware UTC datetime, or None."""
    if v in (None, ""):
        return None
    if isinstance(v, (int, float)) or (isinstance(v, str) and v.isdigit()):
        n = float(v)
        return datetime.fromtimestamp(n / 1000 if n > 1e11 else n, timezone.utc)
    s = str(v).strip()
    for fmt in ("%Y-%m-%d %I:%M %p", "%B %d, %Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(s, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def mk(id, company, title, location, url, source, posted=None, desc="", tier=3, kind="agg", meta=None):
    d = parse_dt(posted)
    return {"id": id, "company": company, "title": title.strip(), "location": (location or "").strip(), "url": url,
            "source": source, "posted": d.isoformat(timespec="seconds") if d else None, "desc": desc or "",
            "tier": tier, "kind": kind, "meta": meta or {}}


def age_days(j):
    d = parse_dt(j.get("posted")) or parse_dt(j.get("first_seen"))
    return (datetime.now(timezone.utc) - d).total_seconds() / 86400 if d else 0


# ------------------------------------------------------------------ company career feeds (ATS)
def greenhouse(c):
    d = fetch(f"https://boards-api.greenhouse.io/v1/boards/{c['slug']}/jobs")
    return [mk(f"gh:{c['slug']}:{j['id']}", c["name"], j["title"], (j.get("location") or {}).get("name", ""),
               j["absolute_url"], c["name"], j.get("first_published") or j.get("updated_at"), "", c["tier"], "ats",
               {"gh": [c["slug"], j["id"]]}) for j in d.get("jobs", [])]


def ashby(c):
    d = fetch(f"https://api.ashbyhq.com/posting-api/job-board/{c['slug']}")
    out = []
    for j in d.get("jobs", []):
        if not j.get("isListed", True):
            continue
        locs = [j.get("location") or ""] + [s.get("location", "") for s in (j.get("secondaryLocations") or [])]
        out.append(mk(f"ashby:{c['slug']}:{j['id']}", c["name"], j["title"], " | ".join(l for l in locs if l),
                      j["jobUrl"], c["name"], j.get("publishedAt"), j.get("descriptionPlain", ""), c["tier"], "ats"))
    return out


def lever(c):
    d = fetch(f"https://api.lever.co/v0/postings/{c['slug']}?mode=json")
    out = []
    for j in d:
        cat = j.get("categories") or {}
        ts = j.get("createdAt")
        out.append(mk(f"lever:{c['slug']}:{j['id']}", c["name"], j["text"],
                      " | ".join(cat.get("allLocations") or [cat.get("location", "")]), j["hostedUrl"], c["name"],
                      datetime.fromtimestamp(ts / 1000, timezone.utc).isoformat() if ts else None,
                      j.get("descriptionPlain", ""), c["tier"], "ats"))
    return out


def wd_days(text):
    """Workday's 'Posted 3 Days Ago' -> 3 (None if unparseable, 31 for '30+')."""
    t = (text or "").lower()
    if "today" in t:
        return 0
    if "yesterday" in t:
        return 1
    m = re.search(r"(\d+)(\+)?\s*days?", t)
    return (31 if m.group(2) else int(m.group(1))) if m else None


def workday(c):
    """Workday search is query-based and returns relevance order, so: search a few queries, keep postings
    from the last N days whose title looks right, then fetch each one's detail (exact location, date, text)."""
    base = f"https://{c['tenant']}.wd{c['wd']}.myworkdayjobs.com"
    api = f"{base}/wday/cxs/{c['tenant']}/{c['site']}"
    picked = {}
    for q in CFG["workday_queries"]:
        for off in (0, 20):
            d = fetch(api + "/jobs", json.dumps({"appliedFacets": {}, "limit": 20, "offset": off, "searchText": q}))
            for p in d.get("jobPostings", []):
                days = wd_days(p.get("postedOn"))
                if days is not None and days <= CFG["max_age_days"] and RULES.title_ok(p["title"]):
                    picked[p["externalPath"]] = p
    out = []
    for path, p in picked.items():
        try:
            info = fetch(api + path, tries=2)["jobPostingInfo"]
        except Exception:
            info = {}
        locs = [info.get("location") or p.get("locationsText", "")] + (info.get("additionalLocations") or [])
        country = (info.get("country") or {}).get("descriptor", "")
        out.append(mk(f"wd:{c['tenant']}:{info.get('jobReqId') or path}", c["name"], p["title"],
                      " | ".join(x for x in locs + [country] if x), info.get("externalUrl") or f"{base}/{c['site']}{path}",
                      c["name"], info.get("startDate") or (datetime.now(timezone.utc) - timedelta(days=wd_days(p.get("postedOn")) or 0)).isoformat(),
                      strip_html(info.get("jobDescription")), c["tier"], "ats"))
    return out


def amazon(c):
    out, seen = [], set()
    for q in CFG["amazon_queries"]:
        for loc in CFG["amazon_locations"]:
            qs = urllib.parse.urlencode({"base_query": q, "loc_query": loc, "result_limit": 50, "sort": "recent"})
            for j in fetch("https://www.amazon.jobs/en/search.json?" + qs).get("jobs", []):
                if j["id_icims"] in seen:
                    continue
                seen.add(j["id_icims"])
                out.append(mk(f"amazon:{j['id_icims']}", c["name"], j["title"], j.get("normalized_location") or j.get("location", ""),
                              "https://www.amazon.jobs" + j["job_path"], c["name"], j.get("posted_date"),
                              strip_html((j.get("description") or "") + " " + (j.get("basic_qualifications") or "")), c["tier"], "ats"))
    return out


def netflix(c):
    out, seen = [], set()
    for q in CFG["netflix_queries"]:
        for j in fetch("https://explore.jobs.netflix.net/api/apply/v2/jobs?domain=netflix.com&start=0&num=50&query=" + urllib.parse.quote(q)).get("positions", []):
            if j["id"] in seen:
                continue
            seen.add(j["id"])
            out.append(mk(f"netflix:{j['id']}", c["name"], j["name"], " | ".join(j.get("locations") or [j.get("location", "")]),
                          j.get("canonicalPositionUrl") or f"https://explore.jobs.netflix.net/careers/job/{j['id']}",
                          c["name"], j.get("t_create"), "", c["tier"], "ats"))
    return out


def atlassian(c):
    return [mk(f"atlassian:{j['id']}", c["name"], j["title"], " | ".join(j.get("locations") or []), j["portalJobPost"]["portalUrl"],
               c["name"], j["portalJobPost"].get("updatedDate"), strip_html(j.get("overview")), c["tier"], "ats")
            for j in fetch("https://www.atlassian.com/endpoint/careers/listings")]


def workable(c):
    d = fetch(f"https://apply.workable.com/api/v3/accounts/{c['slug']}/jobs",
              json.dumps({"query": "", "location": [], "department": [], "worktype": [], "remote": []}))
    out = []
    for j in d.get("results", []):
        loc = j.get("location") or {}
        out.append(mk(f"workable:{c['slug']}:{j['shortcode']}", c["name"], j["title"],
                      ", ".join(x for x in [loc.get("city"), loc.get("country")] if x) + (" (remote)" if j.get("remote") else ""),
                      f"https://apply.workable.com/{c['slug']}/j/{j['shortcode']}/", c["name"], j.get("published"), "", c["tier"], "ats"))
    return out


ATS = {"greenhouse": greenhouse, "ashby": ashby, "lever": lever, "workday": workday, "amazon": amazon,
       "netflix": netflix, "atlassian": atlassian, "workable": workable}
PARTIAL = {"workday", "amazon", "netflix"}  # query-based: absence from results doesn't mean the job closed


# ------------------------------------------------------------------ free job-board APIs
def remotive(cfg):
    out, seen = [], set()
    for q in ["ai engineer", "machine learning", "data scientist", "llm"]:
        for j in fetch("https://remotive.com/api/remote-jobs?search=" + urllib.parse.quote(q) + "&limit=60").get("jobs", []):
            if j["id"] in seen:
                continue
            seen.add(j["id"])
            out.append(mk(f"remotive:{j['id']}", j["company_name"], j["title"], j.get("candidate_required_location", ""),
                          j["url"], "Remotive", j.get("publication_date"), strip_html(j.get("description"))))
    return out


def remoteok(cfg):
    d = fetch("https://remoteok.com/api")
    return [mk(f"remoteok:{j['id']}", j.get("company", ""), j.get("position", ""), j.get("location") or "Worldwide",
               j["url"], "RemoteOK", j.get("date"), strip_html(j.get("description"))) for j in d if j.get("id")]


def himalayas(cfg):
    out = []
    for off in range(0, 100, 20):
        d = fetch(f"https://himalayas.app/jobs/api?limit=20&offset={off}")
        for j in d.get("jobs", []):
            ts = j.get("pubDate")
            out.append(mk(f"himalayas:{j['guid']}", j.get("companyName", ""), j["title"],
                          ", ".join(j.get("locationRestrictions") or []) or "Worldwide", j["applicationLink"], "Himalayas",
                          datetime.fromtimestamp(ts, timezone.utc).isoformat() if ts else None,
                          strip_html(j.get("description") or j.get("excerpt"))))
    return out


def arbeitnow(cfg):
    d = fetch("https://www.arbeitnow.com/api/job-board-api")
    return [mk(f"arbeitnow:{j['slug']}", j["company_name"], j["title"], j.get("location", "") + (" (remote)" if j.get("remote") else ""),
               j["url"], "Arbeitnow", datetime.fromtimestamp(j["created_at"], timezone.utc).isoformat(),
               strip_html(j.get("description"))) for j in d.get("data", [])]


def adzuna(cfg):
    app_id, app_key = os.environ.get("ADZUNA_APP_ID"), os.environ.get("ADZUNA_APP_KEY")
    if not (app_id and app_key):
        raise RuntimeError("skipped: set ADZUNA_APP_ID / ADZUNA_APP_KEY (free at developer.adzuna.com)")
    out = []
    for cc in cfg["adzuna_countries"]:
        for q in cfg["adzuna_queries"]:
            qs = urllib.parse.urlencode({"app_id": app_id, "app_key": app_key, "what": q, "results_per_page": 50,
                                         "max_days_old": 7, "sort_by": "date", "content-type": "application/json"})
            for j in fetch(f"https://api.adzuna.com/v1/api/jobs/{cc}/search/1?{qs}").get("results", []):
                out.append(mk(f"adzuna:{j['id']}", (j.get("company") or {}).get("display_name", ""), j["title"],
                              (j.get("location") or {}).get("display_name", "") + f", {cc.upper()}", j["redirect_url"],
                              f"Adzuna-{cc.upper()}", j.get("created"), strip_html(j.get("description"))))
    return out


def hn_hiring(cfg):
    """Latest 'Ask HN: Who is hiring?' thread, comments mentioning AI/ML. Title = first line of the post."""
    hits = fetch("https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=10")["hits"]
    story = next(h for h in hits if "who is hiring" in h["title"].lower())
    out, seen = [], set()
    for q in ["AI engineer", "machine learning", "LLM", "data scientist", "visa"]:
        d = fetch("https://hn.algolia.com/api/v1/search_by_date?tags=comment,story_%s&hitsPerPage=200&query=%s"
                  % (story["objectID"], urllib.parse.quote(q)))
        for h in d["hits"]:
            if h["objectID"] in seen or not h.get("comment_text"):
                continue
            seen.add(h["objectID"])
            first = strip_html(h["comment_text"].split("<p>")[0])
            parts = [p.strip() for p in first.split("|")]
            out.append(mk(f"hn:{h['objectID']}", parts[0][:60], first[:140], first, f"https://news.ycombinator.com/item?id={h['objectID']}",
                          "HN Who's Hiring", h.get("created_at"), strip_html(h["comment_text"])))
    return out


CC = {"PT": "Portugal", "NL": "Netherlands", "DE": "Germany", "FR": "France", "ES": "Spain", "GB": "United Kingdom", "IE": "Ireland",
      "SE": "Sweden", "DK": "Denmark", "FI": "Finland", "BE": "Belgium", "AT": "Austria", "IT": "Italy", "CH": "Switzerland",
      "PL": "Poland", "LU": "Luxembourg", "NO": "Norway", "SG": "Singapore", "AE": "United Arab Emirates", "IN": "India"}


def landing_jobs(cfg):
    """Landing.jobs: European tech jobs, many with relocation/visa support."""
    out = []
    for j in fetch("https://landing.jobs/api/v1/jobs?limit=100"):
        locs = ", ".join(f"{l.get('city', '')}, {CC.get(l.get('country_code'), l.get('country_code', ''))}" for l in j.get("locations") or [])
        text = strip_html((j.get("role_description") or "") + " " + (j.get("main_requirements") or ""))
        if j.get("relocation_paid"):
            text += " Relocation assistance provided."
        out.append(mk(f"landing:{j['id']}", j.get("company_name") or "Landing.jobs", j["title"], locs + (" (remote)" if j.get("remote") else ""),
                      j["url"], "Landing.jobs", j.get("published_at"), text))
    return out


def working_nomads(cfg):
    return [mk(f"wn:{j['url']}", j["company_name"], j["title"], j.get("location") or "Worldwide", j["url"], "Working Nomads",
               j.get("pub_date"), strip_html(j.get("description"))) for j in fetch("https://www.workingnomads.com/api/exposed_jobs/")]


def jobicy(cfg):
    return [mk(f"jobicy:{j['id']}", j["companyName"], j["jobTitle"], j.get("jobGeo") or "Worldwide", j["url"], "Jobicy",
               j.get("pubDate"), strip_html(j.get("jobDescription")))
            for j in fetch("https://jobicy.com/api/v2/remote-jobs?count=100").get("jobs", [])]


# ------------------------------------------------------------------ Indian job boards: aggregator APIs + email alerts
def jooble(cfg):
    key = os.environ.get("JOOBLE_API_KEY")
    if not key:
        raise RuntimeError("skipped: set JOOBLE_API_KEY (free at jooble.org/api/about)")
    out = []
    for loc in cfg["jooble_locations"]:
        for q in cfg["jooble_queries"]:
            d = fetch(f"https://jooble.org/api/{key}", json.dumps({"keywords": q, "location": loc, "page": 1}))
            for j in d.get("jobs", []):
                out.append(mk(f"jooble:{j['id']}", j.get("company", ""), re.sub(r"</?b>", "", j["title"]), j.get("location") or loc, j["link"],
                              "Jooble", j.get("updated"), strip_html(j.get("snippet"))))
    return out


def jsearch(cfg):
    """JSearch (RapidAPI) indexes Google for Jobs: Naukri, Indeed, foundit, LinkedIn, Glassdoor... Free plan is tiny (~200 calls/month)."""
    key = os.environ.get("RAPIDAPI_KEY")
    if not key:
        raise RuntimeError("skipped: set RAPIDAPI_KEY (free JSearch plan at rapidapi.com)")
    out = []
    for q in cfg["jsearch_queries"]:
        qs = urllib.parse.urlencode({"query": q, "page": 1, "num_pages": 1, "date_posted": "week"})
        d = fetch("https://jsearch.p.rapidapi.com/search?" + qs, headers=[f"X-RapidAPI-Key: {key}", "X-RapidAPI-Host: jsearch.p.rapidapi.com"])
        for j in d.get("data", []):
            out.append(mk(f"jsearch:{j['job_id']}", j.get("employer_name", ""), j["job_title"],
                          ", ".join(x for x in [j.get("job_city"), j.get("job_state"), j.get("job_country")] if x) + (" (remote)" if j.get("job_is_remote") else ""),
                          j.get("job_apply_link") or j.get("job_google_link", ""), f"JSearch/{j.get('job_publisher', '?')}",
                          j.get("job_posted_at_datetime_utc"), strip_html(j.get("job_description"))))
    return out


class _Mail(HTMLParser):
    """Flatten an HTML email into a sequence of text runs and links, in order."""
    def __init__(self):
        super().__init__()
        self.seq, self.href, self.buf = [], None, []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            self.href, self.buf = dict(attrs).get("href"), []

    def handle_data(self, data):
        data = " ".join(data.split())
        if data:
            (self.buf if self.href is not None else self.seq).append(data if self.href is not None else ("t", data))

    def handle_endtag(self, tag):
        if tag == "a" and self.href is not None:
            txt = " ".join(self.buf).strip()
            if txt and self.href.startswith("http"):
                self.seq.append(("a", txt, self.href))
            self.href = None


KEEP_PARAMS = {"jk", "jobid", "job_id", "id", "jid", "jobkey", "j", "vjk"}


def canon_url(u):
    """Strip tracking params so the same posting emailed twice dedupes."""
    p = urllib.parse.urlparse(u)
    q = [(k, v) for k, v in urllib.parse.parse_qsl(p.query) if k.lower() in KEEP_PARAMS]
    return urllib.parse.urlunparse((p.scheme, p.netloc, p.path, "", urllib.parse.urlencode(q), ""))


def jobs_from_email(html_body, source, when, default_loc):
    m = _Mail()
    m.feed(html_body)
    out, seq = [], m.seq
    for i, item in enumerate(seq):
        if item[0] != "a" or not (8 <= len(item[1]) <= 140) or not RULES.title_ok(item[1]):
            continue
        near = []
        for nxt in seq[i + 1:i + 6]:
            if nxt[0] == "a":
                break
            near.append(nxt[1])
        loc = next((t for t in near if locations.classify(t)["cls"] in locations.TARGETS), default_loc)
        company = near[0] if near and len(near[0]) <= 60 else ""
        url = canon_url(item[2])
        out.append(mk(f"mail:{hashlib.sha1(url.encode()).hexdigest()[:14]}", company or source, item[1], loc, item[2], f"{source} (email)",
                      when, "", 3, "agg", {"trusted": True}))
    return out


def email_alerts(cfg):
    """Read job-alert emails that Naukri / Indeed / foundit / Shine / Instahyre / Hirist / Cutshort send to your Gmail (IMAP, read-only)."""
    user, pw = os.environ.get("GMAIL_USER"), os.environ.get("GMAIL_APP_PASSWORD")
    if not (user and pw):
        raise RuntimeError("skipped: set GMAIL_USER and GMAIL_APP_PASSWORD (Google account app password)")
    M = imaplib.IMAP4_SSL("imap.gmail.com")
    M.login(user, pw)
    M.select("INBOX", readonly=True)
    since = (datetime.now() - timedelta(days=cfg["max_age_days"] + 2)).strftime("%d-%b-%Y")
    out = []
    try:
        for source, needle in cfg["email_senders"].items():
            _, data = M.search(None, f'(SINCE "{since}" FROM "{needle}")')
            for num in data[0].split()[-80:]:
                _, msg = M.fetch(num, "(RFC822)")
                m = email.message_from_bytes(msg[0][1])
                when = email.utils.parsedate_to_datetime(m["Date"]).astimezone(timezone.utc).isoformat() if m["Date"] else None
                for part in m.walk():
                    if part.get_content_type() == "text/html":
                        body = part.get_payload(decode=True).decode(part.get_content_charset() or "utf-8", "replace")
                        out += jobs_from_email(body, source, when, cfg["email_default_location"])
    finally:
        M.logout()
    return out


AGG = {  # name -> (fn, min minutes between fetches). Some of these ask API users to go easy.
    "Remotive": (remotive, 360), "RemoteOK": (remoteok, 120), "Himalayas": (himalayas, 120),
    "Arbeitnow": (arbeitnow, 60), "Adzuna": (adzuna, 120), "HN Who's Hiring": (hn_hiring, 360),
    "Landing.jobs": (landing_jobs, 120), "Working Nomads": (working_nomads, 180), "Jobicy": (jobicy, 180),
    "Jooble": (jooble, 120), "JSearch (Naukri/Indeed/etc.)": (jsearch, 720), "Job-board email alerts": (email_alerts, 0),
}


# ------------------------------------------------------------------ filter / score / visa
def wb(words):
    return re.compile(r"\b(?:" + "|".join(re.escape(w) for w in words) + r")\b", re.I)


class Rules:
    def __init__(self, cfg):
        self.inc, self.exc = wb(cfg["title_include"]), wb(cfg["title_exclude"])
        self.kw = cfg["profile_keywords"]

    def title_ok(self, t):
        return bool(self.inc.search(t)) and not self.exc.search(re.sub(r"technical staff", "", t, flags=re.I))

    def track(self, j):
        """Bucket a job: india / intl (Europe, Singapore, UAE) / other (other safe countries) / us (only kept if visa is mentioned) / remote."""
        if not self.title_ok(j["title"]):
            return None
        r = locations.classify(j["location"])
        cls = r["cls"]
        j["region"], j["country"], j["visa_route"] = cls, (r["countries"] or [""])[0], r["visa_route"]
        t = {"india": "india", "singapore": "intl", "uae": "intl", "europe": "intl", "other_ok": "other", "us_optional": "us"}.get(cls)
        if t:
            return t
        if cls in ("remote_global", "regional") and j["kind"] == "agg":
            return "remote"
        return None

    def score(self, j):
        title, body = j["title"].lower(), j["desc"].lower()
        raw = sum(w * (2 if k in title else 1) for k, w in self.kw.items() if k in title or k in body)
        return min(10, round(raw * 10 / 14)) if j["desc"] else min(10, round(sum(w for k, w in self.kw.items() if k in title) * 2))


NEG_VISA = re.compile(r"(unable|not able|cannot|can't|won't|will not|do not|does not|don't|no)\s+(offer\s+|provide\s+)?(visa\s+)?sponsor|without (visa )?sponsorship|must (already )?(be authori[sz]ed|have the right) to work|no visa", re.I)
POS_VISA = re.compile(r"visa sponsor|sponsor(s|ship)? (a |your )?(work )?visa|relocation (assistance|support|package)|will relocate|blue card|work permit support|employment pass", re.I)


def visa_flag(text):
    if not text:
        return "unknown"
    if NEG_VISA.search(text):
        return "no"
    return "yes" if POS_VISA.search(text) else "unknown"


def enrich_greenhouse(j):
    slug, gid = j["meta"]["gh"]
    try:
        d = fetch(f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs/{gid}", tries=2)
        j["desc"] = strip_html(d.get("content"))
    except Exception:
        pass


# ------------------------------------------------------------------ referrals / past applications (LinkedIn export)
_DROP = {"inc", "ltd", "limited", "llc", "llp", "pvt", "private", "corp", "corporation", "co", "company", "technologies", "technology",
         "india", "global", "tech", "services", "solutions", "systems", "software", "labs", "group", "plc", "gmbh", "ag", "pte", "the", "and"}
_ALIAS = {"alphabet": "google", "facebook": "meta", "meta platforms": "meta", "amazon web": "amazon", "aws": "amazon", "citigroup": "citi",
          "citibank": "citi", "citi bank": "citi", "jpmorgan chase": "jpmorgan", "jpmorganchase": "jpmorgan", "jp morgan": "jpmorgan",
          "amex": "american express"}


def norm_co(name):
    n = re.sub(r"\(.*?\)", " ", (name or "").lower().replace("&", " and "))
    words = [w for w in re.sub(r"[^a-z0-9 ]", " ", n).split() if w not in _DROP]
    n = " ".join(words)
    return _ALIAS.get(n, n)


def match_company(company, table):
    """Sum table values for company names equal to / extending the job's company name ('amazon' ~ 'amazon web services')."""
    n = norm_co(company)
    if len(n) < 2:
        return 0
    return sum(v if not isinstance(v, dict) else v["n"] for k, v in table.items()
               if k == n or (len(min(k, n, key=len)) >= 4 and (k.startswith(n + " ") or n.startswith(k + " "))))


def load_connections(cfg):
    """connections.csv (local only): normalised company -> [{name, role, url, email, company}]. Never written to data/."""
    p = ROOT / cfg["connections_csv"]
    by_co = defaultdict(list)
    if not p.exists():
        return by_co
    lines = p.read_text(encoding="utf-8-sig").splitlines()
    start = next((i for i, l in enumerate(lines) if l.startswith("First Name")), 0)
    for r in csv.DictReader(lines[start:]):
        if (r.get("Company") or "").strip():
            by_co[norm_co(r["Company"])].append({"name": f"{r.get('First Name', '')} {r.get('Last Name', '')}".strip(),
                                                 "role": r.get("Position", ""), "url": r.get("URL", ""),
                                                 "email": (r.get("Email Address") or "").strip(), "company": r["Company"].strip()})
    return by_co


def _rank(role):
    r = (role or "").lower()
    if re.search(r"intern|student|summer school|trainee|aspiring|seeking|looking for|fresher|freelanc|ex-|former|\bat university|campus", r):
        return 4  # unlikely to be able to refer
    if re.search(r"recruit|talent|hiring|sourc|acquisition|hr\b|people", r):
        return 0  # can submit referrals / route you
    if re.search(r"engineer|ml\b|\bai\b|data|scien|research|developer|architect|machine", r):
        return 1
    if re.search(r"manager|lead|director|head|vp|principal|staff", r):
        return 2
    return 3


def guess_email(name, company, patterns):
    pat = patterns.get(norm_co(company))
    toks = re.sub(r"[^a-zA-Z ]", "", name).lower().split()
    if not pat or len(toks) < 2:
        return ""
    return pat["pattern"].format(first=toks[0], last=toks[-1]) + "@" + pat["domain"]


def names_for(company, by_co, patterns=None, limit=15):
    n = norm_co(company)
    people = [dict(p) for k, ppl in by_co.items()
              if k == n or (len(min(k, n, key=len)) >= 4 and (k.startswith(n + " ") or n.startswith(k + " "))) for p in ppl]
    people.sort(key=lambda p: _rank(p["role"]))
    for p in people:
        p["ekind"] = "linkedin" if p["email"] else ""
        if not p["email"] and patterns:
            g = guess_email(p["name"], p["company"], patterns)
            p["email"], p["ekind"] = g, ("guess" if g else "")
    return people[:limit]


# ------------------------------------------------------------------ resume choice
def pick_resume(j, profile):
    """FDE resume for customer-facing / deployment / voice roles, else the AI Engineer / Software resume."""
    title, text = j["title"].lower(), (j.get("snippet") or j.get("desc") or "").lower()
    hit = next((w for w in profile.get("fde_title_words", []) if w in title), None)
    if hit:
        return "fde", f"title says “{hit}”: customer-facing delivery, lead with your Voice AI + stakeholder work"
    if not any(w in title for w in profile.get("ai_title_words", [])):
        n = sum(text.count(w) for w in profile.get("fde_text_words", []))
        if n >= profile.get("fde_text_threshold", 6):
            return "fde", "description is customer / stakeholder / deployment heavy"
    return "ai", "core AI / ML engineering role: lead with the agent platform, evals and infra"


# ------------------------------------------------------------------ notify
def telegram_ready():
    return bool(os.environ.get("TELEGRAM_BOT_TOKEN") and os.environ.get("TELEGRAM_CHAT_ID"))


def telegram(text, dry=False):
    if dry or not telegram_ready():
        print(text, "\n")
        return
    body = urllib.parse.urlencode({"chat_id": os.environ["TELEGRAM_CHAT_ID"], "text": text, "disable_web_page_preview": "true"}).encode()
    try:
        urllib.request.urlopen(f"https://api.telegram.org/bot{os.environ['TELEGRAM_BOT_TOKEN']}/sendMessage", body, timeout=30)
    except Exception as e:
        print("telegram failed:", e, file=sys.stderr)


def message(j):
    icon = {"india": "🇮🇳", "intl": "🌏", "remote": "🌐", "other": "🌍", "us": "🇺🇸"}[j["track"]]
    visa = {"yes": "🛂 visa/relocation mentioned", "no": "🚫 says no sponsorship", "unknown": ""}[j["visa"]]
    n = j.get("ref_count", 0)
    ref_txt = (f"🤝 {n} connection{'s' if n > 1 else ''} at {j['company']}: ask for a referral first" if n else "🤝 no connections found, try cold outreach")
    if j.get("applied_before"):
        ref_txt += f"\n⚠️ you've applied to {j['company']} {j['applied_before']}x before"
    prof = load(ROOT / "profile.json", {})
    resume = prof.get("resumes", {}).get(j.get("resume", ""), {}).get("file", "")
    return (f"{icon} {j['company']} (T{j['tier']}) · match {j['score']}/10\n{j['title']}\n📍 {j['location'][:80]}{' · ' + j['country'] if j.get('country') and j['country'] not in j['location'] else ''}\n"
            + (f"📄 Use resume: {resume}\n" if resume else "")
            + (visa + "\n" if visa else "") + ref_txt + f"\n🔗 {j['url']}")


# ------------------------------------------------------------------ the run
def run(force=False, dry=False, notify=True):
    with LOCK:
        cfg = load(ROOT / "config.json", {})
        companies = load(ROOT / "companies.json", {}).get("companies", [])
        store = load(DATA / "jobs.json", {"jobs": {}})
        jobs = store["jobs"]
        seen = set(load(DATA / "seen.json", []))
        status = load(DATA / "status.json", {"sources": {}, "runs": []})
        src_status = status["sources"]
        rules, now = Rules(cfg), now_iso()
        global CFG, RULES
        CFG, RULES = cfg, rules
        max_age = cfg["max_age_days"]
        tracked = load(DATA / "tracker.json", {})

        # build the list of fetch tasks, honouring each source's minimum interval
        tasks, partial = [], set()
        for c in companies:
            if c["ats"] in ATS:
                tasks.append((c["name"], "ats", lambda c=c: ATS[c["ats"]](c), c.get("every_min", 0)))
                if c["ats"] in PARTIAL:
                    partial.add(c["name"])
        for name, (fn, mins) in AGG.items():
            tasks.append((name, "agg", lambda fn=fn: fn(cfg), mins))

        def do(task):
            name, kind, fn, mins = task
            st = src_status.get(name, {})
            if not force and mins and st.get("last_fetch") and \
               (datetime.now(timezone.utc) - datetime.fromisoformat(st["last_fetch"])).total_seconds() < mins * 60 and st.get("ok"):
                return name, kind, None, "recent", 0
            t0 = time.time()
            try:
                return name, kind, fn(), None, int((time.time() - t0) * 1000)
            except Exception as e:
                return name, kind, None, str(e)[:200], int((time.time() - t0) * 1000)

        with ThreadPoolExecutor(14) as ex:
            results = list(ex.map(do, tasks))

        network = load(DATA / "network.json", {"counts": {}, "applied": {}})
        new_jobs, errors = [], 0
        rejected = defaultdict(int)
        for name, kind, fetched, err, ms in results:
            st = src_status.setdefault(name, {"kind": kind})
            st["kind"] = kind
            if err == "recent":
                continue
            if err:
                st.update(ok=False, error=err, ms=ms, last_attempt=now)
                errors += 0 if err.startswith("skipped") else 1
                continue
            baseline = not st.get("seeded")
            ids_now, matched, fresh = set(), 0, 0
            fun = {"fetched": len(fetched), "recent": 0, "title": 0, "matched": 0}
            for j in fetched:
                ids_now.add(j["id"])
                is_recent = not (parse_dt(j["posted"]) and age_days(j) > max_age)  # base filter: posted in the last N days
                title_ok = rules.title_ok(j["title"])
                fun["recent"] += is_recent
                fun["title"] += is_recent and title_ok
                tr = rules.track(j) if (is_recent and title_ok) else None
                if is_recent and title_ok and not tr:  # right role, fresh, but location not in any track: remember why
                    rejected[j["location"][:40] or "(blank)"] += 1
                if not tr:
                    seen.add(j["id"])
                    continue
                fun["matched"] += 1
                matched += 1
                if j["id"] in jobs:
                    jobs[j["id"]].update(closed=False)
                    continue
                j["track"], j["baseline"] = tr, baseline or j["id"] in seen
                j["first_seen"], j["closed"] = now, False
                seen.add(j["id"])
                jobs[j["id"]] = j
                fresh += 1
                if not j["baseline"]:
                    new_jobs.append(j)
            if kind == "ats" and name not in partial:  # a job that vanished from its company's full feed has closed
                for jid, j in jobs.items():
                    if j["source"] == name and jid not in ids_now and not j.get("closed"):
                        j["closed"], j["closed_at"] = True, now
            st.update(ok=True, error=None, fetched=len(fetched), matched=matched, added=fresh, ms=ms, seeded=True, funnel=fun,
                      last_fetch=now, last_attempt=now)

        # enrich newly added jobs: full text for Greenhouse, then score + visa
        todo = [j for j in jobs.values() if "score" not in j]
        with ThreadPoolExecutor(8) as ex:
            list(ex.map(enrich_greenhouse, [j for j in todo if j["meta"].get("gh") and not j["desc"]]))
        for j in todo:
            j["score"], j["visa"] = rules.score(j), visa_flag(j["desc"])
            j["snippet"], j["desc"] = j["desc"][:500], ""
        for jid in list(jobs):  # filters changed? re-check every stored job against today's rules
            j = jobs[jid]
            tr = rules.track(j)
            if tr:
                j["track"] = tr
            elif not (tracked.get(jid) or {}).get("status"):
                del jobs[jid]
        for jid in [k for k, j in jobs.items() if j["track"] == "us" and j["visa"] != "yes"]:
            del jobs[jid]  # US roles are kept only when sponsorship / relocation is actually mentioned
        new_jobs = [j for j in new_jobs if j["id"] in jobs]
        for jid in [k for k, j in jobs.items() if age_days(j) > max_age and not (tracked.get(k) or {}).get("status")]:
            del jobs[jid]  # aged out of the window (anything you've marked in the tracker is kept)
        for j in jobs.values():  # counts only; the local dashboard resolves names from connections.csv
            j["ref_count"] = match_company(j["company"], network["counts"])
            j["applied_before"] = match_company(j["company"], network["applied"])
            j.pop("refs", None)
            j["resume"], j["resume_why"] = pick_resume(j, load(ROOT / "profile.json", {}))

        # alerts
        alerts, digest = [], []
        for j in sorted(new_jobs, key=lambda x: (x["tier"], -x["score"])):
            if j["track"] in ("other", "us") and j["visa"] != "yes":
                continue  # shown on the dashboard, but not worth a phone buzz without a visa/relocation signal
            if j["kind"] == "ats":
                (alerts if j["tier"] <= 2 else digest).append(j)
            elif j["score"] >= cfg["min_score_aggregator_alert"] or j["meta"].get("trusted"):
                alerts.append(j)
        if notify and not os.environ.get("JOBHUNTER_NO_ALERTS"):
            cap = cfg["max_alerts_per_run"]
            for j in alerts[:cap]:
                telegram(message(j), dry)
            if len(alerts) > cap:
                telegram(f"…and {len(alerts) - cap} more new matches, open the dashboard.", dry)
            if digest:
                telegram("📋 Tier-3 digest\n\n" + "\n\n".join(message(j) for j in digest[:10]), dry)

        if rejected:
            status["rejected_locations"] = sorted(rejected.items(), key=lambda kv: -kv[1])[:60]
        status.update(last_run=now, max_age_days=max_age, telegram=telegram_ready(), adzuna=bool(os.environ.get("ADZUNA_APP_ID")), jooble=bool(os.environ.get("JOOBLE_API_KEY")),
                      jsearch=bool(os.environ.get("RAPIDAPI_KEY")), email=bool(os.environ.get("GMAIL_APP_PASSWORD")),
                      manual=[{"name": c["name"], "url": c["url"], "tier": c["tier"], "board": c.get("board", False)} for c in companies if c["ats"] == "manual"])
        status["runs"] = (status.get("runs", []) + [{"t": now, "new": len(new_jobs), "alerted": len(alerts) + len(digest), "errors": errors}])[-40:]
        if not dry:
            store["updated"] = now
            save(DATA / "jobs.json", store)
            save(DATA / "seen.json", sorted(seen))
            save(DATA / "status.json", status)
        return {"new": len(new_jobs), "alerts": len(alerts) + len(digest), "errors": errors}


if __name__ == "__main__":
    DATA.mkdir(exist_ok=True)
    out = run(force="--force" in sys.argv, dry="--dry-run" in sys.argv)
    print(json.dumps(out), file=sys.stderr)
