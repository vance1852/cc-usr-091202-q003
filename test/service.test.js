// 需求端到端验证：暴雨值班场景。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCoordinationService } from "../src/service.js";
import { EventStore } from "../src/model/repository.js";
import { loadGrid, ingestFixtures } from "../src/ingest.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIX = path.join(root, "fixtures");

async function newService(now = "2026-10-06T09:00:00+08:00") {
  const grid = await loadGrid(path.join(FIX, "context.json"));
  let t = new Date(now).getTime();
  const clock = () => new Date((t += 1000)).toISOString();
  return { service: createCoordinationService({ grid, now: clock, matchRadiusM: 50 }), clock: () => new Date(t).toISOString() };
}

test("CSV 热线记录与 JSON 道路网格汇入统一视图，自动就近派单并给出承诺时限", async () => {
  const { service } = await newService();
  const results = await ingestFixtures(service, path.join(FIX, "hotline.csv"));
  assert.equal(results.length, 2);

  // R-1001 积水（新河路）→ 新隐患，就近 RD-031 → 排水一班
  const flood = service.listIncidents().find((i) => i.category === "flooding");
  assert.ok(flood);
  assert.equal(flood.grid.gridId, "RD-031");
  assert.equal(flood.currentTeam, "排水一班");
  assert.ok(Date.parse(flood.commitmentDueAt) > Date.parse(flood.reports[0].reportedAt));
  assert.equal(flood.danger.level, "medium"); // 积水初始中等级

  // R-1002 塌陷点距 RD-031 中心 19m、距 RD-032 111m：就近归 RD-031
  const collapse = service.listIncidents().find((i) => i.category === "collapse");
  assert.equal(collapse.danger.level, "urgent");
  assert.equal(collapse.grid.gridId, "RD-031");
  assert.equal(collapse.currentTeam, "排水一班");
});

test("值班员按坐标查到附近线索、责任班组与承诺时限", async () => {
  const { service } = await newService();
  await ingestFixtures(service, path.join(FIX, "hotline.csv"));

  const found = service.nearby(121.4732, 31.2313, 60);
  assert.equal(found.nearestGrid.gridId, "RD-031");
  assert.ok(found.incidents.length >= 1);
  const hit = found.incidents.find((i) => i.category === "flooding");
  assert.equal(hit.currentTeam, "排水一班");
  assert.ok(hit.commitmentDueAt);
  // 按距离升序
  const distances = found.incidents.map((i) => i.distanceM);
  assert.deepEqual(distances, [...distances].sort((a, b) => a - b));
});

test("相近上报只返回候选，系统不自行合并；值班员可判定并入", async () => {
  const { service } = await newService();
  await ingestFixtures(service, path.join(FIX, "hotline.csv"));

  // 网格员在塌陷点 8 米处再报一次塌陷
  const pending = service.receiveReport({
    reportId: "R-1003",
    source: "网格巡查",
    coords: [121.47335, 31.23125],
    issue: "路面塌陷",
    reportedAt: "2026-10-06T08:25:00+08:00",
  });
  assert.equal(pending.awaitingDecision, true);
  assert.equal(pending.candidates.length, 1);
  assert.equal(pending.candidates[0].incidentId, "INC-0002");
  // 隐患数量没有增加——系统没有自行合并也没有另立
  assert.equal(service.listIncidents().length, 2);

  const decided = service.decideReport("R-1003", "same", { operator: "值班员甲", reason: "同一塌陷点" });
  assert.equal(decided.incident.id, "INC-0002");
  assert.equal(decided.incident.reports.length, 2);
  assert.equal(service.getReport("R-1003").status, "linked");
});

test("影响范围不同的事件禁止合并，必须另立隐患", async () => {
  const { service } = await newService();
  service.receiveReport({
    reportId: "A-1",
    source: "12345",
    coords: [121.4733, 31.2312],
    issue: "路面塌陷",
    scope: "非机动车道一处",
    reportedAt: "2026-10-06T08:18:00+08:00",
  });
  const pending = service.receiveReport({
    reportId: "A-2",
    source: "城管网格员",
    coords: [121.47332, 31.23122],
    issue: "路面塌陷",
    scope: "整幅机动车道",
    reportedAt: "2026-10-06T08:30:00+08:00",
  });
  assert.equal(pending.awaitingDecision, true);

  assert.throws(
    () => service.decideReport("A-2", "same", { operator: "值班员甲" }),
    (err) => err.code === "SCOPE_CONFLICT"
  );
  // 记录仍处于待判定，系统没有替值班员做决定
  assert.equal(service.getReport("A-2").status, "pending");

  const separated = service.decideReport("A-2", "separate", {
    operator: "值班员甲",
    reason: "影响范围不同：机动车道整幅 vs 非机一处",
  });
  assert.notEqual(separated.incident.id, "INC-0001");
  assert.equal(service.listIncidents().length, 2);
  assert.equal(service.getReport("A-2").decision.kind, "separate");
});

test("水位观测与现场照片改变危险等级，升级保留理由", async () => {
  const { service } = await newService();
  const r = service.receiveReport({
    reportId: "W-1",
    source: "12345",
    coords: [121.4731, 31.2312],
    issue: "积水",
    reportedAt: "2026-10-06T08:12:00+08:00",
  });
  const id = r.incident.id;
  assert.equal(r.incident.danger.level, "medium");

  const high = service.addEvidence(id, {
    kind: "water",
    waterLevelCm: 8,
    at: "2026-10-06T08:20:00+08:00",
    source: "水位计-新河路",
  });
  assert.equal(high.danger.level, "high");
  assert.equal(high.escalationHistory.length, 1);
  assert.equal(high.escalationHistory[0].from, "medium");
  assert.match(high.escalationHistory[0].reason, /8cm/);

  const urgent = service.addEvidence(id, {
    kind: "photo",
    photoId: "P-9",
    photoTags: ["large-area", "traffic-blocked"],
    at: "2026-10-06T08:22:00+08:00",
  });
  // 8cm 水 + 大面积/阻断 → high；再补 20cm 水位到 urgent
  assert.equal(urgent.danger.level, "high");
  const now = service.addEvidence(id, {
    kind: "water",
    waterLevelCm: 20,
    at: "2026-10-06T08:25:00+08:00",
  });
  assert.equal(now.danger.level, "urgent");
  assert.equal(now.escalationHistory.length, 2);
  assert.equal(now.escalationHistory[1].to, "urgent");

  // 承诺时限随升级重算留给值班员可见（升级不改已派单时限，转派可刷新）
  assert.ok(now.commitmentDueAt);
});

test("跨部门转派保留原承办关系与全部转派历史", async () => {
  const { service } = await newService();
  const r = service.receiveReport({
    reportId: "T-1",
    source: "网格巡查",
    coords: [121.4740, 31.2320],
    issue: "路面塌陷",
    reportedAt: "2026-10-06T08:18:00+08:00",
  });
  const id = r.incident.id;
  assert.equal(service.getIncident(id).currentTeam, "路面二班");

  service.transfer(id, { to: "排水一班", reason: "塌陷伴随管线涌水，需排水先行", by: "值班员甲" });
  assert.equal(service.getIncident(id).currentTeam, "排水一班");

  service.transfer(id, { to: "应急抢险队", reason: "夜间交通封路需要应急力量" });
  const inc = service.getIncident(id);
  assert.equal(inc.transferHistory.length, 2);
  assert.deepEqual(
    inc.transferHistory.map((t) => [t.from, t.to]),
    [["路面二班", "排水一班"], ["排水一班", "应急抢险队"]]
  );
  // 原承办关系仍在：首派网格与班组被保留
  assert.equal(inc.transferHistory[0].originRelation.firstTeam, "路面二班");
  assert.equal(inc.transferHistory[0].originRelation.grid, "RD-032");
  assert.equal(inc.transferHistory[1].originRelation.firstTeam, "路面二班");
  // 时间线完整
  const types = inc.timeline.map((e) => e.type);
  assert.ok(types.includes("incident.assigned"));
  assert.equal(types.filter((t) => t === "incident.transferred").length, 2);
});

test("匿名来电只保存回访所需信息", () => {
  const service = createCoordinationService({
    grid: [],
    now: () => "2026-10-06T09:00:00+08:00",
  });
  const r = service.receiveReport({
    reportId: "ANON-1",
    source: "12345",
    coords: [121.4731, 31.2312],
    issue: "积水",
    anonymous: true,
    contact: "13812345678",
    callbackNeeded: true,
  });
  const stored = r.incident.reports[0];
  assert.equal(stored.anonymous, true);
  assert.equal(stored.contact, null); // 身份/联系方式不落库
  assert.equal(stored.callback.needed, true);
  assert.equal(stored.callback.handle, "138****5678"); // 仅脱敏回访号

  // 不需要回访的匿名来电连号码都不留
  const r2 = service.receiveReport({
    reportId: "ANON-2",
    source: "12345",
    coords: [121.4735, 31.2315],
    issue: "积水",
    anonymous: true,
    contact: "13900001111",
  });
  assert.equal(r2.incident.reports[0].callback, null);
});

test("重复上报幂等返回已有记录，不产生新隐患", async () => {
  const { service } = await newService();
  await ingestFixtures(service, path.join(FIX, "hotline.csv"));
  const first = service.receiveReport({
    reportId: "DUP-1",
    source: "12345",
    coords: [121.51, 31.26],
    issue: "积水",
    reportedAt: "2026-10-06T08:12:00+08:00",
  });
  const incidentCount = service.listIncidents().length;
  const again = service.receiveReport({
    reportId: "DUP-1",
    source: "12345",
    coords: [121.51, 31.26],
    issue: "积水",
  });
  assert.equal(again.duplicate, true);
  assert.equal(again.incident.id, first.incident.id);
  assert.equal(service.listIncidents().length, incidentCount);
  // 再次导入同一 CSV 同样幂等
  const secondIngest = await ingestFixtures(service, path.join(FIX, "hotline.csv"));
  assert.ok(secondIngest.every((r) => r.duplicate === true));
});

test("回访结论接在原时间线上；问题仍在可重开", () => {
  const service = createCoordinationService({ grid: [], now: () => "2026-10-06T10:00:00+08:00" });
  const r = service.receiveReport({
    reportId: "RV-1",
    source: "12345",
    coords: [121.4731, 31.2312],
    issue: "积水",
  });
  const id = r.incident.id;
  service.resolve(id, { note: "抽水完成" });
  assert.equal(service.getIncident(id).status, "resolved");

  service.revisit(id, { outcome: "reopen", note: "回访仍有明显积水" });
  const reopened = service.getIncident(id);
  assert.equal(reopened.status, "open");
  assert.equal(reopened.revisit.outcome, "reopen");
  assert.ok(reopened.timeline.at(-1).type === "incident.reopened");

  service.resolve(id, { note: "二次处置完成" });
  service.revisit(id, { outcome: "closed", note: "来电人确认消退" });
  const closed = service.getIncident(id);
  assert.equal(closed.status, "closed");
  // 回访结论挂在原隐患上，时间线是同一条
  assert.equal(closed.reports[0].reportId, "RV-1");
  assert.ok(closed.timeline.some((e) => e.type === "incident.revisited"));
});

test("快照交给新进程：未结隐患、升级理由、全部转派历史原样恢复", async () => {
  const grid = await loadGrid(path.join(FIX, "context.json"));
  let t = new Date("2026-10-06T09:00:00+08:00").getTime();
  const service = createCoordinationService({ grid, now: () => new Date((t += 1000)).toISOString() });

  const r = service.receiveReport({
    reportId: "MIG-1",
    source: "网格巡查",
    coords: [121.4731, 31.2312],
    issue: "积水",
    reportedAt: "2026-10-06T08:12:00+08:00",
  });
  const id = r.incident.id;
  service.addEvidence(id, { kind: "water", waterLevelCm: 8, at: "2026-10-06T08:25:00+08:00" });
  service.addEvidence(id, { kind: "water", waterLevelCm: 18, at: "2026-10-06T08:30:00+08:00" });
  service.transfer(id, { to: "应急抢险队", reason: "积水阻断交通，升级抢险" });
  // 保持未结状态（不 resolve）

  const snapshot = service.snapshot();

  // 模拟“把持久化数据交给一个新进程”：仅用事件日志重建
  const migrated = createCoordinationService({
    grid,
    eventStore: new EventStore(structuredClone(snapshot.events)),
  });

  const restored = migrated.getIncident(id);
  assert.equal(restored.status, "open", "未结隐患原样恢复");
  assert.equal(restored.danger.level, "urgent");
  assert.equal(restored.currentTeam, "应急抢险队");
  // 升级理由
  assert.equal(restored.escalationHistory.length, 2); // medium→high (5cm), high→urgent (15cm)
  assert.match(restored.escalationHistory[1].reason, /18cm/);
  // 全部转派历史与原承办关系
  assert.equal(restored.transferHistory.length, 1);
  assert.equal(restored.transferHistory[0].from, "排水一班");
  assert.equal(restored.transferHistory[0].to, "应急抢险队");
  assert.equal(restored.transferHistory[0].originRelation.firstTeam, "排水一班");
  // 上报与时间线完整
  assert.equal(restored.reports[0].reportId, "MIG-1");
  assert.ok(restored.timeline.some((e) => e.type === "incident.transferred"));
  // 重复上报在新进程仍被识别
  const dup = migrated.receiveReport({
    reportId: "MIG-1",
    source: "网格巡查",
    coords: [121.4731, 31.2312],
    issue: "积水",
  });
  assert.equal(dup.duplicate, true);
});

test("人工升级需理由且只能升高", async () => {
  const { service } = await newService();
  const r = service.receiveReport({
    reportId: "ESC-1",
    source: "12345",
    coords: [121.4731, 31.2312],
    issue: "积水",
  });
  const id = r.incident.id;
  assert.throws(() => service.escalate(id, "high", "  "), /理由/);
  assert.throws(() => service.escalate(id, "low", "降级不行"), /更高/);
  const up = service.escalate(id, "high", "气象预警暴雨持续");
  assert.equal(up.danger.level, "high");
  assert.match(up.escalationHistory.at(-1).reason, /气象预警/);
});
