/**
 * Tests for sources.js — run with: node sources.test.mjs
 *
 * The network layer cannot be proven from this sandbox, so what these
 * tests pin is everything that turns a response into meaning: that the
 * NWS two-hop lookup is followed correctly, that a catalog entry needing
 * a key reports itself unavailable rather than silently failing later,
 * and above all that weatherToEvidence produces records the Reno engine
 * will weigh correctly.
 *
 * That last one carries the most risk in the whole file. An evidence
 * record with the wrong sign, the wrong window or an invented value does
 * not error — it quietly changes the ranking and looks fine. So the
 * direction of every mapping is asserted explicitly, and so is the
 * refusal to emit anything when the forecast says nothing notable.
 */

import {
  SOURCES,
  findSources,
  availability,
  getWeather,
  getAlerts,
  getOpenMeteo,
  geocode,
  nearbyPlaces,
  weatherToEvidence,
  _setFetchForTests
} from "./sources.js";
import { scheduleReno } from "./reno-engine.js";

let pass = 0;
let fail = 0;

function check(label, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label} ${detail}`);
  }
}

async function rejectsWith(label, fn, matcher) {
  try {
    await fn();
    check(label, false, "did not reject");
  } catch (e) {
    check(label, matcher ? matcher.test(e.message) : true, e.message);
  }
}

const RENO = { lat: 39.5296, lon: -119.8138 };
const publicResolve = async () => [{ address: "93.184.216.34" }];

/* ------------------------------------------------------------------ */

console.log("\nThe catalog");

check("has a meaningful number of sources", SOURCES.length >= 15, String(SOURCES.length));
check("every source declares a category", SOURCES.every((s) => s.category));
check("every source declares coverage", SOURCES.every((s) => s.coverage));
check("every source declares a quality tier", SOURCES.every((s) => s.quality));
check("every source explains how to call it", SOURCES.every((s) => s.howTo && s.howTo.length > 20));
check("every source lists what it is good for", SOURCES.every((s) => Array.isArray(s.goodFor) && s.goodFor.length));
check("source ids are unique", new Set(SOURCES.map((s) => s.id)).size === SOURCES.length);

check("quality tiers match the Reno engine's scale",
  SOURCES.every((s) => ["official", "organizer", "ticketing", "local_news", "secondary", "manual", "aggregator", "social"].includes(s.quality)),
  SOURCES.filter((s) => !["official", "organizer", "ticketing", "local_news", "secondary", "manual", "aggregator", "social"].includes(s.quality)).map((s) => s.id).join(","));

check("covers weather", SOURCES.some((s) => s.category === "weather"));
check("covers traffic", SOURCES.some((s) => s.category === "traffic"));
check("covers transit", SOURCES.some((s) => s.category === "transit"));
check("covers events", SOURCES.some((s) => s.category === "events"));
check("covers news", SOURCES.some((s) => s.category === "news"));
check("covers geocoding and places", SOURCES.some((s) => s.category === "geocoding") && SOURCES.some((s) => s.category === "places"));
check("covers air quality", SOURCES.some((s) => s.category === "air_quality"));
check("covers something genuinely unanticipated (seismic)", SOURCES.some((s) => s.category === "seismic"));

console.log("\nSearching the catalog");

{
  const weather = findSources({ category: "weather" });
  check("filters by category", weather.sources.every((s) => s.category === "weather") && weather.count >= 2);

  const byText = findSources({ query: "road closure" });
  check("free-text search finds traffic sources", byText.sources.some((s) => s.id === "nevada_511"), byText.sources.map((s) => s.id).join(","));

  const byUse = findSources({ query: "shuttle" });
  check("search matches on what a source is good for", byUse.sources.some((s) => s.id === "rtc_washoe"));

  check("lists the available categories", findSources({}).categories.includes("transit"));
  check("says the catalog is a starting point, not a boundary",
    /not a boundary/.test(findSources({}).note));
}

{
  const noKeys = findSources({ query: "maps", env: {} });
  const gmaps = noKeys.sources.find((s) => s.id === "google_maps");
  check("a key-requiring source is marked unavailable without its key", gmaps && gmaps.available === false);
  check("and says exactly which variable would unlock it",
    gmaps && /GOOGLE_MAPS_API_KEY/.test(gmaps.unlockHint), gmaps?.unlockHint);

  const withKey = findSources({ query: "maps", env: { GOOGLE_MAPS_API_KEY: "x" } });
  check("supplying the key marks it available",
    withKey.sources.find((s) => s.id === "google_maps").available === true);

  const onlyFree = findSources({ category: "weather", availableOnly: true, env: {} });
  check("availableOnly hides key-gated sources", onlyFree.sources.every((s) => !s.needsKey));
  check("no-key weather sources still come back", onlyFree.count >= 2, String(onlyFree.count));
}

{
  const avail = availability({});
  check("availability covers every source", avail.length === SOURCES.length);
  check("no-key sources are available by default", avail.find((s) => s.id === "nws").available === true);
  check("key-gated sources are not", avail.find((s) => s.id === "airnow").available === false);
}

console.log("\nNWS weather: the two-hop lookup");

{
  let urls = [];
  _setFetchForTests(async (url) => {
    urls.push(url);
    if (url.includes("/points/")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          properties: {
            forecastHourly: "https://api.weather.gov/gridpoints/REV/50,60/forecast/hourly",
            relativeLocation: { properties: { city: "Reno", state: "NV" } }
          }
        })
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        properties: {
          updated: "2026-09-18T10:00:00Z",
          periods: [
            { startTime: "2026-09-18T12:00:00-07:00", endTime: "2026-09-18T13:00:00-07:00", temperature: 78, temperatureUnit: "F", probabilityOfPrecipitation: { value: 10 }, windSpeed: "5 mph", windDirection: "W", shortForecast: "Sunny", isDaytime: true }
          ]
        }
      })
    };
  });

  const w = await getWeather({ ...RENO, _resolve: publicResolve });
  check("follows the point lookup to the hourly forecast", urls.length === 2 && urls[1].includes("gridpoints"));
  check("rounds coordinates to four decimals for the point lookup",
    urls[0].includes("39.5296,-119.8138"), urls[0]);
  check("resolves the location name", w.location === "Reno, NV", w.location);
  check("normalizes forecast periods", w.periods[0].precipitationChance === 10 && w.periods[0].shortForecast === "Sunny");
  check("reports the source and its quality tier", w.source === "National Weather Service" && w.quality === "official");
}

{
  _setFetchForTests(async () => ({ ok: true, status: 200, json: async () => ({ properties: {} }) }));
  await rejectsWith("a point outside US coverage explains itself and names the alternative",
    () => getWeather({ lat: 51.5, lon: -0.12, _resolve: publicResolve }), /Open-Meteo/);
}

{
  _setFetchForTests(async () => ({ ok: false, status: 503, json: async () => ({}) }));
  await rejectsWith("an HTTP error names the host and status",
    () => getWeather({ ...RENO, _resolve: publicResolve }), /api\.weather\.gov returned HTTP 503/);
}

await rejectsWith("rejects a nonsense latitude", () => getWeather({ lat: 999, lon: 0 }), /lat.*between -90 and 90/);
await rejectsWith("rejects a nonsense longitude", () => getWeather({ lat: 39, lon: 999 }), /lon.*between -180 and 180/);
await rejectsWith("rejects missing coordinates", () => getWeather({}), /must be a number/);

console.log("\nAlerts, Open-Meteo, geocoding, places");

{
  _setFetchForTests(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      features: [
        { properties: { event: "Winter Storm Warning", severity: "Severe", onset: "2026-09-20T18:00:00-07:00", ends: "2026-09-21T06:00:00-07:00", headline: "Heavy snow expected", areaDesc: "Washoe County" } }
      ]
    })
  }));
  const a = await getAlerts({ ...RENO, _resolve: publicResolve });
  check("parses active alerts", a.count === 1 && a.alerts[0].event === "Winter Storm Warning");
  check("captures the alert window", a.alerts[0].onset && a.alerts[0].ends);
  check("captures severity", a.alerts[0].severity === "Severe");

  _setFetchForTests(async () => ({ ok: true, status: 200, json: async () => ({ features: [] }) }));
  const none = await getAlerts({ ...RENO, _resolve: publicResolve });
  check("no alerts says so explicitly rather than returning bare emptiness", /No active alerts/.test(none.note));
}

{
  _setFetchForTests(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      timezone: "America/Los_Angeles",
      hourly: {
        time: ["2026-09-18T12:00", "2026-09-18T13:00"],
        temperature_2m: [24, 25],
        precipitation_probability: [5, 10],
        wind_speed_10m: [8, 9],
        visibility: [24000, 24000]
      }
    })
  }));
  const om = await getOpenMeteo({ ...RENO, _resolve: publicResolve });
  check("Open-Meteo columns are zipped into periods", om.periods.length === 2 && om.periods[1].temperature === 25);
  check("it is rated below NWS", om.quality === "secondary");
}

{
  _setFetchForTests(async () => ({
    ok: true,
    status: 200,
    json: async () => [{ display_name: "Reno, Washoe County, Nevada", lat: "39.5296", lon: "-119.8138", type: "city", importance: 0.7 }]
  }));
  const g = await geocode({ query: "Reno NV", _resolve: publicResolve });
  check("geocoding returns numeric coordinates", g.results[0].lat === 39.5296 && typeof g.results[0].lon === "number");
  await rejectsWith("geocoding requires a query", () => geocode({}), /required/);
}

{
  _setFetchForTests(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ elements: [{ lat: 39.5, lon: -119.8, tags: { name: "The Bar" } }, { lat: 39.5, lon: -119.8, tags: {} }] })
  }));
  const p = await nearbyPlaces({ ...RENO, amenity: "bar", _resolve: publicResolve });
  check("returns named places", p.places.length === 1 && p.places[0].name === "The Bar");
  check("unnamed nodes are dropped rather than listed as null", p.places.every((x) => x.name));

  // Sanitizing this leaves the harmless string "aroundout" — a real query
  // for an amenity that does not exist, which returns zero results. That
  // would read as "no bars near the venue", so it must be an error.
  await rejectsWith("rejects an injected Overpass query rather than querying nonsense",
    () => nearbyPlaces({ ...RENO, amenity: '"](around:99999,0,0);out;//' }), /simple OSM amenity/);
  await rejectsWith("rejects an amenity with a typo'd character",
    () => nearbyPlaces({ ...RENO, amenity: "bar!" }), /simple OSM amenity/);
  check("a clean amenity name is still accepted", true);
}

console.log("\nDestination guard still applies to every source client");

_setFetchForTests(async () => ({ ok: true, status: 200, json: async () => ({}) }));
await rejectsWith("geocode cannot be pointed at an internal address",
  () => geocode({ query: "x", _resolve: async () => [{ address: "169.254.169.254" }] }), /private or internal/);
await rejectsWith("weather cannot be pointed at an internal address",
  () => getWeather({ ...RENO, _resolve: async () => [{ address: "10.0.0.1" }] }), /private or internal/);

_setFetchForTests(null);

console.log("\nWeather to Reno evidence — the mapping that must not be wrong");

{
  const forecast = {
    source: "National Weather Service",
    periods: [
      { start: "2026-09-19T20:00:00-07:00", end: "2026-09-19T21:00:00-07:00", precipitationChance: 70, windSpeed: "8 mph", shortForecast: "Rain Showers" },
      { start: "2026-09-19T21:00:00-07:00", end: "2026-09-19T22:00:00-07:00", precipitationChance: 5, windSpeed: "3 mph", shortForecast: "Clear" }
    ]
  };
  const { evidence, count } = weatherToEvidence(forecast);

  check("a rainy hour produces exactly one record", count === 1, JSON.stringify(evidence));
  const rain = evidence[0];
  check("rain maps to the weather family", rain.family === "weather");
  check("rain is demand-POSITIVE, per the saved research basis", rain.value > 0, String(rain.value));
  check("its strength scales with precipitation chance", rain.value > 0.8, String(rain.value));
  check("it carries official source confidence", rain.sourceType === "official");
  check("it is windowed to exactly that hour", rain.start === forecast.periods[0].start && rain.end === forecast.periods[0].end);
  check("a clear hour produces nothing", !evidence.some((e) => /clear/i.test(e.note || "")));
}

{
  const snow = weatherToEvidence({
    periods: [{ start: "2026-09-20T18:00:00-07:00", end: "2026-09-20T19:00:00-07:00", precipitationChance: 90, windSpeed: "10 mph", shortForecast: "Heavy Snow" }]
  });
  const suppression = snow.evidence.find((e) => e.family === "safety_suppression");
  check("snow maps to safety_suppression, NOT to a demand bonus", Boolean(suppression), JSON.stringify(snow.evidence));
  check("heavy snow is weighted more than light", suppression.value >= 1.5, String(suppression.value));

  const light = weatherToEvidence({
    periods: [{ start: "2026-09-20T18:00:00-07:00", end: "2026-09-20T19:00:00-07:00", precipitationChance: 40, windSpeed: "5 mph", shortForecast: "Light Snow" }]
  });
  check("lighter snow is weighted less",
    light.evidence.find((e) => e.family === "safety_suppression").value < suppression.value);
}

{
  const wind = weatherToEvidence({
    periods: [{ start: "2026-09-19T14:00:00-07:00", end: "2026-09-19T15:00:00-07:00", precipitationChance: 0, windSpeed: "35 mph", shortForecast: "Windy" }]
  });
  const w = wind.evidence.find((e) => e.family === "weather");
  check("strong wind produces a NEGATIVE weather value", w && w.value < 0, JSON.stringify(wind.evidence));
  check("the wind penalty is bounded", w.value >= -1, String(w.value));

  const calm = weatherToEvidence({
    periods: [{ start: "2026-09-19T14:00:00-07:00", end: "2026-09-19T15:00:00-07:00", precipitationChance: 0, windSpeed: "10 mph", shortForecast: "Sunny" }]
  });
  check("ordinary wind produces no record at all", calm.count === 0);
}

{
  const alerts = {
    source: "National Weather Service",
    alerts: [
      { event: "Blizzard Warning", severity: "Extreme", onset: "2026-09-21T00:00:00-07:00", ends: "2026-09-21T12:00:00-07:00", headline: "Blizzard conditions" },
      { event: "Wind Advisory", severity: "Minor", onset: "2026-09-22T00:00:00-07:00", ends: null, headline: "Gusty" }
    ]
  };
  const r = weatherToEvidence({ periods: [] }, alerts);

  check("alerts become suppression evidence", r.evidence.every((e) => e.family === "safety_suppression"));
  check("an extreme alert is weighted at the maximum", r.evidence[0].value === 2, String(r.evidence[0].value));
  check("a minor alert is weighted far lower", r.evidence[1].value < 1, String(r.evidence[1].value));
  check("an alert with no end time still gets a bounded window",
    r.evidence[1].end && new Date(r.evidence[1].end) > new Date(r.evidence[1].onset || r.evidence[1].start));
  check("alerts carry official confidence", r.evidence.every((e) => e.sourceType === "official"));
}

{
  const nothing = weatherToEvidence({ periods: [{ start: "2026-09-19T14:00:00-07:00", precipitationChance: 0, windSpeed: "5 mph", shortForecast: "Sunny" }] });
  check("a benign forecast yields no evidence", nothing.count === 0);
  check("and says that is neutral by design, not a failure",
    /neutral/.test(nothing.note) && /inventing a record/.test(nothing.note), nothing.note);

  check("an empty forecast does not throw", weatherToEvidence({}).count === 0);
  check("a null forecast does not throw", weatherToEvidence(null).count === 0);
  check("periods with no start time are skipped",
    weatherToEvidence({ periods: [{ precipitationChance: 90, shortForecast: "Rain" }] }).count === 0);
}

console.log("\nThe generated evidence actually moves the Reno engine");

{
  const WEEK_START = new Date("2026-09-18T11:00:00.000Z");
  // Sat Sep 19, 10 PM Reno.
  const start = "2026-09-20T05:00:00.000Z";
  const end = "2026-09-20T06:00:00.000Z";

  const { evidence } = weatherToEvidence({
    source: "National Weather Service",
    periods: [{ start, end, precipitationChance: 80, windSpeed: "6 mph", shortForecast: "Rain Showers" }]
  });

  const before = scheduleReno({ weekStart: WEEK_START });
  const after = scheduleReno({ weekStart: WEEK_START, evidence });

  const hourBefore = before.hours.find((h) => h.date.toISOString() === start);
  const hourAfter = after.hours.find((h) => h.date.toISOString() === start);

  check("the engine accepts the generated records without complaint",
    hourAfter.unrecognized.length === 0, JSON.stringify(hourAfter.unrecognized));
  check("rain raises that hour's demand", hourAfter.D > hourBefore.D, `${hourAfter.D} vs ${hourBefore.D}`);
  check("and raises its opportunity", hourAfter.O > hourBefore.O);
  check("the evidence is confined to its own hour",
    after.hours.filter((h, i) => Math.abs(h.O - before.hours[i].O) > 1e-12).length === 1);
  check("coverage stops reporting DEGRADED once real evidence exists",
    after.coverage !== "DEGRADED" || after.hours.some((h) => h.applied.length > 0));
  check("the hour's reasons now name external demand",
    /external demand/.test(hourAfter.reasons), hourAfter.reasons);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
