import { createServer as createHttpServer } from "node:http";
import { DomainError } from "./errors.js";

const STATUS_BY_CODE = {
  INVALID_INPUT: 400,
  NOT_FOUND: 404,
  IMPACT_SCOPE_MISMATCH: 409,
  ALREADY_RESOLVED: 409,
  NOT_RESOLVED: 409,
  HAZARD_MERGED: 409,
};

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new DomainError("INVALID_INPUT", "请求体过大");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new DomainError("INVALID_INPUT", "请求体不是合法 JSON");
  }
}

/**
 * 值班台业务入口（薄 HTTP 适配层，规则全部在 HazardService）。
 * createServer(service) -> http.Server
 */
export function createServer(service) {
  const routes = [
    ["GET", "/health", async () => ({ body: { ok: true } })],
    [
      "GET",
      "/view",
      async () => ({
        body: {
          grids: service.grids.length,
          reports: service.reports.size,
          open: service.listOpen(),
        },
      }),
    ],
    [
      "POST",
      "/reports",
      async (req) => {
        const result = service.addReport(await readJsonBody(req));
        return { status: result.deduplicated ? 200 : 201, body: result };
      },
    ],
    [
      "GET",
      "/nearby",
      async (_req, url) => ({
        body: {
          clues: service.findNearby({
            longitude: url.searchParams.get("longitude") ?? url.searchParams.get("lng"),
            latitude: url.searchParams.get("latitude") ?? url.searchParams.get("lat"),
            radiusMeters:
              url.searchParams.get("radiusMeters") ?? url.searchParams.get("radius") ?? 200,
            includeResolved: url.searchParams.get("includeResolved") === "true",
          }),
        },
      }),
    ],
    [
      "GET",
      "/hazards/:id",
      async (_req, _url, { id }) => ({ body: service.getHazard(id) }),
    ],
    [
      "POST",
      "/hazards/:id/merge",
      async (req, _url, { id }) => {
        const body = await readJsonBody(req);
        return { body: service.mergeHazards(id, body.secondaryId, body) };
      },
    ],
    [
      "POST",
      "/hazards/:id/observations",
      async (req, _url, { id }) => ({
        body: service.recordObservation(id, await readJsonBody(req)),
      }),
    ],
    [
      "POST",
      "/hazards/:id/adjust-danger",
      async (req, _url, { id }) => {
        const body = await readJsonBody(req);
        return { body: service.adjustDangerLevel(id, body.level, body) };
      },
    ],
    [
      "POST",
      "/hazards/:id/transfer",
      async (req, _url, { id }) => ({
        body: service.transferHazard(id, await readJsonBody(req)),
      }),
    ],
    [
      "POST",
      "/hazards/:id/resolve",
      async (req, _url, { id }) => ({
        body: service.resolveHazard(id, await readJsonBody(req)),
      }),
    ],
    [
      "POST",
      "/hazards/:id/callback",
      async (req, _url, { id }) => ({
        body: service.recordCallback(id, await readJsonBody(req)),
      }),
    ],
    [
      "POST",
      "/snapshot",
      async (req) => {
        const body = await readJsonBody(req);
        if (typeof body.path !== "string" || body.path === "") {
          throw new DomainError("INVALID_INPUT", "缺少快照路径 path");
        }
        await service.saveToFile(body.path);
        return { body: { saved: body.path } };
      },
    ],
  ];

  return createHttpServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const segments = url.pathname.split("/").filter(Boolean);
    try {
      for (const [method, pattern, handler] of routes) {
        const patternSegments = pattern.split("/").filter(Boolean);
        if (method !== req.method || patternSegments.length !== segments.length) continue;
        const params = {};
        const matched = patternSegments.every((seg, i) => {
          if (seg.startsWith(":")) {
            params[seg.slice(1)] = decodeURIComponent(segments[i]);
            return true;
          }
          return seg === segments[i];
        });
        if (!matched) continue;
        const { status = 200, body } = await handler(req, url, params);
        res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(body));
        return;
      }
      res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "路由不存在" } }));
    } catch (error) {
      const isDomain = error instanceof DomainError;
      const status = isDomain ? (STATUS_BY_CODE[error.code] ?? 400) : 500;
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          error: { code: isDomain ? error.code : "INTERNAL", message: error.message },
        }),
      );
    }
  });
}
