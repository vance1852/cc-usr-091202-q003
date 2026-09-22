import test from "node:test";
import assert from "node:assert/strict";
import { makeService } from "./support.js";

test("跨部门转派保留原承办关系与全部转派历史", async () => {
  const { service } = makeService();
  service.addReport({ reportId: "A", issue: "积水", longitude: 121.4732, latitude: 31.2313, reportedAt: "2026-10-06T08:00:00+08:00" });
  const promisedAt = service.getHazard("HZ-0001").promisedAt;

  service.transferHazard("HZ-0001", { toTeam: "市政三班", reason: "积水点需泵车支援", operator: "值班员甲" });
  service.transferHazard("HZ-0001", { toTeam: "排水二班", reason: "泵车归口排水", operator: "值班员甲" });

  const hazard = service.getHazard("HZ-0001");
  assert.equal(hazard.originalTeam, "排水一班"); // 最初承办关系不变
  assert.equal(hazard.assigneeTeam, "排水二班"); // 当前承办为最后一次转派
  assert.equal(hazard.transfers.length, 2);
  assert.deepEqual(
    hazard.transfers.map((t) => [t.fromTeam, t.toTeam]),
    [
      ["排水一班", "市政三班"],
      ["市政三班", "排水二班"],
    ],
  );
  assert.equal(hazard.transfers[0].reason, "积水点需泵车支援");
  assert.equal(hazard.promisedAt, promisedAt); // 承诺时限不因转派改变
  assert.equal(hazard.timeline.filter((e) => e.kind === "transfer").length, 2);
});

test("转派给当前班组或已办结隐患被拒绝", async () => {
  const { service } = makeService();
  service.addReport({ reportId: "A", issue: "积水", longitude: 121.4732, latitude: 31.2313 });
  assert.throws(() => service.transferHazard("HZ-0001", { toTeam: "排水一班" }), /无需转派/);
  service.resolveHazard("HZ-0001");
  assert.throws(
    () => service.transferHazard("HZ-0001", { toTeam: "市政三班" }),
    (error) => error.code === "ALREADY_RESOLVED",
  );
});
