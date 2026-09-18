/**
 * sources.js — where to go for a fact, and clients for the ones that are free.
 *
 * WHY A CATALOG RATHER THAN FIFTY INTEGRATIONS
 *
 * The engines in this agent weigh far more factors than anyone can
 * enumerate in advance, and the whole point of automating this is that the
 * user should not have to predict everything the system will need. So the
 * design here is deliberately two-layer:
 *
 *   1. A CATALOG of real, named endpoints organized by what KIND of fact
 *      they answer. The agent can ask "where do I find traffic closures
 *      for Nevada" and get an actual URL pattern, its coverage, whether it
 *      needs a key, and how much to trust it — instead of guessing at a
 *      domain or inventing one.
 *   2. General-purpose fetching (read_web_page, fetch_json_api) for
 *      everything the catalog does not cover, which will always be most
 *      of the world.
 *
 * That way a question nobody anticipated still has a path: look in the
 * catalog, and if it is not there, go and read the web. Hard-coding one
 * client per source would have covered only the sources someone thought
 * of, which is exactly the failure this is meant to avoid.
 *
 * SOURCE QUALITY
 *
 * Each entry carries a quality tier from the Reno engine's own scale
 * (official 1.00 down to social 0.30), because these feed evidence
 * records whose weight depends on that number. It is recorded per source
 * rather than guessed per call, so the same source is always weighted the
 * same way.
 *
 * KEYS
 *
 * Entries that need an API key say which environment variable, and are
 * clearly marked as unavailable when it is unset — the agent should tell
 * the user which variable would unlock a source rather than silently
 * skipping it or pretending it looked.
 *
 * One real shortcut worth knowing: NASA, the FEC, Congress.gov,
 * Regulations.gov and USDA FoodData Central all issue their free keys
 * through the same underlying signup — api.data.gov — and a single key
 * from there works across all of them. That's why those five entries below
 * all list the same DATA_GOV_API_KEY variable rather than five separate
 * ones: one signup unlocks five sources, not five signups for five.
 * Everything else with a needsKey here (Census, OMDb, TMDb, Alpha Vantage,
 * FRED, balldontlie, Transitland, RestCountries, USAJobs) is a genuinely
 * separate signup — don't assume DATA_GOV_API_KEY covers those too.
 *
 * WHAT THIS EXPANSION DELIBERATELY LEFT OUT
 *
 * The catalog below was checked against each source's own current docs
 * before being written down (this file's whole ethic is never inventing a
 * fact, and a wrong base URL or a stale "no key needed" claim is exactly
 * that kind of invented fact). A few well-known ones got dropped for it:
 * WorldTimeAPI has been sunset outright; CoinCap and RestCountries' old v3
 * free tier are both gone, replaced by paid/keyed products (RestCountries'
 * new free tier is small enough it's listed below anyway, keyed and rate
 * limited, since it's still genuinely useful). If one of these breaks
 * again later, that's a reason to re-check the source, not a reason to
 * guess at a replacement shape and hard-code it anyway.
 */

import { assertSafeUrl } from "./web-read.js";

let _fetchImpl = null;
/** Test seam: swap the transport without needing a live network. */
export function _setFetchForTests(fn) {
  _fetchImpl = fn;
}
function theFetch() {
  return _fetchImpl || globalThis.fetch;
}

const UA = "DarklyAgent/1.0 (personal research agent; contact via app owner)";

/* ------------------------------------------------------------------ *
 * The catalog
 * ------------------------------------------------------------------ */

export const SOURCES = [
  // ---------- weather ----------
  {
    id: "nws",
    name: "National Weather Service",
    category: "weather",
    coverage: "United States",
    quality: "official",
    needsKey: null,
    baseUrl: "https://api.weather.gov",
    howTo:
      "GET /points/{lat},{lon} returns forecast URLs for that grid point; follow properties.forecastHourly for hour-by-hour conditions. The getWeather() client here does both steps.",
    goodFor: ["hourly temperature, precipitation probability, wind", "official US forecasts", "driving-week weather evidence"]
  },
  {
    id: "nws_alerts",
    name: "National Weather Service — active alerts",
    category: "alerts",
    coverage: "United States",
    quality: "official",
    needsKey: null,
    baseUrl: "https://api.weather.gov",
    howTo: "GET /alerts/active?point={lat},{lon} returns active watches, warnings and advisories.",
    goodFor: ["winter storm warnings", "wind advisories", "flood and heat alerts", "dangerous-travel evidence"]
  },
  {
    id: "open_meteo",
    name: "Open-Meteo",
    category: "weather",
    coverage: "Global",
    quality: "secondary",
    needsKey: null,
    baseUrl: "https://api.open-meteo.com/v1/forecast",
    howTo: "GET with latitude, longitude and an `hourly` list. No key, no signup.",
    goodFor: ["non-US forecasts", "a second opinion against NWS", "longer hourly horizons"]
  },
  {
    id: "openaq",
    name: "OpenAQ",
    category: "air_quality",
    coverage: "Global",
    quality: "secondary",
    needsKey: null,
    baseUrl: "https://api.openaq.org/v2/latest",
    howTo: "GET ?coordinates={lat},{lon}&radius=25000 for the nearest measurements.",
    goodFor: ["smoke and PM2.5 during wildfire season", "air-quality suppression evidence"]
  },
  {
    id: "airnow",
    name: "AirNow (EPA)",
    category: "air_quality",
    coverage: "United States",
    quality: "official",
    needsKey: "AIRNOW_API_KEY",
    baseUrl: "https://www.airnowapi.org/aq/observation/latLong/current",
    howTo: "GET with latitude, longitude, distance and API_KEY. Free key from airnowapi.org.",
    goodFor: ["official US AQI", "wildfire smoke advisories"]
  },

  // ---------- geography ----------
  {
    id: "nominatim",
    name: "Nominatim (OpenStreetMap)",
    category: "geocoding",
    coverage: "Global",
    quality: "secondary",
    needsKey: null,
    baseUrl: "https://nominatim.openstreetmap.org/search",
    howTo: "GET ?q={query}&format=json&limit=5. Requires a descriptive User-Agent and is rate limited to about one request per second.",
    goodFor: ["turning an address or venue name into coordinates", "finding a lat/lon to feed the weather sources"]
  },
  {
    id: "overpass",
    name: "Overpass API (OpenStreetMap)",
    category: "places",
    coverage: "Global",
    quality: "secondary",
    needsKey: null,
    baseUrl: "https://overpass-api.de/api/interpreter",
    howTo: "POST an Overpass QL query. The nearbyPlaces() client here wraps the common 'amenities near a point' case.",
    goodFor: ["bars, casinos, stadiums and venues near a point", "counting nightlife density in an area"]
  },
  {
    id: "google_maps",
    name: "Google Maps Platform",
    category: "places",
    coverage: "Global",
    quality: "organizer",
    needsKey: "GOOGLE_MAPS_API_KEY",
    baseUrl: "https://maps.googleapis.com/maps/api",
    howTo: "Places, Directions, Distance Matrix and Geocoding all live under this base and take a `key` parameter.",
    goodFor: ["travel time between two points", "business hours and popularity", "route and traffic estimates"]
  },

  // ---------- transport ----------
  {
    id: "nevada_511",
    name: "Nevada 511 / NDOT",
    category: "traffic",
    coverage: "Nevada",
    quality: "official",
    needsKey: null,
    baseUrl: "https://www.nvroads.com",
    howTo:
      "The public site publishes incidents, closures and construction. Check /List/Incidents and the map endpoints; the structure changes, so read the page rather than assuming a fixed JSON shape.",
    goodFor: ["Reno road closures", "I-80 and I-580 incidents", "construction affecting driving throughput"]
  },
  {
    id: "rtc_washoe",
    name: "RTC Washoe (Reno transit)",
    category: "transit",
    coverage: "Reno / Sparks",
    quality: "official",
    needsKey: null,
    baseUrl: "https://www.rtcwashoe.com",
    howTo: "Route, schedule and service-alert pages. GTFS feeds are usually published as static files under the same domain.",
    goodFor: ["bus service levels", "special-event shuttles", "transit as a rideshare substitute"]
  },
  {
    id: "aviationstack",
    name: "AviationStack",
    category: "aviation",
    coverage: "Global",
    quality: "secondary",
    needsKey: "AVIATIONSTACK_API_KEY",
    baseUrl: "https://api.aviationstack.com/v1/flights",
    howTo: "GET ?access_key={key}&arr_iata=RNO for arrivals. Free tier is limited.",
    goodFor: ["RNO arrival and departure banks", "airport demand evidence"]
  },
  {
    id: "rno_airport",
    name: "Reno-Tahoe International Airport",
    category: "aviation",
    coverage: "Reno",
    quality: "official",
    needsKey: null,
    baseUrl: "https://www.renoairport.com",
    howTo: "Publishes flight status pages and passenger statistics. Read the pages; there is no documented public JSON API.",
    goodFor: ["official passenger volume", "construction and access notices"]
  },

  // ---------- events ----------
  {
    id: "visit_reno_tahoe",
    name: "Visit Reno Tahoe",
    category: "events",
    coverage: "Reno / Tahoe",
    quality: "organizer",
    needsKey: null,
    baseUrl: "https://www.visitrenotahoe.com",
    howTo: "Events calendar pages, frequently marked up with schema.org Event JSON-LD that read_web_page extracts automatically.",
    goodFor: ["festivals and conventions", "tourism-wide event calendars"]
  },
  {
    id: "unr_events",
    name: "University of Nevada, Reno — events",
    category: "events",
    coverage: "Reno",
    quality: "organizer",
    needsKey: null,
    baseUrl: "https://www.unr.edu/events",
    howTo: "Campus calendar; Lawlor Events Center and Mackay Stadium schedules are usually linked from here.",
    goodFor: ["home games", "graduation and move-in", "concerts at Lawlor"]
  },
  {
    id: "ticketmaster",
    name: "Ticketmaster Discovery API",
    category: "events",
    coverage: "Global",
    quality: "ticketing",
    needsKey: "TICKETMASTER_API_KEY",
    baseUrl: "https://app.ticketmaster.com/discovery/v2/events.json",
    howTo: "GET ?apikey={key}&city=Reno&startDateTime=... Free developer key available.",
    goodFor: ["concert and sports listings with times and venues", "attendance-capacity hints"]
  },

  // ---------- news and reference ----------
  {
    id: "gdelt",
    name: "GDELT news index",
    category: "news",
    coverage: "Global",
    quality: "aggregator",
    needsKey: null,
    baseUrl: "https://api.gdeltproject.org/api/v2/doc/doc",
    howTo: "GET ?query={terms}&mode=ArtList&format=json for recent worldwide coverage of a topic.",
    goodFor: ["finding news coverage of an event", "checking whether something was reported at all"]
  },
  {
    id: "wikipedia",
    name: "Wikipedia API",
    category: "reference",
    coverage: "Global",
    quality: "secondary",
    needsKey: null,
    baseUrl: "https://en.wikipedia.org/api/rest_v1",
    howTo: "GET /page/summary/{title} for a short factual summary of a subject.",
    goodFor: ["background on a venue, team or place", "resolving what something is before researching it"]
  },
  {
    id: "usgs_quakes",
    name: "USGS earthquake feed",
    category: "seismic",
    coverage: "Global",
    quality: "official",
    needsKey: null,
    baseUrl: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary",
    howTo: "GET /all_day.geojson (also all_hour, all_week, and magnitude-filtered variants).",
    goodFor: ["recent seismic activity", "an unusual disruption nobody would have thought to check for"]
  },

  // ---------- markets ----------
  {
    id: "alpaca",
    name: "Alpaca market data",
    category: "markets",
    coverage: "US equities",
    quality: "official",
    needsKey: "ALPACA_KEY_ID",
    baseUrl: "https://data.alpaca.markets",
    howTo: "Already wired into this agent through trading.js — use get_quote and get_market_data rather than calling it directly.",
    goodFor: ["live quotes", "historical bars"]
  },

  // ---------- currency & crypto ----------
  {
    id: "frankfurter",
    name: "Frankfurter (ECB exchange rates)",
    category: "currency",
    coverage: "Global (ECB reference rates)",
    quality: "official",
    needsKey: null,
    baseUrl: "https://api.frankfurter.dev/v1",
    howTo: "GET /latest?base=USD&symbols=EUR,GBP for current rates, or /2026-01-01..2026-06-01 for a historical range. No key, no rate limit published.",
    goodFor: ["currency conversion", "historical exchange-rate trends", "whether a foreign purchase is a good time relative to recent rates"]
  },
  {
    id: "coingecko",
    name: "CoinGecko",
    category: "crypto",
    coverage: "Global",
    quality: "secondary",
    needsKey: null,
    baseUrl: "https://api.coingecko.com/api/v3",
    howTo: "GET /simple/price?ids=bitcoin&vs_currencies=usd for spot prices; /coins/markets for a ranked list. Public tier is unauthenticated but rate-limited (roughly 10-30 calls/minute) — a key (COINGECKO_API_KEY, sent as x-cg-demo-api-key) raises that if it starts getting throttled.",
    goodFor: ["crypto spot prices", "market cap and volume rankings", "a quick cross-check, never a trading signal on its own"]
  },

  // ---------- economics & government finance ----------
  {
    id: "fred",
    name: "FRED (Federal Reserve Economic Data)",
    category: "economics",
    coverage: "United States (some global series)",
    quality: "official",
    needsKey: "FRED_API_KEY",
    baseUrl: "https://api.stlouisfed.org/fred",
    howTo: "GET /series/observations?series_id=CPIAUCSL&api_key={key}&file_type=json for a named series. Free key from research.stlouisfed.org/useraccount/apikey.",
    goodFor: ["inflation, unemployment, interest rate series", "whether a macro claim in the news is actually true", "long historical economic context"]
  },
  {
    id: "world_bank",
    name: "World Bank Open Data",
    category: "economics",
    coverage: "Global, by country",
    quality: "official",
    needsKey: null,
    baseUrl: "https://api.worldbank.org/v2",
    howTo: "GET /country/{iso3}/indicator/{code}?format=json, e.g. NY.GDP.MKTP.CD for GDP. No key.",
    goodFor: ["country-level GDP, population, development indicators", "comparing countries on a specific metric"]
  },
  {
    id: "sec_edgar",
    name: "SEC EDGAR",
    category: "economics",
    coverage: "US public companies",
    quality: "official",
    needsKey: null,
    baseUrl: "https://data.sec.gov",
    howTo: "GET /submissions/CIK{10-digit-cik}.json for a company's filing history, or /api/xbrl/companyfacts/CIK{cik}.json for structured financials. No key, but the SEC requires a real descriptive User-Agent header (name + contact) on every request or it will 403.",
    goodFor: ["a company's actual filed financials, not a paraphrase of them", "insider transaction and ownership filings", "verifying a claim about a public company against its own filing"]
  },
  {
    id: "alpha_vantage",
    name: "Alpha Vantage",
    category: "economics",
    coverage: "Global equities, forex, crypto",
    quality: "secondary",
    needsKey: "ALPHA_VANTAGE_API_KEY",
    baseUrl: "https://www.alphavantage.co/query",
    howTo: "GET ?function=TIME_SERIES_DAILY&symbol=AAPL&apikey={key}. Free key, but the free tier is heavily rate-limited (historically ~25 requests/day) — Alpaca is the live-quote source of record for this agent's trading tools; use this only for symbols or history Alpaca doesn't cover.",
    goodFor: ["a symbol outside Alpaca's coverage", "fundamental data (earnings, income statements)", "forex pairs"]
  },
  {
    id: "usaspending",
    name: "USAspending.gov",
    category: "civic",
    coverage: "United States (federal spending)",
    quality: "official",
    needsKey: null,
    baseUrl: "https://api.usaspending.gov/api/v2",
    howTo: "POST /search/spending_by_award/ with a filter object for contracts, grants and loans; GET /agency/{toptier_code}/ for an agency's budget. No key.",
    goodFor: ["how much the federal government actually spent on something", "which companies hold contracts with a given agency"]
  },

  // ---------- civic & government data ----------
  {
    id: "congress_gov",
    name: "Congress.gov API",
    category: "civic",
    coverage: "United States",
    quality: "official",
    needsKey: "DATA_GOV_API_KEY",
    baseUrl: "https://api.congress.gov/v3",
    howTo: "GET /bill/{congress}/{billType}/{billNumber}?api_key={key} for a specific bill; /bill/{congress} lists recent ones. Key is the same api.data.gov signup used by NASA, the FEC, Regulations.gov and USDA FoodData Central (see this file's header note).",
    goodFor: ["what a bill actually says or where it stands", "a member's sponsored legislation", "checking a claim about pending federal legislation"]
  },
  {
    id: "fec",
    name: "FEC (Federal Election Commission)",
    category: "civic",
    coverage: "United States",
    quality: "official",
    needsKey: "DATA_GOV_API_KEY",
    baseUrl: "https://api.open.fec.gov/v1",
    howTo: "GET /candidates/search/?q={name}&api_key={key}; the literal value DEMO_KEY also works for light, non-production testing. Same api.data.gov key as Congress.gov, NASA, Regulations.gov and USDA FoodData Central.",
    goodFor: ["campaign finance and donor records", "verifying a claim about who funded a campaign"]
  },
  {
    id: "regulations_gov",
    name: "Regulations.gov API",
    category: "civic",
    coverage: "United States",
    quality: "official",
    needsKey: "DATA_GOV_API_KEY",
    baseUrl: "https://api.regulations.gov/v4",
    howTo: "GET /documents?filter[searchTerm]={terms}&api_key={key}. Same api.data.gov key as Congress.gov, the FEC and NASA.",
    goodFor: ["a proposed federal rule and its public comments", "whether something is actually in a formal rulemaking process or just rumored"]
  },
  {
    id: "census",
    name: "US Census Bureau API",
    category: "civic",
    coverage: "United States",
    quality: "official",
    needsKey: "CENSUS_API_KEY",
    baseUrl: "https://api.census.gov/data",
    howTo: "GET /{year}/acs/acs5?get=NAME,B01003_001E&for=place:*&in=state:{fips}&key={key} for population by place, as one example — the dataset and variable codes change per survey year, so check the specific year's variable list before assuming a code. This is its own separate signup, NOT the shared api.data.gov key.",
    goodFor: ["population, income, housing by city/county/tract", "demographic context for a market or neighborhood"]
  },
  {
    id: "usajobs",
    name: "USAJobs API",
    category: "civic",
    coverage: "United States (federal jobs)",
    quality: "official",
    needsKey: "USAJOBS_API_KEY",
    baseUrl: "https://data.usajobs.gov/api",
    howTo: "GET /search?Keyword={terms} with headers Authorization-Key: {key} and User-Agent: {the email used to register}. Its own separate signup at developer.usajobs.gov.",
    goodFor: ["current federal job openings", "typical federal pay grades for a role"]
  },

  // ---------- space ----------
  {
    id: "nasa",
    name: "NASA Open APIs",
    category: "space",
    coverage: "Global",
    quality: "official",
    needsKey: "DATA_GOV_API_KEY",
    baseUrl: "https://api.nasa.gov",
    howTo: "GET /planetary/apod?api_key={key} for the astronomy picture of the day; /neo/rest/v1/feed for near-Earth asteroids; /DONKI/... for space weather. The literal value DEMO_KEY works at a low rate limit without signing up. Same key as Congress.gov, the FEC, Regulations.gov and USDA FoodData Central.",
    goodFor: ["near-Earth object and asteroid pass data", "space weather (solar flares, geomagnetic storms)", "an interesting daily image with real astronomical context"]
  },
  {
    id: "open_notify",
    name: "Open Notify",
    category: "space",
    coverage: "Global",
    quality: "secondary",
    needsKey: null,
    baseUrl: "http://api.open-notify.org",
    howTo: "GET /iss-now.json for the ISS's current lat/lon; /astros.json for who is currently in space. A small community-run project, not an official NASA service — it has occasional downtime, so treat a failed request as \"unavailable right now\", not as \"the ISS isn't up there.\"",
    goodFor: ["where the ISS is right now", "how many people are currently in space, on which craft"]
  },
  {
    id: "sunrise_sunset",
    name: "Sunrise-Sunset.org",
    category: "space",
    coverage: "Global",
    quality: "secondary",
    needsKey: null,
    baseUrl: "https://api.sunrise-sunset.org/json",
    howTo: "GET ?lat={lat}&lng={lon}&date=today&formatted=0 for sunrise, sunset, dawn, dusk and solar noon in UTC. No key.",
    goodFor: ["exact sunrise/sunset for a driving or event schedule", "how much daylight a given date/location has"]
  },

  // ---------- health ----------
  {
    id: "openfda",
    name: "openFDA",
    category: "health",
    coverage: "United States",
    quality: "official",
    needsKey: null,
    baseUrl: "https://api.fda.gov",
    howTo: "GET /drug/event.json?search=... for adverse event reports, /food/enforcement.json for recalls, /device/... for medical devices. Usable without a key at a modest rate limit; a DATA_GOV_API_KEY raises it.",
    goodFor: ["drug adverse-event reports", "food and drug recalls", "checking whether a specific recall is real before repeating it"]
  },
  {
    id: "disease_sh",
    name: "disease.sh",
    category: "health",
    coverage: "Global",
    quality: "aggregator",
    needsKey: null,
    baseUrl: "https://disease.sh/v3",
    howTo: "GET /covid-19/countries/{country} or /covid-19/historical for case/death time series, aggregated from JHU and other public trackers. No key.",
    goodFor: ["COVID-19 case and death trends by country", "a quick historical check, not a real-time clinical source"]
  },
  {
    id: "who_gho",
    name: "WHO Global Health Observatory",
    category: "health",
    coverage: "Global",
    quality: "official",
    needsKey: null,
    baseUrl: "https://ghoapi.who.int/api",
    howTo: "GET /{IndicatorCode} for a named indicator's values by country/year, e.g. WHOSIS_000001 for life expectancy. No key.",
    goodFor: ["cross-country public health indicators", "life expectancy, disease burden, health system stats"]
  },
  {
    id: "usda_fooddata",
    name: "USDA FoodData Central",
    category: "health",
    coverage: "United States (also many branded/global products)",
    quality: "official",
    needsKey: "DATA_GOV_API_KEY",
    baseUrl: "https://api.nal.usda.gov/fdc/v1",
    howTo: "GET /foods/search?query={food}&api_key={key} for nutrition facts on a named food or branded product. Same key as NASA, Congress.gov, the FEC and Regulations.gov.",
    goodFor: ["nutrition facts for a specific food or brand", "verifying a nutrition claim rather than guessing at it"]
  },
  {
    id: "open_food_facts",
    name: "Open Food Facts",
    category: "health",
    coverage: "Global (crowd-sourced)",
    quality: "secondary",
    needsKey: null,
    baseUrl: "https://world.openfoodfacts.org/api/v2",
    howTo: "GET /product/{barcode}.json for a specific product's ingredients, nutrition and additives. No key; crowd-sourced, so coverage and accuracy vary by product.",
    goodFor: ["ingredients and additives on packaged food", "a barcode lookup when the user names a product"]
  },

  // ---------- nature & environment ----------
  {
    id: "inaturalist",
    name: "iNaturalist",
    category: "nature",
    coverage: "Global (crowd-sourced observations)",
    quality: "secondary",
    needsKey: null,
    baseUrl: "https://api.inaturalist.org/v1",
    howTo: "GET /observations?lat={lat}&lng={lon}&radius=25 for recent wildlife/plant sightings near a point. No key.",
    goodFor: ["what species have actually been spotted near a place recently", "an unusual sighting (e.g. bear activity) nobody would think to check for"]
  },
  {
    id: "gbif",
    name: "GBIF (Global Biodiversity Information Facility)",
    category: "nature",
    coverage: "Global",
    quality: "official",
    needsKey: null,
    baseUrl: "https://api.gbif.org/v1",
    howTo: "GET /occurrence/search?scientificName={name}&decimalLatitude={lat}&decimalLongitude={lon} for scientifically curated occurrence records. No key.",
    goodFor: ["a more rigorous species-occurrence check than iNaturalist's crowd-sourced feed", "range and distribution questions"]
  },
  {
    id: "noaa_tides",
    name: "NOAA Tides & Currents",
    category: "marine",
    coverage: "United States coastal waters",
    quality: "official",
    needsKey: null,
    baseUrl: "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter",
    howTo: "GET ?product=predictions&station={id}&date=today&format=json for a tide station's high/low times. Station IDs are looked up separately from NOAA's station list. No key.",
    goodFor: ["tide times for a coastal location", "water level and current predictions"]
  },
  {
    id: "epa_envirofacts",
    name: "EPA Envirofacts",
    category: "environment",
    coverage: "United States",
    quality: "official",
    needsKey: null,
    baseUrl: "https://data.epa.gov/efservice",
    howTo: "REST path segments rather than query params, e.g. /PCS_PERMIT_FACT/STATE_CODE/NV/JSON. Covers water discharge permits, Superfund sites, toxic release inventory and more — check the specific table's documented column names before assuming one. No key.",
    goodFor: ["Superfund/contamination sites near a location", "permitted pollution discharge records", "a specific regulatory claim about a facility"]
  },

  // ---------- sports ----------
  {
    id: "thesportsdb",
    name: "TheSportsDB",
    category: "sports",
    coverage: "Global",
    quality: "secondary",
    needsKey: null,
    baseUrl: "https://www.thesportsdb.com/api/v1/json",
    howTo: "GET /123/eventsnext.php?id={teamId} etc. — 123 is the published free test key, usable directly in the URL path at a 30 req/min limit. A paid Patreon key raises the limit and unlocks the v2 API.",
    goodFor: ["team schedules and recent results outside the major US leagues this agent already covers", "league standings", "player and team metadata"]
  },
  {
    id: "balldontlie",
    name: "balldontlie",
    category: "sports",
    coverage: "NBA, NFL, MLB, NHL, EPL (separate subdomains)",
    quality: "secondary",
    needsKey: "BALLDONTLIE_API_KEY",
    baseUrl: "https://api.balldontlie.io",
    howTo: "GET /nba/v1/games?dates[]=2026-01-01 with header Authorization: {key}. Free tier has generous limits for basic endpoints; sign up at app.balldontlie.io.",
    goodFor: ["real box scores and player stats", "a specific game's final score and stat line"]
  },

  // ---------- reference & entertainment ----------
  {
    id: "open_library",
    name: "Open Library",
    category: "reference",
    coverage: "Global",
    quality: "secondary",
    needsKey: null,
    baseUrl: "https://openlibrary.org",
    howTo: "GET /search.json?q={title or author} for book metadata; /isbn/{isbn}.json for a specific edition. No key.",
    goodFor: ["looking up a book's real publication details", "an author's bibliography"]
  },
  {
    id: "google_books",
    name: "Google Books API",
    category: "reference",
    coverage: "Global",
    quality: "secondary",
    needsKey: null,
    baseUrl: "https://www.googleapis.com/books/v1",
    howTo: "GET /volumes?q={terms} for search results including descriptions and preview links. Basic search works without a key; a key raises the rate limit.",
    goodFor: ["book search with descriptions", "cross-checking Open Library's result against a second source"]
  },
  {
    id: "musicbrainz",
    name: "MusicBrainz",
    category: "reference",
    coverage: "Global",
    quality: "secondary",
    needsKey: null,
    baseUrl: "https://musicbrainz.org/ws/2",
    howTo: "GET /artist/?query={name}&fmt=json, /release/?query={album}&fmt=json, etc. No key, but requires a descriptive User-Agent and is rate-limited to about 1 request/second.",
    goodFor: ["canonical artist, album and track metadata", "verifying a release date or credited artist"]
  },
  {
    id: "omdb",
    name: "OMDb API",
    category: "reference",
    coverage: "Global",
    quality: "secondary",
    needsKey: "OMDB_API_KEY",
    baseUrl: "https://www.omdbapi.com",
    howTo: "GET ?t={title}&apikey={key} for a specific movie/show's ratings, cast and plot. Free key from omdbapi.com/apikey.aspx.",
    goodFor: ["a movie or show's real rating, cast and release year", "settling a factual dispute about a film"]
  },
  {
    id: "tmdb",
    name: "TMDb (The Movie Database)",
    category: "reference",
    coverage: "Global",
    quality: "secondary",
    needsKey: "TMDB_API_KEY",
    baseUrl: "https://api.themoviedb.org/3",
    howTo: "GET /search/movie?query={title}&api_key={key}. Free key from themoviedb.org/settings/api. Broader and more current than OMDb for new releases.",
    goodFor: ["upcoming release dates", "cast/crew credits", "a second opinion against OMDb"]
  },
  {
    id: "dictionary_api",
    name: "Free Dictionary API",
    category: "reference",
    coverage: "English (some other languages)",
    quality: "secondary",
    needsKey: null,
    baseUrl: "https://api.dictionaryapi.dev/api/v2",
    howTo: "GET /entries/en/{word} for definitions, phonetics and audio pronunciation links. No key.",
    goodFor: ["a real definition instead of a remembered one", "checking whether a word means what it's being used to mean"]
  },
  {
    id: "open_trivia_db",
    name: "Open Trivia Database",
    category: "reference",
    coverage: "Global",
    quality: "secondary",
    needsKey: null,
    baseUrl: "https://opentdb.com/api.php",
    howTo: "GET ?amount=10&category={id}&difficulty=easy for a batch of real trivia questions with answers. No key.",
    goodFor: ["generating an actual trivia round rather than making questions up", "a category/difficulty-tagged question bank"]
  },
  {
    id: "numbers_api",
    name: "Numbers API",
    category: "reference",
    coverage: "Global",
    quality: "secondary",
    needsKey: null,
    baseUrl: "http://numbersapi.com",
    howTo: "GET /{number}/trivia, /{month}/{day}/date, or /{number}/math for a real (sourced, if imperfectly) trivia fact about that number or date. No key.",
    goodFor: ["a fun aside about a date or number that's actually sourced rather than invented on the spot"]
  },
  {
    id: "rest_countries",
    name: "REST Countries",
    category: "reference",
    coverage: "Global",
    quality: "secondary",
    needsKey: "RESTCOUNTRIES_API_KEY",
    baseUrl: "https://api.restcountries.com/countries/v5",
    howTo: "GET /name/{country} with header Authorization: Bearer {key}. This used to be a no-key API; as of the v5 relaunch it needs a free account and the free tier is capped at 500 requests/month, so use it deliberately rather than for routine lookups.",
    goodFor: ["capital, currency, languages, borders and region for a country", "flag and calling-code lookups"]
  },
  {
    id: "nager_date",
    name: "Nager.Date public holidays",
    category: "reference",
    coverage: "200+ countries",
    quality: "secondary",
    needsKey: null,
    baseUrl: "https://date.nager.at/api/v3",
    howTo: "GET /PublicHolidays/{year}/{countryCode} for that country's official holidays that year. No key.",
    goodFor: ["whether a given date is a public holiday somewhere, which affects traffic, business hours and demand", "planning around a country's actual holiday calendar rather than a guess"]
  },

  // ---------- transport (broader than Nevada) ----------
  {
    id: "opensky",
    name: "OpenSky Network",
    category: "aviation",
    coverage: "Global",
    quality: "secondary",
    needsKey: null,
    baseUrl: "https://opensky-network.org/api",
    howTo: "GET /states/all?lamin={lat}&lomin={lon}&lamax={lat}&lomax={lon} for live aircraft positions in a bounding box. Anonymous access is rate-limited (roughly one request per 10 seconds); a free account raises that.",
    goodFor: ["live air traffic over a region, not just one airport's schedule", "an unusual amount of air activity nobody would think to check for"]
  },
  {
    id: "transitland",
    name: "Transitland",
    category: "transit",
    coverage: "Global (aggregates thousands of transit agencies' GTFS feeds)",
    quality: "aggregator",
    needsKey: "TRANSITLAND_API_KEY",
    baseUrl: "https://transit.land/api/v2",
    howTo: "GET /rest/routes?apikey={key}&lat={lat}&lon={lon}&radius=1000 for transit routes near a point, in any covered city — not just Reno/Sparks. Free key from transit.land.",
    goodFor: ["transit coverage and service levels outside RTC Washoe's area", "whether a destination is realistically transit-accessible"]
  }
];

/** Which catalog entries are usable on this deployment right now. */
export function availability(env = process.env) {
  return SOURCES.map((s) => ({
    id: s.id,
    name: s.name,
    category: s.category,
    coverage: s.coverage,
    quality: s.quality,
    available: !s.needsKey || Boolean(env[s.needsKey] && String(env[s.needsKey]).trim()),
    needsKey: s.needsKey || undefined,
    unlockHint: s.needsKey && !env[s.needsKey] ? `Set ${s.needsKey} to enable ${s.name}.` : undefined
  }));
}

/**
 * Search the catalog.
 *
 * Deliberately returns the how-to text as well as the URL, because a base
 * URL without knowing the shape of the request is not actually usable,
 * and an agent that has to guess the path will guess wrong.
 */
export function findSources({ category, query, availableOnly = false, env = process.env } = {}) {
  const q = query ? String(query).toLowerCase() : null;

  let results = SOURCES.filter((s) => {
    if (category && s.category !== category) return false;
    if (!q) return true;
    const haystack = [s.id, s.name, s.category, s.coverage, s.howTo, ...(s.goodFor || [])].join(" ").toLowerCase();
    return haystack.includes(q);
  });

  if (availableOnly) {
    results = results.filter((s) => !s.needsKey || (env[s.needsKey] && String(env[s.needsKey]).trim()));
  }

  return {
    count: results.length,
    categories: [...new Set(SOURCES.map((s) => s.category))].sort(),
    sources: results.map((s) => ({
      ...s,
      available: !s.needsKey || Boolean(env[s.needsKey] && String(env[s.needsKey]).trim()),
      unlockHint: s.needsKey && !env[s.needsKey] ? `Set ${s.needsKey} to enable this source.` : undefined
    })),
    note:
      "This catalog covers sources someone thought to list. It is a starting point, not a boundary — anything not here can still be reached with web_search and read_web_page."
  };
}

/* ------------------------------------------------------------------ *
 * Shared fetch helper
 * ------------------------------------------------------------------ */

async function getJson(url, { timeoutMs = 15000, headers = {}, _resolve } = {}) {
  await assertSafeUrl(url, _resolve ? { _resolve } : {});

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await theFetch()(url, {
      headers: { Accept: "application/geo+json,application/json", "User-Agent": UA, ...headers },
      signal: controller.signal
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError") throw new Error(`Timed out after ${timeoutMs}ms fetching ${new URL(url).hostname}`);
    throw new Error(`Could not reach ${new URL(url).hostname}: ${e.message}`);
  }
  clearTimeout(timer);

  if (!res.ok) throw new Error(`${new URL(url).hostname} returned HTTP ${res.status}`);
  try {
    return await res.json();
  } catch (e) {
    throw new Error(`${new URL(url).hostname} returned data that is not valid JSON`);
  }
}

function requireCoords(lat, lon) {
  const la = Number(lat);
  const lo = Number(lon);
  if (!Number.isFinite(la) || la < -90 || la > 90) throw new Error("`lat` must be a number between -90 and 90.");
  if (!Number.isFinite(lo) || lo < -180 || lo > 180) throw new Error("`lon` must be a number between -180 and 180.");
  // NWS wants four decimals; more makes it redirect.
  return { lat: Number(la.toFixed(4)), lon: Number(lo.toFixed(4)) };
}

/* ------------------------------------------------------------------ *
 * Weather
 * ------------------------------------------------------------------ */

/**
 * Hourly forecast from the National Weather Service.
 *
 * Two hops, because that is how the API works: a point lookup returns the
 * URL of the forecast for that grid cell. The client follows it rather
 * than making the caller know that.
 */
export async function getWeather({ lat, lon, hours = 48, _resolve } = {}) {
  const c = requireCoords(lat, lon);

  const point = await getJson(`https://api.weather.gov/points/${c.lat},${c.lon}`, { _resolve });
  const hourlyUrl = point?.properties?.forecastHourly;
  if (!hourlyUrl) {
    throw new Error("The NWS point lookup did not include an hourly forecast URL (this usually means the coordinates are outside US coverage — try Open-Meteo instead).");
  }

  const place = point?.properties?.relativeLocation?.properties;
  const forecast = await getJson(hourlyUrl, { _resolve });
  const periods = forecast?.properties?.periods || [];

  return {
    source: "National Weather Service",
    quality: "official",
    location: place ? `${place.city}, ${place.state}` : `${c.lat},${c.lon}`,
    updated: forecast?.properties?.updated || null,
    periods: periods.slice(0, Math.max(1, Math.min(168, hours))).map((p) => ({
      start: p.startTime,
      end: p.endTime,
      temperature: p.temperature,
      temperatureUnit: p.temperatureUnit,
      precipitationChance: p.probabilityOfPrecipitation?.value ?? null,
      windSpeed: p.windSpeed,
      windDirection: p.windDirection,
      shortForecast: p.shortForecast,
      isDaytime: p.isDaytime
    }))
  };
}

/** Active watches, warnings and advisories for a point. */
export async function getAlerts({ lat, lon, _resolve } = {}) {
  const c = requireCoords(lat, lon);
  const data = await getJson(`https://api.weather.gov/alerts/active?point=${c.lat},${c.lon}`, { _resolve });
  const features = data?.features || [];

  return {
    source: "National Weather Service",
    quality: "official",
    count: features.length,
    alerts: features.map((f) => ({
      event: f.properties?.event || null,
      severity: f.properties?.severity || null,
      urgency: f.properties?.urgency || null,
      certainty: f.properties?.certainty || null,
      onset: f.properties?.onset || f.properties?.effective || null,
      ends: f.properties?.ends || f.properties?.expires || null,
      headline: f.properties?.headline || null,
      area: f.properties?.areaDesc || null
    })),
    note: features.length === 0 ? "No active alerts for this location." : undefined
  };
}

/** Open-Meteo hourly forecast: no key, global coverage, useful as a cross-check. */
export async function getOpenMeteo({ lat, lon, timezone = "America/Los_Angeles", _resolve } = {}) {
  const c = requireCoords(lat, lon);
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${c.lat}&longitude=${c.lon}` +
    `&hourly=temperature_2m,precipitation_probability,wind_speed_10m,visibility` +
    `&timezone=${encodeURIComponent(timezone)}`;
  const data = await getJson(url, { _resolve });
  const h = data?.hourly || {};
  const times = h.time || [];

  return {
    source: "Open-Meteo",
    quality: "secondary",
    timezone: data?.timezone || timezone,
    periods: times.map((t, i) => ({
      start: t,
      temperature: h.temperature_2m?.[i] ?? null,
      precipitationChance: h.precipitation_probability?.[i] ?? null,
      windSpeed: h.wind_speed_10m?.[i] ?? null,
      visibility: h.visibility?.[i] ?? null
    }))
  };
}

/* ------------------------------------------------------------------ *
 * Geography
 * ------------------------------------------------------------------ */

export async function geocode({ query, limit = 5, _resolve } = {}) {
  if (!query || typeof query !== "string") throw new Error("`query` is required.");
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=${Math.max(1, Math.min(10, limit))}`;
  const data = await getJson(url, { _resolve });

  return {
    source: "Nominatim (OpenStreetMap)",
    quality: "secondary",
    query,
    results: (Array.isArray(data) ? data : []).map((r) => ({
      name: r.display_name,
      lat: Number(r.lat),
      lon: Number(r.lon),
      type: r.type || null,
      importance: r.importance ?? null
    }))
  };
}

/**
 * Amenities near a point, via Overpass.
 *
 * Useful for the kind of factor nobody enumerates in advance — how many
 * bars are inside a quarter mile of a venue, whether a stadium has
 * parking around it.
 */
export async function nearbyPlaces({ lat, lon, amenity = "bar", radiusMeters = 800, limit = 40, _resolve } = {}) {
  const c = requireCoords(lat, lon);
  // Reject rather than sanitize-and-continue. Stripping the unsafe
  // characters out of `"](around:99999,0,0);out;//` leaves "aroundout",
  // which is harmless but is also a real query for an amenity that does
  // not exist — so it returns zero results, and "no bars near the venue"
  // is a conclusion someone might act on. A malformed amenity should be
  // an error, not an empty neighborhood.
  const raw = String(amenity);
  const safeAmenity = raw.replace(/[^a-z_]/gi, "");
  if (!safeAmenity || safeAmenity !== raw) {
    throw new Error(
      `\`amenity\` must be a simple OSM amenity name like bar, restaurant, casino or theatre — got ${JSON.stringify(raw)}.`
    );
  }
  const radius = Math.max(50, Math.min(5000, Number(radiusMeters) || 800));

  const ql = `[out:json][timeout:20];node["amenity"="${safeAmenity}"](around:${radius},${c.lat},${c.lon});out ${Math.max(1, Math.min(200, limit))};`;
  const url = "https://overpass-api.de/api/interpreter";

  await assertSafeUrl(url, _resolve ? { _resolve } : {});
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  let res;
  try {
    res = await theFetch()(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
      body: `data=${encodeURIComponent(ql)}`,
      signal: controller.signal
    });
  } catch (e) {
    clearTimeout(timer);
    throw new Error(`Could not reach Overpass: ${e.message}`);
  }
  clearTimeout(timer);
  if (!res.ok) throw new Error(`Overpass returned HTTP ${res.status}`);

  const data = await res.json();
  const elements = data?.elements || [];

  return {
    source: "Overpass (OpenStreetMap)",
    quality: "secondary",
    amenity: safeAmenity,
    radiusMeters: radius,
    count: elements.length,
    places: elements.map((e) => ({ name: e.tags?.name || null, lat: e.lat, lon: e.lon })).filter((p) => p.name)
  };
}

/* ------------------------------------------------------------------ *
 * Weather -> Reno engine evidence
 * ------------------------------------------------------------------ */

/**
 * Turn a forecast and active alerts into evidence records the Reno engine
 * can actually consume.
 *
 * This is the point of the whole file: the engine weighs far more factors
 * than anyone wants to type in by hand, and the spec is explicit that
 * weather evidence must carry a real applicability window and a real
 * source confidence rather than being asserted week-wide.
 *
 * Direction is taken from the forecast rather than assumed. The saved
 * research says rain is associated with higher ridehailing use while
 * strong wind suppresses it, so those push opposite ways; anything
 * genuinely unclear produces no record at all, because the spec's rule is
 * that missing evidence stays neutral and is never invented.
 */
export function weatherToEvidence(forecast, alerts = null) {
  const evidence = [];
  const periods = forecast?.periods || [];

  for (const p of periods) {
    if (!p.start) continue;
    const end = p.end || new Date(new Date(p.start).getTime() + 3600_000).toISOString();
    const text = String(p.shortForecast || "").toLowerCase();
    const precip = Number(p.precipitationChance);
    const windMph = parseInt(String(p.windSpeed || "").replace(/[^0-9]/g, ""), 10);

    // Rain: demand-positive, scaled by how likely it is.
    if (Number.isFinite(precip) && precip >= 30 && /rain|shower|drizzle|storm/.test(text)) {
      evidence.push({
        family: "weather",
        label: `Rain likely (${precip}%)`,
        value: Math.min(1.2, 0.3 + (precip / 100) * 0.9),
        sourceType: "official",
        source: forecast.source || "National Weather Service",
        note: p.shortForecast,
        start: p.start,
        end
      });
    }

    // Snow and ice: suppression and friction, not a demand bonus.
    if (/snow|ice|freezing|blizzard|sleet/.test(text)) {
      evidence.push({
        family: "safety_suppression",
        label: `Winter conditions: ${p.shortForecast}`,
        value: /blizzard|heavy snow|freezing rain/.test(text) ? 1.5 : 0.8,
        sourceType: "official",
        source: forecast.source || "National Weather Service",
        note: p.shortForecast,
        start: p.start,
        end
      });
    }

    // Strong wind suppresses activity per the saved research basis.
    if (Number.isFinite(windMph) && windMph >= 25) {
      evidence.push({
        family: "weather",
        label: `Strong wind (${p.windSpeed})`,
        value: -Math.min(1, (windMph - 20) / 25),
        sourceType: "official",
        source: forecast.source || "National Weather Service",
        note: `Wind ${p.windSpeed}`,
        start: p.start,
        end
      });
    }
  }

  for (const a of alerts?.alerts || []) {
    if (!a.onset) continue;
    const severe = /extreme|severe/i.test(a.severity || "");
    const moderate = /moderate/i.test(a.severity || "");
    evidence.push({
      family: "safety_suppression",
      label: a.event || "Weather alert",
      value: severe ? 2 : moderate ? 1.2 : 0.6,
      sourceType: "official",
      source: alerts.source || "National Weather Service",
      note: a.headline || a.event || undefined,
      start: a.onset,
      end: a.ends || new Date(new Date(a.onset).getTime() + 12 * 3600_000).toISOString()
    });
  }

  return {
    count: evidence.length,
    evidence,
    note:
      evidence.length === 0
        ? "The forecast contained nothing that meets the threshold for a weather evidence record. That is a neutral result, not a problem: the engine treats missing evidence as neutral by design and inventing a record would corrupt the ranking."
        : "Each record carries the exact hours it applies to and official source confidence. Direction comes from the forecast, not from an assumption that weather is good or bad for driving."
  };
}
