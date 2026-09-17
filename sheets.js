import { google } from "googleapis";

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = "Channels";
const DAILY_LIMIT = parseInt(process.env.DAILY_SEND_LIMIT || "20", 10);

function getAuth() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is missing");
  }

  let creds;
  try {
    creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }

  return new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https:" + "//www.googleapis.com/auth/spreadsheets"]
  });
}

async function getSheets() {
  if (!SHEET_ID) {
    throw new Error("GOOGLE_SHEET_ID is missing");
  }

  const auth = getAuth();
  return google.sheets({ version: "v4", auth });
}


async function readSheetObjects(sheetName, range = "A:AZ") {
  const sheets = await getSheets();

  const safeName = String(sheetName).replace(/'/g, "''");

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${safeName}'!${range}`
  });

  const rows = res.data.values || [];
  if (rows.length === 0) return [];

  const headers = rows[0].map(h => String(h || "").trim());

  return rows.slice(1)
    .filter(row => row.some(v => String(v ?? "").trim() !== ""))
    .map((row, i) => {
      const obj = { _rowIndex: i + 2 };

      headers.forEach((header, j) => {
        if (header) obj[header] = row[j] ?? "";
      });

      return obj;
    });
}

export async function readBusinessProspects() {
  return readSheetObjects("Business Prospects", "A:AB");
}

export async function readConnectorCandidateUniverse() {
  return readSheetObjects("Connector Candidate Universe", "A:AZ");
}

export async function readBusinessCandidateUniverse() {
  return readSheetObjects("Business Candidate Universe", "A:AZ");
}

function columnLetter(index) {
  let n = index + 1;
  let out = "";

  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }

  return out;
}


export async function readEngineConfig(keys = []) {
  const sheets = await getSheets();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "'Engine Config'!A:D"
  });

  const rows = res.data.values || [];
  if (rows.length < 2) {
    throw new Error("Engine Config sheet has no configuration rows");
  }

  const wanted = new Set(
    (Array.isArray(keys) ? keys : [])
      .map(k => String(k || "").trim().toUpperCase())
      .filter(Boolean)
  );

  const configRows = rows.slice(1)
    .filter(row => String(row[0] || "").trim())
    .map(row => ({
      parameter: String(row[0] || "").trim(),
      value: row[1] ?? "",
      type: row[2] ?? "",
      description: row[3] ?? ""
    }))
    .filter(row =>
      wanted.size === 0 || wanted.has(row.parameter.toUpperCase())
    );

  const byKey = {};
  for (const row of configRows) {
    byKey[row.parameter] = {
      value: row.value,
      type: row.type,
      description: row.description
    };
  }

  return {
    count: configRows.length,
    requestedKeys: [...wanted],
    byKey,
    rows: configRows
  };
}

export async function readActiveMarket() {
  const sheets = await getSheets();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Markets!A:AB"
  });

  const rows = res.data.values || [];
  if (rows.length < 2) {
    throw new Error("Markets sheet has no market rows");
  }

  const headers = rows[0].map(h => String(h || "").trim());

  const markets = rows.slice(1).map((row, i) => {
    const obj = { _rowIndex: i + 2 };
    headers.forEach((h, j) => {
      obj[h] = row[j] ?? "";
    });
    return obj;
  });

  const active = markets.filter(m =>
    String(m["Active Session?"] || "").trim().toUpperCase() === "TRUE"
  );

  if (active.length !== 1) {
    throw new Error(
      `Expected exactly 1 active market, found ${active.length}`
    );
  }

  return {
    marketId: String(active[0]["Market ID"] || "").trim(),
    canonicalMarket: String(active[0]["Canonical Market"] || "").trim(),
    rowIndex: active[0]._rowIndex,
    raw: active[0]
  };
}

function normalizeMarket(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function leadBelongsToMarket(lead, activeMarket) {
  if (!activeMarket?.marketId || !activeMarket?.canonicalMarket) {
    return false;
  }

  const marketId = String(activeMarket.marketId).trim().toUpperCase();
  const channelId = String(lead["Channel ID"] || "").trim().toUpperCase();

  // Stable canonical ID is the strongest signal.
  if (channelId.startsWith(`${marketId}-`)) {
    return true;
  }

  const canonical = normalizeMarket(activeMarket.canonicalMarket);
  const canonicalBase = canonical.replace(/\s+metro$/, "");

  const candidates = [
    normalizeMarket(lead["Market"]),
    normalizeMarket(lead["City Group"])
  ];

  return candidates.some(value =>
    value === canonical ||
    value === canonicalBase ||
    value.startsWith(`${canonicalBase} /`)
  );
}

export async function readAllLeads() {
  const sheets = await getSheets();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:AU`
  });

  const rows = res.data.values || [];
  if (rows.length < 2) return [];

  const headers = rows[0].map(h => String(h || "").trim());

  return rows.slice(1).map((row, i) => {
    const obj = { _rowIndex: i + 2 };

    headers.forEach((h, j) => {
      obj[h] = row[j] ?? "";
    });

    return obj;
  });
}

function scoreLead(lead) {
  let score = 0;

  const priority = String(lead["Priority"] || "").toUpperCase();
  if (priority === "A") score += 40;
  else if (priority === "B") score += 20;
  else if (priority === "C") score += 5;

  const qualityScore = parseFloat(lead["Quality Score"] || 0);
  if (!Number.isNaN(qualityScore)) {
    score += qualityScore * 0.4;
  }

  const quality = String(lead["Expected Quality"] || "").toLowerCase();
  if (quality.includes("very high")) score += 15;
  else if (quality.includes("high")) score += 8;

  const scale = String(lead["Scalability"] || "").toLowerCase();
  if (scale.includes("very high")) score += 10;
  else if (scale.includes("high")) score += 5;

  const risk = String(lead["Legal Risk Tier"] || "").toUpperCase();
  if (risk === "GREEN") score += 20;
  else if (risk === "YELLOW") score += 12;
  else if (risk === "ORANGE") score -= 20;
  else if (risk === "RED") score -= 999;

  const actionability = String(
    lead["Actionability State"] || ""
  ).toUpperCase();

  if (actionability === "READY") score += 25;
  else if (actionability === "APPROVAL REQUIRED") score += 12;
  else score -= 999;

  const recommendation = String(
    lead["Recommendation State"] || ""
  ).toUpperCase();

  if (recommendation === "ELIGIBLE") score += 10;
  else if (recommendation === "FOLLOW-UP DUE") score += 8;
  else if (recommendation === "LOW PRIORITY") score -= 20;
  else if (recommendation === "COOLING OFF") score -= 100;
  else if (recommendation === "DO NOT CONTACT") score -= 999;
  else if (recommendation === "PARTNERED") score -= 999;

  const topTier = String(
    lead["Top-Tier Candidate"] || ""
  ).toUpperCase();

  if (topTier === "TOP TIER") score += 20;
  else if (topTier === "WATCH") score += 5;

  const status = String(lead["Status"] || "").toLowerCase();

  if (status === "new") score += 10;
  if (status.includes("do not")) score -= 999;
  if (status.includes("hold")) score -= 100;

  const recommendAfter = lead["Recommend After"] || "";

  if (recommendAfter) {
    const due = new Date(recommendAfter);

    if (!Number.isNaN(due.getTime()) && due > new Date()) {
      score -= 100;
    }
  }

  return Math.round(score);
}

export function pickDailyQueue(
  leads,
  activeMarket,
  limit = DAILY_LIMIT
) {
  if (!activeMarket?.marketId || !activeMarket?.canonicalMarket) {
    throw new Error("Active market is required for daily queue selection");
  }

  const allowedActionability = new Set([
    "READY",
    "APPROVAL REQUIRED"
  ]);

  const eligible = leads.filter(lead => {
    if (!leadBelongsToMarket(lead, activeMarket)) {
      return false;
    }

    const actionability = String(
      lead["Actionability State"] || ""
    ).toUpperCase();

    if (!allowedActionability.has(actionability)) {
      return false;
    }

    const recommendation = String(
      lead["Recommendation State"] || ""
    ).toUpperCase();

    if (
      recommendation === "DO NOT CONTACT" ||
      recommendation === "PARTNERED" ||
      recommendation === "COOLING OFF"
    ) {
      return false;
    }

    const status = String(
      lead["Status"] || ""
    ).toLowerCase();

    if (
      status.includes("do not") ||
      status.includes("partnered") ||
      status.includes("hold")
    ) {
      return false;
    }

    const recommendAfter = lead["Recommend After"] || "";

    if (recommendAfter) {
      const due = new Date(recommendAfter);

      if (!Number.isNaN(due.getTime()) && due > new Date()) {
        return false;
      }
    }

    return true;
  });

  const scored = eligible.map(lead => ({
    ...lead,
    _score: scoreLead(lead)
  }));

  scored.sort((a, b) => b._score - a._score);

  return scored.slice(0, limit);
}

export async function updateLeadStatus(
  rowIndex,
  status,
  followUpDate,
  notes
) {
  if (!Number.isInteger(rowIndex) || rowIndex < 2) {
    throw new Error(`Invalid Channels row index: ${rowIndex}`);
  }

  const sheets = await getSheets();

  const headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!1:1`
  });

  const headers = (
    headerRes.data.values || [[]]
  )[0].map(h => String(h || "").trim());

  function findColumn(...names) {
    for (const name of names) {
      const idx = headers.indexOf(name);

      if (idx !== -1) {
        return columnLetter(idx);
      }
    }

    return null;
  }

  const statusCol = findColumn("Status");
  const followUpCol = findColumn(
    "Recommend After",
    "Next Follow-Up",
    "Follow Up Date"
  );
  const notesCol = findColumn("Notes");

  const data = [];

  if (statusCol && status !== undefined && status !== null) {
    data.push({
      range: `${SHEET_NAME}!${statusCol}${rowIndex}`,
      values: [[status]]
    });
  }

  if (
    followUpCol &&
    followUpDate !== undefined &&
    followUpDate !== null
  ) {
    data.push({
      range: `${SHEET_NAME}!${followUpCol}${rowIndex}`,
      values: [[followUpDate]]
    });
  }

  if (notesCol && notes !== undefined && notes !== null) {
    data.push({
      range: `${SHEET_NAME}!${notesCol}${rowIndex}`,
      values: [[notes]]
    });
  }

  if (!data.length) {
    return {
      updated: false,
      rowIndex,
      reason: "No writable values supplied"
    };
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      valueInputOption: "RAW",
      data
    }
  });

  const verify = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A${rowIndex}:AU${rowIndex}`
  });

  const row = verify.data.values?.[0] || [];

  const result = { _rowIndex: rowIndex };

  headers.forEach((h, i) => {
    result[h] = row[i] ?? "";
  });

  return {
    updated: true,
    rowIndex,
    lead: result
  };
}

export { DAILY_LIMIT };
