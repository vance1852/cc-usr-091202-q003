import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { HazardService } from "../src/service.js";
import { makeService, root } from "./support.js";

const execFileAsync = promisify(execFile);

/** 构造一份包含合并、升级、转派、办结、回访的完整现场状态。 */
function buildBusyService() {
  const { service } = makeService();
  service.addReport({ reportId: "A", issue: "积水", longitude: 121.4732, latitude: 31.2313, reportedAt: "2026-10-06T08:00:00+08:00" });
  service.addReport({ reportId: "B", issue: "路面塌陷", longitude: 121.4733, latitude: 31.2312, reportedAt: "2026-10-06T08:05:00+08:00" });
  service.addReport({ reportId: "C", issue: "积水", longitude: 121.474, latitude: 31.232, reportedAt: "2026-10-06T08:10:00+08:00" });

  service.mergeHazards("HZ-0001", "HZ-0002", { operator: "值班员甲", note: "同一路面点" });
  service.recordObservation("HZ-0001", { type: "water-level", depthCm: 35 });
  service.transferHazard("HZ-0001", { toTeam: "市政三班", reason: "积水点需泵车支援", operator: "值班员甲" });
  service.transferHazard("HZ-0001", { toTeam: "排水二班", reason: "泵车归口排水", operator: "值班员甲" });
  service.resolveHazard("HZ-0001", { operator: "排水二班", summary: "积水已抽排" });
  service.recordCallback("HZ-0001", { conclusion: "市民确认积水已退", satisfied: true });

  service.recordObservation("HZ-0003", { type: "photo", severity: "moderate", note: "水面扩大" });
  service.transferHazard("HZ-0003", { toTeam: "市政三班", reason: "跨部门协查" });
  return service; // HZ-0003 保持未结
}

test("快照序列化后可原样恢复（未结隐患、升级理由、转派历史）", async () => {
  const service = buildBusyService();
  const restored = HazardService.fromJSON(service.toJSON());

  const strip = (snapshot) => {
    const { savedAt, ...rest } = snapshot;
    return rest;
  };
  assert.deepEqual(strip(restored.toJSON()), strip(service.toJSON()));

  const open = restored.listOpen();
  assert.deepEqual(open.map((h) => h.hazardId), ["HZ-0003"]);
  assert.deepEqual(
    restored.getHazard("HZ-0001").escalations.map((e) => e.reason),
    service.getHazard("HZ-0001").escalations.map((e) => e.reason),
  );
  assert.equal(restored.getHazard("HZ-0001").transfers.length, 2);
});

test("恢复后新单编号不与历史冲突", async () => {
  const service = buildBusyService();
  const restored = HazardService.fromJSON(service.toJSON());
  const { hazard } = restored.addReport({ issue: "积水", longitude: 121.4732, latitude: 31.2313 });
  assert.equal(hazard.hazardId, "HZ-0004");
});

test("持久化文件交给新进程后原样恢复", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "hazard-snapshot-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "state.json");

  const service = buildBusyService();
  await service.saveToFile(file);

  const { stdout } = await execFileAsync("node", [
    path.join(root, "tools", "restore-and-print.mjs"),
    file,
  ]);
  const projection = JSON.parse(stdout);

  assert.deepEqual(projection.openHazards, ["HZ-0003"]);
  assert.deepEqual(projection.hazards, service.toJSON().hazards);
  assert.deepEqual(projection.escalations["HZ-0001"], ["合并 HZ-0002：采纳更高危险等级 high", "水位观测 35cm"]);
  assert.equal(projection.transfers["HZ-0001"].length, 2);
  assert.equal(projection.transfers["HZ-0001"][0].toTeam, "市政三班");
});
