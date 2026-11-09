# fpx-browser — Railway cost log

Measured from Railway's service metrics by `browser-service/scripts/railway-cost.mjs`,
priced at Railway usage rates ($20/vCPU-month, $10/GB-RAM-month,
$0.05/GB egress, $0.15/GB-month volume). Estimates — the
Railway invoice is the source of truth. "Per month" extrapolates the window as if
usage stayed the same around the clock.

| Logged | Window | CPU | Memory | Egress | Volume | Cost CPU / RAM / egress / volume | Window total | Per month at this rate |
|---|---|---|---|---|---|---|---|---|
| 2026-11-09 19:17 UTC | 3h | 0.76 vCPU·h (peak 0.82) | 2.31 GB·h (peak 2.21 GB) | 3.96 GB | 1.04 GB | $0.021 / $0.032 / $0.198 / $0.001 | **$0.251** | $61.04 |
| 2026-11-09 19:17 UTC | 24h | 0.76 vCPU·h (peak 0.82) | 2.31 GB·h (peak 2.21 GB) | 3.96 GB | 1.04 GB | $0.021 / $0.032 / $0.198 / $0.005 | **$0.255** | $7.77 |
