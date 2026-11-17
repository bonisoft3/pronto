# PostgREST must load its cache after this release's schema jobs, even when
# its image and configuration did not change. Both targets wait for /ready
# on the fresh process; accepting a NOTIFY does not acknowledge a reload.
export def fresh-schema-runtime [manifest: string]: nothing -> string {
	let object = ($manifest | from yaml)
	if not ($object.spec.template.spec.containers | any {|c| $c.name == "crud" }) {
		error make {msg: "the schema runtime has no crud container"}
	}
	let metadata = ($object.spec.template.metadata? | default {})
	let annotations = ($metadata.annotations? | default {} | upsert "pronto.dev/schema-release" (random uuid))
	$object | upsert spec.template.metadata ($metadata | upsert annotations $annotations) | to yaml
}
