import type { FC } from "hono/jsx";
import { html } from "hono/html";
import { Layout } from "./layout";

interface SshKey {
  name: string;
  fingerprint: string;
  type: string;
}

const SshKeysContent: FC<{ keys: SshKey[] }> = ({ keys }) => (
  <div>
    <div class="flex items-center justify-between mb-4">
      <h2>SSH Keys</h2>
      <button type="button" onclick="showGenerateForm()" class="btn-outline">+ Generate Key</button>
    </div>
    <div class="card">
      <table>
        <tr><th>Name</th><th>Type</th><th>Fingerprint</th><th></th><th></th><th></th></tr>
        {keys.map(k => (
          <tr key={k.name}>
            <td><code>{k.name}</code></td>
            <td>{k.type}</td>
            <td><code>{k.fingerprint}</code></td>
            <td><button type="button" class="btn-outline" style="padding:4px 8px;font-size:0.75rem;" onclick={`showPubKey('${k.name}')`}>Public Key</button></td>
            <td style="white-space:nowrap;">
              <button type="button" class="btn-outline" style="padding:3px 6px;font-size:0.7rem;margin-right:4px;" onclick={`copyDeploy('${k.name}','linux')`}>Linux</button>
              <button type="button" class="btn-outline" style="padding:3px 6px;font-size:0.7rem;" onclick={`copyDeploy('${k.name}','windows')`}>Win</button>
            </td>
            <td><button type="button" class="btn-outline" style="padding:3px 6px;font-size:0.7rem;color:var(--danger);border-color:var(--danger);" onclick={`deleteKey('${k.name}')`}>✕</button></td>
          </tr>
        ))}
        {keys.length === 0 && <tr><td colspan={6} class="text-muted">No SSH keys found</td></tr>}
      </table>
    </div>
    <div id="generate-modal" class="modal-overlay" style="display:none;">
      <div class="modal">
        <h3>Generate SSH Key</h3>
        <div class="form-group"><label for="key-name">Key Name</label><input type="text" id="key-name" placeholder="id_ed25519" /></div>
        <div class="form-group"><label for="key-type">Type</label>
          <select id="key-type"><option value="ed25519">Ed25519</option><option value="rsa">RSA 4096</option></select>
        </div>
        <div class="form-group"><label for="key-passphrase">Passphrase (optional)</label><input type="password" id="key-passphrase" /></div>
        <div id="gen-error" class="text-sm text-danger" style="display:none;margin-bottom:8px;" />
        <div class="flex gap-2" style="justify-content:flex-end;">
          <button type="button" class="btn-outline" onclick="closeGenerate()">Cancel</button>
          <button type="button" onclick="generateKey()">Generate</button>
        </div>
      </div>
    </div>
    <div id="pubkey-modal" class="modal-overlay" style="display:none;">
      <div class="modal">
        <h3>Public Key</h3>
        <pre id="pubkey-content" style="user-select:all;" />
        <div class="flex gap-2" style="justify-content:flex-end;margin-top:12px;">
          <button type="button" onclick="copyPubKey()">Copy</button>
          <button type="button" class="btn-outline" onclick="closePubKey()">Close</button>
        </div>
      </div>
    </div>
    <script>{html`
      function showGenerateForm() { document.getElementById("generate-modal").style.display = "flex"; }
      function closeGenerate() { document.getElementById("generate-modal").style.display = "none"; }
      async function generateKey() {
        const name = document.getElementById("key-name").value.trim() || "id_ed25519";
        const type = document.getElementById("key-type").value;
        const passphrase = document.getElementById("key-passphrase").value;
        const res = await fetch("/api/ssh/keys", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, type, passphrase }),
        });
        if (res.ok) { location.reload(); }
        else { const d = await res.json(); document.getElementById("gen-error").style.display = "block";
          document.getElementById("gen-error").textContent = d.error || "Failed to generate"; }
      }
      async function showPubKey(name) {
        const res = await fetch("/api/ssh/keys/" + encodeURIComponent(name) + "/pub");
        if (res.ok) {
          document.getElementById("pubkey-content").textContent = await res.text();
          document.getElementById("pubkey-modal").style.display = "flex";
        } else { alert("Failed to load public key"); }
      }
      function closePubKey() { document.getElementById("pubkey-modal").style.display = "none"; }
      async function copyDeploy(name, os) {
        const btn = event.target;
        const orig = btn.textContent;
        const res = await fetch("/api/ssh/keys/" + encodeURIComponent(name) + "/pub");
        if (!res.ok) { alert("Failed to load public key"); return; }
        const pubkey = (await res.text()).trim();
        let cmd;
        if (os === "linux") {
          cmd = "mkdir -p ~/.ssh && echo '" + pubkey + "' >> ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys && echo 'SSH key deployed'";
        } else {
          cmd = "$d=\\\"$env:USERPROFILE\\\\.ssh\\\"; if(!(Test-Path $d)){mkdir $d|out-null}; Add-Content $d\\\\authorized_keys '" + pubkey + "'; icacls $d\\\\authorized_keys /inheritance:r /grant \\\"$env:USERNAME:(R)\\\" 2>$null; Write-Host 'SSH key deployed'";
        }
        try { await navigator.clipboard.writeText(cmd); } catch {
          const ta = document.createElement("textarea"); ta.value = cmd;
          ta.style.position = "fixed"; ta.style.left = "-9999px";
          document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
        }
        btn.textContent = "\u2713 Copied!";
        setTimeout(function() { btn.textContent = orig; }, 2000);
      }
      async function deleteKey(name) {
        if (!confirm('Delete SSH key "' + name + '"? This will permanently remove the private key. You will lose SSH access to any host using this key.')) return;
        const res = await fetch("/api/ssh/keys/" + encodeURIComponent(name), { method: "DELETE" });
        if (res.ok) { location.reload(); }
        else { const d = await res.json(); alert(d.error || "Failed to delete key"); }
      }
      async function copyPubKey() {
        const el = document.getElementById("pubkey-content");
        const text = el.textContent;
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.style.position = "fixed";
          ta.style.left = "-9999px";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
        }
        el.textContent = text + "  \u2713 Copied!";
        setTimeout(() => { el.textContent = text; }, 1500);
      }
    `}</script>
  </div>
);

export function SshKeysPage(keys: SshKey[]) {
  return (
    <Layout title="SSH Keys" currentPath="/ssh-keys">
      <SshKeysContent keys={keys} />
    </Layout>
  );
}
