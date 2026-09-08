"use strict";
/* Hearth local dashboard. Same-origin fetch; session cookie is HttpOnly.
 * All mutations send JSON (required by the server as fetch-only CSRF defense). */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (res.status === 401) { showLogin(); throw new Error("unauthorized"); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `request failed (${res.status})`);
  return body;
}

function showLogin() {
  $("login").hidden = false;
  $("tabs").hidden = true;
  $("logout").hidden = true;
  document.querySelectorAll(".tab").forEach((el) => { el.hidden = true; });
}

function showApp() {
  $("login").hidden = true;
  $("tabs").hidden = false;
  $("logout").hidden = false;
  switchTab("overview");
}

function switchTab(name) {
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab").forEach((el) => { el.hidden = el.id !== name; });
  renderers[name]();
}

$("tabs").addEventListener("click", (e) => {
  const tab = e.target.closest("button")?.dataset.tab;
  if (tab) switchTab(tab);
});

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("login-error").hidden = true;
  try {
    await api("/dashboard/api/login", { method: "POST", body: JSON.stringify({ ownerToken: $("owner-token").value }) });
    $("owner-token").value = "";
    showApp();
  } catch (err) {
    $("login-error").textContent = err.message;
    $("login-error").hidden = false;
  }
});

$("logout").addEventListener("click", async () => {
  await api("/dashboard/api/logout", { method: "POST", body: "{}" }).catch(() => {});
  showLogin();
});

const pill = (text, cls = "") => `<span class="pill ${cls}">${esc(text)}</span>`;

const renderers = {
  async overview() {
    const el = $("overview");
    try {
      const s = await api("/dashboard/api/status");
      const tasks = Object.entries(s.tasks || {}).map(([k, v]) => `${pill(`${k}: ${v}`)}`).join(" ") || "<span class='muted'>no tasks</span>";
      const providers = (s.providers || []).map((p) => `<tr><td>${esc(p.id)}</td><td>${p.enabled ? "yes" : "no"}</td><td>${p.available ? "<span class='good'>available</span>" : "<span class='muted'>unavailable</span>"}</td></tr>`).join("");
      el.innerHTML = `
        <div class="card"><h3>Status</h3>
          <div>Version ${esc(s.version)} · mode ${pill(s.mode)} · sandbox ${esc(s.sandbox)} (${esc(s.sandboxAdapter)})</div>
          <div class="muted">MCP ${esc("/mcp")} · health ${esc("/healthz")}</div></div>
        <div class="card"><h3>Tasks</h3><div>${tasks}</div></div>
        <div class="card"><h3>Providers</h3><table><tr><th>ID</th><th>Enabled</th><th>Status</th></tr>${providers}</table></div>
        <div class="card"><h3>Open workspaces</h3><pre>${esc((s.workspaces || []).map((w) => `${w.id}  ${w.root}`).join("\n") || "none")}</pre></div>`;
    } catch (err) { el.innerHTML = `<p class="error">${esc(err.message)}</p>`; }
  },

  async workspaces() {
    const el = $("workspaces");
    try {
      const w = await api("/dashboard/api/workspaces");
      const open = (w.open || []).map((o) => `<tr><td><code>${esc(o.id)}</code></td><td>${esc(o.root)}</td><td>${esc(o.mode)}</td></tr>`).join("") || `<tr><td colspan="3" class="muted">none open</td></tr>`;
      const profiles = (w.profiles || []).map((p) => `<tr><td>${esc(p.path)}</td><td>${esc(p.mode || "inherit")}</td><td>${p.agentsAllowed === false ? "agents off" : "agents on"}</td></tr>`).join("") || `<tr><td colspan="3" class="muted">no profiles</td></tr>`;
      el.innerHTML = `
        <div class="card"><h3>Allowed roots</h3><pre>${esc((w.allowedRoots || []).join("\n"))}</pre></div>
        <div class="card"><h3>Open workspaces</h3><table><tr><th>ID</th><th>Root</th><th>Mode</th></tr>${open}</table></div>
        <div class="card"><h3>Workspace profiles</h3><table><tr><th>Path</th><th>Mode</th><th>Agents</th></tr>${profiles}</table></div>`;
    } catch (err) { el.innerHTML = `<p class="error">${esc(err.message)}</p>`; }
  },

  async agents() {
    const el = $("agents");
    try {
      const w = await api("/dashboard/api/workspaces");
      if (!w.open.length) { el.innerHTML = `<p class="muted">No open workspaces.</p>`; return; }
      const sel = document.createElement("select");
      w.open.forEach((o) => { const opt = document.createElement("option"); opt.value = o.id; opt.textContent = `${o.id} — ${o.root}`; sel.appendChild(opt); });
      el.innerHTML = `<div class="card"><div class="row"></div><div id="agent-list"></div></div>`;
      el.querySelector(".row").append(sel);
      const load = async () => {
        const data = await api(`/dashboard/api/agents?workspaceId=${encodeURIComponent(sel.value)}`);
        const rows = (data.agents || []).map((a) => `<tr><td><code>${esc(a.id)}</code></td><td>${esc(a.provider)}/${esc(a.profileName)}</td><td>${esc(a.status)}</td><td>${esc((a.latestResponse || a.latestOutput || a.error || "").slice(0, 120))}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">no agents</td></tr>`;
        el.querySelector("#agent-list").innerHTML = `<table><tr><th>ID</th><th>Backend</th><th>Status</th><th>Latest</th></tr>${rows}</table>`;
      };
      sel.addEventListener("change", () => load().catch((e) => { el.querySelector("#agent-list").innerHTML = `<p class="error">${esc(e.message)}</p>`; }));
      await load();
    } catch (err) { el.innerHTML = `<p class="error">${esc(err.message)}</p>`; }
  },

  async tasks() {
    const el = $("tasks");
    try {
      const data = await api("/dashboard/api/tasks?limit=50");
      el.innerHTML = (data.tasks || []).map((t) => `
        <div class="card"><h3><code>${esc(t.id)}</code> ${pill(t.status)} ${t.completionState ? pill(t.completionState) : ""}</h3>
          <div>${esc(t.goal)}</div>
          ${t.error ? `<div class="error">${esc(t.error)}</div>` : ""}
          <pre>${esc((t.evidence || []).slice(-8).map((e) => `- [${e.kind}] ${e.summary}`).join("\n") || "no evidence yet")}</pre>
        </div>`).join("") || `<p class="muted">No tasks yet. Create one from any MCP client with task_create.</p>`;
    } catch (err) { el.innerHTML = `<p class="error">${esc(err.message)}</p>`; }
  },

  async logs() {
    const el = $("logs");
    try {
      const data = await api("/dashboard/api/logs?limit=100");
      const rows = (data.entries || []).reverse().map((e) => `<tr><td class="muted">${esc(e.ts)}</td><td>${esc(e.level)}</td><td><code>${esc(e.event)}</code></td><td>${esc(e.tool || "")}</td><td>${esc(e.workspaceId || "")}</td></tr>`).join("");
      el.innerHTML = `<div class="card"><table><tr><th>Time</th><th>Level</th><th>Event</th><th>Tool</th><th>Workspace</th></tr>${rows}</table></div>`;
    } catch (err) { el.innerHTML = `<p class="error">${esc(err.message)}</p>`; }
  },

  async config() {
    const el = $("config");
    try {
      const c = await api("/dashboard/api/config");
      const opt = (v, cur) => `<option value="${v}"${v === cur ? " selected" : ""}>${v}</option>`;
      el.innerHTML = `
        <div class="card"><h3>Execution</h3>
          <div class="row"><label>Mode <select id="cfg-mode">${opt("readonly", c.execution.mode)}${opt("supervised", c.execution.mode)}${opt("autonomous", c.execution.mode)}</select></label>
          <label>Sandbox <select id="cfg-sandbox">${opt("auto", c.execution.sandbox)}${opt("none", c.execution.sandbox)}</select></label></div>
          <div class="row"><label><input type="checkbox" id="cfg-reqsandbox" ${c.execution.requireSandboxForAutonomous ? "checked" : ""}> require sandbox for autonomous</label>
          <button class="primary" id="cfg-save-exec">Save</button></div>
          <p class="muted">Saving restarts nothing: restart <code>hearth serve</code> to apply.</p></div>
        <div class="card"><h3>Fleet lanes (JSON)</h3>
          <textarea id="cfg-lanes" rows="8" cols="60">${esc(JSON.stringify(c.fleet?.lanes ?? {}, null, 2))}</textarea>
          <div class="row"><button class="primary" id="cfg-save-lanes">Save lanes</button></div></div>
        <div class="card"><h3>Full safe config</h3><pre>${esc(JSON.stringify(c, null, 2))}</pre></div>
        <p id="cfg-msg"></p>`;
      const msg = (t, bad = false) => { const m = $("cfg-msg"); m.textContent = t; m.className = bad ? "error" : "good"; };
      $("cfg-save-exec").addEventListener("click", async () => {
        try {
          await api("/dashboard/api/config", { method: "PUT", body: JSON.stringify({ path: ["execution", "mode"], value: $("cfg-mode").value }) });
          await api("/dashboard/api/config", { method: "PUT", body: JSON.stringify({ path: ["execution", "sandbox"], value: $("cfg-sandbox").value }) });
          await api("/dashboard/api/config", { method: "PUT", body: JSON.stringify({ path: ["execution", "requireSandboxForAutonomous"], value: $("cfg-reqsandbox").checked }) });
          msg("Saved. Restart the server to apply.");
        } catch (e) { msg(e.message, true); }
      });
      $("cfg-save-lanes").addEventListener("click", async () => {
        try {
          const lanes = JSON.parse($("cfg-lanes").value);
          await api("/dashboard/api/config", { method: "PUT", body: JSON.stringify({ path: ["fleet"], value: { lanes } }) });
          msg("Lanes saved. Restart the server to apply.");
        } catch (e) { msg(e.message, true); }
      });
    } catch (err) { el.innerHTML = `<p class="error">${esc(err.message)}</p>`; }
  },

  async setup() {
    const el = $("setup");
    try {
      const s = await api("/dashboard/api/setup");
      const providers = (s.providers || []).map((p) => `<tr><td>${esc(p.id)}</td><td>${p.enabled ? "yes" : "no"}</td><td>${p.available ? "<span class='good'>ready</span>" : "<span class='muted'>missing</span>"}</td></tr>`).join("");
      el.innerHTML = `
        <div class="card"><h3>Installation checklist</h3><table>
          <tr><td>This machine</td><td><code>${esc(s.machineId || "unknown")}</code> <span class="muted">(<code>hearth id</code>)</span></td></tr>
          <tr><td>Allowed roots configured</td><td>${s.hasAllowedRoots ? "<span class='good'>yes</span>" : "<span class='error'>no — run hearth init or add roots</span>"}</td></tr>
          <tr><td>Public base URL</td><td><code>${esc(s.publicBaseUrl)}</code></td></tr>
          <tr><td>Public MCP URL</td><td><code>${esc(s.publicMcpUrl || `${s.publicBaseUrl}/mcp`)}</code></td></tr>
          <tr><td>Tool mode</td><td><code>${esc(s.toolMode || "")}</code></td></tr>
          <tr><td>Redirect hosts</td><td><code>${esc((s.redirectHosts || []).join(", "))}</code></td></tr>
          <tr><td>Subagents enabled</td><td>${s.subagentsEnabled ? "yes" : "no"}</td></tr>
          <tr><td>MCP endpoint</td><td><code>${esc(s.mcpEndpoint)}</code></td></tr>
          <tr><td>Health endpoint</td><td><code>${esc(s.healthEndpoint)}</code></td></tr>
        </table></div>
        <div class="card"><h3>Agent backends</h3><table><tr><th>ID</th><th>Enabled</th><th>Status</th></tr>${providers}</table>
        <p class="muted">Missing CLIs are optional — delegation to them fails loud with install hints. opencode needs a model allow-list from you (see its skill docs) so you never get a surprise bill.</p></div>
        <div class="card"><h3>Fleet lanes</h3><pre>${esc((s.fleetLanes || []).join("\n") || "none configured — pass target directly or add fleet.lanes in config")}</pre></div>`;
    } catch (err) { el.innerHTML = `<p class="error">${esc(err.message)}</p>`; }
  },

  async connect() {
    const el = $("connect");
    try {
      const s = await api("/dashboard/api/setup");
      const mcpUrl = s.publicMcpUrl || `${s.publicBaseUrl}/mcp`;
      el.innerHTML = `
        <div class="card"><h3>This PC</h3>
          <div>Machine <code>${esc(s.machineId || "unknown")}</code> — do not reuse this public URL on another PC.</div>
          <div>Public MCP URL: <code>${esc(mcpUrl)}</code></div>
          <div class="muted">Local: <code>${esc(s.mcpEndpoint)}</code> · health: <code>${esc(s.healthEndpoint)}</code> · tool mode: <code>${esc(s.toolMode || "")}</code></div></div>
        <div class="card"><h3>ChatGPT</h3>
          <ol><li>Keep <code>hearth serve</code> running; tunnel must proxy the whole origin, not only <code>/mcp</code>.</li>
          <li>Add connector URL <code>${esc(mcpUrl)}</code>.</li>
          <li>Approve with the Owner password (<code>~/.hearth/auth.json</code>).</li></ol></div>
        <div class="card"><h3>Claude</h3>
          <ol><li>Redirect hosts now: <code>${esc((s.redirectHosts || []).join(", "))}</code> (needs <code>claude.ai</code>).</li>
          <li>Add MCP server <code>${esc(mcpUrl)}</code>, approve with Owner password.</li>
          <li>Local-only alternative: <code>hearth token create claude-local</code> + <code>hearth mcp</code> as stdio.</li></ol></div>
        <div class="card"><h3>Any MCP client</h3>
          <div>Remote OAuth: <code>${esc(mcpUrl)}</code></div>
          <div>Local stdio: <code>hearth mcp</code> (device token via <code>hearth token create &lt;name&gt;</code> for bearer).</div>
          <p class="muted">CLI equivalent: <code>hearth connect [chatgpt|claude|generic]</code>.</p></div>`;
    } catch (err) { el.innerHTML = `<p class="error">${esc(err.message)}</p>`; }
  },
};

(async () => {
  try {
    const me = await api("/dashboard/api/me");
    if (me.authenticated) showApp();
    else showLogin();
  } catch { showLogin(); }
})();
