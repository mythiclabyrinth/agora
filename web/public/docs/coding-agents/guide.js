import { guides, sharedEnv } from "./guide-data.js";

const key = document.body.dataset.agent;
const guide = guides[key];
if (!guide) {
  document.querySelector("#docs-root").innerHTML = `
    <main class="docs-main"><h1>Guide not found</h1>
    <p>Choose a coding-agent guide from the <a href="./">documentation index</a>.</p></main>`;
  throw new Error(`Unknown coding agent: ${key}`);
}

const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));
const code = value => `<div class="docs-code"><pre><code>${escapeHtml(value)}</code></pre><button class="docs-copy" type="button">Copy</button></div>`;
const envRows = [...sharedEnv, ...guide.env].map(([name, need, fallback, detail]) => `
  <tr><td>${escapeHtml(name)}</td><td class="${need.startsWith("Required") ? "docs-required" : "docs-optional"}">${escapeHtml(need)}</td><td>${escapeHtml(fallback)}</td><td>${escapeHtml(detail)}</td></tr>
`).join("");
const commands = guide.commands.map(([name, detail]) => `
  <div class="docs-command"><code>${escapeHtml(name)}</code><span>${escapeHtml(detail)}</span></div>
`).join("");
const guideLinks = Object.entries(guides).map(([id, item]) => `
  <a class="${id === key ? "active" : ""}" href="${escapeHtml(id)}.html">${escapeHtml(item.name)}</a>
`).join("");

document.title = `${guide.name} for Agora`;
document.querySelector("#docs-root").innerHTML = `
  <div class="docs-shell">
    <aside class="docs-nav">
      <a class="docs-brand" href="../"><img src="../icon.png" alt=""><span>Agora</span></a>
      <a class="docs-eyebrow docs-index-link" href="../">All documentation</a>
      <a class="docs-eyebrow docs-index-link" href="./">Coding agents</a>
      <nav class="docs-nav-list docs-guide-switcher">${guideLinks}</nav>
      <div class="docs-eyebrow docs-page-label">On this page</div>
      <nav class="docs-nav-list docs-page-nav">
        <a href="#setup">Setup</a><a href="#commands">Commands</a>
        <a href="#configuration">Configuration</a><a href="#security">Security</a>
        <a href="#troubleshooting">Troubleshooting</a>
      </nav>
    </aside>
    <main class="docs-main">
      <header class="docs-hero">
        <img class="docs-hero-mark" src="${escapeHtml(guide.logo)}" alt="">
        <span class="docs-kicker">Agora coding agent</span>
        <h1>${escapeHtml(guide.name)}</h1>
        <p class="docs-lede">${escapeHtml(guide.description)}</p>
        <div class="docs-pills"><span class="docs-pill">Runs on your computer</span><span class="docs-pill">Outbound connection</span><span class="docs-pill">Per-channel sessions</span></div>
      </header>
      <section class="docs-section" id="setup">
        <h2>Set up ${escapeHtml(guide.short)}</h2>
        <p>${escapeHtml(guide.requirement)}</p>
        <ol class="docs-steps">
          ${guide.install ? `<li><b>Install and sign in to ${escapeHtml(guide.name)}</b>${code(guide.install.command)}<span>${escapeHtml(guide.install.note)}</span></li>` : ""}
          <li><b>Clone Agora and enter the repository</b>${code("git clone https://github.com/tomjose92/agora.git\ncd agora")}</li>
          <li><b>Create an isolated Python environment</b>${code("python3 -m venv .venv\nsource .venv/bin/activate\npython3 -m pip install --upgrade pip websockets")}</li>
          <li><b>Create access in Agora</b><span>Open <strong>Connections → Add agent → Coding agents → ${escapeHtml(guide.name)}</strong>, choose a name, and continue. Keep the generated token private.</span></li>
          <li><b>Create your local configuration</b>${code(`cp bridges/${guide.directory}/.env.example bridges/${guide.directory}/.env\nchmod 600 bridges/${guide.directory}/.env`)}<span>Open <code>bridges/${escapeHtml(guide.directory)}/.env</code> and <strong>replace</strong> its active <code>AGORA_URL</code> and <code>AGORA_PAIRING_TOKEN</code> placeholder lines. Do not append duplicate keys.</span>${code(`# Replace the placeholder connection lines with:\n${guide.exampleEnv}`)}</li>
          <li><b>Choose repository access</b><span>Set <code>${escapeHtml(guide.allowedRoots)}</code> to colon-separated parent directories. New sessions cannot start until at least one root is configured.</span></li>
          <li><b>Start the Agora agent</b>${code(guide.start)}<span>Keep this process running and the computer awake. No inbound port is opened.</span></li>
          <li><b>Add it to a channel</b><span>When Agora reports it connected, open a channel's member picker, add ${escapeHtml(guide.short)}, then use <code>/sessions</code> or <code>/new</code>.</span></li>
        </ol>
        <div class="docs-callout"><strong>Updating later:</strong> stop the process, run <code>git pull --ff-only</code> inside the Agora checkout, reactivate <code>.venv</code>, and start it again.</div>
      </section>
      <section class="docs-section" id="commands">
        <h2>Commands in Agora</h2>
        <p>Bindings and overrides are scoped to the current channel or thread.</p>
        <div class="docs-command-grid">${commands}</div>
      </section>
      <section class="docs-section" id="configuration">
        <h2>Environment variables</h2>
        <p>Put values in <code>bridges/${escapeHtml(guide.directory)}/.env</code>, export them in the shell, or pass equivalent CLI flags. Real environment variables override the file; command-line flags override both.</p>
        <div class="docs-table-wrap"><table><thead><tr><th>Variable</th><th>Requirement</th><th>Default</th><th>Behavior</th></tr></thead><tbody>${envRows}</tbody></table></div>
        <p><small><strong>*</strong> Provide either <code>AGORA_PAIRING_TOKEN</code> or <code>AGORA_PAIRING_TOKEN_FILE</code>.</small></p>
      </section>
      <section class="docs-section" id="security">
        <h2>Security model</h2>
        <p>The agent can read or modify files permitted by its allowed roots and local sandbox or permission configuration. Use the least privilege that supports the task.</p>
        <ul>
          <li>Keep pairing tokens out of shell history; prefer <code>AGORA_PAIRING_TOKEN_FILE</code> with mode 600.</li>
          <li>Set narrow allowed roots rather than an entire home directory.</li>
          <li>Treat sandbox bypass, full-access modes, and disabled sandboxes as high risk. Use them only on a trusted machine after reviewing the connector's bundled <code>SECURITY.md</code>.</li>
          <li>Leave privilege-escalation and peer-agent settings disabled unless intentionally required.</li>
          <li>Only grant Agora channel membership to people trusted with the repositories exposed to that agent.</li>
          <li>Revoke a credential from Connections immediately if its machine or token may be compromised.</li>
        </ul>
      </section>
      <section class="docs-section" id="troubleshooting">
        <h2>Troubleshooting</h2>
        <h3>Agora stays on “Waiting”</h3><p>Check <code>AGORA_URL</code>, confirm the token has not been revoked, and verify the machine can reach the Agora host. For HTTPS deployments, use the public HTTPS URL.</p>
        <h3>The connector refuses a plaintext WebSocket</h3><p>Remote coding agents reject insecure <code>ws://</code> connections because the pairing token and chat traffic would travel unencrypted. Put Agora behind HTTPS/TLS and configure its public <code>https://</code> URL. Plaintext is accepted only for loopback development.</p>
        <h3>The agent is connected but absent from a channel</h3><p>Connected agents are not automatically channel members. Add ${escapeHtml(guide.short)} with that channel's member picker.</p>
        <h3><code>/new</code> is unavailable</h3><p>Configure <code>${escapeHtml(guide.allowedRoots)}</code>, restart the process, and choose a directory beneath one of those resolved roots.</p>
        <h3>A command is blocked</h3><p>The local sandbox or permission mode is authoritative. Adjust it locally only after reviewing the security implications above.</p>
      </section>
      <footer class="docs-footer"><span class="docs-check">●</span> This guide is bundled with your Agora version. Configuration coverage is checked in CI.</footer>
    </main>
  </div>
`;

document.querySelectorAll(".docs-copy").forEach(button => {
  button.addEventListener("click", async () => {
    const text = button.previousElementSibling.textContent;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(button.previousElementSibling);
        selection.removeAllRanges();
        selection.addRange(range);
        if (!document.execCommand("copy")) throw new Error("Copy unavailable");
        selection.removeAllRanges();
      }
      button.textContent = "Copied";
    } catch {
      button.textContent = "Select and copy";
    }
    setTimeout(() => { button.textContent = "Copy"; }, 1200);
  });
});
