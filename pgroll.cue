// pgroll's migration grammar, as pgroll itself publishes it.
//
// Imported from the schema.json that ships in the pgroll release, so the
// operations an app may declare are the operations that pgroll accepts — not a
// second model of them kept in step by hand. A migration that names a field
// pgroll does not know fails `cue vet` here, before any database is asked.
//
// Regenerate against a new pgroll with — the ref pinned, because the contents
// API answers from the default branch when asked for none, which would take the
// grammar from whatever is unreleased on main while #PgRollGrammar below claims
// a release:
//
//   gh api repos/xataio/pgroll/contents/schema.json?ref=v<version> --jq .content | base64 -d > /tmp/pgroll.json
//   cue import -f jsonschema: /tmp/pgroll.json -o plugins/pronto/pgroll.cue -p pronto
//
// then delete the bare `#PgRollMigration` the import leaves under the
// `@jsonschema` attributes: it is the root-document constraint, and left in
// place it requires every file in this package to be a migration.
package pronto

// The pgroll this grammar was taken from. pgroll.test.ts holds it against the
// pinned binary: a bump without a regrab would leave apps writing migrations
// against operations the tool no longer has, and the first sign of it would be
// a migration that vets here and is refused at the database.
#PgRollGrammar: "0.16.3"

@jsonschema(schema="https://json-schema.org/draft/2020-12/schema")
@jsonschema(id="https://raw.githubusercontent.com/xataio/pgroll/main/schema.json")

// Check constraint definition
#CheckConstraint: close({
	// Constraint expression
	constraint!: string

	// Name of check constraint
	name!: string

	// Do not propagate constraint to child tables
	no_inherit?: bool
})

// Column definition
#Column: close({
	// Check constraint for the column
	check?: #CheckConstraint

	// Default value for the column
	default?: string

	// Name of the column
	name!: string

	// Indicates if the column is nullable
	nullable?: bool

	// Indicates if the column is part of the primary key
	pk?: bool

	// Foreign key constraint for the column
	references?: #ForeignKeyReference

	// Postgres type of the column
	type!: string

	// Indicates if the column values must be unique
	unique?: bool

	// Postgres comment for the column
	comment?: string

	// Generated column definition
	generated?: close({
		// Generation expression of the column
		expression?: string
		identity?: close({
			// Sequence options for identity column, same as in CREATE
			// SEQUENCE
			sequence_options?: string

			// How to handle user specified values for identity column in
			// INSERT and UPDATE statements
			user_specified_values?: "ALWAYS" | "BY DEFAULT"
		})
	})
})

// Constraint definition
#Constraint: matchN(5, [matchIf({
	type?: "unique"
	...
}, {
	check?:      ""
	no_inherit?: false
	columns!:    _
	...
}, _) & {
	...
}, matchIf({
	type?: "check"
	...
}, {
	check!: string
	index_parameters?: close({})
	deferrable?:         false
	initially_deferred?: false
	nulls_not_distinct?: false
	...
}, _) & {
	...
}, matchIf({
	type?: "primary_key"
	...
}, {
	check?:              ""
	no_inherit?:         false
	nulls_not_distinct?: false
	columns!:            _
	...
}, _) & {
	...
}, matchIf({
	type?: "foreign_key"
	...
}, {
	check?: ""
	index_parameters?: close({})
	no_inherit?:         false
	nulls_not_distinct?: false
	columns!:            _
	references!:         _
	...
}, _) & {
	...
}, matchIf({
	type?: "exclude"
	...
}, {
	check?:              ""
	no_inherit?:         false
	nulls_not_distinct?: false
	columns?: []
	exclude!: _
	...
}, _) & {
	...
}]) & close({
	// Name of the constraint
	name!: string

	// Columns to add constraint to
	columns?: [...string]

	// Type of the constraint
	type!: "unique" | "check" | "primary_key" | "foreign_key" | "exclude"

	// Deferable constraint
	deferrable?: bool

	// Initially deferred constraint
	initially_deferred?: bool

	// Nulls not distinct constraint
	nulls_not_distinct?: bool

	// Do not propagate constraint to child tables
	no_inherit?: bool

	// Check constraint expression
	check?: string

	// Reference to the foreign key
	references?: #TableForeignKeyReference

	// Exclude constraint definition
	exclude?: close({
		// Index method
		index_method?: string

		// Expressions of the exclude constraint
		elements?: string

		// Predicate for the exclusion constraint
		predicate?: string
	})
	index_parameters?: close({
		tablespace?:         string
		storage_parameters?: string
		include_columns?: [...string]
	})
})

// On delete behavior of the foreign key constraint
#ForeignKeyAction: "NO ACTION" | "RESTRICT" | "CASCADE" | "SET NULL" | "SET DEFAULT"

// Match type of the foreign key constraint
#ForeignKeyMatchType: "SIMPLE" | "FULL" | "PARTIAL"

// Foreign key reference definition
#ForeignKeyReference: close({
	// Name of the referenced column
	column!: string

	// Name of the foreign key constraint
	name!: string

	// Name of the referenced table
	table!: string

	// Match type of the foreign key constraint
	match_type?: #ForeignKeyMatchType

	// On delete behavior of the foreign key constraint
	on_delete?: #ForeignKeyAction

	// On update behavior of the foreign key constraint
	on_update?: #ForeignKeyAction

	// Deferable constraint
	deferrable?: bool

	// Initially deferred constraint
	initially_deferred?: bool
})

// Index field and its settings
#IndexField: close({
	// Name of the column
	column!: string

	// Collation for the index element
	collate?: string

	// Sort order, default is ascending (ASC)
	sort?: "ASC" | "DESC"

	// Operator class settings
	opclass?: close({
		// Name of the operator class
		name?: string

		// Operator class parameters
		params?: [...string]
	})

	// Nulls ordering, default is first if ascending, last if
	// descending
	nulls?: "FIRST" | "LAST"
})

// Map of column names to down SQL expressions
#MultiColumnDownSQL: [string]: string

// Map of column names to up SQL expressions
#MultiColumnUpSQL: [string]: string

// Add column operation
#OpAddColumn: close({
	// Column to add
	column!: #Column

	// Name of the table
	table!: string

	// SQL expression for up migration
	up?: string
})

// Alter column operation
#OpAlterColumn: matchN(>=1, [{
	check!: _
	...
}, {
	type!: _
	...
}, {
	nullable!: _
	...
}, {
	default!: _
	...
}, {
	comment!: _
	...
}, {
	unique!: _
	...
}, {
	references!: _
	...
}]) & close({
	// Add check constraint to the column
	check?: #CheckConstraint

	// Name of the column
	column!: string

	// SQL expression for down migration
	down!: string

	// Default value of the column. Setting to null will drop the
	// default if it was set previously.
	default?: null | string

	// Indicates if the column is nullable (for add/remove not null
	// constraint operation)
	nullable?: bool

	// Add foreign key constraint to the column
	references?: #ForeignKeyReference

	// Name of the table
	table!: string

	// New type of the column (for change type operation)
	type?: string

	// Add unique constraint to the column
	unique?: #UniqueConstraint

	// New comment on the column
	comment?: null | string

	// SQL expression for up migration
	up!: string
})

// Add constraint to table operation
#OpCreateConstraint: matchN(3, [matchIf({
	type?: "foreign_key"
	...
}, {
	check?:      ""
	no_inherit?: false
	index_params?: close({})
	columns!:    _
	references!: _
	...
}, _) & {
	...
}, matchIf({
	type?: "check"
	...
}, {
	check!: string
	references?: close({})
	index_params?: close({})
	...
}, _) & {
	...
}, matchIf({
	type?: "primary_key"
	...
}, {
	check?:      ""
	no_inherit?: false
	references?: close({})
	columns!: _
	...
}, _) & {
	...
}]) & close({
	// Name of the table
	table!: string

	// Name of the constraint
	name!: string

	// Columns to add constraint to
	columns?: [...string]

	// Type of the constraint
	type!: "unique" | "check" | "foreign_key" | "primary_key"

	// Check constraint expression
	check?: string

	// Do not propagate constraint to child tables
	no_inherit?: bool
	index_parameters?: close({
		tablespace?:         string
		storage_parameters?: string
		include_columns?: [...string]
	})

	// Reference to the foreign key
	references?: #TableForeignKeyReference

	// SQL expressions for up migrations
	up!: #MultiColumnUpSQL

	// SQL expressions for down migrations
	down!: #MultiColumnDownSQL
})

// Create index operation
#OpCreateIndex: close({
	// Names and settings of columns on which to define the index
	columns!: [...#IndexField]

	// Index name
	name!: string

	// Name of table on which to define the index
	table!: string

	// Conditional expression for defining a partial index
	predicate?: string

	// Index method to use for the index: btree, hash, gist, spgist,
	// gin, brin
	method?: "btree" | "hash" | "gist" | "spgist" | "gin" | "brin"

	// Storage parameters for the index
	storage_parameters?: string

	// Indicates if the index is unique
	unique?: bool
})

// Create table operation
#OpCreateTable: close({
	columns!: [...#Column]

	// Name of the table
	name!: string

	// Postgres comment for the table
	comment?: string
	constraints?: [...#Constraint]
})

// Drop column operation
#OpDropColumn: close({
	// Name of the column
	column!: string

	// SQL expression for down migration
	down?: string

	// Name of the table
	table!: string
})

// Drop constraint operation
#OpDropConstraint: close({
	// SQL expression for down migration
	down!: string

	// Name of the constraint
	name!: string

	// Name of the table
	table!: string

	// SQL expression for up migration
	up!: string
})

// Drop index operation
#OpDropIndex: close({
	// Index name
	name!: string
})

// Drop multi-column constraint operation
#OpDropMultiColumnConstraint: close({
	// Name of the table
	table!: string

	// Name of the constraint
	name!: string

	// SQL expressions for up migrations
	up?: #MultiColumnUpSQL

	// SQL expressions for down migrations
	down!: #MultiColumnDownSQL
})

// Drop table operation
#OpDropTable: close({
	// Name of the table
	name!: string
})

// Raw SQL operation
#OpRawSQL: matchN(1, [{
	down!: _
	...
}, {
	onComplete!: _
	...
}, matchN(0, [matchN(>=1, [null | bool | number | string | [...] | {
	down!: _
	...
}, null | bool | number | string | [...] | {
	onComplete!: _
	...
}])]) & {
	...
}]) & close({
	// SQL expression for down migration
	down?: string

	// SQL expression for up migration
	up!: string

	// SQL expression will run on complete step (rather than on start)
	onComplete?: bool
})

// Rename column operation
#OpRenameColumn: close({
	// Name of the table
	table!: string

	// Old name of the column
	from!: string

	// New name of the column
	to!: string
})

// Rename constraint operation
#OpRenameConstraint: close({
	// Name of the constraint
	from!: string

	// New name of the constraint
	to!: string

	// Name of the table
	table!: string
})

// Rename table operation
#OpRenameTable: close({
	// Old name of the table
	from!: string

	// New name of the table
	to!: string
})

// Set replica identity operation
#OpSetReplicaIdentity: close({
	// Replica identity to set
	identity!: #ReplicaIdentity

	// Name of the table
	table!: string
})

// PgRoll migration definition
#PgRollMigration: close({
	// Name of the migration
	name?: string

	// Name of the version schema to use for this migration
	version_schema?: string
	operations!:     #PgRollOperations
})

#PgRollOperation: matchN(>=1, [close({
	add_column!: #OpAddColumn
}), close({
	alter_column!: #OpAlterColumn
}), close({
	rename_column!: #OpRenameColumn
}), close({
	create_index!: #OpCreateIndex
}), close({
	create_table!: #OpCreateTable
}), close({
	drop_column!: #OpDropColumn
}), close({
	drop_constraint!: #OpDropConstraint
}), close({
	drop_multicolumn_constraint!: #OpDropMultiColumnConstraint
}), close({
	rename_constraint!: #OpRenameConstraint
}), close({
	drop_index!: #OpDropIndex
}), close({
	drop_table!: #OpDropTable
}), close({
	sql!: #OpRawSQL
}), close({
	rename_table!: #OpRenameTable
}), close({
	set_replica_identity!: #OpSetReplicaIdentity
}), close({
	create_constraint!: #OpCreateConstraint
})])

#PgRollOperations: [...#PgRollOperation]

// Replica identity definition
#ReplicaIdentity: close({
	// Name of the index to use as replica identity
	index!: string

	// Type of replica identity
	type!: string
})

// Table level foreign key reference definition
#TableForeignKeyReference: close({
	// Name of the table
	table!: string

	// Columns to reference
	columns!: [...string]

	// Match type of the foreign key constraint
	match_type?: #ForeignKeyMatchType

	// On update behavior of the foreign key constraint
	on_update?: #ForeignKeyAction

	// On delete behavior of the foreign key constraint
	on_delete?: #ForeignKeyAction

	// Columns to set to null or to default on delete
	on_delete_set_columns?: [...string]
})

// Unique constraint definition
#UniqueConstraint: close({
	// Name of unique constraint
	name!: string
})
