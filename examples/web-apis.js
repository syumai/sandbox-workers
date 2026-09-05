const url = new URL("https://example.com/search?q=wasm");
const bytes = new TextEncoder().encode("Hello, WebAssembly!");
const response = new Response(
  JSON.stringify({ query: url.searchParams.get("q") }),
  {
    headers: { "content-type": "application/json" },
  },
);
return { bytes: bytes.length, response: await response.json() };
