import test from "node:test";
import assert from "node:assert/strict";
import { loadFixtureService, makeService } from "./support.js";

test("系统不自动合并：同一地点相近上报仍是两条独立隐患", async () => {
  const { service } = await loadFixtureService();
  const open = service.listOpen();
  assert.equal(open.length, 2);
  assert.notEqual(open[0].hazardId, open[1].hazardId);
});

test("值班员确认后合并：上报迁移、次隐患留痕、承诺时限取最早", async () => {
  const { service } = await loadFixtureService();
  const primary = service.mergeHazards("HZ-0001", "HZ-0002", { operator: "值班员甲", note: "同一路面点" });
  assert.deepEqual(primary.reportIds, ["R-1001", "R-1002"]);
  assert.equal(primary.promisedAt, "2026-10-06T02:12:00.000Z");

  const secondary = service.getHazard("HZ-0002");
  assert.equal(secondary.status, "merged");
  assert.equal(secondary.mergedInto, "HZ-0001");
  assert.ok(secondary.timeline.some((e) => e.kind === "merged-into"));
  assert.ok(primary.timeline.some((e) => e.kind === "reports-linked" && e.operator === "值班员甲"));

  // 次隐患危险等级更高（塌陷 high）时，主隐患升级并记录理由
  assert.equal(primary.dangerLevel, "high");
  assert.ok(primary.escalations.some((e) => e.reason.includes("HZ-0002")));

  // 合并后次隐患不可再操作
  assert.throws(() => service.transferHazard("HZ-0002", { toTeam: "市政三班" }), /已并入/);
});

test("影响范围不同的事件拒绝合并", async () => {
  const { service } = makeService();
  service.addReport({ reportId: "A", issue: "积水", longitude: 121.4732, latitude: 31.2313, impactScope: "一条车道" });
  service.addReport({ reportId: "B", issue: "积水", longitude: 121.4733, latitude: 31.2314, impactScope: "整幅路面" });
  assert.throws(
    () => service.mergeHazards("HZ-0001", "HZ-0002", { operator: "值班员甲" }),
    (error) => error.code === "IMPACT_SCOPE_MISMATCH",
  );
  // 状态保持不变
  assert.equal(service.getHazard("HZ-0001").status, "open");
  assert.equal(service.getHazard("HZ-0002").status, "open");
  assert.deepEqual(service.getHazard("HZ-0001").reportIds, ["A"]);
});

test("影响范围未评估时可合并，并采纳已评估的一方", async () => {
  const { service } = makeService();
  service.addReport({ reportId: "A", issue: "积水", longitude: 121.4732, latitude: 31.2313 });
  service.addReport({ reportId: "B", issue: "积水", longitude: 121.4733, latitude: 31.2314, impactScope: "一条车道" });
  const primary = service.mergeHazards("HZ-0001", "HZ-0002");
  assert.equal(primary.impactScope, "一条车道");
});
