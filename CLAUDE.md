# FPX-RefreshAllShipments

## How to work in this repo

- **Always parallelize: 5 agents at a time.** We need to build quickly. Split each task into independent pieces (for example: server route, dashboard page, shared components, browser service, review) and run them as 5 agents at once instead of working through them one after another. Give each agent its own files so they don't edit the same file at the same time.
