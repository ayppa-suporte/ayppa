const EXPECTED_ORIGIN = "https://geihhulnvqzmhzetpbnj.supabase.co";
const PUBLISHABLE_PREFIX = "sb_publishable_";

function isLegacyAnonJwt(key) {
  const parts = key.split(".");
  if (parts.length !== 3 || parts.some(part => !part)) return false;
  const payload = parts[1];
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) return false;
  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), character =>
      character.charCodeAt(0)
    );
    const claims = JSON.parse(new TextDecoder().decode(bytes));
    return Boolean(
      claims && typeof claims === "object" && claims.role === "anon"
    );
  } catch {
    return false;
  }
}

function isPublishableKey(key) {
  if (typeof key !== "string" || !key || key !== key.trim()) return false;
  if (key.startsWith(PUBLISHABLE_PREFIX))
    return key.length > PUBLISHABLE_PREFIX.length;
  return isLegacyAnonJwt(key);
}

function publicConfiguration() {
  const rawUrl = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!rawUrl || !key || rawUrl !== rawUrl.trim() || !isPublishableKey(key))
    return null;

  try {
    const url = new URL(rawUrl);
    if (
      url.protocol !== "https:" ||
      url.origin !== EXPECTED_ORIGIN ||
      url.username ||
      url.password ||
      url.port ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      return null;
    return { url: url.origin, publishableKey: key };
  } catch {
    return null;
  }
}

function send(response, status, body, method) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (method === "HEAD") return response.end();
  return response.end(JSON.stringify(body));
}

export default function handler(request, response) {
  const method = request?.method;
  if (method !== "GET" && method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    return send(response, 405, { error: "method_not_allowed" }, method);
  }

  const configuration = publicConfiguration();
  if (!configuration) return send(response, 503, { configured: false }, method);

  return send(response, 200, { configured: true, ...configuration }, method);
}
