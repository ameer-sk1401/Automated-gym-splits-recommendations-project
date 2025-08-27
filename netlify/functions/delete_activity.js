// netlify/functions/delete_activity.js
const crypto = require("crypto");

/** ENV required:
 *  REPO_OWNER, REPO_NAME, GH_PAT, SIGNING_SECRET
 */
const OWNER = process.env.REPO_OWNER;
const REPO = process.env.REPO_NAME;
const TOKEN = process.env.GH_PAT;
const SECRET = process.env.SIGNING_SECRET;

// Root folder where you store per-user activity
// You mentioned: "User History/<username>/<YYYY>/<MM>/<YYYY-MM-DD>.json"
// (Earlier variants also used "<username>/<MM>/<YYYY-MM-DD>.json").
// We'll try both to be compatible.
const HISTORY_ROOT = "User History";

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "GET") {
      // Confirm delete (optional UI). You can keep this or just do POST-only.
      const {
        u,
        scope = "day",
        d = "",
        y = "",
        m = "",
        ts,
        t,
      } = event.queryStringParameters || {};
      const check = verify({ u, scope, d, y, m, ts }, t);
      if (!check.ok)
        return html(403, page("Auth error", `<p>${esc(check.msg)}</p>`));
      if (!fresh(ts))
        return html(
          410,
          page("Expired", `<p>Link is older than 48 hours.</p>`)
        );
      return html(200, confirmPage({ u, scope, d, y, m, ts, t }));
    }

    if (event.httpMethod === "POST") {
      // Note: Netlify forwards form-urlencoded in event.body
      const body = parseForm(event.body || "");
      const u = (body.u || "").trim();
      const scope = (body.scope || "day").trim(); // "day" | "month" | "all"
      const d = (body.d || "").trim(); // YYYY-MM-DD (for scope=day)
      const y = (body.y || "").trim(); // YYYY (for scope=month)
      const m = (body.m || "").trim(); // MM   (for scope=month)
      const ts = (body.ts || "").trim();
      const t = (body.t || "").trim();

      const check = verify({ u, scope, d, y, m, ts }, t);
      if (!check.ok)
        return html(403, page("Auth error", `<p>${esc(check.msg)}</p>`));
      if (!fresh(ts))
        return html(
          410,
          page("Expired", `<p>Link is older than 48 hours.</p>`)
        );

      if (!OWNER || !REPO || !TOKEN) {
        return html(
          500,
          page(
            "Server misconfig",
            `<p>Missing REPO_OWNER/REPO_NAME/GH_PAT env.</p>`
          )
        );
      }
      const gh = new GitHubRepo(OWNER, REPO, TOKEN);

      let deleted = 0;
      if (scope === "day") {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
          return html(
            400,
            page("Invalid date", `<p>Expected YYYY-MM-DD, got "${esc(d)}"</p>`)
          );
        }
        const [yyyy, mm] = d.split("-");

        // Try canonical path: User History/<u>/<YYYY>/<MM>/<YYYY-MM-DD>.json
        const p1 = `${HISTORY_ROOT}/${u}/${yyyy}/${mm}/${d}.json`;
        // Fallback path variant: User History/<u>/<MM>/<YYYY-MM-DD>.json
        const p2 = `${HISTORY_ROOT}/${u}/${mm}/${d}.json`;

        deleted += await safeDeleteFile(gh, p1);
        if (!deleted) deleted += await safeDeleteFile(gh, p2);
      } else if (scope === "month") {
        if (!/^\d{4}$/.test(y) || !/^\d{2}$/.test(m)) {
          return html(
            400,
            page(
              "Invalid month",
              `<p>Expected y=YYYY & m=MM, got y="${esc(y)}" m="${esc(m)}"</p>`
            )
          );
        }
        // Delete all files under both possible folders for this month
        const p1 = `${HISTORY_ROOT}/${u}/${y}/${m}`;
        const p2 = `${HISTORY_ROOT}/${u}/${m}`;
        deleted += await deleteTree(gh, p1);
        deleted += await deleteTree(gh, p2);
      } else if (scope === "all") {
        // Delete entire user history (all months/years)
        const root = `${HISTORY_ROOT}/${u}`;
        deleted += await deleteTree(gh, root);
      } else {
        return html(
          400,
          page("Invalid scope", `<p>scope must be "day", "month", or "all"</p>`)
        );
      }

      return html(
        200,
        page(
          "Deleted ✅",
          `
        <p>Removed <b>${deleted}</b> file(s) for <b>${esc(u)}</b> (${esc(
            scope
          )} scope).</p>
        <p><a class="btn" href="/activity?u=${encodeURIComponent(
          u
        )}">🔙 Back to Activity</a></p>
      `
        )
      );
    }

    return json({ error: "method_not_allowed" }, 405);
  } catch (e) {
    return html(
      500,
      page("Server error", `<pre>${esc(String(e?.message || e))}</pre>`)
    );
  }
};

/* --------------- helpers --------------- */

function verify(params, token) {
  if (!SECRET)
    return { ok: false, msg: "Server misconfigured (missing SIGNING_SECRET)" };
  const { u, scope, d, y, m, ts } = params;
  if (!u || !ts || !token) return { ok: false, msg: "Missing u/ts/t" };
  // Canonicalize minimal inputs we care to bind:
  const canon = {};
  canon.u = u;
  canon.ts = ts;
  // Bind scope and targeted segment to prevent replay onto other resources
  if (scope) canon.scope = scope;
  if (d) canon.d = d;
  if (y) canon.y = y;
  if (m) canon.m = m;

  const expected = sign(canon, SECRET);
  if (token !== expected) return { ok: false, msg: "Invalid signature" };
  return { ok: true };
}

function fresh(ts) {
  const now = Math.floor(Date.now() / 1000);
  return isFinite(+ts) && Math.abs(now - Number(ts)) <= 172800; // 48h
}

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

function parseForm(raw) {
  const out = {};
  String(raw)
    .split("&")
    .forEach((pair) => {
      if (!pair) return;
      const [k, v] = pair.split("=");
      const key = decodeURIComponent(k || "");
      const val = decodeURIComponent(v || "");
      out[key] = val;
    });
  return out;
}

/* --------------- deletion --------------- */

async function safeDeleteFile(gh, path) {
  try {
    const { sha } = await gh.head(path);
    await gh.del(path, sha, `delete ${path}`);
    return 1;
  } catch {
    return 0;
  }
}

async function deleteTree(gh, dir) {
  // Recursively delete all files under dir (if exists)
  try {
    const listing = await gh.list(dir);
    let count = 0;
    for (const item of listing) {
      if (item.type === "file") {
        await gh.del(
          `${dir}/${item.name}`,
          item.sha,
          `delete ${dir}/${item.name}`
        );
        count++;
      } else if (item.type === "dir") {
        count += await deleteTree(gh, `${dir}/${item.name}`);
      }
    }
    return count;
  } catch {
    // dir not found
    return 0;
  }
}

/* --------------- HTML --------------- */

function page(title, body) {
  return `<!doctype html><meta charset="utf-8" />
  <title>${esc(title)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;background:#1a1a1a;min-height:100vh;padding:20px;display:flex;align-items:center;justify-content:center}
    .container{width:100%;max-width:760px}
    .card{background:rgba(45,45,45,.95);backdrop-filter:blur(10px);border-radius:20px;padding:24px;border:1px solid rgba(255,255,255,.1);color:#eee}
    a.btn,button.btn{display:inline-block;padding:12px 24px;border-radius:25px;text-decoration:none;background:linear-gradient(135deg,#FFD700,#FFA500);color:#4A1458;font-weight:700;border:none;cursor:pointer}
    input,button{font:inherit}
  </style>
  <div class="container"><div class="card">${body}</div></div>`;
}

function confirmPage({ u, scope, d, y, m, ts, t }) {
  const detail =
    scope === "day"
      ? `day <b>${esc(d)}</b>`
      : scope === "month"
      ? `month <b>${esc(y)}-${esc(m)}</b>`
      : `all activity`;

  return page(
    "Confirm delete",
    `
    <h2 style="margin:0 0 8px">Delete ${detail} for <code>${esc(u)}</code>?</h2>
    <p style="color:#bbb;margin:0 0 16px">This action removes JSON record(s) from the repo.</p>
    <form method="POST" action="/.netlify/functions/delete_activity">
      <input type="hidden" name="u" value="${esc(u)}" />
      <input type="hidden" name="scope" value="${esc(scope)}" />
      <input type="hidden" name="d" value="${esc(d)}" />
      <input type="hidden" name="y" value="${esc(y)}" />
      <input type="hidden" name="m" value="${esc(m)}" />
      <input type="hidden" name="ts" value="${esc(ts)}" />
      <input type="hidden" name="t"  value="${esc(t)}" />
      <button class="btn" type="submit">🗑 Delete</button>
      <a class="btn" href="/activity?u=${encodeURIComponent(u)}">Cancel</a>
    </form>
  `
  );
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
function esc(s) {
  return String(s).replace(
    /[&<>"']/g,
    (m) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[
        m
      ])
  );
}

/* ---------- GitHub API helper ---------- */
class GitHubRepo {
  constructor(owner, repo, token) {
    this.base = `https://api.github.com/repos/${owner}/${repo}/contents`;
    this.token = token;
  }
  async _fetch(url, opt = {}) {
    return await fetch(url, {
      ...opt,
      headers: {
        Authorization: `token ${this.token}`,
        "User-Agent": "netlify-delete-activity",
        Accept: "application/vnd.github+json",
        ...(opt.headers || {}),
      },
    });
  }
  async list(dir) {
    const r = await this._fetch(`${this.base}/${encodeURIComponent(dir)}`);
    if (r.status === 404) throw new Error("404");
    if (!r.ok) throw new Error(String(r.status));
    return await r.json();
  }
  async head(path) {
    const r = await this._fetch(`${this.base}/${encodeURIComponent(path)}`);
    if (r.status === 404) throw new Error("404");
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    return { sha: j.sha };
  }
  async del(path, sha, message) {
    const url = `${this.base}/${encodeURIComponent(path)}`;
    const body = { message: message || `delete ${path}`, sha };
    const r = await this._fetch(url, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`DELETE ${path} -> ${r.status} ${txt}`);
    }
    return await r.json();
  }
}
