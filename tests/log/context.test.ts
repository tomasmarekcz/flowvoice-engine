import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import {
  bindToCurrentContext, createLogContext, getLogContext, runWithLogContext, setLogContext,
} from "../../src/log/context";

describe("log context", () => {
  it("is empty outside a context and set/get work inside one", () => {
    expect(getLogContext()).toEqual({});
    runWithLogContext({ project_id: "p1" }, () => {
      setLogContext({ call_id: "c1" });
      expect(getLogContext()).toEqual({ project_id: "p1", call_id: "c1" });
    });
    expect(getLogContext()).toEqual({});
  });

  it("setLogContext outside a context is a no-op", () => {
    setLogContext({ call_id: "x" });
    expect(getLogContext()).toEqual({});
  });

  it("EventEmitter listeners keep the context they were bound in", () => {
    const em = new EventEmitter();
    const seen: (string | null | undefined)[] = [];
    runWithLogContext({ call_id: "c1" }, () => {
      em.on("x", bindToCurrentContext(() => { seen.push(getLogContext().call_id); }));
    });
    em.emit("x");
    expect(seen).toEqual(["c1"]);
  });

  it("createLogContext shares one store across bound listeners", () => {
    const ctx = createLogContext({ request_id: "r1" });
    const em = new EventEmitter();
    const seen: (string | null | undefined)[] = [];
    em.on("a", ctx.bind(() => { setLogContext({ call_id: "c9" }); }));
    em.on("b", ctx.bind(() => { seen.push(getLogContext().call_id); }));
    em.emit("a");
    em.emit("b");
    expect(seen).toEqual(["c9"]);
  });
});
