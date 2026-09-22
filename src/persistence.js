// 文件持久化：事件日志逐行 JSONL 追加，快照为单个 JSON。
// 交给新进程时：新进程读取事件日志重放，未结隐患、升级理由与全部转派历史
// 都由不可变事件原样重建；快照文件用于跨环境移交与人工核对。

import { promises as fs } from "node:fs";
import path from "node:path";
import { EventStore } from "./model/repository.js";

export async function appendEvent(eventLogPath, event) {
  await fs.mkdir(path.dirname(eventLogPath), { recursive: true });
  await fs.appendFile(eventLogPath, JSON.stringify(event) + "\n", "utf8");
}

export async function readEventLog(eventLogPath) {
  let text;
  try {
    text = await fs.readFile(eventLogPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

export async function loadEventStore(eventLogPath) {
  return new EventStore(await readEventLog(eventLogPath));
}

export async function writeSnapshot(snapshotPath, snapshot) {
  await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
  const tmp = `${snapshotPath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(snapshot, null, 2), "utf8");
  await fs.rename(tmp, snapshotPath);
}

export async function readSnapshot(snapshotPath) {
  return JSON.parse(await fs.readFile(snapshotPath, "utf8"));
}
