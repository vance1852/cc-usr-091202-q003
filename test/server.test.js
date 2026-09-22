import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "../src/server.js";
import { makeService } from "./support.js";

async function withServer(t, run) {
  const { service } = makeService();
  const server = createServer(service);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  await run(base, service);
}

const post = (base, path_, body) =>
  fetch(`${base}${path_}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });

test("HTTP 入口：建单幂等、附近查询、转派、时间线", async (t) => {
  await withServer(t, async (base) => {
    const created = await post(base, "/reports", {
      reportId: "R-1",
      issue: "积水",
      longitude: 121.4732,
      latitude: 31.2313,
      reportedAt: "2026-10-06T08:00:00+08:00",
    });
    assert.equal(created.status, 201);
    const { hazard } = await created.json();
    assert.equal(hazard.assigneeTeam, "排水一班");

    const duplicate = await post(base, "/reports", {
      reportId: "R-1",
      issue: "积水",
      longitude: 121.4732,
      latitude: 31.2313,
    });
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).deduplicated, true);

    const nearby = await fetch(`${base}/nearby?lng=121.4731&lat=31.2312&radius=100`);
    const { clues } = await nearby.json();
    assert.equal(clues.length, 1);
    assert.equal(clues[0].assigneeTeam, "排水一班");
    assert.ok(clues[0].promisedAt);

    const transfer = await post(base, `/hazards/${hazard.hazardId}/transfer`, {
      toTeam: "市政三班",
      reason: "需泵车",
    });
    assert.equal(transfer.status, 200);
    const transferred = await transfer.json();
    assert.equal(transferred.assigneeTeam, "市政三班");
    assert.equal(transferred.originalTeam, "排水一班");

    const detail = await fetch(`${base}/hazards/${hazard.hazardId}`);
    const view = await detail.json();
    assert.deepEqual(
      view.timeline.map((e) => e.kind),
      ["report-created", "transfer"],
    );
  });
});

test("HTTP 入口：影响范围冲突返回 409，未知资源返回 404", async (t) => {
  await withServer(t, async (base) => {
    await post(base, "/reports", { reportId: "A", issue: "积水", longitude: 121.4732, latitude: 31.2313, impactScope: "一条车道" });
    await post(base, "/reports", { reportId: "B", issue: "积水", longitude: 121.4733, latitude: 31.2314, impactScope: "整幅路面" });

    const conflict = await post(base, "/hazards/HZ-0001/merge", { secondaryId: "HZ-0002" });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error.code, "IMPACT_SCOPE_MISMATCH");

    const missing = await fetch(`${base}/hazards/HZ-9999`);
    assert.equal(missing.status, 404);

    const badRoute = await fetch(`${base}/no-such-route`);
    assert.equal(badRoute.status, 404);
  });
});

test("HTTP 入口：快照可写入文件并被新服务恢复", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "hazard-http-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await withServer(t, async (base) => {
    await post(base, "/reports", { reportId: "A", issue: "积水", longitude: 121.4732, latitude: 31.2313 });
    const file = path.join(dir, "state.json");
    const saved = await post(base, "/snapshot", { path: file });
    assert.equal(saved.status, 200);

    const { HazardService } = await import("../src/service.js");
    const restored = await HazardService.loadFromFile(file);
    assert.equal(restored.listOpen().length, 1);
  });
});
