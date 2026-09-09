import { describe, expect, it } from "bun:test";
import { ProvidersPage } from "./providers";

function render(providers: Array<Record<string, unknown>>, entries: Record<string, unknown> = {}): string {
  return String(ProvidersPage({
    meta: { invalid: false, error: null, providers: providers as never },
    entries,
  }));
}

const opencodeGo = {
  name: "opencode-go",
  label: "Opencode Go",
  npm: "",
  baseURL: "",
  hasApiKey: false,
  keyManagement: true,
  authStoreKeyPresent: true,
  oauthManaged: false,
  oauthConnected: false,
  virtual: true,
  registry: {
    keyCount: 1,
    activeKeyId: "k-1",
    keys: [{ id: "k-1", masked: "sk-…1234", note: "team A", active: true }],
  },
};

const openai = {
  name: "openai",
  label: "OpenAI API",
  npm: "",
  baseURL: "",
  hasApiKey: false,
  keyManagement: true,
  authStoreKeyPresent: false,
  oauthManaged: true,
  oauthConnected: false,
  virtual: true,
  registry: { keyCount: 0, activeKeyId: null, keys: [] },
};

const googleProvider = {
  name: "google",
  label: "Google",
  npm: "",
  baseURL: "",
  hasApiKey: false,
  keyManagement: true,
  authStoreKeyPresent: false,
  oauthManaged: false,
  oauthConnected: false,
  virtual: true,
  registry: { keyCount: 0, activeKeyId: null, keys: [] },
};

describe("ProvidersPage", () => {
  it("renders registry keys with notes and responsive row classes", () => {
    const html = render([opencodeGo]);
    expect(html).toContain('value="team A"');
    expect(html).toContain('class="key-row"');
    expect(html).toContain("key-row__note");
    expect(html).toContain("key-row__actions");
    expect(html).toContain('class="key-add-row"');
    expect(html).toContain("Opencode Go keys in registry (1)");
    expect(html).toContain("Selected in registry");
  });

  it("injects boot data and loads the external page script", () => {
    const html = render([opencodeGo]);
    expect(html).toContain("window.providersBoot");
    expect(html).toContain('<script src="/static/providers-page.js"></script>');
  });

  it("renders the OAuth panel with a connect action when disconnected", () => {
    const html = render([openai]);
    expect(html).toContain('class="oauth-panel"');
    expect(html).toContain('data-provider="openai"');
    expect(html).toContain('data-connected="false"');
    expect(html).toContain("ChatGPT Pro/Plus");
    expect(html).toContain("startOAuth(&#39;openai&#39;)");
    expect(html).toContain("auth.openai.com/codex/device");
  });

  it("renders the connected state with a disconnect action", () => {
    const html = render([{ ...openai, oauthConnected: true }]);
    expect(html).toContain('data-connected="true"');
    expect(html).toContain("OAuth connected");
    expect(html).toContain("disconnectOAuth(&#39;openai&#39;)");
  });

  it("does not render an OAuth panel for non-OAuth providers", () => {
    const html = render([opencodeGo]);
    expect(html).not.toContain("oauth-panel");
  });

  it("never exposes raw key values", () => {
    const html = render([opencodeGo]);
    expect(html).not.toContain("sk-…1234".replace("…", ""));
  });

  it("keeps masked CJK values identifiable without exposing a raw secret", () => {
    const html = render([{ ...opencodeGo, registry: {
      ...opencodeGo.registry,
      keys: [{ ...opencodeGo.registry.keys[0], masked: "sk-測試密鑰-1234" }],
    } }]);
    expect(html).toContain('title="sk-測試密鑰-1234"');
    expect(html).toContain("sk-測試密鑰-1234");
  });

  it("renders Google provider with brand icon, placeholder, and registry section", () => {
    const html = render([googleProvider]);
    expect(html).toContain('data-provider="google"');
    expect(html).toContain("Google</h3>");
    expect(html).toContain("Google keys in registry (0)");
    expect(html).toContain("Google AI Studio API Key");
    expect(html).toContain("auth-managed");
  });

  it("renders provider overview summary grid", () => {
    const html = render([opencodeGo, openai, googleProvider]);
    expect(html).toContain("providers-overview-grid");
    expect(html).toContain("Configured Providers");
    expect(html).toContain("Active / Connected");
    expect(html).toContain("Key-Managed Providers");
  });

  it("escapes entries JSON in boot script to prevent script tag injection", () => {
    const maliciousEntries = {
      test: { name: "</script><script>alert(1)</script>" },
    };
    const html = render([opencodeGo], maliciousEntries);
    expect(html).not.toContain("</script><script>alert(1)</script>");
    expect(html).toContain("\\u003c/script>\\u003cscript>alert(1)\\u003c/script>");
  });

  it("counts non-key-managed providers with hasApiKey as active in overview grid", () => {
    const envProvider = {
      name: "custom-api",
      label: "Custom API",
      npm: "@ai-sdk/openai-compatible",
      baseURL: "https://api.custom.com",
      hasApiKey: true,
      keyManagement: false,
      authStoreKeyPresent: false,
      oauthManaged: false,
      oauthConnected: false,
      virtual: false,
      registry: { keyCount: 0, activeKeyId: null, keys: [] },
    };
    const html = render([opencodeGo, envProvider]);
    expect(html).toContain('class="stat-number text-success" style="font-size: var(--text-2xl);">2</div>');
    expect(html).toContain('provider-card--active" data-provider="custom-api"');
    expect(html).toContain("API key set");
  });

  it("renders Nvidia provider with valid brand icon", () => {
    const nvidiaProvider = {
      name: "nvidia",
      label: "Nvidia API",
      npm: "",
      baseURL: "",
      hasApiKey: false,
      keyManagement: true,
      authStoreKeyPresent: false,
      oauthManaged: false,
      oauthConnected: false,
      virtual: true,
      registry: { keyCount: 0, activeKeyId: null, keys: [] },
    };
    const html = render([nvidiaProvider]);
    expect(html).toContain('data-provider="nvidia"');
    expect(html).toContain('fill="#76B900"');
    expect(html).toContain("M8.939 8.922");
  });
});
