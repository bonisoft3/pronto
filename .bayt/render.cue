// generated from bayt.cue — do not edit
package pronto

import bayt_ "github.com/bonisoft3/bayt/core:bayt"

// Declared so a bayt.json project can inject the value via stdin —
// file-mode identifier references only resolve against declarations.
project: _
depManifestsIn: {[string]: _}
runtimeIn: *"" | string
_render: (bayt_.#render & {"project": project, depManifests: depManifestsIn, runtime: runtimeIn})
