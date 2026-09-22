/**
 * 业务策略：承诺时限（SLA）与危险等级。
 * 全部为纯函数，可在构造 HazardService 时覆盖。
 */

export const DANGER_LEVELS = ["low", "medium", "high", "critical"];

export function dangerRank(level) {
  const rank = DANGER_LEVELS.indexOf(level);
  if (rank < 0) throw new Error(`未知危险等级: ${level}`);
  return rank;
}

/** 各问题类型的承诺处置时限（小时），default 为兜底。 */
export const DEFAULT_SLA_HOURS = {
  积水: 2,
  路面塌陷: 4,
  default: 24,
};

export function slaHoursFor(issue, table = DEFAULT_SLA_HOURS) {
  if (!issue) return table.default;
  if (table[issue] != null) return table[issue];
  for (const [key, hours] of Object.entries(table)) {
    if (key !== "default" && issue.includes(key)) return hours;
  }
  return table.default;
}

/** 按问题类型给出初始危险等级。 */
export function baseDangerFor(issue = "") {
  if (issue.includes("塌陷")) return "high";
  if (issue.includes("积水")) return "medium";
  return "low";
}

/** 水位观测（厘米）对应的危险等级。 */
export function dangerForWaterDepth(depthCm) {
  if (depthCm >= 30) return "critical";
  if (depthCm >= 15) return "high";
  if (depthCm >= 5) return "medium";
  return "low";
}

/** 现场照片研判结论对应的危险等级。 */
export function dangerForPhotoSeverity(severity) {
  const table = { minor: "medium", moderate: "high", severe: "critical" };
  return table[severity] ?? null;
}
