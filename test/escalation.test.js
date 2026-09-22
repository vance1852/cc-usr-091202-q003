import test from "node:test";
import assert from "node:assert/strict";
import { makeService } from "./support.js";

function waterHazard(service) {
  service.addReport({ reportId: "W", issue: "积水", longitude: 121.4732, latitude: 31.2313 });
  return "HZ-0001";
}

test("水位观测抬高危险等级并记录升级理由", async () => {
  const { service } = makeService();
  const id = waterHazard(service);
  assert.equal(service.getHazard(id).dangerLevel, "medium");

  const result = service.recordObservation(id, { type: "water-level", depthCm: 35 });
  assert.equal(result.escalated, true);
  assert.equal(result.dangerLevel, "critical");

  const hazard = service.getHazard(id);
  assert.equal(hazard.escalations.length, 1);
  assert.equal(hazard.escalations[0].from, "medium");
  assert.equal(hazard.escalations[0].to, "critical");
  assert.ok(hazard.escalations[0].reason.includes("水位观测 35cm"));
  assert.deepEqual(
    hazard.timeline.map((e) => e.kind),
    ["report-created", "observation", "escalation"],
  );
});

test("水位回落不自动降级", async () => {
  const { service } = makeService();
  const id = waterHazard(service);
  service.recordObservation(id, { type: "water-level", depthCm: 35 });
  const again = service.recordObservation(id, { type: "water-level", depthCm: 10 });
  assert.equal(again.escalated, false);
  assert.equal(service.getHazard(id).dangerLevel, "critical");
  assert.equal(service.getHazard(id).escalations.length, 1);
});

test("现场照片研判同样改变危险等级", async () => {
  const { service } = makeService();
  const id = waterHazard(service);
  const result = service.recordObservation(id, { type: "photo", severity: "moderate", note: "水面已漫过人行道" });
  assert.equal(result.dangerLevel, "high");
  const hazard = service.getHazard(id);
  assert.ok(hazard.escalations !== undefined);
  assert.ok(hazard.escalations[0].reason.includes("现场照片研判 moderate"));
  assert.ok(hazard.escalations[0].reason.includes("水面已漫过人行道"));
});

test("人工下调危险等级必须给理由，且不记入升级历史", async () => {
  const { service } = makeService();
  const id = waterHazard(service);
  service.recordObservation(id, { type: "water-level", depthCm: 35 });
  service.adjustDangerLevel(id, "low", { reason: "排水完成，水位已退", operator: "值班员乙" });
  const hazard = service.getHazard(id);
  assert.equal(hazard.dangerLevel, "low");
  assert.equal(hazard.escalations.length, 1); // 只有观测那次升级
  assert.ok(hazard.timeline.some((e) => e.kind === "danger-adjusted" && e.reason === "排水完成，水位已退"));
  assert.throws(() => service.adjustDangerLevel(id, "medium"), /reason/);
});

test("非法观测被拒绝", async () => {
  const { service } = makeService();
  const id = waterHazard(service);
  assert.throws(() => service.recordObservation(id, { type: "water-level", depthCm: -1 }), /depthCm/);
  assert.throws(() => service.recordObservation(id, { type: "photo", severity: "unknown" }), /severity/);
  assert.throws(() => service.recordObservation(id, { type: "other" }), /观测类型/);
});
