/**
 * driver-app.js — the public, driver-facing "Darkly Driver: Shift Planner"
 * screen (the Google Play product), separate from the private console.
 *
 * Design rule: simple on top, everything underneath. The main screen answers
 * "should I drive, and when?" in a few seconds, in words instead of scores.
 * Every number the engine produces is still reachable: tap a card for its
 * details, or open the Details tab for all 168 hours and the sources.
 *
 * buildDriverPayload() turns an engine result (scheduleReno) into that
 * shape. It never invents anything: "why" lines come only from evidence the
 * engine actually applied, and a baseline-only week says so.
 */

const TZ = "America/Los_Angeles";

export function rating(score) {
  if (score >= 80) return { word: "Great", level: 4 };
  if (score >= 65) return { word: "Good", level: 3 };
  if (score >= 50) return { word: "Okay", level: 2 };
  return { word: "Slow", level: 1 };
}

function fmt(date, opts) {
  return new Intl.DateTimeFormat("en-US", Object.assign({ timeZone: TZ }, opts)).format(date);
}
const dayLabel = (d) => fmt(d, { weekday: "short", month: "short", day: "numeric" });
const hourLabel = (d) => fmt(d, { hour: "numeric", hour12: true });
const longDay = (d) => fmt(d, { weekday: "long" });

// Evidence labels applied inside [startIdx, endIdx), strongest first, deduped.
function whyFor(hours, startIdx, endIdx, max = 2) {
  const seen = new Map();
  for (const h of hours) {
    if (h.hourIndex < startIdx || h.hourIndex >= endIdx) continue;
    for (const a of h.applied || []) {
      const ev = a.evidence || {};
      const label = String(ev.label || ev.note || "").trim();
      if (!label) continue;
      const w = Math.abs(Number(a.w) || 0);
      if (!seen.has(label) || seen.get(label).w < w) {
        seen.set(label, { label, w, source: ev.source || "", note: ev.note || "" });
      }
    }
  }
  return [...seen.values()].sort((a, b) => b.w - a.w).slice(0, max);
}

export function buildDriverPayload(result, { now = new Date(), updatedAt = now } = {}) {
  const hours = result.hours; // chronological, with hourIndex
  const evidenceCount = hours.reduce((s, h) => s + (h.applied ? h.applied.length : 0), 0);

  const blocks = result.blocks.map((b) => {
    const coreHours = hours.filter((h) => h.date >= b.coreStartDate && h.date < b.coreEndDate);
    const coreAvg = coreHours.length ? coreHours.reduce((s, h) => s + h.score, 0) / coreHours.length : 0;
    const r = rating(coreAvg);
    const why = whyFor(hours, b.startIndex, b.endIndex);
    return {
      rank: b.rank,
      day: dayLabel(b.coreStartDate),
      time: hourLabel(b.coreStartDate) + " – " + hourLabel(b.coreEndDate),
      startIso: b.startDate.toISOString(),
      endIso: b.endDate.toISOString(),
      coreStartIso: b.coreStartDate.toISOString(),
      coreEndIso: b.coreEndDate.toISOString(),
      rating: r.word,
      level: r.level,
      hours: b.hoursCount,
      extendTo: b.hasExtension ? hourLabel(b.startDate) + " – " + hourLabel(b.endDate) : null,
      why: why.map((w) => w.label),
      details: {
        avgScore: Math.round(coreAvg * 10) / 10,
        coreTotalScore: b.coreTotalScore,
        extendedTotalScore: b.extendedTotalScore,
        extendedAvgScore: b.extendedAvgScore,
        evidence: why
      }
    };
  });

  // "Right now": inside a recommended block, a strong hour, or tell them
  // when the next good stretch starts.
  const dayKey = (d) => fmt(d, { year: "numeric", month: "2-digit", day: "2-digit" });
  const relDay = (iso) => {
    const d = new Date(iso);
    if (dayKey(d) === dayKey(now)) return "Today";
    if (dayKey(d) === dayKey(new Date(now.getTime() + 864e5))) return "Tomorrow";
    return longDay(d);
  };
  let nowCard;
  const current = hours.find((h) => now >= h.date && now < new Date(h.date.getTime() + 3600e3));
  const inBlock = blocks.find((b) => now >= new Date(b.startIso) && now < new Date(b.endIso));
  const next = blocks
    .filter((b) => new Date(b.startIso) > now)
    .sort((a, b) => new Date(a.startIso) - new Date(b.startIso))[0];
  if (inBlock) {
    nowCard = { good: true, headline: "Good time to drive", sub: "You're in one of this week's best stretches, until " + hourLabel(new Date(inBlock.endIso)) + "." };
  } else if (current && current.score >= 65) {
    nowCard = { good: true, headline: "Good time to drive", sub: "This hour is " + rating(current.score).word.toLowerCase() + "." + (next ? " Best stretch next: " + next.day + ", " + next.time + "." : "") };
  } else {
    nowCard = { good: false, headline: "Slow", sub: next ? "Next good stretch: " + relDay(next.coreStartIso) + ", " + next.time + "." : "No more strong stretches this week." };
  }

  // Week heat map: one row per operational day (4 AM to 4 AM), 24 cells.
  const grid = [];
  for (let d = 0; d < 7; d++) {
    const row = hours.filter((h) => h.forecastDayIndex === d).sort((a, b) => a.hourIndex - b.hourIndex);
    if (!row.length) continue;
    grid.push({
      day: fmt(row[0].date, { weekday: "short" }),
      date: fmt(row[0].date, { month: "short", day: "numeric" }),
      startIso: row[0].date.toISOString(),
      cells: row.map((h) => ({ iso: h.date.toISOString(), hour: hourLabel(h.date), score: Math.round(h.score), level: rating(h.score).level }))
    });
  }

  const daysOff = result.bestDaysOff.slice().sort((a, b) => a.date - b.date).map((d) => longDay(d.date));

  return {
    product: "Darkly Driver",
    market: "Reno / Sparks",
    updatedAt: updatedAt.toISOString(),
    researched: evidenceCount > 0,
    now: nowCard,
    grid,
    blocks,
    daysOff,
    daysOffLine: daysOff.length ? daysOff.join(" & ") + (daysOff.length > 1 ? " are" : " is") + " your slowest " + (daysOff.length > 1 ? "days" : "day") + ", good days to take off." : "",
    details: {
      weekStart: new Date(result.weekStart).toISOString(),
      coverage: result.coverage,
      evidenceCount,
      totalRecommendedHours: result.totalRecommendedHours,
      extensionThreshold: result.extensionThreshold,
      scoreMeaning: "Scores are 0–100 and compare hours within this week. They are not dollars per hour and not a guarantee.",
      complianceNotes: result.complianceNotes,
      complianceCaveat: result.complianceCaveat,
      daysOff: result.bestDaysOff.map((d) => ({ day: dayLabel(d.date), avgScore: Math.round(d.avgScore * 10) / 10 })),
      hours: result.ranked.map((h) => ({
        rank: h.rank,
        day: dayLabel(h.date),
        hour: hourLabel(h.date),
        score: Math.round(h.score * 10) / 10,
        rating: rating(h.score).word,
        confidence: h.confidenceLabel,
        platform: h.platform,
        estUber: Math.round(h.income.uber),
        why: (h.applied || []).map((a) => (a.evidence && (a.evidence.label || a.evidence.note)) || "").filter(Boolean)
      })),
      sources: [...new Set(hours.flatMap((h) => (h.applied || []).map((a) => a.evidence && a.evidence.source).filter(Boolean)))]
    }
  };
}

export const DRIVER_HTML = String.raw`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0c0a10" media="(prefers-color-scheme: dark)"><meta name="theme-color" content="#f7f5fa" media="(prefers-color-scheme: light)">
<title>Darkly Driver</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
:root{
  /* Darkly company palette. Brand = royal purple; gold only marks "best". */
  --brand:#7a3fe0;--brand-ink:#ffffff;--brand-soft:rgba(122,63,224,.16);--brand-text:#b48cff;
  --gold:#f2b13a;
  --bg:#0c0a10;--surface:#16131d;--surface2:#1e1a28;--line:#2a2435;
  --text:#f5f3f8;--dim:#a39cae;--faint:#6f687b;
  --h1:#1d1926;--h2:#3a2758;--h3:#6c3fbf;--h4:#f2b13a;
  --good:#3ecf7c;--slow:#8b8497;--barbg:rgba(12,10,16,.92);--navbg:rgba(16,13,21,.96);
}
@media (prefers-color-scheme: light){
  :root:not([data-theme="dark"]){
    --brand:#6a2fd1;--brand-soft:rgba(106,47,209,.10);--brand-text:#5b24bd;--gold:#c98a0e;
    --bg:#f7f5fa;--surface:#ffffff;--surface2:#f1edf6;--line:#e6e0ee;
    --text:#17131c;--dim:#5f5869;--faint:#8f8899;
    --h1:#ece8f2;--h2:#d5c3f0;--h3:#9460e0;--h4:#f2b13a;
    --good:#1f9d57;--slow:#8f8899;--barbg:rgba(247,245,250,.92);--navbg:rgba(255,255,255,.96);
  }
}
:root[data-theme="light"]{
  --brand:#6a2fd1;--brand-soft:rgba(106,47,209,.10);--brand-text:#5b24bd;--gold:#c98a0e;
  --bg:#f7f5fa;--surface:#ffffff;--surface2:#f1edf6;--line:#e6e0ee;
  --text:#17131c;--dim:#5f5869;--faint:#8f8899;
  --h1:#ece8f2;--h2:#d5c3f0;--h3:#9460e0;--h4:#f2b13a;
  --good:#1f9d57;--slow:#8f8899;--barbg:rgba(247,245,250,.92);--navbg:rgba(255,255,255,.96);
}
:root[data-theme="dark"]{
  --brand:#7a3fe0;--brand-soft:rgba(122,63,224,.16);--brand-text:#b48cff;--gold:#f2b13a;
  --bg:#0c0a10;--surface:#16131d;--surface2:#1e1a28;--line:#2a2435;
  --text:#f5f3f8;--dim:#a39cae;--faint:#6f687b;
  --h1:#1d1926;--h2:#3a2758;--h3:#6c3fbf;--h4:#f2b13a;
  --good:#3ecf7c;--slow:#8b8497;--barbg:rgba(12,10,16,.92);--navbg:rgba(16,13,21,.96);
}
@font-face{font-family:"Darkly Exchange";src:url("/assets/fonts/DarklyExchange-Regular.ttf") format("truetype");font-weight:400;font-display:swap}
@font-face{font-family:"Darkly Exchange";src:url("/assets/fonts/DarklyExchange-Bold.ttf") format("truetype");font-weight:700;font-display:swap}
:root{--display:"Darkly Exchange",Inter,system-ui,sans-serif}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-text-size-adjust:100%;font-feature-settings:"tnum" 1,"cv11" 1}
body{padding:0 0 calc(76px + env(safe-area-inset-bottom))}
.wrap{padding:0 16px}
/* app bar */
.bar{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:10px;padding:calc(12px + env(safe-area-inset-top)) 16px 12px;background:var(--barbg);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-bottom:1px solid transparent}
.logo{width:30px;height:30px;border-radius:9px;background:var(--brand);color:var(--brand-ink);display:grid;place-items:center;font-weight:800;font-size:17px;letter-spacing:-.5px}
.title{font-weight:700;font-size:17px;letter-spacing:-.2px;flex:1}
.city{display:flex;align-items:center;gap:5px;font-size:13px;font-weight:500;color:var(--dim);background:var(--surface);border:1px solid var(--line);border-radius:999px;padding:6px 10px}
.city svg{width:14px;height:14px}
/* hero */
.hero{padding:14px 0 6px}
.status{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:var(--dim);text-transform:none}
.dot{width:9px;height:9px;border-radius:50%;background:var(--slow);box-shadow:0 0 0 4px rgba(139,139,151,.15)}
.hero.good .dot{background:var(--good);box-shadow:0 0 0 4px rgba(62,207,124,.18)}
.hero h1{font-size:30px;line-height:1.1;font-weight:800;letter-spacing:-.8px;margin:8px 0 6px}
.hero p{margin:0;font-size:16px;line-height:1.45;color:var(--dim)}
.hero p b{color:var(--text);font-weight:600}
/* section */
.sec{display:flex;align-items:baseline;justify-content:space-between;margin:26px 0 10px}
.sec h2{margin:0;font-size:18px;font-weight:700;letter-spacing:-.3px}
.sec span{font-size:13px;color:var(--faint)}
/* heat map */
.heat{background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:14px 12px 10px}
.hrow{display:flex;align-items:center;gap:8px;width:100%;background:none;border:0;padding:3px 0;color:inherit;font:inherit;cursor:pointer}
.hday{width:38px;flex:0 0 38px;text-align:left;font-size:12.5px;font-weight:600;color:var(--dim)}
.hcells{flex:1;display:grid;grid-template-columns:repeat(24,1fr);gap:2px}
.c{height:18px;border-radius:3px;background:var(--h1)}
.c.l2{background:var(--h2)}.c.l3{background:var(--h3)}.c.l4{background:var(--h4)}
.c.now{outline:2px solid var(--text);outline-offset:-1px}
.axis{display:grid;grid-template-columns:repeat(4,1fr);margin:6px 0 0 46px;font-size:11px;color:var(--faint)}
.legend{display:flex;align-items:center;gap:6px;justify-content:flex-end;margin-top:8px;font-size:11px;color:var(--faint)}
.legend i{display:inline-block;width:14px;height:8px;border-radius:2px}
/* stretch cards */
.card{display:flex;align-items:center;gap:14px;width:100%;text-align:left;background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:14px 16px;margin-bottom:8px;color:inherit;font:inherit;cursor:pointer;transition:background .15s}
.card:active{background:var(--surface2)}
.card .m{flex:1;min-width:0}
.card .t{font-size:19px;font-weight:700;letter-spacing:-.4px}
.card .d{font-size:13.5px;color:var(--dim);margin-top:2px}
.card .w{font-size:13px;color:var(--dim);margin-top:8px;display:flex;gap:6px;align-items:flex-start;line-height:1.35}
.card .w svg{flex:0 0 14px;width:14px;height:14px;margin-top:2px;color:var(--brand-text)}
.meter{display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex:0 0 auto}
.bars{display:flex;gap:3px;align-items:flex-end}
.bars i{width:5px;border-radius:2px;background:var(--line)}
.bars i:nth-child(1){height:8px}.bars i:nth-child(2){height:12px}.bars i:nth-child(3){height:16px}.bars i:nth-child(4){height:20px}
.bars i.on{background:var(--brand-text)}
.meter.l4 .bars i.on{background:var(--gold)}
.meter b{font-size:12.5px;font-weight:600;color:var(--dim)}
.meter.l4 b{color:var(--gold)}
/* days off */
.info{display:flex;gap:12px;align-items:center;background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:14px 16px;font-size:15px;line-height:1.4}
.info svg{flex:0 0 22px;width:22px;height:22px;color:var(--dim)}
.meta{color:var(--faint);font-size:12.5px;margin:22px 0 8px;line-height:1.55}
/* bottom nav */
.nav{position:fixed;left:0;right:0;bottom:0;z-index:6;display:flex;background:var(--navbg);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-top:1px solid var(--line);padding:6px 0 calc(6px + env(safe-area-inset-bottom))}
.nav button{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;background:none;border:0;color:var(--faint);font:inherit;font-size:11.5px;font-weight:600;padding:6px 0;cursor:pointer}
.nav svg{width:24px;height:24px}
.nav .pillbg{padding:3px 18px;border-radius:999px}
.nav button.on{color:var(--text)}
.nav button.on .pillbg{background:var(--brand-soft);color:var(--brand-text)}
.hidden{display:none}
/* details */
.kv{display:grid;grid-template-columns:auto 1fr;gap:10px 16px;font-size:14.5px;background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:16px}
.kv dt{color:var(--dim)}.kv dd{margin:0;font-weight:500;text-align:right}
.list{background:var(--surface);border:1px solid var(--line);border-radius:16px;overflow:hidden}
.li{display:flex;align-items:center;gap:12px;padding:12px 14px;border-top:1px solid var(--line)}
.li:first-child{border-top:0}
.li .rk{width:26px;color:var(--faint);font-size:13px;text-align:right}
.li .m{flex:1;min-width:0}
.li .a{font-size:15px;font-weight:600}
.li .b{font-size:12.5px;color:var(--dim);margin-top:2px}
.li .sc{text-align:right;font-size:13px;color:var(--dim)}
.li .sc b{display:block;font-size:15px;color:var(--text)}
.sw{width:10px;height:10px;border-radius:3px;background:var(--h1);flex:0 0 10px}
.sw.l2{background:var(--h2)}.sw.l3{background:var(--h3)}.sw.l4{background:var(--h4)}
.note{font-size:13px;color:var(--dim);line-height:1.55}
.more{width:100%;margin-top:8px;background:var(--surface);border:1px solid var(--line);color:var(--brand-text);border-radius:12px;padding:12px;font:inherit;font-weight:600;cursor:pointer}
/* sheet */
.sheet-bg{position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;align-items:flex-end;z-index:10}
.sheet-bg.open{display:flex}
.sheet{width:100%;max-height:86vh;overflow:auto;background:var(--surface);border-radius:22px 22px 0 0;padding:10px 18px calc(24px + env(safe-area-inset-bottom));animation:up .22s ease-out}
@keyframes up{from{transform:translateY(40px);opacity:.6}to{transform:none;opacity:1}}
.grab{width:38px;height:4px;border-radius:2px;background:var(--line);margin:0 auto 14px}
.sheet h3{margin:0;font-size:24px;font-weight:800;letter-spacing:-.6px}
.sheet .sub{color:var(--dim);font-size:15px;margin:4px 0 16px}
.why{display:flex;gap:10px;align-items:flex-start;padding:10px 0;border-top:1px solid var(--line);font-size:14.5px}
.why:first-of-type{border-top:0}
.why small{display:block;color:var(--faint);font-size:12px;margin-top:2px}
.loading{color:var(--dim);padding:60px 0;text-align:center}
/* Brand font: Darkly Exchange on the brand mark, headlines, times and numbers; Inter for reading text. */
.logo,.title,.hero h1,.sec h2,.card .t,.sheet h3,.kv dd,.li .sc b,.li .a{font-family:var(--display);letter-spacing:.2px}
.hero h1{letter-spacing:.3px;font-weight:700}
.title{font-weight:700;font-size:18px}

.seg{display:flex;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:3px}
.seg button{flex:1;background:none;border:0;color:var(--dim);font:inherit;font-weight:600;font-size:14px;padding:9px 0;border-radius:9px;cursor:pointer}
.seg button.on{background:var(--brand);color:var(--brand-ink)}
</style>
</head><body>
<header class="bar">
  <div class="logo">D</div>
  <div class="title">Darkly Driver</div>
  <div class="city"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></svg><span id="market">Reno</span></div>
</header>

<main id="week" class="wrap"><div class="loading">Loading your week…</div></main>
<main id="details" class="wrap hidden"></main>

<nav class="nav">
  <button id="t-week" class="on"><span class="pillbg"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="16" rx="3"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/></svg></span>Week</button>
  <button id="t-details"><span class="pillbg"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg></span>Details</button>
</nav>

<div class="sheet-bg" id="sheet-bg"><div class="sheet" id="sheet"></div></div>

<script>
const $=(id)=>document.getElementById(id);
const esc=(v)=>String(v==null?"":v).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const ICON_SPARK='<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.2 6.3L20.5 10l-6.3 2.2L12 18.5l-2.2-6.3L3.5 10l6.3-1.7z"/></svg>';
const ICON_CAL='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4.5" width="18" height="16" rx="3"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4M9 15l2 2 4-4"/></svg>';
let data=null, showAll=false;
function getTheme(){try{return localStorage.getItem("dd-theme")||"system";}catch(e){return "system";}}
function setTheme(t){try{localStorage.setItem("dd-theme",t);}catch(e){}applyTheme(t);}
function applyTheme(t){if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t);else document.documentElement.removeAttribute("data-theme");}
applyTheme(getTheme());

function ago(iso){
  const m=Math.round((Date.now()-new Date(iso))/60000);
  if(m<2)return "just now"; if(m<60)return m+" min ago";
  const h=Math.round(m/60); if(h<24)return h+(h===1?" hour ago":" hours ago");
  const d=Math.round(h/24); return d+(d===1?" day ago":" days ago");
}
function bars(level){let h='<div class="bars">';for(let i=1;i<=4;i++)h+='<i class="'+(i<=level?'on':'')+'"></i>';return h+'</div>';}
function longDate(iso){return new Date(iso).toLocaleDateString("en-US",{timeZone:"America/Los_Angeles",weekday:"long",month:"short",day:"numeric"});}

function renderWeek(){
  const d=data, now=Date.now();
  let h='<section class="hero'+(d.now.good?' good':'')+'"><div class="status"><span class="dot"></span>Right now</div><h1>'+esc(d.now.headline)+'</h1><p>'+esc(d.now.sub)+'</p></section>';

  h+='<div class="sec"><h2>Your week</h2><span>tap a day</span></div><div class="heat">';
  d.grid.forEach((row,ri)=>{
    h+='<button class="hrow" data-row="'+ri+'"><span class="hday">'+esc(row.day)+'</span><span class="hcells">';
    row.cells.forEach(c=>{const t=new Date(c.iso).getTime();h+='<i class="c l'+c.level+(now>=t&&now<t+3600e3?' now':'')+'"></i>';});
    h+='</span></button>';
  });
  h+='<div class="axis"><span>4a</span><span>10a</span><span>4p</span><span>10p</span></div>';
  h+='<div class="legend">Slow <i style="background:var(--h1)"></i><i style="background:var(--h2)"></i><i style="background:var(--h3)"></i><i style="background:var(--h4)"></i> Busy</div></div>';

  h+='<div class="sec"><h2>Best stretches</h2><span>'+d.blocks.length+' this week</span></div>';
  d.blocks.slice().sort((a,b)=>new Date(a.coreStartIso)-new Date(b.coreStartIso)).forEach(b=>{
    h+='<button class="card" data-rank="'+b.rank+'"><div class="m"><div class="t">'+esc(b.time)+'</div><div class="d">'+esc(longDate(b.coreStartIso))+' · '+b.hours+' hrs</div>'+
      (b.why.length?'<div class="w">'+ICON_SPARK+'<span>'+esc(b.why.join(" · "))+'</span></div>':'')+
      '</div><div class="meter l'+b.level+'">'+bars(b.level)+'<b>'+esc(b.rating)+'</b></div></button>';
  });

  if(d.daysOffLine) h+='<div class="sec"><h2>Days off</h2></div><div class="info">'+ICON_CAL+'<span>'+esc(d.daysOffLine)+'</span></div>';
  h+='<p class="meta">Updated '+esc(ago(d.updatedAt))+(d.researched?' with weather, flights, and local events.':' from normal Reno patterns.')+' Planning guidance, not guaranteed earnings.</p>';
  $("week").innerHTML=h;
  $("week").querySelectorAll(".card").forEach(el=>el.onclick=()=>openBlock(+el.dataset.rank));
  $("week").querySelectorAll(".hrow").forEach(el=>el.onclick=()=>openDay(+el.dataset.row));
}

function sheet(html){$("sheet").innerHTML='<div class="grab"></div>'+html;$("sheet-bg").classList.add("open");}
function closeSheet(){$("sheet-bg").classList.remove("open");}
$("sheet-bg").onclick=(e)=>{if(e.target.id==="sheet-bg")closeSheet();};

function openBlock(rank){
  const b=data.blocks.find(x=>x.rank===rank); if(!b)return;
  let h='<h3>'+esc(b.time)+'</h3><div class="sub">'+esc(longDate(b.coreStartIso))+' · '+esc(b.rating)+'</div>';
  h+='<dl class="kv"><dt>Hours</dt><dd>'+b.hours+'</dd>'+(b.extendTo?'<dt>Worth extending to</dt><dd>'+esc(b.extendTo)+'</dd>':'')+
     '<dt>Average score</dt><dd>'+b.details.avgScore+' / 100</dd><dt>Rank this week</dt><dd>#'+b.rank+' of '+data.blocks.length+'</dd></dl>';
  h+='<div class="sec"><h2>Why</h2></div>';
  if(b.details.evidence.length) b.details.evidence.forEach(e=>{h+='<div class="why">'+ICON_SPARK.replace('<svg','<svg style="width:16px;height:16px;color:var(--brand-text);flex:0 0 16px;margin-top:2px"')+'<div>'+esc(e.label)+(e.source?'<small>'+esc(e.source)+'</small>':'')+'</div></div>';});
  else h+='<p class="note">Based on normal Reno patterns for this day and time.</p>';
  sheet(h);
}
function openDay(ri){
  const row=data.grid[ri]; if(!row)return;
  const best=row.cells.slice().sort((a,b)=>b.score-a.score);
  let h='<h3>'+esc(longDate(row.startIso))+'</h3><div class="sub">Every hour, 4 AM to 4 AM</div><div class="list">';
  row.cells.forEach(c=>{h+='<div class="li"><span class="sw l'+c.level+'"></span><div class="m"><div class="a">'+esc(c.hour)+'</div></div><div class="sc"><b>'+["","Slow","Okay","Good","Great"][c.level]+'</b>'+c.score+'</div></div>';});
  h+='</div><p class="note" style="margin-top:10px">Busiest hour: '+esc(best[0].hour)+'.</p>';
  sheet(h);
}

function renderDetails(){
  const x=data.details, cov=String(x.coverage||"").toLowerCase();
  let h='<div class="sec"><h2>How this week was built</h2></div><dl class="kv"><dt>Data coverage</dt><dd>'+esc(cov.charAt(0).toUpperCase()+cov.slice(1))+'</dd><dt>Evidence used</dt><dd>'+x.evidenceCount+'</dd><dt>Recommended driving</dt><dd>'+x.totalRecommendedHours+' hrs</dd><dt>Extend a stretch if score is at least</dt><dd>'+x.extensionThreshold+'</dd></dl>';
  h+='<p class="note">'+esc(x.scoreMeaning)+'</p>';
  const rows=showAll?x.hours:x.hours.slice(0,24);
  h+='<div class="sec"><h2>Every hour</h2><span>best to worst</span></div><div class="list">'+rows.map(r=>{
    const lv={Slow:1,Okay:2,Good:3,Great:4}[r.rating]||1;
    return '<div class="li"><span class="rk">'+r.rank+'</span><span class="sw l'+lv+'"></span><div class="m"><div class="a">'+esc(r.day)+' · '+esc(r.hour)+'</div><div class="b">'+esc(r.confidence)+' confidence · ~$'+r.estUber+'/hr'+(r.why.length?' · '+esc(r.why.join(", ")):'')+'</div></div><div class="sc"><b>'+r.score+'</b>'+esc(r.rating)+'</div></div>';
  }).join("")+'</div>';
  if(!showAll) h+='<button class="more" id="more">Show all '+x.hours.length+' hours</button>';
  h+='<p class="note">~$/hr is a rough guide from the score, not a prediction of what you will make.</p>';
  if(x.sources.length) h+='<div class="sec"><h2>Sources</h2></div><div class="list">'+x.sources.map(s=>'<div class="li"><div class="m"><div class="b" style="margin:0">'+esc(s)+'</div></div></div>').join("")+'</div>';
  h+='<div class="sec"><h2>Driving limits</h2></div><p class="note">'+esc((x.complianceNotes||[]).join(" "))+' '+esc(x.complianceCaveat||"")+'</p>';
  const cur=getTheme();
  h+='<div class="sec"><h2>Appearance</h2></div><div class="seg">'+["system","light","dark"].map(t=>'<button data-t="'+t+'" class="'+(cur===t?'on':'')+'">'+t.charAt(0).toUpperCase()+t.slice(1)+'</button>').join("")+'</div>';
  h+='<p class="meta">Darkly Driver · <a href="/privacy" style="color:var(--dim)">Privacy</a></p>';
  $("details").innerHTML=h;
  $("details").querySelectorAll(".seg button").forEach(b=>b.onclick=()=>{setTheme(b.dataset.t);renderDetails();});
  const m=$("more"); if(m)m.onclick=()=>{showAll=true;renderDetails();};
}

function tab(w){
  $("week").classList.toggle("hidden",w!=="week");$("details").classList.toggle("hidden",w!=="details");
  $("t-week").classList.toggle("on",w==="week");$("t-details").classList.toggle("on",w==="details");window.scrollTo(0,0);
}
$("t-week").onclick=()=>tab("week");$("t-details").onclick=()=>tab("details");

async function load(){
  try{
    const res=await fetch(window.DRIVER_DATA_URL||"/driver-app/data",{cache:"no-store"});
    if(!res.ok)throw new Error("HTTP "+res.status);
    data=await res.json(); renderWeek(); renderDetails();
  }catch(e){ $("week").innerHTML='<div class="loading">Couldn\'t load your week. Check your connection and reopen the app.</div>'; }
}
if(window.DRIVER_PRELOAD){data=window.DRIVER_PRELOAD;renderWeek();renderDetails();}else load();
</script>
</body></html>`;
