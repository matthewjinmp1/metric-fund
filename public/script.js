const state = {
  baseMetrics: [],
  customMetrics: [],
  conditions: [],
  result: null,
  savedBacktests: [],
};

const BACKTEST_DB = "metricFundBacktests";
const BACKTEST_STORE = "backtests";

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
  await refreshSavedBacktests();
}

function openBacktestDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(BACKTEST_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(BACKTEST_STORE)) {
        db.createObjectStore(BACKTEST_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withBacktestStore(mode, callback) {
  const db = await openBacktestDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BACKTEST_STORE, mode);
    const store = tx.objectStore(BACKTEST_STORE);
    const request = callback(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

async function listSavedBacktests() {
  const rows = await withBacktestStore("readonly", (store) => store.getAll());
  return rows.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
}

async function putSavedBacktest(record) {
  return withBacktestStore("readwrite", (store) => store.put(record));
}

async function getSavedBacktest(id) {
  return withBacktestStore("readonly", (store) => store.get(id));
}

async function deleteSavedBacktest(id) {
  return withBacktestStore("readwrite", (store) => store.delete(id));
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
            <span>${formatSavedDate(record.savedAt)} · ${formatNumber(record.result?.finalValue)} final · ${formatDuration(record.result?.elapsedSeconds)}</span>
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
  const yearlyItems = yearlyPeriodItems(result.series);
  $("period-list").innerHTML = yearlyItems
    .map(
      ({ item, index, year }) =>
        `<div class="period-row">
          <button class="period-item" type="button" data-period-index="${index}" aria-pressed="false">
            <strong>${year}</strong>
            <span>${item.period}</span>
            <span>${formatCount(item.holdings)} holdings</span>
            <span>${formatCount(item.available)} available</span>
            <span>${formatPct(item.return)} return</span>
          </button>
          <div class="detail inline-detail" data-period-detail-index="${index}"></div>
        </div>`,
    )
    .join("");
  selectPeriod(Math.max(0, result.series.length - 1));
}

function yearlyPeriodItems(series) {
  const byYear = new Map();
  series.forEach((item, index) => {
    const year = String(item.period).slice(0, 4);
    byYear.set(year, { item, index, year });
  });
  return [...byYear.values()];
}

function handlePeriodClick(event) {
  const button = event.target.closest("[data-period-index]");
  if (!button) return;
  selectPeriod(Number(button.dataset.periodIndex || 0));
}

function selectPeriod(index) {
  const result = state.result;
  if (!result?.series?.length) {
    renderPeriodDetail(null);
    return;
  }
  const nextIndex = Math.max(0, Math.min(index, result.series.length - 1));
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
  const rows = item.sample || [];
  return `
    <p>${item.period}: ${formatCount(item.holdings)} active holdings from ${formatCount(item.available)} available stocks, ${formatCount(item.completed || 0)} completed returns applied, period return ${formatPct(item.return)}</p>
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
