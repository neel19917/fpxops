#!/usr/bin/env node
// Measure the Railway cost of the fpx-browser service and append it to
// browser-service/cost-log.md.
//
//   node browser-service/scripts/railway-cost.mjs [hours=24]
//
// Uses the Railway CLI's login (~/.railway/config.json) to read the service's
// metrics (CPU, memory, egress, volume) over the window, then prices them with
// Railway's usage rates below. It's an ESTIMATE: Railway's invoice is the
// source of truth (railway.com → project → Usage).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ID = "c2be327a-8009-424a-9459-6015f1737666"; // stellar-creation
const SERVICE_ID = "8b39357a-8f68-4dc4-9044-35fea823408f"; // fpx-browser

// Railway usage pricing (per month = 730 h). Update if Railway changes rates.
const RATES = { vcpuMonth: 20, gbRamMonth: 10, egressGb: 0.05, volumeGbMonth: 0.15 };
const HOURS_PER_MONTH = 730;

const hours = Number(process.argv[2] || 24);
const here = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.join(here, "..", "cost-log.md");

const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".railway", "config.json"), "utf8"));
const token = cfg.user?.token || cfg.user?.accessToken;
if (!token) { console.error("Not logged in to Railway (run `railway login`)."); process.exit(1); }

const res = await fetch("https://backboard.railway.com/graphql/v2", {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({
    query: `query($projectId:String!,$serviceId:String,$startDate:DateTime!){
      metrics(projectId:$projectId, serviceId:$serviceId, startDate:$startDate, sampleRateSeconds:300,
              measurements:[CPU_USAGE, MEMORY_USAGE_GB, NETWORK_TX_GB, DISK_USAGE_GB]) { measurement values { ts value } } }`,
    variables: { projectId: PROJECT_ID, serviceId: SERVICE_ID, startDate: new Date(Date.now() - hours * 3600e3).toISOString() },
  }),
});
const body = await res.json();
if (body.errors) { console.error(JSON.stringify(body.errors).slice(0, 500)); process.exit(1); }

const series = Object.fromEntries(body.data.metrics.map((m) => [m.measurement, m.values]));
const step = 300 / 3600; // each sample covers 5 minutes, in hours
const sum = (k) => (series[k] || []).reduce((t, x) => t + x.value, 0);
const max = (k) => Math.max(0, ...(series[k] || []).map((x) => x.value));
const last = (k) => (series[k] || []).at(-1)?.value ?? 0;

// CPU and memory are gauges → integrate over time. Egress samples are the
// GB sent in each 5-minute interval → sum them.
const vcpuHours = sum("CPU_USAGE") * step;
const gbRamHours = sum("MEMORY_USAGE_GB") * step;
const egressGb = sum("NETWORK_TX_GB");
const volumeGb = last("DISK_USAGE_GB");

const cost = {
  cpu: vcpuHours * RATES.vcpuMonth / HOURS_PER_MONTH,
  ram: gbRamHours * RATES.gbRamMonth / HOURS_PER_MONTH,
  egress: egressGb * RATES.egressGb,
  volume: volumeGb * RATES.volumeGbMonth * (hours / HOURS_PER_MONTH),
};
const total = Object.values(cost).reduce((a, b) => a + b, 0);
const perMonth = total * (HOURS_PER_MONTH / hours);
const $ = (n) => `$${n.toFixed(n < 1 ? 3 : 2)}`;

const line = `| ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC | ${hours}h | ${vcpuHours.toFixed(2)} vCPU·h (peak ${max("CPU_USAGE").toFixed(2)}) | ${gbRamHours.toFixed(2)} GB·h (peak ${max("MEMORY_USAGE_GB").toFixed(2)} GB) | ${egressGb.toFixed(2)} GB | ${volumeGb.toFixed(2)} GB | ${$(cost.cpu)} / ${$(cost.ram)} / ${$(cost.egress)} / ${$(cost.volume)} | **${$(total)}** | ${$(perMonth)} |`;

if (!fs.existsSync(LOG)) {
  fs.writeFileSync(LOG, `# fpx-browser — Railway cost log

Measured from Railway's service metrics by \`browser-service/scripts/railway-cost.mjs\`,
priced at Railway usage rates ($${RATES.vcpuMonth}/vCPU-month, $${RATES.gbRamMonth}/GB-RAM-month,
$${RATES.egressGb}/GB egress, $${RATES.volumeGbMonth}/GB-month volume). Estimates — the
Railway invoice is the source of truth. "Per month" extrapolates the window as if
usage stayed the same around the clock.

| Logged | Window | CPU | Memory | Egress | Volume | Cost CPU / RAM / egress / volume | Window total | Per month at this rate |
|---|---|---|---|---|---|---|---|---|
`);
}
fs.appendFileSync(LOG, line + "\n");
console.log(line);
console.log(`\nLogged to ${path.relative(process.cwd(), LOG)}`);
