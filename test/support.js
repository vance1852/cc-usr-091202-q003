import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HazardService } from "../src/service.js";

export const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const GRIDS = [
  { gridId: "RD-031", road: "新河路", center: [121.4731, 31.2312], maintenanceTeam: "排水一班" },
  { gridId: "RD-032", road: "民安街", center: [121.474, 31.232], maintenanceTeam: "路面二班" },
];

/** 固定时钟的服务实例，advance(hours) 可推进时间。 */
export function makeService(options = {}) {
  let current = new Date(options.start ?? "2026-10-06T09:00:00+08:00");
  const service = new HazardService({
    now: () => current,
    ...(options.serviceOptions ?? {}),
  });
  service.ingestGrid(options.grids ?? GRIDS);
  return {
    service,
    advance(hours) {
      current = new Date(current.getTime() + hours * 3600_000);
    },
  };
}

export async function loadFixtureService() {
  const { service } = makeService();
  const csv = await readFile(path.join(root, "fixtures", "hotline.csv"), "utf8");
  const result = service.ingestHotlineCsv(csv);
  return { service, result };
}
