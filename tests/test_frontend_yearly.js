const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const source = fs.readFileSync("public/script.js", "utf8").split("\ninit().catch")[0];
const sandbox = {
  console,
  window: { devicePixelRatio: 1, location: { reload() {} } },
  document: { getElementById() { return null; }, querySelectorAll() { return []; } },
  localStorage: { getItem() { return null; }, setItem() {} },
  fetch: async () => ({ ok: true, json: async () => ({}) }),
  setInterval() {},
};
vm.createContext(sandbox);
vm.runInContext(`${source}\nthis.yearlyPeriodItems = yearlyPeriodItems; this.positionSummaryItems = positionSummaryItems;`, sandbox);

const result = {
  startValue: 100,
  series: [
    {
      period: "2024-01",
      value: 101,
      available: 10,
      completed: 1,
      sample: [{ ticker: "AAPL", startPeriod: "2023-12", endPeriod: "2024-03" }],
    },
    {
      period: "2024-02",
      value: 102,
      available: 11,
      completed: 2,
      sample: [{ ticker: "AAPL", startPeriod: "2023-12", endPeriod: "2024-03" }],
    },
    {
      period: "2024-03",
      value: 103,
      available: 9,
      completed: 3,
      sample: [{ ticker: "AAPL", startPeriod: "2024-03", endPeriod: "2024-06" }],
    },
  ],
};

const years = sandbox.yearlyPeriodItems(result);
assert.strictEqual(years.length, 1);
assert.strictEqual(years[0].year, "2024");
assert.strictEqual(years[0].rows.length, 2);
assert.strictEqual(
  JSON.stringify(years[0].rows.map((row) => `${row.ticker}:${row.startPeriod}-${row.endPeriod}`)),
  JSON.stringify(["AAPL:2023-12-2024-03", "AAPL:2024-03-2024-06"]),
);
assert.strictEqual(years[0].available, 11);
assert.strictEqual(years[0].completed, 6);


const positionResult = {
  series: [
    {
      period: "2024-01",
      sample: [
        { ticker: "AAPL", companyName: "Apple", startPeriod: "2023-12", endPeriod: "2024-03", return: 0.1, marketCap: 3, revenue: 1 },
        { ticker: "MSFT", companyName: "Microsoft", startPeriod: "2024-01", endPeriod: "2024-02", return: 0.2, marketCap: 2, revenue: 1 },
      ],
    },
    {
      period: "2024-02",
      sample: [
        { ticker: "AAPL", companyName: "Apple", startPeriod: "2023-12", endPeriod: "2024-03", return: 0.1, marketCap: 3, revenue: 1 },
        { ticker: "MSFT", companyName: "Microsoft", startPeriod: "2024-02", endPeriod: "2024-03", return: -0.1, marketCap: 2, revenue: 1 },
      ],
    },
    {
      period: "2024-03",
      sample: [
        { ticker: "AAPL", companyName: "Apple", startPeriod: "2024-03", endPeriod: "2024-06", return: 0.05, marketCap: 4, revenue: 2 },
      ],
    },
  ],
};

const positions = sandbox.positionSummaryItems(positionResult);
assert.strictEqual(positions.length, 2);
assert.strictEqual(positions[0].ticker, "AAPL");
assert.strictEqual(positions[0].intervalCount, 2);
assert.strictEqual(positions[0].totalMonths, 6);
assert.strictEqual(positions[0].firstHeld, "2023-12");
assert.strictEqual(positions[0].lastHeld, "2024-06");
assert.strictEqual(positions[0].latestMarketCap, 4);
assert.ok(Math.abs(positions[0].compoundedReturn - 0.155) < 0.000001);
assert.strictEqual(positions[1].ticker, "MSFT");
assert.strictEqual(positions[1].intervalCount, 2);
assert.strictEqual(positions[1].totalMonths, 2);
