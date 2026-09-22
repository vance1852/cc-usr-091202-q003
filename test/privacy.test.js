import test from "node:test";
import assert from "node:assert/strict";
import { makeService } from "./support.js";

test("匿名来电只保存回访所需信息", async () => {
  const { service } = makeService();
  const { report } = service.addReport({
    reportId: "ANON-1",
    issue: "积水",
    longitude: 121.4732,
    latitude: 31.2313,
    anonymous: true,
    reporter: {
      name: "张三",
      idNumber: "310101199001011234",
      phone: "13800000000",
      callbackPhone: "13911112222",
    },
  });
  assert.equal(report.anonymous, true);
  assert.equal(report.reporter, null);
  assert.deepEqual(report.callback, { phone: "13911112222" });

  const persisted = JSON.stringify(service.toJSON());
  assert.ok(!persisted.includes("张三"));
  assert.ok(!persisted.includes("310101199001011234"));
  assert.ok(!persisted.includes("13800000000"));
  assert.ok(persisted.includes("13911112222")); // 回访电话保留
});

test("匿名来电未给回拨电话时退而保留联系电话", async () => {
  const { service } = makeService();
  const { report } = service.addReport({
    issue: "积水",
    longitude: 121.4732,
    latitude: 31.2313,
    anonymous: true,
    reporter: { name: "李四", phone: "13700001111" },
  });
  assert.deepEqual(report.callback, { phone: "13700001111" });
});

test("非匿名来电原样保留报料人信息", async () => {
  const { service } = makeService();
  const { report } = service.addReport({
    issue: "积水",
    longitude: 121.4732,
    latitude: 31.2313,
    reporter: { name: "王五", phone: "13600002222" },
  });
  assert.equal(report.anonymous, false);
  assert.equal(report.reporter.name, "王五");
});
