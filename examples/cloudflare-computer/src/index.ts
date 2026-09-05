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
    "return {total: input.items.reduce((sum, item) => sum + item.price * item.quantity, 0), count: input.items.length};",
  python:
    "return {'total': sum(item['price'] * item['quantity'] for item in input['items']), 'count': len(input['items'])}",
  perl: "my $total = 0; for my $item (@{$input->{items}}) { $total += $item->{price} * $item->{quantity}; } return {total => $total, count => scalar @{$input->{items}}};",
  ruby: "return {'total' => input['items'].sum { |item| item['price'] * item['quantity'] }, 'count' => input['items'].length}",
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
      const execution = await createSandbox(
        bindings[language],
        language,
      ).execute({
        code: await fs.readFile("/program.txt", "utf8"),
        input: JSON.parse(await fs.readFile("/input.json", "utf8")),
      });
      await fs.writeFile("/result.json", JSON.stringify(execution));
      return Response.json(
        {
          language,
          input: JSON.parse(await fs.readFile("/input.json", "utf8")),
          execution: JSON.parse(await fs.readFile("/result.json", "utf8")),
          files: ["/input.json", "/program.txt", "/result.json"],
        },
        { status: execution.ok ? 200 : 422 },
      );
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
