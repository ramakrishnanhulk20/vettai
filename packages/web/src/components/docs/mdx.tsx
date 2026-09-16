import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import { Mermaid } from "./Mermaid";
import StartHere from "./StartHere";

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    Mermaid,
    StartHere,
    ...components,
  } satisfies MDXComponents;
}
