import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { zodem, resetRegistry, walkRegistry, syncMessage, syncEnum, type IRMessage } from "@zodem/core";
import { loadLock } from "@zodem/core/node";
import { emitProto, outputPathFor } from "../src/emit.js";

beforeEach(() => {
  resetRegistry();
});

function generate(): string {
  const walked = walkRegistry();
  const lock = loadLock("/nonexistent/zodem.lock.json"); // always empty — fine, tests don't touch fs
  const syncAll = (m: IRMessage): void => {
    syncMessage(m, lock, { allowBreaking: false });
    for (const e of m.nested.enums) syncEnum(e, lock);
    for (const nested of m.nested.messages) syncAll(nested);
  };
  for (const m of walked.messages) syncAll(m);
  return emitProto({ package: "acme.user.v1", messages: walked.messages, services: walked.services, imports: walked.imports });
}

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
