import { readEnvFile } from "./env";
import { isNativeV2Enabled } from "./agent-model-types";

const REGISTRY_IMAGE = "ghcr.io/tryweb/ai-engkit";

/**
 * Stable channel for the running line.
 *
 * The V2 line promotes to its own `:v2` tag; V1 keeps `:latest`. Falling back
 * to `:latest` on the V2 line would silently pull and deploy the V1 image into
 * a V2 stack (whose volumes are disjoint and whose runtime is OpenCode 2).
 */
export function resolveStableChannel(): string {
  return isNativeV2Enabled() ? "v2" : "latest";
}

/**
 * Resolve the deployable image reference.
 *
 * Production environments can pin a version via AI_ENGKIT_VERSION in
 * /opt/ai-engkit/.env (e.g. v2.0.0); unset falls back to the running line's
 * stable channel, which only moves on explicit promotion through the
 * Promote stable workflow.
 */
export function resolveImageRef(): string {
  const version = readEnvFile().AI_ENGKIT_VERSION?.trim();
  return version ? `${REGISTRY_IMAGE}:${version}` : `${REGISTRY_IMAGE}:${resolveStableChannel()}`;
}
