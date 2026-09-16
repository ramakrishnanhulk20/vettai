import type { ReactNode } from "react";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { RootProvider } from "fumadocs-ui/provider/next";
import DocsBrand from "@/components/docs/DocsBrand";
import ModalScrollLock from "@/components/docs/ModalScrollLock";
import { source } from "@/lib/source";
import "./docs.css";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <RootProvider theme={{ enabled: false }}>
      {/* The docs are night only. The class carries the dark variants without a theme
          provider writing to <html> after the server already sent it. */}
      <div className="dark docs-shell">
        <span aria-hidden className="docs-glow" />
        <ModalScrollLock />
        <DocsLayout
          tree={source.getPageTree()}
          nav={{ title: <DocsBrand />, url: "/docs", transparentMode: "none" }}
          links={[
            { text: "The landing page", url: "/", active: "none" },
            { text: "Play", url: "/play", active: "none" },
          ]}
          themeSwitch={{ enabled: false }}
          sidebar={{
            footer: (
              <p key="note" className="docs-sidebar-note">
                Built on Nimiq Pay. Testnet for now.
              </p>
            ),
          }}
        >
          {children}
        </DocsLayout>
      </div>
    </RootProvider>
  );
}
