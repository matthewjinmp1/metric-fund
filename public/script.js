const state = {
  baseMetrics: [],
  customMetrics: [],
  conditions: [],
  result: null,
  savedBacktests: [],
  selectedPeriodIndex: null,
  yearlyItems: [],
  positionItems: [],
  positionSort: { key: "totalMonths", direction: "desc" },
};

const starterMetricRevisions = new Map(
  [
    ["ROA", "net_income / total_assets", "roa"],
    ["ROE", "net_income / total_equity", "roe"],
    ["FCF Margin", "fcf / revenue", "fcf_margin"],
    ["Gross Margin", "gross_profit / revenue", "gross_margin"],
    ["Debt / Assets", "(st_debt + lt_debt) / total_assets", "debt_to_assets"],
  ].map(([name, oldFormula, newFormula]) => [`${name}:${oldFormula}`, newFormula]),
);

const $ = (id) => document.getElementById(id);

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
  const num = Number(value);
  if (Math.abs(num) >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(digits)}B`;
  if (Math.abs(num) >= 1_000_000) return `${(num / 1_000_000).toFixed(digits)}M`;
  if (Math.abs(num) >= 1_000) return `${(num / 1_000).toFixed(digits)}K`;
  return num.toFixed(digits);
}

function formatCount(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "0";
  return Number(value).toLocaleString();
}

function formatPct(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || Number.isNaN(Number(seconds))) return "-";
  const value = Number(seconds);
  if (value < 1) return `${Math.round(value * 1000)}ms`;
  return `${value.toFixed(2)}s`;
}

function loadSaved() {
  const saved = JSON.parse(localStorage.getItem("metricFundState") || "{}");
  state.customMetrics = saved.customMetrics || [];
  state.conditions = saved.conditions || [];
}

function saveState() {
  localStorage.setItem(
    "metricFundState",
    JSON.stringify({
      customMetrics: state.customMetrics,
      conditions: state.conditions,
    }),
  );
}

async function init() {
  startLiveReload();
  loadSaved();
  const res = await fetch("/api/metrics");
  const data = await res.json();
  state.baseMetrics = data.baseMetrics;
  if (!state.customMetrics.length) state.customMetrics = data.defaultMetrics;
  state.customMetrics = state.customMetrics.map((metric) => {
    const formula = starterMetricRevisions.get(`${metric.name}:${metric.formula}`);
    return formula ? { ...metric, formula } : metric;
  });
  if (!state.conditions.length) state.conditions = data.defaultConditions;
  saveState();
  renderBaseMetrics();
  renderCustomMetrics();
  renderConditions();
  $("run").addEventListener("click", runBacktest);
  $("add-metric").addEventListener("click", addMetric);
  $("add-condition").addEventListener("click", addCondition);
  $("save-backtest").addEventListener("click", saveCurrentBacktest);
  $("metric-search").addEventListener("input", renderBaseMetrics);
  $("period-list").addEventListener("click", handlePeriodClick);
  $("saved-backtests").addEventListener("click", handleSavedBacktestClick);
  $("position-history").addEventListener("click", handlePositionHistoryClick);
  window.addEventListener("hashchange", renderRoute);
  await refreshSavedBacktests();
  renderRoute();
}

function currentRoute() {
  return window.location.hash === "#/positions" ? "positions" : "main";
}

function renderRoute() {
  const route = currentRoute();
  document.querySelectorAll("[data-view]").forEach((view) => {
    view.hidden = view.dataset.view !== route;
  });
  document.querySelectorAll("[data-route-link]").forEach((link) => {
    const isCurrent = link.dataset.routeLink === route;
    link.classList.toggle("selected", isCurrent);
    link.setAttribute("aria-current", isCurrent ? "page" : "false");
  });
  $("page-title").textContent = route === "positions" ? "Position History" : "Build A Fund Rule";
  $("page-subtitle").textContent =
    route === "positions"
      ? "Rank holdings across the whole backtest by total time held."
      : "Define metrics, filter stocks, and roll positions as each company reports new data.";
  $("run").hidden = route === "positions";
  if (route === "positions") renderPositionHistory();
}

async function requestJson(url, options = {}) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);
  return data;
}

async function listSavedBacktests() {
  const data = await requestJson("/api/saved-backtests");
  return data.backtests || [];
}

async function putSavedBacktest(record) {
  return requestJson("/api/saved-backtests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(record),
  });
}

async function getSavedBacktest(id) {
  return requestJson(`/api/saved-backtests/${encodeURIComponent(id)}`);
}

async function deleteSavedBacktest(id) {
  return requestJson(`/api/saved-backtests/${encodeURIComponent(id)}`, { method: "DELETE" });
}

async function refreshSavedBacktests() {
  try {
    state.savedBacktests = await listSavedBacktests();
    renderSavedBacktests();
  } catch (error) {
    $("saved-backtests").innerHTML = `<div class="empty">Saved backtests unavailable: ${escapeHtml(error.message)}</div>`;
  }
}

function startLiveReload() {
  let activeVersion = null;
  let sawServerError = false;
  setInterval(async () => {
    try {
      const res = await fetch(`/api/version?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error("version check failed");
      const data = await res.json();
      if (activeVersion && (data.version !== activeVersion || sawServerError)) {
        window.location.reload();
        return;
      }
      activeVersion = data.version;
      sawServerError = false;
    } catch (_error) {
      sawServerError = true;
    }
  }, 1500);
}

function renderBaseMetrics() {
  const query = $("metric-search").value.trim().toLowerCase();
  const filtered = state.baseMetrics.filter((item) => item.name.toLowerCase().includes(query));
  $("base-metrics").innerHTML = filtered
    .map(
      (item) => `
        <button class="metric-item" title="Click to copy metric name" data-copy="${item.name}">
          <span class="metric-name">${item.name}</span>
          <span class="metric-example">example: ${formatExample(item.example)}</span>
        </button>
      `,
    )
    .join("");
  document.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", () => navigator.clipboard?.writeText(button.dataset.copy));
  });
}

function formatExample(value) {
  if (Array.isArray(value)) return "[...]";
  if (typeof value === "number") return formatNumber(value, 4);
  return value ?? "-";
}

function renderCustomMetrics() {
  $("custom-metrics").innerHTML = state.customMetrics
    .map(
      (metric, index) => `
        <div class="row">
          <input aria-label="Metric name" value="${escapeAttr(metric.name)}" data-metric-name="${index}" />
          <input aria-label="Metric formula" value="${escapeAttr(metric.formula)}" data-metric-formula="${index}" />
          <button class="icon" title="Remove metric" data-remove-metric="${index}">×</button>
        </div>
      `,
    )
    .join("");
  document.querySelectorAll("[data-metric-name]").forEach((input) => {
    input.addEventListener("input", () => {
      state.customMetrics[Number(input.dataset.metricName)].name = input.value;
      saveState();
      renderConditions();
    });
  });
  document.querySelectorAll("[data-metric-formula]").forEach((input) => {
    input.addEventListener("input", () => {
      state.customMetrics[Number(input.dataset.metricFormula)].formula = input.value;
      saveState();
    });
  });
  document.querySelectorAll("[data-remove-metric]").forEach((button) => {
    button.addEventListener("click", () => {
      state.customMetrics.splice(Number(button.dataset.removeMetric), 1);
      saveState();
      renderCustomMetrics();
      renderConditions();
    });
  });
}

function renderConditions() {
  const metricOptions = state.customMetrics
    .filter((metric) => metric.name.trim())
    .map((metric) => metric.name.trim());
  $("conditions").innerHTML = state.conditions
    .map(
      (condition, index) => `
        <div class="row condition-row">
          <select aria-label="Condition metric" data-condition-metric="${index}">
            ${metricOptions
              .map(
                (metric) =>
                  `<option value="${escapeAttr(metric)}" ${metric === condition.metric ? "selected" : ""}>${metric}</option>`,
              )
              .join("")}
          </select>
          <select aria-label="Condition operator" data-condition-operator="${index}">
            ${[">", ">=", "<", "<=", "==", "!="]
              .map((op) => `<option value="${op}" ${op === condition.operator ? "selected" : ""}>${op}</option>`)
              .join("")}
          </select>
          <input aria-label="Condition value" type="number" step="0.01" value="${escapeAttr(condition.value)}" data-condition-value="${index}" />
          <button class="icon" title="Remove condition" data-remove-condition="${index}">×</button>
        </div>
      `,
    )
    .join("");
  document.querySelectorAll("[data-condition-metric]").forEach((input) => {
    input.addEventListener("change", () => {
      state.conditions[Number(input.dataset.conditionMetric)].metric = input.value;
      saveState();
    });
  });
  document.querySelectorAll("[data-condition-operator]").forEach((input) => {
    input.addEventListener("change", () => {
      state.conditions[Number(input.dataset.conditionOperator)].operator = input.value;
      saveState();
    });
  });
  document.querySelectorAll("[data-condition-value]").forEach((input) => {
    input.addEventListener("input", () => {
      state.conditions[Number(input.dataset.conditionValue)].value = Number(input.value);
      saveState();
    });
  });
  document.querySelectorAll("[data-remove-condition]").forEach((button) => {
    button.addEventListener("click", () => {
      state.conditions.splice(Number(button.dataset.removeCondition), 1);
      saveState();
      renderConditions();
    });
  });
}

function addMetric() {
  state.customMetrics.push({ name: "New Metric", formula: "net_income / total_assets" });
  saveState();
  renderCustomMetrics();
  renderConditions();
}

function addCondition() {
  const metric = state.customMetrics[0]?.name || "ROA";
  state.conditions.push({ metric, operator: ">", value: 0 });
  saveState();
  renderConditions();
}

async function runBacktest() {
  $("run").disabled = true;
  $("run").textContent = "Running...";
  $("summary").textContent = "Scanning financials and building portfolio history...";
  state.selectedPeriodIndex = null;
  clearPeriodDetails();
  try {
    const res = await fetch("/api/backtest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        metrics: state.customMetrics,
        conditions: state.conditions,
        minRevenue: Number($("min-revenue").value || 0),
      }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || "Backtest failed.");
    state.result = data;
    $("save-backtest").disabled = false;
    $("save-name").value = defaultBacktestName();
    renderResult();
  } catch (error) {
    $("summary").innerHTML = `<span class="error">${escapeHtml(error.message)}</span>`;
    drawChart([]);
  } finally {
    $("run").disabled = false;
    $("run").textContent = "Run Backtest";
  }
}

function currentBacktestConfig() {
  return {
    metrics: state.customMetrics,
    conditions: state.conditions,
    minRevenue: Number($("min-revenue").value || 0),
  };
}

function defaultBacktestName() {
  const condition = state.conditions[0];
  const metric = condition?.metric || "Backtest";
  const op = condition?.operator || "";
  const value = condition?.value ?? "";
  return `${metric} ${op} ${value}`.trim();
}

async function saveCurrentBacktest() {
  if (!state.result) return;
  const name = $("save-name").value.trim() || defaultBacktestName() || "Saved backtest";
  const savedAt = new Date().toISOString();
  const id = `${savedAt}-${Math.random().toString(16).slice(2)}`;
  await putSavedBacktest({
    id,
    name,
    savedAt,
    config: currentBacktestConfig(),
    result: state.result,
  });
  await refreshSavedBacktests();
}

async function handleSavedBacktestClick(event) {
  const loadButton = event.target.closest("[data-load-backtest]");
  if (loadButton) {
    await loadSavedBacktest(loadButton.dataset.loadBacktest);
    return;
  }
  const deleteButton = event.target.closest("[data-delete-backtest]");
  if (deleteButton) {
    await deleteSavedBacktest(deleteButton.dataset.deleteBacktest);
    await refreshSavedBacktests();
  }
}

async function loadSavedBacktest(id) {
  const record = await getSavedBacktest(id);
  if (!record) return;
  state.customMetrics = record.config?.metrics || state.customMetrics;
  state.conditions = record.config?.conditions || state.conditions;
  $("min-revenue").value = record.config?.minRevenue ?? $("min-revenue").value;
  state.result = record.result;
  saveState();
  renderCustomMetrics();
  renderConditions();
  $("save-backtest").disabled = false;
  $("save-name").value = record.name;
  renderResult();
}

function renderSavedBacktests() {
  if (!state.savedBacktests.length) {
    $("saved-backtests").innerHTML = '<div class="empty">No saved backtests yet.</div>';
    return;
  }
  $("saved-backtests").innerHTML = state.savedBacktests
    .map(
      (record) => `
        <div class="saved-item">
          <div>
            <strong>${escapeHtml(record.name)}</strong>
            <span>${formatSavedDate(record.savedAt)} · ${formatNumber(record.resultSummary?.finalValue)} final · ${formatDuration(record.resultSummary?.elapsedSeconds)}</span>
          </div>
          <button class="ghost" data-load-backtest="${escapeAttr(record.id)}">Load</button>
          <button class="icon" title="Delete saved backtest" data-delete-backtest="${escapeAttr(record.id)}">×</button>
        </div>
      `,
    )
    .join("");
}

function formatSavedDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "saved";
  return date.toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function renderResult() {
  const result = state.result;
  $("summary").textContent = result.notes.join(" ");
  $("stats").innerHTML = `
    <div class="stat"><strong>${formatNumber(result.finalValue)}</strong><span>final value</span></div>
    <div class="stat"><strong>${formatPct(result.totalReturn)}</strong><span>total return</span></div>
    <div class="stat"><strong>${result.periods}</strong><span>periods</span></div>
    <div class="stat"><strong>${formatDuration(result.elapsedSeconds)}</strong><span>backtest time</span></div>
  `;
  drawChart(result.series);
  const yearlyItems = yearlyPeriodItems(result);
  state.yearlyItems = yearlyItems;
  state.positionItems = positionSummaryItems(result);
  renderPositionHistory();
  $("period-list").innerHTML = yearlyItems
    .map(
      ({ item, index, year, yearReturn, rows, available }) =>
        `<div class="period-row">
          <button class="period-item" type="button" data-period-index="${index}" aria-pressed="false">
            <strong>${year}</strong>
            <span>${item.period}</span>
            <span>${formatCount(rows.length)} holding intervals</span>
            <span>${formatCount(available)} max available</span>
            <span>${formatPct(yearReturn)} year return</span>
          </button>
          <div class="detail inline-detail" data-period-detail-index="${index}"></div>
        </div>`,
    )
    .join("");
  selectPeriod(null);
}

function yearlyPeriodItems(result) {
  const byYear = new Map();
  let previousValue = result.startValue || 100;
  result.series.forEach((item, index) => {
    const year = String(item.period).slice(0, 4);
    const existing = byYear.get(year);
    const startValue = existing?.startValue ?? previousValue;
    const rowsByInterval = existing?.rowsByInterval || new Map();
    (item.sample || []).forEach((row) => {
      const key = `${row.ticker}|${row.startPeriod}|${row.endPeriod}`;
      if (!rowsByInterval.has(key)) rowsByInterval.set(key, row);
    });
    byYear.set(year, {
      item,
      index,
      year,
      startValue,
      yearReturn: item.value / startValue - 1,
      rowsByInterval,
      rows: [...rowsByInterval.values()].sort(compareHoldingRows),
      available: Math.max(existing?.available || 0, item.available || 0),
      completed: (existing?.completed || 0) + (item.completed || 0),
    });
    previousValue = item.value;
  });
  return [...byYear.values()];
}


function positionSummaryItems(result) {
  const byInterval = new Map();
  (result.series || []).forEach((item) => {
    (item.sample || []).forEach((row) => {
      const key = `${row.ticker}|${row.startPeriod}|${row.endPeriod}`;
      if (!byInterval.has(key)) byInterval.set(key, row);
    });
  });

  const byTicker = new Map();
  [...byInterval.values()].forEach((row) => {
    const ticker = row.ticker || "";
    const existing = byTicker.get(ticker) || {
      ticker,
      companyName: row.companyName || "",
      exchange: row.exchange || "",
      intervalCount: 0,
      totalMonths: 0,
      firstHeld: row.startPeriod,
      lastHeld: row.endPeriod,
      totalReturnFactor: 1,
      returnSum: 0,
      latestInterval: row,
      intervals: [],
    };
    const months = intervalMonths(row.startPeriod, row.endPeriod);
    existing.intervalCount += 1;
    existing.totalMonths += months;
    existing.firstHeld = minPeriod(existing.firstHeld, row.startPeriod);
    existing.lastHeld = maxPeriod(existing.lastHeld, row.endPeriod);
    existing.totalReturnFactor *= 1 + (Number.isFinite(row.return) ? row.return : 0);
    existing.returnSum += Number.isFinite(row.return) ? row.return : 0;
    existing.intervals.push(row);
    if (comparePeriods(row.endPeriod, existing.latestInterval?.endPeriod) > 0) {
      existing.latestInterval = row;
    }
    byTicker.set(ticker, existing);
  });

  return [...byTicker.values()]
    .map((item) => ({
      ...item,
      totalYears: item.totalMonths / 12,
      averageReturn: item.intervalCount ? item.returnSum / item.intervalCount : 0,
      compoundedReturn: item.totalReturnFactor - 1,
      latestMarketCap: item.latestInterval?.marketCap,
      latestRevenue: item.latestInterval?.revenue,
      intervals: item.intervals.sort(compareHoldingRows),
    }))
    .sort((a, b) => b.totalMonths - a.totalMonths || String(a.ticker).localeCompare(String(b.ticker)));
}

function renderPositionHistory() {
  const target = $("position-history");
  if (!target) return;
  const rows = sortedPositionItems(state.positionItems || []);
  if (!rows.length) {
    target.innerHTML = '<div class="empty">No positions yet.</div>';
    return;
  }
  target.innerHTML = `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Rank</th>
            ${sortablePositionHeader("ticker", "Ticker")}
            ${sortablePositionHeader("companyName", "Company")}
            ${sortablePositionHeader("totalMonths", "Held")}
            ${sortablePositionHeader("intervalCount", "Intervals")}
            ${sortablePositionHeader("firstHeld", "First Held")}
            ${sortablePositionHeader("lastHeld", "Last Held")}
            ${sortablePositionHeader("averageReturn", "Avg Return")}
            ${sortablePositionHeader("compoundedReturn", "Compounded Return")}
            ${sortablePositionHeader("latestMarketCap", "Latest Market Cap")}
            ${sortablePositionHeader("latestRevenue", "Latest Revenue")}
          </tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (row, index) => `
                <tr>
                  <td>${index + 1}</td>
                  <td>${escapeHtml(row.ticker)}</td>
                  <td>${escapeHtml(row.companyName || "")}</td>
                  <td>${formatHeldTime(row.totalMonths)}</td>
                  <td>${formatCount(row.intervalCount)}</td>
                  <td>${escapeHtml(row.firstHeld)}</td>
                  <td>${escapeHtml(row.lastHeld)}</td>
                  <td>${formatPct(row.averageReturn)}</td>
                  <td>${formatPct(row.compoundedReturn)}</td>
                  <td>${formatNumber(row.latestMarketCap)}</td>
                  <td>${formatNumber(row.latestRevenue)}</td>
                </tr>
              `,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}


function handlePositionHistoryClick(event) {
  const button = event.target.closest("[data-position-sort]");
  if (!button) return;
  const key = button.dataset.positionSort;
  state.positionSort = {
    key,
    direction: state.positionSort.key === key && state.positionSort.direction === "desc" ? "asc" : "desc",
  };
  renderPositionHistory();
}

function sortablePositionHeader(key, label) {
  const isCurrent = state.positionSort.key === key;
  const direction = isCurrent ? state.positionSort.direction : "";
  const suffix = direction === "asc" ? " ↑" : direction === "desc" ? " ↓" : "";
  return `<th><button class="sort-button" type="button" data-position-sort="${escapeAttr(key)}" aria-sort="${isCurrent ? direction : "none"}">${escapeHtml(label)}${suffix}</button></th>`;
}

function sortedPositionItems(rows) {
  const { key, direction } = state.positionSort;
  const multiplier = direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const primary = comparePositionValues(a[key], b[key]);
    if (primary) return primary * multiplier;
    return String(a.ticker || "").localeCompare(String(b.ticker || ""));
  });
}

function comparePositionValues(a, b) {
  const leftNumber = Number(a);
  const rightNumber = Number(b);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
  const periodCompare = comparePeriods(a, b);
  if (periodCompare) return periodCompare;
  return String(a ?? "").localeCompare(String(b ?? ""));
}

function formatHeldTime(months) {
  const value = Math.max(0, Number(months) || 0);
  if (value < 12) return `${value} mo`;
  const years = Math.floor(value / 12);
  const remainingMonths = value % 12;
  return remainingMonths ? `${years} yr ${remainingMonths} mo` : `${years} yr`;
}

function intervalMonths(startPeriod, endPeriod) {
  const start = parsePeriod(startPeriod);
  const end = parsePeriod(endPeriod);
  if (!start || !end) return 0;
  return Math.max(0, (end.year - start.year) * 12 + (end.month - start.month));
}

function parsePeriod(period) {
  const match = String(period || "").match(/^(\d{4})-(\d{2})$/);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]) };
}

function comparePeriods(a, b) {
  const left = parsePeriod(a);
  const right = parsePeriod(b);
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;
  return left.year - right.year || left.month - right.month;
}

function minPeriod(a, b) {
  return comparePeriods(a, b) <= 0 ? a : b;
}

function maxPeriod(a, b) {
  return comparePeriods(a, b) >= 0 ? a : b;
}

function compareHoldingRows(a, b) {
  return (
    String(a.ticker || "").localeCompare(String(b.ticker || "")) ||
    String(a.startPeriod || "").localeCompare(String(b.startPeriod || "")) ||
    String(a.endPeriod || "").localeCompare(String(b.endPeriod || ""))
  );
}

function yearlyItemForPeriodIndex(index) {
  return state.yearlyItems.find((item) => item.index === index);
}

function handlePeriodClick(event) {
  const button = event.target.closest("[data-period-index]");
  if (!button) return;
  const index = Number(button.dataset.periodIndex || 0);
  selectPeriod(state.selectedPeriodIndex === index ? null : index);
}

function selectPeriod(index) {
  const result = state.result;
  if (!result?.series?.length || index === null) {
    state.selectedPeriodIndex = null;
    document.querySelectorAll(".period-item").forEach((button) => {
      button.classList.remove("selected");
      button.setAttribute("aria-pressed", "false");
    });
    renderPeriodDetail(null);
    return;
  }
  const nextIndex = Math.max(0, Math.min(index, result.series.length - 1));
  state.selectedPeriodIndex = nextIndex;
  document.querySelectorAll(".period-item").forEach((button) => {
    const isSelected = Number(button.dataset.periodIndex) === nextIndex;
    button.classList.toggle("selected", isSelected);
    button.setAttribute("aria-pressed", String(isSelected));
  });
  renderPeriodDetail(nextIndex);
}

function clearPeriodDetails() {
  document.querySelectorAll("[data-period-detail-index]").forEach((detail) => {
    detail.innerHTML = "";
  });
}

function drawChart(series) {
  const canvas = $("chart");
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(600, Math.floor(rect.width * dpr));
  canvas.height = Math.floor(360 * dpr);
  ctx.scale(dpr, dpr);
  const width = canvas.width / dpr;
  const height = canvas.height / dpr;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#fbfcfb";
  ctx.fillRect(0, 0, width, height);
  const pad = { left: 54, right: 20, top: 18, bottom: 36 };
  const values = series.map((item) => item.value);
  const min = Math.min(100, ...values);
  const max = Math.max(110, ...values);
  const x = (index) => pad.left + (index / Math.max(1, series.length - 1)) * (width - pad.left - pad.right);
  const y = (value) => pad.top + (1 - (value - min) / Math.max(1, max - min)) * (height - pad.top - pad.bottom);

  ctx.strokeStyle = "#dce3de";
  ctx.lineWidth = 1;
  for (let i = 0; i < 5; i += 1) {
    const yy = pad.top + (i / 4) * (height - pad.top - pad.bottom);
    ctx.beginPath();
    ctx.moveTo(pad.left, yy);
    ctx.lineTo(width - pad.right, yy);
    ctx.stroke();
    const label = max - (i / 4) * (max - min);
    ctx.fillStyle = "#66726a";
    ctx.font = "12px system-ui";
    ctx.fillText(formatNumber(label, 0), 10, yy + 4);
  }

  if (!series.length) {
    ctx.fillStyle = "#66726a";
    ctx.font = "14px system-ui";
    ctx.fillText("No data yet", pad.left, height / 2);
    return;
  }

  ctx.strokeStyle = "#176f5d";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  series.forEach((item, index) => {
    const px = x(index);
    const py = y(item.value);
    if (index === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();

  ctx.fillStyle = "#315f9f";
  const last = series[series.length - 1];
  ctx.beginPath();
  ctx.arc(x(series.length - 1), y(last.value), 4, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#66726a";
  ctx.font = "12px system-ui";
  ctx.fillText(series[0].period, pad.left, height - 12);
  ctx.textAlign = "right";
  ctx.fillText(last.period, width - pad.right, height - 12);
  ctx.textAlign = "left";
}

function renderPeriodDetail(index) {
  const result = state.result;
  if (!result?.series?.length || index === null) {
    clearPeriodDetails();
    return;
  }
  clearPeriodDetails();
  const target = document.querySelector(`[data-period-detail-index="${index}"]`);
  if (!target) return;
  target.innerHTML = periodDetailHtml(index);
}

function periodDetailHtml(index) {
  const result = state.result;
  const item = result.series[index];
  const yearlyItem = yearlyItemForPeriodIndex(index);
  const rows = yearlyItem?.rows || item.sample || [];
  const heading = yearlyItem
    ? `${yearlyItem.year}: ${formatCount(rows.length)} unique active holding intervals, ${formatCount(yearlyItem.available)} max available stocks, ${formatCount(yearlyItem.completed)} completed returns applied, year return ${formatPct(yearlyItem.yearReturn)}`
    : `${item.period}: ${formatCount(item.holdings)} active holdings from ${formatCount(item.available)} available stocks, ${formatCount(item.completed || 0)} completed returns applied, period return ${formatPct(item.return)}`;
  return `
    <p>${heading}</p>
    <table>
      <thead>
        <tr>
          <th>Ticker</th>
          <th>Company</th>
          <th>Holding Period</th>
          <th>Return</th>
          <th>Price</th>
          <th>Market Cap</th>
          <th>Revenue</th>
          ${result.metrics.map((metric) => `<th>${escapeHtml(metric.name)}</th>`).join("")}
        </tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (row) => `
              <tr>
                <td>${escapeHtml(row.ticker)}</td>
                <td>${escapeHtml(row.companyName || "")}</td>
                <td>${escapeHtml(row.startPeriod)} to ${escapeHtml(row.endPeriod)}</td>
                <td>${formatPct(row.return)}</td>
                <td>${formatNumber(row.price)}</td>
                <td>${formatNumber(row.marketCap)}</td>
                <td>${formatNumber(row.revenue)}</td>
                ${result.metrics.map((metric) => `<td>${formatNumber(row.metrics[metric.name], 4)}</td>`).join("")}
              </tr>
            `,
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value ?? "");
}

init().catch((error) => {
  document.body.innerHTML = `<main class="shell"><div class="error">${escapeHtml(error.message)}</div></main>`;
});
