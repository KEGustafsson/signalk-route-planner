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
  airHeight?: number;
}

/** Stands in for the flags of a leg that is not `ok` but came without any: closed water. */
export const FLAGS_MISSING = "FLAGS_MISSING";

export interface CheckedLeg {
  index: number;
  status: Status;
  length: number;
  risk: number;
  flags: string[];
  /** The part the leg belongs to, and the corridor it was checked at. */
  part: "harbour" | "route" | "narrows";
  xteLimit?: number;
  /** True for a berth leg: alongside a quay or pier, inside even the harbour corridor. */
  berth?: true;
}

export interface Proof {
  legs: CheckedLeg[];
  parts: {
    part: "harbour" | "route" | "narrows";
    end?: "start" | "end";
    xteLimit?: number;
    legs: [number, number];
  }[];
  /** The route check's own reply for the first part, without its legs (e.g. `checkedAt`). */
  first: Record<string, unknown>;
  /** When the boat reaches the end, epoch ms: the departure, the waits and the sailing time. */
  arrival: number;
}

/** The same point: within 1e-9° (0.1 mm), well under any chart's precision. */
export const same = (a: LonLat | undefined, b: LonLat | undefined): boolean =>
  a !== undefined &&
  b !== undefined &&
  Math.abs(a[0] - b[0]) < 1e-9 &&
  Math.abs(a[1] - b[1]) < 1e-9;

const pathLength = (c: readonly LonLat[]): number =>
  c.slice(1).reduce((s, p, i) => s + haversine(c[i] as LonLat, p), 0);

/** Whether leg i of `part` is its berth leg: from the end point to the berth point, or back. */
/** True when leg `i` of `part` is its berth leg, from or to the end point. */
export function isBerth(part: Part, i: number): boolean {
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
    ...(part.pilotage && { pilotage: true }),
    ...(input.probability !== undefined && { probability: input.probability }),
    ...((input.draft !== undefined || input.airHeight !== undefined) && {
      vessel: {
        ...(input.draft !== undefined && { draft: input.draft }),
        ...(input.airHeight !== undefined && { airHeight: input.airHeight })
      }
    })
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
    at += part.wait ?? 0;
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
        // Every flag rule reads the flags. An `ok` leg sent without them has none; any other
        // leg without them has restrictions the reply does not name, so it is never crossable.
        flags: l.flags ?? (l.status === "ok" ? [] : [FLAGS_MISSING]),
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
  return { legs, parts: spans, first: first ?? {}, arrival: at };
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

/** The berth legs of a proved route, as the reply lists them: at which end, and how long. */
export function berthsOf(
  legs: readonly CheckedLeg[]
): { end: "start" | "end"; leg: number; length: number }[] {
  return legs
    .filter((l) => l.berth)
    .map((l) => ({ end: l.index === 0 ? "start" : "end", leg: l.index, length: l.length }));
}
