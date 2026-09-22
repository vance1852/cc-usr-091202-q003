import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { HazardService } from "./service.js";
import { createServer } from "./server.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const hasFlag = (flag) => args.includes(flag);
const optionValue = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};

const USAGE = `城市热线协同服务

用法：
  node src/index.js                 载入 fixtures 统一视图并打印未结隐患
  node src/index.js --serve         启动 HTTP 服务（--port 指定端口，默认 3000）
  node src/index.js --data 快照.json 从持久化快照恢复（可配合 --serve）
  node src/index.js --save 快照.json 退出（SIGINT）时把当前状态写入快照
`;

async function buildService() {
  const snapshotPath = optionValue("--data");
  if (snapshotPath) {
    const service = await HazardService.loadFromFile(snapshotPath);
    console.log(`已从快照恢复：${snapshotPath}（未结隐患 ${service.listOpen().length} 条）`);
    return service;
  }
  const service = new HazardService();
  const context = JSON.parse(await readFile(path.join(root, "fixtures", "context.json"), "utf8"));
  const csv = await readFile(path.join(root, "fixtures", "hotline.csv"), "utf8");
  service.ingestGrid(context.records);
  const { created, duplicates } = service.ingestHotlineCsv(csv);
  console.log(
    `统一视图已载入：网格 ${service.grids.length} 条，热线新建 ${created.length} 条，重复 ${duplicates.length} 条`,
  );
  return service;
}

function printOpenHazards(service) {
  const open = service.listOpen();
  if (open.length === 0) {
    console.log("当前没有未结隐患。");
    return;
  }
  console.log("未结隐患（按承诺时限排序）：");
  for (const h of open) {
    const overdue = h.overdue ? "【已超时】" : "";
    console.log(
      `  ${h.hazardId} ${h.issue} 危险=${h.dangerLevel} 班组=${h.assigneeTeam} 承诺=${h.promisedAt}${overdue}`,
    );
  }
}

if (hasFlag("--help")) {
  console.log(USAGE);
} else {
  const service = await buildService();
  if (hasFlag("--serve")) {
    const port = Number(optionValue("--port") ?? process.env.PORT ?? 3000);
    const savePath = optionValue("--save");
    const server = createServer(service);
    server.listen(port, () => console.log(`协同服务已启动：http://localhost:${port}`));
    if (savePath) {
      process.on("SIGINT", async () => {
        await service.saveToFile(savePath);
        console.log(`\n状态已写入快照：${savePath}`);
        process.exit(0);
      });
    }
  } else {
    printOpenHazards(service);
  }
}
