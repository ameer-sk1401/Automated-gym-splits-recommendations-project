// netlify/functions/activity.js
// Server-rendered HTML activity page for ?u=<username>
// Reads from: User History/<username>/<YYYY-MM>/<YYYY-MM-DD>.json (GitHub Contents API)

const OWNER = process.env.REPO_OWNER;
const REPO = process.env.REPO_NAME;
const TOKEN = process.env.GH_PAT;
const SECRET = process.env.SIGNING_SECRET; // <-- needed for signing delete links
const crypto = require("crypto");

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "GET")
      return json({ error: "method_not_allowed" }, 405);

    const u = (event.queryStringParameters?.u || "").trim();
    if (!u)
      return html(
        400,
        page("Activity", `<p>Missing <code>?u=</code> in URL.</p>`)
      );

    // List months under "User History/<u>/"
    const months = await listDir(`User History/${u}`);
    if (!months.ok) {
      const msg =
        months.status === 404
          ? `No history found for <b>${escape(u)}</b> yet.`
          : `Could not list history for <b>${escape(u)}</b> (status ${
              months.status
            }).`;
      return html(200, page(`Activity – ${u}`, `<p>${msg}</p>`));
    }

    // month directories like "2025-08"
    const monthDirs = months.items
      .filter((x) => x.type === "dir")
      .map((x) => x.name)
      .sort();

    // Collect all day files + group by month
    const entries = [];
    const byMonth = {}; // { "YYYY-MM": [ dateStr ] }
    for (const m of monthDirs) {
      const days = await listDir(`User History/${u}/${m}`);
      if (!days.ok) continue;

      const monthList = [];
      for (const f of days.items) {
        if (!f.name.endsWith(".json")) continue;
        const d = f.name.replace(".json", ""); // YYYY-MM-DD
        const file = await getJsonByDownloadUrl(f.download_url);
        if (!file) continue;
        const completed = Array.isArray(file.completed)
          ? file.completed
          : Object.keys(file.completed || {});
        entries.push({ date: d, completed, month: m });
        monthList.push(d);
      }
      if (monthList.length) byMonth[m] = monthList.sort();
    }

    entries.sort((a, b) => a.date.localeCompare(b.date)); // ascending

    // Summaries
    const totalDays = entries.length;
    const daysWithAny = entries.filter(
      (e) => (e.completed || []).length > 0
    ).length;
    const rate = totalDays ? Math.round((daysWithAny / totalDays) * 100) : 0;

    // per-exercise counts
    const exCounts = {};
    for (const e of entries) {
      for (const x of e.completed || []) exCounts[x] = (exCounts[x] || 0) + 1;
    }
    const exRows =
      Object.entries(exCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `<tr><td>${escape(k)}</td><td>${v}</td></tr>`)
        .join("") || `<tr><td colspan="2">—</td></tr>`;

    // Signed delete links
    const nowTs = Math.floor(Date.now() / 1000).toString();
    const deleteAllUrl = buildDeleteAllLink(u, nowTs);

    // Per-day rows with delete link
    const dayRows =
      entries
        .map((e) => {
          const list =
            e.completed && e.completed.length
              ? e.completed.map(escape).join(", ")
              : "—";
          const delUrl = buildDeleteDayLink(u, e.date, nowTs);
          return `<tr>
            <td>${e.date}</td>
            <td>${list}</td>
            <td style="width:1%;white-space:nowrap"><a class="btn btn-xs btn-danger" href="${delUrl}">🗑 Delete</a></td>
          </tr>`;
        })
        .join("") || `<tr><td colspan="3">No data yet.</td></tr>`;

    // Per-month section with delete link
    const monthSections = Object.keys(byMonth).length
      ? Object.keys(byMonth)
          .sort()
          .map((m) => {
            const [yyyy, mm] = m.split("-");
            const delMonthUrl = buildDeleteMonthLink(u, yyyy, mm, nowTs);
            const rows = byMonth[m]
              .map((d) => {
                const delDayUrl = buildDeleteDayLink(u, d, nowTs);
                return `<tr>
              <td>${d}</td>
              <td><a class="btn btn-xs btn-danger" href="${delDayUrl}">🗑 Delete day</a></td>
            </tr>`;
              })
              .join("");
            return `
            <div class="panel">
              <div class="panel-head">
                <h4>${m}</h4>
                <a class="btn btn-sm btn-danger" href="${delMonthUrl}">🗑 Delete month</a>
              </div>
              <table>
                <thead><tr><th>Date</th><th>Actions</th></tr></thead>
                <tbody>${rows}</tbody>
              </table>
            </div>
          `;
          })
          .join("")
      : `<div class="panel"><p>No monthly data.</p></div>`;

    const from = entries[0]?.date || "—";
    const to = entries[entries.length - 1]?.date || "—";

    const body = `
      <div class="summary">
        <div class="summary-head">
          <h2>Activity – ${escape(u)}</h2>
          <a class="btn btn-sm btn-danger" href="${deleteAllUrl}">🗑 Delete all</a>
        </div>
        <p class="muted">Range: <b>${from}</b> → <b>${to}</b></p>
        <div class="cards">
          <div class="card"><div class="k">Days total</div><div class="v">${totalDays}</div></div>
          <div class="card"><div class="k">Days completed ≥1</div><div class="v">${daysWithAny}</div></div>
          <div class="card"><div class="k">Adherence</div><div class="v">${rate}%</div></div>
        </div>
      </div>

      <div class="grid">
        <div class="panel">
          <h3>Per day</h3>
          <table><thead><tr><th>Date</th><th>Completed</th><th></th></tr></thead><tbody>${dayRows}</tbody></table>
        </div>
        <div class="panel">
          <h3>Per exercise</h3>
          <table><thead><tr><th>Exercise</th><th>Times</th></tr></thead><tbody>${exRows}</tbody></table>
        </div>
      </div>

      <div class="panel">
        <h3>Months</h3>
        ${monthSections}
      </div>
    `;

    return html(200, page(`Activity – ${u}`, body));
  } catch (e) {
    return html(
      500,
      page(
        "Server Error",
        `<pre>${escape(String((e && e.message) || e))}</pre>`
      )
    );
  }
};

/* ---------- GitHub helpers ---------- */

async function gh(url, opts = {}) {
  const r = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `token ${TOKEN}`,
      "User-Agent": "netlify-activity",
      Accept: "application/vnd.github+json",
      ...(opts.headers || {}),
    },
  });
  return r;
}
async function listDir(path) {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(
    path
  )}`;
  const r = await gh(url);
  if (r.status === 404) return { ok: false, status: 404, items: [] };
  if (!r.ok) return { ok: false, status: r.status, items: [] };
  const items = await r.json();
  return { ok: true, status: 200, items };
}
async function getJsonByDownloadUrl(downloadUrl) {
  const r = await gh(downloadUrl);
  if (!r.ok) return null;
  return await r.json().catch(() => null);
}

/* ---------- signing helpers (server-side) ---------- */
function canonicalize(o) {
  return Object.keys(o)
    .sort()
    .map((k) => `${k}=${encodeURIComponent(o[k])}`)
    .join("&");
}
function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
function sign(params, secret) {
  return b64url(
    crypto.createHmac("sha256", secret).update(canonicalize(params)).digest()
  );
}
function buildSigned(params) {
  if (!SECRET) throw new Error("Missing SIGNING_SECRET");
  const token = sign(params, SECRET);
  const search = new URLSearchParams({ ...params, t: token });
  return search.toString();
}
// delete link builders
function buildDeleteDayLink(u, dateISO, ts) {
  const qs = buildSigned({ u, scope: "day", d: dateISO, ts });
  return `/.netlify/functions/delete_activity?${qs}`;
}
function buildDeleteMonthLink(u, yyyy, mm, ts) {
  const qs = buildSigned({ u, scope: "month", y: yyyy, m: mm, ts });
  return `/.netlify/functions/delete_activity?${qs}`;
}
function buildDeleteAllLink(u, ts) {
  const qs = buildSigned({ u, scope: "all", ts });
  return `/.netlify/functions/delete_activity?${qs}`;
}

/* ---------- response/html helpers ---------- */

function page(title, body) {
  return `<!doctype html><meta charset="utf-8">
  <title>${escape(title)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;margin:24px;background:#f9fafb}
    .muted{color:#6b7280}
    .cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:12px 0 18px}
    .card{border:1px solid #e5e7eb;border-radius:12px;background:#fff;padding:10px 12px}
    .k{color:#6b7280;font-size:12px}
    .v{font-size:20px;font-weight:700}
    .grid{display:grid;grid-template-columns:2fr 1fr;gap:18px}
    .panel{border:1px solid #e5e7eb;border-radius:12px;background:#fff;padding:12px;margin-top:18px}
    .panel-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
    table{border-collapse:collapse;width:100%}
    th,td{border:1px solid #e5e7eb;padding:8px 10px;text-align:left;font-size:14px}
    th{background:#f3f4f6}
    .btn{display:inline-block;padding:8px 12px;border-radius:10px;text-decoration:none;background:#111827;color:#fff}
    .btn-sm{padding:6px 10px;font-size:12px}
    .btn-xs{padding:4px 8px;font-size:12px}
    .btn-danger{background:#b91c1c}
    .summary-head{display:flex;align-items:center;justify-content:space-between}
    @media(max-width:900px){.grid{grid-template-columns:1fr}}
  </style>
  ${body}`;
}
function html(status, body) {
  return {
    statusCode: status,
    headers: { "content-type": "text/html; charset=utf-8" },
    body,
  };
}
function json(obj, status = 200) {
  return {
    statusCode: status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(obj),
  };
}
function escape(s) {
  return String(s).replace(
    /[&<>"']/g,
    (m) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[
        m
      ])
  );
}
