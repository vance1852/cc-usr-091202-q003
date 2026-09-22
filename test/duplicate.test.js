import test from "node:test";
import assert from "node:assert/strict";
import { makeService } from "./support.js";

test("重复上报返回已有记录，不新建隐患、不改时间线", async () => {
  const { service } = makeService();
  const first = service.addReport({ reportId: "R-1", issue: "积水", longitude: 121.4732, latitude: 31.2313 });
  assert.equal(first.deduplicated, false);

  const second = service.addReport({ reportId: "R-1", issue: "积水", longitude: 121.4732, latitude: 31.2313 });
  assert.equal(second.deduplicated, true);
  assert.equal(second.hazard.hazardId, first.hazard.hazardId);
  assert.equal(service.hazards.size, 1);
  assert.equal(service.getHazard(first.hazard.hazardId).timeline.length, 1);
});

test("reportId 类型不同（数字/字符串）也按同一记录去重", async () => {
  const { service } = makeService();
  service.addReport({ reportId: 123, issue: "积水", longitude: 121.4732, latitude: 31.2313 });
  const again = service.addReport({ reportId: "123", issue: "积水", longitude: 121.4732, latitude: 31.2313 });
  assert.equal(again.deduplicated, true);
  assert.equal(service.hazards.size, 1);
});

test("未提供 reportId 时自动生成且互不冲突", async () => {
  const { service } = makeService();
  const a = service.addReport({ issue: "积水", longitude: 121.4732, latitude: 31.2313 });
  const b = service.addReport({ issue: "积水", longitude: 121.4733, latitude: 31.2314 });
  assert.notEqual(a.report.reportId, b.report.reportId);
  assert.equal(service.hazards.size, 2);
});
