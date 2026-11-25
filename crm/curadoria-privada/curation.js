const EXPECTED_SUPABASE_URL = "https://geihhulnvqzmhzetpbnj.supabase.co";
const AUTH_EMAIL = "adm@ayppa.com";
const PAGE_SIZE = 10;

let supabaseConfig = null;
let accessToken = null;
let nextOffset = null;
let currentOffset = 0;
let currentView = "drafts";
let loadSequence = 0;

const elements = {
  loginPanel: document.querySelector("#login-panel"),
  loginForm: document.querySelector("#login-form"),
  loginButton: document.querySelector("#login-button"),
  password: document.querySelector("#login-password"),
  workspace: document.querySelector("#workspace"),
  status: document.querySelector("#status-message"),
  refresh: document.querySelector("#refresh-button"),
  logout: document.querySelector("#logout-button"),
  previous: document.querySelector("#previous-button"),
  next: document.querySelector("#next-button"),
  pageCount: document.querySelector("#page-count"),
  paginationLabel: document.querySelector("#pagination-label"),
  dataMessage: document.querySelector("#data-message"),
  tableWrap: document.querySelector("#table-wrap"),
  recordsBody: document.querySelector("#records-body"),
  recordsHeader: document.querySelector("#records-header"),
  recordsTitle: document.querySelector("#records-title"),
  draftsView: document.querySelector("#drafts-view-button"),
  rejectionsView: document.querySelector("#rejections-view-button"),
  summaryNote: document.querySelector("#summary-note"),
};

function showStatus(message, kind = "") {
  elements.status.textContent = message;
  elements.status.dataset.kind = kind;
}

function safeBrowserConfiguration(payload) {
  if (
    !payload ||
    payload.configured !== true ||
    payload.url !== EXPECTED_SUPABASE_URL ||
    typeof payload.publishableKey !== "string" ||
    !payload.publishableKey.trim()
  )
    return null;
  return { url: EXPECTED_SUPABASE_URL, key: payload.publishableKey };
}

async function getBrowserConfiguration() {
  try {
    const response = await fetch("/api/broker-config", {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
    });
    if (!response.ok) return null;
    return safeBrowserConfiguration(await response.json());
  } catch {
    return null;
  }
}

async function privateRequest(offset, view) {
  if (!accessToken) throw new Error("authentication_required");
  const url = new URL("/api/private-curation", window.location.origin);
  if (url.origin !== window.location.origin) throw new Error("request_rejected");
  url.searchParams.set("limit", String(PAGE_SIZE));
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("view", view);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const error = new Error("private_request_failed");
    error.status = response.status;
    throw error;
  }
  return payload;
}

function clearRenderedData() {
  elements.recordsBody.replaceChildren();
  elements.tableWrap.hidden = true;
  elements.pageCount.textContent = "Aguardando consulta autenticada.";
  elements.paginationLabel.textContent = "—";
  elements.dataMessage.hidden = false;
  elements.dataMessage.textContent = "Nenhum dado privado é carregado antes da autenticação.";
  elements.summaryNote.hidden = true;
  for (const id of [
    "#metric-imported",
    "#metric-developers",
    "#metric-developments",
    "#metric-units",
  ])
    document.querySelector(id).textContent = "—";
  elements.previous.disabled = true;
  elements.next.disabled = true;
  nextOffset = null;
  currentOffset = 0;
  currentView = "drafts";
  updateViewButtons(currentView);
}

function setAuthenticatedView(isAuthenticated) {
  elements.loginPanel.hidden = isAuthenticated;
  elements.workspace.hidden = !isAuthenticated;
}

function setSummary(summary) {
  const fields = [
    ["#metric-imported", "importedRecords"],
    ["#metric-developers", "developerReferences"],
    ["#metric-developments", "developmentReferences"],
    ["#metric-units", "unitReferences"],
  ];
  const valid =
    summary &&
    fields.every(([, key]) => Number.isSafeInteger(summary[key]) && summary[key] >= 0);
  if (!valid) {
    for (const [selector] of fields) document.querySelector(selector).textContent = "—";
    elements.summaryNote.hidden = false;
    return;
  }
  for (const [selector, key] of fields)
    document.querySelector(selector).textContent = new Intl.NumberFormat("pt-BR").format(summary[key]);
  elements.summaryNote.hidden = true;
}

function appendCell(row, label, value) {
  const cell = document.createElement("td");
  cell.dataset.label = label;
  cell.textContent = value || "—";
  row.append(cell);
}

function formatDate(value) {
  if (typeof value !== "string") return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "—"
    : new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function updateViewButtons(view) {
  elements.draftsView.setAttribute("aria-pressed", String(view === "drafts"));
  elements.draftsView.classList.toggle("is-active", view === "drafts");
  elements.rejectionsView.setAttribute("aria-pressed", String(view === "rejections"));
  elements.rejectionsView.classList.toggle("is-active", view === "rejections");
  elements.recordsTitle.textContent = view === "drafts" ? "Rascunhos recebidos" : "Linhas rejeitadas";
}

function appendHeader(label) {
  const cell = document.createElement("th");
  cell.scope = "col";
  cell.textContent = label;
  elements.recordsHeader.append(cell);
}

function appendRawCell(row, label, raw) {
  const rawCell = document.createElement("td");
  rawCell.dataset.label = label;
  const rawDetails = document.createElement("details");
  rawDetails.className = "raw-details";
  const rawSummary = document.createElement("summary");
  rawSummary.textContent = "Ver células originais";
  const rawFields = raw && typeof raw === "object" && !Array.isArray(raw)
    ? Object.entries(raw).filter(([key, value]) => typeof key === "string" && typeof value === "string")
    : [];
  if (rawFields.length) {
    const list = document.createElement("dl");
    list.className = "raw-field-list";
    for (const [key, value] of rawFields) {
      const term = document.createElement("dt");
      term.textContent = key.slice(0, 120);
      const description = document.createElement("dd");
      description.textContent = value.slice(0, 32768) || "—";
      list.append(term, description);
    }
    rawDetails.append(rawSummary, list);
  } else {
    rawSummary.textContent = "Campos originais indisponíveis";
    rawDetails.append(rawSummary);
  }
  rawCell.append(rawDetails);
  row.append(rawCell);
}

function renderRecords(records, view) {
  elements.recordsHeader.replaceChildren();
  const headers = view === "drafts"
    ? ["Construtora", "Empreendimento", "Unidade / bloco", "Referência de origem", "Status", "Células originais da planilha"]
    : ["Job / linha", "Motivo(s) da rejeição", "Células originais da planilha"];
  headers.forEach(appendHeader);
  elements.recordsBody.replaceChildren();
  for (const record of records) {
    const row = document.createElement("tr");
    if (view === "rejections") {
      appendCell(row, "Job / linha", `${record?.job_id || "Job não informado"} · linha ${record?.row_number ?? "—"}`);
      appendCell(row, "Motivo(s) da rejeição", Array.isArray(record?.errors) ? record.errors.join(" · ") : "Motivo indisponível");
      appendRawCell(row, "Células originais", record?.raw);
      elements.recordsBody.append(row);
      continue;
    }

    const data = record?.data && typeof record.data === "object" ? record.data : {};
    appendCell(row, "Construtora", data.developer);
    appendCell(row, "Empreendimento", data.development);
    appendCell(row, "Unidade / bloco", [data.unit, data.block ? `Bloco ${data.block}` : null].filter(Boolean).join(" · ") );

    const source = document.createElement("td");
    source.dataset.label = "Referência de origem";
    const sourceId = document.createElement("span");
    sourceId.className = "source-id";
    sourceId.textContent = record?.source_job_id || "Job não informado";
    const sourceRow = document.createElement("small");
    sourceRow.textContent = `Linha ${record?.source_row_number ?? "—"} · ${formatDate(record?.created_at)}`;
    source.append(sourceId, sourceRow);
    row.append(source);

    const statusCell = document.createElement("td");
    statusCell.dataset.label = "Status";
    const badge = document.createElement("span");
    badge.className = `status-badge ${record?.published === true ? "is-published" : "is-draft"}`;
    badge.textContent = record?.published === true ? "Publicado" : "Rascunho";
    statusCell.append(badge);
    row.append(statusCell);
    appendRawCell(row, "Células originais", record?.raw);
    elements.recordsBody.append(row);
  }
  elements.tableWrap.hidden = records.length === 0;
  elements.dataMessage.hidden = records.length > 0;
  if (records.length === 0) elements.dataMessage.textContent = view === "drafts" ? "Nenhum rascunho nesta página." : "Nenhuma linha rejeitada nesta página.";
}

function renderPage(payload, offset, view) {
  if (!payload || payload.view !== view || !Array.isArray(payload.records) || !Number.isSafeInteger(payload.total))
    throw new Error("invalid_response");
  setSummary(payload.summary);
  updateViewButtons(view);
  renderRecords(payload.records, view);
  currentOffset = offset;
  nextOffset = Number.isSafeInteger(payload.nextOffset) ? payload.nextOffset : null;
  const total = payload.total;
  const first = total === 0 ? 0 : offset + 1;
  const last = Math.min(offset + payload.records.length, total);
  const totalText = new Intl.NumberFormat("pt-BR").format(total);
  elements.pageCount.textContent = `${totalText} ${view === "drafts" ? "rascunhos" : "linhas rejeitadas"} no total`;
  elements.paginationLabel.textContent = `${first}–${last} de ${totalText}`;
  elements.previous.disabled = offset <= 0;
  elements.next.disabled = nextOffset === null;
}

async function loadPage(offset = 0, view = currentView) {
  const sequence = ++loadSequence;
  elements.refresh.disabled = true;
  elements.previous.disabled = true;
  elements.next.disabled = true;
  showStatus(view === "drafts" ? "Consultando rascunhos privados…" : "Consultando linhas rejeitadas privadas…");
  try {
    const payload = await privateRequest(offset, view);
    if (sequence !== loadSequence) return;
    renderPage(payload, offset, view);
    showStatus("");
  } catch (error) {
    if (sequence !== loadSequence) return;
    if (error.status === 401) {
      accessToken = null;
      setAuthenticatedView(false);
      clearRenderedData();
      showStatus("A sessão não foi validada. Entre novamente para continuar.", "error");
    } else if (error.status === 403) {
      accessToken = null;
      setAuthenticatedView(false);
      clearRenderedData();
      showStatus("Esta conta não possui autorização para consultar a curadoria.", "error");
    } else {
      showStatus("Não foi possível consultar a prévia. Tente atualizar em instantes.", "error");
    }
  } finally {
    if (sequence === loadSequence) elements.refresh.disabled = false;
  }
}

async function signIn(password) {
  if (!supabaseConfig) throw new Error("auth_unavailable");
  const url = new URL("/auth/v1/token", supabaseConfig.url);
  url.searchParams.set("grant_type", "password");
  if (url.origin !== EXPECTED_SUPABASE_URL) throw new Error("auth_unavailable");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      apikey: supabaseConfig.key,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ email: AUTH_EMAIL, password }),
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
  });
  let result = null;
  try {
    result = await response.json();
  } catch {
    result = null;
  }
  if (!response.ok || typeof result?.access_token !== "string")
    throw new Error("authentication_failed");
  return result.access_token;
}

elements.loginForm.addEventListener("submit", async event => {
  event.preventDefault();
  const password = elements.password.value;
  elements.password.value = "";
  if (!password) {
    showStatus("Informe a senha da conta administrativa.", "error");
    return;
  }
  elements.loginButton.disabled = true;
  showStatus("Validando acesso…");
  try {
    accessToken = await signIn(password);
    setAuthenticatedView(true);
    await loadPage(0);
  } catch {
    accessToken = null;
    setAuthenticatedView(false);
    clearRenderedData();
    showStatus("Não foi possível validar o acesso. Confira a senha ou tente mais tarde.", "error");
  } finally {
    elements.password.value = "";
    elements.loginButton.disabled = false;
  }
});

elements.refresh.addEventListener("click", () => loadPage(currentOffset, currentView));
elements.draftsView.addEventListener("click", () => { currentView = "drafts"; updateViewButtons(currentView); void loadPage(0, currentView); });
elements.rejectionsView.addEventListener("click", () => { currentView = "rejections"; updateViewButtons(currentView); void loadPage(0, currentView); });
elements.previous.addEventListener("click", () => loadPage(Math.max(0, currentOffset - PAGE_SIZE), currentView));
elements.next.addEventListener("click", () => {
  if (nextOffset !== null) loadPage(nextOffset, currentView);
});
elements.logout.addEventListener("click", () => {
  loadSequence += 1;
  accessToken = null;
  setAuthenticatedView(false);
  clearRenderedData();
  showStatus("Sessão desta página encerrada. Nenhum dado privado permanece na tela.");
});

async function initialize() {
  supabaseConfig = await getBrowserConfiguration();
  if (!supabaseConfig) {
    showStatus("O serviço de autenticação está indisponível. Tente novamente mais tarde.", "error");
    elements.loginButton.disabled = true;
    return;
  }

}

initialize();
