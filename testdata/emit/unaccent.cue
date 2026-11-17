// A generated search column over immutable_unaccent, pinned: the step that
// creates the column's table is the step that first carries the extension and
// its wrapper, so an app without one keeps its 000 bytes, a baseline entity
// gets them in 000, and a later entity in its own migration.
package emit

import (
	"strings"

	pronto "github.com/bonisoft3/pronto"
	"github.com/bonisoft3/pronto/clusters:mecha"
)

_searchField: {ordinal: 3, name: "search", type: "tsvector", generated: "to_tsvector('simple', immutable_unaccent(coalesce(title, '')))"}
_note: {
	table:      "note"
	durability: "server"
	fields: [
		{ordinal: 1, name: "id", type: "uuid", pk: true},
		{ordinal: 2, name: "title", type: "text"},
		_searchField,
	]
}
_unaccentedCode:    _code & {state: entities: Note: _note}
_unaccentedCluster: (pronto.#DefaultCluster & {code: _unaccentedCode, statics: []}).out
_unaccentedFiles: (pronto.#emit & {
	code:     _unaccentedCode
	cluster:  _unaccentedCluster
	terminal: _terminal
	loop:     _loop
	build:    (pronto.#DefaultBuild & {code: _unaccentedCode, cluster: _unaccentedCluster, terminal: _terminal, loop: _loop}).out
}).files
_extensions: "services/database/migrations/000_extensions.sql"

// What unaccent.integration.test.ts applies to PostgreSQL, PGlite and the edge.
unaccentSchema: _unaccentedFiles[_extensions].text + _unaccentedFiles["services/database/migrations/005_create_tables.sql"].text

unaccentInBaseline:       _unaccentedFiles[_extensions].text & mecha.#UnaccentSql
unaccentWrapperBound:     strings.Contains(mecha.#UnaccentSql, "RETURN public.unaccent('public.unaccent'::regdictionary, $1)") & true
unaccentWrapperImmutable: strings.Contains(mecha.#UnaccentSql, "LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT") & true
unaccentColumn:           strings.Contains(_unaccentedFiles["services/database/migrations/005_create_tables.sql"].text, "GENERATED ALWAYS AS (to_tsvector('simple', immutable_unaccent(coalesce(title, '')))) STORED") & true

// No generated column calls it: the 000 every app applied stays its bytes.
_plainFiles:    (pronto.#emit & {code: _code, cluster: _cluster, terminal: _terminal, loop: _loop, build: (pronto.#DefaultBuild & {code: _code, cluster: _cluster, terminal: _terminal, loop: _loop}).out}).files
unaccentAbsent: _plainFiles[_extensions].text & "-- no extensions required\n"

// A live baseline that lacks the entity: 000 keeps its bytes and the entity's
// migration creates the extension before its table.
_laterCode:    _unaccentedCode & {state: baseline: {entities: ["Profile"], after: "20260101"}}
_laterCluster: (pronto.#DefaultCluster & {code: _laterCode, statics: []}).out
_laterFiles: (pronto.#emit & {
	code:     _laterCode
	cluster:  _laterCluster
	terminal: _terminal
	loop:     _loop
	build:    (pronto.#DefaultBuild & {code: _laterCode, cluster: _laterCluster, terminal: _terminal, loop: _loop}).out
}).files
_laterUp:              _laterCluster.state.pgroll["20260101_note"].operations[0].sql.up
unaccentLaterBaseline: _laterFiles[_extensions].text & "-- no extensions required\n"
unaccentLaterFirst:    strings.Index(_laterUp, "CREATE EXTENSION IF NOT EXISTS unaccent") < strings.Index(_laterUp, "CREATE TABLE") & true

// A live baseline keeps its applied 000 by naming it: nothing is emitted under
// that name and the cluster applies the kept file once.
_pinnedCode:    _unaccentedCode & {state: rawMigrations: [{name: "000_extensions.sql", src: "kept/000_extensions.sql"}]}
_pinnedCluster: (pronto.#DefaultCluster & {code: _pinnedCode, statics: []}).out
_pinnedFiles: (pronto.#emit & {
	code:     _pinnedCode
	cluster:  _pinnedCluster
	terminal: _terminal
	loop:     _loop
	build:    (pronto.#DefaultBuild & {code: _pinnedCode, cluster: _pinnedCluster, terminal: _terminal, loop: _loop}).out
}).files
unaccentPinnedNotEmitted: (_pinnedFiles[_extensions].text == _|_) & true
unaccentPinnedOnce:       len([for m in _pinnedCluster.state.migrations if m == _extensions {m}]) & 1
