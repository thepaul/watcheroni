#!/usr/bin/env node
// Per-minute Durable Object usage from Cloudflare's GraphQL Analytics API,
// to confirm that hibernated time isn't billed.
//
// Usage:
//   CLOUDFLARE_ACCOUNT_ID=... \
//     node scripts/do-usage.mjs [--since 2026-10-26T18:00:00Z] [--until ...]
//
// It uses wrangler's login, or CLOUDFLARE_API_TOKEN if set (that token
// needs "Account Analytics: Read").

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const { values: opts } = parseArgs({
  options: {
    since: { type: "string", default: new Date(Date.now() - 60 * 60 * 1000).toISOString() },
    until: { type: "string", default: new Date().toISOString() },
  },
});
// Without CLOUDFLARE_API_TOKEN, use wrangler's own login, which can read
// account analytics.
function wranglerToken() {
  try {
    return execFileSync("npx", ["wrangler", "auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .trim().split("\n").pop();
  } catch {
    return undefined;
  }
}
const token = process.env.CLOUDFLARE_API_TOKEN || wranglerToken();
const accountTag = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token || !accountTag) {
  console.error("set CLOUDFLARE_ACCOUNT_ID, and either run `npx wrangler login` or set CLOUDFLARE_API_TOKEN");
  process.exit(2);
}

async function gql(query, variables = {}) {
  const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors?.length) throw new Error(JSON.stringify(body.errors, null, 2));
  return body.data;
}

// Field names from introspecting the dataset on 2026-10-27. Introspection
// counts against the Analytics API's rate limit, so it isn't repeated.
const timeDim = "datetimeMinute";
const extraDims = ["objectId"];
const sumFields = [
  "activeTime", "cpuTime", "duration", "inboundWebsocketMsgCount", "outboundWebsocketMsgCount",
  "rowsRead", "rowsWritten", "storageReadUnits", "storageWriteUnits", "subrequests",
];

const query = `query($account: String!, $since: Time!, $until: Time!) {
  viewer { accounts(filter: { accountTag: $account }) {
    durableObjectsPeriodicGroups(
      limit: 1000,
      filter: { ${timeDim}_geq: $since, ${timeDim}_leq: $until },
      orderBy: [${timeDim}_ASC]
    ) {
      dimensions { ${[timeDim, ...extraDims].join(" ")} }
      sum { ${sumFields.join(" ")} }
    }
  } }
}`;
const data = await gql(query, { account: accountTag, since: opts.since, until: opts.until });
const rows = data.viewer.accounts[0]?.durableObjectsPeriodicGroups ?? [];
if (!rows.length) {
  console.log("no rows yet (analytics can lag by a few minutes)");
  process.exit(0);
}
console.table(rows.map((r) => ({ ...r.dimensions, ...r.sum })));
console.log("\nDuring the probe's idle minutes, activeTime (if listed) and cpuTime should be at or near zero,");
console.log("while the WebSocket connections stay open.");
