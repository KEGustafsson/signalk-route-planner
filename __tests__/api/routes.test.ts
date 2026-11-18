import { EventEmitter } from "events";
import { PassThrough } from "stream";
import type { Request, RequestHandler, Response } from "express";
import { PLANNING_API } from "../../src/oracle/contract";
import { MAX_BODY_BYTES, readJsonBody, registerRoutes } from "../../src/api/routes";
import { apiFor } from "../../src/plugin-api";
import { at, syntheticApi } from "../helpers/synthetic-oracle";

/** The REST routes with a fake router and a fake planning API (AGENTS.md Validation). */

const g = globalThis as unknown as Record<symbol, unknown>;
const NOW = Date.parse("2026-11-18T07:00:00Z");

function fakeRouter() {
  const routes = new Map<string, RequestHandler>();
  const levels: string[] = [];
  const registrar = {
    get: (p: string, h: RequestHandler) => routes.set(`GET ${p}`, h),
    post: (p: string, h: RequestHandler) => routes.set(`POST ${p}`, h)
  };
  const router = {
    ...registrar,
    access: (level: string) => {
      levels.push(level);
      return registrar;
    }
  };
  const call = (method: string, path: string, body?: unknown) =>
    new Promise<{ code: number; body: unknown }>((resolve) => {
      const res = new EventEmitter() as unknown as Response & { code: number };
      Object.assign(res, {
        setHeader: () => undefined,
        status(code: number) {
          (res as { code: number }).code = code;
          return res;
        },
        json(b: unknown) {
          resolve({ code: (res as { code: number }).code ?? 200, body: b });
          return res;
        }
      });
      const req = { body, readableEnded: true, headers: {} } as unknown as Request;
      const h = routes.get(`${method} ${path}`) as RequestHandler;
      void h(req, res, () => undefined);
    });
  return { router, call, levels };
}

describe("REST routes", () => {
  afterEach(() => {
    delete g[PLANNING_API];
  });

  function mount(running: AbortSignal | undefined = new AbortController().signal) {
    const f = fakeRouter();
    registerRoutes(
      f.router,
      apiFor({ now: () => NOW }, () => running),
      () => undefined
    );
    return f;
  }

  test("routes are open to readonly users", () => {
    expect(mount().levels).toEqual(["readonly"]);
  });

  test("without signalk-underkeel: status off and /plan 503, both with the reason", async () => {
    const f = mount();
    expect((await f.call("GET", "/v1/status")).body).toMatchObject({
      state: "off",
      reason: expect.stringMatching(/signalk-underkeel/)
    });
    const r = await f.call("POST", "/v1/plan", { from: at(0, 0), to: at(5000, 0) });
    expect(r.code).toBe(503);
    expect(JSON.stringify(r.body)).toMatch(/signalk-underkeel 0.7.0 or later is not running/);
  });

  test("an index not ready: /plan 503 with underkeel's reason", async () => {
    g[PLANNING_API] = syntheticApi(
      { obstacles: [] },
      { unavailable: () => "building the chart box" }
    );
    const r = await mount().call("POST", "/v1/plan", { from: at(0, 0), to: at(5000, 0) });
    expect(r).toEqual({ code: 503, body: { errors: ["building the chart box"] } });
  });

  test("a plan around an island, at underkeel's default speed", async () => {
    const api = syntheticApi({ obstacles: [{ x: 2500, y: 0, r: 600 }] });
    g[PLANNING_API] = api;
    const f = mount();
    expect((await f.call("GET", "/v1/status")).body).toEqual({
      state: "ready",
      provider: "synthetic"
    });
    const r = await f.call("POST", "/v1/plan", { from: at(0, 0), to: at(5000, 0) });
    expect(r.code).toBe(200);
    expect(r.body).toMatchObject({ status: "ok", direct: { status: "fail" } });
    expect(api.sessions[0]).toMatchObject({ departure: NOW, speed: 3 });
  });

  test("a bad body is 400; a stopped plugin is 503", async () => {
    g[PLANNING_API] = syntheticApi({ obstacles: [] });
    expect((await mount().call("POST", "/v1/plan", { from: "x" })).code).toBe(400);
    const stopped = fakeRouter();
    registerRoutes(
      stopped.router,
      apiFor({ now: () => NOW }, () => undefined),
      () => undefined
    );
    expect(await stopped.call("POST", "/v1/plan", { from: at(0, 0), to: at(5000, 0) })).toEqual({
      code: 503,
      body: { errors: ["plugin not started"] }
    });
  });

  test("an oversize streamed body is refused without closing the socket", async () => {
    const req = new PassThrough();
    const read = readJsonBody(req as unknown as Request);
    req.write(Buffer.alloc(MAX_BODY_BYTES + 1, 32));
    req.end(Buffer.from("{}"));
    await expect(read).rejects.toThrow("request body too large");
    expect(req.destroyed).toBe(false);
  });

  test("a streamed body within the cap is parsed", async () => {
    const req = new PassThrough();
    const read = readJsonBody(req as unknown as Request);
    req.end(Buffer.from('{"a":1}'));
    await expect(read).resolves.toEqual({ a: 1 });
  });
});
