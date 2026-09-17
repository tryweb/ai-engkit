import type { FC } from "hono/jsx";
import { Layout } from "./layout";

const ProjectsContent: FC<{ projects: string[] }> = ({ projects }) => (
  <div>
    <div class="flex items-center justify-between mb-4 project-toolbar">
      <h2>OpenCode Projects</h2>
      <div class="flex gap-2">
        <button onclick="syncProjects()" class="btn-outline">↻ Sync</button>
        <button id="btn-tool-refresh" onclick="refreshToolStatus()" class="btn-outline">⟳ Re-scan</button>
        <button onclick="showCreateForm()" class="btn-outline">+ New Project</button>
      </div>
    </div>

    <div id="project-summary" class="site-summary" aria-live="polite">
      <span class="site-summary__item">Total <span id="sum-total" class="site-summary__value">—</span></span>
      <span class="site-summary__item">Active <span id="sum-active" class="site-summary__value">—</span></span>
      <span class="site-summary__item">Disabled <span id="sum-disabled" class="site-summary__value">—</span></span>
    </div>

    <div class="filter-bar">
      <input type="search" id="filter-search" class="filter-search" placeholder="Search projects…" aria-label="Search projects" oninput="applyFilters()" />
      <select id="filter-status" aria-label="Filter by status" onchange="applyFilters()">
        <option value="all">All statuses</option>
        <option value="active">Active only</option>
        <option value="disabled">Disabled only</option>
      </select>
      <select id="filter-cap" aria-label="Filter by capability" onchange="applyFilters()">
        <option value="all">Any capability</option>
        <option value="knowledge">Has Knowledge</option>
        <option value="maintenance">Has Maintenance</option>
        <option value="openspec">Has OpenSpec</option>
      </select>
      <select id="filter-remote" aria-label="Filter by git remote" onchange="applyFilters()">
        <option value="all">Any remote</option>
        <option value="with">With remote</option>
        <option value="none">No remote</option>
      </select>
      <select id="filter-codegraph" aria-label="Filter by codegraph status" onchange="applyFilters()">
        <option value="all">Any codegraph</option>
        <option value="indexed">Indexed</option>
        <option value="missing">Not indexed</option>
        <option value="unknown">Unknown</option>
      </select>
      <button id="btn-clear-filters" class="btn-outline btn-clear" onclick="clearFilters()" hidden>Clear filters</button>
    </div>

    <div class="card project-card">
      <div id="project-list" class="project-list">
        {projects.map(name => (
          <div class="project-row" data-project={name}>
            <span class="text-muted">Loading…</span>
          </div>
        ))}
        {projects.length === 0 && <div id="project-empty" class="project-empty text-muted">No projects yet</div>}
        <div id="filter-empty" class="project-empty text-muted" hidden>No projects match the current filters.</div>
      </div>
    </div>
    <div id="sync-modal" class="modal-overlay" style="display:none;">
      <div class="modal">
        <h3>Project Sync</h3>
        <div id="sync-status" class="text-sm" style="margin-bottom:8px;">Checking...</div>
        <div id="sync-results" style="display:none;"></div>
        <div id="sync-actions" style="display:none;justify-content:flex-end;margin-top:12px;gap:8px;" class="flex">
          <button class="btn-outline" onclick="closeSync()">Cancel</button>
          <button id="btn-sync-fix" onclick="applySync()">Fix All</button>
        </div>
      </div>
    </div>
    <div id="create-modal" class="modal-overlay" style="display:none;">
      <div class="modal">
        <h3>Create New Project</h3>
        <div class="form-group">
          <label for="project-name">Project Name</label>
          <input type="text" id="project-name" placeholder="my-project" />
        </div>
        <div class="form-group">
          <label><input type="checkbox" id="init-git" checked onchange="toggleGitRemote()" /> Initialize with git</label>
        </div>
        <div class="form-group" id="git-remote-group" style="display:block;">
          <label for="git-remote">Git Remote URL <span class="text-sm text-muted">(optional)</span></label>
          <input type="text" id="git-remote" placeholder="https://github.com/your-org/project.git" />
        </div>
        <div id="create-error" class="text-sm text-danger" style="display:none;margin-bottom:8px;" />
        <div class="flex gap-2" style="justify-content:flex-end;">
          <button class="btn-outline" onclick="closeCreate()">Cancel</button>
          <button onclick="createProject()">Create</button>
        </div>
      </div>
    </div>

    <div id="remote-modal" class="modal-overlay" style="display:none;">
      <div class="modal">
        <h3>Git Remote</h3>
        <p class="text-sm text-muted" style="margin-bottom:12px;">Set the origin URL for <code id="remote-project-name"></code>. Leave the field empty to remove the remote.</p>
        <div class="form-group">
          <label for="remote-url">Git Remote URL</label>
          <input type="text" id="remote-url" placeholder="https://github.com/your-org/project.git" />
        </div>
        <div id="remote-error" class="text-sm text-danger" style="display:none;margin-bottom:8px;" />
        <div class="flex gap-2" style="justify-content:flex-end;">
          <button class="btn-outline" onclick="closeRemote()">Cancel</button>
          <button onclick="saveRemote()">Save Remote</button>
        </div>
      </div>
    </div>

    <div id="delete-modal" class="modal-overlay" style="display:none;">
      <div class="modal">
        <h3 style="color:var(--color-danger,#dc3545);">Delete Project</h3>
        <p class="text-sm" style="margin-bottom:12px;">This action <strong>cannot be undone</strong>. It will permanently remove:</p>
        <ul class="text-sm" style="margin-bottom:12px;padding-left:20px;">
          <li>Project directory and all files</li>
          <li>OpenChamber registration</li>
          <li>OpenCode session data</li>
        </ul>
        <div class="form-group">
          <label for="delete-confirm-name">Type the project name to confirm</label>
          <input type="text" id="delete-confirm-name" placeholder="" oninput="validateDeleteConfirm()" />
        </div>
        <div id="delete-error" class="text-sm text-danger" style="display:none;margin-bottom:8px;" />
        <div class="flex gap-2" style="justify-content:flex-end;">
          <button class="btn-outline" onclick="closeDelete()">Cancel</button>
          <button id="btn-delete-confirm" onclick="confirmDelete()" disabled style="background:var(--color-danger,#dc3545);color:#fff;border-color:var(--color-danger,#dc3545);">Delete Project</button>
        </div>
      </div>
    </div>

    <div id="drawer-overlay" class="drawer-overlay" style="display:none;" onclick="closeDrawer()"></div>
    <aside id="project-drawer" class="drawer" style="display:none;" role="dialog" aria-modal="true" aria-label="Project details">
      <div class="drawer__header">
        <div style="min-width:0;">
          <h3 id="drawer-name"></h3>
          <span id="drawer-status" class="status-pill"></span>
        </div>
        <button id="drawer-close" class="btn-outline drawer__close" onclick="closeDrawer()" aria-label="Close project details">✕</button>
      </div>
      <div class="drawer__body">
        <div id="drawer-remote" class="drawer__section"></div>
        <div id="drawer-caps" class="drawer__section"></div>
        <div id="drawer-codegraph" class="drawer__section"></div>
        <div id="drawer-leanctx" class="drawer__section"></div>
        <div id="drawer-actions" class="drawer__actions"></div>
      </div>
    </aside>

    <script src="/static/projects-page.js"></script>
  </div>
);

export function ProjectsPage(projects: string[]) {
  return (
    <Layout title="Projects" currentPath="/projects">
      <ProjectsContent projects={projects} />
    </Layout>
  );
}
