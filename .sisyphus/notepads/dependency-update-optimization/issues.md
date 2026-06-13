# Issues - Dependency Update Workflow Optimization

## Known Issues
- No PAT available; GITHUB_TOKEN cannot push to protected branches → fallback to PR needed
- `gh release view` requires gh CLI auth (runs in GHA context where gh is pre-authenticated)
- npm view for opencode-ai returns version as "1.17.3"
- LeanCTX version via GitHub API: yvgude/lean-ctx
- Action version consistency: current dependency-update.yml uses checkout@v6, but ci.yml uses @v4 → must standardize to @v4
