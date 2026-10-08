import type { FC, Child } from "hono/jsx";
import { html } from "hono/html";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const NAV_ITEMS = [
  { href: "/", label: "Dashboard", icon: "⊞" },
  { href: "/projects", label: "Projects", icon: "◰" },
  { href: "/separator", label: "", icon: "" },
  { href: "/auth/git-hosting", label: "Git Hosting", icon: "⬣" },
  { href: "/providers", label: "Providers", icon: "🔌" },
  { href: "/agent-models", label: "Agent Models", icon: "◈" },
  { href: "/secrets", label: "Secrets", icon: "🔐" },
  { href: "/separator3", label: "", icon: "" },
  { href: "/upgrade", label: "Versions & Upgrade", icon: "▲" },
  { href: "/leanctx", label: "LeanCTX Config", icon: "📐" },
  { href: "/lsp", label: "LSP Servers", icon: "🧩" },
  { href: "/agent", label: "Center Connection", icon: "⇄" },
  { href: "/openchamber", label: "OpenChamber", icon: "◉" },
];

const ASSET_DATE = "20260816";
const ASSET_ROOT = new URL("../static/", import.meta.url);

function assetHash(name: string): string {
  return createHash("sha256")
    .update(readFileSync(new URL(name, ASSET_ROOT)))
    .digest("hex")
    .slice(0, 12);
}

const STYLE_ASSET_VERSION = `${ASSET_DATE}-${assetHash("style.css")}`;
const APP_ASSET_VERSION = `${ASSET_DATE}-${assetHash("app.js")}`;
export const AGENT_MODELS_ASSET_VERSION = `${ASSET_DATE}-${assetHash("agent-models-attention.js")}`;

interface LayoutProps {
  title: string;
  children: Child;
  currentPath?: string;
}

export const Layout: FC<LayoutProps> = ({ title, children, currentPath }) => {
  return (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{title} — AI-EngKit Admin</title>
        <link rel="icon" type="image/svg+xml" href="/static/favicon.svg" />
        <link rel="alternate icon" href="/static/favicon.ico" sizes="any" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
        <script>{html`
          (function() {
            function checkMobile() {
              var isMobile = window.innerWidth <= 768 ||
                (navigator.maxTouchPoints > 0 && window.innerWidth <= 1024);
              if (isMobile) {
                document.documentElement.classList.add("mobile");
              } else {
                document.documentElement.classList.remove("mobile");
              }
            }
            checkMobile();
            window.addEventListener("resize", checkMobile);
          })();
        `}</script>
        <link rel="stylesheet" href={`/static/style.css?v=${STYLE_ASSET_VERSION}`} />
      </head>
      <body>
        <div class="app-layout">
          <div class="topbar">
            <button id="nav-toggle" aria-label="Toggle navigation menu">☰</button>
            <div class="flex items-center gap-2" style="font-size:1.1rem;font-weight:700;">
              <img src="/static/favicon.svg" alt="AI-EngKit" style="width:28px;height:28px;" />
              <span>AI-EngKit</span>
            </div>
          </div>
          <aside class="sidebar">
            <div class="logo" style="display:flex;align-items:center;gap:10px;">
              <img src="/static/favicon.svg" alt="AI-EngKit" style="width:36px;height:36px;" />
              <div>
                <div style="font-size:1.1rem;font-weight:700;line-height:1.2;">AI-EngKit</div>
                <div class="subtitle" style="font-size:0.7rem;">Admin Dashboard</div>
              </div>
            </div>
            <nav>
              {NAV_ITEMS.map((item) => (
                item.href.startsWith("/separator")
                  ? <div style="height:1px;background:var(--border);margin:8px 12px;" />
                  : <a
                      href={item.href}
                      class={(currentPath === item.href || (item.href !== "/" && currentPath?.startsWith(`${item.href}/`)))
                        ? "active" : ""}
                    >
                      <span>{item.icon}</span>
                      <span>{item.label}</span>
                    </a>
              ))}
              <div class="nav-icons">
                <a href="#" onclick="document.getElementById('about-modal').style.display='flex';return false;" aria-label="About">
                  <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8" cy="8" r="6.5" /><line x1="8" y1="7" x2="8" y2="11" stroke-linecap="round" /><circle cx="8" cy="5" r="0.8" fill="currentColor" stroke="none" /></svg><span class="visually-hidden">About</span>
                </a>
                <a href="/api/logout" aria-label="Logout">
                  <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M6 2.5h-2.5v11H6" stroke-linecap="round" stroke-linejoin="round" /><path d="M11 5.5 13.5 8 11 10.5" stroke-linecap="round" stroke-linejoin="round" /><line x1="13" y1="8" x2="6.5" y2="8" stroke-linecap="round" /></svg><span class="visually-hidden">Logout</span>
                </a>
              </div>
            </nav>
          </aside>
          <div class="nav-backdrop" id="nav-backdrop"></div>
          <main class="main-content">
            <div id="global-banner" />
            {children}
          </main>
        </div>
        <div id="about-modal" class="modal-overlay" style="display:none;" onclick="if(event.target===this)this.style.display='none';">
          <div class="modal" style="max-width:400px;text-align:center;">
            <img src="/static/favicon.svg" alt="AI-EngKit" style="width:140px;height:140px;margin:0 auto 12px;" />
            <h2 style="margin-bottom:4px;font-size:1.4rem;">AI-EngKit</h2>
            <p class="text-muted" style="margin-bottom:16px;font-size:0.85rem;" id="about-version">AI-EngKit Admin</p>
            <script>{html`
              fetch("/api/versions/image").then(r => r.json()).then(function(d) {
                var el = document.getElementById("about-version");
                if (el && d.version) el.textContent = "AI-EngKit Admin " + d.version;
              }).catch(function() {});
            `}</script>
            <p style="margin-bottom:20px;font-size:0.85rem;color:var(--text-muted);">Empowering AI builders to create, automate, and innovate.</p>
            <div class="flex gap-2" style="justify-content:center;margin-bottom:16px;">
              <a href="https://github.com/tryweb/ai-engkit" target="_blank" rel="noopener" class="btn-outline" style="text-decoration:none;font-size:0.85rem;display:inline-flex;align-items:center;gap:6px;"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>GitHub</a>
              <a href="https://discord.gg/ZcFTYTWvZ2" target="_blank" rel="noopener" class="btn-outline" style="text-decoration:none;font-size:0.85rem;display:inline-flex;align-items:center;gap:6px;"><svg width="16" height="16" viewBox="0 0 127.14 96.36" fill="currentColor"><path d="M107.7,8.07A105.15,105.15,0,0,0,81.47,0a72.06,72.06,0,0,0-3.36,6.83A97.68,97.68,0,0,0,49,6.83,72.37,72.37,0,0,0,45.64,0,105.89,105.89,0,0,0,19.39,8.09C2.79,32.65-1.71,56.6.54,80.21h0A105.73,105.73,0,0,0,32.71,96.36,77.7,77.7,0,0,0,39.6,85.25a68.42,68.42,0,0,1-10.85-5.18c.91-.66,1.8-1.34,2.66-2a75.57,75.57,0,0,0,64.32,0c.87.71,1.76,1.39,2.66,2a68.42,68.42,0,0,1-10.87,5.19,77,77,0,0,0,6.89,11.1A105.25,105.25,0,0,0,126.6,80.22h0C129.24,52.84,122.09,29.11,107.7,8.07ZM42.45,65.69C36.18,65.69,31,60,31,53s5-12.74,11.43-12.74C49,40.23,54,46,54,53S48.84,65.69,42.45,65.69Zm42.24,0C78.41,65.69,73.25,60,73.25,53s5-12.74,11.45-12.74C91.25,40.23,96.25,46,96.25,53S91.07,65.69,84.69,65.69Z"/></svg>Discord</a>
            </div>
            <button class="btn-outline" onclick="document.getElementById('about-modal').style.display='none';">Close</button>
          </div>
        </div>
        <script src={`/static/app.js?v=${APP_ASSET_VERSION}`} />
      </body>
    </html>
  );
};
