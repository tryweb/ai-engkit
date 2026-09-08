import type { FC } from "hono/jsx";
import { html } from "hono/html";
import { Layout } from "./layout";
import type { GainStats, LeanCtxSiteStats, ProveReportStats, SavingsReportStats, ValueReportStats } from "../lib/project-tool-status";
import type { DashboardCenterSummary, DashboardRuntimeProfile, ProviderSummary, SubagentSummary } from "../lib/dashboard-aggregates";
import { deriveSecurity, formatArchive, formatCompression, formatPermissionInheritance, formatTools, formatApplyState, formatBytesEnUs, formatIntEnUs, deriveDbHealthFreeSpaceTone } from "../lib/dashboard-aggregates";
import type { DbHealthSummary } from "../lib/dashboard-aggregates";

interface UpdateCheckResult {
  current: string;
  latest: string;
  update_available: boolean;
  status: "checking" | "up-to-date" | "update-available" | "check-failed" | "pinned";
  configured: string | null;
  message: string;
}

interface UpgradeEvent {
  id: number;
  step: string;
  status: string;
  message: string;
  timestamp: string;
}

interface DashboardData {
  container_status: string;
  uptime_seconds: number | null;
  versions: Record<string, string>;
  gh_auth: string;
  glab_auth: string;
  git_user: string;
  project_count: number;
  ssh_key_count: number;
  center?: DashboardCenterSummary;
  runtimeProfile?: DashboardRuntimeProfile;
  providerSummary?: ProviderSummary;
  subagentSummary?: SubagentSummary;
  leanctx: LeanCtxSiteStats | null;
  gain: GainStats | null;
  valueReport: ValueReportStats | null;
  proveReport: ProveReportStats | null;
  savingsReport: SavingsReportStats | null;
  update_check: UpdateCheckResult;
  upgrade_state: string;
  upgrade_events: UpgradeEvent[];
  upgrade_current_step: string;
  upgrade_progress_pct: number;
  admin_version: string;
  admin_version_mismatch: boolean;
  dbHealth?: DbHealthSummary | null;
}

const UpdateBadge: FC<{ check: UpdateCheckResult; adminVersion: string }> = ({ check, adminVersion }) => {
  if (check.status === "pinned") {
    return <span class="badge" style="background:rgba(99,102,241,0.15);color:var(--accent);font-size:0.65rem;">● Pinned {check.configured || check.current}</span>;
  }
  if (check.status === "update-available") {
    return <span class="badge badge-warning" style="cursor:pointer;" onclick="startUpgrade()">▲ Upgrade</span>;
  }
  if (check.status === "check-failed") {
    return <span class="badge" style="background:rgba(139,143,163,0.15);color:var(--text-muted);font-size:0.65rem;">? unavailable</span>;
  }
  if (adminVersion === "dev") {
    return null;
  }
  return <span class="badge badge-success" style="font-size:0.65rem;">✓ Latest</span>;
};

type PillTone = "success" | "danger" | "warning" | "neutral";

/** Reusable status pill — tone maps to .status-pill--{tone}; ariaLabel for glyph-only labels. */
const StatusPill: FC<{ tone: PillTone; label: string; ariaLabel?: string }> = ({ tone, label, ariaLabel }) => (
  <span class={`status-pill status-pill--${tone}`} aria-label={ariaLabel}>{label}</span>
);

/** Reusable overview metric card — dl/dt/dd semantics; optional accent tone for the headline metric. */
const MetricCard: FC<{
  title: string;
  value: string;
  sub?: string;
  foot?: string;
  tone?: "default" | "accent";
}> = ({ title, value, sub, foot, tone = "default" }) => (
  <dl class={`metric-card${tone === "accent" ? " metric-card--accent" : ""}`}>
    <dt class="metric-card__title">{title}</dt>
    <dd class="metric-card__value">{value}</dd>
    {sub && <dd class="metric-card__sub">{sub}</dd>}
    {foot && <dd class="metric-card__foot">{foot}</dd>}
  </dl>
);

const DashboardContent: FC<{ data: DashboardData }> = ({ data }) => {
  const isRunning = data.container_status === "running";
  const isUpgrading = data.upgrade_state === "running";
  const { gain, leanctx, valueReport, proveReport, savingsReport } = data;
  const uptime = data.uptime_seconds != null ? `${Math.floor(data.uptime_seconds / 60)}m` : null;
  const center = data.center ?? { state: "unavailable" as const, label: "Unavailable", tone: "danger" as const, href: "/agent" as const, ariaLabel: "Center Unavailable" };
  const runtimeProfile = data.runtimeProfile ?? { applyState: "runtime-unavailable" as const, source: "unavailable" as const, compressionLevel: null, toolProfile: null, permissionInheritance: null, crossProjectSearch: null, secretDetectionEnabled: null, secretRedactionEnabled: null, archiveEnabled: null, archiveMaxAgeHours: null, archiveMaxDiskMb: null };
  const providerSummary = data.providerSummary ?? { state: "unavailable" as const, totalCount: 0, issueCount: 0, label: "Status unavailable", tone: "neutral" as const, href: "/providers" as const };
  const subagentSummary = data.subagentSummary ?? { state: "unavailable" as const, configuredCount: 0, worstCount: 0, label: "Status unavailable", tone: "neutral" as const, href: "/agent-models" as const };
  return (
    <div class="dashboard">
      <h2 class="dashboard__heading">Dashboard</h2>

      <section class="site-summary" aria-label="Site summary">
        <span class="site-summary__item">
          <StatusPill tone={isRunning ? "success" : "danger"} label={data.container_status} />
          {uptime && <span class="site-summary__value">{uptime} uptime</span>}
        </span>
        <a href="/projects" class="site-summary__item site-summary__item--link" aria-label={`Projects ${data.project_count} workspace projects`}>
          <span class="site-summary__label">Projects</span>
          <strong class="site-summary__value">{data.project_count}</strong>
        </a>
        <a href="/auth/git-hosting" class="site-summary__item site-summary__item--link" aria-label={`GitHub ${data.gh_auth}`}>
          <span class="site-summary__label">GitHub</span>
          <StatusPill tone={data.gh_auth === "authenticated" ? "success" : "warning"} label={data.gh_auth === "authenticated" ? "✓" : "✗"} ariaLabel={`GitHub ${data.gh_auth}`} />
        </a>
        <a href="/auth/git-hosting" class="site-summary__item site-summary__item--link" aria-label={`GitLab ${data.glab_auth}`}>
          <span class="site-summary__label">GitLab</span>
          <StatusPill tone={data.glab_auth === "authenticated" ? "success" : "warning"} label={data.glab_auth === "authenticated" ? "✓" : "✗"} ariaLabel={`GitLab ${data.glab_auth}`} />
        </a>
        <a href="/auth/git-hosting" class="site-summary__item site-summary__item--link" aria-label={data.git_user ? `Git ${data.git_user}` : "Git not configured"}>
          <span class="site-summary__label">Git</span>
          <span class={`site-summary__value${data.git_user ? "" : " text-muted"}`}>{data.git_user || "not configured"}</span>
        </a>
        <a href="/ssh-keys" class="site-summary__item site-summary__item--link" aria-label={`SSH keys ${data.ssh_key_count}`}>
          <span class="site-summary__label">SSH Keys</span>
          <StatusPill tone={data.ssh_key_count > 0 ? "success" : "warning"} label={String(data.ssh_key_count)} ariaLabel={`SSH keys ${data.ssh_key_count}`} />
        </a>
        <a href={center.href} class="site-summary__item site-summary__item--link" aria-label={center.ariaLabel}>
          <span class="site-summary__label">Center</span>
          <StatusPill tone={center.tone} label={center.label} ariaLabel={center.ariaLabel} />
        </a>
        {data.admin_version_mismatch && (
          <span class="site-summary__item">
            <StatusPill tone="warning" label={`⚠ ${data.admin_version}`} ariaLabel="Admin container version mismatch" />
          </span>
        )}
        <span class="site-summary__item">
          <UpdateBadge check={data.update_check} adminVersion={data.admin_version} />
        </span>
      </section>

      {!isRunning && (
        <div class="card" style="border-color:var(--danger);">
          <strong class="text-danger">⚠ ai-dev container is not running</strong>
          <p class="text-sm text-muted mt-4">Some features (auth, SSH, git, projects, upgrade) are unavailable while ai-dev is down.</p>
        </div>
      )}

      <section class="metric-row" aria-label="Overview metrics">
        <MetricCard
          title="Token Savings"
          tone="accent"
          value={gain ? new Intl.NumberFormat("en-US").format(gain.netTokensSaved) : "—"}
          sub={gain ? `$${gain.netUsdSaved.toFixed(2)} net saved` : "unavailable"}
          foot={gain ? `${gain.compressionPct.toFixed(1)}% compression` : undefined}
        />
        <MetricCard
          title="leanCTX Memory"
          value={leanctx ? new Intl.NumberFormat("en-US").format(leanctx.totalMemoryFacts) : "—"}
          sub={leanctx ? `${new Intl.NumberFormat("en-US").format(leanctx.projectsWithFacts)} projects with facts` : "unavailable"}
          foot={leanctx ? `${new Intl.NumberFormat("en-US").format(leanctx.healthCoverage)} projects with health score` : undefined}
        />
        <MetricCard
          title="leanCTX Activity"
          value={leanctx ? new Intl.NumberFormat("en-US").format(leanctx.activeProjects24h) : "—"}
          sub={leanctx ? "active in last 24h" : "unavailable"}
          foot={gain ? (gain.ledgerVerified ? `✓ ledger intact · ${new Intl.NumberFormat("en-US").format(gain.ledgerEvents)} events` : "⚠ ledger unverified") : undefined}
        />
      </section>
      {(() => {
        const apply = formatApplyState(runtimeProfile.applyState);
        const comp = formatCompression(runtimeProfile.compressionLevel);
        const tools = formatTools(runtimeProfile.toolProfile);
        const arch = formatArchive(runtimeProfile.archiveEnabled, runtimeProfile.archiveMaxAgeHours);
        const sec = deriveSecurity({ secretDetectionEnabled: runtimeProfile.secretDetectionEnabled, secretRedactionEnabled: runtimeProfile.secretRedactionEnabled, crossProjectSearch: runtimeProfile.crossProjectSearch });
        const perm = formatPermissionInheritance(runtimeProfile.permissionInheritance);
        const isUnavailable = runtimeProfile.applyState === "runtime-unavailable";
        return (
          <section class="runtime-profile card" aria-label="LeanCTX Runtime Profile">
            <div class="runtime-profile__header">
              <h3>LeanCTX Runtime</h3>
              <a href="/leanctx" class="btn btn-outline runtime-profile__action">Open configuration</a>
            </div>
            {isUnavailable ? (
              <div class="runtime-profile__fields runtime-profile__fields--unavailable">
                <span class={`status-pill status-pill--${apply.tone}`} aria-label={apply.ariaLabel}>{apply.value}</span>
              </div>
            ) : (
              <dl class="runtime-profile__fields">
                <div class="runtime-profile__field">
                  <dt class="runtime-profile__label">{apply.label}</dt>
                  <dd class={`runtime-profile__value status-pill status-pill--${apply.tone}`} aria-label={apply.ariaLabel}>{apply.value}</dd>
                </div>
                <div class="runtime-profile__field">
                  <dt class="runtime-profile__label">{comp.label}</dt>
                  <dd class={`runtime-profile__value status-pill status-pill--${comp.tone}`} aria-label={comp.ariaLabel}>{comp.value}</dd>
                </div>
                <div class="runtime-profile__field">
                  <dt class="runtime-profile__label">{tools.label}</dt>
                  <dd class={`runtime-profile__value status-pill status-pill--${tools.tone}`} aria-label={tools.ariaLabel}>{tools.value}</dd>
                </div>
                <div class="runtime-profile__field runtime-profile__field--security">
                  <dt class="runtime-profile__label">{sec.label}</dt>
                  <dd class={`runtime-profile__value status-pill status-pill--${sec.tone}`} aria-label={sec.ariaLabel} aria-describedby="runtime-profile-security-detail" tabIndex={0}>{sec.value}</dd>
                  <div id="runtime-profile-security-detail" class="runtime-profile__security-detail" role="tooltip">
                    {sec.detail.map((d) => <span>{d.label}: {d.value}</span>)}<span>Permission inheritance: {perm}</span>
                  </div>
                </div>
                <div class="runtime-profile__field">
                  <dt class="runtime-profile__label">{arch.label}</dt>
                  <dd class={`runtime-profile__value status-pill status-pill--${arch.tone}`} aria-label={arch.ariaLabel}>{arch.value}</dd>
                </div>
              </dl>
            )}
          </section>
        );
      })()}

      <div class="dashboard__ops-row">
        <div class="card">
          <h3>Container Status</h3>
          <div class="flex items-center gap-2">
            <span class={`badge ${isRunning ? "badge-success" : "badge-danger"}`}>{data.container_status}</span>
            {data.uptime_seconds != null && <span class="text-sm text-muted">Uptime: {Math.floor(data.uptime_seconds / 60)}m</span>}
          </div>
          {isRunning && (
            <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border);">
              <div class="flex items-center gap-2">
                <span id="dash-restart-status" class="text-sm text-muted"></span>
                <button id="btn-dash-restart" onclick="dashRestartAiDev()" class="btn-outline" style="color:var(--danger);border-color:var(--danger);">↻ Restart ai-dev</button>
              </div>
            </div>
          )}
          {data.admin_version_mismatch && (
            <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border);">
              <div class="flex items-center gap-2">
                <span class="text-sm">ai-admin</span>
                <span class="badge badge-warning" style="font-size:0.65rem;">⚠ {data.admin_version}</span>
              <button onclick="restartAdmin(event)" class="btn-outline" style="padding:2px 8px;font-size:0.7rem;color:var(--danger);border-color:var(--danger);">↻ Restart</button>
              </div>
              <p class="text-sm text-muted" style="margin-top:4px;">Admin container needs restart to match ai-dev version</p>
            </div>
          )}
        </div>
        <a href="/projects" class="card card--link" aria-label={`Projects ${data.project_count} workspace projects`}>
          <h3>Projects</h3>
          <p class="stat-number">{data.project_count}</p>
          <p class="text-sm text-muted">workspace projects</p>
        </a>
      <section class="ai-runtime card" aria-label="AI Runtime">
        <div class="ai-runtime__header">
          <h3>AI Runtime</h3>
        </div>
        <div class="ai-runtime__rows">
          <a href={providerSummary.href} class="ai-runtime__row">
            <span class="ai-runtime__label">Providers</span>
            <span class={`ai-runtime__value status-pill status-pill--${providerSummary.tone}`} aria-label={`Providers ${providerSummary.label}`}>{providerSummary.label}</span>
          </a>
          <a href={subagentSummary.href} class="ai-runtime__row">
            <span class="ai-runtime__label">Subagents</span>
            <span class={`ai-runtime__value status-pill status-pill--${subagentSummary.tone}`} aria-label={`Subagents ${subagentSummary.label}`}>{subagentSummary.label}</span>
          </a>
        </div>
      </section>
      </div>
      <section class="db-health card" aria-label="Database Health">
        <div class="db-health__header">
          <h3>Database Health</h3>
          <div class="db-health__header-actions">
            {data.dbHealth ? (
              <StatusPill tone={deriveDbHealthFreeSpaceTone(data.dbHealth.freeSpaceBytes)} label={data.dbHealth.freeSpaceBytes !== null ? formatBytesEnUs(data.dbHealth.freeSpaceBytes) + " free" : "free space unknown"} ariaLabel={data.dbHealth.freeSpaceBytes !== null ? `Free space ${formatBytesEnUs(data.dbHealth.freeSpaceBytes)}` : "Free space unknown"} />
            ) : (
              <StatusPill tone="neutral" label="unavailable" ariaLabel="Database health unavailable" />
            )}
            <a href="/retention-policy" class="db-health__link">Configure retention →</a>
          </div>
        </div>
        {data.dbHealth ? (
          <div class="db-health__metrics">
            <MetricCard title="DB File Size" value={formatBytesEnUs(data.dbHealth.fileSizeBytes)} />
            <MetricCard title="Sessions" value={formatIntEnUs(data.dbHealth.rowCounts.session)} />
            <MetricCard title="Events" value={formatIntEnUs(data.dbHealth.rowCounts.event)} />
            <MetricCard title="Messages" value={formatIntEnUs(data.dbHealth.rowCounts.message)} />
            <MetricCard title="Parts" value={formatIntEnUs(data.dbHealth.rowCounts.part)} />
          </div>
        ) : (
          <p class="text-sm text-muted">Health data unavailable — probe failed or timed out.</p>
        )}
      </section>
      <section class="insights card" aria-label="LeanCTX Insights">
        <h3>LeanCTX Insights</h3>
        <div class="insights__grid">
        <div class="insights__subsection insights__subsection--wide">
          <h4 class="insights__title">Savings Economics</h4>
          {data.gain ? (
            <div>
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
                <span class="text-sm text-muted">gross saved</span>
                <span class="text-sm">{`$${data.gain.grossUsdSaved.toFixed(2)}`} ({new Intl.NumberFormat("en-US").format(data.gain.tokensSaved)} tokens)</span>
              </div>
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
                <span class="text-sm text-muted">stream overhead</span>
                <span class="text-sm">{`$${data.gain.overheadUsd.toFixed(2)}`} ({new Intl.NumberFormat("en-US").format(data.gain.bounceTokens)} bounce tokens)</span>
              </div>
              <div style="display:flex;align-items:center;justify-content:space-between;padding-top:8px;border-top:1px solid var(--border);">
                <span class="text-sm text-muted">savings ledger</span>
                {data.gain.ledgerVerified ? (
                  <span class="badge badge-success" style="font-size:0.8rem;">✓ SHA-256 chain intact · {new Intl.NumberFormat("en-US").format(data.gain.ledgerEvents)} events</span>
                ) : (
                  <span class="badge badge-warning" style="font-size:0.8rem;">⚠ chain unverified</span>
                )}
              </div>
            </div>
          ) : (
            <p class="text-sm text-muted">Data unavailable</p>
          )}
        </div>
        <div class="insights__subsection">
          <h4 class="insights__title">Decision Quality</h4>
          {data.valueReport ? (
            data.valueReport.totalTasks > 0 ? (
              <div class="flex items-center gap-2" style="flex-wrap:wrap;">
                <span class="badge" style="font-size:0.8rem;">{new Intl.NumberFormat("en-US").format(data.valueReport.totalTasks)} tasks assessed</span>
                <span class="badge" style="font-size:0.8rem;">{`${(data.valueReport.acceptedRate <= 1 ? data.valueReport.acceptedRate * 100 : data.valueReport.acceptedRate).toFixed(1)}%`} acceptance</span>
                <span class="badge" style="font-size:0.8rem;">CPAO {new Intl.NumberFormat("en-US").format(data.valueReport.cpaoMicros)}μs</span>
                <span class="badge" style="font-size:0.8rem;">ETPAO {new Intl.NumberFormat("en-US").format(data.valueReport.etpaoTokens)} tokens</span>
              </div>
            ) : (
              <p class="text-sm text-muted">No assessments recorded yet</p>
            )
          ) : (
            <p class="text-sm text-muted">Data unavailable</p>
          )}
        </div>
        <div class="insights__subsection">
          <h4 class="insights__title">Evidence</h4>
          {data.proveReport ? (
            data.proveReport.totalTasks > 0 ? (
              <div class="flex items-center gap-2" style="flex-wrap:wrap;">
                <span class="badge" style="font-size:0.8rem;">{new Intl.NumberFormat("en-US").format(data.proveReport.totalTasks)} tasks proven</span>
                <span class={`badge ${data.proveReport.evidenceChainComplete ? "badge-success" : "badge-warning"}`} style="font-size:0.8rem;">
                  {data.proveReport.evidenceChainComplete ? "Chain complete" : "Chain incomplete"}
                </span>
                <span class="badge" style="font-size:0.8rem;">ledger {new Intl.NumberFormat("en-US").format(data.proveReport.ledger.itemCount)} items</span>
              </div>
            ) : (
              <p class="text-sm text-muted">No evidence data</p>
            )
          ) : (
            <p class="text-sm text-muted">Data unavailable</p>
          )}
        </div>
        <div class="insights__subsection insights__subsection--wide">
          <h4 class="insights__title">Top Saving Tools</h4>
          {data.savingsReport ? (
            data.savingsReport.topSources.length > 0 ? (
              <table>
                <thead><tr><th>Tool</th><th>Tokens saved</th><th>Share</th></tr></thead>
                <tbody>
                {(() => {
                  const top5 = [...data.savingsReport!.topSources].sort((a, b) => b[1] - a[1]).slice(0, 5);
                  const total = data.savingsReport!.tokensSaved;
                  return top5.map(([name, tokens]) => (
                    <tr>
                      <td>{name}</td>
                      <td>{new Intl.NumberFormat("en-US").format(tokens)}</td>
                      <td>
                        <div class="share-bar"><div class="share-bar__fill" style={`width:${total > 0 ? ((tokens / total) * 100).toFixed(1) : 0}%`}></div></div>
                        {total > 0 ? `${((tokens / total) * 100).toFixed(1)}%` : "—"}
                      </td>
                    </tr>
                  ));
                })()}
                </tbody>
              </table>
            ) : (
              <p class="text-sm text-muted">No savings data</p>
            )
          ) : (
            <p class="text-sm text-muted">Data unavailable</p>
          )}
        </div>
        </div>
      </section>
      <div class="card" id="versions-card">
        <h3>Component Versions</h3>
        <table>
          <tr><th>Component</th><th>Version</th></tr>
          {Object.entries(data.versions).map(([name, version]) => (
            <tr>
              <td>{name}</td>
              <td>
                {name === "AI-EngKit" ? (
                  <a href="/upgrade" aria-label={`AI-EngKit version ${version}`}><code>{version}</code></a>
                ) : (
                  <code>{version}</code>
                )}
                {name === "AI-EngKit" && !isUpgrading && <span style="margin-left:8px;"><UpdateBadge check={data.update_check} adminVersion={data.admin_version} /></span>}
                {name === "AI-EngKit" && isUpgrading && <span class="badge" style="background:rgba(99,102,241,0.15);color:var(--accent);margin-left:8px;">running</span>}
              </td>
            </tr>
          ))}
        </table>
        <p class="text-sm text-muted" style="margin-top:12px;">
          <a href="/env">Advanced: raw .env editor</a> for variables without a dedicated settings page.
        </p>
        {isUpgrading && (
          <div id="upgrade-inline-progress" style="margin-top:12px;">
            <div class="progress-bar mb-4"><div class="fill" id="inline-progress-fill" style={`width:${data.upgrade_progress_pct}%;`} /></div>
            <div id="inline-log-viewer" class="log-viewer" style="max-height:200px;">
              {data.upgrade_events.map(e => (
                <div class="log-entry">
                  <span class="step">{e.step}</span>
                  <span class={`status ${e.status === 'success' ? 'text-success' : e.status === 'failure' ? 'text-danger' : ''}`}>{e.status}</span>
                  <span>{e.message}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      {/* allow: SIZE_OK — file dominated by the pre-existing inline upgrade/restart JS; splitting into app.js is out of scope */}
      <script>{html`
        let inlineEventSource = null;
        let lastEventId = 0;
        async function startUpgrade() {
          if (!confirm("ai-dev will restart during this upgrade (2-3s downtime). Proceed?")) return;
          let versions;
          try {
            const versionsRes = await fetch("/api/upgrade/versions");
            versions = await versionsRes.json();
            if (!versionsRes.ok || !versions.official_version) {
              alert(versions.error || versions.warning || "No official release is available");
              return;
            }
          } catch (e) {
            alert("Failed to load the official release: " + (e instanceof Error ? e.message : String(e)));
            return;
          }
          const res = await fetch("/api/upgrade", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ version: versions.official_version }),
          });
          if (res.status === 409) {
            const data = await res.json();
            if (data.status && data.status.state === "running") {
              connectUpgradeSSE();
              return;
            }
            alert("Upgrade already in progress");
            return;
          }
          if (!res.ok) { alert("Failed to start upgrade"); return; }
          connectUpgradeSSE();
        }
        async function restartAdmin(event) {
          if (!confirm("Restart admin container? Dashboard will reload after restart completes.")) return;
          const btn = event.target;
          btn.disabled = true;
          btn.textContent = "Restarting...";
          let baselineUptime = null;
          let baselineDigest = null;
          try {
            const baseRes = await fetch("/api/admin/status");
            if (baseRes.ok) {
              const baseData = await baseRes.json();
              if (typeof baseData.uptime_seconds === "number") baselineUptime = baseData.uptime_seconds;
              if (typeof baseData.image_digest === "string" && baseData.image_digest) baselineDigest = baseData.image_digest;
            }
          } catch (_baselineError) {
            baselineUptime = null;
            baselineDigest = null;
          }
          try {
            const res = await fetch("/api/admin/restart", { method: "POST" });
            if (!res.ok) {
              let message = "Failed to restart admin";
              try {
                const data = await res.json();
                if (data && typeof data.error === "string" && data.error) message = data.error;
                else if (data && typeof data.message === "string" && data.message) message = data.message;
              } catch (_parseError) {
                message = "Failed to restart admin";
              }
              alert(message);
              btn.disabled = false;
              btn.textContent = "↻ Restart";
              return;
            }
            const deadline = Date.now() + 120000;
            let observedUnavailability = false;
            const poll = async () => {
              if (Date.now() > deadline) {
                alert("Admin restart timed out — please check container status and logs");
                btn.disabled = false;
                btn.textContent = "↻ Restart";
                return;
              }
              try {
                const statusRes = await fetch("/api/admin/status");
                if (!statusRes.ok) {
                  observedUnavailability = true;
                  setTimeout(poll, 1000);
                  return;
                }
                const statusData = await statusRes.json();
                const newDigest = typeof statusData.image_digest === "string" ? statusData.image_digest : null;
                const newUptime = typeof statusData.uptime_seconds === "number" ? statusData.uptime_seconds : null;
                if (baselineDigest !== null && newDigest !== null && newDigest !== baselineDigest) {
                  location.reload();
                  return;
                }
                if (typeof baselineUptime === "number" && typeof newUptime === "number" && newUptime < baselineUptime) {
                  location.reload();
                  return;
                }
                if (observedUnavailability) {
                  location.reload();
                  return;
                }
              } catch (_pollError) {
                observedUnavailability = true;
              }
              setTimeout(poll, 1000);
            };
            setTimeout(poll, 1000);
          } catch (e) {
            alert("Error: " + (e instanceof Error ? e.message : String(e)));
            btn.disabled = false;
            btn.textContent = "↻ Restart";
          }
        }
        async function dashRestartAiDev() {
          if (!confirm("Restart ai-dev container? This will briefly interrupt OpenCode and OpenChamber.")) return;
          var btn = document.getElementById("btn-dash-restart");
          var status = document.getElementById("dash-restart-status");
          if (!btn || !status) return;
          btn.disabled = true;
          status.textContent = "Restarting...";
          try {
            var res = await fetch("/api/env/restart", { method: "POST" });
            if (res.ok) {
              status.textContent = "Restarted ✔";
              setTimeout(function () { status.textContent = ""; btn.disabled = false; }, 3000);
            } else {
              var d = await res.json();
              status.textContent = "Error: " + (d.error || "unknown");
              btn.disabled = false;
            }
          } catch (e) {
            status.textContent = "Error: " + e.message;
            btn.disabled = false;
          }
        }
        function ensureProgressElements() {
          var card = document.getElementById("versions-card");
          if (!card) return null;
          var existing = document.getElementById("upgrade-inline-progress");
          if (existing) return existing;
          var container = document.createElement("div");
          container.id = "upgrade-inline-progress";
          container.style.marginTop = "12px";
          container.innerHTML = '<div class="progress-bar mb-4"><div class="fill" id="inline-progress-fill" style="width:0%;"></div></div><div id="inline-log-viewer" class="log-viewer" style="max-height:200px;"></div>';
          card.appendChild(container);
          return container;
        }
        function connectUpgradeSSE() {
          if (inlineEventSource) inlineEventSource.close();
          ensureProgressElements();
          inlineEventSource = new EventSource("/api/upgrade/log");
          inlineEventSource.onmessage = function(e) {
            try {
              const ev = JSON.parse(e.data);
              if (ev.id && ev.id <= lastEventId) return;
              lastEventId = ev.id;
              var logViewer = document.getElementById("inline-log-viewer");
              var fill = document.getElementById("inline-progress-fill");
              var progressCard = document.getElementById("upgrade-inline-progress");
              if (progressCard) progressCard.style.display = "block";
              if (logViewer) {
                var entry = document.createElement("div");
                entry.className = "log-entry";
                entry.innerHTML = '<span class="step">' + ev.step + '</span>' +
                  '<span class="status ' + (ev.status === 'success' ? 'text-success' : ev.status === 'failure' ? 'text-danger' : '') + '">' + ev.status + '</span>' +
                  '<span>' + (ev.message || '') + '</span>';
                logViewer.appendChild(entry);
                logViewer.scrollTop = logViewer.scrollHeight;
              }
              var steps = ["digest_compare","backup","merge_env","recreate","poll_health","cleanup"];
              var idx = steps.indexOf(ev.step);
              if (idx >= 0 && (ev.status === 'success' || ev.status === 'failure')) {
                var pct = Math.round(((idx + 1) / steps.length) * 100);
                if (fill) fill.style.width = pct + "%";
              }
              if (ev.step === "cleanup" && ev.status === "success") {
                setTimeout(function() { location.reload(); }, 2000);
              }
              if (ev.step === "cleanup" && ev.status === "failure") {
                if (inlineEventSource) inlineEventSource.close();
              }
            } catch(_) {}
          };
          inlineEventSource.onerror = function() {
            /* reconnect automatically */
          };
        }
        var us = document.getElementById("upgrade-inline-progress");
        if (us && us.style.display !== "none") {
          connectUpgradeSSE();
        }
      `}</script>
    </div>
  );
};

export function DashboardPage(data: DashboardData) {
  return (
    <Layout title="Dashboard" currentPath="/">
      <DashboardContent data={data} />
    </Layout>
  );
}
