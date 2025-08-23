// netlify/functions/submit.js
// Node 18+ on Netlify

const crypto = require("crypto");

/**
 * HTTP entrypoint
 */
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

    // ---- HMAC verification (must match the sender’s signing) ----
    const secret = process.env.SIGNING_SECRET;
    if (!secret)
      return json(
        { error: "server_misconfig", message: "SIGNING_SECRET missing" },
        500
      );

    const expected = signParams({ u, d, ex, ts }, secret);
    if (t !== expected) return json({ error: "invalid_signature" }, 403);

    // ---- Freshness window (48h) ----
    const nowS = Math.floor(Date.now() / 1000);
    if (!isFinite(+ts) || Math.abs(nowS - Number(ts)) > 172800) {
      return json({ error: "expired" }, 410);
    }

    // ---- Repo/env config ----
    const owner = process.env.REPO_OWNER;
    const repo = process.env.REPO_NAME;
    const token = process.env.GH_PAT;
    if (!owner || !repo || !token) {
      return json(
        {
          error: "server_misconfig",
          message: "REPO_OWNER/REPO_NAME/GH_PAT not set",
        },
        500
      );
    }

    const gh = new GitHubRepo(owner, repo, token);

    // ---- Paths ----
    const username = u; // use username as-is; change to sanitize(u) if you want to normalize
    const month = d.slice(0, 7); // "YYYY-MM"

    const pathDaily = `state/${d}.json`;
    const pathUser = `User History/${username}/${month}/${d}.json`;

    // ---- Timestamps ----
    const nowIso = new Date().toISOString();

    // ========== DAILY AGGREGATE (state/YYYY-MM-DD.json) ==========
    const daily = await gh.getOr(pathDaily, {
      date: d,
      completions: {},
      timestamps: {},
    });
    daily.date ??= d;
    daily.completions[u] ??= {};
    daily.timestamps[u] ??= {};

    // idempotent set: if already true, do NOT overwrite the first timestamp
    let alreadyDaily = false;
    if (ex === "ALL") {
      if (daily.completions[u].ALL) {
        alreadyDaily = true;
      } else {
        daily.completions[u].ALL = true;
        daily.timestamps[u].ALL = nowIso;
      }
    } else {
      if (daily.completions[u][ex]) {
        alreadyDaily = true;
      } else {
        daily.completions[u][ex] = true;
        daily.timestamps[u][ex] = nowIso;
      }
    }

    // Write with small retry (handles race on sha)
    await gh.putWithRetry(pathDaily, daily);

    // ========== PER-USER PER-DAY (User History/<u>/<YYYY-MM>/<date>.json) ==========
    const ufile = await gh.getOr(pathUser, {
      date: d,
      user: u,
      completed: [],
      timestamps: {},
    });

    let alreadyUser = false;
    if (ex === "ALL") {
      if (ufile.completed.includes("ALL")) {
        alreadyUser = true;
      } else {
        ufile.completed.push("ALL");
        ufile.timestamps.ALL = ufile.timestamps.ALL ?? nowIso;
      }
    } else {
      if (ufile.completed.includes(ex)) {
        alreadyUser = true;
      } else {
        ufile.completed.push(ex);
        ufile.timestamps[ex] = ufile.timestamps[ex] ?? nowIso;
      }
    }

    await gh.putWithRetry(pathUser, ufile);

    const already = alreadyDaily && alreadyUser;

    // ---- Friendly HTML response ----
    return html(
      200,
      `
      <div class="card">
        <h3>${already ? "Already recorded ✅" : "Got it ✅"}</h3>
        <p>${
          already
            ? `You already logged <strong>${escapeHtml(
                ex
              )}</strong> for <strong>${escapeHtml(d)}</strong>.`
            : `Recorded <strong>${escapeHtml(
                ex
              )}</strong> on <strong>${escapeHtml(d)}</strong>.`
        }
        </p>
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

/* ====================== HMAC + helpers ====================== */

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

/* ====================== GitHub Contents API ====================== */

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
    if (!g) return { ...fallbackObj }; // clone fallback
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

  // simple conflict-resilient write
  async putWithRetry(path, obj, attempts = 2) {
    try {
      return await this.put(path, obj);
    } catch (e) {
      if (attempts <= 1) throw e;
      // On conflict (sha out of date), re-get, merge, and try again once
      if (String(e).includes("409") || String(e).includes("sha")) {
        const latest = await this.get(path);
        if (latest) {
          // naive merge: latest wins for unknown fields, keep our idempotent flags
          const merged = { ...(latest.json || {}), ...(obj || {}) };
          merged._sha = latest.sha;
          return await this.put(path, merged);
        }
      }
      throw e;
    }
  }
}
