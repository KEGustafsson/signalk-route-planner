import type { LonLat } from "../foundation/geo";
import { haversine } from "../foundation/geo";
import type { PlanningApiV1, Reply, Status } from "../oracle/contract";
import type { Part } from "./stages";

/**
 * The proof (plan §4.1 step 5): signalk-underkeel's route check of each part of the route,
 * at the part's own corridor and from the time the boat reaches it. Leg statuses are the
 * route check's (invariant 1); the planner only numbers the legs through and names their part.
 */

export interface ProofInput {
  departure: number;
  speed: number;
  probability?: number;
  draft?: number;
}

export interface CheckedLeg {
  index: number;
  status: Status;
  length: number;
  risk: number;
  flags: string[];
  /** The part the leg belongs to, and the corridor it was checked at. */
  part: "harbour" | "route";
  xteLimit?: number;
  /** True for a berth leg: alongside a quay or pier, inside even the harbour corridor. */
  berth?: true;
}

export interface Proof {
  legs: CheckedLeg[];
  parts: {
    part: "harbour" | "route";
    end?: "start" | "end";
    xteLimit?: number;
    legs: [number, number];
  }[];
  /** The route check's own reply for the first part, without its legs (e.g. `checkedAt`). */
  first: Record<string, unknown>;
}

const same = (a: LonLat | undefined, b: LonLat | undefined): boolean =>
  a !== undefined && b !== undefined && a[0] === b[0] && a[1] === b[1];

const pathLength = (c: readonly LonLat[]): number =>
  c.slice(1).reduce((s, p, i) => s + haversine(c[i] as LonLat, p), 0);

/** Whether leg i of `part` is its berth leg: from the end point to the berth point, or back. */
function isBerth(part: Part, i: number): boolean {
  const c = part.coordinates;
  return part.end === "start"
    ? i === 0 && same(c[1], part.berth)
    : i === c.length - 2 && same(c[i], part.berth);
}

function checkBody(input: ProofInput, part: Part, departure: number): unknown {
  return {
    route: { type: "LineString", coordinates: part.coordinates },
    departure: new Date(departure).toISOString(),
    speed: input.speed,
    ...(part.xteLimit !== undefined && { xteLimit: part.xteLimit }),
    ...(input.probability !== undefined && { probability: input.probability }),
    ...(input.draft !== undefined && { vessel: { draft: input.draft } })
  };
}

/** Each part's route check in order, or the first reply that is not 200. */
export async function prove(
  api: PlanningApiV1,
  input: ProofInput,
  parts: readonly Part[],
  signal: AbortSignal
): Promise<Proof | Reply> {
  const legs: CheckedLeg[] = [];
  const spans: Proof["parts"] = [];
  let first: Record<string, unknown> | undefined;
  let at = input.departure;
  for (const part of parts) {
    const r = await api.routeCheck(checkBody(input, part, at), signal);
    if (r.status !== 200) {
      return r;
    }
    const { legs: own, ...rest } = r.body as { legs: Omit<CheckedLeg, "part">[] };
    first ??= rest;
    const from = legs.length;
    own.forEach((l, i) => {
      legs.push({
        ...l,
        index: legs.length,
        part: part.kind,
        ...(part.xteLimit !== undefined && { xteLimit: part.xteLimit }),
        ...(isBerth(part, i) && { berth: true as const })
      });
    });
    spans.push({
      part: part.kind,
      ...(part.end && { end: part.end }),
      ...(part.xteLimit !== undefined && { xteLimit: part.xteLimit }),
      legs: [from, legs.length - 1]
    });
    at += (pathLength(part.coordinates) / input.speed) * 1000;
  }
  return { legs, parts: spans, first: first ?? {} };
}

/** The parts' coordinates as one line, each handover point once. */
export function joined(parts: readonly Part[]): LonLat[] {
  const out: LonLat[] = [];
  for (const p of parts) {
    for (const c of p.coordinates) {
      if (!same(out[out.length - 1], c)) {
        out.push(c);
      }
    }
  }
  return out;
}
