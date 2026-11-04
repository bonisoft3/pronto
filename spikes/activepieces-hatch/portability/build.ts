import * as esbuild from "esbuild";
await esbuild.build({
	entryPoints: ["runner.ts", "piece.ts"],
	bundle: true,
	platform: "node",
	format: "cjs",
	outdir: "dist",
	outExtension: { ".js": ".cjs" },
});
esbuild.stop();
