use std/assert
use release-schema.nu [fresh-schema-runtime]

def main [] {
	# A schema-only release leaves the runtime image and configuration identical:
	# each release still needs new processes, including a second release in the
	# same second. Existing annotations and every container setting must survive.
	for kind in [Deployment Service] {
		let original = {
			kind: $kind
			metadata: {name: sample}
			spec: {template: {
				metadata: {annotations: {"existing.example/setting": "kept"}}
				spec: {containers: [{name: crud, image: "unchanged@sha256:123", env: [{name: PGRST_DB_URI, value: "unchanged"}]}]}
			}}
		}
		let first = (fresh-schema-runtime ($original | to yaml) | from yaml)
		let second = (fresh-schema-runtime ($original | to yaml) | from yaml)
		let again = (fresh-schema-runtime ($first | to yaml) | from yaml)
		assert (($first.spec.template.metadata.annotations | get "pronto.dev/schema-release") != ($second.spec.template.metadata.annotations | get "pronto.dev/schema-release"))
		assert (($first.spec.template.metadata.annotations | get "pronto.dev/schema-release") != ($again.spec.template.metadata.annotations | get "pronto.dev/schema-release"))
		assert equal ($first | update spec.template.metadata.annotations {|o| $o.spec.template.metadata.annotations | reject "pronto.dev/schema-release" }) $original
	}
	let bare = {spec: {template: {spec: {containers: [{name: crud}]}}}}
	assert ((fresh-schema-runtime ($bare | to yaml) | from yaml | get spec.template.metadata.annotations | get "pronto.dev/schema-release") | is-not-empty)
	assert error { fresh-schema-runtime ({spec: {template: {spec: {containers: [{name: auth}]}}}} | to yaml) }
	print "Schema runtime release tests passed"
}
