#!/usr/bin/env python3
"""Shared job pool for the web app: fetch every source, keep fresh postings, push them to Supabase.

    python3 pool.py              # publish to Supabase (needs SUPABASE_URL + SUPABASE_SERVICE_KEY)
    python3 pool.py --dry-run    # fetch and summarise only

Unlike hunter.py (one person's filters + Telegram), this keeps ALL roles posted in the last N days so each
user's own role/location choices can be applied in their browser. Region/country/visa are pre-computed here.
"""
import json, os, sys, time, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import hunter
import locations

DRY = "--dry-run" in sys.argv
MAX_AGE_DAYS = 14
KEEP_DAYS = 21          # rows older than this (or unseen for 3 days) are deleted
ENRICH_LIMIT = 800      # Greenhouse descriptions fetched per run; the rest wait for a later run (first runs catch up)
STATE = hunter.DATA / "pool_status.json"   # kept between runs by the workflow cache
URL, KEY = os.environ.get("SUPABASE_URL", "").rstrip("/"), os.environ.get("SUPABASE_SERVICE_KEY", "")


def sb(method, path, body=None, prefer=None):
    """Tiny Supabase REST (PostgREST) client using the service key."""
    req = urllib.request.Request(f"{URL}/rest/v1/{path}", method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json",
                                          **({"Prefer": prefer} if prefer else {})})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                raw = r.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            msg = e.read().decode()[:300]
            if e.code < 500 or attempt == 2:
                raise RuntimeError(f"Supabase {method} {path.split('?')[0]} -> {e.code}: {msg}")
        except OSError:
            if attempt == 2:
                raise
        time.sleep(2 * (attempt + 1))


def existing_ids():
    ids, off = set(), 0
    while True:
        rows = sb("GET", f"jobs?select=id&limit=1000&offset={off}") or []
        ids |= {r["id"] for r in rows}
        if len(rows) < 1000:
            return ids
        off += 1000


def main():
    cfg = hunter.load(hunter.ROOT / "config.json", {})
    companies = hunter.load(hunter.ROOT / "companies.json", {}).get("companies", [])
    hunter.CFG, hunter.RULES = cfg, hunter.Rules(cfg)   # Workday/Amazon still search with the role queries in config.json
    status = hunter.load(STATE, {"sources": {}})
    now = datetime.now(timezone.utc)

    tasks = [(c["name"], "ats", (lambda c=c: hunter.ATS[c["ats"]](c)), c.get("every_min", 0)) for c in companies if c["ats"] in hunter.ATS]
    tasks += [(n, "agg", (lambda fn=fn: fn(cfg)), mins) for n, (fn, mins) in hunter.AGG.items()]

    def do(t):
        name, kind, fn, mins = t
        st = status["sources"].get(name, {})
        if mins and st.get("ok") and st.get("last_fetch") and (now - datetime.fromisoformat(st["last_fetch"])).total_seconds() < mins * 60:
            return name, kind, None, "recent"
        try:
            return name, kind, fn(), None
        except Exception as e:
            return name, kind, None, str(e)[:200]

    with ThreadPoolExecutor(14) as ex:
        results = list(ex.map(do, tasks))

    pool = {}
    for name, kind, fetched, err in results:
        st = status["sources"].setdefault(name, {})
        if err == "recent":
            continue
        if err:
            st.update(ok=False, error=err, kind=kind)
            continue
        st.update(ok=True, error=None, kind=kind, fetched=len(fetched), last_fetch=now.isoformat(timespec="seconds"))
        for j in fetched:
            if hunter.parse_dt(j["posted"]) and hunter.age_days(j) > MAX_AGE_DAYS:
                continue
            r = locations.classify(j["location"])
            if r["cls"] in ("excluded", "unclassified", "other_region"):
                continue
            j["region"], j["country"], j["visa_route"] = r["cls"], (r["countries"] or [""])[0], r["visa_route"]
            pool[j["id"]] = j

    have = set() if DRY or not URL else existing_ids()
    new = [j for j in pool.values() if j["id"] not in have]
    gh_new = [j for j in new if j["meta"].get("gh") and not j["desc"]]
    with ThreadPoolExecutor(10) as ex:
        list(ex.map(hunter.enrich_greenhouse, gh_new[:ENRICH_LIMIT]))
    deferred = {j["id"] for j in gh_new[ENRICH_LIMIT:]}   # stored next run, once their description is fetched
    new = [j for j in new if j["id"] not in deferred]

    stamp = now.isoformat(timespec="seconds")

    def row(j, fresh):
        r = {"id": j["id"], "company": j["company"][:120], "title": j["title"][:300], "location": j["location"][:300], "url": j["url"],
             "source": j["source"], "kind": j["kind"], "tier": j["tier"], "posted": j["posted"], "last_seen": stamp,
             "region": j["region"], "country": j["country"], "visa_route": j["visa_route"][:400],
             "snippet": (j["desc"] or "")[:600]}
        if fresh:
            r["first_seen"] = stamp
            r["visa"] = hunter.visa_flag(j["desc"])
        return r

    new_rows = [row(j, True) for j in new]
    old_rows = [row(j, False) for j in pool.values() if j["id"] in have]
    by_region = {}
    for j in pool.values():
        by_region[j["region"]] = by_region.get(j["region"], 0) + 1
    print(f"pool: {len(pool)} fresh jobs ({len(new_rows)} new, {len(old_rows)} seen before, {len(deferred)} waiting for descriptions) | regions {by_region}", file=sys.stderr)

    if DRY or not URL:
        print("dry run (or SUPABASE_URL missing): nothing published", file=sys.stderr)
        return
    for rows in (new_rows, old_rows):
        for i in range(0, len(rows), 500):
            sb("POST", "jobs?on_conflict=id", rows[i:i + 500], prefer="resolution=merge-duplicates,return=minimal")
    cutoff = (now - timedelta(days=KEEP_DAYS)).isoformat(timespec="seconds")
    unseen = (now - timedelta(days=3)).isoformat(timespec="seconds")
    sb("DELETE", f"jobs?posted=lt.{cutoff}", prefer="return=minimal")
    sb("DELETE", f"jobs?last_seen=lt.{unseen}", prefer="return=minimal")
    sb("POST", "companies?on_conflict=name", [{"name": c["name"], "tier": c["tier"], "ats": c["ats"], "url": c.get("url")} for c in companies],
       prefer="resolution=merge-duplicates,return=minimal")
    health = {k: {"ok": v.get("ok"), "kind": v.get("kind"), "fetched": v.get("fetched"), "error": v.get("error"), "last_fetch": v.get("last_fetch")}
              for k, v in status["sources"].items()}
    sb("POST", "meta?on_conflict=key", [{"key": "pool", "value": {"last_run": stamp, "jobs": len(pool), "new": len(new_rows), "regions": by_region,
                                                                   "sources": health}, "updated_at": stamp}],
       prefer="resolution=merge-duplicates,return=minimal")
    hunter.save(STATE, status)
    print(f"published {len(new_rows)} new + refreshed {len(old_rows)}", file=sys.stderr)


if __name__ == "__main__":
    hunter.DATA.mkdir(exist_ok=True)
    main()
