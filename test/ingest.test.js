import test from "node:test";
import assert from "node:assert/strict";
import { loadFixtureService } from "./support.js";

test("CSV 热线与 JSON 网格汇入统一视图", async () => {
  const { service, result } = await loadFixtureService();
  assert.deepEqual(result, { created: ["R-1001", "R-1002"], duplicates: [] });
  assert.equal(service.reports.size, 2);
  assert.equal(service.hazards.size, 2);
  assert.equal(service.grids.length, 2);
});

test("上报自动绑定最近网格的承办班组并计算承诺时限", async () => {
  const { service } = await loadFixtureService();
  const water = service.getHazard("HZ-0001");
  assert.equal(water.gridId, "RD-031");
  assert.equal(water.assigneeTeam, "排水一班");
  assert.equal(water.originalTeam, "排水一班");
  // 积水承诺 2 小时：08:12+08:00 -> 10:12+08:00
  assert.equal(water.promisedAt, "2026-10-06T02:12:00.000Z");

  const collapse = service.getHazard("HZ-0002");
  assert.equal(collapse.assigneeTeam, "排水一班"); // 距 RD-031 更近
  // 路面塌陷承诺 4 小时：08:18+08:00 -> 12:18+08:00
  assert.equal(collapse.promisedAt, "2026-10-06T04:18:00.000Z");
  assert.equal(collapse.dangerLevel, "high");
});

test("重复汇入同一 CSV 不重复建单", async () => {
  const { service } = await loadFixtureService();
  const csv = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../fixtures/hotline.csv", import.meta.url), "utf8"),
  );
  const again = service.ingestHotlineCsv(csv);
  assert.deepEqual(again, { created: [], duplicates: ["R-1001", "R-1002"] });
  assert.equal(service.hazards.size, 2);
});
