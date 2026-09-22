// 把热线 CSV 与道路网格 JSON 汇入统一视图。
// 网格在构造服务时载入；热线行逐条接单，按 reportId 幂等，重复导入返回原记录。

import { readFile } from "node:fs/promises";
import { parseCsv } from "./lib/csv.js";

export async function loadGrid(contextPath) {
  const raw = JSON.parse(await readFile(contextPath, "utf8"));
  return raw.records.map((cell) => ({
    gridId: cell.gridId,
    road: cell.road,
    center: cell.center,
    maintenanceTeam: cell.maintenanceTeam,
  }));
}

export async function loadHotlineRows(csvPath) {
  const rows = parseCsv(await readFile(csvPath, "utf8"));
  return rows
    .filter((row) => row.report_id)
    .map((row) => ({
      reportId: row.report_id,
      source: row.source,
      coords: [Number(row.longitude), Number(row.latitude)],
      issue: row.issue,
      scope: row.scope ?? "",
      reportedAt: row.reported_at,
      // CSV 已脱敏；如来源扩展出匿名/回访列可在此映射。
      anonymous: row.anonymous === "true" || row.anonymous === "1",
      contact: row.contact || null,
      callbackNeeded: row.callback_needed === "true" || row.callback_needed === "1",
    }));
}

export async function ingestFixtures(service, hotlinePath) {
  const rows = await loadHotlineRows(hotlinePath);
  return rows.map((row) => service.receiveReport(row));
}
