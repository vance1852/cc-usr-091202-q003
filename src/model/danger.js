// 危险等级只依据可复核的客观证据计算：上报问题类型、水位读数、现场照片标签。
// 值班员的手动升级单独记录（见 service.escalate），不混入本规则。

export const LEVELS = ["low", "medium", "high", "urgent"];
export const LEVEL_RANK = Object.fromEntries(LEVELS.map((l, i) => [l, i]));

export const PHOTO_TAG_LABELS = {
  collapse: "照片显示塌陷",
  water: "照片显示积水",
  "large-area": "照片显示大面积影响",
  "traffic-blocked": "照片显示交通阻断",
};

// 水位阈值（厘米），与照片标签共同决定等级。
export const WATER_URGENT_CM = 15;
export const WATER_HIGH_CM = 5;

export function computeDanger({ issue = "", waterLevelCm = null, photoTags = [] }) {
  const tags = new Set(photoTags);
  const reasons = [];
  let level = "low";

  const raise = (next, reason) => {
    if (LEVEL_RANK[next] > LEVEL_RANK[level]) level = next;
    reasons.push(reason);
  };

  if (issue.includes("塌陷")) raise("urgent", "上报问题涉及路面塌陷");
  if (tags.has("collapse")) raise("urgent", PHOTO_TAG_LABELS.collapse);
  if (waterLevelCm != null) {
    if (waterLevelCm >= WATER_URGENT_CM) {
      raise("urgent", `水位读数 ${waterLevelCm}cm ≥ ${WATER_URGENT_CM}cm`);
    } else if (waterLevelCm >= WATER_HIGH_CM) {
      raise("high", `水位读数 ${waterLevelCm}cm ≥ ${WATER_HIGH_CM}cm`);
    } else {
      reasons.push(`水位读数 ${waterLevelCm}cm，未达升级阈值`);
    }
  }
  if (tags.has("large-area")) raise("high", PHOTO_TAG_LABELS["large-area"]);
  if (tags.has("traffic-blocked")) raise("high", PHOTO_TAG_LABELS["traffic-blocked"]);
  if (issue.includes("积水")) raise("medium", "上报问题涉及积水");
  if (tags.has("water")) raise("medium", PHOTO_TAG_LABELS.water);
  if (reasons.length === 0) reasons.push("暂无升级证据，按低等级管控");

  return { level, reasons };
}

// 隐患归类：只用于“候选相似上报”的初筛，绝不代表系统自动合并。
export function categoryOf(issue) {
  if (issue.includes("塌陷")) return "collapse";
  if (issue.includes("积水")) return "flooding";
  return issue.trim() || "unknown";
}

export function normalizeScope(scope) {
  return (scope ?? "").toString().trim().replace(/\s+/g, " ");
}
