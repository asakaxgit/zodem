import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { createFrom } from "@zodem/codec";
import type { z } from "zod";
import { zod, proto, codecs } from "@example/shared";

// In-memory store. Values are Zod-shaped (the validated domain type), not
// protobuf-es messages — proto is a transport concern, not how this service
// thinks about its data.
const users = new Map<string, z.infer<typeof zod.User>>();

function zodErrorMessage(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
}

function routes(router: ConnectRouter): void {
  router.service(proto.UserService, {
    async createUser(req) {
      const requestCodec = codecs.get("acme.user.v1.CreateUserRequest")!;
      const raw = requestCodec.decode(req);
      const parsed = zod.CreateUserRequest.safeParse(raw);
      if (!parsed.success) {
        throw new ConnectError(zodErrorMessage(parsed.error), Code.InvalidArgument);
      }

      const user: z.infer<typeof zod.User> = {
        id: randomUUID(),
        createdAt: new Date(),
        ...parsed.data,
      };
      users.set(user.id, user);

      const responseCodec = codecs.get("acme.user.v1.CreateUserResponse")!;
      return createFrom(proto.CreateUserResponseSchema, responseCodec.encode({ user }));
    },

    async getUser(req) {
      const requestCodec = codecs.get("acme.user.v1.GetUserRequest")!;
      const raw = requestCodec.decode(req);
      const parsed = zod.GetUserRequest.safeParse(raw);
      if (!parsed.success) {
        throw new ConnectError(zodErrorMessage(parsed.error), Code.InvalidArgument);
      }

      const user = users.get(parsed.data.id);
      if (!user) {
        throw new ConnectError(`no user with id "${parsed.data.id}"`, Code.NotFound);
      }

      const responseCodec = codecs.get("acme.user.v1.GetUserResponse")!;
      return createFrom(proto.GetUserResponseSchema, responseCodec.encode({ user }));
    },
  });
}

const port = Number(process.env.PORT ?? 8787);
// No CORS setup needed: the web app's Vite dev server proxies /acme.user.v1.*
// to this server, so browser requests are same-origin (see web/vite.config.ts).
const server = createServer(connectNodeAdapter({ routes }));

server.listen(port, () => {
  console.log(`acme.user.v1.UserService listening on http://localhost:${port}`);
});
