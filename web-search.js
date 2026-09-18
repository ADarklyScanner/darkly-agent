/**
 * web-search.js — real web search for the agent, across whichever
 * provider happens to be configured.
 *
 * Search is the one research capability that genuinely cannot be built
 * from nothing: somebody has to run the index. So rather than picking one
 * vendor and hard-failing without it, this supports several and reports
 * honestly which (if any) are available.
 *
 * Provider order is deliberate. Brave, Tavily and Serper are purpose-built
 * search APIs that return real ranked results with URLs. Google
 * Programmable Search is the same idea with more setup. Gemini grounding
 * is LAST and is a different animal: it is a language model that has
 * consulted search, so its prose is generated rather than retrieved. It is
 * included because the user already has a GEMINI_API_KEY and it beats
 * having no search at all, but results from it are labeled as
 * model-summarized with their grounding URLs attached, and the caller is
 * told which kind it got. That distinction matters here: this codebase
 * already treats Gemini's freeform output as deliberately unverified
 * brainstorm material, and search grounding does not erase that — it just
 * attaches citations that can be checked with read_web_page.
 */

const PROVIDERS = [
  {
    id: "brave",
    label: "Brave Search",
    envKey: "BRAVE_API_KEY",
    kind: "retrieved",
    quality: "secondary"
  },
  {
    id: "tavily",
    label: "Tavily",
    envKey: "TAVILY_API_KEY",
    kind: "retrieved",
    quality: "secondary"
  },
  {
    id: "serper",
    label: "Serper (Google)",
    envKey: "SERPER_API_KEY",
    kind: "retrieved",
    quality: "secondary"
  },
  {
    id: "google_cse",
    label: "Google Programmable Search",
    envKey: "GOOGLE_CSE_KEY",
    extraEnv: ["GOOGLE_CSE_ID"],
    kind: "retrieved",
    quality: "secondary"
  },
  {
    id: "gemini",
    label: "Gemini (search-grounded)",
    envKey: "GEMINI_API_KEY",
    kind: "model_summarized",
    quality: "aggregator"
  }
];

let _fetchImpl = null;
/** Test seam: swap the transport without needing a live network. */
export function _setFetchForTests(fn) {
  _fetchImpl = fn;
}
function theFetch() {
  return _fetchImpl || globalThis.fetch;
}

function isConfigured(p, env) {
  if (!env[p.envKey] || !String(env[p.envKey]).trim()) return false;
  return (p.extraEnv || []).every((k) => env[k] && String(env[k]).trim());
}

/** Which providers this deployment can actually use, best first. */
export function availableProviders(env = process.env) {
  return PROVIDERS.filter((p) => isConfigured(p, env)).map((p) => ({
    id: p.id,
    label: p.label,
    kind: p.kind,
    quality: p.quality
  }));
}

export function searchConfigured(env = process.env) {
  return availableProviders(env).length > 0;
}

/**
 * A plain-language description of the search situation, including what to
 * do about it. Returned to the model when nothing is configured so it can
 * tell the user something useful instead of just failing.
 */
export function searchStatus(env = process.env) {
  const available = availableProviders(env);
  if (available.length > 0) {
    return {
      configured: true,
      providers: available,
      note:
        available[0].kind === "model_summarized"
          ? "Only Gemini search-grounding is available. Its summaries are model-generated, not retrieved results — treat them as leads to verify with read_web_page, not as sources."
          : `Using ${available[0].label}.`
    };
  }
  return {
    configured: false,
    providers: [],
    note:
      "No web search provider is configured on this deployment. Set any one of: BRAVE_API_KEY (free tier available), TAVILY_API_KEY, SERPER_API_KEY, GOOGLE_CSE_KEY plus GOOGLE_CSE_ID, or GEMINI_API_KEY (search-grounded, model-summarized). read_web_page still works without any key if you already know the URL."
  };
}

/* ------------------------------------------------------------------ *
 * Per-provider adapters — each returns the same normalized shape
 * ------------------------------------------------------------------ */

async function searchBrave(query, count, env) {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
  const res = await theFetch()(url, {
    headers: { Accept: "application/json", "X-Subscription-Token": env.BRAVE_API_KEY }
  });
  if (!res.ok) throw new Error(`Brave Search returned HTTP ${res.status}`);
  const data = await res.json();
  const results = (data.web && data.web.results) || [];
  return results.slice(0, count).map((r) => ({
    title: r.title || null,
    url: r.url,
    snippet: stripTags(r.description || ""),
    published: r.age || null
  }));
}

async function searchTavily(query, count, env) {
  const res = await theFetch()("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: env.TAVILY_API_KEY, query, max_results: count })
  });
  if (!res.ok) throw new Error(`Tavily returned HTTP ${res.status}`);
  const data = await res.json();
  return (data.results || []).slice(0, count).map((r) => ({
    title: r.title || null,
    url: r.url,
    snippet: stripTags(r.content || ""),
    published: r.published_date || null
  }));
}

async function searchSerper(query, count, env) {
  const res = await theFetch()("https://google.serper.dev/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": env.SERPER_API_KEY },
    body: JSON.stringify({ q: query, num: count })
  });
  if (!res.ok) throw new Error(`Serper returned HTTP ${res.status}`);
  const data = await res.json();
  return (data.organic || []).slice(0, count).map((r) => ({
    title: r.title || null,
    url: r.link,
    snippet: stripTags(r.snippet || ""),
    published: r.date || null
  }));
}

async function searchGoogleCse(query, count, env) {
  const url =
    `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(env.GOOGLE_CSE_KEY)}` +
    `&cx=${encodeURIComponent(env.GOOGLE_CSE_ID)}&q=${encodeURIComponent(query)}&num=${Math.min(count, 10)}`;
  const res = await theFetch()(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Google Programmable Search returned HTTP ${res.status}`);
  const data = await res.json();
  return (data.items || []).slice(0, count).map((r) => ({
    title: r.title || null,
    url: r.link,
    snippet: stripTags(r.snippet || ""),
    published: null
  }));
}

/**
 * Gemini with the google_search tool. Returns the model's prose plus
 * whatever grounding URLs it cites. Deliberately shaped differently from
 * the retrieved providers so a caller cannot mistake one for the other.
 */
async function searchGemini(query, count, env) {
  const model = env.GEMINI_SEARCH_MODEL || "gemini-2.0-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;
  const res = await theFetch()(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: query }] }],
      tools: [{ google_search: {} }]
    })
  });
  if (!res.ok) throw new Error(`Gemini search returned HTTP ${res.status}`);
  const data = await res.json();

  const candidate = (data.candidates || [])[0] || {};
  const text = ((candidate.content && candidate.content.parts) || [])
    .map((p) => p.text || "")
    .join("")
    .trim();

  const grounding = candidate.groundingMetadata || {};
  const chunks = grounding.groundingChunks || [];
  const results = chunks
    .map((c) => (c.web ? { title: c.web.title || null, url: c.web.uri, snippet: "", published: null } : null))
    .filter(Boolean)
    .slice(0, count);

  return { summary: text, results };
}

function stripTags(s) {
  return String(s).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

const ADAPTERS = {
  brave: searchBrave,
  tavily: searchTavily,
  serper: searchSerper,
  google_cse: searchGoogleCse,
  gemini: searchGemini
};

/**
 * Search the web.
 *
 * Tries configured providers in order and falls through on failure, so a
 * rate-limited or briefly-down provider does not take research offline
 * when another is available. Every failure is reported in `attempts`
 * rather than swallowed — a search that silently returned nothing would
 * be indistinguishable from a topic with no coverage, which is exactly
 * the kind of quiet wrongness this codebase tries to avoid.
 */
export async function webSearch(query, options = {}) {
  const env = options.env || process.env;
  const count = Math.max(1, Math.min(20, Number(options.count) || 8));
  const available = availableProviders(env);

  if (available.length === 0) {
    return { ok: false, ...searchStatus(env), results: [] };
  }

  const preferred = options.provider
    ? available.filter((p) => p.id === options.provider)
    : available;

  if (preferred.length === 0) {
    return {
      ok: false,
      configured: true,
      error: `Provider "${options.provider}" is not configured. Available: ${available.map((p) => p.id).join(", ")}.`,
      results: []
    };
  }

  const attempts = [];
  for (const p of preferred) {
    try {
      const raw = await ADAPTERS[p.id](query, count, env);

      if (p.id === "gemini") {
        return {
          ok: true,
          provider: p.id,
          providerLabel: p.label,
          kind: "model_summarized",
          sourceQuality: p.quality,
          query,
          summary: raw.summary,
          results: raw.results,
          caveat:
            "This came from Gemini with search grounding: the summary is MODEL-GENERATED prose, not retrieved text, and may be confidently wrong. Treat it as a set of leads — open the grounding URLs with read_web_page before relying on anything in it, and never cite the summary itself as a source.",
          attempts
        };
      }

      return {
        ok: true,
        provider: p.id,
        providerLabel: p.label,
        kind: "retrieved",
        sourceQuality: p.quality,
        query,
        results: raw,
        attempts
      };
    } catch (e) {
      attempts.push({ provider: p.id, error: String(e.message || e) });
    }
  }

  return {
    ok: false,
    configured: true,
    error: `All configured search providers failed: ${attempts.map((a) => `${a.provider} (${a.error})`).join("; ")}`,
    results: [],
    attempts
  };
}
