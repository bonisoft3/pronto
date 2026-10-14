package pronto

import "strings"

#MechaParam: {name: string & =~"^[a-z][a-z0-9_]*$", type: "uuid" | "text" | "jsonb", default?: string}
#MechaCheck: {sql: string, reason: string, mode: *"reject" | "error"}
#MechaAdmission: {
 name: string & =~"^[a-z][a-z0-9_]*$"
 public: *true | bool
 params: [...#MechaParam]
 id: string
 input: {[string]: _}
 members: {[string]: _}
 locks: *[] | [...#MechaReadLock]
 checks: *[] | [...#MechaCheck]
 result: *"view" | "receipt"
}
#MechaWake: {phases: [string, ...string], deadline: string, event: string}
#MechaPorts: {
 admission?: #MechaAdmission
 join?: {name: string, phases: [string, ...string], event: string} & ({seat: string} | {seats: string, membersPayload: string})
 wake?: #MechaWake
 sync?: {name: string}
 reads?: [string]: {params: [...#MechaParam], returns: "boolean" | "jsonb", sql: string}
 session?: {
  name: string
  leave: {name: string, event: string}
  renew: {event: string, payload: {[string]: _}, when: string}
  routes: [string]: {machine: string, kind: "admission" | "command", args: [..._]}
  sweep: [...string]
  select: {[string]: _}
 }
}

#MechaJsonSql: J={
 fields: {[string]: _}
 out: "jsonb_build_object(" + strings.Join([for key, value in J.fields {(#sqlLit & {v: key}).out + ", " + (#sqlLit & {v: value}).out + [if (value & {raw: string}) == _|_ if (value & ({...} | [...])) != _|_ {"::jsonb"}, ""][0]}], ", ") + ")"
}
