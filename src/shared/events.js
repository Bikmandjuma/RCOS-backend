import { EventEmitter } from "node:events";

// In-process pub/sub so the kitchen and orders screens update instantly (PDF §34).
// Single-server only: put Redis pub/sub behind this same interface when you scale to several instances.
const bus = new EventEmitter();
bus.setMaxListeners(0);

export const publish = (tenantId, event) => bus.emit(`tenant:${tenantId}`, event);
export function subscribe(tenantId, fn) {
  bus.on(`tenant:${tenantId}`, fn);
  return () => bus.off(`tenant:${tenantId}`, fn);
}
