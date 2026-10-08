"""Public research headlines and a small, inspectable experimental signal."""

from datetime import datetime
from email.utils import parsedate_to_datetime
import re
import threading
import time
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

NEWS_URL = "https://www.coindesk.com/arc/outboundfeeds/rss/"
NEWS_URLS = (("CoinDesk", NEWS_URL), ("Cointelegraph", "https://cointelegraph.com/rss"))
SOCIAL_URLS = {
    "btc": "https://www.reddit.com/r/Bitcoin/new/.rss?limit=10",
    "eth": "https://www.reddit.com/r/ethereum/new/.rss?limit=10",
    "xrp": "https://www.reddit.com/r/XRP/new/.rss?limit=10",
    "sol": "https://www.reddit.com/r/solana/new/.rss?limit=10",
}
KEYWORDS = {
    "btc": ("bitcoin", "btc"), "eth": ("ethereum", "ether", "eth"),
    "xrp": ("xrp", "ripple"), "sol": ("solana", "sol"),
}
ATOM = "{http://www.w3.org/2005/Atom}"
POSITIVE = ("rally", "surge", "record high", "approval", "breakout", "soars")
NEGATIVE = ("crash", "plunge", "exploit", "hack", "lawsuit", "selloff")


def research_signal(record, asset, now=None):
    """Score only fresh, asset-relevant public headlines; missing data is neutral."""
    now = time.time() if now is None else now
    if record.get("status") != "ready" or now - record.get("checked_at", 0) > 900:
        return dict(score=0.0, items=0, sources=[], reason="research unavailable or stale")
    values, sources = [], []
    for source, rows in (("news", record.get("news", [])), ("social", record.get("social", []))):
        if record.get(source + "_status") != "ok":
            continue
        for row in rows:
            title = row.get("title", "").lower()
            if source == "news" and row.get("asset_match") is not True:
                continue
            if source == "social" and not any(re.search(r"\b" + re.escape(word) + r"\b", title)
                                              for word in KEYWORDS[asset]):
                continue
            published = row.get("published_at")
            try:
                stamp = (float(published) if isinstance(published, (float, int)) else
                         datetime.fromisoformat(published.replace("Z", "+00:00")).timestamp())
            except (TypeError, ValueError, AttributeError):
                continue
            if not 0 <= now - stamp <= 900:
                continue
            positive = any(re.search(r"\b" + re.escape(word) + r"\b", title) for word in POSITIVE)
            negative = any(re.search(r"\b" + re.escape(word) + r"\b", title) for word in NEGATIVE)
            if positive == negative:
                continue
            values.append(1 if positive else -1)
            publisher = row.get("publisher", source)
            if publisher not in sources:
                sources.append(publisher)
    score = sum(values) / len(values) if values else 0.0
    return dict(score=score, items=len(values), sources=sources,
                reason="experimental headline polarity" if values else "no fresh directional headlines")


def fetch_xml(url):
    request = Request(url, headers={"User-Agent": "crypto-paper-dashboard/0.1 (public RSS research)",
                                    "Accept": "application/rss+xml,application/atom+xml,application/xml"})
    with urlopen(request, timeout=6) as response:
        return ET.fromstring(response.read(2_000_000))


def parse_news(root, asset):
    entries = []
    general = []
    for item in root.findall("./channel/item"):
        title = (item.findtext("title") or "").strip()
        relevant = any(re.search(r"\b" + re.escape(word) + r"\b", title.lower())
                       for word in KEYWORDS[asset])
        published = item.findtext("pubDate")
        try:
            stamp = parsedate_to_datetime(published).timestamp()
        except (TypeError, ValueError):
            stamp = None
        row = dict(title=title[:180], url=(item.findtext("link") or "").strip(),
                   published_at=stamp, asset_match=relevant)
        general.append(row)
        if relevant:
            entries.append(row)
    return entries[:5] if entries else general[:3]


def parse_social(root):
    entries = []
    for item in root.findall(f"{ATOM}entry")[:5]:
        link = item.find(f"{ATOM}link")
        entries.append(dict(title=(item.findtext(f"{ATOM}title") or "").strip()[:180],
                            url=link.get("href", "") if link is not None else "",
                            published_at=(item.findtext(f"{ATOM}updated") or "").strip()))
    return entries


class ResearchCache:
    def __init__(self, fetch=fetch_xml):
        self.fetch = fetch
        self.lock = threading.Lock()
        self.records = {}
        self.loading = set()

    def get(self, asset):
        if asset not in SOCIAL_URLS:
            return dict(status="unsupported")
        with self.lock:
            record = self.records.get(asset, dict(status="loading"))
            if asset not in self.loading and time.time() - record.get("checked_at", 0) > 300:
                self.loading.add(asset)
                threading.Thread(target=self._refresh, args=(asset,), daemon=True).start()
            return record.copy()

    def _refresh(self, asset):
        result = dict(checked_at=time.time(),
                      news_source=" · ".join(name for name, _ in NEWS_URLS),
                      social_source=SOCIAL_URLS[asset])
        news, available, failures = [], [], []
        for publisher, url in NEWS_URLS:
            try:
                rows = parse_news(self.fetch(url), asset)
                news.extend(dict(row, publisher=publisher) for row in rows)
                available.append(publisher)
            except (OSError, ValueError, ET.ParseError):
                failures.append(publisher)
        result["news"] = sorted(news, key=lambda row: row.get("published_at") or 0,
                                reverse=True)[:8]
        result["news_status"] = (f"ok · {len(available)} source(s)" if available else
                                 "unavailable: " + ", ".join(failures))
        try:
            result["social"] = parse_social(self.fetch(SOCIAL_URLS[asset]))
            result["social_status"] = "ok"
        except (OSError, ValueError, ET.ParseError):
            result["social"] = []
            result["social_status"] = "unavailable"
        result["status"] = "ready"
        with self.lock:
            self.records[asset] = result
            self.loading.discard(asset)


