package pronto

import "strings"

#MechaParam: {name: string & =~"^[a-z][a-z0-9_]*$", type: "uuid" | "text" | "jsonb", default?: string}
#MechaCheck: {sql: string, reason: string, mode: *"reject" | "error"}
// What admits a reader to a new instance. Its function is internal: an open
// row (`<machine>_open`) calls it with the instance id the row names and the
// other params from the row's input, or a lease calls it bare.
#MechaAdmission: {
	name: string & =~"^[a-z][a-z0-9_]*$"
	params: [...#MechaParam]
	id:     string
	input: {[string]: _}
	members: {[string]: _}
	locks:  *[] | [...#MechaReadLock]
	checks: *[] | [...#MechaCheck]
}
#MechaWake: {phases: [string, ...string], deadline: string, event: string}
#MechaPorts: {
	admission?: #MechaAdmission
	join?: {phases: [string, ...string], event: string} & ({seat: string} | {seats: string, membersPayload: string})
	// The phases that hold a deadline, armed on the ticker as they are entered.
	wake?: #MechaWake
	reads?: [string]: {params: [...#MechaParam], returns: "boolean" | "jsonb", sql: string}
	// A reader's tab holds the machine open by a lease row (`<machine>_lease`):
	// writing it admits the reader and delivers `touch`, deleting it `leave`.
	// `held` names the state field listing the live sessions by `id`: a row
	// the machine no longer holds is pruned after a touch and after the
	// ticker's wake, and its deletion delivers nothing.
	lease?: {touch: string, leave: string, held: string}
}

#MechaJsonSql: J={
	fields: {[string]: _}
	out: "jsonb_build_object(" + strings.Join([for key, value in J.fields {(#sqlLit & {v: key}).out + ", " + (#sqlLit & {v: value}).out + [if (value & {raw: string}) == _|_ if (value & ({...} | [...])) != _|_ {"::jsonb"}, ""][0]}], ", ") + ")"
}
