import { defineConfig } from "blume";

export default defineConfig({
  title: "sandbox-workers",
  description:
    "Self-hosted code sandboxes on Cloudflare Workers for JavaScript, Python, Perl, and Ruby.",
  logo: { text: "sandbox-workers", href: "/docs/" },
  basePath: "/docs",
  content: { root: "content" },
  theme: { accent: "teal", radius: "md", mode: "system" },
  navigation: {
    actions: [{ label: "Playground", href: "/docs/../" }],
    repo: "https://github.com/syumai/sandbox-workers",
    sidebar: { display: "flat" },
  },
  github: {
    owner: "syumai",
    repo: "sandbox-workers",
    branch: "main",
    dir: "website",
  },
  search: { provider: "orama" },
  ai: { llmsTxt: true },
  feedback: false,
  deployment: {
    output: "static",
    ...(process.env.DOCS_SITE_URL ? { site: process.env.DOCS_SITE_URL } : {}),
  },
});
