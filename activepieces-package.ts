import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export interface PieceSource {
	local?: string;
	export?: string;
	npm?: { package: string; version: string; export: string };
}
export interface Declaration {
	version: 1;
	lock: string;
	pieces: Record<string, PieceSource>;
	actions: Record<string, {
		piece: string;
		action: string;
		inputSchema: string;
		outputSchema: string;
		auth?: { jsonSecret: string; schema: string };
		fixedProps: Record<string, unknown>;
		idempotencyKeyProp?: string;
	}>;
	limits: Record<string, number>;
}
const encode = (value: unknown) =>
	new TextEncoder().encode(JSON.stringify(value, null, 2) + "\n");
const name = /^[A-Za-z][A-Za-z0-9_]*$/;
const version = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

async function inside(root: string, path: string): Promise<string> {
	if (isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
		throw new Error(`Unsafe piece path: ${path}`);
	}
	const full = resolve(root, path);
	const rel = relative(root, full);
	if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		throw new Error(`Path escapes app: ${path}`);
	}
	let current = root;
	for (const component of rel.split(sep)) {
		current = resolve(current, component);
		if ((await Deno.lstat(current)).isSymlink) {
			throw new Error(`Symlink in piece closure: ${path}`);
		}
	}
	return full;
}

async function tree(
	root: string,
	base: string,
	target: string,
	files: Map<string, Uint8Array>,
): Promise<void> {
	const entries = [];
	for await (const entry of Deno.readDir(base)) entries.push(entry);
	entries.sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of entries) {
		if (["node_modules", ".git", ".bayt", ".task"].includes(entry.name)) {
			continue;
		}
		const path = await inside(root, relative(root, resolve(base, entry.name)));
		const key = `${target}/${entry.name}`;
		if (entry.isDirectory) await tree(root, path, key, files);
		else if (entry.isFile) files.set(key, await Deno.readFile(path));
		else throw new Error(`Unsupported piece resource: ${path}`);
	}
}

function refs(schema: unknown): void {
	if (Array.isArray(schema)) { for (const value of schema) refs(value); }
	else if (schema && typeof schema === "object") {
		for (const [key, value] of Object.entries(schema)) {
			if (
				key === "$ref" && (typeof value !== "string" || !value.startsWith("#"))
			) {
				throw new Error(
					"Piece schemas support only fragment references; bundle external schemas first",
				);
			}
			refs(value);
		}
	}
}

export async function packageHatch(
	app: string,
	declaration: Declaration,
	includeLock = true,
): Promise<Map<string, Uint8Array>> {
	const root = await Deno.realPath(app);
	if (declaration.version !== 1) {
		throw new Error("Unsupported Activepieces declaration version");
	}
	const files = new Map<string, Uint8Array>();
	const imports: Record<string, string> = { ajv: "npm:ajv@8.20.0" };
	const scopes: Record<string, Record<string, string>> = {};
	const statements: string[] = [];
	const bindings: string[] = [];
	for (
		const [alias, source] of Object.entries(declaration.pieces).sort((
			[a],
			[b],
		) => a.localeCompare(b))
	) {
		if (!name.test(alias)) throw new Error(`Invalid piece alias: ${alias}`);
		let specifier: string;
		const exported = source.local ? source.export : source.npm?.export;
		if (!exported || !name.test(exported)) {
			throw new Error(`Invalid piece export: ${alias}`);
		}
		if (source.local && !source.npm) {
			const directory = await inside(root, source.local);
			if (!(await Deno.stat(directory)).isDirectory) {
				throw new Error(`Not a package directory: ${source.local}`);
			}
			const metadata = JSON.parse(
				await Deno.readTextFile(
					await inside(root, `${source.local}/package.json`),
				),
			);
			const entry = typeof metadata.exports === "string"
				? metadata.exports
				: metadata.exports?.["."] ?? metadata.main;
			if (typeof entry !== "string" || !entry.startsWith("./")) {
				throw new Error(`Piece ${alias} needs a built string package export`);
			}
			await inside(directory, entry);
			await tree(root, directory, `pieces/${alias}`, files);
			const dependencies: Record<string, string> = {};
			for (
				const [dependency, pin] of Object.entries(metadata.dependencies ?? {})
			) {
				if (
					!packageName.test(dependency) || typeof pin !== "string" ||
					!version.test(pin)
				) {
					throw new Error(
						`Piece ${alias} dependency ${dependency} must pin an exact npm version; workspace/file dependencies must be packaged first`,
					);
				}
				dependencies[dependency] = `npm:${dependency}@${pin}`;
			}
			scopes[`./pieces/${alias}/`] = dependencies;
			specifier = `./pieces/${alias}/${entry.slice(2)}`;
		} else if (source.npm && !source.local) {
			if (
				!packageName.test(source.npm.package) ||
				!version.test(source.npm.version)
			) throw new Error(`Unpinned npm piece: ${alias}`);
			specifier = `npm:${source.npm.package}@${source.npm.version}`;
		} else throw new Error(`Piece ${alias} needs exactly one source`);
		const variable = `piece${bindings.length}`;
		statements.push(
			`import { ${exported} as ${variable} } from ${
				JSON.stringify(specifier)
			};`,
		);
		bindings.push(`${JSON.stringify(alias)}: ${variable}`);
	}
	const actions: Record<string, unknown> = {};
	const schema = async (path: string) => {
		const value = JSON.parse(await Deno.readTextFile(await inside(root, path)));
		if (
			typeof value !== "boolean" &&
			(!value || typeof value !== "object" || Array.isArray(value))
		) throw new Error(`Invalid JSON Schema: ${path}`);
		refs(value);
		return value;
	};
	for (const [alias, action] of Object.entries(declaration.actions)) {
		if (!name.test(alias) || !Object.hasOwn(declaration.pieces, action.piece)) {
			throw new Error(`Unknown action piece: ${alias}`);
		}
		actions[alias] = {
			...action,
			inputSchema: await schema(action.inputSchema),
			outputSchema: await schema(action.outputSchema),
			...(action.auth
				? {
					auth: {
						jsonSecret: action.auth.jsonSecret,
						schema: await schema(action.auth.schema),
					},
				}
				: {}),
		};
	}
	files.set(
		"registry.ts",
		new TextEncoder().encode(
			`${statements.join("\n")}\nexport const pieces = {${
				bindings.join(",")
			}};\n`,
		),
	);
	files.set(
		"deno.json",
		encode({
			imports,
			scopes,
			nodeModulesDir: "none",
			lock: { path: "deno.lock", frozen: true },
		}),
	);
	if (includeLock) {
		files.set(
			"deno.lock",
			await Deno.readFile(await inside(root, declaration.lock)),
		);
	}
	const manifest = { version: 1, limits: declaration.limits, actions };
	files.set("manifest.json", encode(manifest));
	const hashes: string[] = [];
	for (
		const [path, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b))
	) {
		hashes.push(
			`${path}:${
				Array.from(
					new Uint8Array(
						await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
					),
					(x) => x.toString(16).padStart(2, "0"),
				).join("")
			}`,
		);
	}
	const revision = Array.from(
		new Uint8Array(
			await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(hashes.join("\n")),
			),
		),
		(x) => x.toString(16).padStart(2, "0"),
	).join("");
	files.set("manifest.json", encode({ ...manifest, revision }));
	return files;
}

export async function writePackage(
	directory: string,
	files: Map<string, Uint8Array>,
) {
	for (const [path, bytes] of files) {
		await Deno.mkdir(dirname(resolve(directory, path)), { recursive: true });
		await Deno.writeFile(resolve(directory, path), bytes);
	}
}

if (import.meta.main) {
	const [app, declarationFile, output, mode] = Deno.args;
	if (
		!app || !declarationFile || !output ||
		(mode !== undefined && mode !== "--update-lock")
	) {
		throw new Error(
			"usage: activepieces-package.ts APP DECLARATION_JSON OUTPUT [--update-lock]",
		);
	}
	const declaration = JSON.parse(
		await Deno.readTextFile(declarationFile),
	) as Declaration;
	const files = await packageHatch(app, declaration, mode !== "--update-lock");
	await writePackage(output, files);
	if (mode === "--update-lock") {
		const result = await new Deno.Command(Deno.execPath(), {
			args: [
				"cache",
				"--frozen=false",
				"--config",
				resolve(output, "deno.json"),
				resolve(output, "registry.ts"),
			],
			stdout: "inherit",
			stderr: "inherit",
		}).output();
		if (!result.success) {
			throw new Error("Failed to resolve piece dependency lock");
		}
		const destination = resolve(app, declaration.lock);
		const parent = await inside(
			await Deno.realPath(app),
			relative(app, dirname(destination)),
		);
		if (!(await Deno.stat(parent)).isDirectory) {
			throw new Error("Lock parent must exist");
		}
		try {
			if ((await Deno.lstat(destination)).isSymlink) {
				throw new Error("Lock destination cannot be a symlink");
			}
		} catch (error) {
			if (!(error instanceof Deno.errors.NotFound)) throw error;
		}
		await Deno.copyFile(resolve(output, "deno.lock"), destination);
	}
}
