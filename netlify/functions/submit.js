// netlify/functions/submit.js
const crypto = require("crypto");

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "GET") {
      return json({ error: "method_not_allowed" }, 405);
    }

    const q = event.queryStringParameters || {};
    const { u, d, ex, ts, t } = q;
    if (!u || !d || !ex || !ts || !t) {
      return json(
        { error: "missing_params", required: ["u", "d", "ex", "ts", "t"] },
        400
      );
    }

    // Verify signature
    const expected = signParams({ u, d, ex, ts }, process.env.SIGNING_SECRET);
    if (t !== expected) return json({ error: "invalid_signature" }, 403);

    // Freshness (48h)
    const now = Math.floor(Date.now() / 1000);
    if (!isFinite(+ts) || Math.abs(now - Number(ts)) > 172800) {
      return json({ error: "expired" }, 410);
    }

    // Paths
    const owner = process.env.REPO_OWNER;
    const repo = process.env.REPO_NAME;
    const gh = new GitHubRepo(owner, repo, process.env.GH_PAT);

    const folder = sanitize(u); // username folder
    const month = d.slice(0, 7); // "YYYY-MM"
    const pathDaily = `state/${d}.json`;
    const pathUser = `history/${folder}/${month}/${d}.json`;

    // ---- Update daily aggregate ----
    const daily = await gh.getOr(pathDaily, {
      date: d,
      completions: {},
      timestamps: {},
    });
    daily.completions[u] = daily.completions[u] || {};
    daily.timestamps[u] = daily.timestamps[u] || {};
    const nowIso = new Date().toISOString();
    if (ex === "ALL") {
      daily.completions[u].ALL = true;
      daily.timestamps[u].ALL = nowIso;
    } else {
      daily.completions[u][ex] = true;
      daily.timestamps[u][ex] = nowIso;
    }
    await gh.put(pathDaily, daily);

    // ---- Update per-user per-day ----
    const ufile = await gh.getOr(pathUser, {
      date: d,
      user: u,
      completed: [],
      timestamps: {},
    });
    if (ex === "ALL") {
      if (!ufile.completed.includes("ALL")) ufile.completed.push("ALL");
      ufile.timestamps.ALL = nowIso;
    } else {
      if (!ufile.completed.includes(ex)) ufile.completed.push(ex);
      ufile.timestamps[ex] = nowIso;
    }
    await gh.put(pathUser, ufile);

    // Friendly HTML page
    return html(
      200,
      `
      <div class="card">
        <h3>Got it ✅</h3>
        <p>Recorded completion for <strong>${escapeHtml(
          ex
        )}</strong> on <strong>${escapeHtml(d)}</strong>.</p>
        <p class="muted">You can close this tab.</p>
      </div>
    `
    );
  } catch (e) {
    return json(
      { error: "server_error", message: String((e && e.message) || e) },
      500
    );
  }
};

/* -------- HMAC & helpers -------- */

function canonicalize(params) {
  return Object.keys(params)
    .filter((k) => k !== "t")
    .sort()
    .map((k) => `${k}=${encodeURIComponent(params[k])}`)
    .join("&");
}
function base64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
function signParams(params, secret) {
  const mac = crypto
    .createHmac("sha256", secret)
    .update(canonicalize(params))
    .digest();
  return base64url(mac);
}

function sanitize(s) {
  return String(s)
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (m) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[m])
  );
}
function json(obj, status = 200) {
  return {
    statusCode: status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(obj),
  };
}
function html(status, body) {
  const doc = `<!doctype html><meta charset="utf-8">
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;padding:32px;background:#f9fafb}
    .card{max-width:560px;margin:40px auto;padding:20px;border:1px solid #e5e7eb;border-radius:12px;background:#fff}
    h3{margin:0 0 8px}
    .muted{color:#6b7280}
  </style>
  ${body}`;
  return {
    statusCode: status,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: doc,
  };
}

/* -------- GitHub Contents API wrapper -------- */

class GitHubRepo {
  constructor(owner, repo, token) {
    this.owner = owner;
    this.repo = repo;
    this.token = token;
    this.base = `https://api.github.com/repos/${owner}/${repo}/contents`;
    this.ua = "netlify-gym-reminder";
  }
  async _fetch(url, options = {}) {
    const r = await fetch(url, {
      ...options,
      headers: {
        Authorization: `token ${this.token}`,
        "User-Agent": this.ua,
        Accept: "application/vnd.github+json",
        ...(options.headers || {}),
      },
    });
    return r;
  }
  async get(path) {
    const r = await this._fetch(`${this.base}/${encodeURIComponent(path)}`);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GitHub GET ${path} -> ${r.status}`);
    const j = await r.json();
    const content = Buffer.from(j.content, "base64").toString("utf8");
    return { sha: j.sha, json: JSON.parse(content) };
  }
  async getOr(path, fallbackObj) {
    const g = await this.get(path);
    if (!g) return { ...fallbackObj }; // clone
    const obj = g.json;
    obj._sha = g.sha;
    return obj;
  }
  async put(path, obj) {
    const sha = obj._sha;
    delete obj._sha;
    const body = {
      message: `record completion for ${path}`,
      content: Buffer.from(JSON.stringify(obj, null, 2)).toString("base64"),
      ...(sha ? { sha } : {}),
    };
    const r = await this._fetch(`${this.base}/${encodeURIComponent(path)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`GitHub PUT ${path} -> ${r.status} ${txt}`);
    }
    return await r.json();
  }
}
