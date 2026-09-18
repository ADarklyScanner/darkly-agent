/**
 * Tests for sensors.js — run with: node sensors.test.mjs
 *
 * The failure that matters here is staleness. A sound level from six
 * hours ago is a real measurement of a place the phone has probably left,
 * and reporting it as the situation now would be exactly the kind of
 * confident wrongness this codebase keeps trying to design out. So most
 * of these tests are about age: that it is measured, reported, and that
 * nothing past its window is ever described as current.
 */

import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const SCRATCH = path.join(os.tmpdir(), `darkly-sensors-test-${process.pid}`);
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });
process.env.DARKLY_STATE_DIR = SCRATCH;

const {
  recordReading,
  latest,
  summary,
  history,
  interpretSound,
  _clearSensorsForTests,
  MAX_READINGS_PER_SENSOR,
  FRESHNESS
} = await import("./sensors.js");

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

function throwsWith(label, fn, matcher) {
  try {
    fn();
    check(label, false, "did not throw");
  } catch (e) {
    check(label, matcher ? matcher.test(e.message) : true, e.message);
  }
}

/* ------------------------------------------------------------------ */

console.log("\nRecording readings");

_clearSensorsForTests();

{
  const r = recordReading({ sensor: "sound", value: 72, unit: "dB" });
  check("records a reading", r.ok === true && r.sensor === "sound");
  check("counts what is stored", r.stored === 1);
  check("recognizes a known sensor", r.known === true && r.note === undefined);
}

{
  const r = recordReading({ sensor: "Sound", value: 70 });
  check("sensor names are normalized to lower case", r.sensor === "sound" && r.stored === 2);
}

{
  const r = recordReading({ sensor: "magnetometer", value: 42 });
  check("an unknown sensor is still stored", r.ok === true && r.stored === 1);
  check("and is flagged as unknown rather than rejected", r.known === false && /without a server change/.test(r.note));
}

throwsWith("requires a sensor name", () => recordReading({ value: 1 }), /sensor.*required/);
throwsWith("requires a value", () => recordReading({ sensor: "sound" }), /value.*required/);
throwsWith("rejects a sensor name that is all punctuation", () => recordReading({ sensor: "!!!", value: 1 }), /simple name/);

{
  // A value of 0 is a legitimate reading (silence, no motion) and must not
  // be treated as missing.
  const r = recordReading({ sensor: "motion", value: 0 });
  check("zero is a valid reading, not a missing one", r.ok === true);
}

console.log("\nDevice clock handling");

{
  _clearSensorsForTests();
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  recordReading({ sensor: "sound", value: 60, at: future });
  const l = latest("sound");
  // A phone clock running fast would otherwise produce a reading that
  // stays "fresh" forever.
  check("a future timestamp is clamped to now", new Date(l.at).getTime() <= Date.now() + 1000, l.at);
  check("and the reading is therefore fresh, not impossibly so", l.fresh === true && l.ageMs >= 0);
}

{
  _clearSensorsForTests();
  recordReading({ sensor: "sound", value: 60, at: "not a date" });
  check("an unparseable timestamp falls back to now instead of failing", latest("sound").found === true);
}

console.log("\nFreshness — the part that must not be wrong");

{
  _clearSensorsForTests();
  const now = Date.now();
  recordReading({ sensor: "sound", value: 85, unit: "dB", at: new Date(now - 30 * 1000).toISOString() });

  const l = latest("sound", now);
  check("a recent reading is fresh", l.fresh === true);
  check("its age is reported in words", /seconds ago/.test(l.age), l.age);
  check("a fresh reading carries no staleness warning", l.note === undefined);
}

{
  _clearSensorsForTests();
  const now = Date.now();
  recordReading({ sensor: "sound", value: 85, at: new Date(now - 6 * 60 * 60 * 1000).toISOString() });

  const l = latest("sound", now);
  check("a six-hour-old sound reading is NOT fresh", l.fresh === false);
  check("the value is still returned as last-known", l.value === 85);
  check("but it is explicitly not the situation now",
    /not as the situation now/.test(l.note), l.note);
  check("the age is stated in the warning", /hours ago/.test(l.note));
  check("the freshness window is stated so the judgement is auditable", Boolean(l.freshnessWindow));
}

{
  // Different sensors go stale at different rates: a battery level lasts
  // far longer than a noise level.
  _clearSensorsForTests();
  const now = Date.now();
  const twentyMinAgo = new Date(now - 20 * 60 * 1000).toISOString();
  recordReading({ sensor: "sound", value: 70, at: twentyMinAgo });
  recordReading({ sensor: "battery", value: 55, at: twentyMinAgo });

  check("sound goes stale in twenty minutes", latest("sound", now).fresh === false);
  check("battery does not", latest("battery", now).fresh === true);
  check("sound has a tighter window than battery", FRESHNESS.sound < FRESHNESS.battery);
}

{
  const l = latest("barometer");
  check("an unseen sensor reports not-found rather than inventing a value", l.found === false && l.value === undefined);
  check("and explains why there is nothing", /has not sent any/.test(l.note));
}

console.log("\nBounded storage");

{
  _clearSensorsForTests();
  for (let i = 0; i < MAX_READINGS_PER_SENSOR + 60; i++) {
    recordReading({ sensor: "sound", value: i, at: new Date(Date.now() - (MAX_READINGS_PER_SENSOR + 60 - i) * 1000).toISOString() });
  }
  const h = history("sound", MAX_READINGS_PER_SENSOR);
  check("the rolling window is enforced", h.count === MAX_READINGS_PER_SENSOR, String(h.count));
  check("the newest readings are the ones kept",
    h.readings[h.readings.length - 1].value === MAX_READINGS_PER_SENSOR + 59,
    String(h.readings[h.readings.length - 1].value));
  check("the oldest were dropped, not the newest", h.readings[0].value === 60, String(h.readings[0].value));
}

{
  _clearSensorsForTests();
  recordReading({ sensor: "sound", value: 1, at: new Date(Date.now() - 3000).toISOString() });
  recordReading({ sensor: "sound", value: 3, at: new Date(Date.now() - 1000).toISOString() });
  // Out-of-order arrival is normal from a phone with intermittent signal.
  recordReading({ sensor: "sound", value: 2, at: new Date(Date.now() - 2000).toISOString() });

  const h = history("sound");
  check("readings are kept in time order regardless of arrival order",
    h.readings.map((r) => r.value).join(",") === "1,2,3", h.readings.map((r) => r.value).join(","));
  check("latest() returns the newest by time, not by arrival", latest("sound").value === 3);
}

console.log("\nSummary across sensors");

{
  _clearSensorsForTests();
  const now = Date.now();
  recordReading({ sensor: "sound", value: 80, unit: "dB", at: new Date(now - 60 * 1000).toISOString() });
  recordReading({ sensor: "location", value: { lat: 39.53, lon: -119.81 }, at: new Date(now - 2 * 60 * 1000).toISOString() });
  recordReading({ sensor: "battery", value: 42, unit: "%", at: new Date(now - 3 * 60 * 60 * 1000).toISOString() });

  const s = summary(now);
  check("lists every sensor seen", s.sensorCount === 3);
  check("reports each one's latest value", s.sensors.find((x) => x.sensor === "sound").latestValue === 80);
  check("structured values survive the round trip",
    s.sensors.find((x) => x.sensor === "location").latestValue.lat === 39.53);
  check("marks fresh and stale per sensor",
    s.sensors.find((x) => x.sensor === "sound").fresh === true &&
      s.sensors.find((x) => x.sensor === "battery").fresh === false);
}

{
  _clearSensorsForTests();
  const s = summary();
  check("an empty store says nothing has ever arrived", s.sensorCount === 0 && /have ever been received/.test(s.note), s.note);
  check("and says what would have to happen for it to exist", /POST to \/sensor-reading/.test(s.note));
}

console.log("\nSound interpretation");

{
  check("quiet reads as quiet", /quiet/.test(interpretSound(28).comparison));
  check("conversation level reads as moderate", /moderate/.test(interpretSound(55).comparison));
  check("a bar reads as loud", /loud/.test(interpretSound(82).comparison), interpretSound(82).comparison);
  check("a club reads as very loud", /very loud/.test(interpretSound(95).comparison));
  check("the level is rounded, not given false precision", interpretSound(72.4837).approximateDb === 72);

  // The honesty requirement: a phone mic is not a sound meter.
  check("it admits the microphone is uncalibrated", /uncalibrated/.test(interpretSound(70).caveat));
  check("it steers toward comparison over absolute measurement",
    /comparison over time/.test(interpretSound(70).caveat));

  check("a non-numeric reading returns null rather than guessing", interpretSound("loud") === null);
  check("undefined returns null", interpretSound(undefined) === null);
}

console.log("\nDurability");

{
  _clearSensorsForTests();
  recordReading({ sensor: "sound", value: 66, unit: "dB" });
  // Re-import fresh to prove it came off disk rather than out of memory.
  const reloaded = await import(`./sensors.js?cachebust=${Date.now()}`);
  check("readings survive a module reload (they are on the volume, not in RAM)",
    reloaded.latest("sound").value === 66);
}

fs.rmSync(SCRATCH, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
