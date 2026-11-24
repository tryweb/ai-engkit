# E2E (disposable targets only)

Never point `ADMIN_BASE_URL` at V1/V2 prod or the current session stack.

Required environment:
- `ADMIN_BASE_URL=http://<bridge-gateway>:<disposable-admin-port>`
- `AI_DEV_CONTAINER=<disposable ai-dev container name>`
- `ADMIN_PASSWORD` (ephemeral disposable value, e.g. `testadmin123`)
- `PLAYWRIGHT_EXECUTABLE_PATH` (host Playwright Chromium path)

Run:
```bash
cd e2e
ADMIN_BASE_URL=http://172.20.0.1:8199 \
AI_DEV_CONTAINER=ai-engkit-e2etest \
ADMIN_PASSWORD=testadmin123 \
PLAYWRIGHT_EXECUTABLE_PATH=/ms-playwright/<chromium-revision>/chrome-linux64/chrome \
bunx playwright test
```

Artifacts are written to `../.playwright-mcp/e2e`. Clean disposable containers, networks, and volumes after the run.
