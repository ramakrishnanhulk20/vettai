import { createFromSource } from "fumadocs-core/search/server";
import { source } from "@/lib/source";

// A filesystem route wins over the /api/:path* rewrite to the world server, so docs
// search stays on this app and never reaches the backend.
export const { GET } = createFromSource(source, { language: "english" });
