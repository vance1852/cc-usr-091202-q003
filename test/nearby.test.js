import test from "node:test";
import assert from "node:assert/strict";
import { loadFixtureService, makeService } from "./support.js";

test("按坐标查到附近线索、责任班组与承诺时限，按距离升序", async () => {
  const { service } = await loadFixtureService();
  const clues = service.findNearby({ longitude: 121.4731, latitude: 31.2312, radiusMeters: 100 });
  assert.equal(clues.length, 2);
  assert.ok(clues[0].distanceMeters <= clues[1].distanceMeters);
  for (const clue of clues) {
    assert.equal(clue.assigneeTeam, "排水一班");
    assert.ok(clue.promisedAt);
    assert.ok(clue.distanceMeters <= 100);
    assert.equal(clue.reports.length, 1);
  }
});

test("半径外的隐患不出现在结果里", async () => {
  const { service } = await loadFixtureService();
  const clues = service.findNearby({ longitude: 121.5, latitude: 31.3, radiusMeters: 200 });
  assert.equal(clues.length, 0);
});

test("已处置的隐患默认不出现，includeResolved 才返回", async () => {
  const { service } = await loadFixtureService();
  service.resolveHazard("HZ-0001", { operator: "排水一班" });
  const open = service.findNearby({ longitude: 121.4731, latitude: 31.2312, radiusMeters: 100 });
  assert.deepEqual(open.map((c) => c.hazardId), ["HZ-0002"]);
  const all = service.findNearby({
    longitude: 121.4731,
    latitude: 31.2312,
    radiusMeters: 100,
    includeResolved: true,
  });
  assert.equal(all.length, 2);
});

test("listOpen 按承诺时限排序并标注超时", async () => {
  const { service, advance } = makeService();
  service.addReport({ reportId: "A", issue: "积水", longitude: 121.4732, latitude: 31.2313, reportedAt: "2026-10-06T08:00:00+08:00" });
  service.addReport({ reportId: "B", issue: "路灯不亮", longitude: 121.4733, latitude: 31.2314, reportedAt: "2026-10-06T08:00:00+08:00" });
  const open = service.listOpen();
  assert.deepEqual(open.map((h) => h.hazardId), ["HZ-0001", "HZ-0002"]); // 积水 2h 比默认 24h 更紧迫
  assert.equal(open[0].overdue, false);
  advance(3);
  assert.equal(service.listOpen()[0].overdue, true); // 积水已过承诺时限
});
