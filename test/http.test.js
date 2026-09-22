// HTTP 入口集成测试：真实起服务、真实发请求。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createCoordinationService } from "../src/service.js";
import { createHttpServer } from "../src/http.js";
import { loadGrid } from "../src/ingest.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let base;
const server = createHttpServer(
  createCoordinationService({
    grid: await loadGrid(path.join(root, "fixtures", "context.json")),
    now: () => "2026-10-06T09:00:00+08:00",
  })
);

before(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const call = async (method, urlPath, body) => {
  const res = await fetch(base + urlPath, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, json };
};

test("接单 → 近线查询 → 补证据升级 → 转派 → 回访 全链路", async () => {
  const created = await call("POST", "/reports", {
    reportId: "H-1",
    source: "12345",
    coords: [121.4732, 31.2313],
    issue: "积水",
    reportedAt: "2026-10-06T08:12:00+08:00",
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.incident.currentTeam, "排水一班");
  const id = created.json.incident.id;

  const nearby = await call("GET", "/nearby?lng=121.4732&lat=31.2313&radius=50");
  assert.equal(nearby.json.nearestGrid.gridId, "RD-031");
  assert.ok(nearby.json.incidents.some((i) => i.id === id));

  const ev = await call("POST", `/incidents/${id}/evidence`, {
    evidence: { kind: "water", waterLevelCm: 20, at: "2026-10-06T08:30:00+08:00" },
  });
  assert.equal(ev.json.danger.level, "urgent");

  const tx = await call("POST", `/incidents/${id}/transfer`, {
    to: "应急抢险队",
    reason: "积水超警戒",
  });
  assert.equal(tx.json.transferHistory.length, 1);

  await call("POST", `/incidents/${id}/resolve`, { note: "处置完成" });
  const rv = await call("POST", `/incidents/${id}/revisit`, { outcome: "closed", note: "来电人确认" });
  assert.equal(rv.json.status, "closed");
});

test("错误以结构化 JSON 返回：影响范围冲突 409、缺参 400、不存在 404", async () => {
  const a = await call("POST", "/reports", {
    reportId: "X-1",
    source: "g",
    coords: [121.4733, 31.2312],
    issue: "路面塌陷",
    scope: "非机动车道",
  });
  const b = await call("POST", "/reports", {
    reportId: "X-2",
    source: "g",
    coords: [121.47332, 31.23122],
    issue: "路面塌陷",
    scope: "整幅机动车道",
  });
  const conflict = await call("POST", `/reports/X-2/decision`, {
    decision: "same",
    incidentId: a.json.incident.id,
    operator: "甲",
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.error.code, "SCOPE_CONFLICT");

  assert.equal((await call("POST", "/reports", { reportId: "bad" })).status, 400);
  assert.equal((await call("GET", "/incidents/NOPE")).status, 404);

  // 重复上报返回已有记录
  const dup = await call("POST", "/reports", {
    reportId: "X-1",
    coords: [121.4733, 31.2312],
    issue: "路面塌陷",
  });
  assert.equal(dup.json.duplicate, true);
});
