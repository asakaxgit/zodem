import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { zodem, resetRegistry, walkRegistry, syncMessage, syncEnum, type IRMessage } from "@zodem/core";
import { loadLock } from "@zodem/core/node";
import type { IRService } from "@zodem/core";
import { emitProto, outputPathFor, computeFileImports } from "../src/emit.js";

beforeEach(() => {
  resetRegistry();
});

const generate = (opts: { validate?: boolean } = {}): string => {
  const walked = walkRegistry();
  const lock = loadLock("/nonexistent/zodem.lock.json"); // always empty — fine, tests don't touch fs
  const syncAll = (m: IRMessage): void => {
    syncMessage(m, lock, { allowBreaking: false });
    for (const e of m.nested.enums) syncEnum(e, lock);
    for (const nested of m.nested.messages) syncAll(nested);
  };
  for (const m of walked.messages) syncAll(m);
  return emitProto({
    package: "acme.user.v1",
    messages: walked.messages,
    services: walked.services,
    imports: walked.imports,
    validate: opts.validate,
  });
};

describe("emitProto: the handoff §4 example", () => {
  it("matches the expected shape", () => {
    zodem.message("acme.user.v1.User", {
      id: z.string().uuid(),
      email: z.string().email(),
      age: z.number().int().min(0).max(150).meta({ proto: "int32" }),
      role: z.enum(["admin", "member"]),
      nickname: z.string().optional(),
      address: z.object({ city: z.string(), country: z.string() }),
      createdAt: z.date(),
    });
    expect(generate()).toMatchSnapshot();
  });
});

describe("emitProto: discriminated union", () => {
  it("emits a oneof with sibling branch messages", () => {
    const Circle = z.object({ kind: z.literal("circle"), radius: z.number() });
    const Square = z.object({ kind: z.literal("square"), side: z.number() });
    zodem.message("acme.user.v1.Container", { shape: z.discriminatedUnion("kind", [Circle, Square]) });
    expect(generate()).toMatchSnapshot();
  });
});

describe("emitProto: nullable wrapper", () => {
  it("emits a google.protobuf.StringValue field with the wrappers import", () => {
    zodem.message("acme.user.v1.Profile", { bio: z.string().nullable() });
    const text = generate();
    expect(text).toContain('import "google/protobuf/wrappers.proto";');
    expect(text).toContain("google.protobuf.StringValue bio = 1;");
  });
});

describe("emitProto: protovalidate field options", () => {
  it("renders nothing when validate is off, even though rules were collected", () => {
    zodem.message("acme.user.v1.A", { email: z.string().email() });
    const text = generate();
    expect(text).not.toContain("buf.validate");
    expect(text).toContain("string email = 1;");
  });

  it("renders a single-rule group as `[(buf.validate.field).<group> = {...}]`", () => {
    zodem.message("acme.user.v1.A", { email: z.string().email() });
    const text = generate({ validate: true });
    expect(text).toContain("string email = 1 [(buf.validate.field).string = {email: true}];");
  });

  it("renders multiple rules in the same group as one message literal", () => {
    zodem.message("acme.user.v1.A", { name: z.string().min(1).max(100) });
    const text = generate({ validate: true });
    expect(text).toContain("string name = 1 [(buf.validate.field).string = {min_len: 1, max_len: 100}];");
  });

  it("renders repeated size rules plus nested `items`", () => {
    zodem.message("acme.user.v1.A", { tags: z.array(z.string().min(1)).min(1).max(5) });
    const text = generate({ validate: true });
    expect(text).toContain(
      "repeated string tags = 1 [(buf.validate.field).repeated = {min_items: 1, max_items: 5, items: {string: {min_len: 1}}}];",
    );
  });

  it("keeps the string rule group for a nullable field, even though the wire type is a wrapper", () => {
    zodem.message("acme.user.v1.A", { email: z.string().email().nullable() });
    const text = generate({ validate: true });
    expect(text).toContain("google.protobuf.StringValue email = 1 [(buf.validate.field).string = {email: true}];");
  });

  it("emits no options for a field with no rules, even with validate on", () => {
    zodem.message("acme.user.v1.A", { plain: z.string() });
    const text = generate({ validate: true });
    expect(text).toContain("string plain = 1;");
  });
});

describe("computeFileImports: protovalidate", () => {
  it("adds the buf/validate import only when validate is on and a field has rules", () => {
    const owner = new Map([["acme.a.v1.A", "acme.a.v1"]]);
    const withRules = msg("acme.a.v1.A", [
      { name: "email", jsonName: "email", type: { kind: "scalar", name: "string" }, label: "singular", warnings: [], rules: { group: "string", rules: { email: true } } },
    ]);
    expect(computeFileImports([withRules], [], "acme.a.v1", owner, { validate: true })).toEqual(["buf/validate/validate.proto"]);
    expect(computeFileImports([withRules], [], "acme.a.v1", owner, { validate: false })).toEqual([]);
    expect(computeFileImports([withRules], [], "acme.a.v1", owner)).toEqual([]);

    const noRules = msg("acme.a.v1.A", [
      { name: "email", jsonName: "email", type: { kind: "scalar", name: "string" }, label: "singular", warnings: [] },
    ]);
    expect(computeFileImports([noRules], [], "acme.a.v1", owner, { validate: true })).toEqual([]);
  });

  it("finds rules nested inside a nested message", () => {
    const owner = new Map([["acme.a.v1.A", "acme.a.v1"], ["acme.a.v1.A.Inner", "acme.a.v1"]]);
    const inner = msg("acme.a.v1.A.Inner", [
      { name: "email", jsonName: "email", type: { kind: "scalar", name: "string" }, label: "singular", warnings: [], rules: { group: "string", rules: { email: true } } },
    ]);
    const a = msg("acme.a.v1.A", [{ name: "inner", jsonName: "inner", type: { kind: "message", fullName: "acme.a.v1.A.Inner" }, label: "singular", warnings: [] }], [inner]);
    expect(computeFileImports([a], [], "acme.a.v1", owner, { validate: true })).toEqual(["buf/validate/validate.proto"]);
  });
});

describe("emitProto: reserved fields survive removal", () => {
  it("emits a reserved statement for a removed field", () => {
    resetRegistry();
    zodem.message("acme.user.v1.A", { x: z.string(), y: z.string() });
    const walked1 = walkRegistry();
    const lock = loadLock("/nonexistent/zodem.lock.json");
    syncMessage(walked1.messages[0]!, lock, { allowBreaking: false });

    resetRegistry();
    zodem.message("acme.user.v1.A", { x: z.string() });
    const walked2 = walkRegistry();
    syncMessage(walked2.messages[0]!, lock, { allowBreaking: false });

    const text = emitProto({ package: "acme.user.v1", messages: walked2.messages, services: [], imports: [] });
    expect(text).toContain("reserved 2;");
    expect(text).toContain('reserved "y";');
  });
});

const msg = (fullName: string, fields: IRMessage["fields"], nestedMessages: IRMessage[] = []): IRMessage => {
  return { fullName, fields, oneofs: [], nested: { messages: nestedMessages, enums: [] }, reserved: [] };
};

describe("computeFileImports", () => {
  it("adds nothing for a same-package reference", () => {
    const owner = new Map([["acme.a.v1.A", "acme.a.v1"], ["acme.a.v1.B", "acme.a.v1"]]);
    const a = msg("acme.a.v1.A", [{ name: "b", jsonName: "b", type: { kind: "message", fullName: "acme.a.v1.B" }, label: "singular", warnings: [] }]);
    expect(computeFileImports([a], [], "acme.a.v1", owner)).toEqual([]);
  });

  it("imports the other package's file for a cross-package message reference", () => {
    const owner = new Map([["acme.a.v1.A", "acme.a.v1"], ["acme.b.v1.B", "acme.b.v1"]]);
    const a = msg("acme.a.v1.A", [{ name: "b", jsonName: "b", type: { kind: "message", fullName: "acme.b.v1.B" }, label: "singular", warnings: [] }]);
    expect(computeFileImports([a], [], "acme.a.v1", owner)).toEqual(["acme/b/v1/b.proto"]);
  });

  it("adds the matching WKT import", () => {
    const owner = new Map([["acme.a.v1.A", "acme.a.v1"]]);
    const a = msg("acme.a.v1.A", [
      { name: "created_at", jsonName: "createdAt", type: { kind: "wkt", fullName: "google.protobuf.Timestamp" }, label: "singular", warnings: [] },
    ]);
    expect(computeFileImports([a], [], "acme.a.v1", owner)).toEqual(["google/protobuf/timestamp.proto"]);
  });

  it("recurses into a map value and a nested message", () => {
    const owner = new Map([["acme.a.v1.A", "acme.a.v1"], ["acme.a.v1.A.Inner", "acme.a.v1"], ["acme.b.v1.B", "acme.b.v1"]]);
    const inner = msg("acme.a.v1.A.Inner", [
      { name: "b", jsonName: "b", type: { kind: "message", fullName: "acme.b.v1.B" }, label: "singular", warnings: [] },
    ]);
    const a = msg(
      "acme.a.v1.A",
      [{ name: "byKey", jsonName: "byKey", type: { kind: "map", key: "string", value: { kind: "message", fullName: "acme.b.v1.B" } }, label: "singular", warnings: [] }],
      [inner],
    );
    expect(computeFileImports([a], [], "acme.a.v1", owner)).toEqual(["acme/b/v1/b.proto"]);
  });

  it("checks service method input/output types too", () => {
    const owner = new Map([["acme.a.v1.GetXRequest", "acme.a.v1"], ["acme.b.v1.GetXResponse", "acme.b.v1"]]);
    const svc: IRService = {
      fullName: "acme.a.v1.XService",
      methods: [{ name: "GetX", input: "acme.a.v1.GetXRequest", output: "acme.b.v1.GetXResponse", clientStreaming: false, serverStreaming: false, warnings: [] }],
    };
    expect(computeFileImports([], [svc], "acme.a.v1", owner)).toEqual(["acme/b/v1/b.proto"]);
  });
});

describe("outputPathFor", () => {
  it("drops the version segment for the filename", () => {
    expect(outputPathFor("acme.user.v1")).toBe("acme/user/v1/user.proto");
  });
  it("keeps the last segment when it isn't a version", () => {
    expect(outputPathFor("acme.user")).toBe("acme/user/user.proto");
  });
  it("handles a single-segment package", () => {
    expect(outputPathFor("acme")).toBe("acme/acme.proto");
  });
});
