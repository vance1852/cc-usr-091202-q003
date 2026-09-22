// 进程入口：载入道路网格与事件日志 -> 恢复统一视图 -> 启动 HTTP 服务。
// 事件日志在 data/events.jsonl；进程重启或换进程时重放它，
// 未结隐患、升级理由与全部转派历史原样恢复。

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCoordinationService } from "./service.js";
import { loadGrid, ingestFixtures } from "./ingest.js";
import { loadEventStore, appendEvent, writeSnapshot } from "./persistence.js";
import { createHttpServer } from "./http.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = process.env.DATA_DIR ?? path.join(root, "data");
const EVENT_LOG = path.join(DATA_DIR, "events.jsonl");
const SNAPSHOT = path.join(DATA_DIR, "snapshot.json");

const HELP = `城市道路报修协同服务

用法：
  npm start                 启动 HTTP 服务（默认端口 8080）
  node src/index.js ingest  导入 fixtures 热线记录后退出
  node src/index.js snapshot 导出当前快照到 data/snapshot.json

环境变量：
  PORT       HTTP 端口（默认 8080）
  DATA_DIR   事件日志与快照目录（默认 ./data）
`;

async function bootstrap() {
  const grid = await loadGrid(path.join(root, "fixtures", "context.json"));
  const eventStore = await loadEventStore(EVENT_LOG);
  const service = createCoordinationService({ grid, eventStore });
  service.onEvent((event) => appendEvent(EVENT_LOG, event));
  return service;
}

async function main() {
  const command = process.argv[2];
  if (command === "--help" || command === "-h") {
    console.log(HELP);
    return;
  }

  const service = await bootstrap();

  if (command === "ingest") {
    const results = await ingestFixtures(service, path.join(root, "fixtures", "hotline.csv"));
    for (const r of results) {
      console.log(`${r.duplicate ? "重复" : r.awaitingDecision ? "待判定" : "已开单"} ${r.report.reportId}`);
    }
    return;
  }

  if (command === "snapshot") {
    await writeSnapshot(SNAPSHOT, service.snapshot());
    console.log(`快照已写入 ${SNAPSHOT}`);
    return;
  }

  // 启动时幂等补导热线样例（已有 reportId 不会重复落库）。
  await ingestFixtures(service, path.join(root, "fixtures", "hotline.csv"));

  const port = Number(process.env.PORT ?? 8080);
  const server = createHttpServer(service);
  server.listen(port, () => {
    console.log(`协同服务已启动：http://localhost:${port}`);
    console.log(`事件日志：${EVENT_LOG}（${service.eventLog().length} 条）`);
  });
}

main().catch((err) => {
  console.error("启动失败：", err);
  process.exit(1);
});
