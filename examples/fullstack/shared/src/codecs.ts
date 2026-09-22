import { syncEnum, syncMessage, walkRegistry, type IRMessage, type LockFile } from "@zodem/core";
import { createCodecs } from "@zodem/codec";
import lockJson from "../zodem.lock.json" with { type: "json" };
import "./schemas/user.js"; // side effect: registers messages/services with @zodem/core

// Sync against the COMMITTED lockfile (statically imported so this module
// works in the browser too, not just Node) rather than re-deriving numbers.
// `zodem generate --check` in CI is what guarantees this lockfile is
// current; allowBreaking here just means "don't throw if it somehow isn't"
// — availability over strictness for a read path that never persists.
const walked = walkRegistry();
// Not `validateLock()`-checked here on purpose — see the comment above:
// this path prefers to keep working over throwing on a malformed lockfile.
// biome-ignore lint/nursery/noUnsafeTypeAssertion: deliberately unvalidated per the comment above; a JSON import's inferred type is already a structural guess, not a checked one.
const lock = lockJson as LockFile;

const syncAll = (msg: IRMessage): void => {
  syncMessage(msg, lock, { allowBreaking: true });
  for (const e of msg.nested.enums) syncEnum(e, lock);
  for (const nested of msg.nested.messages) syncAll(nested);
};
for (const m of walked.messages) syncAll(m);

/** codec.get("acme.user.v1.User").encode/decode, keyed by full proto message name */
export const codecs = createCodecs(walked.messages);
