const PUBLIC_COLUMNS = [
  "id",
  "title",
  "property_type",
  "developer_name",
  "city",
  "state",
  "neighborhood",
  "public_address",
  "area_m2",
  "price_amount",
  "currency_code",
  "availability",
  "latitude",
  "longitude",
  "public_description",
  "photo_urls",
  "source_url",
  "verified_at",
];

function publicConfiguration() {
  const rawUrl = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!rawUrl || !key || !key.startsWith("sb_publishable_")) return null;
  try {
    const url = new URL(rawUrl);
    if (
      url.protocol !== "https:" ||
      !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname) ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      (url.pathname !== "/" && url.pathname !== "")
    )
      return null;
    return { origin: url.origin, key };
  } catch {
    return null;
  }
}

function integerParameter(value, fallback, maximum) {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number <= maximum ? number : null;
}

function json(response, status, body) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify(body));
}

// Never forward browser cookies/Authorization, arbitrary filters, table names or writes.
// Publishable key makes the upstream request anonymous; RLS remains the security boundary.
export default async function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return json(response, 405, { error: "method_not_allowed" });
  }
  const params = new URL(request.url || "/", "https://portal.invalid")
    .searchParams;
  const permitted = new Set(["limit", "offset"]);
  if (
    [...params.keys()].some(
      key => !permitted.has(key) || params.getAll(key).length !== 1
    )
  )
    return json(response, 400, { error: "invalid_parameters" });
  const limit = integerParameter(params.get("limit"), 24, 50);
  const offset = integerParameter(params.get("offset"), 0, 100000);
  if (limit === null || limit < 1 || offset === null)
    return json(response, 400, { error: "invalid_parameters" });
  const configuration = publicConfiguration();
  if (!configuration)
    return json(response, 503, { error: "catalog_not_configured" });

  const endpoint = new URL(
    "/rest/v1/ayppa_public_listings",
    configuration.origin
  );
  endpoint.searchParams.set("select", PUBLIC_COLUMNS.join(","));
  endpoint.searchParams.set("published", "eq.true");
  endpoint.searchParams.set("order", "id.asc");
  endpoint.searchParams.set("limit", String(limit + 1));
  endpoint.searchParams.set("offset", String(offset));
  try {
    const upstream = await fetch(endpoint, {
      method: "GET",
      headers: { apikey: configuration.key, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
      redirect: "error",
      cache: "no-store",
    });
    if (!upstream.ok)
      return json(response, 503, { error: "catalog_unavailable" });
    const rows = await upstream.json();
    if (
      !Array.isArray(rows) ||
      rows.length > limit + 1 ||
      rows.some(
        row =>
          !row ||
          typeof row !== "object" ||
          typeof row.id !== "string" ||
          typeof row.title !== "string" ||
          typeof row.property_type !== "string"
      )
    )
      return json(response, 503, { error: "catalog_unavailable" });
    const records = rows
      .slice(0, limit)
      .map(row =>
        Object.fromEntries(
          PUBLIC_COLUMNS.map(column => [column, row[column] ?? null])
        )
      );
    return json(response, 200, {
      source: "supabase_public_catalog",
      records,
      limit,
      offset,
      nextOffset: rows.length > limit ? offset + limit : null,
    });
  } catch {
    // Do not expose tokens, upstream error text or Supabase configuration in logs/responses.
    return json(response, 503, { error: "catalog_unavailable" });
  }
}
