import unittest
from datetime import datetime, timezone
import xml.etree.ElementTree as ET

from polymarket_bot.context import parse_news, parse_social, research_signal
from polymarket_bot.core import Engine, Market


class ContextTests(unittest.TestCase):
    def test_asset_news_filter_and_general_fallback(self):
        xml = ET.fromstring("""<rss><channel>
          <item><title>Market overview</title><link>https://example.org/general</link></item>
          <item><title>Solana network update</title><link>https://example.org/sol</link></item>
        </channel></rss>""")
        self.assertEqual(parse_news(xml, "sol")[0]["asset_match"], True)
        self.assertEqual(parse_news(xml, "btc")[0]["asset_match"], False)

    def test_social_atom_extracts_public_links(self):
        xml = ET.fromstring("""<feed xmlns="http://www.w3.org/2005/Atom">
          <entry><title>ETH discussion</title><link href="https://reddit.com/x"/>
          <updated>2026-10-08T00:00:00Z</updated></entry></feed>""")
        self.assertEqual(parse_social(xml)[0]["title"], "ETH discussion")
        self.assertEqual(parse_social(xml)[0]["url"], "https://reddit.com/x")

    def test_fresh_asset_headline_has_bounded_directional_effect(self):
        signal = research_signal(dict(status="ready", checked_at=1000, news_status="ok",
            social_status="ok", news=[dict(title="Solana rally", asset_match=True,
                                             published_at=980)], social=[dict(
                title="SOL surge", published_at=datetime.fromtimestamp(985, timezone.utc).isoformat())]),
            "sol", now=1000)
        self.assertEqual((signal["score"], signal["items"]), (1, 2))
        market = Market(slug="sol-updown-5m-0", up_token="up", down_token="down",
                        strike=100, start=0, end=300)
        engine = Engine(market)
        engine.model.probability = lambda now, market: .5
        engine.ingest(dict(kind="research", ts=1, **signal))
        self.assertAlmostEqual(engine.q, .51)
        engine.ingest(dict(kind="clock", ts=902))
        self.assertAlmostEqual(engine.q, .5)

    def test_stale_or_unrelated_headlines_are_neutral(self):
        record = dict(status="ready", checked_at=1000, news_status="ok", social_status="ok",
                      news=[dict(title="Bitcoin crash", asset_match=False, published_at=990)],
                      social=[dict(title="SOL rally", published_at="2020-01-01T00:00:00Z")])
        self.assertEqual(research_signal(record, "sol", now=1000)["items"], 0)
        self.assertEqual(research_signal(record, "sol", now=2000)["score"], 0)


if __name__ == "__main__":
    unittest.main()

