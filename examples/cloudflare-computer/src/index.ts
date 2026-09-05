import { Workspace, type DurableObjectStorageLike } from "@cloudflare/computer";
import { DurableObject } from "cloudflare:workers";
import { createSandbox } from "@sandbox-workers/core";

interface Env {
  COMPUTERS: DurableObjectNamespace<SandboxComputer>;
  JAVASCRIPT: Fetcher;
  PYTHON: Fetcher;
  PERL: Fetcher;
  RUBY: Fetcher;
}

const programs = {
  javascript:
    "const items = JSON.parse(process.env.ITEMS); ({total: items.reduce((sum, item) => sum + item.price * item.quantity, 0), count: items.length});",
  python:
    "import json, os\nitems = json.loads(os.environ['ITEMS'])\n{'total': sum(item['price'] * item['quantity'] for item in items), 'count': len(items)}",
  perl: "use JSON::PP; my $items = JSON::PP::decode_json($ENV{ITEMS}); my $total = 0; for my $item (@$items) { $total += $item->{price} * $item->{quantity}; } +{total => $total, count => scalar @$items};",
  ruby: "require 'json'\nitems = JSON.parse(ENV['ITEMS'])\n{'total' => items.sum { |item| item['price'] * item['quantity'] }, 'count' => items.length}",
} as const;
type Language = keyof typeof programs;
const input = {
  items: [
    { name: "Tea", price: 500, quantity: 2 },
    { name: "Coffee", price: 800, quantity: 3 },
  ],
};

export class SandboxComputer extends DurableObject<Env> {
  // Computer 0.2.1 uses a broader SQL row generic than workers-types.
  // Both describe the same native Durable Object SQLite storage API.
  private workspace = new Workspace({
    storage: this.ctx.storage as unknown as DurableObjectStorageLike,
  });

  async fetch(request: Request): Promise<Response> {
    const language = new URL(request.url).searchParams.get(
      "language",
    ) as Language;
    if (!Object.hasOwn(programs, language))
      return new Response("Unsupported language", { status: 400 });
    // A fixed workspace per language keeps this public demo's storage bounded.
    // Serialize each read/execute/write cycle so concurrent requests cannot mix files.
    return this.ctx.blockConcurrencyWhile(async () => {
      const fs = this.workspace.fs;
      await fs.writeFile("/input.json", JSON.stringify(input));
      await fs.writeFile("/program.txt", programs[language]);
      const bindings = {
        javascript: this.env.JAVASCRIPT,
        python: this.env.PYTHON,
        perl: this.env.PERL,
        ruby: this.env.RUBY,
      };
      const { items } = JSON.parse(await fs.readFile("/input.json", "utf8"));
      const execution = await createSandbox(
        bindings[language],
      ).runCode(await fs.readFile("/program.txt", "utf8"), {
        envVars: { ITEMS: JSON.stringify(items) },
      });
      await fs.writeFile("/result.json", JSON.stringify(execution));
      return Response.json({
        language,
        input: JSON.parse(await fs.readFile("/input.json", "utf8")),
        execution: JSON.parse(await fs.readFile("/result.json", "utf8")),
        files: ["/input.json", "/program.txt", "/result.json"],
      });
    });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/" && request.method === "GET") {
      return Response.json({
        name: "sandbox-workers + Cloudflare Computer",
        usage: "POST /demo?language=python (javascript, python, perl, ruby)",
        expected: { total: 3400, count: 2 },
        description:
          "Read code and JSON from Computer's SQLite filesystem, execute through a private Service Binding, and persist the result.",
      });
    }
    if (url.pathname !== "/demo")
      return new Response("Not found", { status: 404 });
    if (request.method !== "POST")
      return new Response("Use POST", {
        status: 405,
        headers: { Allow: "POST" },
      });
    const language = url.searchParams.get("language") ?? "python";
    if (!Object.hasOwn(programs, language))
      return new Response("Unsupported language", { status: 400 });
    url.searchParams.set("language", language);
    const stub = env.COMPUTERS.get(
      env.COMPUTERS.idFromName(`demo-${language}`),
    );
    return stub.fetch(new Request(url, { method: "POST" }));
  },
} satisfies ExportedHandler<Env>;
