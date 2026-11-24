import type { Request, RequestHandler, Response } from "express";
import { publicReason } from "../foundation/public-text";
import type { Reply } from "../oracle/contract";

/** REST routes, base `/plugins/signalk-route-planner/v1` (plan §5). */

export const API_BASE = "/v1";

/** Request bodies above this size are refused before parsing. */
export const MAX_BODY_BYTES = 64 * 1024;

export interface ApiProvider {
  status(): unknown;
  /** `signal` aborts when the client goes away. */
  plan(body: unknown, signal: AbortSignal): Promise<Reply>;
  /**
   * Starts the index a plan of the same body would wait for, and answers at once (`plan/warm.ts`).
   * What it starts runs on past the request.
   */
  prepare(body: unknown): Promise<Reply>;
}

type Registrar = {
  get(path: string, ...handlers: RequestHandler[]): unknown;
  post(path: string, ...handlers: RequestHandler[]): unknown;
};

/**
 * The router Signal K hands to `registerWithRouter`. Routes registered on it
 * directly are admin-only; `access("readonly")` opens one to any logged in
 * user. Servers older than the access API only have the plain router.
 */
export interface RouterLike extends Registrar {
  access?(level: "readonly" | "readwrite"): Registrar;
}

/** A request body that is too large or not JSON: the client's fault, answered 400. */
class BodyError extends Error {}

/**
 * The parsed JSON body. Signal K runs express.json() before plugin routes for
 * `application/json`; any other type leaves the stream unread, so it is read
 * here with a size cap.
 */
export function readJsonBody(req: Request): Promise<unknown> {
  const unread = req.readableEnded === false;
  if (!unread && req.body !== undefined && typeof req.body === "object") {
    return Promise.resolve(req.body);
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      if (size > MAX_BODY_BYTES) {
        // Drained, not kept: the socket stays open for the 400.
        return;
      }
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        chunks.length = 0;
        reject(new BodyError("request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (size > MAX_BODY_BYTES) {
        return;
      }
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new BodyError("request body is not JSON"));
      }
    });
    req.on("error", reject);
  });
}

/** A 5xx reply's error reasons, with internals kept off the wire. */
function publicBody(status: number, body: unknown): unknown {
  const errors = (body as { errors?: unknown } | null)?.errors;
  if (status < 500 || !Array.isArray(errors)) {
    return body;
  }
  return {
    ...(body as object),
    errors: errors.map((e) => (typeof e === "string" ? publicReason(e) : e))
  };
}

function send(res: Response, reply: Reply): void {
  for (const [name, value] of Object.entries(reply.headers ?? {})) {
    res.setHeader(name, value);
  }
  res.status(reply.status).json(publicBody(reply.status, reply.body));
}

/** Any other failure is ours; its message may name files, so it goes to the server log. */
function fail(res: Response, err: unknown, log: (message: string) => void): void {
  if (err instanceof BodyError) {
    res.status(400).json({ errors: [err.message] });
  } else {
    log(`REST handler failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    res.status(500).json({ errors: ["internal error"] });
  }
}

/**
 * Reads, plans and an index asked for ahead of a plan are open to readonly users: a plan writes
 * nothing on the server, and the index either asks for is signalk-underkeel's own.
 */
export function registerRoutes(
  router: RouterLike,
  api: ApiProvider,
  log: (message: string) => void = console.error
): void {
  const r = router.access ? router.access("readonly") : router;
  r.get(`${API_BASE}/status`, (_req: Request, res: Response) => {
    res.json(api.status());
  });
  r.post(`${API_BASE}/plan`, (req: Request, res: Response) => {
    const client = new AbortController();
    res.on("close", () => client.abort(new Error("client disconnected")));
    readJsonBody(req)
      .then((body) => api.plan(body, client.signal))
      .then((reply) => send(res, reply))
      .catch((err: unknown) => fail(res, err, log));
  });
  r.post(`${API_BASE}/prepare`, (req: Request, res: Response) => {
    readJsonBody(req)
      .then((body) => api.prepare(body))
      .then((reply) => send(res, reply))
      .catch((err: unknown) => fail(res, err, log));
  });
}
