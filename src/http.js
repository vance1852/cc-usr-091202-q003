// HTTP 入口：值班员通过 JSON API 接单、判定、补证据、转派与回访。
// 所有写操作实时追加到事件日志；进程重启后自动重放恢复。

import { createServer } from "node:http";
import { AppError } from "./model/errors.js";

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_048_576) {
        reject(new AppError("PAYLOAD_TOO_LARGE", "请求体超过 1MB", 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new AppError("INVALID_JSON", "请求体不是合法 JSON", 400));
      }
    });
    req.on("error", reject);
  });

export function createHttpServer(service) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (req.method === "GET" && path === "/health") {
        return json(res, 200, { ok: true });
      }

      // 按坐标查询附近线索、当前责任班组与承诺时限
      if (req.method === "GET" && path === "/nearby") {
        const lng = url.searchParams.get("lng");
        const lat = url.searchParams.get("lat");
        const radius = Number(url.searchParams.get("radius") ?? 50);
        return json(res, 200, service.nearby(lng, lat, radius));
      }

      if (req.method === "GET" && path === "/incidents") {
        return json(res, 200, { incidents: service.listIncidents() });
      }

      if (req.method === "GET" && path === "/reports") {
        return json(res, 200, { reports: service.listReports() });
      }

      let m;
      if (req.method === "GET" && (m = path.match(/^\/incidents\/([^/]+)$/))) {
        const incident = service.getIncident(decodeURIComponent(m[1]));
        if (!incident) throw new AppError("NOT_FOUND", "隐患不存在", 404);
        return json(res, 200, incident);
      }

      if (req.method === "GET" && (m = path.match(/^\/reports\/([^/]+)$/))) {
        const report = service.listReports().find((r) => r.reportId === decodeURIComponent(m[1]));
        if (!report) throw new AppError("NOT_FOUND", "上报记录不存在", 404);
        return json(res, 200, report);
      }

      // 接收上报（含热线/网格/巡查来源）
      if (req.method === "POST" && path === "/reports") {
        const body = await readBody(req);
        return json(res, 201, service.receiveReport(body));
      }

      // 值班员人工判定：same 并入 / separate 另立
      if (req.method === "POST" && (m = path.match(/^\/reports\/([^/]+)\/decision$/))) {
        const body = await readBody(req);
        return json(res, 200, service.decideReport(decodeURIComponent(m[1]), body.decision, body));
      }

      if (req.method === "POST" && (m = path.match(/^\/incidents\/([^/]+)\/evidence$/))) {
        const body = await readBody(req);
        const { evidence, ...params } = body;
        return json(res, 200, service.addEvidence(decodeURIComponent(m[1]), evidence, params));
      }

      if (req.method === "POST" && (m = path.match(/^\/incidents\/([^/]+)\/escalate$/))) {
        const body = await readBody(req);
        return json(res, 200, service.escalate(decodeURIComponent(m[1]), body.to, body.reason, body));
      }

      if (req.method === "POST" && (m = path.match(/^\/incidents\/([^/]+)\/transfer$/))) {
        const body = await readBody(req);
        return json(res, 200, service.transfer(decodeURIComponent(m[1]), body));
      }

      if (req.method === "POST" && (m = path.match(/^\/incidents\/([^/]+)\/resolve$/))) {
        const body = await readBody(req);
        return json(res, 200, service.resolve(decodeURIComponent(m[1]), body));
      }

      if (req.method === "POST" && (m = path.match(/^\/incidents\/([^/]+)\/revisit$/))) {
        const body = await readBody(req);
        return json(res, 200, service.revisit(decodeURIComponent(m[1]), body));
      }

      // 移交快照：新进程凭事件日志即可原样恢复
      if (req.method === "GET" && path === "/snapshot") {
        return json(res, 200, service.snapshot());
      }

      return json(res, 404, { error: { code: "NOT_FOUND", message: "未知接口" } });
    } catch (err) {
      if (err instanceof AppError) {
        return json(res, err.status, { error: { code: err.code, message: err.message, details: err.details } });
      }
      return json(res, 500, { error: { code: "INTERNAL", message: err.message } });
    }
  });
}
