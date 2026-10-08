import unittest
import xml.etree.ElementTree as ET

from polymarket_bot.context import parse_news, parse_social


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


if __name__ == "__main__":
    unittest.main()

