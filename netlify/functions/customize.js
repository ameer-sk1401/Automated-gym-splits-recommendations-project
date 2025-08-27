// netlify/functions/customize.js
const crypto = require("crypto");

/** Required env:
 *  REPO_OWNER, REPO_NAME, GH_PAT, SIGNING_SECRET
 */

const OWNER = process.env.REPO_OWNER;
const REPO = process.env.REPO_NAME;
const TOKEN = process.env.GH_PAT;
const SECRET = process.env.SIGNING_SECRET;

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "GET") {
      const { u, ts, t } = event.queryStringParameters || {};
      const check = verify({ u, ts }, t);
      if (!check.ok)
        return html(403, page("Auth error", `<p>${escape(check.msg)}</p>`));
      if (!fresh(ts))
        return html(
          410,
          page("Expired", `<p>Link is older than 48 hours.</p>`)
        );
      return html(200, formPage(u, ts, t)); // serve secure form
    }

    if (event.httpMethod === "POST") {
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

      const days = buildDaysFromBody(body); // [{title, target_muscles, exercises:[{id,name,sets,reps}]}...]
      if (!days.length) {
        return html(
          400,
          page(
            "Invalid",
            `<p>Please add at least one day and one exercise.</p>`
          )
        );
      }

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

      // Save each day to workout_splits/<u>/<Title>.json (exact filenames)
      let saved = 0;
      for (const day of days) {
        const filename = titleToFilename(day.title);
        const path = `workout_splits/${u}/${filename}`;
        const prev = await gh.get(path).catch(() => null);
        if (prev && JSON.stringify(prev.json) === JSON.stringify(day)) continue;
        await gh.put(path, day, prev?.sha);
        saved++;
      }

      return html(
        200,
        page(
          "Saved ✅",
          `<p>Saved ${saved} custom day file(s) for <b>${escape(u)}</b>.</p>
         <p>Any day you didn't submit will fall back to the default split.</p>`
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

/* ----------------- signing & utils ----------------- */

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
    if (key.endsWith("[]")) {
      const base = key.slice(0, -2);
      (out[base] ||= []).push(val);
    } else if (/\[\d+\]\[\]/.test(key)) {
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

function titleToFilename(title) {
  return title.replace(/ /g, "_").replace(/\+/g, "plus") + ".json";
}

function slug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function buildDaysFromBody(b) {
  // From the form: dayName[], bodyPart[], exerciseName[1][], sets[1][], reps[1][]
  const names = b.dayName || [];
  const parts = b.bodyPart || [];
  const exNames = b.exerciseName || {};
  const sets = b.sets || {};
  const reps = b.reps || {};

  const out = [];
  for (let i = 0; i < names.length; i++) {
    const title = (names[i] || "").trim();
    if (!title) continue;

    const dayIdx = String(i + 1);
    const nArr = exNames[dayIdx] || [];
    const sArr = sets[dayIdx] || [];
    const rArr = reps[dayIdx] || [];
    const ex = [];
    for (let j = 0; j < nArr.length; j++) {
      const name = (nArr[j] || "").trim();
      if (!name) continue;
      ex.push({
        id: slug(`${name}-${j + 1}`),
        name,
        sets: sArr[j] ? Number(sArr[j]) : undefined,
        reps: rArr[j] || undefined,
      });
    }
    if (!ex.length) continue;

    const muscles = parts[i]
      ? String(parts[i])
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    out.push({
      title,
      target_muscles: muscles,
      exercises: ex,
    });
  }
  return out;
}

/* ----------------- HTML ----------------- */

function page(title, body) {
  return `<!doctype html><meta charset="utf-8" />
  <title>${escape(title)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;background:#1a1a1a;min-height:100vh;padding:20px;display:flex;align-items:center;justify-content:center}
    .container{width:100%;max-width:760px}
    .card{background:rgba(45,45,45,.95);backdrop-filter:blur(10px);border-radius:20px;padding:24px;border:1px solid rgba(255,255,255,.1);color:#eee}
    a.btn,button.btn{display:inline-block;padding:12px 24px;border-radius:25px;text-decoration:none;background:linear-gradient(135deg,#FFD700,#FFA500);color:#4A1458;font-weight:700;border:none;cursor:pointer}
    input,button{font:inherit}
    input[type="text"],input[type="number"]{width:100%;padding:10px;border-radius:10px;border:1px solid #444;background:#2a2a2a;color:#eee}
    .section{margin:12px 0;padding:12px;border:1px solid #444;border-radius:12px}
    label{color:#cfcfcf;font-size:14px}
  </style>
  <div class="container"><div class="card">${body}</div></div>`;
}

function formPage(u, ts, t) {
  return page(
    "Create Workout Split",
    `
    <h2 style="margin:0 0 8px">Create Workout Split</h2>
    <p style="color:#bbb;margin:0 0 16px">Add one or more days. Any day you omit will use the default plan.</p>
    <form method="POST" action="/.netlify/functions/customize" id="workoutSplitForm">
      <input type="hidden" name="u" value="${escape(u)}" />
      <input type="hidden" name="ts" value="${escape(ts)}" />
      <input type="hidden" name="t"  value="${escape(t)}" />

      <div id="days"></div>
      <div style="margin:12px 0"><button type="button" class="btn" onclick="addDay()">+ Add Day</button></div>
      <div style="margin-top:16px"><button class="btn" type="submit">💾 Save Workout Split</button></div>
    </form>

    <script>
      let dayCount = 0;
      function addDay(){
        dayCount++;
        const wrap = document.createElement('div');
        wrap.className = 'section';
        wrap.setAttribute('data-day', dayCount);
        wrap.innerHTML = \`
          <div style="display:flex;justify-content:space-between;align-items:center">
            <strong>Day \${dayCount}</strong>
            <button type="button" class="btn" style="padding:6px 12px" onclick="this.closest('.section').remove()">Remove Day</button>
          </div>
          <div style="margin-top:8px">
            <label>Day Name (e.g., Push Day)</label>
            <input name="dayName[]" placeholder="Push Day" required />
          </div>
          <div style="margin-top:8px">
            <label>Body Part(s) (comma-separated)</label>
            <input name="bodyPart[]" placeholder="Chest, Triceps, Shoulders" />
          </div>
          <div class="exercises" style="margin-top:8px"></div>
          <div style="margin-top:8px"><button type="button" class="btn" onclick="addExercise(\${dayCount})">+ Add Exercise</button></div>
        \`;
        document.getElementById('days').appendChild(wrap);
        addExercise(dayCount);
      }
      function addExercise(day){
        const parent = document.querySelector('.section[data-day="'+day+'"] .exercises');
        const row = document.createElement('div');
        row.style = "display:grid;grid-template-columns:2fr 1fr 1fr auto;gap:8px;align-items:end;margin:6px 0";
        row.innerHTML = \`
          <div><label>Exercise</label><input name="exerciseName[\${day}][]" required placeholder="Bench Press"/></div>
          <div><label>Sets</label><input type="number" min="1" name="sets[\${day}][]" placeholder="4" /></div>
          <div><label>Reps</label><input name="reps[\${day}][]" placeholder="8-10" /></div>
          <div><button type="button" class="btn" style="padding:6px 12px" onclick="this.parentElement.parentElement.remove()">Remove</button></div>
        \`;
        parent.appendChild(row);
      }
      // seed one day on load
      addDay();
    </script>
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
function escape(s) {
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
