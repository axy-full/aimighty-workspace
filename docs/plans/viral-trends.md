# Viral mode: trend sources (research only)

**Status: PARKED under "Viral phase 2 (after Stripe launch)"** (owner, 15 Oct 2026, 16:05; docs/redesign-plan.md). Research only: nothing is built until after launch and the owner's go.

Read on 15 Oct 2026. No keys, no sign-ups, no calls made. Everything below comes from public pages (URLs in section 6). "Unverified" means I could not confirm it from the vendor's own page.

## Owner decisions (15 Oct 2026, 16:40)
- The trend panel shows two sources side by side: **"rising globally (TikTok)"** and **"rising in India (YouTube, Google Trends)"**, because TikTok is banned in India.
- The platform-level cache (an exception to ground rule 2) and the customer price wait until after launch.

## 1. Short version

- **Trial first, in this order:** (a) YouTube `videos.list chart=mostPopular&regionCode=IN` (free, official, works for India); (b) SerpApi Google Trends "Trending Now" `geo=IN` on its free plan (250 searches a month); (c) Zyla "TikTok Trend Tracker" for TikTok hashtags with growth (3 free test requests shown on the listing); (d) Tokchart only if sounds matter (the one source that lists sounds with growth).
- **India reality:** TikTok data for India does not exist. TikTok is banned there, and the TikTok Creative Center country list (as copied by third-party actors) has no India. Zyla and Tokchart do not say whether India works (unverified, expect empty). India signals must come from YouTube, Google Trends and Instagram. For TikTok we get "global" (US, GB, ID, BR and similar), not India.
- **Cost at 500 calls a day (about 15,000 a month):** free (YouTube, Meta, Google alpha), US$150 a month (SerpApi Production), about US$15 plus Apify usage (Apify actor), US$100 a month (EnsembleData Wood), US$99 a month and up (Tokchart, call limits not published), about US$3,750 a month (Zyla at published rates). Real need is far less: one call returns a whole list, so with caching about 20 to 50 calls a day is enough (section 4).
- **Zyla is one product sold four times.** The four listings have identical fields, identical provider string ("JNX Global Infrastructure"), identical price and identical 11,965 ms latency. Treat as one source. I could not find who "JNX Global Infrastructure" is.
- **Biggest terms risk:** every TikTok source is scraped data resold by a third party (TikTok's terms ban automated collection). Tokchart's terms also forbid showing its data to customers in dashboards or feeds. The platform-wide risk is to our supplier, but we should be able to drop a provider in a day, which the adapter allows.

## 2. The table

Price column is at 500 calls a day (15,000 a month), cheapest published plan that covers it. "Not published" means no price on the page.

| Source (operator) | Data | India | Freshness | Price/month at 500 calls/day | Terms risk | Notes |
|---|---|---|---|---|---|---|
| **Zyla "TikTok Trend Tracker" (= Media Trends = Trend Data Retriever = Capture Trends).** Marketplace: Zyla Labs (founder/CEO Alejandro Brega, country not stated). Provider shown in sample response: "JNX Global Infrastructure" (unverified who that is) | Hashtags only: rank, posts, video views, industries, country, 7-day period, trend direction up/down, daily trend curve, top creators (with avatar URL). **No sounds.** No formats. | Needs a `country` code (required). Supported list not published. India unverified, expect empty or error | "Real time" in the text; no refresh interval stated (unverified) | Elite plan US$499.99 monthly (2,500 requests) plus overage US$0.259974 per request: 12,500 x 0.259974 = about US$3,250. **About US$3,750 total.** Enterprise "from US$10,000 a year", volume not published. Annual billing is cheaper per plan but the page contradicts itself on prices | **High to medium.** Source says only "sourced from TikTok"; fields match TikTok Creative Center's hashtag page (my inference), whose terms ban automated collection | Listing latency: **11,965 ms average**. 60 requests/min on small plans (page contradicts itself on bigger ones). Only HTTP 200 calls count. Basic is 1 request a month and Pro 2 (looks like a listing error). |
| **Tokchart API** (FORT INDUSTRIES LIMITED, London, company no. 11422884; says it is not affiliated with TikTok) | Music Trends API: ranked songs/artists, UGC video totals and per day. Audio UGC API: individual TikTok sounds with score, UGC videos/day, acceleration, views, likes, upload date, trending countries, hashtags. **Sounds and growth: yes.** Hashtag chart exists on the website, not in the API listing. | Country charts exist; examples show US and UK. India not mentioned. Unverified | Not stated for the API. The site says Business accounts "updated daily" (that refers to tracked accounts) | Music Trends API "from US$99 a month", call limits not published. Audio UGC API: custom, by enquiry. **So: from US$99, real quote needed** | **Medium.** Terms say data is "derived in part from third-party sources". No licence to show data to customers in dashboards or feeds (4.1), no persistent replicas (4.4). Derived insights are allowed | Docs page needs JavaScript; I could not read parameters, auth, rate limits. UK law. Liability capped at 3 months' fees. |
| **EnsembleData** (EnsembleData Pte. Ltd.) | No trending endpoint. Hashtag Search (1 unit per 20 posts), Keyword Search, Music Info/Music Posts. Trends must be inferred by us from counts over time. Returns post lists, so output includes video URLs. | No region parameter seen. Not a TikTok-India source. | "Every request triggers a live scrape" (their words) | Wood plan **US$100** (1,500 units a day, covers 500). Free trial 50 units a day | **Medium.** Says it only accesses public data, no login bypass. It is still scraping | Claims under 3 s (vendor claim). Per-endpoint unit costs partly unlabelled on pricing page (Music Info 2, Music Posts 1). |
| **Apify: `datapeak/tiktok-creative-center`** ("TikTok Creative Center Scraper: Top Ads, Trending Hashtags and Songs", author Gal Gilboa, community actor) | Hashtags: rank, rank change, post count, views, industry, trend curve. Songs: title, artist, trend curve. Top Ads mode also returns ad video URLs (we would not use it) | Region input is a 2-letter code; India not mentioned. Third-party actors list ~27 Creative Center markets without India. Expect none | Whatever the run returns, live pull per run. Creative Center periods 7, 30, 120 days | Pay per event: **US$0.001 per hashtag or song record**, so 15,000 records is **US$15**, plus Apify platform usage (headless browser, residential proxy needed; per-run cost not published). Assumption: 1 call = 1 record. Real runs return up to `maxItems` records each | **High.** Scrapes TikTok's own site through residential proxies. TikTok terms s.5 bar "automated scripts" and bypassing access controls | Created 12 Jul 2026, **last modified 18 Jul 2026**, v0.1. 372 total users, 167 in last 30 days, 2,265 runs, 99.5% success. Young and low-use. Some sources say TikTok removed public songs and creators feeds (unverified for this actor). |
| **YouTube Data API `videos.list chart=mostPopular`** (Google) | Top videos by region and category: title, channel, views, likes, published time. Growth only by us comparing runs. No hashtags or sounds as such (tags in `snippet` are optional) | **Yes. `regionCode=IN` is supported by the parameter.** Whether IN returns a chart is not stated on the page (unverified until tried) | Not stated by the docs (unverified) | **US$0.** 1 quota unit per call; default 10,000 units a day, so 500 a day is fine. 50 results max per call | **Low.** Official API. Developer Policies: delete or refresh stored data every 30 days; no downloading or caching of video; do not replace YouTube data with own metrics without labelling | Needs a Google Cloud project and key. Returns thumbnails and player data (we skip them). |
| **Google Trends API (alpha)** (Google) | Search interest over time, consistently scaled, last 5 years, daily to yearly, countries and sub-regions. Not a "what is trending now" feed (not described) | Countries and sub-regions compared; India not named. Likely fine, unverified | Not stated | Price not published. Alpha, by application | **Low on terms, high on access.** Not open to everyone. Apply by form; Google favours clear use case, ready to start, and feedback. No terms or pricing published | May never be granted. Do not plan on it. |
| **SerpApi Google Trends "Trending Now"** (SerpApi) | Trending queries: search volume, increase %, start time, categories, breakdown. Window 4h, 24h, 48h, 7d | **Yes. `geo=IN` is in SerpApi's locations list.** | 1-hour cache; live otherwise | **Production plan US$150** (15,000 searches; 3,000/hr). Free plan 250 a month; Developer US$75 (5,000). Cached hits are free. Credits per Trending Now call not stated (assumed 1) | **Medium.** Scrapes Google. Google sued SerpApi on 19 Dec 2025 (DMCA, N.D. Cal.); status unverified. SerpApi sells a "U.S. Legal Shield" (up to US$2M cover) on Production and up | No video or media. Best India signal for "what people search". |
| **Instagram Hashtag Search** (Meta Graph API) | Top and recent media for a hashtag you name. No "trending" list, no sounds. Examples show media ids only | Works for any hashtag, but no region filter. Instagram is not banned in India | Not stated | **US$0** | **Low, high effort.** Needs a Business or Creator account, App Review for "Instagram Public Content Access" and `instagram_basic`. **30 unique hashtags per 7 days per account.** Emojis and Stories hashtags not supported | Lookup tool, not discovery. Use only to size a hashtag we already found elsewhere. |

## 3. Signals-only rule

Keep: name, id, counts, growth, region, window, timestamps, and a link to the source page at most. Never fetch, store or proxy a video, cover, avatar or audio file.

- **Zyla:** safe. Output has `avatar` URLs for creators (drop them) and a TikTok page URL (may keep). No videos.
- **Tokchart:** safe. No media fields in the listing.
- **EnsembleData:** tempting. Search endpoints return posts with video links. Use them only to read counts; drop everything else at the mapping step.
- **Apify datapeak:** **flag.** Top Ads mode returns `videoUrl` (signed, expiring in 24 to 48 hours; the page advises downloading promptly) and `coverUrl`. Use hashtags and songs modes only; the adapter must not offer ads mode.
- **YouTube:** safe if we request `part=snippet,statistics` only. Policy bars caching video content.
- **SerpApi, Google Trends, Meta:** no media of ours. Meta media ids are fine; do not request media URLs.

## 4. Proposed adapter (provider-neutral)

**Tool.** `trend.signals` in the registry (A1) first. The button, Atomik, a board card, a saved skill and MCP call the same tool, same price, same approval gate. Read-only, so it needs no spend approval when free. Input: `region` (ISO code or `global`), `kinds` (hashtag, sound, format, topic), `limit`, `window`. Output: `TrendSignal[]` plus `stale: boolean`.

**Env.**
- `TRENDS_PROVIDER`: one of `zyla`, `tokchart`, `ensembledata`, `apify_cc`, `youtube`, `serpapi_trends`, `google_trends`, `meta_hashtag`.
- `TRENDS_API_KEY`: secret, runtime only, never logged, never sent to the client.
- **Switch:** the owner's two names do suffice (off when either is missing). **Recommend a third, `TRENDS_ENABLED`** (unset or not `true` = off). Reason: a key pasted into Coolify for a trial would otherwise turn the feature on for the house workspace at once; a separate switch also lets you stop it without deleting the secret. Off means the tool is not in the registry, not offered in Atomik or MCP, the button is absent, and the route returns 404.
- Optional, with defaults in code: `TRENDS_DAILY_CALL_BUDGET` (default 50), `TRENDS_CACHE_TTL_HOURS` (default 6), `TRENDS_REGIONS` (default `IN,US,GB,global`). Some providers need extra ids (Meta needs an account id); a provider may declare its own optional vars.

**Type (no media fields at all).**
```
TrendSignal {
  kind: 'hashtag' | 'sound' | 'format' | 'topic'
  name: string
  region: string            // ISO 3166-1 alpha-2 or 'global'
  platform: 'tiktok' | 'youtube' | 'instagram' | 'google'
  score?: number            // provider rank or volume, normalised 0..100
  growth?: number           // percent over window, if the provider gives it
  window: '4h' | '24h' | '7d' | '30d' | '120d'
  observedAt: string        // ISO time we fetched
  sourceUrl?: string        // link only
  provider: string          // provider id
}
```
Mapping drops everything not in this type (avatars, covers, video URLs, creator handles).

**Caching and limits.** One fetch per region and provider per TTL (6 h; the providers do not state refresh faster than daily, so 6 to 24 h is enough). 7 regions at 4 refreshes a day is 28 calls a day, well under 500. A daily call budget in the adapter returns cached data once spent. Per-provider rate limit (Zyla 60 a minute; YouTube quota 10,000 units a day; Meta 30 hashtags per 7 days) kept in the provider module. Zyla's listed latency (about 12 s) means the tool is asynchronous: return the cache at once, refresh in the background.

**Cost record.** Every call writes `engine_cost_usd` to the ledger (with provider id, region, status), never shown to customers.

**Failure.** Provider error, timeout or empty result: return the last cache marked `stale: true` with its `observedAt`; if none, "No trends right now. Nothing billed." with Retry. Never bill for a failed fetch. Three failures in a row: stop calling that provider for 15 minutes.

**Storage.** Recommend a **platform-level cache**: trends are public facts, not customer data, one fetch serves all tenants, and the platform pays the key. It holds only `TrendSignal` rows. This is an exception to ground rule 2 ("every table carries `workspace_id`"); the owner should approve it and it should go in the SOW. Per-workspace data stays workspace-scoped: which signal a workspace used in a brief (`workspace_id`, signal id, time). Check before launch that the chosen vendor's terms allow serving one fetch to many customers (Tokchart's 4.1 and 4.4 probably do not; YouTube needs refresh within 30 days).

**Price to customers (owner's decision).** Recommend **free** (a cached read costs the platform cents). Option: 1 cr per "refresh now" outside the cache, shown as `N cr`; the cached read stays `free`. Prices must come from the rate card, not the adapter.

## 5. Test plan

1. **Mocked fixtures per provider.** Hand-written JSON from the documented shapes: Zyla `{status, provider, total_results, data:[{Rank, Hashtag, Posts, "Video Views", "Trend Direction", ...}]}`; Tokchart audio items; EnsembleData hashtag posts; Apify dataset items; YouTube `items[]`; SerpApi `trending_searches[]` (field names from the sample list above); Meta media ids. No real calls.
2. **Contract test.** For every provider id, fixture in, `TrendSignal[]` out; every field typed; `kind`, `region`, `platform`, `provider` always set.
3. **No-media test.** Feed fixtures containing `videoUrl`, `coverUrl`, `avatar`, `thumbnails`, `media_url`; assert none survives, by key name and by scanning every string for `http` links ending in `.mp4`, `.jpg`, `.png`, `.webp`, `.mp3`, `.m4a`; only `sourceUrl` may be a URL and only on the provider's page domain.
4. **Switch-off test.** With `TRENDS_ENABLED` unset, or provider or key missing: tool absent from the registry and from the MCP list, Atomik cannot call it, route returns 404, zero network calls.
5. **Budget and rate-limit test.** Fake clock: after `TRENDS_DAILY_CALL_BUDGET` calls the cache is served; TTL expiry refetches once; concurrent requests for one region make one call (single flight).
6. **Failure test.** Timeout, 500, 429, empty body, malformed JSON: stale cache or "Nothing billed", ledger row cost 0 billed 0, circuit opens after three.
7. **Approval and agent tests (rule 11).** Mocked run through the gate as a person, as `agent:*`, and as an MCP caller; same result and same price.
8. **Secrets.** `TRENDS_API_KEY` absent from logs, responses and client bundle.
9. **Owner's trial plan (later, your keys, your spend).** Day 1, one provider at a time, in this order: YouTube IN, SerpApi IN (free), Zyla (3 free tests, then trial). For each, run `IN`, `US`, `global` and note: **India relevance** (does `IN` return something useful, or empty), **freshness** (does the list change within a day), **latency** (Zyla's listing says about 12 s), **cost per useful signal**, and whether sounds appear. Keep a one-line verdict per provider in the progress doc.

## 6. Sources (all read 15 Oct 2026)

- Zyla list of TikTok trending APIs: https://www.zylalabs.com/api-marketplace/top-search/TikTok%20Trending%20API
- Zyla TikTok Trend Tracker (13569): https://zylalabs.com/api-marketplace/social+media+%26+networking/tiktok+trend+tracker+api/13569
- Zyla Retrieve TikTok Media Trends (13684): https://zylalabs.com/api-marketplace/social+media+%26+networking/retrieve+tiktok+media+trends+api/13684
- Zyla TikTok Trend Data Retriever (13682): https://zylalabs.com/api-marketplace/social+media+%26+networking/tiktok+trend+data+retriever+api/13682
- Zyla Capture TikTok Trends (13683): https://zylalabs.com/api-marketplace/social+media+%26+networking/capture+tiktok+trends+api/13683
- Zyla about (operator): https://zylalabs.com/about-us (Zyla's terms page: not found, so who is liable for listing data is unverified)
- Tokchart home: https://tokchart.com ; API page: https://tokchart.com/api ; API terms: https://tokchart.com/api-terms ; plans: https://tokchart.com/checkout/plans ; docs https://tokchart.com/docs/api (empty without JavaScript)
- EnsembleData pricing: https://ensembledata.com/pricing ; TikTok API: https://ensembledata.com/tiktok-api ; docs: https://ensembledata.com/apis/docs (first 100,000 of 426,935 characters read)
- Apify actor page: https://apify.com/datapeak/tiktok-creative-center ; public metadata: https://api.apify.com/v2/acts/datapeak~tiktok-creative-center
- Creative Center country list (third-party summary via web search, India absent; official Creative Center page needs JavaScript, unverified): https://apify.com/rastriq/tiktok-trends-scraper
- TikTok Terms of Service s.5: https://www.tiktok.com/legal/page/row/terms-of-service/en
- YouTube `videos.list`: https://developers.google.com/youtube/v3/docs/videos/list ; quota: https://developers.google.com/youtube/v3/determine_quota_cost ; policies: https://developers.google.com/youtube/terms/developer-policies
- Google Trends API alpha: https://developers.google.com/search/apis/trends
- SerpApi pricing: https://serpapi.com/pricing ; Trending Now: https://serpapi.com/google-trends-trending-now ; locations (IN listed): https://serpapi.com/google-trends-trending-now-locations ; legal shield page: 404, claim taken from pricing page
- Google v SerpApi (news summaries, filed 19 Dec 2025): https://ipwatchdog.com/2025/12/26/google-sues-serpapi-parasitic-scraping-circumvention-protection-measures/
- Meta Instagram hashtag search: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/hashtag-search

Not verified: who "JNX Global Infrastructure" is; Zyla's or Tokchart's India coverage; Zyla's refresh interval; Tokchart's API call limits and auth; Apify per-run platform usage; whether YouTube mostPopular returns a chart for IN; Google Trends alpha terms; credits per SerpApi Trending Now call; current status of Google v SerpApi.
