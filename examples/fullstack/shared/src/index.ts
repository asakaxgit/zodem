// Two worlds share names here (User, UserService): the Zod schemas and the
// protoc-gen-es generated types/descriptors. Namespace them rather than
// picking a winner with `export *`.
export * as zod from "./schemas/user.js";
export * as proto from "./gen/acme/user/v1/user_pb.js";
export { codecs } from "./codecs.js";
