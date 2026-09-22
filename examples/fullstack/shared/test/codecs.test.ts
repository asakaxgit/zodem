import { describe, expect, it } from "vitest";
import { toBinary, fromBinary } from "@bufbuild/protobuf";
import { asInit, createFrom } from "@zodem/codec";
import type { z } from "zod";
import { codecs } from "../src/codecs.js";
import { CreateUserRequest as ZodCreateUserRequest } from "../src/schemas/user.js";
import { CreateUserRequestSchema } from "../src/gen/acme/user/v1/user_pb.js";

describe("shared codecs: real wire round-trip", () => {
  it("Zod value -> codec -> protobuf-es create() -> real binary wire bytes -> back", () => {
    const zodValue: z.infer<typeof ZodCreateUserRequest> = {
      email: "amy@example.com",
      displayName: "Amy",
      age: 34,
      role: "admin",
      nickname: null,
      address: { city: "Tokyo", country: "JP" },
    };

    // this is exactly what a Connect server handler would do with a validated request
    const parsed = ZodCreateUserRequest.parse(zodValue);
    const codec = codecs.get("acme.user.v1.CreateUserRequest")!;
    const initObject = codec.encode(parsed);

    const protoMessage = createFrom(CreateUserRequestSchema, initObject);
    expect(protoMessage.email).toBe("amy@example.com");
    expect(protoMessage.age).toBe(34);
    expect(protoMessage.nickname).toBeUndefined(); // null collapsed to "not set"
    expect(protoMessage.address).toMatchObject({ city: "Tokyo", country: "JP" });

    // round-trip through actual wire bytes, not just the JS object
    const bytes = toBinary(CreateUserRequestSchema, protoMessage);
    const decodedProto = fromBinary(CreateUserRequestSchema, bytes);

    const decoded = codec.decode(decodedProto);
    expect(decoded).toEqual(parsed);
    expect(() => ZodCreateUserRequest.parse(decoded)).not.toThrow();
  });

  it("a non-null nickname survives the full round-trip", () => {
    const zodValue = {
      email: "bo@example.com",
      displayName: "Bo",
      age: 20,
      role: "member" as const,
      nickname: "Bobby",
      address: { city: "Osaka", country: "JP" },
    };
    const codec = codecs.get("acme.user.v1.CreateUserRequest")!;
    const proto = createFrom(CreateUserRequestSchema, codec.encode(zodValue));
    expect(proto.nickname).toBe("Bobby");
    expect(proto.role).toBe(2); // ROLE_MEMBER

    const bytes = toBinary(CreateUserRequestSchema, proto);
    const back = codec.decode(fromBinary(CreateUserRequestSchema, bytes));
    expect(back).toEqual(zodValue);
  });
});

describe("asInit: validates every key against the real generated schema", () => {
  it("accepts every real field name, including a nested message field", () => {
    expect(() =>
      asInit(CreateUserRequestSchema, {
        email: "amy@example.com",
        displayName: "Amy",
        age: 34,
        role: 1,
        address: { city: "Tokyo", country: "JP" },
      }),
    ).not.toThrow();
  });

  it("rejects a key that isn't a field of the schema", () => {
    expect(() => asInit(CreateUserRequestSchema, { email: "amy@example.com", bogus: "nope" })).toThrow(
      /"bogus" is not a field of "acme\.user\.v1\.CreateUserRequest"/u,
    );
  });
});
