#!/usr/bin/env node
// Per-minute Durable Object usage from Cloudflare's GraphQL Analytics API,
// to confirm that hibernated time isn't billed.
//
// Usage:
//   CLOUDFLARE_ACCOUNT_ID=... \
//     node scripts/do-usage.mjs [--since 2026-10-26T18:00:00Z] [--until ...]
//
// It uses wrangler's login, or CLOUDFLARE_API_TOKEN if set (that token
// needs "Account Analytics: Read"). The script discovers the dataset's
// fields by introspection rather than hard-coding them, since Cloudflare's
// docs don't list them all.

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

const unwrap = (t) => (t.ofType ? unwrap(t.ofType) : t);
async function typeFields(name) {
  const data = await gql(`query($n: String!) { __type(name: $n) { fields { name type { name kind ofType { name kind ofType { name kind ofType { name kind } } } } } } }`, { n: name });
  return data.__type?.fields ?? [];
}

const accountFields = await typeFields("account");
const datasetField = accountFields.find((f) => f.name === "durableObjectsPeriodicGroups");
if (!datasetField) throw new Error("no durableObjectsPeriodicGroups dataset on this account type");
const groupType = unwrap(datasetField.type).name;
const groupFields = await typeFields(groupType);
const sumType = unwrap(groupFields.find((f) => f.name === "sum").type).name;
const dimType = unwrap(groupFields.find((f) => f.name === "dimensions").type).name;
const sumFields = (await typeFields(sumType)).map((f) => f.name);
const dimFields = (await typeFields(dimType)).map((f) => f.name);
const timeDim = ["datetimeMinute", "datetimeFiveMinutes", "datetimeHour", "date"].find((d) => dimFields.includes(d));
const extraDims = ["namespaceId", "objectId"].filter((d) => dimFields.includes(d));

console.log(`dataset fields: sum { ${sumFields.join(", ")} }`);
console.log(`dimensions: ${dimFields.join(", ")}\n`);

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
