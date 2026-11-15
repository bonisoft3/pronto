#!/usr/bin/env nu
# Run with: nu gcp/build_test.nu
#
# build.nu's image reuse: the key each image's inputs make (source-key, image-keys), the tag it
# leaves (key-tag), the images a release finds pushed for their keys (pushed-for) and how it tags
# one (tag-image), against a gcloud that is a shell script on the PATH. Nothing here reaches a
# project.

const gcp_dir = path self .

use std/assert
use build.nu [source-key image-keys key-tag pushed-for tag-action tag-image]

# A gcloud that answers `images describe <repo>:<tag>` with the digest a file `tags/<tag>` holds
# (NOT_FOUND without one) and logs every call.
def fake-gcloud []: nothing -> string {
	let d = (mktemp -d)
	mkdir ($d | path join bin) ($d | path join tags)
	r#'
#!/bin/sh
d="$(dirname "$0")/.."
echo "$*" >> "$d/gcloud.log"
case "$*" in
  *"images describe"*)
    for a; do case "$a" in *:*) at="$a" ;; esac; done
    t="${at##*:}"
    [ -f "$d/tags/$t" ] || { echo "NOT_FOUND: $at was not found" >&2; exit 1; }
    cat "$d/tags/$t" ;;
esac
'# | str trim --left | save -f ($d | path join bin gcloud)
	chmod +x ($d | path join bin gcloud)
	$d
}

def log-of [d: string]: nothing -> list<string> {
	let f = ($d | path join gcloud.log)
	if ($f | path exists) { open --raw $f | lines } else { [] }
}

# An app with two images: web copies src/, api copies api/ and builds from web's image.
def app []: nothing -> record {
	let d = (mktemp -d)
	mkdir ($d | path join src) ($d | path join api)
	"FROM scratch\nCOPY src/ /src/\n" | save -f ($d | path join web.Dockerfile)
	"FROM web\nCOPY api/main.ts /api/\n" | save -f ($d | path join api.Dockerfile)
	let compose = {services: {
		web: {build: {context: $d, dockerfile: "web.Dockerfile"}}
		api: {build: {context: $d, dockerfile: "api.Dockerfile", additional_contexts: {web: "service:web"}}}
	}}
	{dir: $d, compose: $compose}
}

const hashes = [[path hash]; ["src/a.ts" "h1"] ["api/main.ts" "h2"] ["README.md" "h3"]]

def test_source_key_is_stable_and_short [] {
	let k = (source-key $hashes "told")
	assert equal $k (source-key $hashes "told")
	assert equal ($k | str length) 24
}

def test_source_key_changes_with_a_file_or_what_the_build_is_told [] {
	let k = (source-key $hashes "told")
	assert not equal $k (source-key ($hashes | update 0.hash "h1b") "told")
	assert not equal $k (source-key $hashes "told otherwise")
	assert not equal $k (source-key ($hashes | append {path: "new.ts", hash: "h4"}) "told")
}

def test_key_tag_names_the_key [] {
	assert equal (key-tag "abc") "src-abc"
}

def test_without_a_compose_project_every_image_keys_by_the_whole_app [] {
	let a = (image-keys "." null $hashes "told" ["web" "api"])
	let b = (image-keys "." null ($hashes | update 2.hash "h3b") "told" ["web" "api"])
	assert not equal $a.web $b.web
	assert not equal $a.api $b.api
}

def test_an_edit_to_one_service_s_files_changes_its_key_and_its_dependents_alone [] {
	let app = (app)
	let base = (image-keys $app.dir $app.compose $hashes "told" ["web" "api"])
	# A file neither Dockerfile copies changes no key.
	let readme = (image-keys $app.dir $app.compose ($hashes | update 2.hash "h3b") "told" ["web" "api"])
	assert equal $readme $base
	# api's own file changes api's key, not web's.
	let api = (image-keys $app.dir $app.compose ($hashes | update 1.hash "h2b") "told" ["web" "api"])
	assert equal $api.web $base.web
	assert not equal $api.api $base.api
	# web's file changes web's, and api's, which builds from web's image.
	let web = (image-keys $app.dir $app.compose ($hashes | update 0.hash "h1b") "told" ["web" "api"])
	assert not equal $web.web $base.web
	assert not equal $web.api $base.api
	rm -rf $app.dir
}

def test_a_dockerfile_edit_changes_its_key [] {
	let app = (app)
	let base = (image-keys $app.dir $app.compose $hashes "told" ["web" "api"])
	"FROM scratch\nCOPY src/ /src/\nENV X=1\n" | save -f ($app.dir | path join web.Dockerfile)
	let after = (image-keys $app.dir $app.compose $hashes "told" ["web" "api"])
	assert not equal $after.web $base.web
	rm -rf $app.dir
}

def test_pushed_for_finds_the_images_tagged_with_their_keys [] {
	let d = (fake-gcloud)
	let keys = {web: "kweb", api: "kapi"}
	"sha256:web1\n" | save -f ($d | path join tags (key-tag "kweb"))
	let refs = [{svc: web, repo: "r/p/app/app-web"} {svc: api, repo: "r/p/app/app-api"}]
	let found = (with-env {PATH: ($env.PATH | prepend ($d | path join bin))} { pushed-for $refs $keys })
	assert equal $found [{svc: web, repo: "r/p/app/app-web", digest: "sha256:web1"}]
	assert ((log-of $d) | any {|l| $l =~ 'images describe r/p/app/app-api:src-kapi' })
	rm -rf $d
}

def test_pushed_for_with_nothing_pushed_finds_none [] {
	let d = (fake-gcloud)
	let found = (with-env {PATH: ($env.PATH | prepend ($d | path join bin))} { pushed-for [{svc: web, repo: "r/p/app/app-web"}] {web: "k"} })
	assert equal $found []
	rm -rf $d
}

def test_tag_action [] {
	assert equal (tag-action null "sha256:a") "create"
	assert equal (tag-action "sha256:a" "sha256:a") "keep"
	assert equal (tag-action "sha256:b" "sha256:a") "move"
}

# A tag already on the digest is left: the previews' account may not delete one (2026-11-04).
def test_tag_image_leaves_a_tag_that_names_the_digest [] {
	let d = (fake-gcloud)
	"sha256:a\n" | save -f ($d | path join tags src-k)
	with-env {PATH: ($env.PATH | prepend ($d | path join bin))} { tag-image "us-docker.pkg.dev/p/app/app-web" "sha256:a" "src-k" }
	assert not ((log-of $d) | any {|l| $l =~ 'tags (add|update)' })
	rm -rf $d
}

def test_tag_image_adds_a_missing_tag_and_updates_a_moved_one [] {
	let d = (fake-gcloud)
	with-env {PATH: ($env.PATH | prepend ($d | path join bin))} { tag-image "us-docker.pkg.dev/p/app/app-web" "sha256:a" "src-k" }
	assert ((log-of $d) | any {|l| $l =~ 'artifacts docker tags add us-docker.pkg.dev/p/app/app-web@sha256:a us-docker.pkg.dev/p/app/app-web:src-k' })
	"sha256:old\n" | save -f ($d | path join tags src-k)
	with-env {PATH: ($env.PATH | prepend ($d | path join bin))} { tag-image "us-docker.pkg.dev/p/app/app-web" "sha256:a" "src-k" }
	assert ((log-of $d) | any {|l| $l =~ 'artifacts tags update src-k --location us --project p --repository app --package app-web --version sha256:a' })
	rm -rf $d
}

def main [] {
	let tests = (scope commands | where name =~ '^test_' | get name)
	for t in $tests {
		print $"($t)"
		let r = (do { ^$nu.current-exe --no-config-file -c $"source ($gcp_dir | path join build_test.nu); ($t)" } | complete)
		if $r.exit_code != 0 { print -e $r.stdout $r.stderr; error make {msg: $"($t) failed"} }
	}
	print $"($tests | length) passed"
}
