import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import privateCuration, {
  createPrivateCurationHandler,
} from "../api/private-curation.mjs";
import publicListings from "../api/public-listings.mjs";

const SUPABASE_URL = "https://geihhulnvqzmhzetpbnj.supabase.co";
const ANON_KEY = "sb_publishable_test_key";
const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "private-access-token-for-tests";
const OTHER_LISTING_ID = "33333333-3333-4333-8333-333333333333";
const PUBLISHED_LISTING_ID = "22222222-2222-4222-8222-222222222222";
const SUMMARY = {
  importedRecords: 12,
  developerReferences: 3,
  developmentReferences: 5,
  unitReferences: 12,
};

function response(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

function makeRequest({
  url = "/api/private-curation?limit=2&offset=0",
  method = "GET",
  authorization = `Bearer ${TOKEN}`,
  origin = "https://portal.example.test",
  host = "portal.example.test",
  proto = "https",
} = {}) {
  return {
    method,
    url,
    headers: {
      authorization,
      origin,
      host,
      "x-forwarded-proto": proto,
    },
  };
}

function makeResponse() {
  return {
    headers: new Map(),
    setHeader(name, value) {
      this.headers.set(name.toLowerCase(), value);
    },
    end(body) {
      this.body = body;
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}

async function invoke(handler, request) {
  const result = makeResponse();
  await handler(request, result);
  return result;
}

function environment() {
  return {
    SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY: ANON_KEY,
  };
}

function successfulUpstream({
  owner = true,
  rows = [
    {
      id: "draft-1",
      listing_id: PUBLISHED_LISTING_ID,
      source_job_id: "job-alpha",
      source_row_number: 7,
      data: {
        developer_name: "Casa do Mar",
        enterprise_name: "Residencial Alvorada",
        unit_code: "1204",
        block: "B",
      },
      raw: {
        Construtora: "Casa do Mar",
        Empreendimento: "Residencial Alvorada",
        Unidade: "1204",
        Bloco: "B",
        "Forma de pagamento": "R$ 50.000,00 + 60x",
        Dormitórios: "3 suítes",
      },
      created_at: "2026-11-20T10:30:00Z",
    },
    {
      id: "draft-2",
      listing_id: OTHER_LISTING_ID,
      source_job_id: "job-alpha",
      source_row_number: 8,
      data: { developer_name: "Construtora Horizonte", enterprise_name: "Residencial Novo", unit_code: "901", block: null },
      raw: { Unidade: "901", Valor: "Reservado" },
      created_at: "2026-11-20T10:31:00Z",
    },
  ],
  count = 3,
  rejectionRows = [{
    job_id: "11111111-1111-4111-8111-111111111111",
    source_index: 1,
    row_number: 8,
    errors: ["currency_symbol_conflicts_with_currency_code"],
    raw: { Preço: "€ 450.000,00", Moeda: "USD" },
    created_at: "2026-11-20T10:31:00Z",
  }],
  rejectionCount = 1,
} = {}) {
  return async (input, init = {}) => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    if (url.pathname === "/auth/v1/user") {
      assert.equal(headers.get("authorization"), `Bearer ${TOKEN}`);
      assert.equal(headers.get("apikey"), ANON_KEY);
      return response({ id: OWNER_ID, email: "adm@ayppa.com" });
    }
    if (url.pathname === "/rest/v1/ayppa_owner_access") {
      assert.equal(headers.get("authorization"), `Bearer ${TOKEN}`);
      assert.equal(url.searchParams.get("user_id"), `eq.${OWNER_ID}`);
      assert.equal(url.searchParams.get("enabled"), "eq.true");
      return response(owner ? [{ user_id: OWNER_ID, owner_email: "adm@ayppa.com", enabled: true }] : []);
    }
    if (url.pathname === "/rest/v1/ayppa_hive_property_drafts") {
      assert.equal(headers.get("authorization"), `Bearer ${TOKEN}`);
      assert.equal(url.searchParams.get("owner_id"), `eq.${OWNER_ID}`);
      const range = count === 0 ? "*/0" : `0-${Math.max(rows.length - 1, 0)}/${count}`;
      return response(rows, 200, { "Content-Range": range });
    }
    if (url.pathname === "/rest/v1/ayppa_hive_spreadsheet_rows") {
      assert.equal(headers.get("authorization"), `Bearer ${TOKEN}`);
      assert.equal(url.searchParams.get("owner_id"), `eq.${OWNER_ID}`);
      assert.equal(url.searchParams.get("status"), "eq.rejected");
      const range = rejectionCount === 0 ? "*/0" : `0-${Math.max(rejectionRows.length - 1, 0)}/${rejectionCount}`;
      return response(rejectionRows, 200, { "Content-Range": range });
    }
    if (url.pathname === "/rest/v1/rpc/ayppa_hive_private_curation_summary") {
      assert.equal(init.method, "POST");
      assert.equal(init.body, "{}");
      assert.equal(headers.get("authorization"), `Bearer ${TOKEN}`);
      return response(SUMMARY);
    }
    if (url.pathname === "/rest/v1/ayppa_public_listings") {
      assert.equal(headers.get("authorization"), `Bearer ${TOKEN}`);
      assert.equal(url.searchParams.get("published"), "eq.true");
      const ids = [...url.searchParams.get("id").matchAll(/"([^"]+)"/g)].map(match => match[1]);
      const published = ids.includes(PUBLISHED_LISTING_ID)
        ? [{ id: PUBLISHED_LISTING_ID }]
        : [];
      return response(published);
    }
    throw new Error(`Unexpected upstream URL: ${url.pathname}`);
  };
}

test("private endpoint authenticates the owner and returns original cells only after owner checks", async () => {
  const handler = createPrivateCurationHandler({
    fetchImpl: successfulUpstream(),
    env: environment(),
  });
  const result = await invoke(handler, makeRequest());
  const body = result.json();

  assert.equal(result.statusCode, 200);
  assert.equal(result.headers.get("cache-control"), "private, no-store");
  assert.equal(result.headers.get("vary"), "Authorization");
  assert.equal(body.view, "drafts");
  assert.equal(body.total, 3);
  assert.equal(body.nextOffset, 2);
  assert.deepEqual(body.summary, SUMMARY);
  assert.equal(body.records[0].published, true);
  assert.equal(body.records[1].published, false);
  assert.deepEqual(body.records[0].data, {
    developer: "Casa do Mar",
    development: "Residencial Alvorada",
    unit: "1204",
    block: "B",
  });
  assert.deepEqual(body.records[0].raw, {
    Construtora: "Casa do Mar",
    Empreendimento: "Residencial Alvorada",
    Unidade: "1204",
    Bloco: "B",
    "Forma de pagamento": "R$ 50.000,00 + 60x",
    Dormitórios: "3 suítes",
  });
  assert.equal(JSON.stringify(body).includes("must not be returned"), false);
  assert.equal(JSON.stringify(body).includes(TOKEN), false);
});

test("owner-only rejection view returns paginated reasons and original cells for safe UI rendering", async () => {
  const malicious = "<img src=x onerror=alert(1)>";
  const handler = createPrivateCurationHandler({
    fetchImpl: successfulUpstream({
      rejectionRows: [{
        job_id: "11111111-1111-4111-8111-111111111111",
        source_index: 2,
        row_number: 9,
        errors: [malicious],
        raw: { Preço: malicious },
        created_at: "2026-11-20T10:31:00Z",
      }],
      rejectionCount: 5,
    }),
    env: environment(),
  });
  const result = await invoke(handler, makeRequest({ url: "/api/private-curation?view=rejections&limit=2&offset=0" }));
  const body = result.json();
  assert.equal(result.statusCode, 200);
  assert.equal(body.view, "rejections");
  assert.equal(body.total, 5);
  assert.equal(body.nextOffset, 2);
  assert.equal(body.records[0].row_number, 9);
  assert.deepEqual(body.records[0].errors, [malicious]);
  assert.deepEqual(body.records[0].raw, { Preço: malicious });
  const pageScript = await readFile(new URL("../crm/curadoria-privada/curation.js", import.meta.url), "utf8");
  assert.match(pageScript, /description\.textContent = value/);
  assert.match(pageScript, /appendCell\(row, "Motivo\(s\) da rejeição"/);
  assert.doesNotMatch(pageScript, /\.innerHTML\s*=/);
});

test("invalid bearer token is rejected before any private-table request", async () => {
  let tableCalls = 0;
  const fetchImpl = async input => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user")
      return response({ message: "sensitive upstream detail" }, 401);
    tableCalls += 1;
    throw new Error("private request should not run");
  };
  const handler = createPrivateCurationHandler({ fetchImpl, env: environment() });
  const result = await invoke(handler, makeRequest());
  assert.equal(result.statusCode, 401);
  assert.deepEqual(result.json(), { error: "authentication_required" });
  assert.equal(tableCalls, 0);
  assert.equal(result.body.includes("sensitive upstream detail"), false);
});

test("valid user without an owner allowlist row is denied", async () => {
  const handler = createPrivateCurationHandler({
    fetchImpl: successfulUpstream({ owner: false }),
    env: environment(),
  });
  const result = await invoke(handler, makeRequest());
  assert.equal(result.statusCode, 403);
  assert.deepEqual(result.json(), { error: "access_denied" });
});

test("authenticated non-owner email is rejected before the allowlist query", async () => {
  let allowlistCalls = 0;
  const fetchImpl = async input => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") return response({ id: OWNER_ID, email: "other@example.com" });
    if (url.pathname === "/rest/v1/ayppa_owner_access") allowlistCalls += 1;
    throw new Error("private query should not continue");
  };
  const handler = createPrivateCurationHandler({ fetchImpl, env: environment() });
  const result = await invoke(handler, makeRequest());
  assert.equal(result.statusCode, 401);
  assert.equal(allowlistCalls, 0);
});

test("query accepts only bounded single limit/offset filters and pages using exact count", async () => {
  let observedDraftUrl;
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    if (url.pathname === "/auth/v1/user") return response({ id: OWNER_ID, email: "adm@ayppa.com" });
    if (url.pathname === "/rest/v1/ayppa_owner_access") return response([{ user_id: OWNER_ID, owner_email: "adm@ayppa.com", enabled: true }]);
    if (url.pathname === "/rest/v1/ayppa_hive_property_drafts") {
      observedDraftUrl = url;
      const headers = new Headers(init.headers);
      assert.equal(headers.get("prefer"), "count=exact");
      assert.equal(url.searchParams.get("owner_id"), `eq.${OWNER_ID}`);
      return response([], 200, { "Content-Range": "*/27" });
    }
    if (url.pathname === "/rest/v1/rpc/ayppa_hive_private_curation_summary")
      return response(SUMMARY);
    throw new Error("No listings expected for empty page");
  };
  const handler = createPrivateCurationHandler({ fetchImpl, env: environment() });
  const result = await invoke(
    handler,
    makeRequest({ url: "/api/private-curation?limit=10&offset=10" })
  );
  const body = result.json();
  assert.equal(result.statusCode, 200);
  assert.equal(observedDraftUrl.searchParams.get("limit"), "10");
  assert.equal(observedDraftUrl.searchParams.get("offset"), "10");
  assert.equal(body.total, 27);
  assert.equal(body.nextOffset, 20);

  for (const url of [
    "/api/private-curation?limit=11",
    "/api/private-curation?limit=51",
    "/api/private-curation?offset=10001",
    "/api/private-curation?limit=1&limit=2",
    "/api/private-curation?view=all",
    "/api/private-curation?view=drafts&view=rejections",
    "/api/private-curation?owner_id=anyone",
  ]) {
    const rejected = await invoke(handler, makeRequest({ url }));
    assert.equal(rejected.statusCode, 400, url);
  }
});

test("an oversized raw row fails closed without returning its contents", async () => {
  const oversized = "x".repeat(256 * 1024 + 1);
  const handler = createPrivateCurationHandler({
    fetchImpl: successfulUpstream({
      rows: [{
        id: "draft-big",
        listing_id: null,
        source_job_id: "job-alpha",
        source_row_number: 1,
        data: { developer_name: null, enterprise_name: null, unit_code: null, block: null },
        raw: { Coluna: oversized },
        created_at: "2026-11-20T10:30:00Z",
      }],
      count: 1,
    }),
    env: environment(),
  });
  const result = await invoke(handler, makeRequest());
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.includes(oversized), false);
});

test("request Origin must match the serving origin", async () => {
  let upstreamCalls = 0;
  const handler = createPrivateCurationHandler({
    fetchImpl: async () => {
      upstreamCalls += 1;
      throw new Error("upstream should not be called");
    },
    env: environment(),
  });
  const result = await invoke(
    handler,
    makeRequest({ origin: "https://attacker.example" })
  );
  assert.equal(result.statusCode, 403);
  assert.equal(upstreamCalls, 0);
});

test("existing public listings endpoint continues filtering to published=true", async () => {
  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.SUPABASE_URL;
  const previousKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  let observedUrl;
  process.env.SUPABASE_URL = SUPABASE_URL;
  process.env.SUPABASE_PUBLISHABLE_KEY = ANON_KEY;
  globalThis.fetch = async input => {
    observedUrl = new URL(input);
    return response([
      { id: "public-1", title: "Public listing", property_type: "apartment" },
    ]);
  };
  try {
    const result = await invoke(publicListings, {
      method: "GET",
      url: "/api/public-listings?limit=1&offset=0",
      headers: {},
    });
    assert.equal(result.statusCode, 200);
    assert.equal(observedUrl.pathname, "/rest/v1/ayppa_public_listings");
    assert.equal(observedUrl.searchParams.get("published"), "eq.true");
    assert.equal(result.json().records[0].id, "public-1");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY;
    else process.env.SUPABASE_PUBLISHABLE_KEY = previousKey;
  }
});

test("default handler is a Vercel-style function export", () => {
  assert.equal(typeof privateCuration, "function");
});
