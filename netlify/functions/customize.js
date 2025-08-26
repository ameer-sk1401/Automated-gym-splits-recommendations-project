// netlify/functions/customize.js
const crypto = require("crypto");

const OWNER = process.env.REPO_OWNER;
const REPO = process.env.REPO_NAME;
const TOKEN = process.env.GH_PAT;
const SECRET = process.env.SIGNING_SECRET;

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "GET") {
      // show the form (requires signed ?u,ts,t)
      const { u, ts, t } = event.queryStringParameters || {};
      const check = verify({ u, ts }, t);
      if (!check.ok)
        return html(403, page("Auth error", `<p>${escape(check.msg)}</p>`));
      if (!fresh(ts))
        return html(
          410,
          page("Expired", `<p>Link is older than 48 hours.</p>`)
        );

      return html(200, formPage(u, ts, t)); // inject hidden fields so POST keeps signature
    }

    if (event.httpMethod === "POST") {
      // save plan.json
      const body = parseForm(event.body || "");
      const u = (body.u || "").trim();
      const ts = (body.ts || "").trim();
      const t = (body.t || "").trim();
      const check = verify({ u, ts }, t);
      if (!check.ok)
        return html(403, page("Auth error", `<p>${escape(check.msg)}</p>`));
      if (!fresh(ts))
        return html(
          410,
          page("Expired", `<p>Link is older than 48 hours.</p>`)
        );

      // Build plan from submitted arrays
      const plan = buildPlanFromBody(body);
      if (!plan || !Array.isArray(plan.days) || plan.days.length === 0) {
        return html(
          400,
          page(
            "Invalid",
            `<p>Please add at least one day and one exercise.</p>`
          )
        );
      }

      // Write workout_splits/<username>/plan.json
      const gh = new GitHubRepo(OWNER, REPO, TOKEN);
      const path = `workout_splits/${u}/plan.json`;

      // Optional: keep previous plan if user submits identical (idempotent)
      const prev = await gh.get(path).catch(() => null);
      if (prev && deepEqual(prev.json, plan)) {
        return html(
          200,
          page("Saved", `<p>No changes. Your plan was already up to date.</p>`)
        );
      }

      await gh.put(path, plan, prev?.sha);

      return html(
        200,
        page(
          "Saved ✅",
          `<p>Your custom split has been saved for <b>${escape(u)}</b>.</p>
         <p>File: <code>${escape(path)}</code></p>
         <p>You’ll receive emails based on this plan from now on.</p>`
        )
      );
    }

    return json({ error: "method_not_allowed" }, 405);
  } catch (e) {
    return html(
      500,
      page("Server error", `<pre>${escape(String(e?.message || e))}</pre>`)
    );
  }
};

/* ----------------- helpers ----------------- */

function verify(params, token) {
  if (!SECRET)
    return { ok: false, msg: "Server misconfigured (missing SIGNING_SECRET)" };
  if (!params.u || !params.ts || !token)
    return { ok: false, msg: "Missing u/ts/t" };
  const expected = sign(params, SECRET);
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
  // content-type: application/x-www-form-urlencoded
  const out = {};
  for (const pair of String(raw).split("&")) {
    if (!pair) continue;
    const [k, v] = pair.split("=");
    const key = decodeURIComponent(k || "");
    const val = decodeURIComponent(v || "");
    // support multi keys like dayName[]
    if (key.endsWith("[]")) {
      const base = key.slice(0, -2);
      (out[base] ||= []).push(val);
    } else if (/\[\d+\]\[\]/.test(key)) {
      // exerciseName[1][], sets[2][]...
      const base = key.replace(/\[\d+\]\[\]$/, "");
      const idx = (key.match(/\[(\d+)\]\[\]$/) || [])[1];
      out[base] ||= {};
      (out[base][idx] ||= []).push(val);
    } else {
      out[key] = val;
    }
  }
  return out;
}

function buildPlanFromBody(b) {
  // Inputs created by your form:
  // dayName[]          -> array
  // bodyPart[]         -> array
  // exerciseName[1][]  -> array per day
  // sets[1][]          -> array per day
  // reps[1][]          -> array per day
  const names = b.dayName || [];
  const parts = b.bodyPart || [];
  const exNames = b.exerciseName || {};
  const sets = b.sets || {};
  const reps = b.reps || {};

  const days = [];
  for (let i = 0; i < names.length; i++) {
    const dayIdx = String(i + 1); // matches form indexes 1..N
    const list = [];
    const nArr = exNames[dayIdx] || [];
    const sArr = sets[dayIdx] || [];
    const rArr = reps[dayIdx] || [];
    const len = Math.max(nArr.length, sArr.length, rArr.length);
    for (let j = 0; j < len; j++) {
      const name = (nArr[j] || "").trim();
      if (!name) continue;
      const setsNum = Number(sArr[j] || "0");
      const repsTxt = (rArr[j] || "").trim();
      list.push({
        id: slug(`${name}-${j + 1}`),
        name,
        sets: setsNum || undefined,
        reps: repsTxt || undefined,
      });
    }
    if (list.length === 0) continue;
    days.push({
      title: names[i] || `Day ${i + 1}`,
      body_part: parts[i] || "",
      exercises: list,
    });
  }
  if (!days.length) return null;
  return { plan_title: "Custom", days }; // composite plan
}

function slug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// very small deep equal for our plan shape
function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function page(title, body) {
  return `<!doctype html><meta charset="utf-8" />
  <title>${escape(title)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;background:#1a1a1a;min-height:100vh;padding:20px;display:flex;align-items:center;justify-content:center}
    .container{width:100%;max-width:700px}
    .card{background:rgba(45,45,45,.95);backdrop-filter:blur(10px);border-radius:20px;padding:24px;border:1px solid rgba(255,255,255,.1);color:#eee}
    a.btn,button.btn{display:inline-block;padding:12px 24px;border-radius:25px;text-decoration:none;background:linear-gradient(135deg,#FFD700,#FFA500);color:#4A1458;font-weight:700;border:none;cursor:pointer}
  </style>
  <div class="container"><div class="card">${body}</div></div>`;
}
function formPage(u, ts, t) {
  // Your form HTML, with hidden fields for u/ts/t and method=POST action=/customize
  // (Trimmed styles: you can paste your full form_index.html if you prefer.)
  return `
    <h2>Create Workout Split</h2>
    <p style="color:#bbb">Design a multi-day plan. Days appear in your email rotation.</p>
    <form method="POST" action="/.netlify/functions/customize" id="workoutSplitForm">
      <input type="hidden" name="u" value="${escape(u)}" />
      <input type="hidden" name="ts" value="${escape(ts)}" />
      <input type="hidden" name="t" value="${escape(t)}" />

      <!-- Minimal starter: one day + one exercise; JS adds more -->
      <div class="section" data-day="1" style="margin:12px 0;padding:12px;border:1px solid #444;border-radius:12px">
        <div><label>Day Name</label><br/><input name="dayName[]" required placeholder="Push Day" /></div>
        <div><label>Body Part(s)</label><br/><input name="bodyPart[]" placeholder="Chest & Triceps" /></div>
        <div class="exercises">
          <div class="exercise">
            <input name="exerciseName[1][]" placeholder="Bench Press" required />
            <input name="sets[1][]" type="number" min="1" placeholder="Sets" />
            <input name="reps[1][]" placeholder="Reps" />
            <button type="button" onclick="this.parentElement.remove()">Remove</button>
          </div>
        </div>
        <button type="button" onclick="addExercise(1)">+ Add Exercise</button>
      </div>

      <div><button type="button" onclick="addDay()">+ Add Another Day</button></div>
      <div style="margin-top:16px"><button class="btn" type="submit">💾 Save Workout Split</button></div>
    </form>

    <script>
      let dayCount = 1;
      function addDay(){
        dayCount++;
        const cont = document.getElementById('workoutSplitForm');
        const before = cont.querySelector('div[style*="margin-top:16px"]');
        const wrap = document.createElement('div');
        wrap.className = 'section';
        wrap.setAttribute('data-day', dayCount);
        wrap.style = "margin:12px 0;padding:12px;border:1px solid #444;border-radius:12px";
        wrap.innerHTML = \`
          <div><strong>Day \${dayCount}</strong> <button type="button" onclick="this.closest('.section').remove()">Remove Day</button></div>
          <div><label>Day Name</label><br/><input name="dayName[]" required placeholder="Pull Day" /></div>
          <div><label>Body Part(s)</label><br/><input name="bodyPart[]" placeholder="Back & Biceps" /></div>
          <div class="exercises">
            <div class="exercise">
              <input name="exerciseName[\${dayCount}][]" placeholder="Exercise" required />
              <input name="sets[\${dayCount}][]" type="number" min="1" placeholder="Sets" />
              <input name="reps[\${dayCount}][]" placeholder="Reps" />
              <button type="button" onclick="this.parentElement.remove()">Remove</button>
            </div>
          </div>
          <button type="button" onclick="addExercise(\${dayCount})">+ Add Exercise</button>
        \`;
        cont.insertBefore(wrap, before);
      }
      function addExercise(day){
        const section = document.querySelector('.section[data-day="'+day+'"] .exercises');
        const row = document.createElement('div');
        row.className = 'exercise';
        row.innerHTML = \`
          <input name="exerciseName[\${day}][]" placeholder="Exercise" required />
          <input name="sets[\${day}][]" type="number" min="1" placeholder="Sets" />
          <input name="reps[\${day}][]" placeholder="Reps" />
          <button type="button" onclick="this.parentElement.remove()">Remove</button>
        \`;
        section.appendChild(row);
      }
    </script>
  `;
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

/* ---------- GitHub helper ---------- */
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
        "User-Agent": "netlify-customize",
        Accept: "application/vnd.github+json",
        ...(opt.headers || {}),
      },
    });
  }
  async get(path) {
    const r = await this._fetch(`${this.base}/${encodeURIComponent(path)}`);
    if (r.status === 404) throw new Error("404");
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    const content = Buffer.from(j.content, "base64").toString("utf8");
    return { sha: j.sha, json: JSON.parse(content) };
  }
  async put(path, obj, sha) {
    const body = {
      message: `save ${path}`,
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
      throw new Error(`PUT ${path} -> ${r.status} ${txt}`);
    }
    return await r.json();
  }
}
