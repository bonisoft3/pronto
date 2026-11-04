package declaration

import "list"

#Name: string & =~"^[a-z][a-z0-9-]*$"
#Alias: string & =~"^[a-zA-Z][a-zA-Z0-9_]*$"
#Env: string & =~"^[A-Z][A-Z0-9_]*$"
#Package: string & =~"^(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$"
#Version: string & =~"^[0-9]+\\.[0-9]+\\.[0-9]+$"
#Local: string & =~"^\\./pieces/[a-zA-Z0-9_-]+(/[a-zA-Z0-9_-]+)*$"
#SchemaPath: string & =~"^\\./pieces/([a-zA-Z0-9_-]+/)*[a-zA-Z0-9_-]+\\.(input|output|auth)\\.schema\\.json$"
#JSON: null | bool | number | string | [...#JSON] | {[string]: #JSON}

// This is an opt-in contract, not an implementation of compiler lowering.
#Declaration: D={
 hatches: [H=string]: {
  kind: "container"
  note: string & !=""
  activepieces: AP={
   limits: {
    timeoutMs: *8000 | int & >0 & <=8000
    maxConcurrent: *4 | int & >=1
    maxRequestBytes: *1048576 | int & >0
    maxResultBytes: *1048576 | int & >0
   }
   pieces: [P=string]: {
    {local: #Local, export: #Alias} | {
     npm: {package: #Package, version: #Version, export: #Alias}
    }
   }
   actions: [A=string]: {
    piece: #Alias
    action: string & =~"^[a-zA-Z][a-zA-Z0-9_-]*$"
    inputSchema: #SchemaPath
    outputSchema: #SchemaPath
    idempotencyKeyProp?: #Alias
    // Values come from the operator's environment, never request data.
    auth?: {jsonSecret: #Env, schema: #SchemaPath}
    fixedProps: [string]: #JSON
   }
   _checks: [
    for a, action in AP.actions {
     [if AP.pieces[action.piece] != _|_ {true}, "action \(a) needs a declared piece"][0] & true
     if action.idempotencyKeyProp != _|_ {
      [if action.fixedProps[action.idempotencyKeyProp] == _|_ {true}, "action \(a) fixes its idempotency key property"][0] & true
     }
    },
   ]
  }
 }
 bridges: [B=string]: {
  container: #Name
  action: #Alias
  port: *8080 | int & >=1 & <=65535
 }
 effects: [E=string]: {
  sink: {bridge: #Name, idempotent: false}
  reentry: "unknown" | "repeat"
  note: string & !=""
 }
 _checks: [
  for b, bridge in D.bridges {
   [if D.hatches[bridge.container] != _|_ {true}, "bridge \(b) needs a declared Activepieces hatch"][0] & true
   if D.hatches[bridge.container] != _|_ {
    [if D.hatches[bridge.container].activepieces.actions[bridge.action] != _|_ {true}, "bridge \(b) needs an opted-in action"][0] & true
   }
  },
  for e, effect in D.effects {
   [if D.bridges[effect.sink.bridge] != _|_ {true}, "effect \(e) needs a declared bridge"][0] & true
  },
  for b, _ in D.bridges {
   [if list.Contains([for _, effect in D.effects {effect.sink.bridge}], b) {true}, "bridge \(b) needs an effect"][0] & true
  },
 ]
}
