// The cluster's seat as an app's generated bayt.cue redeclares it. CUE loads
// a package's files in name order, and this one precedes reducer-rows.cue as
// bayt.cue precedes program.cue, so the redeclaration is the seat's first
// conjunct here as it is in an app.
package emit

import mecha "github.com/bonisoft3/pronto/clusters:mecha"

_reducingCluster: mecha.#Cluster
