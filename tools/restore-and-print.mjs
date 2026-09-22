// 供持久化测试使用：在一个全新进程中载入快照并打印规范化投影，
// 校验未结隐患、升级理由与全部转派历史是否原样恢复。
import { HazardService } from "../src/service.js";

const service = await HazardService.loadFromFile(process.argv[2]);
const hazards = service.toJSON().hazards;

const projection = {
  openHazards: hazards
    .filter((h) => h.status === "open")
    .map((h) => h.hazardId)
    .sort(),
  escalations: Object.fromEntries(
    hazards.map((h) => [h.hazardId, h.escalations.map((e) => e.reason)]),
  ),
  transfers: Object.fromEntries(hazards.map((h) => [h.hazardId, h.transfers])),
  hazards,
};

process.stdout.write(JSON.stringify(projection));
