package pronto

import (
	"encoding/json"
	"list"
	"strings"
)

// A Shape as the one CEL statement a column holding values of it carries:
// a json column's `cel`, derived from the machine's own declaration, so the
// value a settle writes and the value the terminal proposes are judged by one
// text. Each constructor has one spelling, and the emitters read exactly
// these: a record is `type(x) == map`, its size and a `has` per field, fields
// in name order; a list is `type(x) == list`, its size and an `all` over an
// element named by its depth; a string is `type(x) == string` with its length
// or its set; an integer is `x == int(x)` with its range, which a JSON
// reader's double still answers; a boolean is `type(x) == bool`. A field is
// selected, so its name has to be a CEL identifier.
//
// CUE refuses a definition that recurses into itself, and a body handed the
// level below as a field is refused the same way (a structural cycle), so the
// renderer is unrolled: #ShapeCel renders eight levels of nesting and refuses
// a ninth, which no Shape has needed. `at` names the value, `depth` how many
// lists enclose it.
#ShapeCel: S={
	shape: _
	at:    *"this" | string
	depth: *0 | int
	out:   string
	if S.shape.type == "boolean" {
		out: "type(\(S.at)) == bool"
	}
	if S.shape.type == "string" {
		if S.shape.values != _|_ {
			out: "type(\(S.at)) == string && \(S.at) in [\(strings.Join([for v in S.shape.values {json.Marshal(v)}], ", "))]"
		}
		if S.shape.values == _|_ {
			out: "type(\(S.at)) == string && \(S.at).size() <= \(S.shape.maxLength)"
		}
	}
	if S.shape.type == "integer" {
		out: "\(S.at) == int(\(S.at)) && \(S.at) >= \(S.shape.min) && \(S.at) <= \(S.shape.max)"
	}
	if S.shape.type == "array" {
		let e = "e\(S.depth + 1)"
		out: "type(\(S.at)) == list && size(\(S.at)) <= \(S.shape.maxItems) && \(S.at).all(\(e), \((#ShapeCel7 & {shape: S.shape.items, at: e, depth: S.depth + 1}).out))"
	}
	if S.shape.type == "object" {
		let keys = list.SortStrings([for k, _ in S.shape.fields {k & =~"^[a-zA-Z_][a-zA-Z0-9_]*$"}])
		out: strings.Join(list.Concat([
			["type(\(S.at)) == map && size(\(S.at)) == \(len(keys))"],
			[for k in keys {"has(\(S.at).\(k)) && \((#ShapeCel7 & {shape: S.shape.fields[k], at: "\(S.at).\(k)", depth: S.depth}).out)"}],
		]), " && ")
	}
}

#ShapeCel7: S={
	shape: _
	at:    *"this" | string
	depth: *0 | int
	out:   string
	if S.shape.type == "boolean" {
		out: "type(\(S.at)) == bool"
	}
	if S.shape.type == "string" {
		if S.shape.values != _|_ {
			out: "type(\(S.at)) == string && \(S.at) in [\(strings.Join([for v in S.shape.values {json.Marshal(v)}], ", "))]"
		}
		if S.shape.values == _|_ {
			out: "type(\(S.at)) == string && \(S.at).size() <= \(S.shape.maxLength)"
		}
	}
	if S.shape.type == "integer" {
		out: "\(S.at) == int(\(S.at)) && \(S.at) >= \(S.shape.min) && \(S.at) <= \(S.shape.max)"
	}
	if S.shape.type == "array" {
		let e = "e\(S.depth + 1)"
		out: "type(\(S.at)) == list && size(\(S.at)) <= \(S.shape.maxItems) && \(S.at).all(\(e), \((#ShapeCel6 & {shape: S.shape.items, at: e, depth: S.depth + 1}).out))"
	}
	if S.shape.type == "object" {
		let keys = list.SortStrings([for k, _ in S.shape.fields {k & =~"^[a-zA-Z_][a-zA-Z0-9_]*$"}])
		out: strings.Join(list.Concat([
			["type(\(S.at)) == map && size(\(S.at)) == \(len(keys))"],
			[for k in keys {"has(\(S.at).\(k)) && \((#ShapeCel6 & {shape: S.shape.fields[k], at: "\(S.at).\(k)", depth: S.depth}).out)"}],
		]), " && ")
	}
}

#ShapeCel6: S={
	shape: _
	at:    *"this" | string
	depth: *0 | int
	out:   string
	if S.shape.type == "boolean" {
		out: "type(\(S.at)) == bool"
	}
	if S.shape.type == "string" {
		if S.shape.values != _|_ {
			out: "type(\(S.at)) == string && \(S.at) in [\(strings.Join([for v in S.shape.values {json.Marshal(v)}], ", "))]"
		}
		if S.shape.values == _|_ {
			out: "type(\(S.at)) == string && \(S.at).size() <= \(S.shape.maxLength)"
		}
	}
	if S.shape.type == "integer" {
		out: "\(S.at) == int(\(S.at)) && \(S.at) >= \(S.shape.min) && \(S.at) <= \(S.shape.max)"
	}
	if S.shape.type == "array" {
		let e = "e\(S.depth + 1)"
		out: "type(\(S.at)) == list && size(\(S.at)) <= \(S.shape.maxItems) && \(S.at).all(\(e), \((#ShapeCel5 & {shape: S.shape.items, at: e, depth: S.depth + 1}).out))"
	}
	if S.shape.type == "object" {
		let keys = list.SortStrings([for k, _ in S.shape.fields {k & =~"^[a-zA-Z_][a-zA-Z0-9_]*$"}])
		out: strings.Join(list.Concat([
			["type(\(S.at)) == map && size(\(S.at)) == \(len(keys))"],
			[for k in keys {"has(\(S.at).\(k)) && \((#ShapeCel5 & {shape: S.shape.fields[k], at: "\(S.at).\(k)", depth: S.depth}).out)"}],
		]), " && ")
	}
}

#ShapeCel5: S={
	shape: _
	at:    *"this" | string
	depth: *0 | int
	out:   string
	if S.shape.type == "boolean" {
		out: "type(\(S.at)) == bool"
	}
	if S.shape.type == "string" {
		if S.shape.values != _|_ {
			out: "type(\(S.at)) == string && \(S.at) in [\(strings.Join([for v in S.shape.values {json.Marshal(v)}], ", "))]"
		}
		if S.shape.values == _|_ {
			out: "type(\(S.at)) == string && \(S.at).size() <= \(S.shape.maxLength)"
		}
	}
	if S.shape.type == "integer" {
		out: "\(S.at) == int(\(S.at)) && \(S.at) >= \(S.shape.min) && \(S.at) <= \(S.shape.max)"
	}
	if S.shape.type == "array" {
		let e = "e\(S.depth + 1)"
		out: "type(\(S.at)) == list && size(\(S.at)) <= \(S.shape.maxItems) && \(S.at).all(\(e), \((#ShapeCel4 & {shape: S.shape.items, at: e, depth: S.depth + 1}).out))"
	}
	if S.shape.type == "object" {
		let keys = list.SortStrings([for k, _ in S.shape.fields {k & =~"^[a-zA-Z_][a-zA-Z0-9_]*$"}])
		out: strings.Join(list.Concat([
			["type(\(S.at)) == map && size(\(S.at)) == \(len(keys))"],
			[for k in keys {"has(\(S.at).\(k)) && \((#ShapeCel4 & {shape: S.shape.fields[k], at: "\(S.at).\(k)", depth: S.depth}).out)"}],
		]), " && ")
	}
}

#ShapeCel4: S={
	shape: _
	at:    *"this" | string
	depth: *0 | int
	out:   string
	if S.shape.type == "boolean" {
		out: "type(\(S.at)) == bool"
	}
	if S.shape.type == "string" {
		if S.shape.values != _|_ {
			out: "type(\(S.at)) == string && \(S.at) in [\(strings.Join([for v in S.shape.values {json.Marshal(v)}], ", "))]"
		}
		if S.shape.values == _|_ {
			out: "type(\(S.at)) == string && \(S.at).size() <= \(S.shape.maxLength)"
		}
	}
	if S.shape.type == "integer" {
		out: "\(S.at) == int(\(S.at)) && \(S.at) >= \(S.shape.min) && \(S.at) <= \(S.shape.max)"
	}
	if S.shape.type == "array" {
		let e = "e\(S.depth + 1)"
		out: "type(\(S.at)) == list && size(\(S.at)) <= \(S.shape.maxItems) && \(S.at).all(\(e), \((#ShapeCel3 & {shape: S.shape.items, at: e, depth: S.depth + 1}).out))"
	}
	if S.shape.type == "object" {
		let keys = list.SortStrings([for k, _ in S.shape.fields {k & =~"^[a-zA-Z_][a-zA-Z0-9_]*$"}])
		out: strings.Join(list.Concat([
			["type(\(S.at)) == map && size(\(S.at)) == \(len(keys))"],
			[for k in keys {"has(\(S.at).\(k)) && \((#ShapeCel3 & {shape: S.shape.fields[k], at: "\(S.at).\(k)", depth: S.depth}).out)"}],
		]), " && ")
	}
}

#ShapeCel3: S={
	shape: _
	at:    *"this" | string
	depth: *0 | int
	out:   string
	if S.shape.type == "boolean" {
		out: "type(\(S.at)) == bool"
	}
	if S.shape.type == "string" {
		if S.shape.values != _|_ {
			out: "type(\(S.at)) == string && \(S.at) in [\(strings.Join([for v in S.shape.values {json.Marshal(v)}], ", "))]"
		}
		if S.shape.values == _|_ {
			out: "type(\(S.at)) == string && \(S.at).size() <= \(S.shape.maxLength)"
		}
	}
	if S.shape.type == "integer" {
		out: "\(S.at) == int(\(S.at)) && \(S.at) >= \(S.shape.min) && \(S.at) <= \(S.shape.max)"
	}
	if S.shape.type == "array" {
		let e = "e\(S.depth + 1)"
		out: "type(\(S.at)) == list && size(\(S.at)) <= \(S.shape.maxItems) && \(S.at).all(\(e), \((#ShapeCel2 & {shape: S.shape.items, at: e, depth: S.depth + 1}).out))"
	}
	if S.shape.type == "object" {
		let keys = list.SortStrings([for k, _ in S.shape.fields {k & =~"^[a-zA-Z_][a-zA-Z0-9_]*$"}])
		out: strings.Join(list.Concat([
			["type(\(S.at)) == map && size(\(S.at)) == \(len(keys))"],
			[for k in keys {"has(\(S.at).\(k)) && \((#ShapeCel2 & {shape: S.shape.fields[k], at: "\(S.at).\(k)", depth: S.depth}).out)"}],
		]), " && ")
	}
}

#ShapeCel2: S={
	shape: _
	at:    *"this" | string
	depth: *0 | int
	out:   string
	if S.shape.type == "boolean" {
		out: "type(\(S.at)) == bool"
	}
	if S.shape.type == "string" {
		if S.shape.values != _|_ {
			out: "type(\(S.at)) == string && \(S.at) in [\(strings.Join([for v in S.shape.values {json.Marshal(v)}], ", "))]"
		}
		if S.shape.values == _|_ {
			out: "type(\(S.at)) == string && \(S.at).size() <= \(S.shape.maxLength)"
		}
	}
	if S.shape.type == "integer" {
		out: "\(S.at) == int(\(S.at)) && \(S.at) >= \(S.shape.min) && \(S.at) <= \(S.shape.max)"
	}
	if S.shape.type == "array" {
		let e = "e\(S.depth + 1)"
		out: "type(\(S.at)) == list && size(\(S.at)) <= \(S.shape.maxItems) && \(S.at).all(\(e), \((#ShapeCel1 & {shape: S.shape.items, at: e, depth: S.depth + 1}).out))"
	}
	if S.shape.type == "object" {
		let keys = list.SortStrings([for k, _ in S.shape.fields {k & =~"^[a-zA-Z_][a-zA-Z0-9_]*$"}])
		out: strings.Join(list.Concat([
			["type(\(S.at)) == map && size(\(S.at)) == \(len(keys))"],
			[for k in keys {"has(\(S.at).\(k)) && \((#ShapeCel1 & {shape: S.shape.fields[k], at: "\(S.at).\(k)", depth: S.depth}).out)"}],
		]), " && ")
	}
}

#ShapeCel1: S={
	shape: _
	at:    *"this" | string
	depth: *0 | int
	out:   string
	if S.shape.type == "boolean" {
		out: "type(\(S.at)) == bool"
	}
	if S.shape.type == "string" {
		if S.shape.values != _|_ {
			out: "type(\(S.at)) == string && \(S.at) in [\(strings.Join([for v in S.shape.values {json.Marshal(v)}], ", "))]"
		}
		if S.shape.values == _|_ {
			out: "type(\(S.at)) == string && \(S.at).size() <= \(S.shape.maxLength)"
		}
	}
	if S.shape.type == "integer" {
		out: "\(S.at) == int(\(S.at)) && \(S.at) >= \(S.shape.min) && \(S.at) <= \(S.shape.max)"
	}
	if S.shape.type == "array" {
		let e = "e\(S.depth + 1)"
		out: "type(\(S.at)) == list && size(\(S.at)) <= \(S.shape.maxItems) && \(S.at).all(\(e), \((#ShapeCel0 & {shape: S.shape.items, at: e, depth: S.depth + 1}).out))"
	}
	if S.shape.type == "object" {
		let keys = list.SortStrings([for k, _ in S.shape.fields {k & =~"^[a-zA-Z_][a-zA-Z0-9_]*$"}])
		out: strings.Join(list.Concat([
			["type(\(S.at)) == map && size(\(S.at)) == \(len(keys))"],
			[for k in keys {"has(\(S.at).\(k)) && \((#ShapeCel0 & {shape: S.shape.fields[k], at: "\(S.at).\(k)", depth: S.depth}).out)"}],
		]), " && ")
	}
}

#ShapeCel0: S={
	shape: _
	at:    *"this" | string
	depth: *0 | int
	out:   string
	if S.shape.type == "boolean" {
		out: "type(\(S.at)) == bool"
	}
	if S.shape.type == "string" {
		if S.shape.values != _|_ {
			out: "type(\(S.at)) == string && \(S.at) in [\(strings.Join([for v in S.shape.values {json.Marshal(v)}], ", "))]"
		}
		if S.shape.values == _|_ {
			out: "type(\(S.at)) == string && \(S.at).size() <= \(S.shape.maxLength)"
		}
	}
	if S.shape.type == "integer" {
		out: "\(S.at) == int(\(S.at)) && \(S.at) >= \(S.shape.min) && \(S.at) <= \(S.shape.max)"
	}
	if S.shape.type == "array" || S.shape.type == "object" {
		out: _|_ // nested deeper than #ShapeCel renders
	}
}

// A command's request: the envelope the terminal writes around an event,
// which the reducer reads whole. The payload is left to the step, which
// checks it against the event's own shape.
#RequestCel: R={
	events: [...string]
	out: strings.Join([
		"type(this) == map && size(this) == 3",
		"has(this.event) && type(this.event) == map && size(this.event) == 2",
		"has(this.event.kind) && type(this.event.kind) == string && this.event.kind in [\(strings.Join([for v in list.SortStrings(R.events) {json.Marshal(v)}], ", "))]",
		"has(this.event.payload) && type(this.event.payload) == map",
		"has(this.expected_revision) && type(this.expected_revision) == string && this.expected_revision.size() <= 20",
		"has(this.version) && this.version == int(this.version) && this.version >= 1 && this.version <= 9007199254740991",
	], " && ")
}
