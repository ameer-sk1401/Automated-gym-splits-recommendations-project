export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }
    if (url.pathname !== "/submit") {
      return new Response("Not found", { status: 404 });
    }
    try {
      const q = Object.fromEntries(url.searchParams.entries());
      const { u, d, ex, ts, t } = q;

      // 1) Validate required params
      if (!u || !d || !ex || !ts || !t) {
        return json({ error: "missing_params" }, 400);
      }

      // 2) Verify HMAC
      const expected = await signParams({ u, d, ex, ts }, env.SIGNING_SECRET);
      if (t !== expected) {
        return json({ error: "invalid_signature" }, 403);
      }

      // 3) Check freshness (48h)
      const now = Math.floor(Date.now() / 1000);
      if (Math.abs(now - Number(ts)) > 172800) {
        return json({ error: "expired" }, 410);
      }

      // 4) Update state/YYYY-MM-DD.json in GitHub
      const path = `state/${d}.json`;
      const gh = new GitHubRepo(env);

      // Get existing file (or null if 404)
      const found = await gh.getFile(path);
      let state;
      if (found?.content) {
        state = JSON.parse(atob(found.content));
      } else {
        // Minimal initialization if the sender job hasn’t created today’s file
        state = { date: d, completions: {}, timestamps: {} };
      }

      if (!state.completions[u]) state.completions[u] = {};
      if (!state.timestamps[u]) state.timestamps[u] = {};

      const when = new Date().toISOString();
      if (ex === "ALL") {
        state.completions[u]["ALL"] = true;
        state.timestamps[u]["ALL"] = when;
      } else {
        state.completions[u][ex] = true;
        state.timestamps[u][ex] = when;
      }

      const newContent = JSON.stringify(state, null, 2);
      await gh.putFile(path, newContent, found?.sha);

      // 5) Friendly HTML response for the user’s browser tab
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
      return json({ error: "server_error", message: e.message }, 500);
    }
  },
};

/* ---------- helpers ---------- */
function escapeHtml(s) {
  return s.replace(
    /[&<>"']/g,
    (m) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[
        m
      ])
  );
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
function html(status, body) {
  const page = `<!doctype html><meta charset="utf-8">
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;padding:32px;background:#f9fafb}
    .card{max-width:560px;margin:40px auto;padding:20px;border:1px solid #e5e7eb;border-radius:12px;background:#fff}
    h3{margin:0 0 8px}
    .muted{color:#6b7280}
  </style>
  ${body}`;
  return new Response(page, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function canonicalize(params) {
  const keys = Object.keys(params)
    .filter((k) => k !== "t")
    .sort();
  return keys.map((k) => `${k}=${encodeURIComponent(params[k])}`).join("&");
}
async function signParams(params, secret) {
  const alg = { name: "HMAC", hash: "SHA-256" };
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    alg,
    false,
    ["sign"]
  );
  const data = new TextEncoder().encode(canonicalize(params));
  const mac = await crypto.subtle.sign(alg.name, key, data);
  return base64Url(mac);
}
function base64Url(buf) {
  let s = btoa(String.fromCharCode(...new Uint8Array(buf)));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

class GitHubRepo {
  constructor(env) {
    this.owner = env.REPO_OWNER;
    this.repo = env.REPO_NAME;
    this.token = env.GH_PAT; // fine-grained PAT with contents:write on this repo
    this.base = `https://api.github.com/repos/${this.owner}/${this.repo}/contents`;
    this.ua = "gym-reminder-worker";
  }
  async getFile(path) {
    const r = await fetch(`${this.base}/${encodeURIComponent(path)}`, {
      headers: { Authorization: `token ${this.token}`, "User-Agent": this.ua },
    });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GitHub GET ${path} failed: ${r.status}`);
    return await r.json();
  }
  async putFile(path, content, sha) {
    const body = {
      message: `record completion for ${path}`,
      content: btoa(content),
      sha,
    };
    const r = await fetch(`${this.base}/${encodeURIComponent(path)}`, {
      method: "PUT",
      headers: {
        Authorization: `token ${this.token}`,
        "User-Agent": this.ua,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`GitHub PUT ${path} failed: ${r.status} ${txt}`);
    }
    return await r.json();
  }
}
