import { remarkMdxMermaid } from "fumadocs-core/mdx-plugins";
import { defineConfig } from "fumadocs-mdx/config";

export default defineConfig({
  mdxOptions: {
    // A ```mermaid fence becomes <Mermaid chart="..." />, so the pages stay plain
    // markdown and the diagrams still draw in the browser.
    remarkPlugins: [remarkMdxMermaid],
  },
});
