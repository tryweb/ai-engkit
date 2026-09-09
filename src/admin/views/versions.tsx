import type { FC } from "hono/jsx";

const categoryLabels: Record<string, string> = {
  core: "Core",
  cli: "CLI",
  mcp: "MCP",
  plugin: "Plugin",
};

const imageMetaLabels: Record<string, string> = {
  image: "Image",
  digest: "Digest",
  created: "Created",
  version: "Version",
};

const categoryOrder = ["core", "cli", "mcp", "plugin"];

const CategoryCard: FC<{ title: string; tools: Record<string, string> }> = ({ title, tools }) => (
  <div class="card">
    <h3>{title}</h3>
    <table>
      {Object.entries(tools).map(([name, version]) => (
        <tr key={name}>
          <td>{name}</td>
          <td><code>{version || <span class="text-muted">unavailable</span>}</code></td>
        </tr>
      ))}
    </table>
  </div>
);

export const VersionsContent: FC<{
  versionsByCategory: Record<string, Record<string, string>>;
  imageMeta: Record<string, string>;
}> = ({ versionsByCategory, imageMeta }) => {
  const isEmpty = Object.keys(versionsByCategory).length === 0 && Object.keys(imageMeta).length === 0;
  if (isEmpty) {
    return (
      <div id="component-versions-root" class="component-versions">
        <h2 style="margin-bottom:24px;">Component Versions</h2>
        <div id="component-versions-loading" class="text-sm text-muted" role="status" aria-live="polite" aria-busy="true" aria-label="Loading component versions">
          <span class="spinner" aria-hidden="true"></span>
          <span>Loading component versions…</span>
          <span id="component-versions-elapsed" class="probe-elapsed text-muted" aria-live="polite"></span>
        </div>
        <div id="component-versions-error" class="text-sm" style="display:none;color:var(--danger);" role="alert"></div>
        <button id="component-versions-retry" type="button" class="btn-outline" style="display:none;margin-top:8px;min-height:44px;" aria-label="Retry loading component versions">Retry</button>
        <div id="component-versions-skeletons">
          <div class="card" aria-hidden="true">
            <h3>Image Metadata</h3>
            <table>
              <tr><td><span class="skeleton skeleton-text" style="width:60px;"></span></td><td><span class="skeleton skeleton-text" style="width:140px;"></span></td></tr>
              <tr><td><span class="skeleton skeleton-text" style="width:50px;"></span></td><td><span class="skeleton skeleton-text" style="width:100px;"></span></td></tr>
              <tr><td><span class="skeleton skeleton-text" style="width:70px;"></span></td><td><span class="skeleton skeleton-text" style="width:120px;"></span></td></tr>
              <tr><td><span class="skeleton skeleton-text" style="width:55px;"></span></td><td><span class="skeleton skeleton-text" style="width:90px;"></span></td></tr>
            </table>
          </div>
          <div class="grid-2" aria-hidden="true">
            {categoryOrder.map((key) => (
              <div class="card" key={key}>
                <h3>{categoryLabels[key] || key}</h3>
                <table>
                  <tr><td><span class="skeleton skeleton-text" style="width:70px;"></span></td><td><span class="skeleton skeleton-text" style="width:80px;"></span></td></tr>
                  <tr><td><span class="skeleton skeleton-text" style="width:60px;"></span></td><td><span class="skeleton skeleton-text" style="width:90px;"></span></td></tr>
                  <tr><td><span class="skeleton skeleton-text" style="width:80px;"></span></td><td><span class="skeleton skeleton-text" style="width:70px;"></span></td></tr>
                </table>
              </div>
            ))}
          </div>
        </div>
        <div id="component-versions-data" style="display:none;"></div>
      </div>
    );
  }
  return (
    <div id="component-versions-root" class="component-versions">
      <h2 style="margin-bottom:24px;">Component Versions</h2>
      <div class="card">
        <h3>Image Metadata</h3>
        <table>
          {Object.entries(imageMeta).map(([k, v]) => (
            <tr key={k}><td>{imageMetaLabels[k] || k}</td><td><code>{v}</code></td></tr>
          ))}
        </table>
      </div>
      <div class="grid-2">
        {categoryOrder.map((key) => {
          const tools = versionsByCategory[key];
          if (!tools) return null;
          return <CategoryCard key={key} title={categoryLabels[key] || key} tools={tools} />;
        })}
      </div>
    </div>
  );
};

export interface VersionsViewData {
  versionsByCategory: Record<string, Record<string, string>>;
  imageMeta: Record<string, string>;
}
