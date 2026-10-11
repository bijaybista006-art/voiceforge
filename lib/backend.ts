/**
 * The one error type the browser's generation queue depends on.
 *
 * Speech goes through lib/gateway.ts, because the backend secret must never
 * reach a browser and the active backend can change between two chunks. What
 * the queue needs from a failure is whether it was the network (pause and
 * retry) or the API (stop retrying), which is all this carries.
 */

export class BackendError extends Error {
  kind: "network" | "api";
  status?: number;

  constructor(message: string, kind: "network" | "api", status?: number) {
    super(message);
    this.name = "BackendError";
    this.kind = kind;
    this.status = status;
  }
}
