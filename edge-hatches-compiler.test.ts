import { assertEquals, assertStringIncludes } from '@std/assert';
import { cue, emitFiles, paymentProgram } from './effects-fixtures.ts';

const hatch = `
app: capabilities: hatches: commerce: {
 kind: "container", note: "trusted provider ingress"
 edge: {
  src: "commerce/dist/edge.js", route: "/commerce"
  environment: ["PAYMENT_KEY"]
  publicAttributes: "data-commerce-mode": "live"
  email: {name: "MAIL", recipients: ["fulfillment@example.test"]}
 }
}
`;
Deno.test('edge hatch declarations preserve names, routes and target-only configuration', async () => {
 const files = await emitFiles(paymentProgram() + hatch);
 const manifest = files['.pronto/edge-hatches.json'] as unknown as {data: {name: string; edge: {environment: string[]; route: string}}[]};
 assertEquals(manifest.data[0].name, 'commerce');
 assertEquals(manifest.data[0].edge.route, '/commerce');
 assertEquals(manifest.data[0].edge.environment, ['PAYMENT_KEY']);
 const cloudflare = await emitFiles(paymentProgram().replace('targets: []', 'targets: ["cloudflare"]') + hatch);
 assertStringIncludes(cloudflare['.github/workflows/cd.yml'].text, 'PAYMENT_KEY: ${{ secrets.PAYMENT_KEY }}');
 for (const route of ['/crud', '/rtc-ice', '/commerce/nested']) {
  const result = await cue(["export", "-", "-e", "out"], paymentProgram() + hatch.replace('"/commerce"', JSON.stringify(route)));
  assertEquals(result.success, false);
 }
});

const door = `
app: capabilities: hatches: commerce: {
 kind: "container", note: "trusted provider ingress"
 door: {route: "/commerce", port: 8080, publicAttributes: "data-commerce-mode": "live"}
}
_cluster: surface: targets: commerce: {activate: "", dockerfile: {from: name: "alpine:3.22"}, compose: {}}
`;
// A container door has one mode: its service is in every launch and the tree it
// serves always carries the hatch's public attributes. Pages keeps its own.
Deno.test('door hatch routes the cluster door, joins the launch and marks the served tree', async () => {
 const files = await emitFiles(paymentProgram() + door);
 const caddy = files['docker/Caddyfile'].text;
 assertStringIncludes(caddy, '@door_commerce path /commerce /commerce/*');
 assertStringIncludes(caddy, 'reverse_proxy {$PRONTO_UPSTREAM_COMMERCE:commerce:8080} {\n      header_up dapr-app-id commerce\n      import bounded-hatch');
 assertStringIncludes(caddy, '(bounded-hatch) {');
 const facts = files['.pronto/cluster.json'] as unknown as {data: {doors?: string[]}};
 assertEquals(facts.data.doors, ['commerce']);
 const served = paymentProgram().replace('statics: []', 'statics: [{file: "shell/index.html", target: "/srv/shell/index.html"}]') + door;
 const cluster = await cue(['export', '-', '-e', '_cluster.surface.targets', '--out', 'json'], served);
 if (!cluster.success) throw new Error(cluster.stderr);
 const targets = JSON.parse(cluster.stdout);
 assertEquals(targets.commerce.compose.profiles, undefined);
 assertEquals(targets.launch.compose.depends_on.commerce, {condition: 'service_healthy'});
 assertEquals(targets.served.compose.build, undefined);
 const [run] = targets.served.dockerfile.epilogue;
 assertEquals(run.includes('COMPOSE_PROFILES'), false);
 assertStringIncludes(run, String.raw`s/([[:space:]])data-commerce-mode="[^"]*"/\1data-commerce-mode="live"/g`);
 for (const route of ['/crud', '/shell', '/commerce/nested']) {
  const result = await cue(['export', '-', '-e', 'out'], paymentProgram() + door.replace('"/commerce"', JSON.stringify(route)));
  assertEquals(result.success, false);
 }
});
