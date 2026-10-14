package pronto

// A session composition invokes an existing Mecha port; it owns no server writes.
#CortexSession: {
 mecha: {machine: string, port: "session"}
 omnishell: {
  pollMs: int & >=100 & <=60000
  draft: {path: string, locked: {path: string, equals: string}}
  rebaseUnsent?: {route: string, unchanged: [string, ...string]}
 }
}

#CortexCommand: {
 mecha: {machine: string, port: "sync"}
 omnishell: {pollMs: int & >=100 & <=60000}
}
#CortexComposition: #CortexSession | #CortexCommand
