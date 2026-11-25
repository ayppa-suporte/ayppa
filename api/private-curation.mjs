const SUPABASE_ORIGIN = "https://geihhulnvqzmhzetpbnj.supabase.co";
const PUBLISHABLE_PREFIX = "sb_publishable_";
const DRAFT_COLUMNS = [
  "id",
  "listing_id",
  "source_job_id",
  "source_row_number",
  "data",
  "raw",
  "created_at",
];
const REJECTION_COLUMNS = ["job_id", "source_index", "row_number", "errors", "raw", "created_at"];
const SUMMARY_FIELDS = [
  "importedRecords",
  "developerReferences",
  "developmentReferences",
  "unitReferences",
];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validPublishableKey(key) {
  if (typeof key !== "string" || !key || key !== key.trim()) return false;
  if (key.startsWith(PUBLISHABLE_PREFIX))
    return key.length > PUBLISHABLE_PREFIX.length;

  const parts = key.split(".");
  if (parts.length !== 3 || parts.some(part => !part)) return false;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return claims?.role === "anon";
  } catch {
    return false;
  }
}

function configuration(env) {
  const rawUrl = env.SUPABASE_URL;
  const key = env.SUPABASE_PUBLISHABLE_KEY;
  if (
    typeof rawUrl !== "string" ||
    !rawUrl ||
    rawUrl !== rawUrl.trim() ||
    !validPublishableKey(key)
  )
    return null;

  try {
    const url = new URL(rawUrl);
    if (
      url.protocol !== "https:" ||
      url.origin !== SUPABASE_ORIGIN ||
      url.username ||
      url.password ||
      url.port ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      return null;
    return { origin: SUPABASE_ORIGIN, key };
  } catch {
    return null;
  }
}

function responseJson(response, status, body) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("Vary", "Authorization");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify(body));
}

function integerParameter(value, fallback, maximum, minimum) {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum
    ? number
    : null;
}

function queryParameters(request) {
  let params;
  try {
    params = new URL(request.url || "/", "https://portal.invalid").searchParams;
  } catch {
    return null;
  }
  const permitted = new Set(["limit", "offset", "view"]);
  if ([...params.keys()].some(key => !permitted.has(key) || params.getAll(key).length !== 1)) return null;
  const limit = integerParameter(params.get("limit"), 10, 10, 1);
  const offset = integerParameter(params.get("offset"), 0, 10000, 0);
  const view = params.get("view") ?? "drafts";
  if (limit === null || offset === null || !["drafts", "rejections"].includes(view)) return null;
  return { limit, offset, view };
}

function sameOrigin(request) {
  const originHeader = request.headers?.origin;
  if (originHeader === undefined) return true;
  if (typeof originHeader !== "string") return false;

  const host = request.headers?.host;
  const forwardedProto = request.headers?.["x-forwarded-proto"];
  const socketProto = request.socket?.encrypted ? "https" : "http";
  const proto =
    typeof forwardedProto === "string"
      ? forwardedProto.split(",")[0].trim().toLowerCase()
      : socketProto;
  if (
    typeof host !== "string" ||
    !host ||
    (proto !== "https" && proto !== "http")
  )
    return false;

  try {
    const parsed = new URL(originHeader);
    return (
      parsed.origin === originHeader &&
      parsed.origin === `${proto}://${host}` &&
      !parsed.username &&
      !parsed.password &&
      parsed.pathname === "/" &&
      !parsed.search &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}

function bearerToken(request) {
  const header = request.headers?.authorization;
  if (typeof header !== "string" || header.length > 8192) return null;
  const match = /^Bearer ([^\s,]+)$/i.exec(header);
  return match?.[1] || null;
}

function upstreamOptions(key, token, extra = {}) {
  return {
    ...extra,
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
    headers: {
      apikey: key,
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...extra.headers,
    },
  };
}

async function readJson(fetchImpl, url, options) {
  const upstream = await fetchImpl(url, options);
  let body = null;
  try {
    body = await upstream.json();
  } catch {
    body = null;
  }
  return { upstream, body };
}

function exactCount(response) {
  const contentRange = response.headers?.get?.("content-range");
  if (typeof contentRange !== "string") return null;
  const total = contentRange.slice(contentRange.lastIndexOf("/") + 1);
  if (!/^\d+$/.test(total)) return null;
  const count = Number(total);
  return Number.isSafeInteger(count) ? count : null;
}

function validSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = {};
  for (const field of SUMMARY_FIELDS) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) return null;
    result[field] = value[field];
  }
  return result;
}

function safeText(value) {
  if (typeof value === "string") {
    const text = value.trim();
    return text ? text.slice(0, 180) : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function projectDisplayData(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return { developer: null, development: null, unit: null, block: null };
  return {
    developer: safeText(data.developer_name),
    development: safeText(data.enterprise_name),
    unit: safeText(data.unit_code),
    block: safeText(data.block),
  };
}

function validRaw(raw) {
  return !!raw && typeof raw === "object" && !Array.isArray(raw)
    && Object.entries(raw).every(([key, value]) => typeof key === "string" && typeof value === "string")
    && Buffer.byteLength(JSON.stringify(raw), "utf8") <= 256 * 1024;
}

function validDraft(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  if (
    typeof row.id !== "string" ||
    (row.listing_id !== null && typeof row.listing_id !== "string") ||
    (row.source_job_id !== null && typeof row.source_job_id !== "string") ||
    (row.source_row_number !== null && (!Number.isSafeInteger(row.source_row_number) || row.source_row_number < 0)) ||
    (row.created_at !== null && typeof row.created_at !== "string") ||
    !row.data || typeof row.data !== "object" || Array.isArray(row.data) ||
    !Object.values(row.data).every(value => value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) ||
    !validRaw(row.raw)
  ) return false;
  return true;
}

function validRejection(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  return UUID_PATTERN.test(row.job_id || "")
    && Number.isSafeInteger(row.source_index) && row.source_index >= 0 && row.source_index <= 9999
    && Number.isSafeInteger(row.row_number) && row.row_number >= 1 && row.row_number <= 10000000
    && Array.isArray(row.errors) && row.errors.length > 0 && row.errors.length <= 64
    && row.errors.every(error => typeof error === "string" && error.length <= 1000)
    && typeof row.created_at === "string" && validRaw(row.raw);
}

async function requestSummary(fetchImpl, configurationValue, token) {
  try {
    const url = new URL(
      "/rest/v1/rpc/ayppa_hive_private_curation_summary",
      configurationValue.origin
    );
    const { upstream, body } = await readJson(
      fetchImpl,
      url,
      upstreamOptions(configurationValue.key, token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    );
    if (!upstream.ok) return null;
    return validSummary(body);
  } catch {
    return null;
  }
}

async function publishedListingIds(
  fetchImpl,
  configurationValue,
  token,
  listingIds
) {
  if (listingIds.length === 0) return new Set();
  const url = new URL("/rest/v1/ayppa_public_listings", configurationValue.origin);
  url.searchParams.set("select", "id");
  url.searchParams.set("published", "eq.true");
  url.searchParams.set("id", `in.(${listingIds.map(id => `"${id}"`).join(",")})`);
  url.searchParams.set("limit", String(listingIds.length));

  const { upstream, body } = await readJson(
    fetchImpl,
    url,
    upstreamOptions(configurationValue.key, token)
  );
  if (
    !upstream.ok ||
    !Array.isArray(body) ||
    body.length > listingIds.length ||
    body.some(row => !row || typeof row.id !== "string")
  )
    throw new Error("listing_status_unavailable");

  const requested = new Set(listingIds);
  return new Set(body.map(row => row.id).filter(id => requested.has(id)));
}

export function createPrivateCurationHandler({
  fetchImpl = globalThis.fetch,
  env = process.env,
} = {}) {
  return async function privateCurationHandler(request, response) {
    if (request?.method !== "GET") {
      response.setHeader("Allow", "GET");
      return responseJson(response, 405, { error: "method_not_allowed" });
    }
    if (!sameOrigin(request))
      return responseJson(response, 403, { error: "request_rejected" });

    const params = queryParameters(request);
    if (!params)
      return responseJson(response, 400, { error: "invalid_parameters" });

    const token = bearerToken(request);
    if (!token)
      return responseJson(response, 401, { error: "authentication_required" });

    const upstreamConfiguration = configuration(env);
    if (!upstreamConfiguration)
      return responseJson(response, 503, { error: "curation_unavailable" });

    try {
      const authUrl = new URL("/auth/v1/user", upstreamConfiguration.origin);
      const { upstream: authResponse, body: user } = await readJson(
        fetchImpl,
        authUrl,
        {
          method: "GET",
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(8000),
          headers: {
            apikey: upstreamConfiguration.key,
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
          },
        }
      );
      if (
        !authResponse.ok ||
        !UUID_PATTERN.test(user?.id || "") ||
        typeof user?.email !== "string" ||
        user.email.trim().toLowerCase() !== "adm@ayppa.com"
      )
        return responseJson(response, 401, { error: "authentication_required" });
      const ownerId = user.id;

      const allowlistUrl = new URL(
        "/rest/v1/ayppa_owner_access",
        upstreamConfiguration.origin
      );
      allowlistUrl.searchParams.set("select", "user_id,owner_email,enabled");
      allowlistUrl.searchParams.set("user_id", `eq.${ownerId}`);
      allowlistUrl.searchParams.set("enabled", "eq.true");
      allowlistUrl.searchParams.set("limit", "1");
      const { upstream: accessResponse, body: accessRows } = await readJson(
        fetchImpl,
        allowlistUrl,
        upstreamOptions(upstreamConfiguration.key, token)
      );
      if (!accessResponse.ok || !Array.isArray(accessRows))
        return responseJson(response, 503, { error: "curation_unavailable" });
      if (
        accessRows.length !== 1 ||
        accessRows[0]?.user_id !== ownerId ||
        accessRows[0]?.owner_email?.trim().toLowerCase() !== "adm@ayppa.com" ||
        accessRows[0]?.enabled !== true
      )
        return responseJson(response, 403, { error: "access_denied" });

      const isDraftView = params.view === "drafts";
      const table = isDraftView ? "ayppa_hive_property_drafts" : "ayppa_hive_spreadsheet_rows";
      const columns = isDraftView ? DRAFT_COLUMNS : REJECTION_COLUMNS;
      const recordsUrl = new URL(`/rest/v1/${table}`, upstreamConfiguration.origin);
      recordsUrl.searchParams.set("select", columns.join(","));
      recordsUrl.searchParams.set("owner_id", `eq.${ownerId}`);
      recordsUrl.searchParams.set("order", isDraftView ? "created_at.desc,id.asc" : "created_at.desc,job_id.desc,source_index.asc");
      if (!isDraftView) recordsUrl.searchParams.set("status", "eq.rejected");
      recordsUrl.searchParams.set("limit", String(params.limit));
      recordsUrl.searchParams.set("offset", String(params.offset));

      const [recordsResult, summary] = await Promise.all([
        readJson(fetchImpl, recordsUrl, upstreamOptions(upstreamConfiguration.key, token, { headers: { Prefer: "count=exact" } })),
        requestSummary(fetchImpl, upstreamConfiguration, token),
      ]);
      const { upstream: recordsResponse, body: rows } = recordsResult;
      const total = exactCount(recordsResponse);
      const invalidRows = !Array.isArray(rows) || rows.length > params.limit || total === null
        || rows.some(row => isDraftView ? !validDraft(row) : !validRejection(row));
      if (!recordsResponse.ok || invalidRows) return responseJson(response, 503, { error: "curation_unavailable" });

      let records;
      if (isDraftView) {
        const listingIds = [...new Set(rows.map(row => row.listing_id).filter(id => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id)))];
        const publishedIds = await publishedListingIds(fetchImpl, upstreamConfiguration, token, listingIds);
        records = rows.map(row => ({
          id: row.id,
          listing_id: row.listing_id,
          source_job_id: row.source_job_id,
          source_row_number: row.source_row_number,
          data: projectDisplayData(row.data),
          raw: row.raw,
          created_at: row.created_at,
          published: row.listing_id ? publishedIds.has(row.listing_id) : false,
        }));
      } else {
        records = rows.map(row => ({
          job_id: row.job_id,
          source_index: row.source_index,
          row_number: row.row_number,
          errors: row.errors,
          raw: row.raw,
          created_at: row.created_at,
        }));
      }

      return responseJson(response, 200, {
        view: params.view,
        records,
        total,
        limit: params.limit,
        offset: params.offset,
        nextOffset: params.offset + params.limit < total ? params.offset + params.limit : null,
        summary,
      });
    } catch {
      // Upstream bodies, errors, configuration and credentials are never returned or logged.
      return responseJson(response, 503, { error: "curation_unavailable" });
    }
  };
}

export default createPrivateCurationHandler();
