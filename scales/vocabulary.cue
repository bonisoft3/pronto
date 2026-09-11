// The shape every file build.ts writes into this package must wear.
//
// Held here rather than only in #Scale because the two grade different sets:
// this shape grades whatever build.ts writes into the package, #Scale grades
// only what #scale draws a bucket from. Registering a vendored vocabulary and
// adopting one are separate acts, and the constraint below applies from the
// first, so a generated file is graded by `cue vet ./...` in every app on the day
// it lands rather than on the day a bucket points at it.
//
// `dimension` is only `string` here. Which norms a bucket joins under is the
// scanner's business (#Dimension), and it means nothing until a bucket is
// composed — where #Scale checks it.
package scales

// A ladder's prefix, which is the vendor's own spelling — #Bucket argues why the
// emitted name has to be the upstream one. camelCase is admitted because the
// shipping tree publishes it: `--base-text-lineHeight-` is Primer's own
// spelling, so a pattern that reshaped it would make the ladder unquotable.
#Prefix: string & =~"^--[a-zA-Z0-9]+(-[a-zA-Z0-9]+)*-$"

#Vocabulary: {
	source: {
		kind:    "quoted"
		origin:  string
		version: string
		// The version is joined to the url that pins it, because nothing else
		// joins them and the two disagreeing is what a half-finished bump leaves:
		// `version` bumped, `url` and `integrity` still naming the old archive.
		// refresh.ts cannot find that on its own — its url rewrite substitutes
		// source.version, so re-verifying a tree whose version already moved is a
		// no-op that re-fetches the old tarball, matches the old digest, and
		// rewrites source.json with the lie intact.
		url:       string & =~"\(version)"
		integrity: string & =~"^sha512-"
	}
	buckets: [Name=string]: {
		prefix:    #Prefix
		dimension: string
		source:    string
		steps: [string]: string
	}
}

[Name=string]: #Vocabulary
