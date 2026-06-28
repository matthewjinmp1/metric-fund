const state = {
  baseMetrics: [],
  customMetrics: [],
  conditions: [],
  result: null,
};

const $ = (id) => document.getElementById(id);

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
  const num = Number(value);
  if (Math.abs(num) >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(digits)}B`;
  if (Math.abs(num) >= 1_000_000) return `${(num / 1_000_000).toFixed(digits)}M`;
  if (Math.abs(num) >= 1_000) return `${(num / 1_000).toFixed(digits)}K`;
  return num.toFixed(digits);
}

function formatPct(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
  return `${(Number(value) * 100).toFixed(1)}%`;
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
  loadSaved();
  const res = await fetch("/api/metrics");
  const data = await res.json();
  state.baseMetrics = data.baseMetrics;
  if (!state.customMetrics.length) state.customMetrics = data.defaultMetrics;
  if (!state.conditions.length) state.conditions = data.defaultConditions;
  renderBaseMetrics();
  renderCustomMetrics();
  renderConditions();
  $("run").addEventListener("click", runBacktest);
  $("add-metric").addEventListener("click", addMetric);
  $("add-condition").addEventListener("click", addCondition);
  $("metric-search").addEventListener("input", renderBaseMetrics);
  $("period-select").addEventListener("change", renderPeriodDetail);
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
  $("period-detail").innerHTML = "";
  try {
    const res = await fetch("/api/backtest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        metrics: state.customMetrics,
        conditions: state.conditions,
        maxHoldings: Number($("max-holdings").value || 0),
        minPrice: Number($("min-price").value || 1),
      }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || "Backtest failed.");
    state.result = data;
    renderResult();
  } catch (error) {
    $("summary").innerHTML = `<span class="error">${escapeHtml(error.message)}</span>`;
    drawChart([]);
  } finally {
    $("run").disabled = false;
    $("run").textContent = "Run Backtest";
  }
}

function renderResult() {
  const result = state.result;
  $("summary").textContent = result.notes.join(" ");
  $("stats").innerHTML = `
    <div class="stat"><strong>${formatNumber(result.finalValue)}</strong><span>final value</span></div>
    <div class="stat"><strong>${formatPct(result.totalReturn)}</strong><span>total return</span></div>
    <div class="stat"><strong>${result.periods}</strong><span>quarters</span></div>
  `;
  drawChart(result.series);
  $("period-select").innerHTML = result.series
    .map((item, index) => `<option value="${index}">${item.period} · ${item.holdings} holdings</option>`)
    .join("");
  $("period-select").value = String(Math.max(0, result.series.length - 1));
  renderPeriodDetail();
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

function renderPeriodDetail() {
  const result = state.result;
  if (!result?.series?.length) {
    $("period-detail").innerHTML = '<div class="empty">No period selected.</div>';
    return;
  }
  const item = result.series[Number($("period-select").value || 0)];
  const rows = item.sample || [];
  $("period-detail").innerHTML = `
    <p>${item.period}: ${item.holdings} holdings, next-quarter return ${formatPct(item.return)}</p>
    <table>
      <thead>
        <tr>
          <th>Ticker</th>
          <th>Company</th>
          <th>Return</th>
          <th>Price</th>
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
                <td>${formatPct(row.return)}</td>
                <td>${formatNumber(row.price)}</td>
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
