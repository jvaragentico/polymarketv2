"""Optional public news and social headlines for paper research, never order signals."""

from email.utils import parsedate_to_datetime
import threading
import time
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

NEWS_URL = "https://www.coindesk.com/arc/outboundfeeds/rss/"
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
        relevant = any(word in title.lower() for word in KEYWORDS[asset])
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
            return dict(status="unsupported", used_for_orders=False)
        with self.lock:
            record = self.records.get(asset, dict(status="loading", used_for_orders=False))
            if asset not in self.loading and time.time() - record.get("checked_at", 0) > 300:
                self.loading.add(asset)
                threading.Thread(target=self._refresh, args=(asset,), daemon=True).start()
            return record.copy()

    def _refresh(self, asset):
        result = dict(checked_at=time.time(), used_for_orders=False,
                      news_source=NEWS_URL, social_source=SOCIAL_URLS[asset])
        for name, url, parser in (("news", NEWS_URL, lambda root: parse_news(root, asset)),
                                  ("social", SOCIAL_URLS[asset], parse_social)):
            try:
                result[name] = parser(self.fetch(url))
                result[name + "_status"] = "ok"
            except (OSError, ValueError, ET.ParseError) as error:
                result[name] = []
                result[name + "_status"] = f"unavailable: {error}"
        result["status"] = "ready"
        with self.lock:
            self.records[asset] = result
            self.loading.discard(asset)

