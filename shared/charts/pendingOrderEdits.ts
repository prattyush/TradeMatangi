import { useSyncExternalStore } from "react";
interface EditableOrder {
  order_id: string;
  session_id: string;
  user_id: string;
  order_type: string;
  limit_price: number;
  trigger_price: number;
  broker_order_id?: string | null;
  kotak_order_id?: string | null;
}
export interface PendingLineEdit {
  orderId: string;
  sessionId: string;
  oldPrice: number;
  requestedPrice: number;
  brokerId: string;
  field: "limit_price" | "trigger_price";
  reportedPrice?: number;
  phase: "sending" | "unconfirmed";
  message: string;
}
export interface BrokerLineReport {
  kotak_order_id?: string;
  broker_order_id?: string;
  status: string;
  limit_price: number;
  trigger_price: number;
}
export class PendingOrderEdits {
  private entries = new Map<string, PendingLineEdit>();
  private listeners = new Set<() => void>();
  private revision = 0;
  private scope = "";
  private clocks = new Map<
    string,
    { generation: string; version: number; retired: Set<string> }
  >();
  private key(sessionId: string, orderId: string) {
    return `${sessionId}:${orderId}`;
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.revision;
  private changed() {
    this.revision++;
    this.listeners.forEach((fn) => fn());
  }
  get(sessionId: string, orderId: string) {
    return this.entries.get(this.key(sessionId, orderId));
  }
  begin(order: EditableOrder, price: number) {
    if (this.get(order.session_id, order.order_id))
      throw new Error(
        "This order has an unconfirmed modification. Refresh Trade History first.",
      );
    const brokerId = order.broker_order_id ?? order.kotak_order_id;
    if (!brokerId) return;
    const field =
      order.order_type === "LIMIT" || order.order_type === "TARGET"
        ? "limit_price"
        : "trigger_price";
    this.entries.set(this.key(order.session_id, order.order_id), {
      orderId: order.order_id,
      sessionId: order.session_id,
      oldPrice: order[field] > 0 ? order[field] : order.trigger_price,
      requestedPrice: price,
      brokerId,
      field,
      phase: "sending",
      message: "Sending modification",
    });
    this.changed();
  }
  acknowledged(sessionId: string, orderId: string, updated?: EditableOrder) {
    const e = this.get(sessionId, orderId);
    if (e) {
      e.phase = "unconfirmed";
      e.message = "Awaiting broker confirmation — refresh Trade History";
      if (updated) {
        e.brokerId =
          updated.broker_order_id ?? updated.kotak_order_id ?? e.brokerId;
        if (updated[e.field] > 0) e.requestedPrice = updated[e.field];
      }
      this.changed();
    }
  }
  failed(sessionId: string, orderId: string, definitive: boolean) {
    const key = this.key(sessionId, orderId),
      e = this.entries.get(key);
    if (!e) return;
    if (definitive) this.entries.delete(key);
    else {
      e.phase = "unconfirmed";
      e.message =
        "Outcome unconfirmed — refresh Trade History before editing again";
    }
    this.changed();
  }
  reconcile(
    sessionId: string,
    reports: BrokerLineReport[],
    evidence?: {
      state_version?: number | null;
      state_generation?: string | null;
    },
  ) {
    if (
      evidence?.state_generation &&
      typeof evidence.state_version === "number"
    ) {
      const clock = this.clocks.get(sessionId);
      if (clock?.retired.has(evidence.state_generation)) return;
      if (
        clock?.generation === evidence.state_generation &&
        evidence.state_version <= clock.version
      )
        return;
      const retired = clock?.retired ?? new Set<string>();
      if (clock && clock.generation !== evidence.state_generation)
        retired.add(clock.generation);
      this.clocks.set(sessionId, {
        generation: evidence.state_generation,
        version: evidence.state_version,
        retired,
      });
    }
    let changed = false;
    for (const [key, e] of this.entries) {
      if (e.sessionId !== sessionId || e.phase === "sending") continue;
      const report = reports.find(
        (r) => (r.broker_order_id ?? r.kotak_order_id) === e.brokerId,
      );
      if (!report) continue;
      const status = report.status.toLowerCase().replace(/[ _-]/g, "");
      if (
        [
          "complete",
          "filled",
          "cancelled",
          "canceled",
          "rejected",
          "expired",
        ].includes(status) ||
        Math.abs(report[e.field] - e.requestedPrice) < 0.000001
      ) {
        this.entries.delete(key);
        changed = true;
      } else if (Number.isFinite(report[e.field]) && report[e.field] > 0) {
        e.oldPrice = report[e.field];
        e.reportedPrice = report[e.field];
        e.message = `Broker reports ${e.oldPrice.toFixed(2)} — requested ${e.requestedPrice.toFixed(2)} unconfirmed; refresh Trade History`;
        changed = true;
      }
    }
    if (changed) this.changed();
  }
  acceptBrokerPrice(sessionId: string, orderId: string) {
    const edit = this.get(sessionId, orderId);
    if (edit?.phase === "unconfirmed" && edit.reportedPrice !== undefined)
      this.terminal(sessionId, orderId);
  }
  setScope(scope: string) {
    if (this.scope === scope) return;
    this.scope = scope;
    this.entries.clear();
    this.clocks.clear();
    this.changed();
  }
  prune(sessionId: string, orders: Array<{ order_id: string }>) {
    const active = new Set(orders.map((order) => order.order_id));
    let changed = false;
    for (const [key, edit] of this.entries)
      if (edit.sessionId === sessionId && !active.has(edit.orderId)) {
        this.entries.delete(key);
        changed = true;
      }
    if (changed) this.changed();
  }
  terminal(sessionId: string, orderId: string) {
    if (this.entries.delete(this.key(sessionId, orderId))) this.changed();
  }
}
export const pendingOrderEdits = new PendingOrderEdits();
export function usePendingOrderEdits() {
  useSyncExternalStore(pendingOrderEdits.subscribe, pendingOrderEdits.snapshot);
  return pendingOrderEdits;
}
