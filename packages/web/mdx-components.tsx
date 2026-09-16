import type { MDXComponents } from "mdx/types";
import { getMDXComponents } from "@/components/docs/mdx";

export function useMDXComponents(components?: MDXComponents): MDXComponents {
  return getMDXComponents(components);
}
