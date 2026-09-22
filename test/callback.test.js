import test from "node:test";
import assert from "node:assert/strict";
import { makeService } from "./support.js";

test("处置完成后，回访结论接在原时间线上", async () => {
  const { service } = makeService();
  service.addReport({ reportId: "A", issue: "积水", longitude: 121.4732, latitude: 31.2313 });
  service.transferHazard("HZ-0001", { toTeam: "市政三班", reason: "需泵车" });
  service.resolveHazard("HZ-0001", { operator: "市政三班", summary: "积水已抽排" });
  service.recordCallback("HZ-0001", { conclusion: "市民确认积水已退，满意", satisfied: true, operator: "回访员丙" });

  const hazard = service.getHazard("HZ-0001");
  assert.deepEqual(
    hazard.timeline.map((e) => e.kind),
    ["report-created", "transfer", "resolved", "callback"],
  );
  const callback = hazard.timeline.at(-1);
  assert.equal(callback.conclusion, "市民确认积水已退，满意");
  assert.equal(hazard.callbacks.length, 1);
  assert.equal(hazard.status, "resolved");
});

test("未处置完成不能登记回访结论", async () => {
  const { service } = makeService();
  service.addReport({ reportId: "A", issue: "积水", longitude: 121.4732, latitude: 31.2313 });
  assert.throws(
    () => service.recordCallback("HZ-0001", { conclusion: "满意" }),
    (error) => error.code === "NOT_RESOLVED",
  );
});

test("重复办结被拒绝", async () => {
  const { service } = makeService();
  service.addReport({ reportId: "A", issue: "积水", longitude: 121.4732, latitude: 31.2313 });
  service.resolveHazard("HZ-0001");
  assert.throws(
    () => service.resolveHazard("HZ-0001"),
    (error) => error.code === "ALREADY_RESOLVED",
  );
});
