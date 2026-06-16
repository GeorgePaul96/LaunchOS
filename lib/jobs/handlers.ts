// Job handler registrations (side-effect import). Importing this module registers handlers.
import { registerJob } from "./registry";
import { publishPost } from "@/lib/publishing/service";

registerJob("publish_post", async (db, payload) => {
  await publishPost(db, payload.postId);
});
